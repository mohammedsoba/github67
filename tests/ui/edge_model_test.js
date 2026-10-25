// Edge AI model cache + downloader (js/core/edge-model.js): the REAL module runs in plain Node against a fake network and a
// fake Cache API. Covers single-flight, progress, integrity (size + SHA-256), retry, cancel, offline, quota and cache hygiene.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { test, run, assert } = require('./_harness');

const src = fs.readFileSync(path.join(__dirname, '../../js/core/edge-model.js'), 'utf8');
const URL_OK = 'https://models.example-host.app/portrait_depth.onnx';

function makeBytes(n, seed) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; }
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');

// Fresh module instance + fresh fake world per test.
function world(opts) {
  opts = opts || {};
  const good = makeBytes(opts.size || 5000, 7);
  const store = new Map();                                   // url -> {bytes, length}
  const fake = {
    fetches: 0, store, good,
    cacheApi: {
      open: async () => ({
        match: async (u) => { const e = store.get(u); return e ? new Response(e.bytes, { headers: { 'content-length': String(e.length) } }) : undefined; },
        put: async (u, res) => { const bytes = new Uint8Array(await res.arrayBuffer()); store.set(u, { bytes, length: bytes.length }); },
        delete: async (u) => store.delete(typeof u === 'string' ? u : u.url),   // the real Cache API accepts a Request or a URL
        keys: async () => [...store.keys()].map((u) => ({ url: u }))
      })
    }
  };
  globalThis.caches = fake.cacheApi;
  globalThis.Worker = function () {};
  globalThis.EDGE_MODEL_CONFIG = { url: opts.url === undefined ? URL_OK : opts.url, sha256: sha(good), bytes: good.length, minDeviceMemoryGB: 3 };
  Object.defineProperty(globalThis.navigator, 'onLine', { value: opts.online !== false, configurable: true });
  Object.defineProperty(globalThis.navigator, 'storage', { value: opts.storage, configurable: true });
  globalThis.fetch = async (url, init) => {
    fake.fetches++;
    const spec = (typeof opts.respond === 'function') ? opts.respond(fake.fetches, good) : {};
    if (spec.status && spec.status !== 200) return { ok: false, status: spec.status, headers: { get: () => null }, body: null };
    const data = spec.bytes || good;
    const declared = spec.declared === undefined ? data.length : spec.declared;
    let pos = 0;
    const chunk = 1000;
    const signal = init && init.signal;
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' && declared !== null ? String(declared) : null) },
      body: { getReader: () => ({
        read: async () => {
          if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
          if (spec.dropAfter != null && pos >= spec.dropAfter) throw new TypeError('network connection lost');
          if (spec.gate && pos >= chunk) await spec.gate(signal);
          if (pos >= data.length) return { done: true };
          const v = data.subarray(pos, Math.min(pos + chunk, data.length)); pos += v.length; return { done: false, value: v };
        },
        releaseLock() {}
      }) }
    };
  };
  const M = (0, eval)(src + ';YoEdgeModel');
  return { M, fake };
}

test('not configured: no URL -> isConfigured false and ensure() rejects with not-configured (no fetch)', async () => {
  const { M, fake } = world({ url: '' });
  assert.equal(M.isConfigured(), false);
  await assert.rejects(M.ensure(), (e) => e.code === 'not-configured');
  assert.equal(fake.fetches, 0);
});

test('a non-HTTPS URL never counts as configured', () => {
  const { M } = world({ url: 'http://models.example-host.app/portrait_depth.onnx' });
  assert.equal(M.isConfigured(), false);
});

test('download: progress goes 0 -> 100, ends verified + cached, and a later ensure() does not touch the network', async () => {
  const { M, fake } = world();
  const seen = []; M.subscribe((s) => seen.push(s));
  await M.ensure();
  assert.equal(fake.fetches, 1);
  assert.equal(M.state().status, 'ready');
  assert.equal(M.state().percent, 100);
  const pcts = seen.filter((s) => s.status === 'downloading').map((s) => s.percent);
  assert.ok(pcts.length >= 1 && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), 'progress is monotonic');
  assert.ok(seen.some((s) => s.status === 'verifying'), 'a verifying phase is reported');
  assert.equal(await M.isCached(), true);
  const buf = await M.read();
  assert.equal(sha(new Uint8Array(buf)), sha(fake.good));
  await M.ensure();
  assert.equal(fake.fetches, 1, 'cached: zero network requests');
});

test('single flight: concurrent ensure() calls share ONE promise and ONE download', async () => {
  const { M, fake } = world();
  const a = M.ensure(), b = M.ensure(), c = M.ensure();
  assert.ok(a === b && b === c, 'the very same promise object');
  await a;
  assert.equal(fake.fetches, 1);
});

test('integrity: a same-length but wrong file is rejected (hash), never cached; a retry then succeeds', async () => {
  const bad = makeBytes(5000, 99);
  const { M, fake } = world({ respond: (n) => (n === 1 ? { bytes: bad } : {}) });
  await assert.rejects(M.ensure(), (e) => e.code === 'hash');
  assert.equal(M.state().status, 'failed');
  assert.equal(M.state().error.code, 'hash');
  assert.equal(fake.store.size, 0, 'nothing cached');
  await M.ensure();                                          // Retry
  assert.equal(M.state().status, 'ready');
  assert.equal(fake.fetches, 2);
});

test('integrity: Content-Length that differs from the expected size is refused before any data is read', async () => {
  const { M, fake } = world({ respond: () => ({ declared: 4999 }) });
  await assert.rejects(M.ensure(), (e) => e.code === 'size');
  assert.equal(fake.store.size, 0);
});

test('integrity: a short body (connection closed early without an error) is a size error', async () => {
  const { M } = world({ respond: () => ({ bytes: makeBytes(3000, 7), declared: null }) });
  await assert.rejects(M.ensure(), (e) => e.code === 'size');
});

test('errors: HTTP status, dropped connection and offline each map to a stable code; the next ensure() retries', async () => {
  let w = world({ respond: () => ({ status: 404 }) });
  await assert.rejects(w.M.ensure(), (e) => e.code === 'http' && e.status === 404);
  assert.equal(w.M.state().error.status, 404);

  w = world({ respond: (n) => (n === 1 ? { dropAfter: 2000 } : {}) });
  await assert.rejects(w.M.ensure(), (e) => e.code === 'network');
  assert.equal(w.M.state().status, 'failed');
  await w.M.ensure();
  assert.equal(w.M.state().status, 'ready', 'Retry after a dropped connection works');

  w = world({ online: false });
  await assert.rejects(w.M.ensure(), (e) => e.code === 'offline');
  assert.equal(w.fake.fetches, 0, 'offline: no request is even attempted');
});

test('cancel: aborts the running download, state returns to idle, nothing is cached, and it can start again', async () => {
  let release;
  const gate = (signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });
  const { M, fake } = world({ respond: (n) => (n === 1 ? { gate } : {}) });
  const p = M.ensure();
  await new Promise((r) => setTimeout(r, 20));
  M.cancel();
  await assert.rejects(p, (e) => e.code === 'aborted');
  assert.equal(M.state().status, 'idle');
  assert.equal(fake.store.size, 0);
  void release;
  await M.ensure();
  assert.equal(M.state().status, 'ready');
});

test('quota: not enough free storage fails early (before downloading) with the quota code', async () => {
  const { M, fake } = world({ storage: { estimate: async () => ({ quota: 6000, usage: 5000 }) } });
  await assert.rejects(M.ensure(), (e) => e.code === 'quota');
  assert.equal(fake.fetches, 0);
});

test('cache hygiene: a truncated cached entry is deleted and re-downloaded; entries of an older model URL are pruned', async () => {
  const { M, fake } = world();
  fake.store.set(URL_OK, { bytes: fake.good.subarray(0, 100), length: 100 });
  fake.store.set('https://models.example-host.app/old_model_v0.onnx', { bytes: makeBytes(10, 1), length: 10 });
  assert.equal(await M.isCached(), false);
  assert.equal(fake.store.has(URL_OK), false, 'the truncated entry is gone');
  await M.ensure();
  assert.deepEqual([...fake.store.keys()], [URL_OK], 'only the current model remains');
});

test('purge() removes the cached model', async () => {
  const { M } = world();
  await M.ensure();
  await M.purge();
  assert.equal(await M.isCached(), false);
});

test('unsubscribe stops notifications; a throwing listener never breaks the download', async () => {
  const { M } = world();
  let calls = 0;
  const off = M.subscribe(() => { calls++; });
  M.subscribe(() => { throw new Error('listener bug'); });
  const origErr = console.error; console.error = () => {};
  await M.ensure();
  const before = calls; off();
  await M.purge(); await M.ensure();
  console.error = origErr;
  assert.equal(calls, before);
});

run('edge_model_test');
