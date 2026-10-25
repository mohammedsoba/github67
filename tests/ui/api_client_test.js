// api_client_test.js - js/config/api-client.js must stay plain-Node loadable (module.exports) and correct.
'use strict';
const path = require('node:path');
const { test, run, assert } = require('./_harness');

const api = require(path.resolve(__dirname, '../../js/config/api-client.js'));

test('exports the public API through module.exports (Node-compatible, no window needed)', () => {
  for (const k of ['resolveBase', 'base', 'url', 'request', 'httpError', 'describe', 'describeHttp', 'isNetworkError', 'ApiError']) {
    assert.equal(typeof api[k], 'function', k);
  }
  assert.equal(api.DEFAULT_TIMEOUT_MS, 300000);
  assert.equal(globalThis.YoApi, api);        // also published on the root object
});

test('resolveBase: same origin by default', () => {
  assert.equal(api.resolveBase({ protocol: 'http:' }), '');
  assert.equal(api.resolveBase({ protocol: 'https:', search: '?x=1' }), '');
  assert.equal(api.resolveBase(), '');
});
test('resolveBase: ?api= override wins (trailing slash trimmed, must be http(s))', () => {
  assert.equal(api.resolveBase({ search: '?api=http://192.168.1.20:8085/', protocol: 'http:' }), 'http://192.168.1.20:8085');
  assert.equal(api.resolveBase({ search: '?a=1&api=' + encodeURIComponent('https://x.y/z//'), protocol: 'http:' }), 'https://x.y/z');
  assert.equal(api.resolveBase({ search: '?api=javascript:alert(1)', protocol: 'http:' }), '');
  assert.equal(api.resolveBase({ search: '?api=ftp://h', protocol: 'http:' }), '');
});
test('resolveBase: configured base, then native shells', () => {
  assert.equal(api.resolveBase({ configured: 'https://api.example.com/', protocol: 'file:' }), 'https://api.example.com');
  assert.equal(api.resolveBase({ protocol: 'file:' }), null, 'packaged build without a configured host has NO base (V26: no placeholder)');
  assert.equal(api.resolveBase({ protocol: 'capacitor:', nativeBase: 'http://10.0.2.2:9000' }), 'http://10.0.2.2:9000');
  assert.equal(api.resolveBase({ protocol: 'http:', isNativeShell: true }), null);
  assert.equal(api.resolveBase({ protocol: 'file:', nativeBase: 'not-a-url' }), null);
  assert.equal(api.resolveBase({ protocol: 'https:' }), '', 'a web page stays same-origin');
  assert.equal(api.resolveBase({ protocol: 'file:', nativeBase: 'https://api.real.com/' }), 'https://api.real.com');
});
test('R20/V26: an unconfigured packaged build (and any reserved .example host) is refused with a clear message', async () => {
  assert.equal(api.isPlaceholderBase('https://api.yofilter.example'), true);
  assert.equal(api.isPlaceholderBase('https://api.real.com'), false);
  assert.equal(api.isPlaceholderBase(''), false);
  globalThis.cordova = {};                       // pretend to be a packaged app with NO configured API host
  try {
    await assert.rejects(() => api.request('/api/erase', { method: 'POST' }),
      (e) => e.kind === 'invalid' && /isn’t set up in this version/i.test(e.message));
  } finally { delete globalThis.cordova; }
});
test('resolveBase: ?api= beats configured', () => {
  assert.equal(api.resolveBase({ search: '?api=http://a:1', configured: 'http://b:2', protocol: 'http:' }), 'http://a:1');
});

test('describeHttp: stable user-facing messages', () => {
  assert.match(api.describeHttp(413), /too large.*25 MB/i);
  assert.match(api.describeHttp(503), /isn’t ready/i);
  assert.match(api.describeHttp(404), /isn’t available at this address/i);   // developer hint (?api=) now lives in the console + README, not the UI
  assert.match(api.describeHttp(405), /isn’t available at this address/i);
  assert.equal(api.describeHttp(400, ' bad mask '), 'bad mask');
  assert.equal(api.describeHttp(422, ''), 'The server couldn’t accept this request.');
  assert.match(api.describeHttp(500, 'boom'), /problem while processing.*boom/i);
  assert.match(api.describeHttp(502), /try again later/i);
  assert.match(api.describeHttp(418), /\(418\)/);
});
test('describe: ApiError kinds, raw network errors, junk', () => {
  assert.match(api.describe(api.ApiError('unreachable')), /can’t reach/i);
  assert.match(api.describe(api.ApiError('timeout')), /too long/i);
  assert.equal(api.describe(api.ApiError('http', 'x', { status: 413 })), api.describeHttp(413));
  assert.equal(api.describe(api.ApiError('invalid', 'custom')), 'custom');
  assert.match(api.describe(new TypeError('Failed to fetch')), /can’t reach/i);
  assert.equal(api.describe(new Error('plain')), 'plain');
  assert.match(api.describe(null), /Something went wrong/);
});
test('isNetworkError', () => {
  assert.ok(api.isNetworkError(new TypeError('x')));
  assert.ok(api.isNetworkError(new Error('Load failed')));
  assert.ok(!api.isNetworkError(new Error('nope')));
  assert.ok(!api.isNetworkError(null));
});

test('httpError reads detail from JSON bodies and survives non-JSON', async () => {
  const e1 = await api.httpError({ status: 400, json: async () => ({ detail: 'mask is not a valid image' }) });
  assert.equal(e1.kind, 'http'); assert.equal(e1.status, 400); assert.equal(e1.detail, 'mask is not a valid image');
  const e2 = await api.httpError({ status: 500, json: async () => { throw new Error('html'); } });
  assert.equal(e2.detail, ''); assert.equal(e2.status, 500);
  const e3 = await api.httpError({ status: 422, json: async () => ({ detail: [{ msg: 'x' }] }) });   // FastAPI 422 list -> ignored
  assert.equal(e3.detail, '');
});

const realFetch = globalThis.fetch;
function withFetch(impl, fn) {
  return async () => { globalThis.fetch = impl; try { await fn(); } finally { globalThis.fetch = realFetch; } };
}

test('request: relative path, method/body passthrough', withFetch(async (u, init) => {
  assert.equal(u, '/api/erase'); assert.equal(init.method, 'POST'); assert.equal(init.body, 'B');
  return { ok: true, status: 200 };
}, async () => {
  const r = await api.request('/api/erase', { method: 'POST', body: 'B' });
  assert.equal(r.status, 200);
}));
test('request: network failure -> unreachable ApiError', withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
  const origErr = console.error; console.error = () => {};
  try { await assert.rejects(api.request('/x'), (e) => e.yoApi && e.kind === 'unreachable'); } finally { console.error = origErr; }
}));
test('request: own timeout -> timeout ApiError', withFetch(
  (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })),
  async () => { await assert.rejects(api.request('/x', { timeoutMs: 30 }), (e) => e.yoApi && e.kind === 'timeout'); }
));
test('request: caller abort is rethrown as AbortError (not a timeout)', withFetch(
  (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })),
  async () => {
    const ctl = new AbortController();
    const p = api.request('/x', { signal: ctl.signal, timeoutMs: 5000 });
    setTimeout(() => ctl.abort(), 10);
    await assert.rejects(p, (e) => e.name === 'AbortError' && !e.yoApi);
  }
));
test('request: already-aborted signal makes no network call', withFetch(async () => { throw new Error('fetch must not run'); }, async () => {
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(api.request('/x', { signal: ctl.signal }), (e) => e.name === 'AbortError');
}));

// ---- 400 "selection too large" from /api/erase (structured body: detail + code + max_width) ----
test('httpError keeps the structured fields of a selection-too-large 400 and describe() shows the localisable message', async () => {
  const body = { detail: 'Selection too large. Max width is 1024px. | المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو 1024 بكسل.',
                 code: 'SELECTION_TOO_LARGE', max_width: 1024, width: 1500 };
  const err = await api.httpError({ status: 400, json: async () => body });
  assert.equal(err.kind, 'http'); assert.equal(err.status, 400);
  assert.equal(err.apiCode, 'SELECTION_TOO_LARGE'); assert.equal(err.maxWidth, 1024);
  assert.equal(err.code, undefined, 'never `code`: that name belongs to callers\' own local errors (EMPTY_MASK, SELECTION_TOO_LARGE)');
  assert.equal(err.detail, body.detail, 'detail stays the plain bilingual string');
  assert.equal(api.describe(err), body.detail, 'no i18n dictionary loaded -> the server text (English | Arabic) is shown as is');
});
test('describeHttp: SELECTION_TOO_LARGE is only special for a 400 carrying that code', () => {
  assert.equal(api.describeHttp(400, '', 'SELECTION_TOO_LARGE', 800), 'Selection too large. Max width is 800px.', 'no server text, no i18n -> English with the number');
  assert.equal(api.describeHttp(400, '', 'SELECTION_TOO_LARGE'), 'Selection too large. Max width is 1024px.', 'unknown max -> the standard 1024');
  assert.equal(api.describeHttp(400, 'server text', 'SELECTION_TOO_LARGE', 800), 'server text', 'no i18n -> the server text wins over the English fallback');
  assert.equal(api.describeHttp(400, 'plain mask error', ''), 'plain mask error', 'other 400s keep the server text');
  assert.equal(api.describeHttp(400, ' bad mask '), 'bad mask');
  assert.match(api.describeHttp(500, 'boom', 'SELECTION_TOO_LARGE'), /problem while processing/i, 'the code never changes a non-400');
});
test('httpError: an old-style error body (no code) still yields an empty code and zero maxWidth', async () => {
  const err = await api.httpError({ status: 400, json: async () => ({ detail: 'Mask is not a valid image (JPEG, PNG or WebP only)' }) });
  assert.equal(err.apiCode, ''); assert.equal(err.maxWidth, 0);
  assert.match(api.describe(err), /not a valid image/);
});

run('api_client_test');
