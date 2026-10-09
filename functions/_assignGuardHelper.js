// _assignGuardHelper.js — tansinh assign-guard (8 Oct 2026)
//
// ONE question, asked by every route that puts a teacher on a lesson:
//   "may this teacher take this lesson (student_schedule row)?"
//
// A lesson is weekly (day_of_week + time_local). It is refused when:
//   1. CALENDAR  the teacher has no free hours on calendar.tansinh.info that weekday
//                (teacher_availability), or the lesson does not fit inside them.
//   2. SHIFT     the teacher has no weekly shift on meetings.tansinh.info that weekday
//                (meeting_content, recurring rows only), or the lesson does not fit inside one.
//   3. MINUTES   the lessons this teacher is already in charge of inside that shift, plus this
//                one, need more minutes than the shift has.
// Rules 2 and 3 apply only when the teacher is IN CHARGE of the lesson: the main teacher for a
// normal lesson, the breakout teacher for a buổi phụ — the same rule as teachers.tansinh.info
// (tm-coverage.teachers.js, inCharge). A breakout teacher on a normal lesson, or a main teacher on
// a buổi phụ, gets rule 1 only.
// Lesson minutes = danh_sach_hv.status; unknown -> DEFAULT_MIN (25, tm-coverage's own default).
// A one-time shift (is_one_time) or a shift switched off for one date is NOT a weekly shift, so it
// neither helps nor hurts a weekly lesson.
//
// SWITCH  /opt/my-api/assign-guard.json, re-read on every call, no restart:
//   { "enabled": true, "no_shift_refuses": true, "check_end": true }
//   enabled false          -> the guard says yes to everything (the old behaviour)
//   no_shift_refuses false -> no weekly shift that day is allowed (rules 2-3 skipped)
//   check_end false        -> only the START has to be inside the calendar hours and the shift
//   A missing or broken file -> the defaults above. Edit it with nano, never a PowerShell here-string.
//
// The file name starts with "_" so server.js never loads it as a route, and ends "Helper.js" so
// git-push-site.sh collects it. Nothing here is required at load time: the routes require it lazily.

const fs = require('fs');

const SWITCH_FILE = '/opt/my-api/assign-guard.json';
const DEFAULTS = { enabled: true, no_shift_refuses: true, check_end: true };
const DEFAULT_MIN = 25;
const DAY = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

function settings(file = SWITCH_FILE) {
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...(j && typeof j === 'object' ? j : {}) };
  } catch (e) {
    console.warn('[assign-guard] ' + file + ' could not be read, using defaults:', e.message || e);
    return { ...DEFAULTS };
  }
}

function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t == null ? '' : t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function hm(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function dur(min) { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m} phút`; }
function lower(s) { return String(s || '').trim().toLowerCase(); }
function isOne(v) { return v === true || v === 1 || ['true', 't', '1'].includes(String(v).toLowerCase()); }
function dowOfYmd(ymd) { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); if (!y || !m || !d) return null; return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

// union of [s, e) intervals; touching intervals join (18-19 and 19-20 is one 18-20)
function union(list) {
  const iv = list.filter(([s, e]) => s !== null && e !== null && e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) { const last = out[out.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]); }
  return out;
}
const fmtList = iv => iv.map(([s, e]) => `${hm(s)}–${hm(e)}`).join(', ');

// the teacher's calendar hours on one weekday
function calendarIv(availRows, day) {
  return union((availRows || []).filter(r => Number(r.day_of_week) === day).map(r => [toMin(r.time_start), toMin(r.time_end)]));
}
// the teacher's WEEKLY shifts on one weekday (recurring meeting_content rows only)
function shiftIv(shiftRows, day) {
  return union((shiftRows || []).filter(r => !isOne(r.is_one_time) && dowOfYmd(r.work_date) === day).map(r => [toMin(r.start_time), toMin(r.end_time)]));
}
// is this lesson row in this teacher's charge?
function inChargeOf(row, email) {
  const e = lower(email);
  return row.buoi_phu ? lower(row.breakout_email) === e : lower(row.teacher_email) === e;
}

/**
 * The pure decision. No database. Every list is already filtered to this teacher (rows of other
 * teachers are ignored anyway).
 *   sched     the lesson row { id, student_email, day_of_week, time_local, buoi_phu }
 *   role      'teacher' (main, teacher_email) | 'breakout' (breakout_email)
 *   avail     teacher_availability rows of the teacher
 *   shifts    meeting_content rows of the teacher
 *   booked    student_schedule rows on that weekday that name the teacher (either column)
 *   minutesOf student email -> status minutes, or null
 * -> { ok: true, info } | { ok: false, reason, error, detail }
 */
function evaluate({ sched, email, name, role, avail, shifts, booked, minutesOf, cfg }) {
  cfg = { ...DEFAULTS, ...(cfg || {}) };
  const who = name || String(email || '').split('@')[0];
  const day = Number(sched.day_of_week), dayName = DAY[day] || `thứ ${day}`;
  const t = toMin(sched.time_local);
  if (t === null || !(day >= 0 && day <= 6)) return { ok: true, info: 'lesson has no usable day/time: not checked' };
  const raw = minutesOf(sched.student_email);
  const mine = raw > 0 ? raw : DEFAULT_MIN;
  const end = t + mine;
  const inCharge = role === 'breakout' ? !!sched.buoi_phu : !sched.buoi_phu;
  const refuse = (reason, error, detail) => ({ ok: false, reason, error, detail: { teacher: email, day, time: hm(t), minutes: mine, ...detail } });

  // 1. calendar
  const cal = calendarIv(avail, day);
  if (!cal.length) return refuse('no_calendar', `${who} chưa có giờ rảnh trên calendar.tansinh.info vào ${dayName}. Không gán được.`, {});
  const c = cal.find(([s, e]) => s <= t && t < e);
  if (!c) return refuse('outside_calendar', `Buổi ${hm(t)} ${dayName} nằm ngoài giờ rảnh của ${who} trên calendar.tansinh.info (${fmtList(cal)}).`, { calendar: fmtList(cal) });
  if (cfg.check_end && inCharge && end > c[1]) return refuse('past_calendar', `Buổi ${hm(t)}–${hm(end)} ${dayName} vượt quá giờ rảnh của ${who} (rảnh đến ${hm(c[1])}).`, { calendar: fmtList(cal) });
  if (!inCharge) return { ok: true, info: 'not in charge of this lesson: calendar checked only' };

  // 2. shift
  const sh = shiftIv(shifts, day);
  if (!sh.length) {
    if (!cfg.no_shift_refuses) return { ok: true, info: 'no weekly shift, allowed by the switch' };
    return refuse('no_shift', `${who} chưa có ca làm trên meetings.tansinh.info vào ${dayName}. Không gán được.`, {});
  }
  const s = sh.find(([a, b]) => a <= t && t < b);
  if (!s) return refuse('outside_shift', `Buổi ${hm(t)} ${dayName} nằm ngoài ca làm của ${who} trên meetings.tansinh.info (${fmtList(sh)}).`, { shifts: fmtList(sh) });
  if (cfg.check_end && end > s[1]) return refuse('past_shift', `Buổi ${hm(t)}–${hm(end)} ${dayName} vượt quá ca làm ${hm(s[0])}–${hm(s[1])} của ${who}.`, { shifts: fmtList(sh) });

  // 3. minutes inside that shift
  let used = 0, n = 0;
  for (const r of booked || []) {
    if (String(r.id) === String(sched.id) || Number(r.day_of_week) !== day || !inChargeOf(r, email)) continue;
    const rt = toMin(r.time_local); if (rt === null || rt < s[0] || rt >= s[1]) continue;
    const m = minutesOf(r.student_email); used += m > 0 ? m : DEFAULT_MIN; n++;
  }
  const work = s[1] - s[0];
  if (used + mine > work) {
    return refuse('over_shift', `Ca làm ${hm(s[0])}–${hm(s[1])} ${dayName} của ${who} có ${dur(work)}: đã xếp ${dur(used)} (${n} buổi), thêm buổi này ${dur(mine)} sẽ vượt ${dur(used + mine - work)}.`,
      { shift: `${hm(s[0])}–${hm(s[1])}`, work, used, lessons: n });
  }
  return { ok: true, info: `fits: ${used + mine} of ${work} minutes in ${hm(s[0])}–${hm(s[1])}` };
}

/**
 * The route-side call. Reads only what the decision needs.
 * -> { ok: true } | { ok: false, status, error, reason, detail }
 * A database error refuses with 503 (fail closed); assign-guard.json { "enabled": false } is the way out.
 */
async function check(supabase, { schedId, teacherEmail, role = 'teacher' }) {
  const cfg = settings();
  if (!cfg.enabled) return { ok: true, info: 'guard switched off' };
  const email = String(teacherEmail || '').trim();
  if (!schedId || !email) return { ok: true, info: 'nothing to check' };
  try {
    const emails = [...new Set([email, lower(email)])];
    const { data: sched, error: e1 } = await supabase.from('student_schedule')
      .select('id, student_email, day_of_week, time_local, buoi_phu').eq('id', schedId).maybeSingle();
    if (e1) throw e1;
    if (!sched) return { ok: true, info: 'lesson not found: the route decides' };
    const day = Number(sched.day_of_week);
    const [av, sh, b1, b2, nm] = await Promise.all([
      supabase.from('teacher_availability').select('day_of_week, time_start, time_end').in('teacher_email', emails).eq('day_of_week', day),
      supabase.from('meeting_content').select('id, work_date, start_time, end_time, is_one_time').in('teacher_email', emails),
      supabase.from('student_schedule').select('id, student_email, day_of_week, time_local, teacher_email, breakout_email, buoi_phu').eq('day_of_week', day).in('teacher_email', emails),
      supabase.from('student_schedule').select('id, student_email, day_of_week, time_local, teacher_email, breakout_email, buoi_phu').eq('day_of_week', day).in('breakout_email', emails),
      supabase.from('user_roles').select('full_name').in('email', emails).limit(1),
    ]);
    for (const r of [av, sh, b1, b2]) if (r.error) throw r.error;
    const booked = [...new Map([...(b1.data || []), ...(b2.data || [])].map(r => [String(r.id), r])).values()];
    const studs = [...new Set([sched.student_email, ...booked.map(r => r.student_email)].filter(Boolean))];
    const mins = new Map();
    if (studs.length) {
      const { data: hv, error: e2 } = await supabase.from('danh_sach_hv').select('email, status').in('email', studs);
      if (e2) throw e2;
      for (const h of hv || []) mins.set(lower(h.email), Number(h.status) || null);
    }
    const name = nm && nm.data && nm.data[0] && nm.data[0].full_name || '';
    const v = evaluate({ sched, email, name, role, avail: av.data, shifts: sh.data, booked, minutesOf: e => mins.get(lower(e)) || null, cfg });
    if (!v.ok) {
      console.log(`[assign-guard] REFUSED ${role} ${email} sched=${schedId} ${v.reason}`);
      return { ok: false, status: 409, error: v.error, reason: v.reason, detail: v.detail };
    }
    return v;
  } catch (e) {
    console.error('[assign-guard] could not check, refusing:', e && e.message || e);
    return { ok: false, status: 503, reason: 'check_failed', error: 'Không kiểm tra được giờ làm của giáo viên lúc này. Thử lại sau giây lát.' };
  }
}

module.exports = { check, evaluate, settings, calendarIv, shiftIv, inChargeOf, union, toMin, hm, dur, DEFAULT_MIN, DAY, DEFAULTS };
