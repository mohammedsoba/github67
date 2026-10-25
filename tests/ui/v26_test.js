// V26 (final remediation of the V25 audit): static + CLI regression tests. Zero-dependency Node, same harness as the other suites.
//   S1  the portrait 503 never carries paths / raw exception text to the client in production
//   S3  no placeholder API host is shipped; version.json -> app-config.js / CSP / config.xml is ONE stamped source
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, run, assert } = require('./_harness');

const root = path.join(__dirname, '../..');
const read = (rel, base) => fs.readFileSync(path.join(base || root, rel), 'utf8');

function python(args, cwd, code) {
  for (const bin of ['python3', 'python']) {
    const r = code
      ? spawnSync(bin, ['-c', code], { cwd, encoding: 'utf8' })
      : spawnSync(bin, args, { cwd, encoding: 'utf8' });
    if (!r.error) return r;
  }
  return null;
}

// Every shipped (non-doc, non-test) text file, for the placeholder sweep.
function shippedFiles(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'docs', 'tests', 'test-results', '.git', '__pycache__', 'models', 'vendor', 'fonts'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shippedFiles(full, out);
    else if (/\.(js|html|css|xml|json|py|md|txt|yml|yaml|ini)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// =====================================================================================================================
// S1 - portrait 503 must not leak paths / exception text in production
// =====================================================================================================================
test('S1: the /api/portrait 503 body is built by public_model_error(IS_PRODUCTION, ...) - the raw reason is never interpolated', () => {
  const main = read('backend/app/main.py');
  assert.match(main, /public_model_error\(IS_PRODUCTION, PORTRAIT_UNAVAILABLE_MESSAGE, reason\)/);
  assert.ok(!/error_response\(503, f"[^"]*\{reason\}/.test(main), 'no f-string puts `reason` into a client response');
  // the full reason still goes to the server log
  assert.match(main, /logger\.error\("\[portrait\] 503 model not loaded \(%s\)/);
});

test('S1: public_model_error - production is always the generic message; development keeps the reason', () => {
  const code = [
    'from backend.app.security import public_model_error, PORTRAIT_UNAVAILABLE_MESSAGE as M',
    'leak = "FileNotFoundError: Portrait model not found: /srv/yofilter/backend/models/portrait_depth.onnx"',
    'prod = public_model_error(True, M, leak)',
    'assert prod == "Portrait background model failed to load", prod',
    'assert "/srv" not in prod and "FileNotFound" not in prod and ".onnx" not in prod',
    'assert public_model_error(True, M, None) == M and public_model_error(True, M, "") == M',
    'dev = public_model_error(False, M, leak)',
    'assert dev.startswith(M) and leak in dev',
    'assert public_model_error(False, M, None) == M',
    'print("ok")',
  ].join('\n');
  const r = python(null, root, code);
  if (!r) { console.log('       (no python on PATH - skipped; pytest covers this)'); return; }
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok/);
});

test('S1: the other client-facing 5xx / 503 texts are generic (ids only) - no str(exc) in a 5xx body', () => {
  const main = read('backend/app/main.py');
  assert.match(main, /LaMa inpainting failed \(ref \{req_id\}\); see the server log\./);
  assert.match(main, /Portrait processing failed \(ref \{req_id\}\); see the server log\./);
  assert.match(main, /raise HTTPException\(status_code=503, detail="LaMa model is not loaded"\)/);
  // str(exc) is only ever used for 400 (input validation) answers
  for (const m of main.matchAll(/(error_response|HTTPException)\((?:status_code=)?(\d{3})[^\n]*str\(exc\)/g)) {
    assert.equal(m[2], '400', 'str(exc) reaches a client only in a 400: ' + m[0]);
  }
});

// =====================================================================================================================
// S3 - no placeholder host; one stamped source for the packaged-app API host
// =====================================================================================================================
test('S3: no placeholder API host (api.yofilter.example / PLACEHOLDER HOST) in any shipped file', () => {
  for (const file of shippedFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/api\.yofilter\.example/.test(text), path.relative(root, file) + ' still names the placeholder host');
    assert.ok(!/PLACEHOLDER HOST/.test(text), path.relative(root, file) + ' still has the placeholder wording');
  }
});

test('S3: version.json is the single source - app-config.js, the CSP and config.xml all follow native_api_base', () => {
  const meta = JSON.parse(read('version.json'));
  assert.equal(typeof meta.native_api_base, 'string');
  const base = meta.native_api_base;
  assert.match(read('js/config/app-config.js'), new RegExp('const NATIVE_API_BASE = "' + base.replace(/[.]/g, '\\.') + '";'));
  const csp = read('index.html').match(/connect-src ([^;"]*)/)[1].trim().split(/\s+/);
  // the Hugging Face download hosts (*.hf.co, *.huggingface.co) are not API hosts; there is no CDN host in the CSP any more
  const apiHosts = csp.filter((t) => /^https?:/.test(t) && !/^https:\/\/\*\.(?:aws\.cdn\.hf\.co|hf\.co|huggingface\.co)$/.test(t));
  assert.deepEqual(apiHosts, base ? [base] : [], 'CSP connect-src lists the API host iff it is configured');
  const cfg = read('config.xml');
  const block = cfg.match(/<!-- yofilter:native-api:begin -->(.*?)<!-- yofilter:native-api:end -->/)[1];
  if (base) assert.equal(block, '<access origin="' + base + '" />');
  else assert.match(block, /NOT CONFIGURED/);
  assert.ok(!/<access origin="\*"/.test(cfg));
});

test('S3: the unconfigured default is safe - the web build is same-origin, the packaged build refuses with a clear message', async () => {
  const api = require(path.join(root, 'js/config/api-client.js'));
  assert.equal(api.resolveBase({ protocol: 'https:' }), '');          // browser build: relative URLs, no host needed
  assert.equal(api.resolveBase({ protocol: 'file:', nativeBase: '' }), null);
  globalThis.cordova = {};
  try {
    await assert.rejects(() => api.request('/api/portrait', { method: 'POST' }),
      (e) => e.kind === 'invalid' && /isn’t set up in this version/i.test(e.message));
  } finally { delete globalThis.cordova; }
  assert.match(read('js/i18n/i18n.js'), /apiNoBase: 'The AI server isn’t set up in this version of the app\.'/);
  assert.match(read('js/i18n/i18n.js'), /apiNoBase: 'خادم الذكاء الاصطناعي غير مُعدّ/);
  assert.match(read('js/config/api-client.js'), /native_api_base in version\.json/);   // the developer hint moved to the console
});

test('S3: sync_version.py CLI - stamps all three files, rejects unsafe values, --release gates an unconfigured build', () => {
  const probe = python(['--version'], root);
  if (!probe) { console.log('       (no python on PATH - skipped; pytest covers this)'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yofilter-s3-'));
  try {
    for (const rel of ['version.json', 'config.xml', 'index.html', 'js/i18n/i18n.js', 'js/config/app-config.js', 'scripts/sync_version.py']) {
      fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(scratch, rel));
    }
    const sync = (...args) => python(['scripts/sync_version.py', ...args], scratch);
    sync('--native-api-base', '');                                          // the scratch copy starts unconfigured, whatever the repo itself is stamped with

    const gate = sync('--release');
    assert.equal(gate.status, 1, 'an unconfigured build must not pass --release');
    assert.match(gate.stdout, /native_api_base is empty/);

    for (const bad of ['http://api.real.com', 'https://api.real.com/v1', 'https://*.real.com', 'https://api.yofilter.example',
      'https://localhost', 'https://api.real.com?x=1', 'ftp://api.real.com', 'api.real.com']) {
      const r = sync('--native-api-base', bad);
      assert.equal(r.status === 0, false, 'must reject ' + bad);
    }
    assert.equal(JSON.parse(read('version.json', scratch)).native_api_base, '', 'a rejected value never reaches version.json');

    const ok = sync('--native-api-base', 'https://api.real-host.com/');          // trailing slash is normalised away
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(JSON.parse(read('version.json', scratch)).native_api_base, 'https://api.real-host.com');
    assert.match(read('js/config/app-config.js', scratch), /const NATIVE_API_BASE = "https:\/\/api\.real-host\.com";/);
    assert.match(read('index.html', scratch), /connect-src 'self' blob: data: https:\/\/api\.real-host\.com https:\/\/\*\.aws\.cdn\.hf\.co /);
    assert.match(read('config.xml', scratch), /<!-- yofilter:native-api:begin --><access origin="https:\/\/api\.real-host\.com" \/><!-- yofilter:native-api:end -->/);
    assert.equal(sync('--check').status, 0);
    assert.equal(sync('--release').status, 0, 'a configured build passes --release');

    fs.writeFileSync(path.join(scratch, 'config.xml'), read('config.xml', scratch).replace('api.real-host.com', 'evil.example.net'));
    const drift = sync('--check');
    assert.equal(drift.status, 1, 'a hand-edited copy is reported as drift');
    assert.match(drift.stdout, /config\.xml/);

    const clear = sync('--native-api-base', '');                                  // back to "not configured": the host disappears everywhere
    assert.equal(clear.status, 0, clear.stdout + clear.stderr);
    assert.ok(!/real-host/.test(read('index.html', scratch) + read('config.xml', scratch) + read('js/config/app-config.js', scratch)));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

run('v26_test');
