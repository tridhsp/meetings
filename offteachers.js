// offteachers.js - Off Teachers page
const _DO = '/api';

let client;
let appStarted = false;

document.addEventListener('DOMContentLoaded', async () => {
  const msgEl = document.getElementById('message');

  try {
    const r = await fetch(_DO + '/supabase-credentials');
    if (!r.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await r.json();

    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
    });

    const { data: { session } } = await client.auth.getSession();
    if (session) {
      showApp();
    } else {
      showLogin();
    }

    client.auth.onAuthStateChange((event, sessionNow) => {
      if (event === 'SIGNED_OUT') {
        appStarted = false;
        showLogin();
        return;
      }
      if (event === 'SIGNED_IN' && sessionNow?.user) {
        showApp();
      }
    });

    setupPasswordToggle();
    setupLoginHandler();

  } catch (e) {
    console.error(e);
    if (msgEl) msgEl.textContent = 'Không thể kết nối. Vui lòng thử lại sau.';
    showLogin();
  }
});

function showLogin() {
  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'block';
  document.body.classList.remove('app');
  const main = document.getElementById('mainContent');
  if (main) main.style.display = 'none';
  const email = document.getElementById('email');
  if (email) email.focus();
}

async function showApp() {
  if (appStarted) return;
  appStarted = true;

  // Check role - only Admin and Super Admin allowed
  try {
    const { data: { user } } = await client.auth.getUser();
    const userEmail = (user?.email || '').toLowerCase();
    const { data: roleRows } = await client
      .from('user_roles')
      .select('role')
      .eq('email', userEmail)
      .limit(1);
    const userRole = roleRows?.[0]?.role || '';
    if (!['Admin', 'Super Admin'].includes(userRole)) {
      appStarted = false;
      const msgEl = document.getElementById('message');
      if (msgEl) {
        msgEl.textContent = 'Bạn không có quyền truy cập trang này. Chỉ Admin mới được phép.';
        msgEl.className = 'error';
      }
      showLogin();
      return;
    }
  } catch (e) {
    console.error('Role check failed:', e);
    appStarted = false;
    showLogin();
    return;
  }

  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'none';
  document.body.classList.add('app');
  const main = document.getElementById('mainContent');
  if (main) main.style.display = 'block';

  await loadQueue();   // tansinh offq v1: one loader, one list
}

function setupPasswordToggle() {
  const toggle = document.getElementById('togglePwd');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    if (!pwd) return;
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
    toggle.textContent = pwd.type === 'password' ? '👁️' : '🙈';
  });
}

function setupLoginHandler() {
  const btn = document.getElementById('login');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const emailEl = document.getElementById('email');
    const pwdEl = document.getElementById('password');
    const msgEl = document.getElementById('message');
    const email = emailEl?.value?.trim();
    const pwd = pwdEl?.value;
    if (!email || !pwd) { if (msgEl) msgEl.textContent = 'Vui lòng nhập email và mật khẩu.'; return; }
    btn.disabled = true;
    btn.textContent = 'Đang đăng nhập…';
    if (msgEl) msgEl.textContent = '';

    try {
      const { error } = await client.auth.signInWithPassword({ email, password: pwd });
      if (error) throw error;
    } catch (e) {
      if (msgEl) msgEl.textContent = e.message || 'Đăng nhập thất bại.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Đăng nhập';
    }
  });
}

// ========== HELPERS ==========

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function initials(nameOrEmail) {
  const src = (nameOrEmail || '').trim();
  if (!src) return 'T';
  const parts = src.split(/\s+/);
  const a = (parts[0] || src)[0] || '';
  const b = (parts[1] || '')[0] || '';
  return (a + b).toUpperCase();
}

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function getMonday(d) {
  const result = new Date(d);
  const dow = result.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  result.setDate(result.getDate() + offset);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const dayLabels = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

// ========== LOAD DATA ==========

// ========== OFF-TEACHER WORK QUEUE v1 (10 Oct 2026) ==========
// One data layer and one renderer. These replace loadOffTeachers/buildSection,
// loadUnmatchedStudents and loadUpcomingImpacted — three columns that told the
// same story three times. Everything below reads OQ and redraws from it.
//
//   OQ.items    every uncovered student session we know about: this week
//               (unmatched-students, keyed by weekday -> real dates) plus
//               tomorrow .. +14 days (upcoming-impacted-students, by date).
//               Where the two overlap, the date-exact row wins.
//   OQ.offRows  meeting_offdays from -8 weeks to +3 weeks: the "cause" lines
//               and the archive.
//   existingSubstitutes  (below) now covers the SAME range, so a past day
//               that was covered shows as covered. The old code fetched from
//               today only, so every past row read "Chưa có GV tạm".

const OQ = {
  todayStr: '', monday: null, sunday: null, from: '', to: '', archFrom: '', farTo: '',
  offRows: [], nameMap: {}, impact: {}, items: [],
  view: 'day', filter: 'open', search: '', loaded: false, collapsed: new Set()
};
const OQ_DOW_LONG = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const OQ_DOW_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const OQ_CAL_URL = 'https://calendar.tansinh.info/';

function oqFmtDM(ymd) { return ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : ''; }
function oqFmtDMY(ymd) { return ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : ''; }
function oqDow(ymd) { return new Date(ymd + 'T00:00:00').getDay(); }
function oqNorm(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
function oqName(email) { return OQ.nameMap[email] || email; }
function oqSubFor(it) { return getSubstituteForStudent(it.studentEmail, it.date, it.role); }
function oqReasonHtml(reason) {
  return reason === 'nghỉ' ? '<span class="r-off">nghỉ</span>' : '<span class="r-noshift" title="GV không có ca vào thứ này, lặp lại mỗi tuần">không có ca</span>';
}
function oqWindowItems() { return OQ.items.filter(it => it.date >= OQ.from && it.date <= OQ.to); }

async function loadQueue() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { oqShowError('Vui lòng đăng nhập lại.'); return; }
  const headers = { 'Authorization': `Bearer ${session.access_token}` };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  OQ.todayStr = formatYMD(today);
  OQ.monday = getMonday(today);
  OQ.sunday = addDays(OQ.monday, 6);
  OQ.from = OQ.todayStr;
  OQ.to = formatYMD(addDays(today, 14));
  OQ.archFrom = formatYMD(addDays(OQ.monday, -56));
  OQ.farTo = formatYMD(addDays(OQ.sunday, 21));

  oqWireOnce();
  oqRenderLoading();

  try {
    const [offRes, unm, upc] = await Promise.all([
      client.from('meeting_offdays')
        .select('teacher_email, off_date, start_time, end_time')
        .gte('off_date', OQ.archFrom).lte('off_date', OQ.farTo)
        .order('off_date', { ascending: true }),
      fetch(_DO + '/unmatched-students', { headers }).then(r => r.json()),
      fetch(_DO + '/upcoming-impacted-students', { headers }).then(r => r.json()),
      loadExistingSubstitutes(OQ.archFrom, OQ.farTo)
    ]);
    if (offRes.error) throw offRes.error;
    if (!unm || !unm.ok) throw new Error((unm && unm.error) || 'Không đọc được HV thiếu GV tuần này');
    if (!upc || !upc.ok) throw new Error((upc && upc.error) || 'Không đọc được HV bị ảnh hưởng 2 tuần tới');

    OQ.offRows = (offRes.data || [])
      .map(r => ({ ...r, teacher_email: (r.teacher_email || '').toLowerCase() }))
      .filter(r => r.teacher_email && r.off_date);
    OQ.items = oqBuildItems(unm.data || {}, upc.data || []);

    // Teacher names: free from the items, then ONE parallel round for the rest
    // (the old code ran one query per teacher, one after another).
    OQ.nameMap = {};
    for (const it of OQ.items) {
      if (it.teacherEmail && it.teacherName && it.teacherName !== it.teacherEmail) OQ.nameMap[it.teacherEmail] = it.teacherName;
    }
    const offEmails = [...new Set(OQ.offRows.map(r => r.teacher_email))];
    const missing = offEmails.filter(e => !OQ.nameMap[e]);
    if (missing.length) {
      const found = await Promise.all(missing.map(e =>
        client.from('meeting_content').select('teacher_name').ilike('teacher_email', e)
          .not('teacher_name', 'is', null).limit(1)
          .then(r => ({ e, name: r.data && r.data[0] && r.data[0].teacher_name }), () => ({ e, name: null }))
      ));
      for (const f of found) if (f.name) OQ.nameMap[f.e] = f.name;
    }

    // Weekday-based impact: used for the archive and for days past the 14-day window.
    OQ.impact = {};
    if (offEmails.length) {
      try {
        const r = await fetch(_DO + '/impacted-students', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ teacherEmails: offEmails })
        }).then(r => r.json());
        if (r && r.ok && r.data) OQ.impact = r.data;
      } catch (e) { console.warn('[offq] impacted-students:', e); }
    }

    OQ.loaded = true;
    oqRenderAll();
  } catch (e) {
    console.error('[offq] load', e);
    oqShowError(e.message || String(e));
  }
}

function oqBuildItems(unm, upc) {
  const map = new Map();
  const put = (dateStr, s, override) => {
    if (!dateStr || !s) return;
    const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
    const email = (s.student_email || '').toLowerCase();
    const key = `${dateStr}|${email}|${role}`;
    if (map.has(key) && !override) return;
    map.set(key, {
      key, date: dateStr, dow: oqDow(dateStr), time: (s.time_local || '').slice(0, 5),
      studentEmail: s.student_email, studentName: s.student_name || s.student_email || '?', role,
      teacherEmail: (s.teacher_email || '').toLowerCase(), teacherName: s.teacher_name || s.teacher_email || '?',
      reason: s.reason === 'nghỉ' ? 'nghỉ' : 'không có ca',
      minutes: s.student_minutes || 0, level: s.student_level || ''
    });
  };
  for (const dow in unm) {
    const n = Number(dow);
    if (Number.isNaN(n)) continue;
    const dateStr = formatYMD(addDays(OQ.monday, n === 0 ? 6 : n - 1));
    for (const s of (unm[dow] || [])) put(dateStr, s, false);
  }
  for (const day of upc) for (const s of (day.students || [])) put(day.date, s, true);
  return [...map.values()];
}

function oqMatches(it) {
  const sub = oqSubFor(it);
  if (OQ.filter === 'open' && sub) return false;
  if (OQ.filter === 'done' && !sub) return false;
  if (OQ.filter === 'off' && it.reason !== 'nghỉ') return false;
  if (OQ.filter === 'noshift' && it.reason === 'nghỉ') return false;
  if (OQ.search) {
    const q = oqNorm(OQ.search);
    if (!oqNorm(it.studentName).includes(q) && !oqNorm(it.teacherName).includes(q)) return false;
  }
  return true;
}

function oqPickerInfo(it) {
  return {
    studentEmail: it.studentEmail, studentName: it.studentName,
    originalTeacherEmail: it.teacherEmail, originalTeacherName: it.teacherName,
    reason: it.reason, dateYMD: it.date,
    dateLabel: `${OQ_DOW_LONG[it.dow]} ${oqFmtDM(it.date)}`, dayOfWeek: it.dow,
    timeLocal: it.time, studentMinutes: it.minutes, studentLevel: it.level, role: it.role
  };
}

let oqWired = false;
function oqWireOnce() {
  if (oqWired) return;
  oqWired = true;
  document.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-oq-pick]');
    if (pick) {
      const it = OQ.items.find(x => x.key === pick.getAttribute('data-oq-pick'));
      if (it) openSubPicker(oqPickerInfo(it));
      return;
    }
    const seg = e.target.closest('.oq-seg-btn');
    if (seg) { OQ.view = seg.dataset.view === 'teacher' ? 'teacher' : 'day'; oqRenderAll(); return; }
    const chip = e.target.closest('.oq-chip');
    if (chip) { OQ.filter = chip.dataset.filter || 'all'; oqRenderAll(); return; }
    const head = e.target.closest('.oq-day-head');
    if (head) {
      const box = head.closest('[data-oq-id]');
      if (box) {
        box.classList.toggle('is-collapsed');
        if (box.classList.contains('is-collapsed')) OQ.collapsed.add(box.dataset.oqId); else OQ.collapsed.delete(box.dataset.oqId);
      }
      return;
    }
    const ph = e.target.closest('.oq-past-head');
    if (ph) { ph.closest('.oq-past-sec')?.classList.toggle('is-collapsed'); }
  });
  const inp = document.getElementById('oqSearch');
  if (inp) {
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { OQ.search = inp.value.trim(); oqRenderQueue(); }, 150);
    });
  }
}

// ---------- rendering ----------

function oqRenderAll() { oqRenderSummary(); oqRenderChips(); oqRenderQueue(); oqRenderPast(); }

function oqRenderLoading() {
  const q = document.getElementById('oqQueue');
  if (q) q.innerHTML = '<div class="ot-loading"><i class="fa-solid fa-spinner"></i><span>Đang tải dữ liệu...</span></div>';
  oqRenderSummary();
  oqRenderChips();
}

function oqShowError(msg) {
  const q = document.getElementById('oqQueue');
  if (q) q.innerHTML = `<div class="ot-loading"><span>Lỗi: ${esc(msg)}</span></div>`;
}

function oqRenderSummary() {
  const el = document.getElementById('oqSummary');
  if (!el) return;
  if (!OQ.loaded) { el.innerHTML = '<div class="oq-stat"><b>…</b><span>Đang tải</span></div>'; return; }
  const win = oqWindowItems();
  const open = win.filter(it => !oqSubFor(it)).length;
  const done = win.length - open;
  const offT = new Set(OQ.offRows.filter(r => r.off_date >= OQ.from && r.off_date <= OQ.to).map(r => r.teacher_email)).size;
  const noshift = new Set(win.filter(it => it.reason !== 'nghỉ').map(it => `${it.studentEmail}|${it.dow}|${it.role}`)).size;
  el.innerHTML = `
    <div class="oq-stat ${open ? 'is-open' : 'is-done'}"><b>${open}</b><span>buổi chưa có GV tạm</span></div>
    <div class="oq-stat is-done"><b>${done}</b><span>buổi đã gán GV tạm</span></div>
    <div class="oq-stat"><b>${offT}</b><span>GV nghỉ, hôm nay → ${oqFmtDM(OQ.to)}</span></div>
    <div class="oq-stat ${noshift ? 'is-warn' : ''}"><b>${noshift}</b><span>lịch không có ca cố định</span></div>`;
}

function oqRenderChips() {
  const el = document.getElementById('oqChips');
  if (!el) return;
  const win = OQ.loaded ? oqWindowItems() : [];
  const c = {
    all: win.length,
    open: win.filter(it => !oqSubFor(it)).length,
    done: win.filter(it => !!oqSubFor(it)).length,
    off: win.filter(it => it.reason === 'nghỉ').length,
    noshift: win.filter(it => it.reason !== 'nghỉ').length
  };
  const defs = [['all', 'Tất cả'], ['open', 'Chưa gán'], ['done', 'Đã gán'], ['off', 'GV nghỉ'], ['noshift', 'Không có ca']];
  el.innerHTML = defs.map(([k, label]) =>
    `<button type="button" class="oq-chip c-${k}${OQ.filter === k ? ' is-on' : ''}" data-filter="${k}">${label}<small>${OQ.loaded ? c[k] : ''}</small></button>`
  ).join('');
}

function oqRenderQueue() {
  const el = document.getElementById('oqQueue');
  if (!el || !OQ.loaded) return;
  el.innerHTML = OQ.view === 'teacher' ? oqHtmlByTeacher() : oqHtmlByDay();
}

function oqHtmlEmpty() {
  const filtered = OQ.filter !== 'all' || !!OQ.search;
  let text;
  if (OQ.search) text = 'Không có buổi nào khớp với từ tìm kiếm.';
  else if (OQ.filter === 'open') text = `Tất cả buổi từ hôm nay đến ${oqFmtDM(OQ.to)} đã có GV tạm.`;
  else if (filtered) text = 'Không có buổi nào khớp bộ lọc này.';
  else text = `Không có HV nào thiếu GV từ hôm nay đến ${oqFmtDM(OQ.to)}.`;
  return `<div class="oq-empty"><i class="fa-solid fa-circle-check"></i>${text}</div>`;
}

function oqHtmlByDay() {
  const items = oqWindowItems();
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const offByDate = new Map();
  for (const r of OQ.offRows) {
    if (r.off_date < OQ.from || r.off_date > OQ.farTo) continue;
    if (!offByDate.has(r.off_date)) offByDate.set(r.off_date, []);
    offByDate.get(r.off_date).push(r);
  }
  const dates = [...new Set([...byDate.keys(), ...offByDate.keys()])].sort();
  const searching = !!OQ.search;
  const out = [];
  for (const date of dates) {
    const all = byDate.get(date) || [];
    const shown = all.filter(oqMatches);
    const offs = offByDate.get(date) || [];
    if (searching && !shown.length) continue;
    if (all.length && !shown.length && OQ.filter !== 'open') continue;
    if (!all.length && !['all', 'open', 'off'].includes(OQ.filter)) continue;
    out.push(oqHtmlDay(date, all, shown, offs, 'live'));
  }
  return out.length ? out.join('') : oqHtmlEmpty();
}

// mode: 'live' (today onward), 'past' (this week, before today), 'archive' (older, off-days only)
function oqHtmlDay(date, all, shown, offs, mode) {
  const dow = oqDow(date);
  const isToday = date === OQ.todayStr;
  const beyond = date > OQ.to;
  const open = all.filter(it => !oqSubFor(it)).length;
  const collapsed = OQ.collapsed.has(date) ? ' is-collapsed' : '';

  let meta = '';
  if (all.length) meta = open ? `${all.length} buổi · <b>${open} chưa gán</b>` : `${all.length} buổi · đã gán đủ`;
  else if (beyond) meta = 'ngoài 14 ngày';
  else if (mode === 'archive') meta = `${new Set(offs.map(r => r.teacher_email)).size} GV nghỉ`;
  else if (offs.length) meta = 'không có HV học';

  const offByT = new Map();
  for (const r of offs) {
    if (!offByT.has(r.teacher_email)) offByT.set(r.teacher_email, []);
    const t = `${(r.start_time || '').slice(0, 5)}–${(r.end_time || '').slice(0, 5)}`;
    if (!offByT.get(r.teacher_email).includes(t)) offByT.get(r.teacher_email).push(t);
  }
  const noshiftT = new Map();
  for (const it of all) {
    if (it.reason === 'nghỉ') continue;
    if (!noshiftT.has(it.teacherEmail)) noshiftT.set(it.teacherEmail, { name: it.teacherName, n: 0 });
    noshiftT.get(it.teacherEmail).n++;
  }

  let causes = '';
  for (const [email, times] of offByT) {
    const name = oqName(email);
    const nHere = all.filter(it => it.teacherEmail === email).length;
    const forecast = (OQ.impact[`${email}|${dow}`] || []).length;
    let count;
    if (nHere) count = `${nHere} HV`;
    else if ((beyond || mode === 'archive') && forecast) count = `${forecast} HV theo lịch tuần`;
    else if (beyond || mode === 'archive') count = '';
    else count = 'không có HV';
    causes += `<div class="oq-cause"><span class="oq-cause-av">${esc(initials(name))}</span><span><b>${esc(name)}</b> nghỉ ${esc(times.join(', '))}</span><span class="oq-cause-right">${count ? `<i class="fa-solid fa-user-graduate"></i> ${count}` : ''}</span></div>`;
  }
  for (const [, v] of noshiftT) {
    causes += `<div class="oq-cause is-noshift"><span class="oq-cause-av">${esc(initials(v.name))}</span><span><b>${esc(v.name)}</b> không có ca ${OQ_DOW_LONG[dow].toLowerCase()} · lặp lại mỗi tuần · ${v.n} HV</span><span class="oq-cause-right"><a href="${OQ_CAL_URL}" target="_blank" rel="noopener"><i class="fa-solid fa-calendar-check"></i> Sửa lịch</a></span></div>`;
  }

  let body = '';
  if (shown.length) body = `<div class="oq-rows">${oqHtmlRows(shown, false, mode === 'past')}</div>`;
  else if (all.length) body = `<div class="oq-day-note"><i class="fa-solid fa-circle-check" style="color:#22c55e"></i> ${all.length} buổi đã gán đủ GV tạm.</div>`;
  else if (beyond) body = '<div class="oq-day-note">Danh sách HV cụ thể sẽ hiện khi còn 14 ngày.</div>';
  else if (mode === 'archive') body = '';
  else body = '<div class="oq-day-note">Không có HV nào học trong ngày này.</div>';

  return `<section class="oq-day${isToday ? ' is-today' : ''}${collapsed}" data-oq-id="${date}">
    <header class="oq-day-head">
      <span class="oq-day-dow">${OQ_DOW_LONG[dow]}</span><span class="oq-day-date">${oqFmtDM(date)}</span>${isToday ? '<span class="oq-tag">hôm nay</span>' : ''}
      <span class="oq-day-meta">${meta}</span><i class="fa-solid fa-chevron-down oq-day-chev"></i>
    </header>
    ${causes}${body}
  </section>`;
}

function oqHtmlRows(items, withDate, isPast) {
  const byStudent = new Map();
  for (const it of items) {
    const k = `${it.date}|${it.studentEmail}`;
    if (!byStudent.has(k)) byStudent.set(k, []);
    byStudent.get(k).push(it);
  }
  const order = { open: 0, partial: 1, done: 2 };
  const groups = [...byStudent.values()].map(g => {
    g.sort((a, b) => (a.role === 'TTKB' ? 0 : 1) - (b.role === 'TTKB' ? 0 : 1));
    const nd = g.filter(it => !!oqSubFor(it)).length;
    const time = g.reduce((m, it) => (it.time && (!m || it.time < m)) ? it.time : m, '');
    return { g, time, state: nd === g.length ? 'done' : (nd ? 'partial' : 'open') };
  });
  groups.sort((a, b) => (order[a.state] - order[b.state]) || a.g[0].date.localeCompare(b.g[0].date) || a.time.localeCompare(b.time));

  return groups.map(({ g, time, state }) => {
    const f = g[0];
    const pills = g.map(it => `<span class="oq-pill ${it.role === 'Breakout' ? 'br' : 'ttkb'}">${it.role}</span>`).join('');
    const teachers = [...new Set(g.map(it => it.teacherName))].map(esc).join(', ');
    const when = withDate ? `${OQ_DOW_SHORT[f.dow]} ${oqFmtDM(f.date)}<br>${esc(time)}` : esc(time);
    let act = '';
    if (g.length === 1) {
      const sub = oqSubFor(f);
      act = sub
        ? `<span class="oq-done"><i class="fa-solid fa-circle-check"></i> GV tạm: ${esc(sub.substitute_teacher_name || sub.substitute_teacher_email)}</span><button type="button" class="oq-link" data-oq-pick="${f.key}">Đổi</button>`
        : `<button type="button" class="oq-btn${isPast ? '' : ' primary'}" data-oq-pick="${f.key}"><i class="fa-solid fa-user-plus"></i> ${isPast ? 'Ghi nhận GV tạm' : 'Gán GV tạm'}</button>`;
    } else {
      act = g.map(it => {
        const sub = oqSubFor(it);
        return sub
          ? `<button type="button" class="oq-rolectl done" data-oq-pick="${it.key}" title="Đổi GV tạm"><i class="fa-solid fa-check"></i> ${it.role}: ${esc((sub.substitute_teacher_name || sub.substitute_teacher_email || '').split(' ').pop())}</button>`
          : `<button type="button" class="oq-rolectl open" data-oq-pick="${it.key}"><i class="fa-solid fa-user-plus"></i> ${it.role}: ${isPast ? 'Ghi nhận' : 'Gán'}</button>`;
      }).join('');
    }
    return `<div class="oq-row is-${state}">
      <span class="oq-time">${when}</span>
      <div class="oq-main"><div class="oq-name">${esc(f.studentName)}${pills}</div><div class="oq-subline">GV: ${teachers} · ${oqReasonHtml(f.reason)}</div></div>
      <div class="oq-act">${act}</div>
    </div>`;
  }).join('');
}

function oqHtmlByTeacher() {
  const items = oqWindowItems().filter(oqMatches);
  if (!items.length) return oqHtmlEmpty();
  const byT = new Map();
  for (const it of items) { if (!byT.has(it.teacherEmail)) byT.set(it.teacherEmail, []); byT.get(it.teacherEmail).push(it); }
  const cards = [...byT.entries()].map(([email, g]) => {
    const name = g[0].teacherName;
    const open = g.filter(it => !oqSubFor(it)).length;
    const offDates = [...new Set(OQ.offRows.filter(r => r.teacher_email === email && r.off_date >= OQ.from && r.off_date <= OQ.to).map(r => r.off_date))].map(oqFmtDM);
    const nsDows = [...new Set(g.filter(it => it.reason !== 'nghỉ').map(it => it.dow))].map(d => OQ_DOW_LONG[d].toLowerCase());
    const bits = [];
    if (offDates.length) bits.push('nghỉ ' + offDates.join(', '));
    if (nsDows.length) bits.push('không có ca ' + nsDows.join(', ') + ' (lặp lại mỗi tuần)');
    const id = 't:' + email;
    const html = `<section class="oq-teacher${OQ.collapsed.has(id) ? ' is-collapsed' : ''}" data-oq-id="${esc(id)}">
      <header class="oq-day-head oq-teacher-head">
        <span class="oq-teacher-av">${esc(initials(name))}</span>
        <div style="flex:1;min-width:0"><div class="oq-teacher-name">${esc(name)}</div><div class="oq-teacher-sub">${esc(bits.join(' · '))}</div></div>
        <span class="oq-day-meta">${g.length} buổi · ${open ? `<b>${open} chưa gán</b>` : 'đã gán đủ'}</span><i class="fa-solid fa-chevron-down oq-day-chev"></i>
      </header>
      <div class="oq-rows">${oqHtmlRows(g, true, false)}</div>
    </section>`;
    return { open, n: g.length, html };
  });
  cards.sort((a, b) => (b.open - a.open) || (b.n - a.n));
  return cards.map(c => c.html).join('');
}

function oqRenderPast() {
  const el = document.getElementById('oqPast');
  if (!el || !OQ.loaded) return;
  const mondayStr = formatYMD(OQ.monday);
  const yesterday = formatYMD(addDays(new Date(OQ.todayStr + 'T00:00:00'), -1));

  // 1. this week, before today — real items, real assignments
  const past = OQ.items.filter(it => it.date < OQ.todayStr);
  const byDate = new Map();
  for (const it of past) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const offWeek = new Map();
  for (const r of OQ.offRows) {
    if (r.off_date < mondayStr || r.off_date >= OQ.todayStr) continue;
    if (!offWeek.has(r.off_date)) offWeek.set(r.off_date, []);
    offWeek.get(r.off_date).push(r);
  }
  const pastDates = [...new Set([...byDate.keys(), ...offWeek.keys()])].sort().reverse();
  const openN = past.filter(it => !oqSubFor(it)).length;
  let sec1 = '';
  if (pastDates.length) {
    sec1 = `<section class="oq-past-sec is-collapsed">
      <div class="oq-past-head"><i class="fa-solid fa-clock-rotate-left"></i><span><b>Đã qua, tuần này</b> · ${oqFmtDM(mondayStr)} – ${oqFmtDM(yesterday)} · ${past.length} buổi${openN ? `, <span style="color:#dc2626;font-weight:700">${openN} không có GV tạm</span>` : ''}</span><i class="fa-solid fa-chevron-down oq-day-chev"></i></div>
      <div class="oq-past-body">${pastDates.map(d => oqHtmlDay(d, byDate.get(d) || [], byDate.get(d) || [], offWeek.get(d) || [], 'past')).join('')}</div>
    </section>`;
  }

  // 2. the 8 weeks before this one — off-days only
  const arch = OQ.offRows.filter(r => r.off_date < mondayStr);
  const archByDate = new Map();
  for (const r of arch) { if (!archByDate.has(r.off_date)) archByDate.set(r.off_date, []); archByDate.get(r.off_date).push(r); }
  const archDates = [...archByDate.keys()].sort().reverse();
  const teachersN = new Set(arch.map(r => r.teacher_email)).size;
  const sec2 = `<section class="oq-past-sec is-collapsed">
    <div class="oq-past-head"><i class="fa-solid fa-box-archive"></i><span><b>8 tuần trước</b> · ${oqFmtDM(OQ.archFrom)} – ${oqFmtDM(formatYMD(addDays(OQ.monday, -1)))} · ${teachersN} GV nghỉ</span><i class="fa-solid fa-chevron-down oq-day-chev"></i></div>
    <div class="oq-past-body">${archDates.length ? archDates.map(d => oqHtmlDay(d, [], [], archByDate.get(d), 'archive')).join('') : '<div class="oq-day-note">Không có GV nghỉ trong 8 tuần trước.</div>'}</div>
  </section>`;

  el.innerHTML = sec1 + sec2;
}

async function oqAfterChange() {
  await loadExistingSubstitutes(OQ.archFrom, OQ.farTo);
  const y = window.scrollY;
  oqRenderAll();
  window.scrollTo(0, y);
}

function oqToast(msg) {
  let t = document.getElementById('oqToast');
  if (!t) { t = document.createElement('div'); t.id = 'oqToast'; t.className = 'oq-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function oqConfirmBar() {
  const body = document.getElementById('subPickerBody');
  if (!body) return null;
  let bar = document.getElementById('oqConfirmBar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'oqConfirmBar'; bar.className = 'oq-confirm'; }
  body.prepend(bar);
  const modal = document.getElementById('subPickerModal');
  if (modal) modal.scrollTop = 0;
  return bar;
}

// ========== TEMPORARY SUBSTITUTE TEACHER FEATURE ==========

let existingSubstitutes = []; // loaded from DB

// tansinh sub-gate (9 Oct 2026, carried into offq v1): the login token for the
// substitute calls. Harmless where the route is still open, required once it
// checks a token.
async function _subAuth() {
  try {
    const { data: { session } } = await client.auth.getSession();
    return session ? { 'Authorization': 'Bearer ' + session.access_token } : {};
  } catch (e) { return {}; }
}

// tansinh offq v1: takes a range. The queue passes -8 weeks .. +3 weeks so
// that past days show their real assignments. Called with no arguments it
// behaves like the old version (today .. +21 days).
async function loadExistingSubstitutes(fromDate, toDate) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = fromDate || formatYMD(today);
    const to = toDate || formatYMD(addDays(today, 21));
    const res = await fetch(`${_DO}/save-temp-substitute?from_date=${from}&to_date=${to}`, { headers: await _subAuth() });
    const out = await res.json();
    if (res.ok && out.ok) {
      existingSubstitutes = out.assignments || [];
    }
  } catch (e) {
    console.warn('Could not load existing substitutes:', e);
  }
}

function getSubstituteForStudent(studentEmail, dateStr, role) {
  if (role) {
    return existingSubstitutes.find(
      s => s.student_email === studentEmail && s.assign_date === dateStr && s.role === role
    ) || null;
  }
  return existingSubstitutes.find(
    s => s.student_email === studentEmail && s.assign_date === dateStr
  ) || null;
}

function openSubPicker(studentInfo) {
  const overlay = document.getElementById('subPickerOverlay');
  const modal = document.getElementById('subPickerModal');
  const body = document.getElementById('subPickerBody');
  const info = document.getElementById('subPickerStudentInfo');

  if (!overlay || !modal) return;

  // Show student info
  const roleBadge = studentInfo.role === 'Breakout'
    ? '<span style="margin-left:4px;padding:1px 6px;border-radius:4px;font-size:0.7rem;font-weight:700;background:#ede9fe;color:#7c3aed;border:1px solid #c4b5fd">Breakout</span>'
    : '<span style="margin-left:4px;padding:1px 6px;border-radius:4px;font-size:0.7rem;font-weight:700;background:#dbeafe;color:#2563eb;border:1px solid #bfdbfe">TTKB</span>';
  info.innerHTML = `
    <strong>${esc(studentInfo.studentName)}</strong>
    — ${esc(studentInfo.dateLabel)}
    — ${studentInfo.timeLocal || ''}
    ${roleBadge}
    <br>GV gốc: <span style="color:#dc2626;">${esc(studentInfo.originalTeacherName)} (${esc(studentInfo.reason)})</span>
  `;

  // Check if already assigned
  const existing = getSubstituteForStudent(studentInfo.studentEmail, studentInfo.dateYMD, studentInfo.role || 'TTKB');   // tansinh offq v1: by role

  body.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải GV đang làm việc...</div>';
  overlay.style.display = 'block';
  modal.style.display = 'block';

  // Close handlers
  overlay.onclick = closeSubPicker;
  document.getElementById('subPickerClose').onclick = closeSubPicker;

  // Fetch working teachers for that date
  fetchAndShowWorkingTeachers(studentInfo, existing);
}

function closeSubPicker() {
  document.getElementById('subPickerOverlay').style.display = 'none';
  document.getElementById('subPickerModal').style.display = 'none';
}

function _fmtMins(m) {
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h${mm > 0 ? mm + 'm' : ''}` : `${mm}m`;
}

function _renderTeacherCard(t, studentInfo, isRecommended, idx) {
  const ini = (t.teacher_name || t.teacher_email || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const shifts = t.shifts.map(s => `${s.start_time}–${s.end_time}`).join(', ');
  const depts = [...new Set((t.shifts || []).map(s => (s.department || '').trim()).filter(Boolean))];
  const deptBadges = depts.map(d => {
    const dl = d.toLowerCase();
    const bg = dl === 'mix' ? '#f5f3ff' : dl === 'breakout' ? '#ecfdf5' : '#eff6ff';
    const color = dl === 'mix' ? '#6d28d9' : dl === 'breakout' ? '#047857' : '#2563eb';
    const border = dl === 'mix' ? '#ddd6fe' : dl === 'breakout' ? '#a7f3d0' : '#bfdbfe';
    return `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:700;background:${bg};color:${color};border:1px solid ${border};margin-left:4px">${esc(d)}</span>`;
  }).join('');

  // Stats badges
  const freeMins = t.freeMins ?? 0;
  const studentCount = t.studentCount ?? 0;
  const freeColor = freeMins > 60 ? '#059669' : freeMins > 20 ? '#d97706' : '#dc2626';
  const freeBg = freeMins > 60 ? '#ecfdf5' : freeMins > 20 ? '#fffbeb' : '#fef2f2';
  const freeBorder = freeMins > 60 ? '#a7f3d0' : freeMins > 20 ? '#fde68a' : '#fecaca';

  const recBadge = isRecommended
    ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:99px;font-size:0.6rem;font-weight:700;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;margin-left:6px;"><i class="fa-solid fa-star" style="font-size:0.5rem;color:#f59e0b;"></i> Phù hợp nhất</span>`
    : '';

  const statsLine = (typeof t.freeMins === 'number')
    ? `<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:6px;font-size:0.65rem;font-weight:600;background:${freeBg};color:${freeColor};border:1px solid ${freeBorder};"><i class="fa-solid fa-hourglass-half" style="font-size:0.5rem;"></i> Trống ${_fmtMins(freeMins)}</span>
        <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:6px;font-size:0.65rem;font-weight:600;background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;"><i class="fa-solid fa-user-graduate" style="font-size:0.5rem;"></i> ${studentCount} HV</span>
      </div>`
    : '';

  // --- Suitability badge ---
  let suitabilityHtml = '';
  if (t.suitability) {
    const suitColors = {
      good:     { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', icon: 'fa-circle-check' },
      ok:       { bg: '#fefce8', border: '#fde68a', text: '#a16207', icon: 'fa-circle-info' },
      overload: { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', icon: 'fa-triangle-exclamation' }
    };
    const sc = suitColors[t.suitability] || suitColors.ok;

    if (t.isTTKB) {
      // TTKB: show free gap info near student's time
      const bestGapText = t.ttkbBestGap
        ? `${t.ttkbBestGap.start} → ${t.ttkbBestGap.end} (${t.ttkbBestGap.duration}m)`
        : 'Không có';
      suitabilityHtml = `
        <div class="sub-card-col-label"><i class="fa-solid ${sc.icon}" style="margin-right:3px;color:${sc.text};"></i> Đánh giá</div>
        <div style="padding:8px 10px;background:${sc.bg};border:1px solid ${sc.border};border-radius:10px;">
          <div style="font-size:0.82rem;font-weight:700;color:${sc.text};margin-bottom:8px;">${esc(t.suitabilityLabel || '')}</div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Trống gần giờ HV:</span>
            <span class="sub-suit-stat-val">${_fmtMins(t.ttkbRelevantFree || 0)}</span>
          </div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Slot gần nhất:</span>
            <span class="sub-suit-stat-val">${bestGapText}</span>
          </div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Tổng trống cả ca:</span>
            <span class="sub-suit-stat-val">${_fmtMins(t.ttkbFreeTotal || 0)}</span>
          </div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Cả ngày:</span>
            <span class="sub-suit-stat-val">${t.studentCount || 0} HV</span>
          </div>
        </div>`;
    } else {
      // Non-TTKB: show overlap counts
      suitabilityHtml = `
        <div class="sub-card-col-label"><i class="fa-solid ${sc.icon}" style="margin-right:3px;color:${sc.text};"></i> Đánh giá</div>
        <div style="padding:8px 10px;background:${sc.bg};border:1px solid ${sc.border};border-radius:10px;">
          <div style="font-size:0.82rem;font-weight:700;color:${sc.text};margin-bottom:8px;">${esc(t.suitabilityLabel || '')}</div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Lúc bắt đầu:</span>
            <span class="sub-suit-stat-val">${t.countAtStart || 0} HV</span>
          </div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Cao điểm:</span>
            <span class="sub-suit-stat-val" style="color:${sc.text};">${t.peakCount || 0} HV</span>
          </div>
          <div class="sub-suit-stat">
            <span style="color:#6b7280;">Cả ngày:</span>
            <span class="sub-suit-stat-val">${t.studentCount || 0} HV</span>
          </div>
        </div>`;
    }
  }

  // --- Timeline bar + segment rows (like calendar app) ---
  let timelineHtml = '';
  if (t.timeline && t.timeline.length > 0) {
    const totalDur = t.timeline.reduce((s, seg) => s + seg.duration, 0) || 1;
    const timelineBarHtml = t.timeline.map(seg => {
      const pct = (seg.duration / totalDur * 100).toFixed(1);
      let segColor;
      if (seg.count === 0) segColor = '#e5e7eb';
      else if (seg.count <= 3) segColor = '#22c55e';
      else if (seg.count <= 6) segColor = '#eab308';
      else segColor = '#ef4444';
      return `<div style="width:${pct}%;height:100%;background:${segColor};" title="${seg.start}–${seg.end}: ${seg.count} HV"></div>`;
    }).join('');

    const segmentRows = t.timeline.map(seg => {
      let countColor;
      if (seg.count === 0) countColor = '#9ca3af';
      else if (seg.count <= 3) countColor = '#15803d';
      else if (seg.count <= 6) countColor = '#a16207';
      else countColor = '#dc2626';
      const studentChips = (seg.students || []).map(s => {
        const roleBadge = s.role === 'TT'
          ? ' <span style="background:#dbeafe;color:#1e40af;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">TT</span>'
          : s.role === 'BR'
          ? ' <span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">BR</span>'
          : '';
        return `<span style="display:inline-flex;align-items:center;gap:3px;background:#f1f5f9;padding:2px 7px;border-radius:99px;font-size:0.68rem;white-space:nowrap;">${esc(s.name)}${roleBadge}${s.buoiPhu ? ' <span style="color:#7c3aed;font-weight:700;font-size:0.6rem;">phụ</span>' : ''}</span>`;
      }).join(' ');
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:0.75rem;">
          <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;min-width:90px;">${esc(seg.start)} → ${esc(seg.end)}</span>
          <span style="font-weight:800;color:${countColor};min-width:20px;text-align:center;">${seg.count}</span>
          <div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;">${studentChips}</div>
        </div>`;
    }).join('');

    timelineHtml = `
      <div style="padding:0;">
        <div class="sub-card-col-label">
          <i class="fa-solid fa-chart-bar" style="margin-right:4px;"></i> Timeline trong giờ học của HV
        </div>
        <div style="display:flex;height:14px;border-radius:99px;overflow:hidden;gap:1px;margin-bottom:10px;">
          ${timelineBarHtml}
        </div>
        <div style="display:flex;gap:10px;font-size:0.65rem;color:#9ca3af;margin-bottom:8px;flex-wrap:wrap;">
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#22c55e;margin-right:3px;"></span>0–3 HV</span>
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#eab308;margin-right:3px;"></span>4–6 HV</span>
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#ef4444;margin-right:3px;"></span>7+ HV</span>
        </div>
        ${segmentRows}
      </div>`;
  }

  // --- Sequential session items (free gaps + students like TTKB view) ---
  let sessionHtml = '';
  if (t.sessionItems && t.sessionItems.length > 0 && (t.isTTKB || !(t.timeline && t.timeline.length > 0))) {
    // Only show session view when there's no overlap timeline (i.e. TTKB-style 1:1)
    const sessionRows = t.sessionItems.map(item => {
      if (item.type === 'free') {
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;margin:2px 0;background:#f0fdf4;border:1px dashed #86efac;border-radius:6px;font-size:0.75rem;">
            <span style="color:#16a34a;font-weight:700;font-size:0.72rem;white-space:nowrap;">
              <i class="fa-solid fa-clock" style="margin-right:3px;"></i>Free ${item.duration}m
            </span>
            <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;margin-left:auto;">
              ${esc(item.start)} → ${esc(item.end)}
            </span>
          </div>`;
      }
      const roleBadge = item.role === 'TT'
        ? ' <span style="background:#dbeafe;color:#1e40af;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">TT</span>'
        : item.role === 'BR'
        ? ' <span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">BR</span>'
        : '';
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:0.75rem;">
          <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;min-width:90px;">
            ${esc(item.time)} → ${esc(item.endTime)}
          </span>
          <div style="flex:1;display:flex;align-items:center;gap:4px;">
            <span style="display:inline-flex;align-items:center;gap:3px;background:#f1f5f9;padding:2px 7px;border-radius:99px;font-size:0.68rem;white-space:nowrap;">
              ${esc(item.name)}${roleBadge}${item.buoiPhu ? ' <span style="color:#7c3aed;font-weight:700;font-size:0.6rem;">phụ</span>' : ''}
            </span>
          </div>
          <span style="font-weight:600;color:#374151;font-size:0.72rem;white-space:nowrap;">${item.duration}m</span>
        </div>`;
    }).join('');

    sessionHtml = `
      <div style="padding:0;">
        <div class="sub-card-col-label">
          <i class="fa-solid fa-${t.isTTKB ? 'list' : 'chart-bar'}" style="margin-right:4px;"></i> ${t.isTTKB ? 'Lịch dạy trong ca (1 HV / lượt)' : 'Timeline trong giờ học của HV'}
        </div>
        ${sessionRows}
      </div>`;
  }

  // If we have timeline data, show both timeline and session
  // If only session items, show session view
  const combinedTimelineHtml = timelineHtml || sessionHtml;

  const assignData = JSON.stringify({
    studentEmail: studentInfo.studentEmail,
    studentName: studentInfo.studentName,
    studentMinutes: studentInfo.studentMinutes || 0,
    studentLevel: studentInfo.studentLevel || '',
    originalTeacherEmail: studentInfo.originalTeacherEmail,
    originalTeacherName: studentInfo.originalTeacherName,
    dateYMD: studentInfo.dateYMD,
    dayOfWeek: studentInfo.dayOfWeek,
    timeLocal: studentInfo.timeLocal || '',
    subEmail: t.teacher_email,
    subName: t.teacher_name || t.teacher_email,
    role: studentInfo.role || 'TTKB'
  }).replace(/"/g, '&quot;');

  return `
    <div class="sub-teacher-item" style="${isRecommended ? 'border-color:#86efac;' : ''}" onclick="assignSubstitute(${assignData})">
      <div class="sub-card-top-row">
        <div class="sub-card-col">
          <div class="sub-card-col-label"><i class="fa-solid fa-chalkboard-user" style="margin-right:3px;"></i> Giáo viên</div>
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="sub-teacher-avatar">${esc(ini)}</div>
            <div style="flex:1;min-width:0;">
              <div class="sub-teacher-name">${esc(t.teacher_name || t.teacher_email)}${recBadge}${t.isTTKB ? ' <span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:4px;font-size:0.6rem;font-weight:700;background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;margin-left:4px;">TTKB 1:1</span>' : ''}</div>
              <div class="sub-teacher-shifts"><i class="fa-regular fa-clock"></i> ${esc(shifts)}${deptBadges}</div>
              ${statsLine}
            </div>
          </div>
        </div>
        <div class="sub-card-col">${suitabilityHtml || '<div class="sub-card-col-label">Đánh giá</div><div style="color:#9ca3af;font-size:0.85rem;">—</div>'}</div>
      </div>
      ${combinedTimelineHtml ? '<div class="sub-card-timeline">' + combinedTimelineHtml + '</div>' : ''}
    </div>`;
}

async function fetchAndShowWorkingTeachers(studentInfo, existing) {
  const body = document.getElementById('subPickerBody');

  try {
    const { data: { session } } = await client.auth.getSession();
    const res = await fetch(_DO + '/get-working-teachers-for-date', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await _subAuth()) },   // tansinh offq v1: same token as the substitute calls
      body: JSON.stringify({
        date: studentInfo.dateYMD,
        student_time: studentInfo.timeLocal || '',
        student_minutes: studentInfo.studentMinutes || 25
      })
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Failed');

    const teachers = out.workingTeachers || [];

    // Filter out the original teacher (who is off)
    const withoutOriginal = teachers.filter(
      t => t.teacher_email !== (studentInfo.originalTeacherEmail || '').toLowerCase()
    );

    // Filter by department based on student's role
    // Breakout student → only Breakout, Supporter, Mix teachers
    // TTKB student → only TTKB, Supporter, Mix teachers
    const studentRole = (studentInfo.role || 'TTKB').toUpperCase();
    let allowedDepts;
    if (studentRole === 'BREAKOUT') {
      allowedDepts = ['breakout', 'supporter', 'mix'];
    } else {
      allowedDepts = ['ttkb', 'supporter', 'mix'];
    }
    const deptMatched = withoutOriginal.filter(t => {
      const teacherDepts = (t.shifts || []).map(s => (s.department || '').toLowerCase());
      return teacherDepts.some(d => allowedDepts.includes(d));
    });

    // Only show teachers whose shift covers the student's learning time
    const studentTime = (studentInfo.timeLocal || '').replace(':', '');
    const studentMin = studentTime ? parseInt(studentTime.slice(0,2)) * 60 + parseInt(studentTime.slice(2,4)) : -1;

    const filtered = studentMin < 0 ? deptMatched : deptMatched.filter(t => {
      return (t.shifts || []).some(s => {
        const sStart = (s.start_time || '').replace(':', '');
        const sEnd = (s.end_time || '').replace(':', '');
        if (!sStart || !sEnd) return false;
        const shiftStartMin = parseInt(sStart.slice(0,2)) * 60 + parseInt(sStart.slice(2,4));
        const shiftEndMin = parseInt(sEnd.slice(0,2)) * 60 + parseInt(sEnd.slice(2,4));
        return studentMin >= shiftStartMin && studentMin < shiftEndMin;
      });
    });

    // Sort by suitability first, then by free time
    filtered.sort((a, b) => {
      if (a.suitability && b.suitability) {
        const suitOrder = { good: 0, ok: 1, overload: 2 };
        const sa = suitOrder[a.suitability] ?? 1;
        const sb = suitOrder[b.suitability] ?? 1;
        if (sa !== sb) return sa - sb;
        if ((a.peakCount || 0) !== (b.peakCount || 0)) return (a.peakCount || 0) - (b.peakCount || 0);
      }
      return (b.freeMins || 0) - (a.freeMins || 0);
    });

    let html = '';

    // Show existing assignment if any
    if (existing) {
      html += `<div class="sub-assigned-badge">
        <i class="fa-solid fa-check-circle"></i>
        Đã gán: <strong>${esc(existing.substitute_teacher_name || existing.substitute_teacher_email)}</strong>
        <button onclick="removeSubstitute('${existing.id}')">✕ Xóa</button>
      </div>`;
      html += '<div style="margin:10px 0 6px;font-size:0.78rem;color:#9ca3af;">Hoặc chọn GV khác:</div>';
    }

    if (filtered.length === 0 && deptMatched.length > 0) {
      // Teachers are working but none cover student's time → show warning + option to see all
      html += `<div style="text-align:center;padding:16px;">
        <div style="width:48px;height:48px;margin:0 auto 10px;border-radius:50%;background:#fef3c7;display:grid;place-items:center;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:1.2rem;color:#d97706;"></i>
        </div>
        <div style="font-weight:700;font-size:0.9rem;color:#92400e;margin-bottom:6px;">Không có GV phù hợp giờ học</div>
        <div style="font-size:0.78rem;color:#6b7280;margin-bottom:14px;">
          HV học lúc <strong>${esc(studentInfo.timeLocal || '?')}</strong> nhưng không có GV nào đang làm việc vào khung giờ đó.<br>
          Có <strong>${deptMatched.length}</strong> GV đang làm việc ngày này ở khung giờ khác.
        </div>
        <button onclick="document.getElementById('subPickerAllTeachers').style.display='block';this.style.display='none';"
          style="padding:8px 20px;border:1px solid #d97706;border-radius:10px;background:#fffbeb;color:#92400e;font-size:0.8rem;font-weight:600;cursor:pointer;">
          <i class="fa-solid fa-eye"></i> Xem tất cả GV đang làm
        </button>
      </div>
      <div id="subPickerAllTeachers" style="display:none;">
        <div style="font-size:0.72rem;font-weight:600;color:#d97706;padding:8px 0 6px;border-top:1px solid #fde68a;margin-top:8px;">
          <i class="fa-solid fa-triangle-exclamation"></i> Giờ làm việc không trùng giờ học của HV:
        </div>`;
      deptMatched.forEach((t, i) => {
        html += _renderTeacherCard(t, studentInfo, false, i);
      });
      html += '</div>';
    } else if (filtered.length === 0) {
      html += '<div style="text-align:center;padding:20px;color:#9ca3af;">Không có GV nào đang làm việc ngày này.</div>';
    } else {
      // Show matching teachers sorted by suitability
      filtered.forEach((t, i) => {
        html += _renderTeacherCard(t, studentInfo, i === 0 && filtered.length > 1, i);
      });
    }

    body.innerHTML = html;
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div style="color:#dc2626;padding:20px;text-align:center;">Lỗi: ${esc(e.message)}</div>`;
  }
}

async function assignSubstitute(info) {
  // tansinh offq v1: inline confirm inside the picker, no confirm()/alert(),
  // and the page redraws in place afterwards (no column reload).
  const bar = oqConfirmBar();
  if (!bar) return;
  bar.innerHTML = `<span>Gán <b>${esc(info.subName)}</b> phụ trách tạm <b>${esc(info.studentName)}</b> (${esc(info.role || 'TTKB')}) ngày ${oqFmtDMY(info.dateYMD)}?</span>
    <span class="oq-confirm-btns"><button type="button" class="oq-btn" data-oq-confirm="no">Hủy</button><button type="button" class="oq-btn primary" data-oq-confirm="yes"><i class="fa-solid fa-check"></i> Gán</button></span>`;
  bar.querySelector('[data-oq-confirm="no"]').onclick = () => bar.remove();
  bar.querySelector('[data-oq-confirm="yes"]').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gán…';
    try {
      const res = await fetch(_DO + '/save-temp-substitute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await _subAuth()) },
        body: JSON.stringify({
          student_email: info.studentEmail,
          original_teacher_email: info.originalTeacherEmail,
          substitute_teacher_email: info.subEmail,
          assign_date: info.dateYMD,
          day_of_week: info.dayOfWeek,
          time_local: info.timeLocal,
          student_name: info.studentName,
          student_minutes: info.studentMinutes,
          student_level: info.studentLevel,
          original_teacher_name: info.originalTeacherName,
          substitute_teacher_name: info.subName,
          role: info.role || 'TTKB'
        })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || 'Save failed');
      closeSubPicker();
      oqToast(`Đã gán ${info.subName} cho ${info.studentName}`);
      await oqAfterChange();
    } catch (e) {
      console.error(e);
      bar.innerHTML = `<span style="color:#b91c1c"><i class="fa-solid fa-triangle-exclamation"></i> Không gán được: ${esc(e.message)}</span><span class="oq-confirm-btns"><button type="button" class="oq-btn" data-oq-confirm="no">Đóng</button></span>`;
      bar.querySelector('[data-oq-confirm="no"]').onclick = () => bar.remove();
    }
  };
}

async function removeSubstitute(id) {
  const bar = oqConfirmBar();
  if (!bar) return;
  bar.innerHTML = `<span>Xóa phân công tạm này?</span>
    <span class="oq-confirm-btns"><button type="button" class="oq-btn" data-oq-confirm="no">Hủy</button><button type="button" class="oq-btn primary" style="background:#dc2626;border-color:#dc2626" data-oq-confirm="yes"><i class="fa-solid fa-trash"></i> Xóa</button></span>`;
  bar.querySelector('[data-oq-confirm="no"]').onclick = () => bar.remove();
  bar.querySelector('[data-oq-confirm="yes"]').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xóa…';
    try {
      const res = await fetch(_DO + '/save-temp-substitute', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(await _subAuth()) },
        body: JSON.stringify({ id })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || 'Delete failed');
      closeSubPicker();
      oqToast('Đã xóa phân công tạm');
      await oqAfterChange();
    } catch (e) {
      console.error(e);
      bar.innerHTML = `<span style="color:#b91c1c"><i class="fa-solid fa-triangle-exclamation"></i> Không xóa được: ${esc(e.message)}</span><span class="oq-confirm-btns"><button type="button" class="oq-btn" data-oq-confirm="no">Đóng</button></span>`;
      bar.querySelector('[data-oq-confirm="no"]').onclick = () => bar.remove();
    }
  };
}


window.openSubPicker = openSubPicker;
window.assignSubstitute = assignSubstitute;
window.removeSubstitute = removeSubstitute;