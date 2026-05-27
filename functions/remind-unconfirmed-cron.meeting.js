// /opt/my-api/routes/remind-unconfirmed-cron.meeting.js
// ═══════════════════════════════════════════════════════════════
// ⚡ Runs on Digital Ocean droplet (NOT Netlify)
//    Cron: every 5 hours via crontab → curl localhost:3111/remind-unconfirmed-cron
//    Sends Zalo report to Admin/Super Admin about teachers
//    who haven't confirmed their schedule or student list
// ═══════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {
  app.get('/remind-unconfirmed-cron', async (req, res) => {
    console.log('[RemindUnconfirmed] Starting check...');

    try {
      const supabase = createClient(
        (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
        process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE,
      { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } }
      );

      // ---- Only send between 06:00 and 21:00 Vietnam time ----
      const now = Date.now();
      const vnHour = new Date(now + 7 * 60 * 60 * 1000).getUTCHours();
      if (vnHour < 6 || vnHour >= 21) {
        console.log(`[RemindUnconfirmed] Vietnam time is ${vnHour}:xx — outside 06:00-21:00. Skipping.`);
        return res.json({ ok: true, skipped: 'night' });
      }

      // ---- Calculate current week Monday ----
      const vnNow = new Date(now + 7 * 60 * 60 * 1000);
      const vnDay = vnNow.getUTCDay(); // 0=Sun
      const mondayOffset = vnDay === 0 ? -6 : 1 - vnDay;
      const monday = new Date(vnNow);
      monday.setUTCDate(vnNow.getUTCDate() + mondayOffset);
      monday.setUTCHours(0, 0, 0, 0);

      const weekStartDate = monday.toISOString().slice(0, 10);

      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      const weekEndDate = sunday.toISOString().slice(0, 10);

      console.log(`[RemindUnconfirmed] Week: ${weekStartDate} to ${weekEndDate}`);

      // ---- 1) Find all teachers who have meetings this week ----
      const queryFrom = new Date(monday);
      queryFrom.setUTCDate(queryFrom.getUTCDate() - 56); // 8 weeks back for recurring
      const queryFromDate = queryFrom.toISOString().slice(0, 10);

      const { data: meetings, error: meetErr } = await supabase
        .from('meeting_content')
        .select('teacher_email, work_date, is_one_time')
        .gte('work_date', queryFromDate)
        .lte('work_date', weekEndDate);

      if (meetErr) {
        console.error('[RemindUnconfirmed] Error loading meetings:', meetErr.message);
        return res.status(500).json({ error: meetErr.message });
      }

      // Helper functions
      function getDayIndex(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDay();
        return day === 0 ? 7 : day;
      }

      function formatYMD(d) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      }

      // Expand recurring meetings to find teachers active this week
      const expandedTeachers = new Set();
      for (const m of (meetings || [])) {
        if (!m.teacher_email) continue;
        const email = m.teacher_email.toLowerCase();

        if (m.is_one_time === false) {
          const originalDayIndex = getDayIndex(m.work_date);
          const targetDate = new Date(monday);
          targetDate.setUTCDate(monday.getUTCDate() + (originalDayIndex - 1));
          const targetDateStr = formatYMD(targetDate);
          if (targetDateStr >= weekStartDate && targetDateStr <= weekEndDate) {
            expandedTeachers.add(email);
          }
        } else {
          if (m.work_date >= weekStartDate && m.work_date <= weekEndDate) {
            expandedTeachers.add(email);
          }
        }
      }

      const uniqueTeachers = [...expandedTeachers];
      const totalTeachers = uniqueTeachers.length;

      if (totalTeachers === 0) {
        console.log('[RemindUnconfirmed] No teachers this week. Done.');
        return res.json({ ok: true, message: 'No teachers this week' });
      }

      // ---- 2) Check calendar confirmations ----
      const { data: calConfs } = await supabase
        .from('meeting_confirmation')
        .select('teacher_email')
        .eq('week_start_date', weekStartDate);

      const calConfirmedSet = new Set(
        (calConfs || []).map(c => (c.teacher_email || '').toLowerCase())
      );

      // ---- 3) Check student list confirmations ----
      const { data: stuConfs } = await supabase
        .from('meeting_student_confirmation')
        .select('teacher_email')
        .eq('week_start_date', weekStartDate);

      const stuConfirmedSet = new Set(
        (stuConfs || []).map(c => (c.teacher_email || '').toLowerCase())
      );

      // ---- 4) Find unconfirmed teachers ----
      const unconfirmedCalendarEmails = uniqueTeachers.filter(e => !calConfirmedSet.has(e));
      const unconfirmedStudentEmails = uniqueTeachers.filter(e => !stuConfirmedSet.has(e));

      // If everyone confirmed both, no need to send
      if (unconfirmedCalendarEmails.length === 0 && unconfirmedStudentEmails.length === 0) {
        console.log('[RemindUnconfirmed] All teachers confirmed everything. Done.');
        return res.json({ ok: true, message: 'All confirmed' });
      }

      // ---- 5) Get teacher names ----
      const allUnconfirmedEmails = [...new Set([...unconfirmedCalendarEmails, ...unconfirmedStudentEmails])];
      const { data: teacherData } = await supabase
        .from('user_roles')
        .select('email, full_name')
        .in('email', allUnconfirmedEmails);

      const nameMap = {};
      for (const t of (teacherData || [])) {
        nameMap[(t.email || '').toLowerCase()] = t.full_name || t.email;
      }

      // ---- 6) Build clean message for Admin/Super Admin ----
      const calConfirmedCount = totalTeachers - unconfirmedCalendarEmails.length;
      const stuConfirmedCount = totalTeachers - unconfirmedStudentEmails.length;

      let message = `📊 BÁO CÁO XÁC NHẬN TUẦN ${weekStartDate}\n`;

      // Calendar section
      if (unconfirmedCalendarEmails.length > 0) {
        message += `\n❌ Chưa xác nhận LỊCH (${unconfirmedCalendarEmails.length}/${totalTeachers} GV):\n`;
        unconfirmedCalendarEmails.forEach((email, idx) => {
          const name = nameMap[email] || email;
          message += `   ${idx + 1}. ${name}\n`;
        });
      } else {
        message += `\n✅ Tất cả GV đã xác nhận LỊCH (${totalTeachers}/${totalTeachers})\n`;
      }

      // Student list section
      if (unconfirmedStudentEmails.length > 0) {
        message += `\n❌ Chưa xác nhận DANH SÁCH HV (${unconfirmedStudentEmails.length}/${totalTeachers} GV):\n`;
        unconfirmedStudentEmails.forEach((email, idx) => {
          const name = nameMap[email] || email;
          message += `   ${idx + 1}. ${name}\n`;
        });
      } else {
        message += `\n✅ Tất cả GV đã xác nhận DANH SÁCH HV (${totalTeachers}/${totalTeachers})\n`;
      }

      // Summary line
      message += `\n📈 Tổng kết: Lịch ${calConfirmedCount}/${totalTeachers} ✓ | DS HV ${stuConfirmedCount}/${totalTeachers} ✓`;

      // ---- 7) Get Admin and Super Admin users ----
      const { data: adminUsers } = await supabase
        .from('user_roles')
        .select('email, full_name, role')
        .in('role', ['Admin', 'Super Admin']);

      if (!adminUsers || adminUsers.length === 0) {
        console.log('[RemindUnconfirmed] No Admin/Super Admin users found.');
        return res.json({ ok: true, message: 'No admins found' });
      }

      // ---- 8) Send Zalo to each admin ----
      for (const admin of adminUsers) {
        console.log(`[RemindUnconfirmed] Sending report to ${admin.role}: ${admin.email}`);
        await sendZaloToRecipients(supabase, admin.email, message, 'Hệ thống TANSINH Meetings');
      }

      console.log(`[RemindUnconfirmed] ✅ Sent report to ${adminUsers.length} admin(s). Done.`);
      return res.json({ ok: true, sent: adminUsers.length });

    } catch (fatalErr) {
      console.error('[RemindUnconfirmed] FATAL ERROR:', fatalErr.message || fatalErr);
      return res.status(500).json({ error: fatalErr.message });
    }
  });
};

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
