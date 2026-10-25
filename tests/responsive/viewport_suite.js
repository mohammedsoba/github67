// viewport_suite.js - responsive layout sanity checks in headless Chromium.
//
//   node tests/responsive/viewport_suite.js            (or: npm run test:responsive)
//
// Needs only Node >= 20 and Playwright's Chromium (`npx playwright install chromium`). It serves the static
// front-end itself, so no uvicorn / ONNX models are required - none of these checks touch the backend.
//
// Matrix: 3 phone viewports x 2 languages (LTR English, RTL Arabic).
//   360x640  small phone          390x844  standard iOS/Android          428x926  large phone (Pro Max / Ultra)
//
// What is asserted (every check reports the offending element + measured numbers on failure):
//   page      no horizontal/vertical page overflow on any main tab
//   bars      top bar + bottom nav pill: no horizontal overflow, nothing clipped, children inside the bar
//   labels    bottom-nav labels fully readable: not truncated, not wrapped, not clipped, >= 9px
//   float     floating Undo / Original pill never overlaps the top bar, the bottom panel, the nav pill,
//             the header action buttons, or itself
//   frame     Frame tab design contract: glass cards, glowing 1px active state, readable un-truncated labels
//             (all 52 presets), pill tokens (#9a9aa6 inactive), scrollability, controls reachable above the nav
//
// Screenshots land in test-results/responsive/ (git-ignored). Exit code is non-zero if anything fails.
//
// Self-test hook: RESP_INJECT_CSS="<css>" injects extra CSS into every page, so you can deliberately break the layout
// and confirm the suite goes red (see "Negative controls" in tests/README.md), e.g.
//   RESP_INJECT_CSS=".main-nav .nav-tab span{font-size:22px!important}" node tests/responsive/viewport_suite.js
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('@playwright/test')); } catch (_) { ({ chromium } = require('playwright')); }

const ROOT = path.resolve(__dirname, '..', '..');
const PHOTO = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'photo.jpg');
const SHOTS = process.env.RESP_SHOTS_DIR || path.join(ROOT, 'test-results', 'responsive');

const VIEWPORTS = [
  { name: 'small-360x640', width: 360, height: 640 },
  { name: 'standard-390x844', width: 390, height: 844 },
  { name: 'large-428x926', width: 428, height: 926 },
];
const LANGS = [{ code: 'en', rtl: false }, { code: 'ar', rtl: true }];
const MAIN_TABS = [{ id: 'edit', index: 0 }, { id: 'tools', index: 1 }, { id: 'frame', index: 2 }];

// ---------------------------------------------------------------- static file server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
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

// ---------------------------------------------------------------- in-page measurement helpers
// Injected once per page as window.__t. Everything returns plain data so failures print readable numbers.
const HELPERS = () => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const fmt = (r) => `[x ${r.l.toFixed(1)}..${r.r.toFixed(1)}, y ${r.t.toFixed(1)}..${r.b.toFixed(1)}]`;
  const shown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  const rgba = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const label = (el) => {
    if (!el) return '(none)';
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').trim().slice(0, 18);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  window.__t = { R, fmt, shown, overlap, rgba, label };
};

// ---------------------------------------------------------------- the checks (each runs inside the page)
const CHECKS = {
  // No page-level scrolling in either axis (the app is a fixed 100dvh shell).
  page() {
    const { R, fmt, shown, label } = window.__t; const out = [];
    const de = document.documentElement, vw = innerWidth, vh = innerHeight;
    if (de.scrollWidth > vw + 1) out.push(`document scrollWidth ${de.scrollWidth} > viewport ${vw} (horizontal page overflow)`);
    if (de.scrollHeight > vh + 1) out.push(`document scrollHeight ${de.scrollHeight} > viewport ${vh} (vertical page overflow)`);
    const app = document.querySelector('.app').getBoundingClientRect();
    if (app.right > vw + 0.5 || app.left < -0.5) out.push(`.app spills outside viewport: x ${app.left}..${app.right}`);
    // body.scrollWidth is deliberately NOT used: body is position:fixed/overflow:hidden (unscrollable) and counts the
    // invisible #previewCanvas working buffer (opacity:0, native photo width). What matters is whether anything the
    // user can SEE spills past the viewport without being contained by a scroller.
    const clippedByScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
        const cs = getComputedStyle(p);
        // A clipping ancestor only contains the element if that ancestor is itself on-screen; a card thumb that sits
        // off-screen inside a scroll strip is clipped by the STRIP, so keep climbing until one is within the viewport.
        if (cs.overflowX !== 'visible') { const pr = R(p); if (pr.r <= vw + 0.5 && pr.l >= -0.5) return true; }
      }
      return false;
    };
    // Shell containers that must never scroll sideways (mobile.css: "nothing else does"): if their content is wider than
    // the box, the overflow is silently clipped by overflow:hidden and part of the UI is unreachable.
    for (const sel of ['.app', '.viewport', '.image-container', '.control-panel', '.panel-content', '.top-bar', '.main-nav']) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} hides horizontally overflowing content (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
    }
    for (const el of document.querySelectorAll('body *')) {
      if (!shown(el) || getComputedStyle(el).pointerEvents === 'none' && +getComputedStyle(el).zIndex < 0) continue;
      const r = R(el);
      if ((r.r > vw + 1 || r.l < -1) && !clippedByScroller(el)) out.push(`visible ${label(el)} ${fmt(r)} spills outside the ${vw}px viewport`);
    }
    return out.slice(0, 12);
  },

  // Primary navigation bars: top bar + bottom nav pill. Nothing may overflow or be clipped by them.
  bars() {
    const { R, fmt, shown, label, overlap } = window.__t; const out = [];
    const vw = innerWidth;
    for (const sel of ['.top-bar', '.main-nav']) {
      const bar = document.querySelector(sel); const br = R(bar);
      if (br.l < -0.5 || br.r > vw + 0.5) out.push(`${sel} outside viewport ${fmt(br)} (vw ${vw})`);
      if (bar.scrollWidth > bar.clientWidth + 1) out.push(`${sel} horizontal overflow: scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth}`);
      const kids = [...bar.querySelectorAll('button, label, span, i, svg, .top-title')].filter(shown);
      for (const k of kids) {
        const r = R(k);
        if (r.l < br.l - 0.5 || r.r > br.r + 0.5 || r.t < br.t - 0.5 || r.b > br.b + 0.5)
          out.push(`${sel} clips ${label(k)} ${fmt(r)} vs bar ${fmt(br)}`);
      }
    }
    // Top bar: the title must be fully visible and not collide with the side buttons.
    const title = document.querySelector('.top-title');
    if (title.scrollWidth > title.clientWidth + 1) out.push(`.top-title truncated (${title.scrollWidth} > ${title.clientWidth})`);
    const tr = R(title);
    for (const b of document.querySelectorAll('.top-bar .top-btn')) if (shown(b) && overlap(tr, R(b))) out.push(`.top-title overlaps ${label(b)}`);
    // Tap-target floor for the primary nav tabs.
    for (const tab of document.querySelectorAll('.main-nav .nav-tab')) { const r = R(tab); if (r.h < 44 || r.w < 44) out.push(`nav tab ${label(tab)} below 44px touch target (${r.w.toFixed(0)}x${r.h.toFixed(0)})`); }
    // The sub-tab strips scroll sideways by design, but their first button must start fully inside the strip.
    for (const bar of document.querySelectorAll('.sub-menu-bar')) {
      if (!shown(bar)) continue;
      const br = R(bar); if (br.l < -0.5 || br.r > vw + 0.5) out.push(`${label(bar)} outside viewport ${fmt(br)}`);
    }
    return out;
  },

  // Silent clipping: a visible control that pokes outside the nearest overflow:hidden ancestor is cut off and can't be
  // reached (deliberate scrollers - overflow-x:auto/scroll - are fine and are skipped). Covers all the UI chrome.
  clipping() {
    const { R, fmt, shown, label } = window.__t; const out = [];
    const roots = ['.top-bar', '.control-panel', '.main-nav'].map((s) => document.querySelector(s));
    for (const root of roots) for (const el of root.querySelectorAll('*')) {
      if (!shown(el)) continue;
      let clip = null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') break;                 // sits inside a deliberate horizontal scroller
        if (ox === 'hidden' || ox === 'clip') { clip = p; break; }   // would be silently cut off here
      }
      if (!clip) continue;
      const r = R(el), c = R(clip);
      if (r.r > c.r + 1 || r.l < c.l - 1) out.push(`${label(el)} ${fmt(r)} is cut off by ${label(clip)} ${fmt(c)}`);
    }
    return out.slice(0, 10);
  },

  // Bottom navigation labels: readable, whole, single-line, inside their tab and inside the pill.
  labels() {
    const { R, fmt, label } = window.__t; const out = [];
    const nav = R(document.querySelector('.main-nav'));
    for (const tab of document.querySelectorAll('.main-nav .nav-tab')) {
      const span = tab.querySelector('span'); if (!span) continue;
      const cs = getComputedStyle(span), fs = parseFloat(cs.fontSize), tr = R(tab);
      if (span.scrollWidth > span.clientWidth + 0.5) out.push(`label ${label(span)} clipped horizontally (${span.scrollWidth} > ${span.clientWidth})`);
      if (span.scrollHeight > span.clientHeight + 1) out.push(`label ${label(span)} clipped vertically (${span.scrollHeight} > ${span.clientHeight})`);
      const range = document.createRange(); range.selectNodeContents(span);
      const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
      if (lines > 1) out.push(`label ${label(span)} wraps onto ${lines} lines`);
      const q = range.getBoundingClientRect();
      if (q.left < tr.l + 1 || q.right > tr.r - 1) out.push(`label ${label(span)} text ${q.left.toFixed(1)}..${q.right.toFixed(1)} leaves its tab ${tr.l.toFixed(1)}..${tr.r.toFixed(1)}`);
      if (q.bottom > nav.b - 2 || q.top < nav.t) out.push(`label ${label(span)} vertically outside the nav pill ${fmt(nav)}`);
      if (fs < 9) out.push(`label ${label(span)} font-size ${fs}px < 9px readability floor`);
      if (cs.textOverflow === 'ellipsis' && span.scrollWidth > span.clientWidth) out.push(`label ${label(span)} shows an ellipsis`);
    }
    return out;
  },

  // Floating Undo + Original pill: sits on the canvas, never on top of chrome or controls.
  float() {
    const { R, fmt, shown, overlap, label } = window.__t; const out = [];
    const pills = ['#undoBtn', '#compareBtn'].map((s) => document.querySelector(s)).filter(shown);
    if (!pills.length) return ['floating Undo/Original pill is not visible after a photo is loaded'];
    const viewport = R(document.querySelector('#viewport'));
    const obstacles = [
      ['.top-bar', document.querySelector('.top-bar')],
      ['.control-panel (bottom panel)', document.querySelector('.control-panel')],
      ['.main-nav (nav pill)', document.querySelector('.main-nav')],
      ...[...document.querySelectorAll('.top-btn')].filter(shown).map((b) => [`action button ${label(b)}`, b]),
      ...[...document.querySelectorAll('.nav-tab')].filter(shown).map((b) => [`nav tab ${label(b)}`, b]),
      ...[...document.querySelectorAll('.control-panel button, .control-panel input, .control-panel .frame-item')].filter(shown).map((b) => [`panel control ${label(b)}`, b]),
    ];
    for (const p of pills) {
      const pr = R(p);
      if (pr.l < viewport.l - 0.5 || pr.r > viewport.r + 0.5 || pr.t < viewport.t - 0.5 || pr.b > viewport.b + 0.5)
        out.push(`${label(p)} ${fmt(pr)} leaves the canvas viewport ${fmt(viewport)}`);
      const panelTop = R(document.querySelector('.control-panel')).t;
      if (panelTop - pr.b < 8) out.push(`${label(p)} only ${(panelTop - pr.b).toFixed(1)}px above the bottom panel (need >= 8px clearance)`);
      for (const [name, el] of obstacles) if (overlap(pr, R(el))) out.push(`${label(p)} ${fmt(pr)} overlaps ${name} ${fmt(R(el))}`);
    }
    if (pills.length === 2 && overlap(R(pills[0]), R(pills[1]))) out.push('Undo and Original buttons overlap each other');
    return out;
  },
};

// Frame-tab design contract. Runs with the Frame tab open and 'All' selected.
const FRAME_CHECKS = {
  tokens() {
    const { rgba, label } = window.__t; const out = [];
    const items = [...document.querySelectorAll('#frameGrid .frame-item')];
    const idle = items.find((i) => !i.classList.contains('active')), active = items.find((i) => i.classList.contains('active'));
    if (!idle || !active) return ['expected both an idle and an active frame card'];

    const c = getComputedStyle(idle), bg = rgba(c.backgroundColor), bd = rgba(c.borderTopColor);
    if (!(bg && bg.r === 255 && bg.g === 255 && bg.b === 255 && Math.abs(bg.a - 0.05) < 0.011)) out.push(`idle card background should be white @ 5% (bg-white/5), got ${c.backgroundColor}`);
    if (c.borderTopWidth !== '1px') out.push(`idle card border should be 1px, got ${c.borderTopWidth}`);
    if (!(bd && bd.r === 255 && Math.abs(bd.a - 0.08) < 0.011)) out.push(`idle card border should be white @ 8% (border-white/8), got ${c.borderTopColor}`);
    if (parseFloat(c.borderTopLeftRadius) < 12) out.push(`idle card radius should be >= 12px (rounded-xl), got ${c.borderTopLeftRadius}`);

    const a = getComputedStyle(active), ab = rgba(a.borderTopColor);
    if (a.borderTopWidth !== '1px') out.push(`active card must keep a hairline 1px border (no heavy border), got ${a.borderTopWidth}`);
    if (!(ab && ab.a >= 0.45 && ab.b > ab.g + 60 && ab.b > ab.r + 60)) out.push(`active card border should be the indigo accent at >= 45% alpha, got ${a.borderTopColor}`);
    if (!/99,\s*102,\s*241/.test(a.boxShadow)) out.push(`active card needs an accent glow box-shadow, got "${a.boxShadow.slice(0, 80)}"`);
    const ty = new DOMMatrixReadOnly(a.transform === 'none' ? undefined : a.transform).m42;
    if (!(ty < -0.5)) out.push(`active card should be elevated (translateY < 0), got ${ty}`);
    if (!/blur/.test(a.backdropFilter || a.webkitBackdropFilter || '')) out.push('active card should carry a backdrop blur for its elevation');
    const lblI = rgba(getComputedStyle(idle.querySelector('span')).color), lblA = rgba(getComputedStyle(active.querySelector('span')).color);
    if (!(lblI && lblI.r === 154 && lblI.g === 154 && lblI.b === 166)) out.push(`idle frame label colour should be #9a9aa6, got ${getComputedStyle(idle.querySelector('span')).color}`);
    if (!(lblA && lblA.r >= 220)) out.push(`active frame label should be high-contrast, got ${getComputedStyle(active.querySelector('span')).color}`);
    return out;
  },

  // Every one of the 52 presets: whole label, readable size, real vertical padding, nothing clipped.
  labels() {
    const { R, label } = window.__t; const out = [];
    renderFrameGrid('all');
    const items = [...document.querySelectorAll('#frameGrid .frame-item')];
    if (items.length < 50) out.push(`expected ~52 frame cards, rendered ${items.length}`);
    for (const it of items) {
      const sp = it.querySelector('span'), cs = getComputedStyle(sp), fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight);
      const card = R(it), lr = R(sp), name = `"${sp.textContent}"`;
      if (sp.scrollWidth > sp.clientWidth + 0.5) out.push(`${name} truncated (${sp.scrollWidth} > ${sp.clientWidth})`);
      if (sp.scrollHeight > sp.clientHeight + 0.5) out.push(`${name} clipped vertically (${sp.scrollHeight} > ${sp.clientHeight}) - descenders are cut`);
      if (fs < 11) out.push(`${name} font-size ${fs}px < 11px`);
      if (!(lh / fs >= 1.2)) out.push(`${name} line-height ${(lh / fs).toFixed(2)} < 1.2 (needs vertical breathing room)`);
      if (card.b - lr.b < 5) out.push(`${name} only ${(card.b - lr.b).toFixed(1)}px bottom padding inside its card`);
      if (lr.l < card.l + 4 || lr.r > card.r - 4) out.push(`${name} touches the card edge (label ${lr.l.toFixed(1)}..${lr.r.toFixed(1)} card ${card.l.toFixed(1)}..${card.r.toFixed(1)})`);
      if (card.w < 64) out.push(`${name} card only ${card.w.toFixed(0)}px wide`);
    }
    // Without scrolling, the whole first row (pills + cards + labels) must sit inside the panel's visible window,
    // i.e. above the floating nav pill - the tightest constraint is the 360x640 phone.
    const inner = document.querySelector('#p-fit-panel .panel-inner'); inner.scrollTop = 0;
    const visBottom = Math.min(R(inner).b, R(document.querySelector('.main-nav')).t);
    for (const it of items.slice(0, 5)) {
      const sp = it.querySelector('span'), lb = R(sp).b, cb = R(it).b;
      if (cb > visBottom + 0.5) out.push(`"${sp.textContent}" card bottom ${cb.toFixed(1)} is below the visible panel edge ${visBottom.toFixed(1)} - needs scrolling to see its label`);
    }
    renderFrameGrid(activeFrameCat);
    return out;
  },

  pills() {
    const { R, rgba } = window.__t; const out = [];
    const pills = [...document.querySelectorAll('#frameCats .frame-cat')];
    if (pills.length !== 11) out.push(`expected 11 category pills, found ${pills.length}`);
    const idle = pills.find((p) => !p.classList.contains('active')), act = pills.find((p) => p.classList.contains('active'));
    const ci = getComputedStyle(idle), ca = getComputedStyle(act), ti = rgba(ci.color), bi = rgba(ci.backgroundColor), ba = rgba(ca.backgroundColor);
    if (!(ti && ti.r === 154 && ti.g === 154 && ti.b === 166)) out.push(`inactive pill text should be #9a9aa6, got ${ci.color}`);
    if (!(bi && bi.a > 0 && bi.a <= 0.12)) out.push(`inactive pill background should be translucent, got ${ci.backgroundColor}`);
    if (ca.backgroundImage !== 'none') out.push(`active pill should be a translucent fill (gradient is reserved for the Save CTA), got ${ca.backgroundImage.slice(0, 40)}`);
    if (!(ba && ba.a > 0 && ba.a < 0.35 && ba.b > ba.g)) out.push(`active pill should be a translucent accent fill, got ${ca.backgroundColor}`);
    if (!/99,\s*102,\s*241/.test(ca.boxShadow)) out.push(`active pill needs a glowing accent shadow, got "${ca.boxShadow.slice(0, 60)}"`);
    const tA = rgba(ca.color); if (!(tA && tA.r >= 220)) out.push(`active pill text should be high-contrast, got ${ca.color}`);
    for (const p of pills) {
      const cs = getComputedStyle(p), r = R(p);
      if (parseFloat(cs.fontSize) < 11) out.push(`pill "${p.textContent}" font-size ${cs.fontSize} < 11px`);
      if (r.h < 30) out.push(`pill "${p.textContent}" only ${r.h.toFixed(0)}px tall (< 30px touch target)`);
      if (p.scrollWidth > p.clientWidth + 0.5) out.push(`pill "${p.textContent}" text clipped`);
    }
    return out;
  },

  // Edges of the horizontal scrollers must leave room for the glow + elevation (they clip on overflow).
  glowRoom() {
    const { R } = window.__t; const out = [];
    const grid = document.querySelector('#frameGrid'), gcs = getComputedStyle(grid), rtl = gcs.direction === 'rtl';
    const first = grid.querySelector('.frame-item'), g = R(grid), f = R(first);
    const startGap = rtl ? g.r - f.r : f.l - g.l;
    if (startGap < 8) out.push(`first card is only ${startGap.toFixed(1)}px from the scroller edge - its glow would be clipped (need >= 8px)`);
    if (f.t - g.t < 6) out.push(`only ${(f.t - g.t).toFixed(1)}px above the cards - elevation/glow would be clipped (need >= 6px)`);
    const bottomGap = g.b - R(grid.querySelector('.frame-item.active') || first).b;
    if (bottomGap < 10) out.push(`only ${bottomGap.toFixed(1)}px below the cards - glow would be clipped (need >= 10px)`);
    const cats = document.querySelector('#frameCats'), c = R(cats), cf = R(cats.querySelector('.frame-cat.active'));
    const cStart = getComputedStyle(cats).direction === 'rtl' ? c.r - cf.r : cf.l - c.l;
    if (cStart < 8) out.push(`active pill is only ${cStart.toFixed(1)}px from the pill-bar edge - its glow would be clipped (need >= 8px)`);
    if (c.b - cf.b < 6) out.push(`only ${(c.b - cf.b).toFixed(1)}px below the pills - glow would be clipped (need >= 6px)`);
    return out;
  },
};

// ---------------------------------------------------------------- runner
const results = [];
function record(vp, lang, tab, name, failures) { results.push({ vp: vp.name, lang: lang.code, tab, name, failures }); }

async function openApp(browser, base, vp, lang) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript((code) => { try { localStorage.setItem('yofilter_language', code); } catch (_) {} }, lang.code);
  const page = await ctx.newPage();
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(base + '/index.html');
  if (process.env.RESP_INJECT_CSS) await page.addStyleTag({ content: process.env.RESP_INJECT_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.setInputFiles('#fileInput', PHOTO);
  await page.waitForFunction(() => { const i = document.querySelector('#mainImg'); return i && i.complete && i.naturalWidth > 0; });
  await page.waitForFunction(() => !document.querySelector('#loadingOverlay.active'));
  await page.waitForSelector('#compareBtn.active', { state: 'visible' });
  await page.evaluate(HELPERS);
  // The "Image loaded" toast is transient chrome; let it finish so it never masks a layout problem.
  await page.waitForTimeout(2600);
  return { ctx, page, pageErrors };
}

async function selectTab(page, tab) {
  await page.evaluate((i) => document.querySelectorAll('.main-nav .nav-tab')[i].click(), tab.index);
  await page.waitForTimeout(350);
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) for (const lang of LANGS) {
      const { ctx, page, pageErrors } = await openApp(browser, base, vp, lang);
      for (const tab of MAIN_TABS) {
        await selectTab(page, tab);
        for (const [name, fn] of Object.entries(CHECKS)) record(vp, lang, tab.id, name, await page.evaluate(fn));
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${lang.code}-${tab.id}.png`) });
      }

      // ---- Frame tab deep checks
      await selectTab(page, MAIN_TABS[2]);
      await page.evaluate(() => { filterFrameCat('all', document.querySelector('#frameCats .frame-cat')); applyFrame('min-white'); });
      await page.waitForTimeout(450);
      for (const [name, fn] of Object.entries(FRAME_CHECKS)) record(vp, lang, 'frame', `frame:${name}`, await page.evaluate(fn));

      // interaction: tapping a card selects it, keeps a 1px border, and leaves exactly one active card
      const inter = await page.evaluate(() => {
        const out = []; const cards = [...document.querySelectorAll('#frameGrid .frame-item')];
        cards[3].click();
        const act = [...document.querySelectorAll('#frameGrid .frame-item.active')];
        if (act.length !== 1) out.push(`expected exactly 1 active card after a tap, found ${act.length}`);
        else if (act[0].textContent.trim() !== cards[3].textContent.trim()) out.push(`wrong card active after tap: "${act[0].textContent.trim()}"`);
        else if (getComputedStyle(act[0]).borderTopWidth !== '1px') out.push(`active card border grew to ${getComputedStyle(act[0]).borderTopWidth}`);
        return out;
      });
      record(vp, lang, 'frame', 'frame:tap-select', inter);

      // scrollability: the card strip and the pill strip pan sideways; the control stack scrolls so the last row clears the nav
      const scroll = await page.evaluate(async () => {
        const { R, fmt, shown } = window.__t; const out = [];
        const grid = document.querySelector('#frameGrid'), cats = document.querySelector('#frameCats'), rtl = getComputedStyle(grid).direction === 'rtl';
        // Direction-agnostic: Chromium's RTL scroll offsets differ by layout, so try both signs, then require that the
        // LAST item becomes fully visible - i.e. every preset / category is actually reachable by panning.
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const [n, el] of [['card strip', grid], ['pill strip', cats]]) {
          if (el.scrollWidth <= el.clientWidth + 1) { out.push(`${n} does not overflow horizontally (nothing to scroll)`); continue; }
          const last = el.lastElementChild, inside = () => { const a = R(el), b = R(last); return b.l >= a.l - 0.5 && b.r <= a.r + 0.5; };
          if (inside()) out.push(`${n}: last item is already fully visible without scrolling`);
          el.scrollLeft = 100000; await wait(60);
          if (!inside()) { el.scrollLeft = -100000; await wait(60); }
          if (!inside()) out.push(`${n}: last item "${last.textContent.trim()}" is unreachable by scrolling (scrollLeft ${el.scrollLeft}, scrollWidth ${el.scrollWidth}, clientWidth ${el.clientWidth})`);
          el.scrollLeft = 0; await wait(30);
        }
        const inner = document.querySelector('#p-fit-panel .panel-inner'); inner.scrollTop = inner.scrollHeight; await new Promise((r) => setTimeout(r, 80));
        const navTop = R(document.querySelector('.main-nav')).t, panelTop = R(document.querySelector('.control-panel')).t;
        for (const sel of ['.frame-reset-btn', '.frame-color-toggle', '.frame-color-input', '#fc-padding']) {
          const el = document.querySelector(sel); if (!shown(el)) { out.push(`${sel} not rendered`); continue; }
          const r = R(el);
          if (r.b > navTop - 1) out.push(`${sel} ${fmt(r)} is hidden behind the nav pill (nav top ${navTop.toFixed(1)}) even when scrolled to the bottom`);
          if (r.t < panelTop) out.push(`${sel} ${fmt(r)} is above the panel (top ${panelTop.toFixed(1)})`);
        }
        // control rows: tall enough for the 24px slider thumb, never stacked on each other, no clipped labels
        const rows = [...document.querySelectorAll('#p-fit-panel .frame-ctrl-row')];
        rows.forEach((row, i) => {
          const r = R(row); if (r.h < 28) out.push(`control row ${i + 1} only ${r.h.toFixed(1)}px tall - slider thumbs (24px) collide with neighbours`);
          if (i && r.t < R(rows[i - 1]).b - 0.5) out.push(`control row ${i + 1} overlaps row ${i}`);
          if (row.scrollWidth > row.clientWidth + 1) out.push(`control row ${i + 1} overflows horizontally (${row.scrollWidth} > ${row.clientWidth})`);
        });
        for (const el of document.querySelectorAll('#p-fit-panel .frame-ctrl-lbl, #p-fit-panel .frame-color-toggle, #p-fit-panel .frame-reset-btn'))
          if (el.scrollWidth > el.clientWidth + 0.5) out.push(`"${el.textContent.trim()}" clipped (${el.scrollWidth} > ${el.clientWidth})`);
        for (const el of document.querySelectorAll('#p-fit-panel .frame-color-toggle, #p-fit-panel .frame-reset-btn')) { const r = R(el); if (r.h < 28) out.push(`"${el.textContent.trim()}" only ${r.h.toFixed(0)}px tall (< 28px)`); }
        inner.scrollTop = 0;
        return out;
      });
      record(vp, lang, 'frame', 'frame:scroll+controls', scroll);

      await page.evaluate(() => { const i = document.querySelector('#p-fit-panel .panel-inner'); i.scrollTop = 0; document.querySelector('#frameGrid').scrollLeft = 0; });
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${lang.code}-frame-final.png`) });
      record(vp, lang, 'all', 'no-uncaught-errors', pageErrors.map((m) => 'pageerror: ' + m));
      await ctx.close();
    }
  } finally {
    await browser.close(); server.close();
  }

  // ---- report
  let failed = 0, total = 0;
  const byCombo = new Map();
  for (const r of results) { const k = `${r.vp} / ${r.lang}`; if (!byCombo.has(k)) byCombo.set(k, []); byCombo.get(k).push(r); }
  for (const [combo, rs] of byCombo) {
    const bad = rs.filter((r) => r.failures.length);
    console.log(`\n${bad.length ? 'FAIL' : ' ok '}  ${combo}   (${rs.length - bad.length}/${rs.length} checks)`);
    for (const r of rs) {
      total++;
      if (!r.failures.length) continue;
      failed++;
      console.log(`   x [${r.tab}] ${r.name}`);
      for (const f of r.failures.slice(0, 6)) console.log(`        - ${f}`);
      if (r.failures.length > 6) console.log(`        ... +${r.failures.length - 6} more`);
    }
  }
  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${total - failed}/${total} checks across ${byCombo.size} viewport/language combinations. Screenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
