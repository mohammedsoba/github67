// ============================================================
// perf-utils.js - rAF throttle helper
//
// Global namespace: window.Perf
// Zero dependencies. Safe to load first - does not touch the DOM
// or any app state.
//
// V23: `debounce` and `throttle` were removed (nothing referenced them).
// ============================================================
(function (global) {
    'use strict';

    // rAF-coalesced throttle: at most one call per animation frame.
    // The most recent arguments win - perfect for pointermove/resize
    // handlers that only need the latest state per repaint.
    //
    // V23/G5: errors are NOT swallowed any more. The throttle's bookkeeping is reset BEFORE `fn` runs, so a
    // throwing handler still surfaces in the console / window.onerror (where it can be seen and fixed) and
    // the next event schedules a fresh frame as usual.
    function rafThrottle(fn) {
        var scheduled = false;
        var lastArgs = null;
        var lastThis = null;
        return function () {
            lastArgs = arguments;
            lastThis = this;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(function () {
                var args = lastArgs, self = lastThis;
                scheduled = false;
                lastArgs = null;
                lastThis = null;
                fn.apply(self, args);
            });
        };
    }

    global.Perf = {
        rafThrottle: rafThrottle
    };

})(window);
