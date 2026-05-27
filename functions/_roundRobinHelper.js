// _roundRobinHelper.js — Round-robin trip tracking helper (v4 — hardened)
const { createClient } = require('@supabase/supabase-js');

function getSB() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_ROLE
  );
}

const TYPE_TO_SOURCE = {
  main:    'bai_hoc',
  homework:'bai_hoc_homework',
  short:   'bai_hoc_shorts',
  shorts:  'bai_hoc_shorts',
  special: 'bai_hoc_dac_biet',
  legacy:  'legacy_lesson'
};

async function fetchStudentBooks(email, retries = 2) {
  const port = process.env.PORT || 3111;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(
        `http://localhost:${port}/gb-list-student-books?email=${encodeURIComponent(email)}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const lessons = json.lessons || [];
      if (lessons.length === 0 && attempt < retries) {
        console.warn(`[RoundRobin] fetchStudentBooks got 0 books for ${email}, retrying (${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      return {
        lessons,
        capLopHoc: (json.student && json.student.cap_lop_hoc) || null
      };
    } catch (err) {
      console.error(`[RoundRobin] fetchStudentBooks error (attempt ${attempt + 1}):`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return { lessons: [], capLopHoc: null };
    }
  }
  return { lessons: [], capLopHoc: null };
}

function bookSource(b) {
  const etype = (b.effective_type || b.book_type || '').toLowerCase();
  return TYPE_TO_SOURCE[etype] || TYPE_TO_SOURCE[(b.book_type || '').toLowerCase()] || null;
}

// Shared filter logic — single source of truth
function getActiveBooks(allBooks, excludedBookCodes, delayedBookCodes, stageFilter) {
  return allBooks.filter(b =>
    !b.is_interactive &&
    !b.is_uu_tien &&
    !b.is_paused &&
    (b.total_lessons || 0) > (b.completed_lessons || 0) &&
    !excludedBookCodes.has(b.book_code) &&
    !delayedBookCodes.has(b.book_code) &&
    (stageFilter == null || parseFloat(b.stage) === Number(stageFilter))
  );
}

// Fetch exclusions + delays in parallel
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

  if (exclRes.error) console.error('[RoundRobin] exclusions fetch error:', exclRes.error.message);
  if (delayRes.error) console.error('[RoundRobin] delays fetch error:', delayRes.error.message);

  return { excludedBookCodes, delayedBookCodes };
}

/**
 * Get round-robin status — processes EACH stage independently.
 */
async function getRoundRobinStatus(email) {
  const sb = getSB();
  const { lessons: allBooks } = await fetchStudentBooks(email);
  const { excludedBookCodes, delayedBookCodes } = await fetchFilters(sb, email);

  const activeBooks = getActiveBooks(allBooks, excludedBookCodes, delayedBookCodes);

  if (activeBooks.length <= 1) {
    return { roundRobinActive: false, allowedSources: null, allowedBookCodes: null };
  }

  // Group by stage
  const byStage = {};
  for (const b of activeBooks) {
    const s = parseFloat(b.stage) || 0;
    if (!byStage[s]) byStage[s] = [];
    byStage[s].push(b);
  }

  // Get ALL covered books for this student
  const { data: allCovered, error: covErr } = await sb
    .from('book_round_robin')
    .select('book_code, stage')
    .eq('student_email', email);

  if (covErr) console.error('[RoundRobin] covered fetch error:', covErr.message);

  const coveredByStage = {};
  for (const r of (allCovered || [])) {
    const s = Number(r.stage);
    if (!coveredByStage[s]) coveredByStage[s] = new Set();
    coveredByStage[s].add(r.book_code);
  }

  let anyRoundRobinActive = false;
  const allowedBookCodes = [];
  const allowedSources = new Set();

  for (const [stageStr, booksAtStage] of Object.entries(byStage)) {
    const stage = Number(stageStr);

    if (booksAtStage.length <= 1) {
      for (const b of booksAtStage) {
        allowedBookCodes.push(b.book_code);
        const src = bookSource(b);
        if (src) allowedSources.add(src);
      }
      continue;
    }

    // 2+ books at this stage — apply round-robin
    const coveredSet = coveredByStage[stage] || new Set();
    let uncoveredBooks = booksAtStage.filter(b => !coveredSet.has(b.book_code));

    // If all covered — trip complete — reset
    if (uncoveredBooks.length === 0) {
      const { error: delErr } = await sb.from('book_round_robin')
        .delete()
        .eq('student_email', email)
        .eq('stage', stage);

      if (delErr) {
        console.error(`[RoundRobin] trip reset DELETE failed for ${email} stage ${stage}:`, delErr.message);
      } else {
        console.log(`[RoundRobin] trip auto-reset: ${email} stage ${stage} (${booksAtStage.length} books)`);
      }
      uncoveredBooks = booksAtStage;
    }

    anyRoundRobinActive = true;

    for (const b of uncoveredBooks) {
      allowedBookCodes.push(b.book_code);
      const src = bookSource(b);
      if (src) allowedSources.add(src);
    }
  }

  if (!anyRoundRobinActive) {
    return { roundRobinActive: false, allowedSources: null, allowedBookCodes: null };
  }

  // Interactive is always allowed
  allowedSources.add('bai_hoc_tuong_tac');

  return {
    roundRobinActive: true,
    currentStage: null,
    allowedSources: [...allowedSources],
    allowedBookCodes,
    totalBooks: activeBooks.length,
    coveredCount: (allCovered || []).length
  };
}

/**
 * Mark a book as covered. If all books at that stage are covered, auto-reset.
 */
async function markBookCovered(email, stage, bookCode) {
  const sb = getSB();

  // Upsert with error check
  const { error: upsertErr } = await sb.from('book_round_robin').upsert(
    { student_email: email, stage: Number(stage), book_code: bookCode },
    { onConflict: 'student_email,stage,book_code', ignoreDuplicates: true }
  );

  if (upsertErr) {
    console.error(`[RoundRobin] upsert FAILED for ${email} stage ${stage} book ${bookCode}:`, upsertErr.message);
    throw new Error('Failed to mark book covered: ' + upsertErr.message);
  }

  // Check if trip is now complete at THIS stage
  const { lessons: allBooks } = await fetchStudentBooks(email);
  const { excludedBookCodes, delayedBookCodes } = await fetchFilters(sb, email);

  const booksAtStage = getActiveBooks(allBooks, excludedBookCodes, delayedBookCodes, stage);

  if (booksAtStage.length <= 1) {
    return { tripComplete: false };
  }

  const { data: covered, error: covErr } = await sb
    .from('book_round_robin')
    .select('book_code')
    .eq('student_email', email)
    .eq('stage', Number(stage));

  if (covErr) {
    console.error(`[RoundRobin] covered check failed for ${email} stage ${stage}:`, covErr.message);
    return { tripComplete: false };
  }

  const coveredSet = new Set((covered || []).map(r => r.book_code));
  const allCoveredNow = booksAtStage.every(b => coveredSet.has(b.book_code));

  if (allCoveredNow) {
    const { error: delErr } = await sb.from('book_round_robin')
      .delete()
      .eq('student_email', email)
      .eq('stage', Number(stage));

    if (delErr) {
      console.error(`[RoundRobin] trip reset DELETE failed for ${email} stage ${stage}:`, delErr.message);
      return { tripComplete: false };
    }

    console.log(`[RoundRobin] trip complete + reset: ${email} stage ${stage} (${booksAtStage.length} books)`);
    return { tripComplete: true };
  }

  return { tripComplete: false };
}

module.exports = { getRoundRobinStatus, markBookCovered, TYPE_TO_SOURCE };
