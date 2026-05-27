// /opt/my-api/routes/save-temp-substitute.meeting.js
// Runs on Digital Ocean droplet (NOT Netlify)
// GET/POST/DELETE /save-temp-substitute
// Saves or deletes temporary substitute teacher assignments.
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {

  // GET = load existing substitute assignments
  app.get('/save-temp-substitute', async (req, res) => {
    try {
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const params = req.query || {};
      let query = supabase
        .from('session_substitute_assignments')
        .select('*')
        .order('assign_date', { ascending: true });

      if (params.from_date) query = query.gte('assign_date', params.from_date);
      if (params.to_date) query = query.lte('assign_date', params.to_date);

      const { data, error } = await query;
      if (error) throw error;

      return res.json({ ok: true, assignments: data || [] });
    } catch (err) {
      console.error('Load assignments error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST = save a substitute assignment
  app.post('/save-temp-substitute', async (req, res) => {
    try {
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const body = req.body || {};
      const {
        student_email, original_teacher_email, substitute_teacher_email,
        assign_date, day_of_week, time_local,
        student_name, student_minutes, student_level,
        original_teacher_name, substitute_teacher_name,
        created_by
      } = body;

      if (!student_email || !assign_date || !substitute_teacher_email) {
        return res.status(400).json({ error: 'student_email, assign_date, and substitute_teacher_email are required' });
      }

      const role = body.role || 'TTKB';

      const row = {
        student_email,
        original_teacher_email: original_teacher_email || null,
        substitute_teacher_email,
        assign_date,
        day_of_week: day_of_week != null ? day_of_week : null,
        time_local: time_local || null,
        student_name: student_name || null,
        student_minutes: student_minutes || 0,
        student_level: student_level || null,
        original_teacher_name: original_teacher_name || null,
        substitute_teacher_name: substitute_teacher_name || null,
        created_by: created_by || null,
        role: role
      };

      const { data, error } = await supabase
        .from('session_substitute_assignments')
        .upsert(row, { onConflict: 'student_email,assign_date,role' })
        .select();

      if (error) throw error;

      return res.json({ ok: true, saved: data });
    } catch (err) {
      console.error('Save assignment error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE = remove a substitute assignment
  app.delete('/save-temp-substitute', async (req, res) => {
    try {
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const body = req.body || {};
      const { id, student_email, assign_date } = body;

      if (id) {
        const { error } = await supabase
          .from('session_substitute_assignments')
          .delete()
          .eq('id', id);
        if (error) throw error;
      } else if (student_email && assign_date) {
        const { error } = await supabase
          .from('session_substitute_assignments')
          .delete()
          .eq('student_email', student_email)
          .eq('assign_date', assign_date);
        if (error) throw error;
      } else {
        return res.status(400).json({ error: 'id or (student_email + assign_date) required' });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Delete assignment error:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
