// migrated from netlify/functions/my-students.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/my-students', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ error: 'Invalid token' });

      const myEmail = (userRes.user.email || '').toLowerCase();
      if (!myEmail) return res.status(400).json({ error: 'No email found' });

      const { data: mainScheds, error: e1 } = await supabase.from('student_schedule').select('student_email, teacher_email, breakout_email, day_of_week, time_local').eq('teacher_email', myEmail);
      if (e1) throw e1;
      const { data: brScheds, error: e2 } = await supabase.from('student_schedule').select('student_email, teacher_email, breakout_email, day_of_week, time_local').eq('breakout_email', myEmail);
      if (e2) throw e2;

      const combined = [];
      for (const s of (mainScheds || [])) {
        if (!s.student_email) continue;
        combined.push({ student_email: s.student_email, day_of_week: s.day_of_week, time_local: s.time_local, role: 'TTKB' });
      }
      for (const s of (brScheds || [])) {
        if (!s.student_email) continue;
        const exists = combined.find(c => c.student_email === s.student_email && c.day_of_week === s.day_of_week && c.time_local === s.time_local);
        if (!exists) combined.push({ student_email: s.student_email, day_of_week: s.day_of_week, time_local: s.time_local, role: 'Breakout' });
      }

      if (!combined.length) return res.json({ ok: true, data: {} });

      const allStudentEmails = [...new Set(combined.map(c => c.student_email))];
      const { data: hvRows } = await supabase.from('danh_sach_hv').select('email, ten_hv, status').in('email', allStudentEmails);

      const activeStudents = new Set();
      const studentNameMap = {};
      for (const h of (hvRows || [])) {
        if (h.status === 0) continue;
        activeStudents.add(h.email);
        if (h.ten_hv) studentNameMap[h.email] = h.ten_hv;
      }

      const result = {};
      for (const c of combined) {
        if (!activeStudents.has(c.student_email)) continue;
        const dow = c.day_of_week;
        if (!result[dow]) result[dow] = [];
        result[dow].push({ student_email: c.student_email, student_name: studentNameMap[c.student_email] || c.student_email, time_local: c.time_local, role: c.role });
      }
      for (const dow in result) result[dow].sort((a, b) => (a.time_local || '').localeCompare(b.time_local || ''));

      return res.json({ ok: true, data: result });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};
