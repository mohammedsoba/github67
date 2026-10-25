// V20 R19 / R20 / Y3-Y9: static checks on HTML / CSS / config / i18n so the fixes cannot silently regress.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, run, assert } = require('./_harness');
const root = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

test('Y5: viewport no longer blocks zoom; editor surfaces declare touch-action', () => {
  const vp = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
  assert.ok(!/maximum-scale|user-scalable/i.test(vp), vp);
  const css = read('css/touch-layout.css');
  assert.match(css, /#curvesCanvas[\s\S]*touch-action:\s*none/);
  assert.match(css, /\.crop-overlay[\s\S]*touch-action:\s*none/);
});

test('Y3: toast wraps (3 lines max), sits below the notch, above the sheets, is a live region', () => {
  const rule = read('css/components.css').split('\n').find((l) => l.includes('.toast {'));
  assert.match(rule, /white-space:\s*normal/);
  assert.match(rule, /-webkit-line-clamp:\s*3/);
  assert.match(rule, /safe-area-inset-top/);
  assert.ok(!/white-space:\s*nowrap/.test(rule));
  const z = Number(/z-index:\s*(\d+)/.exec(rule)[1]);
  assert.ok(z > 10000, 'above Settings (9999) and About (10000)');
  assert.match(html, /id="toast"[^>]*role="status"/);
  assert.match(html, /id="toast"[^>]*aria-live="polite"/);
});

test('Y4: Settings / About are classed dialogs with no inline styles; back + Escape close the top layer', () => {
  for (const id of ['settingsPage', 'aboutPage']) {
    const open = html.match(new RegExp('<div id="' + id + '"[^>]*>'))[0];
    assert.match(open, /role="dialog"/);
    assert.match(open, /aria-modal="true"/);
    assert.ok(!/style=/.test(open), id + ' has no inline style');
  }
  const start = html.indexOf('id="settingsPage"');
  const block = html.slice(start, html.indexOf('</body>'));
  assert.equal((block.match(/style="/g) || []).length, 0, 'no inline style="" left in Settings/About');
  assert.match(read('css/settings.css'), /safe-area-inset-top/);
  assert.match(read('js/core/init.js'), /closeTopmostLayer\(\)/);
  assert.match(read('js/ui/navigation.js'), /function closeTopmostLayer/);
  assert.match(read('js/core/init.js'), /function onBackKeyDown[\s\S]*closeTopmostLayer/);
});

test('Y6/Y7/Y9: 44px hit areas, compact-phone panel, label collision guard exist', () => {
  const css = read('css/touch-layout.css');
  assert.match(css, /\.tool-btn::after[\s\S]*width:\s*44px/);
  assert.match(css, /\.crop-handle::after/);
  assert.match(css, /max-height:\s*720px/);
  assert.match(css, /\.main-nav\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.tool-meta[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(css, /\.tool-value[\s\S]*text-align:\s*end/);
});

test('Y8: curves canvas scales, channel buttons are translated, reset exists, touchcancel handled', () => {
  assert.match(read('css/touch-layout.css'), /\.curves-svg\s*\{[^}]*width:\s*100%/);
  assert.match(html, /data-i18n="curveRed"/);
  assert.match(html, /onclick="resetCurves\(\)"/);
  const js = read('js/editing/curves.js');
  assert.match(js, /touchcancel/);
  assert.match(js, /canvas\.width\s*\/\s*rect\.width/);
  assert.ok(!/textContent = 'Red'/.test(read('js/core/startup-lang.js')), 'English override removed');
  const i18n = read('js/i18n/i18n.js');
  assert.equal((i18n.match(/curveRed:/g) || []).length, 2);
});

test('R19: privacy / offline wording is truthful in EN and AR', () => {
  const i18n = read('js/i18n/i18n.js');
  assert.ok(!/does not .*transmit|We do not collect, store, or transmit/i.test(i18n));
  assert.ok(!/fully offline|Full offline support|no internet required/i.test(i18n + html));
  assert.match(i18n, /Magic Eraser \(the photo and the area you painted\)/);
  assert.match(i18n, /Portrait \(the photo and your blur/);
  assert.match(i18n, /الممحاة السحرية \(الصورة والمنطقة التي رسمتها\)/);
  assert.match(i18n, /خادم YoFilter للذكاء الاصطناعي/);
});

test('R20: CSP present, packaged build uses HTTPS and no wildcard access, MediaStore plugin, real e-mail', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp.replace(/script-src-attr[^;]*;/, '')), 'script-src has no unsafe-inline');
  assert.match(csp, /connect-src 'self'/);
  // V26: the packaged-app API host is stamped from version.json (native_api_base); none is listed while it is unset
  const nativeBase = JSON.parse(read('version.json')).native_api_base;
  if (nativeBase) assert.ok(csp.match(/connect-src[^;]*/)[0].split(/\s+/).includes(nativeBase));
  else assert.ok(!/connect-src[^;]*api\./.test(csp), 'no API host in the CSP while native_api_base is unset');
  const cfg = read('config.xml');
  assert.ok(!/<access origin="\*"/.test(cfg) && !/allow-navigation href="\*"/.test(cfg));
  assert.ok(!/example\.com/.test(cfg));
  assert.match(cfg, /mmyasomm@gmail\.com/);
  assert.match(cfg, /cordova-plugin-photo-library/);
  assert.match(cfg, /usesCleartextTraffic="false"/);
  assert.match(cfg, /WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/);
  assert.match(read('js/config/app-config.js'), /NATIVE_API_BASE = "(https:\/\/[^"]+)?";/);   // V26: stamped from version.json; "" = not configured
  const save = read('js/ui/modals-export.js');
  assert.match(save, /cordova\.plugins\.photoLibrary/);
  assert.ok(!/atob\(/.test(save), 'no base64 round trip when saving');
});

run('v20_static_test');
