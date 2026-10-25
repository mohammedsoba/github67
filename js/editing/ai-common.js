// ============================================================
// ai-common.js (V23) - helpers shared by the AI / portrait tools
// ------------------------------------------------------------
// bg-removal.js, portrait-enhance.js and ai-mask.js each carried their own byte-identical copies of the
// loading-overlay wrappers, "which image is current" lookup, image loader and (bg-removal / portrait-enhance)
// "make this URL the working image" routine. One copy lives here now.
//
// Global: window.YoAiCommon. Loaded before the three tools; everything else is resolved at call time.
// ============================================================
window.YoAiCommon = (function () {
  'use strict';

  // Toast function bound to a module tag (the tag is only used when the toast UI is missing).
  function makeToast(tag) {
    return function (msg, type) {
      if (typeof window.showToast === 'function') window.showToast(msg, type || 'success');
      else console.error('[' + tag + ']', msg);
    };
  }

  // Full-screen loader wrappers: the user always sees progress, never a frozen UI. These are the long on-device AI
  // runs, so they show the 1 -> 100 counter (js/ui/progress-counter.js) instead of the plain spinner.
  function overlayStart(title, sub) {
    if (typeof showLoading === 'function') showLoading(title || window.t('processing'), { progress: true });
    if (typeof updateLoadingSub === 'function') updateLoadingSub(sub || '');
  }
  function overlayStep(sub) { if (typeof updateLoadingSub === 'function') updateLoadingSub(sub || ''); }
  function overlayEnd() { if (typeof hideLoading === 'function') hideLoading(); }

  // Synchronous best guess of the current picture URL (on-screen image, else the working image).
  function currentSrcSync() {
    var main = document.getElementById('mainImg');
    if (main && main.src) return main.src;
    if (typeof originalImage !== 'undefined' && originalImage && originalImage.src) return originalImage.src;
    return '';
  }

  // Resolves to the working image at FULL working resolution with the colour edits rendered in
  // (possibly a transient blob: URL - hand it to releaseTransientImageUrl() once consumed).
  function currentSrc() {
    if (typeof getCurrentEditedImageSrc === 'function') {
      try { return Promise.resolve(getCurrentEditedImageSrc()); } catch (e) {}
    }
    return Promise.resolve(currentSrcSync());
  }

  function releaseSrc(src) {
    if (typeof releaseTransientImageUrl === 'function') releaseTransientImageUrl(src);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('Could not load image')); };
      im.src = src;
    });
  }

  // Yield so the overlay paints before heavy synchronous canvas work.
  function nextFrame() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(resolve, 0); });
      else setTimeout(resolve, 16);
    });
  }

  // Make `url` (a registered blob: URL) the working image. V24/G8: this is a thin wrapper over the ONE commit routine
  // (YoPipeline.commitImageUrl): colour edits are cleared (they are baked into the pixels), the Frame, the overlays and
  // the crop ratio are KEPT, preview canvas / overlay geometry / history are handled there. Resolves true when the
  // image was committed; on failure `toast` receives the message and it resolves false (never rejects).
  function applyResultToEditor(url, toast) {
    return window.YoPipeline.commitImageUrl(url).then(function () {
      return true;
    }, function () {
      if (toast) toast(window.t('toastSyncFailed'), 'error');
      return false;
    });
  }

  // Free a canvas backing store right now (width/height 0) instead of waiting for the garbage collector.
  function releaseCanvas(c) {
    if (c) { c.width = 0; c.height = 0; }
  }

  return {
    makeToast: makeToast,
    overlayStart: overlayStart, overlayStep: overlayStep, overlayEnd: overlayEnd,
    currentSrc: currentSrc, currentSrcSync: currentSrcSync, releaseSrc: releaseSrc,
    loadImage: loadImage, nextFrame: nextFrame,
    applyResultToEditor: applyResultToEditor,
    releaseCanvas: releaseCanvas
  };
})();
