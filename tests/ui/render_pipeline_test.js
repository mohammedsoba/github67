// V19 R1-R5: shared render pipeline (filter maths, curves/colour-mix predicates, CPU order, no Color Mix averaging).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

function load() {
  const sandbox = { console, Math, JSON, Uint8Array, Uint8ClampedArray, Float32Array, Object, Array, Promise,
    document: { createElement() { return { getContext() { return null; } }; }, getElementById() { return null; } } };
  createContext(sandbox);
  vm.runInContext(`
    const sliders = { bright:0, contrast:0, exposure:0, shadows:0, whites:0, blacks:0, sat:0, vibrance:0, warmth:0, tint:0, sharp:0, clarity:0, vignette:0, grain:0 };
    let chosenPreset = 'none';
    let colorMixData = [0,1,2,3,4,5,6,7].map(() => ({ hue:0, sat:0, lum:0 }));
    let curvesData = {};
    const curvesLUT = {};
    const allPresets = [{ id:'none', style:'' }, { id:'moon', style:'moon' }];
    var originalImage = null;
  `, sandbox);
  const root = path.join(__dirname, '../..');
  for (const f of ['js/editing/curves.js', 'js/editing/presets.js', 'js/editing/sliders.js', 'js/editing/effects.js',
                   'js/editing/color-mix-apply.js', 'js/core/render-pipeline.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox);
  }
  vm.runInContext(`
    function defaults(){ return [{x:0,y:0},{x:64,y:64},{x:128,y:128},{x:192,y:192},{x:255,y:255}]; }
    curvesData = { rgb: defaults(), red: defaults(), green: defaults(), blue: defaults() };
    buildCurvesLUTs();
  `, sandbox);
  return { sandbox, run: (c) => vm.runInContext(c, sandbox) };
}

test('nothing active by default', () => {
  const e = load();
  assert.equal(e.run('YoPipeline.needsPixelPass()'), false);
  assert.equal(e.run('YoPipeline.needsBake()'), false);
});

test('R2: editing ONLY the red / green / blue curve is detected', () => {
  for (const ch of ['red', 'green', 'blue']) {
    const e = load();
    e.run(`curvesData.${ch}[2].y = 170; buildCurvesLUTs();`);
    assert.equal(e.run('YoPipeline.curvesActive()'), true, ch);
    assert.equal(e.run('YoPipeline.needsPixelPass()'), true, ch);
  }
});

test('R2: a tiny edit between the old 4 sample points is detected; restoring defaults clears it', () => {
  const e = load();
  e.run('curvesData.rgb[1].y = 70; buildCurvesLUTs();');   // moves the 64 point, LUT[32] changes too
  assert.equal(e.run('YoPipeline.curvesActive()'), true);
  e.run('curvesData.rgb[1].y = 64; buildCurvesLUTs();');
  assert.equal(e.run('YoPipeline.curvesActive()'), false);
});

test('R1: Color Mix alone activates the pixel pass (preview and export share the predicate)', () => {
  const e = load();
  e.run('colorMixData[3].hue = 20;');
  assert.equal(e.run('YoPipeline.colorMixActive()'), true);
  assert.equal(e.run('YoPipeline.needsPixelPass()'), true);
  assert.equal(e.run('YoPipeline.needsBake()'), true);
});

test('R3: Color Mix no longer adds a global hue-rotate / saturate to the CSS filter chain', () => {
  const e = load();
  e.run('colorMixData[0].hue = 100; colorMixData[0].sat = 100;');
  assert.equal(e.run('buildCSSFilter()'), '');
  assert.deepEqual(Array.from(e.run('YoPipeline.currentEditState().filterSteps')), []);
  // but the selective mix data does reach the shader state
  assert.equal(e.run('YoPipeline.currentEditState().mix[0]'), 100);
});

test('R4/R5: CSS filter chain -> colour matrices matches the W3C definitions', () => {
  const e = load();
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  const s = e.run(`YoFilterMath.cssFilterToSteps('brightness(110%) contrast(120%)')`);
  assert.equal(s.length, 2);
  near(s[0].m[0], 1.1); near(s[1].m[4], 1.2); near(s[1].o[0], 0.5 - 0.6);
  const sep = e.run(`YoFilterMath.cssFilterToSteps('sepia(100%)')`)[0];
  near(sep.m[0], 0.393); near(sep.m[4], 0.686); near(sep.m[8], 0.131);
  const gray = e.run(`YoFilterMath.cssFilterToSteps('grayscale(100%)')`)[0];
  near(gray.m[0], 0.2126); near(gray.m[1], 0.7152);
  const hue0 = e.run(`YoFilterMath.cssFilterToSteps('hue-rotate(0deg)')`)[0];
  near(hue0.m[0], 1); near(hue0.m[1], 0); near(hue0.m[4], 1);
  assert.equal(e.run(`YoFilterMath.cssFilterToSteps('blur(3px) opacity(50%)')`).length, 0);
});

test('R4/R5: every preset filter is expressible as matrix steps (nothing needs ctx.filter)', () => {
  const root = path.join(__dirname, '../..');
  const src = fs.readFileSync(path.join(root, 'js/editing/presets.js'), 'utf8');
  const e = load();
  const styles = Array.from(new Set((src.match(/case '([a-z0-9]+)':/g) || []).map((m) => m.slice(6, -2))));
  assert.ok(styles.length > 40);
  for (const st of styles) {
    const css = e.run(`getPresetFilter('${st}', false)`);
    if (!css) continue;
    const ops = e.run(`YoFilterMath.parseOps(${JSON.stringify(css)})`).length;
    const steps = e.run(`YoFilterMath.cssFilterToSteps(${JSON.stringify(css)})`).length;
    assert.equal(steps, ops, st);
    assert.ok(steps <= 12, st);
  }
});

test('R4: CPU path applies filter steps and keeps alpha untouched', () => {
  const e = load();
  const data = new Uint8ClampedArray([200, 100, 50, 77,   10, 20, 30, 0]);
  e.sandbox.__d = data;
  e.run(`YoFilterMath.applySteps(__d, YoFilterMath.cssFilterToSteps('brightness(50%)'));`);
  assert.deepEqual(Array.from(data), [100, 50, 25, 77, 5, 10, 15, 0]);
});

test('R4: CPU vignette is UV-based (identical to the shader) - mid-edge of a wide image is not darker than a corner', () => {
  const e = load();
  const w = 60, h = 20, data = new Uint8ClampedArray(w * h * 4).fill(200);
  e.sandbox.__d = data;
  e.run(`applyFastVignette(__d, ${w}, ${h}, -100);`);
  const px = (x, y) => data[(y * w + x) * 4];
  assert.ok(px(0, 0) <= px(w - 1, h >> 1), 'corner darker than left-edge midpoint');
  assert.ok(px(w >> 1, h >> 1) > px(0, 0));
});

test('R4: CPU grain is deterministic (same pattern every run)', () => {
  const e = load();
  const mk = () => { const d = new Uint8ClampedArray(16 * 16 * 4).fill(128); e.sandbox.__d = d; e.run('applyFastGrain(__d, 16, 16, 60);'); return Array.from(d); };
  assert.deepEqual(mk(), mk());
});

run('render_pipeline_test');
