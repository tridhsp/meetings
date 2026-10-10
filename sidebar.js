/* sidebar.js — tansinh sb-v1 (10 Oct 2026)
 *
 * ONE shared sidebar for every page of meetings.tansinh.info.
 * Each page loads this file right after <body>, WITHOUT "defer", so the
 * menu is on screen before anything else paints.
 *
 * What it does
 *   1. draws the hamburger button, the drawer and the dim overlay
 *   2. marks the current page; hides pages the signed-in role cannot open
 *   3. shows who is signed in (read from the saved Supabase session) and
 *      gives every page a working "Đăng xuất"
 *   4. keeps the drawer open across a page change and slides it away once
 *      the new page is on screen — that is the "smooth" part
 *   5. on index.html, moves the week selector and the admin buttons
 *      (#sidebarPageExtras) into the drawer, so script.js still finds them
 *
 * Two ids are kept on purpose: #sidebar and #sidebarToggle. script.js and
 * confirmation.js look them up. Their own open/close code now does nothing
 * visible (it toggles a class this drawer does not use), which is fine —
 * this file owns open and close.
 *
 * To rename a menu item, change its order, or add a page: edit NAV below.
 * That is the only place the menu is written.
 */
(function () {
  'use strict';
  if (window.__tsSidebar) { return; }

  // ---- the menu. Edit here, nowhere else. ------------------------------
  // roles: which roles may see the link. null = everyone.
  // A link is only hidden once the role is KNOWN and not in the list.
  var NAV = [
    { href: 'index.html',          label: 'Lịch làm việc',       icon: 'fa-house',           roles: ['teacher', 'admin', 'super admin'] },
    { href: 'confirmation.html',   label: 'Xác nhận lịch & HV',  icon: 'fa-calendar-check',  roles: ['teacher', 'admin', 'super admin'] },
    { href: 'studentmeeting.html', label: 'Lịch học của HV',     icon: 'fa-user-graduate',   roles: null },
    { href: 'offteachers.html',    label: 'GV nghỉ & thay thế',  icon: 'fa-user-slash',      roles: ['admin', 'super admin'] }
  ];

  var CARRY_KEY = 'ts.sidebar.carry';   // sessionStorage: "a page change is in progress, keep the drawer open"
  var ROLE_KEY  = 'ts.sidebar.role';    // sessionStorage: the role, cached for a few minutes
  var ROLE_TTL  = 10 * 60 * 1000;
  var DAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

  var toggle, drawer, overlay, isOpenFlag = false, lastAppState = null, refreshTimer = null;

  // ---- small helpers --------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayLabel() {
    var d = new Date();
    return DAYS[d.getDay()] + ', ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
  }
  function currentPage() {
    var p = (location.pathname || '').split('/').pop();
    return (p ? p : 'index.html').toLowerCase();
  }
  function isAuthKey(k) { return /^sb-.+-auth-token$/.test(k); }

  // The page's own Supabase client already saved the session in localStorage.
  // Reading it here costs nothing and needs no network.
  function readSession() {
    try {
      var keys = Object.keys(localStorage).filter(isAuthKey);
      for (var i = 0; i < keys.length; i++) {
        var raw = localStorage.getItem(keys[i]);
        if (!raw) { continue; }
        var j = JSON.parse(raw);
        var s = j && j.currentSession ? j.currentSession : j;
        if (s && s.access_token && s.user) {
          var meta = s.user.user_metadata || {};
          return {
            key: keys[i],
            token: s.access_token,
            exp: s.expires_at ? Number(s.expires_at) * 1000 : 0,
            email: String(s.user.email || ''),
            name: String(meta.full_name || meta.name || '')
          };
        }
      }
    } catch (e) { /* a broken localStorage must never break the page */ }
    return null;
  }
  function initials(name, email) {
    var src = (name || '').trim() || (email || '').split('@')[0].replace(/[._-]+/g, ' ');
    var parts = src.split(/\s+/).filter(Boolean);
    if (!parts.length) { return '?'; }
    var a = parts[0].charAt(0), b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }
  function hueFor(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) % 360; }
    return h;
  }
  function roleLabel(r) {
    var x = String(r || '').trim().toLowerCase();
    if (x === 'super admin') { return 'Super Admin'; }
    if (x === 'admin') { return 'Admin'; }
    if (x === 'teacher') { return 'Giáo viên'; }
    if (x === 'student') { return 'Học viên'; }
    return x ? String(r) : '';
  }

  // ---- draw it ---------------------------------------------------------
  function build() {
    var page = currentPage();
    var links = NAV.map(function (n) {
      var active = n.href === page;
      return '<a class="sb-link' + (active ? ' is-active' : '') + '" href="./' + n.href + '"' +
             ' data-page="' + n.href + '"' + (n.roles ? ' data-roles="' + n.roles.join(',') + '"' : '') +
             (active ? ' aria-current="page"' : '') + '>' +
             '<i class="fa-solid ' + n.icon + '" aria-hidden="true"></i><span>' + esc(n.label) + '</span></a>';
    }).join('');

    var html =
      '<button id="sidebarToggle" class="sb-toggle" type="button" aria-label="Mở menu" title="Menu"' +
      ' aria-controls="sidebar" aria-expanded="false"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>' +
      '<div id="sbOverlay" class="sb-overlay"></div>' +
      '<aside id="sidebar" class="sb-drawer" aria-label="Menu" inert>' +
        '<div class="sb-head">' +
          '<a class="sb-brand" href="./index.html">' +
            '<span class="sb-mark" aria-hidden="true"><i class="fa-solid fa-calendar-check"></i></span>' +
            '<span class="sb-brand-text"><strong>Meetings</strong><small id="sbToday">' + esc(todayLabel()) + '</small></span>' +
          '</a>' +
          '<button class="sb-close" id="sbClose" type="button" aria-label="Đóng menu"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' +
        '</div>' +
        '<div class="sb-body">' +
          '<nav class="sb-nav" aria-label="Các trang">' + links + '</nav>' +
          '<div class="sb-page" id="sidebarPageSlot" hidden></div>' +
        '</div>' +
        '<div class="sb-foot">' +
          '<div class="sb-user" id="sbUser">' +
            '<span class="sb-avatar" id="sbAvatar" aria-hidden="true">?</span>' +
            '<span class="sb-user-text"><span class="sb-user-name" id="sbUserName">Chưa đăng nhập</span>' +
            '<span class="sb-user-role" id="sbUserRole"></span></span>' +
          '</div>' +
          '<button class="sb-logout" id="sbLogout" type="button" hidden><i class="fa-solid fa-power-off" aria-hidden="true"></i><span>Đăng xuất</span></button>' +
        '</div>' +
      '</aside>';

    document.body.insertAdjacentHTML('afterbegin', html);
    toggle  = document.getElementById('sidebarToggle');
    drawer  = document.getElementById('sidebar');
    overlay = document.getElementById('sbOverlay');
    document.body.classList.add('sb-ready');
  }

  // index.html keeps its week selector + admin buttons in a hidden box.
  // Move them into the drawer before script.js looks for them.
  function moveExtras() {
    var box = document.getElementById('sidebarPageExtras');
    var slot = document.getElementById('sidebarPageSlot');
    if (!box || !slot) { return; }
    while (box.firstChild) { slot.appendChild(box.firstChild); }
    slot.hidden = false;
    box.parentNode.removeChild(box);
  }

  // ---- open / close ----------------------------------------------------
  function open(opts) {
    opts = opts || {};
    if (isOpenFlag) { return; }
    if (opts.instant) { drawer.classList.add('sb-instant'); overlay.classList.add('sb-instant'); }
    drawer.classList.add('is-open');
    drawer.removeAttribute('inert');
    overlay.classList.add('is-show');
    toggle.classList.add('is-hidden');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sb-locked');
    isOpenFlag = true;
    if (opts.instant) {
      void drawer.offsetWidth;
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        drawer.classList.remove('sb-instant'); overlay.classList.remove('sb-instant');
      }); });
    } else {
      var first = drawer.querySelector('.sb-link:not(.is-hidden)');
      if (first) { setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (e) {} }, 60); }
    }
  }
  function close() {
    if (!isOpenFlag) { return; }
    var hadFocus = drawer.contains(document.activeElement);
    drawer.classList.remove('is-open');
    drawer.setAttribute('inert', '');
    overlay.classList.remove('is-show');
    toggle.classList.remove('is-hidden');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('sb-locked');
    isOpenFlag = false;
    if (hadFocus) { try { toggle.focus({ preventScroll: true }); } catch (e) {} }
  }

  // A click on a menu link: keep the drawer open, let the page change, and
  // let the NEXT page close it once it is on screen (see carryIn below).
  function onNavClick(e, a) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }
    if (a.getAttribute('data-page') === currentPage()) { e.preventDefault(); close(); return; }
    a.classList.add('is-loading');
    try { sessionStorage.setItem(CARRY_KEY, String(Date.now())); } catch (err) {}
  }
  function carryIn() {
    var at = 0;
    try { at = Number(sessionStorage.getItem(CARRY_KEY) || 0); sessionStorage.removeItem(CARRY_KEY); } catch (e) {}
    if (!at || Date.now() - at > 15000) { return; }
    open({ instant: true });
    var done = false;
    function go() { if (done) { return; } done = true; setTimeout(close, 180); }
    if ('onpagereveal' in window) {
      // Chrome: wait for the cross-page crossfade to finish, then slide away.
      window.addEventListener('pagereveal', function (ev) {
        if (ev.viewTransition) { ev.viewTransition.finished.then(go, go); } else { go(); }
      }, { once: true });
      setTimeout(go, 1500); // safety net
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 260); });
    } else {
      setTimeout(go, 260);
    }
  }

  // ---- who is signed in ------------------------------------------------
  function renderUser() {
    var sess = readSession();
    var av = document.getElementById('sbAvatar');
    var nm = document.getElementById('sbUserName');
    var rl = document.getElementById('sbUserRole');
    var lo = document.getElementById('sbLogout');
    if (!sess) {
      av.textContent = '?'; av.style.background = ''; av.style.color = '';
      nm.textContent = 'Chưa đăng nhập'; nm.title = '';
      rl.textContent = ''; lo.hidden = true;
      return;
    }
    var h = hueFor(sess.email.toLowerCase());
    av.textContent = initials(sess.name, sess.email);
    av.style.background = 'hsl(' + h + ', 70%, 92%)';
    av.style.color = 'hsl(' + h + ', 55%, 32%)';
    nm.textContent = sess.name || sess.email; nm.title = sess.email;
    lo.hidden = false;
  }
  function applyRole(role) {
    var known = !!role;
    var x = String(role || '').toLowerCase();
    var links = drawer.querySelectorAll('.sb-link[data-roles]');
    for (var i = 0; i < links.length; i++) {
      var allowed = links[i].getAttribute('data-roles').split(',');
      links[i].classList.toggle('is-hidden', known && allowed.indexOf(x) === -1);
    }
    var rl = document.getElementById('sbUserRole');
    var sess = readSession();
    if (sess) { rl.textContent = known ? roleLabel(role) : (sess.name ? sess.email : ''); }
  }
  function loadRole(sess, force) {
    if (!sess) { applyRole(null); return; }
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(ROLE_KEY) || 'null'); } catch (e) {}
    var fresh = cached && cached.email === sess.email && (Date.now() - cached.at) < ROLE_TTL;
    if (!force && fresh) { applyRole(cached.role); return; }
    if (sess.exp && sess.exp < Date.now() + 5000) {
      // token expired; the page's own client refreshes it, we do not touch it
      applyRole(cached && cached.email === sess.email ? cached.role : null);
      return;
    }
    fetch('/api/check-role', { headers: { Authorization: 'Bearer ' + sess.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var role = j && j.role ? String(j.role) : '';
        try { sessionStorage.setItem(ROLE_KEY, JSON.stringify({ email: sess.email, role: role, at: Date.now() })); } catch (e) {}
        applyRole(role);
      })
      .catch(function () { applyRole(cached && cached.email === sess.email ? cached.role : null); });
  }
  function refresh(force) {
    renderUser();
    loadRole(readSession(), force);
  }

  // ---- log out, on every page --------------------------------------------
  function manualSignOut(sess) {
    var p = Promise.resolve();
    if (sess && sess.token) {
      p = fetch('/api/supabase-credentials').then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.SUPABASE_URL) { return; }
        return fetch(String(j.SUPABASE_URL).replace(/\/$/, '') + '/auth/v1/logout', {
          method: 'POST', headers: { apikey: j.ANON_PUBLIC_KEY || '', Authorization: 'Bearer ' + sess.token }
        });
      }).catch(function () {});
    }
    return p.then(function () {
      try { Object.keys(localStorage).filter(function (k) { return /^sb-.+-auth-token/.test(k); })
        .forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    });
  }
  function logout() {
    close();
    var sess = readSession();
    try { sessionStorage.removeItem(ROLE_KEY); } catch (e) {}
    var p, usedClient = false;
    try {
      // "client" is the page's own Supabase client (script.js, confirmation.js, ...).
      // Prefer it: the page then shows its login card by itself.
      if (typeof client !== 'undefined' && client && client.auth && typeof client.auth.signOut === 'function') {
        usedClient = true;
        p = Promise.resolve(client.auth.signOut()).catch(function () {});
      }
    } catch (e) { usedClient = false; }
    if (!usedClient) { p = manualSignOut(sess); }
    p.then(function () {
      renderUser();
      var hasLoginCard = !!document.getElementById('loginCard');
      if (!usedClient || !hasLoginCard) { location.reload(); return; }
      setTimeout(function () { if (document.body.classList.contains('app')) { location.reload(); } }, 800);
    });
  }

  // ---- wiring ------------------------------------------------------------
  function wire() {
    toggle.addEventListener('click', function () { open(); });
    document.getElementById('sbClose').addEventListener('click', close);
    overlay.addEventListener('click', close);
    document.getElementById('sbLogout').addEventListener('click', logout);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpenFlag) { close(); } });

    drawer.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) { return; }
      var a = t.closest('a.sb-link');
      if (a) { onNavClick(e, a); return; }
      // index.html buttons that open something else: let their handler run, then close
      if (t.closest('#sidebarWeekToday, #sidebarWeekPicker, #sidebarAddMeeting, #sidebarAddWorking')) {
        setTimeout(close, 0);
      }
    });

    // shrink the hamburger a little once the page is scrolled
    var ticking = false;
    function onScroll() {
      if (ticking) { return; }
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var y = window.scrollY || document.documentElement.scrollTop || 0;
        toggle.classList.toggle('is-scrolled', y > 64);
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // when the page signs the user in or out (body gains/loses "app"), redraw the user card
    lastAppState = document.body.classList.contains('app');
    if (window.MutationObserver) {
      new MutationObserver(function () {
        var now = document.body.classList.contains('app');
        if (now === lastAppState) { return; }
        lastAppState = now;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refresh(now); }, 80);
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('storage', function (e) { if (e.key && isAuthKey(e.key)) { refresh(false); } });
  }

  build();
  wire();
  refresh(false);
  carryIn();
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', moveExtras); }
  else { moveExtras(); }

  window.__tsSidebar = { version: 'sb-v1', open: function () { open(); }, close: close, refresh: function () { refresh(true); } };
})();
