// V23 G1-G5: rendering path, overlay resize, dead-code removal, AI memory release, listener hygiene.
// Plain Node + vm, no browser: behaviour is checked through stub DOM / WebGL objects (frame RATES and real GPU
// memory cannot be measured here - what is asserted is the code path: no encode while dragging, textures
// uploaded once, backing stores set to 0).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

// ---------- stub WebGL2 (records every call) ----------
function makeGl(log) {
  const consts = {};
  let n = 0;
  return new Proxy({}, {
    get(_, name) {
      if (name === 'then') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(String(name))) return consts[name] || (consts[name] = ++n);
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      if (name === 'getParameter') return () => 16384;
      if (name === 'isContextLost') return () => false;
      if (name === 'getUniformLocation') return (_p, u) => u;
      if (/^create/.test(String(name))) return () => ({ id: ++n });
      return (...args) => { log.push([String(name), ...args]); };
    }
  });
}

function loadGpu(sandboxExtra) {
  const log = [];
  const canvas = { width: 0, height: 0, addEventListener() {}, getContext: () => makeGl(log) };
  const sandbox = Object.assign({ console, Math, JSON, Float32Array, Uint8Array, Object, Array,
    document: { createElement: () => canvas } }, sandboxExtra || {});
  createContext(sandbox);
  vm.runInContext(read('js/core/webgl-renderer.js'), sandbox);
  return { GPU: sandbox.GPU, log, canvas, sandbox };
}
const state = (extra) => Object.assign({ sliders: { exposure: 10, grain: 50 }, filterSteps: [], mix: new Float32Array(24),
  useLut: false, lut: {}, grainSeed: 0 }, extra || {});
const src = { width: 100, height: 50 };
const count = (log, name) => log.filter((c) => c[0] === name).length;

// ================= G1 =================
test('G1: source texture uploaded only when the key changes; drags only change uniforms', () => {
  const { GPU, log } = loadGpu();
  const texImage = () => log.filter((c) => c[0] === 'texImage2D' && c.length > 7).length;   // source uploads (6-arg form is source)
  const srcUploads = () => log.filter((c) => c[0] === 'texImage2D' && c.length === 7).length;
  GPU.render(src, { key: 'img|100x50', state: state() });
  const first = srcUploads();
  for (let i = 0; i < 20; i++) GPU.render(src, { key: 'img|100x50', state: state({ sliders: { exposure: i } }) });
  assert.equal(srcUploads(), first, 'no re-upload during 20 drag frames');
  GPU.render(src, { key: 'other|100x50', state: state() });
  assert.equal(srcUploads(), first + 1, 'a new key uploads again');
  assert.ok(texImage() >= 0);
});

test('G1: LUT is uploaded only when a curve array changes, through one reused buffer', () => {
  const { GPU, log } = loadGpu();
  const lutUploads = () => log.filter((c) => c[0] === 'texImage2D' && c.length === 10 && c[4] === 256).length;
  const mk = () => { const a = new Uint8Array(256); for (let i = 0; i < 256; i++) a[i] = i; return a; };
  const L = { rgb: mk(), red: mk(), green: mk(), blue: mk() };
  GPU.render(src, { key: 'k', state: state({ useLut: true, lut: L }) });
  const afterFirst = lutUploads();
  for (let i = 0; i < 10; i++) GPU.render(src, { key: 'k', state: state({ useLut: true, lut: L }) });
  assert.equal(lutUploads(), afterFirst, 'identical LUT references -> no upload');
  const buffers = new Set(log.filter((c) => c[0] === 'texImage2D' && c.length === 10 && c[4] === 256).map((c) => c[c.length - 1]));
  GPU.render(src, { key: 'k', state: state({ useLut: true, lut: Object.assign({}, L, { rgb: mk() }) }) });
  assert.equal(lutUploads(), afterFirst + 1);
  const buffers2 = new Set(log.filter((c) => c[0] === 'texImage2D' && c.length === 10 && c[4] === 256).map((c) => c[c.length - 1]));
  assert.equal(buffers2.size, 1, 'one Uint8Array reused for every LUT upload (identity + curves)');
  assert.ok(buffers.size <= 1);
});

test('G1: grain seed uniform comes from the edit state (session seed), not a constant', () => {
  const { GPU, log } = loadGpu();
  GPU.render(src, { key: 'k', state: state({ grainSeed: 137 }) });
  const seeds = log.filter((c) => c[0] === 'uniform1f' && c[1] === 'u_grainSeed').map((c) => c[2]);
  assert.deepEqual(seeds, [137]);
  GPU.render(src, { key: 'k', state: state({ grainSeed: 137 }) });
  assert.equal(log.filter((c) => c[0] === 'uniform1f' && c[1] === 'u_grainSeed').pop()[2], 137, 'identical every frame -> no flicker');
});

test('G1: GPU.release() zeroes the canvas backing store and frees the source texture', () => {
  const { GPU, log, canvas } = loadGpu();
  GPU.render(src, { key: null, state: state() });
  assert.ok(canvas.width > 0);
  const before = log.length;
  GPU.release();
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  const freed = log.slice(before).find((c) => c[0] === 'texImage2D');
  assert.ok(freed && freed[4] === 1 && freed[5] === 1 && freed[9] === null, 'source texture storage shrunk to 1x1');
  GPU.render(src, { key: 'k2', state: state() });                       // renders again after release
  assert.ok(canvas.width > 0);
});

function loadPipeline() {
  const sandbox = { console, Math, JSON, Uint8Array, Uint8ClampedArray, Float32Array, Object, Array, Promise,
    document: { createElement() { return { getContext() { return null; } }; }, getElementById() { return null; } } };
  createContext(sandbox);
  vm.runInContext(`
    const sliders = { bright:0, contrast:0, exposure:0, shadows:0, whites:0, blacks:0, sat:0, vibrance:0, warmth:0, tint:0, sharp:0, clarity:0, vignette:0, grain:0 };
    let chosenPreset = 'none'; let colorMixData = [0,1,2,3,4,5,6,7].map(() => ({ hue:0, sat:0, lum:0 }));
    let curvesData = {}; const curvesLUT = {}; const allPresets = [{ id:'none', style:'' }]; var originalImage = null;`, sandbox);
  for (const f of ['js/editing/curves.js', 'js/editing/presets.js', 'js/editing/sliders.js', 'js/editing/effects.js',
                   'js/editing/color-mix-apply.js', 'js/core/render-pipeline.js']) vm.runInContext(read(f), sandbox);
  vm.runInContext(`function d(){return [{x:0,y:0},{x:64,y:64},{x:128,y:128},{x:192,y:192},{x:255,y:255}];}
    curvesData = { rgb:d(), red:d(), green:d(), blue:d() }; buildCurvesLUTs();`, sandbox);
  return { sandbox, run: (c) => vm.runInContext(c, sandbox) };
}

test('G1: session grain seed - starts at 0, re-rolls only on request, stays in 0..255, reaches the edit state', () => {
  const e = loadPipeline();
  assert.equal(e.run('YoPipeline.grainSeed()'), 0);
  assert.equal(e.run('YoPipeline.currentEditState().grainSeed'), 0);
  for (let i = 0; i < 50; i++) {
    const s = e.run('YoPipeline.rerollGrainSeed()');
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 255, String(s));
    assert.equal(e.run('YoPipeline.currentEditState().grainSeed'), s);
    for (let k = 0; k < 5; k++) assert.equal(e.run('YoPipeline.grainSeed()'), s, 'stable between re-rolls');
  }
});

test('G1: currentEditState reuses one Color Mix buffer and still reflects the live values', () => {
  const e = loadPipeline();
  const a = e.run('YoPipeline.currentEditState().mix');
  e.run('colorMixData[2].hue = 30;');
  const b = e.run('YoPipeline.currentEditState().mix');
  assert.strictEqual(a, b, 'same Float32Array (no per-frame allocation)');
  assert.equal(b[6], 30);
  e.run('colorMixData[2].hue = 0;');
  assert.equal(e.run('YoPipeline.currentEditState().mix')[6], 0, 'stale values are cleared');
});

test('G1: CPU grain honours the seed with the same maths as the shader (seed 0 = V22 pattern)', () => {
  const e = loadPipeline();
  const mk = (seed) => { const d = new Uint8ClampedArray(16 * 16 * 4).fill(128); e.sandbox.__d = d;
    e.run(`applyFastGrain(__d, 16, 16, 60, ${seed});`); return Array.from(d); };
  assert.deepEqual(mk(7), mk(7));
  assert.notDeepEqual(mk(7), mk(8));
  const d0 = new Uint8ClampedArray(16 * 16 * 4).fill(128); e.sandbox.__d = d0; e.run('applyFastGrain(__d, 16, 16, 60);');
  assert.deepEqual(Array.from(d0), mk(0), 'omitted seed == 0 (back-compat)');
  assert.ok(/uniform1f\(uniforms\.u_grainSeed, st\.grainSeed/.test(read('js/core/webgl-renderer.js')));
  assert.ok(/u_grainSeed, vec2\(12\.9898,78\.233\)|\+ u_grainSeed, vec2\(12\.9898,78\.233\)/.test(read('js/core/webgl-renderer.js')));
});

test('G1: new upload re-rolls the seed exactly once, in file-handler only', () => {
  assert.ok(/YoPipeline\.rerollGrainSeed\(\)/.test(read('js/core/file-handler.js')));
  for (const f of ['js/editing/sliders.js', 'js/core/webgl-renderer.js', 'js/core/render-pipeline.js'])
    assert.ok(!/rerollGrainSeed\(\)\s*;/.test(read(f).replace(/function rerollGrainSeed[\s\S]*?\n    }\n/, '')), f);
});

// ---- live drag path (sliders.js) with a stub DOM, manual rAF and manual timers ----
function loadSliders() {
  const calls = { encode: 0, liveFrames: 0, resize: 0, full: 0 };
  const timers = []; const rafs = [];
  const mkEl = () => ({ style: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    parentNode: null, appendChild(c) { c.parentNode = this; }, removeChild(c) { c.parentNode = null; }, setAttribute() {}, width: 0, height: 0,
    getContext: () => ({}) });
  const img = Object.assign(mkEl(), { src: 'data:old', offsetWidth: 300, offsetHeight: 200, offsetLeft: 10, offsetTop: 5,
    decode: () => Promise.resolve() });
  const container = mkEl();
  const els = { mainImg: img, imgContainer: container, 'v-bright': { innerText: '' }, bright: { value: '5' } };
  const created = [];
  const sandbox = { console, Math, JSON, Promise, Object, Array,
    window: { getComputedStyle: () => ({ borderRadius: '16px' }) },
    document: { getElementById: (id) => els[id] || null, createElement: () => { const c = mkEl(); created.push(c); return c; } },
    requestAnimationFrame: (f) => { rafs.push(f); return rafs.length; }, cancelAnimationFrame: (id) => { rafs[id - 1] = null; },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1] = null; },
    GPU: { isAvailable: () => true },
    YoPipeline: { needsPixelPass: () => true, previewSize: () => ({ w: 1200, h: 800 }), syncPreviewCanvas: () => ({ w: 1200, h: 800 }),
      renderGpuFrame: () => { calls.liveFrames++; return true; }, renderPreview: () => { calls.full++; return 'gpu'; },
      previewEncoding: () => ({ mime: 'image/jpeg', quality: 0.9 }) },
    overlayManager: { resizeCanvas: () => { calls.resize++; } },
    sliders: { bright: 0 }, chosenPreset: 'none', allPresets: [], originalImage: { src: 'data:orig' },
    previewCanvas: { toDataURL: () => { calls.encode++; return 'data:new' + calls.encode; } }, previewCtx: {},
    pendingUpdate: null, lastFilterString: '', scheduleHistorySave() {}, getPresetFilter() { return ''; } };
  createContext(sandbox);
  vm.runInContext(read('js/editing/sliders.js'), sandbox);
  const flushRaf = () => { while (rafs.length) { const f = rafs.shift(); if (f) f(); } };
  const flushTimers = () => { const t = timers.splice(0); t.forEach((x) => x && x.f()); };
  return { sandbox, calls, created, img, container, flushRaf, flushTimers, timers, run: (c) => vm.runInContext(c, sandbox) };
}

test('G1: slider drag renders on the GPU straight into a live canvas - no encode, no overlay re-measure', () => {
  const e = loadSliders();
  for (let i = 0; i < 30; i++) { e.run('onSliderChange("bright")'); e.flushRaf(); }
  assert.equal(e.calls.liveFrames, 30);
  assert.equal(e.calls.encode, 0, 'toDataURL is never called while the thumb moves');
  assert.equal(e.calls.resize, 0, 'overlay canvas is not re-measured per frame');
  assert.equal(e.created.length, 1, 'one live canvas, reused');
  const live = e.created[0];
  assert.ok(live.classList.contains('active') && live.parentNode === e.container);
  assert.equal(live.style.left, '10px'); assert.equal(live.style.width, '300px'); assert.equal(live.style.borderRadius, '16px');
});

test('G1: settle after the drag encodes ONCE, waits for decode, then releases the live canvas (width = 0)', async () => {
  const e = loadSliders();
  for (let i = 0; i < 5; i++) { e.run('onSliderChange("bright")'); e.flushRaf(); }
  const live = e.created[0];
  assert.equal(live.width, 1200);
  e.flushTimers();                                   // settle timer fires
  assert.equal(e.calls.encode, 1);
  assert.equal(e.calls.full, 1);
  assert.equal(e.img.src, 'data:new1');
  assert.ok(live.classList.contains('active'), 'still covering the photo until the new src has decoded');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(live.width, 0); assert.equal(live.height, 0);
  assert.equal(live.parentNode, null);
  assert.equal(e.calls.resize, 1, 'overlay re-measured once, at settle');
});

test('G1: a drag frame arriving while the settle image decodes keeps the live canvas (epoch guard)', async () => {
  const e = loadSliders();
  e.run('onSliderChange("bright")'); e.flushRaf();
  const live = e.created[0];
  e.flushTimers();                                   // full path started, decode pending
  e.run('onSliderChange("bright")'); e.flushRaf();   // new live frame
  await Promise.resolve(); await Promise.resolve();
  assert.ok(live.classList.contains('active'), 'newer live frame must not be hidden by the older settle');
  assert.equal(live.width, 1200);
});

test('G1: the -/+ buttons, presets etc. (no live flag) keep the V22 full path', () => {
  const e = loadSliders();
  e.sandbox.document.getElementById('bright').min = '-100';
  e.run('applyAllEdits()'); e.flushRaf();
  assert.equal(e.calls.encode, 1); assert.equal(e.calls.liveFrames, 0);
  assert.equal(e.created.length, 0);
  assert.ok(/onSliderChange\(id, false\)/.test(read('js/editing/sliders.js')), 'adjustSlider is a discrete step');
});

test('G1: without WebGL2 the live path is skipped before touching the DOM', () => {
  const e = loadSliders();
  e.sandbox.GPU.isAvailable = () => false;
  e.run('onSliderChange("bright")'); e.flushRaf();
  assert.equal(e.created.length, 0);
  assert.equal(e.calls.encode, 1, 'falls back to the V22 encode path');
});

test('G1: .main-img has no filter transition / will-change; live canvas style exists above the photo', () => {
  const css = read('css/components.css');
  const mainImg = css.split('\n').find((l) => /\.main-img \{/.test(l));
  assert.ok(!/transition:\s*filter/.test(mainImg) && !/will-change:\s*filter/.test(mainImg));
  assert.ok(!/transition:[^;]*filter/.test(css.replace(/backdrop-filter/g, '')), 'no filter transitions anywhere');
  assert.ok(/\.live-preview-canvas[^{]*\{[^}]*z-index:\s*6/.test(css));
});

// ================= G2 =================
function loadOverlay() {
  const w = { n: 0, h: 0, set: [] };
  const canvas = { style: {}, className: '', addEventListener(t, f, o) { (this.l = this.l || []).push([t, f, o]); },
    removeEventListener(t, f) { this.l = (this.l || []).filter((x) => !(x[0] === t && x[1] === f)); },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ width: 10 })), set: (t, k, v) => { t[k] = v; return true; } }) };
  Object.defineProperty(canvas, 'width', { get: () => w.n, set: (v) => { w.n = v; w.set.push(['w', v]); } });
  Object.defineProperty(canvas, 'height', { get: () => w.h, set: (v) => { w.h = v; w.set.push(['h', v]); } });
  const rect = { left: 20, top: 30, width: 400, height: 300 };
  const img = { classList: { contains: () => true }, getBoundingClientRect: () => rect };
  const cont = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const sandbox = { console, Math, JSON, Array, Object,
    Perf: { rafThrottle: (f) => f },
    window: { devicePixelRatio: 2, Perf: { rafThrottle: (f) => f } },
    document: { getElementById: (id) => ({ overlayCanvas: canvas, mainImg: img, imgContainer: cont }[id] || null),
      addEventListener() {}, activeElement: { tagName: 'BODY' } },
    originalImage: {}, saveToHistory() {} };
  createContext(sandbox);
  vm.runInContext(read('js/overlays/overlay-manager.js'), sandbox);
  return { sandbox, canvas, w, rect, om: () => vm.runInContext('overlayManager', sandbox), run: (c) => vm.runInContext(c, sandbox) };
}

test('G2: unchanged geometry -> resizeCanvas returns early (bitmap not re-allocated or cleared)', () => {
  const e = loadOverlay(); const om = e.om();
  om.items.push({ type: 'sticker', id: 1, emoji: 'x', x: 5, y: 5, size: 20, rotation: 0, opacity: 1 });
  om.resizeCanvas();
  const writes = e.w.set.length;
  assert.equal(e.w.n, 800); assert.equal(e.w.h, 600);
  for (let i = 0; i < 25; i++) om.resizeCanvas();
  assert.equal(e.w.set.length, writes, '25 slider-frame calls cause zero canvas.width/height writes');
  e.rect.width = 410;
  om.resizeCanvas();
  assert.equal(e.w.n, 820, 'a real size change is applied');
});

test('G2: empty item queue -> geometry kept, bitmap allocation deferred until something is drawn', () => {
  const e = loadOverlay(); const om = e.om();
  om.resizeCanvas();
  assert.equal(e.w.set.length, 0, 'no backing store allocated for an empty overlay');
  assert.equal(om.cssWidth, 400); assert.equal(om.cssHeight, 300);
  assert.equal(e.canvas.style.display, 'block'); assert.equal(e.canvas.style.width, '400px');
  om.addSticker('x');                                 // add* centres from cssWidth/cssHeight and renders
  assert.equal(e.w.n, 800, 'first draw allocates the DPR-scaled bitmap');
  assert.equal(om.items[0].x, 200);
});

test('G2: hidden canvas / DPR change are not mistaken for "unchanged"', () => {
  const e = loadOverlay(); const om = e.om();
  om.resizeCanvas();
  e.canvas.style.display = 'none';
  om.resizeCanvas();
  assert.equal(e.canvas.style.display, 'block');
  e.sandbox.window.devicePixelRatio = 3;
  om.items.push({ type: 'sticker', id: 1, emoji: 'x', x: 5, y: 5, size: 20, rotation: 0, opacity: 1 });
  om.resizeCanvas();
  assert.equal(e.w.n, 1200);
});

// ================= G3 =================
test('G3: unreachable overlay UI files are gone and nothing references them', () => {
  for (const f of ['js/overlays/text-overlays.js', 'js/overlays/shapes.js', 'js/overlays/fx-overlays.js']) assert.ok(!exists(f), f);
  const html = read('index.html');
  assert.ok(!/text-overlays|shapes\.js|fx-overlays/.test(html));
  assert.ok(!/initEmojiGrid/.test(read('js/core/init.js')));
  assert.ok(/ai-common\.js/.test(html));
  assert.ok(html.indexOf('ai-common.js') < html.indexOf('ai-mask.js') && html.indexOf('ai-common.js') < html.indexOf('bg-removal.js'));
});

test('G3: dead functions and state removed (openPremiumModal, Perf.debounce/throttle, crop state)', () => {
  assert.ok(!/openPremiumModal/.test(read('js/ui/modals-export.js') + read('index.html')));
  assert.ok(/function closePremiumModal/.test(read('js/ui/modals-export.js')), 'close handler kept: markup + tests still use it');
  const perf = read('js/core/perf-utils.js');
  assert.ok(!/function (debounce|throttle)\b|\b(debounce|throttle)\s*:\s*(debounce|throttle)\b/.test(perf));
  const st = read('js/core/state.js');
  assert.ok(!/cropStart|cropEnd|let cropRect/.test(st) && /isDrawingCrop/.test(st));
  assert.ok(!/cropStart|cropEnd/.test(read('js/editing/crop.js')));
});

test('G3: stale overlay-editor code is gone from OverlayManager; the engine API remains', () => {
  const o = read('js/overlays/overlay-manager.js');
  const code = o.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const dead of ['updatePanels', 'renderLayersList', 'renderRecentEmojis', 'addRecentEmoji', 'recentEmojis'])
    assert.ok(!o.includes(dead), dead);
  assert.ok(!code.includes('Math.random'), 'no Math.random in executable code');
  for (const kept of ['addText(', 'addSticker(', 'addShape(', 'addFxOverlay(', 'drawToCanvas(', 'hitTest(', 'resizeCanvas('])
    assert.ok(o.includes(kept), kept);
});

test('G3: FX overlays are deterministic (seeded by item id) so redraws do not flicker', () => {
  const e = loadOverlay(); const om = e.om();
  const a = om._fxRandom({ id: 4 }), b = om._fxRandom({ id: 4 }), c = om._fxRandom({ id: 5 });
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb); assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((v) => v >= 0 && v < 1));
});

test('G3: no unused i18n key remains; EN and AR still match', () => {
  const src = read('js/i18n/i18n.js');
  const en = src.slice(src.indexOf('en: {'), src.indexOf('ar: {')), ar = src.slice(src.indexOf('ar: {'));
  const keys = (t) => [...t.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]);
  const kEn = keys(en).slice(1), kAr = keys(ar).slice(1);   // [0] is the 'en' / 'ar' block id
  assert.deepEqual([...kEn].sort(), [...kAr].sort());
  let used = read('index.html');
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach((x) => {
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p); else if (x.name.endsWith('.js') && !p.endsWith('i18n.js')) used += read(p);
  });
  walk('js');
  const unused = kEn.filter((k) => !new RegExp('[\'"`]' + k + '[\'"`]').test(used));
  assert.deepEqual(unused, []);
});

test('G3: bg-removal, portrait-enhance and ai-mask use the shared helpers instead of private copies', () => {
  for (const f of ['js/editing/bg-removal.js', 'js/editing/portrait-enhance.js', 'js/editing/ai-mask.js']) {
    const t = read(f);
    assert.ok(/YoAiCommon/.test(t), f);
    assert.ok(!/function overlayStart|function overlayEnd|function currentSrcSync|function applyResultToEditor|function loadImageEl/.test(t), f);
  }
  const shared = read('js/editing/ai-common.js');
  for (const fn of ['overlayStart', 'currentSrc', 'loadImage', 'applyResultToEditor', 'releaseCanvas']) assert.ok(shared.includes('function ' + fn));
});

// ================= G4 =================
function canvasFactory(registry) {
  return () => {
    const c = { _w: 0, _h: 0, ops: [], maxPx: 0, ctxInfo: { comp: [], getImageData: [], createImageData: 0 } };
    const upd = () => { c.maxPx = Math.max(c.maxPx, c._w * c._h); };
    Object.defineProperty(c, 'width', { get: () => c._w, set: (v) => { c._w = v; upd(); } });
    Object.defineProperty(c, 'height', { get: () => c._h, set: (v) => { c._h = v; upd(); } });
    const info = c.ctxInfo;
    const ctx = { drawImage() {}, fillRect() {}, putImageData() {}, clearRect() {},
      getImageData(x, y, w, h) { info.getImageData.push([w, h]); return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)).fill(255) }; },
      createImageData(w, h) { info.createImageData++; return { data: new Uint8ClampedArray(w * h * 4) }; } };
    let comp = 'source-over';
    Object.defineProperty(ctx, 'globalCompositeOperation', { get: () => comp, set: (v) => { comp = v; info.comp.push(v); } });
    c.getContext = () => ctx; c.toBlob = (cb) => cb({ size: 1 });
    registry.push(c); return c;
  };
}

function aiSandbox(file, W, H) {
  const canvases = [];
  const sandbox = { console, Math, JSON, Promise, Object, Array, Uint8ClampedArray, Uint8Array, Float32Array,
    IS_MOBILE_DEVICE: false,
    document: { createElement: canvasFactory(canvases), getElementById: () => null },
    requestAnimationFrame: (f) => f(), setTimeout: (f) => { f(); return 0; },
    Image: function () { const im = this; im.naturalWidth = W; im.naturalHeight = H; im.width = W; im.height = H;
      Object.defineProperty(im, 'src', { set() { Promise.resolve().then(() => im.onload && im.onload()); } }); },
    URL: { revokeObjectURL() {} }, showLoading() {}, hideLoading() {}, updateLoadingSub() {},
    getCurrentEditedImageSrc: () => Promise.resolve('blob:src'), releaseTransientImageUrl() {},
    canvasToBlobUrl: () => Promise.resolve({ url: 'blob:out' }),
    YoPipeline: { encodeSpec: () => ({ mime: 'image/png' }), canvasHasAlpha: () => false, commitImageUrl: () => Promise.resolve() },   // V24: shared commit
    YoCompat: { drawBlurred() {} },
    YoSegmenter: { load: () => Promise.resolve(), segment: (src) => { const m = canvasFactory(canvases)(); m.width = 256; m.height = 171; return Promise.resolve(m); } },
    showToast() {}, resetAllValues() {}, fitImageToWorkspace() {}, saveToHistory() {} };
  sandbox.window = sandbox; sandbox.t = (k) => k;
  createContext(sandbox);
  vm.runInContext(read('js/editing/ai-common.js'), sandbox);
  vm.runInContext(read(file), sandbox);
  return { sandbox, canvases };
}

test('G4: background removal - matte refined at segmenter size, destination-in composite, every canvas released', async () => {
  const W = 2560, H = 1706;
  const { sandbox, canvases } = aiSandbox('js/editing/bg-removal.js', W, H);
  const url = await sandbox.BgRemoval.apply({ returnDataUrl: true });
  assert.equal(url, 'blob:out');
  const full = canvases.filter((c) => c.maxPx === W * H);
  assert.equal(full.length, 1, 'exactly one full-size canvas (the output)');
  assert.ok(full[0].ctxInfo.comp.includes('destination-in'), 'matte applied with destination-in');
  for (const c of canvases) assert.equal(c.width * c.height, 0, 'canvas released: ' + c.maxPx + ' px');
  for (const c of canvases) for (const g of c.ctxInfo.getImageData) assert.ok(g[0] * g[1] < W * H / 4, 'no full-size pixel read-back');
});

test('G4: background removal releases its canvases when a step fails', async () => {
  const { sandbox, canvases } = aiSandbox('js/editing/bg-removal.js', 800, 600);
  sandbox.canvasToBlobUrl = () => Promise.reject(new Error('encode failed'));
  await sandbox.BgRemoval.apply({ returnDataUrl: true });
  for (const c of canvases) assert.equal(c.width * c.height, 0);
});

test('G4: portrait enhance - in-place output, no createImageData, canvas released on success and failure', async () => {
  const ok = aiSandbox('js/editing/portrait-enhance.js', 64, 48);
  const url = await ok.sandbox.PortraitEnhance.apply();
  assert.equal(url, 'blob:out');
  assert.ok(ok.canvases.length >= 1);
  for (const c of ok.canvases) { assert.equal(c.ctxInfo.createImageData, 0); assert.equal(c.width * c.height, 0); }
  assert.equal(ok.canvases.reduce((n, c) => n + c.ctxInfo.getImageData.length, 0), 1, 'a single getImageData (no unsharp round trip)');
  const bad = aiSandbox('js/editing/portrait-enhance.js', 64, 48);
  bad.sandbox.canvasToBlobUrl = () => Promise.reject(new Error('boom'));
  await bad.sandbox.PortraitEnhance.apply();
  for (const c of bad.canvases) assert.equal(c.width * c.height, 0, 'released in finally');
});

test('G4: AI mask - region masks live at segmenter resolution, replaced masks and committed canvas are released', () => {
  const t = read('js/editing/ai-mask.js');
  assert.ok(!/skyOut\.width = W|bgOut\.width = W|raw\.width = W|out\.width = W; out\.height = H;\s*\n\s*var octx = out\.getContext\('2d'\);\s*\n\s*var feather/.test(t));
  assert.ok(/function releaseMaskCache/.test(t) && /releaseMaskCache\(\);\s*\/\/ the masks of the previous/.test(t));
  assert.ok(/destination-in/.test(t) && /imageSmoothingQuality = 'high';\s*\n\s*lctx\.drawImage\(regionMask/.test(t));
  assert.ok(/commitCanvasAsOriginal\(canvas\)\.then\(function \(\) \{\s*\n\s*C\.releaseCanvas\(canvas\)/.test(t));
  assert.ok(/function \(err\) \{\s*\n\s*C\.releaseCanvas\(canvas\)/.test(t), 'also on failure');
  assert.ok(/releaseCanvas\(sc\)/.test(t) && /releaseCanvas\(maskCanvas\)/.test(t));
});

test('G4: magic eraser - reuses the source canvas when idle, releases window canvases and the composite canvas in finally', () => {
  const t = read('js/editing/magic-eraser.js');
  assert.ok(/if \(!origCanvas \|\| busy\) origCanvas = document\.createElement/.test(t));
  assert.ok(/finally \{[^}]*maskOut\.width = 0; maskOut\.height = 0;[^}]*imageSrc !== origCanvas/s.test(t));
  assert.ok(/if \(src !== full\) full = null/.test(t));
  assert.ok(/finally \{\s*\n\s*c\.width = 0; c\.height = 0;\s+\/\/ released on success AND failure/.test(t));
});

// ================= G5 =================
test('G5: rafThrottle no longer swallows errors, and keeps working after one', () => {
  const rafs = []; let calls = 0;
  const sandbox = { window: {}, requestAnimationFrame: (f) => { rafs.push(f); } };
  createContext(sandbox);
  vm.runInContext(read('js/core/perf-utils.js'), sandbox);
  const f = sandbox.window.Perf.rafThrottle(function (v) { calls++; if (/^bad/.test(v)) throw new Error('handler bug'); });
  f('bad'); f('bad2');                                  // coalesced into one frame (latest args win)
  assert.equal(rafs.length, 1);
  assert.throws(() => rafs.shift()(), /handler bug/);
  assert.equal(calls, 1);
  f('good'); assert.equal(rafs.length, 1, 'scheduled flag was reset before the throw');
  rafs.shift()(); assert.equal(calls, 2);
  assert.equal(Object.keys(sandbox.window.Perf).join(), 'rafThrottle');
});

test('G5: overlay touchmove listener exists only during a drag; touchend/cancel are passive', () => {
  const e = loadOverlay(); const om = e.om();
  const has = (t) => (e.canvas.l || []).filter((x) => x[0] === t);
  assert.equal(has('touchmove').length, 0, 'no permanent touchmove listener');
  assert.deepEqual(has('touchend').map((x) => x[2] && x[2].passive), [true]);
  assert.deepEqual(has('touchcancel').map((x) => x[2] && x[2].passive), [true]);
  assert.deepEqual(has('touchstart').map((x) => x[2] && x[2].passive), [false], 'touchstart calls preventDefault -> stays non-passive');
  om.items.push({ type: 'sticker', id: 1, emoji: 'x', x: 50, y: 50, size: 40, rotation: 0, opacity: 1 });
  om.resizeCanvas();
  let prevented = 0;
  om.onPointerDown({ touches: [{ clientX: 50, clientY: 50 }], preventDefault() { prevented++; } });
  assert.equal(om.isDragging, true); assert.equal(prevented, 1);
  assert.deepEqual(has('touchmove').map((x) => x[2] && x[2].passive), [false], 'cancelable only while dragging');
  om.onPointerUp({});
  assert.equal(has('touchmove').length, 0, 'removed again when the drag ends');
  assert.equal(om.isDragging, false);
});

test('G5: crop touchmove is attached per drag; document touchend/touchcancel are passive', () => {
  const t = read('js/editing/crop.js');
  assert.ok(!/document\.addEventListener\('touchmove'/.test(t.replace(/if \(e\.touches\) document\.addEventListener\('touchmove', onMove, \{ passive: false \}\);/, '')),
    'no permanent document-level touchmove');
  assert.ok(/if \(e\.touches\) document\.addEventListener\('touchmove', onMove, \{ passive: false \}\)/.test(t));
  assert.ok(/document\.removeEventListener\('touchmove', onMove/.test(t));
  assert.ok(/document\.addEventListener\('touchend', endDrag, \{ passive: true \}\)/.test(t));
  assert.ok(/document\.addEventListener\('touchcancel', endDrag, \{ passive: true \}\)/.test(t));
});

test('G5: every touch listener has an explicit passive flag; cancelling ones are non-passive, the rest passive', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach((x) => {
    const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith('.js')) files.push(p);
  });
  walk('js');
  const calls = [];
  for (const f of files) {
    const t = read(f);
    const re = /(add|remove)EventListener\(\s*'(touchstart|touchmove|touchend|touchcancel)'/g; let m;
    while ((m = re.exec(t))) {
      if (m[1] === 'remove') continue;
      let i = t.indexOf('(', m.index), depth = 0, j = i;
      for (; j < t.length; j++) { if (t[j] === '(') depth++; else if (t[j] === ')' && --depth === 0) break; }
      calls.push({ f, type: m[2], text: t.slice(i, j + 1) });
    }
  }
  assert.ok(calls.length >= 15, 'scanner sees the listeners (' + calls.length + ')');
  // gestures.js (passive:true) and everything else must say what they are
  const unflagged = calls.filter((c) => !/passive:\s*(true|false)/.test(c.text)).map((c) => c.f + ' ' + c.type);
  // legacy: compare.js touchend + gestures.js already flagged; only the ones listed here may stay unflagged
  assert.deepEqual(unflagged, [], 'listeners without an explicit passive flag');
  // touchmove listeners cancel (preventDefault) => must be non-passive; touchend/touchcancel never cancel EXCEPT compare.js's touchend
  for (const c of calls) {
    if (c.type === 'touchmove') assert.ok(/passive:\s*false/.test(c.text), c.f + ' touchmove must stay cancelable');
    if (c.type === 'touchcancel') assert.ok(/passive:\s*true/.test(c.text), c.f + ' touchcancel must be passive');
  }
  assert.ok(calls.filter((c) => c.type === 'touchend' && /passive:\s*true/.test(c.text)).length >= 4);
});

run('v23_test');
