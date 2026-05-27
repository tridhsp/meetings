// POST /verify-security-key { key }
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.post('/verify-security-key', async (req, res) => {
    try {
      const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'Missing Supabase env vars' });

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ ok: false, error: 'Missing bearer token' });

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });

      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ ok: false, error: 'Invalid auth token' });

      const inputKey = ((req.body || {}).key || '').trim();
      if (!inputKey) return res.status(400).json({ ok: false, error: 'Security key is required' });

      const { data, error } = await supabase
        .from('security_key_for_teachers')
        .select('admin_key')
        .eq('admin_key', inputKey)
        .limit(1);

      if (error) return res.status(500).json({ ok: false, error: error.message });

      if (!data || data.length === 0) {
        return res.json({ ok: false, valid: false, error: 'Invalid security key' });
      }

      return res.json({ ok: true, valid: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
};
