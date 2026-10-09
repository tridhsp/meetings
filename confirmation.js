// confirmation.js - Dedicated confirmation page
const _DO = '/api';

let client;
let appStarted = false;
let confState = { freehours: false, schedule: false, students: false };

document.addEventListener('DOMContentLoaded', async () => {
  const msgEl = document.getElementById('message');

  try {
    // Get Supabase credentials
    const r = await fetch(_DO + '/supabase-credentials');
    if (!r.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await r.json();

    // Create Supabase client
    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
    });

    // Check session
    const { data: { session } } = await client.auth.getSession();
    if (session) {
      showApp();
    } else {
      showLogin();
    }

    // Listen for auth changes
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

    // Wire up UI
    setupPasswordToggle();
    setupLoginHandler();

  } catch (e) {
    console.error(e);
    if (msgEl) msgEl.textContent = 'Không thể kết nối Supabase. Vui lòng thử lại sau.';
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

  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'none';
  document.body.classList.add('app');


  const main = document.getElementById('mainContent');
  if (main) main.style.display = 'block';

  // Show sidebar toggle button
  const sidebarToggleBtn = document.getElementById('sidebarToggle');
  if (sidebarToggleBtn) sidebarToggleBtn.style.display = 'grid';

  // Wire up sidebar
  setupConfirmationSidebar();

  // tansinh conf-board v1: draw the board first ("Đang kiểm tra…"), then load.
  // The calendar fixes the week; the other three loads run side by side.
  renderConfirmUI();
  setupRailClicks();
  await loadCalendarData();
  await Promise.all([
    (async () => { await loadStudentNotes(); await loadMyStudents(); })(),
    loadFreeHours(),
    loadAllConfirmations()
  ]);
  renderConfirmUI();
}

function setupPasswordToggle() {
  const toggle = document.getElementById('togglePwd');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    if (!pwd) return;
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
  });
}

function setupLoginHandler() {
  const btn = document.getElementById('login');
  if (!btn) return;

  const submit = async () => {
    const msgEl = document.getElementById('message');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = ''; }

    if (!client) {
      if (msgEl) msgEl.textContent = 'Đang kết nối, vui lòng đợi…';
      const _tsWaitStart = Date.now();
      while (!client && Date.now() - _tsWaitStart < 5000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!client) {
        if (msgEl) msgEl.textContent = 'Không kết nối được máy chủ, vui lòng tải lại trang.';
        return;
      }
      if (msgEl) msgEl.textContent = '';
    }

    const email = document.getElementById('email')?.value.trim();
    const password = document.getElementById('password')?.value;

    if (!email || !password) {
      if (msgEl) { msgEl.textContent = 'Vui lòng điền đầy đủ thông tin.'; msgEl.className = 'error'; }
      return;
    }

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      if (msgEl) { msgEl.textContent = error.message; msgEl.className = 'error'; }
    } else {
      if (msgEl) msgEl.textContent = '';
    }
  };

  btn.addEventListener('click', submit);
  document.getElementById('loginCard')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// Helper functions
function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Remove sessions that are fully contained inside a larger session (same department)
function removeContainedFromDay(sessions) {
  const groups = {};
  for (const s of sessions) {
    const dept = (s.department || '');
    if (!groups[dept]) groups[dept] = [];
    groups[dept].push(s);
  }

  const result = [];
  for (const dept in groups) {
    const group = groups[dept];
    if (group.length <= 1) { result.push(...group); continue; }

    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aStart = toMinutes(a.start_time);
      const aEnd = toMinutes(a.end_time);
      let isContained = false;

      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const b = group[j];
        const bStart = toMinutes(b.start_time);
        const bEnd = toMinutes(b.end_time);

        if (bStart <= aStart && bEnd >= aEnd && (bEnd - bStart) > (aEnd - aStart)) {
          isContained = true;
          break;
        }
      }

      if (!isContained) result.push(a);
    }
  }
  return result;
}

function toMinutes(hhmm) {
  if (!hhmm) return -1;
  const raw = String(hhmm).trim();
  const parts = raw.split(':');
  const h = Number(parts[0]);
  const m = Number((parts[1] || '0').replace(/[^\d]/g, '')) || 0;
  return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);
}

function weekdayFromYMD(ymd) {
  const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return -1;
  return new Date(y, m - 1, d).getDay();
}

async function loadCalendarData() {
  const grid = document.getElementById('calendarGrid');
  const statsBar = document.getElementById('statsBar');

  if (!grid) return;

  // Get current user email
  const { data: { session } } = await client.auth.getSession();
  const userEmail = session?.user?.email?.toLowerCase() || '';
  const token = session?.access_token;

  if (!userEmail || !token) {
    grid.innerHTML = '<div class="calendar-loading"><span>Vui lòng đăng nhập lại.</span></div>';
    return;
  }

  // Calculate current week (Monday to Sunday)
  const today = new Date();
  const todayDOW = today.getDay(); // 0=Sun, 1=Mon, ...
  const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  // Update week range display
  const formatDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const weekRangeText = `${formatDate(monday)} – ${formatDate(sunday)}/${monday.getFullYear()}`;
const weekRangeEl = document.getElementById('weekRangeText');
  if (weekRangeEl) weekRangeEl.textContent = weekRangeText;

  // Store Monday for confirmation and check status
  currentWeekMonday = formatYMD(monday);
  checkWeekConfirmation(currentWeekMonday);

  // Fetch meeting_content for this user
  const queryFrom = new Date(monday);
  queryFrom.setDate(queryFrom.getDate() - 56); // 8 weeks back for recurring
  const fromDate = formatYMD(queryFrom);

  try {
    const res = await fetch(`${_DO}/meetingsfrommeetingcontent?from=${fromDate}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));

    if (!res.ok) {
      grid.innerHTML = `<div class="calendar-loading"><span>Lỗi: ${out?.error || res.statusText}</span></div>`;
      return;
    }

    const allRows = out.rows || [];

    // Fetch off-days for this week
    const offRes = await fetch(`${_DO}/offdays-range?from=${formatYMD(monday)}&to=${formatYMD(sunday)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const offOut = await offRes.json().catch(() => ({}));
    const offSet = new Set((offOut.rows || []).map(r => `${r.meeting_content_id}|${r.off_date}`));

    // Filter rows for this user (by teacher_email)
    const userRows = allRows.filter(r =>
      (r.teacher_email || '').toLowerCase() === userEmail
    );

    // Build calendar
    renderCalendar(monday, userRows, today, offSet);

  } catch (e) {
    grid.innerHTML = `<div class="calendar-loading"><span>Lỗi kết nối: ${e.message}</span></div>`;
  }
}

function renderCalendar(monday, userRows, today, offSet) {
  const grid = document.getElementById('calendarGrid');
  const statsBar = document.getElementById('statsBar');
  
  const dayNames = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  const todayYMD = formatYMD(today);

  let totalSessions = 0;
  let totalMinutes = 0;
  
  // Group sessions by day
  const dayGroups = {};

  for (let i = 0; i < 7; i++) {
    const currentDay = new Date(monday);
    currentDay.setDate(monday.getDate() + i);
    const currentYMD = formatYMD(currentDay);
    const dayIndex = currentDay.getDay();
    const isToday = currentYMD === todayYMD;
    const isPast = currentDay < today && !isToday;

    // Find sessions for this day
    const daySessions = userRows.filter(r => {
      const rowYMD = String(r.work_date).slice(0, 10);
      const [ry, rm, rd] = rowYMD.split('-').map(Number);
      const rowDate = new Date(ry, rm - 1, rd);
      const rowDOW = rowDate.getDay();
      
      const isOneTime = r.is_one_time === true || 
                        r.is_one_time === 1 || 
                        String(r.is_one_time).toLowerCase() === 'true' ||
                        String(r.is_one_time).toLowerCase() === 't';
      
      if (isOneTime) {
        return rowYMD === currentYMD;
      }
      return rowDOW === dayIndex;
});

    // Filter out off-day sessions
    const activeSessions = offSet
      ? daySessions.filter(r => !offSet.has(`${r.id}|${currentYMD}`))
      : daySessions;

    // Remove contained sessions (smaller inside larger, same department)
    const cleanedSessions = removeContainedFromDay(activeSessions);

    // Skip days with no sessions
    if (cleanedSessions.length === 0) continue;

const dayKey = `day-${i}`;
    dayGroups[dayKey] = {
      dayName: dayNames[dayIndex],
      dayDate: `${String(currentDay.getDate()).padStart(2, '0')}/${String(currentDay.getMonth() + 1).padStart(2, '0')}`,
      dayIndex: dayIndex,
      isToday,
      isPast,
      sessions: []
    };

    // Remove duplicates and add sessions
const seenTimes = new Set();
    for (const s of cleanedSessions) {
      const key = `${s.start_time}-${s.end_time}-${s.department || ''}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        
        // Calculate hours
        const startMin = toMinutes(s.start_time);
        const endMin = toMinutes(s.end_time);
        if (startMin >= 0 && endMin > startMin) {
          totalMinutes += (endMin - startMin);
        }
        totalSessions++;

        dayGroups[dayKey].sessions.push({
          ...s,
          startMin
        });
      }
    }

    // Sort sessions by time within the day
    dayGroups[dayKey].sessions.sort((a, b) => a.startMin - b.startMin);
  }

  // Build HTML
  let html = '';
  
  const groupKeys = Object.keys(dayGroups);
  
  if (groupKeys.length === 0) {
    html = '<div class="no-sessions-message">Không có lịch làm việc trong tuần này</div>';
  } else {
    for (const dayKey of groupKeys) {
      const group = dayGroups[dayKey];
      
      const groupClasses = ['day-group'];
      if (group.isToday) groupClasses.push('is-today-group');
      if (group.isPast) groupClasses.push('is-past-group');

      const headerClasses = ['day-group-header'];
      if (group.isToday) headerClasses.push('is-today-header');
      if (group.isPast) headerClasses.push('is-past-header');

// Get day class for coloring (mon, tue, wed, etc.)
      const dayClass = getDayClass(group.dayIndex);

      html += `
        <div class="${groupClasses.join(' ')} ${dayClass}">
          <div class="${headerClasses.join(' ')} ${dayClass}">
            <span class="day-group-name">${group.dayName}</span>
            <span class="day-group-date">${group.dayDate}</span>
            <span class="day-group-count">${group.sessions.length} buổi</span>
          </div>
          <div class="day-group-sessions">
      `;

      for (const s of group.sessions) {
        const rowClasses = ['session-row'];
        if (group.isPast) rowClasses.push('is-past');

        const dept = (s.department || '').trim();
        const deptClass = getDeptClass(dept);
        const deptLabel = dept || '—';

        const isRecurring = !(s.is_one_time === true || 
                             s.is_one_time === 1 || 
                             String(s.is_one_time).toLowerCase() === 'true' ||
                             String(s.is_one_time).toLowerCase() === 't');

const startTime = String(s.start_time || '').slice(0, 5);
        const endTime = String(s.end_time || '').slice(0, 5);


html += `
            <div class="${rowClasses.join(' ')}"
                 data-day="${group.dayName}"
                 data-date="${group.dayDate}"
                 data-start="${startTime}"
                 data-end="${endTime}"
                 data-dept="${deptLabel}"
                 data-meeting-id="${s.id || ''}">
              <div class="session-time">
                <i class="fa-solid fa-clock"></i>
                <span class="time-text">${startTime} – ${endTime}</span>
                ${isRecurring ? '<i class="fa-solid fa-repeat recurring-icon" title="Lặp hàng tuần"></i>' : ''}
              </div>
              <div>
                <span class="session-dept ${deptClass}">${deptLabel}</span>
              </div>
              <div class="session-notes">${s.notes || '–'}</div>
              <button type="button" class="request-change-btn" title="Yêu cầu thay đổi">
                <i class="fa-solid fa-pen-to-square"></i>
                Yêu cầu thay đổi
              </button>
            </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    }
  }

  grid.innerHTML = html;

  // Update stats
  if (statsBar) {
    statsBar.style.display = 'flex';
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMins = totalMinutes % 60;
    
    const sessionsEl = document.getElementById('totalSessions');
    const hoursEl = document.getElementById('totalHours');
    
    if (sessionsEl) sessionsEl.textContent = `${totalSessions} buổi làm việc`;
    if (hoursEl) {
      hoursEl.textContent = remainingMins > 0 
        ? `${totalHours} giờ ${remainingMins} phút`
        : `${totalHours} giờ`;
    }
  }
}

// Helper function for day-of-week class
function getDayClass(dayIndex) {
  const classes = ['day-sun', 'day-mon', 'day-tue', 'day-wed', 'day-thu', 'day-fri', 'day-sat'];
  return classes[dayIndex] || '';
}

// Helper function for department class
function getDeptClass(dept) {
  const d = (dept || '').toLowerCase();
  if (d === 'ttkb') return 'dept-ttkb';
  if (d === 'breakout') return 'dept-breakout';
  if (d === 'bm') return 'dept-bm';
  if (d === 'supporter' || d.includes('support')) return 'dept-supporter';
  if (d === 'mix') return 'dept-mix';
  return 'dept-default';
}


// ========== Request Change Modal Handling ==========

function setupRequestChangeModal() {
  const modal = document.getElementById('requestChangeModal');
  const closeBtn = document.getElementById('requestModalClose');
  const cancelBtn = document.getElementById('requestCancelBtn');
  const submitBtn = document.getElementById('requestSubmitBtn');
  const textarea = document.getElementById('requestReason');
  const sessionInfo = document.getElementById('requestSessionInfo');

  if (!modal) return;

  // Store current session data
  let currentSessionData = null;

  // Open modal function
  window.openRequestChangeModal = function(data) {
    currentSessionData = data;
    
    // Populate session info
    sessionInfo.innerHTML = `
      <div class="info-row">
        <i class="fa-regular fa-calendar"></i>
        <span class="info-label">Ngày:</span>
        <span>${data.day} - ${data.date}</span>
      </div>
      <div class="info-row">
        <i class="fa-regular fa-clock"></i>
        <span class="info-label">Thời gian:</span>
        <span>${data.start} – ${data.end}</span>
      </div>
      <div class="info-row">
        <i class="fa-solid fa-building"></i>
        <span class="info-label">Bộ phận:</span>
        <span>${data.dept || '–'}</span>
      </div>
    `;

    // Clear previous input
    textarea.value = '';
    
    // Show modal
    modal.classList.remove('hidden');
    
    // Focus textarea after animation
    setTimeout(() => textarea.focus(), 100);
  };

  // Close modal function
  function closeModal() {
    modal.classList.add('hidden');
    currentSessionData = null;
    textarea.value = '';
  }

  // Event listeners
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

// Submit handler - sends to server
  submitBtn.addEventListener('click', async () => {
    const reason = textarea.value.trim();
    
    if (!reason) {
      textarea.style.borderColor = '#dc2626';
      textarea.focus();
      return;
    }

    if (reason.length < 10) {
      textarea.style.borderColor = '#dc2626';
      alert('Vui lòng nhập lý do chi tiết hơn (ít nhất 10 ký tự).');
      textarea.focus();
      return;
    }

    // Reset border color
    textarea.style.borderColor = '#e5e7eb';

    // Disable button and show loading
    submitBtn.disabled = true;
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...';

    try {
      const { data: { session } } = await client.auth.getSession();
      const token = session?.access_token;
      
      if (!token) {
        alert('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        return;
      }

      // Convert date format from "DD/MM" to "YYYY-MM-DD"
      const dateParts = currentSessionData.date.split('/');
      const now = new Date();
      const year = now.getFullYear();
      const workDate = `${year}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;

      const payload = {
        meetingContentId: currentSessionData.meetingContentId || null,
        workDate: workDate,
        startTime: currentSessionData.start,
        endTime: currentSessionData.end,
        department: currentSessionData.dept,
        reason: reason
      };

      const res = await fetch(_DO + '/request-change', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        throw new Error(result.error || 'Không thể gửi yêu cầu');
      }

      // Success!
      closeModal();
      
      // Show success message
      showSuccessToast('Yêu cầu thay đổi đã được gửi thành công!');

    } catch (err) {
      console.error('Request change error:', err);
      alert('Lỗi: ' + (err.message || 'Không thể gửi yêu cầu. Vui lòng thử lại.'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });

  // Reset border color on input
  textarea.addEventListener('input', () => {
    textarea.style.borderColor = '#e5e7eb';
  });
}

// Delegate click handler for request change buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.request-change-btn');
  if (!btn) return;

  const row = btn.closest('.session-row');
  if (!row) return;

  const data = {
    day: row.dataset.day || '',
    date: row.dataset.date || '',
    start: row.dataset.start || '',
    end: row.dataset.end || '',
    dept: row.dataset.dept || '',
    meetingContentId: row.dataset.meetingId || null
  };

  if (typeof window.openRequestChangeModal === 'function') {
    window.openRequestChangeModal(data);
  }
});

// Success toast notification
function showSuccessToast(message) {
  // Remove existing toast if any
  const existingToast = document.getElementById('successToast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.id = 'successToast';
  toast.innerHTML = `
    <div class="success-toast">
      <i class="fa-solid fa-circle-check"></i>
      <span>${message}</span>
    </div>
  `;
  document.body.appendChild(toast);

  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Initialize the modal when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  setupRequestChangeModal();
});


// ========== Weekly Confirmation ==========
let currentWeekMonday = null;

async function checkWeekConfirmation(mondayYMD) {
  // Now handled by loadAllConfirmations — keep this as a no-op
  // so the existing call in loadCalendarData doesn't break
}

// confirmWeek is now handled by the stepper — see confirmStep('schedule')

// ========== MY STUDENTS SECTION ==========

function msEsc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function msInitials(nameOrEmail) {
  const src = (nameOrEmail || '').trim();
  if (!src) return '?';
  const parts = src.split(/\s+/);
  const a = (parts[0] || src)[0] || '';
  const b = (parts[1] || '')[0] || '';
  return (a + b).toUpperCase();
}

async function loadMyStudents() {
  // tansinh conf-board v1: this used to own its own "Xác nhận danh sách HV"
  // button and its own GET of confirm-student-day. Both are gone; the section
  // header is rendered by renderSectionAction() from the one shared state.
  const content = document.getElementById('myStudentsContent');
  if (!content) return;

  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    content.innerHTML = '<div class="calendar-loading"><span>Vui lòng đăng nhập lại.</span></div>';
    return;
  }

  const token = session.access_token;

  try {
    const res = await fetch(_DO + '/my-students', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Lỗi');

    const data = out.data || {};
    const dayLabelsLong = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

    // This week's dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDow = today.getDay();
    const mondayOffset = todayDow === 0 ? -6 : 1 - todayDow;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    function addDays(d, n) {
      const r = new Date(d);
      r.setDate(r.getDate() + n);
      return r;
    }

    const mondayYMD = formatYMD(monday);

    // Order: Mon → Sun
    const dowOrder = [1, 2, 3, 4, 5, 6, 0];

    // Count unique students
    const allStudents = new Set();
    for (const dow in data) {
      for (const s of data[dow]) {
        allStudents.add(s.student_email);
      }
    }

    cfCounts.students = `${allStudents.size} HV`;
    const metaEl = document.getElementById('cfStudentsMeta');
    if (metaEl) metaEl.textContent = cfCounts.students;

    if (allStudents.size === 0) {
      content.innerHTML = `<div class="cf-empty">
        <i class="fa-solid fa-info-circle" style="font-size:2rem;color:#3b82f6;display:block;margin-bottom:8px"></i>
        Bạn chưa được phân công HV nào
      </div>`;
      return;
    }

    let daysHtml = '';

    for (const dow of dowOrder) {
      const students = data[dow];
      if (!students || !students.length) continue;

      const dayOffset = dow === 0 ? 6 : dow - 1;
      const dayDate = addDays(monday, dayOffset);
      const dd = String(dayDate.getDate()).padStart(2, '0');
      const mm = String(dayDate.getMonth() + 1).padStart(2, '0');

      const studentItems = students.map(s => {
        const ini = msInitials(s.student_name);
        const timeStr = (s.time_local || '').slice(0, 5);
        const roleClass = s.role === 'Breakout' ? 'ms-role-breakout' : 'ms-role-ttkb';
        const existingNotes = getStudentNotes(s.student_email, dow);
        const hasNote = existingNotes.length > 0;
        const noteClass = hasNote ? ' ms-student-has-note' : '';
        const latestNote = hasNote ? existingNotes[0] : null;
        const notePreview = latestNote
          ? `<div class="ms-student-note-preview"><i class="fa-solid fa-flag"></i> "${msEsc(latestNote.note.slice(0, 60))}${latestNote.note.length > 60 ? '...' : ''}"</div>`
          : '';
        const clickData = JSON.stringify({
          studentEmail: s.student_email,
          studentName: s.student_name,
          dayOfWeek: dow,
          timeLocal: timeStr,
          role: s.role || 'TTKB',
          dayLabel: dayLabelsLong[dow] + ' ' + dd + '/' + mm,
          weekStartDate: mondayYMD
        }).replace(/'/g, '\\u0027');
        return `
          <div class="ms-student${noteClass}" style="cursor:pointer;" onclick='openStudentNoteModal(${clickData})'>
            <div class="ms-student-avatar">${msEsc(ini)}</div>
            <div class="ms-student-info">
              <span class="ms-student-name">${msEsc(s.student_name)} <i class="fa-solid fa-flag ms-student-note-icon" title="Ghi chú về HV này"></i></span>
              <span class="ms-student-role ${roleClass}">${msEsc(s.role || 'TTKB')}</span>
              ${notePreview}
            </div>
            <span class="ms-student-time">${msEsc(timeStr)}</span>
          </div>`;
      }).join('');

      daysHtml += `
        <div class="ms-day">
          <div class="ms-day-head">
            <span class="ms-day-dow">${dayLabelsLong[dow]}</span>
            <span class="ms-day-date">${dd}/${mm}</span>
            <span class="ms-day-count">${students.length} HV</span>
          </div>
          ${studentItems}
        </div>`;
    }

    content.innerHTML = `
      <p class="cf-hint"><i class="fa-solid fa-circle-info"></i>Hãy đảm bảo HV thuộc nhóm bạn phụ trách và giờ tiếp HV đúng với lịch. Nếu có sai lệch, bấm vào HV đó để ghi chú cho quản lý trước khi xác nhận.</p>
      <div class="ms-days">${daysHtml}</div>`;

  } catch (e) {
    content.innerHTML = `<div class="calendar-loading"><span>Lỗi: ${msEsc(e.message)}</span></div>`;
  }
}

// ========== STUDENT NOTE FEATURE ==========

let studentNotesCache = [];

async function loadStudentNotes() {
  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDow = today.getDay();
    const mondayOffset = todayDow === 0 ? -6 : 1 - todayDow;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);
    const mondayYMD = formatYMD(monday);

    const res = await fetch(`${_DO}/student-note?week_start_date=${mondayYMD}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const out = await res.json();
    if (res.ok && out.ok) {
      studentNotesCache = out.rows || [];
    }
  } catch (e) {
    console.warn('Could not load student notes:', e);
  }
}

function getStudentNotes(studentEmail, dow) {
  return studentNotesCache.filter(
    n => n.student_email === studentEmail && n.day_of_week === dow
  );
}

function openStudentNoteModal(info) {
  const overlay = document.getElementById('snOverlay');
  const modal = document.getElementById('snModal');
  const studentInfoEl = document.getElementById('snStudentInfo');
  const existingEl = document.getElementById('snExistingNotes');
  const textarea = document.getElementById('snTextarea');

  if (!overlay || !modal) return;

  // Store info for submit
  modal.dataset.studentEmail = info.studentEmail;
  modal.dataset.studentName = info.studentName;
  modal.dataset.dayOfWeek = info.dayOfWeek;
  modal.dataset.timeLocal = info.timeLocal;
  modal.dataset.role = info.role;
  modal.dataset.weekStartDate = info.weekStartDate;

  const ini = msInitials(info.studentName);
  studentInfoEl.innerHTML = `
    <div class="sn-student-avatar">${msEsc(ini)}</div>
    <div class="sn-student-detail">
      <strong>${msEsc(info.studentName)}</strong>
      <small>${msEsc(info.dayLabel)} • ${msEsc(info.timeLocal)} • ${msEsc(info.role || 'TTKB')}</small>
    </div>
  `;

  // Show existing notes
  const notes = getStudentNotes(info.studentEmail, info.dayOfWeek);
  if (notes.length > 0) {
    const statusLabels = { pending: 'Chờ xử lý', resolved: 'Đã xử lý', rejected: 'Từ chối' };
    existingEl.innerHTML = `
      <div class="sn-existing-label"><i class="fa-solid fa-history"></i> Ghi chú trước đó (${notes.length}):</div>
      ${notes.map(n => `
        <div class="sn-note-item">
          <div class="sn-note-text">"${msEsc(n.note)}"</div>
          <div class="sn-note-meta">
            ${new Date(n.created_at).toLocaleDateString('vi-VN')}
            <span class="sn-note-status ${n.status}">${statusLabels[n.status] || n.status}</span>
            ${n.admin_response ? ` — Phản hồi: ${msEsc(n.admin_response)}` : ''}
          </div>
        </div>
      `).join('')}
    `;
  } else {
    existingEl.innerHTML = '';
  }

  textarea.value = '';
  overlay.style.display = 'block';
  modal.style.display = 'block';
  setTimeout(() => textarea.focus(), 100);
}

function closeStudentNoteModal() {
  document.getElementById('snOverlay').style.display = 'none';
  document.getElementById('snModal').style.display = 'none';
}

async function submitStudentNote() {
  const modal = document.getElementById('snModal');
  const textarea = document.getElementById('snTextarea');
  const submitBtn = document.getElementById('snSubmitBtn');
  const note = textarea.value.trim();

  if (!note || note.length < 5) {
    textarea.style.borderColor = '#dc2626';
    textarea.focus();
    return;
  }

  textarea.style.borderColor = '#e5e7eb';
  submitBtn.disabled = true;
  const origHtml = submitBtn.innerHTML;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...';

  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Phiên hết hạn');

    const res = await fetch(_DO + '/student-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        studentEmail: modal.dataset.studentEmail,
        studentName: modal.dataset.studentName,
        dayOfWeek: Number(modal.dataset.dayOfWeek),
        timeLocal: modal.dataset.timeLocal,
        role: modal.dataset.role,
        note: note,
        weekStartDate: modal.dataset.weekStartDate
      })
    });

    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Lỗi');

    closeStudentNoteModal();
    if (typeof showSuccessToast === 'function') {
      showSuccessToast('Đã gửi ghi chú thành công!');
    }

    // Reload notes and students
    await loadStudentNotes();
    await loadMyStudents();

  } catch (e) {
    alert('Lỗi: ' + e.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = origHtml;
  }
}

// Wire up modal buttons
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('snOverlay')?.addEventListener('click', closeStudentNoteModal);
  document.getElementById('snClose')?.addEventListener('click', closeStudentNoteModal);
  document.getElementById('snCancelBtn')?.addEventListener('click', closeStudentNoteModal);
  document.getElementById('snSubmitBtn')?.addEventListener('click', submitStudentNote);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('snModal')?.style.display === 'block') {
      closeStudentNoteModal();
    }
  });
});

window.openStudentNoteModal = openStudentNoteModal;

// ========== SIDEBAR FOR CONFIRMATION PAGE ==========
function setupConfirmationSidebar() {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const closeBtn = document.getElementById('sidebarClose');
  const logoutBtn = document.getElementById('sidebarLogout');

  if (!toggle || !sidebar) return;

  const openSidebar = () => {
    sidebar.classList.add('open');
    overlay?.classList.add('show');
  };

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay?.classList.remove('show');
  };

  toggle.addEventListener('click', openSidebar);
  closeBtn?.addEventListener('click', closeSidebar);
  overlay?.addEventListener('click', closeSidebar);

  logoutBtn?.addEventListener('click', async () => {
    closeSidebar();
    if (client) {
      await client.auth.signOut();
    }
  });
}

// ========== FREE HOURS SECTION ==========

async function loadFreeHours() {
  const grid = document.getElementById('freeHoursGrid');
  if (!grid) return;

  const { data: { session } } = await client.auth.getSession();
  const userEmail = session?.user?.email?.toLowerCase() || '';

  if (!userEmail) {
    grid.innerHTML = '<div class="fh-empty"><i class="fa-solid fa-circle-info"></i>Vui lòng đăng nhập lại.</div>';
    return;
  }

  try {
    const res = await fetch(`${_DO}/get-teacher-ranges?teacherEmail=${encodeURIComponent(userEmail)}`);
    const out = await res.json();

    if (!res.ok) {
      grid.innerHTML = '<div class="fh-empty"><i class="fa-solid fa-circle-exclamation"></i>Không thể tải giờ rảnh.</div>';
      return;
    }

    const ranges = out.ranges || [];
    renderFreeHours(ranges);
  } catch (e) {
    console.error('Load free hours error:', e);
    grid.innerHTML = '<div class="fh-empty"><i class="fa-solid fa-circle-exclamation"></i>Lỗi kết nối.</div>';
  }
}

function renderFreeHours(ranges) {
  const grid = document.getElementById('freeHoursGrid');
  if (!grid) return;

  if (!ranges.length) {
    grid.innerHTML = '<div class="fh-empty-msg"><i class="fa-solid fa-calendar-xmark"></i>Bạn chưa đăng ký giờ rảnh nào.</div>';
    const totalEl = document.getElementById('fhTotal');
    if (totalEl) totalEl.textContent = '0 khung giờ';
    return;
  }

  const dayLabels = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  const dayCssMap = ['day-sun', 'day-mon', 'day-tue', 'day-wed', 'day-thu', 'day-fri', 'day-sat'];
  const dowOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon -> Sun

  // Group by day_of_week
  const byDay = {};
  let totalSlots = 0;
  for (const r of ranges) {
    const d = r.day_of_week;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r);
    totalSlots++;
  }

  // Update total badge
  const totalEl = document.getElementById('fhTotal');
  if (totalEl) totalEl.textContent = `${totalSlots} khung giờ`;

  let html = '<div class="fh-grid">';

  for (const dow of dowOrder) {
    const slots = byDay[dow];
    const dayClass = dayCssMap[dow];

    if (!slots || !slots.length) {
      html += `
        <div class="fh-col ${dayClass} fh-empty-day">
          <div class="fh-col-head">${dayLabels[dow]}</div>
          <div class="fh-col-body"><div class="fh-no-slot">—</div></div>
        </div>`;
      continue;
    }

    slots.sort((a, b) => toMinutes(a.time_start) - toMinutes(b.time_start));

    const pillsHtml = slots.map(s => {
      const start = String(s.time_start || '').slice(0, 5);
      const end = String(s.time_end || '').slice(0, 5);
      return `<div class="fh-pill">${start}–${end}</div>`;
    }).join('');

    html += `
      <div class="fh-col ${dayClass}">
        <div class="fh-col-head">${dayLabels[dow]}</div>
        <div class="fh-col-body">${pillsHtml}</div>
      </div>`;
  }

  html += '</div>';
  grid.innerHTML = html;
}

// ========== CONFIRMATION BOARD v1 (09 Oct 2026) ==========
// Replaces the bottom stepper and the shared pop-up.
// ONE state drives everything: confState[key] (true/false) and cfAt[key] (when).
// Every change calls renderConfirmUI(), which rebuilds the left panel and all
// three section headers from that state. Nothing is cloned, so a button can
// never carry a stale "disabled" over to the next step. That is the fix for
// "I have to refresh to confirm the next one".

const CF_STEPS = ['freehours', 'schedule', 'students'];
const cfInfo = {
  freehours: { url: _DO + '/confirm-free-hours',  label: 'Giờ rảnh',      secId: 'secFreehours' },
  schedule:  { url: _DO + '/confirm-week',        label: 'Lịch tuần này', secId: 'secSchedule'  },
  students:  { url: _DO + '/confirm-student-day', label: 'Danh sách HV',  secId: 'secStudents'  }
};
const cfAt = { freehours: null, schedule: null, students: null };
const cfCounts = { students: '' };
let cfLoaded = false;   // the three GETs have answered
let cfArmed = null;     // which step shows "Chắc chắn?"
let cfBusy = null;      // which step is being posted
let cfArmTimer = null;

// Servers answer in slightly different shapes; take the first time we find.
function cfPickTime(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const c = obj.confirmation || obj.row || {};
  const cands = [obj.confirmed_at, obj.created_at, obj.updated_at, c.confirmed_at, c.created_at, c.updated_at];
  for (const v of cands) {
    if (!v) continue;
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function cfFmtTime(d) {
  if (!d) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return hm;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

function cfNextKey() {
  return CF_STEPS.find(k => !confState[k]) || null;
}

function cfMetaText(key) {
  if (key === 'students') return cfCounts.students || '';
  if (key === 'schedule' && document.getElementById('statsBar')?.style.display === 'none') return '';
  const el = document.getElementById(key === 'freehours' ? 'fhTotal' : 'totalSessions');
  const t = (el?.textContent || '').trim();
  return key === 'schedule' ? t.replace(' làm việc', '') : t;
}

async function loadAllConfirmations() {
  const finish = () => { cfLoaded = true; renderConfirmUI(); };
  if (!currentWeekMonday) return finish();

  const { data: { session } } = await client.auth.getSession();
  const token = session?.access_token;
  if (!token) return finish();

  const headers = { 'Authorization': `Bearer ${token}` };
  const get = (url) => fetch(url, { headers }).then(r => r.json());

  const [fh, sch, stu] = await Promise.allSettled([
    get(`${_DO}/confirm-free-hours?weekStartDate=${currentWeekMonday}`),
    get(`${_DO}/check-week-confirmation?weekStartDate=${currentWeekMonday}`),
    get(`${_DO}/confirm-student-day?weekStartDate=${currentWeekMonday}`)
  ]);

  const take = (key, r) => {
    const v = r.status === 'fulfilled' ? r.value : null;
    confState[key] = !!(v && v.confirmed);
    cfAt[key] = confState[key] ? cfPickTime(v) : null;
  };
  take('freehours', fh);
  take('schedule', sch);
  take('students', stu);
  finish();
}

function renderConfirmUI() {
  const next = cfNextKey();
  const done = CF_STEPS.filter(k => confState[k]).length;

  const schedMeta = document.getElementById('cfSchedMeta');
  if (schedMeta) schedMeta.textContent = cfMetaText('schedule');

  renderRail(next, done);
  CF_STEPS.forEach(k => renderSectionAction(k, next));
  renderAllDone(cfLoaded && done === CF_STEPS.length);
}

function renderRail(next, done) {
  const rows = document.getElementById('cfRailRows');
  const sub  = document.getElementById('cfRailSub');
  const fill = document.getElementById('cfRailFill');
  if (!rows) return;

  const total = CF_STEPS.length;
  if (fill) fill.style.width = cfLoaded ? Math.round(done / total * 100) + '%' : '0%';
  if (sub) {
    sub.textContent = !cfLoaded ? 'Đang kiểm tra…'
      : done === total ? 'Xong tuần này'
      : `${done} / ${total} đã xác nhận · còn ${total - done}`;
  }

  rows.innerHTML = CF_STEPS.map((key, i) => {
    const info = cfInfo[key];
    const isDone = !!confState[key];
    const isNext = cfLoaded && !isDone && next === key;
    const isArmed = cfLoaded && cfArmed === key && cfBusy !== key;
    const cls = ['cf-rail-row', isDone ? 'is-done' : '', isNext ? 'is-next' : '', isArmed ? 'is-armed' : ''].filter(Boolean).join(' ');

    let meta = '', right = '';
    if (!cfLoaded) {
      meta = 'đang kiểm tra…';
      right = '<i class="fa-solid fa-spinner fa-spin cf-rail-wait"></i>';
    } else if (isDone) {
      const t = cfFmtTime(cfAt[key]);
      meta = t ? 'xác nhận lúc ' + t : 'đã xác nhận';
      right = '<i class="fa-solid fa-check cf-rail-check"></i>';
    } else if (cfBusy === key) {
      meta = 'đang xác nhận…';
      right = '<i class="fa-solid fa-spinner fa-spin cf-rail-wait"></i>';
    } else if (isArmed) {
      meta = 'chắc chắn?';
    } else {
      meta = cfMetaText(key) || 'chưa xác nhận';
      right = `<button type="button" class="cf-rail-btn${isNext ? ' primary' : ''}" data-act="arm" data-step="${key}">Xác nhận</button>`;
    }

    const strip = isArmed
      ? `<span class="cf-rail-strip"><button type="button" class="cf-arm-cancel" data-act="disarm">Hủy</button><button type="button" class="cf-arm-ok" data-act="confirm" data-step="${key}"><i class="fa-solid fa-check"></i> Tôi xác nhận</button></span>`
      : '';

    return `<div class="${cls}" role="button" tabindex="0" data-step="${key}">
      <span class="cf-dot"></span>
      <span class="cf-rail-text"><span class="cf-rail-name">${i + 1}. ${info.label}</span><span class="cf-rail-meta">${meta}</span>${strip}</span>
      ${right}
    </div>`;
  }).join('');
}

function renderSectionAction(key, next) {
  const info = cfInfo[key];
  const sec  = document.getElementById(info.secId);
  const host = document.getElementById('cfAction-' + key);
  if (!sec || !host) return;

  const isDone = !!confState[key];
  sec.classList.toggle('is-done', isDone);
  sec.classList.toggle('is-next', cfLoaded && !isDone && next === key);

  if (!cfLoaded) {
    host.innerHTML = '<span class="cf-checking"><i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra…</span>';
    return;
  }
  if (isDone) {
    const t = cfFmtTime(cfAt[key]);
    host.innerHTML = `<span class="cf-done"><i class="fa-solid fa-circle-check"></i> Đã xác nhận${t ? ' · ' + t : ''}</span>`;
    return;
  }
  if (cfBusy === key) {
    host.innerHTML = '<span class="cf-busy"><i class="fa-solid fa-spinner fa-spin"></i> Đang xác nhận…</span>';
    return;
  }
  if (cfArmed === key) {
    host.innerHTML = `<span class="cf-arm"><span class="cf-arm-q">Chắc chắn?</span><button type="button" class="cf-arm-cancel" data-act="disarm">Hủy</button><button type="button" class="cf-arm-ok" data-act="confirm" data-step="${key}"><i class="fa-solid fa-check"></i> Tôi xác nhận</button></span>`;
    return;
  }
  host.innerHTML = `<button type="button" class="cf-confirm-btn${next === key ? ' primary' : ''}" data-act="arm" data-step="${key}"><i class="fa-solid fa-check"></i> Xác nhận</button>`;
}

function renderAllDone(all) {
  const main = document.getElementById('cfMain');
  if (!main) return;
  let b = document.getElementById('cfAllDone');
  if (all) {
    if (!b) {
      b = document.createElement('div');
      b.id = 'cfAllDone';
      b.className = 'cf-alldone';
      b.innerHTML = '<i class="fa-solid fa-circle-check"></i><div><strong>Xong tuần này. Bạn đã xác nhận đủ 3 mục.</strong><div class="cf-alldone-sub">Có thay đổi thì vẫn gửi yêu cầu hoặc ghi chú ở từng phần như bình thường.</div></div>';
      main.prepend(b);
    }
  } else if (b) {
    b.remove();
  }
}

function cfScrollTo(key) {
  const info = cfInfo[key];
  const sec = info && document.getElementById(info.secId);
  if (!sec) return;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sec.classList.remove('cf-flash');
  void sec.offsetWidth;
  sec.classList.add('cf-flash');
  setTimeout(() => sec.classList.remove('cf-flash'), 1400);
}

function cfArm(key, scroll) {
  if (!key || confState[key] || cfBusy) return;
  cfArmed = key;
  clearTimeout(cfArmTimer);
  cfArmTimer = setTimeout(() => { if (cfArmed === key) cfDisarm(); }, 15000);
  renderConfirmUI();
  if (scroll) cfScrollTo(key);
}

function cfDisarm() {
  cfArmed = null;
  clearTimeout(cfArmTimer);
  renderConfirmUI();
}

async function cfConfirm(key) {
  if (!key || confState[key] || cfBusy) return;
  if (!currentWeekMonday) { alert('Chưa xác định được tuần. Vui lòng tải lại trang.'); return; }
  const info = cfInfo[key];

  cfBusy = key;
  cfArmed = null;
  clearTimeout(cfArmTimer);
  renderConfirmUI();

  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');

    const res = await fetch(info.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ weekStartDate: currentWeekMonday })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || (!result.ok && !result.confirmation && !result.confirmed)) {
      throw new Error(result.error || ('Máy chủ trả lời ' + res.status));
    }

    confState[key] = true;
    cfAt[key] = cfPickTime(result) || new Date();
    showSuccessToast(`Đã xác nhận ${info.label}`);

    const nextKey = cfNextKey();
    if (nextKey) setTimeout(() => cfScrollTo(nextKey), 350);
  } catch (e) {
    console.error('[conf-board] confirm', key, e);
    alert('Không xác nhận được: ' + (e.message || 'lỗi kết nối'));
  } finally {
    // Whatever happened, rebuild every button from the state. Nothing stays stuck.
    cfBusy = null;
    renderConfirmUI();
  }
}

function setupRailClicks() {
  if (window.__cfClicksWired) return;
  window.__cfClicksWired = true;

  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      const key = act.dataset.step || act.closest('.cf-rail-row')?.dataset.step || act.closest('.cf-section')?.dataset.step;
      if (a === 'arm')     { cfArm(key, !!act.closest('.cf-rail')); return; }
      if (a === 'disarm')  { cfDisarm(); return; }
      if (a === 'confirm') { cfConfirm(key); return; }
    }
    const row = e.target.closest('.cf-rail-row');
    if (row) cfScrollTo(row.dataset.step);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cfArmed) { cfDisarm(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('cf-rail-row')) {
      e.preventDefault();
      cfScrollTo(e.target.dataset.step);
    }
  });
}