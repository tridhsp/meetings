// GET /userroles-search?q=<at_least_4_chars>
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/userroles-search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 4) {
        return res.json({ suggestions: [] });
      }

      const url = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      const sb = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });

      const { data, error } = await sb
        .from('user_roles')
        .select('email')
        .ilike('email', `%${q}%`)
        .order('email', { ascending: true })
        .limit(10);

      if (error) throw error;

      const suggestions = (data || []).map(r => ({ email: r.email }));
      return res.json({ suggestions });
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }
  });
};
