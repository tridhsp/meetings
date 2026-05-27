// GET /tiep-hv-all
// Returns map of { email: meeting_url } for all tiep-hv meetings
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/tiep-hv-all', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'No token' });

      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

      // Fetch all tiep-hv meetings
      const { data, error } = await supabase
        .from('meetings')
        .select('teacher_email, room_name')
        .eq('meeting_type', 'tiep-hv');

      if (error) return res.status(500).json({ error: error.message });

      // Build { email: url } map
      const map = {};
      for (const row of (data || [])) {
        const email = (row.teacher_email || '').trim().toLowerCase();
        const room = (row.room_name || '').trim();
        if (email && room) {
          map[email] = 'https://meeting.tansinh.info/' + room;
        }
      }

      return res.json(map);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
