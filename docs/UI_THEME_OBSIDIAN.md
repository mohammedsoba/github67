# YoFilter V67 - Obsidian / Indigo theme

Goal: a calm, eye-friendly premium dark theme (no neon, no violet-to-pink gradients, no heavy glows).

## Tokens (css/variables.css - the single source; polish.css holds the glass/accent-fill/text-inactive trio)
| Role | Value |
|---|---|
| App canvas / panels / wells / cards / raised | `#0f0f12` / `#16161a` / `#1a1a20` / `#1e1e24` / `#26262e` |
| Hairlines | `rgba(255,255,255,.06)` dividers, `.08` component borders, `.16` hover |
| Text | primary `#ededf1` (14.2:1 on cards), secondary `#b3b3be` (8.0:1), muted `#8c8c9a` (5.0:1), inactive `#9a9aa6` |
| Accent | `#6366f1` (rings, fills, icons), `#5a5de8` (fills carrying white text, 5.0:1), `#a5b4fc` (accent as text / focus ring, 8.3:1) |
| CTA fill | `--accent-gradient`: one hue, `#6164ea -> #5457de` (a sheen, not a gradient look) |
| Premium | muted gold `#dfb25c` with dark text (9.3:1) - white on amber was 2.1:1 |
| Status | success `#4cc38a`, warning `#e2ad4f`, danger `#ef6b7e` |
| Elevation | soft, wide shadows; accent glows cut to ~45% (`--shadow-glow`, button halos, active cards) |

## What changed
* All CSS colours point at tokens; every hard-coded violet/magenta/pink/cyan/blue is gone (CSS, canvas selection handles,
  curves line, eraser paint tint, About icons, splash glow, on-device-AI model card, loading orb).
* Gradient titles (modal titles, top title) are solid text; Upgrade / Save / Auto-Enhance / Remove-with-AI are flat tonal indigo.
* Cards, modals, Settings/About sheets and the Sky/Person/Background chips sit on `--bg-card`; toasts are a card tone with a
  muted status border (no coloured glow). Modal scrim is lighter (74%) with blur.
* Muted text now passes WCAG AA everywhere (was 3.2:1); `color-scheme: dark`, `theme-color` meta, indigo `::selection`.
* Fixed a latent bug: the premium price (`$4.99`) was rendered 14px/muted because both spans matched `.modal-price span`.

## Deliberately unchanged (user content, not chrome)
Frame styles and their colours (fit-frame.js), the text tool's "gradient" colour, preset thumbnails, R/G/B curve-channel colours.

## Tests
* UI suites: 24/24. Responsive suite: 126/132, identical to V29 (the 6 failures are the existing 42px nav tabs on 360x640).
* viewport_suite.js pins moved with the palette: accent rgb 99,102,241, inactive text #9a9aa6, idle card border 8%.
