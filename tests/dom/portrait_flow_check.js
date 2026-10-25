// Portrait panel flow check, DOM level (jsdom): the REAL index.html + js/config/api-client.js + js/portrait/portrait-mode.js run
// together; only the app services around them (pipeline, loader, toast, history) are stubbed. Covers: no Apply step, slider ->
// request, busy 503 -> automatic retry -> result, still busy -> error panel + "Try again", non-busy 503 not retried, cancel while
// waiting, the safety-net wrapper (no unhandled rejection). NOT a browser: no layout, canvas or WebGL.
//
//   npm i -D jsdom            (not a dependency of the app; this check is skipped when it is missing)
//   node tests/dom/portrait_flow_check.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP portrait_flow_check: jsdom is not installed (npm i -D jsdom)'); process.exit(0); }
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const apiClient = fs.readFileSync(path.join(ROOT, 'js/config/api-client.js'), 'utf8');
const portrait = fs.readFileSync(path.join(ROOT, 'js/portrait/portrait-mode.js'), 'utf8');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for: ' + label); await sleep(5); }
}
const R = (status, detail, retryAfter) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => (/retry-after/i.test(k) && retryAfter !== undefined ? retryAfter : null) },
  json: async () => ({ detail }),
  clone() { return { status, json: async () => ({ detail }) }; },
  blob: async () => new dom.window.Blob([new Uint8Array(500)], { type: 'image/png' }),
});
const BUSY = 'Portrait is busy; please retry in a few seconds';

let dom, log;
function boot(responses, opts = {}) {
  dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.test/' });
  const w = dom.window;
  log = { requests: 0, toasts: [], loader: [], commits: [] };
  const realST = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 1000 ? 5 : ms, ...a);       // 2-10 s waits -> 5 ms
  w.showToast = (m, t) => log.toasts.push([m, t]);
  w.t = (k) => k;
  w.fetch = async () => ({ ok: true, blob: async () => new w.Blob([new Uint8Array(1000)], { type: 'image/png' }) });
  w.URL.createObjectURL = () => 'blob:fake'; w.URL.revokeObjectURL = () => {};
  w.Image = class { set src(u) { if (u === '') return; realST(() => { this.naturalWidth = 1000; this.naturalHeight = 800; this.onload && this.onload(); }, 0); } };
  w.aiLoader = {
    show: () => { log.loader.push('show'); if (opts.loaderThrows) throw new Error('loader exploded'); return log.loader.length; },
    complete: () => log.loader.push('complete'), hide: () => log.loader.push('hide'),
  };
  w.eval(`
    var portraitCurrentBlur = 1, portraitCurrentSkin = 0, portraitBaseBlob = null, portraitResultSrc = null,
        portraitRequestSeq = 0, portraitAbortCtl = null, portraitBusy = false, portraitFocus = { x: .5, y: .5, set: false };
    var originalImage = { src: 'blob:orig', naturalWidth: 1000, naturalHeight: 800, width: 1000, height: 800 };
    var historyStack = [], historyIndex = 0, _blobN = 0;
    var YF = { expose: function () {} };
    var YoPipeline = { imageHasAlpha: function () { return false; },
      commitImageUrl: function (u) { originalImage = { src: u, naturalWidth: 1000, naturalHeight: 800 }; return Promise.resolve(); } };
    function registerBlobUrl() { return 'blob:result' + (++_blobN); }
    function canvasToBlob() { return Promise.reject(new Error('no canvas in jsdom')); }
    function undoEdit() {} function _dropHistoryTop() {}
    function getImageUrlType() { return 'image/png'; } function blobSizeMB() { return '1.0'; } function saveBlob() { return Promise.resolve('saved'); }
  `);
  w.eval(apiClient);
  const queue = responses.slice();
  w.YoApi.request = async (p, o) => {
    log.requests++;
    if (o && o.signal && o.signal.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  };
  w.eval(portrait);
  return w;
}
const disp = (id) => dom.window.document.getElementById(id).style.display;
const visible = () => ['portrait-init-section', 'portrait-result-section', 'portrait-error-section'].filter((id) => disp(id) === 'block');
const slideTo = (v) => { const s = dom.window.document.getElementById('portrait-blur-slider'); s.value = v; dom.window.onPortraitBlurInput(); dom.window.onPortraitBlurChange(); };
const loaderText = () => dom.window.document.getElementById('portraitLoaderText').textContent;

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' -> ' + (e && e.message)]); }
}

(async () => {
  await scenario('initial DOM: intro visible, no Apply button anywhere in the Portrait panel, result/error hidden', async () => {
    boot([]);
    const doc = dom.window.document;
    assert.ok(!doc.getElementById('portraitApplyBtn'));
    assert.strictEqual(doc.querySelectorAll('#portrait-init-section button').length, 0);
    assert.strictEqual(disp('portrait-result-section'), 'none'); assert.strictEqual(disp('portrait-error-section'), 'none');
    const order = [...doc.querySelectorAll('#toolsSubMenu .sub-btn')].map((b) => b.getAttribute('data-i18n'));
    assert.deepStrictEqual(order, ['eraser', 'portrait', 'enhanceFace', 'autoEnhance', 'aiMask']);
  });

  await scenario('S1 slider release -> busy, busy, then success: status line says retrying, only the loading state shows, ends on the result panel', async () => {
    boot([R(503, BUSY, '2'), R(503, BUSY, '2'), R(200)]);
    slideTo(12);
    await until(() => loaderText() === 'portraitBusyRetry', 'retrying status line');
    assert.deepStrictEqual(visible(), [], 'while waiting only the canvas loader is up (intro/result/error hidden)');
    await until(() => disp('portrait-result-section') === 'block', 'result panel');
    assert.strictEqual(log.requests, 3);
    assert.deepStrictEqual(visible(), ['portrait-result-section']);
    assert.strictEqual(loaderText(), 'processingPortrait', 'status line restored');
    assert.ok(log.loader.includes('complete'));
    assert.deepStrictEqual(log.toasts, []);
    assert.strictEqual(dom.window.eval('portraitBusy'), false);
  });

  await scenario('S2 still busy after 2 retries -> translated busy toast + error panel with a Try again button; clicking it runs again and succeeds', async () => {
    boot([R(503, BUSY, '2'), R(503, BUSY, '2'), R(503, BUSY, '2'), R(200)]);
    slideTo(10);
    await until(() => disp('portrait-error-section') === 'block', 'error panel');
    assert.strictEqual(log.requests, 3);
    assert.deepStrictEqual(log.toasts, [['errPortraitBusy', 'error']]);
    assert.deepStrictEqual(visible().sort(), ['portrait-error-section', 'portrait-init-section'].sort());
    const btn = dom.window.document.querySelector('#portrait-error-section button');
    assert.ok(btn && btn.querySelector('[data-i18n="tryAgain"]'));
    assert.strictEqual(dom.window.eval('portraitBusy'), false);
    btn.click();                                              // inline onclick="reapplyPortraitMode()"
    await until(() => disp('portrait-result-section') === 'block', 'result after Try again');
    assert.strictEqual(log.requests, 4); assert.deepStrictEqual(visible(), ['portrait-result-section']);
  });

  await scenario('S3 a non-busy 503 (model not loaded) is NOT retried and shows the model message', async () => {
    boot([R(503, 'Portrait background model failed to load')]);
    slideTo(8);
    await until(() => disp('portrait-error-section') === 'block', 'error panel');
    assert.strictEqual(log.requests, 1);
    assert.deepStrictEqual(log.toasts, [['errPortraitModel', 'error']]);
  });

  await scenario('S4 Cancel-equivalent while waiting to retry: nothing more is sent, loader closed, no unhandled rejection', async () => {
    boot([R(503, BUSY, '10'), R(200)]);
    dom.window.eval('var _st = setTimeout; setTimeout = function (f, ms) { return _st(f, ms >= 1000 ? 80 : ms); };');   // a visible 80 ms wait
    slideTo(9);
    await until(() => loaderText() === 'portraitBusyRetry', 'waiting');
    dom.window.resetPortraitMode();
    await sleep(200);
    assert.strictEqual(log.requests, 1, 'the retry never fired');
    assert.ok(log.loader.includes('hide')); assert.strictEqual(dom.window.eval('portraitBusy'), false);
    assert.deepStrictEqual(visible(), ['portrait-init-section']);
    assert.deepStrictEqual(log.toasts, [], 'a cancelled wait is silent');
  });

  await scenario('S5 an unexpected exception OUTSIDE the core try (loader blows up) -> caught by the wrapper: error panel + toast, loader closed, no unhandled rejection', async () => {
    const before = unhandled.length;
    boot([], { loaderThrows: true });
    slideTo(7);
    await until(() => disp('portrait-error-section') === 'block', 'error panel');
    await sleep(30);
    assert.deepStrictEqual(log.toasts, [['portraitFailed', 'error']]);
    assert.strictEqual(dom.window.eval('portraitBusy'), false);
    assert.strictEqual(unhandled.length, before, 'no unhandled rejection');
  });

  await scenario('S6 a timer-driven refine (+/- buttons, debounced) that fails still leaves no unhandled rejection', async () => {
    const before = unhandled.length;
    boot([R(500, 'boom')]);
    dom.window.adjustPortraitBlur(5);                          // debounce 400 ms -> runPortraitRequest via setTimeout
    await until(() => disp('portrait-error-section') === 'block', 'error panel', 2000);
    await sleep(30);
    assert.strictEqual(unhandled.length, before);
  });

  await scenario('S7 sliders at the sharp floor do nothing (no request); dragging up starts it with no Apply click', async () => {
    boot([R(200)]);
    slideTo(1);
    await sleep(40);
    assert.strictEqual(log.requests, 0);
    slideTo(6);
    await until(() => disp('portrait-result-section') === 'block', 'result');
    assert.strictEqual(log.requests, 1);
  });

  for (const [s, m] of results) console.log(s + '  ' + m);
  console.log('unhandled rejections:', unhandled.length);
  process.exit(results.some((r) => r[0] === 'FAIL') || unhandled.length ? 1 : 0);
})();
