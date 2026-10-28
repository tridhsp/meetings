// _gbSyncHelper.js — GBSYNC-20261001.  Reconciles ONE Bookshelf book into giaobai's lessons table.
//
// HELPER: leading underscore, so server.js never loads it as a route. Capital H, so
// git-push-site.sh (the _*Helper.js glob) collects it into git.
// Used by /opt/my-api/gb-sync.js (the worker), routes/gb-sync.giaobai.js (the routes)
// and /root/book-tools/gbsync-cli.js (the command-line tool).
//
// THE RULES IT ENFORCES (see PLAN-GBSYNC-2026-10-01.md)
//   - writes NOTHING unless books.gb_sync is true (or opts.force, used only by the CLI
//     and the settings route AFTER a Super Admin pressed the switch)
//   - a book that already has a giaobai code KEEPS it; one that never had one gets BS-<slug>;
//     two candidate codes = refuse and say so
//   - every existing lesson id is kept; new ids are minted only for new chapters, with
//     giaobai's own scheme "DDMMYYYY HH:MM:SS (type) XYZ"; lesson_id_key is a generated
//     column and takes care of itself
//   - sort_order = the chapter's position (1-based), name follows the chapter, the chapter
//     url is always the FIRST document link, the six gb_* fields are written on every row
//   - a row whose chapter is gone is deleted; a row that is not chapter-linked ("unlinked",
//     e.g. a hand-added video lesson) keeps its name/links/order and only receives metadata
//   - a row whose chapter belongs to ANOTHER Bookshelf book ("foreign") is never touched
//     and blocks the sync with a clear message
//   - the whole Bookshelf book being deleted deletes NO lessons
//   - gbsync-multilevel (13 Oct 2026): books.gb_levels holds EXTRA levels, each its OWN giaobai code,
//     synced from the same chapters. Level 1 stays in gb_cap_lop / gb_code. Removing a level never
//     deletes its lessons -- same rule as switching the book off.
'use strict';
const { createClient } = require('@supabase/supabase-js');
const { INV } = require('./_gb-cache.giaobai');

const SB_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let _sb = null;
function sb() { if (!_sb) _sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }); return _sb; }

const TYPE_SUFFIX = { main: ' (main)', homework: ' (hw)', short: ' (short)', special: ' (special)', legacy: '' };
/* GBSYNCMEDIA-20261005: books_chapters.audio_url / video_url is a JSON array TEXT ('["url",...]', written by
   addbooks.js) or a plain url. Until 5 Oct 2026 the text itself was copied into lessons.audio_links[0] -- 60 audio
   and 292 video lessons across 27 synced books, every player on baihoc dead. mediaLinks() parses it; mergeMedia()
   puts the chapter's links first, keeps links a teacher added by hand, and drops any leftover JSON text, so the
   next pass over a synced book repairs its rows by itself. */
const isJsonText = x => typeof x === 'string' && x.trim().charAt(0) === '[';
function mediaLinks(v) { const s = String(v || '').trim(); if (!s) return []; if (s.charAt(0) === '[') { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(x => String(x || '').trim()).filter(Boolean); } catch (e) {} } return [s]; }
function mergeMedia(chapterMedia, rowLinks) {
  const want = mediaLinks(chapterMedia);
  const have = Array.isArray(rowLinks) ? rowLinks.filter(x => x) : [];
  const clean = have.filter(x => !isJsonText(x));
  if (!want.length) return clean.length === have.length ? null : clean;                 // no chapter media: only drop junk
  if (clean.length === have.length && want.every((w, i) => have[i] === w)) return null;  // already right: no write
  return want.concat(clean.filter(x => !want.includes(x)));
}
const BOOK_TYPES = Object.keys(TYPE_SUFFIX);
const SKILLS = ['Listening', 'Speaking', 'Reading', 'Writing', 'Vocabulary', 'Grammar', 'Pronunciation', 'Mock Test', 'THCS-THPT'];
const CODE_RE = /^[A-Za-z0-9_-]{1,60}$/;

/* ---------------------------------------------------------------- links and ids (giaobai's own conventions) */
function chapterUrl(slug, chapterId) { return 'https://book.tansinh.info/#/book/' + encodeURIComponent(slug) + '?lesson=' + encodeURIComponent(chapterId); }
function slugCode(slug) { return 'BS-' + String(slug || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 57); }
const LINK_RE = /book\.tansinh\.info\/(?:index\.html)?#\/book\/([^?&#\s"']+)(?:\?([^#\s"']*))?/i;
function chapterFromLink(url, slug, bookId) {
  const m = LINK_RE.exec(String(url || '')); if (!m) return null;
  let s = m[1]; try { s = decodeURIComponent(s); } catch (e) {}
  if (s !== slug && s !== String(bookId)) return null;
  const q = m[2] ? new URLSearchParams(m[2]) : null; return (q && q.get('lesson')) || null;
}
function lessonEpoch(id) { const m = /^(\d{2})(\d{2})(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(String(id || '')); if (!m) return null; return Math.floor(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 7, +m[5], +m[6]) / 1000); }
function tailLetters(id) { const m = /^(\d{8} \d{2}:\d{2}:\d{2})(?: \([^)]+\))?(?: ([A-Z]{3}))?$/.exec(String(id || '').trim()); return m ? (m[2] || null) : null; }
function fmtId(epochSec, type, letters) {
  const d = new Date(epochSec * 1000);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return p.day + p.month + p.year + ' ' + hh + ':' + p.minute + ':' + p.second + (TYPE_SUFFIX[type] || '') + ' ' + letters;
}
function randLetters(taken) { for (let t = 0; t < 500; t++) { let s = ''; for (let i = 0; i < 3; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); if (!taken.has(s)) { taken.add(s); return s; } } return null; }
function mintIds(existingRows, count, type) {
  const taken = new Set(); existingRows.forEach(r => { const t = tailLetters(r.lesson_id); if (t) taken.add(t); });
  let maxE = 0; existingRows.forEach(r => { const e = lessonEpoch(r.lesson_id); if (e && e > maxE) maxE = e; });
  let next = Math.max(maxE + 1, Math.floor(Date.now() / 1000)); const out = [];
  for (let i = 0; i < count; i++) { const L = randLetters(taken); if (!L) break; out.push(fmtId(next++, type, L)); }
  return out;
}
function norm(v) { if (v === null || v === undefined) return ''; const s = String(v); return (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !isNaN(Date.parse(s))) ? String(Date.parse(s)) : s; }   /* ABTEST-20261002: timestamps compare by value */

/* ---------------------------------------------------------------- reads */
const BOOK_COLS = 'id, name, slug, level_id, gb_sync, gb_code, gb_cap_lop, gb_skill, gb_book_type, gb_stage, gb_is_interactive, gb_is_uu_tien, gb_cadence_days, gb_levels, student_requirements, books_levels(name)';   /* gbsync-multilevel: + gb_levels */   /* tansinh dinhky: + gb_cadence_days */   /* tansinh dinhky2: + student_requirements, for the refusal */
async function loadBook(bookId) {
  const { data, error } = await sb().from('books').select(BOOK_COLS).eq('id', bookId).maybeSingle();
  if (error) throw new Error('books: ' + error.message);
  if (!data) return null;
  data.level_name = (data.books_levels && data.books_levels.name) || null; delete data.books_levels;
  return data;
}
async function loadChapters(bookId) {
  const { data, error } = await sb().from('books_chapters').select('id, name, sort_order, created_at, audio_url, video_url, is_test, test_marked_at, test_minutes')
    .eq('book_id', bookId).order('sort_order', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true });
  if (error) throw new Error('books_chapters: ' + error.message);
  return (data || []).map(c => ({ id: String(c.id), name: String(c.name || '').trim() || '(không tên)', audio_url: String(c.audio_url || '').trim(), video_url: String(c.video_url || '').trim(), is_test: !!c.is_test, test_marked_at: c.test_marked_at || null, test_minutes: (c.test_minutes === null || c.test_minutes === undefined || c.test_minutes === '' ? null : (Math.round(Number(c.test_minutes)) > 0 ? Math.round(Number(c.test_minutes)) : null)) }));
}
const ROW_COLS = 'id, lesson_id, lesson_name, sort_order, chapter_id, document_links, audio_links, video_links, book_name, cap_lop, skill, book_type, stage, is_interactive, is_uu_tien, cadence_days, is_test, test_marked_at, test_minutes, created_at';   /* tansinh dinhky: + cadence_days */   /* tansinh gbsync-fix: + created_at, shown on the repair card */
async function rowsForCode(code) {
  const out = []; let from = 0;
  for (;;) {
    const { data, error } = await sb().from('lessons').select(ROW_COLS).eq('book_code', code).range(from, from + 999);
    if (error) throw new Error('lessons: ' + error.message);
    out.push(...(data || [])); if (!data || data.length < 1000) break; from += 1000;
  }
  return out;
}
/* which giaobai codes already hold this book's chapters — by chapter_id, then by url for rows still unlinked */
async function codesPointingAt(book, chapterIds) {
  const codes = new Set();
  if (chapterIds.length) {
    const { data, error } = await sb().from('lessons').select('book_code').in('chapter_id', chapterIds);
    if (error) throw new Error('lessons by chapter: ' + error.message);
    (data || []).forEach(r => { if (r.book_code) codes.add(r.book_code); });
  }
  let from = 0;
  for (;;) {
    const { data, error } = await sb().from('lessons').select('book_code, document_links').is('chapter_id', null).range(from, from + 999);
    if (error) throw new Error('lessons unlinked: ' + error.message);
    (data || []).forEach(r => { (r.document_links || []).forEach(l => { if (chapterFromLink(l, book.slug, book.id) && r.book_code) codes.add(r.book_code); }); });
    if (!data || data.length < 1000) break; from += 1000;
  }
  return codes;
}
/* === tansinh gbsync-multilevel BEGIN (resolve) === */
const LEVEL_MAX = 12;
/* books.gb_levels, cleaned: [{cap_lop, code}], empty rows dropped, never more than LEVEL_MAX */
function normLevels(raw) {
  let a = raw; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
  if (!Array.isArray(a)) return [];
  const out = [];
  a.forEach(x => { if (!x || typeof x !== 'object') return; const cap = String(x.cap_lop || '').trim().slice(0, 80); const code = String(x.code || '').trim(); if (!cap && !code) return; out.push({ cap_lop: cap || null, code: code || null }); });
  return out.slice(0, LEVEL_MAX);
}
/* pointing = the Set from codesPointingAt (null when it was not needed); exclude = the codes the extra levels use */
function resolveCode(book, pointing, exclude) {
  if (book.gb_code) return { code: book.gb_code, source: 'gb_code' };
  const codes = [...(pointing || [])].filter(c => !(exclude && exclude.has(c)));
  if (codes.length === 0) return { code: slugCode(book.slug), source: 'new' };
  if (codes.length === 1) return { code: codes[0], source: 'adopted' };
  return { code: null, source: 'collision', candidates: codes.slice().sort() };
}
/* which OTHER Bookshelf book owns this code -- as its level 1 (gb_code) or as an extra level (gb_levels) */
async function codeOwner(code, notBookId) {
  const s = sb();
  let r = await s.from('books').select('id, name').eq('gb_code', code).neq('id', notBookId).limit(1);
  if (r.error) throw new Error('books: ' + r.error.message);
  if (r.data && r.data.length) return { id: String(r.data[0].id), name: r.data[0].name || '', where: 'gb_code' };
  r = await s.from('books').select('id, name').contains('gb_levels', JSON.stringify([{ code }])).neq('id', notBookId).limit(1);
  if (r.error) throw new Error('books: ' + r.error.message);
  if (r.data && r.data.length) return { id: String(r.data[0].id), name: r.data[0].name || '', where: 'gb_levels' };
  return null;
}
/* the cấp lớp, name and lesson count a code carries today -- for the "pick an existing code" list on the panel */
async function codeInfo(codes) {
  if (!codes.length) return [];
  const { data, error } = await sb().from('lessons').select('book_code, cap_lop, book_name').in('book_code', codes);
  if (error) throw new Error('lessons: ' + error.message);
  const m = {};
  (data || []).forEach(r => { const c = m[r.book_code] || (m[r.book_code] = { code: r.book_code, cap_lop: null, book_name: null, lessons: 0 }); c.lessons++; if (c.cap_lop == null && r.cap_lop) c.cap_lop = r.cap_lop; if (c.book_name == null && r.book_name) c.book_name = r.book_name; });
  return codes.map(c => m[c] || { code: c, cap_lop: null, book_name: null, lessons: 0 });
}
/* === tansinh gbsync-multilevel END (resolve) === */
async function listSynced() {
  const { data, error } = await sb().from('books').select('id').eq('gb_sync', true);
  if (error) throw new Error('books: ' + error.message);
  return (data || []).map(b => String(b.id));
}
/* for a chapter that no longer exists: which synced book did it belong to (via the lesson row it left behind) */
async function bookIdForChapter(chapterId) {
  const { data, error } = await sb().from('lessons').select('book_code').eq('chapter_id', chapterId).limit(1);
  if (error || !data || !data.length) return null;
  const { data: b } = await sb().from('books').select('id').eq('gb_code', data[0].book_code).limit(1);
  if (b && b.length) return String(b[0].id);
  const { data: b2 } = await sb().from('books').select('id').contains('gb_levels', JSON.stringify([{ code: data[0].book_code }])).limit(1);   /* gbsync-multilevel: an extra level's code */
  return b2 && b2.length ? String(b2[0].id) : null;
}

/* === tansinh gbsync-fix BEGIN (issues) === 14 Oct 2026.
   Every problem sentence is ALSO recorded as an ISSUE the addbooks panel can turn into a card with a plan and,
   for the one fixable kind, a button. prob() pushes both, so preview.problems stays exactly what it was.
     issue = { kind, text, fixable, data, title?, plan?, field? }      field = the id of the panel control to focus
   submissionCounts(): how many students have submitted work on a lesson. lesson_submission.lesson_id is a
   COMPOSITE "<lesson id>_<email>_…" (sometimes with a " (dd/mm/yyyy hh:mm)" tail) — see gb-completed-lessons —
   so a lesson's rows are the ones EQUAL to its id or starting with "<id>_". Distinct emails per id.
   Returns null for an id it could not read, never throws: a counting problem must not break the sync preview. */
function prob(out, kind, text, extra) {
  out.problems.push(text);
  if (!Array.isArray(out.issues)) out.issues = [];
  out.issues.push(Object.assign({ kind: kind, text: text, fixable: false, data: {} }, extra || {}));
}
function linkCount(v) { return Array.isArray(v) ? v.filter(Boolean).length : 0; }
async function submissionCounts(lessonIds) {
  const out = {};
  for (const id of (lessonIds || [])) {
    const base = String(id || ''); if (!base) continue;
    try {
      const emails = new Set();
      let r = await sb().from('lesson_submission').select('email').eq('lesson_id', base).limit(5000);
      if (r.error) throw new Error(r.error.message);
      (r.data || []).forEach(x => { if (x.email) emails.add(String(x.email).trim().toLowerCase()); });
      const esc = base.replace(/[\\%_]/g, m => '\\' + m);
      r = await sb().from('lesson_submission').select('email').like('lesson_id', esc + '\\_%').limit(5000);
      if (r.error) throw new Error(r.error.message);
      (r.data || []).forEach(x => { if (x.email) emails.add(String(x.email).trim().toLowerCase()); });
      out[base] = emails.size;
    } catch (e) { console.error('[gb-sync] lesson_submission for ' + JSON.stringify(base) + ': ' + e.message); out[base] = null; }
  }
  return out;
}
/* === tansinh gbsync-fix END (issues) === */

/* ---------------------------------------------------------------- the plan: what WOULD change. Reads only. */
/* === tansinh gbsync-multilevel BEGIN (plan) ===
   One Bookshelf book -> one giaobai code PER LEVEL. Level 1 = (gb_cap_lop, gb_code); the rest = books.gb_levels.
   Every code gets the same chapters; only cap_lop differs. planCode() is the old single-code plan, run once per level,
   and it ADDS to the shared totals (out.add / update / remove / keep ...) so summary() and the panel read as before. */
function levelTag(L) { return L.primary ? 'Cấp lớp 1' : ('Cấp lớp thêm ' + L.n + (L.cap_lop ? ' (' + L.cap_lop + ')' : '')); }
async function planCode(book, chapters, L, meta, mintPool, out) {
  const code = L.code;
  const lv = { cap_lop: L.cap_lop || null, code, primary: !!L.primary, source: L.source, lessons: 0, add: 0, update: 0, remove: 0, keep: 0, unlinked: 0, foreign: 0, problems: [], issues: [] };   /* tansinh gbsync-fix */
  const rows = await rowsForCode(code); lv.lessons = rows.length;
  const chapterSet = new Set(chapters.map(c => c.id));
  const byChapter = new Map(); const unlinkedRows = []; let remove = []; const dups = [];   /* tansinh gbsync-fix */
  for (const r of rows) {
    let cid = r.chapter_id ? String(r.chapter_id) : null;
    if (!cid) { for (const l of (r.document_links || [])) { const c = chapterFromLink(l, book.slug, book.id); if (c && chapterSet.has(c)) { cid = c; r._adopt = c; break; } } }
    if (!cid) { unlinkedRows.push(r); out.unlinked.push({ lesson_id: r.lesson_id, lesson_name: r.lesson_name, code }); lv.unlinked++; continue; }
    if (!chapterSet.has(cid)) { remove.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: r.lesson_name, chapter_id: cid, code }); continue; }
    if (byChapter.has(cid)) { dups.push({ cid: cid, first: byChapter.get(cid), second: r }); continue; }   /* tansinh gbsync-fix: reported below, with the facts the repair needs */
    byChapter.set(cid, r);
  }
  /* === tansinh gbsync-fix BEGIN (dup-chapter) === the one problem the panel can repair: two rows on one chapter.
     The sentence is the same as before; the issue carries both rows, their link counts and how many students have
     submitted work on each. If lesson_submission could not be read the issue is NOT fixable (no button on the page)
     rather than pretending nobody has history. */
  if (dups.length) {
    const chName = {}; chapters.forEach(c => { chName[c.id] = c.name; });
    const idList = []; dups.forEach(d => { idList.push(d.first.lesson_id, d.second.lesson_id); });
    const done = await submissionCounts([...new Set(idList)]);
    const facts = r => ({ lesson_id: r.lesson_id, lesson_name: r.lesson_name || null, sort_order: (r.sort_order === null || r.sort_order === undefined) ? null : r.sort_order,
      created_at: r.created_at || null, links: { audio: linkCount(r.audio_links), video: linkCount(r.video_links), doc: linkCount(r.document_links) },
      students_done: done[r.lesson_id] === undefined ? null : done[r.lesson_id] });
    dups.forEach(d => {
      const known = done[d.first.lesson_id] !== null && done[d.second.lesson_id] !== null;
      prob(lv, 'dup-chapter', 'Hai bài cùng trỏ tới một chương: ' + d.first.lesson_id + ' và ' + d.second.lesson_id + '. Xoá một bài trong giaobai.html trước.',
        Object.assign({ fixable: known, action: 'delete-lesson', data: { book_code: code, chapter_id: d.cid, chapter_name: chName[d.cid] || null, lessons: [facts(d.first), facts(d.second)] } },
          known ? {} : { plan: 'Không đọc được bài nộp của học viên (lesson_submission), nên chưa thể sửa tự động. Tải lại sau; nếu vẫn vậy, xoá một bài trong giaobai.html.' }));
    });
  }
  /* === tansinh gbsync-fix END (dup-chapter) === */
  if (remove.length) {   /* a "gone" chapter may really be another book's chapter: never delete those */
    const { data, error } = await sb().from('books_chapters').select('id, book_id').in('id', remove.map(x => x.chapter_id));
    if (error) throw new Error('books_chapters: ' + error.message);
    const foreignIds = new Set((data || []).filter(c => String(c.book_id) !== String(book.id)).map(c => String(c.id)));
    if (foreignIds.size) {
      const foreign = remove.filter(x => foreignIds.has(x.chapter_id)); remove = remove.filter(x => !foreignIds.has(x.chapter_id));
      out.foreign.push(...foreign); lv.foreign = foreign.length;
      prob(lv, 'foreign', 'Mã ' + code + ' cũng chứa ' + foreign.length + ' bài thuộc một sách Bookshelf KHÁC. Tách chúng ra trong giaobai.html, hoặc chọn mã khác.', { title: 'Mã này chứa bài của sách khác', plan: 'Mở giaobai.html, chuyển các bài đó sang mã khác (hoặc xoá chúng), hoặc dùng mã khác cho sách này.', data: { lessons: foreign.map(x => ({ lesson_id: x.lesson_id, lesson_name: x.lesson_name || null })) } });   /* tansinh gbsync-fix */
    }
  }
  out.remove.push(...remove); lv.remove = remove.length;
  const fresh = [];
  chapters.forEach((c, i) => {
    const want = Object.assign({ lesson_name: c.name, sort_order: i + 1, chapter_id: c.id, is_test: !!c.is_test, test_marked_at: c.test_marked_at || null, test_minutes: c.test_minutes }, meta);   /* ABTEST-20261002 + P5-20261002 */
    const r = byChapter.get(c.id);
    if (!r) { fresh.push({ chapter: c, want }); return; }
    const diff = {};
    for (const k of Object.keys(want)) { if (norm(r[k]) !== norm(want[k])) diff[k] = want[k]; }
    const url = chapterUrl(book.slug, c.id); const links = Array.isArray(r.document_links) ? r.document_links.slice() : [];
    const others = links.filter(l => l && !chapterFromLink(l, book.slug, book.id)); const wantLinks = [url].concat(others);
    if (JSON.stringify(wantLinks) !== JSON.stringify(links)) diff.document_links = wantLinks;
    { const m = mergeMedia(c.audio_url, r.audio_links); if (m) diff.audio_links = m; }   /* GBSYNCMEDIA-20261005: was [c.audio_url], the JSON text itself */
    { const m = mergeMedia(c.video_url, r.video_links); if (m) diff.video_links = m; }   /* GBSYNCMEDIA-20261005 */
    if (Object.keys(diff).length) { out.update.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: c.name, diff, code }); lv.update++; } else { out.keep++; lv.keep++; }
  });
  for (const r of unlinkedRows) {   /* metadata only — never their name, links or order */
    const diff = {}; for (const k of Object.keys(meta)) { if (norm(r[k]) !== norm(meta[k])) diff[k] = meta[k]; }
    if (Object.keys(diff).length) { out.update.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: r.lesson_name, diff, unlinked: true, code }); lv.update++; }
  }
  mintPool.push(...rows);                                  /* new ids never collide across this book's codes */
  if (fresh.length) {
    const ids = mintIds(mintPool, fresh.length, meta.book_type);
    if (ids.length < fresh.length) prob(lv, 'mint', 'Không tạo đủ id mới cho ' + fresh.length + ' chương.', { title: 'Không tạo đủ id bài mới', plan: 'Bấm Lưu lại. Nếu vẫn lỗi, mã này đã dùng gần hết các bộ ba chữ cái — báo quản trị.' });   /* tansinh gbsync-fix */
    fresh.forEach((f, i) => { if (!ids[i]) return; mintPool.push({ lesson_id: ids[i] }); lv.add++; out.add.push({ lesson_id: ids[i], chapter_id: f.chapter.id, lesson_name: f.chapter.name, code,
      row: Object.assign({ book_code: code, lesson_id: ids[i], audio_links: mediaLinks(f.chapter.audio_url), video_links: mediaLinks(f.chapter.video_url), /* GBSYNCMEDIA-20261005 */
        document_links: [chapterUrl(book.slug, f.chapter.id)], inserted_by: null }, f.want) }); });
  }
  lv.problems.forEach(x => out.problems.push(L.primary ? x : (levelTag(L) + ': ' + x)));
  /* tansinh gbsync-fix: the issues follow their sentences, with the same level tag, so issue.text always equals a sentence in out.problems */
  (lv.issues || []).forEach(x => { if (!L.primary) x.text = levelTag(L) + ': ' + x.text; x.data = Object.assign({ book_code: code, cap_lop: L.cap_lop || null, primary: !!L.primary }, x.data || {}); out.issues.push(x); });
  delete lv.issues;
  out.levels.push(lv);
  return lv;
}
async function plan(bookId, opts) {
  opts = opts || {};
  const book = await loadBook(bookId);
  if (!book) return { ok: false, found: false, book_id: bookId, error: 'Không tìm thấy sách Bookshelf ' + bookId, problems: ['Không tìm thấy sách Bookshelf ' + bookId] };
  const chapters = await loadChapters(book.id);
  const extras = normLevels(book.gb_levels);
  const extraCodes = new Set(extras.map(x => x.code).filter(Boolean));
  /* the unlinked-lessons walk is only needed when level 1 has no code yet, or the panel wants the "existing codes" list */
  const pointing = (!book.gb_code || opts.candidates) ? await codesPointingAt(book, chapters.map(c => c.id)) : null;
  const res = resolveCode(book, pointing, extraCodes);
  const out = { ok: true, found: true, book_id: String(book.id), slug: book.slug, name: book.name, level_name: book.level_name, gb_sync: !!book.gb_sync,
    code: res.code, code_source: res.source, candidates: res.candidates || [], chapters: chapters.length,
    add: [], update: [], remove: [], keep: 0, unlinked: [], foreign: [], problems: [], issues: [] /* tansinh gbsync-fix */, levels: [], candidate_info: [], book, chapters_list: chapters };
  if (pointing) { try { out.candidate_info = await codeInfo([...pointing].filter(c => c !== res.code && !extraCodes.has(c)).sort()); } catch (e) { out.candidate_info = []; } }
  if (!res.code) { out.ok = false; prob(out, 'collision', 'Sách này đang được trỏ tới từ ' + res.candidates.length + ' mã giaobai: ' + res.candidates.join(', ') + '. Chọn một mã trong ô "Mã giaobai" rồi lưu — mã còn lại có thể đặt vào một cấp lớp thêm.', { field: 'abGsCode', data: { candidates: res.candidates } }); return out; }   /* tansinh gbsync-fix */
  if (!CODE_RE.test(res.code)) prob(out, 'bad-code', 'Mã không hợp lệ: ' + res.code, { field: 'abGsCode' });   /* tansinh gbsync-fix */
  if (!book.gb_book_type) prob(out, 'missing-type', 'Chưa chọn Loại. Loại quyết định tab trên baihoc và hậu tố trong id bài.', { field: 'abGsType' });   /* tansinh gbsync-fix */
  else if (!BOOK_TYPES.includes(book.gb_book_type)) prob(out, 'bad-type', 'Loại không hợp lệ: ' + book.gb_book_type, { title: 'Loại không hợp lệ', field: 'abGsType', plan: 'Chọn lại Loại ở trên rồi bấm Lưu.' });   /* tansinh gbsync-fix */
  if (book.gb_skill && !SKILLS.includes(book.gb_skill)) prob(out, 'bad-skill', 'Kỹ năng không hợp lệ: ' + book.gb_skill, { title: 'Kỹ năng không hợp lệ', field: 'abGsSkill', plan: 'Chọn lại Kỹ năng ở trên rồi bấm Lưu.' });   /* tansinh gbsync-fix */
  if (!book.gb_cap_lop && ['main', 'homework', 'short'].includes(book.gb_book_type)) prob(out, 'missing-cap', 'Loại ' + book.gb_book_type + ' cần Cấp lớp: baihoc hiện sách này cho CẢ cấp lớp.', { field: 'abGsCap' });   /* tansinh gbsync-fix */
  if (!chapters.length) prob(out, 'no-chapters', 'Sách chưa có chương nào.');   /* tansinh gbsync-fix */

  const levels = [{ cap_lop: book.gb_cap_lop || null, code: res.code, source: res.source, primary: true, n: 1 }];
  extras.forEach((x, i) => levels.push({ cap_lop: x.cap_lop, code: x.code, source: 'extra', primary: false, n: i + 2 }));
  const seenCap = new Set(), seenCode = new Set();
  for (const L of levels) {
    if (!L.primary) {
      if (!L.cap_lop) prob(out, 'level', levelTag(L) + ': chưa chọn cấp lớp.', { data: { n: L.n, cap_lop: L.cap_lop || null, code: L.code || null } });   /* tansinh gbsync-fix */
      if (!L.code) prob(out, 'level', levelTag(L) + ': chưa có mã giaobai.', { data: { n: L.n, cap_lop: L.cap_lop || null, code: L.code || null } });   /* tansinh gbsync-fix */
      else if (!CODE_RE.test(L.code)) prob(out, 'level', levelTag(L) + ': mã không hợp lệ: ' + L.code, { data: { n: L.n, cap_lop: L.cap_lop || null, code: L.code || null } });   /* tansinh gbsync-fix */
    }
    if (L.cap_lop) { const k = L.cap_lop.toLowerCase(); if (seenCap.has(k)) prob(out, 'level', levelTag(L) + ': cấp lớp ' + L.cap_lop + ' bị chọn hai lần.', { data: { n: L.n, cap_lop: L.cap_lop || null, code: L.code || null } }); seenCap.add(k); }   /* tansinh gbsync-fix */
    if (L.code) { if (seenCode.has(L.code)) { prob(out, 'level', levelTag(L) + ': mã ' + L.code + ' bị dùng hai lần.', { data: { n: L.n, cap_lop: L.cap_lop || null, code: L.code || null } }); L.dup = true; } seenCode.add(L.code); }   /* tansinh gbsync-fix */
  }
  for (const L of levels) { if (!L.code || !CODE_RE.test(L.code) || L.dup) continue; const own = await codeOwner(L.code, book.id); if (own) prob(out, 'code-owned', levelTag(L) + ': mã ' + L.code + ' đang thuộc sách Bookshelf khác: ' + (own.name || own.id) + '.', { title: 'Mã đang thuộc sách khác', plan: 'Đổi mã ở ' + (L.primary ? 'ô "Mã giaobai"' : 'dòng cấp lớp đó') + ' rồi bấm Lưu, hoặc tắt đồng bộ ở sách kia trước.', field: L.primary ? 'abGsCode' : null, data: { n: L.n, code: L.code, owner: { id: own.id, name: own.name || null, where: own.where } } }); }   /* tansinh gbsync-fix */
  const meta = { book_name: book.name, cap_lop: book.gb_cap_lop || null, skill: book.gb_skill || null, book_type: book.gb_book_type || null,
    stage: (book.gb_stage === null || book.gb_stage === undefined ? null : Number(book.gb_stage)), is_interactive: !!book.gb_is_interactive, is_uu_tien: !!book.gb_is_uu_tien,
    cadence_days: (Number(book.gb_cadence_days) > 0 ? Number(book.gb_cadence_days) : null) /* tansinh dinhky: 7 = mỗi tuần 1 bài, 14 = 2 tuần 1 bài, null = off; lessons-next reads it */ };
  out.meta = meta;
  const mintPool = [];
  for (const L of levels) {
    if (!L.code || !CODE_RE.test(L.code) || L.dup) { out.levels.push({ cap_lop: L.cap_lop || null, code: L.code || null, primary: !!L.primary, source: L.source, lessons: 0, add: 0, update: 0, remove: 0, keep: 0, unlinked: 0, foreign: 0, problems: [L.dup ? 'mã bị dùng hai lần' : 'chưa có mã'] }); continue; }
    await planCode(book, chapters, L, Object.assign({}, meta, { cap_lop: L.cap_lop || null }), mintPool, out);
  }
  if (out.problems.length) out.ok = false;
  return out;
}
/* === tansinh gbsync-multilevel END (plan) === */
function summary(p) {
  return { code: p.code || null, source: p.code_source || null, chapters: p.chapters || 0, add: (p.add || []).length, update: (p.update || []).length, remove: (p.remove || []).length,
    keep: p.keep || 0, unlinked: (p.unlinked || []).length, foreign: (p.foreign || []).length, problems: p.problems || [], written: !!p.written, at: new Date().toISOString(),
    levels: (p.levels || []).map(L => ({ cap_lop: L.cap_lop || null, code: L.code || null, primary: !!L.primary, source: L.source || null, lessons: L.lessons || 0, add: L.add || 0, update: L.update || 0, remove: L.remove || 0, keep: L.keep || 0, problems: L.problems || [] })) };   /* gbsync-multilevel */
}
async function saveState(bookId, code, err, result) {
  const row = { book_id: bookId, code: code || null, last_error: err || null, last_result: result || null };
  if (!err) row.last_sync = new Date().toISOString();
  const { error } = await sb().from('gb_sync_state').upsert(row, { onConflict: 'book_id' });
  if (error) console.error('[gb-sync] gb_sync_state:', error.message);
}

/* ---------------------------------------------------------------- reconcile: plan, then write. */
async function reconcile(bookId, opts) {
  opts = opts || {}; const dry = !!opts.dry;
  let p;
  try { p = await plan(bookId, { candidates: !!opts.candidates }); } catch (e) { if (!dry) await saveState(bookId, null, 'plan: ' + e.message, null); return { ok: false, book_id: bookId, error: 'plan: ' + e.message, problems: ['plan: ' + e.message] }; }   /* gbsync-multilevel: opts.candidates */
  if (!p.found) return p;                                   /* the whole book is gone: lessons stay, state row cascades away */
  if (!p.ok) { if (!dry && (p.gb_sync || opts.force)) await saveState(bookId, p.code, p.problems.join(' | '), summary(p)); return p; }
  if (!p.gb_sync && !opts.force) { p.skipped = 'gb_sync is off'; return p; }
  if (dry) return p;
  const s = sb(); const errs = [];
  if (p.code_source !== 'gb_code') { const { error } = await s.from('books').update({ gb_code: p.code }).eq('id', bookId); if (error) errs.push('books.gb_code: ' + error.message); }
  if (!errs.length) {
    /* === tansinh gbsync-atomic BEGIN (7 Oct 2026) ===
       One insert for ALL new lessons, not one per lesson. On 7 Oct 2026 the
       web route and the gb-sync worker both wrote the same 26 lessons in the
       same second: the worker read the table while it was half-written (11 of
       26) and added the other 15. A single insert is atomic, so another reader
       sees none or all. And a unique-key refusal (Postgres 23505) means the
       other writer got there first -- that is not an error, the next tick
       simply finds the lessons already in place. */
    /* gbsync-multilevel: one atomic insert PER CODE (= per level), so a lost race on one level never hides the others */
    if (p.add.length) {
      const byCode = {}; p.add.forEach(a => { (byCode[a.row.book_code] = byCode[a.row.book_code] || []).push(a); });
      for (const code of Object.keys(byCode)) {
        const adds = byCode[code];
        const { error } = await s.from('lessons').insert(adds.map(a => a.row));
        if (error && String(error.code) === '23505') {
          console.log('[gb-sync] lost the race on ' + bookId + ' (' + code + '): ' + adds.length + ' lesson(s) already added by another writer; skipping');
          p.lost_race = true; p.add = p.add.filter(a => a.row.book_code !== code);
        }
        else if (error) errs.push('insert ' + adds.length + ' lesson(s) (' + code + '): ' + error.message);
      }
    }
    /* === tansinh gbsync-atomic END === */
    for (const u of p.update) { const { error } = await s.from('lessons').update(u.diff).eq('id', u.id); if (error) errs.push('update ' + u.lesson_id + ': ' + error.message); }
    if (p.remove.length) { const { error } = await s.from('lessons').delete().in('id', p.remove.map(x => x.id)); if (error) errs.push('delete: ' + error.message); }
  }
  if (p.add.length || p.update.length || p.remove.length) INV.lessons().catch(() => {});
  p.written = true; const err = errs.length ? errs.join(' | ') : null;
  await saveState(bookId, p.code, err, summary(p));
  return Object.assign(p, { ok: !err, error: err });
}

/* ---------------------------------------------------------------- settings: what the addbooks panel and the CLI read and write */
function normLevel(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function suggestCapLop(levelName, caps) {
  if (!levelName || !Array.isArray(caps)) return null;
  const n = normLevel(levelName); const m = /^(.*?)testprep$/.exec(n); const alt = m ? ('testprep' + m[1]) : null;
  for (const c of caps) { const nc = normLevel(c); if (nc === n || (alt && nc === alt)) return c; }
  return null;
}
/* === tansinh dinhky2 BEGIN (req) === Định kỳ v2, 23 Oct 2026.
   reqCount(b): how many student requirements the Bookshelf book has (books.student_requirements, the "Yêu cầu cho học viên"
   list). A book with NONE has no "Nộp bài" on baihoc, so a cadence on it would lock every learner for good — the card and
   saveSettings() both refuse. levelLearners(b): how many active learners sit at the book's level(s); the card shows it as a
   WARNING for a pool book (main / homework / short), because every learner at the level who never touched the book is overdue
   the moment a cadence lands. Both are read-only; any failure answers 0 / null and the card carries on. */
const CAD_MIN = 1, CAD_MAX = 90;
function reqCount(b) { try { const a = (b && Array.isArray(b.student_requirements)) ? b.student_requirements : []; return a.filter(r => r && String(r.html || '').trim()).length; } catch (e) { return 0; } }
async function levelLearners(b) {
  try {
    const levels = []; if (b && b.gb_cap_lop) levels.push(String(b.gb_cap_lop));
    for (const x of normLevels(b && b.gb_levels)) if (x && x.cap_lop && !levels.includes(String(x.cap_lop))) levels.push(String(x.cap_lop));
    if (!levels.length) return null;
    const { count, error } = await sb().from('danh_sach_hv').select('email', { count: 'exact', head: true }).in('cap_lop_hoc', levels).neq('archive_state', true);
    if (error) return null;
    return { levels, count: Number(count) || 0 };
  } catch (e) { return null; }
}
/* === tansinh dinhky2 END (req) === */
async function settings(bookId, caps) {
  const p = await reconcile(bookId, { dry: true, force: true, candidates: true });   /* gbsync-multilevel: + the existing-codes list */
  if (!p.found) return { ok: false, error: p.error };
  const { data: st } = await sb().from('gb_sync_state').select('code, last_sync, last_error, last_result').eq('book_id', bookId).maybeSingle();
  const b = p.book;
  return { ok: true, book: { id: String(b.id), name: b.name, slug: b.slug, level_name: b.level_name },
    fields: { gb_sync: !!b.gb_sync, gb_code: b.gb_code || null, gb_cap_lop: b.gb_cap_lop || null, gb_skill: b.gb_skill || null, gb_book_type: b.gb_book_type || null,
      gb_stage: (b.gb_stage === null || b.gb_stage === undefined) ? null : Number(b.gb_stage), gb_is_interactive: !!b.gb_is_interactive, gb_is_uu_tien: !!b.gb_is_uu_tien,
      gb_cadence_days: (Number(b.gb_cadence_days) > 0 ? Number(b.gb_cadence_days) : null), /* tansinh dinhky */
      gb_levels: normLevels(b.gb_levels) /* gbsync-multilevel */ },
    suggest_cap_lop: suggestCapLop(b.level_name, caps), state: st || null,
    student_requirements_count: reqCount(b), level_learners: await levelLearners(b), cadence_range: [CAD_MIN, CAD_MAX],   /* tansinh dinhky2 */
    preview: { ok: p.ok, code: p.code, code_source: p.code_source, candidates: p.candidates, chapters: p.chapters, add: p.add.length, update: p.update.length, remove: p.remove.length,
      keep: p.keep, unlinked: p.unlinked, foreign: p.foreign, problems: p.problems, issues: p.issues || [] /* tansinh gbsync-fix */, new_ids_example: p.add.length ? p.add[0].lesson_id : null,
      levels: p.levels || [], candidate_info: p.candidate_info || [] /* gbsync-multilevel */ } };
}
function cleanFields(body) {
  const f = {}; const errs = [];
  if (body.gb_sync !== undefined) f.gb_sync = !!body.gb_sync;
  if (body.gb_code !== undefined) { const c = String(body.gb_code || '').trim(); if (c && !CODE_RE.test(c)) errs.push('Mã chỉ gồm chữ, số, gạch, tối đa 60 ký tự.'); f.gb_code = c || null; }
  if (body.gb_cap_lop !== undefined) { const c = String(body.gb_cap_lop || '').trim().slice(0, 80); f.gb_cap_lop = c || null; }
  if (body.gb_skill !== undefined) { const c = String(body.gb_skill || '').trim(); if (c && !SKILLS.includes(c)) errs.push('Kỹ năng không hợp lệ: ' + c); f.gb_skill = c || null; }
  if (body.gb_book_type !== undefined) { const c = String(body.gb_book_type || '').trim(); if (c && !BOOK_TYPES.includes(c)) errs.push('Loại không hợp lệ: ' + c); f.gb_book_type = c || null; }
  if (body.gb_stage !== undefined) { const v = body.gb_stage; if (v === null || v === '' || v === undefined) f.gb_stage = null; else { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 20) errs.push('Stage phải là số nguyên 0–20.'); else f.gb_stage = n; } }
  if (body.gb_is_interactive !== undefined) f.gb_is_interactive = !!body.gb_is_interactive;
  if (body.gb_is_uu_tien !== undefined) f.gb_is_uu_tien = !!body.gb_is_uu_tien;
  /* === tansinh dinhky BEGIN (clean) === Định kỳ: null / 0 = off, 7 = mỗi tuần 1 bài, 14 = 2 tuần 1 bài. Anything else is refused. */
  if (body.gb_cadence_days !== undefined) { const v = body.gb_cadence_days; if (v === null || v === '' || v === 0 || v === '0' || v === false) f.gb_cadence_days = null; else { const n = Number(v); if (!Number.isInteger(n) || n < CAD_MIN || n > CAD_MAX) errs.push('Định kỳ phải là số nguyên từ ' + CAD_MIN + ' đến ' + CAD_MAX + ' ngày (7 = mỗi tuần 1 bài).'); else f.gb_cadence_days = n; } }   /* tansinh dinhky2: any whole number 1..90, not only 7 / 14 */
  /* === tansinh dinhky END (clean) === */
  /* === tansinh gbsync-multilevel BEGIN (clean) === the extra levels. The whole list is replaced on every save that sends it. */
  if (body.gb_levels !== undefined) {
    if (!Array.isArray(body.gb_levels)) errs.push('gb_levels phải là danh sách.');
    else {
      const out = []; const seenK = new Set(), seenC = new Set();
      const cap1 = String(body.gb_cap_lop !== undefined ? (body.gb_cap_lop || '') : '').trim().toLowerCase();
      const code1 = String(body.gb_code !== undefined ? (body.gb_code || '') : '').trim();
      body.gb_levels.forEach((x, i) => {
        const cap = String((x && x.cap_lop) || '').trim().slice(0, 80); const code = String((x && x.code) || '').trim();
        if (!cap && !code) return;                                   /* an empty row is just dropped */
        const tag = 'Cấp lớp thêm ' + (i + 1) + ': ';
        if (!cap) errs.push(tag + 'chưa chọn cấp lớp.');
        if (!code) errs.push(tag + 'chưa có mã giaobai.');
        else if (!CODE_RE.test(code)) errs.push(tag + 'mã chỉ gồm chữ, số, gạch, tối đa 60 ký tự.');
        if (cap) { const k = cap.toLowerCase(); if (seenK.has(k) || (cap1 && k === cap1)) errs.push(tag + 'cấp lớp ' + cap + ' đã có ở dòng khác.'); seenK.add(k); }
        if (code) { if (seenC.has(code) || (code1 && code === code1)) errs.push(tag + 'mã ' + code + ' đã có ở dòng khác.'); seenC.add(code); }
        out.push({ cap_lop: cap || null, code: code || null });
      });
      if (out.length > LEVEL_MAX) errs.push('Tối đa ' + LEVEL_MAX + ' cấp lớp thêm.');
      f.gb_levels = out;
    }
  }
  /* === tansinh gbsync-multilevel END (clean) === */
  return { fields: f, errors: errs };
}
/* save the six fields and the switch; when the switch is ON run the sync at once. A book with
   problems is saved with the switch OFF, and the problems are returned, so a half-set book never syncs. */
async function saveSettings(bookId, body, who) {
  const { fields, errors } = cleanFields(body || {});
  if (errors.length) return { ok: false, saved: false, problems: errors };
  const cur = await loadBook(bookId); if (!cur) return { ok: false, saved: false, problems: ['Không tìm thấy sách'] };
  /* tansinh dinhky2: a cadence on a book with no student requirements would lock every learner (no Nộp bài on baihoc) — refused here as well as on the card */
  if (fields.gb_cadence_days > 0 && reqCount(cur) === 0) return { ok: false, saved: false, problems: ['Định kỳ bị từ chối: sách chưa có yêu cầu nào cho học viên, nên học viên không thể nộp bài. Thêm yêu cầu ở mục "Yêu cầu cho học viên" trước, hoặc đặt Định kỳ về Tắt.'] };
  const wantOn = fields.gb_sync === undefined ? !!cur.gb_sync : fields.gb_sync;
  const toWrite = Object.assign({}, fields, { gb_sync: false });        /* write fields first with the switch off */
  if (cur.gb_sync && !wantOn) toWrite.gb_sync = false;
  const s = sb();
  let { error } = await s.from('books').update(toWrite).eq('id', bookId); if (error) return { ok: false, saved: false, problems: ['books: ' + error.message] };
  if (!wantOn) { console.log('[gb-sync] settings saved, sync OFF, book ' + bookId + ' by ' + who); return { ok: true, saved: true, sync_on: false, result: null }; }
  const p = await reconcile(bookId, { dry: true, force: true });
  if (!p.ok) { console.log('[gb-sync] settings saved but NOT switched on (problems), book ' + bookId + ' by ' + who); return { ok: false, saved: true, sync_on: false, problems: p.problems, preview: summary(p) }; }
  ({ error } = await s.from('books').update({ gb_sync: true }).eq('id', bookId)); if (error) return { ok: false, saved: true, sync_on: false, problems: ['books.gb_sync: ' + error.message] };
  const r = await reconcile(bookId, {});
  console.log('[gb-sync] switched ON and synced, book ' + bookId + ' code ' + (r.code || '?') + ' by ' + who + ' — ' + JSON.stringify(summary(r)));
  return { ok: r.ok, saved: true, sync_on: true, result: summary(r), problems: r.problems || [] };
}

module.exports = { reconcile, plan, settings, saveSettings, summary, listSynced, bookIdForChapter, suggestCapLop,
  normLevels, LEVEL_MAX,   /* gbsync-multilevel */
  submissionCounts,   /* tansinh gbsync-fix: the route re-checks student history with the same count the preview used */
  _test: { chapterUrl, slugCode, chapterFromLink, lessonEpoch, tailLetters, fmtId, mintIds, normLevel, cleanFields, normLevels, resolveCode, BOOK_TYPES, SKILLS, reqCount, CAD_MIN, CAD_MAX /* tansinh dinhky2 */ } };
