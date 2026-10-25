// Tools toolbar order, Portrait panel without an Apply step, one header style, no decorative glyphs, EN/AR parity.
// Static checks over index.html / css / i18n / js (plain Node, same harness as the other suites).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, run, assert } = require('./_harness');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const HTML = read('index.html');
const I18N = read('js/i18n/i18n.js');

function section(id) {            // the markup of one panel, up to the next top-level tab-section / comment banner
  const start = HTML.indexOf('id="' + id + '"');
  assert.ok(start > 0, id + ' not found');
  const next = HTML.indexOf('<!-- ──', start);
  return HTML.slice(start, next > 0 ? next : start + 6000);
}

test('Tools toolbar order is Eraser | Portrait | Enhance Face | Auto Enhance | AI Mask, Eraser is the active default', () => {
  const bar = /id="toolsSubMenu"[\s\S]*?<\/div>/.exec(HTML)[0];
  const btns = [...bar.matchAll(/<button class="sub-btn( active)?" onclick="switchSubTab\('([^']+)', this\)" data-i18n="([^"]+)"/g)];
  assert.deepEqual(btns.map((b) => b[3]), ['eraser', 'portrait', 'enhanceFace', 'autoEnhance', 'aiMask']);
  assert.deepEqual(btns.map((b) => b[2]), ['p-eraser', 'p-portrait', 'p-enhance-face', 'p-auto-enhance', 'p-mask']);
  assert.equal(btns.filter((b) => b[1]).length, 1);
  assert.ok(btns[0][1], 'the first (Eraser) button carries .active');
});

test('entering Tools still selects the FIRST button (Eraser) - navigation.js indexes the strip, so the order change is safe', () => {
  const nav = read('js/ui/navigation.js');
  assert.match(nav, /if \(abtns\[0\]\) abtns\[0\]\.classList\.add\('active'\);\s*var eraser = document\.getElementById\('p-eraser'\);/);
});

test('Portrait has NO Apply step: no button in the intro section, no Apply id / handler anywhere in markup or scripts', () => {
  const init = section('portrait-init-section').split('<div id="portrait-result-section"')[0];
  assert.ok(!/<button/.test(init), 'the intro is title + hint only');
  assert.match(init, /<h3 class="tool-title" data-i18n="portraitMode">/);
  assert.match(init, /data-i18n="portraitDesc"/);
  for (const f of ['index.html', 'js/portrait/portrait-mode.js', 'js/core/file-handler.js', 'js/ui/navigation.js', 'js/ui/a11y.js']) {
    const t = read(f);
    assert.ok(!/portraitApplyBtn/.test(t), f + ' still references portraitApplyBtn');
    assert.ok(!/[^e]applyPortraitMode/.test(t.replace(/reapplyPortraitMode/g, '')), f + ' still references applyPortraitMode');
  }
});

test('the sliders still drive everything: release renders, +/- debounce, Set Focus applies a default blur', () => {
  const pm = read('js/portrait/portrait-mode.js');
  assert.match(pm, /window\.onPortraitBlurChange = function \(\) \{[\s\S]*?if \(sliderShouldRender\(\)\) runPortraitRequest\(\);/);
  assert.match(pm, /window\.onPortraitSkinChange = function \(\) \{[\s\S]*?if \(sliderShouldRender\(\)\) runPortraitRequest\(\);/);
  assert.match(pm, /if \(Math\.round\(portraitCurrentBlur\) <= BLUR_MIN\) setBlur\(FOCUS_DEFAULT_BLUR\);/);
});

test('the error state offers a real "Try again" (the old Apply button used to double as the retry)', () => {
  const err = /id="portrait-error-section"[\s\S]*?<\/button>\s*<\/div>/.exec(HTML);
  assert.ok(err, 'error section not found');
  assert.match(err[0], /role="alert"/);
  assert.match(err[0], /<button type="button" class="studio-btn" onclick="reapplyPortraitMode\(\)">/);
  assert.match(err[0], /data-i18n="tryAgain"/);
  assert.match(read('js/portrait/portrait-mode.js'), /window\.reapplyPortraitMode = function \(\) \{\s*runPortraitRequest\(\);/);
});

test('tool headers share ONE class; no inline header styles are left in the Tools panels', () => {
  for (const id of ['portrait-init-section', 'p-enhance-face', 'p-auto-enhance']) {
    assert.match(section(id), /<h3 class="tool-title"/, id);
  }
  assert.ok(!/<h3 style="font-size:13px;font-weight:600/.test(HTML));
  assert.match(read('css/components.css'), /\.tool-title \{ font-size: 13px; font-weight: 600;/);
  const css = read('css/portrait.css');
  assert.ok(!/portrait-panel-content \.ai-btn/.test(css), 'dead Apply-button rule removed');
  assert.match(css, /\.portrait-error \{[^}]*border-radius: 10px;/);
});

test('the generic "Apply" buttons of Enhance Face / Auto Enhance carry text only (no unrelated smiley / plus icon)', () => {
  for (const id of ['p-enhance-face', 'p-auto-enhance']) {
    const b = /<button class="ai-btn"[\s\S]*?<\/button>/.exec(section(id));
    assert.ok(b, id);
    assert.ok(!/<svg/.test(b[0]), id + ' button still has an icon');
    assert.match(b[0], /data-i18n="apply"/);
  }
});

test('no emoji / pictograph anywhere in the page markup or the translations (tool titles stay clean)', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}\u{2728}\u{26A1}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;
  assert.ok(!emoji.test(HTML), 'index.html contains an emoji');
  assert.ok(!emoji.test(I18N), 'i18n.js contains an emoji');
});

test('i18n: English and Arabic define exactly the same keys, and every key the page uses exists in both', () => {
  const iEn = I18N.search(/\n\s{4}en:\s*\{/), iAr = I18N.search(/\n\s{4}ar:\s*\{/);
  assert.ok(iEn >= 0 && iAr > iEn);
  const keys = (s) => new Set([...s.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
  const en = keys(I18N.slice(iEn, iAr)), ar = keys(I18N.slice(iAr));
  assert.ok(en.size > 250);
  assert.deepEqual([...en].filter((k) => !ar.has(k)), [], 'missing in Arabic');
  assert.deepEqual([...ar].filter((k) => !en.has(k)), [], 'missing in English');
  const used = new Set([...HTML.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((k) => !en.has(k) || !ar.has(k)), []);
  for (const k of ['tryAgain', 'portraitBusyRetry', 'errPortraitBusy', 'portraitDesc']) assert.ok(en.has(k) && ar.has(k), k);
});

run('portrait_panel_test');
