// migrated from netlify/functions/assigned-owners-today.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  function bangkokTodayRangeISO() {
    const nowBkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const y = nowBkk.getFullYear(), m = String(nowBkk.getMonth() + 1).padStart(2, '0'), d = String(nowBkk.getDate()).padStart(2, '0');
    const startISO = `${y}-${m}-${d}T00:00:00+07:00`;
    const tomorrow = new Date(nowBkk); tomorrow.setDate(nowBkk.getDate() + 1);
    const y2 = tomorrow.getFullYear(), m2 = String(tomorrow.getMonth() + 1).padStart(2, '0'), d2 = String(tomorrow.getDate()).padStart(2, '0');
    const endISO = `${y2}-${m2}-${d2}T00:00:00+07:00`;
    return { startISO, endISO };
  }

  app.get('/assigned-owners-today', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.split(' ')[1];
      if (!token) return res.status(401).json({ ok: false, error: 'No token' });

      const supa = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
      const { data: userData, error: userErr } = await supa.auth.getUser(token);
      if (userErr || !userData?.user?.email) return res.status(401).json({ ok: false, error: 'Bad token' });
      const studentEmail = userData.user.email.toLowerCase();

      const { startISO, endISO } = bangkokTodayRangeISO();
      const { data, error } = await supa.from('meeting_assigned').select('owner_email').eq('student_email', studentEmail).gte('assigned_date', startISO).lt('assigned_date', endISO);
      if (error) throw error;

      const owners = Array.from(new Set((data || []).map(r => String(r.owner_email || '').toLowerCase()).filter(Boolean)));
      return res.json({ ok: true, owners });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
};
