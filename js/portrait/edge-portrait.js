// ============================================================
// edge-portrait.js  -  on-device portrait (depth of field) with automatic server fallback
// ============================================================
// Hybrid design: run() answers with a finished PNG Blob when the device can do the whole job locally, and with
// `null` whenever it cannot - the caller (js/portrait/portrait-mode.js) then sends the SAME request to the server
// exactly as before. Nothing about the server path changed.
//
// Local path:  decode -> 518x518 tensor -> depth in a Web Worker (onnxruntime-web, WASM/CPU) -> JS mask + bokeh
//              (js/portrait/portrait-math.js) -> PNG.
// null (= use the server) when ANY of these holds:
//   * no model URL configured, or the runtime lacks Cache API / crypto.subtle / WebAssembly / module workers
//   * skin smoothing requested (skin_smooth > 0): that stage is server-only
//   * the device reports too little memory (navigator.deviceMemory < EDGE_MODEL_CONFIG.minDeviceMemoryGB)
//   * the photo is larger than MAX_PIXELS
//   * the model download failed / was cancelled, or the runtime could not start (the card then offers Retry)
//   * the local run itself failed (the request is retried on the server; the error is only logged)
//
// Memory discipline: every temporary canvas is created through withCanvas(), which zeroes width/height in a
// finally block; the decoded ImageBitmap is closed in finally; the 99 MB model buffer is TRANSFERRED to the worker
// (the main thread never keeps a copy); the depth map of the last photo (1 MB) is the only thing cached.
//
// Public API (global YoEdgePortrait)
//   available()                      runtime + config + device checks (no network)
//   canHandle({skin, width, height}) available() and the request is one the local path supports
//   warmup()                         Promise: model downloaded + session started (also what the Retry button calls)
//   run(blob, {level, focusX, focusY, isStale}) -> Promise<Blob | null>
//   reset()                          terminates the worker and clears the session (tests, memory pressure)
// ============================================================
var YoEdgePortrait = (function () {
    'use strict';

    var NET_SIZE = 518;                       // Depth-Anything-V2 ViT patch 14 x 37 (same as PORTRAIT_INPUT_SIZE on the server)
    var MAX_PIXELS = 25000000;                // larger photos -> server
    var WORKER_URL = './js/workers/depth-worker.js';
    var INFER_TIMEOUT_MS = 120000;
    var INIT_TIMEOUT_MS = 120000;

    var worker = null;
    var sessionPromise = null;
    var nextId = 1;
    var pending = {};                         // id -> {resolve, reject, timer}
    var disabled = false;                     // set after a setup failure / user cancel; cleared by Retry
    var depthCache = null;                    // {blob, depth(Float32 NET_SIZE^2, 0..1), w, h}

    // ------------------------------------------------------------------ gates
    function deviceOk() {
        var min = YoEdgeModel.config().minDeviceMemoryGB;
        var mem = (typeof navigator !== 'undefined') ? navigator.deviceMemory : undefined;
        return !(min && typeof mem === 'number' && mem < min);
    }

    function available() {
        return !disabled && YoEdgeModel.isConfigured() && YoEdgeModel.isSupported() && deviceOk();
    }

    function canHandle(req) {
        req = req || {};
        if (!available()) return false;
        if ((req.skin | 0) > 0) return false;                                   // skin smoothing stays on the server
        if (req.width && req.height && req.width * req.height > MAX_PIXELS) return false;
        return true;
    }

    // ------------------------------------------------------------------ worker plumbing
    function rejectAll(err) {
        var ids = Object.keys(pending);
        for (var i = 0; i < ids.length; i++) {
            var p = pending[ids[i]];
            delete pending[ids[i]];
            clearTimeout(p.timer);
            p.reject(err);
        }
    }

    function teardown() {
        if (worker) {
            try { worker.onmessage = null; worker.onerror = null; worker.terminate(); } catch (e) { /* already gone */ }
        }
        worker = null;
        sessionPromise = null;
        rejectAll(new Error('worker stopped'));
    }

    function call(type, payload, transfer, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (!worker) { reject(new Error('worker is not running')); return; }
            var id = nextId++;
            var timer = setTimeout(function () {
                delete pending[id];
                reject(new Error(type + ' timed out'));
                teardown();                                                    // a hung WASM run cannot be cancelled: restart clean
            }, timeoutMs);
            pending[id] = { resolve: resolve, reject: reject, timer: timer };
            var message = { type: type, id: id };
            for (var k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) message[k] = payload[k]; }
            try { worker.postMessage(message, transfer || []); }
            catch (err) { clearTimeout(timer); delete pending[id]; reject(err); }
        });
    }

    function startWorker() {
        var w = new Worker(WORKER_URL, { type: 'module' });
        w.onmessage = function (event) {
            var m = event.data || {};
            var p = pending[m.id];
            if (!p) return;
            delete pending[m.id];
            clearTimeout(p.timer);
            if (m.type === 'error') p.reject(new Error(m.message || 'worker error')); else p.resolve(m);
        };
        w.onerror = function (event) {                                         // script failed to load (vendor/ort missing) or crashed
            var msg = (event && event.message) || 'worker failed to start';
            if (event && event.preventDefault) event.preventDefault();
            var err = new Error(msg); err.code = 'runtime';
            rejectAll(err);
            if (worker === w) { worker = null; sessionPromise = null; }
            try { w.terminate(); } catch (e) { /* already gone */ }
        };
        return w;
    }

    function getSession() {
        if (sessionPromise) return sessionPromise;
        sessionPromise = (async function () {
            var model = await YoEdgeModel.read();                                // fresh copy from the Cache API
            worker = startWorker();
            await call('init', { model: model }, [model], INIT_TIMEOUT_MS);      // transferred: no copy stays on the main thread
        })().catch(function (err) {
            teardown();
            var e = err instanceof Error ? err : new Error(String(err));
            if (!e.code) e.code = 'runtime';
            throw e;
        });
        return sessionPromise;
    }

    // ------------------------------------------------------------------ setup (download + start), shared by run() and Retry
    function setupFailed(err) {
        if (err && err.code === 'aborted') { disabled = true; YoEdgeModelUI.hide(); return; }     // user cancelled: no more prompts this session
        if (err && err.edgeModel && YoEdgeModel.state().status === 'failed') return;               // the download failed: YoEdgeModel state already drives the card (Retry)
        disabled = true;
        console.warn('[edge-portrait] on-device AI unavailable, using the server:', err && err.message);
        YoEdgeModelUI.showError('runtime');
    }

    async function warmup() {
        await YoEdgeModel.ensure();                                              // single flight; the card follows its progress
        if (!sessionPromise) YoEdgeModelUI.setPhase('starting');
        try { await getSession(); }
        finally { YoEdgeModelUI.setPhase('ready'); }
    }

    YoEdgeModelUI.onRetry(function () {
        disabled = false;
        teardown();
        warmup().catch(setupFailed);
    });

    // ------------------------------------------------------------------ canvases with guaranteed disposal
    function withCanvas(width, height, fn) {
        var canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        try {
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('2D canvas is not available');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            return fn(ctx, canvas);
        } finally {
            canvas.width = 0; canvas.height = 0;                                 // releases the backing store immediately
        }
    }

    function readPixels(bitmap, width, height) {
        return withCanvas(width, height, function (ctx) {
            ctx.drawImage(bitmap, 0, 0, width, height);
            return ctx.getImageData(0, 0, width, height).data;
        });
    }

    function scaledSize(w, h, longest) {
        var s = Math.min(1, longest / Math.max(w, h));
        return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
    }

    async function decode(blob) {
        if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
        var url = URL.createObjectURL(blob);
        try {
            var img = await new Promise(function (resolve, reject) {
                var el = new Image(); el.onload = function () { resolve(el); }; el.onerror = function () { reject(new Error('image decode failed')); }; el.src = url;
            });
            return { width: img.naturalWidth, height: img.naturalHeight, _img: img, close: function () {} };
        } finally { URL.revokeObjectURL(url); }                                  // blob URL is always released
    }
    function drawable(bitmap) { return bitmap._img || bitmap; }

    function stale(opts) { if (opts && typeof opts.isStale === 'function' && opts.isStale()) { var e = new Error('superseded'); e.name = 'AbortError'; throw e; } }

    // ------------------------------------------------------------------ the local pipeline
    async function estimateDepth(bitmap, blob) {
        if (depthCache && depthCache.blob === blob) return depthCache;           // slider / re-focus on the same photo: no inference
        var pixels = readPixels(drawable(bitmap), NET_SIZE, NET_SIZE);
        var tensor = YoPortraitMath.toTensor(pixels, NET_SIZE);
        var result = await call('infer', { input: tensor, size: NET_SIZE }, [tensor.buffer], INFER_TIMEOUT_MS);
        if (!result.depth || result.depth.length !== result.w * result.h) throw new Error('unexpected depth output');
        depthCache = { blob: blob, depth: YoPortraitMath.normalizeDepth(result.depth), w: result.w, h: result.h };
        return depthCache;
    }

    async function run(blob, opts) {
        opts = opts || {};
        var bitmap = null;
        try {
            bitmap = await decode(blob);
            var W = bitmap.width, H = bitmap.height;
            if (!canHandle({ skin: 0, width: W, height: H })) return null;
            stale(opts);

            try { await warmup(); } catch (err) { setupFailed(err); return null; }
            stale(opts);

            var depth = await estimateDepth(bitmap, blob);
            stale(opts);

            var M = YoPortraitMath;
            var fx = typeof opts.focusX === 'number' ? opts.focusX : 0.5, fy = typeof opts.focusY === 'number' ? opts.focusY : 0.5;
            var mSize = scaledSize(W, H, M.MASK_WORK), bSize = scaledSize(W, H, M.BOKEH_WORK);

            var guide = readPixels(drawable(bitmap), mSize.w, mSize.h);
            var depthWork = M.resizeBilinear(depth.depth, depth.w, depth.h, 1, mSize.w, mSize.h);
            var mask = M.computeMask(depthWork, guide, mSize.w, mSize.h, fx, fy);
            stale(opts);

            var small = readPixels(drawable(bitmap), bSize.w, bSize.h);
            var full = readPixels(drawable(bitmap), W, H);
            var out = M.composite(full, W, H, small, bSize.w, bSize.h, mask, mSize.w, mSize.h, opts.level);
            if (!out) return blob;                                               // aperture too small to show: the photo stays untouched
            stale(opts);

            return await withCanvasAsync(W, H, function (ctx, canvas) {
                ctx.putImageData(new ImageData(out, W, H), 0, 0);
                return canvasToBlob(canvas, 'image/png');                        // global helper (lossless, as on the server)
            });
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;                     // superseded: portrait-mode ignores it
            console.warn('[edge-portrait] local run failed, falling back to the server:', err && err.message);
            if (err && /worker|timed out|init/i.test(String(err.message))) teardown();
            return null;
        } finally {
            if (bitmap && bitmap.close) { try { bitmap.close(); } catch (e) { /* already closed */ } }
        }
    }

    // async variant: the canvas is zeroed only after the encode promise settles (success OR failure)
    function withCanvasAsync(width, height, fn) {
        var canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        var dispose = function () { canvas.width = 0; canvas.height = 0; };
        var ctx;
        try {
            ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('2D canvas is not available');
            return Promise.resolve(fn(ctx, canvas)).then(function (v) { dispose(); return v; }, function (e) { dispose(); throw e; });
        } catch (err) { dispose(); return Promise.reject(err); }
    }

    function reset() { teardown(); depthCache = null; disabled = false; }

    return { available: available, canHandle: canHandle, warmup: warmup, run: run, reset: reset, _state: function () { return { disabled: disabled, hasWorker: !!worker }; } };
})();
