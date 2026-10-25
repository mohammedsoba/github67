// Portrait queue (server answers 503 "... busy ..."): the page must show the TRANSLATED busy message, not "model not ready"
// and not the server's English text.
// Plain Node, same harness as the other suites. Runs the REAL friendlyError() cut out of js/portrait/portrait-mode.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, run, assert } = require('./_harness');

const src = fs.readFileSync(path.join(__dirname, '../../js/portrait/portrait-mode.js'), 'utf8');
const m = /function friendlyError\(err, status, detail\) \{[\s\S]*?\n    \}\n/.exec(src);
assert.ok(m, 'friendlyError() not found in portrait-mode.js');

const sb = {
  window: {
    t: (key, vars) => (vars ? key + ':' + JSON.stringify(vars) : key),
    YoApi: { describe: (e) => 'DESCRIBED:' + (e && e.kind) },
  },
};
vm.createContext(sb);
vm.runInContext(m[0] + '\nthis.friendlyError = friendlyError;', sb);
const friendly = (...a) => sb.friendlyError(...a);

test('503 with the queue-full text shows the translated busy message, not "model not ready"', () => {
  const text = 'Portrait is busy; please retry in a few seconds';
  assert.equal(friendly(new Error(text), 503, text), 'errPortraitBusy');
});

test('"busy" is matched case-insensitively', () => {
  assert.equal(friendly(null, 503, 'The portrait service is BUSY, retry'), 'errPortraitBusy');
});

test('a plain 503 (model missing) still shows the translated model message', () => {
  assert.equal(friendly(null, 503, 'Portrait background model failed to load'), 'errPortraitModel');
  assert.equal(friendly(null, 503, undefined), 'errPortraitModel');
});

test('other statuses are unchanged (413 / 429 / 504 / 500)', () => {
  assert.equal(friendly(null, 413, 'x'), 'errImageTooLarge');
  assert.equal(friendly(null, 429, 'Too many requests'), 'Too many requests');
  assert.equal(friendly(null, 504, 'Portrait processing timed out after 120s'), 'Portrait processing timed out after 120s');
  assert.equal(friendly(null, 500, ''), 'errServerStatus:{"status":500}');
});

test('aborts stay silent and network/timeout errors still go through YoApi.describe', () => {
  assert.equal(friendly({ name: 'AbortError' }, undefined, undefined), null);
  assert.equal(friendly({ yoApi: true, kind: 'timeout' }, undefined, undefined), 'DESCRIBED:timeout');
});

run('portrait_busy_test');
