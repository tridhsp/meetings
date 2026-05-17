// migrated from netlify/functions/teacher-by-email.js
module.exports = function(app) {
  app.get('/teacher-by-email', async (req, res) => {
    try {
      const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
      const auth = req.headers.authorization || '';
      if (!/^Bearer\s+/i.test(auth)) return res.status(401).json({ error: 'Missing bearer token' });

      const email = (req.query.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Missing email' });

      const url = new URL(`${SUPABASE_URL}/rest/v1/user_roles`);
      url.searchParams.set('select', 'full_name,email');
      url.searchParams.set('email', `eq.${email}`);
      url.searchParams.set('limit', '1');

      const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
      if (!r.ok) return res.status(r.status).json({ error: 'Query failed' });

      const rows = await r.json();
      const row = rows[0] || {};
      return res.json({ full_name: row.full_name || null, email: row.email || email });
    } catch (e) {
      return res.status(500).json({ error: 'Server error', details: String(e) });
    }
  });
};
