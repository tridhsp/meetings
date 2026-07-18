// _scoreHelper.js — shared helpers for the score.tansinh.info routes.
// Leading underscore => not auto-loaded as a route (same convention as _bookshelfHelper.js).
const { createClient } = require('@supabase/supabase-js');

// Service-key client (bypasses RLS — same as every other app route).
function getSupabase() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Pull the Supabase access token from the request (body or Authorization header).
function tokenFrom(req) {
  if (req.body && req.body.access_token) return req.body.access_token;
  const h = (req.headers && req.headers.authorization) ? req.headers.authorization : '';
  return h.replace(/^Bearer\s+/i, '');
}

// Validate a token -> the signed-in user (or null). Can't be spoofed with just an email.
async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (e) {
    return null;
  }
}

// Look up a role by email from user_roles (same table/column the other apps use).
async function getRoleByEmail(email) {
  if (!email) return null;
  const { data } = await getSupabase()
    .from('user_roles')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  return (data && data.role) ? String(data.role).trim() : null;
}

module.exports = { getSupabase, tokenFrom, getUserFromToken, getRoleByEmail };
