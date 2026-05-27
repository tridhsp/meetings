// /opt/my-api/routes/tiep-hv-meeting.meeting.js
// Runs on Digital Ocean droplet (NOT Netlify)
// GET /tiep-hv-meeting?teacher_email=xxx
// Returns the tiep-hv meeting room for a teacher
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/tiep-hv-meeting', async (req, res) => {
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

      const teacher_email = req.query.teacher_email;
      if (!teacher_email) {
        return res.status(400).json({ error: 'teacher_email required' });
      }

      const { data, error } = await supabase
        .from('meetings')
        .select('id, room_name, display_name, teacher_email, meeting_type')
        .ilike('teacher_email', teacher_email)
        .eq('meeting_type', 'tiep-hv')
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });

      const meeting = (data && data.length > 0) ? data[0] : null;
      return res.json(meeting);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
