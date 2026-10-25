// ============================================================
// ai-loading-manager.js - ONE entry point for the loading feedback of the long AI operations
// ------------------------------------------------------------
//   aiLoader.show('removeObject', { onCancel, expectedMs })   Eraser   -> centred modal (the #loadingOverlay island)
//   aiLoader.show('portrait')                                 Portrait -> compact orb on the canvas (#portraitCanvasLoader)
//   aiLoader.complete()   the work succeeded : the counter snaps to 100, pops, holds, fades
//   aiLoader.hide()       error / cancel / superseded : closes at once, never shows "100"
//
// Call show() right before the work starts and END it exactly once with complete() or hide(). show() returns a ticket;
// pass it back (complete(ticket) / hide(ticket)) and a late call of an older operation can never close a newer one.
// Both calls are idempotent: after complete() or hide(), further calls with the same ticket do nothing.
//
// Why this survives a frozen main thread: the moving parts - the spinning comet ring, the counter-rotating dotted ring
// and the pulsing core (css/loading-orb.css) - are CSS @keyframes on transform / opacity, which the browser composites on its
// own thread. They keep moving while a heavy inference blocks JavaScript. Only the NUMBER and the ring fill need the
// main thread (rAF); they simply catch up on the next free frame.
//
// The counter is simulated (there is no real progress to report): it climbs along a time curve to 95 % and creeps from
// there, and only complete() takes it to 100. Pacing and the DOM writes live in js/ui/progress-counter.js (YoProgress).
//
// The modal reuses the existing island (js/ui/loading-toast.js) so its busy lock, Cancel button and finish animation stay
// in one place; the orb is owned here. Loaded before portrait-mode.js / magic-eraser.js; CSP-safe (no inline script).
// ============================================================
(function (g) {
  'use strict';

  var CEILING = 95;           // the simulated counter never shows more until complete()
  var ORB_FINISH_MS = 520;        // pop (0.3 s) + hold + fade; must match css/loading-orb.css

  // name -> where it shows, which i18n key it uses, how long it usually takes (ms, pacing only).
  var OPERATIONS = {
    removeObject: { mode: 'modal', key: 'removingObject',    fallback: 'Removing object\u2026',     expectedMs: 8000 },
    portrait:     { mode: 'orb',   key: 'processingPortrait', fallback: 'Processing portrait\u2026', expectedMs: 6000 }
  };

  function AILoadingManager(env) {
    this._env = env || {};
    this._seq = 0;
    this._current = null;       // { ticket, mode } of the operation on screen, or null
    this._finishTimer = 0;
    this._counter = null;       // YoProgress controller bound to the portrait orb (created lazily, once)
  }

  AILoadingManager.OPERATIONS = OPERATIONS;
  AILoadingManager.CEILING = CEILING;

  // ---- environment (overridable for tests) -------------------------------------------------------------------------
  AILoadingManager.prototype._doc = function () { return this._env.document || g.document; };
  AILoadingManager.prototype._el = function (id) { var d = this._doc(); return d && d.getElementById ? d.getElementById(id) : null; };
  AILoadingManager.prototype._engine = function () { return this._env.YoProgress || g.YoProgress || null; };
  AILoadingManager.prototype._text = function (key, fallback) {
    var t = this._env.t || g.t;
    if (typeof t === 'function') { var s = t(key); if (s && s !== key) return s; }
    return fallback;
  };
  AILoadingManager.prototype._showModal = function (text, opts) {
    var f = this._env.showLoading || g.showLoading;
    if (typeof f === 'function') f(text, opts);
  };
  AILoadingManager.prototype._hideModal = function (opts) {
    var f = this._env.hideLoading || g.hideLoading;
    if (typeof f === 'function') f(opts);
  };

  // ---- public API --------------------------------------------------------------------------------------------------
  // operation: a name from OPERATIONS, or any other string, which is then shown as-is in the modal.
  // opts: { mode: 'modal' | 'orb' (default: the operation's own), onCancel: fn, expectedMs: n }
  AILoadingManager.prototype.show = function (operation, opts) {
    opts = opts || {};
    var def = OPERATIONS[operation] || null;
    var mode = opts.mode || (def && def.mode) || 'modal';
    var text = def ? this._text(def.key, def.fallback) : String(operation == null ? '' : operation);
    var expected = opts.expectedMs > 0 ? opts.expectedMs : (def ? def.expectedMs : 0);

    this._dropCurrent();                                  // a new operation replaces whatever was on screen, at once
    var ticket = ++this._seq;
    var self = this;

    if (mode === 'orb') {
      var el = this._el('portraitCanvasLoader');
      var label = this._el('portraitLoaderText');
      if (label) label.textContent = text;
      var counter = this._orbCounter();
      if (counter) counter.start(expected, CEILING);
      if (el) { el.classList.add('on'); el.setAttribute('aria-hidden', 'false'); }
    } else {
      var onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
      this._showModal(text, {
        onCancel: onCancel ? function () { if (self._current && self._current.ticket === ticket) self._current = null; onCancel(); } : undefined,
        progress: { expectedMs: expected, ceiling: CEILING }
      });
    }
    this._current = { ticket: ticket, mode: mode };
    return ticket;
  };

  // Success: snap to 100 with the pop / hold / fade. No-op when this operation is not the one on screen.
  AILoadingManager.prototype.complete = function (ticket) {
    var cur = this._current;
    if (!cur || (ticket != null && ticket !== cur.ticket)) return false;
    this._current = null;
    if (cur.mode === 'orb') {
      var el = this._el('portraitCanvasLoader');
      var counter = this._counter;
      if (!el || !counter || !el.classList.contains('on')) { this._hideOrb(); return true; }
      counter.finish();
      el.classList.add('finishing');
      el.setAttribute('aria-hidden', 'true');
      var self = this;
      this._finishTimer = setTimeout(function () { self._finishTimer = 0; self._hideOrb(); }, ORB_FINISH_MS);
    } else {
      this._hideModal();                                  // loading-toast.js: counter -> 100, pop, hold, fade
    }
    return true;
  };

  // Error / cancel / superseded: close at once, never "100". No-op when this operation is not the one on screen.
  AILoadingManager.prototype.hide = function (ticket) {
    var cur = this._current;
    if (!cur || (ticket != null && ticket !== cur.ticket)) return false;
    this._dropCurrent();
    return true;
  };

  AILoadingManager.prototype.isActive = function () { return !!this._current; };

  // ---- internals ---------------------------------------------------------------------------------------------------
  AILoadingManager.prototype._orbCounter = function () {
    if (this._counter) return this._counter;
    var engine = this._engine();
    if (!engine) return null;                             // engine missing: the orb still spins (CSS), just without a number
    this._counter = engine.attach({ arc: this._el('portraitArc'), num: this._el('portraitPercent') });
    return this._counter;
  };

  AILoadingManager.prototype._hideOrb = function () {
    if (this._finishTimer) { clearTimeout(this._finishTimer); this._finishTimer = 0; }
    var el = this._el('portraitCanvasLoader');
    if (this._counter) this._counter.reset();
    if (el) { el.classList.remove('finishing'); el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); }
  };

  // Closes whatever is on screen without any celebration.
  AILoadingManager.prototype._dropCurrent = function () {
    var cur = this._current;
    this._current = null;
    if (cur && cur.mode === 'modal') this._hideModal({ instant: true });
    // The orb is always reset: this also ends a finish fade that is still running when a new run starts.
    this._hideOrb();
  };

  g.AILoadingManager = AILoadingManager;
  g.aiLoader = new AILoadingManager();
})(typeof globalThis !== 'undefined' ? globalThis : window);
