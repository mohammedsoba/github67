// save_image_test.js - js/ui/save-image.js (canvasToBlob / saveBlob) in a plain-node vm sandbox, plus static guards
// that the three export entry points stay Blob-based (no toDataURL / base64) and are wired in index.html.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SRC = read('js/ui/save-image.js');

// Fresh sandbox per case. opts: coarse, share ('ok' | 'abort' | 'notallowed' | undefined), canShare (bool)
function makeEnv(opts = {}) {
  const timers = [], anchors = [], revoked = [], shareCalls = [];
  class FakeFile { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = (o || {}).type; } }
  const navigator = {};
  if (opts.share) {
    navigator.canShare = (d) => opts.canShare !== false && !!(d && d.files && d.files.length);
    navigator.share = async (d) => {
      shareCalls.push(d);
      if (opts.share === 'abort') { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
      if (opts.share === 'notallowed') { const e = new Error('no activation'); e.name = 'NotAllowedError'; throw e; }
    };
  }
  const sb = {
    navigator, File: FakeFile, Promise, Error, console,
    window: { matchMedia: (q) => ({ matches: !!opts.coarse && q === '(pointer: coarse)' }) },
    URL: { createObjectURL: (b) => 'blob:fake/' + anchors.length, revokeObjectURL: (u) => revoked.push(u) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => { const a = { style: {}, click() { anchors.push(a); } }; return a; },
    },
  };
  createContext(sb);
  vm.runInContext(SRC, sb);
  return { sb, timers, anchors, revoked, shareCalls };
}
const blob = (type = 'image/png', size = 1234) => ({ size, type });

test('canvasToBlob passes type + quality to toBlob and resolves the blob', async () => {
  const { sb } = makeEnv();
  let seen;
  const canvas = { toBlob: (cb, t, q) => { seen = [t, q]; cb(blob('image/jpeg')); } };
  const b = await sb.canvasToBlob(canvas, 'image/jpeg', 0.92);
  assert.deepEqual(seen, ['image/jpeg', 0.92]);
  assert.equal(b.type, 'image/jpeg');
});

test('canvasToBlob defaults to PNG and rejects on null / empty blob / missing toBlob / throw', async () => {
  const { sb } = makeEnv();
  let t;
  await sb.canvasToBlob({ toBlob: (cb, type) => { t = type; cb(blob()); } });
  assert.equal(t, 'image/png');
  await assert.rejects(sb.canvasToBlob({ toBlob: (cb) => cb(null) }), /Could not encode/);
  await assert.rejects(sb.canvasToBlob({ toBlob: (cb) => cb(blob('image/png', 0)) }), /Could not encode/);
  await assert.rejects(sb.canvasToBlob({}), /Could not encode/);
  await assert.rejects(sb.canvasToBlob(null), /Could not encode/);
  await assert.rejects(sb.canvasToBlob({ toBlob() { throw new Error('boom'); } }), /boom/);
});

test('blobSizeMB uses blob.size', () => {
  const { sb } = makeEnv();
  assert.equal(sb.blobSizeMB({ size: 3 * 1024 * 1024 + 400000 }), '3.4');
  assert.equal(sb.blobSizeMB(null), '0.0');
});

test('touch device with Web Share: shares a File, no download', async () => {
  const env = makeEnv({ coarse: true, share: 'ok' });
  const r = await env.sb.saveBlob(blob('image/jpeg'), 'a.jpg');
  assert.equal(r, 'shared');
  assert.equal(env.shareCalls.length, 1);
  const f = env.shareCalls[0].files[0];
  assert.equal(f.name, 'a.jpg'); assert.equal(f.type, 'image/jpeg');
  assert.equal(env.anchors.length, 0);
});

test('share dismissed by the user (AbortError) -> "cancelled", no download fallback', async () => {
  const env = makeEnv({ coarse: true, share: 'abort' });
  assert.equal(await env.sb.saveBlob(blob(), 'a.png'), 'cancelled');
  assert.equal(env.anchors.length, 0);
});

test('share fails for another reason (NotAllowedError) -> falls back to anchor download', async () => {
  const env = makeEnv({ coarse: true, share: 'notallowed' });
  assert.equal(await env.sb.saveBlob(blob(), 'a.png'), 'downloaded');
  assert.equal(env.anchors.length, 1);
});

test('canShare says no (or share missing) on a touch device -> download', async () => {
  let env = makeEnv({ coarse: true, share: 'ok', canShare: false });
  assert.equal(await env.sb.saveBlob(blob(), 'a.png'), 'downloaded');
  assert.equal(env.shareCalls.length, 0);
  env = makeEnv({ coarse: true });                       // no navigator.share at all
  assert.equal(await env.sb.saveBlob(blob(), 'a.png'), 'downloaded');
});

test('fine pointer (desktop) never opens the share sheet even if the API exists', async () => {
  const env = makeEnv({ coarse: false, share: 'ok' });
  assert.equal(await env.sb.saveBlob(blob(), 'a.png'), 'downloaded');
  assert.equal(env.shareCalls.length, 0);
});

test('download: anchor.download = filename, object URL revoked after 4 s', async () => {
  const env = makeEnv();
  await env.sb.saveBlob(blob(), 'yofilter-x.png');
  assert.equal(env.anchors.length, 1);
  assert.equal(env.anchors[0].download, 'yofilter-x.png');
  assert.match(env.anchors[0].href, /^blob:/);
  assert.equal(env.revoked.length, 0, 'must not revoke synchronously');
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 4000);
  env.timers[0].fn();
  assert.deepEqual(env.revoked, [env.anchors[0].href]);
});

test('static: no toDataURL/base64 in the export, eraser-download and portrait-download paths', () => {
  // V20 (R20): the Cordova storage helper now writes a Blob and uses MediaStore via cordova-plugin-photo-library
  // (no base64 round trip), so it is allowed to contain toBlob() but must not contain toDataURL / atob.
  const exp = read('js/ui/modals-export.js');
  const start = exp.indexOf('function saveCanvasToDeviceStorage');
  const end = exp.indexOf('function doExport');
  const outsideCordova = exp.slice(0, start) + exp.slice(end);
  const doExportBody = exp.slice(end, exp.indexOf('// ==================== MODALS & NAV'));
  assert.ok(!/toDataURL/.test(outsideCordova), 'modals-export.js: toDataURL outside saveCanvasToDeviceStorage');
  assert.ok(!/dataUrl|base64/i.test(doExportBody), 'doExport still mentions dataUrl/base64');
  assert.match(doExportBody, /canvasToBlob\(finalCanvas/);
  assert.match(doExportBody, /saveBlob\(blob/);
  const cordovaFn = exp.slice(start, exp.indexOf('// Shrink a canvas to 1x1'));
  assert.ok(!/toDataURL|atob\(/.test(cordovaFn), 'Cordova helper must not use base64 any more');
  assert.match(cordovaFn, /toBlob\(/);
  assert.match(cordovaFn, /photoLibrary/);

  const me = read('js/editing/magic-eraser.js');
  const dl = me.slice(me.indexOf('async function download()'), me.indexOf('COMMIT RESULT TO THE MAIN EDITOR'));
  assert.match(dl, /window\.canvasToBlob\(source/); assert.match(dl, /window\.saveBlob\(/);
  assert.ok(!/toDataURL|createElement\('a'\)/.test(dl));

  const pm = read('js/portrait/portrait-mode.js');
  const pd = pm.slice(pm.indexOf('window.downloadPortraitResult'), pm.indexOf('window.resetPortraitMode'));
  assert.match(pd, /saveBlob\(/);
  assert.ok(!/createElement\('a'\)|toDataURL|\.href = /.test(pd));
});

test('index.html: save-image.js is deferred and loads right before modals-export.js', () => {
  const html = read('index.html');
  const a = html.indexOf('<script defer src="./js/ui/save-image.js"></script>');
  const b = html.indexOf('<script src="./js/ui/modals-export.js" defer></script>');
  assert.ok(a > 0 && b > a, 'save-image.js must precede modals-export.js');
  assert.equal(html.slice(a, b).split('<script').length - 1, 1, 'nothing may sit between them');
});

run('save_image_test');
