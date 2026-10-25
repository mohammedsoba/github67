// ============================================================
// portrait-enhance.js — offline portrait enhancement
// ------------------------------------------------------------
// The old CodeFormer/GFPGAN Hugging Face Spaces often failed with
// "Failed to fetch". This version is 100% local: face-aware tone,
// detail, skin smoothing and eye/teeth highlights, with no server.
// ============================================================
window.PortraitEnhance = (function () {
  'use strict';

  var C = window.YoAiCommon;            // ai-common.js is loaded before this file (V23: shared helpers)
  var toast = C.makeToast('PortraitEnhance');
  var waitFrame = C.nextFrame;
  var _busy = false;

  async function apply() {
    if (_busy) return;
    var src = await C.currentSrc();
    if (!src) { toast(window.t('toastOpenPhoto'), 'error'); return; }
    _busy = true;
    C.overlayStart(window.t('loadingEnhancing'), window.t('loadingEnhancingSub'));
    try {
      var img;
      try { img = await C.loadImage(src); } finally { C.releaseSrc(src); }
      await waitFrame();
      C.overlayStep(window.t('loadingDetectSkin'));
      var dataUrl = await enhancePortraitLocal(img);
      await C.applyResultToEditor(dataUrl, toast);
      return dataUrl;
    } catch (err) {
      console.error(err);
      toast((err && err.name === 'SegmenterError') ? err.message : window.t('toastEnhanceFailed'), 'error');
    } finally {
      _busy = false;
      C.overlayEnd();
    }
  }

  // V23/G4 memory profile (W x H up to 2560 x 1706 = 17.5 MB per RGBA buffer):
  //   * the result is written IN PLACE into the one ImageData (no second createImageData + copy);
  //   * `base` / `blur` are dropped before the sharpening pass allocates its own blur buffers;
  //   * the unsharp mask works on the same pixel array (no putImageData -> getImageData round trip);
  //   * the canvas backing store is released in `finally`, on success AND on failure.
  async function enhancePortraitLocal(img) {
    var W = img.naturalWidth || img.width;
    var H = img.naturalHeight || img.height;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    try {
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);

      var pixels = ctx.getImageData(0, 0, W, H);
      var data = pixels.data;                       // output (written in place)
      var base = new Uint8ClampedArray(data);       // untouched original, read by the loop
      var blur = fastBlur(base, W, H, Math.max(2, Math.round(Math.min(W, H) / 260)));
      var cx = W * 0.5;
      var cy = H * 0.38;
      var rx = W * 0.34;
      var ry = H * 0.34;

      for (var y = 0; y < H; y++) {
        var fy = (y - cy) / ry;
        for (var x = 0; x < W; x++) {
          var i = (y * W + x) * 4;
          var r = base[i], g = base[i + 1], b = base[i + 2];
          var skin = skinScore(r, g, b);
          var fx = (x - cx) / rx;
          var faceWeight = Math.max(0, 1 - (fx * fx + fy * fy));
          var smooth = Math.min(0.58, skin * (0.18 + faceWeight * 0.38));
          var br = blur[i], bg = blur[i + 1], bb = blur[i + 2];

          // Smooth low-frequency skin variation, but preserve edges via high-pass detail.
          var nr = r * (1 - smooth) + br * smooth;
          var ng = g * (1 - smooth) + bg * smooth;
          var nb = b * (1 - smooth) + bb * smooth;

          // Gentle portrait tone lift and warmth on detected face/skin only.
          var lift = skin * (0.05 + faceWeight * 0.05);
          nr = nr + (255 - nr) * lift + 3 * skin;
          ng = ng + (245 - ng) * lift + 1 * skin;
          nb = nb + (235 - nb) * lift - 2 * skin;

          // Detail recovery: add back a controlled high-pass so result is not waxy.
          var detail = 0.30 + (1 - skin) * 0.22;
          nr += (r - br) * detail;
          ng += (g - bg) * detail;
          nb += (b - bb) * detail;

          // Eyes/teeth catchlights: brighten small low-saturation bright zones in face oval.
          var lum = (r + g + b) / 3;
          var maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
          var sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
          if (faceWeight > 0.25 && lum > 125 && sat < 0.28) {
            var eyeLift = Math.min(0.22, faceWeight * 0.12);
            nr += (255 - nr) * eyeLift;
            ng += (255 - ng) * eyeLift;
            nb += (255 - nb) * eyeLift;
          }

          data[i] = clamp(nr);
          data[i + 1] = clamp(ng);
          data[i + 2] = clamp(nb);
        }
        if (y % 220 === 0) await waitFrame();
      }

      base = null; blur = null;                     // free ~35 MB before the sharpening pass needs its own
      C.overlayStep(window.t('loadingSharpness'));
      unsharpInPlace(data, W, H, 0.28, Math.max(1, Math.round(Math.min(W, H) / 700)));
      ctx.putImageData(pixels, 0, 0);
      pixels = null; data = null;

      // blob: URL (not base64); size registered for the history byte budget. V24/G9: lossless working buffer (PNG).
      var encSpec = YoPipeline.encodeSpec();
      var res = await canvasToBlobUrl(c, encSpec.mime, encSpec.quality);
      return res.url;
    } finally {
      C.releaseCanvas(c);
    }
  }

  function skinScore(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var rule = r > 55 && g > 35 && b > 20 && r > b && r >= g * 0.82 && (max - min) > 12;
    if (!rule) return 0;
    var rg = Math.max(0, Math.min(1, (r - g + 28) / 78));
    var rb = Math.max(0, Math.min(1, (r - b + 30) / 95));
    var lum = (r + g + b) / 3;
    var l = lum < 55 ? 0 : (lum > 235 ? 0.55 : 1);
    return Math.max(0, Math.min(1, (rg * 0.45 + rb * 0.55) * l));
  }

  function fastBlur(src, W, H, radius) {
    radius = Math.max(1, radius | 0);
    var tmp = new Uint8ClampedArray(src.length);
    var out = new Uint8ClampedArray(src.length);
    var win = radius * 2 + 1;

    for (var y = 0; y < H; y++) {
      var sr = 0, sg = 0, sb = 0;
      for (var k = -radius; k <= radius; k++) {
        var x0 = Math.max(0, Math.min(W - 1, k));
        var idx0 = (y * W + x0) * 4;
        sr += src[idx0]; sg += src[idx0 + 1]; sb += src[idx0 + 2];
      }
      for (var x = 0; x < W; x++) {
        var idx = (y * W + x) * 4;
        tmp[idx] = sr / win; tmp[idx + 1] = sg / win; tmp[idx + 2] = sb / win; tmp[idx + 3] = src[idx + 3];
        var xAdd = Math.min(W - 1, x + radius + 1);
        var xSub = Math.max(0, x - radius);
        var ia = (y * W + xAdd) * 4;
        var is = (y * W + xSub) * 4;
        sr += src[ia] - src[is]; sg += src[ia + 1] - src[is + 1]; sb += src[ia + 2] - src[is + 2];
      }
    }

    for (var x2 = 0; x2 < W; x2++) {
      var tr = 0, tg = 0, tb = 0;
      for (var k2 = -radius; k2 <= radius; k2++) {
        var y0 = Math.max(0, Math.min(H - 1, k2));
        var idx1 = (y0 * W + x2) * 4;
        tr += tmp[idx1]; tg += tmp[idx1 + 1]; tb += tmp[idx1 + 2];
      }
      for (var y2 = 0; y2 < H; y2++) {
        var idx2 = (y2 * W + x2) * 4;
        out[idx2] = tr / win; out[idx2 + 1] = tg / win; out[idx2 + 2] = tb / win; out[idx2 + 3] = tmp[idx2 + 3];
        var yAdd = Math.min(H - 1, y2 + radius + 1);
        var ySub = Math.max(0, y2 - radius);
        var ia2 = (yAdd * W + x2) * 4;
        var is2 = (ySub * W + x2) * 4;
        tr += tmp[ia2] - tmp[is2]; tg += tmp[ia2 + 1] - tmp[is2 + 1]; tb += tmp[ia2 + 2] - tmp[is2 + 2];
      }
    }
    return out;
  }

  // Unsharp mask on an RGBA pixel array, in place (alpha untouched).
  function unsharpInPlace(d, W, H, amount, radius) {
    var blur = fastBlur(d, W, H, radius);
    for (var i = 0; i < d.length; i += 4) {
      d[i] = clamp(d[i] + (d[i] - blur[i]) * amount);
      d[i + 1] = clamp(d[i + 1] + (d[i + 1] - blur[i + 1]) * amount);
      d[i + 2] = clamp(d[i + 2] + (d[i + 2] - blur[i + 2]) * amount);
    }
  }

  function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)); }

  return { apply: apply };
})();

window.enhancePortraitFace = function () { window.PortraitEnhance.apply(); };