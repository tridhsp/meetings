// /opt/my-api/routes/save-temp-substitute.meeting.js
// Runs on Digital Ocean droplet (NOT Netlify)
// GET/POST/DELETE /save-temp-substitute
// Saves or deletes temporary substitute teacher assignments.
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// === tansinh sub-gate BEGIN (9 Oct 2026) ===
// Until 9 Oct 2026 this route had no login check: anyone on the internet could
// list, add or delete substitute assignments (session.tansinh.info reads the same
// table, session_substitute_assignments). The rules, once SUB_GATE_MODE is 'enforce':
//   GET     signed in. Admin, Super Admin and Teacher get every row in the range;
//           anyone else only the rows for their own student email.
//   POST    Admin or Super Admin. created_by becomes the signed-in email.
//   DELETE  Admin or Super Admin.
// In 'observe' mode nothing is refused and nothing changes: each call is only
// logged as "[sub-gate] OBSERVE ... would=allow|refuse", so the log can prove
// every real caller sends a login before 'enforce' is switched on.
// Fails closed in 'enforce': if the login cannot be checked, the call is refused.
const SUB_GATE_MODE = 'observe';
const SUB_READ_ALL = ['Admin', 'Super Admin', 'Teacher'];
const SUB_WRITE = ['Admin', 'Super Admin'];
const _subWhoCache = new Map();                       // token -> { at, email, role }, 60 s, evicted
function _subSb() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
  );
}
async function _subWho(req, res, allowed) {
  const enforce = SUB_GATE_MODE === 'enforce';
  const ip = req.headers['x-forwarded-for'] ? 'yes' : 'no';
  let email = '', role = '', why = '';
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) why = 'no-token';
    else {
      const tok = m[1].trim();
      const now = Date.now();
      let hit = _subWhoCache.get(tok);
      if (!hit || now - hit.at > 60000) {
        const sb = _subSb();
        const { data: u, error: ue } = await sb.auth.getUser(tok);
        if (ue || !u || !u.user || !u.user.email) hit = { at: now, email: '', role: '' };
        else {
          const em = String(u.user.email).toLowerCase();
          const { data: rr } = await sb.from('user_roles').select('role').eq('email', em).limit(1);
          hit = { at: now, email: em, role: (rr && rr[0] && rr[0].role) || '' };
        }
        _subWhoCache.set(tok, hit);
        if (_subWhoCache.size > 500) {
          for (const [k, v] of _subWhoCache) { if (now - v.at > 60000 || _subWhoCache.size > 400) _subWhoCache.delete(k); }
        }
      }
      email = hit.email; role = hit.role;
      if (!email) why = 'bad-token';
      else if (allowed && !allowed.includes(role)) why = 'role';
    }
  } catch (e) {
    why = 'check-failed';
    console.error('[sub-gate] login check failed:', e && e.message);
  }
  const ok = !why;
  console.log(`[sub-gate] ${enforce ? 'ENFORCE' : 'OBSERVE'} ${req.method} xff=${ip} auth=${why === 'no-token' ? 'no' : 'yes'} email=${email || '-'} role=${role || '-'} would=${ok ? 'allow' : 'refuse'}${why ? ' why=' + why : ''}`);
  if (!enforce) return { email, role, observe: true };
  if (ok) return { email, role };
  if (why === 'check-failed') res.status(500).json({ error: 'Không kiểm tra được đăng nhập. Thử lại sau.' });
  else if (why === 'role') res.status(403).json({ error: 'Chỉ Admin hoặc Super Admin được thay đổi phân công.' });
  else res.status(401).json({ error: 'Vui lòng đăng nhập.', signin: true });
  return null;
}
// === tansinh sub-gate END ===

module.exports = function (app) {

  // GET = load existing substitute assignments
  app.get('/save-temp-substitute', async (req, res) => {
    try {
      const who = await _subWho(req, res, null);           // tansinh sub-gate
      if (!who) return;
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const params = req.query || {};
      let query = supabase
        .from('session_substitute_assignments')
        .select('*')
        .order('assign_date', { ascending: true });

      if (params.from_date) query = query.gte('assign_date', params.from_date);
      if (params.to_date) query = query.lte('assign_date', params.to_date);

      const { data, error } = await query;
      if (error) throw error;

      const rows = (who.observe || SUB_READ_ALL.includes(who.role))   // tansinh sub-gate: a student sees only their own rows
        ? (data || [])
        : (data || []).filter(r => (r.student_email || '').toLowerCase() === who.email);
      return res.json({ ok: true, assignments: rows });
    } catch (err) {
      console.error('Load assignments error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST = save a substitute assignment
  app.post('/save-temp-substitute', async (req, res) => {
    try {
      const who = await _subWho(req, res, SUB_WRITE);      // tansinh sub-gate
      if (!who) return;
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const body = req.body || {};
      const {
        student_email, original_teacher_email, substitute_teacher_email,
        assign_date, day_of_week, time_local,
        student_name, student_minutes, student_level,
        original_teacher_name, substitute_teacher_name,
        created_by
      } = body;

      if (!student_email || !assign_date || !substitute_teacher_email) {
        return res.status(400).json({ error: 'student_email, assign_date, and substitute_teacher_email are required' });
      }

      const role = body.role || 'TTKB';

      const row = {
        student_email,
        original_teacher_email: original_teacher_email || null,
        substitute_teacher_email,
        assign_date,
        day_of_week: day_of_week != null ? day_of_week : null,
        time_local: time_local || null,
        student_name: student_name || null,
        student_minutes: student_minutes || 0,
        student_level: student_level || null,
        original_teacher_name: original_teacher_name || null,
        substitute_teacher_name: substitute_teacher_name || null,
        created_by: who.email || created_by || null,      // tansinh sub-gate: the signed-in admin
        role: role
      };

      const { data, error } = await supabase
        .from('session_substitute_assignments')
        .upsert(row, { onConflict: 'student_email,assign_date,role' })
        .select();

      if (error) throw error;

      return res.json({ ok: true, saved: data });
    } catch (err) {
      console.error('Save assignment error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE = remove a substitute assignment
  app.delete('/save-temp-substitute', async (req, res) => {
    try {
      const who = await _subWho(req, res, SUB_WRITE);      // tansinh sub-gate
      if (!who) return;
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      const body = req.body || {};
      const { id, student_email, assign_date } = body;

      if (id) {
        const { error } = await supabase
          .from('session_substitute_assignments')
          .delete()
          .eq('id', id);
        if (error) throw error;
      } else if (student_email && assign_date) {
        const { error } = await supabase
          .from('session_substitute_assignments')
          .delete()
          .eq('student_email', student_email)
          .eq('assign_date', assign_date);
        if (error) throw error;
      } else {
        return res.status(400).json({ error: 'id or (student_email + assign_date) required' });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Delete assignment error:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
