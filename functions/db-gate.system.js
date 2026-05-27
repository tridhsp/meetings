const crypto = require('crypto');

// === CONFIG ===
const COOKIE_SECRET = '973ff6de62ac3aa1ff6d8870c85c322da62793d8f31b100a5652dd9077bbb41a';
const COOKIE_NAME = 'db_gate_session';
const PIN_COOKIE_NAME = 'db_gate_pin';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PIN_TTL = 10 * 60 * 1000;          // 10 minutes (just long enough to finish login)
const ENTRY_PIN = process.env.DB_GATE_PIN || '96325126';

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

module.exports = function(app) {

  // --- Auth check (nginx auth_request calls this) ---
  app.get('/db-gate/check', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (readSignedJWTLike(cookies, COOKIE_NAME)) return res.sendStatus(200);
    return res.sendStatus(401);
  });

  // --- Login page (PIN or login depending on cookie state) ---
  app.get('/db-gate', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (readSignedJWTLike(cookies, COOKIE_NAME)) return res.redirect('/');
    const pinPassed = !!readSignedJWTLike(cookies, PIN_COOKIE_NAME);
    const ip = getClientIP(req);
    const lock = getLockInfo(ip);
    res.type('html').send(buildLoginPage(lock, pinPassed));
  });

  // --- PIN verify ---
  app.post('/db-gate/pin', (req, res) => {
    const ip = getClientIP(req);
    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[db-gate] BLOCKED ' + ip + ' (locked at PIN stage)');
      return res.status(429).json({ error: 'locked', lock });
    }
    const { pin } = req.body || {};
    if (pin === ENTRY_PIN) {
      const payload = Buffer.from(JSON.stringify({ ip, exp: Date.now() + PIN_TTL })).toString('base64url');
      const signed = signValue(payload);
      res.cookie(PIN_COOKIE_NAME, signed, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: PIN_TTL, path: '/'
      });
      console.log('[db-gate] 🔓 PIN ok from ' + ip);
      return res.json({ ok: true });
    }
    const r = recordFail(ip);
    console.log('[db-gate] ❌ Bad PIN from ' + ip + ' (attempt ' + r.count + ')');
    const lock = getLockInfo(ip);
    return res.status(401).json({ error: 'invalid_pin', attempts: r.count, lock });
  });

  // --- Login POST (requires PIN cookie) ---
  app.post('/db-gate/login', (req, res) => {
    const ip = getClientIP(req);

    if (isLocked(ip)) {
      const lock = getLockInfo(ip);
      console.log('[db-gate] BLOCKED ' + ip + ' (locked at login stage)');
      return res.status(429).json({ error: 'locked', lock });
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!readSignedJWTLike(cookies, PIN_COOKIE_NAME)) {
      return res.status(403).json({ error: 'no_pin' });
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
      res.clearCookie(PIN_COOKIE_NAME, { path: '/' });
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
    res.clearCookie(PIN_COOKIE_NAME, { path: '/' });
    res.redirect('/db-gate');
  });

  // --- Admin: list bans ---
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
// LOGIN PAGE HTML — Modern light theme with PIN + login flow
// ============================================================
function buildLoginPage(lock, pinPassed) {
  let lockSeconds = 0;
  if (lock) {
    if (lock.permanent) lockSeconds = -1;
    else if (lock.remaining) lockSeconds = lock.remaining;
  }
  const stage = pinPassed ? 'login' : 'pin';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Database Access — db.tansinh.info</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #eef2f7;
    --surface: #ffffff;
    --surface-soft: #f7f9fc;
    --border: #e3e8ef;
    --border-strong: #c9d1dc;
    --text: #0a1322;
    --text-soft: #3b475c;
    --text-dim: #67718a;
    --text-label: #8b94a8;
    --accent: #059669;
    --accent-hover: #047857;
    --accent-soft: #ecfdf5;
    --accent-grad: linear-gradient(135deg, #10b981 0%, #059669 100%);
    --accent-grad-hover: linear-gradient(135deg, #14c191 0%, #047857 100%);
    --danger: #dc2626;
    --danger-soft: #fef2f2;
    --danger-text: #991b1b;
    --warning: #b45309;
    --warning-soft: #fef7e6;
    --warning-text: #78350f;
    --radius: 16px;
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
    -moz-osx-font-smoothing: grayscale;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(circle at 12% 18%, rgba(16, 185, 129, 0.22) 0%, transparent 42%),
      radial-gradient(circle at 88% 82%, rgba(244, 114, 182, 0.13) 0%, transparent 48%),
      radial-gradient(circle at 60% 110%, rgba(245, 158, 11, 0.13) 0%, transparent 42%),
      radial-gradient(circle at 75% 8%, rgba(99, 102, 241, 0.12) 0%, transparent 45%);
    pointer-events: none;
    z-index: 0;
  }

  body::after {
    content: '';
    position: fixed;
    inset: 0;
    background-image: radial-gradient(circle, rgba(10, 19, 34, 0.04) 0.5px, transparent 0.5px);
    background-size: 3px 3px;
    pointer-events: none;
    z-index: 0;
    opacity: 0.35;
  }

  /* Top bar */
  .top-bar {
    position: relative;
    z-index: 2;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 22px 32px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .brand-mark {
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--accent-grad);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    box-shadow: 0 3px 8px rgba(16, 185, 129, 0.32), 0 0 0 1px rgba(16, 185, 129, 0.1) inset;
  }

  .brand-mark svg { width: 13px; height: 13px; }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
    animation: pulse 2.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
    50% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0.04); }
  }

  /* Stage */
  .stage {
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .card {
    position: relative;
    width: 100%;
    max-width: 448px;
    background: var(--surface);
    border: 1px solid rgba(15, 25, 45, 0.04);
    border-radius: var(--radius);
    padding: 40px 40px 32px;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 1) inset,
      0 1px 3px rgba(15, 25, 45, 0.04),
      0 10px 28px rgba(15, 25, 45, 0.06),
      0 36px 88px rgba(15, 25, 45, 0.09);
    animation: cardIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(14px) scale(0.99); }
    to { opacity: 1; transform: none; }
  }

  /* Panels */
  .panel { display: none; }
  body[data-stage="pin"] .panel-pin { display: block; animation: panelIn 0.45s cubic-bezier(0.16, 1, 0.3, 1); }
  body[data-stage="login"] .panel-login { display: block; animation: panelIn 0.45s cubic-bezier(0.16, 1, 0.3, 1); }
  body.locked .panel { display: none !important; }

  @keyframes panelIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  .step-label {
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.14em;
    color: var(--text-label);
    text-transform: uppercase;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .step-label .step-bar {
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, var(--border) 0%, transparent 100%);
  }

  h1 {
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.028em;
    line-height: 1.12;
    margin-bottom: 8px;
    color: var(--text);
  }

  .subtitle {
    font-size: 14px;
    color: var(--text-soft);
    font-weight: 400;
    margin-bottom: 28px;
    line-height: 1.55;
  }

  /* ========== PIN PANEL ========== */

  .pin-dots {
    display: flex;
    justify-content: center;
    gap: 9px;
    margin-bottom: 26px;
    height: 18px;
    align-items: center;
  }

  .pin-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: transparent;
    border: 1.8px solid var(--border-strong);
    transition: all 0.18s ease;
  }

  .pin-dot.filled {
    background: var(--accent);
    border-color: var(--accent);
    transform: scale(1.15);
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
  }

  .pin-dot.error {
    background: var(--danger);
    border-color: var(--danger);
  }

  .pin-dots.shake { animation: shake 0.4s ease; }

  .keypad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 9px;
  }

  .key {
    aspect-ratio: 1.45;
    background: var(--surface-soft);
    border: 1px solid var(--border);
    border-radius: 11px;
    font-family: var(--sans);
    font-size: 22px;
    font-weight: 500;
    color: var(--text);
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, transform 0.07s ease, border-color 0.12s ease, color 0.12s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .key:hover {
    background: white;
    border-color: var(--border-strong);
  }

  .key:active {
    transform: scale(0.96);
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-hover);
  }

  .key.action {
    font-size: 13px;
    color: var(--text-dim);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-family: var(--mono);
  }

  .key.action svg { width: 18px; height: 18px; }

  .pin-hint {
    text-align: center;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--text-label);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-top: 18px;
  }

  /* ========== LOGIN PANEL ========== */

  .field { margin-bottom: 14px; }

  label {
    display: block;
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-label);
    margin-bottom: 7px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    background: var(--surface-soft);
    border: 1px solid var(--border);
    border-radius: 9px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 14px;
    outline: none;
    transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
  }

  input::placeholder { color: #b3bbcb; font-family: var(--mono); }
  input:hover { border-color: var(--border-strong); }
  input:focus {
    background: white;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.14);
  }

  .btn {
    width: 100%;
    padding: 13px 16px;
    background: var(--accent-grad);
    color: white;
    border: none;
    border-radius: 9px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
    cursor: pointer;
    margin-top: 12px;
    position: relative;
    overflow: hidden;
    transition: transform 0.08s ease, box-shadow 0.25s ease, background 0.25s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    box-shadow: 0 4px 14px rgba(16, 185, 129, 0.28), 0 1px 0 rgba(255,255,255,0.18) inset;
  }

  .btn:hover:not(:disabled) {
    background: var(--accent-grad-hover);
    box-shadow: 0 8px 22px rgba(16, 185, 129, 0.4);
  }

  .btn .arrow { display: inline-flex; transition: transform 0.22s ease; }
  .btn:hover:not(:disabled) .arrow { transform: translateX(4px); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn.loading .btn-text, .btn.loading .arrow { visibility: hidden; }
  .btn.loading::after {
    content: '';
    position: absolute;
    inset: 0;
    margin: auto;
    width: 18px;
    height: 18px;
    border: 2.4px solid rgba(255,255,255,0.35);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ========== ALERTS / LOCKOUT ========== */

  .alert {
    border-radius: 9px;
    padding: 11px 13px;
    margin-bottom: 16px;
    font-size: 13px;
    line-height: 1.45;
    display: none;
    align-items: flex-start;
    gap: 10px;
  }

  .alert.show { display: flex; }

  .alert.error {
    background: var(--danger-soft);
    border: 1px solid rgba(220, 38, 38, 0.18);
    color: var(--danger-text);
    animation: shake 0.4s ease;
  }

  .alert .ico { flex-shrink: 0; width: 16px; height: 16px; margin-top: 1px; color: var(--danger); }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(5px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(2px); }
  }

  .lockout {
    background: var(--warning-soft);
    border: 1px solid rgba(180, 83, 9, 0.22);
    border-radius: 11px;
    padding: 22px;
    text-align: center;
    display: none;
  }
  .lockout.show { display: block; }

  .lockout .lk-icon {
    width: 40px;
    height: 40px;
    margin: 0 auto 12px;
    border-radius: 11px;
    background: white;
    border: 1px solid rgba(180, 83, 9, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--warning);
  }
  .lockout .lk-icon svg { width: 20px; height: 20px; }

  .lockout .lk-label {
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--warning);
    margin-bottom: 6px;
  }

  .lockout .lk-msg {
    font-size: 13px;
    color: var(--warning-text);
    line-height: 1.5;
    white-space: pre-line;
  }

  .lockout .lk-timer {
    font-family: var(--mono);
    font-size: 30px;
    font-weight: 500;
    color: var(--warning);
    margin-top: 14px;
    letter-spacing: 0.04em;
  }

  /* ========== FOOTER ========== */

  .foot {
    position: relative;
    z-index: 2;
    padding: 22px 32px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    color: var(--text-label);
    text-transform: uppercase;
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  @media (max-width: 520px) {
    .card { padding: 30px 22px 24px; max-width: 380px; }
    h1 { font-size: 24px; }
    .top-bar, .foot { padding: 18px 18px; font-size: 10px; }
    .key { font-size: 20px; border-radius: 10px; }
    .keypad { gap: 8px; }
    .brand { font-size: 13px; }
  }
</style>
</head>
<body data-stage="${stage}">
  <header class="top-bar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 12 12" fill="currentColor">
          <ellipse cx="6" cy="3" rx="4.4" ry="1.4"/>
          <path d="M1.6 5.4 v3.2 c0 0.78 1.97 1.4 4.4 1.4 s4.4 -0.62 4.4 -1.4 v-3.2 c0 0.78 -1.97 1.4 -4.4 1.4 S1.6 6.18 1.6 5.4z"/>
        </svg>
      </span>
      db.tansinh
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
        <div class="lk-label">Locked Out</div>
        <div class="lk-msg" id="lockMsg">Too many failed attempts</div>
        <div class="lk-timer" id="lockTimer"></div>
      </div>

      <!-- PIN PANEL -->
      <div class="panel panel-pin">
        <div class="step-label">Step 01 &middot; Access Code <span class="step-bar"></span></div>
        <h1>Welcome back.</h1>
        <p class="subtitle">Enter your 8-digit access code to continue.</p>

        <div class="pin-dots" id="pinDots">
          <span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span>
          <span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span>
        </div>

        <div class="alert error" id="pinError">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5"/>
            <line x1="8" y1="5" x2="8" y2="8.5"/>
            <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>
          </svg>
          <span id="pinErrorMsg">Incorrect code</span>
        </div>

        <div class="keypad" id="keypad">
          <button class="key" type="button" data-d="1">1</button>
          <button class="key" type="button" data-d="2">2</button>
          <button class="key" type="button" data-d="3">3</button>
          <button class="key" type="button" data-d="4">4</button>
          <button class="key" type="button" data-d="5">5</button>
          <button class="key" type="button" data-d="6">6</button>
          <button class="key" type="button" data-d="7">7</button>
          <button class="key" type="button" data-d="8">8</button>
          <button class="key" type="button" data-d="9">9</button>
          <button class="key action" type="button" data-act="clear" title="Clear (Esc)">Clear</button>
          <button class="key" type="button" data-d="0">0</button>
          <button class="key action" type="button" data-act="back" title="Backspace" aria-label="Backspace">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 5H8l-7 7 7 7h13a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/>
              <line x1="18" y1="9" x2="12" y2="15"/>
              <line x1="12" y1="9" x2="18" y2="15"/>
            </svg>
          </button>
        </div>

        <div class="pin-hint">Type or tap &middot; auto-submits at 8 digits</div>
      </div>

      <!-- LOGIN PANEL -->
      <div class="panel panel-login">
        <div class="step-label">Step 02 &middot; Sign In <span class="step-bar"></span></div>
        <h1>Authenticate.</h1>
        <p class="subtitle">Enter your administrator credentials to access the dashboard.</p>

        <div class="alert error" id="loginError">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5"/>
            <line x1="8" y1="5" x2="8" y2="8.5"/>
            <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>
          </svg>
          <span id="loginErrorMsg">Invalid credentials</span>
        </div>

        <div class="field">
          <label for="username">Username</label>
          <input type="text" id="username" autocomplete="username" placeholder="username" spellcheck="false">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" autocomplete="current-password" placeholder="••••••••••">
        </div>
        <button class="btn" id="loginBtn" type="button" onclick="doLogin()">
          <span class="btn-text">Continue</span>
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

  <footer class="foot">
    <span>Tansinh &middot; Self-hosted Supabase</span>
    <span>Protected</span>
  </footer>

<script>
  const INIT_LOCK_SECONDS = ${lockSeconds};
  const INIT_LOCK_PERMANENT = ${lock && lock.permanent ? 'true' : 'false'};
  let lockRemaining = INIT_LOCK_SECONDS;

  let pinBuffer = '';
  const PIN_LEN = 8;
  let pinSubmitting = false;

  if (INIT_LOCK_PERMANENT) {
    showLockout('Access permanently blocked.\\nContact the server administrator to lift the ban.', -1);
  } else if (INIT_LOCK_SECONDS > 0) {
    showLockout('Too many failed attempts.\\nTry again in:', INIT_LOCK_SECONDS);
  }

  function showLockout(msg, seconds) {
    document.body.classList.add('locked');
    document.getElementById('lockoutBox').classList.add('show');
    document.getElementById('lockMsg').innerText = msg;

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
        window.location.reload();
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

  function showError(boxId, msgId, msg) {
    const box = document.getElementById(boxId);
    document.getElementById(msgId).innerText = msg;
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
  }

  // ========== PIN ==========

  function renderDots(errState) {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
      dot.classList.remove('filled', 'error');
      if (errState) dot.classList.add('error');
      else if (i < pinBuffer.length) dot.classList.add('filled');
    });
  }

  function clearPinErrState() {
    document.getElementById('pinError').classList.remove('show');
  }

  function pressDigit(d) {
    if (pinSubmitting) return;
    clearPinErrState();
    if (pinBuffer.length >= PIN_LEN) return;
    pinBuffer += d;
    renderDots(false);
    if (pinBuffer.length === PIN_LEN) submitPin();
  }

  function pressBack() {
    if (pinSubmitting) return;
    clearPinErrState();
    if (pinBuffer.length === 0) return;
    pinBuffer = pinBuffer.slice(0, -1);
    renderDots(false);
  }

  function pressClear() {
    if (pinSubmitting) return;
    clearPinErrState();
    pinBuffer = '';
    renderDots(false);
  }

  async function submitPin() {
    pinSubmitting = true;
    try {
      const res = await fetch('/db-gate/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinBuffer })
      });
      const data = await res.json();

      if (data.ok) {
        document.querySelectorAll('.pin-dot').forEach(d => { d.classList.remove('error'); d.classList.add('filled'); });
        setTimeout(() => {
          document.body.setAttribute('data-stage', 'login');
          setTimeout(() => {
            const u = document.getElementById('username');
            if (u) u.focus();
          }, 120);
        }, 380);
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

      renderDots(true);
      document.getElementById('pinDots').classList.add('shake');
      setTimeout(() => document.getElementById('pinDots').classList.remove('shake'), 420);

      let msg = 'Incorrect code.';
      if (data.attempts) {
        const left = (data.attempts < 3) ? (3 - data.attempts) : (data.attempts < 6) ? (6 - data.attempts) : (data.attempts < 9) ? (9 - data.attempts) : 0;
        if (left > 0) msg += ' ' + left + ' attempt' + (left > 1 ? 's' : '') + ' remaining.';
      }

      if (data.lock && data.lock.remaining) {
        showLockout('Too many failed attempts.\\nTry again in:', data.lock.remaining);
      } else if (data.lock && data.lock.permanent) {
        showLockout('Access permanently blocked.\\nContact the server administrator.', -1);
      } else {
        showError('pinError', 'pinErrorMsg', msg);
      }

      setTimeout(() => {
        pinBuffer = '';
        renderDots(false);
        pinSubmitting = false;
      }, 750);

    } catch (e) {
      showError('pinError', 'pinErrorMsg', 'Connection error. Try again.');
      pinBuffer = '';
      renderDots(false);
      pinSubmitting = false;
    }
  }

  document.getElementById('keypad').addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (!k) return;
    if (k.dataset.d) pressDigit(k.dataset.d);
    else if (k.dataset.act === 'back') pressBack();
    else if (k.dataset.act === 'clear') pressClear();
  });

  document.addEventListener('keydown', (e) => {
    if (document.body.getAttribute('data-stage') !== 'pin') return;
    if (document.body.classList.contains('locked')) return;
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); pressDigit(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); pressBack(); }
    else if (e.key === 'Escape') { e.preventDefault(); pressClear(); }
  });

  // ========== LOGIN ==========

  async function doLogin() {
    const btn = document.getElementById('loginBtn');
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;

    if (!user || !pass) {
      showError('loginError', 'loginErrorMsg', 'Please enter both fields.');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    document.getElementById('loginError').classList.remove('show');

    try {
      const res = await fetch('/db-gate/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();

      if (data.ok) {
        btn.classList.remove('loading');
        btn.style.background = '#059669';
        const txt = btn.querySelector('.btn-text');
        const arr = btn.querySelector('.arrow');
        if (txt) { txt.innerText = '✓ Authenticated'; txt.style.visibility = 'visible'; }
        if (arr) arr.style.visibility = 'hidden';
        setTimeout(() => { window.location.href = '/'; }, 600);
        return;
      }

      if (data.error === 'no_pin') {
        document.body.setAttribute('data-stage', 'pin');
        pinBuffer = '';
        pinSubmitting = false;
        renderDots(false);
        showError('pinError', 'pinErrorMsg', 'Session expired. Please re-enter your access code.');
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

      let msg = 'Invalid credentials.';
      if (data.attempts) {
        const left = (data.attempts < 3) ? (3 - data.attempts) : (data.attempts < 6) ? (6 - data.attempts) : (data.attempts < 9) ? (9 - data.attempts) : 0;
        if (left > 0) msg += ' ' + left + ' attempt' + (left > 1 ? 's' : '') + ' remaining.';
      }

      if (data.lock && data.lock.remaining) {
        showLockout('Too many failed attempts.\\nTry again in:', data.lock.remaining);
      } else if (data.lock && data.lock.permanent) {
        showLockout('Access permanently blocked.\\nContact the server administrator.', -1);
      } else {
        showError('loginError', 'loginErrorMsg', msg);
      }

    } catch (e) {
      showError('loginError', 'loginErrorMsg', 'Connection error. Try again.');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('password').focus(); });

  if (document.body.getAttribute('data-stage') === 'login') {
    const u = document.getElementById('username');
    if (u) u.focus();
  }
</script>
</body>
</html>`;
}
