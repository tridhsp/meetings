// GET  /confirm-free-hours?weekStartDate=YYYY-MM-DD
// POST /confirm-free-hours { weekStartDate }
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {

  async function getAuth(req, res) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ error: 'Missing env vars' }); return null; }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return null; }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket }
    });
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) { res.status(401).json({ error: 'Invalid token' }); return null; }

    return { supabase, myEmail: (userRes.user.email || '').toLowerCase() };
  }

  app.get('/confirm-free-hours', async (req, res) => {
    try {
      const ctx = await getAuth(req, res);
      if (!ctx) return;
      const { supabase, myEmail } = ctx;

      const weekStartDate = req.query.weekStartDate;
      if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate required' });

      const { data: rows, error } = await supabase
        .from('meeting_freehours_confirmation')
        .select('confirmed_at')
        .eq('teacher_email', myEmail)
        .eq('week_start_date', weekStartDate)
        .limit(1);

      if (error) {
        if (error.code === '42P01' || error.message?.includes('does not exist')) {
          return res.json({ ok: true, confirmed: false });
        }
        throw error;
      }

      const row = (rows || [])[0];
      return res.json({ ok: true, confirmed: !!row, confirmedAt: row?.confirmed_at || null });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });

  app.post('/confirm-free-hours', async (req, res) => {
    try {
      const ctx = await getAuth(req, res);
      if (!ctx) return;
      const { supabase, myEmail } = ctx;

      const { weekStartDate } = req.body || {};
      if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate required' });

      const { error } = await supabase
        .from('meeting_freehours_confirmation')
        .upsert({
          teacher_email: myEmail,
          week_start_date: weekStartDate,
          confirmed_at: new Date().toISOString()
        }, { onConflict: 'teacher_email,week_start_date' });

      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};
