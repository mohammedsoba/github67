// ============================================================
// gestures.js
// ============================================================
// ==================== SWIPE GESTURES (UNDO/REDO) ====================
(function (g) {
// V27 module "gestures": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('gestures', {
  initSwipeGestures: [() => initSwipeGestures, (v) => { initSwipeGestures = v; }],
  showSwipeHint: [() => showSwipeHint, (v) => { showSwipeHint = v; }],
});
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

// R15: swipe-to-undo must never fire while a tool is using horizontal drags (crop box, eraser brush,
// overlay move/resize, hold-to-compare). Two guards: the tool is engaged, or the
// touch STARTED on one of the tool surfaces / controls.
var SWIPE_BLOCK_SELECTOR = '#cropOverlay, #cropActions, .crop-handle, #me-paint-layer, .me-paint-layer, ' +
    '#overlayCanvas, #compareBtn, .canvas-float, button, input, select, textarea, a';

function isEditingToolActive() {
    try {
        if (typeof isCropMode !== 'undefined' && isCropMode) return true;
        if (typeof _holdOriginalActive !== 'undefined' && _holdOriginalActive) return true;   // hold-to-compare is down
        if (document.querySelector('.me-paint-layer.on')) return true;           // Magic Eraser is painting
        if (typeof overlayManager !== 'undefined' && overlayManager) {
            if (overlayManager.isDragging || overlayManager.isResizing || overlayManager.isRotating) return true;
            if (overlayManager.selectedId !== null && overlayManager.selectedId !== undefined) return true;
        }
    } catch (e) {}
    return false;
}

let swipeBlocked = false;

function initSwipeGestures() {
    const viewport = document.getElementById('viewport');

    viewport.addEventListener('touchstart', function(e) {
        if (e.touches.length !== 1) { swipeBlocked = true; return; }   // pinch / two fingers: never a swipe
        swipeBlocked = isEditingToolActive() ||
            !!(e.target && e.target.closest && e.target.closest(SWIPE_BLOCK_SELECTOR));
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
    }, { passive: true });

    viewport.addEventListener('touchcancel', function() { swipeBlocked = true; }, { passive: true });

    viewport.addEventListener('touchend', function(e) {
        if (!originalImage) return;
        if (swipeBlocked || isEditingToolActive()) { swipeBlocked = false; return; }
        const touch = e.changedTouches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;
        const dt = Date.now() - touchStartTime;

        if (dt > 50 && dt < 600 && Math.abs(dx) > 80 && Math.abs(dy) < 100) {
            if (dx > 0) {
                // Swipe right = Undo
                if (historyIndex > 0) {
                    undoEdit();
                    showSwipeHint(window.t('undo'));
                } else {
                    showSwipeHint(window.t('swipeNothingToUndo'));
                }
            } else {
                // Swipe left = Redo (not implemented yet)
                showSwipeHint(window.t('swipeRedoSoon'));
            }
        }
    }, { passive: true });
}

function showSwipeHint(text) {
    const hint = document.getElementById('swipeHint');
    hint.innerText = text;
    hint.classList.add('show');
    setTimeout(function() { hint.classList.remove('show'); }, 800);
}
})(globalThis);
