'use strict';
/* _kbCascadeHelper.js — knowledge.tansinh.info — tansinh kb-cascade v1 (2 Nov 2026)

   What a PERMANENT delete of a knowledge piece takes with it, and in what order.
   Required by kb-permanent-delete.knowledge.js. NOT a route: the leading underscore keeps
   server.js from loading it, and the capital H is what makes git-push-site.sh collect it
   (its glob is _*Helper.js).

   plan(client, {id, force})      reads, decides, CHANGES NOTHING
   execute(client, plan, {who})   the writes, in this order:
        1. the knowledge rows             (a failure here stops everything, nothing else is touched)
        2. their rows in knowledge_versions
        3. the @-mention links to them in OTHER pieces -> plain text, after saving a version
           of each piece that is edited, so the edit can be undone from the app's history
        4. their pictures on R2 -- only keys that kb-presign-wasabi made (pasted_..., bucket root),
           only when NO other piece or version still shows the same picture. Best-effort: the
           bucket has a lock rule, so a refusal is counted and reported, never thrown.
   run(client, {id, force, dryrun, who})  plan, then execute unless dryrun. Returns
        {status, body, changed} for the route to send.

   Measured on 2 Nov 2026: 60 pieces, 339 versions, 238 picture URLs (5 shared by two pieces),
   14 mention links. All of that is read in one pass each; at ten times the size it still is.   */

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const VERSIONS_TABLE   = 'knowledge_versions';
const DELETE_PICTURES  = true;    // false: never touch R2, only report what would go
const UNLINK_MENTIONS  = true;    // false: leave the dead links in the other pieces
const PICTURE_KEY_RE   = /^pasted_\d{8}_\d{2}:\d{2}:\d{2}\.[A-Za-z0-9]{1,8}$/;   // exactly what kb-presign-wasabi makes
const PAGE             = 500;     // rows per read, under PostgREST's 1000 cap
const IN_CHUNK         = 100;     // ids per .in() filter

/* ---------- small pure helpers (also used by the tests) ---------- */

function cdnHost() {
  const raw = String(process.env.R2_PUBLIC_BUCKET_URL_IMPORTANTFILES || '').trim();
  if (!raw) return null;
  try { return new URL(raw.startsWith('http') ? raw : 'https://' + raw).host.toLowerCase(); }
  catch (e) { return null; }
}

/* every picture in a piece's text that lives on our CDN host, as an R2 object key */
function pictureKeysIn(details, host) {
  const out = new Set();
  if (!details || !host) return out;
  const re = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(details))) {
    let u;
    try { u = new URL(m[1]); } catch (e) { continue; }
    if (u.host.toLowerCase() !== host) continue;
    let key = u.pathname.replace(/^\/+/, '');
    try { key = decodeURIComponent(key); } catch (e) { /* keep the raw path */ }
    if (key) out.add(key);
  }
  return out;
}

/* turn <a ... data-mention-id="X" ...>@Title</a> into @Title when X is being deleted */
function unlinkMentions(details, targetIds) {
  let count = 0;
  const out = String(details || '').replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (tag) => {
    const m = /\bdata-mention-id=["']([^"']+)["']/i.exec(tag);
    if (!m || !targetIds.has(String(m[1]))) return tag;
    count++;
    return tag.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '');
  });
  return { details: out, count };
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchAll(client, table, columns, shape) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from(table).select(columns).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (shape) q = shape(q);
    const { data, error } = await q;
    if (error) throw new Error('reading ' + table + ': ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/* the same client shape as kb-presign-wasabi, so the same keys reach the same bucket */
function makeS3() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME_IMPORTANTFILES;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  const s3 = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { s3, bucket };
}

/* ---------- plan: read everything once, decide, change nothing ---------- */

async function plan(client, opts) {
  const id = String(opts.id || '');
  const all = id === 'all-trash';
  const host = cdnHost();
  const pieces = await fetchAll(client, 'knowledge', 'id, title, details, trashed_at');
  const versions = await fetchAll(client, VERSIONS_TABLE, 'id, record_id, details');

  const targets = all ? pieces.filter(p => p.trashed_at) : pieces.filter(p => String(p.id) === id);
  if (!all && targets.length === 0) return { empty: true, reason: 'not-found' };
  if (!all && !targets[0].trashed_at && !opts.force) return { empty: true, reason: 'not-in-trash', title: targets[0].title };

  const targetIds = new Set(targets.map(p => String(p.id)));
  const remaining = pieces.filter(p => !targetIds.has(String(p.id)));
  const targetVersions = versions.filter(v => targetIds.has(String(v.record_id)));
  const otherVersions = versions.filter(v => !targetIds.has(String(v.record_id)));

  /* pictures: candidates = shown by a target or one of its versions; kept if anything else shows them */
  const candidates = new Set();
  for (const p of targets) for (const k of pictureKeysIn(p.details, host)) candidates.add(k);
  for (const v of targetVersions) for (const k of pictureKeysIn(v.details, host)) candidates.add(k);
  const usedElsewhere = new Set();
  for (const p of remaining) for (const k of pictureKeysIn(p.details, host)) usedElsewhere.add(k);
  for (const v of otherVersions) for (const k of pictureKeysIn(v.details, host)) usedElsewhere.add(k);
  const pictures = { deletable: [], keptShared: [], keptUnexpectedName: [] };
  for (const k of candidates) {
    if (usedElsewhere.has(k)) pictures.keptShared.push(k);
    else if (!PICTURE_KEY_RE.test(k)) pictures.keptUnexpectedName.push(k);
    else pictures.deletable.push(k);
  }

  /* mentions: which remaining pieces link to a target, and what their text becomes */
  const mentions = [];
  for (const p of remaining) {
    const r = unlinkMentions(p.details, targetIds);
    if (r.count) mentions.push({ id: p.id, title: p.title, links: r.count, oldDetails: p.details, newDetails: r.details });
  }

  return {
    all, host, targetIds: [...targetIds],
    targets: targets.map(p => ({ id: p.id, title: p.title, trashed_at: p.trashed_at })),
    versionsToDelete: targetVersions.length,
    pictures, mentions,
    countsBefore: { pieces: pieces.length, versions: versions.length },
  };
}

/* the plan without the big text fields, for the response and the dry run */
function summarize(p) {
  return {
    all: p.all,
    pieces: p.targets,
    versions: p.versionsToDelete,
    mentions: p.mentions.map(m => ({ id: m.id, title: m.title, links: m.links })),
    pictures: { deletable: p.pictures.deletable, keptShared: p.pictures.keptShared, keptUnexpectedName: p.pictures.keptUnexpectedName },
    picturesPossible: !!(p.host && DELETE_PICTURES && makeS3()),
  };
}

/* ---------- execute: the writes ---------- */

async function execute(client, p, opts) {
  const out = {
    deleted: 0, versionsDeleted: 0,
    mentions: { pieces: 0, links: 0, failed: 0 },
    pictures: { candidates: p.pictures.deletable.length + p.pictures.keptShared.length + p.pictures.keptUnexpectedName.length,
                deleted: 0, keptShared: p.pictures.keptShared.length, keptUnexpectedName: p.pictures.keptUnexpectedName.length,
                refused: 0, failed: 0, skipped: 0, deletedKeys: [], refusedKeys: [] },
    warnings: [],
  };

  /* 1. the rows. A failure here means nothing else is touched. */
  for (const chunk of chunks(p.targetIds, IN_CHUNK)) {
    let q = client.from('knowledge').delete().in('id', chunk);
    if (p.all) q = q.not('trashed_at', 'is', null);      // a piece restored since the plan was read stays
    const { data, error } = await q.select('id');
    if (error) return { fatal: 'deleting knowledge rows: ' + error.message, out };
    out.deleted += (data || []).length;
  }

  /* 2. their versions */
  for (const chunk of chunks(p.targetIds, IN_CHUNK)) {
    const { data, error } = await client.from(VERSIONS_TABLE).delete().in('record_id', chunk).select('id');
    if (error) { out.warnings.push('versions: ' + error.message); break; }
    out.versionsDeleted += (data || []).length;
  }

  /* 3. the links in other pieces, each edit preceded by a saved version */
  if (!UNLINK_MENTIONS) { if (p.mentions.length) out.warnings.push('mentions: unlinking is switched off'); }
  else for (const m of p.mentions) {
    try {
      const { error: e1 } = await client.from(VERSIONS_TABLE)
        .insert({ record_id: m.id, title: m.title, details: m.oldDetails, created_at: new Date().toISOString() });
      if (e1) throw new Error('saving a version of "' + m.title + '": ' + e1.message);
      const { error: e2 } = await client.from('knowledge').update({ details: m.newDetails }).eq('id', m.id);
      if (e2) throw new Error('unlinking in "' + m.title + '": ' + e2.message);
      out.mentions.pieces++; out.mentions.links += m.links;
    } catch (e) { out.mentions.failed++; out.warnings.push(e.message); }
  }

  /* 4. the pictures, best-effort */
  const s3 = DELETE_PICTURES ? makeS3() : null;
  if (!p.pictures.deletable.length) { /* nothing to do */ }
  else if (!DELETE_PICTURES) { out.pictures.skipped = p.pictures.deletable.length; out.warnings.push('pictures: deletion is switched off in the helper'); }
  else if (!p.host || !s3) { out.pictures.skipped = p.pictures.deletable.length; out.warnings.push('pictures: R2 settings missing in .env, nothing deleted'); }
  else for (const key of p.pictures.deletable) {
    try {
      await s3.s3.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
      out.pictures.deleted++; out.pictures.deletedKeys.push(key);
    } catch (e) {
      const code = String((e && (e.Code || e.name)) || '');
      const http = e && e.$metadata && e.$metadata.httpStatusCode;
      if (http === 409 || /lock/i.test(code)) { out.pictures.refused++; out.pictures.refusedKeys.push(key); }
      else { out.pictures.failed++; out.warnings.push('picture ' + key + ': ' + (code || (e && e.message) || 'error')); }
    }
  }
  if (out.pictures.refused) out.warnings.push('pictures: ' + out.pictures.refused + ' refused by the bucket lock (kept on R2, harmless)');

  const log = opts.log || console.log;
  log('[kb-permanent-delete] ' + (opts.who || '?') + ' removed ' + out.deleted + ' piece(s) (' + (p.all ? 'all-trash' : p.targetIds[0]) + ')'
    + ': versions ' + out.versionsDeleted + ', mention links ' + out.mentions.links + ' in ' + out.mentions.pieces + ' piece(s)'
    + ', pictures deleted ' + out.pictures.deleted + ' kept-shared ' + out.pictures.keptShared + ' refused ' + out.pictures.refused
    + ' failed ' + out.pictures.failed + (out.warnings.length ? ' | warnings: ' + out.warnings.length : ''));
  return { out };
}

/* ---------- run: what the route calls ---------- */

async function run(client, opts) {
  const p = await plan(client, opts);
  if (p.empty && p.reason === 'not-found') return { status: 404, body: { error: 'Not found' }, changed: false };
  if (p.empty && p.reason === 'not-in-trash') {
    return { status: 409, body: { error: 'This piece is not in the trash. Move it to the trash first (or send force:true).', title: p.title }, changed: false };
  }
  const summary = summarize(p);
  if (opts.dryrun) return { status: 200, body: { success: true, dryrun: true, plan: summary }, changed: false };
  if (!p.targetIds.length) return { status: 200, body: { success: true, deleted: 0, plan: summary }, changed: false };
  const r = await execute(client, p, opts);
  if (r.fatal) return { status: 500, body: { error: r.fatal, partial: r.out }, changed: r.out.deleted > 0 };
  return { status: 200, body: Object.assign({ success: true }, r.out, { plan: summary }), changed: true };
}

module.exports = { run, plan, execute, summarize, pictureKeysIn, unlinkMentions, cdnHost, PICTURE_KEY_RE, VERSIONS_TABLE };
