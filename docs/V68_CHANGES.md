# V68 - mobile geometry: loading overlay, orb, dialogs, touch targets

One new stylesheet, `css/geometry.css` (loaded after `loading-orb.css`, before `rtl.css`). It only overrides sizes and placement;
no JavaScript changed, and the older rules (and the tests that assert them) are untouched. `index.html` gains one `<link>`.

## Measured problems (V67, headless Chromium, 320x568 .. 844x390)
| Where | Problem |
|---|---|
| Loading modal | Content stack was ~236 px tall in a 214 px canvas at 320x568: orb 11 px above, Cancel 11 px below the canvas. In landscape (150 / 111 px canvases) the orb started 43 px above the canvas and Cancel landed on the control panel. |
| Cancel | 96 x 36 px (< 44). |
| Portrait orb | Fixed 58 px with a 15.7 px number; no scaling; stacked pill covered ~38 % of a 240 px canvas. |
| Bottom-nav tabs | 42 px high on compact phones (360x640), 34 px in landscape. Also failed 6 checks of the existing `viewport_suite.js` (126/132). |
| Landscape sub-menu bar | 42 px bar clipped its 44 px buttons to 42 px. |
| Dialogs | `.modal-overlay` had a flat 20 px padding and no `env(safe-area-inset-*)`; `.modal-content` capped at `92dvh` without the insets; Close was 32 px unless the pointer was coarse. |
| Frame tab sliders | Rows 30 px apart - a 44 px touch band collided with the neighbouring rows. |
| Floating cards | Toast and on-device-AI card ignored left / right insets. |

## What changed
1. **Loading modal** - the overlay is a CSS `container` (`container-type: size`); the orb is `clamp(72px, min(36cqw, 44cqh), 132px)`.
   Canvas shorter than 190 px: orb left, text + Cancel right (`clamp(56px, 62cqh, 100px)`). `@supports not (container-type: size)` keeps a
   viewport-based fallback. Cancel is 44 px high, 120 px wide.
2. **Portrait orb** - `clamp(64px, 18vw, 84px)` (number 17 .. 23 px). Canvas shorter than 320 px: status pill beside the orb. Landscape
   (viewport <= 520 px high): 56 .. 64 px orb in the start corner (mirrors in RTL), away from the subject.
3. **Dialogs** - gutter `max(16px, env(safe-area-inset-*))` on all four sides (8 px top / bottom in landscape), height
   `calc(100dvh - top - bottom)`, compact landscape typography, Close and `.modal-btn` 44 px.
4. **Touch targets** - nav tabs real 44 px+ (compact: margin 2 px; landscape: nav 52 px); landscape sub-menu bar 48 px; coarse pointers:
   `.sub-btn` min-width 44, `.edge-ai-btn` 44, `.me-slider` 44, `.tool-slider` 44 px touch band via padding (track unchanged, row does not grow),
   `.frame-ctrl-row` 44 px.
5. **Floating cards** - toast / edge-AI card width respects the left / right insets.

The ring maths (`RING_LENGTH = 326.73`, SVG `r = 52`) is untouched: the orb only ever changes through `--orb-size`.

## Verification
- `tests/responsive/geometry_suite.js` (new): 7 viewports x EN / AR = 112 checks - modal containment and sizes, orb placement / overlap / coverage,
  both dialogs, effective hit areas via `elementFromPoint` on all three main tabs. Negative controls via `GEO_INJECT_CSS` (see tests/README.md).
- `tests/ui/geometry_static_test.js` (new, browser-free): stylesheet order and invariants.
- Existing: 24 UI suites + `viewport_suite.js` (now 132/132; 126/132 on V67).

## Known limits
- Chromium cannot emulate `env(safe-area-inset-*)`, so insets are verified by the CSS (and the gutter assertion), not on a notched device.
  Please do one pass on a real notched iPhone in landscape.
- `container-type` needs Chrome 105 / Safari 16 / Firefox 110; older WebViews use the `@supports not` fallbacks.
