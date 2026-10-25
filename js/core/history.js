// ============================================================
// history.js
// ============================================================

// ==================== HISTORY ====================

// Shared debounce timer for continuous-input controls (sliders, color mix,
// overlay-property sliders). Using a single timer means rapid edits across
// different controls are collapsed into one history entry rather than many.
(function (g) {
// V27 module "history": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('history', {
  MAX_HISTORY_BYTES: [() => MAX_HISTORY_BYTES, (v) => { MAX_HISTORY_BYTES = v; }],
  MIN_HISTORY_STATES: [() => MIN_HISTORY_STATES, (v) => { MIN_HISTORY_STATES = v; }],
  _dropHistoryTop: [() => _dropHistoryTop, (v) => { _dropHistoryTop = v; }],
  _historyBytes: [() => _historyBytes, (v) => { _historyBytes = v; }],
  _historyDebounceTimer: [() => _historyDebounceTimer, (v) => { _historyDebounceTimer = v; }],
  _imageBytes: [() => _imageBytes, (v) => { _imageBytes = v; }],
  _imageUrlBytes: [() => _imageUrlBytes, (v) => { _imageUrlBytes = v; }],
  _imageUrlRefs: [() => _imageUrlRefs, (v) => { _imageUrlRefs = v; }],
  _imageUrlTypes: [() => _imageUrlTypes, (v) => { _imageUrlTypes = v; }],
  _isImageUrlInUse: [() => _isImageUrlInUse, (v) => { _isImageUrlInUse = v; }],
  _pendingRevoke: [() => _pendingRevoke, (v) => { _pendingRevoke = v; }],
  _releaseState: [() => _releaseState, (v) => { _releaseState = v; }],
  _sweepPendingRevokes: [() => _sweepPendingRevokes, (v) => { _sweepPendingRevokes = v; }],
  canvasToBlobUrl: [() => canvasToBlobUrl, (v) => { canvasToBlobUrl = v; }],
  getImageUrlType: [() => getImageUrlType, (v) => { getImageUrlType = v; }],
  registerBlobUrl: [() => registerBlobUrl, (v) => { registerBlobUrl = v; }],
  registerImageUrl: [() => registerImageUrl, (v) => { registerImageUrl = v; }],
  resetHistory: [() => resetHistory, (v) => { resetHistory = v; }],
  saveToHistory: [() => saveToHistory, (v) => { saveToHistory = v; }],
  scheduleHistorySave: [() => scheduleHistorySave, (v) => { scheduleHistorySave = v; }],
  undoEdit: [() => undoEdit, (v) => { undoEdit = v; }],
});
var _historyDebounceTimer = null;

// Debounced save for continuous controls: one undo step once the user stops dragging.
function scheduleHistorySave() {
    clearTimeout(_historyDebounceTimer);
    _historyDebounceTimer = setTimeout(saveToHistory, 650);
}

// ==================== IMAGE-SOURCE BOOKKEEPING ====================
// History snapshots only ever hold a *URL* for the working image. Producers
// (crop, eraser, portrait, bg-removal, enhance) now emit blob: URLs instead of
// base64 data: URLs, so a 12 MP result costs one encoded blob (kept by the
// browser outside the JS heap) rather than a ~1.33x base64 string on the heap.
//
//   _imageUrlBytes : url -> encoded size in bytes   (budget accounting)
//   _imageUrlRefs  : url -> number of history states referencing it
//
// Slider/overlay edits do not change originalImage.src, so consecutive states
// share one URL: the refcount goes up, the byte count is not duplicated.
var _imageUrlBytes = new Map();
var _imageUrlRefs  = new Map();
var _imageUrlTypes = new Map();      // url -> mime type (optional, used for export naming)
var _pendingRevoke = new Set();      // blob: URLs dropped from history but still on screen

// Dynamic byte budget for everything the history keeps alive.
// V24/G9: history entries are now LOSSLESS PNG blobs (roughly 8-12 MB for a 2560 px photo, against ~1 MB as JPEG), so the
// budget is raised to keep a comfortable undo / redo depth: 150 MB on low-end / unknown devices, 200 MB on 8 GB-class ones.
// The two newest states are always kept whatever the budget says (MIN_HISTORY_STATES) and `maxHistory` still caps the count.
var MAX_HISTORY_BYTES = (function () {
    var mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;
    // deviceMemory is unavailable on Safari/Firefox: treat "unknown" as low-end (safe default).
    return (mem && mem > 4 ? 200 : 150) * 1024 * 1024;
})();

// Always keep at least this many newest states, whatever the budget says.
var MIN_HISTORY_STATES = 2;

function registerImageUrl(url, bytes, type) {
    if (!url) return url;
    if (bytes > 0) _imageUrlBytes.set(url, bytes);
    if (type) _imageUrlTypes.set(url, type);
    return url;
}

function getImageUrlType(url) {
    if (_imageUrlTypes.has(url)) return _imageUrlTypes.get(url);
    var m = /^data:([^;,]+)/.exec(url || '');
    return m ? m[1] : '';
}

// Wrap a blob in an object URL and register its size in one step.
function registerBlobUrl(blob) {
    return registerImageUrl(URL.createObjectURL(blob), blob.size, blob.type);
}

// canvas -> Promise<{ url, blob }>   (replaces canvas.toDataURL everywhere)
// V24/G8: the actual canvas.toBlob() wrapper is canvasToBlob() in js/ui/save-image.js (one copy for the whole app); this
// only adds the registered object URL the history needs. Resolved at call time, so script order does not matter.
function canvasToBlobUrl(canvas, type, quality) {
    return canvasToBlob(canvas, type, quality).then(function (blob) {
        return { url: registerBlobUrl(blob), blob: blob };
    });
}

// Size of an image URL. Registered value wins; data: URLs are decoded from
// their length; anything else falls back to a conservative estimate.
function _imageBytes(url) {
    if (!url) return 0;
    if (_imageUrlBytes.has(url)) return _imageUrlBytes.get(url);
    var bytes = 0;
    if (url.indexOf('data:') === 0) {
        var comma = url.indexOf(',');
        var b64 = url.length - comma - 1;
        var pad = url.charAt(url.length - 1) === '=' ? (url.charAt(url.length - 2) === '=' ? 2 : 1) : 0;
        bytes = Math.max(0, Math.floor(b64 * 3 / 4) - pad);
    } else if (typeof originalImage !== 'undefined' && originalImage && originalImage.src === url) {
        // Unregistered blob/http URL: assume ~0.5 byte per pixel (compressed).
        bytes = Math.round((originalImage.naturalWidth || 0) * (originalImage.naturalHeight || 0) * 0.5);
    }
    if (bytes) _imageUrlBytes.set(url, bytes);
    return bytes;
}

// URLs that are visibly/functionally in use right now must never be revoked.
function _isImageUrlInUse(url) {
    try {
        if (typeof originalImage !== 'undefined' && originalImage && originalImage.src === url) return true;
        if (typeof originalForCompare !== 'undefined' && originalForCompare && originalForCompare.src === url) return true;
        var main = document.getElementById('mainImg');
        if (main && main.src === url) return true;
        var ci = document.getElementById('compareImg');
        if (ci && ci.src === url) return true;
        if (window.MagicEraser && typeof window.MagicEraser.getHeldUrls === 'function' &&
            window.MagicEraser.getHeldUrls().indexOf(url) !== -1) return true;
    } catch (e) {}
    return false;
}

function _revokeImageUrl(url) {
    _pendingRevoke.delete(url);
    _imageUrlBytes.delete(url);
    _imageUrlTypes.delete(url);
    if (url.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(url); } catch (e) {}
    }
}

// Revoke deferred URLs once nothing displays them any more.
function _sweepPendingRevokes() {
    _pendingRevoke.forEach(function (url) {
        if (_imageUrlRefs.get(url) > 0) { _pendingRevoke.delete(url); return; }   // re-adopted by a state
        if (!_isImageUrlInUse(url)) _revokeImageUrl(url);
    });
}

function _retainImage(url) {
    if (!url) return;
    _imageUrlRefs.set(url, (_imageUrlRefs.get(url) || 0) + 1);
    _pendingRevoke.delete(url);
    _imageBytes(url);                               // make sure a size is on record
}

function _releaseImage(url) {
    if (!url) return;
    var n = (_imageUrlRefs.get(url) || 0) - 1;
    if (n > 0) { _imageUrlRefs.set(url, n); return; }
    _imageUrlRefs.delete(url);
    if (url.indexOf('blob:') !== 0) { _imageUrlBytes.delete(url); _imageUrlTypes.delete(url); return; }
    // blob: no history state references it. Revoke now unless it is still
    // the on-screen image (or compare/eraser source) - then revoke later.
    if (_isImageUrlInUse(url)) _pendingRevoke.add(url);
    else _revokeImageUrl(url);
}

// Total encoded bytes kept alive by history (each distinct URL counted once).
function _historyBytes() {
    var total = 0;
    _imageUrlRefs.forEach(function (_n, url) { total += _imageBytes(url); });
    return total;
}

function _releaseState(state) {
    if (state) _releaseImage(state.originalImageSrc);
}

// Remove the newest state (used by portrait refinement to replace its own entry).
function _dropHistoryTop() {
    if (!historyStack.length) return;
    _releaseState(historyStack.pop());
    historyIndex = Math.min(historyIndex, historyStack.length - 1);
    updateUndoButton();
}

// Drop the oldest states while over the entry cap or the byte budget.
function _enforceHistoryLimits() {
    while (historyStack.length > maxHistory ||
           (historyStack.length > MIN_HISTORY_STATES && _historyBytes() > MAX_HISTORY_BYTES)) {
        _releaseState(historyStack.shift());
        historyIndex = Math.max(0, historyIndex - 1);
    }
}

// R8: start a brand-new history (used when a new photo is loaded). Cancels the pending debounced
// save, releases every image URL the old states kept alive (blob URLs are revoked, or queued for
// revocation while still on screen) and resets the stack so Undo can never resurrect the previous photo.
function resetHistory() {
    clearTimeout(_historyDebounceTimer);
    _historyDebounceTimer = null;
    while (historyStack.length) _releaseState(historyStack.pop());
    historyStack = [];
    historyIndex = -1;
    _sweepPendingRevokes();
    updateUndoButton();
}

// R9: if a debounced save is still pending (the user changed something < 650 ms ago), commit it NOW so
// that the edit becomes a real history step. Undo then reverts exactly that edit, and the timer can
// no longer fire later and push a stray entry / truncate the redo tail.
function flushPendingHistorySave() {
    if (_historyDebounceTimer === null) return;
    clearTimeout(_historyDebounceTimer);
    _historyDebounceTimer = null;
    saveToHistory();
}

function saveToHistory() {
    if (!originalImage) return; // guard: no image loaded yet

    // Cancel any pending debounced save — this explicit save supersedes it.
    clearTimeout(_historyDebounceTimer);
    _historyDebounceTimer = null;

    const state = {
        sliders:          Object.assign({}, sliders),
        chosenPreset:     chosenPreset,
        colorMixData:     JSON.parse(JSON.stringify(colorMixData)),
        curvesData:       JSON.parse(JSON.stringify(curvesData)),
        cropRatio:        cropRatio,
        fitMode:          fitMode,
        // R6: full frame state (id + every control + custom colour) so undo restores the frame the
        // user actually had, and the export reads the same state the preview shows.
        frame:            (typeof getFrameState === 'function') ? getFrameState() : null,
        // Y15: which part of the upload the edited photo still shows (null = all of it) - keeps the held
        // "Original" preview aligned after Undo / Redo of a crop.
        compareCrop:      (typeof getCompareCropState === 'function') ? getCompareCropState() : null,
        overlays:         JSON.parse(JSON.stringify(overlayManager.items)),

        // --- Image-baseline snapshot ----------------------------------------
        // After a crop, `originalImage` changes to the cropped image.
        // We must store the current image src so undo can restore it.
        originalImageSrc: originalImage.src,

        // Preview-canvas dimensions at the moment of this state.
        // These must be restored together with originalImage so
        // applyCanvasEffects() scales into the correct resolution.
        previewW:         previewCanvas ? previewCanvas.width  : 0,
        previewH:         previewCanvas ? previewCanvas.height : 0,
    };

    // Truncate any redo tail when a new action is taken (release its images)
    if (historyIndex < historyStack.length - 1) {
        var tail = historyStack.splice(historyIndex + 1);
        for (var i = 0; i < tail.length; i++) _releaseState(tail[i]);
    }

    _retainImage(state.originalImageSrc);
    historyStack.push(state);
    historyIndex = historyStack.length - 1;

    // Oldest states go first when over the entry cap or the memory budget
    // (the two newest are always kept).
    _enforceHistoryLimits();
    _sweepPendingRevokes();

    updateUndoButton();
}

// ---------------------------------------------------------------------------
// _commitUndoState(state)
// Synchronous portion of undo: restores all edit params, re-renders.
// Always called after originalImage (and previewCanvas dims) are in sync.
// ---------------------------------------------------------------------------
function _commitUndoState(state) {
    Object.assign(sliders, state.sliders);
    chosenPreset  = state.chosenPreset;
    colorMixData  = JSON.parse(JSON.stringify(state.colorMixData));
    curvesData    = JSON.parse(JSON.stringify(state.curvesData));
    cropRatio     = state.cropRatio;
    fitMode       = state.fitMode;

    // Restore the frame (id, controls, colour, UI) - falls back to fitMode for states saved before V19
    if (state.frame && typeof setFrameState === 'function') {
        setFrameState(state.frame);
    } else {
        if (typeof setFrameState === 'function') {
            var legacyId = (typeof _findFrame === 'function' && _findFrame(state.fitMode)) ? state.fitMode : 'none';
            setFrameState({ id: legacyId, controls: null });
        }
        _applyFitContainer(state.fitMode);
    }

    if (typeof setCompareCropState === 'function') setCompareCropState(state.compareCrop || null);

    // Restore overlay items
    if (state.overlays) {
        overlayManager.items      = JSON.parse(JSON.stringify(state.overlays));
        overlayManager.selectedId = null;
        overlayManager.render();          // (updatePanels() no longer exists since V23 - it threw here on every undo/redo with overlays)
    }

    // Re-render the image from the restored baseline
    updateSliderUI();
    renderPresets();
    renderColorMix();
    buildCurvesLUTs();
    applyAllEdits();
    updateUndoButton();
    _sweepPendingRevokes();     // the image we just left may now be revocable
}

function undoEdit() {
    flushPendingHistorySave();      // R9: never race the 650 ms debounce
    if (historyIndex <= 0) return;
    historyIndex--;
    var state = historyStack[historyIndex];

    // -----------------------------------------------------------------------
    // Restore originalImage if it changed (e.g., a crop was applied after
    // this history state was saved).  The image load is async for data URLs
    // so we branch here; _commitUndoState runs in the onload callback.
    // -----------------------------------------------------------------------
    var needsImageRestore = state.originalImageSrc &&
                            originalImage &&
                            state.originalImageSrc !== originalImage.src;

    if (needsImageRestore) {
        var restoredImg = new Image();
        restoredImg.onload = function () {
            // A newer undo superseded this one while the image was decoding.
            if (historyStack[historyIndex] !== state) return;
            originalImage = restoredImg;
            // Restore preview-canvas dimensions to match the pre-crop image
            if (state.previewW && state.previewH && previewCanvas) {
                previewCanvas.width  = state.previewW;
                previewCanvas.height = state.previewH;
            }
            _commitUndoState(state);
        };
        restoredImg.onerror = function () {
            // Should not happen (states keep their blobs alive through the
            // refcount), but never leave the UI half-restored if it does.
            if (historyStack[historyIndex] !== state) return;
            console.warn('[history] image for this state could not be loaded');
            _commitUndoState(state);
        };
        restoredImg.src = state.originalImageSrc;
    } else {
        // Same originalImage — restore preview-canvas dimensions if recorded
        if (state.previewW && state.previewH && previewCanvas) {
            previewCanvas.width  = state.previewW;
            previewCanvas.height = state.previewH;
        }
        _commitUndoState(state);
    }
}

function updateUndoButton() {
    var btn = document.getElementById('undoBtn');
    if (!btn) return;
    btn.disabled     = historyIndex <= 0;
    btn.style.opacity = historyIndex <= 0 ? '0.5' : '1';
}
})(globalThis);
