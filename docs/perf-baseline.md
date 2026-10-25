# First-load performance baseline — Task P1.5 (fonts and scripts)

Measured with Lighthouse (mobile preset: Moto G Power UA, simulated Slow 4G — 150 ms RTT / 1.6 Mbps down, 4x CPU slowdown),
performance category only, **3 runs per build, median reported**, against the real FastAPI server (`uvicorn backend.app.main:app`).

| Metric (mobile) | Before (V17_P1_4) | After (P1.5) | Change |
|---|---|---|---|
| Performance score | 70 | 76 | +6 |
| First Contentful Paint (FCP) | 4.58 s | 1.98 s | **-57 %** |
| Largest Contentful Paint (LCP) | 4.77 s | 4.92 s | +0.15 s (noise-level, see notes) |
| Total Blocking Time (TBT) | 0 ms (0-37) | 146 ms (130-296) | see notes |
| Speed Index | 5.58 s | 4.61 s | -17 % |
| CLS | 0 | 0 | — |
| Total transfer | 576 KB | 624 KB | +48 KB (Inter Latin, now local) |
| Requests | 53 | 54 | +1 (`inter-latin.woff2`) |
| JS / CSS transfer | 370 KB / 77 KB | 372 KB / 78 KB | +2 KB (`startup-lang.js`) / +1 KB (`@font-face`) |
| Third-party requests | **1** (`fonts.googleapis.com`, render-blocking CSS) | **0** | eliminated |

Raw per-run values — FCP before: 4.67 / 4.58 / 4.51 s, after: 2.03 / 1.98 / 1.97 s. TBT after: 296 / 130 / 146 ms.

## How to read these numbers (important)

* **The "before" baseline was measured in a sandbox where `fonts.googleapis.com` is unreachable.** The render-blocking
  stylesheet request therefore failed instead of downloading, so the real-world "before" also paid for the Google CSS plus
  its font files (the old URL requested 16 families). The FCP gain on a real network is expected to be **at least** what is
  shown; the transfer-size "before" is understated. Re-run on your network to get the true before/after (command below).
* **LCP did not move.** The LCP element is `#lang-placeholder` (the "Tap to select an image" text); Lighthouse attributes
  ~1.3 s of "element render delay" to it because the splash screen covers it until `autoDismissSplash()` fires. LCP is
  therefore gated by the splash timer, not by fonts or scripts. Out of scope for P1.5.
* **TBT rose because FCP moved earlier.** TBT only counts long tasks between FCP and TTI; the same script-evaluation work now
  falls after an earlier FCP. Total JS bytes are unchanged (+2 KB). Treat TBT as a trade-off of the earlier first paint,
  and the next candidate for optimisation (e.g. splitting `init.js` startup work).
* Fonts shipped: `fonts/inter-latin.woff2` (47 KB, preloaded) and `fonts/noto-sans-arabic.woff2` (131 KB, fetched
  **only** when Arabic characters render, via `unicode-range`). Both are variable fonts covering weights 100-900.

## Reproduce

```bash
# terminal 1
LAMA_PROVIDER=cpu PORTRAIT_PROVIDER=cpu LAMA_WARMUP_PASSES=0 python -m uvicorn backend.app.main:app --port 8802
# terminal 2 (3 runs; take the median)
npx lighthouse http://127.0.0.1:8802/ --only-categories=performance --form-factor=mobile \
     --output=json --output-path=./lh-run1.json --chrome-flags="--headless=new"
```

For the true "before", check out the previous build and run the same command with internet access.
