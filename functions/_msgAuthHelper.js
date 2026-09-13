// /opt/my-api/routes/_msgAuthHelper.js
// The Supabase token gate for message.tansinh.info's routes. Added Sep 2026.
//
// WHY IT EXISTS: the 29 *.message.js routes were converted from Netlify
// functions and NONE of them checks a token. Each one builds a service-key
// Supabase client and acts on whatever the request body says. This is the
// one piece of auth they can all share.
//
// ⚠️ THE NAME MATTERS. git-push-site.sh line 97 collects helpers matching
//    _*Helper.js — capital H, no hyphen. "_msg-auth.helper.js" would match
//    nothing and end up in no repo at all, exactly like _cache-helper.js
//    and _rtr-duration.helper.js.
// ⚠️ Never loaded as a route: server.js requires route files by name and
//    this one is never named.
//
// It is lifted from gate() in mtx-api.messages.js so the two agree on what
// a role means, with two deliberate differences:
//
//   1. IT NEVER THROWS. mtx-api calls gate() OUTSIDE its try/catch, so a
//      missing env var turns into an unhandled rejection. Here every failure
//      path is caught and answered with a 500, and the caller only ever has
//      to write:  const who = await gate(req, res, 'admin'); if (!who) return;
//   2. THE TOKEN CACHE EVICTS. mtx-api's grows forever, keyed on a rotating
//      JWT. This one prunes expired entries once it passes MAX_CACHE.
//
// ⚠️ IT FAILS CLOSED. If Supabase is unreachable the answer is 500 and the
//    request is refused. That is the right way round for a route that can
//    message every parent in the school — but it is the OPPOSITE of the
//    three-state rule in 2.13-RECGATE, where "cannot tell" must hold the
//    current state rather than lock a teacher out mid-lesson. Different
//    question, different answer. Do not copy this into a gate that decides
//    whether somebody may keep working.

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Same three strings, same capitals, as RECORD_ROLES in mtx-api.messages.js
// and as the user_roles table. A lowercase "teacher" in the database silently
// loses that person their access, and nothing explains why.
const ROLES = {
  staff: new Set(['Teacher', 'Admin', 'Super Admin']),
  admin: new Set(['Admin', 'Super Admin']),
  super: new Set(['Super Admin'])
};

const TTL_MS = 120000;      // same 2 minutes as mtx-api
const MAX_CACHE = 500;
const cache = new Map();    // token -> { email, role, expires }

function prune(now) {
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  // still too big after dropping the expired ones: this is not a normal
  // amount of live sessions, so start again rather than grow without limit
  if (cache.size > MAX_CACHE) cache.clear();
}

/**
 * @param {object} req   express request
 * @param {object} res   express response — this function answers it on failure
 * @param {string} level 'staff' | 'admin' | 'super'   (default 'staff')
 * @returns {Promise<{email:string, role:string}|null>}  null means it already replied
 */
module.exports = async function gate(req, res, level) {
  const allow = ROLES[level] || ROLES.staff;
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Please sign in first.', signin: true });
      return null;
    }

    const now = Date.now();
    let email = null, role = null;
    const hit = cache.get(token);
    if (hit && hit.expires > now) { email = hit.email; role = hit.role; }

    if (email == null) {
      if (!SB_URL || !SB_KEY) {
        // dotenv loaded nothing — almost always the 0600 .env read as the
        // wrong user. Refuse rather than run unauthenticated.
        console.error('[msg-gate] SUPABASE env missing; refusing');
        res.status(500).json({ error: 'Server is not configured to check sign-ins.' });
        return null;
      }
      const sb = createClient(SB_URL, SB_KEY);
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data || !data.user || !data.user.email) {
        res.status(401).json({ error: 'Your session expired.', signin: true });
        return null;
      }
      email = String(data.user.email).toLowerCase();
      const { data: roleRow } = await sb.from('user_roles').select('role').eq('email', email).maybeSingle();
      // '' is cached too, so an account with no role cannot hammer user_roles
      role = (roleRow && roleRow.role) || '';
      if (cache.size >= MAX_CACHE) prune(now);
      cache.set(token, { email, role, expires: now + TTL_MS });
    }

    if (!allow.has(role)) {
      console.log('[msg-gate] refused ' + email + ' (role ' + JSON.stringify(role) + ') for ' + req.path);
      res.status(403).json({
        error: allow === ROLES.super ? 'Super Admin only.'
             : allow === ROLES.admin ? 'Admin or Super Admin only.'
             : 'Teacher, Admin or Super Admin only.'
      });
      return null;
    }
    return { email, role };
  } catch (e) {
    // fail closed, and say so in the log — a silent pass here would be worse
    // than an outage
    console.error('[msg-gate] check failed, refusing:', (e && e.message) || e);
    try { res.status(500).json({ error: 'Could not check your sign-in. Try again.' }); } catch (_) {}
    return null;
  }
};
