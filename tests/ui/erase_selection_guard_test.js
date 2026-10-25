// erase_selection_guard_test.js - the eraser refuses a painted selection wider than 1024 px BEFORE anything is uploaded.
// Loads the REAL i18n.js, api-client.js, erase-window.js and magic-eraser.js into a vm sandbox with minimal DOM / canvas stubs
// (same approach as cancel_progress_test.js) and drives MagicEraser.apply() end to end. The server enforces the same limit as a
// backstop (tests/backend/test_erase_selection_guard.py); here we also check that a server 400 is shown in the app language.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const EN = 'Selection too large. Max width is 1024px.';
const AR = 'المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو 1024 بكسل.';

// `paint` = which photo columns are painted in the mask: { from, to } (inclusive). getImageData honours the requested rectangle,
// so the real findBBox / window code sees exactly what a real canvas would give.
function el(id, paint) {
  const listeners = {};
  const classes = new Set(['active']);
  return {
    id, hidden: false, disabled: false, innerText: '', textContent: '', style: {}, onclick: null,
    className: '', src: '', naturalWidth: 64, naturalHeight: 64,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }),
    getContext: () => ctx2d(paint),
    setPointerCapture() {},
    fire: (t, ev) => (listeners[t] || []).forEach((fn) => fn(ev)),
    toBlob(cb, type) { cb(new Blob([new Uint8Array(32)], { type: type || 'image/png' })); },
  };
}
function ctx2d(paint) {
  return new Proxy({}, {
    get: (_t, p) => {
      if (p === 'getImageData') {
        return (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const abs = x + col, on = abs >= paint.from && abs <= paint.to;
              data[(row * w + col) * 4] = on ? 255 : 0;
            }
          }
          return { data, width: w, height: h };
        };
      }
      return () => {};
    },
    set: () => true,
  });
}

// photoW: width of the photo in pixels; painted: columns that end up in the mask; lang: app language
function makeEnv(photoW, painted, lang) {
  const els = {}, toasts = [], fetchCalls = [], errors = [];
  const paint = painted;
  const sb = { console: { log() {}, warn() {}, error: (...a) => errors.push(a) }, Blob, FormData, AbortController, Promise, setTimeout, clearTimeout, JSON, Math, Date,
               Uint8Array, Uint8ClampedArray, Proxy, Set, Map, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  sb.localStorage = { getItem: () => null, setItem() {} };
  sb.document = { getElementById: (id) => (els[id] = els[id] || el(id, paint)), createElement: () => el('x', paint), addEventListener() {} };
  sb.addEventListener = () => {};
  let n = 0;
  sb.URL = { createObjectURL: () => 'blob:r' + (++n), revokeObjectURL() {} };
  sb.Image = function () {
    const im = this;
    im.naturalWidth = photoW; im.naturalHeight = 64;
    Object.defineProperty(im, 'src', { set(v) { im._s = v; setTimeout(() => im.onload && im.onload(), 0); }, get() { return im._s; } });
  };
  sb.showToast = (m, t) => toasts.push([m, t]);
  sb.registerBlobUrl = () => 'blob:r' + (++n);
  sb.canvasToBlobUrl = async (c, type) => ({ url: 'blob:c' + (++n), blob: new Blob([new Uint8Array(8)], { type }) });
  sb.saveToHistory = () => {};
  sb.canvasToBlob = async (c, type) => new Blob([new Uint8Array(8)], { type: type || 'image/png' });
  sb.YoPipeline = { commitImageUrl: async () => {} };
  sb.fitImageToWorkspace = () => {};
  sb.previewCanvas = { width: 0, height: 0 };
  sb.previewCtx = ctx2d(paint);
  sb.fetch = (url, init) => {
    const call = { url, init };
    fetchCalls.push(call);
    return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
  };
  createContext(sb);
  vm.runInContext(`var isProcessing = false; var originalImage = null; var currentLanguage = '${lang || 'en'}';`, sb);
  const load = (f) => vm.runInContext(read(f), sb, { filename: f });
  load('js/ui/loading-toast.js');
  sb.showToast = (m, t) => toasts.push([m, t]);          // keep the recording stub in front of loading-toast's own
  load('js/i18n/i18n.js');
  load('js/config/api-client.js');
  load('js/editing/erase-window.js');
  load('js/editing/magic-eraser.js');
  els.mainImg = el('mainImg', paint); els.mainImg.src = 'blob:main';
  els.imgContainer = el('imgContainer', paint);
  els['me-paint-layer'] = el('me-paint-layer', paint);
  els['p-eraser'] = el('p-eraser', paint);
  sb.MagicEraser.init();
  return { sb, els, toasts, fetchCalls, errors };
}

async function ready(env) {
  env.sb.MagicEraser.refreshActive();
  env.sb.MagicEraser.ensureCurrentImage();
  await tick(5);                                       // the Image stub decodes asynchronously
  const layer = env.els['me-paint-layer'];
  const pe = { pointerType: 'touch', clientX: 32, clientY: 32, pointerId: 1, preventDefault() {} };
  layer.fire('pointerdown', pe);
  layer.fire('pointerup', pe);
  assert.equal(env.sb.MagicEraser.hasAnyMask(), true, 'a stroke exists');
}
const okResponse = () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => new Blob([new Uint8Array(16)], { type: 'image/png' }) });

test('1025 px wide selection (English UI): refused, NO request is sent, clear message shown', async () => {
  const env = makeEnv(1400, { from: 100, to: 1124 }, 'en'); await ready(env);   // 1025 columns
  await env.sb.MagicEraser.apply();
  assert.equal(env.fetchCalls.length, 0, 'nothing is uploaded');
  assert.deepEqual(env.toasts, [[EN, 'error']]);
});

test('1025 px wide selection (Arabic UI): the same refusal, in Arabic', async () => {
  const env = makeEnv(1400, { from: 100, to: 1124 }, 'ar'); await ready(env);
  await env.sb.MagicEraser.apply();
  assert.equal(env.fetchCalls.length, 0);
  assert.deepEqual(env.toasts, [[AR, 'error']]);
});

test('exactly 1024 px is still allowed: the request goes out and the success path runs', async () => {
  const env = makeEnv(1400, { from: 100, to: 1123 }, 'en'); await ready(env);   // 1024 columns
  const p = env.sb.MagicEraser.apply();
  await tick(20);
  assert.equal(env.fetchCalls.length, 1, 'one upload');
  assert.equal(env.toasts.length, 0, 'no refusal toast');
  env.fetchCalls[0].resolve(okResponse());
  await p;
});

test('a wide PHOTO with a small selection is fine - only the painted width is limited', async () => {
  const env = makeEnv(4000, { from: 1800, to: 1999 }, 'en'); await ready(env);  // 4000 px photo, 200 px selection
  const p = env.sb.MagicEraser.apply();
  await tick(20);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.toasts.length, 0);
  env.fetchCalls[0].resolve(okResponse());
  await p;
});

test('after a refusal the eraser is not stuck: island closed, busy released, strokes kept, no console error', async () => {
  const env = makeEnv(1400, { from: 0, to: 1399 }, 'en'); await ready(env);
  await env.sb.MagicEraser.apply();
  assert.equal(env.els.loadingOverlay.classList.contains('active'), false, 'loading island closed');
  assert.equal(env.sb.MagicEraser.hasAnyMask(), true, 'the user keeps the strokes and can shrink them');
  assert.deepEqual(env.errors, [], 'a normal refusal is not logged as a failure');
  await env.sb.MagicEraser.apply();                   // usable again straight away (busy was released)
  assert.equal(env.toasts.length, 2);
  assert.equal(env.fetchCalls.length, 0);
});

test('a server 400 SELECTION_TOO_LARGE (stale page / other client) is shown in the app language, EN and AR', async () => {
  const body = { detail: EN + ' | ' + AR, code: 'SELECTION_TOO_LARGE', max_width: 1024, width: 1500 };
  const bad = { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => body };
  for (const [lang, expected] of [['en', EN], ['ar', AR]]) {
    const env = makeEnv(1400, { from: 100, to: 400 }, lang); await ready(env);       // locally fine (301 px) ...
    const p = env.sb.MagicEraser.apply();
    await tick(20);
    env.fetchCalls[0].resolve(bad);                                                  // ... but the server disagrees
    await p;
    assert.deepEqual(env.toasts, [[expected, 'error']], lang);
  }
});

test('wiring: erase-window exports the limit, i18n has the key in EN and AR, the eraser handles the new error code', () => {
  const i18n = read('js/i18n/i18n.js');
  assert.equal((i18n.match(/toastSelectionTooLarge:/g) || []).length, 2, 'one EN + one AR entry');
  assert.ok(i18n.includes("'Selection too large. Max width is {max}px.'"));
  assert.ok(i18n.includes("'المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو {max} بكسل.'"));
  const me = read('js/editing/magic-eraser.js');
  assert.ok(me.indexOf('checkSelectionWidth(bb)') < me.indexOf("window.canvasToBlob(imageSrc"), 'checked before anything is encoded for upload');
  assert.match(me, /err\.code === 'SELECTION_TOO_LARGE'/);
});

test('backend wiring (static): the pipeline guards right after the bbox, before any inference; the route answers a structured 400 ahead of the generic ValueError branch', () => {
  const lama = read('backend/app/lama.py'), main = read('backend/app/main.py');
  const bbox = lama.indexOf('cv2.boundingRect('), empty = lama.indexOf('(empty mask)'), guard = lama.indexOf('check_selection_width(bw)');
  assert.ok(bbox > 0 && empty > bbox && guard > empty, 'guard sits after the bounding box and the empty-mask early return');
  assert.ok(guard < lama.indexOf('self._run(') || guard < lama.indexOf('outputs = self._run('), 'and before the network runs');
  assert.ok(guard < lama.indexOf('cv2.dilate('), 'and before any dilate / crop work');
  assert.match(main, /from backend\.app\.erase_guard import SelectionTooLargeError, error_body/);
  const specific = main.indexOf('except SelectionTooLargeError as exc'), generic = main.indexOf('except ValueError as exc:\n            logger.warning("[erase] 400 rejected input');
  assert.ok(specific > 0 && generic > specific, 'the specific handler comes first (the error is a ValueError subclass)');
  assert.match(main, /JSONResponse\(status_code=400, content=error_body\(exc\)/);
  const cfg = read('backend/app/config.py');
  assert.match(cfg, /^ERASE_MAX_SELECTION_WIDTH = 1024$/m);
  const guardPy = read('backend/app/erase_guard.py');
  assert.ok(guardPy.includes('Selection too large. Max width is {limit}px.'));
  assert.ok(guardPy.includes('المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو {limit} بكسل.'));
  // the same wording on both sides: the English / Arabic strings in i18n.js are the server's with {max} <-> {limit}
  const i18n = read('js/i18n/i18n.js');
  assert.ok(i18n.includes(guardPy.match(/MESSAGE_EN = "([^"]+)"/)[1].replace('{limit}', '{max}')));
  assert.ok(i18n.includes(guardPy.match(/MESSAGE_AR = "([^"]+)"/)[1].replace('{limit}', '{max}')));
});

run('erase_selection_guard_test');
