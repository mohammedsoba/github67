// V20 Y1 / Y2: preset thumbnails use the real filter strength; presets no longer stack.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

function load() {
  const sandbox = { console, Math, JSON, Object, Array, setTimeout: (fn) => fn(), clearTimeout,
    window: { t: (k) => k },
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, getContext: () => null }) } };
  createContext(sandbox);
  vm.runInContext(`
    var sliders = { bright:0, contrast:0, exposure:0, shadows:0, whites:0, blacks:0, sat:0, vibrance:0, warmth:0, tint:0, sharp:0, clarity:0, vignette:0, grain:0 };
    var chosenPreset = 'none';
    var allPresets = [
      { id:'none', name:'Original', type:'normal', style:'', thumb:'' },
      { id:'p-warm', name:'W', type:'warm', style:'angelic', thumb:'' },
      { id:'p-cool', name:'C', type:'cool', style:'moon', thumb:'' },
      { id:'p-hdr',  name:'H', type:'hdr',  style:'hdrpop', thumb:'' } ];
    function requireImage(){ return true; } function showLoading(){} function updateLoadingSub(){} function hideLoading(){}
    function showToast(){} function updateSliderUI(){} function applyAllEdits(){} function saveToHistory(){} function renderPresets(){}
    function resetColorEdits(){ for (var k in sliders) sliders[k]=0; chosenPreset='none'; }
  `, sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/editing/presets.js'), 'utf8'), sandbox);
  vm.runInContext('renderPresets = function(){};', sandbox);   // DOM-free: only slider logic is under test here
  return { sandbox, run: (c) => vm.runInContext(c, sandbox) };
}

test('Y1: the thumbnail filter equals the applied filter (no 0.55 dimming)', () => {
  const e = load();
  const src = fs.readFileSync(path.join(__dirname, '../../js/editing/presets.js'), 'utf8');
  const styles = Array.from(new Set((src.match(/case '([a-z0-9]+)':/g) || []).map((m) => m.slice(6, -2))));
  assert.ok(styles.length > 40);
  for (const s of styles) assert.equal(e.run(`getPresetFilter('${s}', true)`), e.run(`getPresetFilter('${s}', false)`), s);
  assert.equal(e.run(`getPresetFilter('angelic', true)`), 'brightness(110%) contrast(95%) saturate(120%) sepia(15%) hue-rotate(-5deg)');
});

test('Y1: thumbnails are built from the unedited photo, never from mainImg.src', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../js/editing/presets.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderPresets()'), src.indexOf('function getPresetFilter'));
  assert.ok(!/mainImg/.test(fn), 'renderPresets must not read mainImg');
  assert.match(src, /getPresetThumbUrl/);
  assert.match(src, /originalImage\.src/);
});

test('Y2: applying preset B removes everything preset A set (no stacking)', () => {
  const e = load();
  e.run(`applyPreset('p-warm');`);       // warm: warmth 25, sat 15, contrast 5
  assert.equal(e.run('sliders.warmth'), 25);
  e.run(`applyPreset('p-hdr');`);        // hdr: contrast 25, sat 35, vibrance 30, clarity 20
  assert.equal(e.run('sliders.warmth'), 0, 'warm residue gone');
  assert.equal(e.run('sliders.sat'), 35);
  e.run(`applyPreset('p-cool');`);       // cool: warmth -20, sat 10, contrast 10
  assert.deepEqual(JSON.parse(e.run(`JSON.stringify({w:sliders.warmth,s:sliders.sat,c:sliders.contrast,v:sliders.vibrance,cl:sliders.clarity})`)),
    { w: -20, s: 10, c: 10, v: 0, cl: 0 });
});

test('Y2: other manual sliders (not owned by a preset) are kept', () => {
  const e = load();
  e.run(`sliders.exposure = 12; applyPreset('p-warm'); applyPreset('p-cool');`);
  assert.equal(e.run('sliders.exposure'), 12);
});

run('presets_test');
