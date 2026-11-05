'use strict';
// _rtrTaskScheduleHelper.js  -  the task schedule gate  (tansinh task-sched v1, 5 Nov 2026)
//
// Used by get-task-options.realtimereport.js and check-task-validity.realtimereport.js.
// NOT a route: server.js skips files that start with "_". The capital H is on purpose:
// git-push-site.sh collects "_*Helper.js" into the repo (a hyphen or a small h would be in no repo).
//
// WHAT IT ANSWERS: "does this schedule allow the task RIGHT NOW, Vietnam time?"
// A schedule is a task's own "Lich thuc hien" (table work_tasks_calendar) or one teacher's
// "GV phu trach" row (table work_tasks_teacher_assignments). Both rows have the same shape:
//     days        ["T2","T3",...,"CN"]                 empty = every day
//     shifts      ["morning","afternoon","evening"]     empty = any time of day
//     date_from / date_to  (YYYY-MM-DD), is_indefinite  none = no date limit
//
// THE SHIFT BANDS are the ones meetings.tansinh.info draws (ROSTER_BANDS in its script.js):
//     morning    00:00 - 12:00    Sang
//     afternoon  12:00 - 18:00    Chieu
//     evening    18:00 - 24:00    Toi
// BAND_GRACE_MIN: a band still counts for this many minutes after it ends - the same 20 minutes
// /check-shift-permission allows after a shift ends. Set it to 0 for sharp edges.

const BANDS = [
  { key: 'morning',   lo: 0,       hi: 12 * 60, name: 'Sáng'  },
  { key: 'afternoon', lo: 12 * 60, hi: 18 * 60, name: 'Chiều' },
  { key: 'evening',   lo: 18 * 60, hi: 24 * 60, name: 'Tối'   },
];
const BAND_GRACE_MIN = 20;
const DAY_CODES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];   // index = JS getDay(): 0 = Sunday

function pad2(n) { return String(n).padStart(2, '0'); }

// Vietnam "now": { ymd, dayCode, minutes, bands }. Pass a Date to test a fixed moment.
// (The Date is read as WALL-CLOCK Vietnam time, the same trick the routes already use.)
function now(d) {
  const bkk = (d instanceof Date) ? d : new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const ymd = bkk.getFullYear() + '-' + pad2(bkk.getMonth() + 1) + '-' + pad2(bkk.getDate());
  const minutes = (bkk.getHours() * 60) + bkk.getMinutes();
  const bands = new Set();
  for (const b of BANDS) {
    if (minutes >= b.lo && minutes < b.hi) bands.add(b.key);                                   // the band we are in
    else if (minutes >= b.hi && minutes < b.hi + BAND_GRACE_MIN) bands.add(b.key);              // just ended, inside the grace
  }
  return { ymd, dayCode: DAY_CODES[bkk.getDay()], minutes, bands, hhmm: pad2(bkk.getHours()) + ':' + pad2(bkk.getMinutes()) };
}

// Does this schedule row allow the task at moment n?  -> { ok, why }   why = 'date' | 'day' | 'shift' | null
function allows(row, n) {
  const t = n || now();
  const r = row || {};
  if (r.is_indefinite !== true) {
    const df = r.date_from ? String(r.date_from).slice(0, 10) : null;
    const dt = r.date_to   ? String(r.date_to).slice(0, 10)   : null;
    if (df && t.ymd < df) return { ok: false, why: 'date' };
    if (dt && t.ymd > dt) return { ok: false, why: 'date' };
  }
  const days = (Array.isArray(r.days) ? r.days : []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  if (days.length > 0 && !days.includes(t.dayCode)) return { ok: false, why: 'day' };
  const shifts = (Array.isArray(r.shifts) ? r.shifts : []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
  if (shifts.length > 0 && !shifts.some(s => t.bands.has(s))) return { ok: false, why: 'shift' };
  return { ok: true, why: null };
}

// The ticked bands as ONE time window, when they are one band or adjacent bands:
//   ["evening"]              -> { from: "18:00:00", to: "24:00:00" }
//   ["afternoon","evening"]  -> { from: "12:00:00", to: "24:00:00" }
//   ["morning","evening"]    -> null   (two separate windows; the page cannot show that as one)
function bandWindow(shifts) {
  const set = new Set((Array.isArray(shifts) ? shifts : []).map(x => String(x || '').trim().toLowerCase()));
  const on = BANDS.map(b => set.has(b.key));
  const idx = [];
  on.forEach((v, i) => { if (v) idx.push(i); });
  if (!idx.length) return null;
  for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return null;   // a gap: not one window
  const lo = BANDS[idx[0]].lo, hi = BANDS[idx[idx.length - 1]].hi;
  return { from: pad2(Math.floor(lo / 60)) + ':00:00', to: pad2(Math.floor(hi / 60)) + ':00:00' };
}

// A short Vietnamese description of a schedule row, for messages and logs. "" when it has no limits.
function describe(row) {
  const r = row || {};
  const parts = [];
  const days = (Array.isArray(r.days) ? r.days : []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  if (days.length) parts.push(days.join(', '));
  const set = new Set((Array.isArray(r.shifts) ? r.shifts : []).map(x => String(x || '').trim().toLowerCase()));
  const names = BANDS.filter(b => set.has(b.key)).map(b => b.name);
  if (names.length) parts.push(names.join(', '));
  if (r.is_indefinite !== true && (r.date_from || r.date_to)) {
    const f = (v) => { const s = String(v || '').slice(0, 10); return s ? s.split('-').reverse().join('/') : ''; };
    parts.push((f(r.date_from) || '...') + ' - ' + (f(r.date_to) || '...'));
  }
  return parts.join(' · ');
}

// An email as a safe ILIKE pattern (case-insensitive match, no wildcards left open).
// Returns null for anything that is not a plain email, so the caller can refuse it.
function ilikePattern(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254 || /[\s,()*"']/.test(e) || e.indexOf('@') < 1) return null;
  return e.replace(/[\\%_]/g, (c) => '\\' + c);
}

module.exports = { BANDS, BAND_GRACE_MIN, DAY_CODES, now, allows, bandWindow, describe, ilikePattern };
