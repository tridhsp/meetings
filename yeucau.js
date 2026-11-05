/* yeucau.js — tansinh shift-request v1 (5 Nov 2026)
 *
 * The teacher's "Yêu cầu tạo lịch" page. Opened from the "Ngoài giờ làm việc"
 * popup on realtimereport, which puts the teacher's login after the # in the
 * address (#t=…). That part never reaches a server; it is read once, wiped from
 * the address bar, and used as the Bearer token for the sr-* routes. Without it
 * the page uses the meetings.tansinh.info login, and shows the login card if
 * there is none.
 *
 * Flow: /sr-me -> the form (or today's request, if one exists) -> /sr-create ->
 * the sent view with the link for the admin -> /sr-get every 30 s until the
 * admin decides. The time picker is timepick.js, the same one as "Thêm ca làm
 * việc". The teacher's email is never sent: the server reads it from the token.
 */
(function () {
  'use strict';
  const _DO = '/api';
  const POLL_MS = 30000;
  const PRESETS = [   // the three school shifts, as ROSTER_SHIFTS in script.js
    { name: 'Sáng',  start: '08:00', end: '12:00' },
    { name: 'Chiều', start: '15:00', end: '18:00' },
    { name: 'Tối',   start: '18:00', end: '21:00' }
  ];
  const DAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

  const st = { token: null, from: '', client: null, me: null, req: null, tp: null, poll: null, busy: false };
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function msg(text, type) { const m = $('message'); if (m) { m.textContent = text || ''; m.className = type || ''; } }
  function initials(name, email) {
    const src = String(name || email || '').trim();
    if (!src) return 'GV';
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[parts.length - 2].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateLabel(ymd, today) {   // "Hôm nay · Thứ năm, 05/11/2026"
    const p = String(ymd || '').split('-').map(Number);
    if (p.length !== 3) return ymd || '';
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    const txt = DAYS[d.getUTCDay()] + ', ' + pad(p[2]) + '/' + pad(p[1]) + '/' + p[0];
    return (ymd === today ? 'Hôm nay · ' : '') + txt;
  }
  function timeLabel(iso) {   // Vietnam clock from an ISO stamp
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  }
  function durText(s, e) {
    const d = toMin(e) - toMin(s);
    if (!(d > 0)) return '';
    const h = Math.floor(d / 60), m = d % 60;
    return (h ? h + ' giờ' : '') + (h && m ? ' ' : '') + (m ? m + ' phút' : '');
  }
  function toMin(hhmm) { const m = /^(\d{2}):(\d{2})/.exec(String(hhmm || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function fromMin(min) { min = Math.max(0, Math.min(23 * 60 + 59, min)); return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function deptClass(d) {
    switch (String(d || '').toLowerCase()) {
      case 'ttkb': return 'dept--ttkb'; case 'breakout': return 'dept--breakout'; case 'bm': return 'dept--bm';
      case 'supporter': return 'dept--supporter'; case 'mix': return 'dept--mix'; default: return 'dept--default';
    }
  }
  function chipsHtml(r) {
    return '<span class="sr-chip">' + esc(dateLabel(r.work_date, st.me && st.me.today)) + '</span>'
      + (r.department ? '<span class="sr-chip"><span class="pill__dept ' + deptClass(r.department) + '">' + esc(r.department) + '</span></span>' : '')
      + '<span class="sr-chip"><b>' + esc(r.start_time) + ' → ' + esc(r.end_time) + '</b>' + (durText(r.start_time, r.end_time) ? ' · ' + esc(durText(r.start_time, r.end_time)) : '') + '</span>';
  }

  // ---- the login carried from realtimereport (#t=…), read once and wiped ----
  function hashToken() {
    const m = /(?:^#|[#&])t=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the hash stays; harmless */ }
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
  }
  async function initClient() {
    const res = await fetch(_DO + '/supabase-credentials');
    if (!res.ok) throw new Error('Không đọc được cấu hình đăng nhập.');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();
    st.client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: false }
    });
  }
  async function sessionToken() {
    try { const { data: { session } } = await st.client.auth.getSession(); return (session && session.access_token) || null; }
    catch (e) { return null; }
  }
  async function getToken() {
    if (st.from === 'hash' && st.token) return st.token;
    return await sessionToken();
  }
  // every call: Bearer token, JSON in and out. 401 on the carried token means it expired: try the meetings login once.
  async function api(path, opt) {
    opt = opt || {};
    let token = await getToken();
    if (!token) throw { status: 401, error: 'Chưa đăng nhập.' };
    const send = async (t) => {
      const r = await fetch(_DO + path, {
        method: opt.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + t }, opt.body ? { 'Content-Type': 'application/json' } : {}),
        body: opt.body ? JSON.stringify(opt.body) : undefined
      });
      const out = await r.json().catch(() => ({}));
      return { r, out };
    };
    let { r, out } = await send(token);
    if (r.status === 401 && st.from === 'hash') {
      st.from = ''; st.token = null;
      token = await sessionToken();
      if (token) ({ r, out } = await send(token));
    }
    if (!r.ok) throw { status: r.status, error: out.error || ('HTTP ' + r.status), out };
    return out;
  }

  // ---- views ----------------------------------------------------------------
  const VIEWS = ['vLoading', 'vForm', 'vSent', 'vDone', 'vDeclined', 'vError'];
  const BUTTONS = ['btnCancelReq', 'btnAgain', 'btnRoster', 'btnCopy', 'btnSend'];
  function show(view, buttons) {
    VIEWS.forEach((v) => { $(v).hidden = (v !== view); });
    BUTTONS.forEach((b) => { $(b).hidden = !(buttons || []).includes(b); });
    $('srCard').hidden = false;
    $('loginCard').hidden = true;
  }
  function setStatus(status) {
    const el = $('srStatus'), words = { pending: 'Chờ duyệt', approved: 'Đã tạo ca', declined: 'Từ chối', cancelled: 'Đã huỷ' };
    if (!status) { el.hidden = true; return; }
    el.className = 'sr-status ' + status; $('srStatusText').textContent = words[status] || status; el.hidden = false;
  }
  function paintTeacher() {
    const me = st.me || {};
    $('srAvatar').textContent = initials(me.name, me.email);
    $('srName').textContent = me.name || (me.email ? me.email.split('@')[0] : 'Giáo viên');
    $('srEmail').textContent = me.email || '';
    $('srDate').textContent = dateLabel(me.today, me.today);
  }
  function showError(text) {
    $('srErrorText').textContent = text || 'Thử lại sau.';
    show('vError', []);
    setStatus('');
  }
  function showLogin(text) {
    stopPoll();
    $('srCard').hidden = true;
    $('loginCard').hidden = false;
    const m = $('loginMsg'); if (m) { m.textContent = text || ''; m.className = text ? 'error' : ''; }
    try { $('email').focus(); } catch (e) { /* fine */ }
  }

  // the form: department pre-filled from the teacher's last shift, the picker on the shift that holds "now"
  function showForm() {
    const me = st.me || {};
    stopPoll();
    st.req = null;
    $('srTitle').textContent = 'Yêu cầu tạo lịch';
    $('srSub').textContent = 'Dùng khi bạn đang làm mà ca hôm nay chưa có trên lịch. Admin chấp nhận là ca được tạo và realtimereport mở lại.';
    setStatus('');
    const sel = $('srDept');
    if (me.department_hint && [...sel.options].some((o) => o.value === me.department_hint)) { sel.value = me.department_hint; $('srDeptHint').hidden = false; }
    else { sel.value = ''; $('srDeptHint').hidden = true; }
    const shifts = Array.isArray(me.shifts_today) ? me.shifts_today : [];
    const sh = $('srShiftsToday');
    if (shifts.length) {
      sh.innerHTML = 'Trên lịch hôm nay bạn đã có: ' + shifts.map((s) => '<b>' + esc(s.start) + '–' + esc(s.end) + '</b>' + (s.department ? ' ' + esc(s.department) : '')).join(', ') + '. Yêu cầu này là cho một ca khác.';
      sh.hidden = false;
    } else { sh.hidden = true; sh.textContent = ''; }
    if (!st.tp) st.tp = window.tsTimePick($('srPick'), { presets: PRESETS, onChange: updateSendButton });
    // default: the preset that holds "now"; else from now, rounded down, for three hours
    const now = toMin(me.now);
    let s = null, e = null;
    if (!isNaN(now)) {
      const hit = PRESETS.find((p) => toMin(p.start) <= now && now < toMin(p.end));
      if (hit) { s = hit.start; e = hit.end; }
      else { const a = Math.floor(now / 15) * 15; if (a <= 23 * 60) { s = fromMin(a); e = fromMin(Math.min(23 * 60 + 45, a + 180)); } }
    }
    st.tp.set(s || '', e || '');
    $('srNote').value = '';
    show('vForm', ['btnSend']);
    updateSendButton();
  }
  function updateSendButton() {
    const ok = !!($('srDept').value) && st.tp && st.tp.valid();
    $('btnSend').disabled = !ok || st.busy;
  }
  function showSent(r) {
    st.req = r;
    $('srTitle').textContent = 'Yêu cầu tạo lịch';
    $('srSub').textContent = 'Gửi lúc ' + timeLabel(r.created_at) + ' · ' + dateLabel(r.work_date, st.me && st.me.today).replace('Hôm nay · ', '');
    setStatus('pending');
    $('srChips').innerHTML = chipsHtml(r);
    $('srLink').value = r.link || '';
    const n = $('srNoteEcho');
    if (r.note) { n.textContent = 'Ghi chú đã gửi: ' + r.note; n.hidden = false; } else { n.hidden = true; n.textContent = ''; }
    show('vSent', ['btnCancelReq', 'btnCopy']);
    startPoll();
  }
  function showDone(r) {
    st.req = r; stopPoll();
    $('srTitle').textContent = 'Yêu cầu tạo lịch';
    $('srSub').textContent = 'Admin duyệt lúc ' + timeLabel(r.reviewed_at) + (r.reviewed_by ? ' (' + r.reviewed_by + ')' : '');
    setStatus('approved');
    $('srChipsDone').innerHTML = chipsHtml(r);
    show('vDone', ['btnRoster']);
  }
  function showDeclined(r) {
    st.req = r; stopPoll();
    $('srTitle').textContent = 'Yêu cầu tạo lịch';
    $('srSub').textContent = 'Admin trả lời lúc ' + timeLabel(r.reviewed_at) + (r.reviewed_by ? ' (' + r.reviewed_by + ')' : '');
    setStatus('declined');
    $('srDeclineText').textContent = r.review_note ? 'Lý do: ' + r.review_note : 'Không có lý do kèm theo. Hỏi admin nếu cần.';
    $('srChipsDeclined').innerHTML = chipsHtml(r);
    show('vDeclined', ['btnAgain']);
  }
  function route(r) {
    if (!r) { showForm(); return; }
    if (r.status === 'pending') showSent(r);
    else if (r.status === 'approved') showDone(r);
    else if (r.status === 'declined') showDeclined(r);
    else showForm();
  }

  // ---- data ------------------------------------------------------------------
  async function loadMe() {
    show('vLoading', []);
    try {
      st.me = await api('/sr-me');
      paintTeacher();
      route(st.me.request);
    } catch (e) {
      if (e && e.status === 401) { showLogin(st.from ? 'Phiên đăng nhập đã hết. Đăng nhập lại để tiếp tục.' : ''); return; }
      if (e && e.status === 403) { showError('Tài khoản của bạn không phải giáo viên hoặc admin.'); return; }
      showError((e && e.error) || 'Không tải được trang.');
    }
  }
  async function send() {
    if (st.busy) return;
    const dept = $('srDept').value;
    const v = st.tp ? st.tp.format() : { start: null, end: null };
    if (!dept) { msg('Chọn bộ phận trước.', 'error'); return; }
    if (!st.tp || !st.tp.valid()) { msg('Giờ chưa hợp lệ. Gõ dạng 09:30, hoặc chọn bằng các nút giờ.', 'error'); return; }
    st.busy = true; updateSendButton(); msg('Đang gửi…');
    try {
      const out = await api('/sr-create', { method: 'POST', body: { department: dept, startTime: v.start, endTime: v.end, note: $('srNote').value.trim() } });
      msg('Đã gửi.', 'success');
      showSent(out.request);
    } catch (e) {
      if (e && e.status === 409 && e.out && e.out.request) { msg(e.error, 'error'); showSent(e.out.request); }
      else if (e && e.status === 401) showLogin('Phiên đăng nhập đã hết. Đăng nhập lại để gửi.');
      else msg((e && e.error) || 'Gửi thất bại.', 'error');
    } finally { st.busy = false; updateSendButton(); }
  }
  async function cancelReq() {
    if (!st.req || st.busy) return;
    if (!confirm('Huỷ yêu cầu này? Bạn có thể gửi lại một yêu cầu khác.')) return;
    st.busy = true; msg('Đang huỷ…');
    try {
      await api('/sr-cancel', { method: 'POST', body: { id: st.req.id } });
      msg('Đã huỷ yêu cầu.', 'success');
      await loadMe();
    } catch (e) {
      msg((e && e.error) || 'Huỷ thất bại.', 'error');
      if (e && e.status === 409) await loadMe();   // somebody decided meanwhile: show what happened
    } finally { st.busy = false; }
  }
  async function pollOnce() {
    if (!st.req || st.req.status !== 'pending' || document.visibilityState === 'hidden') return;
    try {
      const out = await api('/sr-get?id=' + encodeURIComponent(st.req.id));
      if (out && out.request && out.request.status !== 'pending') route(out.request);
    } catch (e) { /* a blip; the next poll tries again */ }
  }
  function startPoll() { stopPoll(); st.poll = setInterval(pollOnce, POLL_MS); }
  function stopPoll() { if (st.poll) { clearInterval(st.poll); st.poll = null; } }

  async function copyLink() {
    const link = (st.req && st.req.link) || $('srLink').value;
    if (!link) return;
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { ok = false; }
    if (!ok) {
      try { const inp = $('srLink'); inp.focus(); inp.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
    if (ok) msg('Đã sao chép link. Gửi cho admin qua Zalo hoặc Chat.', 'success');
    else { const inp = $('srLink'); inp.focus(); inp.select(); msg('Trình duyệt không cho sao chép tự động. Bấm Ctrl+C để chép link đã chọn.', 'error'); }
  }

  // ---- login card (only when there is no login to use) ----------------------
  async function doLogin() {
    const email = $('email').value.trim(), password = $('password').value;
    const m = $('loginMsg');
    if (!email || !password) { m.textContent = 'Nhập email và mật khẩu.'; m.className = 'error'; return; }
    m.textContent = 'Đang đăng nhập…'; m.className = '';
    try {
      const { error } = await st.client.auth.signInWithPassword({ email, password });
      if (error) { m.textContent = 'Đăng nhập thất bại: ' + error.message; m.className = 'error'; return; }
      st.from = 'session'; st.token = await sessionToken();
      m.textContent = '';
      await loadMe();
    } catch (e) { m.textContent = 'Đăng nhập thất bại.'; m.className = 'error'; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const t = hashToken();
    if (t) { st.token = t; st.from = 'hash'; }
    $('btnSend').addEventListener('click', send);
    $('btnCopy').addEventListener('click', copyLink);
    $('srCopySmall').addEventListener('click', copyLink);
    $('btnCancelReq').addEventListener('click', cancelReq);
    $('btnAgain').addEventListener('click', showForm);
    $('srDept').addEventListener('change', updateSendButton);
    $('login').addEventListener('click', doLogin);
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('togglePwd').addEventListener('click', () => { const p = $('password'); p.type = p.type === 'password' ? 'text' : 'password'; });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollOnce(); });
    try { await initClient(); } catch (e) { $('srCard').hidden = false; showError('Không tải được cấu hình đăng nhập. Thử lại sau.'); return; }
    if (!st.token) { st.token = await sessionToken(); st.from = st.token ? 'session' : ''; }
    if (!st.token) { showLogin(''); return; }
    await loadMe();
  });
})();
