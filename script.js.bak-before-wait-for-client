/* -----------------------------------------------------------
   Supabase auth with session persistence across page refresh
   ----------------------------------------------------------- */
const _DO = '/api';

let client;

// Helper function to get a valid token, refreshing if needed
async function getValidToken() {
  if (!client) return null;

  try {
    // First try to get current session
    const { data: { session }, error } = await client.auth.getSession();

    if (error || !session?.access_token) {
      // Try to refresh the session
      const { data: refreshData, error: refreshError } = await client.auth.refreshSession();

      if (refreshError || !refreshData?.session?.access_token) {
        // Token is completely invalid, user needs to login again
        console.log('Token invalid, redirecting to login');
        await client.auth.signOut();
        return null;
      }

      return refreshData.session.access_token;
    }

    return session.access_token;
  } catch (err) {
    console.error('Error getting valid token:', err);
    return null;
  }
}

let appInitialized = false;    // prevents re-running showApp on token refresh
let hasLoadedMeetings = false; // prevents reloading the list on tab switch

let weekOffset = 0; // 0=this week, -1=previous, +1=next, etc.

let unconfirmedTeachersList = []; // Store unconfirmed teachers for popup
let unconfirmedStudentTeachersList = []; // Store teachers who haven't confirmed student list
let unconfirmedFHTeachersList = []; // Store teachers who haven't confirmed free hours

// Only Admin / Super Admin can edit/delete. Updated by initRoleBasedFab()
window.CAN_EDIT = false;

// Security key popup - returns a Promise that resolves true if key is valid
function askSecurityKey(actionName = 'this action') {
  return new Promise((resolve) => {
    // Remove any existing popup
    document.getElementById('securityPopup')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'securityPopup';
    overlay.className = 'security-overlay';
    overlay.innerHTML = `
      <div class="security-dialog" role="dialog" aria-modal="true" aria-labelledby="securityTitle">
        <div class="security-header">
          <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
          <h3 id="securityTitle">Security Verification</h3>
          <p>Please enter the security key to ${actionName}</p>
        </div>
        <div class="security-body">
          <div class="security-input-wrap">
            <input type="password" 
                   id="securityKeyInput" 
                   class="security-input" 
                   placeholder="Enter security key" 
                   autocomplete="off"
                   autocorrect="off"
                   autocapitalize="off"
                   spellcheck="false" />
          </div>
          <div id="securityError" class="security-error">
            <i class="fa-solid fa-circle-exclamation"></i> 
            <span id="securityErrorText">Invalid security key. Please try again.</span>
          </div>
        </div>
        <div class="security-footer">
          <button type="button" class="security-cancel" id="securityCancel">Cancel</button>
          <button type="button" class="security-submit" id="securitySubmit">
            <i class="fa-solid fa-unlock"></i> Verify
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#securityKeyInput');
    const errorBox = overlay.querySelector('#securityError');
    const errorText = overlay.querySelector('#securityErrorText');
    const submitBtn = overlay.querySelector('#securitySubmit');
    const cancelBtn = overlay.querySelector('#securityCancel');

    function cleanup(result) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') verifyKey();
    }

    async function verifyKey() {
      const key = input.value.trim();
      if (!key) {
        errorText.textContent = 'Please enter a security key.';
        errorBox.classList.add('show');
        input.focus();
        return;
      }

      // Show loading state
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="security-spinner"></span> Verifying...';
      errorBox.classList.remove('show');

      try {
        const { data: { session } } = await client.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          errorText.textContent = 'Please log in again.';
          errorBox.classList.add('show');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-unlock"></i> Verify';
          return;
        }

       const res = await fetch(_DO + '/verify-security-key', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ key })
        });

        const result = await res.json();

        if (result.ok && result.valid) {
          cleanup(true);
        } else {
          errorText.textContent = result.error || 'Invalid security key. Please try again.';
          errorBox.classList.add('show');
          input.value = '';
          input.focus();
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-unlock"></i> Verify';
        }
      } catch (err) {
        errorText.textContent = 'Connection error. Please try again.';
        errorBox.classList.add('show');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-unlock"></i> Verify';
      }
    }

    cancelBtn.addEventListener('click', () => cleanup(false));
    submitBtn.addEventListener('click', verifyKey);
    document.addEventListener('keydown', onKey);

    // Focus input after a tiny delay (for animation)
    setTimeout(() => input.focus(), 100);
  });
}



async function fetchWithRetry(url, retries = 3, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
  throw new Error('Failed after retries');
}

async function initSupabase() {
  const msgEl = document.getElementById('message');

  try {
    // Get credentials from your Netlify function (keeps service key server-only)
    msgEl.textContent = '';
   const res = await fetchWithRetry(_DO + '/supabase-credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();

    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: window.localStorage,
        detectSessionInUrl: true
      }
    });

    const { data: { session } } = await client.auth.getSession();
    if (session) {
      if (!appInitialized) {
        appInitialized = true;
        showApp(session);
      }
    } else {
      showLogin();
    }


    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        appInitialized = false;
        hasLoadedMeetings = false;
        return showLogin();
      }
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        if (!appInitialized && session) {
          appInitialized = true;
          return showApp(session);
        }
      }
      // Ignore TOKEN_REFRESHED, USER_UPDATED, etc.
    });


  } catch (err) {
    console.error(err);
    msgEl.innerHTML = 'Không thể kết nối. <a href="#" id="retryConnect" style="color:#2563eb;text-decoration:underline;">Thử lại</a>';
    showLogin();
    document.getElementById('retryConnect')?.addEventListener('click', (e) => {
      e.preventDefault();
      msgEl.textContent = 'Đang kết nối lại…';
      initSupabase();
    });
  }
}

/* --------------- Toggle password visibility --------------- */
function setupPasswordToggle() {
  const toggle = document.getElementById('togglePwd');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
  });
}

/* ---------------- Login handler ---------------- */
function setupLoginHandler() {
  const btn = document.getElementById('login');
  if (!btn) return;

  const submit = async () => {
    const msgEl = document.getElementById('message');
    msgEl.textContent = '';

    if (!client) {
      msgEl.textContent = 'Supabase đang khởi tạo, vui lòng đợi…';
      return;
    }

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      msgEl.textContent = 'Vui lòng điền đầy đủ thông tin.';
      msgEl.className = 'error';
      return;
    }

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      msgEl.textContent = error.message;
      msgEl.className = 'error';
    } else {
      msgEl.textContent = '';
    }
  };

  btn.addEventListener('click', submit);
  document.getElementById('loginCard')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

}


/* ---------------- UI helpers ---------------- */
async function showApp(session) {
  // Hide login card
  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'none';

  document.body.classList.add('app');

  document.getElementById('fabStudent')?.remove();


  // NEW: make sure the main UI is visible (it may be hidden by showLogin)
  const work = document.getElementById('workMeetings');
  if (work) work.style.display = '';

  // (optional) also reveal the week nav
  document.getElementById('weekNav')?.removeAttribute('hidden');

  setupWeekNav(); // show + wire week navigator


  setupWeekNav(); // show + wire week navigator


  // Make/logout button if missing
  let btn = document.getElementById('logoutBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'logoutBtn';
    btn.className = 'logout-icon';
    btn.addEventListener('click', async () => {
      await client.auth.signOut();
    });
    btn.innerHTML = '<i class="fa-solid fa-power-off" aria-hidden="true"></i>';
    btn.title = 'Log out';
    btn.setAttribute('aria-label', 'Log out');
    document.body.appendChild(btn);
  }

  // Only show the + and Work-meeting FABs for allowed roles
  await initRoleBasedFab(session);



  // Load the Work Meetings list once
  if (!hasLoadedMeetings) {
    hasLoadedMeetings = true;
    loadWorkMeetings().catch(console.error);
  }


}


function removeFabAndModal() {
  const fab = document.getElementById('fabAdd');
  if (fab) fab.remove();
  const modal = document.getElementById('fabModal');
  if (modal) modal.remove();

  // Remove the working-meeting FAB + modal
  const fab2 = document.getElementById('fabAddWorking');
  if (fab2) fab2.remove();
  const modal2 = document.getElementById('workingModal');
  if (modal2) modal2.remove();

  // NEW: remove the Student Meeting FAB
  const fabStudent = document.getElementById('fabStudent');
  if (fabStudent) fabStudent.remove();

  // Remove the Confirmation FAB + modal
  const fabConfirm = document.getElementById('fabConfirm');
  if (fabConfirm) fabConfirm.remove();
  const confirmModal = document.getElementById('confirmCalendarModal');
  if (confirmModal) confirmModal.remove();
}



async function initRoleBasedFab(session) {
  let token = session?.access_token;

  if (!token) {
    token = await getValidToken();
    if (!token) return;
  }

  try {
    let res = await fetch(_DO + '/check-role', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });

    // Retry once if token error
    if (!res.ok && res.status === 401) {
      const newToken = await getValidToken();
      if (!newToken) return;
      res = await fetch(_DO + '/check-role', {
        method: 'GET',
        headers: { Authorization: `Bearer ${newToken}` }
      });
    }

    if (!res.ok) {
      console.error('check-role failed', res.status);
      return;
    }

    const { allowed, role } = await res.json();

    // remember my email for self-only checks
    const { data: { user } } = await client.auth.getUser();
    window.MY_EMAIL = String(user?.email || '').toLowerCase();


    // Only these roles may view the main page
    const viewOK = ['teacher', 'admin', 'super admin'].includes(String(role || '').toLowerCase());
    if (!viewOK) {
      showMsg('Bạn không có quyền truy cập trang này.', 'error');
      await client.auth.signOut(); // kicks back to login
      return;
    }

    // NEW: user is allowed → reveal the UI (in case it was hidden on login)
    document.getElementById('weekNav')?.removeAttribute('hidden');
    const workEl = document.getElementById('workMeetings');
    if (workEl) workEl.style.display = '';

    // Only Admin / Super Admin can edit
    const roleLower = String(role || '').toLowerCase();

    // Admin/Super Admin can edit/delete
    window.CAN_EDIT = ['admin', 'super admin'].includes(roleLower);

    // Teacher + Admin + Super Admin can Assign/Offday
    window.CAN_ASSIGN_OR_OFFDAY = ['teacher', 'admin', 'super admin'].includes(roleLower);




    // Always wire the Assign popup so Teacher/Admin/Super Admin can use it
    setupAssignModal();
    setupTransferModal();

    // Setup Confirmation button for all teachers/admins
    // Removed - confirmation is now in sidebar
    // if (window.CAN_ASSIGN_OR_OFFDAY) {
    //   setupConfirmationFab();
    // }

    // Only Admin / Super Admin get the + FABs
    if (allowed) {
      setupFabModal();          // existing + button (left)
      setupWorkingFabModal();   // working-meeting button (right)
      document.body.classList.add('has-add-fab'); // Add class so CSS can position confirm FAB higher
    } else {
      document.body.classList.remove('has-add-fab'); // Remove class so confirm FAB stays at bottom
    }

    // Re-render roster so actions appear after permission check
    if (hasLoadedMeetings) loadWorkMeetings();

    // Show admin section in sidebar if user is admin
    showSidebarAdminSection();

  } catch (e) {
    console.error('check-role error', e);
  }
}

function showLogin() {
  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'block';

  document.body.classList.remove('app');

  const nav = document.getElementById('weekNav');
  if (nav) nav.hidden = true;

  // NEW: hide/clear the main content
  const work = document.getElementById('workMeetings');
  if (work) {
    work.innerHTML = '';
    work.style.display = 'none';
  }

  const btn = document.getElementById('logoutBtn');
  if (btn) btn.remove();

  removeFabAndModal();

  const email = document.getElementById('email');
  if (email) email.focus();
}



/* ---------- FAB + Modal ---------- */
function setupFabModal() {
  // Create FAB if missing
  let fab = document.getElementById('fabAdd');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'fabAdd';
    fab.className = 'fab';
    fab.title = 'Add';
    fab.setAttribute('aria-label', 'Add');
    fab.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
    document.body.appendChild(fab);
  }

  // Create modal if missing
  let modal = document.getElementById('fabModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fabModal';
    modal.className = 'modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-overlay" id="fabOverlay"></div>

      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <!-- Saving overlay (hidden by default) -->
  <div id="savingOverlay" class="saving-overlay" hidden>
    <div class="saving-box">
      <div class="spinner"></div>
      <div class="saving-label">Đang lưu…</div>
    </div>
  </div>

        <div class="modal-header">
          <h3 id="modalTitle">Quick Action</h3>
          <button class="icon-btn" id="modalClose" aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label for="teacherEmail">Teacher Email</label>
            <input type="text" id="teacherEmail" class="input" placeholder="Type at least 4 characters..." autocomplete="off" />
            <div id="emailSuggestions" class="suggestions" role="listbox" aria-label="Email suggestions"></div>
            <p class="hint">Start typing an email (≥ 4 chars). Suggestions appear after 1s.</p>
          </div>

          <div class="form-group">
            <label for="teacherName">Teacher Name</label>
            <input type="text" id="teacherName" class="input" placeholder="Auto-filled" readonly />
          </div>

          <div class="form-group">
            <label for="meetingHv">Meeting tiếp HV</label>
            <input type="text" id="meetingHv" class="input" placeholder="Nhập nội dung..." />
            <div class="form-subgroup">
              <label for="meetingHvLink" class="sub-label">Link gốc</label>
              <input type="url" id="meetingHvLink" class="input" placeholder="Dán link gốc…" inputmode="url" />
            </div>
          </div>

          <div class="form-group">
            <label for="meetingWork">Meeting Work</label>
            <input type="text" id="meetingWork" class="input" placeholder="Nhập nội dung..." />
            <div class="form-subgroup">
              <label for="meetingWorkLink" class="sub-label">Link gốc</label>
              <input type="url" id="meetingWorkLink" class="input" placeholder="Dán link gốc…" inputmode="url" />
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-ghost" id="modalCancel">Close</button>
          <button class="btn-primary" id="modalSave">
            <i class="fa-solid fa-floppy-disk"></i> Save
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);
  }


  if (modal.dataset.wired === 'true') return; // prevent double wiring

  const overlay = modal.querySelector('#fabOverlay');
  const closeBtn = modal.querySelector('#modalClose');
  const cancelBtn = modal.querySelector('#modalCancel');
  const saveBtn = modal.querySelector('#modalSave');

  // --- Email suggestions + auto-fill name ---
  const emailInput = modal.querySelector('#teacherEmail');
  const nameInput = modal.querySelector('#teacherName');
  const sugBox = modal.querySelector('#emailSuggestions');
  let debounceId;

  function renderSuggestions(list) {
    if (!Array.isArray(list) || list.length === 0) {
      sugBox.innerHTML = '';
      sugBox.style.display = 'none';
      return;
    }
    sugBox.innerHTML = list
      .map(email => `<div class="suggestion-item" role="option" data-email="${email}">
        <i class="fa-solid fa-user"></i> ${email}
      </div>`)
      .join('');
    sugBox.style.display = 'block';
  }

  // Debounced suggestions (1s) only when ≥4 chars
  emailInput.addEventListener('input', () => {
    const q = emailInput.value.trim();
    clearTimeout(debounceId);

    if (q.length < 4) {
      renderSuggestions([]);
      return;
    }

    debounceId = setTimeout(async () => {
      try {
        const { data: { session } } = await client.auth.getSession();
        const token = session?.access_token;
        if (!token) return;

        const res = await fetch(`${_DO}/teachers-search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) return renderSuggestions([]);
        const { suggestions } = await res.json();
        renderSuggestions(suggestions || []);
      } catch {
        renderSuggestions([]);
      }
    }, 1000);
  });

  // Pick a suggestion → fill email → fetch name
  sugBox.addEventListener('click', async (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;

    const email = item.dataset.email;
    emailInput.value = email;
    renderSuggestions([]);

    try {
      const { data: { session } } = await client.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const r = await fetch(`${_DO}/teacher-by-email?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return;
      const { full_name } = await r.json();
      nameInput.value = full_name || '';
    } catch { /* ignore */ }
  });

  // If user types full email and leaves the field, try to fetch name
  emailInput.addEventListener('blur', async () => {
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) return;
    try {
      const { data: { session } } = await client.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const r = await fetch(`${_DO}/teacher-by-email?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return;
      const { full_name } = await r.json();
      nameInput.value = full_name || '';
    } catch { /* ignore */ }
  });

  // Close suggestions when clicking outside the content area
  modal.addEventListener('click', (ev) => {
    const inside = ev.target.closest('.modal-content');
    if (!inside) renderSuggestions([]);
  });

  const open = () => { modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); };
  const close = () => { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); };

  fab.addEventListener('click', async () => {
    const verified = await askSecurityKey('add a meeting');
    if (!verified) return;
    open();
    emailInput?.focus();
  });

  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  // ESC to close
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Placeholder save handler
  saveBtn.addEventListener('click', async () => {
    const savingOverlay = document.getElementById('savingOverlay');

    // Disable button + show overlay immediately
    saveBtn.disabled = true;
    savingOverlay?.removeAttribute('hidden');

    try {
      const data = {
        teacherEmail: modal.querySelector('#teacherEmail')?.value?.trim() || '',
        teacherName: modal.querySelector('#teacherName')?.value?.trim() || '',
        meetingHv: modal.querySelector('#meetingHv')?.value?.trim() || '',
        meetingHvLink: modal.querySelector('#meetingHvLink')?.value?.trim() || '',
        meetingWork: modal.querySelector('#meetingWork')?.value?.trim() || '',
        meetingWorkLink: modal.querySelector('#meetingWorkLink')?.value?.trim() || '',
      };

      // Get the logged-in user's token to prove who is saving
      const { data: sessionData } = await client.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('No session. Please log in again.');

      // Call your Netlify function to insert into DB
      const res = await fetch(_DO + '/addmeeting', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(data)
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) {
        throw new Error(out?.error || res.statusText || 'Save failed');
      }

      // Success UI
      close();
      const msg = document.getElementById('message');
      if (msg) {
        msg.textContent = 'Saved!';
        msg.className = 'success';
        setTimeout(() => { msg.textContent = ''; msg.className = ''; }, 1400);

        loadWorkMeetings(); // refresh list on the main page

      }
    } catch (err) {
      const msg = document.getElementById('message');
      if (msg) {
        msg.textContent = String(err?.message || err);
        msg.className = 'error';
      }
    } finally {
      // Always hide overlay + re-enable button
      savingOverlay?.setAttribute('hidden', '');
      saveBtn.disabled = false;
    }
  });



}

/* ---------- Working Meeting FAB + Popup ---------- */
/* ---------- Working Meeting FAB + Popup (enhanced) ---------- */
function setupWorkingFabModal() {
  // 1) Create the right-side FAB if missing
  let fab = document.getElementById('fabAddWorking');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'fabAddWorking';
    fab.className = 'fab fab--right';
    fab.title = 'Add working meeting';
    fab.setAttribute('aria-label', 'Add working meeting');
    fab.innerHTML = '<i class="fa-solid fa-briefcase" aria-hidden="true"></i>';
    document.body.appendChild(fab);
  }

  // 2) Build modal UI
  let modal = document.getElementById('workingModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'workingModal';
    modal.className = 'modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-overlay" id="wmOverlay"></div>

      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="wmTitle">
        <!-- Saving overlay -->
        <div id="wmSaving" class="saving-overlay" hidden>
          <div class="saving-box">
            <div class="spinner"></div>
            <div class="saving-label">Đang lưu…</div>
          </div>
        </div>

        <div class="modal-header">
          <h3 id="wmTitle">Add work meeting</h3>
          <button class="icon-btn" id="wmClose" aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="modal-body">
          <!-- Teacher Email (typeahead ≥4 chars, 1s debounce) -->
          <div class="form-group">
            <label for="wmEmail">Teacher Email</label>
            <input type="email" id="wmEmail" class="input" placeholder="Type at least 4 characters…" autocomplete="off" />
            <div id="wmEmailSug" class="suggestions" role="listbox" aria-label="Email suggestions"></div>
            <p class="hint">Start typing (≥ 4 chars). Suggestions appear after 1s.</p>
          </div>

          <!-- Tên GV (auto-filled from meeting_links.teacher_name) -->
          <div class="form-group">
            <label for="wmName">Tên GV</label>
            <input type="text" id="wmName" class="input" placeholder="Auto-filled" readonly />
          </div>

          <!-- Meeting link (auto-filled from meeting_links.link_meeting) -->
          <div class="form-group">
            <label for="wmMeetingLink">Meeting link</label>
            <input type="url" id="wmMeetingLink" class="input" placeholder="Auto-filled (editable)" inputmode="url" />
          </div>

          <!-- Work_meeting (auto-filled from meeting_links.link_work_meeting) -->
          <div class="form-group">
            <label for="wmWorkMeeting">Work_meeting</label>
<input type="url" id="wmWorkMeeting" class="input" placeholder="Auto-filled (editable)" inputmode="url" />
</div>

<!-- Department -->
<div class="form-group">
  <label for="wmDept">Department</label>
  <select id="wmDept" class="input">
    <option value="">— Select —</option>
    <option value="TTKB">TTKB</option>
    <option value="Breakout">Breakout</option>
    <option value="BM">BM</option>
    <option value="Supporter">Supporter</option>
    <option value="Mix">Mix</option>
  </select>
</div>

<!-- Working date + time -->
<div class="form-row-3">
  <div class="form-group">
    <label for="wmDate">Working date</label>
    <input type="date" id="wmDate" class="input" required />
  </div>
  <div class="form-group">
    <label for="wmStart">Start time</label>
    <input type="time" id="wmStart" class="input" required />
  </div>
  <div class="form-group">
    <label for="wmEnd">End time</label>
    <input type="time" id="wmEnd" class="input" required />
  </div>
</div>

<!-- Repeat (weekly) -->
<div class="form-group">
  <label class="section-title">Repeat</label>
  <div class="switch-row">
    <span>Recurring (weekly)</span>
    <label class="switch">
      <input type="checkbox" id="wmRecurring" />
      <span class="slider"></span>
    </label>
  </div>
  <p class="hint">Turn on to repeat weekly. Off = one-time.</p>
</div>


<div class="modal-footer">
  <button class="btn-ghost" id="wmCancel">Close</button>
  <button class="btn-primary" id="wmSave">
    <i class="fa-solid fa-floppy-disk"></i> Add
  </button>
</div>

      </div>
    `;
    document.body.appendChild(modal);
  }

  // Prevent wiring twice
  if (modal.dataset.wired === 'true') return;

  // 3) Wire up open/close
  const open = () => {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    emailInput?.focus();

    // Prefill date/time nicely
    const d = modal.querySelector('#wmDate');
    const s = modal.querySelector('#wmStart');
    const e = modal.querySelector('#wmEnd');
    if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
    if (s && !s.value) s.value = '09:00';
    if (e && !e.value) e.value = '10:00';

  };
  const close = () => {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    clearTimeout(debounceId);
    renderSuggestions([]);

    // reset edit state back to default "Add"
    delete modal.dataset.editId;
    modal.querySelector('#wmTitle').textContent = 'Add work meeting';
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Add';
  };


  fab.addEventListener('click', async () => {
    const verified = await askSecurityKey('add a work meeting');
    if (!verified) return;
    open();
  });
  modal.querySelector('#wmOverlay').addEventListener('click', close);
  modal.querySelector('#wmClose').addEventListener('click', close);
  modal.querySelector('#wmCancel').addEventListener('click', close);

  // 4) Elements + helpers
  const emailInput = modal.querySelector('#wmEmail');
  const nameInput = modal.querySelector('#wmName');
  const meetInput = modal.querySelector('#wmMeetingLink');
  const workInput = modal.querySelector('#wmWorkMeeting');
  const sugBox = modal.querySelector('#wmEmailSug');
  const saveBtn = modal.querySelector('#wmSave');
  const savingLay = modal.querySelector('#wmSaving');
  const deptSelect = modal.querySelector('#wmDept');


  // Reuse the "Add work meeting" modal to edit an existing row
  window.openWorkMeetingModalInEditMode = (row) => {
    // tag modal as "editing"
    modal.dataset.editId = row.id;

    // prefill fields
    emailInput.value = row.teacher_email || '';
    nameInput.value = row.teacher_name || '';
    meetInput.value = row.meeting_link || '';
    workInput.value = row.work_meeting || '';

    modal.querySelector('#wmDate').value = row.work_date || '';
    modal.querySelector('#wmStart').value = String(row.start_time || '').slice(0, 5);
    modal.querySelector('#wmEnd').value = String(row.end_time || '').slice(0, 5);

    if (deptSelect) deptSelect.value = row.department || '';

    const rec = modal.querySelector('#wmRecurring');
    if (rec) rec.checked = !row.is_one_time;

    // tweak UI labels for edit mode
    modal.querySelector('#wmTitle').textContent = 'Edit work meeting';
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';

    // show the modal
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  };


  let debounceId;

  function renderSuggestions(list) {
    if (!Array.isArray(list) || list.length === 0) {
      sugBox.innerHTML = '';
      sugBox.style.display = 'none';
      return;
    }
    sugBox.innerHTML = list.map(email => `
      <div class="suggestion-item" role="option" data-email="${email}">
        <i class="fa-solid fa-user"></i> ${email}
      </div>`).join('');
    sugBox.style.display = 'block';
  }

  async function authToken() {
    const { data: { session } } = await client.auth.getSession();
    return session?.access_token || null;
  }

  // 5) Debounced (1s) suggestions from meeting_links.teacher_email
  emailInput.addEventListener('input', () => {
    const q = emailInput.value.trim();
    clearTimeout(debounceId);

    if (q.length < 4) {
      renderSuggestions([]);
      return;
    }

    debounceId = setTimeout(async () => {
      try {
        const token = await authToken();
        if (!token) return renderSuggestions([]);
        const res = await fetch(`${_DO}/meetinglinks-search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return renderSuggestions([]);
        const { suggestions } = await res.json();
        renderSuggestions(suggestions || []);
      } catch {
        renderSuggestions([]);
      }
    }, 1000);
  });

  // 6) Choose suggestion → fill + fetch details (name/links)
  sugBox.addEventListener('click', async (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    const email = item.dataset.email;
    emailInput.value = email;
    renderSuggestions([]);

    try {
      const token = await authToken();
      if (!token) return;
      const r = await fetch(`${_DO}/meetinglink-by-email?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return;
      const { teacher_name, link_meeting, link_work_meeting } = await r.json();
      nameInput.value = teacher_name || '';
      meetInput.value = link_meeting || '';
      workInput.value = link_work_meeting || '';
    } catch { /* ignore */ }
  });

  // 7) If user types full email and leaves field, try to fetch details
  emailInput.addEventListener('blur', async () => {
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) return;
    try {
      const token = await authToken();
      if (!token) return;
      const r = await fetch(`${_DO}/meetinglink-by-email?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return;
      const { teacher_name, link_meeting, link_work_meeting } = await r.json();
      nameInput.value = teacher_name || '';
      meetInput.value = link_meeting || '';
      workInput.value = link_work_meeting || '';
    } catch { /* ignore */ }
  });

  // Close suggestions when clicking outside the content area
  modal.addEventListener('click', (ev) => {
    const inside = ev.target.closest('.modal-content');
    if (!inside) renderSuggestions([]);
  });

  // ESC to close
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // 8) Save → call serverless addworkmeeting
  saveBtn.addEventListener('click', async () => {
    const isRecurring = !!modal.querySelector('#wmRecurring')?.checked;

    const payload = {
      teacherEmail: emailInput.value.trim(),
      teacherName: nameInput.value.trim(),
      meetingLink: meetInput.value.trim(),
      workMeeting: workInput.value.trim(),
      workDate: modal.querySelector('#wmDate').value,   // YYYY-MM-DD
      startTime: modal.querySelector('#wmStart').value,  // HH:MM
      endTime: modal.querySelector('#wmEnd').value,    // HH:MM
      isOneTime: !isRecurring,
      department: (deptSelect?.value || '').trim(),

    };




    if (!payload.teacherEmail) return showMsg('Please choose a teacher email first.', 'error');
    if (!payload.workDate || !payload.startTime || !payload.endTime) {
      return showMsg('Please choose date, start time and end time.', 'error');
    }
    if (payload.startTime >= payload.endTime) {
      return showMsg('End time must be later than start time.', 'error');
    }

    const confirmMsg = isRecurring
      ? 'Bạn có chắc đây là lịch lặp lại hàng tuần?'
      : 'Bạn có chắc lịch này không lặp lại hàng tuần?';

    // prevent double-click stacking while confirm is open
    saveBtn.disabled = true;
    const ok = await confirmBox(confirmMsg);
    saveBtn.disabled = false;
    if (!ok) return;



    if (!payload.teacherEmail) {
      const msg = document.getElementById('message');
      if (msg) { msg.textContent = 'Please choose a teacher email first.'; msg.className = 'error'; }
      return;
    }

    try {
      saveBtn.disabled = true;
      savingLay?.removeAttribute('hidden');

      const token = await authToken();
      if (!token) throw new Error('No session. Please log in again.');

      let endpoint = _DO + '/addworkmeeting';
      let method = 'POST';
      if (modal.dataset.editId) {
        // edit mode → send id and switch to editcalendar
        payload.id = modal.dataset.editId;
        endpoint = _DO + '/editcalendar';
        method = 'PUT';
      }

      const res = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });


const out = await res.json().catch(() => ({}));

      // --- Handle overlap warning ---
      if (out?.overlap && out?.conflicts?.length) {
        savingLay?.setAttribute('hidden', '');
        saveBtn.disabled = false;
        const force = await overlapWarningPopup(out.conflicts);
        if (!force) return;
        // Re-send with forceOverlap flag
        saveBtn.disabled = true;
        savingLay?.removeAttribute('hidden');
        payload.forceOverlap = true;
        const res2 = await fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        const out2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !out2?.ok) throw new Error(out2?.error || 'Save failed');
        close();
        const msg2 = document.getElementById('message');
        if (msg2) {
          msg2.textContent = 'Saved!';
          msg2.className = 'success';
          setTimeout(() => { msg2.textContent = ''; msg2.className = ''; }, 1400);
          loadWorkMeetings();
        }
        return;
      }

      if (!res.ok || !out?.ok) throw new Error(out?.error || 'Save failed');

      close();
      const msg = document.getElementById('message');
      if (msg) {
        msg.textContent = 'Saved!';
        msg.className = 'success';
        setTimeout(() => { msg.textContent = ''; msg.className = ''; }, 1400);
        loadWorkMeetings(); // refresh list on the main page
      }
    } catch (err) {
      const msg = document.getElementById('message');
      if (msg) { msg.textContent = String(err?.message || err); msg.className = 'error'; }
    } finally {
      savingLay?.setAttribute('hidden', '');
      saveBtn.disabled = false;
    }
  });

  modal.dataset.wired = 'true';

}


function showMsg(text, type) {
  const msg = document.getElementById('message');
  if (msg) { msg.textContent = text; msg.className = type || ''; }
}


// --- Global loading overlay (full screen) ---
function showLoadingOverlay(text = 'Đang tải…') {
  if (document.getElementById('globalLoadingOverlay')) return;
  const ov = document.createElement('div');
  ov.id = 'globalLoadingOverlay';
  ov.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:12000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.35)'
  ].join(';');
  ov.innerHTML = `
    <div style="background:#fff;padding:14px 18px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);display:flex;gap:12px;align-items:center;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:26px;"></i>
      <div style="font-weight:600">${text}</div>
    </div>`;
  document.body.appendChild(ov);
}
function hideLoadingOverlay() {
  document.getElementById('globalLoadingOverlay')?.remove();
}

// --- Overlap Warning Popup ---
function overlapWarningPopup(conflicts) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const hasAdjacent = conflicts.some(c => c.conflictType === 'adjacent');
    const hasOverlap = conflicts.some(c => c.conflictType !== 'adjacent');

    let listHtml = conflicts.map(c => {
      const type = c.isRecurring ? '🔁 Recurring' : '📅 One-time';
      const dept = c.department ? ` • ${c.department}` : '';
      const badge = c.conflictType === 'adjacent'
        ? '<span class="overlap-badge adjacent">Adjacent</span>'
        : '<span class="overlap-badge overlapping">Overlapping</span>';
      return `<div class="overlap-item">
        <div class="overlap-item-time">
          <i class="fa-regular fa-clock"></i>
          <strong>${c.startTime} – ${c.endTime}</strong>
          ${badge}
        </div>
        <div class="overlap-item-meta">${type} • ${c.date}${dept}</div>
      </div>`;
    }).join('');

    // Pick icon and title based on conflict type
    let iconClass, iconBg, iconColor, title, desc;
    if (hasAdjacent && !hasOverlap) {
      iconClass = 'fa-solid fa-link';
      iconBg = '#dbeafe';
      iconColor = '#3b82f6';
      title = 'Back-to-Back Schedule Detected';
      desc = `This teacher has ${conflicts.length > 1 ? conflicts.length + ' schedules' : 'a schedule'} that starts/ends exactly when this new one does. Consider <strong>editing the existing schedule</strong> to extend it instead of creating a new one.`;
    } else {
      iconClass = 'fa-solid fa-triangle-exclamation';
      iconBg = '#fef3c7';
      iconColor = '#f59e0b';
      title = 'Schedule Overlap Detected';
      desc = `This teacher already has ${conflicts.length > 1 ? conflicts.length + ' schedules' : 'a schedule'} that conflicts with the new one:`;
    }

    overlay.innerHTML = `
      <div class="overlap-dialog" role="dialog" aria-modal="true">
        <div class="overlap-icon-wrap" style="background:${iconBg}">
          <i class="${iconClass}" style="color:${iconColor}"></i>
        </div>
        <h4 class="overlap-title">${title}</h4>
        <p class="overlap-desc">${desc}</p>
        <div class="overlap-list">${listHtml}</div>
        <p class="overlap-question">${hasAdjacent && !hasOverlap ? 'Save as separate schedule anyway?' : 'Do you still want to save?'}</p>
        <div class="overlap-actions">
          <button class="btn-ghost" id="ovlCancel"><i class="fa-solid fa-xmark"></i> ${hasAdjacent && !hasOverlap ? 'Go Back & Edit' : 'Cancel'}</button>
          <button class="btn-warning" id="ovlForce"><i class="fa-solid fa-check"></i> Save Anyway</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') cleanup(false); }
    function cleanup(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('#ovlCancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#ovlForce').addEventListener('click', () => cleanup(true));
    document.addEventListener('keydown', onKey);
  });
}

// Pretty confirm popup that returns a Promise<boolean>
function confirmBox(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <h4 id="confirmTitle" class="confirm-title">Xác nhận</h4>
        <div class="confirm-message">${message}</div>
        <div class="confirm-actions">
          <button class="btn-ghost" id="cfCancel">Hủy</button>
          <button class="btn-primary" id="cfOk">Đồng ý</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') cleanup(false); }

    function cleanup(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('#cfCancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#cfOk').addEventListener('click', () => cleanup(true));
    document.addEventListener('keydown', onKey);

});
}

// Popup to pick which session when a multi-slot pill is clicked
function pickSessionPopup(pill, actionLabel) {
  return new Promise((resolve) => {
    const slots = pill.querySelectorAll('.pill__time-slot');
    if (!slots.length) {
      resolve(pill.dataset.rowId || null);
      return;
    }

    const teacherName = pill.dataset.teacherName || '';
    const initials = wmInitials(teacherName);
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    let optionsHtml = '';
    slots.forEach((slot) => {
      const rowId = slot.dataset.rowId;
      const start = slot.dataset.startTime || '';
      const end = slot.dataset.endTime || '';
      optionsHtml += `<button class="sp-option" data-pick-id="${rowId}">
        <span class="sp-option-icon"><i class="fa-regular fa-clock"></i></span>
        <span class="sp-option-time">${start}\u2013${end}</span>
        <span class="sp-option-arrow"><i class="fa-solid fa-chevron-right"></i></span>
      </button>`;
    });

    const isDelete = actionLabel === 'delete';
    const iconClass = isDelete ? 'fa-trash' : 'fa-pen';
    const accentColor = isDelete ? '#ef4444' : '#6366f1';

    overlay.innerHTML = `
      <div class="sp-dialog" role="dialog" aria-modal="true">
        <style>
          .sp-dialog {
            background: #fff; border-radius: 16px; padding: 0; width: 320px;
            max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,.18);
            animation: spSlideUp .25s ease; overflow: hidden;
          }
          @keyframes spSlideUp {
            from { opacity: 0; transform: translateY(16px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          .sp-header {
            padding: 20px 20px 14px; text-align: center;
            background: linear-gradient(135deg, ${accentColor}08, ${accentColor}15);
            border-bottom: 1px solid ${accentColor}18;
          }
          .sp-header-avatar {
            width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 10px;
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 16px; color: #fff;
            background: ${accentColor};
          }
          .sp-header h4 {
            margin: 0 0 2px; font-size: 15px; font-weight: 600; color: #1e293b;
          }
          .sp-header p {
            margin: 0; font-size: 13px; color: #94a3b8;
          }
          .sp-body { padding: 12px 16px 6px; }
          .sp-option {
            display: flex; align-items: center; gap: 12px; width: 100%;
            padding: 13px 14px; margin-bottom: 8px;
            border: 1.5px solid #e2e8f0; border-radius: 12px;
            background: #fff; cursor: pointer; transition: all .15s ease;
            font-size: 15px;
          }
          .sp-option:hover {
            border-color: ${accentColor}; background: ${accentColor}08;
            transform: translateY(-1px); box-shadow: 0 2px 8px ${accentColor}18;
          }
          .sp-option:active { transform: translateY(0); }
          .sp-option-icon {
            width: 36px; height: 36px; border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            background: ${accentColor}12; color: ${accentColor}; font-size: 15px;
          }
          .sp-option-time { font-weight: 600; color: #334155; flex: 1; }
          .sp-option-arrow { color: #cbd5e1; font-size: 12px; transition: color .15s; }
          .sp-option:hover .sp-option-arrow { color: ${accentColor}; }
          .sp-footer {
            padding: 8px 16px 16px; text-align: center;
          }
          .sp-cancel {
            background: none; border: none; color: #94a3b8; font-size: 14px;
            font-weight: 500; cursor: pointer; padding: 8px 20px; border-radius: 8px;
            transition: all .15s;
          }
          .sp-cancel:hover { color: #64748b; background: #f1f5f9; }
        </style>

        <div class="sp-header">
          <div class="sp-header-avatar">${wmEscape(initials)}</div>
          <h4>${wmEscape(teacherName)}</h4>
          <p>Select session to ${actionLabel}</p>
        </div>
        <div class="sp-body">
          ${optionsHtml}
        </div>
        <div class="sp-footer">
          <button class="sp-cancel" id="pickCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') cleanup(null); }

    function cleanup(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    overlay.querySelector('#pickCancel').addEventListener('click', () => cleanup(null));
    overlay.querySelectorAll('.sp-option').forEach(btn => {
      btn.addEventListener('click', () => cleanup(btn.dataset.pickId));
    });
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- Off Confirm Box with shift selection ---------- */
function offConfirmBox(defaultDate, teacherEmail, token) {
  return new Promise((resolve) => {
    const esc = (s) => String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const fmtDay = (ymd) => {
      const [y, m, d] = ymd.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return `${dayNames[dt.getDay()]} – ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
    };

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="off-popup" role="dialog" aria-modal="true">
        <div class="off-popup__header">
          <i class="fa-solid fa-moon"></i>
          <span>Đánh dấu nghỉ</span>
          <button class="off-popup__x" id="offPopupClose" aria-label="Đóng">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="off-popup__body">
          <!-- Step 1: Two choices -->
          <div id="offStep1">
            <button class="off-popup__card off-popup__card--quick" id="offQuick">
              <div class="off-popup__card-icon off-popup__card-icon--quick">
                <i class="fa-solid fa-bolt"></i>
              </div>
              <div class="off-popup__card-text">
                <div class="off-popup__card-title">Nghỉ ca này</div>
                <div class="off-popup__card-desc">Chỉ OFF ca này, không ảnh hưởng ca khác</div>
              </div>
              <i class="fa-solid fa-chevron-right off-popup__card-arrow"></i>
            </button>

            <button class="off-popup__card off-popup__card--range" id="offRangeBtn">
              <div class="off-popup__card-icon off-popup__card-icon--range">
                <i class="fa-solid fa-calendar-week"></i>
              </div>
              <div class="off-popup__card-text">
                <div class="off-popup__card-title">Chọn ngày nghỉ</div>
                <div class="off-popup__card-desc">Chọn khoảng ngày, sau đó chọn từng ca cần OFF</div>
              </div>
              <i class="fa-solid fa-chevron-right off-popup__card-arrow"></i>
            </button>
          </div>

          <!-- Step 2: Date range + search -->
          <div id="offStep2" style="display:none">
<div class="off-popup__range" style="display:flex">
              <div class="off-popup__range-row">
                <label class="off-popup__label"><i class="fa-solid fa-play" style="font-size:0.6rem"></i> Từ ngày</label>
                <input type="date" id="offDetailFrom" class="off-popup__date" />
              </div>
              <div class="off-popup__range-row">
                <label class="off-popup__label"><i class="fa-solid fa-stop" style="font-size:0.6rem"></i> Đến ngày</label>
                <input type="date" id="offDetailTo" class="off-popup__date" />
              </div>
              <div class="off-popup__range-actions">
                <button class="off-popup__confirm-range" id="offConfirmRange">
                  <i class="fa-solid fa-check"></i> Xác nhận nghỉ
                </button>
                <button class="off-popup__search-btn" id="offSearchShifts">
                  <i class="fa-solid fa-magnifying-glass"></i> Tra cứu
                </button>
              </div>
            </div>
          </div>

          <!-- Step 3: Shift list -->
          <div id="offStep3" style="display:none">
            <div class="off-popup__selectall">
              <label>
                <input type="checkbox" id="offSelectAll" checked> Chọn tất cả
              </label>
            </div>
            <div id="offShiftList" class="off-popup__shifts"></div>
            <button class="off-popup__confirm" id="offConfirmShifts">
              <i class="fa-solid fa-check"></i> Xác nhận nghỉ
            </button>
          </div>

          <!-- Back button -->
          <button id="offBackBtn" class="off-popup__back" style="display:none">
            <i class="fa-solid fa-arrow-left"></i> Quay lại
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const step1 = overlay.querySelector('#offStep1');
    const step2 = overlay.querySelector('#offStep2');
    const step3 = overlay.querySelector('#offStep3');
    const backBtn = overlay.querySelector('#offBackBtn');
    const fromInput = overlay.querySelector('#offDetailFrom');
    const toInput = overlay.querySelector('#offDetailTo');
    const shiftList = overlay.querySelector('#offShiftList');
    const selectAllCb = overlay.querySelector('#offSelectAll');

    if (defaultDate) {
      fromInput.value = defaultDate;
      // Default "to" date = 4 weeks from today
      const fourWeeksLater = new Date();
      fourWeeksLater.setDate(fourWeeksLater.getDate() + 27); // 4 weeks = 28 days including today
      toInput.value = fourWeeksLater.toISOString().slice(0, 10);
    }

function goStep(n) {
      step1.style.display = n === 1 ? 'flex' : 'none';
      step2.style.display = n === 2 ? 'block' : 'none';
      step3.style.display = n === 3 ? 'block' : 'none';
      backBtn.style.display = n > 1 ? 'flex' : 'none';
      backBtn.onclick = () => goStep(n === 3 ? 2 : 1);
      const popup = overlay.querySelector('.off-popup');
      if (n === 3) popup.classList.add('expanded');
      else popup.classList.remove('expanded');
    }

    function onKey(e) { if (e.key === 'Escape') cleanup(null); }
    function cleanup(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    overlay.querySelector('#offPopupClose').addEventListener('click', () => cleanup(null));

    // Option 1: Quick off
    overlay.querySelector('#offQuick').addEventListener('click', () => {
      cleanup({ ok: true, detailed: false });
    });

    // Option 2: Show date picker
    overlay.querySelector('#offRangeBtn').addEventListener('click', () => goStep(2));

    // Confirm date range directly (off all shifts in range)
    overlay.querySelector('#offConfirmRange').addEventListener('click', async () => {
      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) {
        fromInput.style.borderColor = !from ? '#ef4444' : '';
        toInput.style.borderColor = !to ? '#ef4444' : '';
        return;
      }
      if (from > to) {
        fromInput.style.borderColor = '#ef4444';
        toInput.style.borderColor = '#ef4444';
        return;
      }

      // Fetch all shifts in range, then auto-select all
      shiftList.innerHTML = '<div style="text-align:center;padding:16px;color:#6b7280"><i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý…</div>';
      goStep(3);
      overlay.querySelector('.off-popup__selectall').style.display = 'flex';

      try {
        const res = await fetch(
          `${_DO}/teacher-shifts?email=${encodeURIComponent(teacherEmail)}&from=${from}&to=${to}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || 'Lỗi');

        const shifts = (out.shifts || []).filter(s => !s.already_off);

        if (!shifts.length) {
          shiftList.innerHTML = '<div style="text-align:center;padding:16px;color:#6b7280"><i class="fa-solid fa-check-circle" style="color:#22c55e"></i> Không có ca nào cần OFF.</div>';
          overlay.querySelector('#offConfirmShifts').style.display = 'none';
          return;
        }

// Show shifts in list (unchecked by default)
        let html = '';
        const grouped = {};
        for (const s of shifts) {
          (grouped[s.date] = grouped[s.date] || []).push(s);
        }
        for (const [date, dayShifts] of Object.entries(grouped)) {
          html += `<div class="off-popup__day-group">`;
          html += `<div class="off-popup__shift-header">${esc(fmtDay(date))}</div>`;
          for (const s of dayShifts) {
            const uid = 'off_' + s.meeting_content_id + '_' + s.date;
            html += `
              <label class="off-popup__shift-item" for="${uid}">
                <input type="checkbox" class="off-shift-cb" id="${uid}"
                  data-mcid="${s.meeting_content_id}" data-date="${s.date}"
                  data-email="${esc(s.teacher_email || teacherEmail)}"
                  data-start="${s.start_time}" data-end="${s.end_time}" />
               <span class="off-popup__shift-time">${esc(s.start_time)} – ${esc(s.end_time)}</span>
                ${s.department ? `<span class="off-popup__shift-dept">${esc(s.department)}</span>` : ''}
              </label>`;
          }
          html += `</div>`;
        }
        shiftList.innerHTML = html;
        selectAllCb.checked = false;
        overlay.querySelector('#offConfirmShifts').style.display = '';
      } catch (err) {
        shiftList.innerHTML = `<div style="text-align:center;padding:16px;color:#dc2626">Lỗi: ${esc(err.message)}</div>`;
      }
    });

    // Search shifts
    overlay.querySelector('#offSearchShifts').addEventListener('click', async () => {
      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) {
        fromInput.style.borderColor = !from ? '#ef4444' : '';
        toInput.style.borderColor = !to ? '#ef4444' : '';
        return;
      }
      if (from > to) {
        fromInput.style.borderColor = '#ef4444';
        toInput.style.borderColor = '#ef4444';
        return;
      }

      shiftList.innerHTML = '<div style="text-align:center;padding:16px;color:#6b7280"><i class="fa-solid fa-spinner fa-spin"></i> Đang tìm ca…</div>';
      goStep(3);

      try {
        const res = await fetch(
          `${_DO}/teacher-shifts?email=${encodeURIComponent(teacherEmail)}&from=${from}&to=${to}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || 'Lỗi');

        const shifts = (out.shifts || []).filter(s => !s.already_off);

        if (!shifts.length) {
          shiftList.innerHTML = '<div style="text-align:center;padding:16px;color:#6b7280"><i class="fa-solid fa-check-circle" style="color:#22c55e"></i> Không có ca nào cần OFF.</div>';
          overlay.querySelector('#offConfirmShifts').style.display = 'none';
          overlay.querySelector('.off-popup__selectall').style.display = 'none';
          return;
        }

        // Group by date
        const grouped = {};
        for (const s of shifts) {
          if (!grouped[s.date]) grouped[s.date] = [];
          grouped[s.date].push(s);
        }

let html = '';
        for (const date of Object.keys(grouped).sort()) {
          html += `<div class="off-popup__day-group">`;
          html += `<div class="off-popup__shift-header">${esc(fmtDay(date))}</div>`;
          for (const s of grouped[date]) {
            const uid = `off_${s.meeting_content_id}_${s.date}`;
            html += `
              <label class="off-popup__shift-item" for="${uid}">
                <input type="checkbox" id="${uid}" class="off-shift-cb"
                  data-mcid="${esc(s.meeting_content_id)}"
                  data-date="${esc(s.date)}"
                  data-email="${esc(s.teacher_email || teacherEmail)}"
                  data-start="${esc(s.start_time)}"
data-end="${esc(s.end_time)}" />
                <span class="off-popup__shift-time">${esc(s.start_time)} – ${esc(s.end_time)}</span>
                ${s.department ? `<span class="off-popup__shift-dept">${esc(s.department)}</span>` : ''}
              </label>`;
          }
          html += `</div>`;
        }
        shiftList.innerHTML = html;
        selectAllCb.checked = false;

      } catch (err) {
        shiftList.innerHTML = `<div style="text-align:center;padding:16px;color:#dc2626">Lỗi: ${esc(err.message)}</div>`;
      }
    });

    // Select all toggle
    selectAllCb.addEventListener('change', () => {
      shiftList.querySelectorAll('.off-shift-cb').forEach(cb => { cb.checked = selectAllCb.checked; });
    });

    // Confirm selected shifts
    overlay.querySelector('#offConfirmShifts').addEventListener('click', () => {
      const checked = shiftList.querySelectorAll('.off-shift-cb:checked');
      if (!checked.length) {
        alert('Vui lòng chọn ít nhất 1 ca.');
        return;
      }
      const selectedShifts = Array.from(checked).map(cb => ({
        meeting_content_id: cb.dataset.mcid,
        off_date: cb.dataset.date,
        teacher_email: cb.dataset.email,
        start_time: cb.dataset.start,
        end_time: cb.dataset.end
      }));
      const selectedDates = [...new Set(selectedShifts.map(s => s.off_date))].sort();
      cleanup({ ok: true, detailed: true, selectedShifts, selectedDates });
    });

    document.addEventListener('keydown', onKey);
  });
}

// Group sorted date strings into consecutive ranges
function groupConsecutiveDates(sortedDates) {
  if (!sortedDates.length) return [];
  const ranges = [];
  let start = sortedDates[0];
  let end = sortedDates[0];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(end + 'T00:00:00');
    const curr = new Date(sortedDates[i] + 'T00:00:00');
    if ((curr - prev) / 86400000 === 1) {
      end = sortedDates[i];
    } else {
      ranges.push({ from: start, to: end });
      start = sortedDates[i];
      end = sortedDates[i];
    }
  }
  ranges.push({ from: start, to: end });
  return ranges;
}

/* ---------- Work meetings list (reads via Netlify function) ---------- */
function wmEscape(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function wmInitials(nameOrEmail) {
  const src = (nameOrEmail || '').trim();
  if (!src) return 'T';
  const parts = src.split(/\s+/);
  const a = (parts[0] || src)[0] || '';
  const b = (parts[1] || src)[0] || '';
  return (a + b).toUpperCase();
}
function wmChip(url, label, icon) {
  if (!url) return '';
  try {
    if (!/^https?:\/\//i.test(url)) return '';
    return `<a class="chip" href="${encodeURI(url)}" target="_blank" rel="noopener noreferrer">
              <i class="fa-solid ${icon}" aria-hidden="true"></i>${label}
            </a>`;
  } catch { return ''; }
}

// Global map of teacher_email -> Jitsi tiep-hv URL (populated once per page load)
window.TIEP_HV_URLS = window.TIEP_HV_URLS || {};

// Fetch and cache the tiep-hv URL map
async function loadTiepHvUrls(token) {
  try {
    const res = await fetch(_DO + '/tiep-hv-all', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return;
    const map = await res.json();
    window.TIEP_HV_URLS = map || {};
  } catch (e) {
    console.error('[tiep-hv-all] fetch error:', e);
    window.TIEP_HV_URLS = {};
  }
}

// Render the camera icon for a teacher — either the Jitsi tiep-hv link or a warning
function wmTiepHvIcon(teacherEmail) {
  const key = (teacherEmail || '').trim().toLowerCase();
  const url = key ? (window.TIEP_HV_URLS || {})[key] : '';

  if (url) {
    const safe = encodeURI(url);
    return `
      <a class="pill__link pill__link--meet"
         href="${safe}"
         target="_blank"
         rel="noopener noreferrer"
         title="${wmEscape(url)}">
        <i class="fa-solid fa-video" aria-hidden="true"></i>
        <span class="sr-only">Open meeting link</span>
      </a>`;
  }

  // No tiep-hv row — show red warning triangle
  return `
    <span class="pill__link pill__link--warn"
          style="background:#fee2e2;color:#dc2626;cursor:help;"
          title="GV này chưa có meeting link — cần tạo trong trang Meetings">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="sr-only">Chưa có meeting link</span>
    </span>`;
}

function wmIconLink(url, icon, fallbackLabel) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  const safe = encodeURI(url);

  // Add a color variant class: video -> meet (blue), briefcase -> work (green)
  const variant =
    icon.includes('briefcase') ? 'pill__link--work' :
      icon.includes('video') ? 'pill__link--meet' :
        '';

  return `
    <a class="pill__link ${variant}"
       href="${safe}"
       target="_blank"
       rel="noopener noreferrer"
       title="${wmEscape(url)}">
      <i class="fa-solid ${icon}" aria-hidden="true"></i>
      <span class="sr-only">${wmEscape(fallbackLabel || 'Open link')}</span>
    </a>`;
}

// Map department → css class name for coloring the badge
function wmDeptClass(dept) {
  switch ((dept || '').toLowerCase()) {
    case 'ttkb': return 'dept--ttkb';
    case 'breakout': return 'dept--breakout';
    case 'bm': return 'dept--bm';
    case 'supporter': return 'dept--supporter';
    case 'mix': return 'dept--mix';
    default: return 'dept--default';
  }
}


function wmTimeHHMM(t) { return (t || '').slice(0, 5); }
function wmDateVN(dYmd) {
  try {
    const [y, m, d] = (dYmd || '').split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return dYmd || ''; }
}


/* ---------- Roster helpers (Mon→Sun × Morning/Afternoon/Evening) ---------- */
const ROSTER_SHIFTS = [
  { key: 'morning', start: '08:00', end: '12:00', label: 'Morning 08:00–12:00' },
  { key: 'afternoon', start: '15:00', end: '18:00', label: 'Afternoon 15:00–18:00' },
  { key: 'evening', start: '18:00', end: '21:00', label: 'Evening 18:00–21:00' },
];

// OLD
// const ROSTER_DAY_NAMES = [null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// NEW (abbreviated)
const ROSTER_DAY_NAMES = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeekLocal(d, mondayAsFirst = 1) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = dt.getDay(); // 0=Sun..6=Sat
  // Convert to Monday=0..Sunday=6
  const shift = (dow + 6) % 7;
  dt.setDate(dt.getDate() - shift);
  return dt; // Monday 00:00 local
}

function isSameWeek(ymd, weekStart) {
  if (!ymd) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  const ws = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const we = new Date(ws); we.setDate(ws.getDate() + 7);
  return t >= ws && t < we;
}

function rosterDayIndex(ymd) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return ((t.getDay() + 6) % 7) + 1; // 1..7 with Monday=1
}

function minutesFromHHMM(hhmm) {
  const [h, i] = String(hhmm || '0:0').split(':').map(Number);
  return (h * 60) + (i || 0);
}
function overlapMins(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}
// Bucket by START TIME only:
// <12:00 => morning, 12:00–17:59 => afternoon, >=18:00 => evening
function whichShift(startHHMM /*, endHHMM not needed */) {
  const s = minutesFromHHMM(startHHMM || '00:00');
  if (s >= minutesFromHHMM('18:00')) return 'evening';
  if (s >= minutesFromHHMM('12:00')) return 'afternoon';
  return 'morning';
}

// Expand weekly-recurring rows to the CURRENT displayed week
// and deduplicate by (teacher + date + start + end)
function expandRecurringForWeek(rows, weekStart) {
  const expanded = [];
  for (const r of rows) {
    if (r && r.is_one_time === false) {
      // keep same weekday, but move to this week's date
      const di = rosterDayIndex(r.work_date);            // 1..7 (Mon..Sun)
      const tgt = new Date(weekStart); tgt.setDate(tgt.getDate() + (di - 1));
      expanded.push({ ...r, work_date: formatYMD(tgt) });
    } else {
      expanded.push(r);
    }
  }
  // dedupe (if server already returned a row for this week)
  const seen = new Set();
  return expanded.filter(r => {
    const key = `${r.teacher_email || r.teacher_name}|${r.work_date}|${r.start_time}|${r.end_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Remove sessions that are fully contained inside a larger session
// (same teacher + same day + same department)
function removeContainedSessions(rows) {
  const groups = {};
  for (const r of rows) {
    const key = `${(r.teacher_email || '').toLowerCase()}|${r.work_date}|${(r.department || '')}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const result = [];
  for (const key in groups) {
    const group = groups[key];
    if (group.length <= 1) { result.push(...group); continue; }

    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aStart = minutesFromHHMM(a.start_time);
      const aEnd = minutesFromHHMM(a.end_time);
      let isContained = false;

      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const b = group[j];
        const bStart = minutesFromHHMM(b.start_time);
        const bEnd = minutesFromHHMM(b.end_time);

        // B fully contains A, and B is strictly longer
        if (bStart <= aStart && bEnd >= aEnd && (bEnd - bStart) > (aEnd - aStart)) {
          isContained = true;
          break;
        }
      }

      if (!isContained) result.push(a);
    }
  }
  return result;
}

function bucketizeByDayAndShift(rows) {
  const g = {};
  for (let d = 1; d <= 7; d++) g[d] = { morning: [], afternoon: [], evening: [] };
  for (const r of rows) {
    const d = rosterDayIndex(r.work_date);
    const k = whichShift(r.start_time, r.end_time);
    if (!k) continue; // skip rows that don't overlap a defined shift
    g[d][k].push(r);
  }
  return g;
}

// Renders the 7×3 grid
function renderRoster(buckets) {
  let html = `<div class="roster">`;
  // Header row (empty corner + 3 shift headers)
  html += `<div class="roster__head"></div>`;
  html += ROSTER_SHIFTS.map(s => `<div class="roster__head">${wmEscape(s.label)}</div>`).join('');

  // 7 day rows
  for (let d = 1; d <= 7; d++) {
    const dayClass = `day-${d}`; // Mon=1 … Sun=7
    html += `<div class="roster__day ${dayClass}">${wmEscape(ROSTER_DAY_NAMES[d])}</div>`;
    for (const sh of ROSTER_SHIFTS) {
      const items = buckets[d][sh.key] || [];
      if (!items.length) {
        html += `<div class="roster__cell ${dayClass}"><div class="empty-cell">—</div></div>`;
        continue;
      }
// Group items by teacher email within this cell
      const teacherGroups = {};
      const teacherOrder = [];
      for (const r of items) {
        const key = (r.teacher_email || '').toLowerCase();
        if (!teacherGroups[key]) {
          teacherGroups[key] = [];
          teacherOrder.push(key);
        }
        teacherGroups[key].push(r);
      }

      html += `<div class="roster__cell ${dayClass}">` +
        teacherOrder.map(key => {
          const group = teacherGroups[key];
          const r = group[0]; // first row for name/avatar/dept/actions
          const name = r.teacher_name || r.teacher_email || '(No name)';
          const initials = wmInitials(name);
          const isMulti = group.length > 1;

          // Build time slots HTML
          const timeSlotsHtml = group.map((row, idx) => {
            const time = `${wmTimeHHMM(row.start_time)}–${wmTimeHHMM(row.end_time)}${row.is_one_time ? '' : ' ↻'}`;
            return `<span class="pill__time-slot"
              data-row-id="${row.id}"
              data-work-date="${row.work_date}"
              data-start-time="${String(row.start_time || '').slice(0, 5)}"
              data-end-time="${String(row.end_time || '').slice(0, 5)}">${wmEscape(time)}</span>`;
          }).join('');

          return `
<div
  class="pill ${isMulti ? 'pill--multi' : ''}"
  data-row-id="${r.id}"
  data-work-date="${r.work_date}"
  data-teacher-email="${wmEscape(r.teacher_email || '')}"
  data-start-time="${String(r.start_time || '').slice(0, 5)}"
  data-end-time="${String(r.end_time || '').slice(0, 5)}"
  data-teacher-name="${wmEscape(name)}"
  data-department="${wmEscape(r.department || '')}"
  title="${wmEscape(name)}">

<span class="pill__avatar">${wmEscape(initials)}</span>
<span class="pill__name">${wmEscape(name)}</span>
<span class="pill__meta">
  ${!isMulti && r.department
              ? `<span class="pill__dept ${wmDeptClass(r.department)}">${wmEscape(r.department)}</span>`
              : ``
            }
  ${isMulti
              ? `<div class="pill__time-slots">${timeSlotsHtml}</div>`
              : `<span class="pill__time">${wmEscape(`${wmTimeHHMM(r.start_time)}–${wmTimeHHMM(r.end_time)}${r.is_one_time ? '' : ' ↻'}`)}</span>`
            }
</span>



<div class="pill__actions" role="group" aria-label="Actions">
  ${isMulti && r.department
              ? `<span class="pill__dept pill__dept--inline ${wmDeptClass(r.department)}">${wmEscape(r.department)}</span>`
              : ``
            }
  ${wmTiepHvIcon(r.teacher_email)}
  ${wmIconLink(r.work_meeting, 'fa-briefcase', 'Open work meeting link')}

${(() => {
              const isSelf = (String(r.teacher_email || '').toLowerCase() === String(window.MY_EMAIL || '').toLowerCase());

              const assignBtn = window.CAN_ASSIGN_OR_OFFDAY ? `
    <button type="button" class="pill__icon pill__assign" title="Assign" aria-label="Assign">
      <i class="fa-solid fa-user-plus"></i>
    </button>` : ``;

              const offdayAllowed = (window.CAN_EDIT || (window.CAN_ASSIGN_OR_OFFDAY && isSelf));
              const offdayBtn = offdayAllowed ? `
    <button type="button" class="pill__icon pill__offday" title="Off day" aria-label="Off day">
      <i class="fa-solid fa-moon"></i>
    </button>` : ``;

              const transferAllowed = window.CAN_EDIT || (window.CAN_ASSIGN_OR_OFFDAY && isSelf);
              const transferBtn = transferAllowed ? `
    <button type="button" class="pill__icon pill__transfer" title="Transfer students" aria-label="Transfer students">
      <i class="fa-solid fa-right-left"></i>
    </button>` : ``;

              return assignBtn + offdayBtn + transferBtn;
            })()}


  ${window.CAN_EDIT ? `
    <button type="button" class="pill__icon pill__edit" title="Edit" aria-label="Edit">
      <i class="fa-solid fa-pen"></i>
    </button>
    <button type="button" class="pill__icon pill__delete" title="Delete" aria-label="Delete">
      <i class="fa-solid fa-trash"></i>
    </button>
  ` : ``}
</div>




  </div>`;

        }).join('') +
        `</div>`;
    }
  }

  html += `</div>`;
  return html;
}

function renderWorkRow(row) {
  const display = row.teacher_name || row.teacher_email || '(No name)';
  const initials = wmInitials(display);
  const when = `${wmDateVN(row.work_date)} • ${wmTimeHHMM(row.start_time)}–${wmTimeHHMM(row.end_time)}${row.is_one_time ? '' : ' • ↻'}`;

  return `
    <div class="meeting-row">
      <div class="left">
        <div class="avatar" title="${wmEscape(display)}">${wmEscape(initials)}</div>
        <div class="meta">
          <div class="name">${wmEscape(display)}</div>
          <div class="email">${wmEscape(row.teacher_email || '')}</div>
        </div>
      </div>
      <div class="links">
        ${wmChip(row.meeting_link, 'Meeting', 'fa-video')}
        ${wmChip(row.work_meeting, 'Work', 'fa-briefcase')}
      </div>
      <div class="date">${wmEscape(when)}</div>
    </div>`;
}

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatWeekLabel(weekStart) {
  const ws = new Date(weekStart);
  const we = new Date(weekStart); we.setDate(we.getDate() + 6);
  const o = { day: '2-digit', month: '2-digit' };
  return `${ws.toLocaleDateString('vi-VN', o)} – ${we.toLocaleDateString('vi-VN', o)}`;
}

function setupWeekNav() {
  const nav = document.getElementById('weekNav');
  if (!nav) return;
  nav.hidden = false;

  const prev = document.getElementById('weekPrev');
  const next = document.getElementById('weekNext');
  const today = document.getElementById('weekToday');

  // Show the today FAB
  if (today) today.hidden = false;

  prev.onclick = () => { weekOffset -= 1; loadWorkMeetings(); };
  next.onclick = () => { weekOffset += 1; loadWorkMeetings(); };
  today.onclick = () => { weekOffset = 0; loadWorkMeetings(); };
}

async function loadWorkMeetings() {
  const box = document.getElementById('workMeetings');
  if (!box) return;
  box.innerHTML = '<div class="empty-state">Đang tải lịch…</div>';

  const token = await getValidToken();
  if (!token) {
    box.innerHTML = '<div class="empty-state">Phiên đã hết hạn. Vui lòng đăng nhập lại.</div>';
    return;
  }

  // Pick the displayed week (Mon–Sun)
  const base = new Date();
  base.setDate(base.getDate() + (weekOffset * 7));
  const weekStart = startOfWeekLocal(base);

  // KEEP this: build "from" so recurring rows before this week are returned
  const queryFrom = new Date(weekStart);
  queryFrom.setDate(queryFrom.getDate() - 56); // 8 weeks back
  const from = formatYMD(queryFrom);

  // NEW: end of the displayed week
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const to = formatYMD(weekEnd);

  // 1) Fetch meetings with retry on token error
  let res = await fetch(`${_DO}/meetingsfrommeetingcontent?from=${from}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  let out = await res.json().catch(() => ({}));

  // If token error, try refreshing and retry once
  if (!res.ok && (out?.error?.includes('token') || out?.error?.includes('Token') || res.status === 401)) {
    const newToken = await getValidToken();
    if (!newToken) {
      box.innerHTML = '<div class="empty-state">Phiên đã hết hạn. Vui lòng đăng nhập lại.</div>';
      return;
    }
    res = await fetch(`${_DO}/meetingsfrommeetingcontent?from=${from}`, {
      headers: { Authorization: `Bearer ${newToken}` }
    });
    out = await res.json().catch(() => ({}));
  }

  if (!res.ok) {
    box.innerHTML = `<div class="empty-state">Không đọc được dữ liệu: ${wmEscape(out?.error || res.statusText)}</div>`;
    return;
  }

  // 2) Fetch off-days for the displayed week
  const offRes = await fetch(`${_DO}/offdays-range?from=${from}&to=${to}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const offOut = await offRes.json().catch(() => ({}));
  const offSet = new Set((offOut.rows || []).map(r => `${r.meeting_content_id}|${r.off_date}`));

  // 3) Expand recurring → keep only this week → remove off-days
  const rows = out.rows || [];
const expanded = expandRecurringForWeek(rows, weekStart);
  const weekRows = expanded
    .filter(r => isSameWeek(r.work_date, weekStart))
    .filter(r => !offSet.has(`${r.id}|${r.work_date}`));

  const cleanedRows = removeContainedSessions(weekRows);
  const buckets = bucketizeByDayAndShift(cleanedRows);

  // 4) Render + week label
  const labelEl = document.getElementById('weekLabel');
  if (labelEl) labelEl.textContent = formatWeekLabel(weekStart);
  // Load tiep-hv URLs map before rendering (so each chip can look up its Jitsi link)
  await loadTiepHvUrls(token);
  box.innerHTML = renderRoster(buckets);

  // 4b) Show off teachers this week
  renderOffTeachersToday(expanded, offSet, weekStart);

  // 5) Load and display pending request change alerts (all users can see their own)
  loadPendingRequestChanges();

  // 6) Load unconfirmed teachers count (admins only)
  loadUnconfirmedTeachersCount();
}

/* ========== Off Teachers Today Box ========== */
function renderOffTeachersToday(expanded, offSet, weekStart) {
  const container = document.getElementById('offTeachersBox');
  if (!container) return;

  const todayStr = formatYMD(new Date());
  const dayLabels = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

  // Calculate week boundaries
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekFromStr = formatYMD(weekStart);
  const weekToStr = formatYMD(weekEnd);

  // Find ALL teachers who are off this week (only within week boundaries)
  const offThisWeek = expanded.filter(r =>
    r.work_date >= weekFromStr && r.work_date <= weekToStr &&
    offSet.has(`${r.id}|${r.work_date}`)
  );

  if (offThisWeek.length === 0) {
    container.style.display = 'none';
    return;
  }

  // Group by date, then by teacher
  const dayMap = {};
  for (const r of offThisWeek) {
    const date = r.work_date;
    if (!dayMap[date]) dayMap[date] = {};
    const email = (r.teacher_email || '').toLowerCase();
    if (!email) continue;
    if (!dayMap[date][email]) {
      dayMap[date][email] = {
        name: r.teacher_name || email,
        email: email,
        shifts: []
      };
    }
    const time = `${(r.start_time || '').slice(0, 5)}–${(r.end_time || '').slice(0, 5)}`;
    dayMap[date][email].shifts.push(time);
  }

  // Sort dates
  const sortedDates = Object.keys(dayMap).sort();

  // Count unique teachers across the week
  const allEmails = new Set();
  for (const r of offThisWeek) {
    const em = (r.teacher_email || '').toLowerCase();
    if (em) allEmails.add(em);
  }

  // Build HTML grouped by day
  let bodyHtml = '';
  for (const date of sortedDates) {
    const d = new Date(date + 'T00:00:00');
    const dow = dayLabels[d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const isToday = date === todayStr;
    const todayTag = isToday ? '<span class="off-today-tag">Hôm nay</span>' : '';

    const teachers = Object.values(dayMap[date]).sort((a, b) => a.name.localeCompare(b.name));

    const teacherItems = teachers.map(t => {
      const initials = wmInitials(t.name);
      const shiftsText = t.shifts.join(', ');
      return `
        <div class="off-today-item">
          <div class="off-today-avatar">${wmEscape(initials)}</div>
          <div class="off-today-info">
            <div class="off-today-name">${wmEscape(t.name)}</div>
            <div class="off-today-shifts"><i class="fa-regular fa-clock"></i> ${wmEscape(shiftsText)}</div>
          </div>
        </div>`;
    }).join('');

    bodyHtml += `
      <div class="off-today-day-group ${isToday ? 'off-today-day-group--today' : ''}">
        <div class="off-today-day-label">
          <span class="off-today-dow">${dow}</span>
          <span class="off-today-date">${dd}/${mm}</span>
          ${todayTag}
          <span class="off-today-day-count">${teachers.length} GV</span>
        </div>
        ${teacherItems}
      </div>`;
  }

  container.innerHTML = `
    <div class="off-today-header" id="offTodayToggle">
      <div class="off-today-header-left">
        <i class="fa-solid fa-user-slash"></i>
        <span>GV nghỉ tuần này</span>
        <span class="off-today-count">${allEmails.size}</span>
      </div>
      <button class="off-today-chevron" aria-label="Thu gọn">
        <i class="fa-solid fa-chevron-down"></i>
      </button>
    </div>
    <div class="off-today-body" id="offTodayBody">
      ${bodyHtml}
    </div>`;

  container.style.display = '';

  // Toggle collapse/expand
  document.getElementById('offTodayToggle').addEventListener('click', () => {
    container.classList.toggle('off-today-box--collapsed');
  });
}

// Transfer click → open the Transfer modal
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill__transfer');
  if (!btn) return;

  if (!window.CAN_ASSIGN_OR_OFFDAY) { showMsg('Bạn không có quyền thao tác.', 'error'); return; }

  const pill = btn.closest('.pill');
  const teacherEmail = (pill?.dataset?.teacherEmail || '').toLowerCase();
  const teacherName = pill?.dataset?.teacherName || teacherEmail;
  const endTime = pill?.dataset?.endTime || '';
  const workDate = pill?.dataset?.workDate || '';
  const department = pill?.dataset?.department || '';

  if (!teacherEmail || !workDate) { showMsg('Missing teacher or date info.', 'error'); return; }

  if (typeof window.openTransferModal === 'function') {
    window.openTransferModal({
      teacherEmail,
      teacherName,
      endTime,
      workDate,
      department
    });
  } else {
    showMsg('Transfer modal not ready.', 'error');
  }
});

// Assign click → open the Assign modal
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill__assign');
  if (!btn) return;

  // CHANGE THIS LINE:
  if (!window.CAN_ASSIGN_OR_OFFDAY) { showMsg('Bạn không có quyền thao tác.', 'error'); return; }

  const pill = btn.closest('.pill');
  const id = pill?.dataset?.rowId;
  if (!id) { showMsg('Missing id.', 'error'); return; }

  // Open the popup and remember which meeting we're assigning
  if (typeof window.openAssignModal === 'function') {
    const ownerEmail = pill?.dataset?.teacherEmail || '';
    window.openAssignModal(id, ownerEmail);
  } else {
    showMsg('Assign modal not ready.', 'error');
  }
});


// Offday click → popup → process
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pill__offday');
  if (!btn) return;

  if (!window.CAN_ASSIGN_OR_OFFDAY) { showMsg('Bạn không có quyền thao tác.', 'error'); return; }

  const pill = btn.closest('.pill');
  const id = pill?.dataset?.rowId;
  const workDate = pill?.dataset?.workDate;
  if (!id || !workDate) { showMsg('Missing id or date.', 'error'); return; }

  const my = String(window.MY_EMAIL || '').toLowerCase();
  const teacher = String(pill?.dataset?.teacherEmail || '').toLowerCase();
  if (!window.CAN_EDIT && my !== teacher) {
    showMsg('Bạn chỉ được OFF lịch của chính bạn.', 'error');
    return;
  }

  // Get token BEFORE popup so we can fetch shifts inside it
  const { data: { session } } = await client.auth.getSession();
  const token = session?.access_token || null;
  if (!token) { showMsg('Please log in again.', 'error'); return; }

  const teacherEmail = pill?.dataset?.teacherEmail || '';
  const startTime = pill?.dataset?.startTime || '';
  const endTime = pill?.dataset?.endTime || '';

  const result = await offConfirmBox(workDate, teacherEmail, token);
  if (!result || !result.ok) return;

  showLoadingOverlay('Đang đánh dấu off…');

  try {
    if (!result.detailed) {
      // --- Quick off: just this one shift ---
      const res = await fetch(_DO + '/offday', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ id, workDate, teacherEmail, startTime, endTime })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) { showMsg(out?.error || 'Off-day failed', 'error'); return; }
      showMsg('Đã OFF ca này.', 'success');

    } else {
      // --- Multi-day: sync selected shifts + create offdays records ---
      const shifts = result.selectedShifts || [];
      const dates = result.selectedDates || [];

      // 1) Sync selected shifts to meeting_offdays
      if (shifts.length) {
        const syncRes = await fetch(_DO + '/sync-meeting-offdays', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ shifts })
        });
        const syncOut = await syncRes.json().catch(() => ({}));
        if (!syncRes.ok || syncOut.error) {
          showMsg(syncOut.error || 'Sync failed', 'error');
          return;
        }
      }

      // 2) Create offdays records for consecutive date groups
      if (dates.length) {
        const ranges = groupConsecutiveDates(dates);
        for (const range of ranges) {
          await fetch(_DO + '/offdays-crud', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              person_type: 'teacher',
              person_email: teacherEmail,
              off_from: range.from,
              off_to: range.to
            })
          }).catch(err => console.error('offdays-crud error:', err));
        }
      }

      showMsg(`Đã OFF ${shifts.length} ca (${dates.length} ngày).`, 'success');
    }

    loadWorkMeetings();
  } finally {
    hideLoadingOverlay();
  }
});



// Edit click â†' load row â†' open modal prefilled
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pill__edit');
  if (!btn) return;

  if (!window.CAN_EDIT) { showMsg('Báº¡n khÃ´ng cÃ³ quyá»n thao tÃ¡c.', 'error'); return; }

  const pill = btn.closest('.pill');
  const isMulti = pill?.classList.contains('pill--multi');

  let id;
  if (isMulti) {
    id = await pickSessionPopup(pill, 'edit');
    if (!id) return;
  } else {
    id = pill?.dataset?.rowId;
  }
  if (!id) { showMsg('Missing id.', 'error'); return; }

  const verified = await askSecurityKey('edit this meeting');
  if (!verified) return;

  showLoadingOverlay('Đang tải…');
  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token || null;
    if (!token) { showMsg('Please log in again.', 'error'); return; }

    const res = await fetch(`${_DO}/editcalendar?id=${encodeURIComponent(id)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out?.ok || !out.row) {
      showMsg(out?.error || 'Không tải được dữ liệu.', 'error');
      return;
    }

    // This function already exists in your code (inside setupWorkingFabModal)
    openWorkMeetingModalInEditMode(out.row);
  } finally {
    hideLoadingOverlay();
  }
});

// Delete click â†' confirm â†' DELETE â†' refresh
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pill__delete');
  if (!btn) return;

  if (!window.CAN_EDIT) { showMsg('Báº¡n khÃ´ng cÃ³ quyá»n thao tÃ¡c.', 'error'); return; }

  const pill = btn.closest('.pill');
  const isMulti = pill?.classList.contains('pill--multi');

  let id;
  if (isMulti) {
    id = await pickSessionPopup(pill, 'delete');
    if (!id) return;
  } else {
    id = pill?.dataset?.rowId;
  }
  if (!id) { showMsg('Missing id.', 'error'); return; }

  const verified = await askSecurityKey('delete this meeting');
  if (!verified) return;

  const ok = await confirmBox('Xóa lịch này?');
  if (!ok) return;

  showLoadingOverlay('Đang xóa…');
  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token || null;
    if (!token) { showMsg('Please log in again.', 'error'); return; }

    const res = await fetch(`${_DO}/deletecalendar?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out?.ok) {
      showMsg(out?.error || 'Xóa thất bại.', 'error');
      return;
    }

    showMsg('Đã xóa.', 'success');
    loadWorkMeetings(); // refresh grid
  } finally {
    hideLoadingOverlay();
  }
});

// --- Assign Modal (popup for assigning a teacher to a meeting_content) ---
function setupAssignModal() {
  let modal = document.getElementById('assignModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'assignModal';
    modal.className = 'modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-overlay" id="asOverlay"></div>

      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="asTitle">
        <div class="modal-header">
<h3 id="asTitle">Assign to student</h3>
          <button class="icon-btn" id="asClose" aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
<label for="asEmail">Student email</label>
<input type="email" id="asEmail" class="input" placeholder="Type at least 4 characters…" autocomplete="off" />
            <div id="asSug" class="suggestions" role="listbox" aria-label="Email suggestions"></div>
            <p class="hint">Start typing (≥ 4 chars). Suggestions appear after 1s.</p>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-ghost" id="asCancel">Cancel</button>
          <button class="btn-primary" id="asAssign">
            <i class="fa-solid fa-user-plus"></i> Assign
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // prevent double wiring
  if (modal.dataset.wired === 'true') return;
  modal.dataset.wired = 'true';

  const emailInput = modal.querySelector('#asEmail');
  const sugBox = modal.querySelector('#asSug');
  let debounceId;

  function renderSug(items) {
    if (!Array.isArray(items) || !items.length) {
      sugBox.innerHTML = '';
      sugBox.style.display = 'none';
      return;
    }
    sugBox.innerHTML = items
      .map(x => `
      <div class="suggestion-item" role="option" data-email="${x.email}">
        <i class="fa-solid fa-user"></i>
        <span>${wmEscape(x.email)}</span>
      </div>
    `).join('');
    sugBox.style.display = 'block';
  }


  async function authToken() {
    const { data: { session } } = await client.auth.getSession();
    return session?.access_token || null;
  }

  // Debounced (1s) typeahead; requires >= 4 characters
  emailInput.addEventListener('input', () => {
    const q = emailInput.value.trim();
    clearTimeout(debounceId);

    if (q.length < 4) {
      renderSug([]);
      return;
    }

    debounceId = setTimeout(async () => {
      try {
        const token = await authToken();
        if (!token) return;
        // Reuse existing serverless function that queries user_roles.email
        const res = await fetch(`${_DO}/userroles-search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) { renderSug([]); return; }
        const { suggestions } = await res.json();
        renderSug(suggestions || []);
      } catch (e) {
        renderSug([]);
      }
    }, 1000);
  });

  // Click on a suggestion to fill the email
  sugBox.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    emailInput.value = item.dataset.email || '';
    renderSug([]);
    sugBox.style.display = 'none'; // optional extra hide
  });


  const open = (meetingId, ownerEmail) => {
    modal.dataset.ownerEmail = ownerEmail || '';
    modal.dataset.meetingId = String(meetingId || '');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    emailInput.value = '';

    // ADD THESE TWO LINES
    renderSug([]);
    sugBox.style.display = 'none';

    // focus after frame paint
    setTimeout(() => emailInput.focus(), 0);
  };

  const close = () => {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    clearTimeout(debounceId);
    renderSug([]);                 // clears content
    sugBox.style.display = 'none'; // ADD THIS LINE
    delete modal.dataset.meetingId;
    delete modal.dataset.ownerEmail;

  };


  // expose opener
  window.openAssignModal = open;

  // wire close buttons
  modal.querySelector('#asClose').addEventListener('click', close);
  modal.querySelector('#asCancel').addEventListener('click', close);
  modal.querySelector('#asOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'asOverlay') close();
  });

  // Save → insert into meeting_assigned
  modal.querySelector('#asAssign').addEventListener('click', async () => {
    const studentEmail = (emailInput.value || '').trim().toLowerCase();
    if (!studentEmail || !studentEmail.includes('@')) {
      showMsg('Please enter a valid email.', 'error'); return;
    }

    const meetingId = modal.dataset.meetingId;
    if (!meetingId) { showMsg('Missing meeting id.', 'error'); return; }

    try {
      // We insert directly with the Supabase JS client.
      // RLS should allow insert when assigned_by === auth email (per the policy we created).
      const { data: { user } } = await client.auth.getUser();
      const myEmail = user?.email || '';
      if (!myEmail) { showMsg('Please log in again.', 'error'); return; }

      const { error } = await client
        .from('meeting_assigned')
        .insert([{
          meeting_content_id: meetingId,
          assigned_by: myEmail,
          student_email: studentEmail,           // <— renamed column
          owner_email: modal.dataset.ownerEmail || null  // <— new column
          // assigned_date uses DEFAULT now()
        }]);

      if (error) throw error;

      showMsg('Assigned successfully.', 'ok');
      close();
    } catch (err) {
      console.error(err);
      showMsg(err?.message || 'Assign failed', 'error');
    }
  });
}

/* ---------- Pending Request Changes Alert System ---------- */
let pendingRequestsCache = [];
let pendingStudentNotesCache = [];

async function loadPendingRequestChanges() {
  // Allow all logged-in users to see their own pending requests
  // (Backend filters non-admins to only see their own requests)

  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const res = await fetch(_DO + '/request-change?pending_only=true', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const result = await res.json();
    if (!res.ok || !result.ok) return;

    pendingRequestsCache = result.rows || [];

    // Also load pending student notes
    try {
      const today = new Date();
      const todayDOW = today.getDay();
      const mondayOff = todayDOW === 0 ? -6 : 1 - todayDOW;
      const mon = new Date(today);
      mon.setDate(today.getDate() + mondayOff);
      const mondayYMD = mon.toISOString().slice(0, 10);

      const snRes = await fetch(`${_DO}/student-note?week_start_date=${mondayYMD}&pending_only=true`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const snOut = await snRes.json();
      if (snRes.ok && snOut.ok) pendingStudentNotesCache = snOut.rows || [];
    } catch (e) { console.warn('Could not load student notes for badge:', e); }

    // Update badge count (requests + student notes)
    updatePendingBadge(pendingRequestsCache.length + pendingStudentNotesCache.length);

    // Mark pills that have pending requests
    markPillsWithPendingRequests();

    // Mark pills that have pending student notes
    markPillsWithStudentNotes();

  } catch (e) {
    console.error('Failed to load pending requests:', e);
  }
}

function updatePendingBadge(count) {
  // Remove existing badge
  const existingBadge = document.getElementById('pendingRequestsBadge');
  if (existingBadge) existingBadge.remove();

  // Only show badge for admins (users who can edit)
  if (!window.CAN_EDIT) return;

  // Add badge to the page (always visible for admins)
  const badge = document.createElement('div');
  badge.id = 'pendingRequestsBadge';
  badge.className = 'pending-requests-badge';

  if (count > 0) {
    badge.innerHTML = `
      <i class="fa-solid fa-bell"></i>
      <span class="badge-count">${count}</span>
    `;
    badge.title = `${count} yêu cầu thay đổi lịch đang chờ xử lý`;
    badge.classList.add('has-pending');
  } else {
    badge.innerHTML = `
      <i class="fa-solid fa-bell"></i>
    `;
    badge.title = 'Xem nhật ký yêu cầu thay đổi';
    badge.classList.add('no-pending');
  }

  badge.addEventListener('click', showPendingRequestsPanel);
  document.body.appendChild(badge);
}

/* ---------- Unconfirmed Teachers Badge ---------- */
async function loadUnconfirmedTeachersCount() {
  // Only show for admins
  if (!window.CAN_EDIT) return;

  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    // Calculate current week Monday
    const today = new Date();
    const todayDOW = today.getDay();
    const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);
    const weekStartDate = monday.toISOString().slice(0, 10);

    const res = await fetch(`${_DO}/unconfirmed-teachers-count?weekStartDate=${weekStartDate}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const result = await res.json();
    if (!res.ok || !result.ok) return;

    // Store the unconfirmed teachers list for popup
    unconfirmedTeachersList = result.unconfirmedTeachers || [];
    unconfirmedStudentTeachersList = result.unconfirmedStudentTeachers || [];
    unconfirmedFHTeachersList = result.unconfirmedFHTeachers || [];

    // Count unique teachers who have ANY unconfirmed item
    const allUnconfirmedEmails = new Set([
      ...unconfirmedTeachersList.map(t => t.email),
      ...unconfirmedStudentTeachersList.map(t => t.email),
      ...unconfirmedFHTeachersList.map(t => t.email)
    ]);
    updateUnconfirmedBadge(allUnconfirmedEmails.size);

  } catch (e) {
    console.error('Failed to load unconfirmed count:', e);
  }
}

function updateUnconfirmedBadge(count) {
  // Remove existing badge
  const existingBadge = document.getElementById('unconfirmedTeachersBadge');
  if (existingBadge) existingBadge.remove();

  // Only show for admins
  if (!window.CAN_EDIT) return;

  const badge = document.createElement('div');
  badge.id = 'unconfirmedTeachersBadge';
  badge.className = 'unconfirmed-teachers-badge';

  if (count > 0) {
    badge.innerHTML = `
      <i class="fa-solid fa-calendar-xmark"></i>
      <span class="badge-count">${count}</span>
    `;
    badge.title = `${count} giáo viên chưa xác nhận lịch tuần này`;
    badge.classList.add('has-unconfirmed');
  } else {
    badge.innerHTML = `
      <i class="fa-solid fa-calendar-check"></i>
    `;
    badge.title = 'Tất cả giáo viên đã xác nhận lịch tuần này';
    badge.classList.add('all-confirmed');
  }

  badge.addEventListener('click', () => {
    showUnconfirmedTeachersPopup();
  });
  document.body.appendChild(badge);
}

// Show popup with unconfirmed teachers list
function showUnconfirmedTeachersPopup() {
  const existing = document.getElementById('unconfirmedTeachersPopup');
  if (existing) { existing.remove(); return; }

  // Helper to build popup HTML from current cached data
  function buildPopupBody() {
    let scheduleListHTML = '';
    if (unconfirmedTeachersList.length === 0) {
      scheduleListHTML = '<p class="unconfirmed-popup-empty">Tất cả GV đã xác nhận lịch tuần này! 🎉</p>';
    } else {
      scheduleListHTML = `
        <ul class="unconfirmed-popup-list">
          ${unconfirmedTeachersList.map(t => `
            <li class="unconfirmed-popup-item">
              <i class="fa-solid fa-user-clock"></i>
              <span class="unconfirmed-name">${t.name}</span>
            </li>
          `).join('')}
        </ul>
      `;
    }

    let studentListHTML = '';
    if (unconfirmedStudentTeachersList.length === 0) {
      studentListHTML = '<p class="unconfirmed-popup-empty">Tất cả GV đã xác nhận danh sách HV! 🎉</p>';
    } else {
      studentListHTML = `
        <ul class="unconfirmed-popup-list">
          ${unconfirmedStudentTeachersList.map(t => `
            <li class="unconfirmed-popup-item">
              <i class="fa-solid fa-user-clock" style="color:#3b82f6"></i>
              <span class="unconfirmed-name">${t.name}</span>
            </li>
          `).join('')}
        </ul>
      `;
    }

    let fhListHTML = '';
    if (unconfirmedFHTeachersList.length === 0) {
      fhListHTML = '<p class="unconfirmed-popup-empty">Tất cả GV đã xác nhận lịch rảnh! 🎉</p>';
    } else {
      fhListHTML = `
        <ul class="unconfirmed-popup-list">
          ${unconfirmedFHTeachersList.map(t => `
            <li class="unconfirmed-popup-item">
              <i class="fa-solid fa-user-clock" style="color:#7c3aed"></i>
              <span class="unconfirmed-name">${t.name}</span>
            </li>
          `).join('')}
        </ul>
      `;
    }

    return `
      <p class="unconfirmed-popup-count" style="background:#fff7ed;border:1px solid #fed7aa;color:#c2410c">
        <strong>${unconfirmedTeachersList.length}</strong> giáo viên chưa xác nhận tuần này
      </p>
      ${scheduleListHTML}
      <p class="unconfirmed-popup-count" style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;margin-top:16px">
        <strong>${unconfirmedStudentTeachersList.length}</strong> giáo viên chưa xác nhận danh sách HV
      </p>
      ${studentListHTML}
      <p class="unconfirmed-popup-count" style="background:#f5f3ff;border:1px solid #ddd6fe;color:#6d28d9;margin-top:16px">
        <strong>${unconfirmedFHTeachersList.length}</strong> giáo viên chưa xác nhận lịch rảnh
      </p>
      ${fhListHTML}
    `;
  }

  // Show popup INSTANTLY with cached data
  const popup = document.createElement('div');
  popup.id = 'unconfirmedTeachersPopup';
  popup.className = 'unconfirmed-popup-overlay';

  popup.innerHTML = `
    <div class="unconfirmed-popup-content">
      <div class="unconfirmed-popup-header">
        <i class="fa-solid fa-calendar-xmark"></i>
        <h3>Giáo viên chưa nhận lịch</h3>
        <button class="unconfirmed-popup-close" id="closeUnconfirmedPopup">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="unconfirmed-popup-body" id="unconfirmedPopupBody">
        ${buildPopupBody()}
      </div>
      <div class="unconfirmed-popup-footer">
        <button class="btn-ghost" id="closeUnconfirmedBtn">Đóng</button>
        <button class="btn-primary" id="goToConfirmationBtn">
          <i class="fa-solid fa-external-link"></i> Xem chi tiết
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  popup.querySelector('#closeUnconfirmedPopup').addEventListener('click', () => popup.remove());
  popup.querySelector('#closeUnconfirmedBtn').addEventListener('click', () => popup.remove());
  popup.querySelector('.unconfirmed-popup-overlay').addEventListener('click', (e) => {
    if (e.target === popup) popup.remove();
  });
  popup.querySelector('#goToConfirmationBtn').addEventListener('click', () => {
    window.location.href = './confirmation.html';
  });

  const onEsc = (e) => {
    if (e.key === 'Escape') {
      popup.remove();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);

  // Refresh data in background, then update popup if still open
  (async () => {
    try {
      const { data: { session } } = await client.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const today = new Date();
      const todayDOW = today.getDay();
      const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      const weekStartDate = monday.toISOString().slice(0, 10);

      const res = await fetch(`${_DO}/unconfirmed-teachers-count?weekStartDate=${weekStartDate}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const result = await res.json();
      if (res.ok && result.ok) {
        unconfirmedTeachersList = result.unconfirmedTeachers || [];
        unconfirmedStudentTeachersList = result.unconfirmedStudentTeachers || [];
        unconfirmedFHTeachersList = result.unconfirmedFHTeachers || [];
        const refreshEmails = new Set([
          ...unconfirmedTeachersList.map(t => t.email),
          ...unconfirmedStudentTeachersList.map(t => t.email),
          ...unconfirmedFHTeachersList.map(t => t.email)
        ]);
        updateUnconfirmedBadge(refreshEmails.size);

        // Update popup body if it's still open
        const bodyEl = document.getElementById('unconfirmedPopupBody');
        if (bodyEl) {
          bodyEl.innerHTML = buildPopupBody();
        }
      }
    } catch (e) {
      console.warn('Could not refresh unconfirmed data:', e);
    }
  })();
}

function markPillsWithPendingRequests() {
  // Remove all existing alert markers
  document.querySelectorAll('.pill-alert-marker').forEach(el => el.remove());
  document.querySelectorAll('.pill.has-pending-request').forEach(el => {
    el.classList.remove('has-pending-request');
  });

  if (!pendingRequestsCache.length) return;

  // For each pending request, find the matching pill
  for (const req of pendingRequestsCache) {
    const teacherEmail = (req.teacher_email || '').toLowerCase();
    const workDate = req.work_date;
    const startTime = String(req.start_time || '').slice(0, 5);
    const endTime = String(req.end_time || '').slice(0, 5);

    // Find matching pill
    const pills = document.querySelectorAll('.pill');
    for (const pill of pills) {
      const pillEmail = (pill.dataset.teacherEmail || '').toLowerCase();
      const pillDate = pill.dataset.workDate;
      const pillStart = pill.dataset.startTime;
      const pillEnd = pill.dataset.endTime;

      // Match by teacher + time (date might differ for recurring)
      if (pillEmail === teacherEmail && pillStart === startTime && pillEnd === endTime) {
        pill.classList.add('has-pending-request');

        // Add alert marker if not exists
        if (!pill.querySelector('.pill-alert-marker')) {
          const marker = document.createElement('div');
          marker.className = 'pill-alert-marker';
          marker.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
          marker.title = 'Có yêu cầu thay đổi';
          pill.appendChild(marker);
        }

        // Store request data on the pill for hover tooltip
        pill.dataset.pendingRequestId = req.id;
        pill.dataset.pendingRequestReason = req.reason;
        pill.dataset.pendingRequestDate = new Date(req.created_at).toLocaleDateString('vi-VN');
        pill.dataset.department = req.department || '';
      }
    }
  }

  // Setup hover tooltips
  setupRequestTooltips();
}

function markPillsWithStudentNotes() {
  // Remove existing student note markers
  document.querySelectorAll('.pill.has-student-note').forEach(el => {
    el.classList.remove('has-student-note');
    el.querySelector('.pill-note-marker')?.remove();
  });

  if (!pendingStudentNotesCache.length) return;

  // Group notes by teacher email
  const notesByTeacher = {};
  for (const note of pendingStudentNotesCache) {
    const email = (note.teacher_email || '').toLowerCase();
    if (!notesByTeacher[email]) notesByTeacher[email] = [];
    notesByTeacher[email].push(note);
  }

  const pills = document.querySelectorAll('.pill');
  for (const pill of pills) {
    const pillEmail = (pill.dataset.teacherEmail || '').toLowerCase();
    const teacherNotes = notesByTeacher[pillEmail];
    if (!teacherNotes || pill.classList.contains('has-student-note')) continue;

    pill.classList.add('has-student-note');

    // Store all notes as JSON on the pill
    pill.dataset.studentNotes = JSON.stringify(teacherNotes);

    const marker = document.createElement('div');
    marker.className = 'pill-note-marker';
    marker.innerHTML = '<i class="fa-solid fa-flag"></i>';
    marker.title = `${teacherNotes.length} ghi chú về HV`;
    pill.appendChild(marker);
  }

  // Setup hover tooltips for student notes
  setupStudentNoteTooltips();
}

function setupStudentNoteTooltips() {
  // Remove existing tooltip
  document.getElementById('studentNoteTooltip')?.remove();

  const tooltip = document.createElement('div');
  tooltip.id = 'studentNoteTooltip';
  tooltip.className = 'request-tooltip hidden';
  document.body.appendChild(tooltip);

  let hideTimeout = null;

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  }

  function showTooltip(pill) {
    clearTimeout(hideTimeout);

    let notes = [];
    try { notes = JSON.parse(pill.dataset.studentNotes || '[]'); } catch { return; }
    if (!notes.length) return;

    const teacherName = pill.dataset.teacherName || pill.dataset.teacherEmail || '';
    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    const notesHtml = notes.map(n => {
      const studentName = n.student_name || n.student_email || '';
      const dayLabel = dayNames[n.day_of_week] || '';
      const createdDate = new Date(n.created_at).toLocaleDateString('vi-VN');
      const isPending = n.status === 'pending';

      return `
        <div class="sn-tooltip-note" style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="width:28px;height:28px;border-radius:50%;background:#eef2ff;color:#4f46e5;display:grid;place-items:center;font-size:11px;font-weight:700;">${getInitials(studentName)}</div>
            <div>
              <div style="font-weight:600;font-size:13px;color:#1f2937;">${wmEscape(studentName)}</div>
              <div style="font-size:11px;color:#6b7280;">${dayLabel} • ${wmEscape(n.time_local || '')} • ${wmEscape(n.role || '')}</div>
            </div>
          </div>
          <div style="font-size:13px;color:#374151;padding:6px 10px;background:#fffbeb;border-radius:8px;border-left:3px solid #f59e0b;margin:4px 0;">"${wmEscape(n.note)}"</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px;"><i class="fa-regular fa-paper-plane"></i> ${createdDate}</div>
          ${isPending && window.CAN_EDIT ? `
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="tooltip-btn tooltip-btn-resolve" data-sn-id="${n.id}" style="flex:1;padding:5px 8px;font-size:11px;border:none;border-radius:6px;cursor:pointer;background:#dcfce7;color:#166534;font-weight:600;">
              <i class="fa-solid fa-check"></i> Đã xử lý
            </button>
            <button class="tooltip-btn tooltip-btn-reject" data-sn-id="${n.id}" style="flex:1;padding:5px 8px;font-size:11px;border:none;border-radius:6px;cursor:pointer;background:#fee2e2;color:#991b1b;font-weight:600;">
              <i class="fa-solid fa-xmark"></i> Từ chối
            </button>
          </div>` : ''}
        </div>`;
    }).join('');

    tooltip.innerHTML = `
      <div class="tooltip-header" style="background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;">
        <i class="fa-solid fa-flag"></i>
        <span>Ghi chú về HV (${notes.length})</span>
        <div class="tooltip-close-btn" id="snTooltipCloseBtn">
          <i class="fa-solid fa-xmark"></i>
        </div>
      </div>
      <div class="tooltip-body" style="max-height:350px;overflow-y:auto;">
        <div class="tooltip-teacher-row">
          <div class="tooltip-avatar">${getInitials(teacherName)}</div>
          <div class="tooltip-teacher-info">
            <div class="tooltip-teacher">${wmEscape(teacherName)}</div>
            <div class="tooltip-email">${wmEscape(pill.dataset.teacherEmail || '')}</div>
          </div>
        </div>
        ${notesHtml}
      </div>
    `;

    // Position tooltip
    const rect = pill.getBoundingClientRect();
    const tooltipWidth = 420;
    let left = rect.left + rect.width / 2;
    if (left - tooltipWidth / 2 < 20) left = tooltipWidth / 2 + 20;
    else if (left + tooltipWidth / 2 > window.innerWidth - 20) left = window.innerWidth - tooltipWidth / 2 - 20;

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    tooltip.style.left = `${left}px`;

    if (spaceBelow < 400 && spaceAbove > spaceBelow) {
      tooltip.style.top = 'auto';
      tooltip.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      tooltip.classList.add('tooltip-above');
      tooltip.classList.remove('tooltip-below');
    } else {
      tooltip.style.bottom = 'auto';
      tooltip.style.top = `${rect.bottom + 10}px`;
      tooltip.classList.add('tooltip-below');
      tooltip.classList.remove('tooltip-above');
    }

    tooltip.classList.remove('hidden');

    // Close button
    tooltip.querySelector('#snTooltipCloseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltip.classList.add('hidden');
    });

    // Action buttons (admin resolve/reject)
    tooltip.querySelectorAll('[data-sn-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.snId;
        const action = btn.classList.contains('tooltip-btn-resolve') ? 'resolved' : 'rejected';

        tooltip.classList.add('hidden');

        const adminNote = await showAdminNotePopup(id, action);
        if (adminNote === null) return;

        try {
          const { data: { session } } = await client.auth.getSession();
          const token = session?.access_token;
          if (!token) return;

          const snRes = await fetch(_DO + '/student-note', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id, status: action, adminResponse: adminNote })
          });
          const snOut = await snRes.json();
          if (!snRes.ok || !snOut.ok) throw new Error(snOut.error || 'Error');

          await loadPendingRequestChanges();
          loadWorkMeetings();
        } catch (err) {
          alert('Lỗi: ' + err.message);
        }
      });
    });
  }

  function hideTooltip() {
    hideTimeout = setTimeout(() => {
      tooltip.classList.add('hidden');
    }, 200);
  }

  // Add hover listeners to pills with student notes
  document.querySelectorAll('.pill.has-student-note').forEach(pill => {
    pill.addEventListener('mouseenter', () => showTooltip(pill));
    pill.addEventListener('mouseleave', hideTooltip);
  });

  // Keep tooltip open when hovering over it
  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
  tooltip.addEventListener('mouseleave', hideTooltip);

  // Close tooltip when clicking outside
  document.addEventListener('click', (e) => {
    if (!tooltip.contains(e.target) && !e.target.closest('.pill.has-student-note')) {
      tooltip.classList.add('hidden');
    }
  });
}

function setupRequestTooltips() {
  // Remove existing tooltip
  document.getElementById('requestTooltip')?.remove();

  // Create tooltip element
  const tooltip = document.createElement('div');
  tooltip.id = 'requestTooltip';
  tooltip.className = 'request-tooltip hidden';
  document.body.appendChild(tooltip);

  let hideTimeout = null;
  let currentPill = null;

  function showTooltip(pill) {
    clearTimeout(hideTimeout);
    currentPill = pill;

    const requestId = pill.dataset.pendingRequestId || '';
    const reason = pill.dataset.pendingRequestReason || '';
    const date = pill.dataset.pendingRequestDate || '';
    const teacherName = pill.dataset.teacherName || pill.dataset.teacherEmail || '';
    const startTime = pill.dataset.startTime || '';
    const endTime = pill.dataset.endTime || '';
    const workDate = pill.dataset.workDate || '';
    const department = pill.dataset.department || '';

    // Find full request data from cache
    const reqData = pendingRequestsCache.find(r => r.id === requestId);

    tooltip.innerHTML = `
      <div class="tooltip-header">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>Yêu cầu thay đổi</span>
        <div class="tooltip-close-btn" id="tooltipCloseBtn">
          <i class="fa-solid fa-xmark"></i>
        </div>
      </div>
      <div class="tooltip-body">
        <div class="tooltip-teacher-row">
          <div class="tooltip-avatar">${getInitials(teacherName)}</div>
          <div class="tooltip-teacher-info">
            <div class="tooltip-teacher">${wmEscape(teacherName)}</div>
            <div class="tooltip-email">${wmEscape(pill.dataset.teacherEmail || '')}</div>
          </div>
        </div>
        <div class="tooltip-details">
          <div class="tooltip-detail-item">
            <i class="fa-regular fa-calendar"></i>
            <span>${workDate}</span>
          </div>
          <div class="tooltip-detail-item">
            <i class="fa-regular fa-clock"></i>
            <span>${startTime} – ${endTime}</span>
          </div>
          <div class="tooltip-detail-item">
            <i class="fa-solid fa-building"></i>
            <span>${department || 'N/A'}</span>
          </div>
        </div>
        <div class="tooltip-reason-section">
          <div class="tooltip-reason-label">Lý do yêu cầu:</div>
          <div class="tooltip-reason">"${wmEscape(reason)}"</div>
        </div>
        <div class="tooltip-date">
          <i class="fa-regular fa-paper-plane"></i> Gửi lúc: ${date}
        </div>
      </div>
      ${window.CAN_EDIT ? `
      <div class="tooltip-actions">
        <button class="tooltip-btn tooltip-btn-resolve" data-id="${requestId}">
          <i class="fa-solid fa-check"></i> Đã xử lý
        </button>
        <button class="tooltip-btn tooltip-btn-reject" data-id="${requestId}">
          <i class="fa-solid fa-xmark"></i> Từ chối
        </button>
      </div>
      ` : ''}
    `;

    // Position tooltip
    const rect = pill.getBoundingClientRect();
    const tooltipWidth = 420;
    const tooltipHeight = 380; // Approximate height of tooltip
    let left = rect.left + rect.width / 2;

    // Keep tooltip within viewport horizontally
    if (left - tooltipWidth / 2 < 20) {
      left = tooltipWidth / 2 + 20;
    } else if (left + tooltipWidth / 2 > window.innerWidth - 20) {
      left = window.innerWidth - tooltipWidth / 2 - 20;
    }

    // Check if there's enough space below
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    tooltip.style.left = `${left}px`;

    // Position above or below based on available space
    if (spaceBelow < tooltipHeight + 20 && spaceAbove > spaceBelow) {
      // Show above the pill
      tooltip.style.top = 'auto';
      tooltip.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      tooltip.classList.add('tooltip-above');
      tooltip.classList.remove('tooltip-below');
    } else {
      // Show below the pill (default)
      tooltip.style.bottom = 'auto';
      tooltip.style.top = `${rect.bottom + 10}px`;
      tooltip.classList.add('tooltip-below');
      tooltip.classList.remove('tooltip-above');
    }

    tooltip.classList.remove('hidden');

    // Setup action buttons
    tooltip.querySelectorAll('.tooltip-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const action = btn.classList.contains('tooltip-btn-resolve') ? 'resolved' : 'rejected';

        tooltip.classList.add('hidden');

        // Show note popup
        const adminNote = await showAdminNotePopup(id, action);
        if (adminNote === null) return; // User cancelled

        await handleRequestAction(id, action, adminNote);
        await loadPendingRequestChanges();
        loadWorkMeetings();
      });
    });

    // Close button
    tooltip.querySelector('#tooltipCloseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltip.classList.add('hidden');
    });
  }

  function hideTooltip() {
    hideTimeout = setTimeout(() => {
      tooltip.classList.add('hidden');
      currentPill = null;
    }, 200);
  }

  // Helper function for initials
  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }

  // Add hover listeners to pills with pending requests
  document.querySelectorAll('.pill.has-pending-request').forEach(pill => {
    pill.addEventListener('mouseenter', () => showTooltip(pill));
    pill.addEventListener('mouseleave', hideTooltip);
  });

  // Keep tooltip open when hovering over it
  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
  tooltip.addEventListener('mouseleave', hideTooltip);

  // Close tooltip when clicking outside
  document.addEventListener('click', (e) => {
    if (!tooltip.contains(e.target) && !e.target.closest('.pill.has-pending-request')) {
      tooltip.classList.add('hidden');
    }
  });
}

async function showPendingRequestsPanel() {
  // Remove existing panel
  document.getElementById('pendingRequestsPanel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'pendingRequestsPanel';
  panel.className = 'pending-requests-panel';

  // Get current week dates
  const today = new Date();
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const formatDateInput = (d) => d.toISOString().split('T')[0];
  const defaultFrom = formatDateInput(monday);
  const defaultTo = formatDateInput(sunday);

  panel.innerHTML = `
    <div class="panel-overlay"></div>
    <div class="panel-content panel-content-wide">
      <div class="panel-header">
        <h3><i class="fa-solid fa-clipboard-list"></i> Nhật ký yêu cầu thay đổi</h3>
        <button class="panel-close" id="closePendingPanel">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="panel-filter">
        <div class="filter-row">
          <div class="filter-group">
            <label>Từ ngày:</label>
            <input type="date" id="logFilterFrom" value="${defaultFrom}">
          </div>
          <div class="filter-group">
            <label>Đến ngày:</label>
            <input type="date" id="logFilterTo" value="${defaultTo}">
          </div>
          <div class="filter-group">
            <label>Trạng thái:</label>
            <select id="logFilterStatus">
              <option value="">Tất cả</option>
              <option value="pending">Chờ xử lý</option>
              <option value="resolved">Đã xử lý</option>
              <option value="rejected">Đã từ chối</option>
            </select>
          </div>
          <button class="filter-btn" id="applyLogFilter">
            <i class="fa-solid fa-filter"></i> Lọc
          </button>
          <button class="filter-btn filter-btn-week" id="thisWeekBtn">
            <i class="fa-solid fa-calendar-week"></i> Tuần này
          </button>
          <button class="filter-btn filter-btn-week" id="lastWeekBtn">
            <i class="fa-solid fa-arrow-left"></i> Tuần trước
          </button>
        </div>
      </div>
      <div class="panel-body" id="logPanelBody">
        <div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  // Close handlers
  panel.querySelector('#closePendingPanel').addEventListener('click', () => panel.remove());
  panel.querySelector('.panel-overlay').addEventListener('click', () => panel.remove());

  // Filter handlers
  panel.querySelector('#applyLogFilter').addEventListener('click', () => loadLogData());
  panel.querySelector('#thisWeekBtn').addEventListener('click', () => {
    document.getElementById('logFilterFrom').value = defaultFrom;
    document.getElementById('logFilterTo').value = defaultTo;
    loadLogData();
  });
  panel.querySelector('#lastWeekBtn').addEventListener('click', () => {
    const lastMonday = new Date(monday);
    lastMonday.setDate(monday.getDate() - 7);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    document.getElementById('logFilterFrom').value = formatDateInput(lastMonday);
    document.getElementById('logFilterTo').value = formatDateInput(lastSunday);
    loadLogData();
  });

  // Load initial data
  loadLogData();
}

async function loadLogData() {
  const panelBody = document.getElementById('logPanelBody');
  if (!panelBody) return;

  panelBody.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</div>';

  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const from = document.getElementById('logFilterFrom')?.value || '';
    const to = document.getElementById('logFilterTo')?.value || '';
    const status = document.getElementById('logFilterStatus')?.value || '';

    let url = _DO + '/request-change?';
    if (from) url += `from=${from}&`;
    if (to) url += `to=${to}&`;
    if (status) url += `status=${status}&`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const result = await res.json();
    if (!res.ok || !result.ok) {
      panelBody.innerHTML = '<div class="no-data">Lỗi tải dữ liệu</div>';
      return;
    }

    const requests = result.rows || [];

    // Also load student notes
    let studentNotes = [];
    try {
      const snRes = await fetch(`${_DO}/student-note?week_start_date=${document.getElementById('logFilterFrom')?.value || ''}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const snOut = await snRes.json();
      if (snRes.ok && snOut.ok) studentNotes = snOut.rows || [];
    } catch (e) { console.warn('Could not load student notes:', e); }

    if (!requests.length && !studentNotes.length) {
      panelBody.innerHTML = '<div class="no-data"><i class="fa-solid fa-inbox"></i> Không có yêu cầu nào trong khoảng thời gian này</div>';
      return;
    }

    // Separate requests into pending and processed
    const pendingRequests = requests.filter(r => r.status === 'pending');
    const processedRequests = requests.filter(r => r.status !== 'pending');

    // Helper function to render a request card
    function renderRequestCard(req) {
      const teacherName = req.teacher_name || req.teacher_email;
      const createdDate = new Date(req.created_at).toLocaleDateString('vi-VN');
      const time = `${String(req.start_time).slice(0, 5)} – ${String(req.end_time).slice(0, 5)}`;

      let statusClass = 'status-pending';
      let statusText = '<i class="fa-solid fa-clock"></i> Chờ xử lý';
      if (req.status === 'resolved') {
        statusClass = 'status-resolved';
        statusText = '<i class="fa-solid fa-check"></i> Đã xử lý';
      } else if (req.status === 'rejected') {
        statusClass = 'status-rejected';
        statusText = '<i class="fa-solid fa-xmark"></i> Đã từ chối';
      }

      const resolvedInfo = req.resolved_at ? `
        <div class="resolved-info">
          <i class="fa-solid fa-user-check"></i> Xử lý bởi: ${wmEscape(req.resolved_by || 'N/A')}
          <span class="resolved-date">lúc ${new Date(req.resolved_at).toLocaleString('vi-VN')}</span>
        </div>
      ` : '';

      const adminNote = req.admin_response ? `
        <div class="admin-note-display">
          <i class="fa-solid fa-note-sticky"></i> <strong>Ghi chú:</strong> ${wmEscape(req.admin_response)}
        </div>
      ` : '';

      const isPending = req.status === 'pending';

      return `
        <div class="request-item ${statusClass}" data-id="${req.id}">
          <div class="request-item-header">
            <span class="request-teacher">${wmEscape(teacherName)}</span>
            <span class="request-status-badge ${statusClass}">${statusText}</span>
          </div>
          <div class="request-time">
            <i class="fa-regular fa-clock"></i> ${req.work_date} • ${time}
          </div>
          <div class="request-reason">${wmEscape(req.reason)}</div>
          ${resolvedInfo}
          ${adminNote}
          <div class="request-meta">
            <i class="fa-regular fa-paper-plane"></i> Gửi lúc: ${createdDate}
          </div>
          ${isPending && window.CAN_EDIT ? `
          <div class="request-actions">
            <button class="req-btn req-btn-approve" data-id="${req.id}" data-action="resolved">
              <i class="fa-solid fa-check"></i> Đã xử lý
            </button>
            <button class="req-btn req-btn-reject" data-id="${req.id}" data-action="rejected">
              <i class="fa-solid fa-xmark"></i> Từ chối
            </button>
          </div>
          ` : ''}
        </div>
      `;
    }

    // Render student note cards
    function renderStudentNoteCard(n) {
      const teacherName = n.teacher_name || n.teacher_email;
      const studentName = n.student_name || n.student_email;
      const createdDate = new Date(n.created_at).toLocaleDateString('vi-VN');
      const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
      const dayLabel = dayNames[n.day_of_week] || '';

      let statusClass = 'status-pending';
      let statusText = '<i class="fa-solid fa-clock"></i> Chờ xử lý';
      if (n.status === 'resolved') { statusClass = 'status-resolved'; statusText = '<i class="fa-solid fa-check"></i> Đã xử lý'; }
      else if (n.status === 'rejected') { statusClass = 'status-rejected'; statusText = '<i class="fa-solid fa-xmark"></i> Đã từ chối'; }

      const resolvedInfo = n.resolved_at ? `<div class="resolved-info"><i class="fa-solid fa-user-check"></i> Xử lý bởi: ${wmEscape(n.resolved_by || 'N/A')} <span class="resolved-date">lúc ${new Date(n.resolved_at).toLocaleString('vi-VN')}</span></div>` : '';
      const adminNote = n.admin_response ? `<div class="admin-note-display"><i class="fa-solid fa-note-sticky"></i> <strong>Phản hồi:</strong> ${wmEscape(n.admin_response)}</div>` : '';
      const isPending = n.status === 'pending';

      return `
        <div class="request-item ${statusClass}" data-sn-id="${n.id}" style="border-left:3px solid #f59e0b;">
          <div class="request-item-header">
            <span class="request-teacher"><i class="fa-solid fa-flag" style="color:#f59e0b;margin-right:4px;"></i> ${wmEscape(teacherName)}</span>
            <span class="request-status-badge ${statusClass}">${statusText}</span>
          </div>
          <div class="request-time"><i class="fa-solid fa-user-graduate"></i> HV: <strong>${wmEscape(studentName)}</strong> • ${dayLabel} ${wmEscape(n.time_local || '')} • ${wmEscape(n.role || '')}</div>
          <div class="request-reason">${wmEscape(n.note)}</div>
          ${resolvedInfo}
          ${adminNote}
          <div class="request-meta"><i class="fa-regular fa-paper-plane"></i> Gửi lúc: ${createdDate}</div>
          ${isPending && window.CAN_EDIT ? `
          <div class="request-actions">
            <button class="req-btn req-btn-approve" data-sn-id="${n.id}" data-sn-action="resolved"><i class="fa-solid fa-check"></i> Đã xử lý</button>
            <button class="req-btn req-btn-reject" data-sn-id="${n.id}" data-sn-action="rejected"><i class="fa-solid fa-xmark"></i> Từ chối</button>
          </div>` : ''}
        </div>`;
    }

    const pendingSN = studentNotes.filter(n => n.status === 'pending');
    const processedSN = studentNotes.filter(n => n.status !== 'pending');

    // Build 2-column layout
    panelBody.innerHTML = `
      <div class="log-columns">
        <div class="log-column log-column-pending">
          <div class="log-column-header pending-header">
            <i class="fa-solid fa-clock"></i>
            <span>Chờ xử lý</span>
            <span class="log-column-count">${pendingRequests.length + pendingSN.length}</span>
          </div>
          <div class="log-column-body">
            ${pendingRequests.length > 0
        ? pendingRequests.map(renderRequestCard).join('')
        : ''}
            ${pendingSN.length > 0
        ? '<div style="padding:8px 12px;font-size:0.75rem;font-weight:700;color:#d97706;border-top:1px solid #fde68a;margin-top:8px;"><i class="fa-solid fa-flag"></i> Ghi chú về HV</div>' + pendingSN.map(renderStudentNoteCard).join('')
        : ''}
            ${pendingRequests.length === 0 && pendingSN.length === 0
        ? '<div class="no-items"><i class="fa-solid fa-check-circle"></i> Không có yêu cầu chờ xử lý</div>'
        : ''}
          </div>
        </div>
        <div class="log-column log-column-processed">
          <div class="log-column-header processed-header">
            <i class="fa-solid fa-clipboard-check"></i>
            <span>Đã xử lý</span>
            <span class="log-column-count">${processedRequests.length + processedSN.length}</span>
          </div>
          <div class="log-column-body">
            ${processedRequests.length > 0
        ? processedRequests.map(renderRequestCard).join('')
        : ''}
            ${processedSN.length > 0
        ? '<div style="padding:8px 12px;font-size:0.75rem;font-weight:700;color:#d97706;border-top:1px solid #fde68a;margin-top:8px;"><i class="fa-solid fa-flag"></i> Ghi chú về HV</div>' + processedSN.map(renderStudentNoteCard).join('')
        : ''}
            ${processedRequests.length === 0 && processedSN.length === 0
        ? '<div class="no-items"><i class="fa-solid fa-inbox"></i> Chưa có yêu cầu nào được xử lý</div>'
        : ''}
          </div>
        </div>
      </div>
    `;

    // Attach action handlers for student note items
    panelBody.querySelectorAll('[data-sn-id][data-sn-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.snId;
        const action = btn.dataset.snAction;
        const adminNote = await showAdminNotePopup(id, action);
        if (adminNote === null) return;
        try {
          const snRes = await fetch(_DO + '/student-note', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id, status: action, adminResponse: adminNote })
          });
          const snOut = await snRes.json();
          if (!snRes.ok || !snOut.ok) throw new Error(snOut.error || 'Lỗi');
        } catch (e) { alert('Lỗi: ' + e.message); }
        loadLogData();
        loadPendingRequestChanges();
      });
    });

    // Attach action handlers for pending items
    panelBody.querySelectorAll('.req-btn:not([data-sn-id])').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;

        const adminNote = await showAdminNotePopup(id, action);
        if (adminNote === null) return;

        await handleRequestAction(id, action, adminNote);
        loadLogData(); // Refresh log
        loadPendingRequestChanges(); // Refresh badge
        loadWorkMeetings(); // Refresh roster
      });
    });

  } catch (e) {
    panelBody.innerHTML = '<div class="no-data">Lỗi: ' + e.message + '</div>';
  }
}

async function handleRequestAction(id, status, adminResponse = '') {
  try {
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const res = await fetch(_DO + '/request-change', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ id, status, adminResponse })
    });

    const result = await res.json();
    if (!res.ok || !result.ok) {
      throw new Error(result.error || 'Failed to update request');
    }

    showMsg(status === 'resolved' ? 'Đã đánh dấu xử lý xong.' : 'Đã từ chối yêu cầu.', 'success');
  } catch (e) {
    showMsg('Lỗi: ' + e.message, 'error');
  }
}

function showAdminNotePopup(requestId, action) {
  return new Promise((resolve) => {
    // Remove existing popup
    document.getElementById('adminNotePopup')?.remove();

    const popup = document.createElement('div');
    popup.id = 'adminNotePopup';
    popup.className = 'admin-note-popup';
    popup.innerHTML = `
      <div class="admin-note-overlay"></div>
      <div class="admin-note-content">
        <div class="admin-note-header">
          <h3><i class="fa-solid fa-note-sticky"></i> ${action === 'resolved' ? 'Ghi chú xử lý' : 'Lý do từ chối'}</h3>
          <button class="admin-note-close" id="closeAdminNote">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="admin-note-body">
          <textarea id="adminNoteInput" placeholder="${action === 'resolved' ? 'Nhập ghi chú xử lý (không bắt buộc)...' : 'Nhập lý do từ chối...'}" rows="4"></textarea>
        </div>
        <div class="admin-note-actions">
          <button class="admin-note-btn admin-note-cancel" id="cancelAdminNote">Hủy</button>
          <button class="admin-note-btn admin-note-confirm ${action === 'resolved' ? 'btn-resolve' : 'btn-reject'}" id="confirmAdminNote">
            <i class="fa-solid fa-${action === 'resolved' ? 'check' : 'xmark'}"></i>
            ${action === 'resolved' ? 'Xác nhận xử lý' : 'Xác nhận từ chối'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // Close handlers
    popup.querySelector('#closeAdminNote').addEventListener('click', () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector('.admin-note-overlay').addEventListener('click', () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector('#cancelAdminNote').addEventListener('click', () => {
      popup.remove();
      resolve(null);
    });
    popup.querySelector('#confirmAdminNote').addEventListener('click', () => {
      const note = document.getElementById('adminNoteInput').value.trim();
      popup.remove();
      resolve(note);
    });

    // Focus input
    setTimeout(() => document.getElementById('adminNoteInput')?.focus(), 100);
  });
}

/* ---------- Confirmation Calendar FAB + Popup ---------- */
function setupConfirmationFab() {
  // Create FAB if missing
  let fab = document.getElementById('fabConfirm');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'fabConfirm';
    fab.className = 'fab fab--confirm';
    fab.title = 'Xác nhận lịch làm việc';
    fab.setAttribute('aria-label', 'Xác nhận lịch làm việc');
    fab.innerHTML = '<i class="fa-solid fa-calendar-check" aria-hidden="true"></i>';
    document.body.appendChild(fab);
  }

  fab.addEventListener('click', () => {
    // Navigate to confirmation page instead of popup
    window.location.href = './confirmation.html';
  });
}


/* ---------- Sidebar Functions ---------- */
function setupSidebar() {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const closeBtn = document.getElementById('sidebarClose');
  const logoutBtn = document.getElementById('sidebarLogout');

  if (!toggle || !sidebar) return;

  const openSidebar = () => {
    sidebar.classList.add('open');
    overlay?.classList.add('show');
    updateSidebarWeekLabel(); // Update week label when opening
  };

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay?.classList.remove('show');
  };

  toggle.addEventListener('click', openSidebar);
  closeBtn?.addEventListener('click', closeSidebar);
  overlay?.addEventListener('click', closeSidebar);

  // Sidebar logout button
  logoutBtn?.addEventListener('click', async () => {
    closeSidebar();
    if (client) {
      await client.auth.signOut();
    }
  });

  // Sidebar Add Meeting button (Admin only)
  const addMeetingBtn = document.getElementById('sidebarAddMeeting');
  addMeetingBtn?.addEventListener('click', async () => {
    closeSidebar();
    const verified = await askSecurityKey('add a work meeting');
    if (!verified) return;
    const modal = document.getElementById('fabModal');
    if (modal) {
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }
  });

  // Sidebar Add Working button (Admin only)
  const addWorkingBtn = document.getElementById('sidebarAddWorking');
  addWorkingBtn?.addEventListener('click', async () => {
    closeSidebar();
    const verified = await askSecurityKey('add a working meeting');
    if (!verified) return;
    const modal = document.getElementById('workingModal');
    if (modal) {
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }
  });

  // Week navigation in sidebar
  const weekPrev = document.getElementById('sidebarWeekPrev');
  const weekNext = document.getElementById('sidebarWeekNext');
  const weekToday = document.getElementById('sidebarWeekToday');
  const weekPicker = document.getElementById('sidebarWeekPicker');

  weekPrev?.addEventListener('click', () => {
    weekOffset -= 1;
    updateSidebarWeekLabel();
    loadWorkMeetings();
  });

  weekNext?.addEventListener('click', () => {
    weekOffset += 1;
    updateSidebarWeekLabel();
    loadWorkMeetings();
  });

  weekToday?.addEventListener('click', () => {
    weekOffset = 0;
    updateSidebarWeekLabel();
    loadWorkMeetings();
    closeSidebar();
  });

  weekPicker?.addEventListener('click', () => {
    closeSidebar();
    showWeekPickerPopup();
  });
}

// Update the week label in sidebar
function updateSidebarWeekLabel() {
  const label = document.getElementById('sidebarWeekLabel');
  if (!label) return;

  const base = new Date();
  base.setDate(base.getDate() + (weekOffset * 7));
  const weekStart = startOfWeekLocal(base);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const formatDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

  if (weekOffset === 0) {
    label.textContent = 'Tuần này';
  } else if (weekOffset === -1) {
    label.textContent = 'Tuần trước';
  } else if (weekOffset === 1) {
    label.textContent = 'Tuần sau';
  } else {
    label.textContent = `${formatDate(weekStart)} – ${formatDate(weekEnd)}`;
  }
}

// Show admin section in sidebar when user is admin
function showSidebarAdminSection() {
  const section = document.getElementById('sidebarAdminSection');
  if (section && window.CAN_EDIT) {
    section.style.display = 'block';
  }
}

/* ---------- Calendar View Button (Previous Weeks) ---------- */
function setupCalendarViewButton() {
  // Removed - week selection is now in sidebar
}

function showWeekPickerPopup() {
  // Remove existing popup
  document.getElementById('weekPickerPopup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'weekPickerPopup';
  popup.className = 'week-picker-popup';

  // Generate list of weeks (current week + 8 previous weeks + 4 future weeks)
  const weeks = [];
  for (let i = -8; i <= 4; i++) {
    const base = new Date();
    base.setDate(base.getDate() + (i * 7));
    const weekStart = startOfWeekLocal(base);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    weeks.push({
      offset: i,
      label: `${formatDateShort(weekStart)} – ${formatDateShort(weekEnd)}`,
      isCurrent: i === weekOffset
    });
  }

  popup.innerHTML = `
    <div class="week-picker-overlay"></div>
    <div class="week-picker-content">
      <div class="week-picker-header">
        <h3><i class="fa-solid fa-calendar-alt"></i> Chọn tuần</h3>
        <button class="week-picker-close" id="closeWeekPicker">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="week-picker-body">
        ${weeks.map(w => `
          <button class="week-picker-item ${w.isCurrent ? 'active' : ''} ${w.offset === 0 ? 'current-week' : ''}" data-offset="${w.offset}">
            <i class="fa-solid fa-calendar-week"></i>
            <span>${w.label}</span>
            ${w.offset === 0 ? '<span class="week-badge">Tuần này</span>' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  // Close handlers
  popup.querySelector('#closeWeekPicker').addEventListener('click', () => popup.remove());
  popup.querySelector('.week-picker-overlay').addEventListener('click', () => popup.remove());

  // Week selection
  popup.querySelectorAll('.week-picker-item').forEach(item => {
    item.addEventListener('click', () => {
      weekOffset = parseInt(item.dataset.offset);
      loadWorkMeetings();
      popup.remove();
    });
  });
}

function formatDateShort(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}


/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  setupPasswordToggle();
  setupLoginHandler();
  setupSidebar();
  setupCalendarViewButton();
  // do NOT call setupFabModal() here
});

// ========== TRANSFER STUDENTS MODAL ==========
function setupTransferModal() {
  let modal = document.getElementById('transferModal');
  if (modal && modal.dataset.wired === 'true') return;

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'transferModal';
    modal.className = 'modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-overlay" id="tfOverlay"></div>
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="tfTitle" style="max-width:560px;max-height:85vh;overflow-y:auto;">
        <div class="modal-header">
          <h3 id="tfTitle"><i class="fa-solid fa-right-left" style="color:#7c3aed;margin-right:8px;"></i>Transfer Students</h3>
          <button class="icon-btn" id="tfClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body" id="tfBody">
          <div style="text-align:center;padding:30px;color:#9ca3af;">Loading…</div>
        </div>
        <div class="modal-footer">
          <button class="btn-ghost" id="tfCancel">Cancel</button>
          <button class="btn-primary" id="tfSave" disabled>
            <i class="fa-solid fa-check"></i> Transfer
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  modal.dataset.wired = 'true';

  // State
  let tfState = {
    teacherEmail: '',
    teacherName: '',
    endTime: '',
    workDate: '',
    department: '',
    students: [],              // students of this teacher today
    availableTeachers: [],     // teachers working at the right time
    assignments: {},           // { studentEmail: { toEmail, toName } } — legacy, kept for compat
    selectedTeacher: null,     // currently selected destination teacher
    selectedStudents: new Set(),  // student emails checked in step 1
    completedEmails: new Set(),   // student emails already saved to DB
    showTeacherStep: false,       // flag to show teacher selection step
    transferHistory: []           // saved transfers loaded from DB [{id, student_email, student_name, to_teacher_email, to_teacher_name}]
  };

  async function authToken() {
    const { data: { session } } = await client.auth.getSession();
    return session?.access_token || null;
  }

  // Open
  const open = async (info) => {
    tfState.teacherEmail = info.teacherEmail;
    tfState.teacherName = info.teacherName;
    tfState.endTime = info.endTime;
    tfState.workDate = info.workDate;
    tfState.department = info.department;
    tfState.students = [];
    tfState.availableTeachers = [];
    tfState.assignments = {};
    tfState.selectedTeacher = null;
    tfState.selectedStudents = new Set();
    tfState.completedEmails = new Set();
    tfState.showTeacherStep = false;

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('tfSave').disabled = true;
    document.getElementById('tfBody').innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;"><i class="fa-solid fa-spinner fa-spin"></i> Loading students & teachers…</div>';

    try {
      // 1. Fetch this teacher's students for today's day-of-week
      const [y, m, d] = tfState.workDate.split('-').map(Number);
      const dow = new Date(y, m - 1, d).getDay(); // 0=Sun

      const { data: schedRows, error: schedErr } = await client
        .from('student_schedule')
        .select('student_email, day_of_week, time_local, teacher_email, breakout_email, buoi_phu')
        .eq('day_of_week', dow);

      if (schedErr) throw schedErr;

      // Filter to students belonging to this teacher (as TTKB or Breakout)
      const myStudents = (schedRows || []).filter(s => {
        const tEmail = (s.teacher_email || '').toLowerCase();
        const bEmail = (s.breakout_email || '').toLowerCase();
        return tEmail === tfState.teacherEmail || bEmail === tfState.teacherEmail;
      });

      // Get student names from danh_sach_hv
      const studentEmails = myStudents.map(s => s.student_email).filter(Boolean);
      let nameMap = {};
      if (studentEmails.length) {
        const { data: nameRows } = await client
          .from('danh_sach_hv')
          .select('email, ten_hv, status, cap_lop_hoc')
          .in('email', studentEmails);
        if (nameRows) {
          nameMap = Object.fromEntries(nameRows.map(r => [r.email, r]));
        }
      }

      tfState.students = myStudents.map(s => {
        const info = nameMap[s.student_email] || {};
        return {
          email: s.student_email,
          name: info.ten_hv || (s.student_email || '').split('@')[0],
          time_local: (s.time_local || '').slice(0, 5),
          level: info.cap_lop_hoc || '',
          minutes: Number(info.status || 0),
          role: (s.breakout_email || '').toLowerCase() === tfState.teacherEmail ? 'Breakout' : 'TTKB'
        };
      });

      // Sort by time
      tfState.students.sort((a, b) => a.time_local.localeCompare(b.time_local));

      // 2. Fetch available teachers for this date
      const token = await authToken();
      const wtRes = await fetch(`${_DO}/get-working-teachers?date=${tfState.workDate}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!wtRes.ok) throw new Error('Failed to load working teachers');
      const wtData = await wtRes.json();

      // Exclude the current teacher from the list
      tfState.availableTeachers = (wtData.workingTeachers || []).filter(
        t => t.teacher_email.toLowerCase() !== tfState.teacherEmail
      );

      // 3. Load existing transfers for this date
      const exRes = await fetch(`${_DO}/save-student-transfer?date=${tfState.workDate}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      tfState.transferHistory = [];
      if (exRes.ok) {
        const exData = await exRes.json();
        const existing = (exData.transfers || []).filter(
          t => t.from_teacher_email.toLowerCase() === tfState.teacherEmail
        );
        for (const t of existing) {
          tfState.assignments[t.student_email] = {
            toEmail: t.to_teacher_email,
            toName: t.to_teacher_name || t.to_teacher_email
          };
          tfState.completedEmails.add(t.student_email);
          // Save full details for history display
          const studentInfo = tfState.students.find(s => s.email === t.student_email);
          tfState.transferHistory.push({
            id: t.id,
            student_email: t.student_email,
            student_name: t.student_name || (studentInfo ? studentInfo.name : t.student_email),
            to_teacher_email: t.to_teacher_email,
            to_teacher_name: t.to_teacher_name || t.to_teacher_email,
            time_local: studentInfo ? studentInfo.time_local : ''
          });
        }
      }

      renderTransferUI();

    } catch (err) {
      console.error('Transfer modal load error:', err);
      document.getElementById('tfBody').innerHTML = `<div style="text-align:center;padding:30px;color:#dc2626;">Error: ${wmEscape(err.message)}</div>`;
    }
  };

  function renderTransferUI() {
    const body = document.getElementById('tfBody');

    // Filter out already-transferred students (saved to DB in this session)
    const remaining = tfState.students.filter(s => !tfState.completedEmails.has(s.email));

    // Also count previously saved (loaded from DB)
    const previouslySaved = tfState.students.filter(s => tfState.completedEmails.has(s.email));
    const totalDone = previouslySaved.length;

    // ALL DONE - show success
    if (!remaining.length) {
      body.innerHTML = `
        <div style="text-align:center;padding:40px 20px;">
          <i class="fa-solid fa-circle-check" style="font-size:3rem;color:#059669;margin-bottom:12px;"></i>
          <div style="font-size:1rem;font-weight:700;color:#059669;margin-bottom:6px;">Đã chuyển giao tất cả HV!</div>
          <div style="font-size:0.85rem;color:#6b7280;">${totalDone} HV đã được chuyển giao thành công.</div>
        </div>`;
      document.getElementById('tfSave').disabled = false;
      document.getElementById('tfSave').innerHTML = '<i class="fa-solid fa-check"></i> Đóng';
      return;
    }

    // STEP 1: Show students to select (no teacher chosen yet)
    if (!tfState.showTeacherStep) {
      const studentListHtml = remaining.map(s => {
        const isChecked = tfState.selectedStudents.has(s.email);
        const roleClass = s.role === 'Breakout' ? 'tf-role-breakout' : 'tf-role-ttkb';
        return `
          <label class="tf-student-row" data-email="${wmEscape(s.email)}">
            <input type="checkbox" class="tf-student-check" data-email="${wmEscape(s.email)}" ${isChecked ? 'checked' : ''} />
            <div class="tf-student-info">
              <span class="tf-student-name">${wmEscape(s.name)}</span>
              <span class="tf-student-meta">${wmEscape(s.time_local)} · ${wmEscape(s.level)} · ${s.minutes} min</span>
              <span class="tf-role-badge ${roleClass}">${wmEscape(s.role)}</span>
            </div>
          </label>`;
      }).join('');

      body.innerHTML = `
        <div class="tf-info-bar">
          <i class="fa-solid fa-user-tie"></i>
          <strong>${wmEscape(tfState.teacherName)}</strong>
          <span style="color:#6b7280;margin-left:6px;">ends at ${wmEscape(tfState.endTime)}</span>
          <span style="margin-left:auto;font-size:0.78rem;color:#059669;font-weight:600;">${totalDone} transferred</span>
        </div>
        ${totalDone > 0 ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:8px 14px;margin-bottom:10px;font-size:0.8rem;color:#166534;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <span><i class="fa-solid fa-check" style="margin-right:6px;"></i>${totalDone} HV đã chuyển giao. Còn ${remaining.length} HV.</span>
          <button type="button" id="tfCloseAll" style="font-size:0.75rem;font-weight:700;color:#fff;background:#059669;border:none;border-radius:8px;padding:6px 12px;cursor:pointer;">Đã chuyển giao tất cả HV</button>
        </div>` : ''}
        ${tfState.transferHistory.length > 0 ? `
        <div class="tf-section-label"><i class="fa-solid fa-clock-rotate-left"></i> Đã chuyển giao hôm nay</div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;">
          ${tfState.transferHistory.map(h => `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:0.82rem;" data-transfer-id="${h.id}">
              <i class="fa-solid fa-check-circle" style="color:#059669;flex-shrink:0;"></i>
              <div style="flex:1;min-width:0;">
                <span style="font-weight:600;color:#1f2937;">${wmEscape(h.student_name)}</span>
                <span style="color:#6b7280;font-size:0.72rem;margin-left:4px;">${wmEscape(h.time_local)}</span>
                <span style="color:#059669;font-size:0.72rem;font-weight:600;margin-left:6px;">→ ${wmEscape(h.to_teacher_name)}</span>
              </div>
              <button type="button" class="tf-undo-btn" data-transfer-id="${h.id}" data-student-email="${wmEscape(h.student_email)}" style="font-size:0.7rem;color:#dc2626;background:#fee2e2;border:1px solid #fecaca;border-radius:6px;padding:3px 8px;cursor:pointer;font-weight:600;white-space:nowrap;">
                <i class="fa-solid fa-xmark" style="margin-right:2px;"></i> Huỷ
              </button>
            </div>
          `).join('')}
        </div>` : ''}
        <div class="tf-section-label"><i class="fa-solid fa-check-square"></i> Step 1: Select students to transfer</div>
        <div style="margin-bottom:8px;">
          <button type="button" id="tfSelectAll" style="font-size:0.75rem;color:#7c3aed;background:none;border:none;cursor:pointer;font-weight:600;padding:2px 0;">Select all (${remaining.length})</button>
        </div>
        <div class="tf-student-list" id="tfStudentList">${studentListHtml}</div>
      `;

      // Wire select all
      body.querySelector('#tfSelectAll').addEventListener('click', () => {
        const allSelected = remaining.every(s => tfState.selectedStudents.has(s.email));
        if (allSelected) {
          tfState.selectedStudents.clear();
        } else {
          remaining.forEach(s => tfState.selectedStudents.add(s.email));
        }
        renderTransferUI();
      });

      // Wire "done all" close button
      const closeAllBtn = body.querySelector('#tfCloseAll');
      if (closeAllBtn) {
        closeAllBtn.addEventListener('click', () => {
          close();
          loadWorkMeetings();
        });
      }
// Wire undo buttons for transfer history
      body.querySelectorAll('.tf-undo-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const transferId = btn.dataset.transferId;
          const studentEmail = btn.dataset.studentEmail;
          if (!transferId) return;

          btn.disabled = true;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

          try {
            const token = await authToken();
            const res = await fetch(_DO + '/save-student-transfer', {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
              },
              body: JSON.stringify({ id: transferId })
            });
            const out = await res.json();
            if (!res.ok || !out.ok) throw new Error(out.error || 'Delete failed');

            // Remove from state
            tfState.completedEmails.delete(studentEmail);
            delete tfState.assignments[studentEmail];
            tfState.transferHistory = tfState.transferHistory.filter(h => h.id !== transferId);

            // Re-render
            renderTransferUI();
            showMsg('Đã huỷ chuyển giao.', 'success');
          } catch (err) {
            console.error('Undo transfer error:', err);
            showMsg('Lỗi: ' + (err.message || 'Không huỷ được'), 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-xmark" style="margin-right:2px;"></i> Huỷ';
          }
        });
      });


      // Wire checkboxes
      body.querySelectorAll('.tf-student-check').forEach(cb => {
        cb.addEventListener('change', () => {
          const email = cb.dataset.email;
          if (cb.checked) {
            tfState.selectedStudents.add(email);
          } else {
            tfState.selectedStudents.delete(email);
          }
          // Enable/disable the Transfer button
          document.getElementById('tfSave').disabled = tfState.selectedStudents.size === 0;
          document.getElementById('tfSave').innerHTML = tfState.selectedStudents.size > 0
            ? `<i class="fa-solid fa-right-left"></i> Chuyển giao (${tfState.selectedStudents.size})`
            : '<i class="fa-solid fa-right-left"></i> Chuyển giao';
        });
      });

      // Update button
      const saveBtn = document.getElementById('tfSave');
      saveBtn.disabled = tfState.selectedStudents.size === 0;
      saveBtn.innerHTML = tfState.selectedStudents.size > 0
        ? `<i class="fa-solid fa-right-left"></i> Chuyển giao (${tfState.selectedStudents.size})`
        : '<i class="fa-solid fa-right-left"></i> Chuyển giao';
      return;
    }

    // STEP 2: Teacher is selected — show confirmation and Transfer button
    const selectedStudentsList = remaining.filter(s => tfState.selectedStudents.has(s.email));

    // Teacher list
    const teacherListHtml = tfState.availableTeachers.map(t => {
      const shifts = (t.shifts || []).map(s => `${s.start_time}–${s.end_time} ${s.department || ''}`).join(', ');
      const initials = wmInitials(t.teacher_name || t.teacher_email);
      const isSelected = tfState.selectedTeacher?.teacher_email === t.teacher_email;
      return `
        <div class="tf-teacher-item ${isSelected ? 'tf-teacher-selected' : ''}" data-email="${wmEscape(t.teacher_email)}" data-name="${wmEscape(t.teacher_name || t.teacher_email)}">
          <span class="tf-teacher-avatar">${wmEscape(initials)}</span>
          <div>
            <div class="tf-teacher-name">${wmEscape(t.teacher_name || t.teacher_email)}</div>
            <div class="tf-teacher-shifts">${wmEscape(shifts)}</div>
          </div>
        </div>`;
    }).join('');

    // Selected students summary
    const selectedSummaryHtml = selectedStudentsList.map(s => {
      const roleClass = s.role === 'Breakout' ? 'tf-role-breakout' : 'tf-role-ttkb';
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f5f3ff;border-radius:8px;font-size:0.82rem;">
          <span style="font-weight:600;color:#1f2937;">${wmEscape(s.name)}</span>
          <span style="color:#9ca3af;font-size:0.72rem;">${wmEscape(s.time_local)} · ${s.minutes}min</span>
          <span class="tf-role-badge ${roleClass}" style="margin-left:auto;">${wmEscape(s.role)}</span>
        </div>`;
    }).join('');

    body.innerHTML = `
      <div class="tf-info-bar">
        <i class="fa-solid fa-user-tie"></i>
        <strong>${wmEscape(tfState.teacherName)}</strong>
        <span style="color:#6b7280;margin-left:6px;">ends at ${wmEscape(tfState.endTime)}</span>
        <span style="margin-left:auto;font-size:0.78rem;color:#059669;font-weight:600;">${totalDone} transferred</span>
      </div>

      <div style="margin-bottom:10px;">
        <button type="button" id="tfBackToStudents" style="font-size:0.8rem;color:#7c3aed;background:none;border:none;cursor:pointer;font-weight:600;display:flex;align-items:center;gap:4px;">
          <i class="fa-solid fa-arrow-left" style="font-size:0.7rem;"></i> Back to student selection
        </button>
      </div>

      <div class="tf-section-label"><i class="fa-solid fa-users"></i> ${selectedStudentsList.length} student${selectedStudentsList.length !== 1 ? 's' : ''} selected</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;">${selectedSummaryHtml}</div>

      <div class="tf-section-label"><i class="fa-solid fa-arrow-right"></i> Step 2: Pick destination teacher</div>
      <div class="tf-teacher-list" id="tfTeacherList">${teacherListHtml || '<div style="padding:12px;color:#9ca3af;">No other teachers working.</div>'}</div>
    `;

    // Wire back button
    body.querySelector('#tfBackToStudents').addEventListener('click', () => {
      tfState.selectedTeacher = null;
      tfState.showTeacherStep = false;
    tfState.transferHistory = [];
      renderTransferUI();
    });

    // Wire teacher click
    body.querySelectorAll('.tf-teacher-item').forEach(el => {
      el.addEventListener('click', () => {
        const email = el.dataset.email;
        const name = el.dataset.name;
        const t = tfState.availableTeachers.find(x => x.teacher_email === email);
        tfState.selectedTeacher = t ? { teacher_email: email, teacher_name: name } : null;
        renderTransferUI();
      });
    });

    // Update button to "Transfer" mode
    const saveBtn = document.getElementById('tfSave');
    saveBtn.disabled = !tfState.selectedTeacher;
    saveBtn.innerHTML = tfState.selectedTeacher
      ? `<i class="fa-solid fa-check"></i> Transfer ${selectedStudentsList.length} to ${wmEscape(tfState.selectedTeacher.teacher_name)}`
      : '<i class="fa-solid fa-hand-pointer"></i> Pick a teacher above';
  }

  const close = () => {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (tfState.completedEmails.size > 0) {
      loadWorkMeetings();
    }
  };

  window.openTransferModal = open;

  modal.querySelector('#tfClose').addEventListener('click', close);
  modal.querySelector('#tfCancel').addEventListener('click', close);
  modal.querySelector('#tfOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'tfOverlay') close();
  });

  // Save / Next button (handles both Step 1 → Step 2 transition AND actual save)
  modal.querySelector('#tfSave').addEventListener('click', async () => {

    // ALL DONE: close modal
    if (tfState.completedEmails.size > 0 && tfState.students.every(s => tfState.completedEmails.has(s.email))) {
      close();
      loadWorkMeetings();
      return;
    }


    // STEP 1 → STEP 2: User clicked "Next: Pick teacher" — re-fetch teachers filtered by student time
    if (!tfState.showTeacherStep && tfState.selectedStudents.size > 0) {
      const saveBtn = document.getElementById('tfSave');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading teachers…';

      try {
        // Find the earliest selected student's time
        const selectedTimes = tfState.students
          .filter(s => tfState.selectedStudents.has(s.email))
          .map(s => s.time_local)
          .filter(Boolean)
          .sort();
        const studentTime = selectedTimes[0] || '';

        const token = await authToken();
        const timeParam = studentTime ? `&time=${studentTime}` : '';
        const wtRes = await fetch(`${_DO}/get-working-teachers?date=${tfState.workDate}${timeParam}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (wtRes.ok) {
          const wtData = await wtRes.json();
          tfState.availableTeachers = (wtData.workingTeachers || []).filter(
            t => t.teacher_email.toLowerCase() !== tfState.teacherEmail
          );
        }
      } catch (err) {
        console.error('Re-fetch teachers error:', err);
      }

      tfState.showTeacherStep = true;
      tfState.selectedTeacher = null;
      renderTransferUI();
      return;
    }

    // ACTUAL TRANSFER: selectedTeacher is set and students are selected
    if (!tfState.selectedTeacher || tfState.selectedStudents.size === 0) return;

    const saveBtn = document.getElementById('tfSave');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Transferring…';

    try {
      const token = await authToken();
      const { data: { user } } = await client.auth.getUser();
      const myEmail = user?.email || '';

      const transfers = [...tfState.selectedStudents].map(studentEmail => {
        const studentInfo = tfState.students.find(s => s.email === studentEmail);
        return {
          transfer_date: tfState.workDate,
          from_teacher_email: tfState.teacherEmail,
          to_teacher_email: tfState.selectedTeacher.teacher_email,
          to_teacher_name: tfState.selectedTeacher.teacher_name,
          student_email: studentEmail,
          student_name: studentInfo?.name || studentEmail,
          transfer_time: tfState.endTime ? tfState.endTime + ':00' : null,
          created_by: myEmail
        };
      });

      const res = await fetch(_DO + '/save-student-transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ transfers })
      });

      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error || 'Save failed');

      // Mark these students as completed
      for (const email of tfState.selectedStudents) {
        tfState.completedEmails.add(email);
      }

      // Reset for next batch
      tfState.selectedStudents.clear();
      tfState.selectedTeacher = null;
      tfState.showTeacherStep = false;

      // Re-render to show remaining students (or "All done" screen)
      renderTransferUI();

      // Show brief success message
      showMsg(`Transferred ${transfers.length} student${transfers.length !== 1 ? 's' : ''}!`, 'success');

    } catch (err) {
      console.error('Save transfer error:', err);
      showMsg('Error: ' + (err.message || 'Save failed'), 'error');
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Transfer';
    }
  });
}