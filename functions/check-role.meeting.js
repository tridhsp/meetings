// GET /check-role
// Returns { allowed, role } for the authenticated user
module.exports = function (app) {
  app.get('/check-role', async (req, res) => {
    try {
      const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
      const ANON_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.ANON_PUBLIC_KEY;

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANON_PUBLIC_KEY) {
        return res.status(500).json({ error: 'Missing server env vars' });
      }

      const auth = req.headers.authorization || '';
      if (!auth || !/^Bearer\s+/i.test(auth)) {
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      const accessToken = auth.replace(/^Bearer\s+/i, '');

      // 1) Get the user (email) from Supabase Auth
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: ANON_PUBLIC_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });

      const user = await userRes.json();
      const email = user?.email;
      if (!email) return res.status(401).json({ error: 'No email on token' });

      // 2) Look up role from user_roles
      const url = new URL(`${SUPABASE_URL}/rest/v1/user_roles`);
      url.searchParams.set('select', 'role');
      url.searchParams.set('email', `eq.${email}`);
      url.searchParams.set('limit', '1');

      const roleRes = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!roleRes.ok) {
        const t = await roleRes.text();
        return res.status(roleRes.status).json({ error: 'Role query failed', details: t });
      }

      const rows = await roleRes.json();
      const role = rows?.[0]?.role ?? null;
      const allowed = role === 'Admin' || role === 'Super Admin';

      return res.json({ allowed, role });
    } catch (e) {
      return res.status(500).json({ error: 'Server error', details: String(e) });
    }
  });
};
