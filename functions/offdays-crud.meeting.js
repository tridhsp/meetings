// migrated from netlify/functions/offdays-crud.js
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
      return res.json({ rows: data || [] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.post('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const { person_type, person_email, person_name, off_from, off_to } = req.body || {};
      if (!person_type || !person_email || !off_from || !off_to) {
        return res.status(400).json({ error: 'person_type, person_email, off_from, off_to are required' });
      }
      const { data, error } = await supabase.from('offdays').insert({
        person_type, person_email: person_email.trim().toLowerCase(),
        person_name: person_name || null, off_from, off_to,
        created_by: user.email || null
      }).select().single();
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, data });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.patch('/offdays-crud', async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      const supabase = getSupa();
      const { id, off_from, off_to } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });
      const update = {};
      if (off_from) update.off_from = off_from;
      if (off_to) update.off_to = off_to;
      const { data, error } = await supabase.from('offdays').update(update).eq('id', id).select().single();
      if (error) return res.status(400).json({ error: error.message });
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

      const { error } = await supabase.from('offdays').delete().eq('id', id);
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });
};
