// geometry_suite.js - loader / dialog / touch-target geometry in headless Chromium.
//
//   node tests/responsive/geometry_suite.js            (or: npm run test:geometry)
//
// Needs Node >= 20 and Playwright's Chromium. Serves the static front-end itself (no backend, no models).
//
// Matrix: 4 portrait phones (320x568, 360x640, 390x844, 430x932) + 3 landscape phones (844x390, 667x320, 568x320),
// each in English (LTR) and Arabic (RTL, the longest strings and mirrored start edge).
//
// Asserted (each failure prints the element and the measured numbers):
//   modal    #loadingOverlay: orb, text and Cancel lie fully INSIDE the overlay (nothing overflows the canvas or lands on the
//            control panel); Cancel >= 44 px high; orb 56..132 px; the counter number is not tiny; no text overlap
//   orb      #portraitCanvasLoader: orb + status pill inside the canvas, side by side or stacked without overlap; orb >= 64 px
//            and the number >= 17 px (very short landscape canvases: 56 px / 15 px, in the start corner); the strip it covers
//            stays <= 45 % of the canvas height (<= 52 % on those short canvases)
//   dialogs  Premium / Export dialog fits the viewport on all four sides and respects a >= 16 px (>= 8 px short) gutter;
//            its Close button is 44 x 44 and inside the dialog
//   touch    every visible interactive control on the three main tabs has an EFFECTIVE hit area >= 44 x 44 px, measured with
//            elementFromPoint (so an invisible ::after / padding band counts, a bounding box alone does not)
//   page     no horizontal page overflow while the loader / a dialog is open
//
// Screenshots: test-results/geometry/ (git-ignored). Exit code is non-zero if anything fails.
// Self-test hook: GEO_INJECT_CSS="<css>" injects extra CSS into every page to prove the suite can go red, e.g.
//   GEO_INJECT_CSS=".island-cancel{min-height:30px!important}" node tests/responsive/geometry_suite.js
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('@playwright/test')); } catch (_) { ({ chromium } = require('playwright')); }

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.GEO_SHOTS_DIR || path.join(ROOT, 'test-results', 'geometry');
const VIEWPORTS = [
  { name: 'p320x568', width: 320, height: 568 }, { name: 'p360x640', width: 360, height: 640 },
  { name: 'p390x844', width: 390, height: 844 }, { name: 'p430x932', width: 430, height: 932 },
  { name: 'l844x390', width: 844, height: 390 }, { name: 'l667x320', width: 667, height: 320 },
  { name: 'l568x320', width: 568, height: 320 },
];
const LANGS = [{ code: 'en' }, { code: 'ar' }];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(ROOT, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- runs in the page -------------------------------------------------------------------------------------------------
function pageHelpers() {
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const inside = (a, b, tol) => a && b && a.x >= b.x - tol && a.y >= b.y - tol && a.r <= b.r + tol && a.b <= b.b + tol;
  const overlap = (a, b) => a && b && a.x < b.r - 0.5 && a.r > b.x + 0.5 && a.y < b.b - 0.5 && a.b > b.y + 0.5;
  const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  return { R, inside, overlap, vis };
}

async function evalModal(page) {
  return page.evaluate(({ h }) => {
    const { R, inside, overlap } = new Function('return (' + h + ')()')();
    const q = (s) => document.querySelector(s);
    const ov = q('#loadingOverlay');
    const orb = q('#loadingOrb'), text = q('#loadingText'), cancel = q('#loadingCancel'), sub = q('#loadingSub');
    const o = R(ov), problems = [];
    const parts = { orb: R(orb), text: R(text), cancel: R(cancel) };
    for (const k of Object.keys(parts)) if (!inside(parts[k], o, 0.5)) problems.push(`${k} leaves the overlay (${JSON.stringify(parts[k])} vs ${JSON.stringify(o)})`);
    if (overlap(parts.orb, parts.text)) problems.push('orb overlaps the status text');
    if (overlap(parts.orb, parts.cancel)) problems.push('orb overlaps Cancel');
    if (overlap(parts.text, parts.cancel)) problems.push('text overlaps Cancel');
    if (parts.cancel.h < 43.5) problems.push(`Cancel is ${parts.cancel.h.toFixed(1)}px high (< 44)`);
    if (parts.cancel.w < 43.5) problems.push(`Cancel is ${parts.cancel.w.toFixed(1)}px wide (< 44)`);
    if (parts.orb.w < 55.5 || parts.orb.w > 132.5) problems.push(`orb is ${parts.orb.w.toFixed(1)}px (expected 56..132)`);
    const fs = parseFloat(getComputedStyle(q('#loadingOrb .yo-orb__count')).fontSize);
    if (fs < 15) problems.push(`counter number is ${fs.toFixed(1)}px (< 15)`);
    const panel = R(q('.control-panel'));
    if (parts.cancel.b > panel.y + 0.5 && o.b > panel.y + 0.5) problems.push('Cancel reaches the control panel');
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('page overflows horizontally');
    return { problems, orb: Math.round(parts.orb.w), num: +fs.toFixed(1), canvasH: Math.round(o.h), sub: !!sub };
  }, { h: pageHelpers.toString() });
}

async function evalOrb(page) {
  return page.evaluate(({ h }) => {
    const { R, inside, overlap } = new Function('return (' + h + ')()')();
    const q = (s) => document.querySelector(s);
    const loader = q('#portraitCanvasLoader'), vp = R(q('#viewport'));
    const orb = R(loader.querySelector('.yo-orb')), pill = R(q('#portraitLoaderText'));
    const problems = [];
    for (const [k, v] of [['orb', orb], ['pill', pill]]) if (!inside(v, vp, 0.5)) problems.push(`${k} leaves the canvas (${JSON.stringify(v)} vs ${JSON.stringify(vp)})`);
    if (overlap(orb, pill)) problems.push('orb overlaps the status pill');
    const veryShort = vp.h <= 200;                       // landscape phones: compact corner orb (56..64 px)
    const minOrb = veryShort ? 55.5 : 63.5, minNum = veryShort ? 15 : 17, maxCover = veryShort ? 0.52 : 0.45;
    if (orb.w < minOrb) problems.push(`portrait orb is ${orb.w.toFixed(1)}px (< ${Math.ceil(minOrb)})`);
    const fs = parseFloat(getComputedStyle(loader.querySelector('.yo-orb__count')).fontSize);
    if (fs < minNum) problems.push(`portrait counter number is ${fs.toFixed(1)}px (< ${minNum})`);
    const strip = Math.max(orb.b, pill.b) - vp.y;
    if (strip / vp.h > maxCover) problems.push(`loader covers ${(100 * strip / vp.h).toFixed(0)}% of the canvas height (> ${Math.round(maxCover * 100)}%)`);
    if (veryShort) {                                     // start corner: within 24 px of the start edge (left in LTR, right in RTL)
      const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
      const gap = rtl ? vp.r - orb.r : orb.x - vp.x;
      if (gap < 0 || gap > 24) problems.push(`short-canvas orb is ${gap.toFixed(0)}px from the start edge (expected 0..24)`);
    }
    const fl = q('#canvasFloat');
    if (fl && getComputedStyle(fl).display !== 'none') { const f = R(fl); if (f.w > 0 && (overlap(orb, f) || overlap(pill, f))) problems.push('loader overlaps the floating Undo / Original buttons'); }
    return { problems, orb: Math.round(orb.w), num: +fs.toFixed(1), coverPct: Math.round(100 * strip / vp.h) };
  }, { h: pageHelpers.toString() });
}

async function evalDialog(page, id) {
  return page.evaluate(({ h, id }) => {
    const { R, inside } = new Function('return (' + h + ')()')();
    const ov = document.getElementById(id), box = ov.querySelector('.modal-content'), close = ov.querySelector('.modal-close');
    const b = R(box), problems = [];
    const short = innerHeight <= 520;
    const gutter = short ? 7.5 : 15.5;
    if (b.x < gutter || b.y < (short ? 7.5 : 15.5) || innerWidth - b.r < gutter || innerHeight - b.b < (short ? 7.5 : 15.5))
      problems.push(`dialog is closer than the gutter to an edge (${JSON.stringify(b)} in ${innerWidth}x${innerHeight})`);
    if (box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY === 'visible') problems.push('tall dialog does not scroll');
    if (close) {
      const c = R(close);
      if (c.w < 43.5 || c.h < 43.5) problems.push(`Close is ${c.w.toFixed(1)}x${c.h.toFixed(1)} (< 44x44)`);
      if (!inside(c, b, 0.5)) problems.push('Close leaves the dialog');
    } else problems.push('no .modal-close');
    for (const btn of box.querySelectorAll('.modal-btn')) { const r = R(btn); if (r.h > 0 && r.h < 43.5) problems.push(`.modal-btn is ${r.h.toFixed(1)}px high (< 44)`); }
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('page overflows horizontally');
    return { problems, w: Math.round(b.w), h: Math.round(b.h) };
  }, { h: pageHelpers.toString(), id });
}

// Effective hit area: walk outwards from the centre while elementFromPoint still returns the control (or a child of it).
async function evalTouch(page) {
  return page.evaluate(() => {
    const sel = 'button, input[type="range"], .nav-tab, .sub-btn, .tool-btn, .color-dot, [role="button"], .frame-cat, .opt-box';
    const seen = new Set(), small = []; let probed = 0;
    const owns = (el, hit) => hit && (hit === el || el.contains(hit));
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return; seen.add(el);
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0 || el.disabled) return;
      if (el.closest('[hidden], [aria-hidden="true"]')) return;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
      if (!owns(el, document.elementFromPoint(cx, cy))) return;          // covered / clipped: not tappable right now
      probed++;
      const walk = (dx, dy) => { let n = 0; while (n < 80 && owns(el, document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1)))) n++; return n; };
      const w = walk(-1, 0) + walk(1, 0) + 1, h = walk(0, -1) + walk(0, 1) + 1;
      // A dimension that is SMALLER than the box itself is clipped by a scroll strip (a preset half scrolled out of view);
      // it is full-size once scrolled in, so only unclipped dimensions are judged.
      const wBad = w < 43.5 && w >= r.width - 1, hBad = h < 43.5 && h >= r.height - 1;
      if (wBad || hBad) small.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')} ${w}x${h}`);
    });
    return { small: [...new Set(small)], probed };
  });
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  let failures = 0, checks = 0;
  const report = (vp, what, problems) => {
    checks++;
    if (problems.length) { failures++; console.log(`  FAIL  [${vp}] ${what}`); problems.forEach((p) => console.log('        - ' + p)); }
    else console.log(`  ok    [${vp}] ${what}`);
  };

  for (const lang of LANGS) for (const base_vp of VIEWPORTS) {
    const vp = { ...base_vp, name: `${base_vp.name}/${lang.code}` };
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await ctx.addInitScript((code) => { try { localStorage.setItem('yofilter_language', code); } catch (_) {} }, lang.code);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    if (process.env.GEO_INJECT_CSS) await page.addStyleTag({ content: process.env.GEO_INJECT_CSS });
    await page.waitForTimeout(500);
    // The 2 s intro splash covers the whole app: remove it, or screenshots show the logo and elementFromPoint hits the splash.
    await page.evaluate(() => { const s = document.getElementById('splashScreen'); if (s) { s.classList.add('hidden'); s.style.display = 'none'; } });
    await page.waitForTimeout(100);

    // 1) loading modal - through the real API when it exists, else by toggling the classes it toggles
    await page.evaluate(() => {
      const hasApi = typeof window.showLoading === 'function';
      if (hasApi) window.showLoading('Removing object\u2026', { onCancel: function () {}, progress: { expectedMs: 8000, ceiling: 95 } });
      else {
        document.getElementById('loadingOrb').hidden = false; document.getElementById('loadingSpinner').hidden = true;
        document.getElementById('loadingCancel').hidden = false; document.getElementById('loadingText').innerText = 'Removing object\u2026';
        document.getElementById('loadingOverlay').classList.add('active');
      }
    });
    await page.waitForTimeout(150);
    const m = await evalModal(page);
    report(vp.name, `loading modal (orb ${m.orb}px, number ${m.num}px, canvas ${m.canvasH}px)`, m.problems);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name.replace('/', '-')}-modal.png`) });
    await page.evaluate(() => { if (typeof window.hideLoading === 'function') window.hideLoading({ instant: true }); document.getElementById('loadingOverlay').classList.remove('active', 'finishing'); });

    // 2) portrait canvas loader
    await page.evaluate(() => { const l = document.getElementById('portraitCanvasLoader'); l.classList.add('on'); l.setAttribute('aria-hidden', 'false'); });
    await page.waitForTimeout(350);
    const o = await evalOrb(page);
    report(vp.name, `portrait orb (orb ${o.orb}px, number ${o.num}px, covers ${o.coverPct}% of canvas height)`, o.problems);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name.replace('/', '-')}-portrait-orb.png`) });
    await page.evaluate(() => { const l = document.getElementById('portraitCanvasLoader'); l.classList.remove('on'); l.setAttribute('aria-hidden', 'true'); });

    // 3) dialogs
    for (const id of ['premiumModal', 'exportModal']) {
      await page.evaluate((i) => document.getElementById(i).classList.add('active'), id);
      await page.waitForTimeout(400);
      const d = await evalDialog(page, id);
      report(vp.name, `${id} (${d.w}x${d.h})`, d.problems);
      await page.screenshot({ path: path.join(SHOTS, `${vp.name.replace('/', '-')}-${id}.png`) });
      await page.evaluate((i) => document.getElementById(i).classList.remove('active'), id);
    }

    // 4) effective touch targets on every main tab
    const tabs = await page.$$('.main-nav .nav-tab');
    for (let i = 0; i < Math.min(3, tabs.length); i++) {
      await tabs[i].click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
      const { small, probed } = await evalTouch(page);
      // Guard against a vacuous pass (something covering the app makes every control "not tappable" and skipped).
      if (probed < 6) small.push(`only ${probed} controls were reachable - the page is covered or the tab did not open`);
      report(vp.name, `touch targets, tab ${i}: ${probed} controls probed (>= 44x44 effective)`, small);
    }
    report(vp.name, 'no uncaught page errors', errors);
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures}/${checks} geometry checks FAILED` : `\nAll ${checks} geometry checks passed`);
  process.exit(failures ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
