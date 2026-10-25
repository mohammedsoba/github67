// erase_window_test.js - js/editing/erase-window.js (pure logic, plain node).
// Besides the unit cases it cross-checks the JS window maths against the REAL backend constants
// parsed from backend/app/lama.py + config.py, so the two sides cannot drift apart silently.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, run, assert } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const EW = require(path.join(root, 'js/editing/erase-window.js'));

function pyConst(file, name) {
  const m = new RegExp('^' + name + '\\s*=\\s*(\\d+)', 'm').exec(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.ok(m, `constant ${name} not found in ${file}`);
  return Number(m[1]);
}
const CONTEXT_MIN_PX = pyConst('backend/app/lama.py', 'CONTEXT_MIN_PX');
const MIN_CROP_SIDE = pyConst('backend/app/lama.py', 'MIN_CROP_SIDE');
const MODEL_SIZE = pyConst('backend/app/config.py', 'MODEL_SIZE');

// Port of backend lama.py crop_side()/window geometry (kept literal on purpose).
function serverCrop(bb, W, H) {
  const grow = Math.max(2, Math.round(Math.max(W, H) / 400));
  const x0 = Math.max(0, bb.x - grow), y0 = Math.max(0, bb.y - grow);
  const x1 = Math.min(W, bb.x + bb.w + grow), y1 = Math.min(H, bb.y + bb.h + grow);
  const span = Math.max(x1 - x0, y1 - y0);
  const context = Math.max(CONTEXT_MIN_PX, Math.floor((span * 3 + 4) / 5));
  const side = Math.min(Math.max(span + 2 * context, MIN_CROP_SIDE), MODEL_SIZE * 2);
  const cx = Math.floor((x0 + x1) / 2), cy = Math.floor((y0 + y1) / 2);
  const left = cx - Math.floor(side / 2), top = cy - Math.floor(side / 2);
  return { left, top, right: left + side, bottom: top + side };
}

function rgba(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paint(x, y)) d[(y * w + x) * 4] = 255;
  return d;
}

test('findBBox: tight box around painted pixels', () => {
  const d = rgba(20, 10, (x, y) => x >= 5 && x <= 8 && y >= 2 && y <= 6);
  assert.deepEqual(EW.findBBox(d, 20, 10), { x: 5, y: 2, w: 4, h: 5 });
});
test('findBBox: single pixel', () => {
  assert.deepEqual(EW.findBBox(rgba(8, 8, (x, y) => x === 7 && y === 0), 8, 8), { x: 7, y: 0, w: 1, h: 1 });
});
test('findBBox: threshold is strictly > 127 (127 is NOT painted, 128 is)', () => {
  const d = new Uint8ClampedArray(4 * 4 * 4);
  d[0] = 127;
  assert.equal(EW.findBBox(d, 4, 4), null);
  d[0] = 128;
  assert.deepEqual(EW.findBBox(d, 4, 4), { x: 0, y: 0, w: 1, h: 1 });
});
test('findBBox: empty / unusable input -> null', () => {
  assert.equal(EW.findBBox(new Uint8ClampedArray(64), 4, 4), null);
  assert.equal(EW.findBBox(null, 4, 4), null);
  assert.equal(EW.findBBox(new Uint8ClampedArray(64), 0, 4), null);
  assert.equal(EW.findBBox(new Uint8ClampedArray(64), NaN, 4), null);
});
test('findBBox: short buffer never read out of bounds', () => {
  const d = rgba(10, 10, () => true).subarray(0, 10 * 4 * 3);   // only 3 rows present
  assert.deepEqual(EW.findBBox(d, 10, 10), { x: 0, y: 0, w: 10, h: 3 });
});

test('windowFromBBox: invalid bbox / photo -> null', () => {
  assert.equal(EW.windowFromBBox(null, 100, 100), null);
  assert.equal(EW.windowFromBBox({ x: 1, y: 1, w: 0, h: 5 }, 100, 100), null);
  assert.equal(EW.windowFromBBox({ x: NaN, y: 1, w: 5, h: 5 }, 100, 100), null);
  assert.equal(EW.windowFromBBox({ x: 1, y: 1, w: 5, h: 5 }, 0, 100), null);
  assert.equal(EW.windowFromBBox({ x: 500, y: 500, w: 5, h: 5 }, 100, 100), null);   // fully outside
});
test('windowFromBBox: partly outside bbox is clamped, result is valid', () => {
  const win = EW.windowFromBBox({ x: -20, y: 90, w: 60, h: 60 }, 100, 100);
  assert.ok(EW.isValidWindow(win, 100, 100), JSON.stringify(win));
});
test('windowFromBBox: refSize is the longest photo side', () => {
  assert.equal(EW.windowFromBBox({ x: 10, y: 10, w: 10, h: 10 }, 1600, 900).refSize, 1600);
});
test('windowFromBBox: whole-photo hole gives the whole photo', () => {
  const win = EW.windowFromBBox({ x: 0, y: 0, w: 300, h: 200 }, 300, 200);
  assert.deepEqual([win.x, win.y, win.w, win.h], [0, 0, 300, 200]);
});

test('window ALWAYS contains the server square crop (JS <-> lama.py parity)', () => {
  const photos = [[300, 200], [1024, 768], [4000, 3000], [3000, 4000], [512, 512], [64, 48]];
  let checked = 0;
  for (const [W, H] of photos) {
    for (const bs of [1, 3, 17, 40, 120, 333, 700, 2500]) {
      for (const [fx, fy] of [[0, 0], [0.5, 0.5], [1, 1], [0.1, 0.9], [0.95, 0.05]]) {
        const w = Math.min(bs, W), h = Math.min(Math.max(1, Math.round(bs * 0.6)), H);
        const bb = { x: Math.round((W - w) * fx), y: Math.round((H - h) * fy), w, h };
        const win = EW.windowFromBBox(bb, W, H);
        assert.ok(EW.isValidWindow(win, W, H), `invalid window ${JSON.stringify(win)} for ${W}x${H} ${JSON.stringify(bb)}`);
        const c = serverCrop(bb, W, H);
        // Only the part of the crop that lies inside the photo has to be inside the window.
        assert.ok(win.x <= Math.max(0, c.left), `left ${W}x${H} ${JSON.stringify(bb)}`);
        assert.ok(win.y <= Math.max(0, c.top), `top ${W}x${H} ${JSON.stringify(bb)}`);
        assert.ok(win.x + win.w >= Math.min(W, c.right), `right ${W}x${H} ${JSON.stringify(bb)}`);
        assert.ok(win.y + win.h >= Math.min(H, c.bottom), `bottom ${W}x${H} ${JSON.stringify(bb)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test('isValidWindow rejects bad windows', () => {
  const ok = { x: 0, y: 0, w: 10, h: 10, refSize: 100 };
  assert.ok(EW.isValidWindow(ok, 100, 100));
  assert.ok(!EW.isValidWindow(null, 100, 100));
  assert.ok(!EW.isValidWindow({ ...ok, x: -1 }, 100, 100));
  assert.ok(!EW.isValidWindow({ ...ok, w: 0 }, 100, 100));
  assert.ok(!EW.isValidWindow({ ...ok, w: 101 }, 100, 100));
  assert.ok(!EW.isValidWindow({ ...ok, x: 1.5 }, 100, 100));
  assert.ok(!EW.isValidWindow({ ...ok, refSize: 5 }, 100, 100));
});

// ---- selection-size guard (client half of the 1024 px limit; the server enforces the same limit as a backstop) ----
test('MAX_SELECTION_WIDTH equals the backend ERASE_MAX_SELECTION_WIDTH (client and server cannot drift apart)', () => {
  assert.equal(EW.MAX_SELECTION_WIDTH, pyConst('backend/app/config.py', 'ERASE_MAX_SELECTION_WIDTH'));
  assert.equal(EW.MAX_SELECTION_WIDTH, 1024);
});
test('MAX_SELECTION_WIDTH is the widest selection the server window can hold (2 x MODEL_SIZE)', () => {
  assert.equal(EW.MAX_SELECTION_WIDTH, MODEL_SIZE * 2);
});
test('checkSelectionWidth: exactly the limit is fine, one pixel more is refused', () => {
  assert.deepEqual(EW.checkSelectionWidth({ x: 0, y: 0, w: 1024, h: 10 }), { ok: true, width: 1024, max: 1024 });
  assert.deepEqual(EW.checkSelectionWidth({ x: 0, y: 0, w: 1025, h: 10 }), { ok: false, width: 1025, max: 1024 });
  assert.equal(EW.checkSelectionWidth({ x: 0, y: 0, w: 1, h: 1 }).ok, true);
});
test('checkSelectionWidth: only the WIDTH of the painted box counts (a tall selection is not refused by this rule)', () => {
  assert.equal(EW.checkSelectionWidth({ x: 0, y: 0, w: 50, h: 4000 }).ok, true);
});
test('checkSelectionWidth: works on a real findBBox result (scattered strokes -> joint box)', () => {
  const d = rgba(1400, 10, (x, y) => y === 5 && (x < 10 || x >= 1300));
  const bb = EW.findBBox(d, 1400, 10);
  assert.equal(bb.w, 1400);
  assert.equal(EW.checkSelectionWidth(bb).ok, false);
});
test('checkSelectionWidth: missing / unusable bbox is not a size problem; custom max is honoured', () => {
  assert.deepEqual(EW.checkSelectionWidth(null), { ok: true, width: 0, max: 1024 });
  assert.deepEqual(EW.checkSelectionWidth({ w: NaN }), { ok: true, width: 0, max: 1024 });
  assert.deepEqual(EW.checkSelectionWidth({ w: 50 }, 40), { ok: false, width: 50, max: 40 });
  assert.deepEqual(EW.checkSelectionWidth({ w: 50 }, 0), { ok: true, width: 50, max: 1024 }, 'a non-positive max falls back to the default');
});

run('erase_window_test');
