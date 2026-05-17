// migrated from netlify/functions/impacted-students.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/impacted-students', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ error: 'Invalid token' });

      const { teacherEmails } = req.body || {};
      if (!Array.isArray(teacherEmails) || teacherEmails.length === 0) return res.json({ ok: true, data: {} });

      const lowerEmails = teacherEmails.map(e => e.toLowerCase());

      const { data: mainScheds, error: e1 } = await supabase.from('student_schedule').select('student_email, teacher_email, breakout_email, day_of_week').in('teacher_email', lowerEmails);
      if (e1) throw e1;
      const { data: brScheds, error: e2 } = await supabase.from('student_schedule').select('student_email, breakout_email, day_of_week').in('breakout_email', lowerEmails);
      if (e2) throw e2;

      const result = {};
      for (const s of (mainScheds || [])) {
        const tEmail = (s.teacher_email || '').toLowerCase();
        if (!tEmail) continue;
        const key = `${tEmail}|${s.day_of_week}`;
        if (!result[key]) result[key] = new Set();
        result[key].add(s.student_email);
        const bEmail = (s.breakout_email || '').toLowerCase();
        if (bEmail && lowerEmails.includes(bEmail)) {
          const bKey = `${bEmail}|${s.day_of_week}`;
          if (!result[bKey]) result[bKey] = new Set();
          result[bKey].add(s.student_email);
        }
      }
      for (const s of (brScheds || [])) {
        const bEmail = (s.breakout_email || '').toLowerCase();
        if (!bEmail) continue;
        const key = `${bEmail}|${s.day_of_week}`;
        if (!result[key]) result[key] = new Set();
        result[key].add(s.student_email);
      }

      const allStudentEmails = [...new Set(Object.values(result).flatMap(s => [...s]))];
      const studentNameMap = {}, studentMinutesMap = {}, studentLevelMap = {};
      if (allStudentEmails.length > 0) {
        const { data: stRows } = await supabase.from('danh_sach_hv').select('email, ten_hv, status, cap_lop_hoc').in('email', allStudentEmails);
        for (const st of (stRows || [])) {
          if (st.ten_hv) studentNameMap[st.email] = st.ten_hv;
          studentMinutesMap[st.email] = Number(st.status || 0);
          studentLevelMap[st.email] = st.cap_lop_hoc || '';
        }
      }

      const finalData = {};
      for (const [key, emailSet] of Object.entries(result)) {
        finalData[key] = [...emailSet].map(em => ({
          email: em, name: studentNameMap[em] || em,
          student_minutes: studentMinutesMap[em] || 0, student_level: studentLevelMap[em] || ''
        })).sort((a, b) => a.name.localeCompare(b.name));
      }

      return res.json({ ok: true, data: finalData });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};
