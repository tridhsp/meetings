const crypto = require('crypto');

// === CONFIG ===
// Independent secret + cookie for the meeting gate (separate from db-gate).
const COOKIE_SECRET = 'a7f2c9e14b8d6053fa1e9c72b4d80e3f5a6c1b9d2e7f084a3c5b6d9e0f1a2b3c4';
const COOKIE_NAME = 'mtg_gate_session';
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

// Self-hosted Supabase (localhost). Uses the same env the rest of the app uses.
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:8000';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Escalating lockout per IP (shared across login failures)
const LOCKOUT_TIERS = [
  { threshold: 5,  banSeconds: 300 },     // 5 minutes
  { threshold: 9,  banSeconds: 3600 },    // 1 hour
  { threshold: 14, banSeconds: 86400 },   // 1 day
  { threshold: 20, banSeconds: -1 },      // forever
];

const failTracker = new Map();

function getClientIP(req) {
  return req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
}

function isLocked(ip) {
  const r = failTracker.get(ip);
  if (!r || !r.bannedUntil) return false;
  if (r.bannedUntil === -1) return true;
  if (Date.now() < r.bannedUntil) return true;
  return false;
}

function getLockInfo(ip) {
  const r = failTracker.get(ip);
  if (!r || !r.bannedUntil) return null;
  if (r.bannedUntil === -1) return { permanent: true, attempts: r.count };
  if (Date.now() < r.bannedUntil) {
    return { remaining: Math.ceil((r.bannedUntil - Date.now()) / 1000), attempts: r.count };
  }
  return null;
}

function recordFail(ip) {
  const r = failTracker.get(ip) || { count: 0, bannedUntil: null };
  r.count++;
  for (const t of LOCKOUT_TIERS) {
    if (r.count >= t.threshold) {
      r.bannedUntil = t.banSeconds === -1 ? -1 : Date.now() + t.banSeconds * 1000;
    }
  }
  failTracker.set(ip, r);
  return r;
}

function signValue(value) {
  return value + '.' + crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
}

function verifyValue(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.substring(0, idx);
  if (signed === signValue(value)) return value;
  return null;
}

function parseCookies(header) {
  const c = {};
  if (!header) return c;
  header.split(';').forEach(p => { const [k, ...v] = p.trim().split('='); c[k] = v.join('='); });
  return c;
}

function readSession(cookies) {
  const payload = verifyValue(cookies[COOKIE_NAME]);
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp > Date.now()) return data;
  } catch (e) {}
  return null;
}

module.exports = function(app) {

  // --- Auth check (nginx auth_request calls this) ---
  app.get('/meeting-gate/check', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (readSession(cookies)) return res.sendStatus(200);
    return res.sendStatus(401);
  });

  // --- Login page ---
  app.get('/meeting-gate', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    // 'next' = where to send the user after login (the room they were trying to reach)
    let next = '/';
    if (typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')) {
      next = req.query.next;
    }
    if (readSession(cookies)) return res.redirect(next);
    const ip = getClientIP(req);
    const lock = getLockInfo(ip);
    res.type('html').send(buildLoginPage(lock, next));
  });

  // --- Login POST (verifies against self-hosted Supabase) ---
  app.post('/meeting-gate/login', async (req, res) => {
    const ip = getClientIP(req);

    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[meeting-gate] BLOCKED ' + ip + ' (locked)');
      return res.status(429).json({ error: 'locked', lock });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing', message: 'Email and password required.' });
    }

    try {
      const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ email: email, password: password })
      });

      if (r.ok) {
        // Valid Supabase credentials → issue gate session
        failTracker.delete(ip);
        const payload = Buffer.from(JSON.stringify({
          email: String(email).toLowerCase(),
          exp: Date.now() + SESSION_TTL
        })).toString('base64url');
        const signed = signValue(payload);
        res.cookie(COOKIE_NAME, signed, {
          httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/'
        });
        console.log('[meeting-gate] OK login ' + email + ' from ' + ip);
        return res.json({ ok: true });
      }

      // Bad credentials
      const fail = recordFail(ip);
      console.log('[meeting-gate] BAD login ' + email + ' from ' + ip + ' (attempt ' + fail.count + ')');
      const lock = getLockInfo(ip);
      return res.status(401).json({ error: 'invalid', attempts: fail.count, lock });

    } catch (e) {
      console.log('[meeting-gate] ERROR verifying login: ' + e.message);
      return res.status(502).json({ error: 'upstream', message: 'Login service unavailable. Try again.' });
    }
  });

  // --- Logout ---
  app.get('/meeting-gate/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/meeting-gate');
  });

  // --- Admin: list bans ---
  app.get('/meeting-gate/bans', (req, res) => {
    const bans = [];
    for (const [ip, record] of failTracker.entries()) {
      bans.push({ ip, count: record.count, bannedUntil: record.bannedUntil === -1 ? 'permanent' : record.bannedUntil ? new Date(record.bannedUntil).toISOString() : null });
    }
    res.json(bans);
  });

  // --- Admin: unban ---
  app.post('/meeting-gate/unban', (req, res) => {
    const { ip } = req.body || {};
    if (ip === 'all') { failTracker.clear(); return res.json({ ok: true, msg: 'All bans cleared' }); }
    if (ip) { failTracker.delete(ip); return res.json({ ok: true, msg: 'Unbanned ' + ip }); }
    res.status(400).json({ error: 'Provide ip or "all"' });
  });
};

// ============================================================
// LOGIN PAGE HTML
// ============================================================
function buildLoginPage(lock, next) {
  let lockSeconds = 0;
  if (lock) {
    if (lock.permanent) lockSeconds = -1;
    else if (lock.remaining) lockSeconds = lock.remaining;
  }
  const safeNext = String(next).replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Đăng nhập — TANSINH Meeting</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #eef4fb;
    --surface: #ffffff;
    --surface-soft: #f3f8fd;
    --border: #dde7f1;
    --border-strong: #c5d4e4;
    --text: #102338;
    --text-soft: #43566f;
    --text-dim: #6a7c95;
    --text-label: #8493a8;
    --accent: #0ea5b7;
    --accent-hover: #0c8d9d;
    --accent-grad: linear-gradient(135deg, #0ea5e9 0%, #0d9488 100%);
    --accent-grad-hover: linear-gradient(135deg, #2bb3f0 0%, #11a896 100%);
    --danger: #ef4444;
    --danger-soft: rgba(239,68,68,0.07);
    --danger-text: #c2410c;
    --warning: #d97706;
    --warning-soft: rgba(217,119,6,0.08);
    --warning-text: #b45309;
    --radius: 18px;
    --sans: 'Manrope', system-ui, -apple-system, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: '';
    position: fixed; inset: 0;
    background:
      radial-gradient(circle at 12% 12%, rgba(14,165,233,0.13) 0%, transparent 46%),
      radial-gradient(circle at 88% 82%, rgba(13,148,136,0.11) 0%, transparent 50%),
      linear-gradient(180deg, #f6fafe 0%, #e9f1f9 100%);
    pointer-events: none; z-index: 0;
  }
  .top-bar {
    position: relative; z-index: 2;
    display: flex; justify-content: space-between; align-items: center;
    padding: 22px 32px;
    font-family: var(--mono); font-size: 11px;
    letter-spacing: 0.05em; color: var(--text-dim);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-family: var(--sans); font-size: 15px; font-weight: 700;
    color: var(--text); letter-spacing: -0.01em;
  }
  .brand-mark {
    width: 26px; height: 26px; border-radius: 8px;
    background: var(--accent-grad);
    display: flex; align-items: center; justify-content: center;
    color: white; box-shadow: 0 3px 10px rgba(14,165,183,0.38);
    font-weight: 800; font-size: 13px;
  }
  .status { display: flex; align-items: center; gap: 8px; text-transform: uppercase; }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,0.18);
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,100% { box-shadow: 0 0 0 3px rgba(16,185,129,0.18); }
    50% { box-shadow: 0 0 0 7px rgba(16,185,129,0.04); }
  }
  .stage {
    position: relative; z-index: 1; flex: 1;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    position: relative; width: 100%; max-width: 430px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 40px 38px 32px;
    box-shadow: 0 1px 2px rgba(16,35,56,0.04), 0 18px 50px rgba(14,116,144,0.12);
    animation: cardIn 0.6s cubic-bezier(0.16,1,0.3,1);
  }
  @keyframes cardIn {
    from { opacity: 0; transform: translateY(14px) scale(0.99); }
    to { opacity: 1; transform: none; }
  }
  .step-label {
    font-family: var(--mono); font-size: 10.5px; font-weight: 500;
    letter-spacing: 0.14em; color: var(--text-label);
    text-transform: uppercase; margin-bottom: 14px;
    display: flex; align-items: center; gap: 12px;
  }
  .step-label .step-bar {
    flex: 1; height: 1px;
    background: linear-gradient(90deg, var(--border-strong) 0%, transparent 100%);
  }
  h1 {
    font-size: 28px; font-weight: 700; letter-spacing: -0.028em;
    line-height: 1.12; margin-bottom: 8px; color: var(--text);
  }
  .subtitle {
    font-size: 14px; color: var(--text-soft); font-weight: 400;
    margin-bottom: 26px; line-height: 1.55;
  }
  .field { margin-bottom: 14px; }
  label {
    display: block; font-family: var(--mono); font-size: 10.5px; font-weight: 500;
    color: var(--text-label); margin-bottom: 7px;
    text-transform: uppercase; letter-spacing: 0.12em;
  }
  input[type="email"], input[type="password"] {
    width: 100%; padding: 13px 14px;
    background: var(--surface-soft);
    border: 1px solid var(--border);
    border-radius: 10px; color: var(--text);
    font-family: var(--mono); font-size: 14px; outline: none;
    transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
  }
  input::placeholder { color: #aab8cb; font-family: var(--mono); }
  input:hover { border-color: var(--border-strong); }
  input:focus {
    background: #ffffff; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(14,165,183,0.16);
  }
  .btn {
    width: 100%; padding: 14px 16px;
    background: var(--accent-grad); color: white;
    border: none; border-radius: 10px;
    font-family: var(--sans); font-size: 14px; font-weight: 600;
    cursor: pointer; margin-top: 14px;
    position: relative; overflow: hidden;
    transition: transform 0.08s ease, box-shadow 0.25s ease, background 0.25s ease;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    box-shadow: 0 4px 16px rgba(14,165,183,0.30);
  }
  .btn:hover:not(:disabled) {
    background: var(--accent-grad-hover);
    box-shadow: 0 8px 24px rgba(14,165,183,0.40);
  }
  .btn .arrow { display: inline-flex; transition: transform 0.22s ease; }
  .btn:hover:not(:disabled) .arrow { transform: translateX(4px); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn.loading .btn-text, .btn.loading .arrow { visibility: hidden; }
  .btn.loading::after {
    content: ''; position: absolute; inset: 0; margin: auto;
    width: 18px; height: 18px;
    border: 2.4px solid rgba(255,255,255,0.45); border-top-color: white;
    border-radius: 50%; animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .alert {
    border-radius: 10px; padding: 11px 13px; margin-bottom: 16px;
    font-size: 13px; line-height: 1.45; display: none;
    align-items: flex-start; gap: 10px;
  }
  .alert.show { display: flex; }
  .alert.error {
    background: var(--danger-soft);
    border: 1px solid rgba(239,68,68,0.22);
    color: var(--danger-text); animation: shake 0.4s ease;
  }
  .alert .ico { flex-shrink: 0; width: 16px; height: 16px; margin-top: 1px; color: var(--danger); }
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(5px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(2px); }
  }
  .lockout {
    background: var(--warning-soft);
    border: 1px solid rgba(217,119,6,0.25);
    border-radius: 12px; padding: 22px; text-align: center; display: none;
  }
  .lockout.show { display: block; }
  .lockout .lk-icon {
    width: 40px; height: 40px; margin: 0 auto 12px;
    border-radius: 11px; background: #ffffff;
    border: 1px solid rgba(217,119,6,0.25);
    display: flex; align-items: center; justify-content: center; color: var(--warning);
  }
  .lockout .lk-icon svg { width: 20px; height: 20px; }
  .lockout .lk-label {
    font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.14em; color: var(--warning); margin-bottom: 6px;
  }
  .lockout .lk-msg {
    font-size: 13px; color: var(--warning-text); line-height: 1.5; white-space: pre-line;
  }
  .lockout .lk-timer {
    font-family: var(--mono); font-size: 30px; font-weight: 500;
    color: var(--warning); margin-top: 14px; letter-spacing: 0.04em;
  }
  .foot {
    position: relative; z-index: 2; padding: 22px 32px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em;
    color: var(--text-label); text-transform: uppercase;
    display: flex; justify-content: space-between; gap: 16px;
  }
  @media (max-width: 520px) {
    .card { padding: 30px 22px 24px; max-width: 380px; }
    h1 { font-size: 23px; }
    .top-bar, .foot { padding: 18px 18px; font-size: 10px; }
    .brand { font-size: 14px; }
  }
</style>
</head>
<body>
  <header class="top-bar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true">TS</span>
      TANSINH Meeting
    </span>
    <span class="status"><span class="dot"></span> Online</span>
  </header>

  <main class="stage">
    <div class="card">

      <div class="lockout" id="lockoutBox">
        <div class="lk-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="lk-label">Tạm khóa</div>
        <div class="lk-msg" id="lockMsg">Quá nhiều lần đăng nhập sai</div>
        <div class="lk-timer" id="lockTimer"></div>
      </div>

      <div class="panel" id="loginPanel">
        <div class="step-label">Đăng nhập <span class="step-bar"></span></div>
        <h1>Chào mừng.</h1>
        <p class="subtitle">Đăng nhập bằng tài khoản của bạn để vào phòng họp.</p>

        <div class="alert error" id="loginError">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5"/>
            <line x1="8" y1="5" x2="8" y2="8.5"/>
            <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>
          </svg>
          <span id="loginErrorMsg">Sai thông tin đăng nhập</span>
        </div>

        <div class="field">
          <label for="email">Email</label>
          <input type="email" id="email" autocomplete="username" placeholder="email@tansinh.info" spellcheck="false">
        </div>
        <div class="field">
          <label for="password">Mật khẩu</label>
          <input type="password" id="password" autocomplete="current-password" placeholder="••••••••••">
        </div>
        <button class="btn" id="loginBtn" type="button" onclick="doLogin()">
          <span class="btn-text">Đăng nhập</span>
          <span class="arrow" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <line x1="3" y1="8" x2="13" y2="8"/>
              <polyline points="9 4 13 8 9 12"/>
            </svg>
          </span>
        </button>
      </div>
    </div>
  </main>

<script>
  const NEXT_URL = "${safeNext}";
  const INIT_LOCK_SECONDS = ${lockSeconds};
  const INIT_LOCK_PERMANENT = ${lock && lock.permanent ? 'true' : 'false'};
  let lockRemaining = INIT_LOCK_SECONDS;

  if (INIT_LOCK_PERMANENT) {
    showLockout('Tài khoản/IP đã bị khóa vĩnh viễn.\\nLiên hệ quản trị viên.', -1);
  } else if (INIT_LOCK_SECONDS > 0) {
    showLockout('Quá nhiều lần đăng nhập sai.\\nThử lại sau:', INIT_LOCK_SECONDS);
  }

  function showLockout(msg, seconds) {
    document.getElementById('loginPanel').style.display = 'none';
    document.getElementById('lockoutBox').classList.add('show');
    document.getElementById('lockMsg').innerText = msg;
    if (seconds === -1) {
      document.getElementById('lockTimer').innerText = 'VĨNH VIỄN';
      return;
    }
    lockRemaining = seconds;
    updateTimer();
    const iv = setInterval(() => {
      lockRemaining--;
      if (lockRemaining <= 0) { clearInterval(iv); window.location.reload(); return; }
      updateTimer();
    }, 1000);
  }

  function updateTimer() {
    const m = Math.floor(lockRemaining / 60);
    const s = lockRemaining % 60;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    let t = '';
    if (h > 0) t = h + 'h ' + String(rm).padStart(2,'0') + 'm ' + String(s).padStart(2,'0') + 's';
    else if (m > 0) t = m + 'm ' + String(s).padStart(2,'0') + 's';
    else t = s + 's';
    document.getElementById('lockTimer').innerText = t;
  }

  function showError(msg) {
    const box = document.getElementById('loginError');
    document.getElementById('loginErrorMsg').innerText = msg;
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
  }

  async function doLogin() {
    const btn = document.getElementById('loginBtn');
    const email = document.getElementById('email').value.trim();
    const pass = document.getElementById('password').value;

    if (!email || !pass) { showError('Vui lòng nhập email và mật khẩu.'); return; }

    btn.classList.add('loading');
    btn.disabled = true;
    document.getElementById('loginError').classList.remove('show');

    try {
      const res = await fetch('/meeting-gate/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pass })
      });
      const data = await res.json();

      if (data.ok) {
        btn.classList.remove('loading');
        const txt = btn.querySelector('.btn-text');
        const arr = btn.querySelector('.arrow');
        if (txt) { txt.innerText = '✓ Thành công'; txt.style.visibility = 'visible'; }
        if (arr) arr.style.visibility = 'hidden';
        setTimeout(() => { window.location.href = NEXT_URL || '/'; }, 500);
        return;
      }

      if (data.error === 'locked' && data.lock) {
        if (data.lock.permanent) showLockout('Đã bị khóa vĩnh viễn.\\nLiên hệ quản trị viên.', -1);
        else if (data.lock.remaining) showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
        return;
      }

      let msg = 'Sai email hoặc mật khẩu.';
      if (data.lock && data.lock.remaining) {
        showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
      } else {
        showError(msg);
      }
    } catch (e) {
      showError('Lỗi kết nối. Thử lại.');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('password').focus(); });

  const e0 = document.getElementById('email');
  if (e0) e0.focus();
</script>
</body>
</html>`;
}
