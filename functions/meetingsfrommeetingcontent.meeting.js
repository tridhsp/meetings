// GET /meetingsfrommeetingcontent?from=YYYY-MM-DD&limit=N
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/meetingsfrommeetingcontent', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.ANON_PUBLIC_KEY;
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SUPABASE_ANON || !SERVICE_KEY) {
        return res.status(500).json({ error: 'Missing Supabase env vars' });
      }

      // Validate token with ANON key
      const sbAuth = createClient(SUPABASE_URL, SUPABASE_ANON, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });
      const { data: ures, error: uerr } = await sbAuth.auth.getUser(token);
      if (uerr || !ures?.user) return res.status(401).json({ error: 'Invalid token' });

      // Query with SERVICE key (server-side)
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });

      const today = new Date().toISOString().slice(0, 10);
      const from = req.query.from || today;
      const limit = Math.min(parseInt(req.query.limit, 10) || 300, 500);

      // 1) One-time rows: apply date filter
      const { data: oneTimeRows, error: err1 } = await supabase
        .from('meeting_content')
        .select(
          'id, created_at, creator_email, teacher_email, teacher_name, meeting_link, work_meeting, work_date, start_time, end_time, is_one_time, department, notes'
        )
        .eq('is_one_time', true)
        .gte('work_date', from)
        .order('work_date', { ascending: true })
        .order('start_time', { ascending: true })
        .limit(limit);

      // 2) Recurring rows: fetch ALL (no date filter) so old recurring shifts are included
      const { data: recurringRows, error: err2 } = await supabase
        .from('meeting_content')
        .select(
          'id, created_at, creator_email, teacher_email, teacher_name, meeting_link, work_meeting, work_date, start_time, end_time, is_one_time, department, notes'
        )
        .eq('is_one_time', false)
        .order('work_date', { ascending: true })
        .order('start_time', { ascending: true })
        .limit(limit);

      const error = err1 || err2;
      if (error) return res.status(500).json({ error: error.message });

      // Merge both lists
      const data = [...(recurringRows || []), ...(oneTimeRows || [])];
      return res.json({ rows: data });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });
};
