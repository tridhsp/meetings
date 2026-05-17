// migrated from netlify/functions/deletecalendar.js
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

module.exports = function(app) {
  const ANON_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY;

  async function sbGetUser(token) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_PUBLIC_KEY },
    });
    if (!r.ok) return null;
    return r.json();
  }
  async function sbSelect(table, q) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=representation',
      },
    });
    if (!r.ok) throw new Error(`Select failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async function sbDelete(table, q) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=representation',
      },
    });
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data };
  }

  app.delete('/deletecalendar', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const token = auth.slice(7);

      const user = await sbGetUser(token);
      if (!user?.email) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const roles = await sbSelect('user_roles', `select=role&email=eq.${user.email}&limit=1`);
      const role = roles?.[0]?.role;
      if (role !== 'Admin' && role !== 'Super Admin') return res.status(403).json({ ok: false, error: 'Forbidden' });

      const id = req.query.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

      // Get row first (for teacher_email to clean up offdays)
      const rows = await sbSelect('meeting_content', `select=teacher_email,work_date,start_time,end_time&id=eq.${id}&limit=1`);
      const row = rows?.[0];

      // Delete the meeting_content row
      const del = await sbDelete('meeting_content', `id=eq.${id}`);
      if (!del.ok) return res.status(del.status).json({ ok: false, error: 'Delete failed' });

      // Clean up associated meeting_offdays
      await sbDelete('meeting_offdays', `meeting_content_id=eq.${id}`);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
};
