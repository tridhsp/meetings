// _ringZaloHelper.js -- the ONE place that knows about Zalo identities.
//
// WHY A HELPER AND NOT A ROUTE FILE
//   Three callers need the same knowledge and must never disagree:
//     ring-api  /ring-zalo-search   name or email -> masked identities
//     ring-api  /ring-zalo-dial     (id, relation) -> the raw UID, once
//     ring-rec                      a -zin- caller UID -> a person's name
//   A second copy of the column map would drift, exactly the way mask() has
//   already drifted into two copies (ring-api line 43, ring-rec line 122).
//
// ⚠️ THE FILENAME MATTERS TWICE. server.js skips files starting with "_", so
//    this is never loaded as a route. And git-push-site.sh line 110 collects
//    "_*Helper.js" -- CAPITAL H, NO HYPHEN. A name like "_ring-zalo.helper.js"
//    would match nothing and live in no repo, exactly as _cache-helper.js and
//    _rtr-duration.helper.js still do.
//
// ⚠️ A ZALO UID IS AS PRIVATE AS A PHONE NUMBER. Nothing here masks, because
//    masking belongs to the caller (each already has mask()). uidFor() is the
//    only function that hands back a raw identifier, and it exists to be
//    called by the one route that is allowed to disclose one.
//
// ⚠️ NO USER INPUT EVER REACHES A QUERY. search() filters 257 cached rows in
//    memory, so the PostgREST .or() injection that mtx-suggest is exposed to
//    cannot happen here.

const FREE_DAYS = 30;          // ⚠️ UNVERIFIED against ZCC's own documentation.
                               //    The message desk uses a 7-day window for a
                               //    different feature. Confirm before this
                               //    number is printed as a promise.
const CACHE_MS = 5 * 60 * 1000;
const PAGE = 1000;
const MAX_PAGES = 5;

const ZALO_COLS = {
  hv:    { col: 'zalo_key',            label: 'Zalo gia đình' },
  me:    { col: 'guardian_key1_m',     label: 'Mẹ' },
  cha:   { col: 'guardian_key2_c',     label: 'Cha' },
  other: { col: 'guardian_key3_other', label: 'PH' },
};
// ⚠️ 'hv' is labelled "Zalo gia đình", NOT "Học viên". mtx-zalo-in.js gives
//    that slot a blank label. Measured 10 Sep: 257 of 257 rows have zalo_key
//    and only 69 have a mother's, so for most young learners that account is
//    the family's, not the child's. The other three labels are copied from
//    mtx-zalo-in.js line 152 verbatim so the two apps agree.

const ORDER = ['hv', 'me', 'cha', 'other'];
const SELECT = 'id, ten_hv, email, zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other';

let _cache = null;

function clean(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

// All 257 contacts, cached 5 minutes. Small enough that one read serves both
// the forward search and the reverse UID lookup.
// ⚠️ A contact added in the last 5 minutes will not appear. clearCache() is
//    exported for whatever eventually edits this table.
async function contacts(sb) {
  if (_cache && (Date.now() - _cache.at) < CACHE_MS) return _cache;
  const { data, error } = await sb.from('students_contact_info').select(SELECT).limit(2000);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length === 1000) {
    console.log('[ring-zalo] WARNING: read exactly 1000 contacts - suspect a row cap, results may be short');
  }
  const byUid = new Map();
  for (const r of rows) {
    for (const k of ORDER) {
      const v = clean(r[ZALO_COLS[k].col]);
      if (!v || byUid.has(v)) continue;
      byUid.set(v, { uid: v, key: k, label: ZALO_COLS[k].label,
                     name: clean(r.ten_hv), email: clean(r.email), id: r.id });
    }
  }
  _cache = { rows, byUid, at: Date.now() };
  return _cache;
}

function clearCache() { _cache = null; }

function identitiesOf(row) {
  const out = [];
  for (const k of ORDER) {
    const v = clean(row[ZALO_COLS[k].col]);
    if (v) out.push({ key: k, label: ZALO_COLS[k].label, uid: v });
  }
  return out;
}

// ⚠️ Searches ten_hv AND email, because 97 of the 257 rows have NO EMAIL at
//    all (measured 10 Sep). Those learners are findable by name only, and the
//    page has to say so rather than return an empty box.
async function search(sb, q, limit) {
  const needle = clean(q).toLowerCase();
  if (needle.length < 2) return [];
  const c = await contacts(sb);
  const hits = c.rows.filter(function (r) {
    return clean(r.ten_hv).toLowerCase().indexOf(needle) >= 0 ||
           clean(r.email).toLowerCase().indexOf(needle) >= 0;
  });
  hits.sort(function (a, b) { return clean(a.ten_hv).localeCompare(clean(b.ten_hv), 'vi'); });
  return hits.slice(0, limit || 15);
}

// uid -> newest inbound message inside the window.
// Returns NULL, not an empty Map, when it cannot tell. Three states:
//   a date  = inside the window
//   absent  = outside it
//   null    = unknown, and the page must say "không rõ" rather than guess.
//
// ⚠️ IT PAGES, AND IT CHECKS THAT IT REACHED THE END. A single .limit(1000)
//    would silently truncate: 45 identities at ~22 messages each in 30 days is
//    about 990 rows, right on the cap. A truncated read would report people as
//    "outside the window" who are inside it. That is the exact mistake the
//    first coverage probe made, and it is why this returns null on truncation.
async function windowFor(sb, uids) {
  const list = Array.from(new Set((uids || []).map(clean).filter(Boolean)));
  if (!list.length) return new Map();
  const since = new Date(Date.now() - FREE_DAYS * 86400000).toISOString();
  const out = new Map();
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await sb.from('zalo_messages')
      .select('sender_id, created_at')
      .in('sender_id', list)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.log('[ring-zalo] window read failed: ' + error.message); return null; }
    const rows = data || [];
    for (const r of rows) {
      const s = clean(r.sender_id);
      if (s && !out.has(s)) out.set(s, r.created_at);
    }
    if (rows.length < PAGE) return out;          // reached the end: trustworthy
    from += PAGE;
  }
  console.log('[ring-zalo] window read hit the page limit for ' + list.length + ' ids - reporting unknown');
  return null;                                    // truncated: say so
}

// A live read, deliberately not the cache: a disclosure reads current truth.
async function uidFor(sb, id, relation) {
  const spec = ZALO_COLS[relation];
  if (!spec) return null;
  const { data, error } = await sb.from('students_contact_info')
    .select('id, ten_hv, email, ' + spec.col).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const uid = clean(data[spec.col]);
  if (!uid) return null;
  return { uid: uid, key: relation, label: spec.label,
           name: clean(data.ten_hv) || '(chưa có tên)', email: clean(data.email) };
}

// Reverse: who is this UID? Used by ring-rec to name a -zin- caller.
async function whoIs(sb, uid) {
  const c = await contacts(sb);
  return c.byUid.get(clean(uid)) || null;
}

async function whoAre(sb, uids) {
  const c = await contacts(sb);
  const out = new Map();
  for (const u of (uids || [])) {
    const hit = c.byUid.get(clean(u));
    if (hit) out.set(clean(u), hit);
  }
  return out;
}

module.exports = {
  FREE_DAYS, ZALO_COLS, ORDER,
  contacts, clearCache, identitiesOf, search, windowFor, uidFor, whoIs, whoAre,
};
