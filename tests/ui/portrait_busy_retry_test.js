// Portrait: automatic retry while the server answers 503 "busy" (js/portrait/portrait-mode.js, block "busy-retry").
// The REAL code runs against a fake clock (no 2-10 s waits) and real AbortControllers.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert } = require('./_harness');

const SRC = fs.readFileSync(path.join(__dirname, '../../js/portrait/portrait-mode.js'), 'utf8');
const m = /\/\/ >>> busy-retry([\s\S]*?)\/\/ <<< busy-retry/.exec(SRC);
assert.ok(m, 'busy-retry block not found in portrait-mode.js');

function makeSandbox(responses) {
  const timers = new Map();
  let nextId = 1;
  const calls = [];
  const loaderEl = { textContent: '' };
  const sb = {
    AbortController, Math, Error, Promise, isFinite, Number, String, console,
    PORTRAIT_PATH: '/api/portrait',
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    $: (id) => (id === 'portraitLoaderText' ? loaderEl : null),
    window: {
      t: (k) => 'T:' + k,
      YoApi: {
        request: async (p, opts) => {
          calls.push({ path: p, opts });
          const next = responses.shift();
          if (!next) throw new Error('unexpected extra request');
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  vm.createContext(sb);
  vm.runInContext(m[1] + '\nthis.postWithBusyRetry = postWithBusyRetry; this.busyRetryDelayMs = busyRetryDelayMs; this.waitFor = waitFor; this.setLoaderText = setLoaderText; this.BUSY_RETRIES = BUSY_RETRIES;', sb);
  const fire = () => { const [id, t] = [...timers.entries()][0]; timers.delete(id); t.fn(); return t.ms; };
  return { sb, calls, timers, fire, loaderEl };
}
// A Response stand-in: status, optional Retry-After, JSON body; clone() so the caller can still read the original.
function resp(status, detail, retryAfter) {
  const r = {
    status, bodyReads: 0,
    headers: { get: (k) => (/^retry-after$/i.test(k) && retryAfter !== undefined ? retryAfter : null) },
    json: async () => { r.bodyReads++; return { detail }; },
    clone: () => ({ status, json: async () => ({ detail }) }),
  };
  return r;
}
const BUSY = 'Portrait is busy; please retry in a few seconds';
const tick = () => new Promise((r) => setImmediate(r));

test('a normal answer is returned at once: one request, no waiting, no "retrying" status', async () => {
  const ok = resp(200);
  const { sb, calls, timers } = makeSandbox([ok]);
  let waits = 0;
  assert.equal(await sb.postWithBusyRetry('FORM', null, () => waits++), ok);
  assert.equal(calls.length, 1); assert.equal(waits, 0); assert.equal(timers.size, 0);
  assert.equal(calls[0].path, '/api/portrait'); assert.equal(calls[0].opts.method, 'POST'); assert.equal(calls[0].opts.body, 'FORM');
});

test('busy 503 then success: waits the advised Retry-After (5 s), tells the caller, then re-sends the SAME form', async () => {
  const ok = resp(200);
  const { sb, calls, timers, fire } = makeSandbox([resp(503, BUSY, '5'), ok]);
  let waits = 0;
  const p = sb.postWithBusyRetry('FORM', null, () => waits++);
  await tick(); await tick();
  assert.equal(waits, 1); assert.equal(timers.size, 1);
  assert.equal(fire(), 5000);
  assert.equal(await p, ok);
  assert.equal(calls.length, 2); assert.equal(calls[1].opts.body, 'FORM');
});

test('the delay honours Retry-After but is clamped to 2-10 s, and falls back to 5 s when the header is missing or unreadable', () => {
  const { sb } = makeSandbox([]);
  for (const [header, expected] of [['5', 5000], ['1', 2000], ['0', 5000], ['60', 10000], ['3', 3000], [undefined, 5000], ['soon', 5000]]) {
    assert.equal(sb.busyRetryDelayMs(resp(503, BUSY, header)), expected, 'Retry-After ' + header);
  }
  assert.equal(sb.busyRetryDelayMs({ headers: { get() { throw new Error('opaque response'); } } }), 5000);   // cross-origin, header not exposed
  assert.equal(sb.busyRetryDelayMs({}), 5000);
});

test('still busy after the retries: exactly 3 requests (1 + 2 retries), then the 503 is RETURNED (never thrown) for the error UI', async () => {
  const last = resp(503, BUSY, '2');
  const { sb, calls, timers, fire } = makeSandbox([resp(503, BUSY, '2'), resp(503, BUSY, '2'), last]);
  assert.equal(sb.BUSY_RETRIES, 2);
  let waits = 0;
  const p = sb.postWithBusyRetry('FORM', null, () => waits++);
  for (let i = 0; i < 2; i++) { await tick(); await tick(); fire(); }
  assert.equal(await p, last);
  assert.equal(calls.length, 3); assert.equal(waits, 2); assert.equal(timers.size, 0);
});

test('only a "busy" 503 is retried: model-not-loaded 503, 429, 500, 413 and 504 go straight back to the caller', async () => {
  for (const r of [resp(503, 'Portrait background model failed to load'), resp(429, 'Too many requests'), resp(500, 'boom'), resp(413, 'x'), resp(504, 'timed out')]) {
    const { sb, calls, timers } = makeSandbox([r]);
    assert.equal(await sb.postWithBusyRetry('F', null, () => {}), r, 'status ' + r.status);
    assert.equal(calls.length, 1); assert.equal(timers.size, 0);
  }
});

test('the busy check reads a CLONE: the original response body is untouched for the error text', async () => {
  const ok = resp(200);
  const busy = resp(503, BUSY, '2');
  const { sb, fire } = makeSandbox([busy, ok]);
  const p = sb.postWithBusyRetry('F', null, () => {});
  await tick(); await tick(); fire();
  await p;
  assert.equal(busy.bodyReads, 0);
  const last = resp(503, BUSY, '2');
  const b = makeSandbox([resp(503, BUSY, '2'), resp(503, BUSY, '2'), last]);
  const q = b.sb.postWithBusyRetry('F', null, () => {});
  for (let i = 0; i < 2; i++) { await tick(); await tick(); b.fire(); }
  assert.equal(await q, last); assert.equal(last.bodyReads, 0, 'the caller can still read the final 503 body');
});

test('Cancel / a newer request during the wait: rejects with AbortError at once, clears the timer, sends nothing more', async () => {
  const ctl = new AbortController();
  const { sb, calls, timers } = makeSandbox([resp(503, BUSY, '5'), resp(200)]);
  const p = sb.postWithBusyRetry('F', ctl.signal, () => {});
  await tick(); await tick();
  assert.equal(timers.size, 1);
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(timers.size, 0, 'no timer left behind'); assert.equal(calls.length, 1);
});

test('already-aborted signal: waitFor rejects immediately and schedules no timer; a finished wait removes its abort listener', async () => {
  const done = new AbortController(); done.abort();
  const { sb, timers } = makeSandbox([]);
  await assert.rejects(sb.waitFor(5000, done.signal), (e) => e.name === 'AbortError');
  assert.equal(timers.size, 0);
  let removed = 0;
  const fake = { aborted: false, addEventListener() {}, removeEventListener() { removed++; } };
  const k = makeSandbox([]);
  const w = k.sb.waitFor(3000, fake);
  k.fire(); await w;
  assert.equal(removed, 1);
});

test('a network / timeout error from the request propagates unchanged (the caller maps it to its message)', async () => {
  const boom = new Error('unreachable');
  const { sb } = makeSandbox([boom]);
  await assert.rejects(sb.postWithBusyRetry('F', null, () => {}), (e) => e === boom);
});

test('the loader status line is set through i18n keys', () => {
  const { sb, loaderEl } = makeSandbox([]);
  sb.setLoaderText('portraitBusyRetry');
  assert.equal(loaderEl.textContent, 'T:portraitBusyRetry');
});

test('wiring: the server request goes through postWithBusyRetry, shows "retrying", and restores the normal status line', () => {
  assert.match(SRC, /var response = await postWithBusyRetry\(form, ctl\.signal, function \(\) \{ setLoaderText\('portraitBusyRetry'\); \}\);\s*setLoaderText\('processingPortrait'\);/);
  assert.match(SRC, /loaderHide\(loaderTicket\);[^\n]*\n\s*setLoaderText\('processingPortrait'\);/, 'restored in finally as well');
});

test('wiring: every caller goes through the wrapper that catches - no unhandled rejection, no stuck loader', () => {
  assert.match(SRC, /function runPortraitRequest\(\) \{\s*return runPortraitRequestCore\(\)\.catch\(function \(err\) \{[\s\S]*?portraitBusy = false;[\s\S]*?loaderHide\(\);[\s\S]*?toast\(window\.t\('portraitFailed'\), 'error'\);/);
  const direct = SRC.match(/runPortraitRequestCore/g) || [];
  assert.equal(direct.length, 2, 'only the definition and the wrapper mention the core');
});

run('portrait_busy_retry_test');
