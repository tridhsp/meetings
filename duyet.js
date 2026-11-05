/* duyet.js — tansinh shift-request v1 (5 Nov 2026)
 *
 * The admin side of a teacher's "Yêu cầu tạo lịch". With ?yc=<id> in the
 * address it shows that one request: who, the day, the department, the time on
 * a bar beside the shifts that day, the note, whether the Tiếp HV room exists;
 * then "Từ chối" (with an optional reason the teacher sees) or "Chấp nhận, tạo
 * ca". Accepting goes through /sr-review, which calls the box's own
 * /addworkmeeting, so an overlap comes back the same way "Thêm ca làm việc"
 * reports it, and the admin may still say "Vẫn tạo ca".
 * Without ?yc= it lists the pending requests, newest first.
 * Login: the meetings.tansinh.info session; the login card if there is none.
 * The role is checked on the server; a teacher who opens their own link sees
 * the status, without the buttons.
 */
(function () {
  'use strict';
  const _DO = '/api';
  const DAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  const st = { client: null, id: '', data: null, busy: false };
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function msg(text, type) { const m = $('message'); if (m) { m.textContent = text || ''; m.className = type || ''; } }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function initials(name, email) {
    const src = String(name || email || '').trim();
    if (!src) return 'GV';
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[parts.length - 2].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  function dateLabel(ymd, today) {
    const p = String(ymd || '').split('-').map(Number);
    if (p.length !== 3) return ymd || '';
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    const txt = DAYS[d.getUTCDay()] + ', ' + pad(p[2]) + '/' + pad(p[1]) + '/' + p[0];
    return (ymd === today ? 'Hôm nay · ' : '') + txt;
  }
  function timeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  }
  function dayTimeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  }
  function toMin(hhmm) { const m = /^(\d{2}):(\d{2})/.exec(String(hhmm || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function durText(s, e) {
    const d = toMin(e) - toMin(s);
    if (!(d > 0)) return '';
    const h = Math.floor(d / 60), m = d % 60;
    return (h ? h + ' giờ' : '') + (h && m ? ' ' : '') + (m ? m + ' phút' : '');
  }
  function deptClass(d) {
    switch (String(d || '').toLowerCase()) {
      case 'ttkb': return 'dept--ttkb'; case 'breakout': return 'dept--breakout'; case 'bm': return 'dept--bm';
      case 'supporter': return 'dept--supporter'; case 'mix': return 'dept--mix'; default: return 'dept--default';
    }
  }
  function deptBadge(d) { return d ? '<span class="pill__dept ' + deptClass(d) + '">' + esc(d) + '</span>' : '<span class="muted">—</span>'; }
  const STATUS_WORDS = { pending: 'Chờ duyệt', approved: 'Đã tạo ca', declined: 'Từ chối', cancelled: 'GV đã huỷ' };

  // ---- login -----------------------------------------------------------------
  async function initClient() {
    const res = await fetch(_DO + '/supabase-credentials');
    if (!res.ok) throw new Error('Không đọc được cấu hình đăng nhập.');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();
    st.client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: false }
    });
  }
  async function token() {
    try { const { data: { session } } = await st.client.auth.getSession(); return (session && session.access_token) || null; }
    catch (e) { return null; }
  }
  async function api(path, opt) {
    opt = opt || {};
    const t = await token();
    if (!t) throw { status: 401, error: 'Chưa đăng nhập.' };
    const r = await fetch(_DO + path, {
      method: opt.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + t }, opt.body ? { 'Content-Type': 'application/json' } : {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, error: out.error || ('HTTP ' + r.status), out };
    return out;
  }

  // ---- views ---------------------------------------------------------------------
  const VIEWS = ['vLoading', 'vList', 'vReq', 'vError'];
  const BUTTONS = ['btnList', 'btnRoster', 'btnDecline', 'btnDeclineBack', 'btnDeclineGo', 'btnForceBack', 'btnForceGo', 'btnApprove'];
  function show(view, buttons) {
    VIEWS.forEach((v) => { $(v).hidden = (v !== view); });
    BUTTONS.forEach((b) => { $(b).hidden = !(buttons || []).includes(b); });
    $('srCard').hidden = false;
    $('loginCard').hidden = true;
  }
  function setStatus(status) {
    const el = $('srStatus');
    if (!status) { el.hidden = true; return; }
    el.className = 'sr-status ' + status; $('srStatusText').textContent = STATUS_WORDS[status] || status; el.hidden = false;
  }
  function showError(text) { $('srTitle').textContent = 'Yêu cầu mở lịch'; $('srSub').textContent = ''; setStatus(''); $('srErrorText').textContent = text || ''; show('vError', ['btnList']); }
  function showLogin(text) {
    $('srCard').hidden = true; $('loginCard').hidden = false;
    const m = $('loginMsg'); if (m) { m.textContent = text || ''; m.className = text ? 'error' : ''; }
    try { $('email').focus(); } catch (e) { /* fine */ }
  }

  // the read-only bar: the request in blue, that day's other shifts in grey
  function paintBar(r, shifts) {
    const bar = $('srBar');
    const s = toMin(r.start_time), e = toMin(r.end_time);
    let lo = 6 * 60, hi = 23 * 60;
    const all = [{ s, e }].concat((shifts || []).map((x) => ({ s: toMin(x.start), e: toMin(x.end) })));
    all.forEach((x) => { if (!isNaN(x.s)) lo = Math.min(lo, Math.floor(x.s / 60) * 60); if (!isNaN(x.e)) hi = Math.max(hi, Math.min(24 * 60, Math.ceil(x.e / 60) * 60)); });
    const span = hi - lo, h0 = lo / 60;
    const pct = (m) => (((Math.min(hi, Math.max(lo, m)) - lo) / span) * 100).toFixed(3) + '%';
    let ticks = '', marks = '';
    for (let h = h0; h * 60 <= hi; h++) {
      marks += '<i class="mark" style="left:' + pct(h * 60) + '"></i>';
      if ((h - h0) % 2 === 0) ticks += '<span class="tick" style="left:' + pct(h * 60) + '">' + pad(h) + '</span>';
    }
    let bands = (shifts || []).map((x) => {
      const a = toMin(x.start), b = toMin(x.end);
      if (isNaN(a) || isNaN(b) || b <= a) return '';
      return '<div class="band other" style="left:' + pct(a) + ';width:' + (parseFloat(pct(b)) - parseFloat(pct(a))).toFixed(3) + '%" title="Ca đã có trên lịch"><span>' + esc(x.start) + '–' + esc(x.end) + '</span></div>';
    }).join('');
    if (!isNaN(s) && !isNaN(e) && e > s) {
      bands += '<div class="band" style="left:' + pct(s) + ';width:' + (parseFloat(pct(e)) - parseFloat(pct(s))).toFixed(3) + '%" title="Ca được yêu cầu"><span>' + esc(r.start_time) + '–' + esc(r.end_time) + '</span></div>';
    }
    bar.innerHTML = '<div class="ticks" aria-hidden="true">' + ticks + '</div><div class="track" aria-hidden="true">' + marks + bands + '</div>';
  }

  function paintRequest(out) {
    const r = out.request, today = out.today, admin = !!out.is_admin;
    st.data = out;
    $('srTitle').textContent = 'Yêu cầu mở lịch';
    $('srSub').textContent = (admin ? 'Giáo viên gửi lúc ' : 'Bạn gửi lúc ') + dayTimeLabel(r.created_at)
      + (r.status === 'pending' && admin ? '. Chấp nhận là một ca hôm đó được thêm vào lịch, như bấm Thêm ca làm việc.' : '')
      + (r.status !== 'pending' && r.reviewed_at ? '. ' + (STATUS_WORDS[r.status] || r.status) + ' lúc ' + dayTimeLabel(r.reviewed_at) + (r.reviewed_by ? ' bởi ' + r.reviewed_by : '') : '');
    setStatus(r.status);
    $('srAvatar').textContent = initials(r.teacher_name, r.teacher_email);
    $('srName').textContent = r.teacher_name || r.teacher_email.split('@')[0];
    $('srEmail').textContent = r.teacher_email;
    $('srDate').textContent = dateLabel(r.work_date, today);
    $('srDept').innerHTML = deptBadge(r.department);
    $('srTime').textContent = r.start_time + ' → ' + r.end_time + (durText(r.start_time, r.end_time) ? ' · ' + durText(r.start_time, r.end_time) : '');
    paintBar(r, out.shifts_that_day || []);
    if (r.note) { $('srNote').textContent = r.note; $('srNoteFact').hidden = false; } else { $('srNoteFact').hidden = true; }

    const checks = [];
    if (admin) {
      const shifts = out.shifts_that_day || [];
      if (!shifts.length) checks.push('<div class="sr-check ok"><i class="fa-solid fa-check" aria-hidden="true"></i>Ngày đó giáo viên này chưa có ca nào trên lịch, không trùng ca.</div>');
      else checks.push('<div class="sr-check warn"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>Ngày đó giáo viên đã có ' + shifts.length + ' ca: ' + shifts.map((x) => esc(x.start) + '–' + esc(x.end) + (x.department ? ' ' + esc(x.department) : '')).join(', ') + '. Nếu trùng giờ, hệ thống sẽ báo khi bạn chấp nhận.</div>');
      const room = out.room || {};
      if (room.found === true) checks.push('<div class="sr-check ok"><i class="fa-solid fa-check" aria-hidden="true"></i>Phòng Tiếp HV trên watch.tansinh.info: <b>' + esc(room.room) + '</b>. Link meeting sẽ được gắn như ca thường.</div>');
      else if (room.found === false) checks.push('<div class="sr-check warn"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>Chưa có phòng Tiếp HV trên watch cho giáo viên này. Ca vẫn được tạo, nhưng không có link meeting (có thể sửa sau trên lịch).</div>');
      else checks.push('<div class="sr-check warn"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>Không kiểm tra được phòng trên watch' + (room.error ? ': ' + esc(room.error) : '') + '. Ca vẫn được tạo, không có link meeting.</div>');
      if (r.work_date !== today) checks.push('<div class="sr-check warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>Yêu cầu này là cho ngày <b>' + esc(dateLabel(r.work_date, today)) + '</b>, không phải hôm nay.</div>');
    }
    $('srChecks').innerHTML = checks.join('');
    $('srDeclineBox').hidden = true; $('srConflictBox').hidden = true; $('srOutcome').hidden = true; $('srReason').value = '';

    if (admin && r.status === 'pending') show('vReq', ['btnList', 'btnDecline', 'btnApprove']);
    else show('vReq', ['btnList', 'btnRoster']);
    if (!admin) $('btnList').hidden = true;
  }

  function paintList(out) {
    const today = out.today;
    const row = (r) => '<a class="sr-row" href="duyet.html?yc=' + encodeURIComponent(r.id) + '">'
      + '<div class="wl-avatar" aria-hidden="true" style="width:34px;height:34px;font-size:13px">' + esc(initials(r.teacher_name, r.teacher_email)) + '</div>'
      + '<div class="sr-row-main"><div class="sr-row-name">' + esc(r.teacher_name || r.teacher_email) + '</div>'
      + '<div class="sr-row-meta">' + esc(dateLabel(r.work_date, today)) + ' · <b>' + esc(r.start_time) + '–' + esc(r.end_time) + '</b>' + (r.department ? ' · ' + esc(r.department) : '') + ' · gửi ' + esc(dayTimeLabel(r.created_at)) + '</div></div>'
      + '<span class="sr-status ' + esc(r.status) + '"><i aria-hidden="true"></i>' + esc(STATUS_WORDS[r.status] || r.status) + '</span>'
      + '</a>';
    const p = out.pending || [], rc = out.recent || [];
    $('srPending').innerHTML = p.length ? p.map(row).join('') : '<div class="sr-empty">Không có yêu cầu nào đang chờ.</div>';
    $('srRecent').innerHTML = rc.length ? rc.map(row).join('') : '<div class="sr-empty">Chưa có.</div>';
    $('srTitle').textContent = 'Yêu cầu mở lịch';
    $('srSub').textContent = 'Giáo viên gửi từ realtimereport khi lịch hôm đó chưa có ca của họ. Bấm một dòng để xem và duyệt.';
    setStatus('');
    show('vList', ['btnRoster']);
  }

  // ---- data --------------------------------------------------------------------
  async function load() {
    show('vLoading', []);
    try {
      if (st.id) paintRequest(await api('/sr-get?id=' + encodeURIComponent(st.id)));
      else paintList(await api('/sr-pending'));
    } catch (e) {
      if (e && e.status === 401) { showLogin(''); return; }
      if (e && e.status === 403) { showError(st.id ? 'Yêu cầu này không phải của bạn, và chỉ Super Admin duyệt được.' : 'Trang này dành cho Super Admin.')   /* tansinh sr-superonly v1 */; return; }
      showError((e && e.error) || 'Không tải được.');
    }
  }
  function setBusy(b) { st.busy = b; BUTTONS.forEach((id) => { $(id).disabled = b; }); }

  async function review(action, extra) {
    if (st.busy || !st.id) return;
    setBusy(true); msg(action === 'approve' ? 'Đang tạo ca…' : 'Đang gửi…');
    try {
      const body = Object.assign({ id: st.id, action }, extra || {});
      const out = await api('/sr-review', { method: 'POST', body });
      if (out && out.overlap) {
        msg('');
        $('srConflicts').innerHTML = (out.conflicts || []).map((c) => '<div class="sr-conflict"><b>' + esc(c.startTime || '') + ' – ' + esc(c.endTime || '') + '</b>'
          + (c.date ? ' · ' + esc(c.date) : '') + (c.department ? ' · ' + esc(c.department) : '') + (c.isRecurring ? ' · lặp hàng tuần' : ' · một lần')
          + (c.conflictType === 'adjacent' ? ' · <i>sát giờ</i>' : ' · <i>trùng giờ</i>') + '</div>').join('');
        $('srConflictBox').hidden = false;
        show('vReq', ['btnForceBack', 'btnForceGo']);
        return;
      }
      if (action === 'approve') {
        msg('Đã tạo ca.', 'success');
        $('srOutcome').innerHTML = '<div class="sr-notice ok"><span class="sr-ico"><i class="fa-solid fa-calendar-check" aria-hidden="true"></i></span>'
          + '<div><b>Đã tạo ca</b><span>Ca đã có trên lịch với nhãn Yêu cầu. realtimereport của giáo viên mở lại trong vòng 1 phút.'
          + (out.meeting_link ? ' Link meeting: ' + esc(out.meeting_link) : ' Ca này không có link meeting.') + (out.warning ? ' ' + esc(out.warning) : '') + '</span></div></div>';
        $('srOutcome').hidden = false; $('srConflictBox').hidden = true; $('srDeclineBox').hidden = true;
        if (out.request) { setStatus(out.request.status); }
        show('vReq', ['btnList', 'btnRoster']);
      } else {
        msg('Đã từ chối.', 'success');
        if (out.request) paintRequest(Object.assign({}, st.data, { request: out.request }));
      }
    } catch (e) {
      msg((e && e.error) || 'Thất bại.', 'error');
      if (e && e.status === 409 && e.out && e.out.request) paintRequest(Object.assign({}, st.data, { request: e.out.request }));
      else if (e && e.status === 401) showLogin('Phiên đăng nhập đã hết. Đăng nhập lại.');
      else show('vReq', ['btnList', 'btnDecline', 'btnApprove']);
    } finally { setBusy(false); }
  }

  async function doLogin() {
    const email = $('email').value.trim(), password = $('password').value;
    const m = $('loginMsg');
    if (!email || !password) { m.textContent = 'Nhập email và mật khẩu.'; m.className = 'error'; return; }
    m.textContent = 'Đang đăng nhập…'; m.className = '';
    try {
      const { error } = await st.client.auth.signInWithPassword({ email, password });
      if (error) { m.textContent = 'Đăng nhập thất bại: ' + error.message; m.className = 'error'; return; }
      m.textContent = '';
      await load();
    } catch (e) { m.textContent = 'Đăng nhập thất bại.'; m.className = 'error'; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    st.id = String(new URLSearchParams(location.search).get('yc') || '').trim();
    $('btnApprove').addEventListener('click', () => review('approve'));
    $('btnForceGo').addEventListener('click', () => review('approve', { force: true }));
    $('btnForceBack').addEventListener('click', () => { $('srConflictBox').hidden = true; show('vReq', ['btnList', 'btnDecline', 'btnApprove']); });
    $('btnDecline').addEventListener('click', () => { $('srDeclineBox').hidden = false; show('vReq', ['btnDeclineBack', 'btnDeclineGo']); try { $('srReason').focus(); } catch (e) { /* fine */ } });
    $('btnDeclineBack').addEventListener('click', () => { $('srDeclineBox').hidden = true; show('vReq', ['btnList', 'btnDecline', 'btnApprove']); });
    $('btnDeclineGo').addEventListener('click', () => review('decline', { note: $('srReason').value.trim() }));
    $('login').addEventListener('click', doLogin);
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('togglePwd').addEventListener('click', () => { const p = $('password'); p.type = p.type === 'password' ? 'text' : 'password'; });
    try { await initClient(); } catch (e) { $('srCard').hidden = false; showError('Không tải được cấu hình đăng nhập. Thử lại sau.'); return; }
    if (!(await token())) { showLogin(''); return; }
    await load();
  });
})();
