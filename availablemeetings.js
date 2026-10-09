const _DO = '/api';
let client;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// helper to show initials in avatar
function initialsFrom(name, email) {
  const src = (name || email || '').trim();
  if (!src) return 'T';
  const parts = src.split(/\s+/);
  const first = (parts[0] || '').charAt(0);
  const second = (parts[1] || (email || '').charAt(0) || '').charAt(0);
  return (first + second).toUpperCase();
}

function renderMeetingRow(row) {
  const name = escapeHtml(row.teacher_name || '');
  const email = escapeHtml(row.teacher_email || '');
  const initials = initialsFrom(row.teacher_name, row.teacher_email);
  const dt = row.created_at ? new Date(row.created_at).toLocaleString() : '';

  const chip = (url, label, icon) => {
    if (!url) return '';
    try {
      return `<a class="chip" href="${encodeURI(url)}" target="_blank" rel="noopener">
                <i class="fa-solid ${icon}" aria-hidden="true"></i>${label}
              </a>`;
    } catch { return ''; }
  };

  return `
    <div class="meeting-row">
      <div class="left">
        <div class="avatar" title="${name}">${initials}</div>
        <div class="meta">
          <div class="name">${name || '(No name)'}</div>
          <div class="email">${email}</div>
        </div>
      </div>

      <div class="links">
        ${chip(row.link_meeting, 'Meeting', 'fa-video')}
        ${chip(row.link_meeting_goc, 'Link gốc', 'fa-link')}
        ${chip(row.link_work_meeting, 'Work', 'fa-briefcase')}
        ${chip(row.link_goc_working_meeting, 'Work gốc', 'fa-link')}
      </div>

      <div class="date">${escapeHtml(dt)}</div>
    </div>`;
}


async function loadMeetingLinks(token) {
  const box = document.getElementById('meetingList');
  box.innerHTML = '<div class="empty-state">Loading…</div>';

  const res = await fetch(_DO + '/displaymeetinglink', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const out = await res.json().catch(() => ({}));

  if (!res.ok) {
    box.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(out?.error || res.statusText)}</div>`;
    return;
  }

  const rows = out.rows || [];
  box.innerHTML = rows.length
    ? rows.map(renderMeetingRow).join('')
    : '<div class="empty-state">No meeting links yet.</div>';
}

document.addEventListener('DOMContentLoaded', async () => {
  const msgEl = document.getElementById('message');

  try {
    // get Supabase creds
    const res = await fetch(_DO + '/supabase-credentials');
    if (!res.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();

    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
    });

    // must be logged in
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      msgEl.textContent = 'Bạn chưa đăng nhập. Vui lòng vào trang chính để đăng nhập.';
      document.getElementById('meetingList').innerHTML = '';
      return;
    }

    // load data
    await loadMeetingLinks(session.access_token);
  } catch (e) {
    msgEl.textContent = 'Error: ' + e.message;
  }
});