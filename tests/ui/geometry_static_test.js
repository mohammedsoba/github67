// geometry_static_test.js - browser-free guard for css/geometry.css (V68). The real measurements live in
// tests/responsive/geometry_suite.js (needs Chromium); this one runs in plain Node and protects the wiring and the invariants.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, run } = require('./_harness');

const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
const html = read('index.html');
const css = read('css/geometry.css');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('geometry.css is linked after loading-orb.css and before rtl.css (rtl.css stays last)', () => {
  const at = (f) => html.indexOf('href="./css/' + f + '"');
  assert.ok(at('geometry.css') > at('loading-orb.css'), 'must load after loading-orb.css');
  assert.ok(at('geometry.css') < at('rtl.css'), 'must load before rtl.css');
});

test('the loading modal is a size container, and the orb is resized ONLY through --orb-size', () => {
  assert.match(stripped, /\.loading-overlay\s*\{[^}]*container-type:\s*size/);
  assert.match(stripped, /\.loading-overlay \.yo-orb\s*\{\s*--orb-size:/);
  assert.match(stripped, /\.portrait-canvas-loader \.yo-orb--sm\s*\{\s*--orb-size:\s*clamp\(64px/);
  assert.ok(!/stroke-dasharray|stroke-dashoffset|r="52"/.test(stripped), 'ring maths (RING_LENGTH 326.73) must stay untouched');
});

test('Cancel is a 44 px button; dialogs and Close respect 44 px and the safe-area insets on all four sides', () => {
  assert.match(stripped, /\.loading-overlay \.island-cancel\s*\{[^}]*min-height:\s*44px/);
  assert.match(stripped, /\.modal-close\s*\{[^}]*width:\s*44px;\s*height:\s*44px/);
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(stripped, new RegExp('safe-area-inset-' + side));
  assert.match(stripped, /100dvh - var\(--m-top\) - var\(--m-bottom\)/);
});

test('V22 convention: no physical margin/padding left/right in this file (RTL-safe, logical properties only)', () => {
  assert.ok(!/(margin|padding)-(left|right)\s*:/.test(stripped));
});

test('the older loader rules the other suites assert are untouched by this file (it only overrides)', () => {
  assert.match(read('css/glass.css'), /\.island-cancel\s*\{[^}]*min-height:\s*36px/);        // cancel_progress_test.js
  assert.match(read('css/loading-orb.css'), /\.loading-overlay\.finishing\s*\{[^}]*display:\s*flex/);   // loading_progress_test.js
});

run('geometry_static_test');
