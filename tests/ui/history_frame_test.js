// V19 R6 / R8 / R9: frame state in history, history reset on new upload, undo vs pending debounce.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

function makeEnv() {
  const revoked = [];
  const mainImg = { src: '' };
  const sandbox = {
    console, Map, Set, JSON, Math, Promise, Object, setTimeout, clearTimeout,
    navigator: { deviceMemory: 8 },
    URL: { revokeObjectURL: (u) => revoked.push(u), createObjectURL: () => 'blob:x' },
    document: { getElementById: (id) => (id === 'mainImg' ? mainImg : (id === 'undoBtn' ? { style: {} } : null)) },
    window: {},
  };
  createContext(sandbox);
  vm.runInContext(`
    let historyStack = [], historyIndex = -1; const maxHistory = 20;
    let originalImage = null, originalForCompare = null, previewCanvas = { width: 100, height: 50 };
    let sliders = { exposure: 0 }, chosenPreset = 'none', colorMixData = {}, curvesData = {}, cropRatio = 'free', fitMode = 'normal';
    const overlayManager = { items: [], selectedId: null, render(){}, updatePanels(){} };
    const FRAME_DEFS = [{ id: 'none' }, { id: 'gold' }, { id: 'neon' }];
    var activeFrameId = 'none', activeFrameCat = 'all';
    var frameControls = { thickness: 20, radius: 0, shadow: 0, padding: 0, useCustomColor: false, customColor: '#ffffff' };
    var containerCss = 'x';
    function _findFrame(id){ return FRAME_DEFS.find(f => f.id === id) || null; }
    function _applyFitContainer(m){ containerCss = m; }
    function _setSliderAndLabel(){} function renderFrameGrid(){} function _frameSupportsCustomColor(){ return true; } function _setFrameImageRadius(){}
    function updateSliderUI(){} function renderPresets(){} function renderColorMix(){} function buildCurvesLUTs(){}
    function applyAllEdits(){}`, sandbox);
  const root = path.join(__dirname, '../..');
  vm.runInContext(fs.readFileSync(path.join(root, 'js/core/history.js'), 'utf8'), sandbox);
  // only the frame STATE helpers from fit-frame.js (the rest needs a full DOM)
  const ff = fs.readFileSync(path.join(root, 'js/editing/fit-frame.js'), 'utf8');
  const a = ff.indexOf('// ===================== FRAME STATE (history / reset)');
  const b = ff.indexOf('// ===================== NEW FRAME FUNCTIONS');
  vm.runInContext(ff.slice(a, b), sandbox);
  const set = (c) => vm.runInContext(c, sandbox);
  const get = (c) => vm.runInContext(c, sandbox);
  return { sandbox, revoked, set, get };
}
function commit(env, url) {
  env.sandbox.__u = url;
  env.set(`registerImageUrl(__u, 1000); originalImage = { src: __u, naturalWidth: 10, naturalHeight: 10 }; saveToHistory();`);
}

test('R6: frame id + controls are stored in every history state and restored on undo', () => {
  const e = makeEnv();
  commit(e, 'blob:a');                                   // state 0: no frame
  e.set(`activeFrameId = 'gold'; fitMode = 'gold'; frameControls.thickness = 40; saveToHistory();`);   // state 1
  e.set(`frameControls.thickness = 55; saveToHistory();`);                                             // state 2
  assert.equal(e.get('historyStack[1].frame.id'), 'gold');
  assert.equal(e.get('historyStack[1].frame.controls.thickness'), 40);
  e.set('undoEdit();');
  assert.equal(e.get('frameControls.thickness'), 40, 'control restored');
  assert.equal(e.get('activeFrameId'), 'gold');
  e.set('undoEdit();');
  assert.equal(e.get('activeFrameId'), 'none', 'frame removed by undo, so export reads "none" too');
});

test('R6: resetFrameState clears id, controls and container CSS (new photo / reset all)', () => {
  const e = makeEnv();
  e.set(`activeFrameId = 'neon'; fitMode = 'neon'; frameControls.thickness = 33; frameControls.useCustomColor = true;`);
  e.set('resetFrameState();');
  assert.equal(e.get('activeFrameId'), 'none');
  assert.equal(e.get('fitMode'), 'normal');
  assert.equal(e.get('frameControls.thickness'), 20);
  assert.equal(e.get('frameControls.useCustomColor'), false);
});

test('R8: resetHistory empties the stack, revokes the old photo blobs and disables undo', () => {
  const e = makeEnv();
  commit(e, 'blob:old1'); commit(e, 'blob:old2');
  assert.equal(e.get('historyStack.length'), 2);
  commit(e, 'blob:new');                                 // the new photo is now on screen
  e.set('resetHistory();');
  assert.equal(e.get('historyStack.length'), 0);
  assert.equal(e.get('historyIndex'), -1);
  assert.ok(e.revoked.includes('blob:old1') && e.revoked.includes('blob:old2'), 'old blobs revoked');
  assert.ok(!e.revoked.includes('blob:new'), 'on-screen image kept');
  e.set('saveToHistory();');
  e.set('undoEdit();');                                  // nothing to go back to
  assert.equal(e.get('historyIndex'), 0);
});

test('R9: undo right after a slider edit undoes exactly that edit (pending save flushed first)', () => {
  const e = makeEnv();
  commit(e, 'blob:p');                                   // state 0: exposure 0
  e.set('sliders.exposure = 40; scheduleHistorySave();');   // edit pending in the 650 ms debounce
  assert.notEqual(e.get('_historyDebounceTimer'), null);
  e.set('undoEdit();');
  assert.equal(e.get('sliders.exposure'), 0, 'edit undone');
  assert.equal(e.get('_historyDebounceTimer'), null, 'timer cancelled - no stray entry later');
  assert.equal(e.get('historyStack.length'), 2, 'flushed edit is a real step');
  assert.equal(e.get('historyIndex'), 0);
});

run('history_frame_test');
setTimeout(() => process.exit(process.exitCode || 0), 50);   // pending timers must not keep the test alive
