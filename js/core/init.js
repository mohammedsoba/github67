// ============================================================
// init.js
// ============================================================
// ==================== INIT ====================
(function (g) {
// V27 module "init": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('init', {
  onBackKeyDown: [() => onBackKeyDown, (v) => { onBackKeyDown = v; }],
});
function initCanvasSystem() {
    previewCanvas = document.getElementById('previewCanvas');
    previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
    fullResCanvas = document.getElementById('hiddenCanvas');
    fullResCtx = fullResCanvas.getContext('2d', { willReadFrequently: true });
}

document.addEventListener('DOMContentLoaded', function() {
    initCanvasSystem();
    renderPresets();
    renderColorMix();
    initCurvesCanvas();
    buildCurvesLUTs();
    initCropSystem();
    initSwipeGestures();
    autoDismissSplash();
});

// rAF-throttled resize: coalesces bursts of resize events (mobile URL bar
// show/hide, orientation change, desktop drag-resize) into one layout pass
// per animation frame instead of dozens.
window.addEventListener('resize', (window.Perf ? Perf.rafThrottle : function(f){return f;})(function() {
    if (originalImage) {
        fitImageToWorkspace();
    }
}), { passive: true });

document.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') {
            e.preventDefault();
            undoEdit();
        } else if (e.key === 's') {
            e.preventDefault();
            openExportModal();
        }
    }
    if (e.key === 'Escape') {
        // Y4: close only the top-most layer (About > Settings > Export > Crop)
        if (!closeTopmostLayer() && typeof closePremiumModal === 'function') closePremiumModal();
    }
});

// ── Cordova hardware back-button navigation ───────────────
// G13: Back closes ONE layer per press, top-most first (running operation's Cancel > About > Settings > Export >
// Premium > Crop > Portrait focus mode > selected overlay; see BACK_LAYERS in js/ui/navigation.js). Only when
// nothing is open does it start the double-press exit - and while a save/export is running (no Cancel offered) it
// warns first, so one stray press can never kill the app mid-write.
function onBackKeyDown(e) {
    if (e && e.preventDefault) e.preventDefault(); // prevent instant app-close

    if (typeof closeTopmostLayer === 'function' && closeTopmostLayer()) return;

    // Main editor screen - double-tap within 2 s to exit
    var now = Date.now();
    if (now - onBackKeyDown._lastPress < 2000) {
        if (navigator.app && typeof navigator.app.exitApp === 'function') {
            navigator.app.exitApp();
        }
    } else {
        onBackKeyDown._lastPress = now;
        if (typeof showToast === 'function') {
            var busy = typeof isBackBlockedByBusy === 'function' && isBackBlockedByBusy();
            showToast(window.t(busy ? 'toastBackBusy' : 'toastBackToExit'), 'info');
        }
    }
}
onBackKeyDown._lastPress = 0;

document.addEventListener('deviceready', function () {
    document.addEventListener('backbutton', onBackKeyDown, false);
}, false);
})(globalThis);
