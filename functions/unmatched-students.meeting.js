// GET /unmatched-students
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/unmatched-students', async (req, res) => {
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

      // 1) Get all student schedules
      const { data: scheds, error: sErr } = await supabase
        .from('student_schedule')
        .select('student_email, teacher_email, breakout_email, day_of_week, time_local');
      if (sErr) throw sErr;

      const validScheds = (scheds || []).filter(s => s.student_email && (s.teacher_email || s.breakout_email));
      if (!validScheds.length) return res.json({ ok: true, data: {} });

      // 2) Active students
      const allStudentEmails = [...new Set(validScheds.map(s => s.student_email))];
      const { data: hvRows } = await supabase.from('danh_sach_hv').select('email, ten_hv, status').in('email', allStudentEmails);

      const activeStudents = new Set();
      const studentNameMap = {};
      for (const h of (hvRows || [])) {
        if (h.status === 0) continue;
        activeStudents.add(h.email);
        if (h.ten_hv) studentNameMap[h.email] = h.ten_hv;
      }

      const activeScheds = validScheds.filter(s => activeStudents.has(s.student_email));
      if (!activeScheds.length) return res.json({ ok: true, data: {} });

      // 3) Meetings
      const today = new Date();
      const monday = getMonday(today);
      const sunday = addDays(monday, 6);
      const weekEndStr = formatYMD(sunday);
      const mondayStr = formatYMD(monday);

      const { data: recurringMeetings, error: mErr1 } = await supabase
        .from('meeting_content').select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', false).lte('work_date', weekEndStr);
      if (mErr1) throw mErr1;

      // Student offdays
      const { data: studentOffRows } = await supabase
        .from('offdays').select('person_email, off_from, off_to')
        .eq('person_type', 'student').lte('off_from', weekEndStr).gte('off_to', mondayStr);

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

      const dowToDate = {};
      for (let i = 0; i < 7; i++) {
        const d = addDays(monday, i);
        dowToDate[d.getDay()] = formatYMD(d);
      }

      const { data: onetimeMeetings, error: mErr2 } = await supabase
        .from('meeting_content').select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', true).gte('work_date', mondayStr).lte('work_date', weekEndStr);
      if (mErr2) throw mErr2;

      const meetings = [...(recurringMeetings || []), ...(onetimeMeetings || [])];

      // 4) Offdays
      const { data: offRows } = await supabase
        .from('meeting_offdays').select('meeting_content_id, off_date')
        .gte('off_date', mondayStr).lte('off_date', weekEndStr);
      const offSet = new Set((offRows || []).map(r => `${r.meeting_content_id}|${r.off_date}`));

      const { data: fullOffRows } = await supabase
        .from('offdays').select('person_email, off_from, off_to')
        .eq('person_type', 'teacher').lte('off_from', weekEndStr).gte('off_to', mondayStr);

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

      // 5) Expand recurring
      const expanded = expandRecurringForWeek(meetings || [], monday);
      const weekMeetingsAll = expanded.filter(r => isSameWeek(r.work_date, monday));

      const teacherHadShift = new Set();
      for (const m of weekMeetingsAll) {
        const email = (m.teacher_email || '').toLowerCase();
        if (!email) continue;
        const d = new Date(m.work_date + 'T00:00:00');
        teacherHadShift.add(`${email}|${d.getDay()}`);
      }

      const weekMeetings = weekMeetingsAll.filter(r => {
        const email = (r.teacher_email || '').toLowerCase();
        if (teacherFullOff.has(`${email}|${r.work_date}`)) return false;
        if (offSet.has(`${r.id}|${r.work_date}`)) return false;
        return true;
      });

      // 6) Working time set
      const teacherHasWorkingTime = new Set();
      const teacherMixDays = new Set();
      for (const m of weekMeetings) {
        const email = (m.teacher_email || '').toLowerCase();
        if (!email) continue;
        const d = new Date(m.work_date + 'T00:00:00');
        const dow = d.getDay();
        teacherHasWorkingTime.add(`${email}|${dow}`);
        if ((m.department || '').toLowerCase() === 'mix') teacherMixDays.add(`${email}|${dow}`);
      }

      // 7) Find unmatched
      const result = {};
      const allTeacherEmails = [...new Set(activeScheds.map(s => s.teacher_email))];
      const teacherNameMap = {};
      if (allTeacherEmails.length) {
        const { data: tRows } = await supabase.from('user_roles').select('email, full_name').in('email', allTeacherEmails);
        for (const t of (tRows || [])) { if (t.full_name) teacherNameMap[t.email] = t.full_name; }
      }

      for (const s of activeScheds) {
        const dow = s.day_of_week;
        const dateForDow = dowToDate[dow];
        if (dateForDow && studentOffSet.has(`${(s.student_email || '').toLowerCase()}|${dateForDow}`)) continue;

        const tEmail = (s.teacher_email || '').toLowerCase();
        const bEmail = (s.breakout_email || '').toLowerCase();
        const tKey = tEmail ? `${tEmail}|${dow}` : '';
        const ttkbWorking = tEmail && teacherHasWorkingTime.has(tKey);
        const ttkbIsMix = tEmail && teacherMixDays.has(tKey);

        if (tEmail && !ttkbWorking) {
          const tReason = teacherHadShift.has(tKey) ? 'nghỉ' : 'không có ca';
          if (!result[dow]) result[dow] = [];
          result[dow].push({
            student_email: s.student_email, student_name: studentNameMap[s.student_email] || s.student_email,
            teacher_email: s.teacher_email, teacher_name: teacherNameMap[s.teacher_email] || s.teacher_email,
            time_local: s.time_local, role: 'TTKB', reason: tReason
          });
        }

        if (bEmail && !(ttkbWorking && ttkbIsMix)) {
          const bKey = `${bEmail}|${dow}`;
          if (!teacherHasWorkingTime.has(bKey)) {
            const bReason = teacherHadShift.has(bKey) ? 'nghỉ' : 'không có ca';
            if (!result[dow]) result[dow] = [];
            result[dow].push({
              student_email: s.student_email, student_name: studentNameMap[s.student_email] || s.student_email,
              teacher_email: s.breakout_email, teacher_name: teacherNameMap[s.breakout_email] || s.breakout_email,
              time_local: s.time_local, role: 'Breakout', reason: bReason
            });
          }
        }
      }

      for (const dow in result) {
        result[dow].sort((a, b) => (a.time_local || '').localeCompare(b.time_local || ''));
      }

      return res.json({ ok: true, data: result });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};

function getMonday(d) {
  const result = new Date(d); const dow = result.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  result.setDate(result.getDate() + offset); result.setHours(0, 0, 0, 0); return result;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function formatYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rosterDayIndex(ymd) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  return ((new Date(y, m - 1, d).getDay() + 6) % 7) + 1;
}
function isSameWeek(ymd, weekStart) {
  if (!ymd) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  const ws = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const we = new Date(ws); we.setDate(ws.getDate() + 7);
  return t >= ws && t < we;
}
function expandRecurringForWeek(rows, weekStart) {
  const expanded = [];
  for (const r of (rows || [])) {
    if (r && r.is_one_time === false) {
      const di = rosterDayIndex(r.work_date);
      const tgt = new Date(weekStart); tgt.setDate(tgt.getDate() + (di - 1));
      expanded.push({ ...r, work_date: formatYMD(tgt) });
    } else { expanded.push(r); }
  }
  const seen = new Set();
  return expanded.filter(r => {
    const key = `${r.teacher_email}|${r.work_date}|${r.start_time}|${r.end_time}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}
