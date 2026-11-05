// /opt/my-api/routes/_rtrShiftOpenHelper.js
//
// === tansinh rtr-hours v1 (5 Nov 2026) =======================================
// IS THIS TEACHER IN AN OPEN SHIFT RIGHT NOW?  The one server-side answer
// /create-task and /create-ttkb ask before writing a card.
//
//   check(supabase, email) -> { ok:true,  why }                        may create
//                          -> { ok:false, code:'NO_SHIFT', error, why }  refuse (409)
//
// "Open" = a gio_lam_viec row of TODAY (Vietnam day) with real_end_time null
// whose roster end (end_time, saved at Bắt đầu) has not passed. THE ROSTER END
// IS THE END: a teacher who never presses Kết thúc ca is ended by the clock
// here, in /check-start-work (which also writes real_end_time) and by the
// sweeper /opt/scripts/rtr-shift-closer.js. A row with no end_time waits for
// Kết thúc ca, as before. An overnight row (end before start) is left open
// here and closed by the sweeper.
//
// THE SAME EXCEPTIONS AS THE RECORDING GATE (/opt/my-api/rtr-recgate.json):
//   enabled:false  -> ok  (gate switched off: nobody records, nobody starts a row)
//   bypass_roles   -> ok  (['Super Admin'] by default; the role read by email)
// A missing email is refused BEFORE those two, so a probe with no email never
// reaches an insert whatever the gate says.
// A read error never blocks: ok, logged (fail-open, like the checks around it).
//
// Not a route: the leading "_" keeps server.js from loading it; the capital H
// in the name lets git-push-site.sh collect it (it takes _*Helper.js).
// ============================================================================
'use strict';

const fs = require('fs');

const CONF_FILE = '/opt/my-api/rtr-recgate.json';
const DEFAULT_BYPASS = ['Super Admin'];
const MSG_NOT_STARTED = 'Bạn chưa bắt đầu ca làm việc, nên chưa tạo được công việc.';
const MSG_ENDED = 'Ca làm việc đã kết thúc, nên không tạo thêm được công việc. Ngoài giờ làm việc bạn chỉ xem được.';

let confCache = { at: 0, val: null };

function conf() {
  if (confCache.val && Date.now() - confCache.at < 15000) return confCache.val;
  let val = { enabled: true, bypass_roles: DEFAULT_BYPASS };
  try {
    const raw = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    if (raw && typeof raw === 'object') val = Object.assign(val, raw);
  } catch (e) { /* no file = defaults, as the gate itself does */ }
  confCache = { at: Date.now(), val: val };
  return val;
}

// Vietnam clock, the way check-start-work reads it.
function bkk(now) {
  const d = new Date((now || new Date()).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return { ymd: ymd, minutes: d.getHours() * 60 + d.getMinutes() };
}

function toMin(t) {
  if (t === null || t === undefined || t === '') return null;
  const p = String(t).split(':');
  const h = Number(p[0]), m = Number(p[1] || 0);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h * 60 + m;
}

// One row: open right now?
function isOpenRow(row, nowMin) {
  if (!row) return false;
  if (row.real_end_time !== null && row.real_end_time !== undefined) return false;
  const end = toMin(row.end_time);
  if (end === null) return true;                       // no roster end on the row: only Kết thúc ca ends it
  const start = toMin(row.start_time);
  if (start !== null && end < start) return true;      // overnight: ends tomorrow, the sweeper closes it
  return nowMin < end;
}

async function check(supabase, email, opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  try {
    const em = String(email || '').trim();
    if (!em) return { ok: false, code: 'NO_SHIFT', error: MSG_NOT_STARTED, why: 'no-email' };

    const c = conf();
    if (c.enabled === false) return { ok: true, why: 'gate-off' };

    const { data: roleRow } = await supabase.from('user_roles').select('role').eq('email', em).maybeSingle();
    const role = roleRow && roleRow.role ? String(roleRow.role).trim() : '';
    const bypass = Array.isArray(c.bypass_roles) ? c.bypass_roles : DEFAULT_BYPASS;
    if (role && bypass.includes(role)) return { ok: true, why: 'bypass:' + role };

    const t = bkk(now);
    const { data: rows, error } = await supabase
      .from('gio_lam_viec')
      .select('start_time, end_time, real_end_time')
      .eq('email', em)
      .gte('created_at', t.ymd + 'T00:00:00+07:00')
      .lte('created_at', t.ymd + 'T23:59:59.999+07:00');
    if (error) {
      console.error('[rtr-shift-open] read failed, letting it through:', error.message);
      return { ok: true, why: 'read-error' };
    }
    const list = Array.isArray(rows) ? rows : [];
    if (list.some(r => isOpenRow(r, t.minutes))) return { ok: true, why: 'open' };
    return { ok: false, code: 'NO_SHIFT', error: list.length ? MSG_ENDED : MSG_NOT_STARTED, why: list.length ? 'ended' : 'not-started' };
  } catch (e) {
    console.error('[rtr-shift-open] error, letting it through:', e && e.message ? e.message : e);
    return { ok: true, why: 'error' };
  }
}

module.exports = { check, isOpenRow, toMin, bkk, _conf: conf, MSG_NOT_STARTED, MSG_ENDED };
