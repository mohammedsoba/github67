// ============================================================
// splash.js
// Launch splash: ready-aware lifecycle (V28, reading-time timing)
// ============================================================
// Markup: #splashScreen in index.html. Styles: the inline <style id="splashCritical"> in <head> (not a stylesheet, so
// the splash is styled on first paint). This file only owns WHEN the splash leaves:
//
//   * it stays at least SPLASH_FLOOR_MS (3.5 s) from the moment it painted, so the brand, tagline and credit can be read comfortably;
//   * it leaves as soon as init is done (init.js calls autoDismissSplash() at the end of its DOMContentLoaded handler,
//     i.e. after every deferred script ran and the language was applied) - fast devices never wait longer than the floor;
//   * it leaves at SPLASH_CAP_MS (4 s) from first paint no matter what, so a slow or failed init can not hold the app hostage
//     (plus a pure-CSS 10 s failsafe in the inline style, for the case where this file never loads at all).
//
// Exit = CSS: opacity -> 0 and the stage scales up (compositor only); pointer-events are off from the first exit frame, so
// touches reach the app immediately. The node is removed afterwards, which frees its compositor layers.
// prefers-reduced-motion: no scale / pulse in CSS, and a slightly shorter floor here (3 s: the text is readable sooner without choreography).
(function (g) {
// V27 module "splash": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('splash', {
  autoDismissSplash: [() => autoDismissSplash, (v) => { autoDismissSplash = v; }],
});
const SPLASH_FLOOR_MS = 3500;          // minimum time on screen, measured from first paint (the 3-4 s reading window)
const SPLASH_REDUCED_FLOOR_MS = 3000;  // same, for prefers-reduced-motion users (no choreography to sit through)
const SPLASH_CAP_MS = 4000;            // hard ceiling, measured from first paint (must stay > SPLASH_FLOOR_MS)
const SPLASH_CAP_GRACE_MS = 300;       // the cap never fires sooner than this after this file runs (late-loading scripts still finish)
const SPLASH_TEXT_MIN_MS = 800;        // the tagline gets at least this long on screen once it is revealed
const SPLASH_REDUCED_TEXT_MIN_MS = 400; // same, for prefers-reduced-motion (its fade is 0.25 s)
const SPLASH_EXIT_MS = 600;            // > the 0.55 s CSS exit; only the safety net below uses it
let splashDismissed = false;
let splashReady = false;
let splashShownAt = null;              // performance.now() clock: when the splash first painted
let splashTextAt = null;               // when the tagline was revealed
let splashFloorTimer = null;
let splashCapTimer = null;

function splashNow() {
    return (g.performance && g.performance.now) ? g.performance.now() : Date.now();
}

function splashReducedMotion() {
    try { return !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (err) { return false; }
}

// First paint of the splash: Paint Timing when the browser has it, else "now" (this file runs right after the splash
// painted, so the error is small and always on the side of showing the brand a touch longer).
function splashMarkShown() {
    if (splashShownAt !== null) return;
    let t = null;
    try {
        const e = g.performance.getEntriesByName('first-contentful-paint');
        if (e && e.length) t = e[0].startTime;
    } catch (err) { /* Paint Timing unsupported (old WebView) */ }
    splashShownAt = (t !== null) ? t : splashNow();
}

// Reveal the translated tagline once the language is applied (the 'yofilter:i18n' event applyI18n dispatches), so Arabic
// users never see an English tagline flash by. If i18n never reports, the tagline simply stays hidden (logo + name remain).
function splashRevealText() {
    if (splashTextAt !== null) return;
    splashTextAt = splashNow();
    const splash = document.getElementById('splashScreen');
    if (splash) splash.classList.add('ys-text-in');
}

function skipSplash() {
    if (splashDismissed) return;
    splashDismissed = true;
    clearTimeout(splashFloorTimer);
    clearTimeout(splashCapTimer);
    const splash = document.getElementById('splashScreen');
    if (!splash) return;
    splash.classList.add('hidden');                // CSS exit: fade out + scale up, pointer-events:none at once
    splash.setAttribute('aria-hidden', 'true');
    let removed = false;
    const remove = function () {
        if (removed) return;
        removed = true;
        splash.removeEventListener('transitionend', onEnd);
        splash.style.display = 'none';
        if (splash.parentNode) splash.parentNode.removeChild(splash);
    };
    const onEnd = function (e) {
        if (e.target === splash && e.propertyName === 'opacity') remove();
    };
    splash.addEventListener('transitionend', onEnd);
    setTimeout(remove, SPLASH_EXIT_MS + 100);      // transitionend never fires in a background tab / when transitions are off
}

// Called by init.js at the end of its DOMContentLoaded handler = "the app is initialised". Name kept for that call site.
function autoDismissSplash() {
    if (splashDismissed || splashReady) return;
    splashReady = true;
    splashMarkShown();
    const reduced = splashReducedMotion();
    const floor = reduced ? SPLASH_REDUCED_FLOOR_MS : SPLASH_FLOOR_MS;
    const textMin = reduced ? SPLASH_REDUCED_TEXT_MIN_MS : SPLASH_TEXT_MIN_MS;
    const now = splashNow();
    let until = splashShownAt + floor;
    if (splashTextAt !== null) until = Math.max(until, splashTextAt + textMin);   // never cut the tagline off right after it appears
    const cap = splashShownAt + SPLASH_CAP_MS;
    clearTimeout(splashFloorTimer);
    splashFloorTimer = setTimeout(skipSplash, Math.max(0, Math.min(until, cap) - now));
}

// Armed when this file runs: the hard cap, and the tagline reveal. If init never reports in, the cap still dismisses.
splashMarkShown();
document.addEventListener('yofilter:i18n', splashRevealText, { once: true });
splashCapTimer = setTimeout(skipSplash, Math.max(SPLASH_CAP_GRACE_MS, splashShownAt + SPLASH_CAP_MS - splashNow()));
})(globalThis);
