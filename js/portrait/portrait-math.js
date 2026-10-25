// ============================================================
// portrait-math.js  -  DOM-free depth-of-field maths for the on-device portrait path
// ============================================================
// A JavaScript port of the core of backend/app/portrait.py, so a depth map produced locally (onnxruntime-web)
// becomes the same kind of result the server returns: focal-plane mask, guided-filter edge snapping, a protected
// connected subject region and a layered disc bokeh with highlight bloom.
//
// Everything works on typed arrays only (no canvas, no DOM), so it runs in plain Node for the unit tests.
//
// KNOWN DIFFERENCES from the server (the server stays the reference; see docs/EDGE_AI_PORTRAIT.md):
//   * mask analysis runs at <= 640 px (server: <= 1600 px) and the bokeh layers at <= 1024 px - mobile memory/time
//   * no bilateral pre-filter / shock-filter step on the depth map (the colour guided filter does the edge snapping)
//   * no morphological opening of the focus region (a 4-connected flood fill from the tap is used directly)
//   * skin smoothing is NOT ported: requests with skin_smooth > 0 are served by the server
// Pixel-for-pixel identical output with the server is therefore NOT expected - visually equivalent is the goal.
//
// Public API (global YoPortraitMath)
//   toTensor(rgba, size)                      RGBA 518x518 -> Float32 NCHW (ImageNet mean/std)
//   normalizeDepth(depth)                     robust 1%..99% stretch to 0..1 (1 = nearest)
//   resizeBilinear(src, sw, sh, ch, dw, dh)   multi-channel Float32 bilinear resize
//   resizeArea(src, sw, sh, ch, dw, dh)       multi-channel Float32 area-average (down-scale) resize
//   computeMask(depth, guideRGBA, w, h, fx, fy)   Float32 w*h mask, 1 = keep sharp, 0 = fully blurred
//   composite(rgba, W, H, smallRGBA, bw, bh, mask, mw, mh, level)  -> Uint8ClampedArray (W*H*4) or null when untouched
//   strengthFor(level), constants
// ============================================================
var YoPortraitMath = (function () {
    'use strict';

    var MEAN = [0.485, 0.456, 0.406];
    var STD = [0.229, 0.224, 0.225];
    var MIN_LEVEL = 1, MAX_LEVEL = 30;
    var MASK_WORK = 640;          // longest side for the mask analysis
    var BOKEH_WORK = 1024;        // longest side for the blur layers

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function smoothstep(e0, e1, x) {
        var t = clamp((x - e0) / Math.max(e1 - e0, 1e-6), 0, 1);
        return t * t * (3 - 2 * t);
    }

    // ------------------------------------------------------------ preprocessing / depth
    function toTensor(rgba, size) {
        var n = size * size, out = new Float32Array(3 * n);
        for (var i = 0, p = 0; i < n; i++, p += 4) {
            out[i] = (rgba[p] / 255 - MEAN[0]) / STD[0];
            out[n + i] = (rgba[p + 1] / 255 - MEAN[1]) / STD[1];
            out[2 * n + i] = (rgba[p + 2] / 255 - MEAN[2]) / STD[2];
        }
        return out;
    }

    function normalizeDepth(depth) {
        var n = depth.length;
        for (var i = 0; i < n; i++) { if (!isFinite(depth[i])) throw new Error('Depth model returned non-finite values'); }
        var sorted = Float32Array.from(depth).sort();
        var low = sorted[Math.min(n - 1, Math.floor(0.01 * (n - 1)))];
        var high = sorted[Math.min(n - 1, Math.ceil(0.99 * (n - 1)))];
        var span = Math.max(high - low, 1e-6);
        var out = new Float32Array(n);
        for (var j = 0; j < n; j++) out[j] = clamp((depth[j] - low) / span, 0, 1);
        return out;
    }

    // ------------------------------------------------------------ resampling
    function resizeBilinear(src, sw, sh, ch, dw, dh) {
        if (sw === dw && sh === dh) return Float32Array.from(src);
        var out = new Float32Array(dw * dh * ch);
        var xs = new Int32Array(dw), xs1 = new Int32Array(dw), xw = new Float32Array(dw);
        for (var x = 0; x < dw; x++) {
            var fx = clamp((x + 0.5) * sw / dw - 0.5, 0, sw - 1);
            var x0 = Math.floor(fx);
            xs[x] = x0; xs1[x] = Math.min(sw - 1, x0 + 1); xw[x] = fx - x0;
        }
        for (var y = 0; y < dh; y++) {
            var fy = clamp((y + 0.5) * sh / dh - 0.5, 0, sh - 1);
            var y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
            var r0 = y0 * sw, r1 = y1 * sw, o = y * dw * ch;
            for (var xx = 0; xx < dw; xx++) {
                var a = (r0 + xs[xx]) * ch, b = (r0 + xs1[xx]) * ch, c = (r1 + xs[xx]) * ch, d = (r1 + xs1[xx]) * ch, wx = xw[xx];
                for (var k = 0; k < ch; k++) {
                    var top = src[a + k] + (src[b + k] - src[a + k]) * wx;
                    var bot = src[c + k] + (src[d + k] - src[c + k]) * wx;
                    out[o++] = top + (bot - top) * wy;
                }
            }
        }
        return out;
    }

    // Area average (down-scale): separable, with per-output-index source ranges precomputed once. Every inner loop walks
    // contiguous memory, so a 1024x768x4 -> 100x75 reduction costs milliseconds.
    function areaRanges(n, destN) {
        var ratio = n / destN, start = new Int32Array(destN), count = new Int32Array(destN), weights = [];
        for (var i = 0; i < destN; i++) {
            var a = i * ratio, b = (i + 1) * ratio, ia = Math.floor(a), ib = Math.min(n - 1, Math.ceil(b) - 1), w = [], sum = 0;
            for (var j = ia; j <= ib; j++) { var wg = Math.max(0, Math.min(b, j + 1) - Math.max(a, j)); w.push(wg); sum += wg; }
            for (var q = 0; q < w.length; q++) w[q] /= (sum || 1);
            start[i] = ia; count[i] = w.length; weights.push(w);
        }
        return { start: start, count: count, weights: weights };
    }

    function resizeArea(src, sw, sh, ch, dw, dh) {
        if (dw >= sw && dh >= sh) return resizeBilinear(src, sw, sh, ch, dw, dh);
        var tw = Math.min(dw, sw), th = Math.min(dh, sh), x, y, j, k;
        var hr = areaRanges(sw, tw), horiz = new Float32Array(sh * tw * ch);
        for (y = 0; y < sh; y++) {
            var row = y * sw * ch, orow = y * tw * ch;
            for (x = 0; x < tw; x++) {
                var s0 = hr.start[x], cnt = hr.count[x], wl = hr.weights[x];
                for (k = 0; k < ch; k++) {
                    var acc = 0;
                    for (j = 0; j < cnt; j++) acc += src[row + (s0 + j) * ch + k] * wl[j];
                    horiz[orow + x * ch + k] = acc;
                }
            }
        }
        var vr = areaRanges(sh, th), out = new Float32Array(th * tw * ch), rowLen = tw * ch;
        for (y = 0; y < th; y++) {
            var r0 = vr.start[y], vc = vr.count[y], vw = vr.weights[y], o = y * rowLen;
            for (j = 0; j < vc; j++) {
                var wgt = vw[j], base = (r0 + j) * rowLen;
                for (x = 0; x < rowLen; x++) out[o + x] += horiz[base + x] * wgt;
            }
        }
        return (tw === dw && th === dh) ? out : resizeBilinear(out, tw, th, ch, dw, dh);
    }

    // ------------------------------------------------------------ box / gaussian filters
    // Mean over the (clamped) window, per channel, with running sums: O(n) for any radius, row-major access only.
    function boxFilter(src, w, h, ch, r) {
        if (r < 1) return src;
        var tmp = new Float32Array(src.length), out = new Float32Array(src.length);
        var x, y, k;
        // horizontal
        for (y = 0; y < h; y++) {
            var row = y * w * ch;
            for (k = 0; k < ch; k++) {
                var sum = 0, hi = Math.min(w - 1, r);
                for (x = 0; x <= hi; x++) sum += src[row + x * ch + k];
                for (x = 0; x < w; x++) {
                    var x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
                    tmp[row + x * ch + k] = sum / (x2 - x1 + 1);
                    if (x + r + 1 < w) sum += src[row + (x + r + 1) * ch + k];
                    if (x - r >= 0) sum -= src[row + (x - r) * ch + k];
                }
            }
        }
        // vertical: one accumulator per column, rows added/removed as the window slides
        var rowLen = w * ch, acc = new Float64Array(rowLen), i;
        for (y = 0; y <= Math.min(h - 1, r); y++) for (i = 0; i < rowLen; i++) acc[i] += tmp[y * rowLen + i];
        for (y = 0; y < h; y++) {
            var y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r), inv = 1 / (y2 - y1 + 1), o = y * rowLen;
            for (i = 0; i < rowLen; i++) out[o + i] = acc[i] * inv;
            if (y + r + 1 < h) { var add = (y + r + 1) * rowLen; for (i = 0; i < rowLen; i++) acc[i] += tmp[add + i]; }
            if (y - r >= 0) { var del = (y - r) * rowLen; for (i = 0; i < rowLen; i++) acc[i] -= tmp[del + i]; }
        }
        return out;
    }

    function gaussian(src, w, h, ch, sigma) {
        if (sigma < 0.3) return src;
        if (sigma >= 2.5) {                                   // 3 box passes ~ a Gaussian, O(n)
            var r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
            var a = boxFilter(src, w, h, ch, r);
            a = boxFilter(a, w, h, ch, r);
            return boxFilter(a, w, h, ch, r);
        }
        var rad = Math.max(1, Math.ceil(sigma * 3)), kernel = new Float32Array(2 * rad + 1), sum = 0, i;
        for (i = -rad; i <= rad; i++) { kernel[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += kernel[i + rad]; }
        for (i = 0; i < kernel.length; i++) kernel[i] /= sum;
        var tmp = new Float32Array(src.length), out = new Float32Array(src.length), x, y, k, t, acc;
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) for (k = 0; k < ch; k++) {
            acc = 0;
            for (t = -rad; t <= rad; t++) acc += kernel[t + rad] * src[(y * w + clamp(x + t, 0, w - 1)) * ch + k];
            tmp[(y * w + x) * ch + k] = acc;
        }
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) for (k = 0; k < ch; k++) {
            acc = 0;
            for (t = -rad; t <= rad; t++) acc += kernel[t + rad] * tmp[(clamp(y + t, 0, h - 1) * w + x) * ch + k];
            out[(y * w + x) * ch + k] = acc;
        }
        return out;
    }

    // ------------------------------------------------------------ colour guided filter (He et al.), single-channel src
    // guide: three Float32 planes [r, g, b] in 0..1.
    function guidedFilter(guide, src, w, h, radius, eps) {
        var n = w * h, i;
        var gr = guide[0], gg = guide[1], gb = guide[2];
        var mean = function (x) { return boxFilter(x, w, h, 1, radius); };
        var mul = function (a, b) { var o = new Float32Array(n); for (var q = 0; q < n; q++) o[q] = a[q] * b[q]; return o; };
        var mr = mean(gr), mg = mean(gg), mb = mean(gb), mp = mean(src);
        var cr = mean(mul(gr, src)), cg = mean(mul(gg, src)), cb = mean(mul(gb, src));
        var vrr = mean(mul(gr, gr)), vrg = mean(mul(gr, gg)), vrb = mean(mul(gr, gb));
        var vgg = mean(mul(gg, gg)), vgb = mean(mul(gg, gb)), vbb = mean(mul(gb, gb));
        var a0 = new Float32Array(n), a1 = new Float32Array(n), a2 = new Float32Array(n), b = new Float32Array(n);
        for (i = 0; i < n; i++) {
            var gp0 = cr[i] - mr[i] * mp[i], gp1 = cg[i] - mg[i] * mp[i], gp2 = cb[i] - mb[i] * mp[i];
            var s00 = vrr[i] - mr[i] * mr[i] + eps, s01 = vrg[i] - mr[i] * mg[i], s02 = vrb[i] - mr[i] * mb[i];
            var s11 = vgg[i] - mg[i] * mg[i] + eps, s12 = vgb[i] - mg[i] * mb[i], s22 = vbb[i] - mb[i] * mb[i] + eps;
            var c00 = s11 * s22 - s12 * s12, c01 = s02 * s12 - s01 * s22, c02 = s01 * s12 - s02 * s11;
            var c11 = s00 * s22 - s02 * s02, c12 = s01 * s02 - s00 * s12, c22 = s00 * s11 - s01 * s01;
            var det = s00 * c00 + s01 * c01 + s02 * c02;
            if (Math.abs(det) < 1e-12) det = 1e-12;
            var k0 = (c00 * gp0 + c01 * gp1 + c02 * gp2) / det;
            var k1 = (c01 * gp0 + c11 * gp1 + c12 * gp2) / det;
            var k2 = (c02 * gp0 + c12 * gp1 + c22 * gp2) / det;
            a0[i] = k0; a1[i] = k1; a2[i] = k2;
            b[i] = mp[i] - k0 * mr[i] - k1 * mg[i] - k2 * mb[i];
        }
        a0 = mean(a0); a1 = mean(a1); a2 = mean(a2); b = mean(b);
        var out = new Float32Array(n);
        for (i = 0; i < n; i++) out[i] = clamp(a0[i] * gr[i] + a1[i] * gg[i] + a2[i] * gb[i] + b[i], 0, 1);
        return out;
    }

    // ------------------------------------------------------------ small morphology / regions
    function erode3(mask, w, h) {                              // 3x3 min filter on a 0/1 float mask
        var out = new Float32Array(mask.length);
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
            var m = 1;
            for (var dy = -1; dy <= 1 && m; dy++) for (var dx = -1; dx <= 1; dx++) {
                var v = mask[clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)];
                if (v < m) { m = v; if (!m) break; }
            }
            out[y * w + x] = m;
        }
        return out;
    }

    function medianPatch(depth, w, h, fx, fy) {
        var cx = Math.round(clamp(fx, 0, 1) * (w - 1)), cy = Math.round(clamp(fy, 0, 1) * (h - 1));
        var radius = Math.max(2, Math.floor(Math.min(w, h) * 0.012)), vals = [];
        for (var y = Math.max(0, cy - radius); y < Math.min(h, cy + radius + 1); y++) {
            for (var x = Math.max(0, cx - radius); x < Math.min(w, cx + radius + 1); x++) vals.push(depth[y * w + x]);
        }
        vals.sort(function (a, b) { return a - b; });
        return vals[vals.length >> 1];
    }

    // 4-connected region of `delta < tol` containing the tap (snapped to the nearest candidate pixel).
    function focusRegion(delta, w, h, fx, fy, tol) {
        var n = w * h, region = new Float32Array(n);
        var sx = Math.round(clamp(fx, 0, 1) * (w - 1)), sy = Math.round(clamp(fy, 0, 1) * (h - 1));
        if (!(delta[sy * w + sx] < tol)) {
            var best = -1, bestD = Infinity;
            for (var i = 0; i < n; i++) {
                if (delta[i] < tol) {
                    var dx = (i % w) - sx, dy = ((i / w) | 0) - sy, d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; best = i; }
                }
            }
            if (best < 0) return region;
            sx = best % w; sy = (best / w) | 0;
        }
        var stack = new Int32Array(n), top = 0, seen = new Uint8Array(n), start = sy * w + sx;
        stack[top++] = start; seen[start] = 1;
        while (top > 0) {
            var p = stack[--top], px = p % w, py = (p / w) | 0;
            region[p] = 1;
            if (px > 0 && !seen[p - 1] && delta[p - 1] < tol) { seen[p - 1] = 1; stack[top++] = p - 1; }
            if (px < w - 1 && !seen[p + 1] && delta[p + 1] < tol) { seen[p + 1] = 1; stack[top++] = p + 1; }
            if (py > 0 && !seen[p - w] && delta[p - w] < tol) { seen[p - w] = 1; stack[top++] = p - w; }
            if (py < h - 1 && !seen[p + w] && delta[p + w] < tol) { seen[p + w] = 1; stack[top++] = p + w; }
        }
        return region;
    }

    function guidePlanes(rgba, n) {
        var r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
        for (var i = 0, p = 0; i < n; i++, p += 4) { r[i] = rgba[p] / 255; g[i] = rgba[p + 1] / 255; b[i] = rgba[p + 2] / 255; }
        return [r, g, b];
    }

    // ------------------------------------------------------------ the sharpness mask (server: _mask_at_working_res)
    // depth: Float32 w*h in 0..1 (1 = nearest) at the SAME size as guideRGBA (Uint8 RGBA).  1.0 = sharp, 0.0 = blurred.
    function computeMask(depth, guideRGBA, w, h, fx, fy) {
        var n = w * h, i, short = Math.min(w, h);
        var guide = guidePlanes(guideRGBA, n);

        var refined = guidedFilter(guide, depth, w, h, Math.max(3, Math.floor(short / 140)), 1e-3);
        var focus = medianPatch(refined, w, h, fx, fy);
        var delta = new Float32Array(n), mask = new Float32Array(n);
        for (i = 0; i < n; i++) {
            delta[i] = Math.abs(refined[i] - focus);
            mask[i] = 1 - Math.pow(smoothstep(0.05, 0.60, delta[i]), 0.85);       // flat band + long S-curve
        }

        var core = focusRegion(delta, w, h, fx, fy, 0.20);                          // protected subject
        var coreSoft = gaussian(core, w, h, 1, Math.max(0.8, short / 700));
        for (i = 0; i < n; i++) if (coreSoft[i] > mask[i]) mask[i] = coreSoft[i];

        var radius = Math.max(4, Math.floor(short / 90));
        mask = guidedFilter(guide, mask, w, h, radius, 1e-3);                       // coarse: body shape
        mask = guidedFilter(guide, mask, w, h, Math.max(2, Math.floor(radius / 3)), 2e-4);   // fine: hair

        var firm = core, erodePx = Math.max(1, Math.round(short / 500));
        for (i = 0; i < erodePx; i++) firm = erode3(firm, w, h);
        firm = gaussian(firm, w, h, 1, 0.7);
        for (i = 0; i < n; i++) if (firm[i] > mask[i]) mask[i] = firm[i];

        mask = gaussian(mask, w, h, 1, Math.max(0.5, short / 1500));
        for (i = 0; i < n; i++) mask[i] = clamp(mask[i], 0, 1);
        return mask;
    }

    // ------------------------------------------------------------ bokeh (server: _disc_blur / _composite)
    function discBlur(image, w, h, radius) {                   // 4-channel Float32
        if (radius < 0.8) return image;
        if (radius < 3.0) return gaussian(image, w, h, 4, radius * 0.58);
        var factor = Math.max(1, radius / 3.5);
        var sw = Math.max(1, Math.round(w / factor)), sh = Math.max(1, Math.round(h / factor));
        var small = factor > 1 ? resizeArea(image, w, h, 4, sw, sh) : image;
        var r = radius / factor, k = Math.ceil(r) + 1, size = 2 * k + 1, kern = [], sum = 0, ky, kx;
        for (ky = -k; ky <= k; ky++) for (kx = -k; kx <= k; kx++) {
            var wgt = clamp(r + 0.5 - Math.sqrt(kx * kx + ky * ky), 0, 1);
            if (wgt > 0) { kern.push(kx, ky, wgt); sum += wgt; }
        }
        for (var q = 2; q < kern.length; q += 3) kern[q] /= sum;
        var out = new Float32Array(sw * sh * 4), x, y, t, c;
        for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
            var a0 = 0, a1 = 0, a2 = 0, a3 = 0;
            for (t = 0; t < kern.length; t += 3) {
                var px = clamp(x + kern[t], 0, sw - 1), py = clamp(y + kern[t + 1], 0, sh - 1), o = (py * sw + px) * 4, wk = kern[t + 2];
                a0 += small[o] * wk; a1 += small[o + 1] * wk; a2 += small[o + 2] * wk; a3 += small[o + 3] * wk;
            }
            c = (y * sw + x) * 4;
            out[c] = a0; out[c + 1] = a1; out[c + 2] = a2; out[c + 3] = a3;
        }
        var soft = gaussian(out, sw, sh, 4, Math.max(0.6, r * 0.22));                // creamy disc edge
        void size;
        return factor > 1 ? resizeBilinear(soft, sw, sh, 4, w, h) : soft;
    }

    function strengthFor(level) {
        var l = clamp(Math.round(level), MIN_LEVEL, MAX_LEVEL);
        return (l - MIN_LEVEL) * MAX_LEVEL / (MAX_LEVEL - MIN_LEVEL);
    }

    // rgba: Uint8(Clamped)Array W*H*4 (full resolution source).  smallRGBA: the same photo at bw*bh (<= BOKEH_WORK).
    // mask: Float32 mw*mh (1 = sharp).  Returns a NEW Uint8ClampedArray W*H*4 (alpha copied), or null when the
    // level is so low that the photo stays untouched (the caller then keeps the original).
    function composite(rgba, W, H, smallRGBA, bw, bh, mask, mw, mh, level) {
        var lvl = clamp(Math.round(level), MIN_LEVEL, MAX_LEVEL);
        var strength = strengthFor(lvl), t = strength / MAX_LEVEL;
        var maxRadius = strength * Math.max(W, H) / 1600 * 1.8;
        if (maxRadius < 0.8) return null;

        var nb = bw * bh, i, c;
        var amount = resizeBilinear(mask, mw, mh, 1, bw, bh);
        var any = false;
        for (i = 0; i < nb; i++) { amount[i] = clamp(1 - amount[i], 0, 1); if (amount[i] > 0.001) any = true; }
        if (!any) return null;

        var packed = new Float32Array(nb * 4), src = new Float32Array(nb * 3);
        for (i = 0, c = 0; i < nb; i++, c += 4) {
            var r = smallRGBA[c], g = smallRGBA[c + 1], b = smallRGBA[c + 2];
            var lum = Math.max(r, g, b) / 255;
            var hl = 1 + (2 + 3 * t) * Math.pow(smoothstep(0.78, 1, lum), 2);                // bright highlights bloom
            var wgt = Math.pow(clamp((amount[i] - 0.02) / 0.98, 0, 1), 1.5) * hl;
            src[i * 3] = r; src[i * 3 + 1] = g; src[i * 3 + 2] = b;
            packed[c] = r * wgt; packed[c + 1] = g * wgt; packed[c + 2] = b * wgt; packed[c + 3] = wgt;
        }

        var levels = lvl <= 10 ? 4 : (lvl <= 20 ? 5 : 6);
        var scale = bw / W;                                                                // bokeh work-scale
        var bokeh = new Float32Array(nb * 3);
        for (var k = 1; k <= levels; k++) {
            var used = false, blend = new Float32Array(nb);
            for (i = 0; i < nb; i++) {
                var pos = clamp(amount[i] * levels, 1, levels);
                blend[i] = clamp(1 - Math.abs(pos - k), 0, 1);
                if (blend[i] > 0) used = true;
            }
            if (!used) continue;
            var blurred = discBlur(packed, bw, bh, maxRadius * scale * k / levels);
            for (i = 0, c = 0; i < nb; i++, c += 4) {
                if (blend[i] <= 0) continue;
                var den = blurred[c + 3];
                var o = i * 3;
                if (den > 1e-3) {
                    var inv = 1 / Math.max(den, 1e-4);
                    bokeh[o] += blurred[c] * inv * blend[i]; bokeh[o + 1] += blurred[c + 1] * inv * blend[i]; bokeh[o + 2] += blurred[c + 2] * inv * blend[i];
                } else {
                    bokeh[o] += src[o] * blend[i]; bokeh[o + 1] += src[o + 1] * blend[i]; bokeh[o + 2] += src[o + 2] * blend[i];
                }
            }
            blurred = null;
        }

        // Full-resolution mix: 0 = untouched source pixel, 1 = bokeh. The small maps are sampled bilinearly per pixel
        // so no full-size float buffers are ever allocated.
        var out = new Uint8ClampedArray(W * H * 4);
        var xs0 = new Int32Array(W), xs1 = new Int32Array(W), xw = new Float32Array(W), x, y;
        for (x = 0; x < W; x++) {
            var fx = clamp((x + 0.5) * bw / W - 0.5, 0, bw - 1), x0 = Math.floor(fx);
            xs0[x] = x0; xs1[x] = Math.min(bw - 1, x0 + 1); xw[x] = fx - x0;
        }
        for (y = 0; y < H; y++) {
            var fy = clamp((y + 0.5) * bh / H - 0.5, 0, bh - 1), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), wy = fy - y0, iy = 1 - wy;
            var rowA = y0 * bw, rowC = y1 * bw, p = y * W * 4;
            for (x = 0; x < W; x++, p += 4) {
                var a = rowA + xs0[x], bb = rowA + xs1[x], cc = rowC + xs0[x], dd = rowC + xs1[x], wx = xw[x], ix = 1 - wx;
                var am = (amount[a] * ix + amount[bb] * wx) * iy + (amount[cc] * ix + amount[dd] * wx) * wy;
                var mix = am * levels;
                if (mix <= 0.0005) { out[p] = rgba[p]; out[p + 1] = rgba[p + 1]; out[p + 2] = rgba[p + 2]; out[p + 3] = rgba[p + 3]; continue; }
                if (mix > 1) mix = 1;
                var a3 = a * 3, b3 = bb * 3, c3 = cc * 3, d3 = dd * 3;
                var r0 = rgba[p], g0 = rgba[p + 1], b0 = rgba[p + 2];
                var kr = (bokeh[a3] * ix + bokeh[b3] * wx) * iy + (bokeh[c3] * ix + bokeh[d3] * wx) * wy;
                var kg = (bokeh[a3 + 1] * ix + bokeh[b3 + 1] * wx) * iy + (bokeh[c3 + 1] * ix + bokeh[d3 + 1] * wx) * wy;
                var kb = (bokeh[a3 + 2] * ix + bokeh[b3 + 2] * wx) * iy + (bokeh[c3 + 2] * ix + bokeh[d3 + 2] * wx) * wy;
                out[p] = r0 + (kr - r0) * mix; out[p + 1] = g0 + (kg - g0) * mix; out[p + 2] = b0 + (kb - b0) * mix;   // Uint8ClampedArray rounds + clamps
                out[p + 3] = rgba[p + 3];
            }
        }
        return out;
    }

    return {
        toTensor: toTensor, normalizeDepth: normalizeDepth, resizeBilinear: resizeBilinear, resizeArea: resizeArea,
        boxFilter: boxFilter, gaussian: gaussian, guidedFilter: guidedFilter, focusRegion: focusRegion,
        computeMask: computeMask, composite: composite, strengthFor: strengthFor,
        MASK_WORK: MASK_WORK, BOKEH_WORK: BOKEH_WORK, MIN_LEVEL: MIN_LEVEL, MAX_LEVEL: MAX_LEVEL
    };
})();
