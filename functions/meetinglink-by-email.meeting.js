// migrated from netlify/functions/meetinglink-by-email.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/meetinglink-by-email', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({});

      const email = (req.query.email || '').trim();
      if (!email) return res.status(400).json({});

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({});

      const { data, error } = await supabase
        .from('meeting_links')
        .select('teacher_name, link_meeting, link_work_meeting')
        .eq('teacher_email', email)
        .limit(1);

      if (error || !data || data.length === 0) return res.status(404).json({});
      const row = data[0] || {};
      return res.json({ teacher_name: row.teacher_name || '', link_meeting: row.link_meeting || '', link_work_meeting: row.link_work_meeting || '' });
    } catch (e) {
      return res.status(500).json({});
    }
  });
};
