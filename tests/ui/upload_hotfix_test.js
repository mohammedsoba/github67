// Hotfix regression: (1) "overlayManager.updatePanels is not a function" in reset.js / history.js,
//                    (2) the upload spinner that never went away (finish() aborted before hideLoading()).
// The REAL reset.js and file-handler.js run in a vm sandbox.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, complete: true, getContext: () => ({ drawImage() {}, imageSmoothingEnabled: true }), width: 0, height: 0 });

test('nothing in js/ still CALLS overlayManager.updatePanels (it was removed in V23)', () => {
  const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, out); else if (f.endsWith('.js')) out.push(f); } return out; };
  for (const f of walk(path.join(root, 'js'), [])) assert.ok(!/\.updatePanels\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8'))), path.relative(root, f));
});

test('resetAllValues(): works with a real OverlayManager shape (no updatePanels) and also when overlayManager is missing', () => {
  const calls = [];
  const base = () => ({
    console, sliders: { brightness: 5 }, baseColors: [1], buildCurvesLUTs() {}, updateSliderUI() {}, renderPresets() {}, renderColorMix() {}, cancelCrop: () => calls.push('cancelCrop'),
    document: { getElementById: () => el() }, cropRatio: '', fitMode: ''
  });
  for (const withOverlay of [true, false]) {
    const sb = base();
    if (withOverlay) sb.overlayManager = { items: [1, 2], selectedId: 7, render() { calls.push('render'); } };
    createContext(sb);
    vm.runInContext(read('js/ui/reset.js'), sb);
    assert.doesNotThrow(() => vm.runInContext('resetAllValues()', sb));
    if (withOverlay) { assert.equal(sb.overlayManager.items.length, 0); assert.equal(sb.overlayManager.selectedId, null); assert.ok(calls.includes('render')); }
    assert.ok(calls.includes('cancelCrop'), 'the rest of the reset still ran');
  }
});

// Builds the sandbox for handleFileSelect and drives a full successful decode -> finish() path.
function upload(over) {
  const log = { hide: 0, show: 0, toasts: [], applied: 0, order: [] };
  const sb = Object.assign({
    console: { error() {}, log() {}, warn() {} }, Math, Promise, setTimeout, requestAnimationFrame: (f) => f(),
    document: { createElement: el, getElementById: () => el(), body: { classList: { add() {} } } },
    window: { t: (k) => k }, previewCanvas: { width: 0, height: 0 }, previewCtx: { drawImage() {} },
    showLoading() { log.show++; }, hideLoading() { log.hide++; log.order.push('hide'); }, showToast(m, t) { log.toasts.push(t + ':' + m); },
    YoPipeline: { canvasHasAlpha: () => false },
    createImageBitmap: () => Promise.resolve({ width: 800, height: 600, close() {} }),
    canvasToBlobUrl: () => Promise.resolve({ url: 'blob:x' }),
    Image: function () { const i = this; i.naturalWidth = 800; i.naturalHeight = 600; Object.defineProperty(i, 'src', { set(v) { i._s = v; setTimeout(() => i.onload && i.onload(), 0); }, get() { return i._s; } }); },
    resetAllValues() { log.order.push('resetAllValues'); }, resetHistory() { log.order.push('resetHistory'); }, saveToHistory() { log.order.push('saveToHistory'); },
    renderPresets() {}, applyAllEdits() { log.applied++; log.order.push('applyAllEdits'); }, overlayManager: { canvas: null },
    requestAnimationFrameDummy: 0
  }, over || {});
  createContext(sb);
  vm.runInContext(read('js/core/file-handler.js'), sb);
  vm.runInContext('handleFileSelect', sb)({ target: { files: [{ type: 'image/jpeg' }], value: 'x' } });
  return { sb, log, settle: () => new Promise((r) => setTimeout(r, 40)) };
}

test('upload: the spinner is dismissed once the photo is loaded, history is saved first and an initial render pass runs', async () => {
  const { log, settle } = upload();
  await settle();
  assert.equal(log.show, 1);
  assert.equal(log.hide, 1, 'hideLoading() ran exactly once');
  assert.ok(log.order.indexOf('saveToHistory') < log.order.indexOf('hide'));
  assert.equal(log.applied, 1, 'applyAllEdits() (initial default render) ran');
  assert.deepEqual(log.toasts, [], 'a successful upload shows NO "photo loaded" toast (removed for good)');
});

test('upload: if ANY step of finish() throws (the original updatePanels bug), the spinner is still dismissed and an error is shown', async () => {
  const { log, settle } = upload({ resetAllValues() { throw new TypeError('overlayManager.updatePanels is not a function'); } });
  await settle();
  assert.equal(log.hide, 1, 'no stuck spinner');
  assert.ok(log.toasts.some((t) => t.startsWith('error:')), 'the user is told');
});

test('upload: decode errors can never leave the spinner up (encoder rejects twice; image element errors; FileReader errors)', async () => {
  // encoder rejects -> one FileReader retry -> clear error
  let reads = 0;
  let r = upload({
    canvasToBlobUrl: () => Promise.reject(new Error('encode')),
    FileReader: function () { const f = this; f.readAsDataURL = () => { reads++; setTimeout(() => f.onload({ target: { result: 'data:image/png;base64,AAAA' } }), 0); }; }
  });
  await r.settle();
  assert.equal(reads, 1, 'exactly one fallback attempt');
  assert.equal(r.log.hide, 1);
  assert.ok(r.log.toasts.some((t) => t === 'error:toastImageLoadFailed'));

  // the first <img> fails to decode
  r = upload({ Image: function () { const i = this; Object.defineProperty(i, 'src', { set() { setTimeout(() => i.onerror && i.onerror(), 0); } }); } });
  await r.settle();
  assert.equal(r.log.hide, 1);

  // an exception inside bitmapToImg itself (e.g. canvas 2D context unavailable) is contained
  r = upload({
    document: { createElement: () => ({ style: {}, getContext() { throw new Error('no 2d'); } }), getElementById: () => el(), body: { classList: { add() {} } } },
    FileReader: function () { const f = this; f.readAsDataURL = () => setTimeout(() => f.onerror && f.onerror(), 0); }
  });
  await r.settle();
  assert.equal(r.log.hide, 1, 'thrown error -> fallback -> reader error -> spinner dismissed');
});

test('the "photo loaded" toast is gone for good: no toast call, no i18n string, nothing re-adds it', () => {
  for (const f of ['js/core/file-handler.js', 'js/core/init.js', 'js/ui/gestures.js', 'js/ui/navigation.js', 'index.html'])
    assert.ok(!/toastImageLoaded|photo loaded successfully|Image loaded successfully/i.test(read(f)), f);
  const i18n = read('js/i18n/i18n.js');
  assert.ok(!/toastImageLoaded/.test(i18n), 'key removed in English and Arabic');
  assert.ok(!/تم تحميل الصورة بنجاح/.test(i18n));
  assert.match(read('js/core/file-handler.js'), /toastImageLoadFailed/, 'the ERROR toast for a failed load stays');
});

run('upload_hotfix_test');
