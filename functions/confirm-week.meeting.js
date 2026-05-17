// migrated from netlify/functions/confirm-week.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/confirm-week', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'No token' });

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

      const { weekStartDate, teacherName } = req.body || {};
      if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate required' });

      const { data, error } = await supabase
        .from('meeting_confirmation')
        .upsert({
          teacher_email: user.email.toLowerCase(),
          teacher_name: teacherName || null,
          week_start_date: weekStartDate,
          confirmed_at: new Date().toISOString()
        }, { onConflict: 'teacher_email,week_start_date' })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, confirmation: data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
