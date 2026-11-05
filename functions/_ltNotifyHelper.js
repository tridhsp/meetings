/* =====================================================================
   _ltNotifyHelper.js  -  learntoday notices  (2 Nov 2026)
   /opt/my-api/routes/_ltNotifyHelper.js
   =====================================================================
   NOT A ROUTE. The leading underscore keeps server.js from loading it; the
   capital H in the name is what git-push-site.sh collects (_*Helper.js).
   Required by learn-status-report.calendar.js (and learn-complete next).

   THREE EXPORTS. None of them ever throws into the caller.
     ltLedger(sb, row)                       one row into public.learning_events
     ltNotifyMatrix(sb, email, text, meta)   Element X to the student and the
                                             relatives on the roster
     ltFetchSafe(url, opts, ms)              fetch with a time limit (8 s). On
                                             ANY failure it returns a fake
                                             answer {ok:false, status:0} whose
                                             json() says {error:-1, message},
                                             so the old Zalo code keeps working
                                             and the ledger gets the reason.

   ELEMENT X REUSES THE DESK'S OWN ROOM LOGIC. ensureRoom() and mtx() come
   from mtx-api.messages.js (exported by its @LTN block). So a room this
   helper creates is exactly the room the message desk would create: same
   power levels, same call block, same encryption lock. A student's first
   room may be created here; the desk then uses it.

   WHO GETS THE ELEMENT X COPY: the Student row whose linked_email is the
   student's email, plus every live row whose student_localpart points at
   that student (the relatives). A row whose relation starts with "zalo"
   (zalo_pending, zalo_guest) has no real Matrix account and is recorded
   as 'skipped', never invited.

   THE THREAD ROW (matrix_messages, direction 'out') is written with
   sender_email 'learntoday@system', so the desk's thread and its sent log
   show the notice was automatic, not typed by a teacher.

   SELFTEST, read-only (root, because it reads /opt/my-api/.env):
     sudo NODE_PATH=/opt/my-api/node_modules node /opt/my-api/routes/_ltNotifyHelper.js selftest
   ===================================================================== */
'use strict';

const SENDER = 'learntoday@system';
const ZALO_TIMEOUT_MS = 8000;

function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function short(s, n) { return s == null ? null : String(s).slice(0, n); }

/* ---------------------------------------------------------------- ledger */
async function ltLedger(sb, row) {
  try {
    if (!sb || !row || !row.event) return false;
    const r = {
      student_email: lower(row.student_email),
      student_name:  row.student_name || null,
      event:         row.event,
      channel:       row.channel || null,
      recipient:     row.recipient == null ? null : String(row.recipient),
      status:        row.status || null,
      reason:        short(row.reason, 200),
      message:       short(row.message, 2000),
      lsr_id:        row.lsr_id || null,
      by_email:      row.by_email || null,
      meta:          (row.meta && typeof row.meta === 'object') ? row.meta : {}
    };
    const { error } = await sb.from('learning_events').insert(r);
    if (error) { console.error('[lt-notify] ledger:', error.message); return false; }
    return true;
  } catch (e) {
    console.error('[lt-notify] ledger threw:', e && e.message);
    return false;
  }
}

/* ------------------------------------------------- fetch that never hangs */
async function ltFetchSafe(url, opts, ms) {
  const limit = ms || ZALO_TIMEOUT_MS;
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: AbortSignal.timeout(limit) }));
  } catch (e) {
    const why = (e && e.name === 'TimeoutError')
      ? 'timeout after ' + (limit / 1000) + ' s'
      : ((e && e.message) || 'network error');
    const body = { error: -1, message: 'no answer: ' + why };
    return { ok: false, status: 0, json: async () => body, text: async () => JSON.stringify(body) };
  }
}

/* --------------------------------------------- the desk's room functions */
function deskApi() {
  try {
    const api = require('./mtx-api.messages');
    if (api && typeof api.ensureRoom === 'function' && typeof api.mtx === 'function') return api;
    console.error('[lt-notify] mtx-api loaded but does not export ensureRoom and mtx (see the @LTN block at its end)');
  } catch (e) {
    console.error('[lt-notify] cannot load mtx-api:', e && e.message);
  }
  return null;
}

/* ------------------------------------------------------------ Element X */
async function ltNotifyMatrix(sb, studentEmail, text, meta) {
  const m = meta || {};
  const out = [];
  const email = lower(studentEmail);
  const note = (row) => ltLedger(sb, Object.assign({}, m,
    { student_email: email, event: 'notice', channel: 'matrix', message: text }, row));
  try {
    if (!email || !text) { await note({ status: 'skipped', reason: !email ? 'no student email' : 'no text' }); return out; }
    const api = deskApi();
    if (!api) { await note({ status: 'skipped', reason: 'mtx-api export missing' }); return out; }

    const { data: students, error: e1 } = await sb.from('matrix_users')
      .select('localpart, display_name, role, relation, linked_email')
      .eq('role', 'Student').is('deleted_at', null);
    if (e1) { await note({ status: 'skipped', reason: 'roster read failed: ' + e1.message }); return out; }
    const student = (students || []).find(u => lower(u.linked_email) === email);
    if (!student) { await note({ status: 'skipped', reason: 'no Chat account for this email' }); return out; }

    const { data: rel, error: e2 } = await sb.from('matrix_users')
      .select('localpart, display_name, role, relation, linked_email')
      .eq('student_localpart', student.localpart).is('deleted_at', null);
    if (e2) console.error('[lt-notify] relatives read failed:', e2.message);

    const people = [student].concat((rel || []).filter(u => u.localpart !== student.localpart));
    for (const p of people) {
      if (lower(p.relation).startsWith('zalo')) {
        await note({ recipient: p.localpart, status: 'skipped', reason: 'Zalo-only contact, no Chat account' });
        out.push({ localpart: p.localpart, status: 'skipped' });
        continue;
      }
      try {
        const roomId = await api.ensureRoom(sb, p.localpart, p.display_name);
        const txn = 'lt' + Date.now() + process.hrtime.bigint().toString().slice(-6);
        const r = await api.mtx('/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/send/m.room.message/' + txn,
          { method: 'PUT', body: JSON.stringify({ msgtype: 'm.text', body: text }) });
        if (!r.ok) {
          await note({ recipient: p.localpart, status: 'failed', reason: 'synapse ' + r.status + ' ' + JSON.stringify(r.body || {}).slice(0, 120) });
          out.push({ localpart: p.localpart, status: 'failed' });
          continue;
        }
        const eventId = (r.body && r.body.event_id) || null;
        const { error: e3 } = await sb.from('matrix_messages').insert({
          room_id: roomId, localpart: p.localpart, direction: 'out', body: text, event_id: eventId, sender_email: SENDER
        });
        await note({
          recipient: p.localpart, status: 'sent',
          reason: e3 ? ('sent, but not shown in the thread: ' + e3.message) : null,
          meta: Object.assign({}, m.meta || {}, { event_id: eventId, room_id: roomId, relation: p.relation || null, role: p.role || null })
        });
        out.push({ localpart: p.localpart, status: 'sent' });
      } catch (e) {
        await note({ recipient: p.localpart, status: 'failed', reason: String((e && e.message) || e) });
        out.push({ localpart: p.localpart, status: 'failed' });
      }
    }
  } catch (e) {
    console.error('[lt-notify] matrix leg threw:', e && e.message);
    try { await note({ status: 'failed', reason: 'threw: ' + String((e && e.message) || e) }); } catch (_) { }
  }
  return out;
}

module.exports = { ltLedger, ltNotifyMatrix, ltFetchSafe, SENDER };

/* ------------------------------------------------------------- selftest */
if (require.main === module && process.argv[2] === 'selftest') {
  (async () => {
    require('dotenv').config({ path: '/opt/my-api/.env' });
    const url = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    let ok = true;
    const say = (good, what) => { console.log((good ? 'PASS ' : 'FAIL ') + what); if (!good) ok = false; };

    say(!!url && !!key, 'env loaded (if this fails: run with sudo)');
    say(!!deskApi(), 'mtx-api exports ensureRoom and mtx (patch-mtx-export.py apply)');

    if (url && key) {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(url, key);
      const t = await sb.from('learning_events').select('id', { count: 'exact', head: true });
      say(!t.error, 'learning_events table reachable' + (t.error ? ' (' + t.error.message + ')' : ' (' + t.count + ' rows)'));
      const v = await sb.from('learning_sessions').select('day', { count: 'exact', head: true });
      say(!v.error, 'learning_sessions view reachable' + (v.error ? ' (' + v.error.message + ')' : ' (' + v.count + ' rows)'));
    }

    const fake = await ltFetchSafe('http://127.0.0.1:9/nothing', { method: 'POST' }, 1500);
    const j = await fake.json();
    say(fake.ok === false && fake.status === 0 && j.error === -1, 'ltFetchSafe gives a safe answer when the far end is dead (' + j.message + ')');

    console.log(ok ? 'SELFTEST OK' : 'SELFTEST FAILED');
    process.exit(ok ? 0 : 1);
  })().catch(e => { console.error('selftest threw:', e && e.message); process.exit(1); });
}
