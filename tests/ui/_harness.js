// Minimal zero-dependency test harness: `node tests/ui/<name>_test.js` runs plain Node, no JSDOM, no npm install.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function run(suite) {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log('  ok   ' + c.name); }
    catch (err) { failed++; console.log('  FAIL ' + c.name + '\n       ' + String(err && err.stack || err).split('\n').join('\n       ')); }
  }
  console.log(`${suite}: ${cases.length - failed}/${cases.length} passed`);
  if (failed || cases.length === 0) process.exitCode = 1;   // an empty suite is a failure too (silent no-op guard)
}

// V27: every module registers its API through YF.expose (js/core/namespace.js), so a vm sandbox that runs a module
// file must load the registry first. Use this instead of vm.createContext(sandbox) in any suite that loads app modules.
function createContext(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/core/namespace.js'), 'utf8'), sandbox, { filename: 'namespace.js' });
  return sandbox;
}

module.exports = { test, run, assert, createContext };
