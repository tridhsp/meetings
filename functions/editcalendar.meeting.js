// GET  /editcalendar?id=<uuid>
// PUT  /editcalendar  { id, teacherEmail, ... }
module.exports = function (app) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const ANON_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.ANON_PUBLIC_KEY;

  // --- Supabase helpers (using REST) ---
  async function sbGetUser(accessToken) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: ANON_PUBLIC_KEY }
    });
    if (!r.ok) return null;
    return r.json();
  }
  async function sbSelect(table, query) {
    const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Prefer: 'return=representation' }
    });
    if (!r.ok) throw new Error(`Supabase select failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async function sbPatch(table, query, patch) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) throw new Error((data && (data.message || data.error)) || text || r.statusText);
    return data;
  }

  function normalizeTime(t) {
    if (!t) return undefined;
    if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`;
    if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
    return undefined;
  }
  function isValidDateYMD(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ''); }

  function buildPatchFromBody(b) {
    const p = {};
    if (typeof b.teacherEmail === 'string') p.teacher_email = b.teacherEmail.trim();
    if (typeof b.teacherName === 'string') p.teacher_name = b.teacherName.trim();
    if (typeof b.meetingLink === 'string') p.meeting_link = b.meetingLink.trim();
    if (typeof b.workMeeting === 'string') p.work_meeting = b.workMeeting.trim();
    if (typeof b.notes === 'string') p.notes = b.notes.trim();
    if (typeof b.isOneTime === 'boolean') p.is_one_time = b.isOneTime;
    if (typeof b.department === 'string') {
      const allowed = new Set(['TTKB', 'Breakout', 'BM', 'Supporter', 'Mix']);
      const val = b.department.trim();
      p.department = allowed.has(val) ? val : null;
    }
    if (typeof b.workDate === 'string') {
      if (!isValidDateYMD(b.workDate)) throw new Error('workDate must be YYYY-MM-DD');
      p.work_date = b.workDate;
    }
    if (typeof b.startTime === 'string') {
      const v = normalizeTime(b.startTime);
      if (!v) throw new Error('startTime must be HH:MM or HH:MM:SS');
      p.start_time = v;
    }
    if (typeof b.endTime === 'string') {
      const v = normalizeTime(b.endTime);
      if (!v) throw new Error('endTime must be HH:MM or HH:MM:SS');
      p.end_time = v;
    }
    return p;
  }

  async function checkCanEdit(user, row) {
    if (!user) return false;
    const email = (user.email || '').toLowerCase();
    try {
      const q = new URLSearchParams();
      q.set('select', 'email,role');
      q.set('email', `eq.${email}`);
      const roles = await sbSelect('user_roles', q.toString());
      const isAdmin = Array.isArray(roles) && roles.some(r => {
        const role = (r.role || '').toLowerCase();
        return role === 'admin' || role === 'super admin' || role === 'super_admin' || role === 'superadmin';
      });
      if (isAdmin) return true;
    } catch (_) {}
    if (row?.creator_email && row.creator_email.toLowerCase() === email) return true;
    if (row?.teacher_email && row.teacher_email.toLowerCase() === email) return true;
    return false;
  }

  // ============ GET ============
  app.get('/editcalendar', async (req, res) => {
    try {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANON_PUBLIC_KEY) {
        return res.status(500).json({ ok: false, error: 'Missing env vars' });
      }
      const authz = req.headers.authorization || '';
      const token = (authz.startsWith('Bearer ') ? authz.slice(7) : '').trim();
      if (!token) return res.status(401).json({ ok: false, error: 'Missing Bearer token' });

      const user = await sbGetUser(token);
      if (!user) return res.status(401).json({ ok: false, error: 'Invalid session' });

      const id = (req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

      const q = new URLSearchParams();
      q.set('id', `eq.${id}`);
      q.set('select', '*');
      const rows = await sbSelect('meeting_content', q.toString());
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return res.status(404).json({ ok: false, error: 'Row not found' });
      if (!(await checkCanEdit(user, row))) return res.status(403).json({ ok: false, error: 'Forbidden' });
      return res.json({ ok: true, row });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ============ PUT ============
  app.put('/editcalendar', async (req, res) => {
    try {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANON_PUBLIC_KEY) {
        return res.status(500).json({ ok: false, error: 'Missing env vars' });
      }
      const authz = req.headers.authorization || '';
      const token = (authz.startsWith('Bearer ') ? authz.slice(7) : '').trim();
      if (!token) return res.status(401).json({ ok: false, error: 'Missing Bearer token' });

      const user = await sbGetUser(token);
      if (!user) return res.status(401).json({ ok: false, error: 'Invalid session' });

      const body = req.body || {};
      const id = (body.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

      const q = new URLSearchParams();
      q.set('id', `eq.${id}`);
      q.set('select', '*');
      const rows = await sbSelect('meeting_content', q.toString());
      const current = Array.isArray(rows) ? rows[0] : null;
      if (!current) return res.status(404).json({ ok: false, error: 'Row not found' });
      if (!(await checkCanEdit(user, current))) return res.status(403).json({ ok: false, error: 'Forbidden' });

      let patch;
      try { patch = buildPatchFromBody(body); }
      catch (e) { return res.status(400).json({ ok: false, error: e.message || 'Invalid input' }); }
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'No editable fields provided' });

      if (patch.start_time && patch.end_time && patch.start_time >= patch.end_time) {
        return res.status(400).json({ ok: false, error: 'endTime must be later than startTime' });
      }

      // --- Overlap check ---
      const forceOverlap = !!body.forceOverlap;
      if (!forceOverlap) {
        const merged = {
          teacher_email: patch.teacher_email || current.teacher_email,
          work_date: patch.work_date || current.work_date,
          start_time: (patch.start_time || current.start_time || '').slice(0, 5),
          end_time: (patch.end_time || current.end_time || '').slice(0, 5),
          is_one_time: patch.is_one_time !== undefined ? patch.is_one_time : current.is_one_time
        };

        const qOvl = new URLSearchParams();
        qOvl.set('select', 'id,teacher_name,work_date,start_time,end_time,is_one_time,department');
        qOvl.set('teacher_email', `eq.${merged.teacher_email}`);
        qOvl.set('id', `neq.${id}`);
        const existing = await sbSelect('meeting_content', qOvl.toString());

        if (existing && existing.length > 0) {
          const newDow = new Date(merged.work_date + 'T00:00:00').getDay();
          const newIsRecurring = !merged.is_one_time;
          const conflicts = existing.filter(row => {
            const rowDow = new Date(row.work_date + 'T00:00:00').getDay();
            const sameDate = row.work_date === merged.work_date;
            const sameDow = rowDow === newDow;
            const rowIsRecurring = !row.is_one_time;
            const dateMatch = sameDate || (sameDow && (rowIsRecurring || newIsRecurring));
            if (!dateMatch) return false;
            const rStart = (row.start_time || '').slice(0, 5);
            const rEnd = (row.end_time || '').slice(0, 5);
            const isOverlap = merged.start_time < rEnd && merged.end_time > rStart;
            const isAdjacent = !isOverlap && (merged.start_time === rEnd || merged.end_time === rStart);
            if (isOverlap || isAdjacent) {
              row._conflictType = isAdjacent ? 'adjacent' : 'overlap';
              return true;
            }
            return false;
          });

          if (conflicts.length > 0) {
            return res.json({
              ok: false,
              overlap: true,
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

      const updated = await sbPatch('meeting_content', `id=eq.${encodeURIComponent(id)}`, patch);
      const row = Array.isArray(updated) ? updated[0] : updated;
      return res.json({ ok: true, row });
    } catch (err) {
      console.error('editcalendar error:', err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
};
