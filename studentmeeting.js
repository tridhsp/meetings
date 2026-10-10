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



    // === tansinh sm-v2: header + rows (10 Oct 2026) — see renderScheduleRowsV2 at the end of this file ===
    html += `<div class="roster__head"><span class="head head--day"><i class="fa-regular fa-calendar"></i> Ngày</span></div>`;
    html += `<div class="roster__head"><span class="head head--time"><i class="fa-regular fa-clock"></i> Giờ học</span></div>`;
    html += `<div class="roster__head"><span class="head head--note"><i class="fa-solid fa-book-open"></i> Ghi chú</span></div>`;
    html += `<div class="roster__head"><span class="head head--main"><i class="fa-solid fa-door-open"></i> Vào lớp với ai?</span></div>`;
    html += `<div class="roster__head"><span class="head head--other"><i class="fa-solid fa-people-group"></i> Meeting khác &amp; GV hỗ trợ</span></div>`;

    html += await renderScheduleRowsV2({
        client,
        data: (data || []),
        studentEmail: email,
        nameByTeacher,
        linkByTeacher,
        DB_DAY_LABELS,
        DISPLAY_ORDER,
        dbToDisplayIndex,
        todayYMD,
        todayDOW,
        assignedOwnersToday,
        substitutesByDate,
        hasTodayGrid,
        renderOtherDOW,
        targetAssignedDOW
    });
    // === tansinh sm-v2: end of header + rows ===


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
// === tansinh sm-v2 BEGIN (10 Oct 2026) ===
// "Vào lớp với ai?" — ONE resolved answer per class slot, with a reason the
// learner can read. Replaces the old three right-hand columns.
//
// Who is shown on the LIVE row (today, or the nearest learning day when there
// is no class today), in this order:
//   1. Meeting chỉ định (meeting_assigned)  — staff pinned a meeting for today
//   2. GV dạy thay ("Tạm", save-temp-substitute) for this row's role
//   3. GV phụ trách of the row — if working now, or later today
//   4. the learner's OWN GV Breakout, all of them (1 or 2) — when the main
//      teacher is off, has no shift at this slot, or the shift already ended
//   5. nobody → the "Gọi hỗ trợ" badge (ringts.tansinh.info, new tab)
//
// Everything here REUSES the existing helpers in this file (isTeacherOffAt,
// isTeacherWorkingAt, getTeacherUpcomingShiftsToday, fetchTiepHvMeeting,
// fetchAvailableBreakoutRooms, getOtherMeetingsAt, getTeacherDepartment,
// renderTiepHvMeetingCard, renderBreakoutRoomChips). Nothing above was changed
// except the row loop inside loadStudentSchedule(), which now calls
// renderScheduleRowsV2().

const SM_V2 = {
    SUPPORT_URL: 'https://ringts.tansinh.info/',
    SHOW_PLANNED_ON_OTHER_DAYS: true,   // one-word switch: names + notes on days that are not today
    SHOW_DATE_UNDER_DAY: true,          // dd/mm under the day name
    FALLBACK_NEEDS_SHIFT: true          // a breakout teacher is offered as the fallback ONLY if they have a
                                        // shift today (working now, or starting later). false = offer them
                                        // anyway when they have a room, with an honest note under the card.
};

// Next date (today or later) that falls on weekday dow (0=Sun..6=Sat)
function smNextYMDForDow(dow, todayYMD) {
    const t = new Date(String(todayYMD) + 'T00:00:00');
    const diff = (Number(dow) - t.getDay() + 7) % 7;
    t.setDate(t.getDate() + diff);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function smAddDays(ymd, n) {
    const t = new Date(String(ymd) + 'T00:00:00');
    t.setDate(t.getDate() + Number(n));
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function smDDMM(ymd) {
    const s = String(ymd || '');
    return s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '';
}

function smLower(s) {
    return String(s || '').trim().toLowerCase();
}

function smInitials(name, email) {
    const n = String(name || '').trim();
    if (n) return n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return String(email || '').split('@')[0].slice(0, 2).toUpperCase();
}

function smNowHHMM() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// The status strip: one coloured line that tells the learner what is going on.
// kind: ok | soon | sub | assigned | fallback | call | info | off
function smStripHTML(kind, innerHtml) {
    const icons = {
        ok: 'fa-circle-check', soon: 'fa-clock', sub: 'fa-user-plus', assigned: 'fa-thumbtack',
        fallback: 'fa-people-arrows', call: 'fa-phone-volume', info: 'fa-circle-info', off: 'fa-user-slash'
    };
    const icon = icons[kind] || 'fa-circle-info';
    return `<div class="sm-strip sm-strip--${kind}"><i class="fa-solid ${icon}"></i><span>${innerHtml}</span></div>`;
}

// The call-for-support badge. Opens ringts.tansinh.info in a NEW tab.
// soft=true is the calm version (no class today, nobody around) — same button.
function smCallBadgeHTML(reasonHtml, soft) {
    return `<div class="sm-call${soft ? ' sm-call--soft' : ''}">
        <div class="sm-call__text"><i class="fa-solid ${soft ? 'fa-circle-info' : 'fa-triangle-exclamation'}"></i> ${reasonHtml}</div>
        <a class="sm-call__btn" href="${wmEscape(SM_V2.SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">
            <i class="fa-solid fa-phone-volume"></i> Gọi hỗ trợ
        </a>
        <div class="sm-call__hint">Trang gọi mở trong tab mới. Bấm nút gọi, rồi nói tên và buổi học của bạn — chúng tôi sẽ xếp giáo viên cho bạn ngay.</div>
    </div>`;
}

// A small card for a teacher we cannot send the learner to (off, or no room).
// tone: 'off' (red) | 'noroom' (grey)
function smOffCardHTML(name, email, roleLabel, noteHtml, tone) {
    const t = tone || 'off';
    const initials = smInitials(name, email);
    return `<div class="tmc-card tmc-card--off sm-offcard sm-offcard--${t}">
        <div class="tmc-header">
            <div class="tmc-avatar sm-offcard__avatar">${wmEscape(initials)}</div>
            <div class="tmc-info">
                <div class="tmc-name">${wmEscape(name || email)}</div>
                <div class="tmc-status sm-offcard__status"><span class="tmc-dot sm-offcard__dot"></span> GV ${wmEscape(roleLabel)} — ${noteHtml}</div>
            </div>
        </div>
    </div>`;
}

// A labelled group of cards: "GV dạy thay", "Meeting được chỉ định", ...
function smSectionHTML(kind, labelHtml, cardsHtml) {
    if (!cardsHtml) return '';
    return `<div class="sm-section sm-section--${kind}"><div class="sm-section__label">${labelHtml}</div>${cardsHtml}</div>`;
}

// --- off-day window for the planned rows (one fetch, in-memory checks) ---
async function smFetchOffWindow(client, fromYMD, toYMD) {
    const out = { shift: [], full: [] };
    try {
        const { data: mo } = await client
            .from('meeting_offdays')
            .select('teacher_email, off_date, start_time, end_time')
            .gte('off_date', fromYMD)
            .lte('off_date', toYMD);
        out.shift = (mo || []).map(r => ({
            em: smLower(r.teacher_email),
            date: String(r.off_date || '').slice(0, 10),
            s: r.start_time ? toMinutes(r.start_time) : 0,
            e: r.end_time ? toMinutes(r.end_time) : 24 * 60
        }));
        const { data: fo } = await client
            .from('offdays')
            .select('person_email, off_from, off_to')
            .eq('person_type', 'teacher')
            .lte('off_from', toYMD)
            .gte('off_to', fromYMD);
        out.full = (fo || []).map(r => ({
            em: smLower(r.person_email),
            from: String(r.off_from || '').slice(0, 10),
            to: String(r.off_to || '').slice(0, 10)
        }));
    } catch (e) {
        console.error('[sm-v2] off window fetch error', e);
    }
    return out;
}

function smIsOffOn(offWindow, email, ymd, classMin) {
    const em = smLower(email);
    if (!em) return false;
    if (offWindow.shift.some(r => r.em === em && r.date === ymd && classMin >= r.s && classMin < r.e)) return true;
    if (offWindow.full.some(r => r.em === em && r.from <= ymd && ymd <= r.to)) return true;
    return false;
}

// Fill in names for emails the page did not know yet (breakout teachers,
// assigned owners). Writes into the shared nameByTeacher map.
async function smFillNames(client, nameByTeacher, emails) {
    const missing = [...new Set(emails.map(smLower).filter(e => e && !nameByTeacher[e]))];
    if (!missing.length) return;
    try {
        const { data } = await client.from('user_roles').select('email, full_name').in('email', missing);
        for (const row of (data || [])) {
            const key = smLower(row.email);
            if (key && row.full_name) nameByTeacher[key] = row.full_name;
        }
    } catch (e) {
        console.error('[sm-v2] name fill error', e);
    }
}

// What is this teacher doing TODAY? Every check is against today's date.
// strictSlot=true also asks "does the teacher have a shift at the class time?"
async function smTeacherStatusToday(ctx, emailKey, displayName, classTime, strictSlot) {
    const { client, todayDOW } = ctx;
    const st = { off: false, slotOk: true, workingNow: false, upcoming: [], ended: false };
    if (!emailKey) return st;
    st.off = await isTeacherOffAt(client, emailKey, todayDOW, classTime);
    if (st.off) return st;
    if (strictSlot) {
        st.slotOk = await isTeacherWorkingAt(client, emailKey, displayName, todayDOW, classTime, TEACHER_START_TOLERANCE_MIN);
    }
    st.workingNow = await isTeacherWorkingAt(client, emailKey, displayName, todayDOW, smNowHHMM());
    if (!st.workingNow) st.upcoming = await getTeacherUpcomingShiftsToday(client, emailKey, displayName, todayDOW);
    // "any shift at all today?" — only asked when nothing is live or upcoming
    st.anyToday = (st.workingNow || st.upcoming.length > 0)
        ? true
        : await isTeacherWorkingAt(client, emailKey, displayName, todayDOW, '00:00', 24 * 60);
    st.noShift = !st.anyToday;                                           // no shift today at all
    st.ended = st.anyToday && !st.workingNow && st.upcoming.length === 0; // worked today, done now
    return st;
}

function smAvailable(st) {
    return !!st && !st.off && st.slotOk && (st.workingNow || st.upcoming.length > 0);
}

// One sentence that says WHY a teacher is not the answer right now.
function smWhyNot(st, name, classTime, relaxed) {
    const who = `GV phụ trách <b>${wmEscape(name)}</b>`;
    if (!st) return `Buổi này <b>chưa có GV phụ trách</b>.`;
    if (st.off) return `${who} <b>nghỉ hôm nay</b>.`;
    if (st.noShift) return `${who} <b>chưa có lịch làm việc hôm nay</b>.`;
    if (!st.slotOk && !relaxed) return `${who} không có lịch làm việc vào giờ học của bạn (<b>${wmEscape(classTime)}</b>).`;
    if (st.ended) return `Ca làm việc hôm nay của ${who} <b>đã kết thúc</b>.`;
    return `${who} hiện không làm việc.`;
}

// Short reason for a grey card
function smShortWhy(st, classTime, relaxed) {
    if (st.off) return '<strong>nghỉ hôm nay</strong>';
    if (st.noShift) return 'chưa có lịch làm việc hôm nay';
    if (!st.slotOk && !relaxed) return `không có lịch vào ${wmEscape(classTime)}`;
    if (st.ended) return 'ca hôm nay đã kết thúc';
    return 'hiện không làm việc';
}

// Build the join card for ONE teacher. Returns { html, joinable }.
// kind: 'breakout' looks for free breakout rooms first; 'ttkb' goes straight to
// the teacher's main (tiep-hv) meeting.
async function smTeacherCard(ctx, emailKey, displayName, kind, st, roleLabel) {
    const { studentEmail } = ctx;
    const name = String(displayName || '').trim();
    const notYet = !st.workingNow && st.upcoming.length > 0;
    if (st.off) {
        return { html: smOffCardHTML(name, emailKey, roleLabel, '<strong>nghỉ hôm nay</strong>', 'off'), joinable: false };
    }
    if (kind === 'breakout') {
        const rooms = await fetchAvailableBreakoutRooms(emailKey);
        if (rooms.length > 0) {
            return { html: renderBreakoutRoomChips(rooms, studentEmail, name, emailKey, notYet, st.upcoming), joinable: true };
        }
    }
    const m = await fetchTiepHvMeeting(emailKey);
    if (m && m.room_name) {
        const shown = name || String(m.display_name || '').trim();
        return { html: renderTiepHvMeetingCard(m, studentEmail, shown, emailKey, notYet, st.upcoming, roleLabel), joinable: true };
    }
    return { html: smOffCardHTML(name, emailKey, roleLabel, 'chưa có phòng meeting', 'noroom'), joinable: false };
}

// Meeting chỉ định — staff pinned a meeting for this learner today.
async function smAssignedHTML(ctx) {
    const { client, nameByTeacher, assignedOwnersToday } = ctx;
    const cards = [];
    for (const ownerEmail of (assignedOwnersToday || [])) {
        const dept = await getTeacherDepartment(client, ownerEmail);
        const d = dept.toLowerCase();
        const isB = (d === 'bm' || d.includes('breakout'));
        const name = (nameByTeacher[ownerEmail] || '').trim();
        // Staff assigned it for today: treat the teacher as live, no shift checks.
        const st = { off: false, slotOk: true, workingNow: true, upcoming: [], ended: false };
        const card = await smTeacherCard(ctx, ownerEmail, name, isB ? 'breakout' : 'ttkb', st, dept || 'GV');
        cards.push(card.html);
    }
    return cards.join('');
}

// "Các meeting khác": Supporter / Mix teachers who are on shift right now and
// overlap this class slot. (Breakout teachers are skipped — they have their
// own cards.) Ported from the old loop, unchanged in behaviour.
async function smOtherMeetingsHTML(ctx, dbDay, timeLocal, renderedEmails) {
    const { client, studentEmail, todayDOW, hasTodayGrid } = ctx;
    const matches = await getOtherMeetingsAt(client, Number(dbDay), timeLocal, {
        effectiveDOW: todayDOW,
        overrideClassDateToToday: !hasTodayGrid,
        currentStudentEmail: studentEmail
    });
    if (!matches.length) return '';

    const chips = [];
    for (const m of matches) {
        const emailKey = smLower(m.teacher_email);
        const displayName = (m.teacher_name || emailKey || '').trim();
        const dept = String(m.department || '').trim();
        const dl = dept.toLowerCase();
        if (dl === 'bm' || dl.includes('breakout')) continue;      // own cards elsewhere
        if (!emailKey || renderedEmails.has(emailKey)) continue;
        renderedEmails.add(emailKey);

        const isSupporter = dl === 'supporter' || dl.includes('support');
        const meeting = await fetchTiepHvMeeting(emailKey);
        if (meeting && meeting.room_name) {
            const label = isSupporter ? 'Supporter' : (dl === 'mix' ? 'Mix' : (dept || 'GV'));
            chips.push(renderTiepHvMeetingCard(meeting, studentEmail, displayName, emailKey, false, [], label));
            continue;
        }
        const deptBadge = departmentBadgeHTML(dept);
        const hint = isSupporter ? ' <span class="supporter-hint">Xử lý yêu cầu</span>' : '';
        chips.push(`<span class="teacher-inline"><span class="teacher-name">${wmEscape(displayName)}</span> ${deptBadge}${hint}</span>`);
    }
    return chips.join('');
}

// ---------- the LIVE day: today, or the nearest learning day ----------
async function smRenderLiveDay(ctx, items, dbDay) {
    const { nameByTeacher, todayYMD, todayDOW, hasTodayGrid, DB_DAY_LABELS } = ctx;
    const relaxed = !hasTodayGrid;             // no class today: show who is around, do not alarm
    const subs = ctx.substitutesByDate[todayYMD] || {};
    const ttkbSub = (subs.TTKB && subs.TTKB.substitute_teacher_email) ? subs.TTKB : null;
    const brSub = (subs.Breakout && subs.Breakout.substitute_teacher_email) ? subs.Breakout : null;

    // this learner's own breakout teachers on this day
    const breakoutEmails = [...new Set(items.map(r => smLower(r.breakout_email)).filter(Boolean))];

    // small caches so two slots on one day do not ask the server twice
    const stCache = new Map();
    const statusOf = async (em, name, classTime, strict) => {
        const key = `${em}|${classTime}|${strict ? 1 : 0}`;
        if (!stCache.has(key)) stCache.set(key, await smTeacherStatusToday(ctx, em, name, classTime, strict));
        return stCache.get(key);
    };

    const cardCache = new Map();
    const cardOf = async (em, name, kind, st, label) => {
        const key = `${em}|${kind}|${label}|${st.off ? 1 : 0}|${st.workingNow ? 1 : 0}`;
        if (!cardCache.has(key)) cardCache.set(key, await smTeacherCard(ctx, em, name, kind, st, label));
        return cardCache.get(key);
    };

    const assignedHtml = await smAssignedHTML(ctx);
    const usedBreakout = new Set();             // breakout teachers already shown in the main column
    const slotBlocks = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isAux = (item.buoi_phu === true);
        const roleLabel = isAux ? 'Breakout' : 'TTKB';
        const mainEmail = smLower(item.teacher_email);
        const mainName = (nameByTeacher[mainEmail] || '').trim() || mainEmail;
        const classTime = timeHHMM(item.time_local);

        const blocks = [];
        let strip = '';

        // (1) Meeting chỉ định — pinned once, at the first slot
        if (i === 0 && assignedHtml) {
            blocks.push(smSectionHTML('assigned', '<i class="fa-solid fa-thumbtack"></i> Meeting được chỉ định cho bạn hôm nay', assignedHtml));
            strip = smStripHTML('assigned', `Hôm nay bạn được <b>chỉ định</b> vào meeting bên dưới. Hãy vào đó trước.`);
        }

        // (2) GV dạy thay for THIS row's role
        const sub = isAux ? brSub : ttkbSub;
        let subCard = null;
        if (sub) {
            const subEmail = smLower(sub.substitute_teacher_email);
            const subName = sub.substitute_teacher_name || nameByTeacher[subEmail] || subEmail;
            const subSt = await statusOf(subEmail, subName, classTime, false);
            subCard = await cardOf(subEmail, subName, isAux ? 'breakout' : 'ttkb', subSt, 'dạy thay');
            if (isAux) usedBreakout.add(subEmail);
            blocks.push(smSectionHTML('sub', '<i class="fa-solid fa-user-plus"></i> GV dạy thay hôm nay', subCard.html));
            if (!strip) {
                strip = subCard.joinable
                    ? smStripHTML('sub', `Hôm nay GV <b>${wmEscape(subName)}</b> dạy thay. Vào meeting của GV ${wmEscape(subName)} bên dưới.`)
                    : smStripHTML('off', `GV dạy thay <b>${wmEscape(subName)}</b> hiện không thể nhận bạn.`);
            }
        }

        // (3) GV phụ trách of this row
        let mainSt = null;
        let mainCard = null;
        if (mainEmail) {
            mainSt = await statusOf(mainEmail, mainName, classTime, !relaxed);
            if (smAvailable(mainSt)) {
                mainCard = await cardOf(mainEmail, mainName, isAux ? 'breakout' : 'ttkb', mainSt, roleLabel);
                if (isAux) usedBreakout.add(mainEmail);
                blocks.push(smSectionHTML('main', `<i class="fa-solid fa-chalkboard-user"></i> GV phụ trách (${wmEscape(roleLabel)})`, mainCard.html));
                if (!strip) {
                    if (!mainCard.joinable) {
                        strip = smStripHTML('fallback', `GV phụ trách <b>${wmEscape(mainName)}</b> đang làm việc nhưng <b>chưa có phòng meeting</b>. Hãy vào tạm với GV Breakout bên dưới, hoặc gọi hỗ trợ.`);
                    } else if (mainSt.workingNow) {
                        strip = smStripHTML('ok', `GV phụ trách <b>${wmEscape(mainName)}</b> đang làm việc — bấm <b>Meeting chính</b> để vào lớp.`);
                    } else {
                        const first = mainSt.upcoming[0];
                        strip = smStripHTML('soon', `GV phụ trách <b>${wmEscape(mainName)}</b> chưa tới giờ làm việc — sẽ bắt đầu lúc <b>${wmEscape(first ? first.start : '')}</b>. Hãy vào lớp đúng giờ.`);
                    }
                }
            }
        }

        // (4) fallback to the learner's OWN breakout teachers when the main teacher
        //     cannot take them and nobody else was assigned
        const mainJoinable = !!(mainCard && mainCard.joinable);
        const answered = !!(assignedHtml && i === 0) || !!(subCard && subCard.joinable) || mainJoinable;
        if (!answered) {
            const why = relaxed
                ? `Hôm nay (<b>${wmEscape(DB_DAY_LABELS[todayDOW])} ${smDDMM(todayYMD)}</b>) bạn không có lịch học.`
                : smWhyNot(mainSt, mainName, classTime, relaxed);

            // if the main teacher exists but is off / unscheduled, say so with a card
            if (mainEmail && mainSt && !mainCard) {
                if (!relaxed) blocks.push(smOffCardHTML(mainName, mainEmail, roleLabel, smShortWhy(mainSt, classTime, relaxed), mainSt.off ? 'off' : 'noroom'));
            }

            // candidates: this slot's own breakout teacher first, then the learner's other
            // breakout teachers, then a breakout substitute. (A teacher used as the answer
            // for one slot may be the answer for the next slot too — do not exclude them.)
            const ownBreakout = smLower(item.breakout_email);
            const ordered = [ownBreakout, ...breakoutEmails].filter((e, i, a) => e && a.indexOf(e) === i);
            const cands = [];
            for (const be of ordered) {
                if (be === mainEmail) continue;
                cands.push({ em: be, name: (nameByTeacher[be] || '').trim() || be, label: 'Breakout' });
            }
            if (brSub && !isAux) {
                const se = smLower(brSub.substitute_teacher_email);
                if (!usedBreakout.has(se) && !cands.some(c => c.em === se)) {
                    cands.push({ em: se, name: brSub.substitute_teacher_name || nameByTeacher[se] || se, label: 'Breakout dạy thay' });
                }
            }

            const goodCards = [];
            const badCards = [];
            for (const c of cands) {
                const st = await statusOf(c.em, c.name, classTime, false);
                usedBreakout.add(c.em);
                if (!smAvailable(st)) {
                    // no shift today / already done / off
                    if (st.off || SM_V2.FALLBACK_NEEDS_SHIFT) {
                        badCards.push(smOffCardHTML(c.name, c.em, c.label, smShortWhy(st, classTime, relaxed), st.off ? 'off' : 'noroom'));
                        continue;
                    }
                    // switch is off: offer the room anyway, but say what we know
                    const card = await cardOf(c.em, c.name, 'breakout', st, c.label);
                    if (card.joinable) {
                        goodCards.push(card.html + `<div class="sm-note"><i class="fa-solid fa-circle-info"></i> GV này ${smShortWhy(st, classTime, relaxed)} — hãy thử vào phòng; nếu không có ai, gọi hỗ trợ.</div>`);
                    } else {
                        badCards.push(card.html);
                    }
                    continue;
                }
                const card = await cardOf(c.em, c.name, 'breakout', st, c.label);
                if (card.joinable) goodCards.push(card.html); else badCards.push(card.html);
            }

            if (goodCards.length) {
                blocks.push(smSectionHTML('fallback', `<i class="fa-solid fa-people-arrows"></i> Vào lớp với GV Breakout của bạn`, goodCards.join('') + badCards.join('')));
                strip = relaxed
                    ? smStripHTML('info', `${why} Đang hiển thị GV của bạn đang làm việc lúc này.`)
                    : smStripHTML('fallback', `${why} Hãy vào lớp với <b>GV Breakout</b> bên dưới${goodCards.length > 1 ? ' (chọn một trong ' + goodCards.length + ' GV)' : ''}.`);
            } else {
                if (badCards.length) blocks.push(smSectionHTML('fallback', `<i class="fa-solid fa-people-arrows"></i> GV Breakout của bạn`, badCards.join('')));
                const nowMinSm = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
                const classOver = (nowMinSm - toMinutes(classTime)) >= 120 || !!(mainSt && mainSt.ended && !mainSt.off);
                if (relaxed) {
                    strip = smStripHTML('info', `${why} Không có GV nào của bạn đang làm việc lúc này.`);
                    blocks.push(smCallBadgeHTML(`Cần hỗ trợ hoặc muốn học bù? Hãy gọi cho chúng tôi.`, true));
                } else if (classOver) {
                    // the lesson is behind us: calm, not an alarm
                    strip = smStripHTML('off', `${why} Buổi học lúc <b>${wmEscape(classTime)}</b> hôm nay đã qua giờ.`);
                    blocks.push(smCallBadgeHTML(`Buổi học hôm nay đã qua giờ. Cần hỗ trợ hoặc muốn học bù? Hãy gọi cho chúng tôi.`, true));
                } else {
                    strip = smStripHTML('call', `${why} Không có GV Breakout nào có thể nhận bạn lúc này — hãy <b>gọi hỗ trợ</b>.`);
                    blocks.push(smCallBadgeHTML(`Chưa có giáo viên nào cho buổi học <b>${wmEscape(classTime)}</b> của bạn.`, false));
                }
            }
        } else if (mainEmail && mainSt && !smAvailable(mainSt) && !relaxed) {
            // answered by assigned/sub, but the main teacher is out — say so in one line
            blocks.push(`<div class="sm-note"><i class="fa-solid fa-user-slash"></i> ${smWhyNot(mainSt, mainName, classTime, relaxed)}</div>`);
        }

        if (!strip) strip = smStripHTML('info', `Hãy chọn một meeting bên dưới để vào lớp.`);
        slotBlocks.push(strip + blocks.join(''));
    }

    // ---------- secondary column: other breakout teachers + Supporter / Mix ----------
    const secondaryParts = [];
    const breakoutLive = [];
    const breakoutSoon = [];
    for (const be of breakoutEmails) {
        if (usedBreakout.has(be)) continue;
        const name = (nameByTeacher[be] || '').trim() || be;
        const refTime = timeHHMM((items.find(r => smLower(r.breakout_email) === be) || {}).time_local || '00:00');
        const st = await statusOf(be, name, refTime, false);
        if (!smAvailable(st)) {                                         // off, no shift today, or done
            breakoutLive.push(smOffCardHTML(name, be, 'Breakout', smShortWhy(st, refTime, true), st.off ? 'off' : 'noroom'));
            continue;
        }
        const card = await cardOf(be, name, 'breakout', st, 'Breakout');
        (st.workingNow ? breakoutLive : breakoutSoon).push(card.html);
    }
    if (brSub && !usedBreakout.has(smLower(brSub.substitute_teacher_email))) {
        const se = smLower(brSub.substitute_teacher_email);
        const sn = brSub.substitute_teacher_name || nameByTeacher[se] || se;
        const st = await statusOf(se, sn, timeHHMM(items[0].time_local), false);
        const card = await cardOf(se, sn, 'breakout', st, 'Breakout dạy thay');
        breakoutLive.push(smSectionHTML('sub', '<i class="fa-solid fa-user-plus"></i> GV Breakout dạy thay', card.html));
    }
    if (breakoutLive.length) secondaryParts.push(smSectionHTML('breakout', '<i class="fa-solid fa-door-open"></i> GV Breakout của bạn', breakoutLive.join('')));
    if (breakoutSoon.length) {
        secondaryParts.push(`<div class="not-yet-section"><div class="not-yet-label"><i class="fa-solid fa-clock"></i> GV Breakout chưa tới giờ làm việc</div>${breakoutSoon.join('')}</div>`);
    }

    const renderedOthers = new Set();
    const otherChunks = [];
    for (const item of items) {
        const h = await smOtherMeetingsHTML(ctx, dbDay, item.time_local, renderedOthers);
        if (h) otherChunks.push(h);
    }
    if (otherChunks.length) secondaryParts.push(smSectionHTML('other', '<i class="fa-solid fa-people-group"></i> GV hỗ trợ đang làm việc', otherChunks.join('')));

    const secondary = secondaryParts.length
        ? secondaryParts.join('')
        : `<div class="sm-muted">Không có meeting khác lúc này.</div>`;

    return { primary: slotBlocks.join('<div class="sm-slot-sep"></div>'), secondary };
}

// ---------- a PLANNED day: not today, just show who is expected ----------
function smRenderPlannedDay(ctx, items, dbDay, rowYMD, offWindow) {
    const { nameByTeacher, DB_DAY_LABELS } = ctx;
    const dayLabel = DB_DAY_LABELS[dbDay];
    const when = `<b>${wmEscape(dayLabel)} ${smDDMM(rowYMD)}</b>`;
    if (!SM_V2.SHOW_PLANNED_ON_OTHER_DAYS) {
        return smStripHTML('info', `Nút vào lớp sẽ hiện vào ${when}.`);
    }
    const subs = ctx.substitutesByDate[rowYMD] || {};
    const parts = [];
    let anyOff = false;

    for (const item of items) {
        const isAux = (item.buoi_phu === true);
        const roleLabel = isAux ? 'Breakout' : 'TTKB';
        const mainEmail = smLower(item.teacher_email);
        const mainName = (nameByTeacher[mainEmail] || '').trim() || mainEmail;
        const classMin = toMinutes(item.time_local);
        const lines = [];

        if (mainEmail) {
            const off = smIsOffOn(offWindow, mainEmail, rowYMD, classMin);
            anyOff = anyOff || off;
            lines.push(`<div class="sm-plan__line${off ? ' sm-plan__line--off' : ''}"><span class="sm-plan__who">GV phụ trách · ${wmEscape(roleLabel)}</span> <b>${wmEscape(mainName)}</b>${off ? ` <span class="sm-tag sm-tag--off">nghỉ ${smDDMM(rowYMD)}</span>` : ''}</div>`);
        } else {
            lines.push(`<div class="sm-plan__line sm-plan__line--off"><span class="sm-plan__who">GV phụ trách</span> <b>chưa có</b> <span class="sm-tag sm-tag--off">cần xếp GV</span></div>`);
        }

        const tSub = (!isAux && subs.TTKB && subs.TTKB.substitute_teacher_email) ? subs.TTKB : null;
        if (tSub) {
            const se = smLower(tSub.substitute_teacher_email);
            const sn = tSub.substitute_teacher_name || nameByTeacher[se] || se;
            lines.push(`<div class="sm-plan__line sm-plan__line--sub"><span class="sm-plan__who">GV dạy thay</span> <b>${wmEscape(sn)}</b> <span class="sm-tag sm-tag--sub">Tạm</span></div>`);
        }

        const bEmail = smLower(item.breakout_email);
        if (bEmail && bEmail !== mainEmail) {
            const bName = (nameByTeacher[bEmail] || '').trim() || bEmail;
            const bOff = smIsOffOn(offWindow, bEmail, rowYMD, classMin);
            anyOff = anyOff || bOff;
            lines.push(`<div class="sm-plan__line${bOff ? ' sm-plan__line--off' : ''}"><span class="sm-plan__who">GV Breakout</span> <b>${wmEscape(bName)}</b>${bOff ? ` <span class="sm-tag sm-tag--off">nghỉ ${smDDMM(rowYMD)}</span>` : ''}</div>`);
        }

        const bSub = (subs.Breakout && subs.Breakout.substitute_teacher_email) ? subs.Breakout : null;
        if (bSub) {
            const se = smLower(bSub.substitute_teacher_email);
            const sn = bSub.substitute_teacher_name || nameByTeacher[se] || se;
            lines.push(`<div class="sm-plan__line sm-plan__line--sub"><span class="sm-plan__who">GV Breakout dạy thay</span> <b>${wmEscape(sn)}</b> <span class="sm-tag sm-tag--sub">Tạm</span></div>`);
        }

        parts.push(`<div class="sm-plan">${lines.join('')}</div>`);
    }

    const strip = anyOff
        ? smStripHTML('off', `Có GV <b>nghỉ</b> vào ${when}. Hôm đó hệ thống sẽ tự hiện GV thay thế để bạn vào lớp.`)
        : smStripHTML('info', `Nút vào lớp sẽ hiện vào ${when}.`);
    return strip + parts.join('<div class="sm-slot-sep"></div>');
}

// ---------- all rows ----------
async function renderScheduleRowsV2(ctx) {
    const { client, data, nameByTeacher, DB_DAY_LABELS, DISPLAY_ORDER, dbToDisplayIndex, todayYMD, hasTodayGrid, renderOtherDOW } = ctx;
    let html = '';

    if (!data.length) {
        html += `<div class="sm-empty">${smStripHTML('call', `Bạn <b>chưa có lịch học</b> nào trong hệ thống.`)}${smCallBadgeHTML(`Hãy gọi hỗ trợ để được xếp lớp và giáo viên.`, false)}</div>`;
        return html;
    }

    // names for breakout teachers + assigned owners (the page only knew main teachers)
    await smFillNames(client, nameByTeacher, [
        ...data.map(r => r.breakout_email),
        ...data.map(r => r.teacher_email),
        ...(ctx.assignedOwnersToday || [])
    ]);

    const offWindow = await smFetchOffWindow(client, todayYMD, smAddDays(todayYMD, 6));

    for (const dbDay of DISPLAY_ORDER) {
        const items = data.filter(r => Number(r.day_of_week) === Number(dbDay));
        if (!items.length) continue;

        const dayClass = `day-${dbToDisplayIndex(dbDay)}`;
        const isLive = Number(dbDay) === Number(renderOtherDOW);
        const todayClass = isLive ? ' day-today' : '';
        const nearestClass = (isLive && !hasTodayGrid) ? ' day-nearest' : '';
        const rowYMD = smNextYMDForDow(dbDay, todayYMD);
        const dateHtml = SM_V2.SHOW_DATE_UNDER_DAY ? `<span class="sm-date">${smDDMM(rowYMD)}</span>` : '';

        html += `<div class="roster__day ${dayClass}${todayClass}${nearestClass}">${wmEscape(DB_DAY_LABELS[dbDay])}${dateHtml}</div>`;

        const times = items.map(r => timePillHTML(r.time_local)).join('<br>');
        const notes = items.map(r => sessionBadgeHTML(!!r.buoi_phu)).join('<br>');

        let primary = '';
        let secondary = '';
        if (isLive) {
            try {
                const out = await smRenderLiveDay(ctx, items, dbDay);
                primary = out.primary;
                secondary = out.secondary;
            } catch (e) {
                console.error('[sm-v2] live day render error', e);
                primary = smStripHTML('call', `Không tải được thông tin giáo viên. Hãy tải lại trang, hoặc gọi hỗ trợ.`)
                    + smCallBadgeHTML(`Trang gặp lỗi khi tìm giáo viên cho bạn.`, false);
            }
        } else {
            primary = smRenderPlannedDay(ctx, items, dbDay, rowYMD, offWindow);
            secondary = `<div class="sm-muted">Hiển thị vào ngày học.</div>`;
        }

        html += `<div class="roster__cell roster__cell--center ${dayClass}${todayClass}">${times}</div>`;
        html += `<div class="roster__cell roster__cell--center ${dayClass}${todayClass}">${notes}</div>`;
        html += `<div class="roster__cell roster__cell--main ${dayClass}${todayClass}">${primary}</div>`;
        html += `<div class="roster__cell roster__cell--other ${dayClass}${todayClass}">${secondary}</div>`;
        html += `<div class="roster__sep" aria-hidden="true"></div>`;
    }
    return html;
}
// === tansinh sm-v2 END ===
