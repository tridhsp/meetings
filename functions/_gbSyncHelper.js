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
const BOOK_COLS = 'id, name, slug, level_id, gb_sync, gb_code, gb_cap_lop, gb_skill, gb_book_type, gb_stage, gb_is_interactive, gb_is_uu_tien, books_levels(name)';
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
const ROW_COLS = 'id, lesson_id, lesson_name, sort_order, chapter_id, document_links, audio_links, video_links, book_name, cap_lop, skill, book_type, stage, is_interactive, is_uu_tien, is_test, test_marked_at, test_minutes';
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
async function resolveCode(book, chapters) {
  if (book.gb_code) return { code: book.gb_code, source: 'gb_code' };
  const codes = await codesPointingAt(book, chapters.map(c => c.id));
  if (codes.size === 0) return { code: slugCode(book.slug), source: 'new' };
  if (codes.size === 1) return { code: [...codes][0], source: 'adopted' };
  return { code: null, source: 'collision', candidates: [...codes].sort() };
}
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
  return b && b.length ? String(b[0].id) : null;
}

/* ---------------------------------------------------------------- the plan: what WOULD change. Reads only. */
async function plan(bookId) {
  const book = await loadBook(bookId);
  if (!book) return { ok: false, found: false, book_id: bookId, error: 'Không tìm thấy sách Bookshelf ' + bookId, problems: ['Không tìm thấy sách Bookshelf ' + bookId] };
  const chapters = await loadChapters(book.id);
  const res = await resolveCode(book, chapters);
  const out = { ok: true, found: true, book_id: String(book.id), slug: book.slug, name: book.name, level_name: book.level_name, gb_sync: !!book.gb_sync,
    code: res.code, code_source: res.source, candidates: res.candidates || [], chapters: chapters.length,
    add: [], update: [], remove: [], keep: 0, unlinked: [], foreign: [], problems: [], book, chapters_list: chapters };
  if (!res.code) { out.ok = false; out.problems.push('Sách này đang được trỏ tới từ ' + res.candidates.length + ' mã giaobai: ' + res.candidates.join(', ') + '. Chọn một mã trong ô "Mã giaobai" rồi lưu.'); return out; }
  if (!CODE_RE.test(res.code)) out.problems.push('Mã không hợp lệ: ' + res.code);
  if (!book.gb_book_type) out.problems.push('Chưa chọn Loại. Loại quyết định tab trên baihoc và hậu tố trong id bài.');
  else if (!BOOK_TYPES.includes(book.gb_book_type)) out.problems.push('Loại không hợp lệ: ' + book.gb_book_type);
  if (book.gb_skill && !SKILLS.includes(book.gb_skill)) out.problems.push('Kỹ năng không hợp lệ: ' + book.gb_skill);
  if (!book.gb_cap_lop && ['main', 'homework', 'short'].includes(book.gb_book_type)) out.problems.push('Loại ' + book.gb_book_type + ' cần Cấp lớp: baihoc hiện sách này cho CẢ cấp lớp.');
  if (!chapters.length) out.problems.push('Sách chưa có chương nào.');

  const rows = await rowsForCode(res.code);
  const chapterSet = new Set(chapters.map(c => c.id));
  const byChapter = new Map(); const unlinkedRows = [];
  for (const r of rows) {
    let cid = r.chapter_id ? String(r.chapter_id) : null;
    if (!cid) { for (const l of (r.document_links || [])) { const c = chapterFromLink(l, book.slug, book.id); if (c && chapterSet.has(c)) { cid = c; r._adopt = c; break; } } }
    if (!cid) { unlinkedRows.push(r); out.unlinked.push({ lesson_id: r.lesson_id, lesson_name: r.lesson_name }); continue; }
    if (!chapterSet.has(cid)) { out.remove.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: r.lesson_name, chapter_id: cid }); continue; }
    if (byChapter.has(cid)) { out.problems.push('Hai bài cùng trỏ tới một chương: ' + byChapter.get(cid).lesson_id + ' và ' + r.lesson_id + '. Xoá một bài trong giaobai.html trước.'); continue; }
    byChapter.set(cid, r);
  }
  if (out.remove.length) {   /* a "gone" chapter may really be another book's chapter: never delete those */
    const { data, error } = await sb().from('books_chapters').select('id, book_id').in('id', out.remove.map(x => x.chapter_id));
    if (error) throw new Error('books_chapters: ' + error.message);
    const foreignIds = new Set((data || []).filter(c => String(c.book_id) !== String(book.id)).map(c => String(c.id)));
    if (foreignIds.size) {
      out.foreign = out.remove.filter(x => foreignIds.has(x.chapter_id)); out.remove = out.remove.filter(x => !foreignIds.has(x.chapter_id));
      out.problems.push('Mã ' + res.code + ' cũng chứa ' + out.foreign.length + ' bài thuộc một sách Bookshelf KHÁC. Tách chúng ra trong giaobai.html, hoặc chọn mã khác.');
    }
  }
  const meta = { book_name: book.name, cap_lop: book.gb_cap_lop || null, skill: book.gb_skill || null, book_type: book.gb_book_type || null,
    stage: (book.gb_stage === null || book.gb_stage === undefined ? null : Number(book.gb_stage)), is_interactive: !!book.gb_is_interactive, is_uu_tien: !!book.gb_is_uu_tien };
  out.meta = meta;
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
    if (Object.keys(diff).length) out.update.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: c.name, diff }); else out.keep++;
  });
  for (const r of unlinkedRows) {   /* metadata only — never their name, links or order */
    const diff = {}; for (const k of Object.keys(meta)) { if (norm(r[k]) !== norm(meta[k])) diff[k] = meta[k]; }
    if (Object.keys(diff).length) out.update.push({ id: r.id, lesson_id: r.lesson_id, lesson_name: r.lesson_name, diff, unlinked: true });
  }
  if (fresh.length) {
    const ids = mintIds(rows, fresh.length, meta.book_type);
    if (ids.length < fresh.length) out.problems.push('Không tạo đủ id mới cho ' + fresh.length + ' chương.');
    fresh.forEach((f, i) => { if (!ids[i]) return; out.add.push({ lesson_id: ids[i], chapter_id: f.chapter.id, lesson_name: f.chapter.name,
      row: Object.assign({ book_code: res.code, lesson_id: ids[i], audio_links: mediaLinks(f.chapter.audio_url), video_links: mediaLinks(f.chapter.video_url), /* GBSYNCMEDIA-20261005 */
        document_links: [chapterUrl(book.slug, f.chapter.id)], inserted_by: null }, f.want) }); });
  }
  if (out.problems.length) out.ok = false;
  return out;
}
function summary(p) {
  return { code: p.code || null, source: p.code_source || null, chapters: p.chapters || 0, add: (p.add || []).length, update: (p.update || []).length, remove: (p.remove || []).length,
    keep: p.keep || 0, unlinked: (p.unlinked || []).length, foreign: (p.foreign || []).length, problems: p.problems || [], written: !!p.written, at: new Date().toISOString() };
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
  try { p = await plan(bookId); } catch (e) { if (!dry) await saveState(bookId, null, 'plan: ' + e.message, null); return { ok: false, book_id: bookId, error: 'plan: ' + e.message, problems: ['plan: ' + e.message] }; }
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
    if (p.add.length) {
      const { error } = await s.from('lessons').insert(p.add.map(a => a.row));
      if (error && String(error.code) === '23505') {
        console.log('[gb-sync] lost the race on ' + bookId + ' (' + p.code + '): ' + p.add.length + ' lesson(s) already added by another writer; skipping');
        p.lost_race = true; p.add = [];
      }
      else if (error) errs.push('insert ' + p.add.length + ' lesson(s): ' + error.message);
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
async function settings(bookId, caps) {
  const p = await reconcile(bookId, { dry: true, force: true });
  if (!p.found) return { ok: false, error: p.error };
  const { data: st } = await sb().from('gb_sync_state').select('code, last_sync, last_error, last_result').eq('book_id', bookId).maybeSingle();
  const b = p.book;
  return { ok: true, book: { id: String(b.id), name: b.name, slug: b.slug, level_name: b.level_name },
    fields: { gb_sync: !!b.gb_sync, gb_code: b.gb_code || null, gb_cap_lop: b.gb_cap_lop || null, gb_skill: b.gb_skill || null, gb_book_type: b.gb_book_type || null,
      gb_stage: (b.gb_stage === null || b.gb_stage === undefined) ? null : Number(b.gb_stage), gb_is_interactive: !!b.gb_is_interactive, gb_is_uu_tien: !!b.gb_is_uu_tien },
    suggest_cap_lop: suggestCapLop(b.level_name, caps), state: st || null,
    preview: { ok: p.ok, code: p.code, code_source: p.code_source, candidates: p.candidates, chapters: p.chapters, add: p.add.length, update: p.update.length, remove: p.remove.length,
      keep: p.keep, unlinked: p.unlinked, foreign: p.foreign, problems: p.problems, new_ids_example: p.add.length ? p.add[0].lesson_id : null } };
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
  return { fields: f, errors: errs };
}
/* save the six fields and the switch; when the switch is ON run the sync at once. A book with
   problems is saved with the switch OFF, and the problems are returned, so a half-set book never syncs. */
async function saveSettings(bookId, body, who) {
  const { fields, errors } = cleanFields(body || {});
  if (errors.length) return { ok: false, saved: false, problems: errors };
  const cur = await loadBook(bookId); if (!cur) return { ok: false, saved: false, problems: ['Không tìm thấy sách'] };
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
  _test: { chapterUrl, slugCode, chapterFromLink, lessonEpoch, tailLetters, fmtId, mintIds, normLevel, cleanFields, BOOK_TYPES, SKILLS } };
