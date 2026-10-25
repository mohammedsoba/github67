// 1 -> 100 loading counter + Hugging Face CSP hosts. Plain Node, no dependencies.
// Loads the REAL progress-counter.js and loading-toast.js into vm sandboxes with a fake clock and minimal DOM stubs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

// ---------------------------------------------------------------------------------------------------- fake clock
function makeClock() {
  let t = 0, id = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { q.set(++id, { fn, at: t + (ms || 0) }); return id; },
    clearTimeout: (i) => { q.delete(i); },
    pending: () => q.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, e] of q) if (e.at <= end && (!next || e.at < next.e.at)) next = { i, e };
        if (!next) break;
        q.delete(next.i); t = Math.max(t, next.e.at); next.e.fn();
      }
      t = end;
    },
  };
}

// An element stub: only what the code under test may touch.
function stubEl(id) {
  const classes = new Set();
  return {
    id, hidden: false, innerText: '', textContent: '', style: {}, onclick: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    _classes: classes,
  };
}

// A sandbox with the registry, a fake clock and the given app files loaded in order.
function makeEnv(files) {
  const clock = makeClock();
  const els = {};
  const sb = { console, Math, Date, JSON, Number, String, performance: { now: clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  sb.window = sb; sb.globalThis = sb;
  sb.document = { getElementById: (id) => (els[id] = els[id] || stubEl(id)) };
  createContext(sb);
  vm.runInContext('var isProcessing = false; var originalImage = null;', sb);
  for (const f of files) vm.runInContext(read(f), sb, { filename: f });
  const proc = () => vm.runInContext('isProcessing', sb);
  return { sb, els, clock, proc };
}
const BOTH = ['js/ui/progress-counter.js', 'js/ui/loading-toast.js'];

// =====================================================================================================================
// the curve
// =====================================================================================================================
const YP = (() => { const e = makeEnv(['js/ui/progress-counter.js']); return e.sb.YoProgress; })();

test('curve: starts at 1, whole numbers only, never above 99 - not even after a million years', () => {
  assert.equal(YP.percentAt(0, 8000), 1);
  assert.equal(YP.percentAt(-50, 8000), 1);
  for (const t of [1, 10, 500, 8000, 60000, 3.6e6, 1e12, Number.MAX_VALUE]) {
    const p = YP.percentAt(t, 8000);
    assert.ok(Number.isInteger(p) && p >= 1 && p <= 99, t + ' ms -> ' + p);
  }
});

test('curve: monotonic (never goes backwards) for several expected durations', () => {
  for (const expected of [0, 100, 1500, 8000, 30000, 1e9]) {
    let prev = 0;
    for (let t = 0; t <= 600000; t += 50) {
      const p = YP.percentAt(t, expected);
      assert.ok(p >= prev, 'expected=' + expected + ' t=' + t + ': ' + p + ' < ' + prev);
      prev = p;
    }
  }
});

test('curve: paced by the expected time (about 80 % there) and it keeps creeping - never a frozen "99 %"', () => {
  const at = (t) => YP.percentAt(t, 8000);
  assert.ok(at(1000) >= 15 && at(1000) <= 35, '1 s: ' + at(1000));
  assert.ok(at(8000) >= 70 && at(8000) <= 90, 'expected time: ' + at(8000));
  assert.ok(at(40000) > at(16000) && at(80000) > at(40000) && at(320000) > at(80000), 'still moving long after the expected time');
  assert.ok(at(320000) <= 99);
  // a learned duration changes the pace: the same instant is further along when the operation is usually faster
  assert.ok(YP.percentAt(3000, 4000) > YP.percentAt(3000, 20000));
});

test('curve: junk input falls back to the default pace instead of NaN', () => {
  for (const bad of [undefined, null, NaN, -1, 0, Infinity, '5000', {}]) assert.equal(YP.percentAt(4000, bad), YP.percentAt(4000, YP.DEFAULT_EXPECTED_MS), String(bad));
  for (const bad of [NaN, Infinity, '12', null, undefined, {}]) assert.equal(YP.percentAt(bad, 8000), 1, String(bad));
  assert.equal(YP.percentAt(1500, 5), YP.percentAt(1500, 1500), 'a tiny learned duration is clamped, it must not race to 90 % and stall');
});

// =====================================================================================================================
// the controller
// =====================================================================================================================
function controller() {
  const clock = makeClock();
  const writes = [];
  const num = { set textContent(v) { writes.push(v); this._v = v; }, get textContent() { return this._v; } };
  const arc = { style: {} };
  const ctl = YP.attach({ num, arc }, { now: clock.now, schedule: (fn) => { const id = clock.setTimeout(fn, 16); return () => clock.clearTimeout(id); } });
  return { ctl, clock, num, arc, writes };
}

test('controller: start() shows 1 and an almost empty ring; the number climbs with time and the ring follows', () => {
  const c = controller();
  c.ctl.start(8000);
  assert.equal(c.num.textContent, '1');
  assert.equal(c.arc.style.strokeDashoffset, (326.73 * 0.99).toFixed(2));
  c.clock.advance(4000);
  const mid = Number(c.num.textContent);
  assert.ok(mid > 40 && mid < 90, String(mid));
  assert.equal(c.arc.style.strokeDashoffset, (326.73 * (1 - mid / 100)).toFixed(2));
  assert.equal(c.ctl.value(), mid);
});

test('controller: writes the DOM only when the whole number changes, and never writes a smaller number', () => {
  const c = controller();
  c.ctl.start(8000);
  c.clock.advance(20000);
  assert.deepEqual(c.writes, [...new Set(c.writes)], 'no repeated value written');
  const nums = c.writes.map(Number);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'ascending');
});

test('controller: only finish() reaches 100 - an hour of waiting stays below it; finish() stops the clock', () => {
  const c = controller();
  c.ctl.start(8000);
  c.clock.advance(3.6e6);
  assert.ok(c.ctl.value() <= 99, String(c.ctl.value()));
  c.ctl.finish();
  assert.equal(c.num.textContent, '100');
  assert.equal(c.arc.style.strokeDashoffset, '0.00');
  assert.equal(c.clock.pending(), 0, 'no timer left running');
  const w = c.writes.length;
  c.clock.advance(60000);
  assert.equal(c.writes.length, w, 'nothing is written after finish()');
});

test('controller: start() twice never leaves two loops running; reset() stops everything; start() restarts at 1', () => {
  const c = controller();
  c.ctl.start(8000); c.ctl.start(8000); c.ctl.start(8000);
  assert.equal(c.clock.pending(), 1, 'exactly one pending tick');
  c.clock.advance(5000);
  assert.ok(c.ctl.value() > 30);
  c.ctl.reset();
  assert.equal(c.clock.pending(), 0);
  c.ctl.start(8000);
  assert.equal(c.ctl.value(), 1, 'a new run counts from 1 again');
});

test('controller: missing elements never throw; an SVG node without .style falls back to setAttribute', () => {
  const c0 = YP.attach({}, { now: () => 0, schedule: () => () => {} });
  c0.start(); c0.finish(); c0.reset();
  const attrs = {};
  const c1 = YP.attach({ arc: { setAttribute: (k, v) => { attrs[k] = v; } } }, { now: () => 0, schedule: () => () => {} });
  c1.start(1000);
  assert.equal(attrs['stroke-dashoffset'], (326.73 * 0.99).toFixed(2));
  assert.doesNotThrow(() => YP.attach().start());
});

// =====================================================================================================================
// the loading overlay (REAL loading-toast.js)
// =====================================================================================================================
test('overlay: without opts.progress nothing changes - the spinner shows, no counter, no finish layer', () => {
  const e = makeEnv(BOTH);
  e.sb.showLoading('Loading image…');
  assert.equal(e.els.loadingOrb.hidden, true);
  assert.equal(e.els.loadingSpinner.hidden, false);
  assert.equal(e.els.loadingOverlay.classList.contains('active'), true);
  assert.equal(e.proc(), true);
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('active'), false);
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  assert.equal(e.proc(), false);
  assert.equal(e.clock.pending(), 0);
});

test('overlay: opts.progress swaps the spinner for the orb and counts up from 1', () => {
  const e = makeEnv(BOTH);
  e.sb.showLoading('Removing object…', { progress: { expectedMs: 6000 } });
  assert.equal(e.els.loadingOrb.hidden, false);
  assert.equal(e.els.loadingSpinner.hidden, true);
  assert.equal(e.els.loadingPercent.textContent, '1');
  e.clock.advance(3000);
  assert.ok(Number(e.els.loadingPercent.textContent) > 30, e.els.loadingPercent.textContent);
  assert.equal(e.els.loadingText.innerText, 'Removing object…');
});

test('overlay: hideLoading() closes synchronously, snaps to 100, then the click-through finish layer fades out', () => {
  const e = makeEnv(BOTH);
  e.sb.showLoading('Working…', { progress: true });
  e.clock.advance(2000);
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('active'), false, 'closed at once');
  assert.equal(e.proc(), false, 'isProcessing cleared at once (nothing waits for the fade)');
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true);
  assert.equal(e.els.loadingPercent.textContent, '100');
  e.clock.advance(500);
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true, 'still visible inside the 520 ms window');
  e.clock.advance(30);
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  assert.equal(e.clock.pending(), 0, 'no timer leaked');
});

test('overlay: a new operation during the finish fade removes it at once and counts from 1 again', () => {
  const e = makeEnv(BOTH);
  e.sb.showLoading('A', { progress: true });
  e.clock.advance(3000);
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true);
  e.sb.showLoading('B', { progress: true });
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  assert.equal(e.els.loadingOverlay.classList.contains('active'), true);
  assert.equal(e.els.loadingPercent.textContent, '1');
  assert.equal(e.clock.pending(), 1, 'only B\'s tick is pending - the old finish timer was cleared');
  e.sb.showLoading('C');                               // a plain operation right after a counted one: spinner is back, loop stopped
  assert.equal(e.els.loadingOrb.hidden, true);
  assert.equal(e.els.loadingSpinner.hidden, false);
  assert.equal(e.clock.pending(), 0);
});

test('overlay: the finish layer keeps the Cancel button\'s space only when a Cancel button was showing (nothing jumps)', () => {
  const e = makeEnv(BOTH);
  e.els.loadingCancel = Object.assign(stubEl('loadingCancel'), { hidden: true });
  e.sb.showLoading('With cancel', { progress: true, onCancel: () => {} });
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('keep-cancel-space'), true);
  e.clock.advance(600);
  assert.equal(e.els.loadingOverlay.classList.contains('keep-cancel-space'), false, 'removed together with the finish layer');
  e.sb.showLoading('Without cancel', { progress: true });
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true);
  assert.equal(e.els.loadingOverlay.classList.contains('keep-cancel-space'), false, 'no Cancel was showing: no reserved gap');
  e.sb.showLoading('Next');                            // a new operation clears both classes at once
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
});

test('overlay: Cancel closes at once with no "100 %" finish', () => {
  const e = makeEnv(BOTH);
  let cancelled = 0;
  e.sb.showLoading('Working…', { progress: true, onCancel: () => cancelled++ });
  e.clock.advance(2000);
  e.els.loadingCancel.onclick({ preventDefault() {} });
  assert.equal(cancelled, 1);
  assert.equal(e.els.loadingOverlay.classList.contains('active'), false);
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  assert.notEqual(e.els.loadingPercent.textContent, '100');
  assert.equal(e.clock.pending(), 0);
  e.sb.hideLoading();                                  // the feature's own finally-block hides again: still nothing
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
});

test('overlay: a failure is not celebrated - an error toast during the run (or during the fade) means no "100 %"', () => {
  const e = makeEnv(BOTH);
  e.sb.showLoading('Working…', { progress: true });
  e.clock.advance(1000);
  e.sb.showToast('Could not erase', 'error');          // the eraser toasts the error BEFORE its finally-block hides the overlay
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  assert.notEqual(e.els.loadingPercent.textContent, '100');
  assert.equal(e.clock.pending(), 1, 'only the toast\'s own auto-hide timer remains - no counter or finish timer');
  e.clock.advance(5001);
  assert.equal(e.clock.pending(), 0);
  // hide first, toast second: the fade that already started is cut short
  e.sb.showLoading('Again', { progress: true });
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true);
  e.sb.showToast('Late error', 'error');
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  // success / info toasts never interfere, and the NEXT run starts clean even after an error
  e.sb.showLoading('Next', { progress: true });
  e.sb.showToast('Saved', 'success');
  e.sb.hideLoading();
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), true);
});

test('overlay: hideLoading() with nothing showing (double call, or after a plain spinner) is harmless', () => {
  const e = makeEnv(BOTH);
  assert.doesNotThrow(() => { e.sb.hideLoading(); e.sb.hideLoading(); });
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
  e.sb.showLoading('x', { progress: true });
  e.sb.hideLoading(); e.sb.hideLoading();              // the second call must not restart the fade
  assert.equal(e.clock.pending(), 1, 'one finish timer, not two');
});

test('overlay: if progress-counter.js is missing the plain spinner is used and nothing throws', () => {
  const e = makeEnv(['js/ui/loading-toast.js']);       // engine not loaded
  assert.doesNotThrow(() => e.sb.showLoading('x', { progress: true }));
  assert.equal(e.els.loadingOrb.hidden, true);
  assert.equal(e.els.loadingSpinner.hidden, false);
  assert.doesNotThrow(() => e.sb.hideLoading());
  assert.equal(e.els.loadingOverlay.classList.contains('finishing'), false);
});

// =====================================================================================================================
// who asks for the counter
// =====================================================================================================================
test('wiring: the long AI tools ask for the counter; quick operations deliberately do not', () => {
  assert.match(read('js/editing/ai-common.js'), /showLoading\(title \|\| window\.t\('processing'\), \{ progress: true \}\)/);
  const eraser = read('js/editing/magic-eraser.js');
  assert.match(eraser, /const expectedMs = runs\.length >= ETA_MIN_SAMPLES \? medianOf\(runs\) : 0;/);
  assert.match(eraser, /showLoading\(tr\('removingObject'[^\n]*progress: \{ expectedMs: expectedMs \}/);
  for (const f of ['js/core/file-handler.js', 'js/editing/presets.js', 'js/editing/ai-auto.js', 'js/ui/modals-export.js'])
    assert.ok(!/progress\s*:/.test(read(f)), f + ' is a quick operation - no counter');
  const portrait = read('js/portrait/portrait-mode.js');
  assert.match(portrait, /window\.aiLoader\.show\('portrait'\)/, 'Portrait goes through the AILoadingManager');
  assert.ok(!/YoProgress\.attach/.test(portrait), 'the manager owns the portrait counter now');
});

// =====================================================================================================================
// markup, scripts, CSS
// =====================================================================================================================
test('markup: both orbs exist, are decorative (aria-hidden), keep their numbers left-to-right, and the overlay spinner is addressable', () => {
  for (const id of ['loadingOrb', 'loadingArc', 'loadingPercent', 'loadingSpinner', 'portraitArc', 'portraitPercent'])
    assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /<div class="yo-orb" id="loadingOrb" aria-hidden="true" hidden>/);
  assert.match(html, /<div class="yo-orb yo-orb--sm" aria-hidden="true">/);
  assert.equal((html.match(/<span class="yo-orb__count" dir="ltr">/g) || []).length, 2, 'dir=ltr: "45%" never flips to "%45" in Arabic');
  assert.ok(html.indexOf('id="loadingOrb"') < html.indexOf('id="loadingText"'), 'orb sits above the status text');
  assert.ok(!/portrait-canvas-spinner/.test(html), 'the old bare spinner is gone');
  assert.equal((html.match(/class="yo-orb__orbit"/g) || []).length, 2, 'both orbs carry the counter-rotating CSS ring');
});

test('scripts / CSS: the engine loads after the registry and BEFORE its two users; the stylesheet loads before rtl.css', () => {
  const at = (s) => html.indexOf('src="./js/' + s + '"');
  assert.ok(at('core/namespace.js') < at('ui/progress-counter.js'));
  assert.ok(at('ui/progress-counter.js') > 0 && at('ui/progress-counter.js') < at('ui/loading-toast.js'));
  assert.ok(at('ui/progress-counter.js') < at('portrait/portrait-mode.js'));
  assert.match(html.slice(html.lastIndexOf('<script', at('ui/progress-counter.js')), html.indexOf('</script>', at('ui/progress-counter.js'))), /defer/);
  const css = (f) => html.indexOf('href="./css/' + f + '"');
  assert.ok(css('loading-orb.css') > css('edge-ai.css') && css('loading-orb.css') < css('rtl.css'), 'rtl.css must stay last');
});

test('CSS: hidden respected, finish layer is click-through, only transform/opacity are animated, reduced motion honoured', () => {
  const css = read('css/loading-orb.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.yo-orb\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.loading-overlay\.finishing\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.loading-overlay\.finishing\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.loading-overlay\.finishing\.keep-cancel-space \.island-cancel\s*\{[^}]*visibility:\s*hidden/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const kf of css.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)) {
    const props = [...kf[2].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.length > 0 && props.every((p) => p === 'transform' || p === 'opacity'), kf[1] + ' animates ' + props.join(','));
  }
  assert.match(css, /stroke-dasharray:\s*326\.73/, 'ring length matches RING_LENGTH in progress-counter.js');
  assert.match(read('js/ui/progress-counter.js'), /RING_LENGTH = 326\.73/);
  assert.ok(!/margin-(left|right)\s*:/.test(css), 'logical margins only (RTL)');
});

test('portrait: the orb sits top-centre (bottom-centre overlapped the floating Original button on 320 / 360 / 390 px phones)', () => {
  const css = read('css/portrait.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.portrait-canvas-loader\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /flex-direction:\s*column/);          // orb + status line, stacked
  assert.match(rule, /justify-content:\s*flex-start/);     // column direction: flex-start = top edge
  assert.match(rule, /padding-top:\s*16px/);
  assert.ok(!/flex-end|padding-bottom/.test(rule));
  assert.match(rule, /pointer-events:\s*none/, 'the loader never takes touches: the blur slider stays usable while it runs');
});

test('new engine: no inline handlers, no innerHTML / eval / document.write, no storage, no network', () => {
  const src = read('js/ui/progress-counter.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bon(?:click|change|input)\s*=/.test(src));
  assert.ok(!/\binnerHTML\b|\beval\s*\(|new Function\(|document\.write|localStorage|sessionStorage|\bfetch\s*\(|XMLHttpRequest/.test(src));
});

// =====================================================================================================================
// Content-Security-Policy: Hugging Face download hosts
// =====================================================================================================================
const cspOf = (h) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
const directive = (csp, name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/).slice(1);

test('CSP: connect-src allows the Hugging Face hosts (the CDN a model download is redirected to is re-checked by CSP)', () => {
  // the stamped native API host (version.json, if configured) sits in front of the fixed hosts: it is not part of what this test pins
  const nativeBase = JSON.parse(read('version.json')).native_api_base;
  const connect = directive(cspOf(html), 'connect-src').filter((host) => !nativeBase || host !== nativeBase);
  for (const host of ['https://*.aws.cdn.hf.co', 'https://*.huggingface.co', 'https://*.hf.co']) assert.ok(connect.includes(host), host + ' missing from connect-src');
  // the fixed entries start right after the stamped span (sync_version.py rewrites only the span before https://*.aws.cdn.hf.co)
  assert.deepEqual(connect, ["'self'", 'blob:', 'data:', 'https://*.aws.cdn.hf.co', 'https://*.huggingface.co', 'https://*.hf.co']);
  assert.ok(!/jsdelivr|googleapis/.test(connect.join(' ')), 'MediaPipe is served from this origin: no CDN host in connect-src');
});

test('CSP: the new hosts open connect-src ONLY - never scripts, images, styles, frames or workers; nothing else was loosened', () => {
  const csp = cspOf(html);
  for (const d of ['default-src', 'script-src', 'img-src', 'style-src', 'font-src', 'media-src', 'worker-src', 'object-src', 'base-uri', 'form-action'])
    assert.ok(!/hf\.co|huggingface/.test(directive(csp, d).join(' ')), d + ' must not list Hugging Face');
  assert.deepEqual(directive(csp, 'script-src'), ["'self'", "'wasm-unsafe-eval'"]);       // no third-party script host at all
  assert.deepEqual(directive(csp, 'default-src'), ["'self'"]);
  assert.deepEqual(directive(csp, 'object-src'), ["'none'"]);
  assert.ok(!csp.includes("'unsafe-eval'") && !/connect-src[^;]*\s\*(\s|;|$)/.test(csp + ';'), 'no unsafe-eval, no bare * in connect-src');
  for (const src of directive(csp, 'connect-src')) assert.ok(/^'self'$|^blob:$|^data:$|^https:\/\//.test(src), 'only https hosts: ' + src);
});

test('CSP: the server header (PAGE_CSP) adds no connect-src, so the <meta> policy above is the single authority', () => {
  const sec = read('backend/app/security.py');
  const page = /PAGE_CSP = "([^"]+)"/.exec(sec)[1];
  assert.ok(!/connect-src|default-src|script-src/.test(page), page);
});

test('CSP: sync_version.py stamping keeps the new hosts when a model URL is configured (and --check passes as shipped)', () => {
  const run = (args, code) => {
    for (const bin of ['python3', 'python']) {
      const r = code ? spawnSync(bin, ['-c', code], { cwd: root, encoding: 'utf8' }) : spawnSync(bin, args, { cwd: root, encoding: 'utf8' });
      if (!r.error) return r;
    }
    return null;
  };
  const check = run(['scripts/sync_version.py', '--check']);
  if (!check) { console.log('       (no python on PATH - skipped)'); return; }
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const code = [
    'import sys; sys.path.insert(0, "scripts")',
    'import sync_version as sv',
    'html = open("index.html", encoding="utf-8").read()',
    'rx = [t for t in sv.TARGETS["index.html"] if "connect-src" in t[1]][0][0]',
    'meta = {"native_api_base": "https://api.example-app.com", "edge_model_origin": "https://huggingface.co"}',
    'out = rx.sub(lambda m: m.group(1) + sv.csp_value(meta) + m.group(3), html)',
    'print(out.split("connect-src ")[1].split(";")[0])',
  ].join('\n');
  const r = run(null, code);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(),
    "'self' blob: data: https://api.example-app.com https://huggingface.co https://*.aws.cdn.hf.co https://*.huggingface.co https://*.hf.co");
});

run('loading_progress');

// =====================================================================================================================
// Portrait loader: status text + the same "snap to 100" finish as the overlay
// =====================================================================================================================
test('portrait loader: has a status line (en + ar); the manager completes on success and hides otherwise', () => {
  assert.match(html, /id="portraitLoaderText" data-i18n="processingPortrait">Processing portrait/);
  const i18n = read('js/i18n/i18n.js');
  assert.equal((i18n.match(/processingPortrait:/g) || []).length, 2, 'English and Arabic');
  const portrait = read('js/portrait/portrait-mode.js');
  const callAt = portrait.indexOf('var loaderTicket = loaderShow();');
  const completeAt = portrait.indexOf('loaderComplete(loaderTicket);');
  const catchAt = portrait.indexOf("console.error('Portrait error:'");
  const finallyHide = portrait.indexOf('loaderHide(loaderTicket);');
  assert.ok(callAt > 0 && callAt < portrait.indexOf('YoEdgePortrait.run('), 'show() runs before the inference call');
  assert.ok(completeAt > callAt && completeAt < catchAt, 'complete() is on the success path only');
  assert.ok(finallyHide > catchAt, 'hide() is in the error/finally path');
  const css = read('css/loading-orb.css');
  assert.match(css, /\.portrait-canvas-loader\.finishing \{ animation: yoOverlayOut/);
});
