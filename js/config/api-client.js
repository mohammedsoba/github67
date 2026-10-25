// api-client.js - one place that knows where the YoFilter backend lives and how to talk to it.
//
//  * Same-origin by default: requests go to a RELATIVE path ("/api/erase"), so it never matters which
//    port uvicorn runs on (8080, 8085, 5000 ...) - the page and the API share the same origin.
//  * Overrides (only needed when the page is NOT served by the backend):
//      - add  ?api=http://192.168.1.20:8085  to the page URL, or
//      - set  window.PRODUCTION_API_BASE  (js/config/app-config.js), or
//      - for Cordova / file:// builds set "native_api_base" in version.json and run scripts/sync_version.py (it stamps
//        window.NATIVE_API_BASE in js/config/app-config.js, the CSP and config.xml; HTTPS only).
//  * Every request gets a generous timeout (low-spec CPUs need a long time for one LaMa pass) and every
//    failure is turned into a short, human message (server offline, timeout, too large, model missing ...).
//
// The pure helpers take their inputs as arguments, so they are unit-tested from Node (tests/ui).
(function (root) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 300000;            // 5 minutes: far above the worst single inference on a tiny CPU
  // Packaged apps cannot use "localhost" (that is the phone itself) and modern Android blocks cleartext HTTP.
  // A packaged build with NO configured host has no base at all (resolveBase() returns null): request() refuses to
  // call anything and tells the user the build is not configured, instead of failing with a confusing network error.
  // No placeholder host is shipped anywhere.
  var PLACEHOLDER_HOST_RE = /^https?:\/\/[^/]*\.example(?::\d+)?(?:\/|$)/i;
  function isPlaceholderBase(v) { return PLACEHOLDER_HOST_RE.test(String(v || '')); }
  var NATIVE_PROTOCOLS = ['file:', 'content:', 'app:', 'capacitor:', 'ionic:', 'cordova:'];

  function trimBase(v) { return String(v || '').trim().replace(/\/+$/, ''); }
  function isHttpUrl(v) { return /^https?:\/\/[^\s/]+/i.test(v); }

  // Decide the API base. '' means "same origin" (relative URLs); null means "packaged app, no API host configured".
  // Pure: all inputs are arguments.
  //   env = { search, protocol, configured, nativeBase, isNativeShell }
  function resolveBase(env) {
    env = env || {};
    var m = /[?&]api=([^&#]+)/.exec(env.search || '');
    if (m) {
      var fromQuery = trimBase(decodeURIComponent(m[1]));
      if (isHttpUrl(fromQuery)) return fromQuery;
    }
    var configured = trimBase(env.configured);
    if (isHttpUrl(configured)) return configured;
    var proto = env.protocol || '';
    if (env.isNativeShell || NATIVE_PROTOCOLS.indexOf(proto) !== -1) {
      var nb = trimBase(env.nativeBase);
      return isHttpUrl(nb) ? nb : null;
    }
    return '';                                  // http(s) page served by the backend: stay on its origin
  }

  function currentBase() {
    var loc = root.location || {};
    return resolveBase({
      search: loc.search,
      protocol: loc.protocol,
      configured: root.PRODUCTION_API_BASE,
      nativeBase: root.NATIVE_API_BASE,
      isNativeShell: !!(root.cordova || root.Capacitor)
    });
  }

  function url(path) { return (currentBase() || '') + path; }

  function timeoutMs() {
    var v = Number(root.YO_API_TIMEOUT_MS);
    return isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
  }

  // ---- errors ---------------------------------------------------------------------------------------
  // kind: 'unreachable' | 'timeout' | 'http' | 'invalid'
  function ApiError(kind, message, extra) {
    var e = new Error(message || kind);
    e.name = 'YoApiError';
    e.yoApi = true;
    e.kind = kind;
    if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; }
    return e;
  }

  // Y11: user-facing messages come from the i18n dictionary (EN/AR). Without js/i18n/i18n.js (unit tests,
  // very early errors) the English fallback is used, with the same {placeholder} replacement.
  function tt(key, fallback, params) {
    try {
      if (typeof root.t === 'function') {
        var v = root.t(key, params);
        if (v && v !== key) return v;
      }
    } catch (e) { /* fall through to the English text */ }
    return params ? fallback.replace(/\{(\w+)\}/g, function (m, k) { return params[k] !== undefined ? params[k] : m; }) : fallback;
  }
  function msgUnreachable() { return tt('apiUnreachable', 'Can’t reach the AI server. Check your connection and try again.'); }
  function msgGeneric() { return tt('apiGeneric', 'Something went wrong. Please try again.'); }

  // Turn any error into one short sentence for the toast. Pure.
  function describe(err) {
    if (!err) return msgGeneric();
    if (err.yoApi) {
      switch (err.kind) {
        case 'unreachable': return msgUnreachable();
        case 'timeout': return tt('apiTimeout', 'The server took too long to respond. Try a smaller area, or try again.');
        case 'http': return describeHttp(err.status, err.detail, err.apiCode, err.maxWidth);
        default: return err.message || msgGeneric();
      }
    }
    // A raw fetch() network failure that bypassed YoApi.fetch ("Failed to fetch", "Load failed", ...).
    if (isNetworkError(err)) return msgUnreachable();
    return err.message || String(err);
  }

  // `code` / `maxWidth` are optional: the machine-readable fields some 400s carry (httpError reads them from the JSON body and
  // stores the code as `apiCode` - NOT `code`, which callers use for their own local errors, e.g. the eraser's EMPTY_MASK).
  function describeHttp(status, detail, code, maxWidth) {
    var text = typeof detail === 'string' ? detail.trim() : '';
    if (status === 413) return tt('apiTooLarge', 'This photo is too large for the server (25 MB max).');
    if (status === 429) return text || tt('apiTooMany', 'Too many requests. Please wait a moment and try again.');
    if (status === 503 && /busy/i.test(text)) return text;      // eraser queue full (Retry-After: 5)
    if (status === 503) return tt('apiModelNotLoaded', 'The AI model isn’t ready on the server yet. Please try again shortly.');
    if (status === 404 || status === 405) {
      return tt('apiNotFound', 'The AI service isn’t available at this address.');
    }
    // Selection wider than the eraser accepts: show it in the app language (the server text carries English AND Arabic).
    if (status === 400 && code === 'SELECTION_TOO_LARGE') {
      return tt('toastSelectionTooLarge', text || 'Selection too large. Max width is {max}px.', { max: maxWidth > 0 ? maxWidth : 1024 });
    }
    if (status === 400 || status === 422) return text || tt('apiRejected', 'The server couldn’t accept this request.');
    if (status >= 500) return tt('apiServerError', 'The server ran into a problem while processing the photo.') + (text ? ' ' + text : tt('apiSeeLog', ' Please try again later.'));
    return text || tt('apiStatus', 'Something went wrong on the server ({status}). Please try again.', { status: status });
  }

  function isNetworkError(err) {
    if (!err) return false;
    var msg = String(err.message || '');
    return err.name === 'TypeError' ||
      /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_connection/i.test(msg);
  }

  // Read the error body of a non-OK response into an ApiError.
  async function httpError(response) {
    var detail = '', code = '', maxWidth = 0;
    try {
      var j = await response.json();
      var d = j && (j.error || j.message || j.detail);
      if (typeof d === 'string') detail = d;
      if (j && typeof j.code === 'string') code = j.code;
      if (j && isFinite(Number(j.max_width)) && Number(j.max_width) > 0) maxWidth = Number(j.max_width);
    } catch (e) { /* body was not JSON */ }
    return ApiError('http', 'HTTP ' + response.status, { status: response.status, detail: detail, apiCode: code, maxWidth: maxWidth });
  }

  // fetch() against the backend with a timeout. `path` is relative ("/api/erase").
  //   opts: standard fetch options + timeoutMs + signal (caller cancellation, rethrown as AbortError).
  async function request(path, opts) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) {                  // cancelled before it started: no network call at all
      var early = new Error('Aborted'); early.name = 'AbortError'; throw early;
    }
    var base = currentBase();
    if (base === null || isPlaceholderBase(base)) {            // refuse BEFORE any timer / network work starts
      if (root.console) root.console.error('[YoApi] no AI server address is configured for this build - set native_api_base in version.json (then run scripts/sync_version.py), or add ?api=http://host:port to the page URL.');
      throw ApiError('invalid', tt('apiNoBase', 'The AI server isn’t set up in this version of the app.'), { url: url(path) });
    }
    var ms = opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs();
    var ctl = new AbortController();
    var timedOut = false, callerAborted = false;
    var timer = setTimeout(function () { timedOut = true; try { ctl.abort(); } catch (e) {} }, ms);
    var outer = opts.signal, onOuterAbort = null;
    if (outer) {
      onOuterAbort = function () { callerAborted = true; try { ctl.abort(); } catch (e) {} };
      outer.addEventListener('abort', onOuterAbort);
    }
    var target = url(path);
    try {
      var init = { method: opts.method || 'GET', signal: ctl.signal };
      if (opts.body !== undefined) init.body = opts.body;
      if (opts.headers) init.headers = opts.headers;
      return await root.fetch(target, init);
    } catch (err) {
      if (timedOut && !callerAborted) {
        throw ApiError('timeout', 'Request timed out after ' + Math.round(ms / 1000) + ' s', { url: target });
      }
      if (callerAborted || (err && err.name === 'AbortError')) throw err;          // cancelled on purpose
      if (isNetworkError(err)) {
        if (root.console) root.console.error('[YoApi] cannot reach ' + target + ' - is the backend running?', err);
        throw ApiError('unreachable', msgUnreachable(), { url: target, cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (outer && onOuterAbort) outer.removeEventListener('abort', onOuterAbort);
    }
  }

  var api = {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    resolveBase: resolveBase,
    isPlaceholderBase: isPlaceholderBase,
    base: currentBase,
    url: url,
    request: request,
    httpError: httpError,
    describe: describe,
    describeHttp: describeHttp,
    isNetworkError: isNetworkError,
    ApiError: ApiError
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YoApi = api;
})(typeof window !== 'undefined' ? window : globalThis);
