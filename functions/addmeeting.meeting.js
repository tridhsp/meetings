// migrated from netlify/functions/addmeeting.js (ESM → CJS)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/addmeeting', async (req, res) => {
    try {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
      const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;

      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Bearer token' });
      }
      const accessToken = authHeader.slice(7);

      const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON);
      const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(accessToken);
      if (userErr || !userData?.user?.email) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      const creatorEmail = userData.user.email;

      const { teacherEmail, teacherName, meetingHv, meetingHvLink, meetingWork, meetingWorkLink } = req.body || {};
      if (!teacherEmail) {
        return res.status(400).json({ error: 'teacherEmail is required' });
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const row = {
        teacher_email: teacherEmail || null,
        teacher_name: teacherName || null,
        link_meeting: meetingHv || null,
        link_meeting_goc: meetingHvLink || null,
        link_work_meeting: meetingWork || null,
        link_goc_working_meeting: meetingWorkLink || null,
        creator_email: creatorEmail
      };

      const { error } = await supabase.from('meeting_links').insert(row);
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
