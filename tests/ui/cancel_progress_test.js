// P1.4 - cancel / staged progress / ETA for the eraser.
// Loads the REAL loading-toast.js, i18n.js, api-client.js, erase-window.js and magic-eraser.js into a
// vm sandbox with minimal DOM/canvas stubs, then drives MagicEraser.apply() end to end.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function el(id) {
  const listeners = {};
  const classes = new Set(['active']);
  return {
    id, hidden: false, disabled: false, innerText: '', textContent: '', style: {}, onclick: null,
    className: '', src: '', naturalWidth: 64, naturalHeight: 64,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }),
    getContext: () => ctx2d(),
    setPointerCapture() {},
    fire: (t, ev) => (listeners[t] || []).forEach((fn) => fn(ev)),
    _classes: classes,
    toBlob(cb, type) { cb(new Blob([new Uint8Array(32)], { type: type || 'image/png' })); },
  };
}
function ctx2d() {
  return new Proxy({}, {
    get: (_t, p) => {
      if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h });
      return () => {};
    },
    set: () => true,
  });
}

function makeEnv() {
  const els = {};
  const store = {};
  const toasts = [], subs = [], loads = [], history = [];
  const fetchCalls = [];
  const flags = { ignoreAbort: false };
  const sb = { console, Blob, FormData, AbortController, Promise, setTimeout, clearTimeout, JSON, Math, Date, Uint8Array, Uint8ClampedArray, Proxy, Set, Map, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  sb.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  sb.document = {
    getElementById: (id) => (els[id] = els[id] || el(id)),
    createElement: () => el('x'),
    addEventListener() {},
  };
  sb.addEventListener = () => {};
  let n = 0;
  sb.URL = { createObjectURL: () => 'blob:r' + (++n), revokeObjectURL() {} };
  sb.Image = function () {
    const im = this;
    im.naturalWidth = 64; im.naturalHeight = 64;
    Object.defineProperty(im, 'src', { set(v) { im._s = v; setTimeout(() => im.onload && im.onload(), 0); }, get() { return im._s; } });
  };
  sb.showToast = (m, t) => toasts.push([m, t]);
  sb.registerBlobUrl = (b) => 'blob:r' + (++n);
  sb.canvasToBlobUrl = async (c, type) => ({ url: 'blob:c' + (++n), blob: new Blob([new Uint8Array(8)], { type }) });
  sb.saveToHistory = () => history.push('saved');
  // V24/G8: the eraser uploads through the shared canvasToBlob (save-image.js) and commits through the shared
  // YoPipeline.commitImageUrl; both are stubbed here (their real behaviour is covered by v24_test.js / render_pipeline_test.js).
  sb.canvasToBlob = async (c, type) => new Blob([new Uint8Array(8)], { type: type || 'image/png' });
  sb.YoPipeline = { commitImageUrl: async () => { history.push('saved'); } };
  sb.fitImageToWorkspace = () => {};
  sb.previewCanvas = { width: 0, height: 0 };
  sb.previewCtx = ctx2d();
  sb.fetch = (url, init) => {
    const call = { url, init, resolve: null };
    fetchCalls.push(call);
    return new Promise((resolve, reject) => {
      call.resolve = resolve; call.reject = reject;
      if (!flags.ignoreAbort) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
  };
  createContext(sb);
  vm.runInContext('var isProcessing = false; var originalImage = null;', sb);
  const load = (f) => vm.runInContext(read(f), sb, { filename: f });
  load('js/ui/loading-toast.js');
  // loading-toast defines showToast too; keep our recording stub in front of it
  sb.showToast = (m, t) => toasts.push([m, t]);
  vm.runInContext('var _realUpdate = updateLoadingSub; updateLoadingSub = function(t){ __subs.push(t); _realUpdate(t); };', Object.assign(sb, { __subs: subs }));
  load('js/i18n/i18n.js');                // real dictionary: window.t(key, params) gives the English text
  load('js/config/api-client.js');
  load('js/editing/erase-window.js');
  load('js/editing/magic-eraser.js');
  els.mainImg = el('mainImg'); els.mainImg.src = 'blob:main';
  els.imgContainer = el('imgContainer');
  els['me-paint-layer'] = el('me-paint-layer');
  els['p-eraser'] = el('p-eraser');
  sb.MagicEraser.init();
  return { sb, els, toasts, subs, history, fetchCalls, store, flags };
}

async function readyWithStroke(env) {
  env.sb.MagicEraser.refreshActive();
  env.sb.MagicEraser.ensureCurrentImage();
  await tick(5);                                   // Image stub decodes asynchronously
  const layer = env.els['me-paint-layer'];
  const pe = { pointerType: 'touch', clientX: 32, clientY: 32, pointerId: 1, preventDefault() {} };
  layer.fire('pointerdown', pe);
  layer.fire('pointerup', pe);
  assert.equal(env.sb.MagicEraser.hasAnyMask(), true, 'stroke painted');
}
const okResponse = () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => new Blob([new Uint8Array(16)], { type: 'image/png' }) });

test('island shows a Cancel button during an erase and hides it afterwards', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const p = env.sb.MagicEraser.apply();
  await tick(10);
  const btn = env.els.loadingCancel;
  assert.equal(btn.hidden, false);
  assert.equal(typeof btn.onclick, 'function');
  assert.equal(env.els.loadingOverlay.classList.contains('active'), true);
  env.fetchCalls[0].resolve(okResponse());
  await p;
  assert.equal(btn.hidden, true);
  assert.equal(btn.onclick, null);
  assert.equal(env.els.loadingOverlay.classList.contains('active'), false);
});

test('Cancel: aborts the request, closes the island within 200 ms, toasts, commits nothing', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const before = { src: env.els.mainImg.src, saves: env.history.length };
  const p = env.sb.MagicEraser.apply();
  await tick(10);
  const call = env.fetchCalls[0];
  const t0 = Date.now();
  env.els.loadingCancel.onclick({ preventDefault() {} });
  assert.ok(Date.now() - t0 < 200);
  assert.equal(call.init.signal.aborted, true, 'network request aborted');
  assert.equal(env.els.loadingOverlay.classList.contains('active'), false, 'island closed synchronously');
  assert.equal(env.els.loadingCancel.hidden, true);
  assert.equal(env.toasts.length, 0, 'a user-initiated cancel shows no toast: the modal closing is the feedback');
  await p;                                          // apply() unwinds quietly
  assert.equal(env.toasts.filter((t) => /fail/i.test(t[0])).length, 0, 'no error toast');
  assert.equal(env.els.mainImg.src, before.src);
  assert.equal(env.history.length, before.saves, 'history untouched');
  assert.equal(env.sb.MagicEraser.hasAnyMask(), true, 'mask kept so the user can retry');
  assert.equal(env.toasts.filter((t) => /cancel/i.test(t[0])).length, 0, 'and never a cancellation toast');
});

test('late response after Cancel never modifies the canvas, history or editor', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const src = env.els.mainImg.src;
  env.flags.ignoreAbort = true;                     // worst case: a transport that still delivers after abort
  const p = env.sb.MagicEraser.apply();
  await tick(10);
  const call = env.fetchCalls[0];
  env.els.loadingCancel.onclick({});
  call.resolve(okResponse());                       // response arrives AFTER cancel
  await p; await tick(20);
  assert.equal(env.els.mainImg.src, src);
  assert.equal(env.history.length, 0);
  assert.equal(env.sb.MagicEraser._debug().actions, 1, 'mask not reset by a stale result');
});

test('after Cancel the eraser is immediately usable again and a stale run cannot hide the new island', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const first = env.sb.MagicEraser.apply();
  await tick(10);
  env.els.loadingCancel.onclick({});
  const second = env.sb.MagicEraser.apply();        // busy was released by cancel
  await tick(10);
  assert.equal(env.fetchCalls.length, 2);
  await first;                                       // old run finishes unwinding...
  assert.equal(env.els.loadingOverlay.classList.contains('active'), true, '...but the new island stays open');
  env.fetchCalls[1].resolve(okResponse());
  await second;
  assert.equal(env.history.length, 1);
});

test('stages are shown in order; ETA appears only after 2 samples and uses the median', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const run1 = async () => {
    const p = env.sb.MagicEraser.apply();
    await tick(10);
    env.fetchCalls.at(-1).resolve(okResponse());
    await p;
    await readyWithStroke(env);
  };
  await run1();
  const stagesRun1 = env.subs.slice();
  assert.deepEqual(stagesRun1.slice(0, 2), ['Preparing…', 'Waiting for the AI server…']);
  assert.ok(stagesRun1.every((s) => !/usually/i.test(s)), 'no ETA with <2 samples (1 recorded)');
  assert.equal(env.sb.MagicEraser._eta.loadDurations().length, 1);
  env.subs.length = 0;
  await run1();                                      // 2nd run: sees 1 sample -> still no ETA; records the 2nd
  assert.ok(env.subs.every((s) => !/usually/i.test(s)));
  env.subs.length = 0;
  await run1();                                      // 3rd run: 2 samples exist -> ETA suffix
  assert.ok(env.subs.some((s) => /Waiting for the AI server… · Usually about \d+ s$/.test(s)), env.subs.join(' | '));
});

test('ETA store: keeps the last 5, median, ignores junk, survives broken storage', () => {
  const env = makeEnv();
  const eta = env.sb.MagicEraser._eta;
  [1000, 2000, 3000, 4000, 5000, 6000, 7000].forEach((v) => eta.recordDuration(v));
  assert.deepEqual(JSON.parse(env.store.yo_erase_ms), [3000, 4000, 5000, 6000, 7000]);
  assert.equal(eta.medianOf([5000, 1000, 9000]), 5000);
  assert.equal(eta.medianOf([1000, 3000]), 2000);
  assert.match(eta.etaSuffix(), /Usually about 5 s$/);
  env.store.yo_erase_ms = '{"not":"an array"}';
  assert.deepEqual(Array.from(eta.loadDurations()), []);
  env.store.yo_erase_ms = '[100,"x",null,-5,200]';
  assert.deepEqual(Array.from(eta.loadDurations()), [100, 200]);
  env.sb.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(Array.from(eta.loadDurations()), []);
  eta.recordDuration(1234);                          // must not throw
  assert.equal(eta.etaSuffix(), '');
});

test('showLoading without onCancel hides any previous Cancel button; patch forwards opts', () => {
  const env = makeEnv();
  let cancelled = 0;
  env.sb.showLoading('Working...', { onCancel: () => cancelled++ });
  const btn = env.els.loadingCancel;
  assert.equal(btn.hidden, false);
  btn.onclick({}); btn.onclick && btn.onclick({});   // 2nd click is a no-op (handler dropped)
  assert.equal(cancelled, 1);
  assert.equal(env.els.loadingOverlay.classList.contains('active'), false);
  env.sb.showLoading('Working...', { onCancel: () => {} });
  env.sb.showLoading('Another job');                 // no opts: stale handler must not leak
  assert.equal(btn.hidden, true);
  assert.equal(btn.onclick, null);
  env.sb.showLoading('x', { onCancel: () => {} });
  env.sb.hideLoading();
  assert.equal(btn.hidden, true);
});

test('markup + CSS: cancel button in the overlay, glass.css linked, [hidden] respected', () => {
  const html = read('index.html');
  assert.match(html, /<button type="button" class="island-cancel" id="loadingCancel" hidden data-i18n="cancel">Cancel<\/button>/);
  assert.ok(html.indexOf('id="loadingCancel"') > html.indexOf('id="loadingSub"'), 'after the body text');
  // inside the overlay element: after its opening tag and before the compare <img> that follows the overlay
  assert.ok(html.indexOf('id="loadingCancel"') < html.indexOf('<img class="compare-img"'), 'Cancel is inside #loadingOverlay');
  assert.ok(html.indexOf('id="loadingCancel"') > html.indexOf('id="loadingOverlay"'));
  assert.match(html, /css\/glass\.css/);
  const css = read('css/glass.css');
  assert.match(css, /\.island-cancel\s*\{[^}]*min-height:\s*36px/);
  assert.match(css, /border-radius:\s*9999px/);
  assert.match(css, /\.island-cancel\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.island-cancel:hover/);
  assert.match(css, /\.island-cancel:active/);
  assert.match(css, /body\.rtl \.island-cancel/);
});

test('i18n: every new label exists in English AND Arabic (Arabic differs from English)', () => {
  const src = read('js/i18n/i18n.js');
  const en = src.slice(src.indexOf('    en: {'), src.indexOf('    ar: {'));
  const ar = src.slice(src.indexOf('    ar: {'));
  const val = (block, k) => { const m = new RegExp("^\\s*" + k + ": '((?:[^'\\\\]|\\\\.)*)'", 'm').exec(block); return m && m[1]; };
  for (const k of ['cancel', 'stagePreparing', 'stageWaiting', 'stageReceiving', 'stageBlending', 'stageApplying', 'etaUsually']) {
    const e = val(en, k), a = val(ar, k);
    assert.ok(e, 'missing EN ' + k); assert.ok(a, 'missing AR ' + k);
    assert.notEqual(e, a, k + ' is not translated');
    assert.ok(/[\u0600-\u06FF]/.test(a), k + ' has no Arabic letters');
  }
  assert.ok(val(en, 'etaUsually').includes('{s}') && val(ar, 'etaUsually').includes('{s}'));
});

test('Magic Eraser asks the overlay for the 1 -> 100 counter, paced by the median of the learned runs (0 until 2 exist)', async () => {
  const env = makeEnv(); await readyWithStroke(env);
  const seen = [];
  vm.runInContext('var __realShow = showLoading; showLoading = function (t, o) { __seen.push(o); return __realShow(t, o); };', Object.assign(env.sb, { __seen: seen }));
  const once = async () => {
    const p = env.sb.MagicEraser.apply();
    await tick(10);
    env.fetchCalls.at(-1).resolve(okResponse());
    await p;
    await readyWithStroke(env);
  };
  await once();                                                   // no samples yet
  assert.ok(seen[0].progress && seen[0].progress.expectedMs === 0, JSON.stringify(seen[0].progress));
  assert.equal(typeof seen[0].onCancel, 'function', 'Cancel is still offered');
  env.store.yo_erase_ms = JSON.stringify([4000, 6000, 5000]);
  await once();
  assert.equal(seen[1].progress.expectedMs, 5000, 'median of the learned runs');
});

run('cancel_progress');
