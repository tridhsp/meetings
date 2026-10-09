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

  await loadOffTeachers();
  await loadExistingSubstitutes();
  await loadUnmatchedStudents();
  await loadUpcomingImpacted();
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

async function loadOffTeachers() {
  const content = document.getElementById('otContent');

  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    content.innerHTML = '<div class="ot-loading"><span>Vui lòng đăng nhập lại.</span></div>';
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = formatYMD(today);

  const monday = getMonday(today);
  const sunday = addDays(monday, 6);

  // Section 1: Today → end of this week
  const sec1From = todayStr;
  const sec1To = formatYMD(sunday);

  // Section 2: Next 3 weeks (week after this week → 3 weeks out)
  const sec2From = formatYMD(addDays(sunday, 1));
  const sec2To = formatYMD(addDays(sunday, 21));

  // Section 3: Past 8 weeks (8 weeks before this Monday → yesterday)
  const sec3From = formatYMD(addDays(monday, -56));
  const sec3To = formatYMD(addDays(today, -1));

  try {
    // Fetch all meeting_offdays for the entire range
    const overallFrom = sec3From;
    const overallTo = sec2To;

    const { data: offRows, error } = await client
      .from('meeting_offdays')
      .select('teacher_email, off_date, start_time, end_time')
      .gte('off_date', overallFrom)
      .lte('off_date', overallTo)
      .order('off_date', { ascending: true });

    if (error) throw error;

    // We need teacher names - fetch from meeting_content
    const uniqueEmails = [...new Set((offRows || []).map(r => (r.teacher_email || '').toLowerCase()).filter(Boolean))];
    const nameMap = {};

    if (uniqueEmails.length > 0) {
      // Fetch teacher names in batches
      for (const email of uniqueEmails) {
        const { data: mcRows } = await client
          .from('meeting_content')
          .select('teacher_name')
          .ilike('teacher_email', email)
          .not('teacher_name', 'is', null)
          .limit(1);

        if (mcRows && mcRows.length > 0 && mcRows[0].teacher_name) {
          nameMap[email] = mcRows[0].teacher_name;
        }
      }
    }

    let schedByTeacherDay = {};


    // Fetch impacted students via server function (bypasses RLS)

    if (uniqueEmails.length > 0) {
      try {
        const { data: { session: sess } } = await client.auth.getSession();
        const tok = sess?.access_token;
        if (tok) {
          const impRes = await fetch(_DO + '/impacted-students', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${tok}`
            },
            body: JSON.stringify({ teacherEmails: uniqueEmails })
          });
          const impOut = await impRes.json();
          if (impOut.ok && impOut.data) {
            schedByTeacherDay = impOut.data;
          }
        }
      } catch (impErr) {
        console.warn('Could not load impacted students:', impErr);
      }
    }

    // Split rows into 3 sections
    const rows = offRows || [];
    const sec1Rows = rows.filter(r => r.off_date >= sec1From && r.off_date <= sec1To);
    const sec2Rows = rows.filter(r => r.off_date >= sec2From && r.off_date <= sec2To);
    const sec3Rows = rows.filter(r => r.off_date >= sec3From && r.off_date <= sec3To);

    let html = '';

    // Section 1: This week (today → Sunday)
    html += buildSection(
      'Tuần này',
      `${formatDDMM(today)} → ${formatDDMM(sunday)}`,
      'current',
      sec1Rows, nameMap, todayStr,
      'fa-solid fa-fire',
      'Không có GV nghỉ từ hôm nay đến cuối tuần',
      schedByTeacherDay
    );

    // Section 2: Next 3 weeks
    const sec2Start = addDays(sunday, 1);
    const sec2End = addDays(sunday, 21);
    html += buildSection(
      '3 tuần tới',
      `${formatDDMM(sec2Start)} → ${formatDDMM(sec2End)}`,
      'upcoming',
      sec2Rows, nameMap, todayStr,
      'fa-solid fa-calendar-week',
      'Không có GV nghỉ trong 3 tuần tới',
      schedByTeacherDay
    );

    // Section 3: Past 8 weeks
    const sec3Start = addDays(monday, -56);
    const sec3End = addDays(today, -1);
    html += buildSection(
      '8 tuần trước',
      `${formatDDMM(sec3Start)} → ${formatDDMM(sec3End)}`,
      'past',
      sec3Rows, nameMap, todayStr,
      'fa-solid fa-clock-rotate-left',
      'Không có GV nghỉ trong 8 tuần trước',
      schedByTeacherDay
    );

    content.innerHTML = html;

    // Wire up toggle collapse
    content.querySelectorAll('.ot-section-head').forEach(head => {
      head.addEventListener('click', () => {
        head.closest('.ot-section').classList.toggle('collapsed');
      });
    });

  } catch (e) {
    content.innerHTML = `<div class="ot-loading"><span>Lỗi: ${esc(e.message)}</span></div>`;
  }
}

function formatDDMM(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildSection(title, dateRange, type, rows, nameMap, todayStr, icon, emptyMsg, schedByTeacherDay) {
  const uniqueTeachers = new Set(rows.map(r => (r.teacher_email || '').toLowerCase()).filter(Boolean));
  const countLabel = `${uniqueTeachers.size} GV`;

  let bodyHtml = '';

  if (rows.length === 0) {
    bodyHtml = `<div class="ot-section-body ot-empty"><i class="fa-solid fa-check-circle" style="font-size:2rem;color:#22c55e;display:block;margin-bottom:8px"></i>${esc(emptyMsg)}</div>`;
  } else {
    // Group by date
    const dayMap = {};
    for (const r of rows) {
      const date = r.off_date;
      if (!dayMap[date]) dayMap[date] = {};
      const email = (r.teacher_email || '').toLowerCase();
      if (!email) continue;
      if (!dayMap[date][email]) {
        dayMap[date][email] = {
          name: nameMap[email] || email,
          email: email,
          shifts: []
        };
      }
      const time = `${(r.start_time || '').slice(0, 5)}–${(r.end_time || '').slice(0, 5)}`;
      if (!dayMap[date][email].shifts.includes(time)) {
        dayMap[date][email].shifts.push(time);
      }
    }

    const sortedDates = Object.keys(dayMap).sort((a, b) => type === 'past' ? b.localeCompare(a) : a.localeCompare(b));

    let daysHtml = '';
    for (const date of sortedDates) {
      const d = new Date(date + 'T00:00:00');
      const dow = dayLabels[d.getDay()];
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const isToday = date === todayStr;
      const todayTag = isToday ? `<span class="ot-day-today-tag">Hôm nay</span>` : '';

      const teachers = Object.values(dayMap[date]).sort((a, b) => a.name.localeCompare(b.name));
      const dowNum = d.getDay();

      const headClass = type === 'past' ? 'ot-day-head--past' : (type === 'upcoming' ? 'ot-day-head--upcoming' : (isToday ? 'ot-day-head--today' : ''));

      const teacherItems = teachers.map(t => {
        const ini = initials(t.name);
        const shiftsText = t.shifts.join(', ');
        const impactKey = `${t.email}|${dowNum}`;
        const impacted = (schedByTeacherDay || {})[impactKey] || [];
        const studentsHtml = impacted.length > 0 ? `
          <div class="ot-impacted">
            <div class="ot-impacted-title">
              <i class="fa-solid fa-user-graduate"></i>
              HV bị ảnh hưởng (${impacted.length})
            </div>
            <div class="ot-impacted-list">
              ${impacted.map(s => `<span class="ot-student-chip">${esc(s.name)}</span>`).join('')}
            </div>
          </div>` : '';
        return `
          <div class="ot-teacher">
            <div class="ot-teacher-avatar">${esc(ini)}</div>
            <div class="ot-teacher-info">
              <div class="ot-teacher-name">${esc(t.name)}</div>
              <div class="ot-teacher-shifts"><i class="fa-regular fa-clock"></i> ${esc(shiftsText)}</div>
            </div>
          </div>
          ${studentsHtml}`;
      }).join('');

      daysHtml += `
        <div class="ot-day">
          <div class="ot-day-head ${headClass}">
            <span class="ot-day-dow">${dow}</span>
            <span class="ot-day-date">${dd}/${mm}</span>
            ${todayTag}
            <span class="ot-day-count">${teachers.length} GV</span>
          </div>
          ${teacherItems}
        </div>`;
    }

    bodyHtml = `<div class="ot-section-body">${daysHtml}</div>`;
  }

  // Past section starts collapsed
  const collapsedClass = type === 'past' ? ' collapsed' : '';

  return `
    <section class="ot-section${collapsedClass}">
      <div class="ot-section-head ot-section-head--${type}">
        <h2><i class="${icon}"></i> ${esc(title)}</h2>
        <span style="font-size:0.82rem;font-weight:500;opacity:0.85">${esc(dateRange)}</span>
        <span class="ot-section-badge">${countLabel}</span>
        <i class="fa-solid fa-chevron-down ot-section-chevron"></i>
      </div>
      ${bodyHtml}
    </section>`;
}

// ========== HELPER: Group students by email for merged cards ==========
function groupStudentsByEmail(students) {
  const groups = {};
  for (const s of students) {
    const key = s.student_email;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  return groups;
}

// ========== UNMATCHED STUDENTS (HV không có GV phụ trách) ==========

async function loadUnmatchedStudents() {
  const content = document.getElementById('umContent');
  if (!content) return;

  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    content.innerHTML = '<div class="ot-loading"><span>Vui lòng đăng nhập lại.</span></div>';
    return;
  }

  try {
    const res = await fetch(_DO + '/unmatched-students', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Lỗi');

    const data = out.data || {};
    const dayLabelsLong = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

    // Get this week's dates for display
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monday = getMonday(today);

    // Reorder: today first, then backwards (most recent on top)
    const todayDow = today.getDay(); // 0=Sun...6=Sat
    const dowOrder = [];
    for (let i = 0; i < 7; i++) {
      dowOrder.push((todayDow - i + 7) % 7);
    }

    // Count total unique students
    const allStudents = new Set();
    for (const dow in data) {
      for (const s of data[dow]) {
        allStudents.add(s.student_email);
      }
    }

    let bodyHtml = '';

    if (allStudents.size === 0) {
      bodyHtml = `<div class="um-section-body um-empty">
        <i class="fa-solid fa-check-circle" style="font-size:2rem;color:#22c55e;display:block;margin-bottom:8px"></i>
        Tất cả HV đã có GV phụ trách trong tuần này
      </div>`;
    } else {
      let daysHtml = '';

      for (const dow of dowOrder) {
        const students = data[dow];
        if (!students || !students.length) continue;

        // Calculate the actual date for this day of the week
        const dayOffset = dow === 0 ? 6 : dow - 1;
        const dayDate = addDays(monday, dayOffset);
        const dd = String(dayDate.getDate()).padStart(2, '0');
        const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
        const dateStr = `${dayDate.getFullYear()}-${mm}-${dd}`;

        const grouped = groupStudentsByEmail(students);
        const uniqueCount = Object.keys(grouped).length;

        const studentItems = Object.values(grouped).map(entries => {
          const first = entries[0];
          const ini = initials(first.student_name);
          const timeStr = (first.time_local || '').slice(0, 5);
          const isMulti = entries.length > 1;

          // Check if ALL roles have subs
          const allHaveSub = entries.every(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            return !!getSubstituteForStudent(s.student_email, dateStr, role);
          });
          const anyHasSub = entries.some(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            return !!getSubstituteForStudent(s.student_email, dateStr, role);
          });
          const cardClass = allHaveSub ? 'um-student--has-sub' : (anyHasSub ? 'um-student--partial-sub' : 'um-student--no-sub');

          

          // Single entry → original flat layout; multi → merged card
          if (!isMulti) {
            const s = first;
            const sub = getSubstituteForStudent(s.student_email, dateStr, s.role === 'Breakout' ? 'Breakout' : 'TTKB');
            const subBadge = sub
              ? `<div class="um-sub-badge"><i class="fa-solid fa-circle-check"></i> GV tạm (${esc(s.role || 'TTKB')}): ${esc(sub.substitute_teacher_name || sub.substitute_teacher_email)}</div>`
              : `<div class="um-no-sub-badge"><i class="fa-solid fa-circle-xmark"></i> Chưa có GV tạm</div>`;
            return `
            <div class="um-student ${cardClass}">
              <div class="um-student-avatar">${esc(ini)}</div>
              <div class="um-student-info">
              <div class="um-student-name" style="cursor:pointer;text-decoration:underline;text-decoration-color:#d9770640;" onclick='openSubPicker(${JSON.stringify({
                studentEmail: s.student_email, studentName: s.student_name,
                originalTeacherEmail: s.teacher_email, originalTeacherName: s.teacher_name,
                reason: s.reason || "nghỉ", dateYMD: dateStr,
                dateLabel: dayLabelsLong[dow] + " " + dd + "/" + mm, dayOfWeek: dow,
                timeLocal: (s.time_local || "").slice(0, 5),
                studentMinutes: s.student_minutes || 0, studentLevel: s.student_level || "",
                role: s.role || "TTKB"
              }).replace(/'/g, "\\u0027")})'>${esc(s.student_name)}</div>
                <div class="um-student-teacher">
                  <i class="fa-solid fa-chalkboard-user"></i>
                  GV: ${esc(s.teacher_name)} <span style="color:${s.reason === 'nghỉ' ? '#ef4444' : '#f59e0b'};font-weight:600">(${esc(s.reason || 'không có ca')})</span>
                  <span style="margin-left:4px;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:700;background:${s.role === 'Breakout' ? '#ede9fe' : '#dbeafe'};color:${s.role === 'Breakout' ? '#7c3aed' : '#2563eb'};border:1px solid ${s.role === 'Breakout' ? '#c4b5fd' : '#bfdbfe'}">${esc(s.role || 'TTKB')}</span>
                </div>
                ${subBadge}
              </div>
              <span class="um-student-time">${esc(timeStr)}</span>
            </div>`;
          }

          // Multi-role: compact pill badges
          const teacherName = first.teacher_name;
          const reason = first.reason || 'nghỉ';
          const reasonColor = reason === 'nghỉ' ? '#ef4444' : '#f59e0b';

          const rolePills = entries.map(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            const sub = getSubstituteForStudent(s.student_email, dateStr, role);
            const isBR = role === 'Breakout';
            const dotColor = sub ? '#22c55e' : '#ef4444';
            const pillBg = sub ? '#dcfce7' : (isBR ? '#ede9fe' : '#dbeafe');
            const pillColor = sub ? '#15803d' : (isBR ? '#7c3aed' : '#2563eb');
            const pillBorder = sub ? '#86efac' : (isBR ? '#c4b5fd' : '#bfdbfe');
            const subName = sub ? esc(sub.substitute_teacher_name || sub.substitute_teacher_email).split(' ').pop() : '';

            const pickerData = JSON.stringify({
              studentEmail: s.student_email, studentName: s.student_name,
              originalTeacherEmail: s.teacher_email, originalTeacherName: s.teacher_name,
              reason: s.reason || "nghỉ", dateYMD: dateStr,
              dateLabel: dayLabelsLong[dow] + " " + dd + "/" + mm, dayOfWeek: dow,
              timeLocal: (s.time_local || "").slice(0, 5),
              studentMinutes: s.student_minutes || 0, studentLevel: s.student_level || "",
              role: role
            }).replace(/'/g, "\\u0027");

            return `<span class="um-role-pill" onclick='openSubPicker(${pickerData})' style="background:${pillBg};color:${pillColor};border-color:${pillBorder}">${esc(role)} <span class="um-role-dot" style="background:${dotColor}"></span>${subName ? ` <span class="um-role-sub-name">${subName}</span>` : ''}</span>`;
          }).join('');

          return `
            <div class="um-student ${cardClass}">
              <div class="um-student-avatar">${esc(ini)}</div>
              <div class="um-student-info">
                <div class="um-student-name">${esc(first.student_name)}</div>
                <div class="um-student-teacher">
                  <i class="fa-solid fa-chalkboard-user"></i>
                  GV: ${esc(teacherName)} <span style="color:${reasonColor};font-weight:600">(${esc(reason)})</span>
                </div>
                <div class="um-role-pills">${rolePills}</div>
              </div>
              <span class="um-student-time">${esc(timeStr)}</span>
            </div>`;

        }).join('');

        daysHtml += `
          <div class="um-day">
            <div class="um-day-head">
              <span class="um-day-dow">${dayLabelsLong[dow]}</span>
              <span class="um-day-date">${dd}/${mm}</span>
              <span class="um-day-count">${uniqueCount} HV</span>
            </div>
            ${studentItems}
          </div>`;
      }

      bodyHtml = `<div class="um-section-body">${daysHtml}</div>`;
    }

    content.innerHTML = `
      <section class="um-section">
        <div class="um-section-head">
          <h2><i class="fa-solid fa-triangle-exclamation"></i> HV không có GV phụ trách</h2>
          <span class="um-section-badge">${allStudents.size} HV</span>
          <i class="fa-solid fa-chevron-down um-section-chevron"></i>
        </div>
        ${bodyHtml}
      </section>`;

    // Wire up collapse toggle
    content.querySelector('.um-section-head')?.addEventListener('click', () => {
      content.querySelector('.um-section')?.classList.toggle('collapsed');
    });

  } catch (e) {
    content.innerHTML = `<div class="ot-loading"><span>Lỗi: ${esc(e.message)}</span></div>`;
  }
}


// ========== UPCOMING IMPACTED STUDENTS (2 tuần tới) ==========

// ========== UPCOMING IMPACTED STUDENTS (2 tuần tới) ==========

async function loadUpcomingImpacted() {
  const content = document.getElementById('uiContent');
  if (!content) return;

  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    content.innerHTML = '<div class="ot-loading"><span>Vui lòng đăng nhập lại.</span></div>';
    return;
  }

  try {
    const res = await fetch(_DO + '/upcoming-impacted-students', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Lỗi');

    const data = out.data || [];

    // Count unique students
    const allStudents = new Set();
    for (const day of data) {
      for (const s of day.students) {
        allStudents.add(s.student_email);
      }
    }

    let bodyHtml = '';

    if (data.length === 0) {
      bodyHtml = `<div class="ui-section-body ui-empty">
        <i class="fa-solid fa-check-circle" style="font-size:2rem;color:#22c55e;display:block;margin-bottom:8px"></i>
        Không có HV bị ảnh hưởng trong 2 tuần tới
      </div>`;
    } else {
      const dayLabelsLong = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
      let daysHtml = '';

      for (const day of data) {
        const d = new Date(day.date + 'T00:00:00');
        const dow = d.getDay();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');

        const students = day.students;

        const grouped = groupStudentsByEmail(students);
        const uniqueCount = Object.keys(grouped).length;

        const studentItems = Object.values(grouped).map(entries => {
          const first = entries[0];
          const ini = initials(first.student_name);
          const timeStr = (first.time_local || '').slice(0, 5);
          const isMulti = entries.length > 1;

          const allHaveSub = entries.every(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            return !!getSubstituteForStudent(s.student_email, day.date, role);
          });
          const anyHasSub = entries.some(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            return !!getSubstituteForStudent(s.student_email, day.date, role);
          });
          const cardClass = allHaveSub ? 'um-student--has-sub' : (anyHasSub ? 'um-student--partial-sub' : 'um-student--no-sub');

          

          if (!isMulti) {
            const s = first;
            const sub = getSubstituteForStudent(s.student_email, day.date, s.role === 'Breakout' ? 'Breakout' : 'TTKB');
            const reasonColor = s.reason === 'nghỉ' ? '#ef4444' : '#f59e0b';
            const subBadge = sub
              ? `<div class="um-sub-badge"><i class="fa-solid fa-circle-check"></i> GV tạm (${esc(s.role || 'TTKB')}): ${esc(sub.substitute_teacher_name || sub.substitute_teacher_email)}</div>`
              : `<div class="um-no-sub-badge"><i class="fa-solid fa-circle-xmark"></i> Chưa có GV tạm</div>`;
            return `
            <div class="um-student ${cardClass}">
              <div class="um-student-avatar">${esc(ini)}</div>
              <div class="um-student-info">
                <div class="um-student-name" style="cursor:pointer;text-decoration:underline;text-decoration-color:#6366f140;" onclick='openSubPicker(${JSON.stringify({
                  studentEmail: s.student_email, studentName: s.student_name,
                  originalTeacherEmail: s.teacher_email, originalTeacherName: s.teacher_name,
                  reason: s.reason || "nghỉ", dateYMD: day.date,
                  dateLabel: dayLabelsLong[dow] + " " + dd + "/" + mm, dayOfWeek: dow,
                  timeLocal: (s.time_local || "").slice(0, 5),
                  studentMinutes: s.student_minutes || 0, studentLevel: s.student_level || "",
                  role: s.role || "TTKB"
                }).replace(/'/g, "\\u0027")})'>${esc(s.student_name)}</div>
                <div class="um-student-teacher">
                  <i class="fa-solid fa-chalkboard-user"></i>
                  GV: ${esc(s.teacher_name)} <span style="color:${reasonColor};font-weight:600">(${esc(s.reason || 'không có ca')})</span>
                  <span style="margin-left:4px;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:700;background:${s.role === 'Breakout' ? '#ede9fe' : '#dbeafe'};color:${s.role === 'Breakout' ? '#7c3aed' : '#2563eb'};border:1px solid ${s.role === 'Breakout' ? '#c4b5fd' : '#bfdbfe'}">${esc(s.role || 'TTKB')}</span>
                </div>
                ${subBadge}
              </div>
              <span class="um-student-time">${esc(timeStr)}</span>
            </div>`;
          }

          // Multi-role: compact pill badges
          const teacherName = first.teacher_name;
          const reason = first.reason || 'nghỉ';
          const reasonColor = reason === 'nghỉ' ? '#ef4444' : '#f59e0b';

          const rolePills = entries.map(s => {
            const role = s.role === 'Breakout' ? 'Breakout' : 'TTKB';
            const sub = getSubstituteForStudent(s.student_email, day.date, role);
            const isBR = role === 'Breakout';
            const dotColor = sub ? '#22c55e' : '#ef4444';
            const pillBg = sub ? '#dcfce7' : (isBR ? '#ede9fe' : '#dbeafe');
            const pillColor = sub ? '#15803d' : (isBR ? '#7c3aed' : '#2563eb');
            const pillBorder = sub ? '#86efac' : (isBR ? '#c4b5fd' : '#bfdbfe');
            const subName = sub ? esc(sub.substitute_teacher_name || sub.substitute_teacher_email).split(' ').pop() : '';

            const pickerData = JSON.stringify({
              studentEmail: s.student_email, studentName: s.student_name,
              originalTeacherEmail: s.teacher_email, originalTeacherName: s.teacher_name,
              reason: s.reason || "nghỉ", dateYMD: day.date,
              dateLabel: dayLabelsLong[dow] + " " + dd + "/" + mm, dayOfWeek: dow,
              timeLocal: (s.time_local || "").slice(0, 5),
              studentMinutes: s.student_minutes || 0, studentLevel: s.student_level || "",
              role: role
            }).replace(/'/g, "\\u0027");

            return `<span class="um-role-pill" onclick='openSubPicker(${pickerData})' style="background:${pillBg};color:${pillColor};border-color:${pillBorder}">${esc(role)} <span class="um-role-dot" style="background:${dotColor}"></span>${subName ? ` <span class="um-role-sub-name">${subName}</span>` : ''}</span>`;
          }).join('');

          return `
            <div class="um-student ${cardClass}">
              <div class="um-student-avatar">${esc(ini)}</div>
              <div class="um-student-info">
                <div class="um-student-name">${esc(first.student_name)}</div>
                <div class="um-student-teacher">
                  <i class="fa-solid fa-chalkboard-user"></i>
                  GV: ${esc(teacherName)} <span style="color:${reasonColor};font-weight:600">(${esc(reason)})</span>
                </div>
                <div class="um-role-pills">${rolePills}</div>
              </div>
              <span class="um-student-time">${esc(timeStr)}</span>
            </div>`;

        }).join('');

        daysHtml += `
          <div class="um-day">
            <div class="um-day-head">
              <span class="um-day-dow">${dayLabelsLong[dow]}</span>
              <span class="um-day-date">${dd}/${mm}</span>
              <span class="um-day-count">${uniqueCount} HV</span>
            </div>
            ${studentItems}
          </div>`;
      }

      bodyHtml = `<div class="ui-section-body">${daysHtml}</div>`;
    }

    const today = new Date();
    const fromDate = addDays(today, 1);
    const toDate = addDays(today, 14);
    const dateRange = `${formatDDMM(fromDate)} → ${formatDDMM(toDate)}`;

    content.innerHTML = `
      <section class="ui-section">
        <div class="ui-section-head">
          <h2><i class="fa-solid fa-binoculars"></i> HV bị ảnh hưởng 2 tuần tới</h2>
          <span style="font-size:0.82rem;font-weight:500;opacity:0.85">${dateRange}</span>
          <span class="ui-section-badge">${allStudents.size} HV</span>
          <i class="fa-solid fa-chevron-down ui-section-chevron"></i>
        </div>
        ${bodyHtml}
      </section>`;

    // Wire up collapse toggle
    content.querySelector('.ui-section-head')?.addEventListener('click', () => {
      content.querySelector('.ui-section')?.classList.toggle('collapsed');
    });

  } catch (e) {
    content.innerHTML = `<div class="ot-loading"><span>Lỗi: ${esc(e.message)}</span></div>`;
  }
}


// ========== TEMPORARY SUBSTITUTE TEACHER FEATURE ==========

let existingSubstitutes = []; // loaded from DB

async function loadExistingSubstitutes() {
  try {
    const today = new Date();
    const fromDate = today.toISOString().split('T')[0];
    // Load substitutes from today onwards (up to 3 weeks)
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 21);
    const toDateStr = toDate.toISOString().split('T')[0];

    const res = await fetch(`${_DO}/save-temp-substitute?from_date=${fromDate}&to_date=${toDateStr}`);
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
  const existing = getSubstituteForStudent(studentInfo.studentEmail, studentInfo.dateYMD);

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
      headers: { 'Content-Type': 'application/json' },
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
  if (!confirm(`Gán ${info.subName} phụ trách tạm cho ${info.studentName} ngày ${info.dateYMD}?`)) return;

  try {
    const res = await fetch(_DO + '/save-temp-substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Save failed');

    alert('Đã gán GV phụ trách tạm thành công!');
    closeSubPicker();

    // Reload data to refresh badges
    await loadExistingSubstitutes();
    await loadUnmatchedStudents();
    await loadUpcomingImpacted();
  } catch (e) {
    console.error(e);
    alert('Lỗi: ' + e.message);
  }
}

async function removeSubstitute(id) {
  if (!confirm('Xóa phân công tạm này?')) return;

  try {
    const res = await fetch(_DO + '/save-temp-substitute', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Delete failed');

    alert('Đã xóa phân công tạm.');
    closeSubPicker();

    await loadExistingSubstitutes();
    await loadUnmatchedStudents();
    await loadUpcomingImpacted();
  } catch (e) {
    console.error(e);
    alert('Lỗi: ' + e.message);
  }
}


window.openSubPicker = openSubPicker;
window.assignSubstitute = assignSubstitute;
window.removeSubstitute = removeSubstitute;