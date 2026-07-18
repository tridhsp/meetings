// _roundRobinHelper.js — v6: Stage-gating + Maximum interleaving rotation
// Phase 1: Students locked into lowest stage. Higher-stage books promote only to fill skill gaps.
// Phase 2: Turn order uses "most remaining" algorithm — never same type back-to-back.

const { createClient } = require('@supabase/supabase-js');
const { pickActiveThcsBook } = require('./_thcsAutoBook');

function getSB() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_ROLE
  );
}

// ── THCS/THPT auto-rotation rollout gate ──
// While testing, only these students get a THCS book woven into the rotation.
// To enable for everyone later, just make thcsAutoEnabledFor() return true.
const THCS_AUTO_TEST_EMAILS = new Set(['sample2@tansinh.info']);
function thcsAutoEnabledFor(email) {
  return THCS_AUTO_TEST_EMAILS.has(String(email || '').trim().toLowerCase());
}

// Append the ONE active THCS book to an existing (non-empty) rotation pool.
// Safe by design: only runs for enabled emails, and only when the student already
// has an active multi-book pool (so a stage-0-only student is never affected).
async function appendThcsAutoBook(sb, email, pool) {
  if (!thcsAutoEnabledFor(email)) return pool;
  if (!Array.isArray(pool) || pool.length === 0) return pool; // never turn rotation ON just for THCS
  try {
    const { data: hv } = await sb
      .from('danh_sach_hv')
      .select('lop_thcs_thpt_dang_hoc')
      .ilike('email', email)
      .maybeSingle();
    const thcsClass = hv && hv.lop_thcs_thpt_dang_hoc;
    if (!thcsClass) return pool;

    const book = await pickActiveThcsBook(sb, email, thcsClass);
    if (!book) return pool;
    if (pool.some(b => b.book_code === book.book_code)) return pool; // already present (e.g. assigned)

    pool.push({
      book_code: book.book_code,
      book_name: book.book_name,
      book_type: book.book_type,
      stage: book.stage,
      skill: book.skill,
      total_lessons: book.total_lessons,
      completed_lessons: book.completed_lessons,
      is_interactive: false,
      is_uu_tien: false,
      is_paused: false,
      is_assigned: true,   // lets it pass participation checks if ever re-filtered
      _thcsAuto: true      // tag → bookSource() gives it its own lane
    });
    console.log('[RR][THCS] wove THCS book ' + book.book_code + ' into pool for ' + email);
  } catch (e) {
    console.error('[RR][THCS] inject error:', e.message);
  }
  return pool;
}

const TYPE_TO_SOURCE = {
  main:     'bai_hoc',
  homework: 'bai_hoc_homework',
  short:    'bai_hoc_shorts',
  shorts:   'bai_hoc_shorts',
  special:  'bai_hoc_dac_biet',
  legacy:   'legacy_lesson'
};

const MAIN = 'bai_hoc';

// ────────────────────────────────────────────────
//  Fetch student books from local giaobai API
// ────────────────────────────────────────────────
async function fetchStudentBooks(email, retries = 2) {
  const port = process.env.PORT || 3111;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(
        `http://localhost:${port}/gb-list-student-books?email=${encodeURIComponent(email)}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return {
        lessons: json.lessons || [],
        capLopHoc: (json.student && json.student.cap_lop_hoc) || null
      };
    } catch (err) {
      console.error(`[RR] fetchStudentBooks error (attempt ${attempt + 1}):`, err.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, 500));
      else return { lessons: [], capLopHoc: null };
    }
  }
  return { lessons: [], capLopHoc: null };
}

// ────────────────────────────────────────────────
//  Book → source type mapping
// ────────────────────────────────────────────────
function bookSource(b) {
  if (b && b._thcsAuto) return 'bai_hoc_thcs_auto'; // THCS auto-rotation lane (its own type)
  const etype = (b.effective_type || b.book_type || '').toLowerCase();
  if (etype === 'extra' || (b.assigned_as || '').toLowerCase() === 'extra') return null; // Extra = standalone track, never in rotation
  return TYPE_TO_SOURCE[etype] || TYPE_TO_SOURCE[(b.book_type || '').toLowerCase()] || null;
}

// ────────────────────────────────────────────────
//  Fetch exclusions + delays
// ────────────────────────────────────────────────
async function fetchFilters(sb, email) {
  const [exclRes, delayRes] = await Promise.all([
    sb.from('lessons_exclusions_used_for_books').select('book_code').eq('student_email', email),
    sb.from('lessons_book_delays').select('book_code, delay_until').eq('student_email', email)
  ]);

  const excludedBookCodes = new Set(((exclRes.data) || []).map(r => r.book_code));
  const now = new Date();
  const delayedBookCodes = new Set(
    ((delayRes.data) || [])
      .filter(r => r.book_code && r.delay_until && new Date(r.delay_until) > now)
      .map(r => r.book_code)
  );

  if (exclRes.error) console.error('[RR] exclusions fetch error:', exclRes.error.message);
  if (delayRes.error) console.error('[RR] delays fetch error:', delayRes.error.message);

  return { excludedBookCodes, delayedBookCodes };
}

// ────────────────────────────────────────────────
//  Check if a book can participate in round-robin
// ────────────────────────────────────────────────
function isParticipatable(b, excludedBookCodes, delayedBookCodes) {
  const src = bookSource(b);

  // Special books are standalone catalog items: a student only "has" a special
  // book if it was explicitly assigned (lessons_assigned). Special books that are
  // only present via the student's cap_lop (is_assigned=false, no assigned_as) must
  // NOT drive the round-robin rotation, because lessons-next serves special lessons
  // strictly from the assigned set — including them produces phantom "Chặng X/Y"
  // turns that resolve to no servable lesson.
  if (src === 'bai_hoc_dac_biet') {
    const isAssigned = b.is_assigned === true ||
      (typeof b.assigned_as === 'string' && b.assigned_as.trim() !== '');
    if (!isAssigned) return false;
  }

  return !b.is_interactive &&
    !b.is_uu_tien &&
    !b.is_paused &&
    !excludedBookCodes.has(b.book_code) &&
    !delayedBookCodes.has(b.book_code) &&
    src !== null; // must have a valid type (main/homework/short/special)
}

function hasRemaining(b) {
  return (b.total_lessons || 0) > (b.completed_lessons || 0);
}

// ────────────────────────────────────────────────
//  Fetch skill per book_code from lessons table
// ────────────────────────────────────────────────
async function fetchBookSkills(sb, bookCodes) {
  if (!bookCodes.length) return {};
  const { data } = await sb
    .from('lessons')
    .select('book_code, skill')
    .in('book_code', bookCodes);

  const map = {}; // book_code → skill (first non-null)
  for (const r of (data || [])) {
    if (r.book_code && r.skill && !map[r.book_code]) {
      map[r.book_code] = r.skill;
    }
  }
  return map;
}


// ════════════════════════════════════════════════
//  PHASE 1: Stage-Gating with Skill Coverage
// ════════════════════════════════════════════════

async function getStageGatedPool(email) {
  const sb = getSB();
  const { lessons: allBooks } = await fetchStudentBooks(email);
  const { excludedBookCodes, delayedBookCodes } = await fetchFilters(sb, email);

  // Books that CAN participate in round-robin (valid type, not paused/excluded/delayed)
  const participatable = allBooks.filter(b => isParticipatable(b, excludedBookCodes, delayedBookCodes));

  // Stage 0 = always independent, never gated
  const stage0 = participatable.filter(b => (parseFloat(b.stage) || 0) === 0);

  // Non-stage-0 books
  const nonStage0 = participatable.filter(b => (parseFloat(b.stage) || 0) > 0);

  if (nonStage0.length === 0) {
    return { activePool: [], stage0Books: stage0, sb };
  }

  // Fetch skills for all non-stage-0 book_codes
  const allCodes = nonStage0.map(b => b.book_code);
  const skillMap = await fetchBookSkills(sb, allCodes);

  // Attach _skill to each book
  for (const b of nonStage0) b._skill = skillMap[b.book_code] || null;

  // Find the lowest stage (usually 1)
  const stages = [...new Set(nonStage0.map(b => parseFloat(b.stage) || 0))].sort((a, b) => a - b);
  const baseStage = stages[0];

  // ALL books at base stage (including fully completed ones — for skill tracking)
  const baseStageAll = nonStage0.filter(b => (parseFloat(b.stage) || 0) === baseStage);

  // Active = base stage + has remaining lessons
  const baseStageActive = baseStageAll.filter(hasRemaining);

  // Skills that base stage SHOULD cover (from ALL base-stage books, including completed)
  const baseSkills = new Set(baseStageAll.map(b => b._skill).filter(Boolean));

  // Skills currently covered by active base-stage books
  const coveredSkills = new Set(baseStageActive.map(b => b._skill).filter(Boolean));

  // Missing skills: were in base stage but no active base-stage book has them
  const missingSkills = [...baseSkills].filter(s => !coveredSkills.has(s));

  // Build active pool starting with base-stage active books
  const activePool = [...baseStageActive];
  const usedCodes = new Set(activePool.map(b => b.book_code));

  // For each missing skill, promote the lowest-stage available book from higher stages
  for (const skill of missingSkills) {
    const candidates = nonStage0
      .filter(b =>
        (parseFloat(b.stage) || 0) > baseStage &&
        b._skill === skill &&
        hasRemaining(b) &&
        !usedCodes.has(b.book_code)
      )
      .sort((a, b) => (parseFloat(a.stage) || 0) - (parseFloat(b.stage) || 0));

    if (candidates.length > 0) {
      activePool.push(candidates[0]);
      usedCodes.add(candidates[0].book_code);
      console.log(`[RR] Promoted stage ${candidates[0].stage} book "${candidates[0].book_name}" to fill ${skill} skill gap`);
    }
  }

  // -- Type-coverage promotion (cross-stage) --
  // If the current (base) stage has no usable book of a rotation type, pull the
  // LOWEST-stage participatable book of that type from a higher stage, so the
  // rotation always has a Main, a Short, and a Homework turn when one exists.
  // Base-stage books with lessons left are already in activePool/usedCodes, so a
  // type only gets pulled up once the base stage has truly run OUT of that type.
  const ROTATION_TYPES = ['bai_hoc', 'bai_hoc_homework', 'bai_hoc_shorts'];
  const typesInPool = new Set(activePool.map(b => bookSource(b)).filter(Boolean));
  for (const wantType of ROTATION_TYPES) {
    if (typesInPool.has(wantType)) continue;
    const candidates = nonStage0
      .filter(b => bookSource(b) === wantType && hasRemaining(b) && !usedCodes.has(b.book_code))
      .sort((a, b) => (parseFloat(a.stage) || 0) - (parseFloat(b.stage) || 0));
    if (candidates.length > 0) {
      activePool.push(candidates[0]);
      usedCodes.add(candidates[0].book_code);
      typesInPool.add(wantType);
      console.log(`[RR] Type-coverage: promoted stage ${candidates[0].stage} ${wantType} book "${candidates[0].book_name}"`);
    }
  }
  return { activePool: await appendThcsAutoBook(sb, email, activePool), stage0Books: stage0, sb };
}


// ════════════════════════════════════════════════
//  PHASE 2: Maximum Interleaving Rotation
// ════════════════════════════════════════════════

/**
 * Compute the turn sequence for one trip.
 *
 * Rules:
 *  1. Always start with Main (if Main books exist)
 *  2. Never same type back-to-back: each turn picks a DIFFERENT type from the previous
 *  3. Among candidates, pick the type with the most remaining turns (natural interleaving)
 *  4. Tie-break: prefer type with more total books
 *  5. If only one type has remaining turns, allow consecutive (unavoidable)
 *  6. Soft: if last turn is Main, try safe swap to avoid 2 consecutive across trip boundary
 */
function computeWeightedSequence(activeBooks) {
  // Group by source type
  const byType = {};
  for (const b of activeBooks) {
    const src = bookSource(b);
    if (!src) continue;
    if (!byType[src]) byType[src] = [];
    byType[src].push(b);
  }

  const types = Object.keys(byType);
  if (types.length === 0) return [];

  const totalByType = {};
  for (const t of types) totalByType[t] = byType[t].length;

  const totalTurns = Object.values(totalByType).reduce((a, b) => a + b, 0);

  // Only 1 type → no interleaving possible
  if (types.length === 1) return Array(totalTurns).fill(types[0]);

  const usedByType = {};
  for (const t of types) usedByType[t] = 0;

  const sequence = [];

  for (let turn = 0; turn < totalTurns; turn++) {
    let pick = null;
    const lastType = sequence.length > 0 ? sequence[sequence.length - 1] : null;

    // Rule 1: always start with Main (if Main books exist)
    if (turn === 0 && totalByType[MAIN] > 0) {
      pick = MAIN;
    } else {
      // Pick a DIFFERENT type from the previous turn, with the most remaining turns.
      // This naturally interleaves: majority types fill gaps, minority types spread out.
      const candidates = types.filter(t => t !== lastType && usedByType[t] < totalByType[t]);

      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          const remA = totalByType[a] - usedByType[a];
          const remB = totalByType[b] - usedByType[b];
          if (remA !== remB) return remB - remA; // most remaining first
          return totalByType[b] - totalByType[a]; // tie-break: more total books
        });
        pick = candidates[0];
      } else {
        // Only one type has remaining turns — allow consecutive (unavoidable)
        const remaining = types.filter(t => usedByType[t] < totalByType[t]);
        if (remaining.length > 0) pick = remaining[0];
      }
    }

    if (!pick) break;
    sequence.push(pick);
    usedByType[pick]++;
  }

  // Soft Rule 5: if last turn is Main, try to swap with an earlier non-Main
  // to avoid 2 consecutive Mains across trip boundary (first turn is always Main).
  // Only swap if it doesn't create any back-to-back pair.
  if (sequence.length >= 3 && sequence[sequence.length - 1] === MAIN) {
    for (let i = sequence.length - 2; i >= 1; i--) {
      if (sequence[i] === MAIN) continue;
      const candidate = [...sequence];
      candidate[i] = sequence[sequence.length - 1];
      candidate[sequence.length - 1] = sequence[i];

      // Validate: no back-to-back anywhere
      let valid = true;
      for (let j = 1; j < candidate.length; j++) {
        if (candidate[j] === candidate[j - 1]) { valid = false; break; }
      }
      if (valid) {
        for (let j = 0; j < candidate.length; j++) sequence[j] = candidate[j];
        break;
      }
    }
  }

  return sequence;
}

/**
 * Pick the type with the lowest used/total ratio.
 * Tie-break: prefer type with more total books.
 * Returns null if all types are fully used.
 */
function pickLowestRatio(types, usedByType, totalByType) {
  let bestRatio = Infinity;
  let bestType = null;

  for (const t of types) {
    const total = totalByType[t] || 0;
    if (total === 0) continue;
    const used = usedByType[t] || 0;
    if (used >= total) continue; // fully used

    const ratio = used / total;
    if (ratio < bestRatio ||
        (ratio === bestRatio && total > (totalByType[bestType] || 0))) {
      bestRatio = ratio;
      bestType = t;
    }
  }

  return bestType;
}

/**
 * Check if stored sequence matches current pool composition.
 * If type counts differ, the sequence is stale and must be recomputed.
 */
function isSequenceStale(sequence, activeBooks) {
  if (!sequence || !Array.isArray(sequence) || sequence.length === 0) return true;

  const seqCounts = {};
  for (const t of sequence) seqCounts[t] = (seqCounts[t] || 0) + 1;

  const poolCounts = {};
  for (const b of activeBooks) {
    const src = bookSource(b);
    if (src) poolCounts[src] = (poolCounts[src] || 0) + 1;
  }

  const allTypes = new Set([...Object.keys(seqCounts), ...Object.keys(poolCounts)]);
  for (const t of allTypes) {
    if ((seqCounts[t] || 0) !== (poolCounts[t] || 0)) return true;
  }
  return false;
}


// ════════════════════════════════════════════════
//  getRoundRobinStatus
// ════════════════════════════════════════════════

async function getRoundRobinStatus(email) {
  const { activePool, stage0Books, sb } = await getStageGatedPool(email);

  // Activate round-robin for 1+ book (single-book students get a 1-turn trip
  // and a "Chặng 1/1" stage card). Only bail out when there are zero servable books.
  if (activePool.length < 1) {
    const codes = activePool.map(b => b.book_code);
    const srcs = new Set(activePool.map(b => bookSource(b)).filter(Boolean));
    srcs.add('bai_hoc_tuong_tac');
    return {
      roundRobinActive: false,
      allowedSources: [...srcs],
      allowedBookCodes: codes,
      nextType: null,
      sequence: null,
      currentTurn: null,
      totalTurns: 0,
      totalBooks: activePool.length
    };
  }

  // ── Load or create trip ──
  const { data: tripRow } = await sb
    .from('book_round_robin_trips')
    .select('*')
    .eq('student_email', email)
    .maybeSingle();

  let sequence = tripRow?.sequence || null;
  let currentTurn = tripRow?.current_turn || 0;

  // If no trip or sequence is stale (pool changed), recompute
  if (!tripRow || isSequenceStale(sequence, activePool)) {
    sequence = computeWeightedSequence(activePool);
    currentTurn = 0;

    // Clear old covered-books tracking
    await sb.from('book_round_robin').delete().eq('student_email', email);

    // Save new trip
    await sb.from('book_round_robin_trips').upsert(
      { student_email: email, sequence, current_turn: 0 },
      { onConflict: 'student_email' }
    );

    console.log(`[RR] New trip for ${email}: ${sequence.join(' → ')} (${sequence.length} turns)`);
  }

  // Handle overflow (shouldn't normally happen)
  if (currentTurn >= sequence.length) {
    await sb.from('book_round_robin').delete().eq('student_email', email);
    sequence = computeWeightedSequence(activePool);
    currentTurn = 0;
    await sb.from('book_round_robin_trips').upsert(
      { student_email: email, sequence, current_turn: 0 },
      { onConflict: 'student_email' }
    );
    console.log(`[RR] Trip overflow reset for ${email}: ${sequence.join(' → ')}`);
  }

  // ── Determine next type and allowed books ──
  const { data: coveredRows } = await sb
    .from('book_round_robin')
    .select('book_code, covered_at')
    .eq('student_email', email)
    .order('covered_at', { ascending: true });

  const coveredSet = new Set((coveredRows || []).map(r => r.book_code));

  // Try the current turn's type. If no uncovered books, advance turns.
  let resolvedTurn = currentTurn;
  let nextType = sequence[resolvedTurn] || null;
  let allowedBookCodes = [];

  while (resolvedTurn < sequence.length) {
    nextType = sequence[resolvedTurn];
    allowedBookCodes = activePool
      .filter(b => bookSource(b) === nextType && !coveredSet.has(b.book_code))
      .map(b => b.book_code);

    if (allowedBookCodes.length > 0) break;

    // No uncovered books for this type (edge case: mid-trip change)
    resolvedTurn++;
  }

  // If we advanced, update DB
  if (resolvedTurn !== currentTurn && resolvedTurn < sequence.length) {
    currentTurn = resolvedTurn;
    await sb.from('book_round_robin_trips')
      .update({ current_turn: currentTurn })
      .eq('student_email', email);
  }

  // If ALL turns exhausted, reset trip
  if (resolvedTurn >= sequence.length || allowedBookCodes.length === 0) {
    await sb.from('book_round_robin').delete().eq('student_email', email);
    sequence = computeWeightedSequence(activePool);
    currentTurn = 0;
    await sb.from('book_round_robin_trips').upsert(
      { student_email: email, sequence, current_turn: 0 },
      { onConflict: 'student_email' }
    );

    nextType = sequence[0] || null;
    allowedBookCodes = activePool
      .filter(b => bookSource(b) === nextType)
      .map(b => b.book_code);

    console.log(`[RR] All turns exhausted, reset for ${email}: ${sequence.join(' → ')}`);
  }

  // Build response
  const allowedSources = new Set();
  if (nextType) allowedSources.add(nextType);
  allowedSources.add('bai_hoc_tuong_tac'); // interactive always allowed

  return {
    roundRobinActive: true,
    allowedSources: [...allowedSources],
    allowedBookCodes,
    nextType,
    sequence,
    currentTurn,
    totalTurns: sequence.length,
    totalBooks: activePool.length,
    completedDates: (coveredRows || []).map(r => r.covered_at).filter(Boolean)
  };
}


// ════════════════════════════════════════════════
//  markBookCovered — called after submission
// ════════════════════════════════════════════════

async function markBookCovered(email, stage, bookCode) {
  const sb = getSB();

  // -- Duplicate-safe guard (Bug-B fix): if this book is already covered
  // in the current trip, do NOT advance the turn again.
  const { data: _already } = await sb
    .from('book_round_robin')
    .select('book_code')
    .eq('student_email', email)
    .eq('book_code', bookCode)
    .maybeSingle();
  if (_already) {
    console.log(`[RR] duplicate mark ignored for ${email} / ${bookCode}`);
    return { tripComplete: false, alreadyCovered: true, nextType: null };
  }

  // 1) Mark book as covered
  const { error: upsertErr } = await sb.from('book_round_robin').upsert(
    { student_email: email, stage: Number(stage), book_code: bookCode },
    { onConflict: 'student_email,stage,book_code', ignoreDuplicates: true }
  );

  if (upsertErr) {
    console.error(`[RR] upsert FAILED: ${upsertErr.message}`);
    throw new Error('Failed to mark book covered: ' + upsertErr.message);
  }

  // 2) Advance the trip turn
  let { data: tripRow } = await sb
    .from('book_round_robin_trips')
    .select('*')
    .eq('student_email', email)
    .maybeSingle();

  if (!tripRow || !tripRow.sequence) {
    // -- Trip auto-create: submissions made outside the student page
    // (e.g. teacher page, before the student opened baihoc) must advance
    // the rotation exactly the same way as in-page submissions.
    try {
      const { activePool } = await getStageGatedPool(email);
      const sequence = computeWeightedSequence(activePool || []);
      if (!sequence.length) return { tripComplete: false, nextType: null };
      await sb.from('book_round_robin_trips').upsert(
        { student_email: email, sequence, current_turn: 0 },
        { onConflict: 'student_email' }
      );
      tripRow = { sequence, current_turn: 0 };
      console.log(`[RR] trip auto-created on mark for ${email}: ${sequence.join(' > ')}`);
    } catch (e) {
      console.warn('[RR] trip auto-create failed:', (e && e.message) || e);
      return { tripComplete: false, nextType: null };
    }
  }

  // -- Out-of-turn safety: advance only when this book's type matches the
  // current turn. Otherwise the covered row is recorded, and the status
  // logic auto-skips exhausted turns later (existing behaviour).
  let _bookType = null;
  try {
    const { data: _bRow } = await sb.from('lessons')
      .select('book_type').eq('book_code', bookCode).limit(1).maybeSingle();
    _bookType = _bRow ? (_bRow.book_type || null) : null;
  } catch (_) {}
  const _expected = tripRow.sequence[tripRow.current_turn || 0] || null;
  const _actualSrc = _bookType ? (TYPE_TO_SOURCE[_bookType] || null) : null;
  if (_expected && _actualSrc && _actualSrc !== _expected) {
    console.log(`[RR] out-of-turn mark recorded (no advance): ${email} ${bookCode} type=${_actualSrc} expected=${_expected}`);
    return { tripComplete: false, outOfTurn: true, nextType: _expected };
  }

  const newTurn = (tripRow.current_turn || 0) + 1;

  // Trip complete?
  if (newTurn >= tripRow.sequence.length) {
    // Clear covered-books + trip
    await sb.from('book_round_robin').delete().eq('student_email', email);
    await sb.from('book_round_robin_trips').delete().eq('student_email', email);
    console.log(`[RR] Trip complete for ${email} (${tripRow.sequence.length} turns)`);
    return { tripComplete: true, nextType: null };
  }

  // Advance turn counter
  await sb.from('book_round_robin_trips')
    .update({ current_turn: newTurn })
    .eq('student_email', email);

  return {
    tripComplete: false,
    nextType: tripRow.sequence[newTurn] || null,
    currentTurn: newTurn,
    totalTurns: tripRow.sequence.length
  };
}


module.exports = {
  getRoundRobinStatus,
  markBookCovered,
  getStageGatedPool,
  computeWeightedSequence,
  TYPE_TO_SOURCE
};
