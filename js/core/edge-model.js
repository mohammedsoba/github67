// ============================================================
// edge-model.js  -  On-demand download + local cache of the portrait ONNX model
// ============================================================
// The ~99 MB Depth-Anything-V2-Small model is NOT shipped inside the APK. On the first on-device portrait run it
// is downloaded ONCE from EDGE_MODEL_URL (app-config.js), verified (exact size + SHA-256) and stored in the Cache
// API (origin storage that survives restarts). Later runs read it from there - no network.
//
// Guarantees
//   * single flight   ensure() while a download runs returns the SAME promise: a second tap never starts a second
//                     download, and subscribers all see the same progress.
//   * fail closed     a wrong size or hash is never cached and never executed (the partial buffer is dropped).
//   * clean errors    every failure is an EdgeModelError with a stable `code` that the UI maps to EN/AR text.
//   * retry           after a failure the state is 'failed'; calling ensure() again simply retries from scratch.
//
// Public API (global YoEdgeModel)
//   isConfigured()      true when a model URL + SHA-256 + size are set
//   isSupported()       true when this runtime can do it at all (Cache API, crypto.subtle, WebAssembly, fetch streams)
//   isCached()          Promise<boolean>
//   ensure()            Promise<void>   downloads when missing; resolves when the verified model is in the cache
//   read()              Promise<ArrayBuffer>   the cached model bytes (fresh copy; caller may transfer it)
//   cancel()            aborts a running download
//   purge()             deletes the cached model (e.g. after the runtime rejected it)
//   subscribe(fn)       fn({status, loaded, total, percent, error}) on every change; returns unsubscribe()
//   state()             snapshot of the same object
// ============================================================
var YoEdgeModel = (function () {
    'use strict';

    var CACHE_NAME = 'yofilter-edge-models-v1';
    var PROGRESS_MIN_MS = 120;                 // UI update throttle

    var current = { status: 'idle', loaded: 0, total: 0, percent: 0, error: null };
    var inflight = null;
    var controller = null;
    var listeners = [];

    // ------------------------------------------------------------------ errors
    // codes: not-configured | unsupported | offline | network | http | size | hash | quota | aborted | missing
    function EdgeModelError(code, message, status) {
        var e = new Error(message || code);
        e.name = 'EdgeModelError';
        e.code = code;
        if (status) e.status = status;
        e.edgeModel = true;
        return e;
    }

    function cfg() {
        var c = (typeof EDGE_MODEL_CONFIG !== 'undefined' && EDGE_MODEL_CONFIG) || {};
        return {
            url: String(c.url || ''),
            sha256: String(c.sha256 || '').toLowerCase(),
            bytes: Number(c.bytes) || 0,
            minDeviceMemoryGB: Number(c.minDeviceMemoryGB) || 0
        };
    }

    function isConfigured() {
        var c = cfg();
        return /^https:\/\/[^\s]+$/.test(c.url) && /^[0-9a-f]{64}$/.test(c.sha256) && c.bytes > 0;
    }

    function isSupported() {
        try {
            return typeof caches !== 'undefined' && typeof fetch === 'function' &&
                typeof crypto !== 'undefined' && !!crypto.subtle &&
                typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined' &&
                typeof Response !== 'undefined' && !!Response.prototype && 'body' in Response.prototype;
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------------ state
    function emit(patch) {
        for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k]; }
        current.percent = current.total > 0 ? Math.max(0, Math.min(100, Math.floor(current.loaded * 100 / current.total))) : 0;
        var snapshot = state();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](snapshot); } catch (err) { if (typeof console !== 'undefined') console.error('[edge-model] listener failed', err); }
        }
    }

    function state() {
        return { status: current.status, loaded: current.loaded, total: current.total, percent: current.percent, error: current.error };
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    }

    // ------------------------------------------------------------------ cache
    async function openCache() { return caches.open(CACHE_NAME); }

    async function pruneStale(cache, keepUrl) {
        // A new model version has a new URL: drop every other entry so old 99 MB files never pile up.
        var keys = await cache.keys();
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].url !== keepUrl) await cache.delete(keys[i]);
        }
    }

    async function isCached() {
        if (!isConfigured() || !isSupported()) return false;
        var c = cfg();
        try {
            var cache = await openCache();
            var hit = await cache.match(c.url);
            if (!hit) return false;
            var len = Number(hit.headers.get('content-length'));
            if (len !== c.bytes) { await cache.delete(c.url); return false; }   // truncated / foreign entry
            return true;
        } catch (e) { return false; }
    }

    async function read() {
        var c = cfg();
        var cache = await openCache();
        var hit = await cache.match(c.url);
        if (!hit) throw EdgeModelError('missing', 'model is not cached');
        var buf = await hit.arrayBuffer();
        if (buf.byteLength !== c.bytes) {
            await cache.delete(c.url);
            throw EdgeModelError('size', 'cached model has the wrong size');
        }
        return buf;
    }

    async function purge() {
        try {
            var cache = await openCache();
            await cache.delete(cfg().url);
        } catch (e) { /* nothing to purge */ }
        if (current.status === 'ready') emit({ status: 'idle', loaded: 0, total: 0, error: null });
    }

    // ------------------------------------------------------------------ helpers
    function toHex(buffer) {
        var bytes = new Uint8Array(buffer), out = '';
        for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return out;
    }

    async function assertRoom(bytes) {
        // Best effort: refuse early (before 99 MB of traffic) when the origin quota clearly cannot hold the model.
        try {
            if (navigator.storage && navigator.storage.estimate) {
                var est = await navigator.storage.estimate();
                if (est && est.quota && est.usage != null && (est.quota - est.usage) < bytes * 1.1) {
                    throw EdgeModelError('quota', 'not enough free storage for the model');
                }
            }
        } catch (e) { if (e && e.code === 'quota') throw e; }
    }

    function classify(err, signal) {
        if (err && err.edgeModel) return err;
        if (signal && signal.aborted || (err && err.name === 'AbortError')) return EdgeModelError('aborted', 'download cancelled');
        if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')))) return EdgeModelError('quota', 'storage quota exceeded');
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return EdgeModelError('offline', 'no internet connection');
        return EdgeModelError('network', String(err && err.message || err));
    }

    // ------------------------------------------------------------------ download
    async function download(signal) {
        var c = cfg();
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw EdgeModelError('offline', 'no internet connection');
        await assertRoom(c.bytes);

        var response = await fetch(c.url, { signal: signal, cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'follow' });
        if (!response.ok) throw EdgeModelError('http', 'model host answered ' + response.status, response.status);
        var declared = Number(response.headers.get('content-length'));
        if (declared && declared !== c.bytes) throw EdgeModelError('size', 'model host sent ' + declared + ' bytes, expected ' + c.bytes);
        if (!response.body || !response.body.getReader) throw EdgeModelError('unsupported', 'streaming downloads are not supported');

        emit({ status: 'downloading', loaded: 0, total: c.bytes, error: null });
        // One pre-sized buffer: peak memory ~= the model size (no chunk list + concat copy).
        var data = new Uint8Array(c.bytes);
        var offset = 0, lastEmit = 0;
        var reader = response.body.getReader();
        try {
            for (;;) {
                var step = await reader.read();
                if (step.done) break;
                var chunk = step.value;
                if (offset + chunk.length > c.bytes) throw EdgeModelError('size', 'model host sent more data than expected');
                data.set(chunk, offset);
                offset += chunk.length;
                var now = Date.now();
                if (now - lastEmit >= PROGRESS_MIN_MS) { lastEmit = now; emit({ loaded: offset }); }
            }
        } finally {
            try { reader.releaseLock(); } catch (e) { /* already released */ }
        }
        if (offset !== c.bytes) throw EdgeModelError('size', 'download ended after ' + offset + ' of ' + c.bytes + ' bytes');
        emit({ loaded: offset, status: 'verifying' });

        var digest = toHex(await crypto.subtle.digest('SHA-256', data));
        if (digest !== c.sha256) throw EdgeModelError('hash', 'model checksum mismatch');

        var cache = await openCache();
        await cache.put(c.url, new Response(data, { status: 200, headers: {
            'content-type': 'application/octet-stream', 'content-length': String(c.bytes) } }));
        await pruneStale(cache, c.url);
        data = null;
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    }

    // ------------------------------------------------------------------ public
    function ensure() {
        if (inflight) return inflight;                                   // single flight
        if (!isConfigured()) return Promise.reject(EdgeModelError('not-configured', 'no model URL is configured'));
        if (!isSupported()) return Promise.reject(EdgeModelError('unsupported', 'on-device AI is not supported here'));

        controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var signal = controller && controller.signal;
        emit({ status: 'checking', loaded: 0, total: cfg().bytes, error: null });

        inflight = (async function () {
            try {
                if (await isCached()) { emit({ status: 'ready', loaded: cfg().bytes, error: null }); return; }
                await download(signal);
                emit({ status: 'ready', loaded: cfg().bytes, error: null });
            } catch (raw) {
                var err = classify(raw, signal);
                emit({ status: err.code === 'aborted' ? 'idle' : 'failed', error: { code: err.code, message: err.message, status: err.status || 0 } });
                throw err;
            } finally {
                inflight = null;
                controller = null;
            }
        })();
        return inflight;
    }

    function cancel() { if (controller) { try { controller.abort(); } catch (e) { /* already aborted */ } } }

    return {
        isConfigured: isConfigured, isSupported: isSupported, isCached: isCached, ensure: ensure, read: read,
        cancel: cancel, purge: purge, subscribe: subscribe, state: state, config: cfg, CACHE_NAME: CACHE_NAME
    };
})();
