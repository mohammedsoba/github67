// ============================================================
// bg-removal.js — dependable free background removal
// ------------------------------------------------------------
// Uses the already-working MediaPipe Selfie Multiclass segmenter
// (shared, queued YoSegmenter service). Works locally in the browser
// with no API.
//
// V23/G4 memory profile: the matte is refined AT SEGMENTER RESOLUTION (<= 1024 px, 512 px on phones) and is
// only scaled up by the final `destination-in` composite. The old version scaled the raw mask to the full
// photo size (up to 2560x1706), refined it there and read two more full-size ImageData buffers to copy the
// matte pixel by pixel. Every canvas backing store is released (width = height = 0) as soon as it has been
// used, also when a step throws.
// ============================================================
window.BgRemoval = (function () {
  'use strict';

  var C = window.YoAiCommon;            // ai-common.js is loaded before this file
  var toast = C.makeToast('BgRemoval');
  var _busy = false;

  function waitForPortraitSegmenter() {
    // R17/R18: shared, queued service; rejects with a plain-language message (offline / timeout / failed)
    return YoSegmenter.load();
  }

  // Returns the refined matte (white RGBA, alpha = person) at segmenter resolution.
  function segmentPersonMask(imgEl) {
    var W = imgEl.naturalWidth || imgEl.width;
    var H = imgEl.naturalHeight || imgEl.height;
    var maxDim = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 512 : 1024;
    var scale = Math.min(1, maxDim / Math.max(W, H));
    var sw = Math.max(1, Math.round(W * scale));
    var sh = Math.max(1, Math.round(H * scale));
    var small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    var sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(imgEl, 0, 0, sw, sh);

    // Queued in YoSegmenter: this call gets ITS OWN mask, never another tool's.
    return YoSegmenter.segment(small).then(function (maskCanvas) {
      C.releaseCanvas(small);
      var mask;
      try { mask = refineMask(maskCanvas); } finally { C.releaseCanvas(maskCanvas); }
      return mask;
    }, function (err) {
      C.releaseCanvas(small);
      throw err;
    });
  }

  // Soft-threshold the confidence (alpha) and feather the edge, all at the mask's own size. The result keeps
  // the matte in the ALPHA channel so it can be applied with `destination-in` without reading pixels back.
  function refineMask(rawCanvas) {
    var W = rawCanvas.width, H = rawCanvas.height;
    var srcCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
    var img = srcCtx.getImageData(0, 0, W, H);
    var d = img.data;

    // Keep soft hair edges: dead-zone at both ends, smoothstep in between.
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3] / 255;
      a = a < 0.08 ? 0 : (a > 0.92 ? 1 : smoothstep(0.12, 0.88, a));
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }

    var sharp = document.createElement('canvas');
    sharp.width = W; sharp.height = H;
    sharp.getContext('2d').putImageData(img, 0, 0);

    // Tiny blur only on the alpha edge to avoid jagged cutouts (same ratio to the picture as before).
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var octx = out.getContext('2d');
    var feather = Math.max(1, Math.round(Math.min(W, H) / 550));
    try {
      YoCompat.drawBlurred(octx, sharp, W, H, feather);     // R5: works without ctx.filter (Safari/WKWebView)
    } finally {
      C.releaseCanvas(sharp);
    }
    return out;
  }

  function smoothstep(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // Photo x matte -> transparent PNG (blob: URL registered for the history budget).
  // `destination-in` keeps the photo's colour and multiplies its alpha by the matte (a photo that already has
  // transparent areas keeps them); the small matte is scaled up by drawImage with high-quality smoothing.
  function composeTransparent(imgEl, maskCanvas) {
    var w = imgEl.naturalWidth || imgEl.width;
    var h = imgEl.naturalHeight || imgEl.height;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var oc = out.getContext('2d');
    oc.drawImage(imgEl, 0, 0, w, h);
    oc.globalCompositeOperation = 'destination-in';
    oc.imageSmoothingEnabled = true;
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(maskCanvas, 0, 0, w, h);
    oc.globalCompositeOperation = 'source-over';
    return canvasToBlobUrl(out, 'image/png').then(function (res) {
      C.releaseCanvas(out);
      return res.url;
    }, function (err) {
      C.releaseCanvas(out);
      throw err;
    });
  }

  async function apply(opts) {
    if (_busy) return;
    var src = await C.currentSrc();
    if (!src) { toast(window.t('toastOpenPhoto'), 'error'); return; }
    _busy = true;
    C.overlayStart(window.t('loadingRemoving'), window.t('loadingLocalAI'));
    var mask = null;
    try {
      var imgEl;
      try { imgEl = await C.loadImage(src); } finally { C.releaseSrc(src); }
      C.overlayStep(window.t('loadingPreparing'));
      await waitForPortraitSegmenter();
      C.overlayStep(window.t('loadingIsolating'));
      mask = await segmentPersonMask(imgEl);
      C.overlayStep(window.t('loadingTransparent'));
      var dataUrl = await composeTransparent(imgEl, mask);

      if (opts && opts.returnDataUrl) return dataUrl;
      await C.applyResultToEditor(dataUrl, toast);
      return dataUrl;
    } catch (err) {
      console.error(err);
      toast((err && err.name === 'SegmenterError') ? err.message : window.t('toastBgFailed'), 'error');
    } finally {
      C.releaseCanvas(mask);            // the matte is never needed after the composite (or after a failure)
      _busy = false;
      C.overlayEnd();
    }
  }

  return { apply: apply };
})();

window.removeImageBackground = function () { window.BgRemoval.apply(); };
