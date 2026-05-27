// GET /upcoming-impacted-students
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/upcoming-impacted-students', async (req, res) => {
    try {
      const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Missing env vars' });

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ error: 'Invalid token' });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const fromDate = addDays(today, 1);
      const toDate = addDays(today, 14);
      const fromDateStr = formatYMD(fromDate);
      const toDateStr = formatYMD(toDate);

      // 1) Get all student schedules
      const { data: scheds, error: sErr } = await supabase
        .from('student_schedule')
        .select('student_email, teacher_email, breakout_email, day_of_week, time_local');
      if (sErr) throw sErr;

      const validScheds = (scheds || []).filter(s => s.student_email && (s.teacher_email || s.breakout_email));
      if (!validScheds.length) return res.json({ ok: true, data: [] });

      // 2) Get active students only
      const allStudentEmails = [...new Set(validScheds.map(s => s.student_email))];
      const { data: hvRows } = await supabase.from('danh_sach_hv').select('email, ten_hv, status, cap_lop_hoc').in('email', allStudentEmails);

      const activeStudents = new Set();
      const studentNameMap = {};
      const studentMinutesMap = {};
      const studentLevelMap = {};
      for (const h of (hvRows || [])) {
        if (h.status === 0) continue;
        activeStudents.add(h.email);
        if (h.ten_hv) studentNameMap[h.email] = h.ten_hv;
        studentMinutesMap[h.email] = Number(h.status || 0);
        studentLevelMap[h.email] = h.cap_lop_hoc || '';
      }

      const activeScheds = validScheds.filter(s => activeStudents.has(s.student_email));

      // Student offdays
      const { data: studentOffRows } = await supabase
        .from('offdays').select('person_email, off_from, off_to')
        .eq('person_type', 'student').lte('off_from', toDateStr).gte('off_to', fromDateStr);

      const studentOffSet = new Set();
      for (const row of (studentOffRows || [])) {
        const email = (row.person_email || '').trim().toLowerCase();
        if (!email) continue;
        const start = new Date(row.off_from + 'T00:00:00');
        const end = new Date(row.off_to + 'T00:00:00');
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          studentOffSet.add(`${email}|${formatYMD(d)}`);
        }
      }

      if (!activeScheds.length) return res.json({ ok: true, data: [] });

      // 3) Get all meeting_content
      const { data: recurringMeetings, error: mErr1 } = await supabase
        .from('meeting_content').select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', false).lte('work_date', toDateStr);
      if (mErr1) throw mErr1;

      const { data: onetimeMeetings, error: mErr2 } = await supabase
        .from('meeting_content').select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', true).gte('work_date', fromDateStr).lte('work_date', toDateStr);
      if (mErr2) throw mErr2;

      const meetings = [...(recurringMeetings || []), ...(onetimeMeetings || [])];

      // 4) Meeting offdays
      const { data: offRows } = await supabase
        .from('meeting_offdays').select('meeting_content_id, off_date')
        .gte('off_date', fromDateStr).lte('off_date', toDateStr);
      const offSet = new Set((offRows || []).map(r => `${r.meeting_content_id}|${r.off_date}`));

      // Full-day teacher offdays
      const { data: fullOffRows } = await supabase
        .from('offdays').select('person_email, off_from, off_to')
        .eq('person_type', 'teacher').lte('off_from', toDateStr).gte('off_to', fromDateStr);

      const teacherFullOff = new Set();
      for (const row of (fullOffRows || [])) {
        const email = (row.person_email || '').trim().toLowerCase();
        if (!email) continue;
        const start = new Date(row.off_from + 'T00:00:00');
        const end = new Date(row.off_to + 'T00:00:00');
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          teacherFullOff.add(`${email}|${formatYMD(d)}`);
        }
      }

      // 5) Teacher names
      const allTeacherEmails = [...new Set(activeScheds.flatMap(s => [s.teacher_email, s.breakout_email].filter(Boolean)))];
      const teacherNameMap = {};
      if (allTeacherEmails.length) {
        const { data: tRows } = await supabase.from('user_roles').select('email, full_name').in('email', allTeacherEmails);
        for (const t of (tRows || [])) { if (t.full_name) teacherNameMap[t.email] = t.full_name; }
        for (const email of allTeacherEmails) {
          if (!teacherNameMap[email]) {
            const { data: mcRows } = await supabase.from('meeting_content').select('teacher_name').ilike('teacher_email', email).not('teacher_name', 'is', null).limit(1);
            if (mcRows && mcRows[0]?.teacher_name) teacherNameMap[email] = mcRows[0].teacher_name;
          }
        }
      }

      // 6) Check each day
      const result = [];
      for (let dayOffset = 1; dayOffset <= 14; dayOffset++) {
        const targetDate = addDays(today, dayOffset);
        const targetDateStr = formatYMD(targetDate);
        const targetDow = targetDate.getDay();

        const targetMonday = getMonday(targetDate);
        const expanded = expandRecurringForWeek(meetings, targetMonday);
        const dayMeetingsAll = expanded.filter(r => r.work_date === targetDateStr);

        const teacherHadShift = new Set();
        for (const m of dayMeetingsAll) {
          const email = (m.teacher_email || '').toLowerCase();
          if (email) teacherHadShift.add(email);
        }

        const dayMeetings = dayMeetingsAll.filter(r => {
          const email = (r.teacher_email || '').toLowerCase();
          if (teacherFullOff.has(`${email}|${r.work_date}`)) return false;
          const ids = r._all_ids || [r.id];
          return !ids.some(id => offSet.has(`${id}|${r.work_date}`));
        });

        const teacherWorking = new Set();
        const teacherMix = new Set();
        for (const m of dayMeetings) {
          const email = (m.teacher_email || '').toLowerCase();
          if (!email) continue;
          teacherWorking.add(email);
          if ((m.department || '').toLowerCase() === 'mix') teacherMix.add(email);
        }

        const dayStudents = [];
        for (const s of activeScheds) {
          if (s.day_of_week !== targetDow) continue;
          if (studentOffSet.has(`${(s.student_email || '').toLowerCase()}|${targetDateStr}`)) continue;

          const tEmail = (s.teacher_email || '').toLowerCase();
          const bEmail = (s.breakout_email || '').toLowerCase();
          const ttkbWorking = tEmail && teacherWorking.has(tEmail);
          const ttkbIsMix = tEmail && teacherMix.has(tEmail);

          if (tEmail && !ttkbWorking) {
            const reason = teacherHadShift.has(tEmail) ? 'nghỉ' : 'không có ca';
            dayStudents.push({
              student_email: s.student_email, student_name: studentNameMap[s.student_email] || s.student_email,
              teacher_email: s.teacher_email, teacher_name: teacherNameMap[s.teacher_email] || s.teacher_email,
              time_local: s.time_local, role: 'TTKB', reason,
              student_minutes: studentMinutesMap[s.student_email] || 0,
              student_level: studentLevelMap[s.student_email] || ''
            });
          }

          if (bEmail && !(ttkbWorking && ttkbIsMix)) {
            if (!teacherWorking.has(bEmail)) {
              const reason = teacherHadShift.has(bEmail) ? 'nghỉ' : 'không có ca';
              dayStudents.push({
                student_email: s.student_email, student_name: studentNameMap[s.student_email] || s.student_email,
                teacher_email: s.breakout_email, teacher_name: teacherNameMap[s.breakout_email] || s.breakout_email,
                time_local: s.time_local, role: 'Breakout', reason,
                student_minutes: studentMinutesMap[s.student_email] || 0,
                student_level: studentLevelMap[s.student_email] || ''
              });
            }
          }
        }

        if (dayStudents.length > 0) {
          dayStudents.sort((a, b) => (a.time_local || '').localeCompare(b.time_local || ''));
          result.push({ date: targetDateStr, students: dayStudents });
        }
      }

      return res.json({ ok: true, data: result });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};

// ========== HELPERS ==========
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function getMonday(d) {
  const result = new Date(d);
  const dow = result.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  result.setDate(result.getDate() + offset);
  result.setHours(0, 0, 0, 0);
  return result;
}
function rosterDayIndex(ymd) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return ((t.getDay() + 6) % 7) + 1;
}
function expandRecurringForWeek(rows, weekStart) {
  const expanded = [];
  for (const r of (rows || [])) {
    if (r && r.is_one_time === false) {
      const di = rosterDayIndex(r.work_date);
      const tgt = new Date(weekStart);
      tgt.setDate(tgt.getDate() + (di - 1));
      expanded.push({ ...r, work_date: formatYMD(tgt) });
    } else {
      expanded.push(r);
    }
  }
  const seen = {};
  return expanded.filter(r => {
    const key = `${r.teacher_email}|${r.work_date}|${r.start_time}|${r.end_time}`;
    if (seen[key]) { seen[key]._all_ids.push(r.id); return false; }
    r._all_ids = [r.id];
    seen[key] = r;
    return true;
  });
}
