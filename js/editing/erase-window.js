// erase-window.js - which part of the photo the LaMa server actually needs.
//
// The 512x512 network only sees a square crop (hole + context) around the painted area, so
// uploading / downloading the whole photo (up to ~24 MB lossless at 12 MP) is wasted work.
// This computes a window that is guaranteed to contain the server's square crop (same maths as
// backend/app/lama.py, plus a small safety margin), so a cropped request gives exactly the
// same pixels as a full-photo one. Pure functions: no DOM, unit-tested from Node.
(function (root) {
  'use strict';
  var MODEL_SIZE = 512;                      // keep in sync with backend config.MODEL_SIZE
  var MIN_SIDE = 256, MAX_SIDE = MODEL_SIZE * 2;   // keep in sync with backend lama.py MIN_CROP_SIDE
  var CONTEXT_MIN_PX = 48;                                        // ... and CONTEXT_MIN_PX
  // Widest painted selection (bounding box of the mask, photo pixels) the server accepts; wider -> HTTP 400 there.
  var MAX_SELECTION_WIDTH = 1024;                                 // keep in sync with backend config.ERASE_MAX_SELECTION_WIDTH

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function dim(v) { return isNum(v) ? Math.floor(v) : 0; }

  // Bounding box of mask pixels > 127 in RGBA data (red channel, like the upload binarisation).
  // Returns null when nothing is painted (zero pixels) or the input is unusable (no data, bad size).
  function findBBox(data, w, h) {
    w = dim(w); h = dim(h);
    if (!data || !(w > 0) || !(h > 0)) return null;
    var rows = Math.min(h, Math.floor(data.length / (w * 4)));          // never read past a short buffer
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < rows; y++) {
      var row = y * w * 4, hit = false;
      for (var x = 0; x < w; x++) {
        if (data[row + x * 4] > 127) { hit = true; if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
      if (hit) { if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // Window (clamped to the photo) that contains the server's square crop for this bbox.
  // Returns null for a null / non-finite / zero-size bbox, a bbox entirely outside the photo, or a
  // photo with no pixels; a bbox that only partly leaves the photo is clamped to it first.
  function windowFromBBox(bb, W, H) {
    W = dim(W); H = dim(H);
    if (!bb || !(W > 0) || !(H > 0)) return null;
    if (!isNum(bb.x) || !isNum(bb.y) || !isNum(bb.w) || !isNum(bb.h) || bb.w <= 0 || bb.h <= 0) return null;
    var bx0 = Math.max(0, Math.floor(bb.x)), by0 = Math.max(0, Math.floor(bb.y));
    var bx1 = Math.min(W, Math.ceil(bb.x + bb.w)), by1 = Math.min(H, Math.ceil(bb.y + bb.h));
    if (bx1 <= bx0 || by1 <= by0) return null;                          // fully off-bounds
    bb = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
    var grow = Math.max(2, Math.round(Math.max(W, H) / 400));
    var span = Math.max(bb.w, bb.h) + 2 * grow;                       // server: max(x1-x0, y1-y0)
    var context = Math.max(CONTEXT_MIN_PX, Math.floor((span * 3 + 4) / 5));   // server crop_side(): 60% of the span per side
    var side = Math.min(Math.max(span + 2 * context, MIN_SIDE), MAX_SIDE);
    var half = Math.ceil(side / 2) + grow + 4;                        // centre may shift by <= grow when clamped
    var cx = Math.floor(bb.x + bb.w / 2), cy = Math.floor(bb.y + bb.h / 2);
    var x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
    var x1 = Math.min(W, cx + half), y1 = Math.min(H, cy + half);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, refSize: Math.max(W, H) };
  }

  // Selection-size guard, run BEFORE anything is encoded or uploaded (the server enforces the same limit as a backstop).
  // Looks at the width of the painted bounding box only - never at the size of the photo or of the window that gets uploaded.
  // `bb` is a findBBox() result; `max` is optional (tests). Returns { ok, width, max }; a missing / unusable bbox is ok:true with
  // width 0 - "nothing painted" is the caller's separate EMPTY_MASK case, not a size problem.
  function checkSelectionWidth(bb, max) {
    var limit = isNum(max) && max > 0 ? Math.floor(max) : MAX_SELECTION_WIDTH;
    var width = bb && isNum(bb.w) && bb.w > 0 ? Math.ceil(bb.w) : 0;
    return { ok: width <= limit, width: width, max: limit };
  }

  // True when `win` is a usable upload window: integer, non-empty, fully inside a W x H photo.
  function isValidWindow(win, W, H) {
    if (!win) return false;
    var ok = function (v) { return isNum(v) && Math.floor(v) === v; };
    return ok(win.x) && ok(win.y) && ok(win.w) && ok(win.h) && ok(win.refSize) &&
      win.w > 0 && win.h > 0 && win.x >= 0 && win.y >= 0 &&
      win.x + win.w <= W && win.y + win.h <= H && win.refSize >= Math.max(win.w, win.h);
  }

  var api = { MAX_SELECTION_WIDTH: MAX_SELECTION_WIDTH, findBBox: findBBox, windowFromBBox: windowFromBBox,
             isValidWindow: isValidWindow, checkSelectionWidth: checkSelectionWidth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EraseWindow = api;
})(typeof window !== 'undefined' ? window : globalThis);
