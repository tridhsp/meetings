// migrated from netlify/functions/addworkmeeting.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/addworkmeeting', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ ok: false, error: 'Missing bearer token' });

      const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
      const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), SERVICE_KEY);

      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ ok: false, error: 'Invalid auth token' });
      const user = userRes.user;

      const { data: roles } = await supabase.from('user_roles').select('role').eq('email', user.email).in('role', ['Admin', 'Super Admin']).limit(1);
      if (!roles || roles.length === 0) return res.status(403).json({ ok: false, error: 'Not allowed' });

      const body = req.body || {};
      const forceOverlap = !!body.forceOverlap;
      const { teacherEmail, teacherName, meetingLink, workMeeting, workDate, startTime, endTime, isOneTime, department } = body;

      const allowedDepts = new Set(['TTKB','Breakout','BM','Supporter','Mix']);
      const dept = (typeof department === 'string' && allowedDepts.has(department)) ? department : null;

      if (!teacherEmail) return res.status(400).json({ ok: false, error: 'teacherEmail is required' });
      if (!workDate) return res.status(400).json({ ok: false, error: 'workDate is required' });
      if (!startTime) return res.status(400).json({ ok: false, error: 'startTime is required' });
      if (!endTime) return res.status(400).json({ ok: false, error: 'endTime is required' });

      const insertRow = {
        creator_email: user.email,
        teacher_email: teacherEmail,
        teacher_name: teacherName || null,
        meeting_link: meetingLink || null,
        work_meeting: workMeeting || null,
        work_date: workDate,
        start_time: startTime,
        end_time: endTime,
        is_one_time: (isOneTime !== false),
        department: dept
      };

      if (!forceOverlap) {
        const { data: existing } = await supabase.from('meeting_content')
          .select('id, teacher_name, work_date, start_time, end_time, is_one_time, department')
          .ilike('teacher_email', teacherEmail);   // tansinh shift-dates v1: case-insensitive, like the roster

        if (existing && existing.length > 0) {
          const newDow = new Date(workDate + 'T00:00:00').getDay();
          const newIsRecurring = !(insertRow.is_one_time);
          const todayYMD = (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();   // tansinh shift-dates v1: today in Vietnam
          const conflicts = existing.filter(row => {
            const rowDow = new Date(row.work_date + 'T00:00:00').getDay();
            const sameDate = row.work_date === workDate;
            const sameDow = rowDow === newDow;
            const rowIsRecurring = !row.is_one_time;
            /* tansinh shift-dates v1 (5 Nov 2026): a weekly row counts on its weekday; a one-time row counts on its own
               date only, and against a NEW weekly shift only if that date is today or later. Before this, a one-time
               row from 2025 "conflicted" with every new weekly shift on that weekday for ever. */
            const dateMatch = rowIsRecurring ? sameDow : (newIsRecurring ? (sameDow && row.work_date >= todayYMD) : sameDate);
            if (!dateMatch) return false;
            const rStart = (row.start_time || '').slice(0, 5);
            const rEnd = (row.end_time || '').slice(0, 5);
            const isOverlap = startTime < rEnd && endTime > rStart;
            const isAdjacent = !isOverlap && (startTime === rEnd || endTime === rStart);
            if (isOverlap || isAdjacent) {
              row._conflictType = isAdjacent ? 'adjacent' : 'overlap';
              return true;
            }
            return false;
          });

          if (conflicts.length > 0) {
            return res.json({
              ok: false, overlap: true,
              conflicts: conflicts.map(c => ({
                date: c.work_date,
                startTime: (c.start_time || '').slice(0, 5),
                endTime: (c.end_time || '').slice(0, 5),
                isRecurring: !c.is_one_time,
                department: c.department,
                conflictType: c._conflictType || 'overlap'
              }))
            });
          }
        }
      }

      const { data, error } = await supabase.from('meeting_content').insert(insertRow).select('id').single();
      if (error) return res.status(500).json({ ok: false, error: error.message });

      return res.json({ ok: true, id: data.id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
};
