// ============================================================
// compare.js - press-and-hold "Original" preview
// ============================================================
// Y15: the old split-screen compare slider (its toggle, drag handlers and markup) is gone - nothing in the
// UI could open it any more. What is left is the press-and-hold preview.
//
// PRESS-AND-HOLD "ORIGINAL" PREVIEW
// ------------------------------------------------------------
// Press and hold the floating "Original" pill (#compareBtn) -> the canvas instantly shows the frozen,
// unedited upload-time photo (originalForCompare). Release (mouseup / touchend / mouseleave, or any
// cancel) -> the edited canvas is back immediately. Display-only: it never touches the edit state,
// history stack, preview canvas or any backend call. It reuses the #compareImg overlay that
// positionCompareElements() pins to the exact rendered-photo rectangle.
//
// Y15 - CROP ALIGNMENT. originalForCompare is the UNCROPPED upload. After a crop the edited photo shows only
// part of it, so drawing the whole original into the (smaller) cropped rectangle squeezed / stretched it.
// The crop is therefore remembered as a normalised rectangle of the original (compareCrop, 0..1) and the
// preview is built from exactly that region (a small cached blob URL). The rectangle travels with the
// history states, so Undo / Redo of a crop keeps the preview aligned.

(function (g) {
// V27 module "compare": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('compare', {
  _holdOriginalActive: [() => _holdOriginalActive, (v) => { _holdOriginalActive = v; }],
  applyCropToCompare: [() => applyCropToCompare, (v) => { applyCropToCompare = v; }],
  getCompareCropState: [() => getCompareCropState, (v) => { getCompareCropState = v; }],
  getOriginalPreviewSrc: [() => getOriginalPreviewSrc, (v) => { getOriginalPreviewSrc = v; }],
  holdOriginalEnd: [() => holdOriginalEnd, (v) => { holdOriginalEnd = v; }],
  holdOriginalStart: [() => holdOriginalStart, (v) => { holdOriginalStart = v; }],
  positionCompareElements: [() => positionCompareElements, (v) => { positionCompareElements = v; }],
  resetCompareCrop: [() => resetCompareCrop, (v) => { resetCompareCrop = v; }],
  setCompareCropState: [() => setCompareCropState, (v) => { setCompareCropState = v; }],
});
let _holdOriginalActive = false;
let _holdWanted = false;          // pointer is down but the cropped preview image is still being prepared
let _holdLastTouchTs = 0;         // used to ignore the "ghost" mouse events some browsers emit after a touch

// ---- crop alignment state ------------------------------------------------------------------------------
let compareCrop = null;                           // null = whole original, else { x, y, w, h } in 0..1 of originalForCompare
let _compareCropUrl = null;                       // blob URL of the cropped original (cache)
let _compareCropKey = '';                         // which (original, crop) the cache belongs to
let _compareCropBuilding = null;                  // Promise while a build is running

function _cropKey(c) {
    return (originalForCompare ? originalForCompare.src : '') + '|' + (c ? [c.x, c.y, c.w, c.h].map(function (n) { return n.toFixed(5); }).join(',') : '');
}

function _revokeCompareCrop() {
    if (_compareCropUrl) { try { URL.revokeObjectURL(_compareCropUrl); } catch (e) {} }
    _compareCropUrl = null;
    _compareCropKey = '';
}

function getCompareCropState() {
    return compareCrop ? { x: compareCrop.x, y: compareCrop.y, w: compareCrop.w, h: compareCrop.h } : null;
}

// Restore a state (undo / redo) or clear it (null).
function setCompareCropState(st) {
    compareCrop = st ? { x: st.x, y: st.y, w: st.w, h: st.h } : null;
    _prepareCompareCrop();
}

// A new photo: whole original again, cache released.
function resetCompareCrop() {
    compareCrop = null;
    _revokeCompareCrop();
    _compareCropBuilding = null;
}

// Called by crop.js when a crop is committed. `rel` = the crop rectangle as fractions (0..1) of the photo
// that was on screen BEFORE the crop; it is composed with any earlier crop.
function applyCropToCompare(rel) {
    if (!rel || !(rel.w > 0) || !(rel.h > 0)) return;
    const c = compareCrop || { x: 0, y: 0, w: 1, h: 1 };
    compareCrop = { x: c.x + rel.x * c.w, y: c.y + rel.y * c.h, w: rel.w * c.w, h: rel.h * c.h };
    _prepareCompareCrop();
}

// Build (once) the cropped copy of the original. Resolves with the URL to show, or null if none is needed.
function _prepareCompareCrop() {
    if (!compareCrop || !originalForCompare || !originalForCompare.naturalWidth) {
        _revokeCompareCrop();
        return Promise.resolve(null);
    }
    const key = _cropKey(compareCrop);
    if (_compareCropUrl && _compareCropKey === key) return Promise.resolve(_compareCropUrl);
    if (_compareCropBuilding && _compareCropBuilding.key === key) return _compareCropBuilding.promise;

    const nw = originalForCompare.naturalWidth, nh = originalForCompare.naturalHeight;
    const sx = Math.max(0, Math.round(compareCrop.x * nw));
    const sy = Math.max(0, Math.round(compareCrop.y * nh));
    const sw = Math.max(1, Math.min(nw - sx, Math.round(compareCrop.w * nw)));
    const sh = Math.max(1, Math.min(nh - sy, Math.round(compareCrop.h * nh)));
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(originalForCompare, sx, sy, sw, sh, 0, 0, sw, sh);
    const promise = new Promise(function (resolve) {
        const done = function (blob) {
            c.width = 0; c.height = 0;
            if (_cropKey(compareCrop) !== key || !blob) { resolve(null); return; }   // superseded meanwhile / encode failed
            _revokeCompareCrop();
            _compareCropUrl = URL.createObjectURL(blob);
            _compareCropKey = key;
            resolve(_compareCropUrl);
        };
        canvasToBlob(c, 'image/png').then(done, function () { done(null); });   // V24/G8: shared helper (save-image.js)
    });
    _compareCropBuilding = { key: key, promise: promise };
    promise.then(function () { if (_compareCropBuilding && _compareCropBuilding.promise === promise) _compareCropBuilding = null; });
    return promise;
}

// The picture the "Original" preview should show RIGHT NOW (null = not ready yet, ask again via callback).
function _compareSourceNow() {
    if (typeof originalForCompare === 'undefined' || !originalForCompare || !originalForCompare.src) return null;
    if (!compareCrop) return originalForCompare.src;
    return (_compareCropUrl && _compareCropKey === _cropKey(compareCrop)) ? _compareCropUrl : null;
}

// For other modules (the Magic Eraser's own hold-to-compare): the aligned original, or '' when unavailable.
function getOriginalPreviewSrc() {
    return _compareSourceNow() || '';
}

// -----------------------------------------------------------------------
// positionCompareElements
// Pins #compareImg to the exact pixel bounds of #mainImg. #compareImg is absolutely positioned inside
// #viewport (the nearest positioned ancestor), so offsets are measured against #viewport's padding box -
// NOT against #imgContainer - and pinned with margin:0 / right:auto / bottom:auto (otherwise a letterboxed
// photo is pushed off by half of its free space).
// Called on: hold start, window resize / fitImageToWorkspace while holding.
// -----------------------------------------------------------------------
function positionCompareElements() {
    const mainImg    = document.getElementById('mainImg');
    const compareImg = document.getElementById('compareImg');
    const container  = document.getElementById('imgContainer');
    if (!mainImg || !compareImg || !mainImg.classList.contains('active')) return;

    const viewport = document.getElementById('viewport') || container.parentElement;
    const rect  = mainImg.getBoundingClientRect();
    const vRect = viewport.getBoundingClientRect();
    compareImg.style.margin = '0';
    compareImg.style.right  = 'auto';
    compareImg.style.bottom = 'auto';
    compareImg.style.left   = (rect.left - vRect.left - viewport.clientLeft) + 'px';
    compareImg.style.top    = (rect.top  - vRect.top  - viewport.clientTop) + 'px';
    compareImg.style.width  = rect.width  + 'px';
    compareImg.style.height = rect.height + 'px';
}

function _announce(key) {
    if (window.YoA11y && typeof window.YoA11y.announce === 'function') window.YoA11y.announce(window.t(key));
}

function _showHoldOriginal(src) {
    const ci  = document.getElementById('compareImg');
    const btn = document.getElementById('compareBtn');
    const mainImg = document.getElementById('mainImg');
    if (!ci || !btn || !mainImg || !mainImg.classList.contains('active')) return;
    _holdOriginalActive = true;
    // Only re-assign src when it changed, so repeat presses show the already-decoded image with no flash.
    if (ci.getAttribute('src') !== src) ci.src = src;
    ci.style.clipPath = 'none';
    positionCompareElements();
    ci.classList.add('active', 'holding-original');
    btn.classList.add('comparing');
    btn.setAttribute('aria-pressed', 'true');
    _announce('announceShowingOriginal');
}

function holdOriginalStart() {
    if (_holdOriginalActive || _holdWanted) return;
    if (typeof originalForCompare === 'undefined' || !originalForCompare || !originalForCompare.src) return;
    const src = _compareSourceNow();
    if (src) { _showHoldOriginal(src); return; }
    // cropped preview still being prepared (a few ms after a crop): show it as soon as it exists, if still held
    _holdWanted = true;
    _prepareCompareCrop().then(function (url) {
        if (!_holdWanted) return;                       // released meanwhile
        _holdWanted = false;
        _showHoldOriginal(url || originalForCompare.src);
    });
}

function holdOriginalEnd() {
    _holdWanted = false;
    if (!_holdOriginalActive) return;
    _holdOriginalActive = false;
    const ci  = document.getElementById('compareImg');
    const btn = document.getElementById('compareBtn');
    if (ci)  { ci.classList.remove('active', 'holding-original'); ci.style.clipPath = ''; }
    if (btn) { btn.classList.remove('comparing'); btn.setAttribute('aria-pressed', 'false'); }
    _announce('announceShowingEdited');
}

function initHoldOriginal() {
    const btn = document.getElementById('compareBtn');
    if (!btn) return;
    const isGhostMouse = function () { return Date.now() - _holdLastTouchTs < 800; };

    // Touch: preventDefault stops the browser from synthesising mouse events / a click / a long-press menu.
    btn.addEventListener('touchstart', function (e) {
        _holdLastTouchTs = Date.now();
        e.preventDefault(); e.stopPropagation();
        holdOriginalStart();
    }, { passive: false });
    btn.addEventListener('touchend', function (e) {
        _holdLastTouchTs = Date.now();
        e.preventDefault(); e.stopPropagation();
        holdOriginalEnd();
    }, { passive: false });
    btn.addEventListener('touchcancel', function () {
        _holdLastTouchTs = Date.now();
        holdOriginalEnd();
    }, { passive: true });

    // Mouse
    btn.addEventListener('mousedown', function (e) {
        if (isGhostMouse() || e.button !== 0) return;
        e.preventDefault();
        holdOriginalStart();
    });
    btn.addEventListener('mouseup', function () { if (!isGhostMouse()) holdOriginalEnd(); });
    btn.addEventListener('mouseleave', function () { if (!isGhostMouse()) holdOriginalEnd(); });
    window.addEventListener('mouseup', function () { if (!isGhostMouse()) holdOriginalEnd(); });

    // Keyboard (hold Space / Enter) + safety nets so the original can never get "stuck" on screen.
    btn.addEventListener('keydown', function (e) {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdOriginalStart(); }
    });
    btn.addEventListener('keyup', function (e) {
        if (e.key === ' ' || e.key === 'Enter') holdOriginalEnd();
    });
    btn.addEventListener('blur', holdOriginalEnd);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('blur', holdOriginalEnd);
    document.addEventListener('visibilitychange', function () { if (document.hidden) holdOriginalEnd(); });
}

// compare.js is a deferred script, so this runs before DOMContentLoaded fires.
document.addEventListener('DOMContentLoaded', initHoldOriginal);
})(globalThis);
