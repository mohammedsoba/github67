// ============================================================
// curves.js
// ============================================================
// ==================== CURVES ====================
(function (g) {
// V27 module "curves": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('curves', {
  buildCurveLUT: [() => buildCurveLUT, (v) => { buildCurveLUT = v; }],
  buildCurvesLUTs: [() => buildCurvesLUTs, (v) => { buildCurvesLUTs = v; }],
  cubicInterpolate: [() => cubicInterpolate, (v) => { cubicInterpolate = v; }],
  drawCurves: [() => drawCurves, (v) => { drawCurves = v; }],
  initCurvesCanvas: [() => initCurvesCanvas, (v) => { initCurvesCanvas = v; }],
  invalidateCurveCache: [() => invalidateCurveCache, (v) => { invalidateCurveCache = v; }],
  resetCurves: [() => resetCurves, (v) => { resetCurves = v; }],
  switchCurveChannel: [() => switchCurveChannel, (v) => { switchCurveChannel = v; }],
});
function initCurvesCanvas() {
    const canvas = document.getElementById('curvesCanvas');
    const ctx = canvas.getContext('2d');
    drawCurves(ctx);
    let isDragging = false;
    let dragPoint = null;

    const getPointFromEvent = function(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        // Y8: the canvas is scaled by CSS (responsive width), so convert CSS pixels -> canvas pixels
        const sx = rect.width  > 0 ? canvas.width  / rect.width  : 1;
        const sy = rect.height > 0 ? canvas.height / rect.height : 1;
        return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
    };

    const handleStart = function(e) {
        e.preventDefault();
        const pos = getPointFromEvent(e);
        const points = curvesData[activeCurveChannel];
        let closest = null;
        let minDist = Infinity;
        for (let i = 0; i < points.length; i++) {
            const px = (points[i].x / 255) * canvas.width;
            const py = canvas.height - (points[i].y / 255) * canvas.height;
            const dist = Math.hypot(px - pos.x, py - pos.y);
            if (dist < 28 && dist < minDist) {      // generous grab radius (canvas px) for fingers
                minDist = dist;
                closest = i;
            }
        }
        if (closest !== null) {
            isDragging = true;
            dragPoint = closest;
        }
    };

    const handleMove = function(e) {
        if (!isDragging || dragPoint === null) return;
        e.preventDefault();
        const pos = getPointFromEvent(e);
        const x = Math.max(0, Math.min(255, (pos.x / canvas.width) * 255));
        const y = Math.max(0, Math.min(255, 255 - (pos.y / canvas.height) * 255));
        const points = curvesData[activeCurveChannel];
        if (dragPoint > 0) {
            points[dragPoint].x = Math.max(points[dragPoint - 1].x + 5, Math.min(dragPoint < points.length - 1 ? points[dragPoint + 1].x - 5 : 255, x));
        }
        points[dragPoint].y = y;
        // V24/G6: only the dragged channel changes. Its sorted-points cache is refreshed once, then used by both the
        // preview line and the 256-entry LUT; the other three LUTs keep their arrays untouched.
        invalidateCurveCache(activeCurveChannel);
        drawCurves(ctx);
        buildCurveLUT(activeCurveChannel);
        // applyAllEdits() already coalesces calls into ONE requestAnimationFrame (and cancels a pending one), so it is
        // called directly: the extra rAF wrapper only delayed every frame by one more frame. live = true -> the G1 GPU
        // path (no image encode per move); the single settle encode runs ~140 ms after the last move.
        applyAllEdits(true);
    };

    const handleEnd = function() {
        if (isDragging) {
            isDragging = false;
            dragPoint = null;
            saveToHistory();
        }
    };

    canvas.addEventListener('mousedown', handleStart);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseup', handleEnd);
    canvas.addEventListener('mouseleave', handleEnd);
    canvas.addEventListener('touchstart', handleStart, { passive: false });
    canvas.addEventListener('touchmove', handleMove, { passive: false });
    canvas.addEventListener('touchend', handleEnd, { passive: true });
    canvas.addEventListener('touchcancel', handleEnd, { passive: true });     // Y8: OS interrupted the touch (call, gesture, ...) - never leave a drag stuck
}

// V24/G6: sorted copies of the control points, one per channel. cubicInterpolate() used to copy + sort the points on
// EVERY call (256 x 4 per LUT rebuild plus ~200 for the preview line, on every pointer move). The cache is keyed by
// the points array itself, so replacing curvesData[channel] (reset, undo/redo, new photo) can never serve a stale copy;
// in-place edits (the drag) call invalidateCurveCache().
const _sortedPointsCache = { rgb: null, red: null, green: null, blue: null };

function _sortPoints(points) {
    return points.slice().sort(function(a, b) { return a.x - b.x; });
}

function getSortedCurvePoints(channel) {
    const points = curvesData[channel];
    const hit = _sortedPointsCache[channel];
    if (hit && hit.source === points && hit.length === points.length) {
        // The cached copy holds the SAME point objects, so y/x edits are always seen; only a change of ORDER can make
        // it stale, and that is a 5-element check instead of a sort.
        const s = hit.sorted;
        let ordered = true;
        for (let i = 1; i < s.length; i++) { if (s[i - 1].x > s[i].x) { ordered = false; break; } }
        if (ordered) return s;
    }
    return invalidateCurveCache(channel);
}

function invalidateCurveCache(channel) {
    const points = curvesData[channel];
    const sorted = _sortPoints(points);
    _sortedPointsCache[channel] = { source: points, length: points.length, sorted: sorted };
    return sorted;
}

// `sorted` must already be ordered by x. Without it the points are sorted here (one-off callers).
function cubicInterpolate(x, points, sorted) {
    if (!sorted) sorted = _sortPoints(points);
    let i = 0;
    for (; i < sorted.length - 1; i++) {
        if (x >= sorted[i].x && x <= sorted[i + 1].x) break;
    }
    if (i >= sorted.length - 1) return sorted[sorted.length - 1].y;
    if (x <= sorted[0].x) return sorted[0].y;
    const p0 = sorted[Math.max(0, i - 1)];
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    const p3 = sorted[Math.min(sorted.length - 1, i + 2)];
    const t = (x - p1.x) / (p2.x - p1.x);
    const t2 = t * t;
    const t3 = t2 * t;
    return Math.max(0, Math.min(255, 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)));
}

// Rebuild ONE channel's LUT. A NEW Uint8Array is assigned on purpose: webgl-renderer.js decides whether the LUT
// texture needs a re-upload by comparing the array references, so an in-place edit would never reach the GPU.
function buildCurveLUT(channel) {
    const sorted = getSortedCurvePoints(channel);
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        lut[i] = Math.round(cubicInterpolate(i, null, sorted));
    }
    curvesLUT[channel] = lut;
    return lut;
}

// All four channels (init, reset, undo/redo, new photo). Drags use buildCurveLUT(activeCurveChannel).
function buildCurvesLUTs() {
    const channels = ['rgb', 'red', 'green', 'blue'];
    for (let c = 0; c < channels.length; c++) buildCurveLUT(channels[c]);
}

function drawCurves(ctx) {
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const pos = (i / 4) * w;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(w, pos);
        ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const points = curvesData[activeCurveChannel];
    const sorted = getSortedCurvePoints(activeCurveChannel);
    const colors = { rgb: '#a5b4fc', red: '#ff6b6b', green: '#51cf66', blue: '#339af0' };
    ctx.strokeStyle = colors[activeCurveChannel];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let px = 0; px <= w; px += 2) {
        const x = (px / w) * 255;
        const y = cubicInterpolate(x, points, sorted);
        const py = h - (y / 255) * h;
        if (px === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    for (let i = 0; i < points.length; i++) {
        const px = (points[i].x / 255) * w;
        const py = h - (points[i].y / 255) * h;
        ctx.fillStyle = colors[activeCurveChannel];
        ctx.beginPath();
        ctx.arc(px, py, i === 0 || i === points.length - 1 ? 5 : 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

// Y8: reset the curve that is currently being edited (RGB / R / G / B) back to its default shape.
function resetCurves() {
    const defaults = [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}];
    curvesData[activeCurveChannel] = defaults.map(function(p) { return { x: p.x, y: p.y }; });
    buildCurvesLUTs();
    const canvas = document.getElementById('curvesCanvas');
    if (canvas) drawCurves(canvas.getContext('2d'));
    applyAllEdits();
    saveToHistory();
}

function switchCurveChannel(channel, element) {
    const btns = document.querySelectorAll('.channel-btn');
    for (let i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    element.classList.add('active');
    activeCurveChannel = channel;
    const canvas = document.getElementById('curvesCanvas');
    const ctx = canvas.getContext('2d');
    drawCurves(ctx);
}
})(globalThis);
