// ============================================================
// progress-counter.js - the 1 -> 100 counter shown while an AI operation runs
// ------------------------------------------------------------
// Magic Eraser, background removal, AI masks, face enhance and Portrait are single long requests / model runs: there is
// no real percentage to report. Instead of a spinner that gives no sense of time, the counter is SIMULATED from the
// elapsed time and the operation's typical duration, and snaps to 100 when the operation really finishes.
//
// Honest by construction:
//   * it only ever reaches 100 through finish() - i.e. when the work is done - never by itself (the curve stays <= 99);
//   * it never freezes: past the expected time it keeps creeping up (a hyperbolic tail) instead of sitting on "99 %";
//   * it never goes backwards, and the DOM is written only when the whole number changes.
//
// API (global: window.YoProgress, loaded before loading-toast.js and portrait-mode.js):
//   YoProgress.percentAt(elapsedMs, expectedMs[, ceilingPct]) -> integer 1..ceiling (99 by default)   pure, unit-tested
//   YoProgress.attach({ num, arc }[, env])      -> controller         num = text node holder, arc = SVG <circle> ring
//       controller.start(expectedMs?, ceilingPct?)   begin at 1 (expectedMs <= 0 / missing -> DEFAULT_EXPECTED_MS; ceiling default 99)
//       controller.finish()             stop the clock and show 100
//       controller.reset()              stop the clock (nothing is shown as "done")
//       controller.value()              the whole number currently shown (-1 before the first render)
//   env = { now(), schedule(fn) -> cancel() } is for tests; the defaults use performance.now() and requestAnimationFrame.
//
// Everything is resolved at call time and every element is optional, so a missing node degrades to "no counter".
// ============================================================
window.YoProgress = (function () {
  'use strict';

  var DEFAULT_EXPECTED_MS = 8000;
  var MIN_EXPECTED_MS = 1500;       // a learned duration of a few hundred ms would race to 90 % and then sit there
  var MAX_EXPECTED_MS = 120000;
  var FLOOR = 1;
  var CEILING = 99;
  // Circumference of the ring: 2 * PI * r with r = 52 in the 120 x 120 viewBox (css/loading-orb.css uses the same number).
  var RING_LENGTH = 326.73;

  function clampExpected(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return DEFAULT_EXPECTED_MS;
    return Math.min(MAX_EXPECTED_MS, Math.max(MIN_EXPECTED_MS, ms));
  }

  // A fast ease-out (about 80 % at the expected time) blended with a slow hyperbolic tail. Both terms are strictly
  // increasing, so the sum is too: monotonic, never constant, and bounded below CEILING for every finite time.
  //   E = 8 s:  1 s -> 25   4 s -> 65   8 s -> 80   16 s -> 86   60 s -> 92   5 min -> 97
  // ceilingPct (optional, 2..99, default 99): the value the curve approaches. AILoadingManager passes 95.
  function clampCeiling(c) {
    return typeof c === 'number' && isFinite(c) && c >= 2 && c <= CEILING ? Math.floor(c) : CEILING;
  }

  function percentAt(elapsedMs, expectedMs, ceilingPct) {
    var t = typeof elapsedMs === 'number' && elapsedMs > 0 && isFinite(elapsedMs) ? elapsedMs : 0;
    var e = clampExpected(expectedMs);
    var top = clampCeiling(ceilingPct);
    var fast = 1 - Math.exp(-3 * t / e);
    var slow = t / (t + 4 * e);
    var p = top * (0.82 * fast + 0.18 * slow);
    return Math.min(top, Math.max(FLOOR, Math.floor(p)));
  }

  function defaultNow() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  // Calls fn once on the next frame (or ~10 fps where there is no rAF); returns a function that cancels it.
  function defaultSchedule(fn) {
    if (typeof requestAnimationFrame === 'function') {
      var frame = requestAnimationFrame(fn);
      return function () { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); };
    }
    var timer = setTimeout(fn, 100);
    return function () { clearTimeout(timer); };
  }

  function attach(parts, env) {
    var p = parts || {};
    var now = (env && env.now) || defaultNow;
    var schedule = (env && env.schedule) || defaultSchedule;
    var cancelNext = null;
    var running = false;
    var startedAt = 0;
    var expected = DEFAULT_EXPECTED_MS;
    var top = CEILING;
    var shown = -1;

    function render(v) {
      if (v === shown) return;                                   // whole number unchanged: no DOM write
      shown = v;
      if (p.num) p.num.textContent = String(v);
      if (p.arc) {
        var offset = (RING_LENGTH * (1 - v / 100)).toFixed(2);
        if (p.arc.style) p.arc.style.strokeDashoffset = offset;
        else if (typeof p.arc.setAttribute === 'function') p.arc.setAttribute('stroke-dashoffset', offset);
      }
    }

    function stopLoop() {
      running = false;
      if (cancelNext) { var c = cancelNext; cancelNext = null; c(); }
    }

    function tick() {
      cancelNext = null;
      if (!running) return;
      render(Math.max(shown, percentAt(now() - startedAt, expected, top)));   // never backwards
      cancelNext = schedule(tick);
    }

    return {
      start: function (expectedMs, ceilingPct) {
        stopLoop();                                              // a second start() can never leave two loops running
        expected = clampExpected(expectedMs);
        top = clampCeiling(ceilingPct);
        startedAt = now();
        running = true;
        shown = -1;
        render(FLOOR);
        cancelNext = schedule(tick);
      },
      finish: function () { stopLoop(); render(100); },
      reset: function () { stopLoop(); },
      value: function () { return shown; }
    };
  }

  return { percentAt: percentAt, attach: attach, DEFAULT_EXPECTED_MS: DEFAULT_EXPECTED_MS };
})();
