// /opt/my-api/routes/_rtrShiftBudgetHelper.js
//
// === tansinh shift-budget v1.1 (5 Nov 2026; v1.1 adds details() for the page's popup) ===
// THE ROSTER SHIFT IS A BUDGET OF MINUTES.
//
// meetings.tansinh.info gives a teacher a shift, say 08:00-11:00 = 180 minutes.
// A new work card (create-task) or TTKB batch (create-ttkb) may never take the
// shift's total past those minutes, and may never run past the shift's end:
//
//     give = min( planned, floor(budget left), floor(minutes to the shift's end) )
//
// Under one minute the card is REFUSED (409 SHIFT_BUDGET with a Vietnamese
// sentence; the page shows it as it is: alert('Lỗi: ' + error)). Otherwise the
// card's status "<N>" is shortened to give, and everything else follows by
// itself, because they all read that same <N>: the page's countdown (maxMap),
// the page's own close at 0 (rtrOnDeadline -> /rtr-card-done auto), the
// 2-minute closer (rtr-card-closer.js), the cut (finalizeBatch) and the pay
// (glv-get-calculated-time-batch: cap = <N>, +3 when paired).
//
// SPENT = the minutes already used in THIS shift. Every batch (one card, or two
// cards sharing a batch_ts) created inside the shift's window, counted ONCE:
//     closed  (completed_at set)        min(completed_at - created_at, cap)
//     open    (no completed_at yet)     cap, its planned minutes, until it ends
// cap = _rtrCloseHelper.capMinutes(rows): the biggest <N> in the batch, 10
// when none, +3 for a batch of 2 (the page's pair boost). Extra sessions and
// TTKB cards count like any other card (decided 5 Nov 2026).
//
// THE SHIFT comes from /check-shift-permission on this same server, called on
// 127.0.0.1 (the way mtx-bulk calls /mtx-send): today's roster shifts of this
// teacher, with off-days, duplicates and contained shifts already removed, as
// [{start:'08:00', end:'11:00'}]. Overlapping or touching shifts are merged
// into one window; two separate shifts (08-11 and 15-18) are two budgets. The
// current shift is the window whose [start, end + 20 min] holds now (the same
// grace the gate gives). A Super Admin gets shifts [] -> no shift -> no cap.
//
// STRICT END (decided 5 Nov 2026): CLOCK_GRACE_MIN = 0. The gate still lets
// the picker open until end + 20; the budget then gives 0 minutes and refuses,
// naming the end time. CLOCK_GRACE_MIN = 20 would allow a card until end + 20.
//
// FAIL-OPEN, on purpose: if the loopback call or the work read fails, the card
// is created exactly as before and ONE line "[shift-budget] FAIL-OPEN ..." is
// logged. A broken check must never lock a teacher out mid-shift (the same
// three-state thinking as the recording gate). budgetFor() never throws.
//
// ⚠️ The capital H in this file's name is load-bearing: git-push-site.sh
//    collects "_*Helper.js". The leading "_" keeps server.js from loading it as
//    a route. A require of a missing helper throws at boot and stops EVERY
//    route, so the installer restores the routes BEFORE it removes this file.
// ⚠️ Pure parts first (what the installer's selftest runs with no database),
//    then the two functions that talk to the world.
// ===========================================================================

'use strict';

const H = require('./_rtrCloseHelper');

const GRACE_AFTER_END_MIN = 20;   // membership window: check-shift-permission's GRACE_AFTER_END
const CLOCK_GRACE_MIN = 0;        // strict end. 20 = a card may still start until end + 20
const DEFAULT_PLANNED_MIN = 10;   // the page's "maxMins ?? 10"
const PAIR_EXTRA_MIN = 3;         // the page's +3 for a batch of two
const LOOPBACK_TIMEOUT_MS = 8000;

// --------------------------------------------------------------- pure parts

/** Vietnam clock of a Date (no DST: shift the instant by +7h, read UTC fields). */
function vnParts(d) {
  const date = d instanceof Date ? d : new Date();
  const t = new Date(date.getTime() + 7 * 3600 * 1000);
  const hh = t.getUTCHours(), mi = t.getUTCMinutes(), ss = t.getUTCSeconds();
  return {
    date: date,
    ymd: t.toISOString().slice(0, 10),
    minutes: hh * 60 + mi + ss / 60,
    hhmm: String(hh).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
  };
}

/** "08:00" or "08:00:00" -> 480. null when it is not a time. */
function parseHHMM(s) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtHHMM(min) {
  min = Math.max(0, Math.round(Number(min) || 0));
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/** "3 giờ", "2 giờ 30 phút", "45 phút". */
function fmtDur(min) {
  min = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return h + ' giờ ' + String(m).padStart(2, '0') + ' phút';
  if (h) return h + ' giờ';
  return m + ' phút';
}

/** [{start,end}] from the gate -> windows [{startMin,endMin,start,end,total}],
 *  sorted, overlapping or touching ones merged. Bad rows are skipped. */
function mergeShifts(shifts) {
  const items = [];
  for (const s of shifts || []) {
    const a = parseHHMM(s && s.start), b = parseHHMM(s && s.end);
    if (a === null || b === null || b <= a) continue;
    items.push({ startMin: a, endMin: b });
  }
  items.sort((x, y) => (x.startMin - y.startMin) || (x.endMin - y.endMin));
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.startMin <= last.endMin) {
      if (it.endMin > last.endMin) last.endMin = it.endMin;
    } else {
      out.push({ startMin: it.startMin, endMin: it.endMin });
    }
  }
  for (const w of out) {
    w.start = fmtHHMM(w.startMin);
    w.end = fmtHHMM(w.endMin);
    w.total = w.endMin - w.startMin;
  }
  return out;
}

/** The window whose [start, end + grace] holds now. Several -> the latest start. */
function currentShift(windows, nowMin) {
  let best = null;
  for (const w of windows || []) {
    if (nowMin >= w.startMin && nowMin <= w.endMin + GRACE_AFTER_END_MIN) {
      if (!best || w.startMin > best.startMin) best = w;
    }
  }
  return best;
}

/** Vietnam minutes-of-day on a Vietnam date -> ISO instants. The window of
 *  membership runs to end + grace, so a card made in the grace belongs here. */
function windowUtc(ymd, startMin, endMin) {
  const base = Date.parse(ymd + 'T00:00:00+07:00');
  return {
    fromISO: new Date(base + startMin * 60000).toISOString(),
    toISO: new Date(base + (endMin + GRACE_AFTER_END_MIN) * 60000).toISOString()
  };
}

/** What ONE batch spends: closed -> min(completed - created, cap); open -> cap. */
function batchMinutes(rows) {
  const cap = H.capMinutes(rows);
  const created = H.earliestCreated(rows);
  let completed = null;
  for (const r of rows || []) {
    const ms = r && r.completed_at ? new Date(r.completed_at).getTime() : NaN;
    if (Number.isFinite(ms) && (completed === null || ms > completed)) completed = ms;
  }
  if (!created || completed === null) return { cap: cap, minutes: cap, open: true };
  const elapsed = (completed - created.getTime()) / 60000;
  return { cap: cap, minutes: Math.max(0, Math.min(elapsed, cap)), open: false };
}

/** Group work rows by batch_ts, sum what each batch spends. excludeBatchTs =
 *  the batch being created right now (never counted against itself). */
function sumBatches(rows, excludeBatchTs) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = String((r && r.batch_ts) || '');
    if (!k) continue;
    if (excludeBatchTs && k === String(excludeBatchTs)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const batches = [];
  let spent = 0;
  for (const [k, g] of groups) {
    const b = batchMinutes(g);
    const c = H.earliestCreated(g);
    batches.push({
      batch_ts: k, task: String(g[0].task || ''), cards: g.length,
      created_at: c ? c.toISOString() : null, cap: b.cap,
      minutes: Math.round(b.minutes * 10) / 10, open: b.open
    });
    spent += b.minutes;
  }
  batches.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return { spent: spent, batches: batches };
}

/** Minutes a status "<N>" plans; 10 when there is none (the page's default). */
function plannedOf(statusString) {
  const n = H.statusMinutes(statusString);
  return n === null ? DEFAULT_PLANNED_MIN : n;
}

/** The planned cap of a whole TTKB batch: the biggest student status (10 when
 *  none), +3 for a pair. statuses are the raw danh_sach_hv.status values. */
function plannedOfBatch(statuses, isPair) {
  let max = null;
  for (const s of statuses || []) {
    const n = H.statusMinutes('<' + ((s === null || s === undefined) ? '' : s) + '>');
    if (n !== null && (max === null || n > max)) max = n;
  }
  return (max === null ? DEFAULT_PLANNED_MIN : max) + (isPair ? PAIR_EXTRA_MIN : 0);
}

/** The minutes a new card may have. planned stays untouched unless the budget
 *  or the clock has less; the two limits are whole minutes. */
function giveMinutes(planned, b) {
  const left = Math.floor(Number(b.left) + 1e-9);
  const clock = Math.floor(Number(b.clockLeft) + 1e-9);
  return Math.min(Number(planned), left, clock);
}

/** The status to write for ONE row of a batch whose cap may not pass give.
 *  give null = the budget does not bite: the status is returned as it is.
 *  For a pair the row's own <N> may be at most give - 3 (the +3 brings the
 *  batch cap back to give); never below 1, so a pair with give 1..3 ends at
 *  4 minutes (a known overshoot of up to 3 minutes, in that corner only). */
function capStatus(statusString, give, isPair) {
  if (give === null || give === undefined) return statusString;
  const own = plannedOf(statusString);
  const limit = Math.max(1, isPair ? give - PAIR_EXTRA_MIN : give);
  if (own <= limit) return statusString;
  return '<' + limit + '>';
}

/** The sentence the picker shows when a card is refused. */
function refusal(b) {
  const head = 'Ca làm việc của bạn (' + b.shift.start + '–' + b.shift.end + ')';
  if (Number(b.clockLeft) < 1) {
    return head + ' đã kết thúc lúc ' + b.shift.end + '. Không thể tạo thêm công việc trong ca này.';
  }
  return head + ' đã dùng hết ' + fmtDur(b.total) + '. Không thể tạo thêm công việc trong ca này.';
}

function r1(n) { return Math.round(Number(n) * 10) / 10; }

/** The numbers behind a decision, for the page's popup (shift-popup v1).
 *  Whole minutes, no names. why = which limit decided: 'clock' (the shift's
 *  end) or 'budget' (the minutes already used). */
function details(b, planned, give) {
  const left = Math.max(0, Math.floor(Number(b.left) + 1e-9));
  const clock = Math.max(0, Math.floor(Number(b.clockLeft) + 1e-9));
  return {
    cut: give >= 1 && give < Number(planned),
    refused: give < 1,
    why: clock <= left ? 'clock' : 'budget',
    shift: { start: b.shift.start, end: b.shift.end },
    total: b.total,
    spent: Math.round(Number(b.spent)),
    left: left,
    clockLeft: clock,
    cards: (b.batches || []).reduce((n, x) => n + (Number(x.cards) || 0), 0),
    batches: (b.batches || []).length,
    planned: Number(planned),
    give: give < 1 ? 0 : give
  };
}

/** One log line per decision, like ring-phone's. No names of students. */
function logLine(email, b, planned, give, kind) {
  return '[shift-budget] ' + String(email || '').toLowerCase() + ' ' + (kind || 'TASK')
    + ' shift ' + b.shift.start + '-' + b.shift.end + ' total ' + b.total
    + ' spent ' + r1(b.spent) + ' left ' + r1(b.left) + ' clock-left ' + r1(b.clockLeft)
    + ' planned ' + planned + ' give ' + give
    + (give < 1 ? ' REFUSED' : (give < Number(planned) ? ' CUT' : ''));
}

// ------------------------------------------------------- talk to the world

/** Today's roster shifts for this teacher, from the gate on this same server.
 *  Resolves to { ok, allowed, reason, shifts } or { ok:false, error }. Never throws. */
async function shiftsToday(email, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || globalThis.fetch;
  const base = opts.apiBase || process.env.RTR_API_BASE || ('http://127.0.0.1:' + (process.env.PORT || 3111));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOPBACK_TIMEOUT_MS);
  try {
    const r = await doFetch(base + '/check-shift-permission', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }), signal: ctrl.signal
    });
    let j = null;
    try { j = await r.json(); } catch (_) { j = null; }
    if (!r.ok || !j) return { ok: false, error: 'check-shift-permission HTTP ' + r.status };
    return { ok: true, allowed: !!j.allowed, reason: String(j.reason || ''), shifts: Array.isArray(j.shifts) ? j.shifts : [] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The budget of the teacher's CURRENT roster shift.
 *    { shift:null, reason }                               no cap applies
 *    { shift:{start,end}, total, spent, left, clockLeft, batches, windows, nowHHMM, ymd, reason:'ok' }
 *  opts: batchTs (the batch being created, never counted), now (tests), fetch (tests), apiBase */
async function budgetFor(supabase, email, opts) {
  opts = opts || {};
  const now = vnParts(opts.now);
  try {
    const st = await shiftsToday(email, opts);
    if (!st.ok) {
      console.log('[shift-budget] FAIL-OPEN ' + String(email || '').toLowerCase() + ': ' + st.error);
      return { shift: null, reason: 'fail-open', error: st.error, nowHHMM: now.hhmm, ymd: now.ymd };
    }
    const windows = mergeShifts(st.shifts);
    const cur = currentShift(windows, now.minutes);
    if (!cur) {
      return { shift: null, reason: (st.shifts.length ? 'outside_shift' : (st.reason || 'no_shift')), windows: windows, nowHHMM: now.hhmm, ymd: now.ymd };
    }
    const w = windowUtc(now.ymd, cur.startMin, cur.endMin);
    const { data, error } = await supabase
      .from('work')
      .select(H.ROW_SELECT)
      .eq('email', email)
      .gte('created_at', w.fromISO)
      .lt('created_at', w.toISO);
    if (error) {
      console.log('[shift-budget] FAIL-OPEN ' + String(email || '').toLowerCase() + ': work read: ' + error.message);
      return { shift: null, reason: 'fail-open', error: 'work read: ' + error.message, nowHHMM: now.hhmm, ymd: now.ymd };
    }
    const sum = sumBatches(data || [], opts.batchTs);
    return {
      shift: { start: cur.start, end: cur.end }, total: cur.total,
      spent: sum.spent, left: cur.total - sum.spent,
      clockLeft: cur.endMin + CLOCK_GRACE_MIN - now.minutes,
      batches: sum.batches, windows: windows, nowHHMM: now.hhmm, ymd: now.ymd, reason: 'ok'
    };
  } catch (e) {
    console.log('[shift-budget] FAIL-OPEN ' + String(email || '').toLowerCase() + ': ' + String((e && e.message) || e));
    return { shift: null, reason: 'fail-open', error: String((e && e.message) || e), nowHHMM: now.hhmm, ymd: now.ymd };
  }
}

module.exports = {
  vnParts, parseHHMM, fmtHHMM, fmtDur, mergeShifts, currentShift, windowUtc,
  batchMinutes, sumBatches, plannedOf, plannedOfBatch, giveMinutes, capStatus,
  refusal, logLine, details, shiftsToday, budgetFor,
  GRACE_AFTER_END_MIN, CLOCK_GRACE_MIN, DEFAULT_PLANNED_MIN, PAIR_EXTRA_MIN
};
