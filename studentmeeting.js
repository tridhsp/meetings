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
                if (changed && (myTeacherEmails.has(changed) || smV4OnDutyEmails.includes(changed))) reloadScheduleDebounced(); // sm-v4
            }
        );

        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_content' },
            (payload) => {
                const changed = (payload.new?.teacher_email || payload.old?.teacher_email || '').toLowerCase();
                if (changed && (myTeacherEmails.has(changed) || smV4OnDutyEmails.includes(changed))) reloadScheduleDebounced(); // sm-v4
            }
        );

        realtimeChannel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_offdays' },
            (payload) => {
                const changed = (payload.new?.teacher_email || payload.old?.teacher_email || '').toLowerCase();
                if (changed && (myTeacherEmails.has(changed) || smV4OnDutyEmails.includes(changed))) reloadScheduleDebounced(); // sm-v4
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



    // === tansinh sm-v3: the week agenda (10 Oct 2026) — see renderScheduleRowsV2 at the end of this file ===
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
    // === tansinh sm-v3: end of the week agenda ===


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
    const pollEmails = smV4PollEmails(); if (!pollEmails.length) return; // sm-v4: own breakout teachers + the on-duty ones shown
    try {
        const allRoomNames = [];
        for (const btEmail of pollEmails) { // sm-v4
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
// === tansinh sm-v3 BEGIN (10 Oct 2026) ===
// "Vào lớp với ai?" — ONE resolved answer per class slot, with a reason the
// learner can read, laid out as a WEEK AGENDA: today expanded, other days compact.
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

const SM_V3 = {
    SUPPORT_URL: 'https://ringts.tansinh.info/',
    SHOW_PLANNED_ON_OTHER_DAYS: true,   // one-word switch: names + notes on days that are not today
    SHOW_DATE_UNDER_DAY: true,          // dd/mm under the day name
    FALLBACK_NEEDS_SHIFT: true          // a breakout teacher is offered as the fallback ONLY if they have a
                                        // shift today (working now, or starting later). false = offer them
                                        // anyway when they have a room, with an honest note under the card.
};
// === tansinh sm-v4 config BEGIN (10 Oct 2026) — GV Breakout đang trực ===
// When NONE of the learner's own teachers is working right now, the live day
// also shows the Breakout/BM teachers who are on shift now, with their free
// rooms. The code is in the sm-v4 block at the end of this file.
const SM_V4 = {
    ENABLED: true,      // one-word switch: false = the page behaves exactly as sm-v3
    ROLE_BASED: true,   // true  = show the on-duty Breakout teacher whenever none of her own
                        //         BREAKOUT-role teachers is live, even if a TTKB answer exists
                        // false = any live teacher of hers (TTKB included) hides it
    MAX_CHECK: 6,       // how many on-duty teachers to ask for free rooms (one API call each)
    MAX_SHOW: 3         // how many of them to show, most free rooms first
};
// sm-v5: the two-tile look for today's card (Lớp chính / Phòng Breakout)
const SM_V5 = {
    ENABLED: true,      // one-word switch: false = today's card renders as the sm-v3 sections
    MAX_ROOMS: 12       // room buttons shown in the Breakout tile
};
// === tansinh sm-v4 config END ===

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
        <a class="sm-call__btn" href="${wmEscape(SM_V3.SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">
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
        console.error('[sm-v3] off window fetch error', e);
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
        console.error('[sm-v3] name fill error', e);
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

// Just the breakout-room chips, no card around them — used under a teacher's
// own card when that teacher is BOTH the GV phụ trách and the GV Breakout.
function smRoomsStripHTML(rooms, studentEmail) {
    if (!rooms || !rooms.length) return '';
    const chips = rooms.map(room => {
        let url = 'https://meeting.tansinh.info/' + room.room_name;
        if (studentEmail) {
            url += '#userInfo.email=%22' + encodeURIComponent(studentEmail) + '%22'
                + '&userInfo.displayName=%22' + encodeURIComponent(studentEmail) + '%22';
        }
        const parts = String(room.room_name).split('_');
        return `<a href="${wmEscape(url)}" target="_blank" rel="noopener noreferrer" class="tmc-room-btn" title="${wmEscape(room.room_name)}">${wmEscape(parts[parts.length - 1])}</a>`;
    }).join('');
    return `<div class="sm-rooms"><div class="sm-rooms__label">Phòng Breakout trống (${rooms.length}) — chọn một phòng:</div><div class="tmc-rooms-grid sm-rooms__grid">${chips}</div></div>`;
}

// One row of the agenda: the date rail on the left, the body on the right.
function smAgRowHTML(o) {
    const cls = ['ag__row', o.dayClass || ''];
    if (o.isToday) cls.push('ag__row--today');
    if (o.isLast) cls.push('ag__row--last');
    return `<div class="${cls.join(' ')}">
        <div class="ag__rail">
            <div class="ag__day">${wmEscape(o.dayLabel)}</div>
            <div class="ag__date">${smDDMM(o.ymd)}${o.isToday ? ' · Hôm nay' : ''}</div>
            <span class="ag__dot" aria-hidden="true"></span>
        </div>
        <div class="ag__body">${o.body}</div>
    </div>`;
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
                let roomsStrip = '';
                if (isAux) {
                    usedBreakout.add(mainEmail);
                } else if (breakoutEmails.includes(mainEmail)) {
                    // the same teacher is also this learner's GV Breakout: show their rooms
                    // under their one card instead of a second card further down
                    const ownRooms = await fetchAvailableBreakoutRooms(mainEmail);
                    roomsStrip = smRoomsStripHTML(ownRooms, ctx.studentEmail);
                    usedBreakout.add(mainEmail);
                }
                blocks.push(smSectionHTML('main', `<i class="fa-solid fa-chalkboard-user"></i> GV phụ trách (${wmEscape(roleLabel)})`, mainCard.html + roomsStrip));
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
                    if (st.off || SM_V3.FALLBACK_NEEDS_SHIFT) {
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

        // === tansinh sm-v4 hook BEGIN (10 Oct 2026) — GV Breakout đang trực ===
        // Shown ONCE per day, at the first slot where nobody of the learner's OWN
        // Breakout-role teachers is working RIGHT NOW: her breakout teacher(s), a
        // breakout substitute, a pinned meeting whose owner is a Breakout/BM
        // teacher, or — on a "buổi phụ" row — the row's own teacher. A TTKB answer
        // (pinned TTKB meeting, TTKB substitute, live TTKB teacher) does NOT hide it
        // while SM_V4.ROLE_BASED is true. Own teachers that start later today stay
        // on screen; the on-duty teacher is added as the "right now" answer.
        if (i === 0) smV4OnDutyEmails = [];
        if (SM_V4.ENABLED && !ctx._smV4Shown && !ctx._smV4AnyLive) {
            try {
                const smV4SubSt = (sub && subCard && subCard.joinable)
                    ? await statusOf(smLower(sub.substitute_teacher_email), sub.substitute_teacher_name || '', classTime, false)
                    : null;
                const smV4SubLive = !!(smV4SubSt && smV4SubSt.workingNow);
                const smV4MainLive = !!(mainCard && mainCard.joinable && mainSt && mainSt.workingNow);
                const smV4MainIsB = isAux || breakoutEmails.includes(mainEmail);
                let smV4Covered;
                if (SM_V4.ROLE_BASED) {
                    smV4Covered = await smV4AssignedBreakoutLive(ctx)
                        || (isAux && smV4SubLive)
                        || (smV4MainIsB && smV4MainLive)
                        || await smV4OwnBreakoutLive(ctx, { item, breakoutEmails, brSub, mainEmail, isAux, classTime, statusOf, cardOf });
                } else {
                    smV4Covered = !!assignedHtml || smV4SubLive || smV4MainLive
                        || await smV4OwnBreakoutLive(ctx, { item, breakoutEmails, brSub, mainEmail, isAux, classTime, statusOf, cardOf });
                }
                if (smV4Covered) {
                    ctx._smV4AnyLive = true;
                } else {
                    const smV4Skip = new Set([mainEmail, ...breakoutEmails, ...usedBreakout,
                        ...(ctx.assignedOwnersToday || []).map(smLower)].filter(Boolean));
                    if (sub) smV4Skip.add(smLower(sub.substitute_teacher_email));
                    if (brSub) smV4Skip.add(smLower(brSub.substitute_teacher_email));
                    const od = await smV4OnDutySection(ctx, smV4Skip);
                    if (od.count) {
                        ctx._smV4Shown = true;
                        smV4OnDutyEmails = od.emails;
                        // the call-for-support badge is no longer the answer for this slot
                        for (let k = blocks.length - 1; k >= 0; k--) {
                            if (String(blocks[k]).indexOf('<div class="sm-call') === 0) blocks.splice(k, 1);
                        }
                        blocks.push(od.html);
                        strip = smV4Strip(strip, { answered, relaxed, isAux, mainSt, mainName, classTime, count: od.count, DB_DAY_LABELS, todayDOW, todayYMD });
                    }
                }
            } catch (e) {
                console.error('[sm-v4] on-duty block error', e);
            }
        }
        // === tansinh sm-v4 hook END ===
        if (!strip) strip = smStripHTML('info', `Hãy chọn một meeting bên dưới để vào lớp.`);
        slotBlocks.push({ item, strip, blocks: blocks.join('') });
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

    const secondary = secondaryParts.join('');
    const primary = slotBlocks.map(s => s.strip + s.blocks).join('<div class="sm-slot-sep"></div>');
    return { slots: slotBlocks, primary, secondary };
}

// ---------- a PLANNED day: not today — one compact line per class slot ----------
function smAgPlannedBody(ctx, items, rowYMD, offWindow) {
    const { nameByTeacher } = ctx;
    const subs = ctx.substitutesByDate[rowYMD] || {};
    const tSubRow = (subs.TTKB && subs.TTKB.substitute_teacher_email) ? subs.TTKB : null;
    const bSubRow = (subs.Breakout && subs.Breakout.substitute_teacher_email) ? subs.Breakout : null;
    const lines = [];

    for (const item of items) {
        const isAux = (item.buoi_phu === true);
        const roleLabel = isAux ? 'Breakout' : 'TTKB';
        const mainEmail = smLower(item.teacher_email);
        const mainName = (nameByTeacher[mainEmail] || '').trim() || mainEmail;
        const classMin = toMinutes(item.time_local);
        const bits = [timePillHTML(item.time_local), sessionBadgeHTML(!!item.buoi_phu)];
        const tSub = isAux ? null : tSubRow;
        let needsCover = false;

        if (mainEmail) {
            const off = smIsOffOn(offWindow, mainEmail, rowYMD, classMin);
            bits.push(`<span class="ag__who"><span class="ag__role">GV phụ trách</span> <b class="${off ? 'ag__struck' : ''}">${wmEscape(mainName)}</b> <span class="ag__role">· ${wmEscape(roleLabel)}</span></span>`);
            if (off) {
                bits.push(`<span class="sm-tag sm-tag--off">nghỉ ${smDDMM(rowYMD)}</span>`);
                needsCover = !(isAux ? bSubRow : tSub);
            }
        } else {
            bits.push(`<span class="ag__who"><span class="ag__role">GV phụ trách</span> <b>chưa có</b></span><span class="sm-tag sm-tag--off">cần xếp GV</span>`);
            needsCover = true;
        }

        if (tSub) {
            const se = smLower(tSub.substitute_teacher_email);
            const sn = tSub.substitute_teacher_name || nameByTeacher[se] || se;
            bits.push(`<span class="ag__who ag__who--sub">→ <span class="ag__role">GV dạy thay</span> <b>${wmEscape(sn)}</b></span><span class="sm-tag sm-tag--sub">Tạm</span>`);
        }

        const bEmail = smLower(item.breakout_email);
        if (bEmail && bEmail !== mainEmail) {
            const bName = (nameByTeacher[bEmail] || '').trim() || bEmail;
            const bOff = smIsOffOn(offWindow, bEmail, rowYMD, classMin);
            bits.push(`<span class="ag__who"><span class="ag__role">· Breakout</span> <b class="${bOff ? 'ag__struck' : ''}">${wmEscape(bName)}</b></span>`);
            if (bOff) bits.push(`<span class="sm-tag sm-tag--off">nghỉ ${smDDMM(rowYMD)}</span>`);
        }
        if (bSubRow) {
            const se = smLower(bSubRow.substitute_teacher_email);
            const sn = bSubRow.substitute_teacher_name || nameByTeacher[se] || se;
            bits.push(`<span class="ag__who ag__who--sub">→ <span class="ag__role">Breakout dạy thay</span> <b>${wmEscape(sn)}</b></span><span class="sm-tag sm-tag--sub">Tạm</span>`);
        }

        const note = needsCover
            ? `<div class="ag__note"><i class="fa-solid fa-circle-info"></i> Chưa có GV thay. Hôm đó trang sẽ tự hiện GV Breakout của bạn, hoặc nút Gọi hỗ trợ.</div>`
            : '';
        lines.push(`<div class="ag__slot">${bits.join('')}</div>${note}`);
    }
    return lines.join('');
}

// ---------- the TODAY row: expanded card(s) from the resolver ----------
async function smAgTodayBody(ctx, items, dbDay, noClass) {
    if (typeof SM_V5 !== 'undefined' && SM_V5.ENABLED) { const v5 = await smV5TodayBody(ctx, items, dbDay, noClass); if (v5 != null) return v5; } // sm-v4: the two-tile look (sm-v5); on an error it falls through to the sections below
    const { DB_DAY_LABELS, todayYMD } = ctx;
    let out;
    try {
        out = await smRenderLiveDay(ctx, items, dbDay);
    } catch (e) {
        console.error('[sm-v3] live day render error', e);
        return `<div class="ag__card ag__card--call">${smStripHTML('call', `Không tải được thông tin giáo viên. Hãy tải lại trang, hoặc gọi hỗ trợ.`)}<div class="ag__cardbody">${smCallBadgeHTML(`Trang gặp lỗi khi tìm giáo viên cho bạn.`, false)}</div></div>`;
    }
    const others = out.secondary ? `<div class="ag__others">${out.secondary}</div>` : '';
    const cards = out.slots.map((s, i) => {
        const kind = (s.strip.match(/sm-strip--([a-z]+)/) || [])[1] || 'info';
        const meta = noClass
            ? `<span class="ag__noclass"><i class="fa-regular fa-calendar"></i> Buổi học gần nhất: <b>${wmEscape(DB_DAY_LABELS[dbDay])} ${smDDMM(smNextYMDForDow(dbDay, todayYMD))}</b></span>`
            : `${timePillHTML(s.item.time_local)}${sessionBadgeHTML(!!s.item.buoi_phu)}`;
        const tail = (i === out.slots.length - 1) ? others : '';
        return `<div class="ag__card ag__card--${kind}">${s.strip}<div class="ag__cardbody"><div class="ag__slotmeta">${meta}</div>${s.blocks}${tail}</div></div>`;
    });
    return cards.join('');
}

// ---------- all rows: the week agenda ----------
async function renderScheduleRowsV2(ctx) {
    const { client, data, nameByTeacher, DB_DAY_LABELS, DISPLAY_ORDER, dbToDisplayIndex, todayYMD, todayDOW, hasTodayGrid, renderOtherDOW } = ctx;
    const weekTo = smAddDays(todayYMD, 6);
    const n = data.length;
    const subParts = [`Tuần ${smDDMM(todayYMD)} – ${smDDMM(weekTo)}`, `${n} buổi học`];
    if (n) subParts.push('Nút vào lớp hiện vào đúng ngày học');

    let html = `<div class="ag">
        <div class="ag__head">
            <div class="ag__sub">${subParts.join(' · ')}</div>
            <a class="ag__call" href="${wmEscape(SM_V3.SUPPORT_URL)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-phone-volume"></i> Gọi hỗ trợ</a>
        </div>`;

    if (!n) {
        html += `<div class="ag__empty">${smStripHTML('call', `Bạn <b>chưa có lịch học</b> nào trong hệ thống.`)}${smCallBadgeHTML(`Hãy gọi hỗ trợ để được xếp lớp và giáo viên.`, false)}</div></div>`;
        return html;
    }

    // names for breakout teachers + assigned owners (the page only knew main teachers)
    await smFillNames(client, nameByTeacher, [
        ...data.map(r => r.breakout_email),
        ...data.map(r => r.teacher_email),
        ...(ctx.assignedOwnersToday || [])
    ]);
    const offWindow = await smFetchOffWindow(client, todayYMD, weekTo);

    // learning days, ordered by their next date counting from today
    const days = DISPLAY_ORDER
        .filter(d => data.some(r => Number(r.day_of_week) === Number(d)))
        .map(d => ({ dbDay: Number(d), ymd: smNextYMDForDow(d, todayYMD) }))
        .sort((a, b) => a.ymd.localeCompare(b.ymd));

    const rows = [];
    if (hasTodayGrid) {
        const items = data.filter(r => Number(r.day_of_week) === Number(todayDOW));
        rows.push({ dayLabel: DB_DAY_LABELS[todayDOW], ymd: todayYMD, isToday: true, dayClass: `day-${dbToDisplayIndex(todayDOW)}`,
                    body: await smAgTodayBody(ctx, items, todayDOW, false) });
    } else {
        // no class today: a "today" row that shows who of the learner's teachers is around
        const nearestItems = data.filter(r => Number(r.day_of_week) === Number(renderOtherDOW));
        rows.push({ dayLabel: DB_DAY_LABELS[todayDOW], ymd: todayYMD, isToday: true, dayClass: `day-${dbToDisplayIndex(todayDOW)}`,
                    body: await smAgTodayBody(ctx, nearestItems, renderOtherDOW, true) });
    }
    for (const d of days) {
        if (hasTodayGrid && d.ymd === todayYMD) continue;
        const items = data.filter(r => Number(r.day_of_week) === d.dbDay);
        rows.push({ dayLabel: DB_DAY_LABELS[d.dbDay], ymd: d.ymd, isToday: false, dayClass: `day-${dbToDisplayIndex(d.dbDay)}`,
                    body: smAgPlannedBody(ctx, items, d.ymd, offWindow) });
    }

    html += `<div class="ag__list">` + rows.map((r, i) => smAgRowHTML(Object.assign({}, r, { isLast: i === rows.length - 1 }))).join('') + `</div></div>`;
    return html;
}
// === tansinh sm-v3 END ===
// === tansinh sm-v4 BEGIN (10 Oct 2026) — GV Breakout đang trực ===
// The fallback the sm-v3 rewrite lost: when nobody of the learner's own teachers
// is working right now, show the Breakout/BM teachers who are on shift now.
// Reuses fetchFallbackTeachersNow (shift covers now, not off today),
// fetchAvailableBreakoutRooms, fetchTiepHvMeeting, renderBreakoutRoomChips,
// renderTiepHvMeetingCard, smFillNames, smSectionHTML and smStripHTML.
// Config: SM_V4, next to SM_V3. Switch off with SM_V4.ENABLED = false.

// emails of the on-duty teachers shown in the last render; the 30-second room
// poll and the realtime handlers watch them too (see pollBreakoutRooms)
let smV4OnDutyEmails = [];

function smV4PollEmails() {
    const seen = new Set();
    return [...myBreakoutEmails, ...smV4OnDutyEmails].map(smLower).filter(e => {
        if (!e || seen.has(e)) return false;
        seen.add(e);
        return true;
    });
}

// Is one of today's pinned meetings owned by a Breakout/BM teacher? (A pinned
// meeting counts as live — smAssignedHTML treats its owner as working now.)
async function smV4AssignedBreakoutLive(ctx) {
    for (const ow of (ctx.assignedOwnersToday || [])) {
        const d = String(await getTeacherDepartment(ctx.client, ow) || '').toLowerCase();
        if (d === 'bm' || d.includes('breakout')) return true;
    }
    return false;
}

// Is any of the learner's OWN breakout teachers (this slot's, the others in her
// schedule, a breakout substitute) working right now with a joinable card?
async function smV4OwnBreakoutLive(ctx, o) {
    const { nameByTeacher } = ctx;
    const own = [smLower(o.item.breakout_email), ...o.breakoutEmails]
        .filter((e, i, a) => e && a.indexOf(e) === i && e !== o.mainEmail);
    const cands = own.map(be => ({ em: be, name: (nameByTeacher[be] || '').trim() || be, label: 'Breakout' }));
    if (o.brSub && !o.isAux) {
        const se = smLower(o.brSub.substitute_teacher_email);
        if (se && !cands.some(c => c.em === se)) {
            cands.push({ em: se, name: o.brSub.substitute_teacher_name || nameByTeacher[se] || se, label: 'Breakout dạy thay' });
        }
    }
    for (const c of cands) {
        const st = await o.statusOf(c.em, c.name, o.classTime, false);
        if (!smAvailable(st) || !st.workingNow) continue;
        const card = await o.cardOf(c.em, c.name, 'breakout', st, c.label);
        if (card.joinable) return true;
    }
    return false;
}

// The shift that covers "now" for this teacher today (same date rules as
// getTeacherUpcomingShiftsToday, same 20-minute tail as fetchFallbackTeachersNow).
async function smV4ShiftNow(client, teacherEmail, todayDOW) {
    const em = smLower(teacherEmail);
    if (!em) return null;
    try {
        const { data } = await client.from('meeting_content')
            .select('start_time, end_time, work_date, is_one_time')
            .ilike('teacher_email', em);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const todayYMD = thisWeekYMDForDow(Number(todayDOW));
        for (const r of (data || [])) {
            const isOne = r.is_one_time === true || r.is_one_time === 1 ||
                String(r.is_one_time).toLowerCase() === 'true' || String(r.is_one_time).toLowerCase() === 't';
            const rowYMD = String(r.work_date).slice(0, 10);
            const dateOk = isOne ? (rowYMD === todayYMD) : (weekdayFromYMD(r.work_date) === Number(todayDOW));
            if (!dateOk) continue;
            const s = toMinutes(r.start_time);
            const e = toMinutes(r.end_time);
            if (nowMin >= s && nowMin < Math.min(e + 20, 24 * 60)) return { start: timeHHMM(r.start_time), end: timeHHMM(r.end_time) };
        }
    } catch (e) {
        console.error('[sm-v4] shift lookup error', e);
    }
    return null;
}

// "đang làm việc" -> "đang trực · ca 08:00–12:00" on a card we did not write
function smV4Decorate(cardHtml, shift) {
    const tail = shift ? ` <span class="sm-onduty__shift"><i class="fa-regular fa-clock"></i> ca ${wmEscape(shift.start)}–${wmEscape(shift.end)}</span>` : '';
    return String(cardHtml).replace('GV Breakout — đang làm việc', 'GV Breakout — đang trực' + tail);
}

// The on-duty candidates, as DATA: Breakout/BM teachers on shift now, not off,
// not in `skip`, with their free rooms (most rooms first). If nobody has a free
// room, the first ones with a main meeting, marked noRooms. Up to SM_V4.MAX_SHOW.
async function smV4OnDutyPick(ctx, skip) {
    const { client, nameByTeacher, todayDOW } = ctx;
    const list = await fetchFallbackTeachersNow(client, ['breakout', 'bm']);
    const cands = [];
    for (const t of (list || [])) {
        const em = smLower(t.teacher_email);
        if (!em || skip.has(em) || cands.some(c => c.em === em)) continue;
        cands.push({ em, name: (t.teacher_name || '').trim() });
        if (cands.length >= SM_V4.MAX_CHECK) break;
    }
    if (!cands.length) return [];
    await smFillNames(client, nameByTeacher, cands.map(c => c.em));
    const withRooms = [];
    const noRooms = [];
    for (const c of cands) {
        c.name = (nameByTeacher[c.em] || '').trim() || c.name || c.em;
        c.rooms = await fetchAvailableBreakoutRooms(c.em);
        c.mainRoom = '';
        c.noRooms = !c.rooms.length;
        (c.rooms.length ? withRooms : noRooms).push(c);
    }
    withRooms.sort((a, b) => b.rooms.length - a.rooms.length);
    const picked = withRooms.slice(0, SM_V4.MAX_SHOW);
    if (!picked.length) {
        for (const c of noRooms.slice(0, SM_V4.MAX_SHOW)) {
            const m = await fetchTiepHvMeeting(c.em);
            if (m && m.room_name) { c.mainRoom = m.room_name; picked.push(c); }
        }
    }
    for (const c of picked) c.shift = await smV4ShiftNow(client, c.em, todayDOW);
    return picked;
}

// The sm-v3-style section built from the pick. Returns { count, html, emails }.
async function smV4OnDutySection(ctx, skip) {
    const { studentEmail } = ctx;
    const out = { count: 0, html: '', emails: [] };
    const picked = await smV4OnDutyPick(ctx, skip);
    const cards = [];
    for (const c of picked) {
        if (!c.noRooms) {
            cards.push(smV4Decorate(renderBreakoutRoomChips(c.rooms, studentEmail, c.name, c.em, false, []), c.shift));
        } else {
            cards.push(smV4Decorate(renderTiepHvMeetingCard({ room_name: c.mainRoom }, studentEmail, c.name, c.em, false, [], 'Breakout'), c.shift)
                + `<div class="sm-onduty__note"><i class="fa-solid fa-circle-info"></i> Phòng Breakout của GV này đang kín. Vào <b>Meeting chính</b> và chờ GV mời bạn vào phòng.</div>`);
        }
    }
    if (!cards.length) return out;
    out.count = cards.length;
    out.emails = picked.map(c => c.em);
    out.html = smSectionHTML('onduty', `<i class="fa-solid fa-door-open"></i> GV Breakout đang trực lúc này`,
        cards.join('')
        + `<div class="sm-onduty__note"><i class="fa-solid fa-circle-info"></i> Đây không phải GV Breakout thường ngày của bạn — hôm nay bạn vào tạm. Nếu vào phòng mà không có ai, bấm <b>Gọi hỗ trợ</b> ở đầu trang.</div>`);
    return out;
}

// The one-line explanation above the card. Three situations:
//   someone of hers answers later today (or her own breakout teacher has a
//   room but is not live yet)  -> keep that sentence, add the offer
//   no class today             -> calm info line
//   nobody of hers can take her -> why, then the offer (or "class is over")
function smV4Strip(oldStrip, o) {
    const where = `Hãy vào tạm với <b>GV Breakout đang trực</b> bên dưới${o.count > 1 ? ' (chọn một trong ' + o.count + ' GV)' : ''}.`;
    const kind = (String(oldStrip || '').match(/sm-strip--([a-z]+)/) || [])[1] || '';
    if ((o.answered || kind === 'fallback') && oldStrip) {
        // a TTKB answer exists (pinned / substitute / main teacher), or her own breakout
        // teacher has a room but is not live yet: keep that sentence, add the Breakout offer
        const extra = (SM_V4.ROLE_BASED && !o.isAux && kind !== 'fallback')
            ? `GV Breakout của bạn không làm việc lúc này — khi cần phòng Breakout, ${where.charAt(0).toLowerCase() + where.slice(1)}`
            : `Muốn học ngay bây giờ? ${where}`;
        return String(oldStrip).replace(/<\/span><\/div>$/, ` ${extra}</span></div>`);
    }
    if (o.relaxed) {
        return smStripHTML('info', `Hôm nay (<b>${wmEscape(o.DB_DAY_LABELS[o.todayDOW])} ${smDDMM(o.todayYMD)}</b>) bạn không có lịch học. Muốn học ngay bây giờ? ${where}`);
    }
    const why = smWhyNot(o.mainSt, o.mainName, o.classTime, o.relaxed);
    const d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const classOver = (nowMin - toMinutes(o.classTime)) >= 120 || !!(o.mainSt && o.mainSt.ended && !o.mainSt.off);
    if (classOver) return smStripHTML('off', `${why} Buổi học lúc <b>${wmEscape(o.classTime)}</b> hôm nay đã qua giờ. Muốn học thêm? ${where}`);
    return smStripHTML('fallback', `${why} GV Breakout của bạn cũng không làm việc lúc này. ${where}`);
}

// ---------- sm-v5: the two-tile look for today's card (Lớp chính / Phòng Breakout) ----------
// smAgTodayBody routes here while SM_V5.ENABLED. One guide sentence on top, two
// tiles with one button each, a help line, and the next class. Any error falls
// back to the sm-v3 sections (the routing line checks for null).

function smV5Url(roomName, studentEmail) {
    let url = 'https://meeting.tansinh.info/' + roomName;
    if (studentEmail) {
        url += '#userInfo.email=%22' + encodeURIComponent(studentEmail) + '%22'
            + '&userInfo.displayName=%22' + encodeURIComponent(studentEmail) + '%22';
    }
    return url;
}

function smV5RoomNum(roomName) {
    const parts = String(roomName || '').split('_');
    return parts[parts.length - 1];
}

// short reason for a tile line
function smV5Why(st, classTime, strict) {
    if (!st) return 'chưa có GV';
    if (st.off) return 'nghỉ hôm nay';
    if (st.noShift) return 'chưa có lịch hôm nay';
    if (strict && !st.slotOk) return 'không có lịch lúc ' + classTime;
    if (st.ended) return 'đã xong ca hôm nay';
    if (!st.workingNow && st.upcoming && st.upcoming.length) return 'bắt đầu lúc ' + st.upcoming[0].start;
    return 'hiện không làm việc';
}

async function smV5Rooms(email, studentEmail) {
    const rooms = await fetchAvailableBreakoutRooms(email);
    return rooms.map(r => ({ room_name: r.room_name, num: smV5RoomNum(r.room_name), url: smV5Url(r.room_name, studentEmail) }))
        .sort((a, b) => ((Number(a.num) || 0) - (Number(b.num) || 0)) || String(a.num).localeCompare(String(b.num)))
        .slice(0, SM_V5.MAX_ROOMS);
}

// Everything a tile needs about one teacher. kind: 'ttkb' | 'breakout'
async function smV5Teacher(ctx, email, name, kind, st, mainRoom) {
    const em = smLower(email);
    const t = { email: em, name: String(name || '').trim() || em, kind, st, mainUrl: '', rooms: [], shift: null, joinable: false };
    if (!em) return t;
    const m = mainRoom ? { room_name: mainRoom } : await fetchTiepHvMeeting(em);
    if (kind === 'breakout') {
        t.rooms = await smV5Rooms(em, ctx.studentEmail);
        t.mainUrl = (m && m.room_name) ? smV5Url(m.room_name, ctx.studentEmail) : (t.rooms.length ? smV5Url(em.split('@')[0], ctx.studentEmail) : '');
    } else {
        t.mainUrl = (m && m.room_name) ? smV5Url(m.room_name, ctx.studentEmail) : '';
    }
    t.joinable = !!t.mainUrl || t.rooms.length > 0;
    return t;
}

// "Thứ hai 12/10 · 19:00 · GV Vy Dang Tran Phuong" — the next class after now
function smV5NextClass(ctx) {
    const { data, todayYMD, DB_DAY_LABELS, nameByTeacher } = ctx;
    const d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes();
    let best = null;
    for (const r of (data || [])) {
        const time = timeHHMM(r.time_local);
        let ymd = smNextYMDForDow(Number(r.day_of_week), todayYMD);
        if (ymd === todayYMD && toMinutes(time) <= nowMin) ymd = smAddDays(ymd, 7);
        const key = ymd + ' ' + time;
        if (!best || key < best.key) {
            const em = smLower(r.teacher_email);
            best = { key, ymd, dow: Number(r.day_of_week), time, teacher: (nameByTeacher[em] || '').trim() || em };
        }
    }
    if (!best) return '';
    return `${wmEscape(DB_DAY_LABELS[best.dow])} ${smDDMM(best.ymd)} · ${wmEscape(best.time)}${best.teacher ? ' · GV ' + wmEscape(best.teacher) : ''}`;
}

// Decide who goes in each tile. Same cascade as sm-v3/v4, as data:
//   Lớp chính:      pinned TTKB meeting → TTKB substitute → own teacher of the slot
//   Phòng Breakout: pinned BM meeting → breakout substitute → own breakout teacher
//                   live now → on-duty teacher (sm-v4) → own breakout teacher later today
async function smV5Resolve(ctx, items, dbDay, noClass) {
    const { client, data, nameByTeacher, todayYMD, todayDOW, studentEmail } = ctx;
    const relaxed = !!noClass;
    const d0 = new Date();
    const nowMin = d0.getHours() * 60 + d0.getMinutes();
    const subs = ctx.substitutesByDate[todayYMD] || {};
    const ttkbSub = (subs.TTKB && subs.TTKB.substitute_teacher_email) ? subs.TTKB : null;
    const brSub = (subs.Breakout && subs.Breakout.substitute_teacher_email) ? subs.Breakout : null;
    const nameOf = (em) => (nameByTeacher[em] || '').trim() || em;
    const stCache = new Map();
    const statusOf = async (em, classTime, strict) => {
        const key = `${em}|${classTime}|${strict ? 1 : 0}`;
        if (!stCache.has(key)) stCache.set(key, await smTeacherStatusToday(ctx, em, nameOf(em), classTime, strict));
        return stCache.get(key);
    };
    const LIVE = { off: false, slotOk: true, workingNow: true, upcoming: [], ended: false, anyToday: true, noShift: false };

    const mainSlots = items.filter(r => r.buoi_phu !== true);
    const auxSlots = items.filter(r => r.buoi_phu === true);
    const firstSlot = mainSlots[0] || items[0] || null;
    const classTime = firstSlot ? timeHHMM(firstSlot.time_local) : '';
    const ownBreakout = [...new Set([
        ...items.map(r => smLower(r.breakout_email)),
        ...auxSlots.map(r => smLower(r.teacher_email))
    ].filter(Boolean))];
    const ownTtkb = [...new Set(mainSlots.map(r => smLower(r.teacher_email)).filter(Boolean))];

    // pinned meetings, split by the owner's department
    const pinnedT = [];
    const pinnedB = [];
    for (const ow of (ctx.assignedOwnersToday || [])) {
        const em = smLower(ow);
        if (!em) continue;
        const d = String(await getTeacherDepartment(client, em) || '').toLowerCase();
        ((d === 'bm' || d.includes('breakout')) ? pinnedB : pinnedT).push(em);
    }

    // ---- Lớp chính
    const main = { kind: 'none', t: null, why: '', time: relaxed ? '' : classTime, notYet: false };
    if (pinnedT.length) {
        main.kind = 'pinned';
        main.t = await smV5Teacher(ctx, pinnedT[0], nameOf(pinnedT[0]), 'ttkb', LIVE);
    } else if (ttkbSub) {
        const se = smLower(ttkbSub.substitute_teacher_email);
        const st = await statusOf(se, classTime || smNowHHMM(), false);
        const t = await smV5Teacher(ctx, se, ttkbSub.substitute_teacher_name || nameOf(se), 'ttkb', st);
        if (!st.off && t.joinable && (st.workingNow || st.upcoming.length)) {
            main.kind = 'sub'; main.t = t; main.notYet = !st.workingNow;
        } else {
            main.why = `GV dạy thay ${t.name} ${smV5Why(st, classTime, false)}`;
        }
    }
    if (main.kind === 'none' && !relaxed) {
        for (const slot of mainSlots) {
            const em = smLower(slot.teacher_email);
            if (!em) continue;
            const ct = timeHHMM(slot.time_local);
            const st = await statusOf(em, ct, true);
            if (smAvailable(st)) {
                const t = await smV5Teacher(ctx, em, nameOf(em), 'ttkb', st);
                if (t.joinable) { main.kind = 'own'; main.t = t; main.time = ct; main.notYet = !st.workingNow; break; }
                if (!main.why) { main.why = `GV của bạn, ${t.name}, đang làm việc nhưng chưa có phòng meeting`; main.t = t; }
            } else if (!main.why) {
                main.why = `GV của bạn, ${nameOf(em)}, ${smV5Why(st, ct, true)}`;
                main.t = { email: em, name: nameOf(em), st, kind: 'ttkb', rooms: [], mainUrl: '', joinable: false };
            }
        }
    }
    if (main.kind === 'none' && relaxed) {
        // no class today: name a TTKB teacher of hers only if one is live right now
        const all = [...new Set((data || []).filter(r => r.buoi_phu !== true).map(r => smLower(r.teacher_email)).filter(Boolean))];
        for (const em of all) {
            const st = await statusOf(em, smNowHHMM(), false);
            if (st.workingNow && !st.off) {
                const t = await smV5Teacher(ctx, em, nameOf(em), 'ttkb', st);
                if (t.joinable) { main.kind = 'own'; main.t = t; main.time = ''; break; }
            }
        }
    }
    const mainOk = main.kind !== 'none' && !!(main.t && main.t.joinable);
    const classOver = !relaxed && !!classTime && !mainOk
        && ((nowMin - toMinutes(classTime)) >= 120 || !!(main.t && main.t.st && main.t.st.ended && !main.t.st.off));

    // ---- Phòng Breakout
    const br = { kind: 'none', t: null, why: '', insteadName: '', insteadWhy: '', notYet: false, others: [],
                 time: (!relaxed && auxSlots.length) ? timeHHMM(auxSlots[0].time_local) : '' };
    const brTime = br.time || classTime || smNowHHMM();
    let ownSoon = null;
    if (pinnedB.length) {
        br.kind = 'pinned';
        br.t = await smV5Teacher(ctx, pinnedB[0], nameOf(pinnedB[0]), 'breakout', LIVE);
    } else {
        if (brSub) {
            const se = smLower(brSub.substitute_teacher_email);
            const st = await statusOf(se, brTime, false);
            if (!st.off && (st.workingNow || st.upcoming.length)) {
                const t = await smV5Teacher(ctx, se, brSub.substitute_teacher_name || nameOf(se), 'breakout', st);
                if (t.joinable) {
                    if (st.workingNow) { br.kind = 'sub'; br.t = t; }
                    else if (!ownSoon) ownSoon = { t, kind: 'sub' };
                }
            }
        }
        if (br.kind === 'none') {
            const cands = relaxed
                ? [...new Set([...ownBreakout, ...(data || []).map(r => smLower(r.breakout_email)).filter(Boolean)])]
                : ownBreakout;
            for (const em of cands) {
                const st = await statusOf(em, brTime, false);
                if (st.off || !(st.workingNow || st.upcoming.length)) {
                    if (!br.insteadName && !relaxed) { br.insteadName = nameOf(em); br.insteadWhy = smV5Why(st, brTime, false); }
                    continue;
                }
                const t = await smV5Teacher(ctx, em, nameOf(em), 'breakout', st);
                if (!t.joinable) {
                    if (!br.insteadName && !relaxed) { br.insteadName = t.name; br.insteadWhy = 'chưa có phòng meeting'; }
                    continue;
                }
                if (st.workingNow) { br.kind = 'own'; br.t = t; break; }
                if (!ownSoon) ownSoon = { t, kind: 'own' };
            }
        }
        if (br.kind === 'none') {
            const skip = new Set([...ownBreakout, ...ownTtkb, ...pinnedT, ...pinnedB]);
            if (brSub) skip.add(smLower(brSub.substitute_teacher_email));
            if (ttkbSub) skip.add(smLower(ttkbSub.substitute_teacher_email));
            const picked = await smV4OnDutyPick(ctx, skip);
            if (picked.length) {
                const p = picked[0];
                br.kind = 'onduty';
                br.t = await smV5Teacher(ctx, p.em, p.name, 'breakout', LIVE, p.mainRoom || '');
                br.t.shift = p.shift || null;
                br.others = picked.slice(1);
                if (ownSoon) { br.insteadName = ownSoon.t.name; br.insteadWhy = smV5Why(ownSoon.t.st, brTime, false); }
                smV4OnDutyEmails = picked.map(x => x.em);
            } else if (ownSoon) {
                br.kind = ownSoon.kind; br.t = ownSoon.t; br.notYet = true;
                br.insteadName = ''; br.insteadWhy = '';
            }
        }
    }
    if (br.kind === 'none' && br.insteadName) br.why = `GV Breakout của bạn, ${br.insteadName}, ${br.insteadWhy}`;

    // ---- help: Supporter / Mix on shift right now (same source as "GV hỗ trợ đang làm việc")
    const help = [];
    const seen = new Set();
    const probeTimes = items.length ? items.map(r => r.time_local) : [smNowHHMM()];
    for (const tl of probeTimes) {
        const ms = await getOtherMeetingsAt(client, Number(dbDay), tl, { effectiveDOW: todayDOW, overrideClassDateToToday: relaxed, currentStudentEmail: studentEmail });
        for (const m of ms) {
            const em = smLower(m.teacher_email);
            const dl = String(m.department || '').trim().toLowerCase();
            if (!em || seen.has(em) || dl === 'bm' || dl.includes('breakout')) continue;
            seen.add(em);
            const mt = await fetchTiepHvMeeting(em);
            help.push({
                em, name: String(m.teacher_name || em).trim(),
                label: (dl === 'supporter' || dl.includes('support')) ? 'Supporter' : (dl === 'mix' ? 'Mix' : (String(m.department || '').trim() || 'GV')),
                url: (mt && mt.room_name) ? smV5Url(mt.room_name, studentEmail) : ''
            });
            if (help.length >= 2) break;
        }
        if (help.length >= 2) break;
    }

    return { relaxed, classTime, classOver, main, mainOk, br, brOk: br.kind !== 'none' && !!(br.t && br.t.joinable), help, next: smV5NextClass(ctx) };
}

// The one guide sentence. Returns [kind, html].
function smV5Headline(R) {
    const mName = R.main.t ? wmEscape(R.main.t.name) : '';
    const bName = R.br.t ? wmEscape(R.br.t.name) : '';
    const brPart = R.brOk ? (R.br.notYet ? ' Phòng Breakout mở lúc <b>' + wmEscape(R.br.t.st.upcoming[0] ? R.br.t.st.upcoming[0].start : '') + '</b>.' : ' Cần phòng Breakout thì sang ô bên cạnh.') : '';
    if (R.main.kind === 'pinned') return ['assigned', `Hôm nay bạn được <b>xếp vào lớp</b> của GV <b>${mName}</b>. Vào <b>Lớp chính</b> trước.${brPart}`];
    if (R.relaxed) {
        if (R.mainOk || R.brOk) return ['info', `Hôm nay bạn <b>không có lịch học</b>. Muốn học thêm? Vào với GV đang trực bên dưới.`];
        return ['info', `Hôm nay bạn <b>không có lịch học</b>. Lúc này không có GV nào trực.`];
    }
    if (R.main.kind === 'sub' && R.mainOk) return ['sub', `Hôm nay GV <b>${mName}</b> dạy thay. Vào <b>Lớp chính</b>${R.main.notYet ? ' đúng giờ' : ''}.${brPart}`];
    if (R.mainOk && R.main.notYet) {
        const at = R.main.t.st.upcoming[0] ? R.main.t.st.upcoming[0].start : R.main.time;
        return ['soon', `GV của bạn bắt đầu lúc <b>${wmEscape(at)}</b>. Vào lớp đúng giờ.${R.brOk && !R.br.notYet ? ' Muốn học ngay bây giờ? Vào <b>Phòng Breakout</b> bên cạnh.' : brPart}`];
    }
    if (R.mainOk) return ['ok', `GV của bạn <b>đang dạy</b>. Bấm <b>Vào lớp</b>.${brPart}`];
    const why = R.main.why ? wmEscape(R.main.why) + '.' : 'Hôm nay chưa có GV lớp chính.';
    if (R.brOk) return ['fallback', `${why} Hôm nay bạn vào <b>phòng Breakout</b> với GV <b>${bName}</b>${R.br.notYet ? ' lúc <b>' + wmEscape(R.br.t.st.upcoming[0] ? R.br.t.st.upcoming[0].start : '') + '</b>' : ''}.`];
    if (R.classOver) return ['off', `Buổi học lúc <b>${wmEscape(R.classTime)}</b> hôm nay đã qua giờ. Cần hỗ trợ hoặc muốn học bù? Gọi cho chúng tôi.`];
    return ['call', `${why} Lúc này <b>chưa có GV nào</b> cho bạn — bấm <b>Gọi hỗ trợ</b>.`];
}

function smV5Avatar(t) {
    return `<div class="v5-tile__avatar">${wmEscape(smInitials(t.name, t.email))}</div>`;
}

function smV5MainTile(R) {
    const o = R.main;
    const time = o.time ? ` · ${wmEscape(o.time)}` : '';
    const label = `<div class="v5-tile__label"><i class="fa-solid fa-chalkboard-user"></i> Lớp chính${time}</div>`;
    if (!R.mainOk) {
        const who = o.t
            ? `<div class="v5-tile__who">${smV5Avatar(o.t)}<div class="v5-tile__txt"><div class="v5-tile__name">${wmEscape(o.t.name)}</div><div class="v5-tile__sub">${wmEscape(o.why || 'hiện không làm việc')}</div></div></div>`
            : `<div class="v5-tile__sub">${R.relaxed ? 'Hôm nay bạn không có lớp chính.' : wmEscape(o.why || 'Hôm nay chưa có GV lớp chính.')}</div>`;
        const note = R.brOk ? `<div class="v5-tile__note"><i class="fa-solid fa-arrow-right"></i> Hôm nay bạn học ở ô <b>Phòng Breakout</b>.</div>` : '';
        return `<div class="v5-tile v5-tile--main v5-tile--muted">${label}${who}${note}</div>`;
    }
    const sub = o.kind === 'pinned' ? 'Hôm nay bạn được xếp vào lớp này'
        : o.kind === 'sub' ? 'GV dạy thay hôm nay' + (o.notYet ? ' · bắt đầu lúc ' + wmEscape(o.t.st.upcoming[0] ? o.t.st.upcoming[0].start : '') : '')
        : o.notYet ? 'GV của bạn · bắt đầu lúc ' + wmEscape(o.t.st.upcoming[0] ? o.t.st.upcoming[0].start : '')
        : 'GV của bạn · đang dạy';
    const btn = `<a class="v5-btn v5-btn--main${o.notYet ? ' v5-btn--soon' : ''}" href="${wmEscape(o.t.mainUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-video"></i> Vào lớp${o.notYet ? ' (chưa tới giờ)' : ''}</a>`;
    return `<div class="v5-tile v5-tile--main">${label}<div class="v5-tile__who">${smV5Avatar(o.t)}<div class="v5-tile__txt"><div class="v5-tile__name">${wmEscape(o.t.name)}</div><div class="v5-tile__sub">${sub}</div></div></div>${btn}</div>`;
}

function smV5BreakoutTile(R) {
    const o = R.br;
    const time = o.time ? ` · ${wmEscape(o.time)}` : '';
    const label = `<div class="v5-tile__label"><i class="fa-solid fa-door-open"></i> Phòng Breakout${time}</div>`;
    if (!R.brOk) {
        const who = o.why
            ? `<div class="v5-tile__sub">${wmEscape(o.why)}.</div>`
            : '';
        const line = R.relaxed ? 'Lúc này không có GV Breakout trực.' : 'Chưa có GV Breakout nào lúc này.';
        return `<div class="v5-tile v5-tile--breakout v5-tile--muted">${label}${who}<div class="v5-tile__sub">${line} Cần gấp? <a href="${wmEscape(SM_V3.SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">Gọi hỗ trợ</a>.</div></div>`;
    }
    const t = o.t;
    let sub;
    if (o.kind === 'onduty') {
        sub = `Đang trực${t.shift ? ' đến ' + wmEscape(t.shift.end) : ''}`;
        if (o.insteadName) sub += ` · thay cho <b>${wmEscape(o.insteadName)}</b> (${wmEscape(o.insteadWhy)})`;
    } else if (o.kind === 'pinned') {
        sub = 'Hôm nay bạn được xếp vào với GV này';
    } else if (o.kind === 'sub') {
        sub = 'GV Breakout dạy thay hôm nay' + (o.notYet ? ' · bắt đầu lúc ' + wmEscape(t.st.upcoming[0] ? t.st.upcoming[0].start : '') : '');
    } else if (R.main.t && R.mainOk && R.main.t.email === t.email) {
        sub = 'Cũng là GV lớp chính của bạn · phòng Breakout trong lớp này';
    } else {
        sub = o.notYet ? 'GV Breakout của bạn · bắt đầu lúc ' + wmEscape(t.st.upcoming[0] ? t.st.upcoming[0].start : '') : 'GV Breakout của bạn · đang trực';
    }
    const step1 = t.mainUrl
        ? `<div class="v5-step"><span class="v5-step__n">1</span><a class="v5-btn v5-btn--breakout${o.notYet ? ' v5-btn--soon' : ''}" href="${wmEscape(t.mainUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-headset"></i> Vào Meeting chính để điểm danh</a></div>`
        : '';
    const chips = t.rooms.map(r => `<a class="tmc-room-btn" href="${wmEscape(r.url)}" target="_blank" rel="noopener noreferrer" title="${wmEscape(r.room_name)}">${wmEscape(r.num)}</a>`).join('');
    const step2 = t.rooms.length
        ? `<div class="v5-step"><span class="v5-step__n">2</span><div class="v5-step__txt">Sau khi điểm danh, chọn một phòng trống (${t.rooms.length}):<div class="v5-rooms">${chips}</div></div></div>`
        : (o.notYet
            ? `<div class="v5-step"><span class="v5-step__n">2</span><div class="v5-step__txt">Phòng Breakout sẽ mở khi GV bắt đầu lúc <b>${wmEscape(t.st.upcoming[0] ? t.st.upcoming[0].start : '')}</b>.</div></div>`
            : `<div class="v5-step"><span class="v5-step__n">2</span><div class="v5-step__txt">Phòng Breakout đang kín — ở lại Meeting chính, GV sẽ mời bạn vào phòng.</div></div>`);
    const note = o.notYet ? `<div class="v5-tile__note"><i class="fa-regular fa-clock"></i> Chưa tới giờ — vào đúng giờ GV bắt đầu.</div>` : '';
    const others = (o.others || []).length
        ? `<div class="v5-tile__note"><i class="fa-solid fa-people-arrows"></i> Cũng đang trực: ${o.others.map(x => wmEscape(x.name)).join(', ')}.</div>`
        : '';
    return `<div class="v5-tile v5-tile--breakout">${label}<div class="v5-tile__who">${smV5Avatar(t)}<div class="v5-tile__txt"><div class="v5-tile__name">${wmEscape(t.name)}</div><div class="v5-tile__sub">${sub}</div></div></div><div class="v5-steps">${step1}${step2}</div>${note}${others}</div>`;
}

// Today's card in the two-tile look. Returns null on any error, so the routing
// line in smAgTodayBody falls through to the sm-v3 sections.
async function smV5TodayBody(ctx, items, dbDay, noClass) {
    try {
        const R = await smV5Resolve(ctx, items, dbDay, noClass);
        const [kind, text] = smV5Headline(R);
        const tiles = `<div class="v5-tiles">${smV5MainTile(R)}${smV5BreakoutTile(R)}</div>`;
        const h = R.help[0];
        const helpLeft = h
            ? `<i class="fa-solid fa-headset"></i> Cần giúp? ${wmEscape(h.label)} <b>${wmEscape(h.name)}</b> đang trực${h.url ? ` · <a href="${wmEscape(h.url)}" target="_blank" rel="noopener noreferrer">Vào</a>` : ''}`
            : `<i class="fa-solid fa-headset"></i> Cần giúp? Gọi cho chúng tôi.`;
        const helpBar = `<div class="v5-help"><span>${helpLeft}</span><a class="v5-help__call" href="${wmEscape(SM_V3.SUPPORT_URL)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-phone-volume"></i> Gọi hỗ trợ</a></div>`;
        const badge = (!R.mainOk && !R.brOk)
            ? smCallBadgeHTML(R.relaxed ? 'Cần hỗ trợ hoặc muốn học bù? Hãy gọi cho chúng tôi.' : (R.classOver ? 'Buổi học hôm nay đã qua giờ. Cần hỗ trợ hoặc muốn học bù? Hãy gọi cho chúng tôi.' : `Chưa có giáo viên nào cho buổi học <b>${wmEscape(R.classTime)}</b> của bạn.`), R.relaxed || R.classOver)
            : '';
        const next = R.next ? `<div class="v5-next"><i class="fa-regular fa-calendar"></i> Buổi học tiếp theo: <b>${R.next}</b></div>` : '';
        return `<div class="ag__card ag__card--${kind}">${smStripHTML(kind, text)}<div class="ag__cardbody">${tiles}${badge}${helpBar}${next}</div></div>`;
    } catch (e) {
        console.error('[sm-v5] today render error, falling back to the sections', e);
        return null;
    }
}
// === tansinh sm-v4 END ===
