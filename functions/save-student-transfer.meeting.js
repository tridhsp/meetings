// migrated from netlify/functions/save-student-transfer.js (auth-check inlined)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  async function verifyAuth(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return { user: null, error: 'No token' };
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return { user: null, error: error?.message || 'Invalid token' };
    return { user: data.user, error: null };
  }

  app.get('/save-student-transfer', async (req, res) => {
    try {
      const { user, error: authError } = await verifyAuth(req);
      if (authError) return res.status(401).json({ error: 'Unauthorized' });
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const transferDate = req.query.date;
      if (!transferDate) return res.status(400).json({ error: 'date is required' });
      const { data, error } = await supabase.from('student_schedule_transfers').select('*').eq('transfer_date', transferDate).order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ ok: true, transfers: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  app.post('/save-student-transfer', async (req, res) => {
    try {
      const { user, error: authError } = await verifyAuth(req);
      if (authError) return res.status(401).json({ error: 'Unauthorized' });
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { transfers } = req.body || {};
      if (!transfers || !transfers.length) return res.status(400).json({ error: 'transfers array is required' });
      const rows = transfers.map(t => ({
        transfer_date: t.transfer_date, from_teacher_email: t.from_teacher_email,
        to_teacher_email: t.to_teacher_email, to_teacher_name: t.to_teacher_name || null,
        student_email: t.student_email, student_name: t.student_name || null,
        transfer_time: t.transfer_time || null, created_by: t.created_by || user.email || null
      }));
      const { data, error } = await supabase.from('student_schedule_transfers').upsert(rows, { onConflict: 'student_email,transfer_date' }).select();
      if (error) throw error;
      return res.json({ ok: true, saved: data });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  app.delete('/save-student-transfer', async (req, res) => {
    try {
      const { user, error: authError } = await verifyAuth(req);
      if (authError) return res.status(401).json({ error: 'Unauthorized' });
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const body = req.body || {};
      if (body.id) {
        const { error } = await supabase.from('student_schedule_transfers').delete().eq('id', body.id);
        if (error) throw error;
      } else if (body.student_email && body.transfer_date) {
        const { error } = await supabase.from('student_schedule_transfers').delete().eq('student_email', body.student_email).eq('transfer_date', body.transfer_date);
        if (error) throw error;
      } else {
        return res.status(400).json({ error: 'id or (student_email + transfer_date) required' });
      }
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });
};
