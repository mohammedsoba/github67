// ============================================================
// loading-toast.js
// ============================================================
// showLoading(text, opts)
//   opts.onCancel  optional function. When given, a Cancel button is shown in the loading overlay;
//                  clicking it calls onCancel() and then closes the overlay immediately.
//   Every call resets the button, so a handler from a previous operation can never leak into the next.
//   opts.progress  optional. true, or { expectedMs, ceiling } (typical duration; 0 / missing = default; ceiling = the % the
//                  simulated count approaches, default 99 - AILoadingManager passes 95). Replaces the plain spinner
//                  by the 1 -> 100 counter orb (js/ui/progress-counter.js) - meant for the long AI operations only, so
//                  quick ones (loading a photo, a preset, an export) do not flash a pointless counter. Every call resets
//                  it too. hideLoading() then snaps the counter to 100 and fades the overlay out over ~0.5 s - but not
//                  after Cancel, and not when an error toast appeared meanwhile (the operation did not finish).
(function (g) {
// V27 module "loading-toast": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('loading-toast', {
  hideLoading: [() => hideLoading, (v) => { hideLoading = v; }],
  requireImage: [() => requireImage, (v) => { requireImage = v; }],
  showLoading: [() => showLoading, (v) => { showLoading = v; }],
  showToast: [() => showToast, (v) => { showToast = v; }],
  updateLoadingSub: [() => updateLoadingSub, (v) => { updateLoadingSub = v; }],
});
function _setLoadingCancel(onCancel) {
    var btn = document.getElementById('loadingCancel');
    if (!btn) return;
    btn.onclick = null;
    if (typeof onCancel !== 'function') { btn.hidden = true; return; }
    btn.hidden = false;
    btn.disabled = false;
    btn.onclick = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        btn.onclick = null;                       // a double tap must not fire the callback twice
        try { onCancel(); } catch (err) { if (typeof console !== 'undefined') console.error('[loading] onCancel failed', err); }
        hideLoading({ instant: true });           // cancelled: close at once, no "100 %" finish
    };
}

// ---- 1 -> 100 counter orb (see js/ui/progress-counter.js) -----------------------------------------------------------
var _orbController = null;     // YoProgress controller bound to #loadingOrb, created lazily and only once
var _orbActive = false;        // the current showLoading() call asked for the counter
var _orbFailed = false;        // an error toast appeared while it ran: the operation did not finish, so no "100 %"
var _finishTimer = 0;
var FINISH_MS = 520;           // how long the finished "100 %" orb stays before it has faded out (css/loading-orb.css)

function _getOrbController() {
    if (_orbController) return _orbController;
    if (!g.YoProgress) return null;                // engine not loaded: the plain spinner is used
    _orbController = g.YoProgress.attach({
        arc: document.getElementById('loadingArc'),
        num: document.getElementById('loadingPercent')
    });
    return _orbController;
}

// Ends the "finished" fade at once (a new operation started, or an error toast arrived).
function _endFinishing() {
    if (_finishTimer) { clearTimeout(_finishTimer); _finishTimer = 0; }
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) { overlay.classList.remove('finishing'); overlay.classList.remove('keep-cancel-space'); }
}

// Spinner or counter orb for the operation that is starting; `progress` is showLoading's opts.progress.
function _setLoadingProgress(progress) {
    var ctl = progress ? _getOrbController() : null;
    var orb = document.getElementById('loadingOrb');
    var spinner = document.getElementById('loadingSpinner');
    _orbActive = !!ctl;
    _orbFailed = false;
    if (orb) orb.hidden = !ctl;
    if (spinner) spinner.hidden = !!ctl;
    if (ctl) ctl.start(progress.expectedMs, progress.ceiling);
    else if (_orbController) _orbController.reset();
}

function showLoading(text, opts) {
    document.getElementById('loadingText').innerText = text;
    document.getElementById('loadingSub').innerText = '';
    _setLoadingCancel(opts && opts.onCancel);
    _endFinishing();                              // a previous operation's fade-out must not linger over this one
    _setLoadingProgress(opts && opts.progress);
    document.getElementById('loadingOverlay').classList.add('active');
    isProcessing = true;
}

function updateLoadingSub(text) {
    document.getElementById('loadingSub').innerText = text;
}

// opts.instant: skip the "100 %" finish (used by Cancel). The overlay itself always closes synchronously ('active' is
// removed and isProcessing cleared right here); the finish fade is a click-through ('finishing') layer on top of that.
function hideLoading(opts) {
    var cancelBtn = document.getElementById('loadingCancel');
    var hadCancel = !!cancelBtn && !cancelBtn.hidden;
    _setLoadingCancel(null);                      // hides the button and drops its click handler
    var overlay = document.getElementById('loadingOverlay');
    var ctl = _orbActive ? _orbController : null;
    var celebrate = !!ctl && !_orbFailed && !(opts && opts.instant === true);
    _orbActive = false;
    overlay.classList.remove('active');
    if (celebrate) {
        ctl.finish();
        overlay.classList.add('finishing');
        if (hadCancel) overlay.classList.add('keep-cancel-space');   // keep the space the Cancel button took: nothing jumps during the fade
        _finishTimer = setTimeout(_endFinishing, FINISH_MS);
    } else if (ctl) {
        ctl.reset();
    }
    isProcessing = false;
}

// Guard for tools that need a photo: shows the standard toast and returns false when none is loaded.
function requireImage() {
    if (originalImage) return true;
    showToast(window.t('toastLoadImage'), 'error');
    return false;
}

function showToast(message, type) {
    if (type === 'error') { _orbFailed = true; _endFinishing(); }   // an error is not a successful finish: no "100 %"
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.className = 'toast show ' + (type || '');
    if (toast._timeout) clearTimeout(toast._timeout);
    const duration = (type === 'error' || type === 'warning') ? 5000 : 3000;
    toast._timeout = setTimeout(function() { toast.classList.remove('show'); }, duration);
}
})(globalThis);
