// ============================================================
// sliders.js
// ============================================================
// ==================== SLIDERS & UI ====================
// `oninput` calls this while the thumb moves: those frames take the live GPU path (no image encode).
// adjustSlider() (the -/+ buttons) is a single discrete step and passes live=false -> full path.
(function (g) {
// V27 module "sliders": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('sliders', {
  _scheduleLiveSettle: [() => _scheduleLiveSettle, (v) => { _scheduleLiveSettle = v; }],
  adjustSlider: [() => adjustSlider, (v) => { adjustSlider = v; }],
  applyAllEdits: [() => applyAllEdits, (v) => { applyAllEdits = v; }],
  buildCSSFilter: [() => buildCSSFilter, (v) => { buildCSSFilter = v; }],
  onSliderChange: [() => onSliderChange, (v) => { onSliderChange = v; }],
  updateSliderUI: [() => updateSliderUI, (v) => { updateSliderUI = v; }],
});
function onSliderChange(id, live) {
    const val = parseInt(document.getElementById(id).value);
    sliders[id] = val;
    document.getElementById('v-' + id).innerText = val;
    applyAllEdits(live !== false);
    scheduleHistorySave();
}

function adjustSlider(id, dir) {
    const slider = document.getElementById(id);
    const step = sliderSteps[id] || 1;
    let val = parseInt(slider.value) + (dir * step);
    val = Math.max(parseInt(slider.min), Math.min(parseInt(slider.max), val));
    slider.value = val;
    onSliderChange(id, false);
}

function updateSliderUI() {
    const keys = Object.keys(sliders);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const el = document.getElementById(key);
        if (el) {
            el.value = sliders[key];
            const valEl = document.getElementById('v-' + key);
            if (valEl) valEl.innerText = sliders[key];
        }
    }
}

function buildCSSFilter() {
    let filter = '';
    if (sliders.bright !== 0) filter += 'brightness(' + (100 + sliders.bright) + '%) ';
    if (sliders.contrast !== 0) filter += 'contrast(' + (100 + sliders.contrast) + '%) ';
    if (sliders.sat !== 0) filter += 'saturate(' + (100 + sliders.sat) + '%) ';
    if (chosenPreset !== 'none') {
        const preset = allPresets.find(function(p) { return p.id === chosenPreset; });
        if (preset) {
            const presetFilter = getPresetFilter(preset.style);
            if (presetFilter) filter += presetFilter + ' ';
        }
    }
    // Color Mix is intentionally NOT approximated here: the selective per-band mix runs ONLY in the
    // shader / CPU pass (a global average hue-rotate would shift colours outside the chosen band).
    return filter.trim();
}

// ==================== PREVIEW UPDATE (V23 / G1 live drag path) ====================
// While a slider thumb moves, every frame is drawn by the GPU straight into a transient <canvas> laid over
// #mainImg: no toDataURL / JPEG encode, no <img> decode, no overlay re-measure. ~140 ms after the last input
// the "settle" step runs the normal path ONCE (encode into #mainImg.src), waits for the image to decode,
// and only then removes the live canvas, so there is never a blank or stale frame. The canvas backing store
// is released (width = height = 0) every time it is hidden. Everything that is not a slider drag (-/+ buttons,
// presets, history, curves, colour mix, AI tools) keeps the exact V22 behaviour.
var LIVE_SETTLE_MS = 140;
var _liveCanvas = null;
var _liveTimer = null;
var _liveEpoch = 0;        // bumped on every live frame; a settle that finished late must not hide a newer frame
var _liveWanted = false;   // would the frame scheduled in the current animation frame be a live one?

function applyAllEdits(live) {
    if (!originalImage) return;
    if (pendingUpdate) {
        cancelAnimationFrame(pendingUpdate);
        _liveWanted = _liveWanted && live === true;   // a discrete change in the same frame forces the full path
    } else {
        _liveWanted = live === true;
    }
    pendingUpdate = requestAnimationFrame(function() {
        pendingUpdate = null;
        _applyAllEditsImpl(_liveWanted);
    });
}

function _applyAllEditsImpl(live) {
    const img = document.getElementById('mainImg');
    if (!img.src || !originalImage) return;

    // One shared predicate (render-pipeline.js) for preview AND export: sliders, ALL four curve
    // channels over the full 0..255 range, and Color Mix.
    if (YoPipeline.needsPixelPass()) {
        if (live === true && _drawLiveFrame(img)) {
            _scheduleLiveSettle();
            return;                                   // preview size unchanged: nothing to re-measure
        }
        applyCanvasEffects();
    } else {
        let filter = buildCSSFilter();
        img.style.filter = filter;
        lastFilterString = filter;
        if (img.src !== originalImage.src) {
            img.src = originalImage.src;
        }
        _hideLiveCanvasAfterDecode(img);              // a drag that ended back at "no pixel pass"
    }

    overlayManager.resizeCanvas();
}

// Full path: render -> encode -> <img>. Used for every non-drag change and as the settle step of a drag.
function applyCanvasEffects() {
    if (!originalImage || !previewCanvas) return;
    var dims = YoPipeline.syncPreviewCanvas();
    if (!dims) return;

    // Colour filters (brightness / contrast / saturate / preset), every pixel effect, Color Mix and
    // curves all run inside the pipeline: no ctx.filter dependency, alpha is preserved, and the
    // previous frame is cleared first so transparent areas never show old pixels.
    YoPipeline.renderPreview(previewCtx, dims.w, dims.h);

    var enc = YoPipeline.previewEncoding(originalImage);
    var img = document.getElementById('mainImg');
    img.src = previewCanvas.toDataURL(enc.mime, enc.quality);
    img.style.filter = 'none';
    lastFilterString = 'none';
    _hideLiveCanvasAfterDecode(img);
}

// Draws one GPU frame into the live canvas. false = caller must use the full path (GPU unavailable /
// photo not laid out yet); the live canvas is never left half-initialised in that case.
function _drawLiveFrame(img) {
    if (!previewCanvas) return false;
    // No WebGL2 -> no live path, and no DOM / allocation churn per frame: straight to the full path.
    if (typeof GPU === 'undefined' || !GPU.isAvailable()) return false;
    var w = img.offsetWidth, h = img.offsetHeight;
    if (!w || !h) return false;
    var dims = YoPipeline.previewSize(originalImage);
    var container = document.getElementById('imgContainer');
    if (!container) return false;

    var created = false;
    if (!_liveCanvas) {
        _liveCanvas = document.createElement('canvas');
        _liveCanvas.className = 'live-preview-canvas';
        _liveCanvas.setAttribute('aria-hidden', 'true');
        created = true;
    }
    if (_liveCanvas.parentNode !== container) container.appendChild(_liveCanvas);

    // (Re)size only when needed: the backing store is re-allocated after every release, never per frame.
    if (_liveCanvas.width !== dims.w || _liveCanvas.height !== dims.h) {
        _liveCanvas.width = dims.w;
        _liveCanvas.height = dims.h;
    }
    var ctx = _liveCanvas.getContext('2d');
    if (!ctx || !YoPipeline.renderGpuFrame(ctx, dims.w, dims.h)) {
        if (created || !_liveCanvas.classList.contains('active')) _releaseLiveCanvas();
        return false;
    }

    // Pin the canvas to the photo's box. Layout is read once per drag (first frame), not per frame.
    if (!_liveCanvas.classList.contains('active')) {
        _liveCanvas.style.left = img.offsetLeft + 'px';
        _liveCanvas.style.top = img.offsetTop + 'px';
        _liveCanvas.style.width = w + 'px';
        _liveCanvas.style.height = h + 'px';
        try { _liveCanvas.style.borderRadius = window.getComputedStyle(img).borderRadius; } catch (e) {}
        _liveCanvas.classList.add('active');
    }
    _liveEpoch++;
    return true;
}

function _scheduleLiveSettle() {
    if (_liveTimer) clearTimeout(_liveTimer);
    _liveTimer = setTimeout(_settleLive, LIVE_SETTLE_MS);
}

// Drag finished: run the normal path once. (Errors surface in the console instead of being swallowed.)
function _settleLive() {
    _liveTimer = null;
    if (!originalImage) { _releaseLiveCanvas(); return; }
    _applyAllEditsImpl(false);
}

function _releaseLiveCanvas() {
    if (!_liveCanvas) return;
    _liveCanvas.classList.remove('active');
    _liveCanvas.width = 0;            // free the backing store immediately
    _liveCanvas.height = 0;
    if (_liveCanvas.parentNode) _liveCanvas.parentNode.removeChild(_liveCanvas);
}

// Remove the live canvas once `img` shows its new source. A newer live frame (epoch changed) wins.
function _hideLiveCanvasAfterDecode(img) {
    if (!_liveCanvas || !_liveCanvas.classList.contains('active')) return;
    if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
    var epoch = _liveEpoch;
    var done = function() { if (epoch === _liveEpoch) _releaseLiveCanvas(); };
    if (img && typeof img.decode === 'function') img.decode().then(done, done);
    else done();
}
})(globalThis);
