// migrated from netlify/functions/meetinglinks-search.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/meetinglinks-search', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ suggestions: [] });

      const q = (req.query.q || '').trim();
      if (q.length < 4) return res.json({ suggestions: [] });

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ suggestions: [] });

      const { data, error } = await supabase
        .from('meeting_links')
        .select('teacher_email')
        .ilike('teacher_email', `%${q}%`)
        .limit(20);

      if (error) return res.json({ suggestions: [] });
      const emails = [...new Set((data || []).map(r => r.teacher_email).filter(Boolean))].slice(0, 8);
      return res.json({ suggestions: emails });
    } catch (e) {
      return res.json({ suggestions: [] });
    }
  });
};
