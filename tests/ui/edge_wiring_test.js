// Edge AI wiring + static guarantees: load order, CSP, i18n (EN/AR), config <-> model checksum, worker contract, server path intact,
// and the version.json -> app-config / CSP / config.xml stamping of edge_model_url.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, run, assert } = require('./_harness');

const root = path.join(__dirname, '../..');
const read = (rel, base) => fs.readFileSync(path.join(base || root, rel), 'utf8');
const html = read('index.html');
const NEW_JS = ['js/core/edge-model.js', 'js/ui/edge-model-ui.js', 'js/portrait/portrait-math.js', 'js/portrait/edge-portrait.js', 'js/workers/depth-worker.js'];

function python(args, cwd) {
  for (const bin of ['python3', 'python']) { const r = spawnSync(bin, args, { cwd, encoding: 'utf8' }); if (!r.error) return r; }
  return null;
}

test('load order: edge-model -> edge-model-ui -> portrait-math -> edge-portrait -> portrait-mode, all deferred; the stylesheet is linked', () => {
  const order = ['js/core/edge-model.js', 'js/ui/edge-model-ui.js', 'js/portrait/portrait-math.js', 'js/portrait/edge-portrait.js', 'js/portrait/portrait-mode.js']
    .map((f) => html.indexOf('src="./' + f + '"'));
  assert.ok(order.every((i) => i > 0), 'every script tag exists');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'dependencies load first');
  for (const f of order) assert.match(html.slice(html.lastIndexOf('<script', f), html.indexOf('</script>', f)), /defer/);
  assert.match(html, /<link rel="stylesheet" href="\.\/css\/edge-ai\.css">/);
  assert.ok(html.indexOf('js/core/edge-model.js') > html.indexOf('js/config/app-config.js'), 'config loads before the model module');
});

test('CSP: no unsafe-eval; wasm-unsafe-eval + blob workers allowed; no edge host unless version.json sets one', () => {
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  assert.ok(!/'unsafe-eval'/.test(csp));
  assert.match(csp, /script-src [^;]*'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self' blob:/);
  const meta = JSON.parse(read('version.json'));
  assert.equal(meta.edge_model_url, '', 'shipped unconfigured: portrait stays on the server until a URL is set');
  assert.match(csp, /connect-src 'self' blob: data:(?: https:\/\/[^\s;]+)*? https:\/\/\*\.aws\.cdn\.hf\.co/);
});

test('new modules: no inline handlers, no innerHTML / eval / document.write; the UI writes text via textContent', () => {
  for (const f of NEW_JS) {
    const src = read(f);
    assert.ok(!/\son(?:click|change|input)\s*=/.test(src), f + ' has an inline handler');
    assert.ok(!/\binnerHTML\b|\beval\s*\(|new Function\(|document\.write/.test(src), f + ' uses an unsafe sink');
  }
  const ui = read('js/ui/edge-model-ui.js');
  assert.match(ui, /addEventListener\('click'/);
  assert.ok(!/style\.cssText|setAttribute\('style'/.test(ui));
});

test('i18n: every edge key exists in English AND Arabic, Arabic really is Arabic, placeholders match', () => {
  const src = read('js/i18n/i18n.js');
  const keys = ['edgePreparing', 'edgeVerifying', 'edgeStarting', 'edgeReady', 'edgeMb', 'edgeRetry', 'edgeErrOffline', 'edgeErrNetwork', 'edgeErrHttp', 'edgeErrCorrupt', 'edgeErrQuota', 'edgeErrRuntime', 'edgeErrGeneric'];
  const arStart = src.indexOf('errPortraitModel:', src.indexOf('errPortraitModel:') + 10);
  assert.ok(arStart > 0);
  for (const k of keys) {
    const re = new RegExp("\\b" + k + ": '([^']*)'", 'g');
    const found = [...src.matchAll(re)].map((m) => m[1]);
    assert.equal(found.length, 2, k + ' must exist exactly twice (EN + AR)');
    assert.notEqual(found[0], found[1], k + ' Arabic differs from English');
    assert.match(found[1], /[\u0600-\u06FF]/, k + ' Arabic text contains Arabic letters');
    assert.deepEqual((found[0].match(/\{\w+\}/g) || []).sort(), (found[1].match(/\{\w+\}/g) || []).sort(), k + ' placeholders match');
  }
  assert.match(src, /edgePreparing: 'Setting up AI features \(one-time download\)…'/);
  assert.match(src, /edgePreparing: 'جارٍ تجهيز ميزات الذكاء الاصطناعي/);
});

test('config: EDGE_MODEL_CONFIG size + SHA-256 equal backend/models/MODELS.sha256 (and the real file, when present)', () => {
  const cfg = read('js/config/app-config.js');
  const sha = /sha256: "([0-9a-f]{64})"/.exec(cfg)[1];
  const bytes = Number(/bytes: (\d+)/.exec(cfg)[1]);
  const line = read('backend/models/MODELS.sha256').split(/\r?\n/).find((l) => /portrait_depth\.onnx/.test(l));
  assert.equal(sha, line.split(/\s+/)[0].toLowerCase());
  const model = path.join(root, 'backend/models/portrait_depth.onnx');
  if (fs.existsSync(model) && fs.statSync(model).size > 1e6) assert.equal(fs.statSync(model).size, bytes);
  assert.match(cfg, /const EDGE_MODEL_URL = "";/, 'unconfigured by default');
});

test('worker contract: module worker, vendored runtime only, single-threaded WASM, no network URL', () => {
  const w = read('js/workers/depth-worker.js');
  assert.match(w, /^'use strict';/m);
  assert.match(w, /import \* as ort from '\.\.\/\.\.\/vendor\/ort\/ort\.wasm\.min\.mjs'/);
  assert.match(w, /numThreads = 1/);
  assert.match(w, /executionProviders: \['wasm'\]/);
  assert.ok(!/https?:\/\//.test(w), 'the worker never names a remote host');
  assert.match(read('js/portrait/edge-portrait.js'), /new Worker\(WORKER_URL, \{ type: 'module' \}\)/);
});

test('hybrid contract: portrait-mode.js still sends the unchanged server request when the local path answers null', () => {
  const pm = read('js/portrait/portrait-mode.js');
  assert.match(pm, /window\.YoEdgePortrait\.canHandle\(\{ skin: skin \}\)/);
  assert.match(pm, /if \(localBlob\) \{[\s\S]*\} else \{[\s\S]*form\.append\('blur_level', String\(level\)\)[\s\S]*form\.append\('skin_smooth', String\(skin\)\)[\s\S]*postWithBusyRetry\(form, ctl\.signal/);
  // ... and that helper is still the plain YoApi POST to the same endpoint (the retry only wraps it).
  assert.match(pm, /window\.YoApi\.request\(PORTRAIT_PATH, \{ method: 'POST', body: form, signal: signal \}\)/);
  assert.match(pm, /isStale: function \(\) \{ return seq !== portraitRequestSeq; \}/);
});

test('vendored runtime: pinned exact version (never latest), integrity table is the trust anchor, binaries are git-ignored', () => {
  const f = read('scripts/fetch_ort.py');
  assert.match(f, /VERSION = "\d+\.\d+\.\d+"/);
  assert.ok(!/@latest/.test(f));
  assert.match(f, /ORT\.sha256/);
  assert.match(read('.gitignore'), /vendor\/ort\/\*\.wasm/);
  assert.ok(fs.existsSync(path.join(root, 'vendor/ort/README.md')));
});

test('sync_version.py: edge_model_url is stamped into app-config.js, the CSP and config.xml; unsafe values are rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yo-edge-'));
  try {
    for (const rel of ['scripts/sync_version.py', 'version.json', 'index.html', 'config.xml', 'js/i18n/i18n.js', 'js/config/app-config.js']) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(tmp, rel));
    }
    const sync = (args) => python(['scripts/sync_version.py', ...args], tmp);
    sync(['--native-api-base', '']);                                       // start from the unconfigured state, whatever the repo itself is stamped with
    const probe = sync(['--check']);
    if (!probe) return;                                                    // no python on this machine: the CI job covers it
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);

    const ok = sync(['--edge-model-url', 'https://models.yofilter.app/v1/portrait_depth.onnx']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(read('js/config/app-config.js', tmp), /const EDGE_MODEL_URL = "https:\/\/models\.yofilter\.app\/v1\/portrait_depth\.onnx";/);
    assert.match(read('index.html', tmp), /connect-src 'self' blob: data: https:\/\/models\.yofilter\.app https:\/\/\*\.aws\.cdn\.hf\.co/);
    assert.match(read('config.xml', tmp), /<access origin="https:\/\/models\.yofilter\.app" \/>/);
    assert.equal(sync(['--check']).status, 0, 'in sync after stamping');

    const both = sync(['--native-api-base', 'https://api.yofilter.app']);
    assert.equal(both.status, 0, both.stdout + both.stderr);
    assert.match(read('index.html', tmp), /data: https:\/\/api\.yofilter\.app https:\/\/models\.yofilter\.app https:\/\/\*\.aws\.cdn\.hf\.co/);

    for (const bad of ['http://models.yofilter.app/m.onnx', 'https://models.yofilter.app/m.onnx?sig=1', 'https://models.yofilter.app', 'https://localhost/m.onnx', 'https://models.example/m.onnx', 'https://*.yofilter.app/m.onnx']) {
      const r = sync(['--edge-model-url', bad]);
      assert.notEqual(r.status, 0, 'must reject ' + bad);
    }
    assert.equal(sync(['--edge-model-url', ' ']).status, 0, 'clearing the URL is allowed');
    assert.match(read('js/config/app-config.js', tmp), /const EDGE_MODEL_URL = "";/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('docs: docs/EDGE_AI_PORTRAIT.md documents the flow, limits and hosting requirements', () => {
  const d = read('docs/EDGE_AI_PORTRAIT.md');
  for (const needle of ['Cache API', 'SHA-256', 'skin', 'CORS', 'Content-Length', 'fetch_ort.py', 'Retry', 'fallback']) assert.ok(d.includes(needle), 'docs mention ' + needle);
});

run('edge_wiring_test');
