// P1.2 - history image bookkeeping: refcounts, byte budget, blob revocation, undo.
// Loads the real js/core/history.js into a vm sandbox with minimal browser stubs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const MB = 1024 * 1024;

function makeEnv(deviceMemory) {
  const revoked = [];
  const mainImg = { src: '' };
  const sandbox = {
    console, Map, Set, JSON, Math, Promise, setTimeout, clearTimeout,
    navigator: { deviceMemory },
    URL: { revokeObjectURL: (u) => revoked.push(u), createObjectURL: () => 'blob:x' },
    document: { getElementById: (id) => (id === 'mainImg' ? mainImg : null) },
    window: {},
  };
  createContext(sandbox);
  // state.js globals (top-level `let` in a classic script is shared across scripts in a context)
  vm.runInContext(`
    let historyStack = [], historyIndex = -1; const maxHistory = 20;
    let originalImage = null, originalForCompare = null, previewCanvas = { width: 100, height: 50 };
    let sliders = { exposure: 0 }, chosenPreset = null, colorMixData = {}, curvesData = {}, cropRatio = 'free', fitMode = 'fit';
    const overlayManager = { items: [], selectedId: null, render(){}, updatePanels(){} };
    function updateSliderUI(){} function renderPresets(){} function renderColorMix(){} function buildCurvesLUTs(){}
    function applyAllEdits(){} function _applyFitContainer(){}`, sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/core/history.js'), 'utf8'), sandbox);
  const get = (e) => vm.runInContext(e, sandbox);
  const set = (code) => vm.runInContext(code, sandbox);
  return { sandbox, revoked, mainImg, get, set };
}
// switch the "on-screen" image like a producer does, then save a history entry
function commit(env, url, bytes) {
  env.sandbox.__u = url; env.sandbox.__b = bytes;
  env.set(`registerImageUrl(__u, __b); originalImage = { src: __u, naturalWidth: 10, naturalHeight: 10 }; saveToHistory();`);
}

test('budget: 150MB on low-end (<=4GB) and 200MB on high-end devices (V24: lossless PNG history)', () => {
  assert.equal(makeEnv(4).get('MAX_HISTORY_BYTES'), 150 * MB);
  assert.equal(makeEnv(2).get('MAX_HISTORY_BYTES'), 150 * MB);
  assert.equal(makeEnv(8).get('MAX_HISTORY_BYTES'), 200 * MB);
  assert.equal(makeEnv(undefined).get('MAX_HISTORY_BYTES'), 150 * MB);   // unknown => safe default
});

test('_imageBytes decodes data: URLs and prefers registered sizes', () => {
  const env = makeEnv(8);
  const b64 = Buffer.alloc(3000).toString('base64');
  env.sandbox.__d = 'data:image/png;base64,' + b64;
  assert.equal(env.get('_imageBytes(__d)'), 3000);
  env.set(`registerImageUrl('blob:a', 12345)`);
  assert.equal(env.get(`_imageBytes('blob:a')`), 12345);
});

test('slider edits share one image reference: bytes are not duplicated', () => {
  const env = makeEnv(8);
  commit(env, 'blob:base', 5 * MB);
  for (let i = 0; i < 10; i++) env.set('saveToHistory()');       // same originalImage.src each time
  assert.equal(env.get('historyStack.length'), 11);
  assert.equal(env.get('_historyBytes()'), 5 * MB);
  assert.equal(env.get(`_imageUrlRefs.get('blob:base')`), 11);
  assert.deepEqual(env.revoked, []);
});

test('maxHistory cap releases the oldest image and revokes its blob exactly once', () => {
  const env = makeEnv(8);
  for (let i = 0; i < 22; i++) commit(env, 'blob:img' + i, 1 * MB);
  assert.equal(env.get('historyStack.length'), 20);
  assert.equal(env.get('historyIndex'), 19);
  assert.deepEqual(env.revoked, ['blob:img0', 'blob:img1']);
  assert.equal(env.get(`_imageUrlRefs.has('blob:img0')`), false);
});

test('byte budget drops oldest states but always keeps the two newest', () => {
  const env = makeEnv(4);                                          // 150MB budget (V24)
  for (let i = 0; i < 10; i++) commit(env, 'blob:big' + i, 60 * MB);   // 600MB offered
  assert.ok(env.get('_historyBytes()') <= 150 * MB, 'over budget: ' + env.get('_historyBytes()'));
  assert.equal(env.get('historyStack.length'), 2);
  assert.equal(env.get('historyIndex'), 1);
  assert.equal(env.get('historyStack[1].originalImageSrc'), 'blob:big9');
  assert.equal(env.revoked.length, 8);
  // a single oversized image never empties the history
  commit(env, 'blob:huge', 500 * MB);
  assert.equal(env.get('historyStack.length'), 2);
});

test('the on-screen image is revoked only after nothing displays it', () => {
  const env = makeEnv(8);
  commit(env, 'blob:a', MB);
  commit(env, 'blob:b', MB);
  // make 'a' the displayed image again while history drops it (budget squeeze)
  env.set(`originalImage = { src: 'blob:a' }`);
  env.set(`_releaseState(historyStack.shift()); historyIndex--;`);
  assert.deepEqual(env.revoked, [], 'still on screen: must not be revoked');
  assert.equal(env.get(`_pendingRevoke.has('blob:a')`), true);
  env.set(`originalImage = { src: 'blob:b' }; _sweepPendingRevokes();`);
  assert.deepEqual(env.revoked, ['blob:a']);
});

test('Compare original and eraser-held URLs are protected from revocation', () => {
  const env = makeEnv(8);
  commit(env, 'blob:orig', MB);
  env.set(`originalForCompare = { src: 'blob:orig' }`);
  env.sandbox.window.MagicEraser = { getHeldUrls: () => ['blob:held'] };
  commit(env, 'blob:held', MB);
  for (let i = 0; i < 21; i++) commit(env, 'blob:n' + i, 1000);
  assert.ok(!env.revoked.includes('blob:orig'));
  assert.ok(!env.revoked.includes('blob:held'));
});

test('redo tail is released when a new action branches history', () => {
  const env = makeEnv(8);
  commit(env, 'blob:1', MB); commit(env, 'blob:2', MB); commit(env, 'blob:3', MB);
  env.set('historyIndex = 0');                                     // as if undone twice
  env.set(`originalImage = { src: 'blob:1' }`);                    // image currently shown = state 0
  commit(env, 'blob:4', MB);                                       // new branch
  assert.equal(env.get('historyStack.length'), 2);
  assert.deepEqual(env.revoked.sort(), ['blob:2', 'blob:3']);
});

test('_dropHistoryTop (portrait refinement) releases the replaced result', () => {
  const env = makeEnv(8);
  commit(env, 'blob:base', MB); commit(env, 'blob:portrait1', MB);
  env.set(`originalImage = { src: 'blob:base' }`);                 // portrait1 no longer displayed
  env.set('_dropHistoryTop()');
  assert.deepEqual(env.revoked, ['blob:portrait1']);
  assert.equal(env.get('historyIndex'), 0);
});

test('undo restores the exact image URL (no revoked blob) across 10 erases + 5 crops', async () => {
  const env = makeEnv(8);
  const loaded = [];
  env.sandbox.Image = function () { const im = this; Object.defineProperty(im, 'src', { set(v) { im._s = v; loaded.push(v); setTimeout(() => im.onload && im.onload(), 0); }, get() { return im._s; } }); };
  env.sandbox.Image.prototype = {};
  commit(env, 'blob:orig', 4 * MB);
  for (let i = 0; i < 10; i++) commit(env, 'blob:erase' + i, 12 * MB);
  for (let i = 0; i < 5; i++) commit(env, 'blob:crop' + i, 3 * MB);
  assert.ok(env.get('_historyBytes()') <= 160 * MB);
  const live = new Set(env.get('Array.from(_imageUrlRefs.keys())'));
  // walk all the way back; every URL we load must still be live (never revoked)
  const depth = env.get('historyIndex');
  for (let i = 0; i < depth; i++) {
    env.set('undoEdit()');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(loaded.length > 0);
  for (const u of loaded) assert.ok(!env.revoked.includes(u), 'undo loaded a revoked blob: ' + u);
  assert.equal(env.get('historyIndex'), 0);
  assert.equal(env.get('originalImage.src'), env.get('historyStack[0].originalImageSrc'));
  assert.ok(live.has(env.get('originalImage.src')));
});

run('history_memory');
