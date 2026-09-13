// _glvVideoSourceHelper.js
//
// Reads the OWNER and the RECORDING TIME straight out of a video URL, for the
// two sources that never produce a video_uploads row: screenrec and jibri.
//
// Why this exists: giolamviec validates a card by asking video_uploads who
// uploaded the video and when. Nobody uploads a screenrec or jibri recording —
// the server writes it — so the lookup finds nothing and the card is marked
// INVALID and paid zero. But both formats carry the answer in the URL:
//
//   xem.tansinh.info/minhdoduy24082026145019/2026-08-24_14-50-34-937303.mp4
//                    └─ owner ─┘└ DDMMYYYYHHMMSS ┘
//
//   lv-watch?k=minhdoduy/2026-08/minhdoduy_2026-08-24-02-20-47.mp4
//              └ room ┘           └──── YYYY-MM-DD-HH-MM-SS ────┘
//
// This is a STRONGER check than the uploader row, because the recorder writes
// the name — a teacher cannot upload a file and claim it is someone else's.
//
// ⚠️ THE PREFIX TRAP. Matching "starts with minhdoduy" is NOT enough:
// "tansinh2..." starts with "tansinh", and you measured exactly one such pair
// among 171 accounts. So the folder must be the prefix followed by EXACTLY
// 14 digits. "tansinh2" + 14 digits leaves 15 characters after "tansinh" and
// cannot match.
//
// ⚠️ TIMEZONES DIFFER BETWEEN THE TWO SOURCES, and this decides the date check:
//   screenrec  the 14 digits come from the TEACHER'S BROWSER  -> Vietnam time
//   jibri      the filename is written by a recorder VM       -> UTC
// The recorder VMs run UTC while the hosts run +07. A 00:30 Vietnam lesson is
// 17:30 UTC the PREVIOUS DAY, so treating a jibri stamp as local would fail
// the date check on every late-evening lesson.
//
// ⚠️ The capital H in the filename is load-bearing: git-push-site.sh line 97
// collects "_*Helper.js" only. A file named _glv-video-source.js is never
// pushed to GitHub.

'use strict';

// Strip a query string only when the identity is in the path. A jibri link
// (?k=&s=) and a player wrapper (?url=) ARE their query string.
function safeBase(u) {
  u = (u || '').trim();
  const q = u.indexOf('?');
  if (q < 0) return u;
  const p = u.slice(0, q);
  return /\.(mp4|m4v|mov|webm)$/i.test(p) ? p : u;
}

// DDMMYYYYHHMMSS, written by the teacher's browser, so Vietnam time.
function fromScreenrecStamp(d) {
  if (!/^\d{14}$/.test(d)) return null;
  const day = d.slice(0, 2), mon = d.slice(2, 4), yr = d.slice(4, 8);
  const hh = d.slice(8, 10), mm = d.slice(10, 12), ss = d.slice(12, 14);
  const iso = `${yr}-${mon}-${day}T${hh}:${mm}:${ss}+07:00`;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

// YYYY-MM-DD-HH-MM-SS out of a jibri filename, written by a recorder VM in UTC.
function fromJibriStamp(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name || '');
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * describe(link) -> { kind, owner, recordedAt, id } or null
 *
 *   kind        'screenrec' | 'jibri'
 *   owner       the email prefix that recorded it, lowercase
 *   recordedAt  ISO 8601 UTC, or null if the name did not carry one
 *   id          stable identity, independent of any signature
 *
 * Returns null for anything else — an R2 upload, a meeting room link, a
 * Google Doc — so the caller falls back to its existing rules unchanged.
 */
function describe(link, depth) {
  depth = depth || 0;
  if (depth > 2) return null;
  if (typeof link !== 'string') return null;

  let u;
  try { u = new URL(link.trim()); } catch (e) { return null; }
  const host = u.host.toLowerCase();

  // player wrapper: the real video is inside ?url=
  if (host === 'play.tansinh.info') {
    const inner = u.searchParams.get('url');
    return inner ? describe(inner, depth + 1) : null;
  }

  // jibri share link
  if (u.pathname === '/api/lv-watch' || u.pathname === '/api/lv-stream') {
    if (host !== 'meetrecording.tansinh.info' && host !== 'lessonvideo.tansinh.info') return null;
    const k = u.searchParams.get('k');
    if (!k) return null;
    const parts = k.split('/');
    if (parts.length < 3) return null;                 // room/YYYY-MM/file.mp4
    const room = parts[0].toLowerCase();
    if (!room) return null;
    return {
      kind: 'jibri',
      owner: room,
      recordedAt: fromJibriStamp(parts[parts.length - 1]),
      id: 'jibri:' + k
    };
  }

  // screenrec
  if (host === 'xem.tansinh.info' && /\.mp4$/i.test(u.pathname)) {
    const seg = u.pathname.replace(/^\//, '').split('/');
    if (seg.length < 2) return null;
    // <prefix><14 digits>  with an optional -<n> suffix for a repeat session
    const m = /^([a-z0-9._-]*?)(\d{14})(?:-(\d+))?$/i.exec(seg[0]);
    if (!m || !m[1]) return null;
    return {
      kind: 'screenrec',
      owner: m[1].toLowerCase(),
      recordedAt: fromScreenrecStamp(m[2]),
      id: 'screenrec:' + seg.join('/')
    };
  }

  return null;
}

/** Does this recording belong to this worker? Exact prefix, never "starts with". */
function ownedBy(info, workerEmail) {
  if (!info || !info.owner) return false;
  const prefix = String(workerEmail || '').toLowerCase().split('@')[0].trim();
  return !!prefix && info.owner === prefix;
}

module.exports = { describe, ownedBy, safeBase };
