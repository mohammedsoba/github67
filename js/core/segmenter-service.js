// ============================================================
// segmenter-service.js  (V20)  -  R17 + R18
// ============================================================
// ONE person-segmentation service for the whole app (AI Mask, Background Removal, anything later).
//
// R17  Requests are queued: exactly one segmentation runs at a time and every caller gets ITS OWN
//      result through a Promise. The old design swapped the global window.onPortraitSegmentationResults
//      handler per tool, so two tools running together could receive each other's masks.
//
// R18  Same-origin assets only (no third-party CDN, ever):
//        1. The code, the WASM files and the model are loaded from ./vendor/mediapipe/... - served by the backend
//           from its own origin, or bundled in the Cordova app (see vendor/mediapipe/README.md; filled and
//           hash-verified by scripts/fetch_mediapipe_assets.py, which the Docker build runs).
//        2. every step has a timeout and fails with a SegmenterError carrying a plain-language,
//           user-facing message (code: offline | load-timeout | load-failed | segment-timeout |
//           segment-failed).
//
// Public API:  YoSegmenter.load() -> Promise<void>
//              YoSegmenter.segment(canvasOrImage) -> Promise<HTMLCanvasElement>
//                  (white RGBA mask: alpha = person confidence, any size)
//              YoSegmenter.status() -> 'idle' | 'loading' | 'ready' | 'failed'
// ============================================================
var YoSegmenter = (function () {
    'use strict';

    // Pinned release of @mediapipe/tasks-vision whose files live in ./vendor/mediapipe (keep equal to VERSION in
    // scripts/fetch_mediapipe_assets.py - a test checks it). Informational: nothing is requested by version at run time.
    var VERSION = '0.10.14';
    var CONFIG = {
        version: VERSION,
        localBase: './vendor/mediapipe/',
        localLoadTimeoutMs: 60000,      // same-origin ~15 MB (module + WASM + model) on a slow phone connection
        segmentTimeoutMs: 30000
    };

    var MESSAGES = {
        'offline':         'You’re offline. The AI cut-out model isn’t on this device yet — connect once to download it, then try again.',
        'load-timeout':    'The AI model is taking too long to download. Check your connection and try again.',
        'load-failed':     'Couldn’t load the AI model. Check your connection and try again.',
        'segment-timeout': 'The AI analysis took too long. Please try again.',
        'segment-failed':  'Couldn’t analyze the photo. Please try again.'
    };

    var MESSAGE_KEYS = { 'offline': 'segOffline', 'load-timeout': 'segLoadTimeout', 'load-failed': 'segLoadFailed',
                         'segment-timeout': 'segTimeout', 'segment-failed': 'segFailed' };
    // Plain-language, localised (EN/AR) message; falls back to the English text above.
    function messageFor(code) {
        var fallback = MESSAGES[code] || MESSAGES['segment-failed'];
        try {
            if (typeof window !== 'undefined' && typeof window.t === 'function') {
                var key = MESSAGE_KEYS[code] || 'segFailed', v = window.t(key);
                if (v && v !== key) return v;
            }
        } catch (e) {}
        return fallback;
    }

    function SegmenterError(code, detail) {
        var e = new Error(messageFor(code));
        e.name = 'SegmenterError';
        e.code = code;
        e.detail = detail ? String(detail && detail.message || detail) : '';
        return e;
    }

    var _state = 'idle';
    var _segmenter = null;
    var _loadPromise = null;
    var _tail = Promise.resolve();          // serial queue for segment()

    function isOffline() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    function withTimeout(promise, ms, code) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var t = setTimeout(function () { if (!done) { done = true; reject(SegmenterError(code)); } }, ms);
            promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                         function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
        });
    }

    // Create the ImageSegmenter from one asset set {vision, wasm, model}.
    function createFromSet(set) {
        return import(/* @vite-ignore */ set.vision).then(function (vision) {
            return vision.FilesetResolver.forVisionTasks(set.wasm).then(function (fileset) {
                // GPU delegate is unstable on phones: CPU (WASM) there
                var primary = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 'CPU' : 'GPU';
                var make = function (delegate) {
                    return vision.ImageSegmenter.createFromOptions(fileset, {
                        baseOptions: { modelAssetPath: set.model, delegate: delegate },
                        runningMode: 'IMAGE',
                        outputCategoryMask: false,
                        outputConfidenceMasks: true
                    });
                };
                return make(primary).catch(function () { return make('CPU'); });
            });
        });
    }

    function load() {
        if (_state === 'ready') return Promise.resolve();
        if (_loadPromise) return _loadPromise;
        _state = 'loading';

        var local = {
            vision: CONFIG.localBase + 'vision_bundle.mjs',
            wasm:   CONFIG.localBase + 'wasm',
            model:  CONFIG.localBase + 'selfie_multiclass_256x256.tflite'
        };

        _loadPromise = withTimeout(createFromSet(local), CONFIG.localLoadTimeoutMs, 'load-timeout')
            .catch(function (localErr) {
                // There is NO fallback host: a failure here is "offline" (assets not cached on this device yet) or a plain load failure.
                if (localErr && localErr.name === 'SegmenterError') throw localErr;
                throw SegmenterError(isOffline() ? 'offline' : 'load-failed', localErr);
            })
            .then(function (seg) {
                _segmenter = seg;
                _state = 'ready';
                try { portraitModelLoaded = true; } catch (e) {}      // legacy flag (state.js)
            })
            .catch(function (err) {
                _state = 'failed';
                _loadPromise = null;                                   // allow a clean retry
                console.error('[segmenter] load failed:', err);
                if (err && err.name === 'SegmenterError') throw err;
                throw SegmenterError(isOffline() ? 'offline' : 'load-failed', err);
            });
        return _loadPromise;
    }

    // Selfie Multiclass confidence masks: [0] = background. Foreground alpha = 1 - bg with a gentle S-curve.
    function buildMaskCanvas(result) {
        var masks = result.confidenceMasks;
        var bg = masks[0];
        var mw = bg.width, mh = bg.height;
        var bgData = bg.getAsFloat32Array();
        var cv = document.createElement('canvas');
        cv.width = mw; cv.height = mh;
        var cx = cv.getContext('2d');
        var id = cx.createImageData(mw, mh);
        var px = id.data;
        for (var i = 0; i < bgData.length; i++) {
            var fg = 1 - bgData[i];
            fg = fg < 0.5 ? 2 * fg * fg : 1 - Math.pow(-2 * fg + 2, 2) / 2;
            var a = Math.max(0, Math.min(255, Math.round(fg * 255)));
            var j = i * 4;
            px[j] = 255; px[j + 1] = 255; px[j + 2] = 255; px[j + 3] = a;
        }
        cx.putImageData(id, 0, 0);
        for (var k = 0; k < masks.length; k++) { try { masks[k].close(); } catch (e) {} }
        return cv;
    }

    function runOne(source) {
        return load().then(function () {
            var seg = _segmenter;
            return withTimeout(new Promise(function (resolve, reject) {
                try {
                    // MediaPipe calls the callback synchronously inside segment(); the result is ours alone.
                    seg.segment(source, function (result) {
                        try { resolve(buildMaskCanvas(result)); } catch (e) { reject(SegmenterError('segment-failed', e)); }
                    });
                } catch (e) { reject(SegmenterError('segment-failed', e)); }
            }), CONFIG.segmentTimeoutMs, 'segment-timeout');
        });
    }

    // Queue: one job at a time; a failed job never blocks the jobs behind it.
    function segment(source) {
        var job = _tail.then(function () { return runOne(source); });
        _tail = job.then(function () {}, function () {});
        return job;
    }

    return {
        load: load,
        segment: segment,
        status: function () { return _state; },
        isOffline: isOffline,
        config: CONFIG,
        SegmenterError: SegmenterError,
        // test hook (Node tests inject a fake segmenter instead of downloading anything)
        _setSegmenterForTests: function (seg) { _segmenter = seg; _state = seg ? 'ready' : 'idle'; _loadPromise = null; }
    };
})();
