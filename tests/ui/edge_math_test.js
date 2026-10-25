// portrait-math.js (DOM-free depth-of-field maths for the on-device path): real module, plain Node, synthetic images.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, run, assert } = require('./_harness');

const M = (0, eval)(fs.readFileSync(path.join(__dirname, '../../js/portrait/portrait-math.js'), 'utf8') + ';YoPortraitMath');

// Synthetic portrait: a near, warm disc ("subject") on a far, patterned background.
function scene(W, H) {
  const rgba = new Uint8ClampedArray(W * H * 4), depth = new Float32Array(W * H);
  const r = Math.min(W, H) * 0.25;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, inside = (x - W / 2) ** 2 + (y - H / 2) ** 2 < r * r;
    depth[i] = inside ? 0.9 : 0.2;
    const c = (((x >> 3) + (y >> 3)) & 1) ? 200 : 60;
    rgba[i * 4] = inside ? 220 : c; rgba[i * 4 + 1] = inside ? 150 : c; rgba[i * 4 + 2] = inside ? 120 : 255 - c; rgba[i * 4 + 3] = 255;
  }
  return { rgba, depth };
}

test('toTensor: NCHW layout with ImageNet mean/std', () => {
  const px = new Uint8ClampedArray([255, 0, 128, 255, 0, 255, 0, 255]);        // 2 pixels (size 1x2 is enough: n = size*size)
  const t = M.toTensor(new Uint8ClampedArray([255, 0, 128, 255]), 1);
  assert.equal(t.length, 3);
  assert.ok(Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(t[1] - (0 - 0.456) / 0.224) < 1e-5);
  assert.ok(Math.abs(t[2] - (128 / 255 - 0.406) / 0.225) < 1e-5);
  void px;
});

test('normalizeDepth: stretches to 0..1, ignores extreme outliers, rejects non-finite values', () => {
  const d = new Float32Array(1000); for (let i = 0; i < 1000; i++) d[i] = i / 999 * 10 + 5;
  d[0] = -1e6; d[999] = 1e6;
  const n = M.normalizeDepth(d);
  assert.ok(n.every((v) => v >= 0 && v <= 1));
  assert.ok(n[500] > 0.4 && n[500] < 0.6, 'the middle stays in the middle despite the outliers');
  assert.throws(() => M.normalizeDepth(new Float32Array([1, NaN, 3])), /non-finite/);
});

test('resize: constants survive, 2x area average is exact, bilinear keeps the range', () => {
  const flat = new Float32Array(8 * 6).fill(0.5);
  assert.ok(M.resizeBilinear(flat, 8, 6, 1, 3, 5).every((v) => Math.abs(v - 0.5) < 1e-6));
  assert.ok(M.resizeArea(flat, 8, 6, 1, 4, 3).every((v) => Math.abs(v - 0.5) < 1e-6));
  const img = Float32Array.from([1, 3, 5, 7, 2, 4, 6, 8, 10, 20, 30, 40, 11, 21, 31, 41]);   // 4x4
  const half = M.resizeArea(img, 4, 4, 1, 2, 2);
  assert.deepEqual(Array.from(half), [(1 + 3 + 2 + 4) / 4, (5 + 7 + 6 + 8) / 4, (10 + 20 + 11 + 21) / 4, (30 + 40 + 31 + 41) / 4]);
  const four = M.resizeArea(Float32Array.from({ length: 16 }, (_, i) => i), 4, 4, 4, 1, 1);   // 4 channels, 2x2 px each... shape check only
  assert.equal(four.length, 4);
});

test('boxFilter equals the brute-force clamped-window mean', () => {
  const w = 9, h = 7, r = 2, src = Float32Array.from({ length: w * h }, (_, i) => (i * 37) % 11);
  const out = M.boxFilter(src, w, h, 1, r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += src[yy * w + xx]; n++; }
    assert.ok(Math.abs(out[y * w + x] - s / n) < 1e-4, `(${x},${y})`);
  }
});

test('focusRegion: 4-connected region of the tap; a tap on a hole snaps to the nearest candidate', () => {
  const w = 10, h = 4, delta = new Float32Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < 4; x++) delta[y * w + x] = 0;           // left block is "in focus"
  delta[1 * w + 8] = 0;                                                                     // an isolated speck, not connected
  let region = M.focusRegion(delta, w, h, 0.0, 0.5, 0.2);
  assert.equal(region[1 * w + 8], 0, 'the unconnected speck is excluded');
  assert.equal(region[0], 1);
  region = M.focusRegion(delta, w, h, 0.55, 0.5, 0.2);                                       // tap on the far/blurred area
  assert.equal(region[1 * w + 3], 1, 'snapped to the nearest in-focus pixel and flooded from there');
});

test('computeMask: subject stays sharp, far background is blurred, values stay in 0..1', () => {
  const W = 160, H = 120, { rgba, depth } = scene(W, H);
  const mask = M.computeMask(depth, rgba, W, H, 0.5, 0.5);
  assert.equal(mask.length, W * H);
  assert.ok(mask.every((v) => v >= 0 && v <= 1));
  assert.ok(mask[(H / 2) * W + W / 2] > 0.97, 'subject centre is kept sharp');
  assert.ok(mask[3 * W + 3] < 0.25, 'far corner is blurred');
});

test('computeMask: tapping the BACKGROUND flips the focal plane (the subject becomes the blurred part)', () => {
  const W = 160, H = 120, { rgba, depth } = scene(W, H);
  const mask = M.computeMask(depth, rgba, W, H, 0.03, 0.05);
  assert.ok(mask[3 * W + 3] > 0.9, 'tapped plane stays sharp');
  assert.ok(mask[(H / 2) * W + W / 2] < 0.4, 'the near subject is now defocused');
});

test('composite: level 1 -> null (untouched); subject pixels are bit-identical; background changes; alpha is preserved', () => {
  const W = 160, H = 120, { rgba, depth } = scene(W, H);
  rgba[(5 * W + 5) * 4 + 3] = 77;                                                         // a semi-transparent pixel
  const mask = M.computeMask(depth, rgba, W, H, 0.5, 0.5);
  assert.equal(M.composite(rgba, W, H, rgba, W, H, mask, W, H, 1), null);
  const out = M.composite(rgba, W, H, rgba, W, H, mask, W, H, 20);
  assert.equal(out.length, W * H * 4);
  const c = ((H / 2) * W + W / 2) * 4;
  for (let k = 0; k < 4; k++) assert.equal(out[c + k], rgba[c + k], 'subject untouched');
  let changed = 0;
  for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) if (out[i * 4 + k] !== rgba[i * 4 + k]) { changed++; break; }
  assert.ok(changed > W * H * 0.3, 'a large part of the background is blurred');
  assert.equal(out[(5 * W + 5) * 4 + 3], 77, 'alpha channel is copied verbatim');
});

test('composite: a higher level blurs more (mean absolute change grows with the aperture)', () => {
  const W = 160, H = 120, { rgba, depth } = scene(W, H);
  const mask = M.computeMask(depth, rgba, W, H, 0.5, 0.5);
  const delta = (lvl) => { const o = M.composite(rgba, W, H, rgba, W, H, mask, W, H, lvl); let s = 0; for (let i = 0; i < o.length; i++) s += Math.abs(o[i] - rgba[i]); return s; };
  const a = delta(6), b = delta(14), c = delta(30);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
});

test('composite: separate bokeh work copy (smaller than the source) gives the same result shape and keeps the subject exact', () => {
  const W = 200, H = 150, { rgba, depth } = scene(W, H);
  const mask = M.computeMask(depth, rgba, W, H, 0.5, 0.5);
  const sw = 100, sh = 75;
  const small = Uint8ClampedArray.from(M.resizeArea(Float32Array.from(rgba), W, H, 4, sw, sh));
  const out = M.composite(rgba, W, H, small, sw, sh, mask, W, H, 25);
  assert.equal(out.length, W * H * 4);
  const c = ((H / 2) * W + W / 2) * 4;
  for (let k = 0; k < 3; k++) assert.equal(out[c + k], rgba[c + k]);
});

test('strengthFor mirrors the server mapping (level 1 -> 0, level 30 -> 30)', () => {
  assert.equal(M.strengthFor(1), 0);
  assert.equal(M.strengthFor(30), 30);
  assert.ok(Math.abs(M.strengthFor(2) - 30 / 29) < 1e-9);
  assert.equal(M.strengthFor(99), 30);
});

run('edge_math_test');
