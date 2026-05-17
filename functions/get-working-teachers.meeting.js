// migrated from netlify/functions/get-working-teachers.js (auth-check inlined)
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

  app.get('/get-working-teachers', async (req, res) => {
    try {
      const { user, error: authError } = await verifyAuth(req);
      if (authError) return res.status(401).json({ error: 'Unauthorized' });

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const targetDate = (req.query.date || '').trim();
      if (!targetDate) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

      const [y, m, d] = targetDate.split('-').map(Number);
      const targetDOW = new Date(y, m - 1, d).getDay();

      const { data: allMeetings, error: mErr } = await supabase
        .from('meeting_content')
        .select('id, teacher_email, teacher_name, work_date, start_time, end_time, is_one_time, department, created_at');
      if (mErr) throw mErr;

      const matchingShifts = [];
      for (const row of (allMeetings || [])) {
        const rowYMD = String(row.work_date).slice(0, 10);
        const [ry, rm, rd] = rowYMD.split('-').map(Number);
        const rowDOW = new Date(ry, rm - 1, rd).getDay();
        const isOneTime = row.is_one_time === true || row.is_one_time === 1 || String(row.is_one_time).toLowerCase() === 'true' || String(row.is_one_time).toLowerCase() === 't';
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

      // Deduplicate recurring shifts
      const dedupeMap = {};
      for (const s of matchingShifts) {
        if (s.is_one_time) { dedupeMap['onetime-' + s.meeting_content_id] = s; }
        else {
          const key = `${s.teacher_email}||${s.department}||${s.start_time}||${s.end_time}`;
          if (!dedupeMap[key] || s.created_at > dedupeMap[key].created_at) dedupeMap[key] = s;
        }
      }
      const dedupedShifts = Object.values(dedupeMap);
      matchingShifts.length = 0;
      matchingShifts.push(...dedupedShifts);

      // Remove contained shifts
      function _toMin(t) { const [h = 0, m = 0] = String(t || '').split(':').map(Number); return h * 60 + m; }
      const groups = {};
      for (const s of matchingShifts) {
        const key = `${s.teacher_email}||${s.department}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      }
      const afterContained = [];
      for (const key in groups) {
        const group = groups[key];
        if (group.length <= 1) { afterContained.push(...group); continue; }
        for (let i = 0; i < group.length; i++) {
          const a = group[i]; const aS = _toMin(a.start_time); const aE = _toMin(a.end_time);
          let contained = false;
          for (let j = 0; j < group.length; j++) {
            if (i === j) continue;
            const b = group[j]; const bS = _toMin(b.start_time); const bE = _toMin(b.end_time);
            if (bS <= aS && bE >= aE && (bE - bS) > (aE - aS)) { contained = true; break; }
          }
          if (!contained) afterContained.push(a);
        }
      }
      matchingShifts.length = 0;
      matchingShifts.push(...afterContained);

      // Offdays filter
      const { data: offdays, error: oErr } = await supabase.from('meeting_offdays').select('meeting_content_id, teacher_email').eq('off_date', targetDate);
      if (oErr) throw oErr;
      const offSet = new Set((offdays || []).map(o => `${o.meeting_content_id}`));
      let activeShifts = matchingShifts.filter(s => !offSet.has(String(s.meeting_content_id)));

      const studentTime = (req.query.time || '').trim();
      const studentLevel = (req.query.level || '').trim();
      if (studentTime) activeShifts = activeShifts.filter(s => s.start_time <= studentTime && s.end_time > studentTime);

      // Group by teacher
      const teacherMap = {};
      for (const s of activeShifts) {
        if (!teacherMap[s.teacher_email]) teacherMap[s.teacher_email] = { teacher_email: s.teacher_email, teacher_name: s.teacher_name, shifts: [] };
        teacherMap[s.teacher_email].shifts.push({ start_time: s.start_time, end_time: s.end_time, department: s.department });
      }

      const workingEmails = Object.keys(teacherMap);
      if (workingEmails.length > 0) {
        const { data: nameRows } = await supabase.from('user_roles').select('email, full_name').in('email', workingEmails);
        if (nameRows) for (const nr of nameRows) { const k = nr.email.toLowerCase(); if (teacherMap[k]) teacherMap[k].teacher_name = nr.full_name || teacherMap[k].teacher_name; }
      }

      let eligibleEmailSet = null;
      if (studentLevel) {
        const { data: levelRows } = await supabase.from('level_assignments').select('teacher_email').eq('class_name', studentLevel);
        if (levelRows && levelRows.length > 0) {
          eligibleEmailSet = new Set(levelRows.map(r => (r.teacher_email || '').toLowerCase()));
          for (const em of Object.keys(teacherMap)) { if (!eligibleEmailSet.has(em)) delete teacherMap[em]; }
        }
      }

      const workingTeachers = Object.values(teacherMap);
      workingTeachers.sort((a, b) => (a.teacher_name || a.teacher_email).localeCompare(b.teacher_name || b.teacher_email));

      return res.json({ date: targetDate, dayOfWeek: targetDOW, studentTime: studentTime || null, studentLevel: studentLevel || null, eligibleEmails: eligibleEmailSet ? Array.from(eligibleEmailSet) : null, workingTeachers });
    } catch (error) {
      console.error('Error:', error);
      return res.status(500).json({ error: error.message });
    }
  });
};
