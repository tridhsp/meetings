// POST /get-working-teachers-for-date { date, student_time, student_minutes }
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

function timeToMinHelper(t) {
  const [h = 0, m = 0] = String(t || '').split(':').map(Number);
  return h * 60 + m;
}

function minToHHMM(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function buildTimelineSegments(students, hvMinMap, hvNameMap, windowStart, windowEnd) {
  const studentRanges = [];
  for (const s of students) {
    const sStart = timeToMinHelper(s.time_local);
    const sDur = s.buoi_phu ? 25 : (hvMinMap[s.student_email] || 25);
    const sEnd = sStart + sDur;
    if (sStart < windowEnd && sEnd > windowStart) {
      studentRanges.push({
        email: s.student_email,
        name: hvNameMap[s.student_email] || s.student_email.split('@')[0],
        start: sStart, end: sEnd, duration: sDur, buoiPhu: !!s.buoi_phu,
        role: s._role || ''
      });
    }
  }

  const timePoints = new Set([windowStart, windowEnd]);
  for (const sr of studentRanges) {
    if (sr.start >= windowStart && sr.start < windowEnd) timePoints.add(sr.start);
    if (sr.end > windowStart && sr.end <= windowEnd) timePoints.add(sr.end);
  }
  const sorted = Array.from(timePoints).sort((a, b) => a - b);

  const segments = [];
  let peakCount = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i];
    const segEnd = sorted[i + 1];
    const present = studentRanges.filter(sr => sr.start < segEnd && sr.end > segStart);
    const count = present.length;
    if (count > peakCount) peakCount = count;
    segments.push({
      start: minToHHMM(segStart), end: minToHHMM(segEnd),
      startMin: segStart, endMin: segEnd,
      duration: segEnd - segStart, count,
      students: present.map(sr => ({
        name: sr.name, email: sr.email,
        time: minToHHMM(sr.start), endTime: minToHHMM(sr.end),
        duration: sr.duration, buoiPhu: sr.buoiPhu,
        role: sr.role
      }))
    });
  }

  let suitability, suitabilityLabel;
  if (peakCount <= 3) {
    suitability = 'good'; suitabilityLabel = 'Phù hợp — GV có thể quản lý tốt';
  } else if (peakCount <= 6) {
    suitability = 'ok'; suitabilityLabel = 'Chấp nhận được — GV sẽ hơi đông lúc cao điểm';
  } else {
    suitability = 'overload'; suitabilityLabel = 'Quá tải — GV đã có quá nhiều HV cùng lúc';
  }

  return {
    segments, peakCount, suitability, suitabilityLabel,
    allStudents: studentRanges.map(sr => ({
      name: sr.name, email: sr.email,
      time: minToHHMM(sr.start), endTime: minToHHMM(sr.end),
      duration: sr.duration, buoiPhu: sr.buoiPhu,
      role: sr.role
    }))
  };
}

module.exports = function (app) {
  app.post('/get-working-teachers-for-date', async (req, res) => {
    try {
      const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Missing env vars' });

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket }
      });

      const body = req.body || {};
      const targetDate = (body.date || '').trim();
      const studentTime = (body.student_time || '').trim();
      const studentMinutes = Number(body.student_minutes) || 25;
      if (!targetDate) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

      const [y, m, d] = targetDate.split('-').map(Number);
      const targetDOW = new Date(y, m - 1, d).getDay();

      // 1. Fetch ALL meeting_content
      const { data: allMeetings, error: mErr } = await supabase
        .from('meeting_content')
        .select('id, teacher_email, teacher_name, work_date, start_time, end_time, is_one_time, department, created_at');
      if (mErr) throw mErr;

      // 2. Find shifts matching target date
      const matchingShifts = [];
      for (const row of (allMeetings || [])) {
        const rowYMD = String(row.work_date).slice(0, 10);
        const [ry, rm, rd] = rowYMD.split('-').map(Number);
        const rowDOW = new Date(ry, rm - 1, rd).getDay();
        const isOneTime = row.is_one_time === true || row.is_one_time === 1 ||
          String(row.is_one_time).toLowerCase() === 'true' || String(row.is_one_time).toLowerCase() === 't';
        const match = isOneTime ? (rowYMD === targetDate) : (rowDOW === targetDOW);
        if (match) {
          matchingShifts.push({
            meeting_content_id: row.id,
            teacher_email: (row.teacher_email || '').toLowerCase(),
            teacher_name: row.teacher_name || '',
            start_time: String(row.start_time || '').slice(0, 5),
            end_time: String(row.end_time || '').slice(0, 5),
            department: row.department || '',
            is_one_time: !!isOneTime,
            created_at: row.created_at || ''
          });
        }
      }

      // 3. Deduplicate recurring shifts
      const dedupeMap = {};
      for (const s of matchingShifts) {
        if (s.is_one_time) {
          dedupeMap['onetime-' + s.meeting_content_id] = s;
        } else {
          const key = `${s.teacher_email}||${s.department}||${s.start_time}||${s.end_time}`;
          if (!dedupeMap[key] || s.created_at > dedupeMap[key].created_at) dedupeMap[key] = s;
        }
      }
      const deduped = Object.values(dedupeMap);

      // 4. Remove contained shifts
      function _toMin(t) { const [h = 0, m = 0] = String(t || '').split(':').map(Number); return h * 60 + m; }
      const groups = {};
      for (const s of deduped) {
        const key = `${s.teacher_email}||${s.department}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      }
      const afterContained = [];
      for (const key in groups) {
        const group = groups[key];
        if (group.length <= 1) { afterContained.push(...group); continue; }
        for (let i = 0; i < group.length; i++) {
          const a = group[i];
          const aS = _toMin(a.start_time), aE = _toMin(a.end_time);
          let isContained = false;
          for (let j = 0; j < group.length; j++) {
            if (i === j) continue;
            const b = group[j];
            if (_toMin(b.start_time) <= aS && _toMin(b.end_time) >= aE && (_toMin(b.end_time) - _toMin(b.start_time)) > (aE - aS)) {
              isContained = true; break;
            }
          }
          if (!isContained) afterContained.push(a);
        }
      }

      // 5. Filter out offdays
      const { data: offdays } = await supabase.from('meeting_offdays').select('meeting_content_id, teacher_email').eq('off_date', targetDate);
      const offSet = new Set((offdays || []).map(o => String(o.meeting_content_id)));
      const activeShifts = afterContained.filter(s => !offSet.has(String(s.meeting_content_id)));

      // 6. Full-day offdays
      const { data: fullOffdays } = await supabase.from('offdays').select('person_email').eq('person_type', 'teacher').lte('off_from', targetDate).gte('off_to', targetDate);
      const fullOffSet = new Set((fullOffdays || []).map(o => (o.person_email || '').toLowerCase()));
      const filteredShifts = activeShifts.filter(s => !fullOffSet.has(s.teacher_email));

      // 7. Group by teacher
      const teacherMap = {};
      for (const s of filteredShifts) {
        if (!teacherMap[s.teacher_email]) {
          teacherMap[s.teacher_email] = { teacher_email: s.teacher_email, teacher_name: s.teacher_name, shifts: [] };
        }
        teacherMap[s.teacher_email].shifts.push({ start_time: s.start_time, end_time: s.end_time, department: s.department });
      }

      // 8. Get full names
      const workingEmails = Object.keys(teacherMap);
      if (workingEmails.length > 0) {
        const { data: nameRows } = await supabase.from('user_roles').select('email, full_name').in('email', workingEmails);
        if (nameRows) {
          for (const nr of nameRows) {
            const key = nr.email.toLowerCase();
            if (teacherMap[key]) teacherMap[key].teacher_name = nr.full_name || teacherMap[key].teacher_name;
          }
        }
      }

      // 9. Student counts + timeline
      const { data: dayScheds } = await supabase.from('student_schedule').select('student_email, teacher_email, breakout_email, time_local, buoi_phu').eq('day_of_week', targetDOW);
      const allStudentEmails = [...new Set((dayScheds || []).map(s => s.student_email))];
      let minutesMap = {}, hvDurationMap = {}, hvNameMap = {};
      if (allStudentEmails.length) {
        const { data: hvRows } = await supabase.from('danh_sach_hv').select('email, status, max, ten_hv').in('email', allStudentEmails);
        if (hvRows) {
          for (const r of hvRows) {
            minutesMap[r.email] = Number(r.status || 0);
            hvDurationMap[r.email] = Number(r.max) || Number(r.status) || 25;
            hvNameMap[r.email] = r.ten_hv || r.email.split('@')[0];
          }
        }
      }

      const { data: existingSubs } = await supabase.from('session_substitute_assignments').select('substitute_teacher_email, student_email, student_minutes').eq('assign_date', targetDate);

      const targetMin = studentTime ? timeToMinHelper(studentTime) : -1;
      const targetEnd = targetMin >= 0 ? targetMin + studentMinutes : -1;

      for (const email of workingEmails) {
        const entry = teacherMap[email];
        let totalShiftMins = 0;
        for (const s of entry.shifts) totalShiftMins += _toMin(s.end_time) - _toMin(s.start_time);

        const myStudents = (dayScheds || []).filter(sc => (sc.teacher_email || '').toLowerCase() === email);
        const myBreakoutStudents = (dayScheds || []).filter(sc => (sc.breakout_email || '').toLowerCase() === email);
        const allMyStudentsRaw = [
          ...myStudents.map(s => ({ ...s, _role: 'TT' })),
          ...myBreakoutStudents.filter(s => (s.teacher_email || '').toLowerCase() !== email).map(s => ({ ...s, _role: 'BR' }))
        ];
        const uniqueStudents = [...new Set(myStudents.map(s => s.student_email))];

        let bookedMins = 0;
        for (const se of uniqueStudents) bookedMins += (minutesMap[se] || 0);
        const mySubs = (existingSubs || []).filter(sa => (sa.substitute_teacher_email || '').toLowerCase() === email);
        for (const sa of mySubs) bookedMins += (sa.student_minutes || minutesMap[sa.student_email] || 0);

        entry.studentCount = uniqueStudents.length + mySubs.length;
        entry.totalShiftMins = totalShiftMins;
        entry.bookedMins = bookedMins;
        entry.freeMins = Math.max(0, totalShiftMins - bookedMins);

        const isTTKB = entry.shifts.length > 0 && entry.shifts.every(s => {
          const dept = (s.department || '').toUpperCase();
          return dept === 'TTKB' || dept === 'SUPPORTER';
        });
        entry.isTTKB = isTTKB;

        if (targetMin >= 0 && targetEnd >= 0) {
          const PREP_MINS = 2;
          let shiftStartMin = Infinity, shiftEndMin = 0;
          for (const s of entry.shifts) {
            const ss = _toMin(s.start_time), se = _toMin(s.end_time);
            if (ss < shiftStartMin) shiftStartMin = ss;
            if (se > shiftEndMin) shiftEndMin = se;
          }

          const seqStudents = allMyStudentsRaw
            .map(s => ({ ...s, scheduledMin: timeToMinHelper(s.time_local), baseDuration: s.buoi_phu ? 25 : (hvDurationMap[s.student_email] || 25), name: hvNameMap[s.student_email] || s.student_email.split('@')[0] }))
            .sort((a, b) => a.scheduledMin - b.scheduledMin);

          let cursor = shiftStartMin;
          const sequential = [];
          for (const s of seqStudents) {
            if (s.baseDuration <= 0) continue;
            const actualStart = Math.max(s.scheduledMin, cursor);
            const actualEnd = actualStart + s.baseDuration;
            sequential.push({
              type: 'student', name: s.name, email: s.student_email,
              role: s._role, buoiPhu: !!s.buoi_phu,
              startMin: actualStart, endMin: actualEnd, duration: s.baseDuration,
              time: minToHHMM(actualStart), endTime: minToHHMM(actualEnd)
            });
            cursor = actualEnd + PREP_MINS;
            if (cursor > shiftEndMin) cursor = actualEnd;
          }

          const freeGaps = [];
          let gapCursor = shiftStartMin;
          for (const s of sequential) {
            if (s.startMin > gapCursor) {
              freeGaps.push({ type: 'free', startMin: gapCursor, endMin: s.startMin, duration: s.startMin - gapCursor, start: minToHHMM(gapCursor), end: minToHHMM(s.startMin) });
            }
            gapCursor = s.endMin + PREP_MINS;
            if (gapCursor > shiftEndMin) gapCursor = s.endMin;
          }
          if (shiftEndMin > gapCursor) {
            freeGaps.push({ type: 'free', startMin: gapCursor, endMin: shiftEndMin, duration: shiftEndMin - gapCursor, start: minToHHMM(gapCursor), end: minToHHMM(shiftEndMin) });
          }

          entry.sessionItems = [...sequential, ...freeGaps].sort((a, b) => a.startMin - b.startMin);

          if (isTTKB) {
            const studentDuration = targetEnd - targetMin;
            const totalFreeTime = freeGaps.reduce((sum, g) => sum + g.duration, 0);
            const relevantGaps = freeGaps.filter(g => g.endMin >= targetMin);
            const relevantFreeTime = relevantGaps.reduce((sum, g) => sum + g.duration, 0);
            const bestRelevantGap = relevantGaps.length > 0
              ? relevantGaps.reduce((best, g) => g.duration > best.duration ? g : best, relevantGaps[0])
              : null;
            const fitsInRelevantGap = relevantGaps.some(g => g.duration >= studentDuration);

            entry.peakCount = 1;
            entry.countAtStart = 0;
            entry.ttkbFreeTotal = totalFreeTime;
            entry.ttkbRelevantFree = relevantFreeTime;
            entry.ttkbBestGap = bestRelevantGap ? { start: bestRelevantGap.start, end: bestRelevantGap.end, duration: bestRelevantGap.duration } : null;
            entry.ttkbFitsInGap = fitsInRelevantGap;

            if (fitsInRelevantGap) { entry.suitability = 'good'; entry.suitabilityLabel = 'Phù hợp — có slot trống gần giờ HV'; }
            else if (relevantFreeTime > 0) { entry.suitability = 'ok'; entry.suitabilityLabel = 'Có trống gần giờ HV nhưng slot nhỏ'; }
            else { entry.suitability = 'overload'; entry.suitabilityLabel = 'GV kín lịch gần giờ HV học'; }
          } else {
            const timeline = buildTimelineSegments(allMyStudentsRaw, hvDurationMap, hvNameMap, targetMin, targetEnd);
            entry.timeline = timeline.segments;
            entry.suitability = timeline.suitability;
            entry.suitabilityLabel = timeline.suitabilityLabel;
            entry.peakCount = timeline.peakCount;
            entry.countAtStart = timeline.segments.length > 0 ? timeline.segments[0].count : 0;
            entry.overlappingStudents = timeline.allStudents;
          }
        }
      }

      const workingTeachers = Object.values(teacherMap);
      workingTeachers.sort((a, b) => {
        if (a.suitability && b.suitability) {
          const suitOrder = { good: 0, ok: 1, overload: 2 };
          const sa = suitOrder[a.suitability] ?? 1;
          const sb2 = suitOrder[b.suitability] ?? 1;
          if (sa !== sb2) return sa - sb2;
          if ((a.peakCount || 0) !== (b.peakCount || 0)) return (a.peakCount || 0) - (b.peakCount || 0);
        }
        return (b.freeMins || 0) - (a.freeMins || 0);
      });

      return res.json({ ok: true, date: targetDate, workingTeachers });
    } catch (err) {
      console.error('Error:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
