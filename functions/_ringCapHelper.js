// _ringCapHelper.js -- the daily call limit for ring.tansinh.info
//
// ⚠️ THE FILENAME MATTERS TWICE.
//    1. It starts with "_" so server.js never loads it as a route.
//    2. git-push-site.sh line 110 collects "_*Helper.js" -- CAPITAL H, NO
//       HYPHEN. A name like "_ring-cap.helper.js" matches nothing and would
//       live in no git repo at all, exactly as _cache-helper.js and
//       _rtr-duration.helper.js still do today.
//
// THE RULE, as decided 13 Sep 2026
//   At most PER_DAY calls per (student_id, relation_key, channel) per day.
//   Each family member has their OWN allowance, and phone and Zalo are
//   counted separately. So one student can receive 3 phone calls AND 3 Zalo
//   calls, and their mother another 3 and 3, and their father another 3 and 3.
//
//   The allowance is SHARED BY ALL TEACHERS, not per teacher. The point of the
//   limit is to stop a family being pestered, and 25 teachers with 3 each is
//   75 calls, which would defeat it. Change SHARED to false if you ever want
//   per-teacher instead; nothing else needs editing.
//
//   Admin and Super Admin are exempt. gate() already returns the role, so this
//   costs no extra database read.
//
//   EVERY ATTEMPT COUNTS, answered or not. The ledger row is written when the
//   number is handed over, which is the only moment the relation is known.
//
// ⚠️ A DAY IS A VIETNAM DAY, NOT A UTC DAY.
//    ring_call_attempts.at is stored with a +00:00 offset. Midnight in Vietnam
//    is 17:00 UTC the day before. Getting this wrong would reset everybody's
//    allowance at 7am, in the middle of the morning shift. This is the same
//    +07 trap that has already cost two sessions -- see PART 7 of the master
//    file.
//
// ⚠️ WHAT THIS DOES NOT STOP, stated plainly.
//    The ledger write in both dial routes is deliberately fire-and-forget, so
//    a logging failure can never block a real call. That means two clicks
//    within the same few milliseconds could both read "2 used" before either
//    row lands, and a teacher would get 4. The window is one round trip on the
//    private path and the page needs two clicks per call, so this is accepted
//    rather than risk blocking a genuine call.
//    Nor does it stop someone who already holds a number on screen and knows
//    how to use devtools -- the page never holds the number, but a determined
//    person could re-dial one they already have. Closing that properly means
//    counting in the dialplan on VM 107 as well, which is a much bigger job.
//    This stops the normal path, which is what was asked for.

const PER_DAY = 3;        // calls allowed per bucket per day
const SHARED  = true;     // true = all teachers share the 3; false = 3 each
const EXEMPT_ROLES = ['Admin', 'Super Admin'];
const TZ_OFFSET_HOURS = 7;   // Asia/Ho_Chi_Minh. No daylight saving, so fixed.

// Shown to the teacher when a bucket is full. Matches the labels the page
// already uses, so the message names the same person the button did.
const REL_LABEL = {
  phone: { hv: 'Học viên', me: 'Mẹ', cha: 'Cha', chi: 'Chị', ba: 'Bà', ong: 'Ông' },
  zalo:  { hv: 'Zalo gia đình', me: 'Mẹ', cha: 'Cha', other: 'PH' },
};

// Start of today in Vietnam, expressed as a UTC instant, as an ISO string.
// Worked out by shifting into +07, truncating the date there, and shifting
// back -- rather than trusting the server's own timezone, which is UTC on the
// VMs and +07 on the hosts.
function vnDayStartISO(now) {
  const t = (now || new Date()).getTime();
  const shifted = new Date(t + TZ_OFFSET_HOURS * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const startShifted = Date.UTC(y, m, d, 0, 0, 0, 0);
  return new Date(startShifted - TZ_OFFSET_HOURS * 3600 * 1000).toISOString();
}

// How many calls are left in one bucket right now.
//
// Returns { exempt, used, left, limit, resets } and NEVER throws. A database
// problem returns left = limit, so a broken read can never block a real call.
// That is the same three-state thinking as the recording gate: when we cannot
// tell, we do not punish the teacher.
async function remaining(sb, opts) {
  const limit = PER_DAY;
  const out = { exempt: false, used: 0, left: limit, limit: limit, resets: '00:00', error: null };

  if (opts && EXEMPT_ROLES.includes(opts.role)) {
    out.exempt = true;
    return out;
  }

  try {
    let q = sb.from('ring_call_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', String(opts.student_id))
      .eq('relation_key', String(opts.relation_key))
      .eq('channel', String(opts.channel))
      .gte('at', vnDayStartISO());

    if (!SHARED) q = q.eq('email', String(opts.email || ''));

    const { count, error } = await q;
    if (error) {
      out.error = error.message;
      return out;                      // fail OPEN, see the note above
    }
    out.used = count || 0;
    out.left = Math.max(0, limit - out.used);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

// The sentence a teacher sees when a bucket is full. Names the person and says
// when it resets, rather than a bare error.
function fullMessage(channel, relation_key, student_name) {
  const who = (REL_LABEL[channel] && REL_LABEL[channel][relation_key]) || relation_key;
  const via = channel === 'zalo' ? 'qua Zalo' : 'qua điện thoại';
  const name = student_name ? (' của ' + student_name) : '';
  return 'Đã gọi đủ ' + PER_DAY + ' lượt ' + via + ' cho ' + who + name +
         ' hôm nay. Lượt mới bắt đầu lúc 00:00.';
}

// The one call a dial route makes. Returns null when the call may proceed, or
// a ready-made { status, body } to send back when it may not.
//
//   const blocked = await enforce(sb(), { ... });
//   if (blocked) return res.status(blocked.status).json(blocked.body);
//
async function enforce(sb, opts) {
  const r = await remaining(sb, opts);
  if (r.exempt || r.left > 0) return null;
  return {
    status: 429,
    body: {
      error: fullMessage(opts.channel, opts.relation_key, opts.student_name),
      cap: { used: r.used, limit: r.limit, left: 0, channel: opts.channel,
             relation: opts.relation_key, resets: r.resets },
    },
  };
}

module.exports = {
  PER_DAY, SHARED, EXEMPT_ROLES,
  vnDayStartISO, remaining, fullMessage, enforce,
  _test: { REL_LABEL, TZ_OFFSET_HOURS },
};
