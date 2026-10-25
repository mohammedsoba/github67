// AILoadingManager: behaviour (fake DOM + fake clock, real progress-counter.js) and the "never blocked by JS" CSS contract.
// Plain Node, no dependencies.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert } = require('./_harness');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---- fake clock shared by the engine (rAF) and the manager (setTimeout) ----
function makeEnv() {
  let t = 0, id = 0;
  const frames = new Map(), timers = new Map();
  const timeouts = { set: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; }, clear: (i) => timers.delete(i) };
  const classes = (set) => ({ add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) });
  const el = (extra) => Object.assign({ textContent: '', attrs: {}, set: new Set(), setAttribute(k, v) { this.attrs[k] = v; }, style: {} }, extra);
  const nodes = { portraitCanvasLoader: el(), portraitLoaderText: el(), portraitArc: el(), portraitPercent: el() };
  for (const n of Object.values(nodes)) n.classList = classes(n.set);
  const calls = [];
  const sb = {
    console, Math, Date, setTimeout: timeouts.set, clearTimeout: timeouts.clear,
    performance: { now: () => t },
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (i) => frames.delete(i),
    document: { getElementById: (i) => nodes[i] || null },
    t: (k) => ({ removingObject: 'جاري إزالة العنصر…', processingPortrait: 'جاري معالجة الصورة الشخصية…' }[k] || k),
    showLoading: (text, opts) => calls.push(['show', text, opts]),
    hideLoading: (opts) => calls.push(['hide', opts || {}]),
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('js/ui/progress-counter.js'), sb);
  vm.runInContext(read('js/ui/ai-loading-manager.js'), sb);
  const advance = (ms) => {
    const end = t + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    t = end;
    const f = [...frames.values()]; frames.clear(); f.forEach((fn) => fn(t));
  };
  return { sb, nodes, calls, advance };
}

test('modal: show() hands the translated text, Cancel and a 95 % counter to the island; complete() ends with a normal hide (100 + pop/hold/fade)', () => {
  const e = makeEnv();
  let cancelled = 0;
  const ticket = e.sb.aiLoader.show('removeObject', { onCancel: () => cancelled++, expectedMs: 5000 });
  const [, text, opts] = e.calls[e.calls.length - 1];
  assert.equal(text, 'جاري إزالة العنصر…');
  assert.deepEqual({ ...opts.progress }, { expectedMs: 5000, ceiling: 95 });
  assert.equal(typeof opts.onCancel, 'function');
  assert.equal(e.sb.aiLoader.isActive(), true);
  assert.equal(e.sb.aiLoader.complete(ticket), true);
  assert.equal(JSON.stringify(e.calls[e.calls.length - 1]), JSON.stringify(['hide', {}]), 'a plain hideLoading() is the success path (the island celebrates)');
  assert.equal(e.sb.aiLoader.isActive(), false);
  opts.onCancel();
  assert.equal(cancelled, 1, 'the caller\'s Cancel handler still runs');
});

test('modal: hide() closes instantly (no celebration); a second end call does nothing; Cancel makes the later hide a no-op', () => {
  const e = makeEnv();
  const t1 = e.sb.aiLoader.show('removeObject');
  assert.equal(e.sb.aiLoader.hide(t1), true);
  assert.equal(JSON.stringify(e.calls[e.calls.length - 1]), JSON.stringify(['hide', { instant: true }]));
  const n = e.calls.length;
  assert.equal(e.sb.aiLoader.hide(t1), false);
  assert.equal(e.sb.aiLoader.complete(t1), false);
  assert.equal(e.calls.length, n, 'idempotent');
  const t2 = e.sb.aiLoader.show('removeObject', { onCancel() {} });
  e.calls[e.calls.length - 1][2].onCancel();             // the island's Cancel button
  assert.equal(e.sb.aiLoader.isActive(), false);
  assert.equal(e.sb.aiLoader.hide(t2), false, 'the island already closed itself');
});

test('a late end call of an OLD operation never closes a newer one', () => {
  const e = makeEnv();
  const old = e.sb.aiLoader.show('portrait');
  const fresh = e.sb.aiLoader.show('portrait');
  assert.notEqual(old, fresh);
  assert.equal(e.sb.aiLoader.complete(old), false);
  assert.equal(e.sb.aiLoader.hide(old), false);
  assert.equal(e.sb.aiLoader.isActive(), true);
  assert.equal(e.sb.aiLoader.hide(fresh), true);
});

test('orb: status text, counter 1 -> never above 95, snap to 100 on complete(), pop/hold/fade then gone; Arabic text', () => {
  const e = makeEnv();
  const n = e.nodes;
  const ticket = e.sb.aiLoader.show('portrait');
  assert.equal(n.portraitLoaderText.textContent, 'جاري معالجة الصورة الشخصية…');
  assert.ok(n.portraitCanvasLoader.set.has('on'));
  assert.equal(n.portraitCanvasLoader.attrs['aria-hidden'], 'false');
  assert.equal(n.portraitPercent.textContent, '1');
  let last = 1;
  for (let i = 0; i < 60; i++) {
    e.advance(5000);                                     // five minutes of a "frozen" inference
    const v = Number(n.portraitPercent.textContent);
    assert.ok(v >= last, 'never backwards'); assert.ok(v <= 95, 'never above 95 before complete()');
    last = v;
  }
  assert.ok(last >= 90, 'it did climb (' + last + ')');
  e.sb.aiLoader.complete(ticket);
  assert.equal(n.portraitPercent.textContent, '100');
  assert.ok(n.portraitCanvasLoader.set.has('finishing') && n.portraitCanvasLoader.set.has('on'));
  e.advance(300);
  assert.ok(n.portraitCanvasLoader.set.has('on'), 'still held');
  e.advance(300);
  assert.ok(!n.portraitCanvasLoader.set.has('on') && !n.portraitCanvasLoader.set.has('finishing'), 'faded out and gone');
});

test('orb: hide() never shows 100; a new run during the finish fade restarts cleanly at 1', () => {
  const e = makeEnv();
  const n = e.nodes;
  const t1 = e.sb.aiLoader.show('portrait');
  e.advance(2000);
  e.sb.aiLoader.hide(t1);
  assert.ok(Number(n.portraitPercent.textContent) < 100);
  assert.ok(!n.portraitCanvasLoader.set.has('on'));
  const t2 = e.sb.aiLoader.show('portrait');
  e.sb.aiLoader.complete(t2);                            // finishing...
  e.sb.aiLoader.show('portrait');                        // ...a newer request arrives (slider moved)
  assert.ok(!n.portraitCanvasLoader.set.has('finishing'));
  assert.equal(n.portraitPercent.textContent, '1');
  e.advance(2000);                                       // the OLD fade timer must not hide the new run
  assert.ok(n.portraitCanvasLoader.set.has('on'));
});

test('degrades: no engine -> the orb still opens (CSS spins) and closes; unknown operation names are shown as given', () => {
  const e = makeEnv();
  e.sb.aiLoader._env = { YoProgress: null };
  e.sb.YoProgress = undefined;
  const mgr = new e.sb.AILoadingManager({ YoProgress: null, document: e.sb.document, t: e.sb.t });
  const t = mgr.show('portrait');
  assert.ok(e.nodes.portraitCanvasLoader.set.has('on'));
  mgr.complete(t);
  assert.ok(!e.nodes.portraitCanvasLoader.set.has('on'));
  e.sb.aiLoader.show('Doing something custom…');
  assert.equal(e.calls[e.calls.length - 1][1], 'Doing something custom…');
});

test('engine: ceiling parameter - default stays 99, an explicit 95 is honoured, junk falls back to 99', () => {
  const e = makeEnv();
  const P = e.sb.YoProgress;
  const near = (v, top) => assert.ok(v <= top && v >= top - 1, v + ' approaches ' + top + ' without passing it');
  near(P.percentAt(1e9, 8000), 99);                      // the curve only approaches its ceiling (floor of a value just below it)
  near(P.percentAt(1e9, 8000, 95), 95);
  near(P.percentAt(1e9, 8000, 500), 99);                 // junk ceiling -> default
  assert.equal(P.percentAt(0, 8000, 95), 1);
  let prev = 0;
  for (let ms = 0; ms <= 600000; ms += 997) { const v = P.percentAt(ms, 8000, 95); assert.ok(v >= prev && v <= 95); prev = v; }
});

test('CSS contract: the motion is pure CSS @keyframes on transform/opacity, infinite, and survives prefers-reduced-motion', () => {
  const css = read('css/loading-orb.css');
  for (const sel of ['yo-orb__halo', 'yo-orb__orbit', 'yo-orb__glow']) {
    const rule = new RegExp('\\.' + sel + '\\s*\\{([^}]*)\\}').exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /animation:[^;]*infinite/, sel + ' loops forever');
  }
  assert.match(css, /@keyframes yoOrbSpinRev \{ to \{ transform: rotate\(-360deg\); \} \}/);
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /\.yo-orb__halo \{ animation: yoOrbBreathe[^}]*infinite/, 'reduced motion: breathing, not frozen');
  assert.match(rm, /\.yo-orb__glow \{ animation: yoOrbBreathe[^}]*infinite/);
  assert.ok(!/\.yo-orb__halo \{ animation: none/.test(rm), 'the loader never stops moving');
  // JS never drives the motion: the manager and engine contain no setInterval / animate()
  for (const f of ['js/ui/ai-loading-manager.js', 'js/ui/progress-counter.js'])
    assert.ok(!/setInterval|\.animate\(/.test(read(f)), f);
});

test('wiring: Eraser and Portrait call the manager (show before the work, complete on success, hide otherwise); the script is external (CSP)', () => {
  const html = read('index.html');
  assert.match(html, /<script src="\.\/js\/ui\/ai-loading-manager\.js" defer><\/script>/);
  const at = (s) => html.indexOf('src="./js/' + s + '"');
  assert.ok(at('ui/progress-counter.js') < at('ui/ai-loading-manager.js') && at('ui/loading-toast.js') < at('ui/ai-loading-manager.js'));
  assert.ok(at('ui/ai-loading-manager.js') < at('portrait/portrait-mode.js'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no inline <script> blocks (script-src has no unsafe-inline)');
  const er = read('js/editing/magic-eraser.js');
  assert.match(er, /window\.aiLoader\.show\('removeObject'/);
  assert.match(er, /window\.aiLoader\.complete\(loadJob\)/);
  assert.match(er, /showBusy\(false, null, loadJob\)/);
  assert.ok(er.indexOf('const loadJob = showBusy(true, cancelErase)') < er.indexOf('await buildInpaintFormData()'), 'before the first await of the run');
  assert.ok(er.indexOf("window.aiLoader.complete(loadJob)") < er.indexOf("console.error('[MagicEraser] erase failed'"), 'complete() on the success path');
});

run('ai_loading_manager');
