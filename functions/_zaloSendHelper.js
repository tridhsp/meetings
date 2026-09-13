// /opt/my-api/routes/_zaloSendHelper.js
// The Zalo OA leg for messages.tansinh.info. Added Sep 2026.
//
// ⚠️ THE NAME MATTERS. git-push-site.sh line 97 only collects helpers that
//    match _*Helper.js — capital H, no hyphen. "_zalo-send.helper.js" would be
//    in no repo, exactly like _rtr-duration.helper.js and _cache-helper.js.
// ⚠️ Never loaded as a route: server.js skips files that start with "_".
//
// It mirrors bulk-send-zalo.message.js line for line where it matters:
//   same endpoint, same token source (newest row of `tokens`), same footer,
//   same zalo_status upsert, same zalo_sent_messages insert. So message.tansinh.info's
//   sent log, expired list and response tracker keep seeing every message,
//   whichever app sent it.
//
// sendToFamily() NEVER throws. Every outcome is a status word:
//   sent      every Zalo ID accepted it
//   partial   some accepted, some "hết hạn"
//   failed    none accepted, or no access_token
//   skipped   nothing was attempted, and `detail` says why
//             (outside 06:00–21:45 · no linked email · not in students_contact_info ·
//              no Zalo IDs · same text to this family in the last 10 minutes)

const ZALO_CS_URL = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const FOOTER = (staffName) => `Nhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép TANSINH tiếp tục gửi thông tin. Trân trọng! (${staffName})`;

// Same policy as the old app's page: Zalo penalises off-hours business
// messaging. Vietnam is a fixed +07, no daylight saving, so the shift is exact.
const WINDOW_OPEN_MIN  = 6 * 60;        // 06:00
const WINDOW_CLOSE_MIN = 21 * 60 + 45;  // 21:45
const DEDUPE_MIN       = 10;            // same text, same family, within this = skip
const PER_CALL_MS      = 8000;          // one Zalo call may not hang longer than this

function vnMinutes(now) {
  const vn = new Date((now || Date.now()) + 7 * 3600 * 1000);
  return vn.getUTCHours() * 60 + vn.getUTCMinutes();
}
function windowOpen(now) {
  const m = vnMinutes(now);
  return m >= WINDOW_OPEN_MIN && m <= WINDOW_CLOSE_MIN;
}

async function latestToken(sb) {
  const { data, error } = await sb.from('tokens').select('access_token')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('token read failed: ' + error.message);
  return (data && data.access_token) || null;
}

// Which Zalo IDs does this Matrix person's message go to?
// The SAME four columns bulk-send-zalo reads, keyed by the student's email.
// Returns { found:false, reason } or { found:true, ten_hv, zalo_key, targets:[{id, kind}] }
async function resolveFamily(sb, linkedEmail) {
  const email = String(linkedEmail || '').trim();
  if (!email) return { found: false, reason: 'no_email' };
  const cols = 'ten_hv, zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other';
  let { data: stu, error } = await sb.from('students_contact_info').select(cols).eq('email', email).maybeSingle();
  if (error) throw new Error('contact read failed: ' + error.message);
  if (!stu) {
    // second try, case-insensitive — the contact table is typed by hand
    const r2 = await sb.from('students_contact_info').select(cols).ilike('email', email).limit(1);
    if (r2.error) throw new Error('contact read failed: ' + r2.error.message);
    stu = r2.data && r2.data[0];
  }
  if (!stu) return { found: false, reason: 'not_in_contacts' };
  const raw = [
    { id: stu.zalo_key,            kind: 'HV'  },
    { id: stu.guardian_key1_m,     kind: 'Mẹ'  },
    { id: stu.guardian_key2_c,     kind: 'Cha' },
    { id: stu.guardian_key3_other, kind: 'PH'  }
  ].filter(t => t.id);
  const seen = new Set(), targets = [];
  for (const t of raw) { if (!seen.has(t.id)) { seen.add(t.id); targets.push(t); } }
  return { found: true, ten_hv: stu.ten_hv || email, zalo_key: stu.zalo_key || null, targets };
}

// One Zalo call. Never throws; a network error is just a failed result.
async function sendOne(token, userId, text, imageUrls) {
  const payload = { recipient: { user_id: userId }, message: { text } };
  if (imageUrls && imageUrls.length) {
    payload.message.attachment = { type: 'template', payload: { template_type: 'media',
      elements: imageUrls.map(u => ({ media_type: 'image', url: u })) } };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_MS);
  try {
    const r = await fetch(ZALO_CS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: token },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    let j; try { j = await r.json(); } catch { j = {}; }
    const ok = r.ok && (!j.error || j.error === 0);
    return { ok, code: j.error, message: j.message || (r.ok ? '' : 'HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, code: 'network', message: String((e && e.message) || e) };
  } finally { clearTimeout(timer); }
}

// The same text to the same family in the last DEDUPE_MIN minutes — from ANY
// app, because the old app writes the same table. Read failure = not a dupe.
async function sentRecently(sb, fam, text) {
  try {
    const since = new Date(Date.now() - DEDUPE_MIN * 60000).toISOString();
    const { data } = await sb.from('zalo_sent_messages').select('sent_at')
      .eq('student_name', fam.ten_hv).eq('content', text).gte('sent_at', since).limit(1);
    return !!(data && data.length);
  } catch { return false; }
}

// ONE raw Zalo ID, no family and no email — a Guest: somebody who has
// messaged the OA but is not a student yet, so there is nothing to resolve
// against. Deliberately built on the SAME pieces as sendToFamily — same
// window rule, same FOOTER, same zalo_status upsert, same zalo_sent_messages
// row — so a guest reply looks identical to every other message this school
// sends, and the old app's sent log and expired list still see it.
// opts: { sb, zaloId, name, text, staffName, accountId, oaId, imageUrls }
// Returns { status, detail, sent, failed, total }. NEVER throws.
async function sendToOne(opts) {
  const { sb, zaloId, text, staffName, accountId, oaId } = opts;
  const id = String(zaloId || '').trim();
  const name = String(opts.name || '').trim() || id;
  const imageUrls = opts.imageUrls || [];
  const none = (status, detail, total) => ({ status, detail, sent: 0, failed: status === 'failed' ? (total || 0) : 0, total: total || 0 });
  try {
    if (!id) return none('skipped', 'chưa có Zalo ID');
    if (!windowOpen()) return none('skipped', 'ngoài giờ gửi Zalo (06:00–21:45)');
    // sentRecently keys on the display name, which is what the sent log stores
    if (await sentRecently(sb, { ten_hv: name }, text)) return none('skipped', 'trùng tin vừa gửi (10 phút)', 1);
    const token = await latestToken(sb);
    if (!token) return none('failed', 'không có access_token Zalo', 1);

    const finalText = text + '\n\n' + FOOTER(staffName || 'TANSINH');
    const bangkokIso = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
    const r = await sendOne(token, id, finalText, imageUrls);

    const { error: stErr } = await sb.from('zalo_status').upsert({
      oa_id: oaId, recipient_id: id, recipient_name: name,
      status: r.ok ? 'Success' : 'Zalo hết hạn', created_at: bangkokIso
    }, { onConflict: 'oa_id,recipient_id' });
    if (stErr) console.log('[zalo] zalo_status upsert failed:', stErr.message);

    const { error: logErr } = await sb.from('zalo_sent_messages').insert({
      sender_name: staffName || 'Staff', account_id: accountId || null,
      student_name: name, receiver_id: id, content: text, image_urls: imageUrls
    });
    if (logErr) console.log('[zalo] zalo_sent_messages insert failed:', logErr.message);

    return r.ok
      ? { status: 'sent', detail: '1/1', sent: 1, failed: 0, total: 1 }
      : { status: 'failed', detail: '0/1 · ' + (r.message || 'Zalo từ chối'), sent: 0, failed: 1, total: 1 };
  } catch (e) { return none('failed', String((e && e.message) || e).slice(0, 180)); }
}

// opts: { sb, linkedEmail, text, staffName, accountId, oaId, imageUrls }
// Returns { status, detail, sent, failed, total }. NEVER throws.
async function sendToFamily(opts) {
  const { sb, linkedEmail, text, staffName, accountId, oaId } = opts;
  const imageUrls = opts.imageUrls || [];
  const none = (status, detail, total) => ({ status, detail, sent: 0, failed: status === 'failed' ? (total || 0) : 0, total: total || 0 });
  try {
    if (!windowOpen()) return none('skipped', 'ngoài giờ gửi Zalo (06:00–21:45)');
    const fam = await resolveFamily(sb, linkedEmail);
    if (!fam.found) return none('skipped', fam.reason === 'no_email' ? 'chưa liên kết email' : 'không có trong danh bạ Zalo');
    if (!fam.targets.length) return none('skipped', 'chưa có Zalo ID');
    if (await sentRecently(sb, fam, text)) return none('skipped', 'trùng tin vừa gửi (10 phút)', fam.targets.length);

    const token = await latestToken(sb);
    if (!token) return none('failed', 'không có access_token Zalo', fam.targets.length);

    const finalText = text + '\n\n' + FOOTER(staffName || 'TANSINH');
    const bangkokIso = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
    let sent = 0; const expired = [];
    for (const t of fam.targets) {
      const r = await sendOne(token, t.id, finalText, imageUrls);
      const deliveryStatus = r.ok ? 'Success' : 'Zalo hết hạn';
      if (r.ok) sent++; else expired.push(t.kind);
      const { error: stErr } = await sb.from('zalo_status').upsert({
        oa_id: oaId, recipient_id: t.id,
        recipient_name: t.kind === 'HV' ? fam.ten_hv : fam.ten_hv + ' (' + t.kind + ')',
        status: deliveryStatus, created_at: bangkokIso
      }, { onConflict: 'oa_id,recipient_id' });
      if (stErr) console.log('[zalo] zalo_status upsert failed:', stErr.message);
    }

    // the old app's sent log — one row per student, same shape as bulk-send-zalo
    const { error: logErr } = await sb.from('zalo_sent_messages').insert({
      sender_name: staffName || 'Staff', account_id: accountId || null,
      student_name: fam.ten_hv, receiver_id: fam.zalo_key, content: text, image_urls: imageUrls
    });
    if (logErr) console.log('[zalo] zalo_sent_messages insert failed:', logErr.message);

    const total = fam.targets.length;
    const status = sent === total ? 'sent' : sent > 0 ? 'partial' : 'failed';
    const detail = sent + '/' + total + (expired.length ? ' · hết hạn: ' + expired.join(', ') : '');
    return { status, detail, sent, failed: total - sent, total };
  } catch (e) {
    return none('failed', String((e && e.message) || e).slice(0, 180));
  }
}

module.exports = { sendToFamily, sendToOne, resolveFamily, windowOpen };
