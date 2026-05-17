// GET  /request-change   — list requests
// POST /request-change   — create request
// PUT  /request-change   — update status (admin)
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

module.exports = function (app) {

  async function authAndRole(req, res) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) { res.status(401).json({ ok: false, error: 'Missing bearer token' }); return null; }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ ok: false, error: 'Missing Supabase env vars' }); return null; }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket }
    });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) { res.status(401).json({ ok: false, error: 'Invalid auth token' }); return null; }

    const userEmail = userRes.user.email.toLowerCase();
    const { data: roleData } = await supabase.from('user_roles').select('role, full_name').eq('email', userEmail).limit(1);
    const userRole = roleData?.[0]?.role || '';
    const userName = roleData?.[0]?.full_name || '';
    const isAdmin = ['Admin', 'Super Admin'].includes(userRole);

    return { supabase, userEmail, userName, userRole, isAdmin };
  }

  // ============ GET ============
  app.get('/request-change', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, isAdmin } = ctx;

      const { status, from, to, pending_only } = req.query;

      let query = supabase.from('meeting_request_change').select('*').order('created_at', { ascending: false });
      if (!isAdmin) query = query.eq('teacher_email', userEmail);
      if (status) query = query.eq('status', status);
      if (pending_only === 'true') query = query.eq('status', 'pending');
      if (from) query = query.gte('work_date', from);
      if (to) query = query.lte('work_date', to);

      const { data, error } = await query.limit(500);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true, rows: data || [], isAdmin });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ============ POST ============
  app.post('/request-change', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, userName } = ctx;

      const { meetingContentId, workDate, startTime, endTime, department, reason } = req.body || {};

      if (!workDate || !startTime || !endTime || !reason) {
        return res.status(400).json({ ok: false, error: 'Missing required fields: workDate, startTime, endTime, reason' });
      }
      if (reason.trim().length < 10) {
        return res.status(400).json({ ok: false, error: 'Reason must be at least 10 characters' });
      }

      const insertData = {
        teacher_email: userEmail,
        teacher_name: userName || null,
        meeting_content_id: meetingContentId || null,
        work_date: workDate,
        start_time: startTime.length === 5 ? `${startTime}:00` : startTime,
        end_time: endTime.length === 5 ? `${endTime}:00` : endTime,
        department: department || null,
        reason: reason.trim(),
        status: 'pending'
      };

      const { data, error } = await supabase.from('meeting_request_change').insert(insertData).select('id').single();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true, id: data.id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ============ PUT ============
  app.put('/request-change', async (req, res) => {
    try {
      const ctx = await authAndRole(req, res);
      if (!ctx) return;
      const { supabase, userEmail, isAdmin } = ctx;

      if (!isAdmin) return res.status(403).json({ ok: false, error: 'Only admins can update requests' });

      const { id, status, adminResponse } = req.body || {};
      if (!id || !status) return res.status(400).json({ ok: false, error: 'Missing id or status' });
      if (!['pending', 'approved', 'rejected', 'resolved'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Invalid status' });
      }

      const { error } = await supabase.from('meeting_request_change')
        .update({ status, admin_response: adminResponse || null, resolved_by: userEmail, resolved_at: new Date().toISOString() })
        .eq('id', id);

      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
};
