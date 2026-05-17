// migrated from netlify/functions/offday.js
module.exports = function(app) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const ANON_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY;

  app.post('/offday', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!/^Bearer\s+/i.test(auth)) return res.status(401).json({ error: 'Missing bearer token' });
      const accessToken = auth.replace(/^Bearer\s+/i, '');

      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_PUBLIC_KEY, Authorization: `Bearer ${accessToken}` } });
      if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
      const user = await userRes.json();
      const email = user?.email || null;

      const roleUrl = new URL(`${SUPABASE_URL}/rest/v1/user_roles`);
      roleUrl.searchParams.set('select', 'role');
      roleUrl.searchParams.set('email', `eq.${email}`);
      roleUrl.searchParams.set('limit', '1');
      const roleRes = await fetch(roleUrl, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
      const roleRows = roleRes.ok ? await roleRes.json() : [];
      const role = roleRows?.[0]?.role ?? null;
      if (role !== 'Admin' && role !== 'Super Admin') return res.status(403).json({ error: 'Forbidden' });

      const { id, workDate, teacherEmail, startTime, endTime } = req.body || {};
      if (!id || !workDate) return res.status(400).json({ error: 'Missing id or workDate' });

      const insertUrl = new URL(`${SUPABASE_URL}/rest/v1/meeting_offdays`);
      insertUrl.searchParams.set('on_conflict', 'meeting_content_id,off_date');
      const resp = await fetch(insertUrl, {
        method: 'POST',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify({
          meeting_content_id: id, off_date: workDate, created_by: email,
          teacher_email: teacherEmail || null,
          start_time: startTime ? (startTime.length === 5 ? `${startTime}:00` : startTime) : null,
          end_time: endTime ? (endTime.length === 5 ? `${endTime}:00` : endTime) : null
        })
      });

      if (resp.status === 409) return res.json({ ok: true });
      if (!resp.ok) { const t = await resp.text(); return res.status(resp.status).json({ ok: false, error: t }); }
      const row = await resp.json();

      if (teacherEmail && workDate) {
        const checkUrl = new URL(`${SUPABASE_URL}/rest/v1/offdays`);
        checkUrl.searchParams.set('select', 'id');
        checkUrl.searchParams.set('person_type', 'eq.teacher');
        checkUrl.searchParams.set('person_email', `ilike.${teacherEmail.trim().toLowerCase()}`);
        checkUrl.searchParams.set('off_from', `lte.${workDate}`);
        checkUrl.searchParams.set('off_to', `gte.${workDate}`);
        checkUrl.searchParams.set('limit', '1');
        const checkResp = await fetch(checkUrl, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
        const existing = checkResp.ok ? await checkResp.json() : [];
        if (!existing.length) {
          await fetch(`${SUPABASE_URL}/rest/v1/offdays`, {
            method: 'POST',
            headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ person_type: 'teacher', person_email: teacherEmail.trim().toLowerCase(), person_name: null, off_from: workDate, off_to: workDate, created_by: email })
          });
        }
      }

      return res.json({ ok: true, row: row?.[0] });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete('/offday', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!/^Bearer\s+/i.test(auth)) return res.status(401).json({ error: 'Missing bearer token' });
      const accessToken = auth.replace(/^Bearer\s+/i, '');

      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_PUBLIC_KEY, Authorization: `Bearer ${accessToken}` } });
      if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
      const user = await userRes.json();
      const email = user?.email || null;

      const roleUrl = new URL(`${SUPABASE_URL}/rest/v1/user_roles`);
      roleUrl.searchParams.set('select', 'role');
      roleUrl.searchParams.set('email', `eq.${email}`);
      roleUrl.searchParams.set('limit', '1');
      const roleRes = await fetch(roleUrl, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
      const roleRows = roleRes.ok ? await roleRes.json() : [];
      const role = roleRows?.[0]?.role ?? null;
      if (role !== 'Admin' && role !== 'Super Admin') return res.status(403).json({ error: 'Forbidden' });

      const id = req.query.id;
      const workDate = req.query.workDate || req.query.date;
      if (!id || !workDate) return res.status(400).json({ error: 'Missing id or workDate' });

      const url = new URL(`${SUPABASE_URL}/rest/v1/meeting_offdays`);
      url.searchParams.set('meeting_content_id', `eq.${id}`);
      url.searchParams.set('off_date', `eq.${workDate}`);
      const resp = await fetch(url, { method: 'DELETE', headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' } });
      if (!resp.ok) { const t = await resp.text(); return res.status(resp.status).json({ ok: false, error: t }); }

      // Clean up offdays if no more shift-offs remain
      const mcUrl = new URL(`${SUPABASE_URL}/rest/v1/meeting_content`);
      mcUrl.searchParams.set('select', 'teacher_email');
      mcUrl.searchParams.set('id', `eq.${id}`);
      mcUrl.searchParams.set('limit', '1');
      const mcResp = await fetch(mcUrl, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
      const mcRows = mcResp.ok ? await mcResp.json() : [];
      const teacherEmail = mcRows?.[0]?.teacher_email;

      if (teacherEmail) {
        const te = teacherEmail.trim().toLowerCase();
        const remUrl = new URL(`${SUPABASE_URL}/rest/v1/meeting_offdays`);
        remUrl.searchParams.set('select', 'id');
        remUrl.searchParams.set('teacher_email', `ilike.${te}`);
        remUrl.searchParams.set('off_date', `eq.${workDate}`);
        remUrl.searchParams.set('limit', '1');
        const remResp = await fetch(remUrl, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
        const remaining = remResp.ok ? await remResp.json() : [];
        if (!remaining.length) {
          const delOffUrl = new URL(`${SUPABASE_URL}/rest/v1/offdays`);
          delOffUrl.searchParams.set('person_type', 'eq.teacher');
          delOffUrl.searchParams.set('person_email', `ilike.${te}`);
          delOffUrl.searchParams.set('off_from', `eq.${workDate}`);
          delOffUrl.searchParams.set('off_to', `eq.${workDate}`);
          await fetch(delOffUrl, { method: 'DELETE', headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' } });
        }
      }

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
};
