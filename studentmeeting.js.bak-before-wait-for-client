// studentmeeting.js
const _DO = '/api';
let client;

// NEW — guard so showApp() runs only once
let appStarted = false;


// NEW — realtime channel + debounce + reload helper
let realtimeChannel;

// NEW — event-driven refresh: only refresh at the next meeting start/end
let nextChangeTimerId = null;

// NEW — smart breakout room polling (only reloads when room availability actually changes)
let breakoutPollTimer = null;
let lastBreakoutSnapshot = '';

function stopNextChangeTimer() {
    if (nextChangeTimerId) {
        clearTimeout(nextChangeTimerId);
        nextChangeTimerId = null;
    }
}

// Convert minutes since 00:00 to today’s epoch ms in local time
function msTodayAtMinutes(mins) {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const m = Math.max(0, Math.min(mins, 24 * 60)); // clamp to [0, 1440]
    base.setMinutes(m);
    return base.getTime();
}

/**
 * Schedule a one-shot refresh at the nearest relevant boundary TODAY:
 * - start_time of a non-TTKB meeting
 * - end_time(+buffer) of a non-TTKB meeting
 * We only look at meetings that actually matter TODAY (weekly rows whose weekday === effectiveDOW, or one-time rows on today’s date).
 */
async function scheduleNextChangeTimer(effectiveDOW) {
    stopNextChangeTimer();

    const nowMs = Date.now();
    const now = new Date();
    const todayYMD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Pull candidates just once; keep this light by excluding TTKB (only "Các meeting khác")
    const { data: rows, error } = await client
        .from('meeting_content')
        .select('teacher_email, department, work_date, start_time, end_time, is_one_time')
        .neq('department', 'TTKB');

    if (error || !Array.isArray(rows)) return;

    const BUFFER_MIN = 20;
    let nextEpoch = Number.POSITIVE_INFINITY;

    for (const r of rows) {
        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        const isOne =
            r.is_one_time === true ||
            r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';

        // Only consider meetings that are relevant for TODAY
        const isForToday = isOne ? (rowYMD === todayYMD) : (rowDOW === Number(effectiveDOW));
        if (!isForToday) continue;

        const s = toMinutes(r.start_time);
        const e = toMinutes(r.end_time);
        if (s >= 0) {
            const sEpoch = msTodayAtMinutes(s);
            if (sEpoch > nowMs) nextEpoch = Math.min(nextEpoch, sEpoch);
        }
        if (e >= 0) {
            const eEpoch = msTodayAtMinutes(Math.min(e + BUFFER_MIN, 24 * 60));
            if (eEpoch > nowMs) nextEpoch = Math.min(nextEpoch, eEpoch);
        }
    }

    if (nextEpoch !== Number.POSITIVE_INFINITY) {
        const delay = Math.max(0, Math.min(nextEpoch - nowMs, 24 * 60 * 60 * 1000)); // cap ≤ 24h
        nextChangeTimerId = setTimeout(() => {
            reloadScheduleDebounced();     // ← trigger a single refresh at the boundary
        }, delay + 25); // tiny cushion to avoid edge jitter
    }
}




// Simple debounce so we don't reload too often
function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// Use this to refresh the schedule when a DB change happens
const reloadScheduleDebounced = debounce(() => {
    loadStudentSchedule().catch(console.error);
}, 350);

const DEBUG_STUDENT_MEETING = true;

// Allow a teacher to start up to N minutes after the student's class start
const TEACHER_START_TOLERANCE_MIN = 60;



document.addEventListener('DOMContentLoaded', async () => {
    const msgEl = document.getElementById('message');

    try {
        // 1) Get Supabase URL + anon key from your Netlify function
        const r = await fetch(_DO + '/supabase-credentials');
        if (!r.ok) throw new Error('Failed to load credentials');
        const { SUPABASE_URL, ANON_PUBLIC_KEY } = await r.json();

        // 2) Create Supabase client with persistent session (same pattern as index)
        client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
        });

        // 3) Initial session check → show login or app
        const { data: { session } } = await client.auth.getSession();
        if (session) {
            showApp();
        } else {
            showLogin();
        }

        // 4) Listen for sign-in/sign-out events
        client.auth.onAuthStateChange((event, sessionNow) => {
            if (event === 'SIGNED_OUT') {
                // Stop realtime when the user logs out
                if (realtimeChannel) {
                    try { client.removeChannel(realtimeChannel); } catch (e) { }
                    realtimeChannel = null;
                }
                // NEW — stop boundary timer on sign-out
                stopNextChangeTimer();

                // Stop breakout room polling
                if (breakoutPollTimer) { clearInterval(breakoutPollTimer); breakoutPollTimer = null; }

                appStarted = false; // allow showApp() to run after next sign-in
                showLogin();
                return;

            }

            // Only react to real sign-in, not “initial session”/tab switches
            if (event === 'SIGNED_IN' && sessionNow?.user) {
                showApp();
            }
            // ignore other events
        });




        // 5) Wire up the UI
        setupPasswordToggle();
        setupLoginHandler();

    } catch (e) {
        console.error(e);
        if (msgEl) msgEl.textContent = 'Không thể kết nối Supabase. Vui lòng thử lại sau.';
        showLogin();
    }
});

// --- UI helpers (mirror your main page behavior) ---
function showLogin() {
    const card = document.getElementById('loginCard');
    if (card) card.style.display = 'block';

    document.body.classList.remove('app');

    const root = document.getElementById('studentMeetingRoot');
    if (root) root.style.display = 'none';
    // Do not load the schedule when logged out



    const msgEl = document.getElementById('message');
    if (msgEl) msgEl.textContent = '';

    const email = document.getElementById('email');
    if (email) email.focus();
}

async function showApp() {
    // NEW — don’t run twice (e.g., when tab focus/auth events fire)
    if (appStarted) return;
    appStarted = true;

    const card = document.getElementById('loginCard');
    if (card) card.style.display = 'none';

    document.body.classList.add('app');

    const root = document.getElementById('studentMeetingRoot');
    if (root) root.style.display = 'block';

    // Get current user's email
    const { data: { session } } = await client.auth.getSession();
    const email = session?.user?.email || null;

    // Initial render
    // Initial render
    await loadStudentSchedule().catch(console.error);

    // Start realtime subscriptions
    if (email) setupRealtimeSubscriptions(email);

    // Smart poll: only check breakout room counts every 30s, reload only if changed
    if (breakoutPollTimer) clearInterval(breakoutPollTimer);
    breakoutPollTimer = setInterval(() => {
        pollBreakoutRooms();
    }, 30000);

    // No minute polling; boundary timer handles time-based updates


}



// --- Password eye toggle (same as index) ---
function setupPasswordToggle() {
    const toggle = document.getElementById('togglePwd');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        const pwd = document.getElementById('password');
        if (!pwd) return;
        pwd.type = pwd.type === 'password' ? 'text' : 'password';
    });
}

// --- Email/password login (same pattern as index) ---
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
            // onAuthStateChange will switch the view to showApp()
        }
    };

    btn.addEventListener('click', submit);
    document.getElementById('loginCard')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
    });
}

// Set of teacher emails for THIS student (used to filter realtime events)
let myTeacherEmails = new Set();
// Breakout teacher emails for THIS student (used for smart polling)
let myBreakoutEmails = [];

// NEW — subscribe to DB changes for this student and reload the UI
function setupRealtimeSubscriptions(studentEmail) {
    try {
        // Build the set of MY teachers so we only react to relevant changes
        client
            .from('student_schedule')
            .select('teacher_email, breakout_email')
            .ilike('student_email', studentEmail)
            .then(({ data }) => {
                myTeacherEmails = new Set();
                const bSet = new Set();
                for (const r of (data || [])) {
                    if (r.teacher_email) myTeacherEmails.add(r.teacher_email.trim().toLowerCase());
                    if (r.breakout_email) {
                        myTeacherEmails.add(r.breakout_email.trim().toLowerCase());
                        bSet.add(r.breakout_email.trim().toLowerCase());
                    }
                }
                myBreakoutEmails = [...bSet];
            });

        // If an old channel exists, remove it (avoid duplicates)
        if (realtimeChannel) {
            try { client.removeChannel(realtimeChannel); } catch (e) { }
            realtimeChannel = null;
        }

        // Create a new channel
        realtimeChannel = client.channel('studentmeeting-realtime');

        // student_schedule changes for THIS student
        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'student_schedule', filter: `student_email=eq.${studentEmail}` },
            () => reloadScheduleDebounced()
        );

        // meeting_assigned changes for THIS student
        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_assigned', filter: `student_email=eq.${studentEmail}` },
            () => reloadScheduleDebounced()
        );

        // Config tables — only reload if the change is for a teacher in THIS student's schedule
        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_links' },
            (payload) => {
                const changed = (payload.new?.teacher_email || payload.old?.teacher_email || '').toLowerCase();
                if (changed && myTeacherEmails.has(changed)) reloadScheduleDebounced();
            }
        );

        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_content' },
            (payload) => {
                const changed = (payload.new?.teacher_email || payload.old?.teacher_email || '').toLowerCase();
                if (changed && myTeacherEmails.has(changed)) reloadScheduleDebounced();
            }
        );

        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_offdays' },
            (payload) => {
                const changed = (payload.new?.teacher_email || payload.old?.teacher_email || '').toLowerCase();
                if (changed && myTeacherEmails.has(changed)) reloadScheduleDebounced();
            }
        );

        // Go live
        realtimeChannel.subscribe((status) => {
            if (DEBUG_STUDENT_MEETING) console.log('[Realtime] status:', status);
        });
    } catch (e) {
        console.error('[Realtime] subscribe error', e);
    }
}



// ---------- Student schedule loader ----------
async function loadStudentSchedule() {
    const grid = document.getElementById('scheduleGrid');
    if (!grid) return;

    // Show a small loading state
    grid.innerHTML = `
  <div class="loading" role="status" aria-live="polite">
    <div class="loading__spinner" aria-hidden="true"></div>
    <div class="loading__text">Đang tải lịch học…</div>
  </div>`;


    // Need the current user's email
    const { data: { session } } = await client.auth.getSession();
    const email = session?.user?.email || null;
    if (!email) {
        grid.innerHTML = `<div class="empty-state">Hãy đăng nhập để xem lịch.</div>`;
        return;
    }

    // Query student_schedule for this email
    const { data, error } = await client
        .from('student_schedule')
        .select('id, day_of_week, time_local, timezone, teacher_email, student_email, buoi_phu, breakout_email')
        .ilike('student_email', email)
        .order('day_of_week', { ascending: true })
        .order('time_local', { ascending: true });

    if (error) {
        grid.innerHTML = `<div class="empty-state">Không tải được dữ liệu: ${wmEscape(error.message)}</div>`;
        return;
    }

    if (DEBUG_STUDENT_MEETING) {
        const { data: { session } } = await client.auth.getSession();
        console.groupCollapsed('[student] schedule load');
        console.log('studentEmail', session?.user?.email || null);
        console.log('raw student_schedule rows:', (data || []).length);
        console.table((data || []).map(r => ({
            id: r.id,
            dow: r.day_of_week,
            time_local: String(r.time_local),
            teacher_email: String(r.teacher_email),
            buoi_phu: r.buoi_phu
        })));
        console.groupEnd();
    }



    // --- Build a distinct list of teacher emails (lower-cased) ---
    const teacherEmails = Array.from(new Set(
        (data || [])
            .map(r => (r.teacher_email || '').trim().toLowerCase())
            .filter(Boolean)
    ));

    if (DEBUG_STUDENT_MEETING) {
        console.log('[teacherEmails]', teacherEmails);
    }


    // --- Fetch meeting links + teacher names for these teachers ---
    let linkByTeacher = {};
    let nameByTeacher = {};
    if (teacherEmails.length) {
        const { data: mlinks, error: mErr } = await client
            .from('meeting_links')
            .select('teacher_email, teacher_name, link_meeting')
            .in('teacher_email', teacherEmails);

        if (!mErr && mlinks) {
            for (const row of mlinks) {
                const key = (row.teacher_email || '').trim().toLowerCase();
                if (!key) continue;
                linkByTeacher[key] = row.link_meeting || '';
                nameByTeacher[key] = row.teacher_name || '';
            }
        }
    }



    // --- Fetch teacher full names from user_roles ---

    if (teacherEmails.length) {
        const { data: roles, error: rolesErr } = await client
            .from('user_roles')
            .select('email, full_name')
            .in('email', teacherEmails);

        if (!rolesErr && roles) {
            for (const row of roles) {
                const key = (row.email || '').trim().toLowerCase();
                if (key) nameByTeacher[key] = row.full_name || '';
            }
        }
    }


    // DB day codes: 0=Sun, 1=Mon, ... 6=Sat
    const DB_DAY_LABELS = {
        0: 'Chủ nhật', 1: 'Thứ hai', 2: 'Thứ ba', 3: 'Thứ tư',
        4: 'Thứ năm', 5: 'Thứ sáu', 6: 'Thứ bảy'
    };

    // Show Sunday → Saturday (change to [1,2,3,4,5,6,0] if you prefer Monday-first)
    const DISPLAY_ORDER = [0, 1, 2, 3, 4, 5, 6];

    // CSS tint classes expect: day-1=Mon … day-7=Sun
    const dbToDisplayIndex = (dbDay) => (dbDay === 0 ? 7 : dbDay); // -> 1..7

    let html = `<div class="roster">`;
    // NEW: find today's date in Bangkok + preload today's assigned owners
    const { ymd: todayYMD, dow: todayDOW } = todayInBangkok();
    const assignedOwnersToday = await fetchAssignedOwnersForToday(client, email, todayYMD);

    // NEW: preload substitute teacher assignments for this student (today ± 7 days covers the visible week)
    const _today = new Date(todayYMD + 'T00:00:00');
    const _weekFrom = new Date(_today); _weekFrom.setDate(_today.getDate() - 7);
    const _weekTo = new Date(_today); _weekTo.setDate(_today.getDate() + 7);
    const _ymd = (d) => d.toISOString().slice(0, 10);
    const substitutesByDate = await fetchSubstitutesForStudent(email, _ymd(_weekFrom), _ymd(_weekTo));

    // Choose which row should display today's assigned meeting chips.
    // If there's no row for "today", pick the closest learning day in this week,
    // preferring the most recent past day when equally close.
    const daysWithLearningSet = new Set((data || []).map(r => Number(r.day_of_week)));

    function pickClosestDow(baseDow, daysSet) {
        // Prefer today (k=0), then nearest past, then nearest future
        for (let k = 0; k <= 6; k++) {
            const prev = (baseDow - k + 7) % 7;
            if (daysSet.has(prev)) return prev;
            const next = (baseDow + k) % 7;
            if (daysSet.has(next)) return next;
        }
        // fallback (shouldn't happen if student has any learning day)
        return baseDow;
    }

    const targetAssignedDOW = pickClosestDow(todayDOW, daysWithLearningSet);

    // NEW — if student has a grid today, use it; otherwise use the nearest grid
    const hasTodayGrid = daysWithLearningSet.has(todayDOW);
    const renderOtherDOW = hasTodayGrid ? todayDOW : targetAssignedDOW;



    html += `<div class="roster__head"><span class="head head--day"><i class="fa-regular fa-calendar"></i> Ngày</span></div>`;
    html += `<div class="roster__head"><span class="head head--time"><i class="fa-regular fa-clock"></i> Giờ học</span></div>`;
    html += `<div class="roster__head"><span class="head head--note"><i class="fa-solid fa-book-open"></i> Ghi chú</span></div>`;
    html += `<div class="roster__head"><span class="head head--main"><i class="fa-solid fa-chalkboard-user"></i> GV phụ trách chính</span></div>`;
    html += `<div class="roster__head"><span class="head head--other"><i class="fa-solid fa-people-group"></i> Các Meeting khác</span></div>`;
    html += `<div class="roster__head"><span class="head head--assign"><i class="fa-solid fa-thumbtack"></i> Meeting chỉ định</span></div>`;




    for (const dbDay of DISPLAY_ORDER) {

        const items = (data || []).filter(
            r => Number(r.day_of_week) === Number(dbDay)
        );

        if (DEBUG_STUDENT_MEETING) {
            console.groupCollapsed(`[render-day] dbDay=${dbDay}`);
            console.log('items count:', items.length);
            console.table(items.map(r => ({
                time_local: String(r.time_local),
                teacher_email: String(r.teacher_email),
                buoi_phu: r.buoi_phu
            })));
        }

        // If no learning on this day, skip rendering it entirely
        if (!items.length) {
            if (DEBUG_STUDENT_MEETING) console.groupEnd(); // close the group we just opened
            continue;
        }

        const dayClass = `day-${dbToDisplayIndex(dbDay)}`;

        // Render only days that actually have schedule items
        const todayClass = (Number(dbDay) === Number(renderOtherDOW)) ? ' day-today' : '';
        html += `<div class="roster__day ${dayClass}${todayClass}">${wmEscape(DB_DAY_LABELS[dbDay])}</div>`;

        // Show multiple entries per day on separate lines
        const times = items.map(r => timePillHTML(r.time_local)).join('<br>');

        const teachersHtml = (await Promise.all(items.map(async (r) => {
            const emailRaw = r.teacher_email || '';
            const emailKey = emailRaw.trim().toLowerCase();

            const link = ''; // TEMP: hide meeting_links URLs — was: linkByTeacher[emailKey];
            const displayName = (nameByTeacher[emailKey] || '').trim();

            const iconHtml = link
                ? `<a href="${wmEscape(link)}" target="_blank" rel="noopener noreferrer"
          class="meeting-link" title="Mở link họp">
         <i class="fa-solid fa-video" aria-hidden="true"></i>
       </a>`
                : `<span class="meeting-link meeting-link--disabled" title="Chưa có link họp">
         <i class="fa-solid fa-video" aria-hidden="true"></i>
       </span>`;

            const badgeHtml = teacherShortBadgeHTML(r.buoi_phu === true);

            const nameHtml = displayName
                ? `<span class="teacher-name">${wmEscape(displayName)}</span>`
                : `<span class="teacher-name teacher-name--muted">(Chưa cập nhật tên)</span>`;

            if (DEBUG_STUDENT_MEETING) {
                console.log('[check] teacher chip', {
                    dbDay,
                    classTime: String(r.time_local),
                    emailKey,
                    displayName
                });
            }

            // NEW: Hide teacher if they don't have a working calendar for this weekday & time
            const isWorking = await isTeacherWorkingAt(
                client,
                emailKey,
                displayName,
                Number(dbDay),
                r.time_local,
                TEACHER_START_TOLERANCE_MIN
            );

            if (!isWorking) {
                let fallbackHtml = '';
                if (Number(dbDay) === Number(todayDOW)) {
                    const isBreakout = (r.buoi_phu === true);
                    const fallbackDepts = isBreakout
                        ? ['BM', 'Breakout', 'Mix']
                        : ['BM', 'Breakout', 'Supporter', 'Mix'];
                    const fallbackTeachers = await fetchFallbackTeachersNow(client, fallbackDepts, linkByTeacher);
                    fallbackHtml = await renderFallbackTeachersHTML(fallbackTeachers, email);
                }
                return `<span class="teacher-off-badge"><i class="fa-solid fa-triangle-exclamation"></i> Hãy yêu cầu xếp lại GV</span>${fallbackHtml}`;
            }

            // NEW #3: If this row is NOT TODAY
            if (Number(dbDay) !== Number(todayDOW)) {
                const who = displayName || emailKey;

                // If this is the nearest grid row AND teacher is TTKB, show card like breakout does
                if (Number(dbDay) === Number(renderOtherDOW) && r.buoi_phu !== true) {
                    const now = new Date();
                    const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                    const isWorkingNow = await isTeacherWorkingAt(client, emailKey, displayName, Number(todayDOW), nowHHMM);

                    if (isWorkingNow) {
                        // Teacher is working RIGHT NOW — show active card
                        const tiepHvMeeting = await fetchTiepHvMeeting(emailKey);
                        if (tiepHvMeeting) {
                            return renderTiepHvMeetingCard(tiepHvMeeting, email, displayName, emailKey, false);
                        }
                    } else {
                        // Check if teacher has a shift LATER today
                        const upcomingShifts = await getTeacherUpcomingShiftsToday(client, emailKey, displayName, Number(todayDOW));
                        if (upcomingShifts.length > 0) {
                            const tiepHvMeeting = await fetchTiepHvMeeting(emailKey);
                            if (tiepHvMeeting) {
                                const notYetCardHtml = renderTiepHvMeetingCard(tiepHvMeeting, email, displayName, emailKey, true, upcomingShifts);
                                return `<div class="not-yet-section">
                                    <div class="not-yet-label"><i class="fa-solid fa-clock"></i> GV sau đây chưa tới GIỜ LÀM VIỆC</div>
                                    ${notYetCardHtml}
                                </div>`;
                            }
                        }
                    }
                }

                return '';
            }

            // NEW #2: If this row is for TODAY, also hide when it's outside working hours *right now*
            if (Number(dbDay) === Number(todayDOW)) {
                const now = new Date();
                const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                const isWorkingNow = await isTeacherWorkingAt(
                    client,
                    emailKey,
                    displayName,
                    Number(dbDay),
                    nowHHMM
                );
                if (!isWorkingNow) {
                    const who = displayName || emailKey;

                    // Check if teacher has an upcoming shift later today
                    const upcomingShifts = await getTeacherUpcomingShiftsToday(client, emailKey, displayName, Number(todayDOW));

                    if (upcomingShifts.length > 0) {
                        // Show tiep-hv card in "not yet" section (for TTKB teachers)
                        let notYetCardHtml = '';
                        if (r.buoi_phu !== true) {
                            const tiepHvMeeting = await fetchTiepHvMeeting(emailKey);
                            if (tiepHvMeeting) {
                                notYetCardHtml = renderTiepHvMeetingCard(tiepHvMeeting, email, displayName, emailKey, true, upcomingShifts);
                            }
                        }
                        return `<div class="not-yet-section">
                            <div class="not-yet-label"><i class="fa-solid fa-clock"></i> GV sau đây chưa tới GIỜ LÀM VIỆC</div>
                            ${notYetCardHtml}
                        </div>`;
                    }

                    // Shift already ended — show "Đã hết ca" as before
                    const isBreakout = (r.buoi_phu === true);
                    const fallbackDepts = isBreakout
                        ? ['BM', 'Breakout', 'Mix']
                        : ['BM', 'Breakout', 'Supporter', 'Mix'];
                    const fallbackTeachers = await fetchFallbackTeachersNow(client, fallbackDepts, linkByTeacher);
                    const fallbackHtml = await renderFallbackTeachersHTML(fallbackTeachers, email);
                    return `<span class="teacher-off-badge"><i class="fa-regular fa-circle-xmark"></i> Đã hết ca làm việc của GV ${wmEscape(who)}</span>${fallbackHtml}`;
                }

            }



            // 3) OFF-DAY check for this week's date/time
            const isOff = await isTeacherOffAt(client, emailKey, Number(dbDay), r.time_local);

            if (DEBUG_STUDENT_MEETING) {
                console.log('[check-result]', (displayName || emailKey), 'dow=', dbDay, 'class=', String(r.time_local), '→ isOff=', isOff);
            }

            let offNote = '';
            let offFallbackHtml = '';
            if (isOff) {
                offNote = `<div class="teacher-off">Teacher is off</div>`;
                const isBreakout = (r.buoi_phu === true);
                const fallbackDepts = isBreakout
                    ? ['BM', 'Breakout', 'Mix']
                    : ['BM', 'Breakout', 'Supporter', 'Mix'];
                const fallbackTeachers = await fetchFallbackTeachersNow(client, fallbackDepts, linkByTeacher);
                offFallbackHtml = await renderFallbackTeachersHTML(fallbackTeachers, email);
            }
            // For TTKB teachers (buoi_phu === false), append their tiep-hv meeting card
            let tiepHvHtml = '';
            if (r.buoi_phu !== true && !isOff) {
                const tiepHvMeeting = await fetchTiepHvMeeting(emailKey);
                if (tiepHvMeeting) {
                    tiepHvHtml = renderTiepHvMeetingCard(tiepHvMeeting, email, displayName, emailKey);
                }
            }

            // NEW: TTKB SUBSTITUTE — if a TTKB sub is assigned for this row's date, append their card
            let ttkbSubHtml = '';
            if (r.buoi_phu !== true) {
                const rowDateYMD = thisWeekYMDForDow(+dbDay);
                const sub = substitutesByDate[rowDateYMD]?.TTKB;
                if (sub && sub.substitute_teacher_email) {
                    const subEmail = String(sub.substitute_teacher_email).toLowerCase();
                    const subName = sub.substitute_teacher_name || subEmail;
                    const subMeeting = await fetchTiepHvMeeting(subEmail);
                    if (subMeeting) {
                        const subCard = renderTiepHvMeetingCard(subMeeting, email, subName, subEmail);
                        ttkbSubHtml = `<div class="sub-section" style="margin-top:8px;">
                            <div class="sub-label" style="font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">
                                <i class="fa-solid fa-user-plus"></i> GV phụ trách tạm
                            </div>
                            ${subCard}
                        </div>`;
                    }
                }
            }

            // TEMP: hide teacher name chip for TTKB — only show the tiep-hv card
            if (r.buoi_phu !== true && (tiepHvHtml || ttkbSubHtml)) {
                return `${offNote}${offFallbackHtml}${tiepHvHtml}${ttkbSubHtml}`;
            }
            return `<span class="teacher-inline">${nameHtml} ${badgeHtml} ${iconHtml}</span>${offNote}${offFallbackHtml}${tiepHvHtml}${ttkbSubHtml}`;
        }))).join('<br>');


        const notes = items.map(r => sessionBadgeHTML(!!r.buoi_phu)).join('<br>');

        // Keep the last column empty for now
        // Build "Các Meeting khác" = meetings from other departments (≠ TTKB)
        // that overlap this day/time. One line per class time.
        // NEW — Only render “Các Meeting khác” on the chosen grid:
        // - If student has a grid today → show on today’s row
        // - Else → show on the nearest grid (same logic as “Meeting chỉ định”)
        let emailsHtml = '';
        if (Number(dbDay) === Number(renderOtherDOW)) {
            const otherLines = await Promise.all(items.map(async (r) => {
                // Pass “effectiveDOW” = today; if there’s no today grid, also override classDate to today
                const matches = await getOtherMeetingsAt(client, Number(dbDay), r.time_local, {
                    effectiveDOW: todayDOW,
                    overrideClassDateToToday: !hasTodayGrid,
                    currentStudentEmail: email
                });

                if (!matches.length) return '';

                const renderedSupporters = new Set();

                const chips = await Promise.all(matches.map(async (m) => {
                    const emailKey = String(m.teacher_email || '').trim().toLowerCase();
                    const displayName = (m.teacher_name || emailKey || '').trim();

                    // fetch link on demand for “other” teachers and cache it
                    const link = ''; // TEMP: hide meeting_links URLs — was: await ensureLinkForTeacher(client, m.teacher_email, linkByTeacher);

                    const iconHtml = link
                        ? `<a href="${wmEscape(link)}" target="_blank" rel="noopener noreferrer" class="meeting-link" title="Mở link họp">
             <i class="fa-solid fa-video" aria-hidden="true"></i>
           </a>`
                        : `<span class="meeting-link meeting-link--disabled" title="Chưa có link họp">
             <i class="fa-solid fa-video" aria-hidden="true"></i>
           </span>`;

                    const dept = (m.department || '').trim();

                    // Skip Breakout teachers — they already have their own card below
                    if (dept.toLowerCase() === 'breakout' || dept.toLowerCase().includes('breakout')) return '';

                    // Supporter teachers: show a proper meeting card (like TTKB)
                    // Skip if we already rendered a card for this Supporter
                    const isSupporter = dept.toLowerCase() === 'supporter' || dept.toLowerCase().includes('support');
                    if (isSupporter) {
                        if (renderedSupporters.has(emailKey)) return '';
                        renderedSupporters.add(emailKey);
                        const supMeeting = await fetchTiepHvMeeting(emailKey);
                        if (supMeeting && supMeeting.room_name) {
                            return renderTiepHvMeetingCard(supMeeting, email, displayName, emailKey, false, [], 'Supporter');
                        }
                        // Fallback: if no meeting in meetings table, show old inline style
                        const deptBadge = departmentBadgeHTML(dept);
                        return `<span class="teacher-inline"><span class="teacher-name">${wmEscape(displayName)}</span> ${deptBadge} ${iconHtml} <span class="supporter-hint">Xử lý yêu cầu</span></span>`;
                    }

                    const deptBadge = departmentBadgeHTML(dept);

                    return `<span class="teacher-inline"><span class="teacher-name">${wmEscape(displayName)}</span> ${deptBadge} ${iconHtml}</span>`;
                }));

                return chips.join(' ');
            }));

            // one line per class time
            emailsHtml = otherLines.join('<br>');

            // NEW: Also show Jitsi breakout rooms for this student's breakout teachers
            const breakoutTeacherEmails = [...new Set(
                items
                    .map(r => (r.breakout_email || '').trim().toLowerCase())
                    .filter(Boolean)
            )];
            if (breakoutTeacherEmails.length > 0) {

                const breakoutWorkingChunks = [];
                const breakoutNotYetChunks = [];
                for (const btEmail of breakoutTeacherEmails) {
                    const tName = (nameByTeacher[btEmail] || btEmail).trim();

                    // NEW: Check if this breakout teacher is off today
                    // Use the first class time on this day as the reference time
                    const matchingItem = items.find(r => (r.breakout_email || '').toLowerCase() === btEmail);
                    const refClassTime = matchingItem?.time_local || '00:00';
                    const btIsOff = await isTeacherOffAt(client, btEmail, Number(dbDay), refClassTime);

                    if (btIsOff) {
                        // Render an "off" card (no meeting button, red status)
                        const initials = tName
                            ? tName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
                            : btEmail.slice(0, 2).toUpperCase();

                        const offCard = `<div class="tmc-card tmc-card--off">
                            <div class="tmc-header">
                                <div class="tmc-avatar" style="background:#fee2e2;color:#b91c1c;">${wmEscape(initials)}</div>
                                <div class="tmc-info">
                                    <div class="tmc-name">${wmEscape(tName)}</div>
                                    <div class="tmc-status" style="color:#b91c1c;">
                                        <span class="tmc-dot" style="background:#dc2626;"></span>
                                        GV Breakout — <strong>nghỉ hôm nay</strong>
                                    </div>
                                </div>
                            </div>
                        </div>`;
                        breakoutWorkingChunks.push(offCard);
                        continue;  // skip the rest of the loop for this teacher
                    }

                    const rooms = await fetchAvailableBreakoutRooms(btEmail);
                    if (rooms.length > 0) {
                        // Check if this breakout teacher is working RIGHT NOW
                        const now = new Date();
                        const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                        const btWorkingNow = await isTeacherWorkingAt(client, btEmail, tName, Number(todayDOW), nowHHMM);

                        if (btWorkingNow) {
                            breakoutWorkingChunks.push(renderBreakoutRoomChips(rooms, email, tName, btEmail));
                        } else {
                            // Check if teacher has a shift LATER today
                            const btUpcomingShifts = await getTeacherUpcomingShiftsToday(client, btEmail, tName, Number(todayDOW));
                            if (btUpcomingShifts.length > 0) {
                                breakoutNotYetChunks.push(renderBreakoutRoomChips(rooms, email, tName, btEmail, true, btUpcomingShifts));
                            }
                            // If shift ended or no shift → don't show at all
                        }
                    }
                }

                // NEW: BREAKOUT SUBSTITUTE — if a Breakout sub is assigned for this date, append their card
                const _rowDateYMD = thisWeekYMDForDow(+dbDay);
                const breakoutSub = substitutesByDate[_rowDateYMD]?.Breakout;
                if (breakoutSub && breakoutSub.substitute_teacher_email) {
                    const subEmail = String(breakoutSub.substitute_teacher_email).toLowerCase();
                    const subName = breakoutSub.substitute_teacher_name || subEmail;
                    const subRooms = await fetchAvailableBreakoutRooms(subEmail);
                    if (subRooms.length > 0) {
                        const subCard = renderBreakoutRoomChips(subRooms, email, subName, subEmail);
                        const wrappedSubCard = `<div class="sub-section" style="margin-top:8px;">
                            <div class="sub-label" style="font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">
                                <i class="fa-solid fa-user-plus"></i> GV phụ trách tạm
                            </div>
                            ${subCard}
                        </div>`;
                        breakoutWorkingChunks.push(wrappedSubCard);
                    }
                }

                if (breakoutWorkingChunks.length > 0) {
                    const breakoutHtml = breakoutWorkingChunks.join('');
                    emailsHtml = emailsHtml
                        ? emailsHtml + '<br>' + breakoutHtml
                        : breakoutHtml;
                }

                if (breakoutNotYetChunks.length > 0) {
                    const notYetSection = `<div class="not-yet-section">
                        <div class="not-yet-label"><i class="fa-solid fa-clock"></i> GV sau đây chưa tới GIỜ LÀM VIỆC</div>
                        ${breakoutNotYetChunks.join('')}
                    </div>`;
                    emailsHtml = emailsHtml
                        ? emailsHtml + '<br>' + notYetSection
                        : notYetSection;
                }
            }
        } else {
            emailsHtml = '';
        }

        // NEW: Meeting chỉ định = meetings assigned for TODAY only (Bangkok time)
        // Now checks teacher type: Breakout → show breakout rooms, TTKB/other → show tiep-hv card


        let assignedHtml = '';
        if (Number(dbDay) === Number(targetAssignedDOW)) {   // ← changed todayDOW → targetAssignedDOW
            const chips = [];
            for (const ownerEmail of assignedOwnersToday) {
                // Check this teacher's department to decide which card to show
                const dept = await getTeacherDepartment(client, ownerEmail);
                const deptLower = dept.toLowerCase();
                const isBreakoutTeacher = (deptLower === 'bm' || deptLower.includes('breakout'));

                if (isBreakoutTeacher) {
                    // --- Breakout teacher: show breakout rooms ---
                    const rooms = await fetchAvailableBreakoutRooms(ownerEmail);
                    // Get display name from meeting_content or user_roles
                    let bDisplayName = ownerEmail;
                    if (nameByTeacher[ownerEmail]) {
                        bDisplayName = nameByTeacher[ownerEmail];
                    } else {
                        // Try fetching from user_roles
                        const { data: urRows } = await client
                            .from('user_roles')
                            .select('full_name')
                            .ilike('email', ownerEmail)
                            .limit(1);
                        if (urRows && urRows[0]?.full_name) {
                            bDisplayName = urRows[0].full_name;
                        }
                    }

                    if (rooms.length > 0) {
                        const card = renderBreakoutRoomChips(rooms, email, bDisplayName, ownerEmail);
                        chips.push(card);
                    } else {
                        // No available rooms — show tiep-hv card as fallback
                        const m = await fetchTiepHvMeeting(ownerEmail);
                        if (m && m.room_name) {
                            const displayName = (m.display_name || bDisplayName).trim();
                            const card = renderTiepHvMeetingCard(m, email, displayName, ownerEmail, false, []);
                            chips.push(card);
                        }
                    }
                } else {
                    // --- TTKB / other teacher: show tiep-hv card (original behavior) ---
                    const m = await fetchTiepHvMeeting(ownerEmail);
                    if (!m || !m.room_name) continue;

                    const displayName = (m.display_name || ownerEmail).trim();

                    const card = renderTiepHvMeetingCard(
                        m,              // meeting object (has room_name)
                        email,          // student's email — for Jitsi pre-fill
                        displayName,    // teacher's display name
                        ownerEmail,     // teacher's email (used for avatar initials fallback)
                        false,          // notYet = false (treat as currently working)
                        []              // no upcoming shifts row needed
                    );

                    chips.push(card);
                }
            }
            assignedHtml = chips.join(' ');
        } else {
            assignedHtml = '';
        }







        html += `<div class="roster__cell roster__cell--center ${dayClass}${todayClass}">${times}</div>`;
        html += `<div class="roster__cell roster__cell--center ${dayClass}${todayClass}">${notes}</div>`;
        html += `<div class="roster__cell ${dayClass}${todayClass}">${teachersHtml}</div>`;
        html += `<div class="roster__cell ${dayClass}${todayClass}">${emailsHtml}</div>`;
        html += `<div class="roster__cell ${dayClass}${todayClass}">${assignedHtml}</div>`;
        html += `<div class="roster__sep" aria-hidden="true"></div>`;





        if (DEBUG_STUDENT_MEETING) console.groupEnd();


    }


    html += `</div>`;
    grid.innerHTML = html;

    // NEW — schedule a refresh exactly at the next relevant start/end TODAY
    // We want “Các meeting khác” to update when the clock hits those boundaries,
    // even if the DB didn’t change.
    scheduleNextChangeTimer(todayDOW).catch(console.error);


}

// === Working-hours helpers (meeting_content) ===
// Convert "HH:MM" or "HH:MM:SS" to minutes
function toMinutes(hhmm) {
    if (!hhmm) return -1;
    const raw = String(hhmm).trim();
    // handles "HH:MM", "HH:MM:SS", and "HH:MM:SS+07"
    const parts = raw.split(':');
    const h = Number(parts[0]);
    const m = Number((parts[1] || '0').replace(/[^\d]/g, '')) || 0;
    const val = (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);

    if (DEBUG_STUDENT_MEETING) {
        console.log('[toMinutes]', { input: raw, h, m, val });

    }
    return val;
}


function minsToHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 0=Sun..6=Sat from a "YYYY-MM-DD"
function weekdayFromYMD(ymd) {
    const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return -1;
    return new Date(y, m - 1, d).getDay();
}

// The next calendar date for a given weekday (0..6) from "today"
function thisWeekYMDForDow(dow) {
    // Week starts on Sunday (0). Find Sunday of *this* week, then add dow.
    const today = new Date();
    const sunday = new Date(today);
    sunday.setHours(0, 0, 0, 0);
    sunday.setDate(today.getDate() - today.getDay()); // go back to Sunday
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + Number(dow));        // move to desired weekday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


/**
 * Return true if this teacher works on the student's learning day/time.
 * Uses exact-lowercase email match first; falls back to name (ilike) if email missing.
 * IMPORTANT: column names are all lowercase in DB.
 */
// Accept a teacher if their shift overlaps the window
// [classHHMM, classHHMM + toleranceMin)
// If toleranceMin = 0, fall back to the strict check (class start ∈ [start,end))
async function isTeacherWorkingAt(client, teacherEmail, teacherName, dbDay, classHHMM, toleranceMin = 0) {
    const email = (teacherEmail || '').trim().toLowerCase();
    const name = (teacherName || '').trim();

    const classMin = toMinutes(classHHMM);
    const classDateYMD = thisWeekYMDForDow(+dbDay);
    const classWindowEnd = classMin + (toleranceMin || 0); // class start + tolerance

    function mergeRows(a = [], b = []) {
        const seen = new Set();
        const out = [];
        for (const r of [...a, ...b]) {
            const key = [
                String(r.teacher_email || '').trim().toLowerCase(),
                String(r.teacher_name || '').trim().toLowerCase(),
                String(r.work_date).slice(0, 10),
                String(r.start_time),
                String(r.end_time)
            ].join('|');
            if (!seen.has(key)) { seen.add(key); out.push(r); }
        }
        return out;
    }

    if (!email && !name) return false;

    const cols = 'teacher_email, teacher_name, work_date, start_time, end_time, is_one_time';

    let rowsByEmail = [], rowsByName = [], error = null;

    if (email) {
        const q1 = await client.from('meeting_content')
            .select(cols).ilike('teacher_email', email).limit(200);
        rowsByEmail = q1.data || [];
        if (q1.error) error = q1.error;
    }

    if (name) {
        const q2 = await client.from('meeting_content')
            .select(cols).ilike('teacher_name', `%${name}%`).limit(200);
        rowsByName = q2.data || [];
        if (q2.error && !error) error = q2.error;
    }

    const rows = mergeRows(rowsByEmail, rowsByName);
    if (error || !rows || rows.length === 0) return false;

    let matched = false;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        const s = toMinutes(r.start_time);
        const e = toMinutes(r.end_time);

        // normalize boolean
        const isOne =
            r.is_one_time === true ||
            r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';

        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        // Date/weekday gate first
        if (isOne) {
            if (rowYMD !== classDateYMD) continue;       // exact date only
        } else {
            if (rowDOW !== +dbDay) continue;             // same weekday
        }

        // Time check (tolerant overlap if toleranceMin > 0)
        let timeOk;
        if ((toleranceMin || 0) > 0) {
            const windowStart = classMin;
            const windowEnd = classWindowEnd;
            // Overlap if max(start) < min(end)
            timeOk = Math.max(s, windowStart) < Math.min(e, windowEnd);
        } else {
            // Strict: class start is inside the shift
            timeOk = (classMin >= s && classMin < e);
        }

        if (!timeOk) continue;

        matched = true;
        break;
    }

    return matched;
}


/**
 * Check if a teacher has an UPCOMING shift later today (not started yet).
 * Returns true if there is at least one shift on todayDOW that starts AFTER now.
 */
async function hasTeacherUpcomingShiftToday(client, teacherEmail, teacherName, todayDOW) {
    const email = (teacherEmail || '').trim().toLowerCase();
    const name = (teacherName || '').trim();
    if (!email && !name) return false;

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayYMD = thisWeekYMDForDow(todayDOW);

    const cols = 'start_time, end_time, work_date, is_one_time';
    let rows = [];

    if (email) {
        const { data } = await client.from('meeting_content').select(cols).ilike('teacher_email', email);
        if (data) rows = data;
    }
    if (!rows.length && name) {
        const { data } = await client.from('meeting_content').select(cols).ilike('teacher_name', `%${name}%`);
        if (data) rows = data;
    }

    return rows.some(r => {
        const isOne = r.is_one_time === true || r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';
        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        const dateOk = isOne ? (rowYMD === todayYMD) : (rowDOW === todayDOW);
        if (!dateOk) return false;

        const s = toMinutes(r.start_time);
        return s > nowMin; // shift starts AFTER current time
    });
}


/**
 * Get upcoming shift times for a teacher today (shifts that start AFTER now).
 * Returns array of { start: 'HH:MM', end: 'HH:MM' } sorted by start time.
 */
async function getTeacherUpcomingShiftsToday(client, teacherEmail, teacherName, todayDOW) {
    const email = (teacherEmail || '').trim().toLowerCase();
    const name = (teacherName || '').trim();
    if (!email && !name) return [];

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayYMD = thisWeekYMDForDow(todayDOW);

    const cols = 'start_time, end_time, work_date, is_one_time';
    let rows = [];

    if (email) {
        const { data } = await client.from('meeting_content').select(cols).ilike('teacher_email', email);
        if (data) rows = data;
    }
    if (!rows.length && name) {
        const { data } = await client.from('meeting_content').select(cols).ilike('teacher_name', `%${name}%`);
        if (data) rows = data;
    }

    const shifts = [];
    for (const r of rows) {
        const isOne = r.is_one_time === true || r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';
        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        const dateOk = isOne ? (rowYMD === todayYMD) : (rowDOW === todayDOW);
        if (!dateOk) continue;

        const s = toMinutes(r.start_time);
        if (s > nowMin) {
            shifts.push({
                start: timeHHMM(r.start_time),
                end: timeHHMM(r.end_time)
            });
        }
    }

    // Sort by start time
    shifts.sort((a, b) => a.start.localeCompare(b.start));
    return shifts;
}


async function isTeacherOffAt(client, teacherEmail, dbDay, classHHMM) {
    const email = (teacherEmail || '').trim().toLowerCase();
    if (!email) return false;

    const classMin = toMinutes(classHHMM);           // student's class start (minutes)
    const classDateYMD = thisWeekYMDForDow(+dbDay);  // YYYY-MM-DD for this week's weekday

    // 1) Check meeting_offdays (shift-specific off from meeting app)
    const { data: offRows, error } = await client
        .from('meeting_offdays')
        .select('teacher_email, off_date, start_time, end_time')
        .ilike('teacher_email', email)
        .eq('off_date', classDateYMD);

    if (!error && offRows?.length) {
        const shiftOff = offRows.some(r => {
            const s = r.start_time ? toMinutes(r.start_time) : 0;
            const e = r.end_time ? toMinutes(r.end_time) : 24 * 60;
            return classMin >= s && classMin < e;
        });
        if (shiftOff) return true;
    }

    // 2) Check offdays table (full-day off from offday app — safety fallback)
    const { data: offdayRows, error: odErr } = await client
        .from('offdays')
        .select('id')
        .eq('person_type', 'teacher')
        .ilike('person_email', email)
        .lte('off_from', classDateYMD)
        .gte('off_to', classDateYMD)
        .limit(1);

    if (!odErr && offdayRows?.length) return true;

    return false;
}

// === FALLBACK: fetch currently working teachers from specific departments ===
async function fetchFallbackTeachersNow(client, departments, linkCache = {}) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayDOW = now.getDay();
    const todayYMD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const { data: rows, error } = await client
        .from('meeting_content')
        .select('teacher_email, teacher_name, department, work_date, start_time, end_time, is_one_time');

    if (error || !rows?.length) return [];

    const deptSet = new Set(departments.map(d => d.toLowerCase()));

    const candidates = rows.filter(r => {
        const dept = String(r.department || '').trim().toLowerCase();
        const matchesDept = deptSet.has(dept) ||
            (deptSet.has('breakout') && dept.includes('breakout')) ||
            (deptSet.has('bm') && dept === 'bm');
        if (!matchesDept) return false;

        const s = toMinutes(r.start_time);
        const e = toMinutes(r.end_time);

        const isOne = r.is_one_time === true || r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';

        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        const isForToday = isOne ? (rowYMD === todayYMD) : (rowDOW === todayDOW);
        if (!isForToday) return false;

        const BUFFER_MIN = 20;
        const endWithBuffer = Math.min(e + BUFFER_MIN, 24 * 60);
        return nowMin >= s && nowMin < endWithBuffer;
    });

    if (!candidates.length) return [];

    const candidateEmails = [...new Set(candidates.map(r => String(r.teacher_email || '').trim().toLowerCase()).filter(Boolean))];

    let offNowSet = new Set();
    if (candidateEmails.length) {
        const { data: offRows } = await client
            .from('meeting_offdays')
            .select('teacher_email, off_date, start_time, end_time')
            .in('teacher_email', candidateEmails)
            .eq('off_date', todayYMD);

        if (Array.isArray(offRows)) {
            for (const orow of offRows) {
                const em = String(orow.teacher_email || '').trim().toLowerCase();
                const s = orow.start_time ? toMinutes(orow.start_time) : 0;
                const e = orow.end_time ? toMinutes(orow.end_time) : 24 * 60;
                if (nowMin >= s && nowMin < e) offNowSet.add(em);
            }
        }
    }

    // Also check full-day offdays table
    if (candidateEmails.length) {
        const { data: fullOffRows } = await client
            .from('offdays')
            .select('person_email')
            .eq('person_type', 'teacher')
            .in('person_email', candidateEmails)
            .lte('off_from', todayYMD)
            .gte('off_to', todayYMD);

        if (Array.isArray(fullOffRows)) {
            for (const o of fullOffRows) {
                offNowSet.add(String(o.person_email || '').trim().toLowerCase());
            }
        }
    }

    const seen = new Set();
    const result = [];
    for (const r of candidates) {
        const em = String(r.teacher_email || '').trim().toLowerCase();
        if (!em || seen.has(em) || offNowSet.has(em)) continue;
        seen.add(em);

        const link = ''; // TEMP: hide meeting_links URLs — was: await ensureLinkForTeacher(client, em, linkCache);
        result.push({
            teacher_email: em,
            teacher_name: (r.teacher_name || '').trim(),
            department: (r.department || '').trim(),
            link: link || ''
        });
    }

    return result;
}

async function renderFallbackTeachersHTML(fallbackTeachers, studentEmail) {
    if (!fallbackTeachers.length) return '';

    const renderedEmails = new Set();
    const cards = [];

    for (const t of fallbackTeachers) {
        const em = (t.teacher_email || '').trim().toLowerCase();
        if (renderedEmails.has(em)) continue;
        renderedEmails.add(em);

        const dept = (t.department || '').trim();
        const deptLower = dept.toLowerCase();
        const displayName = (t.teacher_name || em).trim();

        // Supporter → show tiep-hv meeting card
        if (deptLower === 'supporter' || deptLower.includes('support')) {
            const supMeeting = await fetchTiepHvMeeting(em);
            if (supMeeting && supMeeting.room_name) {
                cards.push(renderTiepHvMeetingCard(supMeeting, studentEmail, displayName, em, false, [], 'Supporter'));
                continue;
            }
        }

        // Breakout / BM → show breakout room card
        if (deptLower === 'bm' || deptLower.includes('breakout')) {
            const rooms = await fetchAvailableBreakoutRooms(em);
            if (rooms.length > 0) {
                cards.push(renderBreakoutRoomChips(rooms, studentEmail, displayName, em));
                continue;
            }
            // Fallback: try tiep-hv if no breakout rooms
            const bMeeting = await fetchTiepHvMeeting(em);
            if (bMeeting && bMeeting.room_name) {
                cards.push(renderTiepHvMeetingCard(bMeeting, studentEmail, displayName, em, false, [], 'Breakout'));
                continue;
            }
        }

        // Mix or other → show tiep-hv card if available, else old inline style
        if (deptLower === 'mix') {
            const mixMeeting = await fetchTiepHvMeeting(em);
            if (mixMeeting && mixMeeting.room_name) {
                cards.push(renderTiepHvMeetingCard(mixMeeting, studentEmail, displayName, em, false, [], 'Mix'));
                continue;
            }
        }

        // Final fallback: old inline style for teachers without meetings table entry
        const nameHtml = t.teacher_name
            ? `<span class="teacher-name">${wmEscape(t.teacher_name)}</span>`
            : `<span class="teacher-name teacher-name--muted">(Chưa cập nhật tên)</span>`;
        const deptBadge = departmentBadgeHTML(dept);
        const iconHtml = t.link
            ? `<a href="${wmEscape(t.link)}" target="_blank" rel="noopener noreferrer" class="meeting-link" title="Mở link họp">
                 <i class="fa-solid fa-video" aria-hidden="true"></i>
               </a>`
            : `<span class="meeting-link meeting-link--disabled" title="Chưa có link họp">
                 <i class="fa-solid fa-video" aria-hidden="true"></i>
               </span>`;
        cards.push(`<span class="teacher-inline">${nameHtml} ${deptBadge} ${iconHtml}</span>`);
    }

    if (!cards.length) return '';
    return `<div class="fallback-label"><i class="fa-solid fa-people-arrows"></i> GV đang làm việc:</div>${cards.join('')}`;
}

// === OTHER MEETINGS helper (meeting_content) ===
// Return meetings from departments ≠ 'TTKB' that overlap this weekday/time,
// AND only show them when the teacher is working *right now*.
// === OTHER MEETINGS helper (meeting_content) ===
// Return meetings from departments ≠ 'TTKB' that overlap this weekday/time,
// AND only show them when the teacher is working *right now*.
// NEW — supports rendering on nearest grid while still showing TODAY’s active meetings
async function getOtherMeetingsAt(client, dbDay, classHHMM, opts = {}) {
    // NEW: normalize current logged-in student's email (for Breakout guard)
    const currentStudentEmail = String(opts.currentStudentEmail || '').trim().toLowerCase();
    // dbDay: the grid row’s weekday (0..6)
    // classHHMM: the row’s class time (HH:MM)
    // opts.effectiveDOW: which weekday counts as “today” for filtering active meetings (defaults to real today)
    // opts.overrideClassDateToToday: if true, treat the class date as TODAY for one-time rows

    const classMin = toMinutes(classHHMM);              // student's class start -> minutes

    // Now (local time)
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes(); // 0..1439
    const todayDOW_real = now.getDay();                    // 0..6
    const todayYMD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const effectiveDOW = Number(opts.effectiveDOW ?? todayDOW_real);
    const overrideClassDate = !!opts.overrideClassDateToToday;

    // When not overriding: use the row’s weekday to compute the class date
    // When overriding: treat the class date as today (so one-time rows can show up “today”)
    const classDate = overrideClassDate ? todayYMD : thisWeekYMDForDow(+dbDay);

    // Pull candidate rows (non-TTKB)
    const { data: rows, error } = await client
        .from('meeting_content')
        .select('teacher_email, teacher_name, department, work_date, start_time, end_time, is_one_time')
        .neq('department', 'TTKB');

    if (error || !rows?.length) return [];

    // Build a set of teachers who are OFF right now (today)
    const teacherList = Array.from(new Set(
        rows.map(r => String(r.teacher_email || '').trim().toLowerCase()).filter(Boolean)
    ));

    let offNowSet = new Set();
    if (teacherList.length) {
        const { data: offRows } = await client
            .from('meeting_offdays')
            .select('teacher_email, off_date, start_time, end_time')
            .in('teacher_email', teacherList)
            .eq('off_date', todayYMD); // today only

        if (Array.isArray(offRows)) {
            for (const orow of offRows) {
                const email = String(orow.teacher_email || '').trim().toLowerCase();
                const s = orow.start_time ? toMinutes(orow.start_time) : 0;     // 00:00
                const e = orow.end_time ? toMinutes(orow.end_time) : 24 * 60;   // 24:00
                if (nowMin >= s && nowMin < e) offNowSet.add(email);            // off *right now*
            }
        }
    }

    const matches = rows.filter((r) => {
        const s = toMinutes(r.start_time);
        const e = toMinutes(r.end_time);

        const isOne =
            r.is_one_time === true ||
            r.is_one_time === 1 ||
            String(r.is_one_time).toLowerCase() === 'true' ||
            String(r.is_one_time).toLowerCase() === 't';

        const rowYMD = String(r.work_date).slice(0, 10);
        const rowDOW = weekdayFromYMD(r.work_date);

        // Does this meeting correspond to the student’s grid row?
        // For weekly rows: match either the row weekday or the “effective” weekday when overriding.
        const rowMatchesStudentWeekday = overrideClassDate ? (rowDOW === effectiveDOW) : (rowDOW === +dbDay);

        // Guard by the row’s date/weekday
        const dateOk = isOne
            ? (rowYMD === (overrideClassDate ? todayYMD : classDate))
            : rowMatchesStudentWeekday;

        // Only show if this meeting is happening TODAY and the teacher is currently on shift (with small buffer)
        const BUFFER_MIN = 20;
        const endWithBuffer = Math.min(e + BUFFER_MIN, 24 * 60);
        const teacherIsOnNow = (nowMin >= s && nowMin < endWithBuffer);

        // For weekly rows, “today” means rowDOW equals effectiveDOW; for one-time, rowYMD must equal today
        const isForToday = isOne ? (rowYMD === todayYMD) : (rowDOW === effectiveDOW);

        return dateOk && isForToday && teacherIsOnNow && !offNowSet.has(String(r.teacher_email || '').trim().toLowerCase());
    });




    // NEW — Breakout guard: only keep Breakout (BM/Breakout) meetings
    // if the logged-in student is actually assigned to that Breakout teacher
    let filteredMatches = matches;
    try {
        // Collect candidate Breakout teachers in this list
        const breakoutEmails = Array.from(new Set(
            matches
                .filter(m => {
                    const d = String(m.department || '').trim().toLowerCase();
                    return d === 'bm' || d.includes('breakout');
                })
                .map(m => String(m.teacher_email || '').trim().toLowerCase())
                .filter(Boolean)
        ));

        if (breakoutEmails.length && currentStudentEmail) {
            // Fetch all schedule rows for this student once
            const { data: ssRows, error: ssErr } = await client
                .from('student_schedule')
                .select('student_email, breakout_email')
                .ilike('student_email', currentStudentEmail);

            if (!ssErr && Array.isArray(ssRows)) {
                const allowedBreakoutSet = new Set(
                    ssRows
                        .map(r => String(r.breakout_email || '').trim().toLowerCase())
                        .filter(Boolean)
                );

                filteredMatches = matches.filter(m => {
                    const dept = String(m.department || '').trim().toLowerCase();
                    const isBreakout = (dept === 'bm') || dept.includes('breakout');
                    if (!isBreakout) return true; // other departments unchanged
                    const tEmail = String(m.teacher_email || '').trim().toLowerCase();
                    // Keep only if this Breakout teacher is assigned to the current student
                    return allowedBreakoutSet.has(tEmail);
                });
            } else {
                // If schedule lookup fails, hide Breakout by default (safer)
                filteredMatches = matches.filter(m => {
                    const dept = String(m.department || '').trim().toLowerCase();
                    return !(dept === 'bm' || dept.includes('breakout'));
                });
            }
        } else if (!currentStudentEmail) {
            // No student context → hide Breakout meetings entirely
            filteredMatches = matches.filter(m => {
                const dept = String(m.department || '').trim().toLowerCase();
                return !(dept === 'bm' || dept.includes('breakout'));
            });
        }
    } catch (e) {
        // On any error, fall back to hiding Breakout meetings
        filteredMatches = matches.filter(m => {
            const dept = String(m.department || '').trim().toLowerCase();
            return !(dept === 'bm' || dept.includes('breakout'));
        });
    }

    // de-dupe (use filteredMatches now)
    const seen = new Set();
    const unique = [];
    for (const r of filteredMatches) {
        const key = [
            String(r.teacher_email || '').trim().toLowerCase(),
            String(r.work_date).slice(0, 10),
            String(r.start_time),
            String(r.end_time),
        ].join('|');
        if (!seen.has(key)) { seen.add(key); unique.push(r); }
    }


    // stable order
    unique.sort((a, b) => String(a.teacher_name || '').localeCompare(String(b.teacher_name || '')));
    return unique;
}



// Return today's date (YYYY-MM-DD) and weekday (0..6) in Bangkok time
function todayInBangkok() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(now);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    const ymd = `${y}-${m}-${d}`; // YYYY-MM-DD
    const dow = new Date(`${ymd}T00:00:00+07:00`).getDay(); // 0..6 (Sun..Sat)
    return { ymd, dow };
}

// Fetch substitute teacher assignments for this student in a date range
// Returns: { 'YYYY-MM-DD': { TTKB: row, Breakout: row } }
async function fetchSubstitutesForStudent(studentEmail, fromYMD, toYMD) {
    const em = (studentEmail || '').trim().toLowerCase();
    if (!em) return {};

    try {
        const url = `${_DO}/save-temp-substitute?from_date=${fromYMD}&to_date=${toYMD}`;
        const res = await fetch(url);
        if (!res.ok) return {};

        const out = await res.json();
        const all = out.assignments || [];

        const map = {};
        for (const r of all) {
            if ((r.student_email || '').toLowerCase() !== em) continue;
            const date = r.assign_date;
            const role = r.role || 'TTKB';
            if (!map[date]) map[date] = {};
            map[date][role] = r;
        }
        return map;
    } catch (e) {
        console.error('[fetchSubstitutes] error:', e);
        return {};
    }
}

// Get unique owner emails assigned to this student for the given date
async function fetchAssignedOwnersForToday(client, studentEmail, ymd) {
    const email = (studentEmail || '').trim().toLowerCase();
    if (!email) return [];

    // Build the UTC window for "today" in Asia/Bangkok
    const startLocal = new Date(`${ymd}T00:00:00+07:00`);      // local midnight
    const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000); // next midnight
    const startUTC = startLocal.toISOString();  // e.g. 2025-10-06T17:00:00.000Z
    const endUTC = endLocal.toISOString();    // e.g. 2025-10-07T16:59:59.999Z

    const { data, error } = await client
        .from('meeting_assigned')
        .select('owner_email, assigned_date, student_email')
        .ilike('student_email', email)
        .gte('assigned_date', startUTC)
        .lt('assigned_date', endUTC);

    if (error || !Array.isArray(data)) return [];
    const owners = data
        .map(r => String(r.owner_email || '').trim().toLowerCase())
        .filter(Boolean);
    return Array.from(new Set(owners));
}


// Fetch one meeting_content row for a teacher email (name + link)
async function fetchMeetingByTeacherEmail(client, teacherEmail) {
    const email = (teacherEmail || '').trim().toLowerCase();
    if (!email) return null;
    const { data, error } = await client
        .from('meeting_content')
        .select('teacher_email, teacher_name, meeting_link')
        .ilike('teacher_email', email)
        .limit(1);

    if (error || !Array.isArray(data) || data.length === 0) return null;
    return data[0];
}


// - cache: the existing linkByTeacher object (we reuse & update it)
async function ensureLinkForTeacher(client, teacherEmail, cache = {}) {
    const key = String(teacherEmail || '').trim().toLowerCase();
    if (!key) return '';

    // If we already looked this email up, return the cached value
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
        return cache[key] || '';
    }

    // Fetch from meeting_links (case-insensitive match)
    const { data, error } = await client
        .from('meeting_links')
        .select('link_meeting')
        .ilike('teacher_email', key)
        .limit(1);

    const link = (!error && Array.isArray(data) && data[0]?.link_meeting) ? data[0].link_meeting : '';
    cache[key] = link || ''; // cache the result (even empty) to avoid repeat queries
    return link;
}


// === BREAKOUT ROOM PICKER (from Jitsi meetings table) ===

// Fetch available breakout rooms for a teacher
async function fetchAvailableBreakoutRooms(teacherEmail) {
    const em = (teacherEmail || '').trim().toLowerCase();
    if (!em) return [];
    try {
        const { data: { session } } = await client.auth.getSession();
        const token = session?.access_token || '';
        if (!token) return [];

        const res = await fetch(
            _DO + '/breakout-rooms?teacher_email=' + encodeURIComponent(em),
            { headers: { Authorization: 'Bearer ' + token } }
        );
        if (!res.ok) return [];
        const result = await res.json();
        return Array.isArray(result) ? result : [];
    } catch (e) {
        console.error('[breakout-rooms] fetch error:', e);
        return [];
    }
}

// Fetch the tiep-hv meeting for a TTKB teacher
async function fetchTiepHvMeeting(teacherEmail) {
    const em = (teacherEmail || '').trim().toLowerCase();
    if (!em) return null;
    try {
        const { data: { session } } = await client.auth.getSession();
        const token = session?.access_token || '';
        if (!token) return null;

        const res = await fetch(
            _DO + '/tiep-hv-meeting?teacher_email=' + encodeURIComponent(em),
            { headers: { Authorization: 'Bearer ' + token } }
        );
        if (!res.ok) return null;
        const result = await res.json();
        return (result && result.room_name) ? result : null;
    } catch (e) {
        console.error('[tiep-hv-meeting] fetch error:', e);
        return null;
    }
}

// Shared helper: build upcoming shifts HTML for both TTKB and Breakout cards
function buildUpcomingShiftsHtml(upcomingShifts, notYet) {
    if (!notYet || !upcomingShifts || !upcomingShifts.length) return '';

    const shiftBadges = upcomingShifts.map(s =>
        `<span class="tmc-shift-badge"><i class="fa-regular fa-clock"></i> ${s.start} — ${s.end}</span>`
    ).join('');

    return `<div class="tmc-upcoming-shifts">
        <div class="tmc-shifts-label">Sẽ bắt đầu làm việc vào:</div>
        <div class="tmc-shifts-list">${shiftBadges}</div>
    </div>`;
}

// Detect teacher's department from meeting_content (for GV chỉ định)
async function getTeacherDepartment(client, teacherEmail) {
    const em = (teacherEmail || '').trim().toLowerCase();
    if (!em) return '';
    const { data, error } = await client
        .from('meeting_content')
        .select('department')
        .ilike('teacher_email', em)
        .limit(1);
    if (error || !data || !data.length) return '';
    return (data[0].department || '').trim();
}

// Render a card for TTKB teacher's main meeting (tiep-hv type)
function renderTiepHvMeetingCard(meeting, studentEmail, teacherName, teacherEmail, notYet = false, upcomingShifts = [], roleLabel = 'TTKB') {
    if (!meeting || !meeting.room_name) return '';

    const displayName = (teacherName || '').trim();
    const emailUsername = teacherEmail ? teacherEmail.split('@')[0].toLowerCase() : '';

    const initials = displayName
        ? displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
        : emailUsername.slice(0, 2).toUpperCase();

    let mainUrl = 'https://meeting.tansinh.info/' + meeting.room_name;
    if (studentEmail) {
        mainUrl += '#userInfo.email=%22' + encodeURIComponent(studentEmail) + '%22'
                 + '&userInfo.displayName=%22' + encodeURIComponent(studentEmail) + '%22';
    }

    const mainBtn = `<a href="${wmEscape(mainUrl)}" target="_blank" rel="noopener noreferrer" class="tmc-main-btn">
           <i class="fa-solid fa-headset"></i> Meeting chính <i class="fa-solid fa-arrow-up-right-from-square tmc-main-arrow"></i>
       </a>`;

    const cardClass = notYet ? 'tmc-card tmc-card--not-yet' : 'tmc-card';
    const dotClass = notYet ? 'tmc-dot tmc-dot--not-yet' : 'tmc-dot';
    const statusText = notYet ? `GV ${roleLabel} — chưa tới giờ làm việc` : `GV ${roleLabel} — đang làm việc`;

    // Build upcoming shifts text
    const shiftsHtml = buildUpcomingShiftsHtml(upcomingShifts, notYet);

    return `<div class="${cardClass}">
        <div class="tmc-header">
            <div class="tmc-avatar">${wmEscape(initials)}</div>
            <div class="tmc-info">
                <div class="tmc-name">${wmEscape(displayName || emailUsername)}</div>
                <div class="tmc-status"><span class="${dotClass}"></span> ${statusText}</div>
            </div>
            ${mainBtn}
        </div>
        ${shiftsHtml}
    </div>`;
}

// Smart poll: only fetch breakout room counts, reload page only if availability changed
async function pollBreakoutRooms() {
    if (!myBreakoutEmails.length) return; // no breakout teachers → nothing to poll
    try {
        const allRoomNames = [];
        for (const btEmail of myBreakoutEmails) {
            const rooms = await fetchAvailableBreakoutRooms(btEmail);
            for (const r of rooms) {
                allRoomNames.push(r.room_name);
            }
        }
        // Build a snapshot string to compare
        const snapshot = allRoomNames.sort().join(',');
        if (snapshot !== lastBreakoutSnapshot) {
            lastBreakoutSnapshot = snapshot;
            reloadScheduleDebounced(); // something changed → reload
        }
    } catch (e) {
        console.error('[pollBreakoutRooms] error:', e);
    }
}

// Render teacher meeting card (E1 design) with Meeting chính + breakout rooms
function renderBreakoutRoomChips(rooms, studentEmail, teacherName, teacherEmail, notYet = false, upcomingShifts = []) {
    if (!rooms.length) return '';

    const displayName = (teacherName || '').trim();
    const emailUsername = teacherEmail ? teacherEmail.split('@')[0].toLowerCase() : '';

    // Teacher initials for avatar (take first letter of each word, max 2)
    const initials = displayName
        ? displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
        : emailUsername.slice(0, 2).toUpperCase();

    // --- Meeting chính URL (main room = email username) ---
    let mainUrl = '';
    if (emailUsername) {
        mainUrl = 'https://meeting.tansinh.info/' + emailUsername;
        if (studentEmail) {
            mainUrl += '#userInfo.email=%22' + encodeURIComponent(studentEmail) + '%22'
                + '&userInfo.displayName=%22' + encodeURIComponent(studentEmail) + '%22';
        }
    }

    // --- Breakout room grid items ---
    const roomItems = rooms.map(room => {
        let url = 'https://meeting.tansinh.info/' + room.room_name;
        if (studentEmail) {
            url += '#userInfo.email=%22' + encodeURIComponent(studentEmail) + '%22'
                + '&userInfo.displayName=%22' + encodeURIComponent(studentEmail) + '%22';
        }
        const parts = room.room_name.split('_');
        const roomNum = parts[parts.length - 1];
        return `<a href="${wmEscape(url)}" target="_blank" rel="noopener noreferrer"
                   class="tmc-room-btn" title="${wmEscape(room.room_name)}">${wmEscape(roomNum)}</a>`;
    }).join('');

    // --- Meeting chính button ---
    const mainBtn = mainUrl
        ? `<a href="${wmEscape(mainUrl)}" target="_blank" rel="noopener noreferrer" class="tmc-main-btn">
               <i class="fa-solid fa-headset"></i> Meeting chính <i class="fa-solid fa-arrow-up-right-from-square tmc-main-arrow"></i>
           </a>`
        : '';

    // --- Build the card ---
    const cardClass = notYet ? 'tmc-card tmc-card--not-yet' : 'tmc-card';
    const dotClass = notYet ? 'tmc-dot tmc-dot--not-yet' : 'tmc-dot';
    const statusText = notYet ? 'GV Breakout — chưa tới giờ làm việc' : 'GV Breakout — đang làm việc';

    // Build upcoming shifts text
    const shiftsHtml = buildUpcomingShiftsHtml(upcomingShifts, notYet);

    return `<div class="${cardClass}">
        <div class="tmc-header">
            <div class="tmc-avatar">${wmEscape(initials)}</div>
            <div class="tmc-info">
                <div class="tmc-name">${wmEscape(displayName || emailUsername)}</div>
                <div class="tmc-status"><span class="${dotClass}"></span> ${statusText}</div>
            </div>
            ${mainBtn}
        </div>
        <div class="tmc-rooms">
            <div class="tmc-rooms-label">Chọn phòng Breakout trống:</div>
            <div class="tmc-rooms-grid">${roomItems}</div>
        </div>
        ${shiftsHtml}
    </div>`;
}


// --- UI helpers for badges and time pill ---
function sessionBadgeHTML(isAux) {
    // Used in the "Ghi chú" column
    return isAux
        ? `<span class="badge badge--aux"><i class="fa-solid fa-puzzle-piece"></i> Buổi phụ</span>`
        : `<span class="badge badge--main"><i class="fa-solid fa-book-open"></i> Buổi chính</span>`;
}

function teacherShortBadgeHTML(isAux) {
    // Used next to the teacher name chip (old style: TTKB / BM)
    return isAux
        ? `<span class="teacher-badge teacher-badge--bm" title="Buổi phụ = BM/Breakout">BM/ Breakout</span>`
        : `<span class="teacher-badge teacher-badge--ttkb" title="Buổi chính = TTKB">TTKB</span>`;
}


// Map department text → colored badge for "Các Meeting khác"
function departmentBadgeHTML(dept) {
    const d = String(dept || '').trim().toLowerCase();
    if (!d) return '';

    // Keep BM as "BM"
    if (d === 'bm') {
        return `<span class="teacher-badge teacher-badge--bm">BM</span>`;
    }

    // Show "Breakout" when department contains "breakout"
    // Reuse the same BM style class to avoid CSS changes
    if (d.includes('breakout')) {
        return `<span class="teacher-badge teacher-badge--bm">Breakout</span>`;
    }

    if (d === 'mix') {
        return `<span class="teacher-badge teacher-badge--mix">Mix</span>`;
    }
    if (d === 'supporter' || d.includes('support')) {
        return `<span class="teacher-badge teacher-badge--supporter">Supporter</span>`;
    }

    // Fallback: show the original text
    return `<span class="teacher-badge">${wmEscape(dept)}</span>`;
}


function timePillHTML(t) {
    return `<span class="time-pill"><i class="fa-solid fa-clock"></i> ${timeHHMM(t)}</span>`;
}


// Small helpers (reuse pattern/naming from your main script’s utils)
function timeHHMM(t) {
    // Postgres TIME usually comes "HH:MM:SS" -> make "HH:MM"
    if (!t) return '';
    const [h, m] = String(t).split(':');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function wmEscape(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Optional cleanup
window.addEventListener('beforeunload', () => {
    stopNextChangeTimer(); // boundary timer only
    if (breakoutPollTimer) { clearInterval(breakoutPollTimer); breakoutPollTimer = null; }
    if (realtimeChannel) {
        try { client.removeChannel(realtimeChannel); } catch (e) { }
        realtimeChannel = null;
    }
});