// migrated from netlify/functions/sync-meeting-offdays.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/sync-meeting-offdays', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ error: 'Invalid token' });
      const createdBy = userRes.user.email || '';

      const shifts = (req.body || {}).shifts;
      if (!Array.isArray(shifts) || shifts.length === 0) return res.status(400).json({ error: 'shifts array is required' });

      const rows = shifts.map(s => ({
        meeting_content_id: s.meeting_content_id,
        off_date: s.off_date,
        teacher_email: (s.teacher_email || '').trim().toLowerCase() || null,
        start_time: s.start_time ? (s.start_time.length === 5 ? `${s.start_time}:00` : s.start_time) : null,
        end_time: s.end_time ? (s.end_time.length === 5 ? `${s.end_time}:00` : s.end_time) : null,
        created_by: createdBy
      }));

      const { data, error } = await supabase
        .from('meeting_offdays')
        .upsert(rows, { onConflict: 'meeting_content_id,off_date' })
        .select();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, upserted: (data || []).length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
