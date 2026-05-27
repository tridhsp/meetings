// GET /get-teacher-ranges?teacherEmail=xxx
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/get-teacher-ranges', async (req, res) => {
    try {
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const teacherEmail = req.query.teacherEmail;
      if (!teacherEmail) return res.status(400).json({ error: 'teacherEmail is required' });

      const { data: ranges, error } = await supabase
        .from('teacher_availability')
        .select('day_of_week, time_start, time_end')
        .eq('teacher_email', teacherEmail)
        .order('day_of_week', { ascending: true })
        .order('time_start', { ascending: true });

      if (error) throw error;

      return res.json({ ranges: ranges || [] });
    } catch (error) {
      console.error('Error fetching teacher ranges:', error);
      return res.status(500).json({ error: error.message });
    }
  });
};
