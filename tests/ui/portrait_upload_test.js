// Browser-side downscale before the portrait SERVER upload (js/portrait/portrait-mode.js, block "upload-prep").
// Plain Node, same harness as the other suites: the REAL code between the upload-prep markers runs against fake
// canvas / image / blob objects, so sizes, formats, fallbacks and caching are asserted without a browser.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert } = require('./_harness');

const SRC = fs.readFileSync(path.join(__dirname, '../../js/portrait/portrait-mode.js'), 'utf8');
const m = /\/\/ >>> upload-prep([\s\S]*?)\/\/ <<< upload-prep/.exec(SRC);
assert.ok(m, 'upload-prep block not found in portrait-mode.js');

function makeSandbox() {
  const log = { images: 0, released: 0, canvases: 0, encodes: [], warns: [] };
  const urls = new Map();
  let nextUrl = 0;
  class FakeImage {
    set src(u) {
      if (u === '') { log.released++; this.onload = this.onerror = null; return; }   // releaseImage(): not a decode
      log.images++;
      const b = urls.get(u);
      setTimeout(() => {
        if (b.decodeFails) { this.onerror(); return; }
        this.naturalWidth = b.w; this.naturalHeight = b.h; this.__alpha = !!b.alpha;
        this.onload();
      }, 0);
    }
  }
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; this._alpha = false; }
    getContext() {
      const self = this;
      return {
        imageSmoothingEnabled: false, imageSmoothingQuality: '',
        drawImage(src, x, y, w, h) { self._alpha = !!(src.__alpha || src._alpha); self._drawW = w; self._drawH = h; },
        getImageData(x, y, w, h) {
          if (sb.__readFails) throw new Error('getImageData blocked');
          const d = new Uint8ClampedArray(w * h * 4).fill(255);
          if (self._alpha) d[3] = 128;
          return { data: d };
        },
      };
    }
  }
  const sb = {
    console: { warn: (...a) => log.warns.push(a.join(' ')), error() {}, log() {} },
    setTimeout, Math,
    URL: { createObjectURL: (b) => { const u = 'blob:' + (++nextUrl); urls.set(u, b); return u; }, revokeObjectURL: (u) => urls.delete(u) },
    Image: FakeImage,
    document: { createElement: () => { log.canvases++; return new FakeCanvas(); } },
    canvasToBlob: (canvas, type, quality) => {
      log.encodes.push({ type, quality, w: canvas.width, h: canvas.height });
      if (sb.__encodeFails) return Promise.reject(new Error('Could not encode the image'));
      const px = canvas.width * canvas.height;
      return Promise.resolve({ type, size: sb.__encodeHuge ? 1e9 : Math.round(px * (type === 'image/jpeg' ? 0.2 : 2.5)) });
    },
  };
  vm.createContext(sb);
  vm.runInContext(m[1] + '\nthis.prepareUpload = prepareUpload;', sb);
  return { sb, log };
}
const blob = (w, h, type, size, extra) => Object.assign({ w, h, type, size }, extra);
const MB = 1024 * 1024;

test('constants: 2048 px side (= server PORTRAIT_MAX_SIDE), JPEG 0.92 for opaque photos, 3 MB "send untouched" threshold', () => {
  const { sb } = makeSandbox();
  assert.equal(sb.UPLOAD_MAX_SIDE, 2048);
  assert.equal(sb.UPLOAD_JPEG_QUALITY, 0.92);
  assert.equal(sb.UPLOAD_KEEP_BYTES, 3 * MB);
  const cfg = fs.readFileSync(path.join(__dirname, '../../backend/app/config.py'), 'utf8');
  assert.match(cfg, /_int_env\("PORTRAIT_MAX_SIDE", 2048\)/, 'client and server limits must stay in step');
});

test('6000x4000 JPEG -> 2048x1365 JPEG q0.92, scaled in halving steps (3000x2000 first), far smaller than the original', async () => {
  const { sb, log } = makeSandbox();
  const base = blob(6000, 4000, 'image/jpeg', 6 * MB);
  const r = await sb.prepareUpload(base);
  assert.deepEqual(log.encodes, [{ type: 'image/jpeg', quality: 0.92, w: 2048, h: 1365 }]);
  assert.equal(log.canvases, 2, 'one halving step + the final canvas');
  assert.equal(r.name, 'portrait-source.jpg');
  assert.ok(r.blob.size < base.size / 5, 'the upload is a fraction of the original');
});

test('6000x4000 OPAQUE PNG (typical after any edit) -> JPEG, not PNG', async () => {
  const { sb, log } = makeSandbox();
  const r = await sb.prepareUpload(blob(6000, 4000, 'image/png', 40 * MB));
  assert.equal(log.encodes[0].type, 'image/jpeg');
  assert.equal(r.name, 'portrait-source.jpg');
});

test('PNG with transparency stays PNG (JPEG would turn the transparent area black)', async () => {
  const { sb, log } = makeSandbox();
  const r = await sb.prepareUpload(blob(6000, 4000, 'image/png', 40 * MB, { alpha: true }));
  assert.deepEqual(log.encodes[0], { type: 'image/png', quality: undefined, w: 2048, h: 1365 });
  assert.equal(r.name, 'portrait-source.png');
});

test('if the opacity check cannot run, the safe choice (PNG) is made', async () => {
  const { sb, log } = makeSandbox();
  sb.__readFails = true;
  await sb.prepareUpload(blob(4000, 3000, 'image/png', 20 * MB));
  assert.equal(log.encodes[0].type, 'image/png');
});

test('a small photo that already fits is sent UNTOUCHED: same Blob object, no decode work, no canvas, no encode', async () => {
  const { sb, log } = makeSandbox();
  const base = blob(1200, 800, 'image/png', 800 * 1024);
  const r = await sb.prepareUpload(base);
  assert.equal(r.blob, base);
  assert.equal(r.name, 'portrait-source.png');
  assert.equal(log.canvases, 0); assert.equal(log.encodes.length, 0);
});

test('a heavy opaque PNG that already fits (2000x1500, 9 MB) is re-encoded once as JPEG at the same size', async () => {
  const { sb, log } = makeSandbox();
  const r = await sb.prepareUpload(blob(2000, 1500, 'image/png', 9 * MB));
  assert.deepEqual(log.encodes, [{ type: 'image/jpeg', quality: 0.92, w: 2000, h: 1500 }]);
  assert.equal(log.canvases, 1, 'no halving steps when nothing is shrunk');
  assert.equal(r.name, 'portrait-source.jpg');
});

test('a JPEG that already fits is never re-encoded (no extra generation of loss), however heavy', async () => {
  const { sb, log } = makeSandbox();
  const base = blob(2000, 1500, 'image/jpeg', 4 * MB);
  const r = await sb.prepareUpload(base);
  assert.equal(r.blob, base); assert.equal(log.encodes.length, 0);
});

test('the upload is never bigger than the baseline: an encode that is not smaller is discarded', async () => {
  const { sb } = makeSandbox();
  sb.__encodeHuge = true;
  const base = blob(6000, 4000, 'image/png', 40 * MB);
  const r = await sb.prepareUpload(base);
  assert.equal(r.blob, base);
});

test('any failure falls back to the original baseline and never throws (decode error / encode error)', async () => {
  const a = makeSandbox();
  const bad = blob(6000, 4000, 'image/png', 40 * MB, { decodeFails: true });
  assert.equal((await a.sb.prepareUpload(bad)).blob, bad);
  assert.ok(a.log.warns.length === 1 && /skipped/.test(a.log.warns[0]));
  const b = makeSandbox();
  b.sb.__encodeFails = true;
  const base = blob(6000, 4000, 'image/png', 40 * MB);
  assert.equal((await b.sb.prepareUpload(base)).blob, base);
  assert.equal(b.log.warns.length, 1);
});

test('UPLOAD_JPEG_QUALITY = 0 keeps the whole chain lossless: opaque photos are uploaded as PNG', async () => {
  const { sb, log } = makeSandbox();
  sb.UPLOAD_JPEG_QUALITY = 0;
  const r = await sb.prepareUpload(blob(6000, 4000, 'image/png', 40 * MB));
  assert.deepEqual(log.encodes[0], { type: 'image/png', quality: undefined, w: 2048, h: 1365 });
  assert.equal(r.name, 'portrait-source.png');
});

test('one encode per baseline: concurrent slider requests share a single job; a different baseline gets its own', async () => {
  const { sb, log } = makeSandbox();
  const base = blob(6000, 4000, 'image/png', 40 * MB);
  const [a, b] = await Promise.all([sb.prepareUpload(base), sb.prepareUpload(base)]);
  assert.equal(a, b);
  assert.equal(await sb.prepareUpload(base), a);
  assert.equal(log.images, 1); assert.equal(log.encodes.length, 1);
  await sb.prepareUpload(blob(6000, 4000, 'image/png', 41 * MB));
  assert.equal(log.images, 2);
});

test('the decoded photo is released after use: right after the canvas is drawn, on early returns and on errors', async () => {
  const a = makeSandbox();
  await a.sb.prepareUpload(blob(6000, 4000, 'image/jpeg', 6 * MB));
  assert.ok(a.log.released >= 1, 'oversized photo: bitmap released');
  const b = makeSandbox();
  await b.sb.prepareUpload(blob(1200, 800, 'image/png', 800 * 1024));
  assert.ok(b.log.released >= 1, 'small photo (early return): bitmap released');
  const c = makeSandbox();
  c.sb.__encodeFails = true;
  await c.sb.prepareUpload(blob(6000, 4000, 'image/png', 40 * MB));
  assert.ok(c.log.released >= 1, 'encode failure: bitmap released');
});

test('geometry: square, extreme panorama and exact-limit photos get the right target and the halving loop terminates', async () => {
  for (const [w, h, ew, eh] of [[5000, 5000, 2048, 2048], [10000, 1, 2048, 1], [2049, 1000, 2048, 1000]]) {
    const { sb, log } = makeSandbox();
    await sb.prepareUpload(blob(w, h, 'image/png', 30 * MB));
    assert.equal(log.encodes[0].w, ew, `${w}x${h} width`);
    assert.ok(Math.abs(log.encodes[0].h - eh) <= 1, `${w}x${h} height`);
  }
  const { sb, log } = makeSandbox();
  await sb.prepareUpload(blob(2048, 1536, 'image/png', 1 * MB));          // exactly the limit and small: untouched
  assert.equal(log.encodes.length, 0);
});

test('wiring: only the SERVER form uses the prepared upload; the on-device model still gets the full baseline; a stale request stops before posting', () => {
  assert.match(SRC, /var upload = await prepareUpload\(portraitBaseBlob\);\s*if \(seq !== portraitRequestSeq\) return;\s*var form = new FormData\(\);\s*form\.append\('image', upload\.blob, upload\.name\);/);
  assert.match(SRC, /window\.YoEdgePortrait\.run\(portraitBaseBlob,/);
  assert.ok(!/form\.append\('image', portraitBaseBlob/.test(SRC));
  assert.match(SRC, /if \(!refine\) portraitBaseBlob = await currentImageBlob\(\);/, 'the baseline is still captured untouched (refining never stacks blur)');
});

run('portrait_upload_test');
