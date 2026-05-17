// GET /offdays-range?from=YYYY-MM-DD&to=YYYY-MM-DD
module.exports = function (app) {
  app.get('/offdays-range', async (req, res) => {
    try {
      const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ ok: false, error: 'Missing server env vars' });
      }

      const auth = req.headers.authorization || '';
      if (!auth || !/^Bearer\s+/i.test(auth)) {
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      const { from, to } = req.query;
      const url = new URL(`${SUPABASE_URL}/rest/v1/meeting_offdays`);
      url.searchParams.set('select', 'meeting_content_id,off_date');
      if (from) url.searchParams.append('off_date', `gte.${from}`);
      if (to)   url.searchParams.append('off_date', `lte.${to}`);
      url.searchParams.set('limit', '10000');

      const resp = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      });

      if (!resp.ok) {
        const t = await resp.text();
        return res.status(resp.status).json({ ok: false, error: t });
      }
      const rows = await resp.json();
      return res.json({ ok: true, rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
};
