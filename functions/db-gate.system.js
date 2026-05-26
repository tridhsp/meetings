const crypto = require('crypto');

// === CONFIG ===
const COOKIE_SECRET = '973ff6de62ac3aa1ff6d8870c85c322da62793d8f31b100a5652dd9077bbb41a';
const COOKIE_NAME = 'db_gate_session';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Escalating lockout: 3 fails each tier
const LOCKOUT_TIERS = [
  { threshold: 3, banSeconds: 300 },      // 5 minutes
  { threshold: 6, banSeconds: 3600 },     // 1 hour
  { threshold: 9, banSeconds: 86400 },    // 1 day
  { threshold: 12, banSeconds: -1 },      // forever
];

const failTracker = new Map(); // IP -> { count, bannedUntil, tier }

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

module.exports = function(app) {

  // --- Auth check (nginx auth_request calls this) ---
  app.get('/db-gate/check', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifyValue(cookies[COOKIE_NAME]);
    if (payload) {
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.exp > Date.now()) return res.sendStatus(200);
      } catch (e) {}
    }
    return res.sendStatus(401);
  });

  // --- Login page ---
  app.get('/db-gate', (req, res) => {
    // If already logged in, redirect to dashboard
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifyValue(cookies[COOKIE_NAME]);
    if (payload) {
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.exp > Date.now()) return res.redirect('/');
      } catch (e) {}
    }
    const ip = getClientIP(req);
    const lock = getLockInfo(ip);
    res.type('html').send(buildLoginPage(lock));
  });

  // --- Login POST ---
  app.post('/db-gate/login', (req, res) => {
    const ip = getClientIP(req);

    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[db-gate] BLOCKED ' + ip + ' (locked out)');
      return res.status(429).json({ error: 'locked', lock });
    }

    const { username, password } = req.body || {};
    const validUser = process.env.DASHBOARD_USERNAME || 'sbadministrator';
    const validPass = process.env.DASHBOARD_PASSWORD || '';

    if (username === validUser && password === validPass) {
      failTracker.delete(ip);
      const payload = Buffer.from(JSON.stringify({ ip, exp: Date.now() + SESSION_TTL })).toString('base64url');
      const signed = signValue(payload);
      res.cookie(COOKIE_NAME, signed, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/'
      });
      console.log('[db-gate] ✅ Login from ' + ip);
      return res.json({ ok: true });
    }

    const r = recordFail(ip);
    console.log('[db-gate] ❌ Failed login from ' + ip + ' (attempt ' + r.count + ')');
    const lock = getLockInfo(ip);
    return res.status(401).json({ error: 'invalid', attempts: r.count, lock });
  });

  // --- Logout ---
  app.get('/db-gate/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/db-gate');
  });

  // --- Admin: list bans (localhost only) ---
  app.get('/db-gate/bans', (req, res) => {
    const bans = [];
    for (const [ip, record] of failTracker.entries()) {
      bans.push({ ip, count: record.count, bannedUntil: record.bannedUntil === -1 ? 'permanent' : record.bannedUntil ? new Date(record.bannedUntil).toISOString() : null });
    }
    res.json(bans);
  });

  // --- Admin: unban ---
  app.post('/db-gate/unban', (req, res) => {
    const { ip } = req.body || {};
    if (ip === 'all') { failTracker.clear(); return res.json({ ok: true, msg: 'All bans cleared' }); }
    if (ip) { failTracker.delete(ip); return res.json({ ok: true, msg: 'Unbanned ' + ip }); }
    res.status(400).json({ error: 'Provide ip or "all"' });
  });
};

// ============================================================
// LOGIN PAGE HTML
// ============================================================
function buildLoginPage(lock) {
  let lockMsg = '';
  let lockSeconds = 0;
  if (lock) {
    if (lock.permanent) {
      lockMsg = 'Access permanently blocked. Contact the administrator.';
      lockSeconds = -1;
    } else if (lock.remaining) {
      lockSeconds = lock.remaining;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Database Access</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0b0f;
    --surface: #12141c;
    --surface-hover: #1a1d28;
    --border: #252836;
    --border-focus: #3ecf8e;
    --text: #e8e8ec;
    --text-dim: #6b7083;
    --accent: #3ecf8e;
    --accent-glow: rgba(62, 207, 142, 0.15);
    --danger: #f24c5e;
    --danger-glow: rgba(242, 76, 94, 0.1);
    --warning: #f5a623;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Outfit', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  /* animated bg grid */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      linear-gradient(90deg, rgba(62,207,142,0.03) 1px, transparent 1px),
      linear-gradient(rgba(62,207,142,0.03) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: gridShift 20s linear infinite;
    pointer-events: none;
  }

  @keyframes gridShift {
    0% { transform: translate(0, 0); }
    100% { transform: translate(60px, 60px); }
  }

  /* floating orbs */
  .orb {
    position: fixed;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.4;
    pointer-events: none;
    animation: float 15s ease-in-out infinite;
  }
  .orb-1 { width: 300px; height: 300px; background: rgba(62,207,142,0.12); top: -100px; left: -80px; }
  .orb-2 { width: 250px; height: 250px; background: rgba(62,130,207,0.1); bottom: -80px; right: -60px; animation-delay: -7s; }

  @keyframes float {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33% { transform: translate(30px, -20px) scale(1.05); }
    66% { transform: translate(-20px, 15px) scale(0.95); }
  }

  .gate-container {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    padding: 20px;
  }

  .gate-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 48px 40px 40px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    animation: cardIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(20px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .gate-icon {
    width: 56px;
    height: 56px;
    background: var(--accent-glow);
    border: 1px solid rgba(62,207,142,0.2);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 28px;
  }

  .gate-icon svg { width: 28px; height: 28px; stroke: var(--accent); fill: none; stroke-width: 1.8; }

  h1 {
    font-size: 1.4rem;
    font-weight: 600;
    text-align: center;
    margin-bottom: 6px;
    letter-spacing: -0.02em;
  }

  .subtitle {
    text-align: center;
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 300;
    margin-bottom: 32px;
  }

  .field {
    margin-bottom: 18px;
  }

  label {
    display: block;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-dim);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-family: 'JetBrains Mono', monospace;
  }

  input[type="text"],
  input[type="password"] {
    width: 100%;
    padding: 12px 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  input::placeholder {
    color: #3a3d4e;
  }

  .btn {
    width: 100%;
    padding: 13px;
    background: var(--accent);
    color: #0a0b0f;
    border: none;
    border-radius: 10px;
    font-family: 'Outfit', sans-serif;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    margin-top: 8px;
    position: relative;
    overflow: hidden;
  }

  .btn:hover:not(:disabled) {
    background: #4de0a0;
    transform: translateY(-1px);
    box-shadow: 0 6px 24px rgba(62,207,142,0.25);
  }

  .btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.loading .btn-text { visibility: hidden; }
  .btn.loading::after {
    content: '';
    position: absolute;
    inset: 0;
    margin: auto;
    width: 20px;
    height: 20px;
    border: 2.5px solid rgba(10,11,15,0.3);
    border-top-color: #0a0b0f;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .error-box {
    background: var(--danger-glow);
    border: 1px solid rgba(242,76,94,0.2);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 18px;
    display: none;
    animation: shake 0.4s ease;
  }

  .error-box.show { display: flex; align-items: flex-start; gap: 10px; }

  .error-box svg { flex-shrink: 0; width: 18px; height: 18px; stroke: var(--danger); fill: none; margin-top: 1px; }

  .error-box .msg {
    font-size: 0.84rem;
    color: var(--danger);
    line-height: 1.45;
  }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(5px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(2px); }
  }

  .lockout-box {
    background: rgba(245,166,35,0.08);
    border: 1px solid rgba(245,166,35,0.2);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 18px;
    text-align: center;
    display: none;
  }

  .lockout-box.show { display: block; }

  .lockout-box .lock-icon { font-size: 1.6rem; margin-bottom: 6px; }
  .lockout-box .lock-msg { font-size: 0.84rem; color: var(--warning); line-height: 1.45; }
  .lockout-box .timer {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--warning);
    margin-top: 8px;
  }

  .footer {
    text-align: center;
    margin-top: 20px;
    font-size: 0.75rem;
    color: #2a2d3a;
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 480px) {
    .gate-card { padding: 36px 24px 28px; }
    h1 { font-size: 1.2rem; }
  }
</style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>

  <div class="gate-container">
    <div class="gate-card">
      <div class="gate-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2C9.24 2 7 4.24 7 7v4H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-2V7c0-2.76-2.24-5-5-5zm-3 5c0-1.66 1.34-3 3-3s3 1.34 3 3v4H9V7zm3 9a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
        </svg>
      </div>

      <h1>Database Access</h1>
      <p class="subtitle">Authenticated access required</p>

      <div class="lockout-box" id="lockoutBox">
        <div class="lock-icon">&#128274;</div>
        <div class="lock-msg" id="lockMsg">Too many failed attempts</div>
        <div class="timer" id="lockTimer"></div>
      </div>

      <div class="error-box" id="errorBox">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span class="msg" id="errorMsg">Invalid credentials</span>
      </div>

      <div id="formFields">
        <div class="field">
          <label for="username">Username</label>
          <input type="text" id="username" autocomplete="username" placeholder="Enter username" spellcheck="false">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" autocomplete="current-password" placeholder="Enter password">
        </div>
        <button class="btn" id="loginBtn" onclick="doLogin()">
          <span class="btn-text">Authenticate</span>
        </button>
      </div>
    </div>
    <div class="footer">db.tansinh.info &middot; protected</div>
  </div>

<script>
  const INIT_LOCK_SECONDS = ${lockSeconds};
  const INIT_LOCK_PERMANENT = ${lock && lock.permanent ? 'true' : 'false'};
  let lockRemaining = INIT_LOCK_SECONDS;

  if (INIT_LOCK_PERMANENT) {
    showLockout('Access permanently blocked.\\nContact the server administrator to lift the ban.', -1);
  } else if (INIT_LOCK_SECONDS > 0) {
    showLockout('Too many failed attempts.\\nTry again in:', INIT_LOCK_SECONDS);
  }

  function showLockout(msg, seconds) {
    document.getElementById('lockoutBox').classList.add('show');
    document.getElementById('lockMsg').innerText = msg;
    document.getElementById('formFields').style.display = 'none';
    document.getElementById('errorBox').classList.remove('show');

    if (seconds === -1) {
      document.getElementById('lockTimer').innerText = 'PERMANENT';
      return;
    }

    lockRemaining = seconds;
    updateTimer();
    const iv = setInterval(() => {
      lockRemaining--;
      if (lockRemaining <= 0) {
        clearInterval(iv);
        document.getElementById('lockoutBox').classList.remove('show');
        document.getElementById('formFields').style.display = 'block';
        return;
      }
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
    const box = document.getElementById('errorBox');
    document.getElementById('errorMsg').innerText = msg;
    box.classList.remove('show');
    void box.offsetWidth; // force reflow for re-animation
    box.classList.add('show');
  }

  async function doLogin() {
    const btn = document.getElementById('loginBtn');
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;

    if (!user || !pass) { showError('Please enter both fields.'); return; }

    btn.classList.add('loading');
    btn.disabled = true;
    document.getElementById('errorBox').classList.remove('show');

    try {
      const res = await fetch('/db-gate/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();

      if (data.ok) {
        btn.innerHTML = '<span class="btn-text" style="visibility:visible">✓ Authenticated</span>';
        btn.style.background = '#2ecc71';
        setTimeout(() => { window.location.href = '/'; }, 600);
        return;
      }

      if (data.error === 'locked' && data.lock) {
        if (data.lock.permanent) {
          showLockout('Access permanently blocked.\\nContact the server administrator.', -1);
        } else if (data.lock.remaining) {
          showLockout('Too many failed attempts.\\nTry again in:', data.lock.remaining);
        }
        return;
      }

      const remaining = data.lock ? '' : '';
      let attemptsMsg = 'Invalid credentials.';
      if (data.attempts) {
        const left = (data.attempts < 3) ? (3 - data.attempts) : (data.attempts < 6) ? (6 - data.attempts) : (data.attempts < 9) ? (9 - data.attempts) : 0;
        if (left > 0) attemptsMsg += ' ' + left + ' attempt' + (left > 1 ? 's' : '') + ' remaining.';
      }

      if (data.lock && data.lock.remaining) {
        showLockout('Too many failed attempts.\\nTry again in:', data.lock.remaining);
      } else if (data.lock && data.lock.permanent) {
        showLockout('Access permanently blocked.\\nContact the server administrator.', -1);
      } else {
        showError(attemptsMsg);
      }

    } catch (e) {
      showError('Connection error. Try again.');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // Enter key support
  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('password').focus(); });

  // Autofocus
  document.getElementById('username').focus();
</script>
</body>
</html>`;
}
