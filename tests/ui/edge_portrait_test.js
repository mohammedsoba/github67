// js/portrait/edge-portrait.js (orchestrator): the REAL module + REAL portrait-math.js against fake canvas / worker / model.
// Focus: the hybrid contract (null = "use the server"), worker transfer, depth cache, and 100% canvas disposal.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, run, assert } = require('./_harness');

const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
const MATH = read('js/portrait/portrait-math.js');
const EDGE = read('js/portrait/edge-portrait.js');

let canvases, workers, bitmapsClosed, encodes, uiCalls, retryFn, modelCalls;
let mode;      // fake worker behaviour: ok | inferError | initError
const flags = { configured: true, supported: true, ensureError: null, modelState: 'idle' };

function disc(n) { const d = new Float32Array(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) d[y * n + x] = ((x - n / 2) ** 2 + (y - n / 2) ** 2 < (n * 0.2) ** 2) ? 9 : 2; return d; }

function install() {
  canvases = []; workers = []; bitmapsClosed = 0; encodes = []; uiCalls = []; modelCalls = { ensure: 0, read: 0 }; retryFn = null; mode = 'ok';
  flags.configured = true; flags.supported = true; flags.ensureError = null; flags.modelState = 'idle';
  Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: 8, configurable: true });
  globalThis.document = { createElement: () => {
    const c = { width: 0, height: 0, getContext: () => ({
      drawImage() {}, putImageData() {},
      getImageData: (x, y, w, h) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = (i * 7) & 255; data[i * 4 + 1] = (i * 3) & 255; data[i * 4 + 2] = 90; data[i * 4 + 3] = 255; } return { data }; }
    }) };
    canvases.push(c); return c;
  } };
  globalThis.ImageData = function (data, w, h) { this.data = data; this.width = w; this.height = h; };
  globalThis.createImageBitmap = async (blob) => ({ width: blob.w, height: blob.h, close() { bitmapsClosed++; } });
  globalThis.canvasToBlob = (canvas) => { encodes.push({ w: canvas.width, h: canvas.height }); return mode === 'encodeError' ? Promise.reject(new Error('toBlob failed')) : Promise.resolve({ size: 1, type: 'image/png' }); };
  globalThis.Worker = function (url, opts) {
    const w = { url, opts, log: [], terminated: false,
      postMessage(msg, transfer) {
        w.log.push({ type: msg.type, transferred: (transfer || []).length, isBuffer: msg.model instanceof ArrayBuffer });
        setTimeout(() => {
          if (w.terminated) return;
          if (msg.type === 'init') w.onmessage({ data: mode === 'initError' ? { type: 'error', id: msg.id, message: 'session create failed' } : { type: 'ready', id: msg.id } });
          else if (msg.type === 'infer') w.onmessage({ data: mode === 'inferError' ? { type: 'error', id: msg.id, message: 'infer boom' } : { type: 'result', id: msg.id, depth: disc(518), h: 518, w: 518 } });
        }, 1);
      },
      terminate() { w.terminated = true; } };
    workers.push(w); return w;
  };
  globalThis.YoEdgeModel = {
    config: () => ({ minDeviceMemoryGB: 3 }), isConfigured: () => flags.configured, isSupported: () => flags.supported,
    ensure: async () => { modelCalls.ensure++; if (flags.ensureError) throw flags.ensureError; },
    read: async () => { modelCalls.read++; return new ArrayBuffer(16); },
    state: () => ({ status: flags.modelState })
  };
  globalThis.YoEdgeModelUI = {
    onRetry: (fn) => { retryFn = fn; }, hide: () => uiCalls.push('hide'),
    showError: (c) => uiCalls.push('error:' + c), setPhase: (p) => uiCalls.push('phase:' + p)
  };
  (0, eval)(MATH);
  return (0, eval)(EDGE + ';YoEdgePortrait');
}
const photo = (w, h) => ({ w: w || 400, h: h || 300 });
const allDisposed = () => canvases.every((c) => c.width === 0 && c.height === 0);

test('canHandle gates: unconfigured, unsupported, skin smoothing, huge photos and low-memory devices all go to the server', () => {
  const E = install();
  assert.equal(E.canHandle({ skin: 0 }), true);
  flags.configured = false; assert.equal(E.canHandle({ skin: 0 }), false); flags.configured = true;
  flags.supported = false; assert.equal(E.canHandle({ skin: 0 }), false); flags.supported = true;
  assert.equal(E.canHandle({ skin: 30 }), false, 'skin smoothing is server-only');
  assert.equal(E.canHandle({ skin: 0, width: 6000, height: 5000 }), false, '30 MP is over the limit');
  Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: 2, configurable: true });
  assert.equal(E.canHandle({ skin: 0 }), false, 'a 2 GB device uses the server');
});

test('happy path: PNG blob back; model buffer TRANSFERRED to a module worker; every canvas disposed; bitmap closed', async () => {
  const E = install();
  const out = await E.run(photo(), { level: 20, focusX: 0.5, focusY: 0.5 });
  assert.ok(out && out.type === 'image/png');
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].opts, { type: 'module' });
  assert.match(workers[0].url, /js\/workers\/depth-worker\.js$/);
  const init = workers[0].log.find((l) => l.type === 'init');
  assert.ok(init.isBuffer && init.transferred === 1, 'ArrayBuffer is transferred, not copied');
  const infer = workers[0].log.find((l) => l.type === 'infer');
  assert.equal(infer.transferred, 1, 'the input tensor is transferred');
  assert.ok(canvases.length >= 5, 'net, mask, bokeh, full and output canvases were used');
  assert.ok(allDisposed(), 'width = height = 0 on every temporary canvas');
  assert.equal(encodes.length, 1);
  assert.ok(encodes[0].w === 400 && encodes[0].h === 300, 'the output canvas was still full-size while encoding');
  assert.equal(bitmapsClosed, 1);
});

test('depth cache: the same photo (slider / re-focus) never re-runs the network; a different photo does', async () => {
  const E = install();
  const a = photo();
  await E.run(a, { level: 10 });
  await E.run(a, { level: 25, focusX: 0.2, focusY: 0.7 });
  assert.equal(workers[0].log.filter((l) => l.type === 'infer').length, 1);
  await E.run(photo(), { level: 10 });
  assert.equal(workers[0].log.filter((l) => l.type === 'infer').length, 2);
  assert.equal(workers.length, 1, 'ONE worker/session for the whole app session');
  assert.ok(allDisposed());
});

test('concurrent runs share ONE worker session', async () => {
  const E = install();
  const [x, y] = await Promise.all([E.run(photo(), { level: 10 }), E.run(photo(), { level: 12 })]);
  assert.ok(x && y);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].log.filter((l) => l.type === 'init').length, 1);
});

test('aperture too small to show: the original blob comes back untouched', async () => {
  const E = install();
  const b = photo(100, 80);
  assert.equal(await E.run(b, { level: 2 }), b);
  assert.ok(allDisposed());
});

test('local failure -> null (server fallback); canvases disposed, bitmap closed, no crash', async () => {
  let E = install();
  mode = 'inferError';
  assert.equal(await E.run(photo(), { level: 15 }), null);
  assert.ok(allDisposed()); assert.equal(bitmapsClosed, 1);

  E = install(); mode = 'encodeError';
  assert.equal(await E.run(photo(), { level: 15 }), null);
  assert.ok(allDisposed(), 'the output canvas is zeroed even when the encode rejects');
});

test('download failure: null (server fallback); the card (YoEdgeModel state) owns Retry, local stays enabled for the next try', async () => {
  const E = install();
  const err = new Error('lost'); err.edgeModel = true; err.code = 'network';
  flags.ensureError = err; flags.modelState = 'failed';
  assert.equal(await E.run(photo(), { level: 15 }), null);
  assert.equal(workers.length, 0, 'no worker without a model');
  assert.ok(!uiCalls.some((c) => c.startsWith('error:')), 'no duplicate runtime error on top of the download error');
  assert.equal(E.canHandle({ skin: 0 }), true);
  flags.ensureError = null; flags.modelState = 'ready';
  assert.ok(await E.run(photo(), { level: 15 }), 'works once the network is back');
});

test('user cancel: local AI stays off for the rest of the session, until Retry is pressed', async () => {
  const E = install();
  const err = new Error('cancelled'); err.edgeModel = true; err.code = 'aborted';
  flags.ensureError = err;
  assert.equal(await E.run(photo(), { level: 15 }), null);
  assert.ok(uiCalls.includes('hide'));
  assert.equal(E.canHandle({ skin: 0 }), false);
  flags.ensureError = null;
  retryFn();                                                  // the Retry button
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(E.canHandle({ skin: 0 }), true);
});

test('runtime failure (session cannot start): server fallback, card says so, Retry re-enables and re-starts', async () => {
  const E = install();
  mode = 'initError';
  assert.equal(await E.run(photo(), { level: 15 }), null);
  assert.ok(uiCalls.includes('error:runtime'));
  assert.equal(E.canHandle({ skin: 0 }), false, 'no retry loop on every slider move');
  assert.ok(workers[0].terminated, 'the failed worker is terminated');
  mode = 'ok';
  retryFn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(E.canHandle({ skin: 0 }), true);
  assert.ok(await E.run(photo(), { level: 15 }));
});

test('superseded request: AbortError (ignored by portrait-mode), nothing leaks', async () => {
  const E = install();
  let calls = 0;
  await assert.rejects(E.run(photo(), { level: 15, isStale: () => ++calls >= 3 }), (e) => e.name === 'AbortError');
  assert.ok(allDisposed());
  assert.equal(bitmapsClosed, 1);
});

run('edge_portrait_test');
