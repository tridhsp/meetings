// GET /check-week-confirmation?weekStartDate=YYYY-MM-DD
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/check-week-confirmation', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'No token' });

      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

      const weekStartDate = req.query.weekStartDate;
      if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate required' });

      const { data, error } = await supabase
        .from('meeting_confirmation')
        .select('*')
        .eq('teacher_email', user.email.toLowerCase())
        .eq('week_start_date', weekStartDate)
        .single();

      if (error && error.code !== 'PGRST116') {
        return res.status(500).json({ error: error.message });
      }

      return res.json({ ok: true, confirmed: !!data, confirmation: data || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
