// /opt/my-api/routes/sr-api.meeting.js
// tansinh shift-request v1 (5 Nov 2026)
//
// A teacher who is working but has no shift on meetings.tansinh.info asks for
// one from the "Ngoài giờ làm việc" popup on realtimereport. The request lives
// in public.shift_requests (VM 101). An admin opens the link, and "Chấp nhận"
// creates the shift THROUGH THE EXISTING /addworkmeeting ROUTE on this box, so
// the overlap check, the creator_email and the row shape are exactly what
// "Thêm ca làm việc" produces. Nothing here writes meeting_content directly.
//
// Pages: meetings.tansinh.info/yeucau.html (teacher) and /duyet.html (admin).
// Table: shift_requests.sql in the same folder as this file's handoff.
//
// Endpoints (all behind the Supabase token gate in _msgAuthHelper.js):
//   GET  /sr-me                 staff   who am I, today's date, department hint, my request today
//   POST /sr-create             staff   {department, startTime, endTime, note}  -> a pending request for TODAY
//   GET  /sr-get?id=            staff   the request; the owner, or an admin (who also gets the room and today's shifts)
//   POST /sr-cancel             staff   {id}  the owner withdraws a pending request
//   GET  /sr-pending            admin   pending requests, newest first, plus the recently reviewed ones
//   POST /sr-review             admin   {id, action:'approve'|'decline', note, force}
//   GET  /sr-badges?from=&to=   staff   approved requests in a date range, keyed by the shift they created
//
// ⚠️ The teacher's email always comes from the token, never from the body.
// ⚠️ "Today" is Vietnam's today: this VM runs UTC (PART 7 of the master file).
// ⚠️ One PENDING request per teacher per day; the table's partial unique index
//    enforces it even if two tabs send at once (error code 23505 -> 409).

const { createClient } = require('@supabase/supabase-js');
const _auth = require('./_msgAuthHelper');
const gate = (typeof _auth === 'function') ? _auth : (_auth && _auth.gate);

const SB_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOCAL_API = 'http://127.0.0.1:3111';               // this box; the mtx-bulk pattern
const SITE = 'https://meetings.tansinh.info';
const MEET_BASE = 'https://meeting.tansinh.info/';        // same as WL_MEET_BASE in meetings script.js
const DEPTS = ['TTKB', 'Breakout', 'BM', 'Supporter', 'Mix'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 300;

let _sb = null;
function sb() {
  if (!_sb) _sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return _sb;
}

// ---- small helpers -----------------------------------------------------------
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); }          // the clock in Vietnam, as a UTC-labelled Date
function vnToday() { return vnNow().toISOString().slice(0, 10); }            // YYYY-MM-DD
function vnNowHHMM() { return vnNow().toISOString().slice(11, 16); }         // HH:MM
function hhmm(t) { return String(t == null ? '' : t).slice(0, 5); }
function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function whoEmail(who) { return lower(who && (who.email || (who.user && who.user.email))); }
function whoRole(who) { return String((who && (who.role || (who.user && who.user.role))) || ''); }
function isAdmin(who) { return whoRole(who) === 'Super Admin'; }   // tansinh sr-superonly v1 (5 Nov 2026): only a Super Admin may open and decide a request
function linkFor(id) { return SITE + '/duyet.html?yc=' + encodeURIComponent(id); }
function statusWord(s) { return { pending: 'đang chờ duyệt', approved: 'được chấp nhận', declined: 'bị từ chối', cancelled: 'bị huỷ' }[s] || s; }

// what the browser may see of a request row (the link is not a secret: the review route checks the role)
function pub(r) {
  if (!r) return null;
  return {
    id: r.id, teacher_email: r.teacher_email, teacher_name: r.teacher_name || '',
    department: r.department || '', work_date: r.work_date,
    start_time: hhmm(r.start_time), end_time: hhmm(r.end_time), note: r.note || '',
    status: r.status, created_at: r.created_at,
    reviewed_by: r.reviewed_by || '', reviewed_at: r.reviewed_at || null, review_note: r.review_note || '',
    meeting_content_id: r.meeting_content_id || null, link: linkFor(r.id)
  };
}

// the Tiếp HV room, picked the way wlIndexRooms() in meetings script.js picks it
function pickRoom(rows, email) {
  const em = lower(email), user = em.split('@')[0];
  let tiep = null;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || lower(r.teacher_email) !== em) continue;
    const room = String(r.room_name || '');
    const isTiep = r.meeting_type === 'tiep-hv' || (!r.meeting_type && room === user);
    if (!isTiep) continue;
    if (!tiep || (room === user && tiep.room_name !== user)) tiep = r;
  }
  return tiep ? { found: true, room: String(tiep.room_name || user), link: MEET_BASE + String(tiep.room_name || user) }
              : { found: false, room: '', link: '' };
}

function validate(b) {
  const department = String(b.department || '').trim();
  const startTime = String(b.startTime || '').trim();
  const endTime = String(b.endTime || '').trim();
  const note = String(b.note || '').trim().slice(0, NOTE_MAX);
  if (!DEPTS.includes(department)) return { error: 'Chọn bộ phận.' };
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) return { error: 'Giờ chưa hợp lệ. Gõ dạng 09:30, hoặc chọn bằng các nút giờ.' };
  if (endTime <= startTime) return { error: 'Giờ kết thúc phải sau giờ bắt đầu.' };
  return { department, startTime, endTime, note };
}

async function localCall(method, path, auth, body) {
  const r = await fetch(LOCAL_API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': auth || '' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function fullName(email) {
  const { data } = await sb().from('user_roles').select('full_name').ilike('email', email).limit(1);
  return (data && data[0] && data[0].full_name) || '';
}
async function deptHint(email) {
  const { data } = await sb().from('meeting_content').select('department')
    .ilike('teacher_email', email).not('department', 'is', null)
    .order('work_date', { ascending: false }).limit(1);
  return (data && data[0] && data[0].department) || '';
}
async function getReq(id) {
  const { data } = await sb().from('shift_requests').select('*').eq('id', id).maybeSingle();
  return data || null;
}
async function latestRequest(email, date) {
  const { data } = await sb().from('shift_requests').select('*')
    .ilike('teacher_email', email).eq('work_date', date)
    .order('created_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}
async function pendingToday(email, date) {
  const { data } = await sb().from('shift_requests').select('*')
    .ilike('teacher_email', email).eq('work_date', date).eq('status', 'pending').limit(1);
  return (data && data[0]) || null;
}
// the teacher's shifts on that date, as the roster would show them: the one-time rows of
// the day, plus every weekly row on the same weekday (the roster's own expansion rule)
async function shiftsOn(email, date) {
  const cols = 'id, start_time, end_time, department, is_one_time, work_date';
  const [a, b] = await Promise.all([
    sb().from('meeting_content').select(cols).ilike('teacher_email', email).eq('work_date', date),
    sb().from('meeting_content').select(cols).ilike('teacher_email', email).eq('is_one_time', false)
  ]);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const weekly = (b.data || []).filter(r => r.work_date !== date && new Date(r.work_date + 'T00:00:00Z').getUTCDay() === dow);
  return [...(a.data || []), ...weekly]
    .map(r => ({ id: r.id, start: hhmm(r.start_time), end: hhmm(r.end_time), department: r.department || '', one_time: !!r.is_one_time }))
    .sort((x, y) => x.start.localeCompare(y.start));
}
async function roomInfo(req, email) {
  try {
    const r = await localCall('GET', '/watch-meetings-list', req.headers.authorization, null);
    if (!r.ok || !Array.isArray(r.data)) return { found: null, room: '', link: '', error: 'Không đọc được danh sách phòng trên watch (HTTP ' + r.status + ').' };
    return pickRoom(r.data, email);
  } catch (e) { return { found: null, room: '', link: '', error: e.message }; }
}

module.exports = function (app) {
  if (typeof gate !== 'function') {
    console.error('[sr] _msgAuthHelper.js did not give a gate() function; the sr-* routes are NOT installed');
    return;
  }

  // ---- who am I --------------------------------------------------------------
  app.get('/sr-me', async (req, res) => {
    const who = await gate(req, res, 'staff'); if (!who) return;
    const email = whoEmail(who);
    if (!email) return res.status(500).json({ ok: false, error: 'Không đọc được email từ phiên đăng nhập.' });
    try {
      const today = vnToday();
      const [name, hint, latest, shifts] = await Promise.all([fullName(email), deptHint(email), latestRequest(email, today), shiftsOn(email, today)]);
      res.json({ ok: true, email, name, role: whoRole(who), today, now: vnNowHHMM(), department_hint: hint, request: pub(latest), shifts_today: shifts });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- the teacher sends a request for today ----------------------------------
  app.post('/sr-create', async (req, res) => {
    const who = await gate(req, res, 'staff'); if (!who) return;
    const email = whoEmail(who);
    if (!email) return res.status(500).json({ ok: false, error: 'Không đọc được email từ phiên đăng nhập.' });
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const today = vnToday();
      const name = await fullName(email);
      const { data, error } = await sb().from('shift_requests').insert({
        teacher_email: email, teacher_name: name || null, department: v.department,
        work_date: today, start_time: v.startTime, end_time: v.endTime, note: v.note || null
      }).select('*').single();
      if (error) {
        if (error.code === '23505') {
          const ex = await pendingToday(email, today);
          return res.status(409).json({ ok: false, error: 'Bạn đã có một yêu cầu đang chờ duyệt hôm nay.', request: pub(ex) });
        }
        return res.status(500).json({ ok: false, error: error.message });
      }
      console.log(`[sr] CREATED ${data.id} ${email} ${today} ${v.startTime}-${v.endTime} ${v.department}`);
      res.json({ ok: true, request: pub(data) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- read one request: its owner, or an admin -------------------------------
  app.get('/sr-get', async (req, res) => {
    const who = await gate(req, res, 'staff'); if (!who) return;
    const email = whoEmail(who);
    const id = String(req.query.id || '').trim();
    if (!UUID.test(id)) return res.status(400).json({ ok: false, error: 'Link không đúng.' });
    try {
      const row = await getReq(id);
      if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy yêu cầu này.' });
      const admin = isAdmin(who), owner = lower(row.teacher_email) === email;
      if (!admin && !owner) return res.status(403).json({ ok: false, error: 'Yêu cầu này không phải của bạn.' });
      const out = { ok: true, request: pub(row), is_admin: admin, today: vnToday() };
      if (admin) {
        const [shifts, room] = await Promise.all([shiftsOn(row.teacher_email, row.work_date), roomInfo(req, row.teacher_email)]);
        out.shifts_that_day = shifts;
        out.room = room;
      }
      res.json(out);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- the teacher withdraws a pending request --------------------------------
  app.post('/sr-cancel', async (req, res) => {
    const who = await gate(req, res, 'staff'); if (!who) return;
    const email = whoEmail(who);
    const id = String((req.body || {}).id || '').trim();
    if (!UUID.test(id)) return res.status(400).json({ ok: false, error: 'Link không đúng.' });
    try {
      const { data, error } = await sb().from('shift_requests').update({ status: 'cancelled' })
        .eq('id', id).eq('status', 'pending').ilike('teacher_email', email).select('*');
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) return res.status(409).json({ ok: false, error: 'Yêu cầu không còn ở trạng thái chờ duyệt, hoặc không phải của bạn.' });
      console.log(`[sr] CANCELLED ${id} by ${email}`);
      res.json({ ok: true, request: pub(data[0]) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- the admin's inbox ---------------------------------------------------------
  app.get('/sr-pending', async (req, res) => {
    const who = await gate(req, res, 'admin'); if (!who) return;
    if (!isAdmin(who)) return res.status(403).json({ ok: false, error: 'Chỉ Super Admin xem và duyệt được yêu cầu mở lịch.' });   // tansinh sr-superonly v1
    try {
      const since = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
      const [p, r] = await Promise.all([
        sb().from('shift_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(50),
        sb().from('shift_requests').select('*').neq('status', 'pending').gte('created_at', since).order('created_at', { ascending: false }).limit(20)
      ]);
      if (p.error) return res.status(500).json({ ok: false, error: p.error.message });
      res.json({ ok: true, today: vnToday(), pending: (p.data || []).map(pub), recent: (r.data || []).map(pub) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- the admin decides --------------------------------------------------------
  app.post('/sr-review', async (req, res) => {
    const who = await gate(req, res, 'admin'); if (!who) return;
    if (!isAdmin(who)) return res.status(403).json({ ok: false, error: 'Chỉ Super Admin duyệt được yêu cầu mở lịch.' });   // tansinh sr-superonly v1
    const adminEmail = whoEmail(who);
    const b = req.body || {};
    const id = String(b.id || '').trim();
    const action = String(b.action || '').trim();
    const note = String(b.note || '').trim().slice(0, NOTE_MAX);
    if (!UUID.test(id)) return res.status(400).json({ ok: false, error: 'Link không đúng.' });
    if (action !== 'approve' && action !== 'decline') return res.status(400).json({ ok: false, error: 'action phải là approve hoặc decline.' });
    try {
      const row = await getReq(id);
      if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy yêu cầu này.' });
      if (row.status !== 'pending') return res.status(409).json({ ok: false, error: 'Yêu cầu này đã ' + statusWord(row.status) + '.', request: pub(row) });

      if (action === 'decline') {
        const { data, error } = await sb().from('shift_requests')
          .update({ status: 'declined', reviewed_by: adminEmail, reviewed_at: new Date().toISOString(), review_note: note || null })
          .eq('id', id).eq('status', 'pending').select('*').single();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        console.log(`[sr] DECLINED ${id} (${row.teacher_email}) by ${adminEmail}`);
        return res.json({ ok: true, request: pub(data) });
      }

      // approve: the same payload "Thêm ca làm việc" sends, through the same route
      const room = await roomInfo(req, row.teacher_email);
      const payload = {
        teacherEmail: row.teacher_email,
        teacherName: row.teacher_name || '',
        meetingLink: room.link || '',
        workMeeting: '',
        workDate: row.work_date,
        startTime: hhmm(row.start_time),
        endTime: hhmm(row.end_time),
        isOneTime: true,
        department: row.department || '',
        forceOverlap: !!b.force
      };
      const r = await localCall('POST', '/addworkmeeting', req.headers.authorization, payload);
      const out = r.data || {};
      if (out.overlap && Array.isArray(out.conflicts) && out.conflicts.length) {
        return res.json({ ok: false, overlap: true, conflicts: out.conflicts });
      }
      if (!r.ok || !out.ok || !out.id) {
        return res.status(502).json({ ok: false, error: out.error || ('Tạo ca thất bại (HTTP ' + r.status + ').') });
      }
      const { data, error } = await sb().from('shift_requests')
        .update({ status: 'approved', reviewed_by: adminEmail, reviewed_at: new Date().toISOString(), review_note: note || null, meeting_content_id: out.id })
        .eq('id', id).eq('status', 'pending').select('*').single();
      if (error) {
        console.error(`[sr] APPROVED ${id} but could not mark it: ${error.message} (meeting_content ${out.id})`);
        return res.json({ ok: true, meeting_content_id: out.id, meeting_link: payload.meetingLink, warning: 'Ca đã được tạo, nhưng không ghi được trạng thái yêu cầu. Tải lại trang.' });
      }
      console.log(`[sr] APPROVED ${id} (${row.teacher_email} ${row.work_date} ${payload.startTime}-${payload.endTime}) by ${adminEmail} -> meeting_content ${out.id}`);
      res.json({ ok: true, request: pub(data), meeting_content_id: out.id, meeting_link: payload.meetingLink });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- the badges for the roster ------------------------------------------------
  app.get('/sr-badges', async (req, res) => {
    const who = await gate(req, res, 'staff'); if (!who) return;
    const from = String(req.query.from || '').trim(), to = String(req.query.to || '').trim();
    if (!YMD.test(from) || !YMD.test(to)) return res.status(400).json({ ok: false, error: 'from và to phải là YYYY-MM-DD.' });
    try {
      const { data, error } = await sb().from('shift_requests')
        .select('meeting_content_id, teacher_email, created_at, reviewed_by, reviewed_at')
        .eq('status', 'approved').not('meeting_content_id', 'is', null)
        .gte('work_date', from).lte('work_date', to).limit(500);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      res.json({ ok: true, items: data || [] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
};

module.exports._test = { vnToday, vnNowHHMM, hhmm, pickRoom, validate, pub, linkFor, whoEmail, whoRole, isAdmin };
