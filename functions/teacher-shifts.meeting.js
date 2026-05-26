// migrated from netlify/functions/teacher-shifts.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/teacher-shifts', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
      const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userRes?.user) return res.status(401).json({ error: 'Invalid token' });

      const teacherEmail = (req.query.email || '').trim().toLowerCase();
      const fromDate = req.query.from || '';
      const toDate = req.query.to || '';
      if (!teacherEmail || !fromDate || !toDate) return res.status(400).json({ error: 'email, from, to are required' });

      const { data: rows, error } = await supabase
        .from('meeting_content')
        .select('id, teacher_email, teacher_name, work_date, start_time, end_time, is_one_time, department')
        .ilike('teacher_email', teacherEmail);
      if (error) return res.status(400).json({ error: error.message });

      if (!rows || !rows.length) return res.json({ shifts: [] });

      const { data: existingOffs } = await supabase
        .from('meeting_offdays')
        .select('meeting_content_id, off_date')
        .ilike('teacher_email', teacherEmail)
        .gte('off_date', fromDate)
        .lte('off_date', toDate);

      const offSet = new Set((existingOffs || []).map(o => `${o.meeting_content_id}|${o.off_date}`));

      const from = new Date(fromDate + 'T00:00:00');
      const to = new Date(toDate + 'T00:00:00');
      const shifts = [];

      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const dow = d.getDay();

        for (const row of rows) {
          const rowYMD = String(row.work_date).slice(0, 10);
          const rowDate = new Date(rowYMD + 'T00:00:00');
          const rowDOW = rowDate.getDay();

          const isOne = row.is_one_time === true || row.is_one_time === 1 || String(row.is_one_time).toLowerCase() === 'true' || String(row.is_one_time).toLowerCase() === 't';
          const match = isOne ? (rowYMD === dateStr) : (rowDOW === dow);
          if (!match) continue;

          const isOff = offSet.has(`${row.id}|${dateStr}`);
          shifts.push({
            meeting_content_id: row.id,
            date: dateStr,
            start_time: (row.start_time || '').slice(0, 5),
            end_time: (row.end_time || '').slice(0, 5),
            department: row.department || '',
            is_one_time: !!isOne,
            is_off: isOff
          });
        }
      }

      return res.json({ shifts });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
