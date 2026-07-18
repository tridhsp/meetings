// migrated from netlify/functions/offdays-crud.js
// FIXED: uses offdays_makeup_classes (the table learn-today reads from)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  function getSupa() {
    return createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
  }
  async function getUser(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const supabase = getSupa();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  app.get('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const personType = req.query.person_type || '';
      const today = new Date().toISOString().slice(0, 10);
      let query = supabase.from('offdays').select('*').gte('off_to', today).order('off_from', { ascending: true });
      if (personType) query = query.eq('person_type', personType);
      const { data, error } = await query;
      if (error) return res.status(400).json({ error: error.message });

      const rows = data || [];

      // For student offdays, load makeups from offdays_makeup_classes
      if (personType === 'student' && rows.length > 0) {
        const offIds = rows.map(r => r.id);
        const { data: makeups, error: mErr } = await supabase
          .from('offdays_makeup_classes')
          .select('*')
          .in('offday_id', offIds)
          .order('off_date', { ascending: true });

        if (!mErr && makeups) {
          const makeupMap = {};
          for (const m of makeups) {
            if (!makeupMap[m.offday_id]) makeupMap[m.offday_id] = [];
            makeupMap[m.offday_id].push(m);
          }
          for (const row of rows) {
            row.makeups = makeupMap[row.id] || [];
          }
        } else {
          for (const row of rows) {
            row.makeups = [];
          }
        }
      }

      return res.json({ rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.post('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const { person_type, person_email, person_name, off_from, off_to, no_makeup, makeup_dates } = req.body || {};
      if (!person_type || !person_email || !off_from || !off_to) {
        return res.status(400).json({ error: 'person_type, person_email, off_from, off_to are required' });
      }
      const emailNorm = person_email.trim().toLowerCase();
      const { data, error } = await supabase.from('offdays').insert({
        person_type, person_email: emailNorm,
        person_name: person_name || null, off_from, off_to,
        created_by: user.email || null
      }).select().single();
      if (error) return res.status(400).json({ error: error.message });

      // Save makeups for student offdays into offdays_makeup_classes
      if (person_type === 'student' && Array.isArray(makeup_dates) && makeup_dates.length > 0 && data?.id) {
        const makeupRows = makeup_dates.map(m => ({
          offday_id: data.id,
          person_email: emailNorm,
          off_date: m.off_date,
          makeup_date: m.makeup_date || null,
          makeup_start_time: m.makeup_start_time || null,
          makeup_end_time: m.makeup_end_time || null,
          ttkb_teacher_email: m.ttkb_teacher_email || null,
          breakout_teacher_email: m.breakout_teacher_email || null,
          other_teacher_email: m.other_teacher_email || null,
          note: m.note || null,
          no_makeup: m.no_makeup || false,
          created_by: user.email || null
        }));
        const { error: mErr } = await supabase.from('offdays_makeup_classes').insert(makeupRows);
        if (mErr) console.error('[offdays-crud] Error saving makeups:', mErr.message);
      }

      return res.json({ ok: true, data });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.patch('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const { id, off_from, off_to, makeup_dates } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });
      const update = {};
      if (off_from) update.off_from = off_from;
      if (off_to) update.off_to = off_to;
      const { data, error } = await supabase.from('offdays').update(update).eq('id', id).select().single();
      if (error) return res.status(400).json({ error: error.message });

      // Get person_email from the offdays record (needed for offdays_makeup_classes)
      const emailNorm = (data.person_email || '').trim().toLowerCase();

      // Update makeups if provided
      if (Array.isArray(makeup_dates)) {
        // Delete old makeups
        const { error: delErr } = await supabase.from('offdays_makeup_classes').delete().eq('offday_id', id);
        if (delErr) console.error('[offdays-crud] Error deleting old makeups:', delErr.message);

        // Insert new makeups
        if (makeup_dates.length > 0) {
          const makeupRows = makeup_dates.map(m => ({
            offday_id: id,
            person_email: emailNorm,
            off_date: m.off_date,
            makeup_date: m.makeup_date || null,
            makeup_start_time: m.makeup_start_time || null,
            makeup_end_time: m.makeup_end_time || null,
            ttkb_teacher_email: m.ttkb_teacher_email || null,
            breakout_teacher_email: m.breakout_teacher_email || null,
            other_teacher_email: m.other_teacher_email || null,
            note: m.note || null,
            no_makeup: m.no_makeup || false,
            created_by: user.email || null
          }));
          const { error: mErr } = await supabase.from('offdays_makeup_classes').insert(makeupRows);
          if (mErr) console.error('[offdays-crud] Error saving makeups:', mErr.message);
        }
      }

      return res.json({ ok: true, data });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.delete('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: row, error: readErr } = await supabase.from('offdays').select('person_type, person_email, off_from, off_to').eq('id', id).single();
      if (readErr) return res.status(400).json({ error: readErr.message });

      if (row && row.person_type === 'teacher' && row.person_email && row.off_from && row.off_to) {
        await supabase.from('meeting_offdays').delete()
          .ilike('teacher_email', row.person_email.trim().toLowerCase())
          .gte('off_date', row.off_from).lte('off_date', row.off_to);
      }

      // Delete makeups first (CASCADE would handle this, but explicit is safer)
      await supabase.from('offdays_makeup_classes').delete().eq('offday_id', id);

      const { error } = await supabase.from('offdays').delete().eq('id', id);
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });
};
