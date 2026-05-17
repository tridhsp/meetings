// migrated from netlify/functions/teachers-search.js
module.exports = function(app) {
  app.get('/teachers-search', async (req, res) => {
    try {
      const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
      const auth = req.headers.authorization || '';
      if (!/^Bearer\s+/i.test(auth)) return res.status(401).json({ suggestions: [] });

      const qRaw = (req.query.q || '').trim();
      if (qRaw.length < 4) return res.json({ suggestions: [] });
      const q = qRaw.replace(/[%*]/g, '');

      const url = new URL(`${SUPABASE_URL}/rest/v1/user_roles`);
      url.searchParams.set('select', 'email');
      url.searchParams.set('email', `ilike.${q}*`);
      url.searchParams.append('order', 'email.asc');
      url.searchParams.set('limit', '8');

      const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
      if (!r.ok) return res.json({ suggestions: [] });

      const rows = await r.json();
      return res.json({ suggestions: rows.map(x => x.email).filter(Boolean) });
    } catch (e) {
      return res.status(500).json({ suggestions: [] });
    }
  });
};
