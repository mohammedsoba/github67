# Self-hosted fonts

| File | Family | Coverage | Source |
|---|---|---|---|
| `inter-latin.woff2` | Inter (variable, wght 100-900) | Latin | `@fontsource-variable/inter` 5.3.0 (`inter-latin-wght-normal.woff2`) |
| `noto-sans-arabic.woff2` | Noto Sans Arabic (variable, wght 100-900) | Arabic blocks (U+0600-06FF, 0750-077F, FB50-FDFF, FE70-FEFC) + ZWNJ/ZWJ/LRM/RLM | `@fontsource-variable/noto-sans-arabic`, re-subset with `pyftsubset` (all layout features kept) |

Licenses: SIL Open Font License 1.1 (`OFL-Inter.txt`, `OFL-NotoSansArabic.txt`).
Declared in `css/base.css` (`font-display: swap`); served by `backend/app/main.py` at `/fonts/*` as `font/woff2`.
