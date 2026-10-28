/* =====================================================================
   _subAssignedHelper.js  --  WHO IS SUPPOSED TO TEACH THIS LEARNER TODAY
   Built 12/10/2026 for submit.tansinh.info (TSPATCH-SUBASSIGNED-20261012).

   NOT A ROUTE. The leading underscore keeps server.js from loading it, and
   the capital H with no hyphen is what git-push-site.sh collects (_*Helper.js).
   Required by sub-api.submit.js.

   ONE QUESTION: for learner X on date D, who is the TTKB teacher and who is
   the Breakout teacher? The answer is read, never guessed, from the tables
   the calendar, meeting and baihoc apps already keep:

     student_schedule                 the plan: teacher_email (TTKB) and
                                      breakout_email, per day_of_week
     student_schedule_transfers       a one-day TTKB move (to_teacher_email)
     session_substitute_assignments   a one-day substitute, role 'TTKB' or
                                      'Breakout' (measured 12/10/2026: those
                                      two values and no others, 278 rows)
     meeting_assigned                 the day's live owner, written by the
                                      meeting app's "tiếp HV". Listed as
                                      owners[], NEVER used to overwrite the
                                      plan -- empty on most days.

   THE PRECEDENCE IS COPIED FROM get-student-ttkb.baihoc.js, which is what
   the student's own page already shows them:
     TTKB     = schedule row -> transfer -> substitute (role TTKB)
     Breakout = schedule row -> substitute (role Breakout)
   The schedule row is the non-buoi_phu one when several exist, else the
   first -- the same choice get-student-ttkb makes.

   ⚠️ day_of_week IS JavaScript's getUTCDay() OF THE BANGKOK DATE: 0 = Sunday.
      Measured 12/10/2026: values 0..6, Monday = 1. Not ISO (Monday = 1,
      Sunday = 7). A wrong convention here would silently name Sunday's
      teacher on a Monday.

   ⚠️ FAILS SOFT, PER TABLE. Each of the three extras is wrapped on its own,
      so a missing or renamed table costs that one detail and a console
      warning, never the whole answer. Only student_schedule itself is
      allowed to throw, and the caller wraps that too.

   SELF-TEST, prints staff emails only (no phone numbers, no keys):
     cd /opt/my-api && sudo NODE_PATH=/opt/my-api/node_modules \
       node routes/_subAssignedHelper.js <learner-email> [YYYY-MM-DD]
   ===================================================================== */
'use strict';

const ROLE_TTKB = 'ttkb';
const ROLE_BREAKOUT = 'breakout';

function lc(v) { return String(v || '').trim().toLowerCase(); }
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function dowOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function nextYmd(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function hhmm(t) {
  const s = String(t || '');
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : null;
}

/* One warning per table per process, so a broken extra does not fill the
   pm2 log at every card refresh. */
const warned = {};
function warnOnce(key, msg) {
  if (warned[key]) return;
  warned[key] = true;
  console.warn('[subAssigned] ' + key + ': ' + msg);
}

async function assignedFor(sb, learnerEmail, ymd) {
  const em = lc(learnerEmail);
  if (!em || !isYmd(ymd)) return null;
  const dow = dowOf(ymd);

  const out = {
    date: ymd,
    dow: dow,
    has_schedule: false,
    slot: null,          /* { schedule_id, time_local, buoi_phu } */
    teacher: null,       /* { email, name, source, original } */
    breakout: null,      /* { email, name, source, original } */
    owners: []           /* emails from meeting_assigned, the day's live owners */
  };

  /* ---- the plan ---- */
  const ss = await sb.from('student_schedule')
    .select('id, teacher_email, breakout_email, time_local, buoi_phu')
    .ilike('student_email', em)
    .eq('day_of_week', dow);
  if (ss.error) throw new Error('student_schedule: ' + ss.error.message);
  const rows = ss.data || [];
  const row = rows.find(r => !r.buoi_phu) || rows[0] || null;
  if (row) {
    out.has_schedule = true;
    out.slot = { schedule_id: row.id, time_local: hhmm(row.time_local), buoi_phu: !!row.buoi_phu, rows: rows.length };
    if (lc(row.teacher_email)) out.teacher = { email: lc(row.teacher_email), name: null, source: 'schedule', original: null };
    if (lc(row.breakout_email)) out.breakout = { email: lc(row.breakout_email), name: null, source: 'schedule', original: null };
  }

  /* ---- a one-day TTKB transfer ---- */
  try {
    const tr = await sb.from('student_schedule_transfers')
      .select('to_teacher_email')
      .ilike('student_email', em)
      .eq('transfer_date', ymd);
    if (tr.error) throw new Error(tr.error.message);
    const t = (tr.data || []).find(r => lc(r.to_teacher_email));
    if (t) {
      out.teacher = { email: lc(t.to_teacher_email), name: null, source: 'transfer',
                      original: out.teacher ? out.teacher.email : null };
    }
  } catch (e) { warnOnce('student_schedule_transfers', e.message || e); }

  /* ---- a one-day substitute, either role ---- */
  try {
    const su = await sb.from('session_substitute_assignments')
      .select('role, substitute_teacher_email, original_teacher_email')
      .ilike('student_email', em)
      .eq('assign_date', ymd);
    if (su.error) throw new Error(su.error.message);
    for (const r of (su.data || [])) {
      const sub = lc(r.substitute_teacher_email);
      if (!sub) continue;
      const role = lc(r.role);
      const rec = { email: sub, name: null, source: 'substitute',
                    original: lc(r.original_teacher_email) || null };
      if (role === ROLE_TTKB) {
        if (!rec.original && out.teacher) rec.original = out.teacher.email;
        out.teacher = rec;
      } else if (role === ROLE_BREAKOUT) {
        if (!rec.original && out.breakout) rec.original = out.breakout.email;
        out.breakout = rec;
      }
    }
  } catch (e) { warnOnce('session_substitute_assignments', e.message || e); }

  /* ---- the day's live owners (informational) ---- */
  try {
    const ma = await sb.from('meeting_assigned')
      .select('owner_email')
      .ilike('student_email', em)
      .gte('assigned_date', ymd + 'T00:00:00+07:00')
      .lt('assigned_date', nextYmd(ymd) + 'T00:00:00+07:00');
    if (ma.error) throw new Error(ma.error.message);
    out.owners = [...new Set((ma.data || []).map(r => lc(r.owner_email)).filter(Boolean))];
  } catch (e) { warnOnce('meeting_assigned', e.message || e); }

  return out;
}

/* Every email the caller should look a name up for. */
function emailsOf(a) {
  const list = [];
  if (!a) return list;
  if (a.teacher && a.teacher.email) list.push(a.teacher.email);
  if (a.breakout && a.breakout.email) list.push(a.breakout.email);
  (a.owners || []).forEach(e => list.push(e));
  return list;
}

/* Fill in names from a namesFor() map ({ email: { name, role } }). Returns
   the same object, decorated. A missing name stays null; the page falls
   back to the email on its own. */
function decorate(a, names) {
  if (!a) return null;
  const nm = e => (names && names[e] && names[e].name) || null;
  if (a.teacher && a.teacher.email) a.teacher.name = nm(a.teacher.email);
  if (a.breakout && a.breakout.email) a.breakout.name = nm(a.breakout.email);
  return a;
}

module.exports = { assignedFor, emailsOf, decorate };

/* ---------------------------------------------------------------------
   Standalone self-test. Prints staff emails only.
   --------------------------------------------------------------------- */
if (require.main === module) {
  (async () => {
    process.chdir('/opt/my-api');
    require('dotenv').config();
    const { createClient } = require('@supabase/supabase-js');
    const WebSocket = require('ws');
    const sb = createClient(
      (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
    const email = process.argv[2];
    const ymd = isYmd(process.argv[3]) ? process.argv[3]
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!email) { console.log('usage: node _subAssignedHelper.js <learner-email> [YYYY-MM-DD]'); process.exit(2); }
    const a = await assignedFor(sb, email, ymd);
    if (!a) { console.log('no answer (bad email or date)'); process.exit(1); }
    const show = x => x ? (x.email + ' (' + x.source + (x.original ? ', was ' + x.original : '') + ')') : '—';
    console.log('date ' + a.date + ' dow ' + a.dow + '  schedule row: ' + (a.has_schedule ? 'yes' : 'NO') +
      (a.slot ? '  slot ' + (a.slot.time_local || '?') + (a.slot.buoi_phu ? ' (buoi phu)' : '') + ' of ' + a.slot.rows : ''));
    console.log('TTKB     ' + show(a.teacher));
    console.log('Breakout ' + show(a.breakout));
    console.log('owners   ' + (a.owners.length ? a.owners.join(', ') : '—'));
    console.log('SELFTEST DONE');
    process.exit(0);
  })().catch(e => { console.log('SELFTEST FAILED: ' + (e && e.message || e)); process.exit(1); });
}
