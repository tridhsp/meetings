// GET  /student-note   — list notes
// POST /student-note   — create note
// PUT  /student-note   — update status (admin)
// DELETE /student-note — delete note
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {

  // Shared auth + role helper
  async function authAndRole(req, res) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) { res.status(401).json({ ok: false, error: 'Missing token' }); return null; }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ ok: false, error: 'Missing env vars' }); return null; }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket }
    });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) { res.status(401).json({ ok: false, error: 'Invalid token' }); return null; }

    const userEmail = userRes.user.email.toLowerCase();
    const { data: roleData } = await supabase.from('user_roles').select('role, full_name').eq('email', userEmail).limit(1);
    const userRole = roleData?.[0]?.role || '';
    const userName = roleData?.[0]?.full_name || '';
    const isAdmin = ['Admin', 'Super Admin'].includes(userRole);

    return { supabase, userEmail, userName, userRole, isAdmin };
  }

  // ============ GET ============
  app.get('/student-note', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, isAdmin } = ctx;

      const { week_start_date, pending_only, teacher_email } = req.query;

      let query = supabase.from('meeting_student_notes').select('*').order('created_at', { ascending: false });
      if (!isAdmin) query = query.eq('teacher_email', userEmail);
      if (teacher_email && isAdmin) query = query.eq('teacher_email', teacher_email);
      if (week_start_date) query = query.eq('week_start_date', week_start_date);
      if (pending_only === 'true') query = query.eq('status', 'pending');

      const { data, error } = await query.limit(500);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true, rows: data || [], isAdmin });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ============ POST ============
  app.post('/student-note', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, userName } = ctx;

      const { studentEmail, studentName, dayOfWeek, timeLocal, role, note, weekStartDate } = req.body || {};
      if (!studentEmail || !note || note.trim().length < 5) {
        return res.status(400).json({ ok: false, error: 'studentEmail and note (min 5 chars) required' });
      }

      const insertData = {
        teacher_email: userEmail,
        teacher_name: userName || null,
        student_email: studentEmail,
        student_name: studentName || null,
        day_of_week: dayOfWeek ?? null,
        time_local: timeLocal || null,
        role: role || null,
        note: note.trim(),
        status: 'pending',
        week_start_date: weekStartDate || null
      };

      const { data, error } = await supabase.from('meeting_student_notes').insert(insertData).select('id').single();
      if (error) return res.status(500).json({ ok: false, error: error.message });

      // ===== AUTO-CREATE DUTY FOR ADMIN USERS =====
      try {
        const { data: adminUsers } = await supabase.from('user_roles').select('email, full_name, role').in('role', ['Admin', 'Super Admin']);
        if (adminUsers && adminUsers.length > 0) {
          const dueAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
          const meetingSiteUrl = 'https://meeting.tansinh.info';
          const dutySiteUrl = 'https://duty.tansinh.info';
          const teacherDisplayName = userName || userEmail;
          const studentDisplayName = studentName || studentEmail;

          const dutyTitle = `[GV Note] ${teacherDisplayName} — ${studentDisplayName}`;
          const dutyDescription = `GV ${teacherDisplayName} ghi chú về HV ${studentDisplayName}:\n\n"${note.trim()}"\n\n📅 Ngày: ${dayOfWeek != null ? ['CN','T2','T3','T4','T5','T6','T7'][dayOfWeek] || '' : ''} ${timeLocal || ''}\n🔗 ${meetingSiteUrl}/confirmation.html`;

          for (const admin of adminUsers) {
            const { data: insertedDuty, error: dutyErr } = await supabase
              .from('duty')
              .insert({
                title: dutyTitle,
                description: dutyDescription,
                assigned_to: admin.email,
                assigned_by: userEmail,
                status: 'pending',
                due_at: dueAt
              })
              .select('id')
              .single();

            if (dutyErr) { console.error(`[StudentNote] Failed to create duty for ${admin.email}:`, dutyErr.message); continue; }
            console.log(`[StudentNote] Created duty #${insertedDuty.id} for ${admin.email}`);

            // Pre-insert reminder threshold
            const THRESHOLDS = [
              { type: '15m', minutes: 15 },
              { type: '30m', minutes: 30 },
              { type: '1h', minutes: 60 },
              { type: '3h', minutes: 180 },
              { type: '6h', minutes: 360 },
            ];
            const minutesLeft = (new Date(dueAt).getTime() - Date.now()) / 60000;
            let matchedThreshold = null;
            for (const threshold of THRESHOLDS) {
              if (minutesLeft <= threshold.minutes) { matchedThreshold = threshold; break; }
            }
            if (matchedThreshold && insertedDuty?.id) {
              await supabase.from('duty_reminders').insert({ duty_id: insertedDuty.id, reminder_type: matchedThreshold.type });
            }

            // Send Zalo notification to admin
            const dutyLink = insertedDuty?.id ? `\n🔗 Xem nhiệm vụ: ${dutySiteUrl}/?id=${insertedDuty.id}` : '';
            const zaloMessage = `📝 GHI CHÚ HV MỚI\n\nGV ${teacherDisplayName} ghi chú về HV ${studentDisplayName}:\n\n"${note.trim()}"\n\n📅 Hạn xử lý: ${new Date(dueAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}${dutyLink}`;
            await sendZaloToRecipients(supabase, admin.email, zaloMessage, 'Hệ thống TANSINH Meetings');
          }
        }
      } catch (dutyErr) {
        console.error('[StudentNote] Error creating duties:', dutyErr.message || dutyErr);
      }

      return res.json({ ok: true, id: data.id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ============ PUT ============
  app.put('/student-note', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, isAdmin } = ctx;

      if (!isAdmin) return res.status(403).json({ ok: false, error: 'Admin only' });

      const { id, status, adminResponse } = req.body || {};
      if (!id || !status) return res.status(400).json({ ok: false, error: 'Missing id or status' });
      if (!['pending', 'resolved', 'rejected'].includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });

      const { error } = await supabase.from('meeting_student_notes')
        .update({ status, admin_response: adminResponse || null, resolved_by: userEmail, resolved_at: new Date().toISOString() })
        .eq('id', id);

      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ============ DELETE ============
  app.delete('/student-note', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, isAdmin } = ctx;

      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

      let query = supabase.from('meeting_student_notes').delete().eq('id', id);
      if (!isAdmin) query = query.eq('teacher_email', userEmail);

      const { error } = await query;
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
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

  if (!tokenRow?.access_token) { console.error('[Zalo] No access token found'); return; }

  const token = tokenRow.access_token;
  const oaId = process.env.ZALO_OA_ID;

  const { data: contact, error: contactErr } = await supabase
    .from('students_contact_info')
    .select('email, zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other, ten_hv')
    .eq('email', recipientEmail)
    .maybeSingle();

  if (contactErr || !contact) { console.log('[Zalo] No contact found for email:', recipientEmail); return; }

  const receiverIds = [contact.zalo_key, contact.guardian_key1_m, contact.guardian_key2_c, contact.guardian_key3_other].filter(Boolean);
  if (!receiverIds.length) { console.log('[Zalo] No Zalo IDs found for:', recipientEmail); return; }

  const uniqueIds = [...new Set(receiverIds)];
  const footer = `Nhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép TANSINH tiếp tục gửi thông tin. Trân trọng! (${assignedByName})`;
  const finalText = `${message}\n\n${footer}`;

  for (const id of uniqueIds) {
    let nameToLog = contact.ten_hv || recipientEmail;
    if (id !== contact.zalo_key) {
      const { data: whoList } = await supabase.from('students_contact_info').select('ten_hv').eq('zalo_key', id);
      if (whoList?.length > 0) {
        if (whoList.length === 1) { nameToLog = whoList[0].ten_hv; }
        else { const [parent, child] = whoList; nameToLog = `${parent.ten_hv} (${child.ten_hv})`; }
      }
    }

    const payload = { recipient: { user_id: id }, message: { text: finalText } };
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

    const deliveryStatus = zaloResp.ok && (!zaloJson.error || zaloJson.error === 0) ? 'Success' : 'Zalo hết hạn';
    const bangkokIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    await supabase.from('zalo_status').upsert({
      oa_id: oaId, recipient_id: id, recipient_name: nameToLog, status: deliveryStatus, created_at: bangkokIso
    }, { onConflict: 'oa_id,recipient_id' });

    if (!zaloResp.ok || (zaloJson.error && zaloJson.error !== 0)) {
      console.error('[Zalo send error]', id, zaloJson);
    }
  }
}
