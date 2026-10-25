// ============================================================
// render-pipeline.js  (V19)
// ============================================================
// ONE render path shared by the live preview, the export and the AI tools:
//
//   YoFilterMath  CSS filter chain -> colour-matrix steps (GPU shader + CPU fallback)
//   YoCompat      ctx.filter feature detection + non-filter fallbacks (Safari / iOS WKWebView)
//   YoPipeline    edit-state helpers (needsPixelPass), alpha handling, preview/export rendering,
//                 full-resolution "bake" for AI tools, commit of a processed canvas as the new
//                 working image.
//
// Loaded before webgl-renderer.js. Everything that depends on other modules (sliders, curvesLUT,
// colorMixData, GPU, effects.js ...) is resolved at call time, so script order is not critical.
// ============================================================

// ------------------------------------------------------------
// YoFilterMath: CSS filter functions as 3x3 colour matrices (W3C Filter Effects spec)
// ------------------------------------------------------------
var YoFilterMath = (function () {
    var MAX_STEPS = 12;

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // "brightness(110%) hue-rotate(-5deg) blur(2px)" -> [{name, v}, ...]  (hue in degrees, % -> fraction)
    function parseOps(str) {
        var ops = [];
        if (!str || str === 'none') return ops;
        var re = /([a-z-]+)\(\s*([^)]*?)\s*\)/gi, m;
        while ((m = re.exec(str))) {
            var name = m[1].toLowerCase(), raw = m[2].trim(), v = parseFloat(raw);
            if (isNaN(v)) continue;
            if (name === 'hue-rotate') {
                if (/rad$/.test(raw)) v = v * 180 / Math.PI;
                else if (/turn$/.test(raw)) v = v * 360;
                else if (/grad$/.test(raw)) v = v * 0.9;
            } else if (name !== 'blur' && /%$/.test(raw)) {
                v = v / 100;
            }
            ops.push({ name: name, v: v });
        }
        return ops;
    }

    // -> { m: [9 numbers, row-major], o: [3 numbers, 0..1 units] } or null (no colour effect)
    function opToStep(op) {
        var v = op.v, a, s, c, sn, b;
        switch (op.name) {
            case 'brightness':
                v = Math.max(0, v);
                return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0, 0, 0] };
            case 'contrast':
                v = Math.max(0, v); b = 0.5 - 0.5 * v;
                return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [b, b, b] };
            case 'saturate':
                s = Math.max(0, v);
                return { m: [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
                             0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
                             0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s], o: [0, 0, 0] };
            case 'grayscale':
                a = 1 - clamp01(v);
                return { m: [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
                             0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
                             0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a], o: [0, 0, 0] };
            case 'sepia':
                a = 1 - clamp01(v);
                return { m: [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
                             0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
                             0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a], o: [0, 0, 0] };
            case 'hue-rotate':
                s = v * Math.PI / 180; c = Math.cos(s); sn = Math.sin(s);
                return { m: [0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928,
                             0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.140, 0.072 - c * 0.072 - sn * 0.283,
                             0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072],
                         o: [0, 0, 0] };
            case 'invert':
                v = clamp01(v);
                return { m: [1 - 2 * v, 0, 0, 0, 1 - 2 * v, 0, 0, 0, 1 - 2 * v], o: [v, v, v] };
            default:
                return null;     // blur / opacity / drop-shadow: no per-pixel colour matrix
        }
    }

    function cssFilterToSteps(str) {
        var ops = parseOps(str), steps = [];
        for (var i = 0; i < ops.length && steps.length < MAX_STEPS; i++) {
            var st = opToStep(ops[i]);
            if (st) steps.push(st);
        }
        return steps;
    }

    // CPU: run the steps over RGBA bytes (clamped between steps, alpha untouched)
    function applySteps(data, steps) {
        if (!steps || !steps.length) return;
        for (var k = 0; k < steps.length; k++) {
            var m = steps[k].m, o = steps[k].o;
            var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
            var o0 = o[0] * 255, o1 = o[1] * 255, o2 = o[2] * 255;
            for (var i = 0; i < data.length; i += 4) {
                var r = data[i], g = data[i + 1], b = data[i + 2];
                var nr = m0 * r + m1 * g + m2 * b + o0;
                var ng = m3 * r + m4 * g + m5 * b + o1;
                var nb = m6 * r + m7 * g + m8 * b + o2;
                data[i]     = nr < 0 ? 0 : (nr > 255 ? 255 : nr);
                data[i + 1] = ng < 0 ? 0 : (ng > 255 ? 255 : ng);
                data[i + 2] = nb < 0 ? 0 : (nb > 255 ? 255 : nb);
            }
        }
    }

    return { MAX_STEPS: MAX_STEPS, parseOps: parseOps, opToStep: opToStep,
             cssFilterToSteps: cssFilterToSteps, applySteps: applySteps };
})();

// ------------------------------------------------------------
// YoCompat: canvas ctx.filter detection + fallbacks
// ------------------------------------------------------------
var YoCompat = (function () {
    var _supported = null;

    // True only when ctx.filter really changes pixels (Safari / WKWebView may lack it or ignore it).
    function supportsCtxFilter() {
        if (_supported !== null) return _supported;
        _supported = false;
        try {
            var c = document.createElement('canvas');
            c.width = 1; c.height = 1;
            var x = c.getContext('2d');
            if (x && 'filter' in x) {
                x.filter = 'grayscale(100%)';
                x.fillStyle = '#ff0000';
                x.fillRect(0, 0, 1, 1);
                var d = x.getImageData(0, 0, 1, 1).data;
                _supported = (d[0] !== 255 || d[1] !== 0);
            }
        } catch (e) { _supported = false; }
        return _supported;
    }

    // Filter-free blur: bilinear down- then up-scale. Good enough for feathering masks.
    function blurFallback(src, radius) {
        var w = src.width, h = src.height;
        var f = Math.max(1.5, radius * 1.2);
        var sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
        var small = document.createElement('canvas');
        small.width = sw; small.height = sh;
        var sx = small.getContext('2d');
        sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high';
        sx.drawImage(src, 0, 0, sw, sh);
        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ox = out.getContext('2d');
        ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
        ox.drawImage(small, 0, 0, w, h);
        small.width = 0; small.height = 0;
        return out;
    }

    // Draw `source` (w x h) through a CSS filter string. Uses ctx.filter where it works, otherwise
    // colour matrices (CPU) + the blur fallback above.
    function drawWithFilter(ctx, source, w, h, filterStr) {
        if (!filterStr || filterStr === 'none') { ctx.drawImage(source, 0, 0, w, h); return; }
        if (supportsCtxFilter()) {
            ctx.filter = filterStr;
            ctx.drawImage(source, 0, 0, w, h);
            ctx.filter = 'none';
            return;
        }
        var ops = YoFilterMath.parseOps(filterStr);
        var work = document.createElement('canvas');
        work.width = w; work.height = h;
        var wctx = work.getContext('2d');
        wctx.drawImage(source, 0, 0, w, h);
        var pending = [];
        var flush = function () {
            if (!pending.length) return;
            var id = wctx.getImageData(0, 0, w, h);
            YoFilterMath.applySteps(id.data, pending);
            wctx.putImageData(id, 0, 0);
            pending = [];
        };
        for (var i = 0; i < ops.length; i++) {
            if (ops[i].name === 'blur') {
                flush();
                var blurred = blurFallback(work, ops[i].v);
                wctx.clearRect(0, 0, w, h);
                wctx.drawImage(blurred, 0, 0);
                blurred.width = 0; blurred.height = 0;
            } else {
                var st = YoFilterMath.opToStep(ops[i]);
                if (st) pending.push(st);
            }
        }
        flush();
        ctx.drawImage(work, 0, 0);
        work.width = 0; work.height = 0;
    }

    // Convenience: draw with a Gaussian-ish blur of `px` pixels.
    function drawBlurred(ctx, source, w, h, px) {
        drawWithFilter(ctx, source, w, h, 'blur(' + px + 'px)');
    }

    return { supportsCtxFilter: supportsCtxFilter, drawWithFilter: drawWithFilter,
             drawBlurred: drawBlurred, blurFallback: blurFallback };
})();

// ------------------------------------------------------------
// YoPipeline
// ------------------------------------------------------------
var YoPipeline = (function () {
    var PREVIEW_DIM = 1200;

    // ---------- "is anything active?" (single source of truth for preview AND export) ----------
    var _defaultLut = null;
    function defaultCurveLut() {
        if (_defaultLut) return _defaultLut;
        var pts = [{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: 128, y: 128 }, { x: 192, y: 192 }, { x: 255, y: 255 }];
        var lut = new Uint8Array(256);
        for (var i = 0; i < 256; i++) {
            lut[i] = (typeof cubicInterpolate === 'function') ? Math.round(cubicInterpolate(i, pts)) : i;
        }
        _defaultLut = lut;
        return lut;
    }

    // True when ANY of the four curve LUTs (rgb / red / green / blue) differs from the untouched
    // default curve at ANY of the 256 entries. (The default Catmull-Rom curve is not exactly the
    // identity between its control points, so "untouched" is compared against the default LUT.)
    function curvesActive() {
        if (typeof curvesLUT === 'undefined' || !curvesLUT) return false;
        var base = defaultCurveLut(), chans = ['rgb', 'red', 'green', 'blue'];
        for (var c = 0; c < chans.length; c++) {
            var l = curvesLUT[chans[c]];
            if (!l) continue;
            for (var i = 0; i < 256; i++) if (l[i] !== base[i]) return true;
        }
        return false;
    }

    function colorMixActive() {
        if (typeof colorMixData === 'undefined' || !colorMixData) return false;
        for (var i = 0; i < colorMixData.length; i++) {
            var d = colorMixData[i];
            if (d.hue !== 0 || d.sat !== 0 || d.lum !== 0) return true;
        }
        return false;
    }

    // Anything that needs the per-pixel pass (shader / CPU) rather than a plain CSS filter.
    function needsPixelPass() {
        var s = sliders;
        return s.sharp > 0 || s.clarity > 0 || s.vignette !== 0 || s.grain > 0 ||
               s.shadows !== 0 || s.whites !== 0 || s.blacks !== 0 || s.exposure !== 0 ||
               s.vibrance !== 0 || s.warmth !== 0 || s.tint !== 0 ||
               curvesActive() || colorMixActive();
    }

    function hasFilterChain() {
        return (typeof buildCSSFilter === 'function') && buildCSSFilter() !== '';
    }

    // Any edit at all (pixel pass or CSS filter chain) that must be baked into exported pixels.
    function needsBake() { return needsPixelPass() || hasFilterChain(); }

    // Stable string describing the colour edits (cache key for baked copies).
    function editSignature() {
        try { return JSON.stringify([sliders, chosenPreset, colorMixData, curvesData]); } catch (e) { return String(Date.now()); }
    }

    // ---------- grain seed (session based) ----------
    // One integer for the whole editing session of a photo: constant while sliders are dragged (no flicker)
    // and shared by GPU preview, GPU export and the CPU fallback (identical pattern everywhere). It is
    // re-rolled ONLY when a new image is uploaded (file-handler.js). 0..255 keeps the shader's sin()
    // argument small enough to stay precise on mobile GPUs.
    var _grainSeed = 0;
    function grainSeed() { return _grainSeed; }
    function rerollGrainSeed() {
        _grainSeed = Math.floor(Math.random() * 256);
        return _grainSeed;
    }

    // Reused Color Mix upload buffer: currentEditState() runs on every drag frame, so it must not allocate.
    // Safe to share because every consumer (GPU.render / cpuApply) reads it synchronously.
    var _mixBuf = new Float32Array(24);

    // Everything the shader / CPU pass needs, captured at one instant.
    function currentEditState() {
        var s = {}, k;
        for (k in sliders) if (Object.prototype.hasOwnProperty.call(sliders, k)) s[k] = sliders[k];
        var mix = _mixBuf;
        mix.fill(0);
        if (typeof colorMixData !== 'undefined' && colorMixData) {
            for (var i = 0; i < 8; i++) {
                var d = colorMixData[i] || { hue: 0, sat: 0, lum: 0 };
                mix[i * 3] = d.hue || 0; mix[i * 3 + 1] = d.sat || 0; mix[i * 3 + 2] = d.lum || 0;
            }
        }
        return {
            sliders: s,
            filterSteps: YoFilterMath.cssFilterToSteps((typeof buildCSSFilter === 'function') ? buildCSSFilter() : ''),
            mix: mix,
            grainSeed: _grainSeed,
            useLut: curvesActive(),
            lut: (typeof curvesLUT !== 'undefined' && curvesLUT) ? curvesLUT : {}
        };
    }

    // ---------- alpha helpers ----------
    function _scanAlpha(drawable, w, h) {
        if (!w || !h) return false;
        var sc = Math.min(1, 384 / Math.max(w, h));
        var sw = Math.max(1, Math.round(w * sc)), sh = Math.max(1, Math.round(h * sc));
        var c = document.createElement('canvas');
        c.width = sw; c.height = sh;
        var x = c.getContext('2d', { willReadFrequently: true });
        x.imageSmoothingEnabled = true;
        x.drawImage(drawable, 0, 0, sw, sh);
        var d = x.getImageData(0, 0, sw, sh).data, found = false;
        for (var i = 3; i < d.length; i += 4) { if (d[i] < 250) { found = true; break; } }
        c.width = 0; c.height = 0;
        return found;
    }

    function canvasHasAlpha(canvas) {
        try { return _scanAlpha(canvas, canvas.width, canvas.height); } catch (e) { return false; }
    }

    // Cached on the image element: does this picture contain transparent pixels?
    function imageHasAlpha(img) {
        if (!img) return false;
        if (img.__yfAlpha !== undefined) return img.__yfAlpha;
        var res = false;
        try {
            var type = (typeof getImageUrlType === 'function') ? getImageUrlType(img.src) : '';
            if (type === 'image/jpeg' || /^data:image\/jpe?g/i.test(img.src || '')) res = false;
            else res = _scanAlpha(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
        } catch (e) { res = false; }
        try { img.__yfAlpha = res; } catch (e) {}
        return res;
    }

    // V24/G9 - LOSSLESS WORKING BUFFER. Every intermediate image the editor keeps (upload, crop, AI tools, bakes,
    // portrait) is PNG, whether or not it has transparency: re-encoding a decoded JPEG at every step (0.92, 0.95, 0.95, ...)
    // lost quality with each edit. Lossy encoding now happens exactly ONCE, in doExport() (modals-export.js) - and for
    // the display-only preview below. The arguments are ignored; they stay so existing callers keep working.
    function encodeSpec(/* hasAlpha, jpegQuality */) {
        return { mime: 'image/png', quality: undefined };
    }

    // Encoding used for the on-screen preview image ONLY (never read back as pixels: originalImage is untouched).
    // Lossy on purpose - it is re-encoded on every settle and must stay fast. WebP keeps alpha; Safari falls back to PNG.
    function previewEncoding(img) {
        return imageHasAlpha(img) ? { mime: 'image/webp', quality: 0.92 } : { mime: 'image/jpeg', quality: 0.92 };
    }

    // ---------- preview ----------
    function previewSize(img) {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w > PREVIEW_DIM || h > PREVIEW_DIM) {
            var r = Math.min(PREVIEW_DIM / w, PREVIEW_DIM / h);
            w = Math.round(w * r); h = Math.round(h * r);
        }
        return { w: Math.max(1, w), h: Math.max(1, h) };
    }

    // Keep previewCanvas matched to the working image (every commit path, incl. AI tools).
    function syncPreviewCanvas() {
        if (!originalImage || !previewCanvas) return null;
        var d = previewSize(originalImage);
        if (previewCanvas.width !== d.w) previewCanvas.width = d.w;
        if (previewCanvas.height !== d.h) previewCanvas.height = d.h;
        return d;
    }

    // Downscaled, UNFILTERED copy of the working image: uploaded to the GPU once per image.
    var _prev = { key: null, canvas: null };
    function getPreviewSource(w, h) {
        var key = originalImage.src + '|' + w + 'x' + h;
        if (_prev.key === key && _prev.canvas) return { canvas: _prev.canvas, key: key };
        if (!_prev.canvas) _prev.canvas = document.createElement('canvas');
        _prev.canvas.width = w; _prev.canvas.height = h;
        var x = _prev.canvas.getContext('2d');
        x.clearRect(0, 0, w, h);                         // never leave pixels of a previous image behind
        x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
        x.drawImage(originalImage, 0, 0, w, h);
        _prev.key = key;
        return { canvas: _prev.canvas, key: key };
    }

    // Order matches the shader exactly: filters -> sharpness -> exposure -> shadows/whites/blacks ->
    // vibrance -> warmth -> tint -> colour mix -> clarity -> vignette -> grain -> curves.
    function cpuApply(data, w, h, st) {
        var s = st.sliders;
        YoFilterMath.applySteps(data, st.filterSteps);
        if (s.sharp > 0) applyFastSharpness(data, w, h, s.sharp);
        if (s.exposure !== 0) applyExposure(data, w, h, s.exposure);
        if (s.shadows !== 0) applyShadows(data, w, h, s.shadows);
        if (s.whites !== 0) applyWhites(data, w, h, s.whites);
        if (s.blacks !== 0) applyBlacks(data, w, h, s.blacks);
        if (s.vibrance !== 0) applyVibrance(data, w, h, s.vibrance);
        if (s.warmth !== 0) applyWarmth(data, w, h, s.warmth);
        if (s.tint !== 0) applyTint(data, w, h, s.tint);
        applyColorMix(data, w, h);
        if (s.clarity > 0) applyFastClarity(data, s.clarity);
        if (s.vignette !== 0) applyFastVignette(data, w, h, s.vignette);
        if (s.grain > 0) applyFastGrain(data, w, h, s.grain, st.grainSeed || 0);
        if (st.useLut) {
            var L = st.lut, rgb = L.rgb, rL = L.red, gL = L.green, bL = L.blue;
            if (rgb && rL && gL && bL) {
                for (var j = 0; j < data.length; j += 4) {
                    data[j]     = rgb[rL[data[j]]];
                    data[j + 1] = rgb[gL[data[j + 1]]];
                    data[j + 2] = rgb[bL[data[j + 2]]];
                }
            }
        }
    }

    // Draw the preview (w x h) into ctx: GPU first, CPU fallback. Alpha preserved.
    function renderPreview(ctx, w, h) {
        var src = getPreviewSource(w, h);
        var st = currentEditState();
        var out = null;
        try { out = GPU.render(src.canvas, { key: src.key, state: st }); } catch (e) { console.warn('GPU render failed', e); out = null; }
        ctx.clearRect(0, 0, w, h);
        if (out) { ctx.drawImage(out, 0, 0, w, h); return 'gpu'; }
        ctx.drawImage(src.canvas, 0, 0, w, h);
        var id = ctx.getImageData(0, 0, w, h);
        cpuApply(id.data, w, h, st);
        ctx.putImageData(id, 0, 0);
        return 'cpu';
    }

    // Drag fast path: draw the GPU result straight into `ctx` (the live canvas) - NO CPU fallback, NO image
    // encode. Returns true when the GPU produced the frame, false when the caller must use the full path.
    function renderGpuFrame(ctx, w, h) {
        if (!originalImage || !ctx) return false;
        var src = getPreviewSource(w, h);
        var out = null;
        try { out = GPU.render(src.canvas, { key: src.key, state: currentEditState() }); }
        catch (e) { console.warn('GPU live render failed', e); out = null; }
        if (!out) return false;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(out, 0, 0, w, h);
        return true;
    }

    // ---------- export / AI bake ----------
    // Render `img` with ALL colour edits at w x h into `target` (same engine as the preview).
    function renderEditedCanvas(img, w, h, target) {
        target.width = w; target.height = h;
        var ctx = target.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        if (!needsBake()) { ctx.drawImage(img, 0, 0, w, h); return target; }

        var st = currentEditState();
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        var out = null;
        try {
            if (GPU.isAvailable() && Math.max(iw, ih) <= GPU.maxTextureSize()) {
                out = GPU.render(img, { key: null, state: st, width: iw, height: ih });
            }
        } catch (e) { console.warn('GPU export render failed, using CPU', e); out = null; }

        if (out) {
            ctx.drawImage(out, 0, 0, w, h);
            GPU.release();
            return target;
        }
        ctx.drawImage(img, 0, 0, w, h);
        var id = ctx.getImageData(0, 0, w, h);
        cpuApply(id.data, w, h, st);
        ctx.putImageData(id, 0, 0);
        return target;
    }

    // Promise<url>: the working image at FULL working resolution with every colour edit baked in.
    // With no edits it is simply originalImage.src. A freshly created blob must be handed to
    // releaseTransientImageUrl() by the caller (that call is a no-op for URLs the editor still owns).
    function getEditedWorkingSrc() {
        if (!originalImage) return Promise.resolve('');
        if (!needsBake()) return Promise.resolve(originalImage.src);
        var iw = originalImage.naturalWidth || originalImage.width;
        var ih = originalImage.naturalHeight || originalImage.height;
        var c = document.createElement('canvas');
        try { renderEditedCanvas(originalImage, iw, ih, c); } catch (e) {
            console.warn('bake failed', e);
            return Promise.resolve(originalImage.src);
        }
        var spec = encodeSpec(imageHasAlpha(originalImage));
        return canvasToBlobUrl(c, spec.mime, spec.quality).then(function (res) {
            c.width = 0; c.height = 0;
            return res.url;
        }, function () {
            c.width = 0; c.height = 0;
            return originalImage.src;
        });
    }

    // ---------- the ONE "make this the working image" routine (V24/G8) ----------
    // Crop, background removal, portrait enhance, AI masks, Magic Eraser and Portrait mode each carried their own
    // copy, and the copies disagreed (alpha cache, preview canvas, which edits were cleared, whether the Frame and the
    // overlays survived). They all end here now.
    //
    // commitImageUrl(url, opts): `url` is an already-encoded, registered blob: URL.
    //   opts.hasAlpha        true / false when the caller knows it (fills the alpha cache); undefined = detected lazily
    //   opts.keepColorEdits  true: colour edits stay on top of the new pixels (crop, portrait); default: they were
    //                        baked into the pixels, so they are cleared (AI tools)
    //   opts.resetImageBox   true: drop the inline size / aspect / fit left on #mainImg by a previous crop (crop, portrait)
    //   opts.beforeHistory   function(next): last step before the history entry is written (crop: compare-crop state;
    //                        portrait: replace its own previous entry)
    // Frame, overlays and the crop ratio are never touched. Resolves with the new Image. When the URL cannot be
    // decoded it is revoked (unless history already owns it) and the promise rejects.
    function commitImageUrl(url, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var next = new Image();
            next.onload = function () {
                if (opts.hasAlpha !== undefined) { try { next.__yfAlpha = !!opts.hasAlpha; } catch (e) {} }
                originalImage = next;
                if (!opts.keepColorEdits && typeof resetColorEdits === 'function') resetColorEdits();
                var main = document.getElementById('mainImg');
                if (main) {
                    main.src = url;
                    main.className = 'main-img active';
                    main.style.filter = 'none';
                    if (opts.resetImageBox) {
                        main.style.width = 'auto';
                        main.style.height = 'auto';
                        main.style.aspectRatio = 'auto';
                        main.style.objectFit = 'contain';
                    }
                }
                syncPreviewCanvas();
                try {
                    if (typeof fitImageToWorkspace === 'function') fitImageToWorkspace();
                    if (typeof overlayManager !== 'undefined' && overlayManager && overlayManager.resizeCanvas) overlayManager.resizeCanvas();
                } catch (e) {}
                if (typeof opts.beforeHistory === 'function') opts.beforeHistory(next);
                if (opts.keepColorEdits && typeof applyAllEdits === 'function') applyAllEdits();
                if (typeof saveToHistory === 'function') saveToHistory();
                resolve(next);
            };
            next.onerror = function () {
                if (typeof releaseTransientImageUrl === 'function') releaseTransientImageUrl(url);
                reject(new Error('Result ready, but could not sync it to the main editor'));
            };
            next.src = url;
        });
    }

    // Canvas variant: lossless-encode the canvas (encodeSpec) into a registered blob: URL, then commitImageUrl().
    // opts.hasAlpha defaults to a scan of the canvas; pass it when it is known to skip the scan.
    // opts.releaseCanvas: free the canvas backing store as soon as it is encoded (before the new image decodes).
    function commitCanvas(canvas, opts) {
        opts = Object.assign({}, opts || {});
        if (opts.hasAlpha === undefined) opts.hasAlpha = canvasHasAlpha(canvas);
        var spec = encodeSpec();
        return canvasToBlobUrl(canvas, spec.mime, spec.quality).then(function (res) {
            if (opts.releaseCanvas) { canvas.width = 0; canvas.height = 0; }
            return commitImageUrl(res.url, opts);
        }, function (err) {
            if (opts.releaseCanvas) { canvas.width = 0; canvas.height = 0; }
            throw err;
        });
    }

    // Kept for existing callers (ai-mask.js): AI result canvas -> working image, colour edits cleared.
    function commitCanvasAsOriginal(canvas) {
        return commitCanvas(canvas);
    }

    return {
        PREVIEW_DIM: PREVIEW_DIM,
        curvesActive: curvesActive, colorMixActive: colorMixActive,
        needsPixelPass: needsPixelPass, hasFilterChain: hasFilterChain, needsBake: needsBake,
        editSignature: editSignature, currentEditState: currentEditState,
        canvasHasAlpha: canvasHasAlpha, imageHasAlpha: imageHasAlpha,
        encodeSpec: encodeSpec, previewEncoding: previewEncoding,
        previewSize: previewSize, syncPreviewCanvas: syncPreviewCanvas,
        cpuApply: cpuApply, renderPreview: renderPreview, renderGpuFrame: renderGpuFrame,
        grainSeed: grainSeed, rerollGrainSeed: rerollGrainSeed,
        renderEditedCanvas: renderEditedCanvas,
        getEditedWorkingSrc: getEditedWorkingSrc,
        commitImageUrl: commitImageUrl, commitCanvas: commitCanvas,
        commitCanvasAsOriginal: commitCanvasAsOriginal
    };
})();
