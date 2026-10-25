// ============================================================
// a11y.js - Y17: live-region announcements, dialog focus management + focus trap, pressed-state sync
// ============================================================
// window.YoA11y.announce(text)          polite screen-reader announcement (shared live region)
// window.YoA11y.openDialog(el, focusEl) remembers the opener, moves focus into the dialog
// window.YoA11y.closeDialog(el)         returns focus to the opener
// Tab / Shift+Tab are trapped inside the top-most open dialog (About > Settings > Export > Premium).
(function () {
  'use strict';

  var live = null;
  function ensureLive() {
    if (live && document.body.contains(live)) return live;
    live = document.createElement('div');
    live.id = 'srAnnouncer';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
    return live;
  }
  var announceTimer = null;
  function announce(text) {
    if (!text) return;
    var el = ensureLive();
    el.textContent = '';                       // clearing first makes repeated identical messages re-announce
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { el.textContent = String(text); }, 60);
  }

  function openDialog(el, focusEl) {
    if (!el) return;
    el._opener = document.activeElement;
    var target = focusEl || el;
    setTimeout(function () {
      try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
    }, 0);
  }
  function closeDialog(el) {
    if (!el) return;
    var opener = el._opener;
    el._opener = null;
    if (opener && opener.focus && document.contains(opener)) {
      try { opener.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  }
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    var all = root.querySelectorAll(FOCUSABLE), out = [];
    for (var i = 0; i < all.length; i++) if (isVisible(all[i]) && !all[i].hidden) out.push(all[i]);
    return out;
  }

  // The dialog that currently owns the keyboard (null = none open).
  function topDialog() {
    var about = document.getElementById('aboutPage');
    if (about && about.style.display === 'block') return about;
    var settings = document.getElementById('settingsPage');
    if (settings && settings.style.display === 'block') return settings;
    var ids = ['exportModal', 'premiumModal'];
    for (var i = 0; i < ids.length; i++) {
      var m = document.getElementById(ids[i]);
      if (m && m.classList.contains('active')) return m.querySelector('[role="dialog"]') || m;
    }
    return null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    var dlg = topDialog();
    if (!dlg) return;
    var list = focusables(dlg);
    if (!list.length) { e.preventDefault(); try { dlg.focus(); } catch (x) {} return; }
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (!dlg.contains(active)) { e.preventDefault(); first.focus(); return; }   // focus escaped: pull it back
    if (e.shiftKey && (active === first || active === dlg)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);

  // ---- pressed / current state mirrors the visual .active class ----------------------------------------
  var PRESSED = '.sub-btn, .opt-box, .mask-chip, .frame-cat, .channel-btn, .preset-item, .frame-item, .color-dot';
  function syncState(el) {
    if (!el.matches) return;
    if (el.matches('.nav-tab')) {
      if (el.classList.contains('active')) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    } else if (el.matches(PRESSED) && el.tagName === 'BUTTON') {
      el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
    }
  }
  function syncAll() {
    var els = document.querySelectorAll(PRESSED + ', .nav-tab');
    for (var i = 0; i < els.length; i++) syncState(els[i]);
  }
  document.addEventListener('DOMContentLoaded', function () {
    ensureLive();
    syncAll();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].attributeName === 'class') syncState(list[i].target);
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  });

  window.YoA11y = { announce: announce, openDialog: openDialog, closeDialog: closeDialog, syncAll: syncAll, topDialog: topDialog };
})();
