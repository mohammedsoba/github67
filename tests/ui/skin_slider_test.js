// skin_slider_test.js - Portrait skin/blur slider logic from js/portrait/portrait-mode.js.
// No JSDOM: the real file is evaluated in a bare node:vm context with ~30 lines of hand-written DOM stubs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeEl(id) {
  const cls = new Set();
  return {
    id, value: '0', innerText: '', style: {}, disabled: false,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    setAttribute() {}, addEventListener() {}, appendChild() {},
  };
}

// Fresh sandbox per test: real portrait globals (copied from state.js so they cannot drift) + real portrait-mode.js.
function load() {
  const els = {};
  const document = {
    getElementById: (id) => (id === 'mainImg' ? null : (els[id] = els[id] || makeEl(id))),   // mainImg missing => its load-watcher is skipped
    createElement: () => makeEl('x'),
    addEventListener() {},
  };
  const calls = { fetch: [], toasts: [] };
  const win = {};
  const ctx = createContext({
    window: win, document, console, setTimeout, clearTimeout, FormData, AbortController, Image: function () {},
    showToast: (m, t) => calls.toasts.push([m, t]),
    fetch: (...a) => { calls.fetch.push(a); return Promise.reject(new Error('no network in unit test')); },
  });
  win.YoApi = require(path.join(root, 'js/config/api-client.js'));
  ctx.window.window = win;
  // The `let portrait...` globals straight from js/core/state.js, plus the two the tests poke.
  const stateLets = read('js/core/state.js').split('\n').filter((l) => /^let (portrait\w+|originalImage)\b/.test(l)).join('\n');
  assert.ok(/portraitCurrentSkin/.test(stateLets), 'state.js no longer declares portraitCurrentSkin');
  vm.runInContext(stateLets, ctx);
  vm.runInContext('function saveToHistory(){} function applyAllEdits(){} var historyStack=[], historyIndex=0, previewCanvas={}, previewCtx={};', ctx);
  vm.runInContext(read('js/portrait/portrait-mode.js'), ctx, { filename: 'portrait-mode.js' });
  const get = (name) => vm.runInContext(name, ctx);
  const set = (name, v) => { ctx.__v = v; vm.runInContext(`${name} = __v`, ctx); };
  return { win, els, calls, get, set, ctx };
}

function slide(env, value) { env.els['portrait-skin-slider'] = Object.assign(env.els['portrait-skin-slider'] || makeEl('portrait-skin-slider'), { value }); env.win.onPortraitSkinInput(); }

test('portrait-mode.js loads and exposes the skin slider handlers', () => {
  const env = load();
  for (const fn of ['onPortraitSkinInput', 'onPortraitSkinChange', 'adjustPortraitSkin', 'onPortraitBlurInput', 'onPortraitTabEnter']) {
    assert.equal(typeof env.win[fn], 'function', fn);
  }
});
test('slider input updates state, label and slider (0..100)', () => {
  const env = load();
  slide(env, '42');
  assert.equal(env.get('portraitCurrentSkin'), 42);
  assert.equal(env.els['v-portrait-skin'].innerText, 42);
});
test('slider input clamps to 0..100 and survives junk', () => {
  const env = load();
  slide(env, '500'); assert.equal(env.get('portraitCurrentSkin'), 100);
  slide(env, '-30'); assert.equal(env.get('portraitCurrentSkin'), 0);
  slide(env, 'abc'); assert.equal(env.get('portraitCurrentSkin'), 0);
  slide(env, '33.7'); assert.equal(env.get('portraitCurrentSkin'), 33);    // parseInt semantics: integers only reach the server
  slide(env, ''); assert.equal(env.get('portraitCurrentSkin'), 0);
});
test('+/- buttons step by delta and clamp at both ends (no photo => no request)', () => {
  const env = load();
  env.win.adjustPortraitSkin(5); env.win.adjustPortraitSkin(5);
  assert.equal(env.get('portraitCurrentSkin'), 10);
  env.win.adjustPortraitSkin(-5); assert.equal(env.get('portraitCurrentSkin'), 5);
  env.win.adjustPortraitSkin(-50); assert.equal(env.get('portraitCurrentSkin'), 0);
  env.win.adjustPortraitSkin(500); assert.equal(env.get('portraitCurrentSkin'), 100);
  assert.equal(env.calls.fetch.length, 0);
});
test('entering the Portrait tab resets blur to 1 and skin to 0', () => {
  const env = load();
  slide(env, '70'); env.set('portraitCurrentBlur', 20);
  env.win.onPortraitTabEnter();
  assert.equal(env.get('portraitCurrentSkin'), 0);
  assert.equal(env.get('portraitCurrentBlur'), 1);
});
test('blur slider clamps to 1..30', () => {
  const env = load();
  env.els['portrait-blur-slider'] = Object.assign(makeEl('portrait-blur-slider'), { value: '99' });
  env.win.onPortraitBlurInput(); assert.equal(env.get('portraitCurrentBlur'), 30);
  env.els['portrait-blur-slider'].value = '-4'; env.win.onPortraitBlurInput(); assert.equal(env.get('portraitCurrentBlur'), 1);
});
test('slider range in index.html matches the backend limits (0..100)', () => {
  const html = read('index.html');
  const m = /<input[^>]*id="portrait-skin-slider"[^>]*>/.exec(html);
  assert.ok(m, 'portrait-skin-slider missing from index.html');
  assert.match(m[0], /min="0"/); assert.match(m[0], /max="100"/);
  const cfg = read('backend/app/config.py');
  assert.match(cfg, /PORTRAIT_MIN_SKIN_SMOOTH\s*=\s*0\b/); assert.match(cfg, /PORTRAIT_MAX_SKIN_SMOOTH\s*=\s*100\b/);
  assert.match(cfg, /PORTRAIT_MIN_BLUR_LEVEL\s*=\s*1\b/); assert.match(cfg, /PORTRAIT_MAX_BLUR_LEVEL\s*=\s*30\b/);
});
test('release with no photo loaded never fires a network request', () => {
  const env = load();
  slide(env, '60');
  env.win.onPortraitSkinChange();
  assert.equal(env.calls.fetch.length, 0);
});

run('skin_slider_test');
