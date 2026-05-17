// /opt/my-api/routes/notify-unmatched-students-cron.meeting.js
// ═══════════════════════════════════════════════════════════════
// ⚡ Runs on Digital Ocean droplet (NOT Netlify)
//    Cron: every 5 hours via crontab → curl localhost:3111/notify-unmatched-students-cron
//    Sends Zalo to Admin/Super Admin with a summary of students
//    who don't have a teacher this week (nghỉ or không có ca)
//    and whether a substitute has been assigned.
// ═══════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/notify-unmatched-students-cron', async (req, res) => {
    console.log('[NotifyUnmatched] Starting check...');

    try {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE,
        { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      // ---- Only send between 06:00 and 21:00 Vietnam time ----
      const now = Date.now();
      const vnHour = new Date(now + 7 * 60 * 60 * 1000).getUTCHours();
      if (vnHour < 6 || vnHour >= 21) {
        console.log(`[NotifyUnmatched] Vietnam time is ${vnHour}:xx — outside 06:00-21:00. Skipping.`);
        return res.json({ ok: true, skipped: 'night' });
      }

      // ---- Calculate current week Monday & Sunday ----
      const vnNow = new Date(now + 7 * 60 * 60 * 1000);
      const vnDay = vnNow.getUTCDay(); // 0=Sun
      const mondayOffset = vnDay === 0 ? -6 : 1 - vnDay;
      const monday = new Date(vnNow);
      monday.setUTCDate(vnNow.getUTCDate() + mondayOffset);
      monday.setUTCHours(0, 0, 0, 0);

      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);

      const mondayStr = formatYMD(monday);
      const sundayStr = formatYMD(sunday);

      console.log(`[NotifyUnmatched] Week: ${mondayStr} to ${sundayStr}`);

      // ---- 1) Get all student schedules ----
      const { data: scheds, error: sErr } = await supabase
        .from('student_schedule')
        .select('student_email, teacher_email, breakout_email, day_of_week, time_local');
      if (sErr) throw sErr;

      const validScheds = (scheds || []).filter(s => s.student_email && (s.teacher_email || s.breakout_email));
      if (!validScheds.length) {
        console.log('[NotifyUnmatched] No student schedules found. Done.');
        return res.json({ ok: true, message: 'No student schedules' });
      }

      // ---- 2) Get active students only ----
      const allStudentEmails = [...new Set(validScheds.map(s => s.student_email))];
      const { data: hvRows } = await supabase
        .from('danh_sach_hv')
        .select('email, ten_hv, status, student_minutes, student_level')
        .in('email', allStudentEmails);

      const activeStudents = new Set();
      const studentNameMap = {};
      for (const h of (hvRows || [])) {
        if (h.status === 0) continue;
        activeStudents.add(h.email);
        if (h.ten_hv) studentNameMap[h.email] = h.ten_hv;
      }

      const activeScheds = validScheds.filter(s => activeStudents.has(s.student_email));
      if (!activeScheds.length) {
        console.log('[NotifyUnmatched] No active student schedules. Done.');
        return res.json({ ok: true, message: 'No active schedules' });
      }

      // ---- 3) Get meeting_content (recurring + one-time) ----
      const { data: recurringMeetings, error: mErr1 } = await supabase
        .from('meeting_content')
        .select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', false)
        .lte('work_date', sundayStr);
      if (mErr1) throw mErr1;

      const { data: onetimeMeetings, error: mErr2 } = await supabase
        .from('meeting_content')
        .select('id, teacher_email, work_date, start_time, end_time, is_one_time, department')
        .eq('is_one_time', true)
        .gte('work_date', mondayStr)
        .lte('work_date', sundayStr);
      if (mErr2) throw mErr2;

      const meetings = [...(recurringMeetings || []), ...(onetimeMeetings || [])];

      // ---- 4) Get meeting_offdays for this week ----
      const { data: offRows } = await supabase
        .from('meeting_offdays')
        .select('meeting_content_id, off_date')
        .gte('off_date', mondayStr)
        .lte('off_date', sundayStr);

      const offSet = new Set((offRows || []).map(r => `${r.meeting_content_id}|${r.off_date}`));

      // Also get full-day teacher offdays
      const { data: fullOffRows } = await supabase
        .from('offdays')
        .select('person_email, off_from, off_to')
        .eq('person_type', 'teacher')
        .lte('off_from', sundayStr)
        .gte('off_to', mondayStr);

      const teacherFullOff = new Set();
      for (const row of (fullOffRows || [])) {
        const email = (row.person_email || '').trim().toLowerCase();
        if (!email) continue;
        const start = new Date(row.off_from + 'T00:00:00');
        const end = new Date(row.off_to + 'T00:00:00');
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          teacherFullOff.add(`${email}|${formatYMD(d)}`);
        }
      }

      // ---- 5) Expand recurring meetings to this week ----
      const expanded = expandRecurringForWeek(meetings, monday);

      const weekMeetingsAll = expanded.filter(r => isSameWeek(r.work_date, monday));

      // Build "had shift" set (before removing off-days)
      const teacherHadShift = new Set();
      for (const m of weekMeetingsAll) {
        const email = (m.teacher_email || '').toLowerCase();
        if (!email) continue;
        const d = new Date(m.work_date + 'T00:00:00');
        teacherHadShift.add(`${email}|${d.getDay()}`);
      }

      // Remove off-days
      const weekMeetings = weekMeetingsAll.filter(r => {
        const email = (r.teacher_email || '').toLowerCase();
        if (teacherFullOff.has(`${email}|${r.work_date}`)) return false;
        if (offSet.has(`${r.id}|${r.work_date}`)) return false;
        return true;
      });

      // ---- 6) Build working sets ----
      const teacherHasWorkingTime = new Set();
      const teacherMixDays = new Set();
      for (const m of weekMeetings) {
        const email = (m.teacher_email || '').toLowerCase();
        if (!email) continue;
        const d = new Date(m.work_date + 'T00:00:00');
        const dow = d.getDay();
        teacherHasWorkingTime.add(`${email}|${dow}`);
        if ((m.department || '').toLowerCase() === 'mix') {
          teacherMixDays.add(`${email}|${dow}`);
        }
      }

      // ---- 7) Get teacher names ----
      const allTeacherEmails = [...new Set([
        ...activeScheds.map(s => s.teacher_email),
        ...activeScheds.map(s => s.breakout_email)
      ].filter(Boolean))];
      const teacherNameMap = {};
      if (allTeacherEmails.length) {
        const { data: tRows } = await supabase
          .from('user_roles')
          .select('email, full_name')
          .in('email', allTeacherEmails);
        for (const t of (tRows || [])) {
          if (t.full_name) teacherNameMap[t.email] = t.full_name;
        }
      }

      // ---- 8) Find unmatched students grouped by day ----
      const result = {};

      for (const s of activeScheds) {
        const dow = s.day_of_week;
        const tEmail = (s.teacher_email || '').toLowerCase();
        const bEmail = (s.breakout_email || '').toLowerCase();
        const tKey = tEmail ? `${tEmail}|${dow}` : '';
        const ttkbWorking = tEmail && teacherHasWorkingTime.has(tKey);
        const ttkbIsMix = tEmail && teacherMixDays.has(tKey);

        // Check TTKB
        if (tEmail && !ttkbWorking) {
          const tReason = teacherHadShift.has(tKey) ? 'nghỉ' : 'không có ca';
          if (!result[dow]) result[dow] = [];
          result[dow].push({
            student_email: s.student_email,
            student_name: studentNameMap[s.student_email] || s.student_email,
            teacher_email: s.teacher_email,
            teacher_name: teacherNameMap[s.teacher_email] || s.teacher_email,
            time_local: s.time_local,
            role: 'TTKB',
            reason: tReason
          });
        }

        // Check Breakout
        if (bEmail && !(ttkbWorking && ttkbIsMix)) {
          const bKey = `${bEmail}|${dow}`;
          if (!teacherHasWorkingTime.has(bKey)) {
            const bReason = teacherHadShift.has(bKey) ? 'nghỉ' : 'không có ca';
            if (!result[dow]) result[dow] = [];
            result[dow].push({
              student_email: s.student_email,
              student_name: studentNameMap[s.student_email] || s.student_email,
              teacher_email: s.breakout_email,
              teacher_name: teacherNameMap[s.breakout_email] || s.breakout_email,
              time_local: s.time_local,
              role: 'BR',
              reason: bReason
            });
          }
        }
      }

      // Sort each day by time
      for (const dow in result) {
        result[dow].sort((a, b) => (a.time_local || '').localeCompare(b.time_local || ''));
      }

      // ---- 9) Load existing substitute assignments for this week ----
      const { data: subRows } = await supabase
        .from('session_substitute_assignments')
        .select('student_email, assign_date, substitute_teacher_name, substitute_teacher_email')
        .gte('assign_date', mondayStr)
        .lte('assign_date', sundayStr);

      const subMap = {};
      for (const s of (subRows || [])) {
        subMap[`${s.student_email}|${s.assign_date}`] = s.substitute_teacher_name || s.substitute_teacher_email;
      }

      // ---- 10) Build Zalo message ----
      const dayLabelsLong = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

      // We need to compute actual dates for each dow
      function dateForDow(dow) {
        const dayOffset = dow === 0 ? 6 : dow - 1;
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + dayOffset);
        return d;
      }

      let totalUnmatched = 0;
      let totalNoSub = 0;
      let totalHasSub = 0;
      let messageBody = '';

      // Only show days from today forward (don't report past days)
      const todayVN = new Date(now + 7 * 60 * 60 * 1000);
      const todayStr = `${todayVN.getUTCFullYear()}-${String(todayVN.getUTCMonth() + 1).padStart(2, '0')}-${String(todayVN.getUTCDate()).padStart(2, '0')}`;

      // Order: today first, then upcoming days
      const todayDow = todayVN.getUTCDay();
      const dowOrder = [];
      for (let i = 0; i < 7; i++) {
        dowOrder.push((todayDow + i) % 7);
      }

      for (const dow of dowOrder) {
        const students = result[dow];
        if (!students || !students.length) continue;

        const dayDate = dateForDow(dow);
        const dateStr = formatYMD(dayDate);

        // Skip past days
        if (dateStr < todayStr) continue;

        const dd = String(dayDate.getUTCDate()).padStart(2, '0');
        const mm = String(dayDate.getUTCMonth() + 1).padStart(2, '0');

        let dayNoSub = [];
        let dayHasSub = [];

        for (const s of students) {
          totalUnmatched++;
          const subKey = `${s.student_email}|${dateStr}`;
          const subName = subMap[subKey];

          if (subName) {
            totalHasSub++;
            dayHasSub.push(s);
          } else {
            totalNoSub++;
            dayNoSub.push(s);
          }
        }

        const isToday = dateStr === todayStr;
        const dayHeader = isToday
          ? `📅 ${dayLabelsLong[dow]} ${dd}/${mm} (Hôm nay)`
          : `📅 ${dayLabelsLong[dow]} ${dd}/${mm}`;

        messageBody += `\n${dayHeader}\n`;

        if (dayNoSub.length > 0) {
          messageBody += `  ⚠️ Chưa có GV tạm (${dayNoSub.length}):\n`;
          for (const s of dayNoSub) {
            const time = (s.time_local || '').slice(0, 5);
            messageBody += `    ❌ ${s.student_name} [${s.role}] ${time} — GV: ${s.teacher_name} (${s.reason})\n`;
          }
        }

        if (dayHasSub.length > 0) {
          messageBody += `  ✅ Đã có GV tạm (${dayHasSub.length}):\n`;
          for (const s of dayHasSub) {
            const time = (s.time_local || '').slice(0, 5);
            const subKey = `${s.student_email}|${dateStr}`;
            messageBody += `    ✓ ${s.student_name} [${s.role}] ${time} → ${subMap[subKey]}\n`;
          }
        }
      }

      // ---- 11) Decide whether to send ----
      if (totalUnmatched === 0) {
        console.log('[NotifyUnmatched] All students have teachers this week. No notification needed.');
        return res.json({ ok: true, message: 'All matched' });
      }

      // Only send if there are students WITHOUT substitutes
      if (totalNoSub === 0) {
        console.log(`[NotifyUnmatched] All ${totalHasSub} unmatched students already have substitutes. Skipping Zalo.`);
        return res.json({ ok: true, message: 'All have substitutes', totalHasSub });
      }

      const vnTimeStr = `${String(vnHour).padStart(2, '0')}:${String(new Date(now + 7 * 60 * 60 * 1000).getUTCMinutes()).padStart(2, '0')}`;

      let message = `🚨 BÁO CÁO HV CHƯA CÓ GV — Tuần ${mondayStr}\n`;
      message += `🕐 Cập nhật lúc ${vnTimeStr}\n`;
      message += `\n📊 Tổng: ${totalUnmatched} HV bị ảnh hưởng`;
      message += `\n⚠️ Chưa có GV tạm: ${totalNoSub} HV`;
      if (totalHasSub > 0) {
        message += `\n✅ Đã gán GV tạm: ${totalHasSub} HV`;
      }
      message += `\n${messageBody}`;
      message += `\n🔗 Xử lý tại: ${process.env.MEETING_SITE_URL || 'https://meeting.tansinh.info'}/offteachers.html`;

      // ---- 12) Get Admin and Super Admin users ----
      const { data: adminUsers } = await supabase
        .from('user_roles')
        .select('email, full_name, role')
        .in('role', ['Admin', 'Super Admin']);

      if (!adminUsers || adminUsers.length === 0) {
        console.log('[NotifyUnmatched] No Admin/Super Admin users found.');
        return res.json({ ok: true, message: 'No admins found' });
      }

      // ---- 13) Send Zalo to each admin ----
      for (const admin of adminUsers) {
        console.log(`[NotifyUnmatched] Sending report to ${admin.role}: ${admin.email}`);
        await sendZaloToRecipients(supabase, admin.email, message, 'Hệ thống TANSINH Meetings');
      }

      console.log(`[NotifyUnmatched] ✅ Sent report to ${adminUsers.length} admin(s). Done.`);
      return res.json({ ok: true, sent: adminUsers.length });

    } catch (fatalErr) {
      console.error('[NotifyUnmatched] FATAL ERROR:', fatalErr.message || fatalErr);
      return res.status(500).json({ error: fatalErr.message });
    }
  });
};


// ========== HELPERS ==========

function formatYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function rosterDayIndex(ymd) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return ((t.getDay() + 6) % 7) + 1; // 1..7 with Monday=1
}

function isSameWeek(ymd, weekStart) {
  if (!ymd) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  const ws = new Date(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate());
  const we = new Date(ws);
  we.setDate(ws.getDate() + 7);
  return t >= ws && t < we;
}

function expandRecurringForWeek(rows, weekStart) {
  const expanded = [];
  for (const r of (rows || [])) {
    if (r && r.is_one_time === false) {
      const di = rosterDayIndex(r.work_date);
      const tgt = new Date(weekStart);
      tgt.setUTCDate(tgt.getUTCDate() + (di - 1));
      expanded.push({ ...r, work_date: formatYMD(tgt) });
    } else {
      expanded.push(r);
    }
  }
  const seen = new Set();
  return expanded.filter(r => {
    const key = `${r.teacher_email}|${r.work_date}|${r.start_time}|${r.end_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


// ========== HELPER: Send Zalo ==========
async function sendZaloToRecipients(supabase, recipientEmail, message, assignedByName) {
  const { data: tokenRow } = await supabase
    .from('tokens')
    .select('access_token')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!tokenRow?.access_token) {
    console.error('[Zalo] No access token found');
    return;
  }

  const token = tokenRow.access_token;
  const oaId = process.env.ZALO_OA_ID;

  const { data: contact, error: contactErr } = await supabase
    .from('students_contact_info')
    .select('email, zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other, ten_hv')
    .eq('email', recipientEmail)
    .maybeSingle();

  if (contactErr || !contact) {
    console.log('[Zalo] No contact found for email:', recipientEmail);
    return;
  }

  const receiverIds = [
    contact.zalo_key,
    contact.guardian_key1_m,
    contact.guardian_key2_c,
    contact.guardian_key3_other
  ].filter(Boolean);

  if (!receiverIds.length) {
    console.log('[Zalo] No Zalo IDs found for:', recipientEmail);
    return;
  }

  const uniqueIds = [...new Set(receiverIds)];

  const footer = `Nhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép TANSINH tiếp tục gửi thông tin. Trân trọng! (${assignedByName})`;
  const finalText = `${message}\n\n${footer}`;

  for (const id of uniqueIds) {
    let nameToLog = contact.ten_hv || recipientEmail;
    if (id !== contact.zalo_key) {
      const { data: whoList } = await supabase
        .from('students_contact_info')
        .select('ten_hv')
        .eq('zalo_key', id);

      if (whoList?.length > 0) {
        if (whoList.length === 1) {
          nameToLog = whoList[0].ten_hv;
        } else {
          const [parent, child] = whoList;
          nameToLog = `${parent.ten_hv} (${child.ten_hv})`;
        }
      }
    }

    const payload = {
      recipient: { user_id: id },
      message: { text: finalText }
    };

    let zaloResp, zaloJson;
    try {
      zaloResp = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: token },
        body: JSON.stringify(payload)
      });
      zaloJson = await zaloResp.json();
    } catch (fetchErr) {
      console.error(`[Zalo] Network error sending to ${id}:`, fetchErr.message || fetchErr);
      continue;
    }

    const deliveryStatus = zaloResp.ok && (!zaloJson.error || zaloJson.error === 0)
      ? 'Success'
      : 'Zalo hết hạn';

    const bangkokIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    await supabase.from('zalo_status').upsert({
      oa_id: oaId,
      recipient_id: id,
      recipient_name: nameToLog,
      status: deliveryStatus,
      created_at: bangkokIso
    }, { onConflict: 'oa_id,recipient_id' });

    if (!zaloResp.ok || (zaloJson.error && zaloJson.error !== 0)) {
      console.error('[Zalo send error]', id, zaloJson);
    }
  }
}
