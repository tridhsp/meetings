// /opt/my-api/routes/_rtrCloseHelper.js
//
// === tansinh rtr-close v1 (3 Nov 2026) =====================================
// THE ONE PLACE THAT WRITES link_ttkb FROM NOW ON.
//
// A work card's video no longer comes from a pasted link. When a batch of
// cards closes (its deadline passes, or someone presses Done), finalizeBatch()
// asks server3 to cut the card's minutes out of the teacher's SHIFT recording
// (POST /_cut on screenrec-serve.py), and writes the result onto the card:
//
//   link_ttkb     https://xem.tansinh.info/<shift folder>/card-<batch stamp>.mp4
//   input_dur     the cut's true length in seconds (the duplicate detector
//                 in giolamviec keys on batch|link|input_dur and skips 0)
//   completed_at  the window's end: the deadline, or the Done click
//   rec_note      what happened: 'shift 1803s', 'shift 1740s gap 63s 2 pieces',
//                 'no-recording', 'cut-failed 3: <reason>', 'cut-failed-final'
//   + one video_uploads row (duration_sec, file_hash rtr-shift:*), so the
//     pay reads the length at once and nothing ever needs to probe the file.
//
// WHY THE CUT IS MADE ON server3, NOT HERE: the shift file lives on tank2.
// This box only asks, with a signed ticket (the SAME key as the upload
// tickets: SCREENREC_UPLOAD_KEY = /etc/screenrec-upload.key on server3), and
// reads the answer. The cut is a COPY of those minutes; the shift recording
// is never touched and keeps running. Idempotent: asking twice for one batch
// answers the same file.
//
// RETRIES: a failed cut writes 'cut-failed N: reason' and keeps completed_at,
// so the next attempt (rtr-card-closer.js, every 2 minutes) cuts the SAME
// window. After MAX_ATTEMPTS it becomes 'cut-failed-final' for an Admin.
//
// ⚠️ capMinutes() MUST match the countdown the teacher sees: the biggest
//    <N> in the batch, +3 when the batch holds 2 or more cards (script.js,
//    "extraMins"). The pay code in giolamviec uses its own cap per row; the
//    deadline is the page's.
// ⚠️ prefixOf() MUST stay bug-for-bug identical to scr-work-session,
//    scr-upload-ticket, the screenrec page and rtr-recorder.js: the folder is
//    named by the browser with that rule and checked by server3 with the
//    /_list rule (prefix + exactly 14 digits).
// ⚠️ The capital H in this file's name is load-bearing: git-push-site.sh
//    collects "_*Helper.js". A lower-case h is in no repo.
// ⚠️ Never throws out of finalizeBatch(): a close must never take a route or
//    the closer down. Every failure is a returned {ok:false, ...}.
// ===========================================================================

'use strict';

const crypto = require('crypto');
const cache = require('./_cache-helper');
const videoSource = require('./_glvVideoSourceHelper');

const XEM_BASE = (process.env.SCREENREC_XEM_URL || 'https://xem.tansinh.info').replace(/\/+$/, '');
const CUT_TIMEOUT_MS = 95000;   // server3 gives up at 80 s per ffmpeg call
const MAX_ATTEMPTS = 12;        // every 2 minutes = about 24 minutes
const DEFAULT_CAP_MIN = 10;     // the page's "maxMins ?? 10"
const PAIR_EXTRA_MIN = 3;       // the page's extraMins for a batch of 2+
const PARENT_EARLY_MS = 15 * 60 * 1000;   // a Jibri recording may start this long before the card
const PARENT_LATE_MS = 2 * 60 * 1000;     // ...or this long after the card closed
const ADMIN_ROLES = ['Admin', 'Super Admin'];

// --------------------------------------------------------------- pure parts

function prefixOf(email) {
  return String(email || '').split('@')[0]
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40) || 'user';
}

/** The number in a status like "<45>", or null. */
function statusMinutes(status) {
  const m = /<([\d.]+)>/.exec(String(status || ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The batch's cap in minutes, as the countdown shows it. */
function capMinutes(rows) {
  let max = null;
  for (const r of rows || []) {
    const n = statusMinutes(r.status);
    if (n !== null && (max === null || n > max)) max = n;
  }
  const base = max === null ? DEFAULT_CAP_MIN : max;
  return base + ((rows || []).length >= 2 ? PAIR_EXTRA_MIN : 0);
}

function earliestCreated(rows) {
  let t = null;
  for (const r of rows || []) {
    const ms = new Date(r.created_at).getTime();
    if (Number.isFinite(ms) && (t === null || ms < t)) t = ms;
  }
  return t === null ? null : new Date(t);
}

/** created_at + cap minutes, as a Date (null if no created_at). */
function deadlineFor(rows) {
  const c = earliestCreated(rows);
  if (!c) return null;
  return new Date(c.getTime() + capMinutes(rows) * 60 * 1000);
}

/** A 14-digit Vietnam-time stamp of the batch: the cut's file name. */
function batchName(ts) {
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const v = new Date(ms + 7 * 3600 * 1000).toISOString();   // Vietnam has no DST
  return v.slice(0, 19).replace(/[-T:]/g, '');              // YYYYMMDDHHMMSS
}

function signCut(key, prefix, start, end, name, exp) {
  return crypto.createHmac('sha256', String(key).trim())
    .update('cut|' + prefix + '|' + start + '|' + end + '|' + name + '|' + exp)
    .digest('hex');
}

/** A short, log-safe reason (no URLs with tickets, no stack). */
function short(s, n) {
  return String(s || '').replace(/\s+/g, ' ').slice(0, n || 120);
}

function attemptsIn(note) {
  const m = /^cut-failed(?:-final)? (\d+)/.exec(String(note || ''));
  return m ? parseInt(m[1], 10) : 0;
}

// ------------------------------------------------------------ talk to server3

/** POST /_cut on server3 through the xem tunnel. Resolves to
 *  { status, json } or { status: 0, error }. Never throws. */
async function requestCut(args, deps) {
  const key = (deps && deps.key) || process.env.SCREENREC_UPLOAD_KEY;
  const doFetch = (deps && deps.fetch) || fetch;
  if (!key) return { status: 0, error: 'SCREENREC_UPLOAD_KEY missing in .env' };
  const exp = String(Math.floor(Date.now() / 1000) + 600);
  const q = new URLSearchParams({
    prefix: args.prefix, start: String(args.start), end: String(args.end),
    name: args.name, exp: exp,
    sig: signCut(key, args.prefix, args.start, args.end, args.name, exp)
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (deps && deps.timeoutMs) || CUT_TIMEOUT_MS);
  try {
    const r = await doFetch(XEM_BASE + '/_cut?' + q.toString(), { method: 'POST', signal: ctrl.signal });
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { status: r.status, json: json };
  } catch (e) {
    return { status: 0, error: short(e && e.message ? e.message : e, 100) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- the close

const ROW_SELECT = 'id, email, task, ten_hv, status, created_at, batch_ts, link_ttkb, '
  + 'input_dur, completed_at, rec_note, parent_link, parent_link_at, ttkb_type, '
  + 'interactive_lesson_id, student_email, paired_with';

async function loadBatch(supabase, batch_ts, email) {
  let q = supabase.from('work').select(ROW_SELECT).eq('batch_ts', batch_ts);
  if (email) q = q.eq('email', email);
  const { data, error } = await q;
  if (error) throw new Error('work read: ' + error.message);
  return data || [];
}

async function loadRole(supabase, email) {
  try {
    const { data } = await supabase.from('user_roles').select('role')
      .eq('email', String(email || '').toLowerCase()).maybeSingle();
    return (data && data.role) || null;
  } catch (e) {
    return null;
  }
}

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

async function invalidate(email) {
  try {
    if (email) await cache.delPattern('rtr:my-work:' + String(email).toLowerCase() + ':*');   // tansinh rtr-close 3b: the key ends in :<date> or :all
    await cache.delPattern('rtr:admin-month:*');
    await cache.delPattern('rtr:student-history:*');
    await cache.delPattern('rtr:student-week-ttkb:*');
  } catch (e) { /* cache is best effort */ }
}

/** Close one batch: cut, write, remember. opts: { email, batch_ts, endAt,
 *  by, deps }. Returns { ok, link, seconds, note, none, retry, already }. */
async function finalizeBatch(supabase, opts) {
  const log = (opts && opts.log) || console.log;
  const deps = (opts && opts.deps) || {};
  const tag = '[rtr-close ' + short(opts.batch_ts, 32) + ']';
  try {
    const rows = await loadBatch(supabase, opts.batch_ts, opts.email);
    if (!rows.length) return { ok: false, error: 'no-rows' };
    const email = String(rows[0].email || '').toLowerCase();

    if (rows.every(r => r.link_ttkb)) {
      return { ok: true, already: true, link: rows[0].link_ttkb, note: rows[0].rec_note || '' };
    }
    const finalNote = (rows[0].rec_note || '').startsWith('cut-failed-final');
    if (finalNote && !(opts && opts.force)) {
      return { ok: false, error: 'final', note: rows[0].rec_note };
    }

    const start = earliestCreated(rows);
    if (!start) return { ok: false, error: 'no-created_at' };
    // The window's end: whatever was decided first, never re-decided on a retry.
    const fixedEnd = rows[0].completed_at ? new Date(rows[0].completed_at) : null;
    let end = fixedEnd || (opts.endAt ? new Date(opts.endAt) : null) || new Date();
    const deadline = deadlineFor(rows);
    if (!fixedEnd && deadline && end > deadline) end = deadline;
    if (end.getTime() - start.getTime() < 3000) {
      await supabase.from('work').update({ completed_at: end.toISOString(), rec_note: 'no-recording (window under 3 s)' })
        .eq('batch_ts', opts.batch_ts).eq('email', email);
      await invalidate(email);
      return { ok: true, none: true, note: 'no-recording (window under 3 s)' };
    }

    const prefix = prefixOf(email);
    const name = batchName(rows[0].batch_ts || rows[0].created_at);
    const startS = Math.floor(start.getTime() / 1000);
    const endS = Math.floor(end.getTime() / 1000);

    const r = await requestCut({ prefix: prefix, start: startS, end: endS, name: name }, deps);

    // ---- failure: remember, and let the closer try again
    if (!r.json || (r.status !== 200)) {
      const attempts = attemptsIn(rows[0].rec_note) + 1;
      const reason = r.error || (r.json && (r.json.error || r.json.detail)) || ('HTTP ' + r.status);
      const note = (attempts >= MAX_ATTEMPTS ? 'cut-failed-final ' : 'cut-failed ') + attempts + ': ' + short(reason, 90);
      await supabase.from('work').update({ completed_at: end.toISOString(), rec_note: note })
        .eq('batch_ts', opts.batch_ts).eq('email', email);
      await invalidate(email);
      log(tag + ' FAILED ' + note);
      return { ok: false, retry: attempts < MAX_ATTEMPTS, note: note };
    }

    // ---- nothing recorded in that window
    if (r.json.none) {
      await supabase.from('work').update({ completed_at: end.toISOString(), rec_note: 'no-recording' })
        .eq('batch_ts', opts.batch_ts).eq('email', email);
      await invalidate(email);
      log(tag + ' no-recording for ' + prefix + ' ' + startS + '..' + endS);
      return { ok: true, none: true, note: 'no-recording' };
    }

    // ---- the cut exists
    const link = XEM_BASE + r.json.path;
    const seconds = Math.max(0, Math.round(Number(r.json.seconds) || 0));
    let note = 'shift ' + seconds + 's';
    if (Number(r.json.gap) > 5) note += ' gap ' + Math.round(Number(r.json.gap)) + 's';
    if (Number(r.json.pieces) > 1) note += ' ' + r.json.pieces + ' pieces';
    if (r.json.existing) note += ' existing';
    if (opts.by) note += ' by ' + short(opts.by, 40);

    const { error: upErr } = await supabase.from('work').update({
      link_ttkb: link, input_dur: seconds, completed_at: end.toISOString(), rec_note: note
    }).eq('batch_ts', opts.batch_ts).eq('email', email);
    if (upErr) throw new Error('work update: ' + upErr.message);

    // The pay reads this row; written here so no probe is ever needed.
    try {
      const { data: ex } = await supabase.from('video_uploads').select('id, duration_sec').eq('video_link', link).limit(1);
      const marker = 'rtr-shift:' + crypto.createHash('md5').update(link).digest('hex').slice(0, 16);
      if (ex && ex.length) {
        if (ex[0].duration_sec == null) await supabase.from('video_uploads').update({ duration_sec: seconds }).eq('id', ex[0].id);
      } else {
        const ins = await supabase.from('video_uploads').insert({ video_link: link, duration_sec: seconds, file_hash: marker });
        if (ins.error) await supabase.from('video_uploads').insert({ video_link: link, duration_sec: seconds });
      }
    } catch (e) {
      log(tag + ' video_uploads not written: ' + short(e && e.message, 80));
    }

    // Lesson completion for interactive TTKB, as update-link did it.
    for (const row of rows.filter(x => x.ttkb_type === 'interactive' && x.interactive_lesson_id && x.student_email)) {
      try {
        const lessonId = String(row.interactive_lesson_id).trim();
        const { data: lessonRow } = await supabase.from('lessons').select('book_code').eq('lesson_id', lessonId).limit(1).maybeSingle();
        const { error: insErr } = await supabase.from('interactive_sessions').insert({
          email: row.student_email, book_code: (lessonRow && lessonRow.book_code) || null,
          lesson_id: lessonId, teacher_email: email, work_id: row.id
        });
        if (insErr && insErr.code !== '23505') log(tag + ' interactive insert: ' + insErr.message);
      } catch (e) {
        log(tag + ' interactive: ' + short(e && e.message, 80));
      }
    }

    await invalidate(email);
    log(tag + ' ' + note + ' -> ' + link);
    return { ok: true, link: link, seconds: seconds, note: note };
  } catch (e) {
    log(tag + ' ERROR ' + short(e && e.message ? e.message : e, 120));
    return { ok: false, error: short(e && e.message ? e.message : e, 120), retry: true };
  }
}

// --------------------------------------------------------- the parent (Jibri) link

/** Is this Jibri link acceptable for these rows? -> { ok, error, info } */
function checkParentLink(link, teacherEmail, rows) {
  const info = videoSource.describe(String(link || '').trim());
  if (!info || info.kind !== 'jibri') {
    return { ok: false, error: 'Link phải là link ghi hình buổi học (meetrecording.tansinh.info/api/lv-watch?k=...). Mở bảng Recordings trong phòng học và bấm Copy.' };
  }
  if (!videoSource.ownedBy(info, teacherEmail)) {
    return { ok: false, error: 'Bản ghi này thuộc phòng "' + info.owner + '", không phải phòng của giáo viên thẻ này.' };
  }
  if (!info.recordedAt) {
    return { ok: false, error: 'Không đọc được thời gian ghi trong link.' };
  }
  const rec = new Date(info.recordedAt).getTime();
  const start = earliestCreated(rows);
  if (!start) return { ok: false, error: 'Thẻ không có thời gian tạo.' };
  const endD = rows[0].completed_at ? new Date(rows[0].completed_at) : (deadlineFor(rows) || new Date());
  if (rec < start.getTime() - PARENT_EARLY_MS) {
    return { ok: false, error: 'Bản ghi này bắt đầu hơn 15 phút TRƯỚC khi thẻ được tạo. Thẻ chỉ nhận bản ghi của chính buổi này.' };
  }
  if (rec > endD.getTime() + PARENT_LATE_MS) {
    return { ok: false, error: 'Bản ghi này bắt đầu SAU khi thẻ đã đóng. Thẻ chỉ nhận bản ghi của chính buổi này.' };
  }
  return { ok: true, info: info };
}

// ------------------------------------------------------------------- the Zalo

/** The TTKB Zalo message, exactly as update-link sent it, with the given
 *  link. Returns the number delivered. Never throws. */
async function sendTtkbZalo(supabase, opts) {
  let zaloSent = 0;
  try {
    const email = String(opts.email || '').toLowerCase();
    const ttkbRows = (opts.rows || []).filter(r => (r.task || '').trim() === 'TTKB');
    if (!ttkbRows.length || !opts.link) return 0;
    const doFetch = (opts.deps && opts.deps.fetch) || fetch;

    const { data: teacherRow } = await supabase.from('user_roles').select('full_name').eq('email', email).maybeSingle();
    const teacherName = (teacherRow && teacherRow.full_name) || email;

    const { data: tokenRow } = await supabase.from('tokens').select('access_token')
      .order('created_at', { ascending: false }).limit(1).single();
    if (!tokenRow || !tokenRow.access_token) return 0;
    const token = tokenRow.access_token;
    const oaId = process.env.ZALO_OA_ID;

    const studentEmails = [...new Set(ttkbRows.map(r => r.student_email).filter(Boolean))];
    const studentNamesStr = ttkbRows.map(r => r.ten_hv).filter(Boolean).join(' & ');

    for (const stuEmail of studentEmails) {
      const { data: contact } = await supabase.from('students_contact_info')
        .select('zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other, ten_hv')
        .eq('email', stuEmail).maybeSingle();
      if (!contact) continue;
      const uniqueIds = [...new Set([contact.zalo_key, contact.guardian_key1_m, contact.guardian_key2_c, contact.guardian_key3_other].filter(Boolean))];
      if (!uniqueIds.length) continue;

      const messageText =
        `Thầy cô gửi video Tương tác của HV ${studentNamesStr}. ` +
        `Bạn đã được GV ${teacherName} hoàn thành tương tác cho hôm nay. ` +
        `Mời bạn bấm vào link sau đây để có thể xem link video:\n\n` +
        `🔗 ${opts.link}`;

      let reportBlock = '';
      const answers = opts.report_form_answers;
      if (answers && typeof answers === 'object') {
        const lines = [];
        for (const [label, value] of Object.entries(answers)) {
          if (value === null || value === undefined) continue;
          let formatted = '';
          if (Array.isArray(value)) {
            const joined = value.filter(Boolean).join(', ');
            if (!joined) continue;
            formatted = joined;
          } else {
            const str = String(value).trim();
            if (!str) continue;
            formatted = str;
          }
          lines.push(`• ${label}: ${formatted}`);
        }
        if (lines.length) reportBlock = `\n\n📝 Báo cáo buổi tương tác:\n${lines.join('\n')}`;
      }
      const footer =
        `\n\nNhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép ` +
        `TANSINH tiếp tục gửi thông tin. Trân trọng! (${teacherName})`;
      const finalText = messageText + reportBlock + footer;

      for (const id of uniqueIds) {
        let nameToLog = contact.ten_hv || stuEmail;
        if (id !== contact.zalo_key) {
          const { data: whoList } = await supabase.from('students_contact_info').select('ten_hv').eq('zalo_key', id);
          if (whoList && whoList.length === 1) nameToLog = whoList[0].ten_hv;
          else if (whoList && whoList.length > 1) nameToLog = `${whoList[0].ten_hv} (${whoList[1].ten_hv})`;
        }
        const zaloResp = await doFetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', access_token: token },
          body: JSON.stringify({ recipient: { user_id: id }, message: { text: finalText } })
        });
        const zaloJson = await zaloResp.json();
        const deliveryStatus = zaloResp.ok && (!zaloJson.error || zaloJson.error === 0) ? 'Success' : 'Zalo hết hạn';
        const bangkokIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
        await supabase.from('zalo_status').upsert({
          oa_id: oaId, recipient_id: id, recipient_name: nameToLog, status: deliveryStatus, created_at: bangkokIso
        }, { onConflict: 'oa_id,recipient_id' });
        await supabase.from('zalo_sent_messages').insert({
          sender_name: teacherName, account_id: email, student_name: contact.ten_hv,
          receiver_id: id, content: messageText + reportBlock
        });
        if (deliveryStatus === 'Success') zaloSent++;
      }
    }
  } catch (e) {
    console.error('[rtr-close zalo] non-blocking:', e && e.message ? e.message : e);
  }
  return zaloSent;
}

module.exports = {
  prefixOf, statusMinutes, capMinutes, earliestCreated, deadlineFor, batchName,
  signCut, attemptsIn, requestCut, loadBatch, loadRole, isAdminRole, invalidate,
  finalizeBatch, checkParentLink, sendTtkbZalo,
  XEM_BASE, MAX_ATTEMPTS, ROW_SELECT, ADMIN_ROLES
};
