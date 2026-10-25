# UI text and messaging audit (on top of V29_AILoadingManager)

Scope: toasts, status text, loading text, error messages and labels in English and Arabic.
Result: 24/24 UI suites pass. Backend, Edge AI pipeline, rendering, history and module wrapping are untouched.

## 1. Toasts removed (the result is already visible, or the user caused it)
| Action | Removed toast | Why it was noise |
|---|---|---|
| Pick a filter / "Original" | Filter applied / Filter and colour edits cleared | The photo changes |
| Frame apply / remove / reset | Frame applied, removed, Controls reset | The photo changes |
| Curves reset | Curve reset | The curve redraws |
| Watermark switch | Watermark turned on / off | The switch is the feedback |
| Crop | Drag corners… / Move or resize… / Crop applied | The crop box and result are visible; the panel already has a hint |
| Auto Enhance | Auto enhancement applied | The photo changes |
| AI Mask | Applied to {region} / AI enhanced all regions | The status line under the buttons already says it |
| Background removal / Enhance Face | Background removed / Portrait enhanced | The photo changes |
| Magic Eraser | Object removed / Cancelled / first-open hint | Result visible; the modal closing is the cancel feedback |

## 2. Toasts kept (no other visible feedback)
Saved / Shared confirmations (a saved file changes nothing on screen), every error, the "nothing to do yet" warnings
(no region chosen, nothing painted, crop too small), "press back again to exit", and "Premium is coming soon".

## 3. Raw technical text no longer shown to users
`{msg}` (the raw exception text) was removed from export, save, download and erase failure toasts, and the
`err.message` concatenation from background-removal / enhance failures. Technical details stay in `console.error`.
Developer hints (`?api=`, `native_api_base`) moved out of the UI: the README and api-client header already document `?api=`,
and api-client now logs the `native_api_base` hint to the console when no server address is configured.

## 4. Copy changes
* Arabic rewritten in modern, natural wording (جارٍ…، تعذّر…، «حاول مرة أخرى»، اقتصاص، التعريض، تعتيم الحواف، ريترو…).
* English: one consistent voice, typographic ’ and …, American spelling (color), no "!" on confirmations, errors say what
  happened and what to do next.
* Brand unified to "YoFilter" (was "Yo Filter" in the About screen, terms and licences).
* 21 now-unused keys removed from both languages (required by the V23 "no unused i18n key" guard).
* The static default text in index.html and the English fallbacks in api-client / segmenter-service / magic-eraser follow the
  new wording, so nothing flashes the old text before applyI18n runs.

## 5. Test changes (each legitimately follows from the above)
* api_client_test, v26_test, segmenter_service_test, edge_wiring_test: assertions on the old wording now match the new wording.
* cancel_progress_test: a user cancel now shows NO toast (was: exactly one "Cancelled"); the "usually" ETA checks became
  case-insensitive so they cannot pass vacuously; `cancelled` removed from the key list.
* v22_test: the placeholder-fill check uses `maskApplyingTo` (its old key was removed).
* v25_test: G13 now expects `toastSaveFailed` and no raw `{msg}` (`toastSaveFailedMsg` removed).

## 6. Intentionally NOT changed
`privacyPolicyText` wording (pinned by the V20 static test; only "colour" -> "color") and `feature6`'s facts. See open question 1 in the hand-off message.
