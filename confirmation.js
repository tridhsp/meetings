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

  // Load calendar data
  await loadCalendarData();
  await loadStudentNotes();
  await loadMyStudents();
  await loadFreeHours();
  await loadAllConfirmations();
  setupStepperClicks();

  // Show stepper
  const stepper = document.getElementById('confStepper');
  if (stepper) stepper.classList.add('visible');
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
      if (msgEl) msgEl.textContent = 'Supabase đang khởi tạo, vui lòng đợi…';
      return;
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

    // Get this week's dates
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

    // Check if student list is already confirmed this week
    let studentConfirmed = false;
    try {
      const confRes = await fetch(`${_DO}/confirm-student-day?weekStartDate=${mondayYMD}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const confOut = await confRes.json();
      if (confOut.ok) studentConfirmed = !!confOut.confirmed;
    } catch (e) {
      console.warn('Could not check student confirmation:', e);
    }

    

    // Order: Mon → Sun
    const dowOrder = [1, 2, 3, 4, 5, 6, 0];

    // Count unique students
    const allStudents = new Set();
    for (const dow in data) {
      for (const s of data[dow]) {
        allStudents.add(s.student_email);
      }
    }

    // Confirm button (defined here so it's available for both cases)
    const confirmBtnHtml = studentConfirmed
      ? `<div class="ms-confirm-row">
           <button class="ms-confirm-btn confirmed" disabled>
             <i class="fa-solid fa-circle-check"></i> Đã xác nhận danh sách HV ✓
           </button>
         </div>`
      : `<div class="ms-confirm-row">
           <button class="ms-confirm-btn" id="msConfirmBtn" data-week="${mondayYMD}">
             <i class="fa-solid fa-check-circle"></i> Xác nhận danh sách HV tuần này
           </button>
         </div>`;

    let bodyHtml = '';

    if (allStudents.size === 0) {
      bodyHtml = `<div class="ms-section-body ms-empty">
        <i class="fa-solid fa-info-circle" style="font-size:2rem;color:#3b82f6;display:block;margin-bottom:8px"></i>
        Bạn chưa được phân công HV nào
      </div>`;
    } else {
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

      

      bodyHtml = `<div class="ms-section-body">${daysHtml}</div>`;
    }

    content.innerHTML = `
      <section class="ms-section">
        <div class="ms-section-head">
          <h2><i class="fa-solid fa-user-graduate"></i> HV bạn phụ trách</h2>
          <span class="ms-section-badge">${allStudents.size} HV</span>
          <i class="fa-solid fa-chevron-down ms-section-chevron"></i>
        </div>
        <div class="ms-description">
          <i class="fa-solid fa-circle-info"></i>
          Hãy đảm bảo HV thuộc nhóm bạn phụ trách và hãy đảm bảo giờ bạn tiếp HV đúng với lịch liệt kê.
          Nếu có sai lệch, vui lòng báo lại quản lý.
        </div>
        ${confirmBtnHtml}
        ${bodyHtml}
      </section>`;

    // Wire up collapse toggle
    content.querySelector('.ms-section-head')?.addEventListener('click', () => {
      content.querySelector('.ms-section')?.classList.toggle('collapsed');
    });

    // Wire up confirm button
    const confirmBtn = document.getElementById('msConfirmBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const week = confirmBtn.dataset.week;

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác nhận...';

        try {
          const confRes = await fetch(_DO + '/confirm-student-day', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ weekStartDate: week })
          });
          const confOut = await confRes.json();
          if (!confRes.ok || !confOut.ok) throw new Error(confOut.error || 'Lỗi');

          confirmBtn.className = 'ms-confirm-btn confirmed';
          confirmBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Đã xác nhận danh sách HV ✓';

          if (typeof showSuccessToast === 'function') {
            showSuccessToast('Đã xác nhận danh sách HV tuần này!');
          }
        } catch (e) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Xác nhận danh sách HV tuần này';
          alert('Lỗi: ' + e.message);
        }
      });
    }

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

// ========== UNIFIED CONFIRMATION STEPPER ==========

async function loadAllConfirmations() {
  if (!currentWeekMonday) return;

  const { data: { session } } = await client.auth.getSession();
  const token = session?.access_token;
  if (!token) return;

  const headers = { 'Authorization': `Bearer ${token}` };

  // Check all 3 confirmations in parallel
  const [fhRes, schRes, stuRes] = await Promise.allSettled([
    fetch(`${_DO}/confirm-free-hours?weekStartDate=${currentWeekMonday}`, { headers }).then(r => r.json()),
    fetch(`${_DO}/check-week-confirmation?weekStartDate=${currentWeekMonday}`, { headers }).then(r => r.json()),
    fetch(`${_DO}/confirm-student-day?weekStartDate=${currentWeekMonday}`, { headers }).then(r => r.json())
  ]);

  confState.freehours = !!(fhRes.status === 'fulfilled' && fhRes.value?.confirmed);
  confState.schedule = !!(schRes.status === 'fulfilled' && schRes.value?.confirmed);
  confState.students = !!(stuRes.status === 'fulfilled' && stuRes.value?.confirmed);

  updateStepperUI();
}

function updateStepperUI() {
  const steps = [
    { key: 'freehours', el: 'confStep1', num: 'confStepNum1', status: 'confStepStatus1' },
    { key: 'schedule',  el: 'confStep2', num: 'confStepNum2', status: 'confStepStatus2' },
    { key: 'students',  el: 'confStep3', num: 'confStepNum3', status: 'confStepStatus3' }
  ];

  let doneCount = 0;
  let firstPending = -1;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const el = document.getElementById(s.el);
    const numEl = document.getElementById(s.num);
    const statusEl = document.getElementById(s.status);
    if (!el) continue;

    const isDone = confState[s.key];

    el.classList.toggle('done', isDone);
    el.classList.remove('active-step');

    if (isDone) {
      numEl.innerHTML = '<i class="fa-solid fa-check" style="font-size:14px"></i>';
      statusEl.textContent = 'Đã xác nhận ✓';
      doneCount++;
    } else {
      numEl.textContent = String(i + 1);
      statusEl.textContent = 'Nhấn để xác nhận';
      if (firstPending === -1) firstPending = i;
    }
  }

  // Highlight first pending step
  if (firstPending >= 0) {
    const pendingEl = document.getElementById(steps[firstPending].el);
    if (pendingEl) pendingEl.classList.add('active-step');
  }

  // Update progress
  const progressEl = document.getElementById('confProgressText');
  const stepper = document.getElementById('confStepper');
  if (progressEl) {
    progressEl.textContent = `${doneCount} / 3`;
    progressEl.classList.toggle('all-done', doneCount === 3);
  }
  if (stepper) {
    stepper.classList.toggle('all-confirmed', doneCount === 3);
  }
}

function setupStepperClicks() {
  document.getElementById('confStep1')?.addEventListener('click', () => confirmStep('freehours'));
  document.getElementById('confStep2')?.addEventListener('click', () => confirmStep('schedule'));
  document.getElementById('confStep3')?.addEventListener('click', () => confirmStep('students'));
}

const stepInfo = {
  freehours: {
    url: _DO + '/confirm-free-hours',
    label: 'Giờ rảnh',
    title: 'Xác nhận giờ rảnh',
    msg: 'Hãy đảm bảo giờ rảnh hiện tại của bạn đã đúng và đầy đủ.<br>Nếu có thay đổi, vui lòng báo quản lý trước khi xác nhận.',
    icon: 'fa-solid fa-clock',
    colorClass: 'step-freehours'
  },
  schedule: {
    url: _DO + '/confirm-week',
    label: 'Lịch làm việc',
    title: 'Xác nhận lịch làm việc',
    msg: 'Hãy kiểm tra kỹ lịch làm việc tuần này.<br>Nếu có sai lệch, vui lòng gửi yêu cầu thay đổi trước khi xác nhận.',
    icon: 'fa-solid fa-calendar-check',
    colorClass: 'step-schedule'
  },
  students: {
    url: _DO + '/confirm-student-day',
    label: 'Danh sách HV',
    title: 'Xác nhận danh sách học viên',
    msg: 'Hãy đảm bảo HV thuộc nhóm bạn phụ trách và giờ tiếp HV đúng.<br>Nếu có sai lệch, vui lòng ghi chú trước khi xác nhận.',
    icon: 'fa-solid fa-user-graduate',
    colorClass: 'step-students'
  }
};

function confirmStep(stepKey) {
  if (confState[stepKey]) return;
  if (!currentWeekMonday) return;

  const info = stepInfo[stepKey];
  if (!info) return;

  // Show popup
  const overlay = document.getElementById('confPopupOverlay');
  const iconEl = document.getElementById('confPopupIcon');
  const titleEl = document.getElementById('confPopupTitle');
  const msgEl = document.getElementById('confPopupMsg');
  const okBtn = document.getElementById('confPopupOk');
  const cancelBtn = document.getElementById('confPopupCancel');

  iconEl.className = 'conf-popup-icon ' + info.colorClass;
  iconEl.innerHTML = `<i class="${info.icon}"></i>`;
  titleEl.textContent = info.title;
  msgEl.innerHTML = info.msg;

  overlay.classList.add('show');

  // Clean up old listeners
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  newCancel.addEventListener('click', () => overlay.classList.remove('show'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show'); }, { once: true });

  newOk.addEventListener('click', async () => {
    newOk.disabled = true;
    newOk.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác nhận...';

    try {
      const { data: { session } } = await client.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Vui lòng đăng nhập lại.');

      const res = await fetch(info.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ weekStartDate: currentWeekMonday })
      });

      const result = await res.json();
      if (!res.ok || (!result.ok && !result.confirmation)) {
        throw new Error(result.error || 'Lỗi');
      }

      confState[stepKey] = true;
      updateStepperUI();
      overlay.classList.remove('show');
      showSuccessToast(`Đã xác nhận ${info.label}!`);

    } catch (e) {
      console.error(`Confirm ${stepKey} error:`, e);
      alert('Lỗi: ' + e.message);
      newOk.disabled = false;
      newOk.innerHTML = '<i class="fa-solid fa-check"></i> Tôi xác nhận';
    }
  });
}