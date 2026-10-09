// _ringKeyHelper.js  --  the security-key gate for ring.tansinh.info  (13 Sep 2026)
//
// NOT A ROUTE. Starts with "_" so server.js never loads it as one; named
// *Helper.js -- capital H, no hyphen -- so git-push-site.sh line 110 collects it.
//
// THE KEYS live exactly where meetings.tansinh.info keeps them: ONE row in
// security_key_for_teachers with admin_key and teacher_key, rotated on the 1st
// and 15th by sk-auto-key-generator and replaced wholesale by sk-admin-api.
// Nothing here writes to that table. One system, one set of keys.
//
// TWO LEVELS
//   'teacher'  satisfied by EITHER key        -> placing a call
//   'admin'    satisfied by admin_key ONLY    -> adding, editing, revealing a contact
//
// WHERE THE KEY TRAVELS: in the X-Security-Key header, ON THE REQUEST THAT
// DOES THE THING. meetings.tansinh.info verifies first in a separate call and
// the action route then trusts the page -- so its action routes are not
// actually locked. Here the route IS the lock; the page only draws the prompt.
//
// WHEN THE KEY IS MISSING OR WRONG the reply is 403 with need_key = the level
// required, and the page turns that into the prompt. Ten wrong keys from one
// account in ten minutes earns a 429 and a wait.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const TABLE      = 'security_key_for_teachers';
const MAX_TRIES  = 10;
const WINDOW_MS  = 10 * 60 * 1000;

function sb() {
  return createClient(
    process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Constant-time compare, so a wrong key costs the same as a nearly-right one.
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function currentKeys() {
  const { data, error } = await sb().from(TABLE)
    .select('admin_key, teacher_key').order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const r = data && data[0];
  return { admin:   r ? String(r.admin_key   || '').trim() : '',
           teacher: r ? String(r.teacher_key || '').trim() : '' };
}

// 'admin' | 'teacher' | null. Never says which one was close.
async function levelOf(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return null;
  const cur = await currentKeys();
  if (cur.admin   && same(k, cur.admin))   return 'admin';
  if (cur.teacher && same(k, cur.teacher)) return 'teacher';
  return null;
}

function satisfies(got, need) {
  return got === 'admin' || (need === 'teacher' && got === 'teacher');
}

// ---------------------------------------------------------- attempt limiter
const tries = new Map();   // email -> [timestamps]
function recent(email) {
  const now = Date.now();
  const list = (tries.get(email) || []).filter(t => now - t < WINDOW_MS);
  tries.set(email, list);
  return list;
}
function tooMany(email) { return recent(email).length >= MAX_TRIES; }
function noteFail(email) { recent(email).push(Date.now()); }
function noteOk(email)   { tries.delete(email); }

// Gate a route. Returns true to carry on, or sends the refusal and returns false.
//   need  'teacher' | 'admin'
//   u     the user gate() already resolved, for the limiter and the log
async function requireKey(req, res, need, u) {
  const email = (u && u.email) || 'anon';
  if (tooMany(email)) {
    res.status(429).json({ error: 'Sai khóa quá nhiều lần. Thử lại sau 10 phút.', need_key: need });
    return false;
  }
  const key = String(req.headers['x-security-key'] || '').trim();
  let got = null;
  if (key) {
    try { got = await levelOf(key); }
    catch (e) { res.status(500).json({ error: 'Không đọc được khóa bảo mật: ' + ((e && e.message) || e) }); return false; }
  }
  if (satisfies(got, need)) { noteOk(email); return true; }
  if (key) { noteFail(email); console.log('[ring-key] wrong ' + need + ' key from ' + email); }
  res.status(403).json({
    error: need === 'admin' ? 'Cần khóa bảo mật Admin.' : 'Cần khóa bảo mật giáo viên.',
    need_key: need,
  });
  return false;
}

module.exports = { levelOf, satisfies, requireKey, tooMany, noteFail, noteOk, same, _tries: tries };
