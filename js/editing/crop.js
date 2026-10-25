// ============================================================
// crop.js
// ============================================================
// ==================== CROP SYSTEM (Lightroom-style) ====================
// State: cropBox holds current selection in container-space pixels
(function (g) {
// V27 module "crop": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('crop', {
  CROP_MIN_OUTPUT: [() => CROP_MIN_OUTPUT],
  _cropBusy: [() => _cropBusy, (v) => { _cropBusy = v; }],
  _cropInitTimer: [() => _cropInitTimer, (v) => { _cropInitTimer = v; }],
  _exactRatioSize: [() => _exactRatioSize, (v) => { _exactRatioSize = v; }],
  activateCropMode: [() => activateCropMode, (v) => { activateCropMode = v; }],
  applyCropSelection: [() => applyCropSelection, (v) => { applyCropSelection = v; }],
  cancelCrop: [() => cancelCrop, (v) => { cancelCrop = v; }],
  clampCropBox: [() => clampCropBox, (v) => { clampCropBox = v; }],
  cropAspect: [() => cropAspect, (v) => { cropAspect = v; }],
  cropAspectParts: [() => cropAspectParts, (v) => { cropAspectParts = v; }],
  cropBox: [() => cropBox, (v) => { cropBox = v; }],
  cropImgBounds: [() => cropImgBounds, (v) => { cropImgBounds = v; }],
  initCropSystem: [() => initCropSystem, (v) => { initCropSystem = v; }],
});
let cropBox = { x: 0, y: 0, w: 0, h: 0 };
let cropImgBounds = { x: 0, y: 0, w: 0, h: 0 }; // image bounds within container
let cropAspect = null; // null = free, otherwise w/h ratio
let cropAspectParts = null; // [num, den] of the chosen ratio, e.g. [16, 9]: exact integer output sizes
const CROP_MIN = 30;          // smallest crop box on screen (CSS px), both sides
const CROP_MIN_OUTPUT = 16;   // smallest crop in SOURCE pixels that is accepted
let _cropBusy = false;        // an Apply is being encoded: a second tap must not start another one
let _cropInitTimer = null;    // pending initializeCropBox() after a tab / ratio tap
let _cropLastActivate = { ratio: null, t: 0 };

// Y14: crop UI state lives in classes, not in inline display styles:
//   #cropRect.is-visible / #cropActions.is-visible, and body.crop-active (hides the floating Undo/Original).
function _setCropUiVisible(on) {
    const rect = document.getElementById('cropRect');
    const actions = document.getElementById('cropActions');
    if (rect) rect.classList.toggle('is-visible', on);
    if (actions) actions.classList.toggle('is-visible', on);
    document.body.classList.toggle('crop-active', on);
}

function getImgBoundsInContainer() {
    const container = document.getElementById('imgContainer');
    const img = document.getElementById('mainImg');
    const cr = container.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    return { x: ir.left - cr.left, y: ir.top - cr.top, w: ir.width, h: ir.height };
}

function renderCropBox() {
    const rect = document.getElementById('cropRect');
    rect.style.left = cropBox.x + 'px';
    rect.style.top = cropBox.y + 'px';
    rect.style.width = cropBox.w + 'px';
    rect.style.height = cropBox.h + 'px';
    _setCropUiVisible(true);
}

// Smallest width a box may have: both sides >= CROP_MIN, and (fixed ratio) exactly on the ratio.
function _minCropW() { return cropAspect ? CROP_MIN * Math.max(1, cropAspect) : CROP_MIN; }
function _minCropH() { return cropAspect ? _minCropW() / cropAspect : CROP_MIN; }

// Y12: order matters - 1) minimum size, 2) fit inside the photo (keeping the ratio), 3) only then position.
function clampCropBox() {
    const b = cropImgBounds;
    let w = cropBox.w, h = cropBox.h;
    if (cropAspect) {
        w = Math.max(w, _minCropW());
        h = w / cropAspect;
        const k = Math.min(1, b.w / w, b.h / h);          // too big for the photo: scale BOTH sides
        w *= k; h *= k;
    } else {
        w = Math.min(Math.max(w, CROP_MIN), b.w);
        h = Math.min(Math.max(h, CROP_MIN), b.h);
    }
    let x = Math.min(Math.max(cropBox.x, b.x), b.x + b.w - w);
    let y = Math.min(Math.max(cropBox.y, b.y), b.y + b.h - h);
    cropBox = { x: x, y: y, w: w, h: h };
}

function initializeCropBox() {
    cropImgBounds = getImgBoundsInContainer();
    const b = cropImgBounds;
    let w, h;
    if (cropAspect) {
        // Fit largest rect with aspect inside image bounds, at 90%
        const scale = 0.9;
        if (b.w / b.h > cropAspect) {
            h = b.h * scale;
            w = h * cropAspect;
        } else {
            w = b.w * scale;
            h = w / cropAspect;
        }
    } else {
        w = b.w * 0.7;
        h = b.h * 0.7;
    }
    cropBox = { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w: w, h: h };
    clampCropBox();
    renderCropBox();
    _announceCropSize();
}

function _announceCropSize() {
    if (!window.YoA11y || !originalImage || !cropImgBounds.w) return;
    const k = originalImage.naturalWidth / cropImgBounds.w;
    window.YoA11y.announce(window.t('announceCropSize', { w: Math.round(cropBox.w * k), h: Math.round(cropBox.h * k) }));
}

function getPointerPos(e) {
    const container = document.getElementById('imgContainer');
    const cr = container.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - cr.left, y: t.clientY - cr.top };
}

function initCropSystem() {
    const overlay = document.getElementById('cropOverlay');
    const rect = document.getElementById('cropRect');

    let mode = null; // 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | 'draw'
    let startPos = null;
    let startBox = null;

    function startDrag(e, m) {
        if (!isCropMode) return;
        e.preventDefault();
        e.stopPropagation();
        mode = m;
        startPos = getPointerPos(e);
        startBox = { x: cropBox.x, y: cropBox.y, w: cropBox.w, h: cropBox.h };
        isDrawingCrop = true;
        // G5: onMove calls preventDefault(), so a touch drag needs a NON-passive touchmove listener - but only
        // while the drag runs. It used to sit on `document` for the whole session (scroll-blocking warning,
        // and every touch anywhere paid for it). endDrag() removes it again.
        if (e.touches) document.addEventListener('touchmove', onMove, { passive: false });
    }

    function onMove(e) {
        if (!isCropMode || !isDrawingCrop || !mode) return;
        e.preventDefault();
        const p = getPointerPos(e);
        const dx = p.x - startPos.x;
        const dy = p.y - startPos.y;
        const b = cropImgBounds;

        if (mode === 'move') {
            cropBox.x = startBox.x + dx;
            cropBox.y = startBox.y + dy;
            clampCropBox();
        } else if (mode === 'draw') {
            // draw a new box from the press point to the pointer, inside the photo (free ratio only)
            let x1 = Math.max(b.x, Math.min(startPos.x, p.x));
            let y1 = Math.max(b.y, Math.min(startPos.y, p.y));
            let x2 = Math.min(b.x + b.w, Math.max(startPos.x, p.x));
            let y2 = Math.min(b.y + b.h, Math.max(startPos.y, p.y));
            cropBox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        } else {
            // resize: the corner OPPOSITE the dragged handle is the fixed anchor
            const east = (mode === 'resize-se' || mode === 'resize-ne');
            const south = (mode === 'resize-se' || mode === 'resize-sw');
            const ax = east ? startBox.x : startBox.x + startBox.w;
            const ay = south ? startBox.y : startBox.y + startBox.h;
            const room = { w: east ? b.x + b.w - ax : ax - b.x, h: south ? b.y + b.h - ay : ay - b.y };
            // where the dragged corner wants to be
            let w = (east ? 1 : -1) * ((east ? startBox.x + startBox.w : startBox.x) + dx - ax);
            let h = (south ? 1 : -1) * ((south ? startBox.y + startBox.h : startBox.y) + dy - ay);
            if (cropAspect) {
                // dominant axis decides, then BOTH sides come from the exact ratio
                if (Math.abs(dx) >= Math.abs(dy)) h = w / cropAspect; else w = h * cropAspect;
                const maxW = Math.min(room.w, room.h * cropAspect);
                const minW = Math.min(_minCropW(), maxW);
                w = Math.min(Math.max(w, minW), maxW);
                h = w / cropAspect;
            } else {
                w = Math.min(Math.max(w, Math.min(CROP_MIN, room.w)), room.w);
                h = Math.min(Math.max(h, Math.min(CROP_MIN, room.h)), room.h);
            }
            cropBox = { x: east ? ax : ax - w, y: south ? ay : ay - h, w: w, h: h };
        }
        renderCropBox();
    }

    function endDrag() {
        document.removeEventListener('touchmove', onMove, { passive: false });
        const wasDraw = (mode === 'draw');
        isDrawingCrop = false;
        mode = null;
        if (wasDraw && startBox && (cropBox.w < CROP_MIN || cropBox.h < CROP_MIN)) {
            // Y12: a tap / tiny drag never leaves an unusable box behind: restore the previous one and say why
            cropBox = { x: startBox.x, y: startBox.y, w: startBox.w, h: startBox.h };
            clampCropBox();
            renderCropBox();
            showToast(window.t('toastCropTooSmall'), 'warning');
        } else if (startBox) {
            _announceCropSize();
        }
        startBox = null;
    }

    // Overlay: draw new rect only if free-mode and starting outside existing box
    overlay.addEventListener('mousedown', function(e) {
        if (!isCropMode || e.target !== overlay) return;
        if (cropAspect) return; // fixed ratio uses centered preset only
        startDrag(e, 'draw');
    });
    overlay.addEventListener('touchstart', function(e) {
        if (!isCropMode || e.target !== overlay) return;
        if (cropAspect) return;
        startDrag(e, 'draw');
    }, { passive: false });

    // Rect body: move
    rect.addEventListener('mousedown', function(e) { if (e.target === rect) startDrag(e, 'move'); });
    rect.addEventListener('touchstart', function(e) { if (e.target === rect) startDrag(e, 'move'); }, { passive: false });

    // Handles: resize
    const handles = [['cropHandleNW','resize-nw'],['cropHandleNE','resize-ne'],['cropHandleSW','resize-sw'],['cropHandleSE','resize-se']];
    for (let i = 0; i < handles.length; i++) {
        const el = document.getElementById(handles[i][0]);
        const m = handles[i][1];
        el.addEventListener('mousedown', function(e) { startDrag(e, m); });
        el.addEventListener('touchstart', function(e) { startDrag(e, m); }, { passive: false });
    }

    // touchmove is attached per drag in startDrag(); touchend / touchcancel never cancel anything -> passive.
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag, { passive: true });
    document.addEventListener('touchcancel', endDrag, { passive: true });   // an interrupted touch must end the drag
}

function activateCropMode(ratio, element) {
    // Y12: a double click / double tap on a ratio button (or the tab + the button) must not start the
    // activation twice (two timers, two toasts, a box re-initialised under the finger).
    const now = Date.now();
    if (isCropMode && _cropLastActivate.ratio === ratio && now - _cropLastActivate.t < 400) return;
    _cropLastActivate = { ratio: ratio, t: now };

    const boxes = document.querySelectorAll('#p-crop .opt-box');
    for (let i = 0; i < boxes.length; i++) boxes[i].classList.remove('active');
    if (element) element.classList.add('active');
    cropRatio = ratio;

    if (!requireImage()) return;

    // Always reset image display so bounds are natural
    const img = document.getElementById('mainImg');
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.aspectRatio = 'auto';
    img.style.objectFit = 'contain';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';

    const ratioMap = { 'free': null, '1-1': 1, '4-5': 4/5, '16-9': 16/9, '9-16': 9/16, '4-3': 4/3, '3-4': 3/4 };
    cropAspect = ratioMap[ratio];
    if (cropAspect === undefined) cropAspect = null;
    cropAspectParts = null;
    if (cropAspect) {
        const m = /^(\d+)-(\d+)$/.exec(ratio);
        if (m) cropAspectParts = [parseInt(m[1], 10), parseInt(m[2], 10)];
    }

    isCropMode = true;
    document.getElementById('cropOverlay').classList.add('active');

    // Wait for layout, then initialize the crop rectangle (one pending init at a time)
    clearTimeout(_cropInitTimer);
    _cropInitTimer = setTimeout(function() {
        _cropInitTimer = null;
        if (!isCropMode) return;                      // cancelled in the meantime
        initializeCropBox();
    }, 50);
}

// Largest exact-ratio size (integer multiples of the ratio) that fits the wanted source size.
function _exactRatioSize(sw, sh) {
    const n = cropAspectParts[0], d = cropAspectParts[1];
    const k = Math.floor(Math.min(sw / n, sh / d));
    return k >= 1 ? { w: k * n, h: k * d } : null;
}

function applyCropSelection() {
    if (_cropBusy) return;                                       // Y12: double tap on Apply
    if (!originalImage || !cropBox || cropBox.w < 5 || cropBox.h < 5) {
        showToast(window.t('toastCropNoArea'), 'warning');
        return;
    }
    const img = document.getElementById('mainImg');
    const container = document.getElementById('imgContainer');
    const cr = container.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const imgLeft = ir.left - cr.left;
    const imgTop = ir.top - cr.top;
    const natW = originalImage.naturalWidth, natH = originalImage.naturalHeight;

    const scaleX = natW / ir.width;
    const scaleY = natH / ir.height;
    let sx = Math.max(0, (cropBox.x - imgLeft) * scaleX);
    let sy = Math.max(0, (cropBox.y - imgTop) * scaleY);
    let sw = Math.min(natW - sx, cropBox.w * scaleX);
    let sh = Math.min(natH - sy, cropBox.h * scaleY);

    // Output size: fixed ratio -> exact integer multiples of the ratio (16:9 is really 16:9, not 1919x1080)
    let outW = Math.round(sw), outH = Math.round(sh);
    if (cropAspectParts) {
        const ex = _exactRatioSize(sw, sh);
        if (ex) {
            sx = Math.min(sx + (sw - ex.w) / 2, natW - ex.w);  // keep the box centre, stay inside the photo
            sy = Math.min(sy + (sh - ex.h) / 2, natH - ex.h);
            sx = Math.max(0, sx); sy = Math.max(0, sy);
            sw = ex.w; sh = ex.h; outW = ex.w; outH = ex.h;
        } else { outW = 0; }
    }
    // Y12: undersized selections are refused with a message instead of silently doing nothing
    if (outW < CROP_MIN_OUTPUT || outH < CROP_MIN_OUTPUT) {
        showToast(window.t('toastCropTooSmall'), 'warning');
        return;
    }

    // Fractions of the CURRENT photo: lets the held "Original" preview crop the upload the same way (Y15)
    const rel = { x: sx / natW, y: sy / natH, w: sw / natW, h: sh / natH };

    _cropBusy = true;
    const applyBtn = document.getElementById('cropApplyBtn');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.setAttribute('aria-busy', 'true'); }
    const release = function() {
        _cropBusy = false;
        if (applyBtn) { applyBtn.disabled = false; applyBtn.removeAttribute('aria-busy'); }
    };

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(originalImage, sx, sy, sw, sh, 0, 0, outW, outH);

    // V24/G8+G9: the shared commit routine (YoPipeline.commitCanvas) encodes the crop LOSSLESSLY (PNG - a crop is an
    // intermediate step, JPEG happens once at export), swaps the working image and writes the history entry. The colour
    // edits stay on top of the cropped pixels, the Frame / overlays / ratio are untouched.
    const cropHasAlpha = YoPipeline.imageHasAlpha(originalImage);   // a crop cannot add transparency
    YoPipeline.commitCanvas(canvas, {
        hasAlpha: cropHasAlpha,
        keepColorEdits: true,
        resetImageBox: true,
        releaseCanvas: true,                              // release the 12MP backing store as soon as it is encoded
        beforeHistory: function() {
            cancelCrop();
            if (typeof applyCropToCompare === 'function') applyCropToCompare(rel);   // Y15: before the history state is saved
        }
    }).then(function() {
        release();
    }, function() {
        release();
        showToast(window.t('toastCropFailed'), 'error');
    });
}

function cancelCrop() {
    clearTimeout(_cropInitTimer);
    _cropInitTimer = null;
    isCropMode = false;
    isDrawingCrop = false;
    cropAspect = null;
    cropAspectParts = null;
    document.getElementById('cropOverlay').classList.remove('active');
    _setCropUiVisible(false);
    cropBox = { x: 0, y: 0, w: 0, h: 0 };
}
})(globalThis);
