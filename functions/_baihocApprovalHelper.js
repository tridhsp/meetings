// /opt/my-api/routes/_baihocApprovalHelper.js
// =====================================================================
// The baihoc half of a submit.tansinh.info approval.        02/09/2026
//
// WHY THIS EXISTS
//   submit's Học viên verdict must do EXACTLY what baihoc's ✔ Approve
//   button did, in the SAME records, or the learner never sees it:
//     1. lesson_submission  -- what lessons-next gates the next chapter on,
//        and what mainpage.js renders as the red banner + "GV: ..." notes
//     2. /send-zalo         -- the family's Zalo message, same text format
//   Because the same row and the same route are used, nothing downstream
//   changes. This file is the ONLY place that knowledge lives.
//
// ⚠️ NOT A ROUTE. The leading underscore keeps server.js from loading it.
//    The "Helper.js" ending (capital H, no hyphen) is what git-push-site.sh
//    line 97 collects -- rename it and it silently leaves git.
//
// ⚠️ lesson_submission HAS NO chapter_id. The chapter uuid sits inside
//    document_link, so the join is a substring match -- the same one
//    /sub-approvals already uses for its read-through. A chapter can hold
//    several rows (that is what a redo is). We judge the newest PENDING row,
//    because that is the one lessons-next is holding the learner on; if
//    none is pending, the newest row (a re-judgement, like the Redo on
//    approved-lessons.html). No row at all = the learner never submitted the
//    baihoc form for this chapter, and there is nothing to gate or message.
//
// ⚠️ approve_date IS NULLED ON DISAPPROVAL. baihoc does that, and
//    lessons-next / approved-lessons read these columns. Do not "fix" it
//    here while baihoc's own route still exists -- the two would disagree.
//
// ⚠️ send-zalo IS CALLED, NEVER COPIED. It is 434 lines that also find the
//    guardians, log zalo_status / zalo_sent_messages and upsert the row
//    (bc_date, account_id -- baihoc's approve does that too, today). Calling
//    it over loopback is the same pattern _rtr-duration.helper uses for
//    lv-stream. It is awaited with a timeout and NEVER throws: the verdict
//    is already written by then, exactly as baihoc saves before it sends.
//
// ⚠️ ONE ADDITION TO baihoc's JSON: "labels". baihoc's feedback keys are
//    form fields (yeu_cau_1 ...) with a hard-coded label map in
//    mainpage.js. submit's keys are requirement keys (st_..., h:...), so
//    the requirement's own text travels with them. mainpage.js renders
//    (labels[k] || labelMap[k] || k) after a one-line patch; until then it
//    shows the key. Labels are HTML-escaped because that banner uses
//    innerHTML.
// =====================================================================
'use strict';

const http = require('http');

const ZALO_TIMEOUT_MS = 20000;
/* teachers.js joins the preview lines with exactly this */
const SEP = '\n--------------------------------\n';
const LABEL_MAX = 120;

function lc(s) { return String(s || '').trim().toLowerCase(); }

function sendZaloUrl() {
  return 'http://127.0.0.1:' + (process.env.PORT || 3111) + '/send-zalo';
}

/* HTML -> one line of text for a Zalo message or a label. */
function plainLabel(html, index) {
  let s = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  if (!s) return 'Yêu cầu ' + (Number(index) + 1);
  if (s.length > LABEL_MAX) s = s.slice(0, LABEL_MAX - 1) + '…';
  return s;
}

/* mainpage.js drops labels into innerHTML, so the stored copy is escaped */
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Which lesson_submission row does this learner + chapter card judge? */
async function findRow(sb, email, chapterId) {
  const { data, error } = await sb
    .from('lesson_submission')
    .select('lesson_id, email, gv_approved, approve_date, approval_note, created_at, ' +
            'yeu_cau_1, yeu_cau_2, yeu_cau_3, yeu_cau_4, video_ngoi_hoc, document_link')
    .ilike('email', email)
    .like('document_link', '%' + chapterId + '%')
    .order('created_at', { ascending: false });
  if (error) throw new Error('lesson_submission read: ' + error.message);
  const rows = data || [];
  const pending = rows.find(r => r.gv_approved == null || String(r.gv_approved).trim() === '');
  return { row: pending || rows[0] || null, total: rows.length, pending: !!pending };
}

/* The exact update approve-submission.baihoc.js performs. */
async function writeVerdict(sb, lessonId, status, approverEmail, approvalNote) {
  const approved = status === 'approved';
  const { error } = await sb
    .from('lesson_submission')
    .update({
      approval_note: approvalNote,
      gv_approved: approved ? approverEmail : 'disapproved',
      approve_date: approved ? new Date().toISOString() : null
    })
    .eq('lesson_id', lessonId);
  if (error) throw new Error('lesson_submission update: ' + error.message);
}

/* approve  -> the note as plain text            (baihoc, unchanged)
   disapprove -> {type, note, feedback}          (baihoc's JSON) + labels  */
function buildApprovalNote(status, note, feedback, labels) {
  if (status === 'approved') return note;
  const fb = {};
  const lb = {};
  for (const k of Object.keys(feedback || {})) {
    fb[k] = feedback[k];
    if (labels && labels[k]) lb[k] = escHtml(labels[k]);
  }
  return JSON.stringify({ type: 'disapproval', note: note, feedback: fb, labels: lb });
}

/* teachers.js builds six preview lines, every one present even when empty */
function previewText(row) {
  return [
    'Lesson ID: ' + (row.lesson_id || ''),
    'Yêu cầu 1: ' + (row.yeu_cau_1 || ''),
    'Yêu cầu 2: ' + (row.yeu_cau_2 || ''),
    'Yêu cầu 3: ' + (row.yeu_cau_3 || ''),
    'Yêu cầu 4: ' + (row.yeu_cau_4 || ''),
    'Video ngồi học: ' + (row.video_ngoi_hoc || '')
  ].join(SEP);
}

/* Byte-for-byte the text teachers.js sends, before send-zalo's own footer. */
function buildText(row, status, note, feedback, labels) {
  const plain = previewText(row);
  if (status === 'approved') {
    return plain + '\n\n--- Ghi chú duyệt ---\n' + note;
  }
  let t = '❌ BÀI CHƯA ĐẠT — Cần làm lại\n\n';
  t += plain + '\n\n';
  t += '--- Lý do không duyệt ---\n' + note + '\n';
  const keys = Object.keys(feedback || {});
  if (keys.length) {
    t += '\n--- Ghi chú từng phần ---\n';
    for (const k of keys) t += '• ' + ((labels && labels[k]) || k) + ': ' + feedback[k] + '\n';
  }
  return t;
}

/* POST JSON over loopback. Resolves ALWAYS; never rejects. */
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(url);
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(raw); } catch (_) { j = null; }
          fin({ httpOk: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode, json: j, raw: raw.slice(0, 300) });
        });
        res.on('error', (e) => fin({ error: (e && e.message) || String(e) }));
      });
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => fin({ error: (e && e.message) || String(e) }));
      req.end(body);
    } catch (e) {
      fin({ error: (e && e.message) || String(e) });
    }
  });
}

/* Same body teachers.js sends. Returns { status: sent|failed|timeout, detail } */
async function sendZalo(payload) {
  const r = await postJson(sendZaloUrl(), payload, ZALO_TIMEOUT_MS);
  if (r.error) {
    return { status: /timeout/i.test(r.error) ? 'timeout' : 'failed', detail: r.error };
  }
  if (r.httpOk && r.json && r.json.ok) {
    const exp = Array.isArray(r.json.expired) ? r.json.expired.length : 0;
    return { status: 'sent', detail: exp ? ('zalo het han: ' + exp) : null };
  }
  const why = (r.json && (r.json.error || r.json.message)) || ('HTTP ' + r.status + ' ' + r.raw);
  return { status: 'failed', detail: String(why).slice(0, 200) };
}

/* The whole baihoc half, in order: find -> write -> message.
   NEVER throws. Every outcome is described in the returned object. */
async function apply(sb, o) {
  const out = {
    attempted: true, found: false, lesson_id: null, submissions: 0,
    was_pending: false, written: false, zalo: 'skipped', zalo_detail: null, error: null
  };
  const approver = o.approver || {};
  if (!approver.email) { out.error = 'approver email unknown'; return out; }

  let f;
  try {
    f = await findRow(sb, o.forEmail, o.chapterId);
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;
  }
  out.submissions = f.total;
  if (!f.row) return out;
  out.found = true;
  out.lesson_id = f.row.lesson_id;
  out.was_pending = f.pending;

  try {
    await writeVerdict(sb, f.row.lesson_id, o.status, approver.email,
                       buildApprovalNote(o.status, o.note, o.feedback, o.labels));
    out.written = true;
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;
  }

  const z = await sendZalo({
    studentName: o.learnerName || String(f.row.email || o.forEmail).split('@')[0],
    studentEmail: f.row.email || o.forEmail,
    text: buildText(f.row, o.status, o.note, o.feedback, o.labels),
    senderName: approver.name || '',
    imageUrls: [],
    accountId: approver.uid || null,
    lessonId: f.row.lesson_id
  });
  out.zalo = z.status;
  out.zalo_detail = z.detail || null;
  return out;
}

module.exports = { lc, plainLabel, escHtml, findRow, writeVerdict,
                   buildApprovalNote, buildText, sendZalo, apply };
