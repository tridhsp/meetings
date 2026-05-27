const { createClient } = require('@supabase/supabase-js');

async function verifyAuth(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return { user: null, error: 'No token provided' };
  }

  const supabase = createClient(
    (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
    process.env.SUPABASE_ANON_KEY
  );

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: error?.message || 'Invalid token' };
  }

  return { user: data.user, error: null };
}

module.exports = { verifyAuth };
