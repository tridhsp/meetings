// /opt/my-api/routes/breakout-rooms.meeting.js
// Runs on Digital Ocean droplet (NOT Netlify)
// GET /breakout-rooms?teacher_email=xxx
// Returns available breakout rooms for a teacher (0 participants)
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ participants: 0 }); }
      });
    }).on('error', () => resolve({ participants: 0 }));
  });
}

module.exports = function (app) {
  app.get('/breakout-rooms', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'No token' });

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

      const teacher_email = req.query.teacher_email;
      if (!teacher_email) {
        return res.status(400).json({ error: 'teacher_email required' });
      }

      const { data: meetings, error } = await supabase
        .from('meetings')
        .select('id, room_name, display_name, teacher_email, meeting_type')
        .ilike('teacher_email', teacher_email)
        .eq('meeting_type', 'breakout')
        .order('room_name', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      if (!meetings || meetings.length === 0) {
        return res.json([]);
      }

      const results = await Promise.all(meetings.map(async (m) => {
        const roomJid = m.room_name + '@conference.meeting.tansinh.info';
        const url = 'https://meeting.tansinh.info/room-size?room=' + encodeURIComponent(roomJid);
        const data = await httpGet(url);
        return { ...m, participants: data.participants || 0 };
      }));

      const available = results.filter(r => r.participants <= 0);
      return res.json(available);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
