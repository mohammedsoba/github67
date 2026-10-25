// v22_test.js - Part 2, Task 2 (Y10-Y18): static guards + the pure logic that can run without a browser.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');
const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---- dictionary
function dict() {
  const src = read('js/i18n/i18n.js');
  const m = src.match(/var translations = (\{[\s\S]*?\n  \});\n\n  \/\/ ── Core/);
  return vm.runInNewContext('(' + m[1] + ')');
}
test('Y11: EN and AR have identical key sets; every data-i18n* key in index.html exists', () => {
  const d = dict();
  assert.deepStrictEqual(Object.keys(d.en).sort(), Object.keys(d.ar).sort());
  const html = read('index.html');
  const re = /data-i18n(?:-title|-placeholder|-alt|-aria)?="([A-Za-z0-9_]+)"/g;
  let m; const missing = [];
  while ((m = re.exec(html))) if (!(m[1] in d.en)) missing.push(m[1]);
  assert.deepStrictEqual(missing, []);
});
test('Y11: every window.t(\'key\') used in js/ exists in the dictionary; i18n-patch.js is gone', () => {
  const d = dict();
  const used = new Set();
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        const re = /\bt\('([A-Za-z0-9_]+)'/g; let m;
        while ((m = re.exec(s))) used.add(m[1]);
      }
    }
  })(path.join(root, 'js'));
  const missing = [...used].filter((k) => !(k in d.en) && !/^[a-z]$/.test(k) && k !== 'canvas');
  assert.deepStrictEqual(missing.filter((k) => !['2d', 'webgl2', 'div', 'span', 'a', 'Undo'].includes(k)), []);
  assert.ok(!fs.existsSync(path.join(root, 'js/i18n/i18n-patch.js')));
  assert.ok(!/i18n-patch/.test(read('index.html')));
});
test('Y11: t() fills {placeholders}; export labels are honest', () => {
  const sb = { window: {} }; sb.window = sb;
  vm.runInNewContext(read('js/i18n/i18n.js'), sb);
  assert.strictEqual(sb.t('maskApplyingTo', { region: 'Sky' }), 'Applying to Sky…');
  assert.strictEqual(sb.t('doesNotExist'), 'doesNotExist');
  const d = dict();
  assert.ok(/JPEG 60%/.test(d.en.lowQuality) && /JPEG 92%/.test(d.en.normalQuality) && /PNG/.test(d.en.ultraQuality));
  assert.ok(!/Ultra|Low Quality|Normal Quality/.test(JSON.stringify(d.en.lowQuality + d.en.normalQuality + d.en.ultraQuality)));
  assert.ok(/2560/.test(d.en.exportSubtitle));
});
test('Y11: no hard-coded English literal is passed to a toast / loading call', () => {
  const bad = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.js') || f.name === 'i18n.js') continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/\b(showToast|toast|showLoading|updateLoadingSub|overlayStart|overlayStep|setStatus|showSwipeHint)\(\s*'[A-Z]/.test(line) && !/^\s*(\/\/|function )/.test(line)) bad.push(f.name + ':' + (i + 1) + ' ' + line.trim());
      });
    }
  })(path.join(root, 'js'));
  assert.deepStrictEqual(bad, []);
});

// ---- Y10 / Y14 static CSS guards
test('Y10: rtl.css has no row-reverse and no physical margins/paddings; no physical margin-left/right elsewhere', () => {
  const rtl = read('css/rtl.css');
  assert.ok(!/row-reverse/.test(rtl.replace(/\/\*[\s\S]*?\*\//g, '')));
  for (const f of fs.readdirSync(path.join(root, 'css'))) {
    const s = read('css/' + f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/margin-(left|right)\s*:/.test(s), f + ' still uses a physical margin');
  }
  assert.ok(!/margin-right:\s*[46]px/.test(read('index.html')));
});
test('Y14: no :has() and no [style*=] selectors in CSS; crop state is class-based', () => {
  for (const f of fs.readdirSync(path.join(root, 'css'))) {
    const s = read('css/' + f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/:has\(/.test(s), f + ' uses :has()');
    assert.ok(!/\[style\*?=/.test(s), f + ' matches inline styles');
  }
  const crop = read('js/editing/crop.js');
  assert.ok(!/style\.display\s*=\s*'(block|flex)'/.test(crop) && /classList\.toggle\('crop-active'|toggle\('crop-active'/.test(crop));
  assert.ok(/body\.crop-active/.test(read('css/polish.css')) && /body\.photo-loaded/.test(read('css/polish.css')) && /body\.eraser-active/.test(read('css/polish.css')));
});

// ---- Y15
test('Y15: compare slider and quick-text hint are gone; hold-to-compare stays', () => {
  const html = read('index.html');
  for (const w of ['compareSliderContainer', 'compareDivider', 'compareHandle', 'compare-label', 'quickTextHint']) assert.ok(!html.includes(w), w);
  for (const f of ['js/ui/compare.js', 'js/ui/gestures.js', 'js/core/init.js', 'js/core/file-handler.js']) {
    assert.ok(!/toggleCompareMode|initCompareSlider|isDraggingCompare|setupDoubleTap|compareMode/.test(read(f)), f);
  }
  assert.ok(/id="compareBtn"/.test(html) && /holdOriginalStart/.test(read('js/ui/compare.js')));
});
test('Y15: crop rectangles compose, so the held Original is cropped like the edited photo', () => {
  const sb = { document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(cb) { cb(null); } }) }, URL, Promise, Date, setTimeout,
    canvasToBlob: () => Promise.reject(new Error('encode failed')) };   // V24/G8: compare.js uses the shared save-image.js helper
  sb.window = sb; createContext(sb);
  vm.runInContext(read('js/ui/compare.js') + '\nvar originalForCompare = { src: "x", naturalWidth: 1000, naturalHeight: 500 };', sb);
  vm.runInContext('applyCropToCompare({x:0.1,y:0.2,w:0.5,h:0.5}); applyCropToCompare({x:0.5,y:0,w:0.5,h:1});', sb);
  const c = vm.runInContext('getCompareCropState()', sb);
  assert.ok(Math.abs(c.x - 0.35) < 1e-9 && Math.abs(c.y - 0.2) < 1e-9 && Math.abs(c.w - 0.25) < 1e-9 && Math.abs(c.h - 0.5) < 1e-9, JSON.stringify(c));
  vm.runInContext('setCompareCropState(null)', sb);
  assert.strictEqual(vm.runInContext('getCompareCropState()', sb), null);
});

// ---- Y12 crop maths
function cropEnv() {
  const sb = { console, Math, document: { getElementById: () => null, body: { classList: { toggle() {} } } }, window: {} };
  createContext(sb);
  vm.runInContext(read('js/editing/crop.js'), sb);
  return { run: (c) => vm.runInContext(c, sb) };
}
test('Y12: clampCropBox enforces the minimum first, keeps an exact ratio and stays inside the photo', () => {
  const e = cropEnv();
  e.run('cropImgBounds = {x:10,y:10,w:300,h:200}; cropAspect = 16/9; cropBox = {x:0,y:0,w:5,h:5}; clampCropBox();');
  const b = JSON.parse(e.run('JSON.stringify(cropBox)'));
  assert.ok(b.w >= 30 && b.h >= 30 - 1e-9, JSON.stringify(b));
  assert.ok(Math.abs(b.w / b.h - 16 / 9) < 1e-9);
  assert.ok(b.x >= 10 && b.y >= 10 && b.x + b.w <= 310 + 1e-9 && b.y + b.h <= 210 + 1e-9);
  e.run('cropBox = {x:0,y:0,w:900,h:900}; clampCropBox();');
  const big = JSON.parse(e.run('JSON.stringify(cropBox)'));
  assert.ok(big.w <= 300 + 1e-9 && big.h <= 200 + 1e-9 && Math.abs(big.w / big.h - 16 / 9) < 1e-9, JSON.stringify(big));
});
test('Y12: exact integer ratio sizes; undersized selections are refused', () => {
  const e = cropEnv();
  e.run('cropAspectParts = [16, 9];');
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(_exactRatioSize(1919.4, 1080.3))')), { w: 1904, h: 1071 });
  assert.strictEqual(e.run('_exactRatioSize(10, 5)'), null);
  const src = read('js/editing/crop.js');
  assert.ok(/_cropBusy/.test(src) && /CROP_MIN_OUTPUT/.test(src) && /toastCropTooSmall/.test(src) && /_cropInitTimer/.test(src));
});

// ---- Y13 frames
function frameEnv() {
  const sb = { console, Math, document: { getElementById: (id) => (id === 'viewport' ? { clientWidth: 360, clientHeight: 500 } : null), addEventListener() {}, readyState: 'complete' }, window: { t: (k) => k, innerWidth: 360, innerHeight: 640 } };
  createContext(sb);
  vm.runInContext(read('js/editing/fit-frame.js'), sb);
  return { run: (c) => vm.runInContext(c, sb) };
}
test('Y13: custom colour is invalid for neon / frost / gradient frames, valid for solid ones', () => {
  const e = frameEnv();
  const ok = (id) => e.run(`_frameSupportsCustomColor(_findFrame('${id}'))`);
  for (const id of ['neon-purple', 'soc-tiktok', 'rnd-frost', 'lux-gold', 'grad-ocean', 'none']) assert.strictEqual(ok(id), false, id);
  for (const id of ['min-white', 'pol-classic', 'cln-navy', 'film-strip']) assert.strictEqual(ok(id), true, id);
  const css = JSON.parse(e.run(`JSON.stringify(_buildFrameCSS(_findFrame('rnd-frost'), {thickness:20,radius:0,shadow:0,padding:0,useCustomColor:true,customColor:'#ff0000'}))`));
  assert.strictEqual(css.background, 'rgba(255,255,255,0.06)');
});
test('Y13: padding is capped on a 360 px screen (12% of the short side) and polaroid keeps proportion', () => {
  const e = frameEnv();
  const css = JSON.parse(e.run(`JSON.stringify(_buildFrameCSS(_findFrame('min-white'), {thickness:60,radius:0,shadow:0,padding:40}))`));
  assert.strictEqual(css.padding, '43px 43px 43px 43px');
  const pol = JSON.parse(e.run(`JSON.stringify(_buildFrameCSS(_findFrame('pol-classic'), {thickness:60,radius:0,shadow:0,padding:40}))`));
  const [t, , b] = pol.padding.replace(/px/g, '').split(' ').map(Number);
  assert.ok(t <= 43 && b > t && b <= 108, pol.padding);
  const small = JSON.parse(e.run(`JSON.stringify(_buildFrameCSS(_findFrame('min-white'), {thickness:10,radius:0,shadow:0,padding:0}))`));
  assert.strictEqual(small.padding, '10px 10px 10px 10px');                       // normal values untouched
  const r = JSON.parse(e.run(`JSON.stringify(_buildFrameCSS(_findFrame('rnd-white'), {thickness:5,radius:30,shadow:0,padding:0}))`));
  assert.strictEqual(r.imageRadius, 41);                                           // 16+30 - 0 border - 5 padding
});

// ---- Y16 watermark
test('Y16: watermark can be switched off and the choice is stored', () => {
  const store = {}; const calls = [];
  const sb = { localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: { addEventListener() {}, getElementById: () => null }, window: { t: (k) => k }, showToast() {} };
  createContext(sb); vm.runInContext(read('js/editing/watermark.js'), sb);
  const ctx = new Proxy({}, { get: (_t, p) => (...a) => { calls.push(String(p)); }, set: () => true });
  sb.drawWatermark(ctx, 800, 600);
  assert.ok(calls.includes('fillText'));
  vm.runInContext('setWatermarkEnabled(false)', sb);
  assert.strictEqual(store.yofilter_watermark, 'off');
  calls.length = 0; sb.drawWatermark(ctx, 800, 600);
  assert.strictEqual(calls.length, 0);
  store.yofilter_watermark = 'off';
  const sb2 = Object.assign({}, sb); createContext(sb2); vm.runInContext(read('js/editing/watermark.js'), sb2);
  assert.strictEqual(vm.runInContext('isWatermarkEnabled()', sb2), false);
  assert.ok(/role="switch"/.test(read('index.html')) && /toggleWatermarkSetting/.test(read('index.html')));
});

// ---- Y17
test('Y17: no <div onclick>; dialogs have roles, labels and a focus trap; live region exists', () => {
  const html = read('index.html');
  assert.ok(!/<div[^>]*\sonclick="(?!event\.stopPropagation|close(Premium|Export)Modal)/.test(html));
  for (const id of ['premiumModal', 'exportModal']) assert.ok(new RegExp('id="' + id + '"[\\s\\S]*?role="dialog" aria-modal="true" aria-labelledby').test(html), id);
  assert.ok(/aria-live="polite"/.test(html) && /YoA11y/.test(read('js/ui/a11y.js')) && /key !== 'Tab'/.test(read('js/ui/a11y.js')));
  assert.ok(/createElement\('button'\)/.test(read('js/editing/presets.js')) && /createElement\('button'\)/.test(read('js/editing/color-mix.js')) && /createElement\('button'\)/.test(read('js/editing/fit-frame.js')));
});

// ---- Y18
test('Y18: eraser keeps strokes across same-size reloads, clears them after a removal / new photo, HD export is full size', () => {
  const me = read('js/editing/magic-eraser.js');
  assert.ok(/sameGeometry/.test(me) && /keepStrokes: false/.test(me) && /discardStrokes/.test(me));
  const dl = me.slice(me.indexOf('async function download()'), me.indexOf('COMMIT RESULT TO THE MAIN EDITOR'));
  assert.ok(/renderEditedCanvas\(originalImage, w, h, c\)/.test(dl) && !/toDataURL/.test(dl));
  assert.ok(/discardStrokes/.test(read('js/core/file-handler.js')));
});

run('v22_test');
