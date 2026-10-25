# V28 - Launch splash upgrade

Built on the uploaded `youfilter_finalproject.zip` (V27 module structure). Scope: the launch splash only. **No change** to
editing, AI, backend, export, history, `init.js`, `version.json` (stays 1.0.0) or any other screen.

## Why upgrade instead of adding a second overlay

YoFilter already had a splash (`#splashScreen`). It had four problems, all fixed here:

| Problem (V27) | Fix (V28) |
|---|---|
| `.monogram` was `color: #000000` on the `#0f0f12` backdrop - the logo was effectively invisible | The logo is the real app icon, `icon.png` (the file `config.xml` ships), clipped to its squircle corners and preloaded; glow and shadow are tinted to the icon's cyan/violet |
| Blind 2 s timer from `DOMContentLoaded`, 0.8 s opacity-only exit | Ready-aware lifecycle (below), 0.55 s fade **+ scale-up** exit |
| No `prefers-reduced-motion` handling; `filter: blur()` animated on the logo (expensive on low-end GPUs) | Reduced-motion block; no blur/filter anywhere in the splash; transform + opacity only |
| Splash CSS lived in `components.css`, so it could only paint after the whole stylesheet chain | Inline `<style id="splashCritical">` in `<head>`, before the stylesheets |

## What changed

| File | Change |
|---|---|
| `index.html` | `<style id="splashCritical">` (all splash CSS) in `<head>`; new splash markup (`<img src="./icon.png">`, wordmark, tagline `data-i18n="splashTagline"`, developer credit, `aria-hidden`); `<link rel="preload" href="./icon.png" as="image">` |
| `css/components.css` | Old splash rules + `introFadeScale` / `glowSweep` keyframes removed (single source of truth). `fadeInUp` stays - `.tutorial-card` uses it |
| `js/ui/splash.js` | Rewritten lifecycle. Same module name, same single export `autoDismissSplash` |
| `js/i18n/i18n.js` | `splashTagline` in English and Arabic |
| `tests/ui/v28_test.js`, `tests/README.md` | 22 new checks (26 UI suites now) |

`js/core/init.js` is **untouched**: it already calls `autoDismissSplash()` as the last statement of its `DOMContentLoaded`
handler, which is exactly the "init complete" signal (all deferred scripts ran and `startup-lang.js` applied the language).
`#splashScreen`, `.hidden` and `#monogram` keep their names, so `tests/responsive/geometry_suite.js` keeps working.

## Lifecycle (`js/ui/splash.js`)

Times are measured from the splash's **first paint** (Paint Timing `first-contentful-paint`; falls back to "now" on WebViews
without it).

* **Floor 1.5 s** - never a flicker, even on a fast device.
* **Ready-aware** - when init reports in (`autoDismissSplash()`), the splash leaves at the floor, or immediately if the floor already passed.
* **Hard cap 2.0 s** - leaves regardless. The cap never fires sooner than 300 ms after `splash.js` itself runs, so on a very slow device the
  remaining scripts still get to finish. A pure-CSS 10 s failsafe (`ys-failsafe`) covers the case where `splash.js` never loads at all.
* **Tagline** fades in only after the language is applied (`yofilter:i18n`), so Arabic users never see an English flash. Once shown it gets
  >= 0.8 s on screen (bounded by the cap). If i18n never reports, the tagline stays hidden; the logo and name still show and nothing is delayed.
* **Developer credit** - "develop by YASSEN MOHAMMED" under the tagline: 11 px, muted, fades in after a 0.75 s delay and is fully visible at 1.45 s, just before the 1.5 s floor ends. Not translated (it is a name). Reduced motion: plain 0.25 s fade after 0.3 s.
* **Reduced motion**: floor 0.8 s (tagline minimum 0.4 s); CSS drops the pulse and the scale, entry/exit become plain fades.

## Motion and performance

* Only `opacity` and `transform` are animated (a test enforces this for every splash `@keyframes`); no `filter`, `blur()` or `backdrop-filter`.
* `will-change` on two elements only (`.splash-screen`, `.ys-stage`). The infinite glow pulse ends with the splash because the node is **removed** after
  the exit, which also frees its compositor layers (`transitionend` on opacity, with a timer fallback for background tabs).
* Exit: `.hidden` gives `pointer-events: none` and `visibility: hidden` from the first exit frame, so touches reach the app immediately.
* Verified in headless Chromium (390x844 @2x touch, 1280x800, Arabic, reduced motion): no JS errors; splash painted, `hidden` at about 1.8-1.9 s after
  navigation start, node removed about 0.6 s later; `elementFromPoint` after exit hits the app (`#uploadBox` / `#imgContainer`), not the splash.

## One honest limit

The inline CSS guarantees the splash is fully styled the instant the browser paints, with no dependency on `variables.css` / `base.css` /
`components.css`. It does **not** make that first paint earlier: the 19 same-origin stylesheets are still render-blocking, as before. Making them
non-blocking would let deferred scripts run before layout CSS is applied (init measures layout), so it was left out of this change on purpose.
If you want that, it is a separate task with its own tests.

Arabic: `rtl.css` forces the Arabic font stack on `body.rtl *` with `!important`, so the Latin "YoFilter" wordmark renders in that stack in Arabic mode.
That is existing app-wide behaviour and was not overridden.

## Tests

`node tests/ui/run_all.js` -> **All 26 UI suites passed** (25 existing + `v28_test.js`). Not run here: Playwright E2E (needs the backend and models),
`tests/responsive/*` (need the Playwright npm package).

## Timing update - reading-time splash (3.5 s floor, 4 s cap)

Only the three timing constants in `js/ui/splash.js` changed (logic, markup, CSS animations and `init.js` are untouched):

| Constant | Before | After |
|---|---|---|
| `SPLASH_FLOOR_MS` | 1500 | **3500** |
| `SPLASH_REDUCED_FLOOR_MS` (prefers-reduced-motion) | 800 | **3000** |
| `SPLASH_CAP_MS` | 2000 | **4000** |

Behaviour is otherwise as described above: measured from first paint, leaves at the floor once init is ready, the cap always wins,
the 10 s CSS failsafe still covers a `splash.js` that never loads. Invariant: `SPLASH_CAP_MS` must stay greater than `SPLASH_FLOOR_MS`.
`tests/ui/v28_test.js` timing expectations were updated to the new numbers (22/22, 26 UI suites green).
