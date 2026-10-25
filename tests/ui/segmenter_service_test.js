// V20 R17 / R18: shared segmenter - one queued job at a time, per-caller results, clear offline/timeout errors.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert } = require('./_harness');

function load(opts) {
  opts = opts || {};
  const sandbox = { console, Promise, setTimeout, clearTimeout, Math, JSON, Float32Array, Object,
    navigator: { onLine: opts.onLine !== false },
    window: { t: opts.t },
    document: { createElement() { return { width: 0, height: 0, getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }; } }; } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/core/segmenter-service.js'), 'utf8') + '\n;globalThis.YoSegmenter = YoSegmenter;', sandbox);
  return sandbox.YoSegmenter;
}
function fakeMask(w, h) {
  return { width: w, height: h, getAsFloat32Array: () => new Float32Array(w * h).fill(0.2), close() {} };
}
function fakeSegmenter(log, delay) {
  return {
    segment(src, cb) {
      log.push('start:' + src.id);
      cb({ confidenceMasks: [fakeMask(2, 2)] });
      log.push('end:' + src.id);
    }
  };
}

test('R17: jobs run strictly one after another and each caller gets its own result', async () => {
  const seg = load();
  const log = [];
  seg._setSegmenterForTests(fakeSegmenter(log));
  const [a, b, c] = await Promise.all([seg.segment({ id: 'A' }), seg.segment({ id: 'B' }), seg.segment({ id: 'C' })]);
  assert.deepEqual(log, ['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  assert.ok(a && b && c && a !== b && b !== c, 'three distinct mask canvases');
});

test('R17: a failing job does not block the queue behind it', async () => {
  const seg = load();
  let n = 0;
  seg._setSegmenterForTests({ segment(src, cb) { n++; if (src.id === 'bad') throw new Error('boom'); cb({ confidenceMasks: [fakeMask(1, 1)] }); } });
  const bad = seg.segment({ id: 'bad' });
  const good = seg.segment({ id: 'good' });
  await assert.rejects(bad, (e) => e.name === 'SegmenterError' && e.code === 'segment-failed');
  assert.ok(await good);
  assert.equal(n, 2);
});

test('R17: no global result handler is used any more', () => {
  const root = path.join(__dirname, '../..');
  for (const f of ['js/editing/ai-mask.js', 'js/editing/bg-removal.js', 'js/portrait/portrait-mode.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/onPortraitSegmentationResults\s*=/.test(src), f + ' must not hijack a global handler');
    assert.ok(!/portraitSelfieSegmentation\.send/.test(src), f + ' must go through YoSegmenter');
  }
  for (const f of ['js/editing/ai-mask.js', 'js/editing/bg-removal.js']) {
    assert.ok(/YoSegmenter\.segment\(/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
  }
});

test('R18: offline + local bundle not loadable -> SegmenterError code "offline" with a plain message', async () => {
  const seg = load({ onLine: false });
  await assert.rejects(seg.load(), (e) => e.name === 'SegmenterError' && e.code === 'offline' && /you’re offline/i.test(e.message));
  assert.equal(seg.status(), 'failed');
});

test('R18: online but nothing loadable -> "load-failed", and a retry is possible (not stuck in loading)', async () => {
  const seg = load({ onLine: true });
  await assert.rejects(seg.load(), (e) => e.name === 'SegmenterError' && (e.code === 'load-failed' || e.code === 'load-timeout'));
  assert.notEqual(seg.status(), 'loading');
});

test('R18: error messages follow the UI language (window.t)', async () => {
  const seg = load({ onLine: false, t: (k) => (k === 'segOffline' ? 'ARABIC-OFFLINE-TEXT' : k) });
  await assert.rejects(seg.load(), (e) => e.message === 'ARABIC-OFFLINE-TEXT');
});

test('R18: same-origin assets only - no CDN config, no third-party URL anywhere in the service', () => {
  const seg = load();
  assert.equal(seg.config.localBase, './vendor/mediapipe/');
  assert.equal(seg.config.cdn, undefined);
  assert.ok(seg.config.segmentTimeoutMs > 0 && seg.config.localLoadTimeoutMs > 0);
  const src = fs.readFileSync(path.join(__dirname, '../../js/core/segmenter-service.js'), 'utf8');
  assert.ok(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, '')), 'no http(s) URL in code (comments excluded)');
  assert.ok(!/jsdelivr|googleapis|\/latest\//i.test(src.replace(/\/\/.*$/gm, '')));
});

test('R18: the pinned version in the service equals the one the fetch script downloads', () => {
  const py = fs.readFileSync(path.join(__dirname, '../../scripts/fetch_mediapipe_assets.py'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../../js/core/segmenter-service.js'), 'utf8');
  assert.equal(/^VERSION = "([^"]+)"/m.exec(py)[1], /var VERSION = '([^']+)'/.exec(js)[1]);
  assert.match(py, /^MODEL_VERSION = "\d+"/m, 'the model release is explicit, never "latest"');
  assert.ok(!/\/latest\//.test(py.replace(/#.*$/gm, '')), 'no /latest/ URL in the fetch script');
});

run('segmenter_service_test');
