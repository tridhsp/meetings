/* timepick.js — tansinh timepick-v1 as ONE shared piece (5 Nov 2026)
 *
 * This is the time picker of "Thêm ca làm việc" (meetings script.js, tansinh
 * timepick-v1, 11 Oct 2026): Sáng/Chiều/Tối presets, typed 24-hour fields with
 * − + buttons, and a timeline with two handles you can drag. Lifted into one
 * file so other pages can use the same picker. script.js still carries its own
 * copy inside setupWorkingFabModal(); switching it to this file is a separate
 * later patch, so the live popup was not touched today.
 *
 *   var tp = window.tsTimePick(host, {
 *     presets: [{ name: 'Sáng', start: '08:00', end: '12:00' }, ...],   // optional, these are the defaults
 *     start: '15:00', end: '18:00',                                      // optional first values
 *     onChange: function (v) {}                                          // optional, v = tp.get()
 *   });
 *   tp.get()   -> { start: 'HH:MM' | null, end: 'HH:MM' | null, s: minutes | null, e: minutes | null }
 *   tp.set('15:00', '18:00')   tp.valid()   tp.focus()
 *
 * It injects its own CSS once (id tsTimePickStyles): the same rules as the
 * timepick block of wlInjectStyles() in script.js. Markup uses the same wl-*
 * class names, scoped to the host element, with no ids, so two pickers on one
 * page cannot clash.
 */
(function () {
  'use strict';
  if (window.tsTimePick) return;

  var CSS = '\n'
    + '.wl-presets{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 10px}\n'
    + '.wl-preset{font-family:inherit;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;color:#374151;font-size:13px;line-height:1;cursor:pointer;font-variant-numeric:tabular-nums}\n'
    + '.wl-preset b{font-weight:700;color:#111827}\n'
    + '.wl-preset:hover{border-color:#cbd5e1;background:#f9fafb}\n'
    + '.wl-preset.on{background:#e0ecff;border-color:#93c5fd;color:#1d4ed8}\n'
    + '.wl-preset.on b{color:#1d4ed8}\n'
    + '.wl-preset:focus-visible{outline:2px solid var(--primary,#0d6efd);outline-offset:2px}\n'
    + '.wl-panel{border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;padding:12px 14px 8px}\n'
    + '.wl-fields{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}\n'
    + '.wl-field{display:flex;flex-direction:column;gap:4px}\n'
    + '.wl-field>span{font-size:12px;color:#6b7280}\n'
    + '.wl-step{display:flex;align-items:center;border:1px solid #e5e7eb;border-radius:10px;background:#fff;overflow:hidden}\n'
    + '.wl-step:focus-within{border-color:var(--primary,#0d6efd);box-shadow:0 0 0 3px rgba(59,130,246,.15)}\n'
    + '.wl-step.bad{border-color:#dc2626}\n'
    + '.wl-tinput{width:84px;flex:none;text-align:center;font-variant-numeric:tabular-nums;font-size:18px;font-weight:700;padding:8px 2px;border:none;border-radius:0;background:transparent;font-family:inherit;color:#111827}\n'
    + '.wl-tinput:focus{outline:none;box-shadow:none}\n'
    + '.wl-stepbtn{font-family:inherit;width:34px;height:40px;border:none;background:transparent;color:#6b7280;font-size:18px;line-height:1;cursor:pointer;flex:none;padding:0}\n'
    + '.wl-stepbtn:hover{background:#f3f4f6;color:#111827}\n'
    + '.wl-stepbtn:focus-visible{outline:2px solid var(--primary,#0d6efd);outline-offset:-2px}\n'
    + '.wl-time-arrow{color:#9ca3af;padding-bottom:12px}\n'
    + '.wl-dur{margin-left:auto;padding-bottom:11px;font-size:13px;color:#6b7280;font-variant-numeric:tabular-nums;white-space:nowrap}\n'
    + '.wl-dur b{color:#111827;font-weight:700}\n'
    + '.wl-dur.bad{color:#b91c1c;font-weight:600}\n'
    + '.wl-bar{margin-top:12px;padding:0 11px;touch-action:none;user-select:none;-webkit-user-select:none}\n'
    + '.wl-ticks{position:relative;height:16px;font-size:11px;color:#9ca3af;font-variant-numeric:tabular-nums;pointer-events:none}\n'
    + '.wl-tick{position:absolute;top:0;transform:translateX(-50%)}\n'
    + '.wl-track{position:relative;height:38px;cursor:pointer}\n'
    + '.wl-track::before{content:"";position:absolute;left:0;right:0;top:15px;height:8px;border-radius:999px;background:#e5e7eb}\n'
    + '.wl-hourmark{position:absolute;top:25px;width:1px;height:5px;background:#cbd5e1;transform:translateX(-50%);pointer-events:none}\n'
    + '.wl-band{position:absolute;top:12px;height:14px;border-radius:999px;background:var(--primary,#0d6efd);cursor:grab}\n'
    + '.wl-band.dragging{cursor:grabbing}\n'
    + '.wl-handle{position:absolute;top:8px;width:22px;height:22px;border-radius:50%;background:#fff;border:2px solid var(--primary,#0d6efd);box-shadow:0 1px 4px rgba(16,24,40,.25);transform:translateX(-50%);cursor:ew-resize;padding:0;z-index:2}\n'
    + '.wl-handle[hidden]{display:none}\n'
    + '.wl-handle:focus-visible{outline:2px solid var(--primary,#0d6efd);outline-offset:2px}\n'
    + '.wl-handle::after{content:attr(data-tip);position:absolute;bottom:28px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;padding:3px 7px;border-radius:6px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s}\n'
    + '.wl-handle.dragging::after,.wl-handle:focus-visible::after{opacity:1}\n'
    + '.wl-track.dragging,.wl-track.dragging *{cursor:grabbing}\n'
    + '@media (max-width:480px){.wl-tick--minor{display:none}.wl-tinput{width:66px;font-size:16px}.wl-stepbtn{width:28px}.wl-dur{margin-left:0;width:100%;padding:4px 0 0}}\n'
    + '@media (prefers-reduced-motion:reduce){.wl-handle::after{transition:none}}\n';

  var DEFAULT_PRESETS = [
    { name: 'Sáng',  start: '08:00', end: '12:00' },
    { name: 'Chiều', start: '15:00', end: '18:00' },
    { name: 'Tối',   start: '18:00', end: '21:00' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function injectStyles() {
    if (document.getElementById('tsTimePickStyles')) return;
    var st = document.createElement('style');
    st.id = 'tsTimePickStyles';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // "9" "09" "930" "0930" "9:30" "9h30" "9g30" "9.30" "9:3" -> minutes since midnight, or null
  function tParse(raw) {
    var s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    var h, mi;
    if (/^\d+$/.test(s)) {
      if (s.length <= 2) { h = +s; mi = 0; }
      else if (s.length === 3) { h = +s[0]; mi = +s.slice(1); }
      else if (s.length === 4) { h = +s.slice(0, 2); mi = +s.slice(2); }
      else return null;
    } else {
      var m = s.match(/^(\d{1,2})[:hg.,](\d{0,2})$/);
      if (!m) return null;
      h = +m[1];
      mi = m[2] ? +(m[2].length === 1 ? m[2] + '0' : m[2]) : 0;
    }
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function tFmt(min) {
    min = Math.max(0, Math.min(23 * 60 + 59, min));
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function durText(d) {
    var h = Math.floor(d / 60), m = d % 60;
    return (h ? h + ' giờ' : '') + (h && m ? ' ' : '') + (m ? m + ' phút' : '');
  }

  window.tsTimePick = function (host, opts) {
    opts = opts || {};
    injectStyles();
    var presetsSrc = Array.isArray(opts.presets) && opts.presets.length ? opts.presets : DEFAULT_PRESETS;
    var PRESETS = presetsSrc.map(function (p) { return { name: String(p.name || ''), s: tParse(p.start), e: tParse(p.end) }; })
                            .filter(function (p) { return p.s != null && p.e != null && p.e > p.s; });

    host.innerHTML = ''
      + '<div class="wl-presets" role="group" aria-label="Ca mẫu"></div>'
      + '<div class="wl-panel">'
      +   '<div class="wl-fields">'
      +     '<div class="wl-field"><span>Bắt đầu</span>'
      +       '<div class="wl-step wl-step--start">'
      +         '<button type="button" class="wl-stepbtn" data-step="start" data-dir="-1" aria-label="Bắt đầu sớm hơn 15 phút" title="Sớm hơn 15 phút">−</button>'
      +         '<input type="text" class="wl-tinput wl-tinput--start" inputmode="numeric" placeholder="09:00" autocomplete="off" aria-label="Giờ bắt đầu" />'
      +         '<button type="button" class="wl-stepbtn" data-step="start" data-dir="1" aria-label="Bắt đầu muộn hơn 15 phút" title="Muộn hơn 15 phút">+</button>'
      +       '</div></div>'
      +     '<span class="wl-time-arrow" aria-hidden="true">→</span>'
      +     '<div class="wl-field"><span>Kết thúc</span>'
      +       '<div class="wl-step wl-step--end">'
      +         '<button type="button" class="wl-stepbtn" data-step="end" data-dir="-1" aria-label="Kết thúc sớm hơn 15 phút" title="Sớm hơn 15 phút">−</button>'
      +         '<input type="text" class="wl-tinput wl-tinput--end" inputmode="numeric" placeholder="10:00" autocomplete="off" aria-label="Giờ kết thúc" />'
      +         '<button type="button" class="wl-stepbtn" data-step="end" data-dir="1" aria-label="Kết thúc muộn hơn 15 phút" title="Muộn hơn 15 phút">+</button>'
      +       '</div></div>'
      +     '<div class="wl-dur" aria-live="polite"></div>'
      +   '</div>'
      +   '<div class="wl-bar">'
      +     '<div class="wl-ticks" aria-hidden="true"></div>'
      +     '<div class="wl-track">'
      +       '<div class="wl-band" title="Kéo để dời cả ca"></div>'
      +       '<button type="button" class="wl-handle wl-handle--s" role="slider" aria-label="Giờ bắt đầu" aria-valuemin="0" aria-valuemax="1439" title="Kéo để đổi giờ bắt đầu"></button>'
      +       '<button type="button" class="wl-handle wl-handle--e" role="slider" aria-label="Giờ kết thúc" aria-valuemin="0" aria-valuemax="1439" title="Kéo để đổi giờ kết thúc"></button>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    var qs = function (sel) { return host.querySelector(sel); };
    var presetsEl = qs('.wl-presets'), startInput = qs('.wl-tinput--start'), endInput = qs('.wl-tinput--end');
    var startStep = qs('.wl-step--start'), endStep = qs('.wl-step--end'), durEl = qs('.wl-dur');
    var ticksEl = qs('.wl-ticks'), trackEl = qs('.wl-track'), bandEl = qs('.wl-band');
    var handleS = qs('.wl-handle--s'), handleE = qs('.wl-handle--e');
    var STEP = 15;                                   // every control moves in 15-minute steps
    var BAR_LO = 6 * 60, BAR_HI = 23 * 60;           // the timeline shows 06:00 → 23:00; it widens only when a shift falls outside
    var DAY_MAX = 23 * 60 + 59;
    var barLo = BAR_LO, barHi = BAR_HI;
    var lastDur = 60;                                // the end follows the start by this many minutes

    presetsEl.innerHTML = PRESETS.map(function (p, i) {
      return '<button type="button" class="wl-preset" data-i="' + i + '"><b>' + esc(p.name) + '</b>' + tFmt(p.s) + '–' + tFmt(p.e) + '</button>';
    }).join('');

    function tGet(input) { return tParse(input.value); }
    function pctOf(min) { return ((min - barLo) / (barHi - barLo)) * 100; }
    function minAtX(clientX) {
      var r = trackEl.getBoundingClientRect();
      if (!r.width) return null;
      var f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round((barLo + f * (barHi - barLo)) / STEP) * STEP;
    }
    function buildTicks() {
      var span = barHi - barLo, h0 = barLo / 60, labels = '', marks = '';
      for (var h = h0; h * 60 <= barHi; h++) {
        var pct = (((h * 60 - barLo) / span) * 100).toFixed(3) + '%';
        marks += '<i class="wl-hourmark" style="left:' + pct + '"></i>';
        if ((h - h0) % 2) continue;                                  // a label every two hours
        var minor = (h - h0) % 4 ? ' wl-tick--minor' : '';          // on a phone, only every four
        labels += '<span class="wl-tick' + minor + '" style="left:' + pct + '">' + String(h).padStart(2, '0') + '</span>';
      }
      ticksEl.innerHTML = labels;
      Array.prototype.forEach.call(trackEl.querySelectorAll('.wl-hourmark'), function (n) { n.remove(); });
      trackEl.insertAdjacentHTML('afterbegin', marks);
    }
    function fitBar(s, e) {
      var lo = BAR_LO, hi = BAR_HI;
      if (s != null) { lo = Math.min(lo, Math.floor(s / 60) * 60); hi = Math.max(hi, Math.min(24 * 60, Math.ceil((s + 1) / 60) * 60)); }
      if (e != null) { hi = Math.max(hi, Math.min(24 * 60, Math.ceil(e / 60) * 60)); }
      if (lo !== barLo || hi !== barHi || !ticksEl.childElementCount) { barLo = lo; barHi = hi; buildTicks(); }
    }
    function fire() { if (typeof opts.onChange === 'function') { try { opts.onChange(api.get()); } catch (e) { /* the page's problem */ } } }
    function paintTime(editing) {
      var s = tGet(startInput), e = tGet(endInput);
      fitBar(s, e);
      startStep.classList.toggle('bad', editing !== startInput && startInput.value.trim() !== '' && s == null);
      endStep.classList.toggle('bad', editing !== endInput && endInput.value.trim() !== '' && (e == null || (s != null && e <= s)));
      Array.prototype.forEach.call(presetsEl.querySelectorAll('[data-i]'), function (b) { var p = PRESETS[+b.dataset.i]; b.classList.toggle('on', !!p && s === p.s && e === p.e); });
      var sv = s == null ? null : Math.min(barHi, Math.max(barLo, s));
      var ev = e == null ? null : Math.min(barHi, Math.max(barLo, e));
      var ok = sv != null && ev != null && ev > sv;
      bandEl.style.left  = pctOf(sv == null ? barLo : sv) + '%';
      bandEl.style.width = (ok ? pctOf(ev) - pctOf(sv) : 0) + '%';
      handleS.style.left = pctOf(sv == null ? barLo : sv) + '%';
      handleE.style.left = pctOf(ev == null ? (sv == null ? barLo : sv) : ev) + '%';
      handleS.hidden = s == null;
      handleE.hidden = e == null;
      [[handleS, s], [handleE, e]].forEach(function (pair) {
        var h = pair[0], v = pair[1];
        h.setAttribute('aria-valuenow', v == null ? '0' : String(v));
        h.setAttribute('aria-valuetext', v == null ? '' : tFmt(v));
        h.dataset.tip = v == null ? '' : tFmt(v);
      });
      if (s == null || e == null) { durEl.textContent = 'Chọn giờ bắt đầu và kết thúc'; durEl.classList.remove('bad'); }
      else if (e <= s) { durEl.textContent = 'Kết thúc phải sau bắt đầu'; durEl.classList.add('bad'); }
      else { durEl.innerHTML = '<b>' + esc(durText(e - s)) + '</b>'; durEl.classList.remove('bad'); }
      fire();
    }
    // Moving the start keeps the shift the same length.
    function setStart(min) {
      startInput.value = tFmt(min);
      endInput.value = tFmt(min + (lastDur > 0 ? lastDur : 60));
      paintTime();
    }
    function setEnd(min) {
      endInput.value = tFmt(min);
      var s = tGet(startInput);
      if (s != null && min > s) lastDur = min - s;
      paintTime();
    }
    function tFormat(input) {
      var v = tGet(input);
      if (v != null) input.value = tFmt(v);
      return v;
    }
    // Leaving a field: a typed start behaves like a chip (the end moves with it); a typed end teaches the duration
    function tCommit(input) {
      var v = tGet(input);
      if (v == null) return;
      if (input === startInput) { setStart(v); return; }
      input.value = tFmt(v);
      var s = tGet(startInput);
      if (s != null && v > s) lastDur = v - s;
    }
    // − and + move 15 minutes; a time off the grid lands on the grid first.
    function stepField(which, dir) {
      var isS = which === 'start';
      var cur = isS ? tGet(startInput) : tGet(endInput);
      if (cur == null) {
        var s0 = tGet(startInput);
        if (isS) setStart(9 * 60); else setEnd((s0 == null ? 9 * 60 : s0) + (lastDur > 0 ? lastDur : 60));
        return;
      }
      var next = cur % STEP === 0 ? cur + dir * STEP : (dir > 0 ? Math.ceil(cur / STEP) : Math.floor(cur / STEP)) * STEP;
      if (next < 0 || next > DAY_MAX) return;
      if (isS) setStart(next); else setEnd(next);
    }
    Array.prototype.forEach.call(host.querySelectorAll('.wl-stepbtn'), function (b) {
      b.addEventListener('click', function () { stepField(b.dataset.step, +b.dataset.dir); });
    });
    presetsEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]'); if (!b) return;
      var p = PRESETS[+b.dataset.i]; if (!p) return;
      lastDur = p.e - p.s;
      startInput.value = tFmt(p.s);
      endInput.value = tFmt(p.e);
      paintTime();
    });

    // Dragging: a handle moves its own end of the shift; the blue band slides the whole shift; a press on the
    // empty track jumps the nearer handle there. Pointer capture keeps the drag alive outside the track.
    var drag = null;
    function dragTeach() {
      var s = tGet(startInput), e = tGet(endInput);
      if (s != null && e != null && e > s) lastDur = e - s;
    }
    function dragMove(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var at = minAtX(ev.clientX); if (at == null) return;
      var s = tGet(startInput), e = tGet(endInput);
      if (drag.kind === 'band') {
        var ns = Math.round((at - drag.grab) / STEP) * STEP;
        ns = Math.max(barLo, Math.min(barHi - drag.dur, ns));
        if (ns !== s) { startInput.value = tFmt(ns); endInput.value = tFmt(ns + drag.dur); paintTime(); }
      } else if (drag.kind === 'start') {
        var v = Math.min(at, (e == null ? barHi : e) - STEP);
        if (v !== s) { startInput.value = tFmt(v); paintTime(); }
      } else {
        var v2 = Math.max(at, (s == null ? barLo : s) + STEP);
        if (v2 !== e) { endInput.value = tFmt(v2); paintTime(); }
      }
    }
    function dragEnd(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      var id = drag.id;
      drag = null;
      try { trackEl.releasePointerCapture(id); } catch (e2) { /* already released */ }
      trackEl.classList.remove('dragging'); handleS.classList.remove('dragging'); handleE.classList.remove('dragging'); bandEl.classList.remove('dragging');
      dragTeach();
      paintTime();
    }
    trackEl.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      var s = tGet(startInput), e = tGet(endInput);
      var at = minAtX(ev.clientX); if (at == null) return;
      if (s == null || e == null || e <= s) {           // nothing to grab yet: start a shift where the finger is
        s = Math.max(barLo, Math.min(barHi - STEP, at));
        e = Math.min(barHi, s + (lastDur > 0 ? lastDur : 60));
        if (e <= s) e = s + STEP;
        startInput.value = tFmt(s); endInput.value = tFmt(e); paintTime();
      }
      var kind;
      if (ev.target === handleS) kind = 'start';
      else if (ev.target === handleE) kind = 'end';
      else if (ev.target === bandEl) kind = 'band';
      else kind = Math.abs(at - s) <= Math.abs(at - e) ? 'start' : 'end';
      drag = { kind: kind, id: ev.pointerId, dur: e - s, grab: at - s };
      trackEl.classList.add('dragging');
      (kind === 'start' ? handleS : kind === 'end' ? handleE : bandEl).classList.add('dragging');
      try { trackEl.setPointerCapture(ev.pointerId); } catch (e2) { /* fine without capture */ }
      ev.preventDefault();
      dragMove(ev);
    });
    trackEl.addEventListener('pointermove', dragMove);
    trackEl.addEventListener('pointerup', dragEnd);
    trackEl.addEventListener('pointercancel', dragEnd);
    // Keyboard on a handle: ← → move 15 minutes, with Shift one hour. A handle moves only its own end.
    [handleS, handleE].forEach(function (h) {
      h.addEventListener('keydown', function (e) {
        var step = 0;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -STEP;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = STEP;
        if (!step) return;
        e.preventDefault();
        if (e.shiftKey) step *= 4;
        var s = tGet(startInput), en = tGet(endInput);
        if (h === handleS) {
          if (s == null) return;
          startInput.value = tFmt(Math.max(0, Math.min(s + step, (en == null ? DAY_MAX : en) - STEP)));
        } else {
          if (en == null) return;
          endInput.value = tFmt(Math.min(DAY_MAX, Math.max(en + step, (s == null ? 0 : s) + STEP)));
        }
        dragTeach();
        paintTime();
      });
    });
    [startInput, endInput].forEach(function (inp) {
      inp.addEventListener('input', function () { paintTime(inp); });
      inp.addEventListener('blur', function () { tCommit(inp); paintTime(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault(); tCommit(inp); paintTime();
          if (inp === startInput) endInput.focus(); else inp.blur();
          return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        var step = (e.shiftKey ? 60 : 15) * (e.key === 'ArrowUp' ? 1 : -1);
        var cur = tGet(inp);
        if (cur == null) return;
        if (inp === startInput) setStart(cur + step); else setEnd(cur + step);
      });
    });

    var api = {
      get: function () {
        var s = tGet(startInput), e = tGet(endInput);
        return { start: s == null ? null : tFmt(s), end: e == null ? null : tFmt(e), s: s, e: e };
      },
      valid: function () { var v = api.get(); return v.s != null && v.e != null && v.e > v.s; },
      set: function (start, end) {
        var s = tParse(start), e = tParse(end);
        startInput.value = s == null ? '' : tFmt(s);
        endInput.value = e == null ? '' : tFmt(e);
        if (s != null && e != null && e > s) lastDur = e - s;
        paintTime();
      },
      format: function () { tFormat(startInput); tFormat(endInput); paintTime(); return api.get(); },
      focus: function () { try { startInput.focus(); } catch (e) { /* nothing to do */ } },
      parse: tParse, fmt: tFmt
    };
    api.set(opts.start || '', opts.end || '');
    return api;
  };
})();
