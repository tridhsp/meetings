// migrated from netlify/functions/displaymeetinglink.js (ESM → CJS)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/displaymeetinglink', async (req, res) => {
    try {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
      const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;

      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Bearer token' });
      }
      const accessToken = authHeader.slice(7);

      const sbAuth = createClient(SUPABASE_URL, SUPABASE_ANON);
      const { data: userData, error: userErr } = await sbAuth.auth.getUser(accessToken);
      if (userErr || !userData?.user?.email) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      const creatorEmail = userData.user.email;

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data, error } = await supabase
        .from('meeting_links')
        .select('id, teacher_email, teacher_name, link_meeting, link_meeting_goc, link_work_meeting, link_goc_working_meeting, created_at')
        .eq('creator_email', creatorEmail)
        .order('created_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });

      return res.json({ rows: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
