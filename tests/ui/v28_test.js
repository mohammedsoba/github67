// V28 - launch splash. Plain Node, no dependencies (same harness as the other suites).
// Static guarantees (inline critical CSS, markup, i18n EN+AR, reduced motion, compositor-only animation, old CSS gone) plus the
// REAL js/ui/splash.js driven by a virtual clock: floor, ready-aware dismissal, hard cap, reduced-motion floor, exit/cleanup.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert, createContext } = require('./_harness');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('index.html');
const critical = (/<style id="splashCritical">([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';

// ---------------------------------------------------------------- static ---------------------------------------------
test('V28: critical splash CSS is inline in <head>, before every stylesheet, on the #0f0f12 backdrop', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(critical.length > 500, 'inline <style id="splashCritical"> missing');
  assert.ok(head.includes('id="splashCritical"'), 'must live in <head>');
  assert.ok(head.indexOf('id="splashCritical"') < head.indexOf('<link rel="stylesheet"'), 'must come before the external stylesheets');
  assert.match(critical, /\.splash-screen\s*\{[^}]*background:\s*#0f0f12/i);
  assert.match(html, /style-src 'self' 'unsafe-inline'/, 'the CSP must keep allowing the inline style');
});

test('V28: splash markup - ids kept, app-icon logo, wordmark, i18n tagline, developer credit, hidden from assistive tech', () => {
  const m = /<div class="splash-screen" id="splashScreen"([^>]*)>([\s\S]*?<\/p>)\s*<\/div>\s*<\/div>/.exec(html);
  assert.ok(m, 'splash block not found');
  assert.match(m[1], /aria-hidden="true"/);
  assert.match(m[2], /id="monogram"/);
  assert.match(m[2], /<img src="\.\/icon\.png"[^>]*alt=""/);
  assert.ok(!/<svg/.test(m[2]), 'the drawn SVG monogram is gone');
  assert.match(m[2], /<p class="ys-credit" dir="ltr">develop by <span>YASSEN MOHAMMED<\/span><\/p>/);
  assert.match(m[2], /class="ys-wordmark">YoFilter</);
  assert.match(m[2], /<p class="ys-tagline" data-i18n="splashTagline">AI Photo Studio<\/p>/);
  assert.equal((html.match(/id="splashScreen"/g) || []).length, 1);
});

test('V28: the logo is the REAL app icon - the same icon.png config.xml ships, preloaded, a valid 512x512 PNG', () => {
  const png = fs.readFileSync(path.join(root, 'icon.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon.png is a PNG');
  assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
  assert.match(read('config.xml'), /<icon src="icon\.png"\s*\/>/, 'config.xml uses the same file');
  assert.match(html, /<link rel="preload" href="\.\/icon\.png" as="image">/);
  assert.match(html, /img-src 'self'/, 'CSP allows the same-origin image');
  assert.match(critical, /\.monogram\s*\{[^}]*border-radius:\s*22%[^}]*overflow:\s*hidden/, 'the square PNG is clipped to the icon corner radius');
  assert.ok(!/#000000|#000\b/i.test(critical), 'no pure black in the splash');
});

test('V28: developer credit - quiet, under the branding, delayed fade-in that finishes long before the 3.5 s floor, plain fade for reduced motion', () => {
  const html0 = html.slice(html.indexOf('id="splashScreen"'));
  assert.ok(html0.indexOf('class="ys-tagline"') < html0.indexOf('class="ys-credit"'), 'credit sits below the tagline');
  const rule = /\.ys-credit\s*\{([^}]*)\}/.exec(critical)[1];
  assert.match(rule, /opacity:\s*0/);
  const m = /animation:\s*ys-rise\s+([\d.]+)s\s+[^;]*?\s([\d.]+)s forwards/.exec(rule);
  assert.ok(m, 'delayed ys-rise animation');
  assert.ok(parseFloat(m[1]) + parseFloat(m[2]) <= 3.5, 'fully visible before the floor ends (' + (parseFloat(m[1]) + parseFloat(m[2])) + ' s)');
  assert.ok(parseFloat(m[2]) >= 0.5, 'a real delay, not an instant appearance');
  assert.match(critical, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.ys-credit\s*\{\s*transform:\s*none;\s*animation:\s*ys-fade/);
  assert.ok(!/data-i18n/.test(/<p class="ys-credit"[^>]*>/.exec(html)[0]), 'a name credit is not translated');
});

test('V28: compositor-only motion - no filter / blur / backdrop-filter, and every keyframe animates only opacity + transform', () => {
  assert.ok(!/filter\s*:|blur\(|backdrop-filter/i.test(critical), 'splash CSS must not use filter/blur');
  const frames = [...critical.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)];
  assert.ok(frames.length >= 6, 'keyframes not parsed: ' + frames.length);
  for (const f of frames) {
    const props = new Set([...f[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]));
    for (const p of props) assert.ok(['opacity', 'transform', 'visibility', 'pointer-events'].includes(p), '@keyframes ' + f[1] + ' animates ' + p);
  }
});

test('V28: prefers-reduced-motion - no pulse, no scale (entry and exit become plain fades)', () => {
  const rm = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n        \}/.exec(critical);
  assert.ok(rm, 'reduced-motion block missing');
  assert.match(rm[1], /\.glow-effect\s*\{\s*animation:\s*ys-fade-glow/, 'glow must stop pulsing');
  assert.match(rm[1], /\.splash-screen\.hidden \.ys-stage\s*\{\s*transform:\s*none/, 'exit must not scale');
  assert.match(rm[1], /\.ys-stage\s*\{\s*transition:\s*none/);
});

test('V28: exit never blocks touch - pointer-events none from the first exit frame, plus a CSS failsafe if the script never runs', () => {
  assert.match(critical, /\.splash-screen\.hidden\s*\{[^}]*pointer-events:\s*none/);
  assert.match(critical, /\.splash-screen\.hidden\s*\{[^}]*visibility:\s*hidden/);
  assert.match(critical, /animation:\s*ys-failsafe 0s linear 10s forwards/);
  assert.match(critical, /\.splash-screen\.hidden \.ys-stage\s*\{\s*transform:\s*scale\(1\.\d+\)/, 'scale-up exit');
});

test('V28: the old splash CSS is gone from components.css (single source of truth) and nothing else regressed there', () => {
  const css = read('css/components.css');
  for (const gone of ['.splash-screen', '.monogram', '.intro-container', '.glow-effect', 'introFadeScale', 'glowSweep']) assert.ok(!css.includes(gone), gone + ' still in components.css');
  assert.ok(css.includes('@keyframes fadeInUp'), 'fadeInUp is used by .tutorial-card and must stay');
});

test('V28: i18n - splashTagline exists in English AND Arabic, and Arabic really is Arabic', () => {
  const sb = createContext({ window: {}, document: {}, CustomEvent: function () {} });
  sb.window = sb;
  vm.runInContext(read('js/i18n/i18n.js'), sb, { filename: 'i18n.js' });
  assert.equal(vm.runInContext('t("splashTagline")', sb), 'AI Photo Studio');
  vm.runInContext('var currentLanguage = "ar";', sb);
  const ar = vm.runInContext('t("splashTagline")', sb);
  assert.match(ar, /[\u0600-\u06FF]/);
  assert.notEqual(ar, 'AI Photo Studio');
});

test('V28: wiring - splash.js still loads before init.js, init.js still calls autoDismissSplash last, and the export name is unchanged', () => {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/(js\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.indexOf('js/ui/splash.js') > -1 && srcs.indexOf('js/ui/splash.js') < srcs.indexOf('js/core/init.js'));
  const init = read('js/core/init.js');
  const handler = /document\.addEventListener\('DOMContentLoaded', function\(\) \{([\s\S]*?)\n\}\);/.exec(init)[1];
  const calls = handler.trim().split('\n').map((l) => l.trim());
  assert.equal(calls[calls.length - 1], 'autoDismissSplash();', 'readiness is signalled after every init step');
  assert.match(read('js/ui/splash.js'), /autoDismissSplash: \[\(\) => autoDismissSplash, \(v\) => \{ autoDismissSplash = v; \}\]/);
});

// ------------------------------------------------------------ behaviour ----------------------------------------------
// Virtual clock: setTimeout/clearTimeout/performance.now all move together, so floor / cap arithmetic is exact.
function harness({ fcp = 0, reduced = false, noSplash = false, paintTiming = true } = {}) {
  let now = 0, seq = 0;
  const timers = new Map();
  const listeners = {};
  const splash = {
    classes: new Set(), attrs: {}, style: {}, parentNode: null, handlers: {},
    classList: { add: (c) => splash.classes.add(c), contains: (c) => splash.classes.has(c) },
    setAttribute: (k, v) => { splash.attrs[k] = v; },
    addEventListener: (t, f) => { splash.handlers[t] = f; },
    removeEventListener: (t) => { delete splash.handlers[t]; },
  };
  const parent = { removed: 0, removeChild: (n) => { assert.equal(n, splash); parent.removed++; splash.parentNode = null; } };
  splash.parentNode = parent;
  const sb = {
    setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { f, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    performance: { now: () => now, getEntriesByName: (n) => (paintTiming && n === 'first-contentful-paint' ? [{ startTime: fcp }] : []) },
    matchMedia: (q) => ({ matches: reduced && /reduced-motion/.test(q) }),
    document: {
      getElementById: (id) => (id === 'splashScreen' && !noSplash && parent.removed === 0 ? splash : null),
      addEventListener: (t, f) => { listeners[t] = f; },
    },
  };
  createContext(sb);
  sb.globalThis = sb;
  const advance = (to) => {   // run every timer due up to `to`, in time order
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].f();
    }
    now = to;
  };
  return {
    splash, parent, listeners, advance, at: (t) => { now = t; },
    load: () => vm.runInContext(read('js/ui/splash.js'), sb, { filename: 'splash.js' }),
    ready: () => vm.runInContext('autoDismissSplash()', sb),
    hidden: () => splash.classes.has('hidden'),
  };
}

test('V28 lifecycle: init finishes early (300 ms) -> splash still waits for the 3.5 s floor, then exits at once', () => {
  const h = harness(); h.at(100); h.load(); h.advance(300); h.ready();
  h.advance(3499); assert.equal(h.hidden(), false, 'must not leave before the floor');
  h.advance(3500); assert.equal(h.hidden(), true, 'leaves exactly at the floor');
  assert.equal(h.splash.attrs['aria-hidden'], 'true');
});

test('V28 lifecycle: floor is measured from FIRST PAINT (Paint Timing), not from script start', () => {
  const h = harness({ fcp: 400 }); h.at(700); h.load(); h.advance(800); h.ready();
  h.advance(3899); assert.equal(h.hidden(), false);
  h.advance(3900); assert.equal(h.hidden(), true, 'painted at 400 + 3500');
});

test('V28 lifecycle: init is late (never reports) -> the 4 s hard cap dismisses it anyway', () => {
  const h = harness(); h.at(50); h.load();
  h.advance(3999); assert.equal(h.hidden(), false);
  h.advance(4000); assert.equal(h.hidden(), true);
});

test('V28 lifecycle: init completes AFTER the floor -> dismissed immediately (no extra wait), still within the cap', () => {
  const h = harness(); h.at(50); h.load(); h.advance(3700); h.ready();
  h.advance(3700); assert.equal(h.hidden(), true, 'ready at 3.7 s is past the floor: leave now');
});

test('V28 lifecycle: the cap beats a floor that would run past it, and a late script file still gets a short grace', () => {
  const h = harness({ fcp: 100 }); h.at(4300); h.load();      // slow device: splash.js only runs at 4.3 s
  h.advance(4599); assert.equal(h.hidden(), false, 'grace so the remaining scripts can finish');
  h.advance(4600); assert.equal(h.hidden(), true);
});

test('V28 lifecycle: prefers-reduced-motion shortens the floor to 3 s (tagline minimum 400 ms)', () => {
  const h = harness({ reduced: true }); h.at(50); h.load(); h.advance(200); h.listeners['yofilter:i18n'](); h.ready();
  h.advance(2999); assert.equal(h.hidden(), false);
  h.advance(3000); assert.equal(h.hidden(), true);
});

test('V28 lifecycle: browsers without Paint Timing fall back to "now" and still honour floor and cap', () => {
  const h = harness({ paintTiming: false }); h.at(200); h.load(); h.advance(300); h.ready();
  h.advance(3699); assert.equal(h.hidden(), false);
  h.advance(3700); assert.equal(h.hidden(), true, 'shown at 200 + 3500');
});

test('V28 tagline: revealed only once the language is applied (yofilter:i18n); if i18n never reports it stays hidden and nothing is delayed', () => {
  const a = harness(); a.at(10); a.load();
  assert.equal(a.splash.classes.has('ys-text-in'), false, 'not before the language is applied');
  a.listeners['yofilter:i18n'](); assert.equal(a.splash.classes.has('ys-text-in'), true);
  const b = harness(); b.at(10); b.load(); b.advance(500); b.ready();
  assert.equal(b.splash.classes.has('ys-text-in'), false, 'no English flash for Arabic users');
  b.advance(3499); assert.equal(b.hidden(), false); b.advance(3500); assert.equal(b.hidden(), true, 'the floor is unaffected');
});

test('V28 tagline: once revealed it gets >= 800 ms of screen time (bounded by the cap)', () => {
  const h = harness(); h.at(10); h.load(); h.advance(3300); h.listeners['yofilter:i18n'](); h.ready();   // language applied late
  h.advance(3999); assert.equal(h.hidden(), false, 'floor 3500 < text 3300 + 800 = 4100, so it wants to stay...');
  h.advance(4000); assert.equal(h.hidden(), true, '...but the 4 s hard cap wins');
});

test('V28 exit: adds .hidden at once, removes the node on transitionend (opacity), and is safe to call twice', () => {
  const h = harness(); h.at(0); h.load(); h.advance(1000); h.ready(); h.advance(3500);
  assert.ok(h.hidden()); assert.equal(h.parent.removed, 0, 'still in the DOM while it fades');
  assert.equal(typeof h.splash.handlers.transitionend, 'function');
  h.splash.handlers.transitionend({ target: {}, propertyName: 'opacity' });   // another element\'s event: ignored
  assert.equal(h.parent.removed, 0);
  h.splash.handlers.transitionend({ target: h.splash, propertyName: 'transform' });
  assert.equal(h.parent.removed, 0, 'only the opacity transition counts');
  h.splash.handlers.transitionend({ target: h.splash, propertyName: 'opacity' });
  assert.equal(h.parent.removed, 1); assert.equal(h.splash.style.display, 'none');
  h.advance(5000); assert.equal(h.parent.removed, 1, 'no double removal');
});

test('V28 exit: if transitionend never fires (background tab) the safety timer still removes the node', () => {
  const h = harness(); h.at(0); h.load(); h.advance(1000); h.ready(); h.advance(3500);
  h.advance(3500 + 700); assert.equal(h.parent.removed, 1);
});

test('V28 robustness: a missing #splashScreen (tests remove it, or it is already gone) never throws', () => {
  const h = harness({ noSplash: true }); h.at(10); h.load(); h.advance(500); h.ready(); h.advance(4500);
  assert.equal(h.parent.removed, 0);
});

run('v28_test');
