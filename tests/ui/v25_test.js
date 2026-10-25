// V25 / Task 3 (G11-G15): static + behavioural regression tests. Zero-dependency Node (same harness as the other suites).
//   G11/G12  backend hardening + metadata single source (static; the runtime checks live in tests/backend/test_v25_*.py)
//   G13      Back-button layer stack, busy warning, no native alert()
//   G14      CSS cascade consolidation
//   G15      preview == export parity, per-channel curves, Color Mix isolation, frame state across undo / new upload, swipes
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test, run, assert, createContext } = require('./_harness');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripLineComments = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const listFiles = (dir, ext) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).map((f) => dir + '/' + f);

// =====================================================================================================================
// G11 - backend / ops hardening (static view of backend/app/*.py; runtime behaviour is covered by pytest)
// =====================================================================================================================
test('G11: /docs, /redoc and /openapi.json are switched off in production', () => {
  const main = read('backend/app/main.py');
  assert.match(main, /docs_url=None if IS_PRODUCTION else "\/docs"/);
  assert.match(main, /redoc_url=None if IS_PRODUCTION else "\/redoc"/);
  assert.match(main, /openapi_url=None if IS_PRODUCTION else "\/openapi.json"/);
});

test('G11: config.xml is no longer on the public root-asset allow-list', () => {
  const main = read('backend/app/main.py');
  const m = main.match(/if filename not in \{([^}]*)\}/);
  assert.ok(m, 'allow-list found');
  assert.ok(!/config\.xml/.test(m[1]), 'config.xml must not be served');
  assert.ok(/favicon\.ico/.test(m[1]) && /icon\.png/.test(m[1]) && /robots\.txt/.test(m[1]), 'the harmless assets stay');
});

test('G11: /health goes through health_payload (production = 3 fields); no path / version leaks outside the dev-only helper', () => {
  const main = read('backend/app/main.py');
  // The route builds its body with health_payload(IS_PRODUCTION, ...) and answers with the status code health_http_status() derives
  // from the two model flags (200 only when BOTH models are loaded, else 503), never cached. (It used to be a bare `return health_payload(...)`.)
  const handler = main.slice(main.indexOf('@app.get("/health")'), main.indexOf('def _reject_if_huge'));
  assert.match(handler, /body = health_payload\(\s*IS_PRODUCTION,/, 'body comes from health_payload(IS_PRODUCTION, ...)');
  assert.match(handler, /model_loaded=lama_loaded,\s*portrait_loaded=portrait_loaded,/, 'both model flags are passed through');
  assert.match(handler, /detailed=lambda: _health_details\(request\)/, 'diagnostics are lazy: only built when the helper decides (development)');
  assert.match(handler, /return JSONResponse\(body, status_code=health_http_status\(lama_loaded, portrait_loaded\), headers=NO_STORE\)/, 'status code + no-store come from the shared helpers');
  assert.ok(!/return health_payload\(/.test(handler), 'the body is not returned directly any more (it needs the computed status code)');
  const sec = read('backend/app/security.py');
  assert.match(sec, /body: dict\[str, object\] = \{"status".*"model_loaded".*"portrait_model_loaded"/s);
  // the path / providers / dependency map are only built inside _health_details, which the production branch never calls
  const publicHealth = main.slice(main.indexOf('@app.get("/health")'), main.indexOf('def _reject_if_huge'));
  assert.ok(!/MODEL_PATH|installed_version|get_available_providers|portrait_error/.test(publicHealth), 'handler itself leaks nothing');
});

test('G11: security headers are stamped by an outermost middleware (nosniff always; CSP/frame-ancestors/XFO/Referrer/HSTS in production)', () => {
  const main = read('backend/app/main.py');
  assert.match(main, /async def add_security_headers/);
  assert.ok(main.indexOf('app.add_middleware(\n    CORSMiddleware') < main.indexOf('async def add_security_headers'), 'added AFTER CORS => outermost');
  const sec = read('backend/app/security.py');
  for (const h of ['X-Content-Type-Options', 'Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'Strict-Transport-Security']) assert.ok(sec.includes(h), h);
  assert.match(sec, /frame-ancestors 'none'/);
  assert.match(sec, /default-src 'none'/);
});

test('G11: CORS - explicit header allow-list (no wildcard), production default = native app origin only', () => {
  const main = read('backend/app/main.py'), cfg = read('backend/app/config.py'), sec = read('backend/app/security.py');
  assert.ok(!/allow_headers=\["\*"\]/.test(main), 'wildcard allow_headers is gone');
  assert.match(main, /allow_headers=CORS_ALLOW_HEADERS/);
  assert.ok(!/"\*"/.test(sec.match(/CORS_ALLOW_HEADERS = \[[^\]]*\]/)[0]));
  assert.match(cfg, /NATIVE_APP_ORIGINS = \["https:\/\/localhost"\]/);
  assert.match(cfg, /def resolve_allowed_origins\(raw: str \| None, production: bool\)/);
  assert.match(cfg, /return list\(NATIVE_APP_ORIGINS\) if production else \["\*"\]/);
});

// =====================================================================================================================
// G12 - metadata single source
// =====================================================================================================================
test('G12: version.json is the single source; config.xml, index.html, i18n (EN+AR) and the backend all agree', () => {
  const meta = JSON.parse(read('version.json'));
  assert.match(meta.version, /^\d+\.\d+\.\d+$/);
  assert.equal(meta.version, '1.0.0', 'release version stays 1.0.0');
  assert.equal(meta.api_title, 'YoFilter API');
  assert.equal(read('config.xml').match(/<widget\b[^>]*\bversion="([^"]*)"/)[1], meta.version);
  assert.equal(read('index.html').match(/data-i18n="appVersion">Version ([^<]*)</)[1], meta.version);
  const i18n = read('js/i18n/i18n.js');
  assert.equal(i18n.match(/appVersion: 'Version ([^']*)'/)[1], meta.version);
  assert.equal(i18n.match(/appVersion: 'الإصدار ([^']*)'/)[1], meta.version);
  const main = read('backend/app/main.py');
  assert.match(main, /title=APP_TITLE/);
  assert.match(main, /version=APP_VERSION/);
  assert.ok(!/LaMa Inpainting API/.test(main), 'old title is gone');
  assert.ok(!/version="1\.0\.0"/.test(main), 'no hard-coded version in main.py');
  assert.match(read('backend/app/config.py'), /version\.json/);
});

test('G12: scripts/sync_version.py --check reports "in sync" (skipped only when no Python is installed)', () => {
  let r = null;
  for (const bin of ['python3', 'python']) {
    const t = spawnSync(bin, [path.join(root, 'scripts/sync_version.py'), '--check'], { encoding: 'utf8' });
    if (!t.error) { r = t; break; }
  }
  if (!r) { console.log('       (no python on PATH - skipped; pytest covers this)'); return; }
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /in sync/);
});

test('G12: config.xml - Android-only, pinned SDK targets (target 34), author kept, API host stamped from version.json', () => {
  const cfg = read('config.xml');
  assert.match(cfg, /<author email="mmyasomm@gmail\.com">Yassin Mohamed<\/author>/);
  assert.match(cfg, /android-targetSdkVersion" value="34"/);
  assert.match(cfg, /android-minSdkVersion" value="\d+"/);
  assert.match(cfg, /<engine name="android" spec="\^13\.0\.0"/);
  assert.ok(!/<platform name="ios"/.test(cfg));
  assert.match(cfg, /yofilter:native-api:begin/, 'the API <access> line is a stamped block (V26)');
  assert.ok(!/PLACEHOLDER HOST/.test(cfg) && !/api\.yofilter\.example/.test(cfg), 'no placeholder host (V26)');
});

// =====================================================================================================================
// G13 - Back button + blocking dialogs
// =====================================================================================================================
test('G13: no native alert() / confirm() / prompt() left in js/ or index.html', () => {
  const files = [...['core', 'ui', 'editing', 'config', 'overlays', 'portrait', 'i18n'].flatMap((d) => listFiles('js/' + d, '.js')), 'index.html'];
  for (const f of files) {
    const code = stripLineComments(read(f));
    assert.ok(!/(^|[^.\w$])(alert|confirm|prompt)\s*\(/.test(code), f + ' still calls a blocking dialog');
  }
});

test('G13: Cordova save callbacks use translated toasts; i18n keys are consistent in EN and AR', () => {
  const src = read('js/ui/modals-export.js'), i18n = read('js/i18n/i18n.js');
  assert.match(src, /showToast\(window\.t\('toastSavedName'/);
  assert.match(src, /showToast\(window\.t\('toastSaveFailed'\), 'error'\)/);
  assert.ok(!/toastSaveFailedMsg/.test(src + i18n), 'raw technical reasons are no longer put into the toast (they stay in the console)');
  assert.equal((i18n.match(/toastSaveFailed:/g) || []).length, 2);
  assert.equal((i18n.match(/toastBackBusy:/g) || []).length, 2);
  assert.ok(!/alertSavedDevice|alertSaveFailed/.test(i18n + src), 'orphaned alert* keys removed');
});

function makeBackEnv() {
  const els = {};
  const mk = (id, extra) => {
    const e = { id, style: {}, hidden: false, _cls: new Set(), setAttribute() {}, focus() {}, click() { if (this.onclick) this.onclick({}); } };
    e.classList = { contains: (c) => e._cls.has(c), add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c) };
    els[id] = Object.assign(e, extra || {});
    return els[id];
  };
  ['aboutPage', 'settingsPage', 'exportModal', 'premiumModal', 'loadingOverlay', 'loadingCancel'].forEach((id) => mk(id));
  els.loadingCancel.hidden = true;
  const listeners = {}, calls = { cancel: 0, exit: 0, toasts: [], prevented: 0, focusExit: 0 };
  let clock = 1000, focus = false;
  const sandbox = {
    console, Math, JSON, Object,
    Date: { now: () => clock },
    document: { getElementById: (id) => els[id] || null, activeElement: null, contains: () => false,
                addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelectorAll: () => [] },
    window: { t: (k) => k, addEventListener() {}, Perf: null,
              isPortraitFocusModeActive: () => focus, exitPortraitFocusMode: () => { focus = false; calls.focusExit++; } },
    navigator: { app: { exitApp: () => { calls.exit++; } } },
    __els: els, __calls: calls,
  };
  createContext(sandbox);
  vm.runInContext(`
    var isCropMode = false, originalImage = null, currentLanguage = 'en';
    function cancelCrop() { isCropMode = false; }
    function closeExportModal() { __els.exportModal._cls.delete('active'); }
    function closePremiumModal() { __els.premiumModal._cls.delete('active'); }
    var overlayManager = { selectedId: null, isDragging: false, isResizing: false, isRotating: false, render() {} };
    function showToast(msg, type) { __calls.toasts.push(msg + ':' + type); }
  `, sandbox);
  vm.runInContext(read('js/ui/navigation.js'), sandbox);
  vm.runInContext(read('js/core/init.js'), sandbox);
  return {
    sandbox, els, calls, listeners,
    set: (c) => vm.runInContext(c, sandbox),
    get: (c) => vm.runInContext(c, sandbox),
    setFocus: (v) => { focus = v; },
    tick: (ms) => { clock += ms; },
    back: () => sandbox.onBackKeyDown({ preventDefault() { calls.prevented++; } }),
  };
}

test('G13: Back closes ONE layer per press, strictly top-most first, and only then reports "nothing open"', () => {
  const e = makeBackEnv();
  e.els.loadingOverlay._cls.add('active'); e.els.loadingCancel.hidden = false;
  e.els.loadingCancel.onclick = () => { e.calls.cancel++; e.els.loadingOverlay._cls.delete('active'); e.els.loadingCancel.hidden = true; };
  e.els.aboutPage.style.display = 'block';
  e.els.settingsPage.style.display = 'block';
  e.els.exportModal._cls.add('active');
  e.els.premiumModal._cls.add('active');
  e.set('isCropMode = true;');
  e.setFocus(true);
  e.set('overlayManager.selectedId = 7;');

  const order = [];
  for (let i = 0; i < 12; i++) {
    const name = e.get('topmostLayerName()');
    if (!name) break;
    order.push(name);
    assert.equal(e.get('closeTopmostLayer()'), true);
  }
  e.set('overlayManager.selectedId = null;');    // the stub's render() does not clear it; the real manager does the same assignment
  assert.deepEqual(order.slice(0, 7), ['loading', 'about', 'settings', 'export', 'premium', 'crop', 'portrait-focus']);
  assert.equal(order[7], 'overlay-selection');
  assert.equal(e.calls.cancel, 1, 'Back on a running operation == its Cancel button');
  assert.equal(e.calls.focusExit, 1);
  assert.equal(e.get('isCropMode'), false);
  assert.equal(e.get('closeTopmostLayer()'), false, 'nothing left');
});

test('G13: the hardware Back handler consumes a press that closed a layer - no toast, no exit', () => {
  const e = makeBackEnv();
  e.els.settingsPage.style.display = 'block';
  e.back();
  assert.equal(e.els.settingsPage.style.display, 'none');
  assert.deepEqual(e.calls.toasts, []);
  assert.equal(e.calls.exit, 0);
  assert.equal(e.calls.prevented, 1, 'default (instant app close) is always prevented');
});

test('G13: with nothing open - first Back toasts "press again", second within 2 s exits, a late second one only re-arms', () => {
  const e = makeBackEnv();
  e.tick(5000);
  e.back();
  assert.deepEqual(e.calls.toasts, ['toastBackToExit:info']);
  assert.equal(e.calls.exit, 0);
  e.tick(2500); e.back();                                        // too late -> new toast, still no exit
  assert.equal(e.calls.toasts.length, 2); assert.equal(e.calls.exit, 0);
  e.tick(500); e.back();                                         // within 2 s -> exit
  assert.equal(e.calls.exit, 1);
});

test('G13: Back during a NON-cancellable save/export warns ("still working") instead of silently arming the exit; double press still exits', () => {
  const e = makeBackEnv();
  e.tick(5000);
  e.els.loadingOverlay._cls.add('active');                       // loading overlay up, Cancel button hidden
  assert.equal(e.get('topmostLayerName()'), null);
  assert.equal(e.get('isBackBlockedByBusy()'), true);
  e.back();
  assert.deepEqual(e.calls.toasts, ['toastBackBusy:info']);
  assert.equal(e.calls.exit, 0);
  e.tick(300); e.back();
  assert.equal(e.calls.exit, 1, 'a stuck overlay can never trap the user');
});

test('G13: Escape and Back share closeTopmostLayer; the Cordova listener is registered on deviceready', () => {
  const e = makeBackEnv();
  assert.ok((e.listeners.deviceready || []).length === 1);
  assert.ok((e.listeners.keydown || []).length === 1);
  const init = read('js/core/init.js');
  assert.match(init, /document\.addEventListener\('backbutton', onBackKeyDown, false\)/);
});

// =====================================================================================================================
// G14 - CSS cascade
// =====================================================================================================================
function cssBlocks(file) {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) out.push({ sel: m[1].split(',').map((s) => s.trim()), decl: m[2] });
  return out;
}
const SIZE_DECL = /(^|[;\s])(min-|max-)?(height)\s*:/;

test('G14: .top-bar and .control-panel geometry (height / min / max) is declared ONLY in components.css', () => {
  for (const f of listFiles('css', '.css')) {
    if (f.endsWith('components.css')) continue;
    for (const b of cssBlocks(f)) {
      for (const exact of ['.top-bar', '.control-panel']) {
        if (b.sel.includes(exact)) assert.ok(!SIZE_DECL.test(b.decl), `${f}: ${exact} { ${b.decl.trim()} } duplicates the geometry`);
      }
    }
  }
  const comp = cssBlocks('css/components.css');
  assert.ok(comp.some((b) => b.sel.includes('.top-bar') && /height:\s*calc\(56px \+ env\(safe-area-inset-top/.test(b.decl)));
  assert.ok(comp.some((b) => b.sel.includes('.control-panel') && /height:\s*clamp\(244px, 34vh, 360px\)/.test(b.decl)));
  assert.ok(comp.some((b) => b.sel.includes('.control-panel') && /height:\s*clamp\(272px, 44dvh, 340px\)/.test(b.decl)), 'dvh variant kept');
});

test('G14: .top-bar keeps its safe-area top padding - no later padding shorthand can reset it', () => {
  const rules = cssBlocks('css/components.css').filter((b) => b.sel.includes('.top-bar'));
  const shorthand = rules.filter((b) => /(^|[;\s])padding\s*:/.test(b.decl));
  assert.equal(shorthand.length, 1, 'only the base rule uses the padding shorthand');
  assert.match(shorthand[0].decl, /padding:\s*env\(safe-area-inset-top, 0px\) 14px 0/);
  assert.ok(rules.some((b) => /padding-inline:\s*10px/.test(b.decl)) && rules.some((b) => /padding-inline:\s*8px/.test(b.decl)));
});

test('G14: no !important on .main-img (width/height/max-*) - inline style updates apply again; values unchanged', () => {
  for (const f of listFiles('css', '.css')) {
    for (const b of cssBlocks(f)) {
      if (b.sel.some((s) => /(^|[\s>])\.main-img(\.|$|\s|:)/.test(s) && !/\.compare-img/.test(s))) {
        assert.ok(!/!important/.test(b.decl), `${f}: .main-img rule uses !important`);
      }
    }
  }
  const base = cssBlocks('css/components.css').find((b) => b.sel.includes('.main-img'));
  assert.match(base.decl, /max-width:\s*100%/); assert.match(base.decl, /max-height:\s*100%/);
  assert.match(base.decl, /width:\s*auto/); assert.match(base.decl, /height:\s*auto/);
  // every inline write the app makes is exactly these values, so dropping !important cannot change the layout
  for (const f of ['js/core/file-handler.js', 'js/ui/reset.js', 'js/editing/crop.js', 'js/core/render-pipeline.js']) {
    const writes = [...read(f).matchAll(/(?:mainImg|img|main)\.style\.(width|height|maxWidth|maxHeight) = '([^']+)'/g)];
    for (const w of writes) assert.ok(w[2] === 'auto' || w[2] === '100%', `${f}: inline ${w[1]} = ${w[2]}`);
  }
});

test('G14: font smoothing is defined once (antialiased / grayscale) for every viewport', () => {
  let count = 0;
  for (const f of listFiles('css', '.css')) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/subpixel-antialiased/.test(css), f);
    count += (css.match(/-webkit-font-smoothing\s*:/g) || []).length;
  }
  assert.equal(count, 1);
  assert.match(read('css/base.css'), /-webkit-font-smoothing:\s*antialiased;\s*-moz-osx-font-smoothing:\s*grayscale/);
});

// =====================================================================================================================
// G15 - behaviour regressions
// =====================================================================================================================
function makeCanvas() {
  const c = { width: 0, height: 0, data: null };
  c.getContext = () => ({
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    clearRect() {},
    drawImage(src) { c.data = Uint8ClampedArray.from(src.data); },       // sources are always the same size here
    getImageData() { return { data: Uint8ClampedArray.from(c.data), width: c.width, height: c.height }; },
    putImageData(id) { c.data = Uint8ClampedArray.from(id.data); },
  });
  return c;
}

// R,G,B,A for: pure red, orange, yellow-green, mid grey (64), mid grey (128), pure blue, skin, white
const PIXELS = [[220, 30, 30], [230, 140, 30], [150, 200, 40], [64, 64, 64], [128, 128, 128], [30, 40, 210], [224, 172, 140], [255, 255, 255]];
const W = 4, H = 2;

function loadPipeline() {
  const sandbox = { console, Math, JSON, Uint8Array, Uint8ClampedArray, Float32Array, Object, Array, Promise,
    document: { createElement: () => makeCanvas(), getElementById: () => null } };
  createContext(sandbox);
  const data = new Uint8ClampedArray(W * H * 4);
  PIXELS.forEach((p, i) => { data.set([p[0], p[1], p[2], 255], i * 4); });
  sandbox.__img = { src: 'blob:photo', naturalWidth: W, naturalHeight: H, width: W, height: H, data };
  vm.runInContext(`
    const sliders = { bright:0, contrast:0, exposure:0, shadows:0, whites:0, blacks:0, sat:0, vibrance:0, warmth:0, tint:0, sharp:0, clarity:0, vignette:0, grain:0 };
    let chosenPreset = 'none';
    let colorMixData = [0,1,2,3,4,5,6,7].map(() => ({ hue:0, sat:0, lum:0 }));
    let curvesData = {};
    const curvesLUT = {};
    const allPresets = [{ id:'none', style:'' }, { id:'moon', style:'moon' }];
    var originalImage = __img;
    var GPU = { render() { return null; }, isAvailable() { return false; }, maxTextureSize() { return 4096; }, release() {} };   // no WebGL: both paths use the CPU engine
  `, sandbox);
  for (const f of ['js/editing/curves.js', 'js/editing/presets.js', 'js/editing/sliders.js', 'js/editing/effects.js',
                   'js/editing/color-mix-apply.js', 'js/core/render-pipeline.js']) vm.runInContext(read(f), sandbox);
  vm.runInContext(`
    function defaults(){ return [{x:0,y:0},{x:64,y:64},{x:128,y:128},{x:192,y:192},{x:255,y:255}]; }
    curvesData = { rgb: defaults(), red: defaults(), green: defaults(), blue: defaults() };
    buildCurvesLUTs();
  `, sandbox);
  const run = (c) => vm.runInContext(c, sandbox);
  const px = (arr) => Array.from({ length: W * H }, (_, i) => Array.from(arr.slice(i * 4, i * 4 + 3)));
  // Preview path and export path, exactly as the app calls them
  const preview = () => { const cv = makeCanvas(); cv.width = W; cv.height = H; run('YoPipeline'); sandbox.__ctx = cv.getContext('2d'); sandbox.__cv = cv;
    run('YoPipeline.renderPreview(__ctx, ' + W + ', ' + H + ')'); return px(cv.data); };
  const exported = () => { const t = makeCanvas(); sandbox.__t = t; run('YoPipeline.renderEditedCanvas(originalImage, ' + W + ', ' + H + ', __t)'); return px(t.data); };
  return { run, preview, exported, original: PIXELS.map((p) => p.slice()) };
}

test('G15: preview and export render IDENTICAL pixels for the same edit state (sliders + filter + curves + Color Mix + vignette + grain)', () => {
  const e = loadPipeline();
  e.run(`
    sliders.exposure = 25; sliders.warmth = 18; sliders.vibrance = 22; sliders.tint = -10; sliders.shadows = 15;
    sliders.bright = 10; sliders.contrast = 12; sliders.sat = 8;               // CSS-filter chain part
    sliders.vignette = -30; sliders.grain = 20;
    colorMixData[0].hue = 25; colorMixData[0].sat = 30; colorMixData[5].lum = -20;
    curvesData.red = [{x:0,y:0},{x:64,y:96},{x:128,y:128},{x:192,y:192},{x:255,y:255}];
    invalidateCurveCache('red'); buildCurveLUT('red');
  `);
  assert.equal(e.run('YoPipeline.needsBake()'), true);
  const a = e.preview(), b = e.exported();
  assert.deepEqual(a, b, 'the export must be exactly what the preview shows');
  assert.notDeepEqual(a, e.original, 'the edits really changed something');
});

test('G15: preview and export both return the photo untouched when there are no edits', () => {
  const e = loadPipeline();
  assert.equal(e.run('YoPipeline.needsBake()'), false);
  assert.deepEqual(e.exported(), e.original);
  assert.deepEqual(e.preview(), e.original);
});

test('G15: per-channel curves - editing ONLY red / green / blue changes only that channel, identically in preview and export', () => {
  for (const [ch, idx] of [['red', 0], ['green', 1], ['blue', 2]]) {
    const e = loadPipeline();
    e.run(`curvesData.${ch} = [{x:0,y:0},{x:64,y:110},{x:128,y:128},{x:192,y:192},{x:255,y:255}]; invalidateCurveCache('${ch}'); buildCurveLUT('${ch}');`);
    assert.equal(e.run('YoPipeline.needsPixelPass()'), true, ch + ' edit is detected');
    const out = e.exported();
    assert.deepEqual(out, e.preview(), ch + ': preview == export');
    const grey = out[3];                                        // input (64,64,64)
    assert.ok(grey[idx] > 64 + 15, `${ch} channel of the grey pixel was lifted (${grey[idx]})`);
    for (let c = 0; c < 3; c++) if (c !== idx) assert.equal(grey[c], 64, `${ch}: other channels untouched`);
    assert.deepEqual(out[7], [255, 255, 255], 'white stays white (curve end point is fixed)');
  }
});

test('G15: Color Mix is isolated by hue - a red tweak leaves blue and neutral pixels alone; a blue tweak leaves red alone; preview == export', () => {
  const e = loadPipeline();
  e.run('colorMixData[0].hue = 40; colorMixData[0].sat = 50;');     // channel 0 = Red
  const out = e.exported();
  assert.deepEqual(out, e.preview());
  assert.notDeepEqual(out[0], e.original[0], 'pure red moved');
  for (const i of [3, 4, 5, 7]) assert.deepEqual(out[i], e.original[i], 'pixel ' + i + ' (grey / blue / white) untouched');

  const f = loadPipeline();
  f.run('colorMixData[5].hue = -40; colorMixData[5].sat = 50;');    // channel 5 = Blue
  const o2 = f.exported();
  assert.deepEqual(o2, f.preview());
  assert.notDeepEqual(o2[5], f.original[5], 'pure blue moved');
  assert.deepEqual(o2[0], f.original[0], 'red untouched by a blue tweak');
  assert.deepEqual(o2[4], f.original[4], 'neutral grey untouched');
});

// ---- frame state across undo / new uploads --------------------------------------------------------------------------
function makeHistoryEnv() {
  const revoked = [];
  const mainImg = { src: '' };
  const sandbox = { console, Map, Set, JSON, Math, Promise, Object, setTimeout, clearTimeout, navigator: { deviceMemory: 8 },
    URL: { revokeObjectURL: (u) => revoked.push(u), createObjectURL: () => 'blob:x' },
    document: { getElementById: (id) => (id === 'mainImg' ? mainImg : (id === 'undoBtn' ? { style: {} } : null)) }, window: {} };
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
  vm.runInContext(read('js/core/history.js'), sandbox);
  const ff = read('js/editing/fit-frame.js');
  vm.runInContext(ff.slice(ff.indexOf('// ===================== FRAME STATE (history / reset)'), ff.indexOf('// ===================== NEW FRAME FUNCTIONS')), sandbox);
  const set = (c) => vm.runInContext(c, sandbox), get = (c) => vm.runInContext(c, sandbox);
  const commit = (url) => { sandbox.__u = url; set(`registerImageUrl(__u, 1000); originalImage = { src: __u, naturalWidth: 10, naturalHeight: 10 }; saveToHistory();`); };
  return { set, get, commit, revoked };
}

test('G15: frame state - every undo step restores ITS frame (gold -> neon -> none), and the controls with it', () => {
  const e = makeHistoryEnv();
  e.commit('blob:a');                                                                               // 0: no frame
  e.set(`activeFrameId = 'gold'; fitMode = 'gold'; frameControls.thickness = 40; saveToHistory();`);     // 1: gold / 40
  e.set(`activeFrameId = 'neon'; fitMode = 'neon'; frameControls.thickness = 25; frameControls.useCustomColor = true; saveToHistory();`); // 2: neon / 25
  e.set('undoEdit();');
  assert.equal(e.get('activeFrameId'), 'gold'); assert.equal(e.get('frameControls.thickness'), 40);
  assert.equal(e.get('frameControls.useCustomColor'), false, 'custom colour flag restored too');
  e.set('undoEdit();');
  assert.equal(e.get('activeFrameId'), 'none'); assert.equal(e.get('fitMode'), 'normal');
  e.set('undoEdit();');                                                                              // already at the first state
  assert.equal(e.get('historyIndex'), 0); assert.equal(e.get('activeFrameId'), 'none');
});

test('G15: frame state - a NEW upload starts clean: old frame cleared, history reset, undo can never resurrect the previous photo\'s frame', () => {
  const e = makeHistoryEnv();
  e.commit('blob:old');
  e.set(`activeFrameId = 'gold'; fitMode = 'gold'; frameControls.thickness = 55; saveToHistory();`);
  // what file-handler does for a fresh upload
  e.set('resetHistory(); resetFrameState();');
  e.commit('blob:new');
  assert.equal(e.get('activeFrameId'), 'none');
  assert.equal(e.get('frameControls.thickness'), 20, 'controls back to defaults');
  assert.equal(e.get('historyStack.length'), 1);
  assert.equal(e.get('historyStack[0].frame.id'), 'none', 'baseline state of the new photo carries no frame');
  e.set('undoEdit();');
  assert.equal(e.get('activeFrameId'), 'none');
  assert.ok(e.revoked.includes('blob:old'), 'the previous photo was released');
});

// ---- swipe gestures ---------------------------------------------------------------------------------------------------
function makeSwipeEnv() {
  const handlers = {}, state = { undo: 0, hint: null };
  let clock = 10000, paintOn = false;
  const hint = { innerText: '', classList: { add() {}, remove() {} } };
  const viewport = { addEventListener: (t, f) => { handlers[t] = f; } };
  const sandbox = { console, Math, setTimeout: () => 0, __state: state,
    Date: { now: () => clock },
    window: { t: (k) => k },
    document: { getElementById: (id) => (id === 'viewport' ? viewport : (id === 'swipeHint' ? hint : null)),
                querySelector: () => (paintOn ? {} : null) } };
  createContext(sandbox);
  vm.runInContext(`let originalImage = {}, historyIndex = 3, isCropMode = false, _holdOriginalActive = false, overlayManager = null;
                   function undoEdit() { __state.undo++; }`, sandbox);
  vm.runInContext(read('js/ui/gestures.js'), sandbox);
  vm.runInContext('initSwipeGestures();', sandbox);
  const start = (x, y, target, touches) => handlers.touchstart({ touches: touches || [{ clientX: x, clientY: y }], target: target || { closest: () => null } });
  const end = (x, y) => handlers.touchend({ changedTouches: [{ clientX: x, clientY: y }] });
  const swipe = (dx, dy, ms, opts) => { opts = opts || {}; start(100, 300, opts.target, opts.touches); clock += ms; end(100 + dx, 300 + dy); };
  return { state, hint, swipe, start, end, tick: (ms) => { clock += ms; }, handlers,
           set: (c) => vm.runInContext(c, sandbox), setPaint: (v) => { paintOn = v; } };
}

test('G15: swipe right undoes (when there is history); at the first state it only hints "nothing to undo"; swipe left never undoes', () => {
  const e = makeSwipeEnv();
  e.swipe(140, 10, 200);
  assert.equal(e.state.undo, 1); assert.equal(e.hint.innerText, 'undo');
  e.set('historyIndex = 0;');
  e.swipe(140, 10, 200);
  assert.equal(e.state.undo, 1); assert.equal(e.hint.innerText, 'swipeNothingToUndo');
  e.swipe(-140, 10, 200);
  assert.equal(e.state.undo, 1); assert.equal(e.hint.innerText, 'swipeRedoSoon');
});

test('G15: swipe thresholds - too short, too slow, too fast or too diagonal never undo; a photo is required', () => {
  const e = makeSwipeEnv();
  e.swipe(60, 0, 200);       // < 80 px
  e.swipe(140, 0, 700);      // slower than 600 ms
  e.swipe(140, 0, 20);       // faster than 50 ms (a tap-jitter, not a swipe)
  e.swipe(140, 150, 200);    // mostly vertical
  assert.equal(e.state.undo, 0);
  e.set('originalImage = null;');
  e.swipe(140, 0, 200);
  assert.equal(e.state.undo, 0, 'no photo -> nothing to undo');
});

test('G15: swipe is blocked while a tool uses horizontal drags - two fingers, controls, crop, eraser paint, overlay selection, hold-to-compare, touchcancel', () => {
  const e = makeSwipeEnv();
  e.swipe(140, 0, 200, { touches: [{ clientX: 1, clientY: 1 }, { clientX: 9, clientY: 9 }] });   // pinch
  e.swipe(140, 0, 200, { target: { closest: () => ({}) } });                                           // started on a button / canvas overlay
  e.set('isCropMode = true;');            e.swipe(140, 0, 200); e.set('isCropMode = false;');
  e.setPaint(true);                        e.swipe(140, 0, 200); e.setPaint(false);
  e.set('overlayManager = { selectedId: 3, isDragging: false, isResizing: false, isRotating: false };'); e.swipe(140, 0, 200);
  e.set('overlayManager = { selectedId: null, isDragging: true, isResizing: false, isRotating: false };'); e.swipe(140, 0, 200);
  e.set('overlayManager = null; _holdOriginalActive = true;');                                         e.swipe(140, 0, 200);
  e.set('_holdOriginalActive = false;');
  e.start(100, 300); e.handlers.touchcancel(); e.tick(200); e.end(240, 300);                          // OS stole the touch
  assert.equal(e.state.undo, 0, 'no blocked gesture may undo');
  e.swipe(140, 0, 200);                                                                              // and the very next clean swipe works again
  assert.equal(e.state.undo, 1);
});

run('v25_test');
