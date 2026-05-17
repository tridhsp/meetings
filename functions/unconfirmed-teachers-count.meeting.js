// GET /unconfirmed-teachers-count?weekStartDate=YYYY-MM-DD
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/unconfirmed-teachers-count', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'No token' });

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

      const weekStartDate = req.query.weekStartDate;
      if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate required' });

      // Calculate week end date (Sunday)
      const monday = new Date(weekStartDate);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const weekEndDate = sunday.toISOString().slice(0, 10);

      // Calculate 8 weeks back for recurring meetings
      const queryFrom = new Date(monday);
      queryFrom.setDate(queryFrom.getDate() - 56);
      const queryFromDate = queryFrom.toISOString().slice(0, 10);

      // 1) Get all meetings from 8 weeks back to include recurring meetings
      const { data: meetings, error: meetingsError } = await supabase
        .from('meeting_content')
        .select('teacher_email, work_date, is_one_time')
        .gte('work_date', queryFromDate)
        .lte('work_date', weekEndDate);

      if (meetingsError) return res.status(500).json({ error: meetingsError.message });

      function getDayIndex(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDay();
        return day === 0 ? 7 : day;
      }

      function formatYMD(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }

      // Expand recurring meetings to this week
      const expandedTeachers = new Set();
      for (const m of (meetings || [])) {
        if (!m.teacher_email) continue;
        const email = m.teacher_email.toLowerCase();
        if (m.is_one_time === false) {
          const originalDayIndex = getDayIndex(m.work_date);
          const targetDate = new Date(monday);
          targetDate.setDate(monday.getDate() + (originalDayIndex - 1));
          const targetDateStr = formatYMD(targetDate);
          if (targetDateStr >= weekStartDate && targetDateStr <= weekEndDate) {
            expandedTeachers.add(email);
          }
        } else {
          if (m.work_date >= weekStartDate && m.work_date <= weekEndDate) {
            expandedTeachers.add(email);
          }
        }
      }

      const uniqueTeachers = [...expandedTeachers];
      const totalTeachers = uniqueTeachers.length;

      if (totalTeachers === 0) {
        return res.json({ ok: true, total: 0, confirmed: 0, unconfirmed: 0 });
      }

      // 2) Get teachers who have confirmed this week
      const { data: confirmations, error: confError } = await supabase
        .from('meeting_confirmation')
        .select('teacher_email')
        .eq('week_start_date', weekStartDate);

      if (confError) return res.status(500).json({ error: confError.message });

      const confirmedEmails = new Set(
        (confirmations || []).map(c => (c.teacher_email || '').toLowerCase())
      );

      const unconfirmedEmails = uniqueTeachers.filter(e => !confirmedEmails.has(e));
      const confirmedCount = totalTeachers - unconfirmedEmails.length;
      const unconfirmedCount = unconfirmedEmails.length;

      // Fetch names for unconfirmed teachers
      let unconfirmedTeachers = [];
      if (unconfirmedEmails.length > 0) {
        const { data: teacherData, error: teacherError } = await supabase
          .from('user_roles')
          .select('email, full_name')
          .in('email', unconfirmedEmails);

        if (!teacherError && teacherData) {
          const nameMap = {};
          for (const t of teacherData) {
            nameMap[(t.email || '').toLowerCase()] = t.full_name || t.email;
          }
          unconfirmedTeachers = unconfirmedEmails.map(email => ({
            email, name: nameMap[email] || email
          }));
        } else {
          unconfirmedTeachers = unconfirmedEmails.map(email => ({ email, name: email }));
        }
      }

      // 3) Check student list confirmations
      const { data: studentConfs } = await supabase
        .from('meeting_student_confirmation')
        .select('teacher_email')
        .eq('week_start_date', weekStartDate);

      const studentConfirmedEmails = new Set(
        (studentConfs || []).map(c => (c.teacher_email || '').toLowerCase())
      );
      const unconfirmedStudentEmails = uniqueTeachers.filter(e => !studentConfirmedEmails.has(e));

      let unconfirmedStudentTeachers = [];
      if (unconfirmedStudentEmails.length > 0) {
        const { data: stData } = await supabase
          .from('user_roles')
          .select('email, full_name')
          .in('email', unconfirmedStudentEmails);
        const stNameMap = {};
        for (const t of (stData || [])) {
          stNameMap[(t.email || '').toLowerCase()] = t.full_name || t.email;
        }
        unconfirmedStudentTeachers = unconfirmedStudentEmails.map(email => ({
          email, name: stNameMap[email] || email
        }));
      }

      // 4) Check free hours confirmations
      const { data: fhConfs } = await supabase
        .from('meeting_freehours_confirmation')
        .select('teacher_email')
        .eq('week_start_date', weekStartDate);

      const fhConfirmedEmails = new Set(
        (fhConfs || []).map(c => (c.teacher_email || '').toLowerCase())
      );
      const unconfirmedFHEmails = uniqueTeachers.filter(e => !fhConfirmedEmails.has(e));

      let unconfirmedFHTeachers = [];
      if (unconfirmedFHEmails.length > 0) {
        const { data: fhData } = await supabase
          .from('user_roles')
          .select('email, full_name')
          .in('email', unconfirmedFHEmails);
        const fhNameMap = {};
        for (const t of (fhData || [])) {
          fhNameMap[(t.email || '').toLowerCase()] = t.full_name || t.email;
        }
        unconfirmedFHTeachers = unconfirmedFHEmails.map(email => ({
          email, name: fhNameMap[email] || email
        }));
      }

      return res.json({
        ok: true,
        total: totalTeachers,
        confirmed: confirmedCount,
        unconfirmed: unconfirmedCount,
        unconfirmedTeachers,
        unconfirmedStudentCount: unconfirmedStudentEmails.length,
        unconfirmedStudentTeachers,
        unconfirmedFHCount: unconfirmedFHEmails.length,
        unconfirmedFHTeachers
      });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
