const crypto = require('crypto');

// === CONFIG ===
const COOKIE_SECRET = 'b8e4c1a7f9d2630e5c8a14fb7e9d05a3c6f21984b7e0d35a9c1f4e8b2a6d7039';
const COOKIE_NAME = 'gb_gate_session';
const PIN_COOKIE_NAME = 'gb_gate_pin';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PIN_TTL = 10 * 60 * 1000;          // 10 minutes (just long enough to finish login)
const ENTRY_PIN = process.env.GB_GATE_PIN || '96325126';

const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Escalating lockout: shared between PIN failures and login failures
const LOCKOUT_TIERS = [
  { threshold: 3, banSeconds: 300 },      // 5 minutes
  { threshold: 6, banSeconds: 3600 },     // 1 hour
  { threshold: 9, banSeconds: 86400 },    // 1 day
  { threshold: 12, banSeconds: -1 },      // forever
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

function readSignedJWTLike(cookies, name) {
  const payload = verifyValue(cookies[name]);
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp > Date.now()) return data;
  } catch (e) {}
  return null;
}

// Verify Supabase email+password, then confirm the user's role is Super Admin.
// Returns { ok:true, email } or { ok:false, reason:'invalid'|'not_admin'|'upstream' }
async function verifySuperAdmin(email, password) {
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email, password: password })
    });
    if (!r.ok) return { ok: false, reason: 'invalid' };
    const authData = await r.json().catch(() => ({}));
    const userId = authData && authData.user && authData.user.id;
    const lowerEmail = String(email).toLowerCase();

    // Look up role in user_roles (service key bypasses RLS for a reliable check)
    const q = await fetch(
      SUPABASE_URL + '/rest/v1/user_roles?select=role,email,uid&email=eq.' + encodeURIComponent(lowerEmail),
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } }
    );
    let role = null;
    if (q.ok) {
      const rows = await q.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) role = rows[0].role;
      // Fallback: match by uid if email row missing
      if (!role && userId) {
        const q2 = await fetch(
          SUPABASE_URL + '/rest/v1/user_roles?select=role&uid=eq.' + encodeURIComponent(userId),
          { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } }
        );
        if (q2.ok) {
          const rows2 = await q2.json().catch(() => []);
          if (Array.isArray(rows2) && rows2.length) role = rows2[0].role;
        }
      }
    }

    if (role === 'Super Admin') return { ok: true, email: lowerEmail };
    return { ok: false, reason: 'not_admin' };
  } catch (e) {
    console.log('[gb-gate] verify error: ' + e.message);
    return { ok: false, reason: 'upstream' };
  }
}

module.exports = function(app) {

  // --- Auth check (nginx auth_request calls this) ---
  app.get('/gb-gate/check', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (readSignedJWTLike(cookies, COOKIE_NAME)) return res.sendStatus(200);
    return res.sendStatus(401);
  });

  // --- Login page (PIN or login depending on cookie state) ---
  app.get('/gb-gate', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (readSignedJWTLike(cookies, COOKIE_NAME)) return res.redirect('/');
    const pinPassed = !!readSignedJWTLike(cookies, PIN_COOKIE_NAME);
    const ip = getClientIP(req);
    const lock = getLockInfo(ip);
    res.type('html').send(buildLoginPage(lock, pinPassed));
  });

  // --- PIN verify ---
  app.post('/gb-gate/pin', (req, res) => {
    const ip = getClientIP(req);
    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[gb-gate] BLOCKED ' + ip + ' (locked at PIN stage)');
      return res.status(429).json({ error: 'locked', lock });
    }
    const { pin } = req.body || {};
    if (pin === ENTRY_PIN) {
      const payload = Buffer.from(JSON.stringify({ ip, exp: Date.now() + PIN_TTL })).toString('base64url');
      const signed = signValue(payload);
      res.cookie(PIN_COOKIE_NAME, signed, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: PIN_TTL, path: '/'
      });
      console.log('[gb-gate] PIN ok from ' + ip);
      return res.json({ ok: true });
    }
    const r = recordFail(ip);
    console.log('[gb-gate] Bad PIN from ' + ip + ' (attempt ' + r.count + ')');
    const lock = getLockInfo(ip);
    return res.status(401).json({ error: 'invalid_pin', attempts: r.count, lock });
  });

  // --- Login POST (requires PIN cookie; Super Admin only) ---
  app.post('/gb-gate/login', async (req, res) => {
    const ip = getClientIP(req);

    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[gb-gate] BLOCKED ' + ip + ' (locked at login stage)');
      return res.status(429).json({ error: 'locked', lock });
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!readSignedJWTLike(cookies, PIN_COOKIE_NAME)) {
      return res.status(403).json({ error: 'no_pin' });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing', message: 'Email and password required.' });
    }

    const result = await verifySuperAdmin(email, password);

    if (result.ok) {
      failTracker.delete(ip);
      const payload = Buffer.from(JSON.stringify({
        email: result.email, exp: Date.now() + SESSION_TTL
      })).toString('base64url');
      const signed = signValue(payload);
      res.cookie(COOKIE_NAME, signed, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/'
      });
      res.clearCookie(PIN_COOKIE_NAME, { path: '/' });
      console.log('[gb-gate] Login OK ' + result.email + ' from ' + ip);
      return res.json({ ok: true });
    }

    if (result.reason === 'upstream') {
      return res.status(502).json({ error: 'upstream', message: 'Login service unavailable. Try again.' });
    }

    // invalid credentials OR not a Super Admin → count as a failed attempt
    const r = recordFail(ip);
    const lock = getLockInfo(ip);
    if (result.reason === 'not_admin') {
      console.log('[gb-gate] DENIED (not Super Admin) ' + email + ' from ' + ip);
      return res.status(403).json({ error: 'not_admin', attempts: r.count, lock });
    }
    console.log('[gb-gate] Failed login ' + email + ' from ' + ip + ' (attempt ' + r.count + ')');
    return res.status(401).json({ error: 'invalid', attempts: r.count, lock });
  });

  // --- Logout ---
  app.get('/gb-gate/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.clearCookie(PIN_COOKIE_NAME, { path: '/' });
    res.redirect('/gb-gate');
  });

  // --- Admin: list bans ---
  app.get('/gb-gate/bans', (req, res) => {
    const bans = [];
    for (const [ip, record] of failTracker.entries()) {
      bans.push({ ip, count: record.count, bannedUntil: record.bannedUntil === -1 ? 'permanent' : record.bannedUntil ? new Date(record.bannedUntil).toISOString() : null });
    }
    res.json(bans);
  });

  // --- Admin: unban ---
  app.post('/gb-gate/unban', (req, res) => {
    const { ip } = req.body || {};
    if (ip === 'all') { failTracker.clear(); return res.json({ ok: true, msg: 'All bans cleared' }); }
    if (ip) { failTracker.delete(ip); return res.json({ ok: true, msg: 'Unbanned ' + ip }); }
    res.status(400).json({ error: 'Provide ip or "all"' });
  });
};

// ============================================================
// LOGIN PAGE HTML — PIN screen then email+password (Super Admin)
// ============================================================
function buildLoginPage(lock, pinPassed) {
  let lockSeconds = 0;
  if (lock) {
    if (lock.permanent) lockSeconds = -1;
    else if (lock.remaining) lockSeconds = lock.remaining;
  }
  const stage = pinPassed ? 'login' : 'pin';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Giao bài — Đăng nhập</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #eef4fb; --surface: #ffffff; --surface-soft: #f3f8fd;
    --border: #dde7f1; --border-strong: #c5d4e4;
    --text: #102338; --text-soft: #43566f; --text-dim: #6a7c95; --text-label: #8493a8;
    --accent: #4f46e5; --accent-hover: #4338ca;
    --accent-grad: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
    --danger: #ef4444; --danger-soft: rgba(239,68,68,0.07); --danger-text: #c2410c;
  }
  body {
    font-family: 'Manrope', sans-serif; background: var(--bg); color: var(--text);
    min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    width: 100%; max-width: 400px; padding: 36px 32px;
    box-shadow: 0 20px 50px rgba(16,35,56,0.10);
  }
  .logo {
    width: 52px; height: 52px; border-radius: 14px; background: var(--accent-grad);
    display: grid; place-items: center; margin: 0 auto 18px;
    font-size: 24px; color: #fff;
  }
  h1 { font-size: 20px; font-weight: 800; text-align: center; margin-bottom: 4px; }
  .sub { font-size: 13px; color: var(--text-dim); text-align: center; margin-bottom: 26px; }
  .stage { display: none; }
  .stage.active { display: block; }
  label { display: block; font-size: 12px; font-weight: 600; color: var(--text-label); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .4px; }
  input[type=text], input[type=email], input[type=password] {
    width: 100%; height: 46px; padding: 0 14px; font-size: 15px; font-family: inherit;
    border: 1px solid var(--border-strong); border-radius: 11px; background: var(--surface-soft);
    color: var(--text); margin-bottom: 16px; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,70,229,.12); background: #fff; }
  .pin-dots { display: flex; gap: 12px; justify-content: center; margin: 6px 0 22px; }
  .pin-dot { width: 14px; height: 14px; border-radius: 50%; background: var(--border-strong); transition: background .15s, transform .15s; }
  .pin-dot.filled { background: var(--accent); transform: scale(1.1); }
  .keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .key {
    height: 56px; border: 1px solid var(--border); border-radius: 13px; background: var(--surface-soft);
    font-size: 21px; font-weight: 600; color: var(--text); cursor: pointer; font-family: inherit;
    transition: background .12s, transform .08s;
  }
  .key:hover { background: #e9f1f9; }
  .key:active { transform: scale(.96); }
  .key.act { font-size: 14px; color: var(--text-dim); }
  .btn {
    width: 100%; height: 48px; border: none; border-radius: 12px; background: var(--accent-grad);
    color: #fff; font-size: 15px; font-weight: 700; font-family: inherit; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 4px;
    transition: filter .15s, transform .08s;
  }
  .btn:hover { filter: brightness(1.05); }
  .btn:active { transform: scale(.98); }
  .btn:disabled { opacity: .6; cursor: default; }
  .btn .spin { display: none; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%; animation: sp .6s linear infinite; }
  .btn.loading .spin { display: inline-block; }
  .btn.loading .btn-text { display: none; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .err {
    display: none; background: var(--danger-soft); border: 1px solid rgba(239,68,68,.25);
    color: var(--danger-text); font-size: 13px; font-weight: 500; padding: 10px 12px;
    border-radius: 10px; margin-bottom: 14px; text-align: center;
  }
  .err.show { display: block; }
  .lock { text-align: center; padding: 10px 0; }
  .lock-time { font-size: 28px; font-weight: 800; color: var(--danger-text); font-family: 'JetBrains Mono', monospace; margin-top: 6px; }
  .foot { text-align: center; font-size: 11px; color: var(--text-label); margin-top: 22px; }
</style>
</head>
<body data-stage="${stage}">
  <div class="card">
    <div class="logo">📚</div>
    <h1>Giao bài</h1>
    <p class="sub">Khu vực quản trị — chỉ dành cho Super Admin</p>

    <!-- PIN STAGE -->
    <div class="stage" id="stagePin">
      <div class="err" id="pinError"><span id="pinErrorMsg"></span></div>
      <div class="pin-dots" id="pinDots">
        <div class="pin-dot"></div><div class="pin-dot"></div><div class="pin-dot"></div><div class="pin-dot"></div>
        <div class="pin-dot"></div><div class="pin-dot"></div><div class="pin-dot"></div><div class="pin-dot"></div>
      </div>
      <div class="keypad" id="keypad">
        <button class="key" data-d="1">1</button><button class="key" data-d="2">2</button><button class="key" data-d="3">3</button>
        <button class="key" data-d="4">4</button><button class="key" data-d="5">5</button><button class="key" data-d="6">6</button>
        <button class="key" data-d="7">7</button><button class="key" data-d="8">8</button><button class="key" data-d="9">9</button>
        <button class="key act" data-act="clear">Xóa</button><button class="key" data-d="0">0</button><button class="key act" data-act="back">←</button>
      </div>
    </div>

    <!-- LOGIN STAGE -->
    <div class="stage" id="stageLogin">
      <div class="err" id="loginError"><span id="loginErrorMsg"></span></div>
      <label for="email">Email</label>
      <input type="email" id="email" autocomplete="username" placeholder="you@tansinh.info">
      <label for="password">Mật khẩu</label>
      <input type="password" id="password" autocomplete="current-password" placeholder="••••••••">
      <button class="btn" id="loginBtn"><span class="spin"></span><span class="btn-text">Đăng nhập</span></button>
    </div>

    <!-- LOCK STAGE -->
    <div class="stage" id="stageLock">
      <div class="lock">
        <div id="lockMsg" style="font-size:14px;color:var(--danger-text);font-weight:600;white-space:pre-line;"></div>
        <div class="lock-time" id="lockTime"></div>
      </div>
    </div>

    <div class="foot">TANSINH · giaobai</div>
  </div>

<script>
  let pinBuffer = '';
  let pinSubmitting = false;

  function setStage(s) {
    document.body.setAttribute('data-stage', s);
    document.getElementById('stagePin').classList.toggle('active', s === 'pin');
    document.getElementById('stageLogin').classList.toggle('active', s === 'login');
    document.getElementById('stageLock').classList.toggle('active', s === 'lock');
    if (s === 'login') setTimeout(() => { const e = document.getElementById('email'); if (e) e.focus(); }, 50);
  }

  function showError(boxId, msgId, msg) {
    const b = document.getElementById(boxId), m = document.getElementById(msgId);
    if (m) m.innerText = msg;
    if (b) b.classList.add('show');
  }
  function hideError(boxId) { const b = document.getElementById(boxId); if (b) b.classList.remove('show'); }

  function renderDots(animate) {
    const dots = document.querySelectorAll('#pinDots .pin-dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
  }

  let lockTimer = null;
  function showLockout(msg, seconds) {
    setStage('lock');
    document.getElementById('lockMsg').innerText = msg;
    const el = document.getElementById('lockTime');
    if (lockTimer) clearInterval(lockTimer);
    if (seconds === -1) { el.innerText = '∞'; return; }
    let s = seconds;
    const tick = () => {
      if (s <= 0) { clearInterval(lockTimer); location.reload(); return; }
      const m = Math.floor(s / 60), sec = s % 60;
      el.innerText = m + ':' + String(sec).padStart(2, '0');
      s--;
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  // ===== PIN =====
  async function submitPin() {
    if (pinSubmitting) return;
    pinSubmitting = true;
    try {
      const res = await fetch('/gb-gate/pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinBuffer })
      });
      const data = await res.json();
      if (data.ok) { setStage('login'); pinBuffer = ''; renderDots(false); pinSubmitting = false; return; }
      if (data.error === 'locked' && data.lock) {
        if (data.lock.permanent) showLockout('Bị khóa vĩnh viễn.\\nLiên hệ quản trị máy chủ.', -1);
        else if (data.lock.remaining) showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
        return;
      }
      let msg = 'Mã PIN sai.';
      if (data.attempts) {
        const left = (data.attempts < 3) ? (3 - data.attempts) : (data.attempts < 6) ? (6 - data.attempts) : (data.attempts < 9) ? (9 - data.attempts) : 0;
        if (left > 0) msg += ' Còn ' + left + ' lần.';
      }
      if (data.lock && data.lock.remaining) showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
      else if (data.lock && data.lock.permanent) showLockout('Bị khóa vĩnh viễn.\\nLiên hệ quản trị máy chủ.', -1);
      else showError('pinError', 'pinErrorMsg', msg);
      setTimeout(() => { pinBuffer = ''; renderDots(false); pinSubmitting = false; }, 700);
    } catch (e) {
      showError('pinError', 'pinErrorMsg', 'Lỗi kết nối. Thử lại.');
      pinBuffer = ''; renderDots(false); pinSubmitting = false;
    }
  }

  function pressDigit(d) {
    hideError('pinError');
    if (pinBuffer.length >= 8) return;
    pinBuffer += d; renderDots(true);
    if (pinBuffer.length === 8) submitPin();
  }
  function pressBack() { hideError('pinError'); pinBuffer = pinBuffer.slice(0, -1); renderDots(false); }
  function pressClear() { hideError('pinError'); pinBuffer = ''; renderDots(false); }

  document.getElementById('keypad').addEventListener('click', (e) => {
    const k = e.target.closest('.key'); if (!k) return;
    if (k.dataset.d) pressDigit(k.dataset.d);
    else if (k.dataset.act === 'back') pressBack();
    else if (k.dataset.act === 'clear') pressClear();
  });
  document.addEventListener('keydown', (e) => {
    if (document.body.getAttribute('data-stage') !== 'pin') return;
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); pressDigit(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); pressBack(); }
    else if (e.key === 'Escape') { e.preventDefault(); pressClear(); }
  });

  // ===== LOGIN =====
  async function doLogin() {
    const btn = document.getElementById('loginBtn');
    const email = document.getElementById('email').value.trim();
    const pass = document.getElementById('password').value;
    if (!email || !pass) { showError('loginError', 'loginErrorMsg', 'Nhập đủ email và mật khẩu.'); return; }

    btn.classList.add('loading'); btn.disabled = true; hideError('loginError');
    try {
      const res = await fetch('/gb-gate/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pass })
      });
      const data = await res.json();
      if (data.ok) {
        btn.classList.remove('loading');
        const txt = btn.querySelector('.btn-text');
        if (txt) txt.innerText = '✓ Thành công';
        setTimeout(() => { window.location.href = '/'; }, 500);
        return;
      }
      if (data.error === 'no_pin') {
        setStage('pin'); pinBuffer = ''; pinSubmitting = false; renderDots(false);
        showError('pinError', 'pinErrorMsg', 'Phiên hết hạn. Nhập lại mã PIN.');
        return;
      }
      if (data.error === 'locked' && data.lock) {
        if (data.lock.permanent) showLockout('Bị khóa vĩnh viễn.\\nLiên hệ quản trị máy chủ.', -1);
        else if (data.lock.remaining) showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
        return;
      }
      let msg = 'Email hoặc mật khẩu sai.';
      if (data.error === 'not_admin') msg = 'Tài khoản này không phải Super Admin.';
      if (data.attempts) {
        const left = (data.attempts < 3) ? (3 - data.attempts) : (data.attempts < 6) ? (6 - data.attempts) : (data.attempts < 9) ? (9 - data.attempts) : 0;
        if (left > 0) msg += ' Còn ' + left + ' lần.';
      }
      if (data.lock && data.lock.remaining) showLockout('Quá nhiều lần sai.\\nThử lại sau:', data.lock.remaining);
      else if (data.lock && data.lock.permanent) showLockout('Bị khóa vĩnh viễn.\\nLiên hệ quản trị máy chủ.', -1);
      else showError('loginError', 'loginErrorMsg', msg);
    } catch (e) {
      showError('loginError', 'loginErrorMsg', 'Lỗi kết nối. Thử lại.');
    } finally {
      btn.classList.remove('loading'); btn.disabled = false;
    }
  }

  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('password').focus(); });

  // Boot
  const initLock = ${lockSeconds};
  if (initLock === -1) showLockout('Bị khóa vĩnh viễn.\\nLiên hệ quản trị máy chủ.', -1);
  else if (initLock > 0) showLockout('Quá nhiều lần sai.\\nThử lại sau:', initLock);
  else setStage('${stage}');
</script>
</body>
</html>`;
}
