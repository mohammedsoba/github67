// ============================================================
// ai-mask.js
// AI Mask — selective editing for Sky, Person and Background.
// Reuses the MediaPipe Selfie Multiclass segmenter loaded by
// portrait-mode.js for the person mask, derives a sky mask from
// a color+position heuristic, and applies per-region adjustments
// (brightness / contrast / saturation / warmth) via canvas
// compositing. Also provides an "Auto AI Enhance" that picks
// smart per-region defaults from the analyzed image.
// ============================================================

(function () {
    var currentMask = null;          // 'sky' | 'person' | 'background'
    var maskCache = {                // cached per-base-image region masks
        srcKey: null,
        person: null,
        sky: null,
        background: null,
        width: 0,
        height: 0
    };
    var params = { bright: 0, contrast: 0, sat: 0, warmth: 0 };
    var busy = false;

    // ---------- helpers ----------
    function $(id) { return document.getElementById(id); }

    // V24/G10: built with createElement + textContent - `msg` may carry an error message (err.message / server text), so
    // it is never parsed as HTML.
    function setStatus(msg, loading) {
        var el = $('mask-status');
        if (!el) return;
        el.textContent = '';
        if (!msg) { el.style.display = 'none'; return; }
        el.style.display = 'flex';
        if (loading) {
            var spin = document.createElement('span');
            spin.className = 'spin';
            el.appendChild(spin);
        }
        var text = document.createElement('span');
        text.textContent = String(msg);
        el.appendChild(text);
    }

    // V23: loader wrappers, frame yield, current-image lookup and image loader are shared (ai-common.js).
    var C = window.YoAiCommon;
    var overlayStart = C.overlayStart, overlayStep = C.overlayStep, overlayEnd = C.overlayEnd;
    var nextFrame = C.nextFrame;

    function setActionsDisabled(disabled) {
        var nodes = document.querySelectorAll('#p-mask .mask-btn, #p-mask .mask-chip, #mask-auto-btn');
        for (var i = 0; i < nodes.length; i++) {
            if (disabled) nodes[i].setAttribute('disabled', 'true');
            else nodes[i].removeAttribute('disabled');
            nodes[i].style.pointerEvents = disabled ? 'none' : '';
            nodes[i].style.opacity = disabled ? '0.6' : '';
        }
    }

    // currentSrc() resolves to a URL (possibly a transient blob: URL - release it with releaseSrc()).
    var currentSrc = C.currentSrc, releaseSrc = C.releaseSrc, loadImage = C.loadImage;
    function loadImageFromCurrent() {
        return currentSrc().then(function (src) {
            return loadImage(src).then(function (img) { releaseSrc(src); return img; },
                                       function (e) { releaseSrc(src); throw e; });
        });
    }

    // Stable key for the mask cache: anchor to the original image so that
    // repeated Apply calls don't re-run segmentation every time the main
    // canvas src flips to a fresh blob URL.
    function baseSrcKey() {
        if (typeof originalImage !== 'undefined' && originalImage && originalImage.src) {
            return originalImage.src;
        }
        var m = $('mainImg');
        return m && m.src ? m.src : '';
    }

    function ensureSegmenter() {
        // R17/R18: shared, queued service; rejects with a plain-language message (offline / timeout / failed)
        return YoSegmenter.load();
    }

    // Build the person mask (white = person, transparent = else), feathered, AT SEGMENTER RESOLUTION
    // (<= 1024 px, 512 px on phones). V23/G4: it used to be scaled to the full photo size (up to 2560x1706 =
    // 17.5 MB, cached for as long as the photo is open); paintRegion() scales it up with drawImage when it
    // composites, so nothing is lost but memory.
    function computePersonMask(img) {
        var W = img.naturalWidth || img.width;
        var H = img.naturalHeight || img.height;
        var maxDim = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 512 : 1024;
        var s = Math.min(1, maxDim / Math.max(W, H));
        var sw = Math.max(1, Math.round(W * s));
        var sh = Math.max(1, Math.round(H * s));
        var sc = document.createElement('canvas');
        sc.width = sw; sc.height = sh;
        var sctx = sc.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(img, 0, 0, sw, sh);

        // Queued in YoSegmenter: this call gets ITS OWN mask, never another tool's.
        return YoSegmenter.segment(sc).then(function (maskCanvas) {
            C.releaseCanvas(sc);
            var out;
            try {
                var mw = maskCanvas.width, mh = maskCanvas.height;
                out = document.createElement('canvas');
                out.width = mw; out.height = mh;
                // Same feather-to-picture ratio as the old full-resolution blur (min side / 300).
                var feather = Math.max(1, Math.round(Math.min(mw, mh) / 300));
                YoCompat.drawBlurred(out.getContext('2d'), maskCanvas, mw, mh, feather);   // R5: no ctx.filter dependency
            } finally {
                C.releaseCanvas(maskCanvas);
            }
            return out;
        }, function (err) {
            C.releaseCanvas(sc);
            throw err;
        });
    }

    // Derive the sky mask from color/position, then subtract person.
    function computeSkyAndBackground(img, personCanvas) {
        var W = img.naturalWidth || img.width;
        var H = img.naturalHeight || img.height;

        // Downscale for pixel scoring, then upscale + feather.
        var maxDim = 512;
        var s = Math.min(1, maxDim / Math.max(W, H));
        var sw = Math.max(1, Math.round(W * s));
        var sh = Math.max(1, Math.round(H * s));

        var srcC = document.createElement('canvas');
        srcC.width = sw; srcC.height = sh;
        var sctx = srcC.getContext('2d');
        sctx.drawImage(img, 0, 0, sw, sh);
        var srcData = sctx.getImageData(0, 0, sw, sh).data;

        // Downscaled person mask for subtraction
        var persC = document.createElement('canvas');
        persC.width = sw; persC.height = sh;
        var pctx = persC.getContext('2d');
        pctx.drawImage(personCanvas, 0, 0, sw, sh);
        var persData = pctx.getImageData(0, 0, sw, sh).data;

        var skyImg = sctx.createImageData(sw, sh);
        var out = skyImg.data;

        for (var y = 0; y < sh; y++) {
            // Vertical bias: 1 at top, 0 below ~65% of image height
            var v = y / sh;
            var top = v < 0.55 ? 1 : Math.max(0, 1 - (v - 0.55) / 0.20);
            for (var x = 0; x < sw; x++) {
                var i = (y * sw + x) * 4;
                var r = srcData[i], g = srcData[i + 1], b = srcData[i + 2];
                var lum = (r + g + b) / 3;
                // Blue-dominant OR bright & desaturated (overcast sky)
                var blueScore = Math.max(0, (b - r + 8) / 60);
                var brightScore = Math.max(0, (lum - 130) / 120);
                var maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
                var sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
                var overcast = brightScore * Math.max(0, 1 - sat * 2.5);
                var score = Math.min(1, Math.max(blueScore, overcast * 0.85));
                score *= top;
                // Subtract person confidence (persData alpha 0..255)
                var pers = persData[i + 3] / 255;
                score *= (1 - pers);
                // Soft threshold for cleaner edges
                var v2 = score < 0.15 ? 0 : Math.min(1, (score - 0.15) / 0.55);
                var a = Math.round(v2 * 255);
                out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = a;
            }
        }
        sctx.putImageData(skyImg, 0, 0);

        // Sky mask stays at the (<= 512 px) scoring resolution, feathered there. V23/G4: it used to be scaled
        // to the full photo size; paintRegion() scales it up when it composites.
        var skyOut = document.createElement('canvas');
        skyOut.width = sw; skyOut.height = sh;
        var skctx = skyOut.getContext('2d');
        skctx.imageSmoothingEnabled = true;
        skctx.imageSmoothingQuality = 'high';
        var feather = Math.max(1, Math.round(Math.min(sw, sh) / 260));   // same ratio to the picture as before
        YoCompat.drawBlurred(skctx, srcC, sw, sh, feather);     // R5: no ctx.filter dependency

        // Background = 1 - person - sky (clamped), at the person mask's resolution so its edge is exactly as
        // sharp as the person mask's own edge.
        var bw = personCanvas.width || sw, bh = personCanvas.height || sh;
        var bgOut = document.createElement('canvas');
        bgOut.width = bw; bgOut.height = bh;
        var bgctx = bgOut.getContext('2d');
        bgctx.imageSmoothingEnabled = true;
        bgctx.imageSmoothingQuality = 'high';
        // Start opaque white
        bgctx.fillStyle = '#ffffff';
        bgctx.fillRect(0, 0, bw, bh);
        // Subtract person + sky with destination-out
        bgctx.globalCompositeOperation = 'destination-out';
        bgctx.drawImage(personCanvas, 0, 0, bw, bh);
        bgctx.drawImage(skyOut, 0, 0, bw, bh);
        bgctx.globalCompositeOperation = 'source-over';

        C.releaseCanvas(srcC);
        C.releaseCanvas(persC);
        return { sky: skyOut, background: bgOut };
    }

    // Free the cached region masks right now (backing stores -> 0x0) before they are replaced.
    function releaseMaskCache() {
        C.releaseCanvas(maskCache.person);
        C.releaseCanvas(maskCache.sky);
        C.releaseCanvas(maskCache.background);
        maskCache.srcKey = null;
        maskCache.person = maskCache.sky = maskCache.background = null;
        maskCache.width = 0; maskCache.height = 0;
    }

    function ensureMasks(onProgress) {
        var key = baseSrcKey();
        if (!key) return Promise.reject(new Error('no image'));
        if (maskCache.srcKey === key && maskCache.person && maskCache.sky && maskCache.background) {
            return Promise.resolve();
        }
        if (onProgress) onProgress('Loading model...');
        return ensureSegmenter()
            .then(function () {
                if (onProgress) onProgress('Reading image...');
                return loadImage(key);
            })
            .then(function (img) {
                if (onProgress) onProgress('Detecting person...');
                return computePersonMask(img).then(function (personMask) {
                    if (onProgress) onProgress('Analyzing sky & background...');
                    return nextFrame().then(function () {
                        var parts = computeSkyAndBackground(img, personMask);
                        releaseMaskCache();            // the masks of the previous photo / geometry
                        maskCache.srcKey = key;
                        maskCache.person = personMask;
                        maskCache.sky = parts.sky;
                        maskCache.background = parts.background;
                        maskCache.width = img.naturalWidth || img.width;
                        maskCache.height = img.naturalHeight || img.height;
                    });
                });
            });
    }

    // Build a CSS filter string from region params
    function buildRegionFilter(p) {
        var brightness = 1 + (p.bright || 0) / 100;
        var contrast = 1 + (p.contrast || 0) / 100;
        var saturate = 1 + (p.sat || 0) / 100;
        var hueShift = (p.warmth || 0) * 0.12; // subtle warm/cool hue nudge
        var sepia = (p.warmth || 0) > 0 ? Math.min(0.35, (p.warmth / 100) * 0.35) : 0;
        return 'brightness(' + brightness.toFixed(3) + ') ' +
               'contrast(' + contrast.toFixed(3) + ') ' +
               'saturate(' + saturate.toFixed(3) + ') ' +
               'hue-rotate(' + hueShift.toFixed(2) + 'deg) ' +
               (sepia > 0 ? 'sepia(' + sepia.toFixed(3) + ')' : '');
    }

    // Paint one region (adjusted copy masked to region) on top of baseCtx.
    function paintRegion(baseCtx, sourceImg, regionMask, p, W, H) {
        var layer = document.createElement('canvas');
        layer.width = W; layer.height = H;
        var lctx = layer.getContext('2d');
        YoCompat.drawWithFilter(lctx, sourceImg, W, H, buildRegionFilter(p));     // R5: colour matrices when ctx.filter is missing

        // The region mask lives at segmenter resolution: scale it up smoothly while masking (destination-in).
        lctx.globalCompositeOperation = 'destination-in';
        lctx.imageSmoothingEnabled = true;
        lctx.imageSmoothingQuality = 'high';
        lctx.drawImage(regionMask, 0, 0, W, H);
        lctx.globalCompositeOperation = 'source-over';

        baseCtx.drawImage(layer, 0, 0);
        layer.width = 0; layer.height = 0;
    }

    // Composite: baseImg + (adjusted copy masked to single region)
    function compositeRegion(regionMask, p) {
        return loadImageFromCurrent().then(function (img) {
            var W = img.naturalWidth || img.width;
            var H = img.naturalHeight || img.height;

            var out = document.createElement('canvas');
            out.width = W; out.height = H;
            var octx = out.getContext('2d');
            octx.drawImage(img, 0, 0, W, H);
            paintRegion(octx, img, regionMask, p, W, H);
            return out;
        });
    }

    // R11: the result becomes the real working image (registered blob URL, originalImage replaced,
    // preview refreshed, history saved) - so it survives the next slider move, Undo and Compare.
    function pushCanvasToMain(canvas) {
        var keepMasks = maskCache.srcKey === baseSrcKey();
        // The full-size result canvas is only needed until it has been encoded: free its backing store as soon
        // as the commit has settled (success or failure) instead of leaving ~17 MB to the garbage collector.
        return YoPipeline.commitCanvasAsOriginal(canvas).then(function () {
            C.releaseCanvas(canvas);
            // The committed image has the same geometry, so the cached person/sky/background masks still fit it
            if (keepMasks) maskCache.srcKey = baseSrcKey();
        }, function (err) {
            C.releaseCanvas(canvas);
            throw err;
        });
    }

    // ---------- UI handlers exposed to inline onclick ----------
    window.selectMaskRegion = function (region, el) {
        if (busy) return;
        currentMask = region;
        var chips = document.querySelectorAll('#p-mask .mask-chip');
        for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
        if (el) el.classList.add('active');
        var controls = $('mask-controls');
        if (controls) controls.classList.add('visible');
        // Reset sliders for a fresh per-region tweak
        params = { bright: 0, contrast: 0, sat: 0, warmth: 0 };
        ['bright', 'contrast', 'sat', 'warmth'].forEach(function (k) {
            var s = $('mask-' + k); var v = $('mask-v-' + k);
            if (s) s.value = 0; if (v) v.innerText = '0';
        });
        // Warm up masks so Apply is instant later
        if (typeof originalImage !== 'undefined' && originalImage) {
            // If masks are already cached for this image, no overlay needed.
            var cached = maskCache.srcKey === baseSrcKey() &&
                maskCache.person && maskCache.sky && maskCache.background;
            if (cached) {
                setStatus(window.t('maskReady'), false);
                return;
            }
            busy = true;
            setActionsDisabled(true);
            overlayStart(window.t('toastAnalyzing'), window.t('maskPreparing'));
            setStatus(window.t('toastAnalyzing'), true);
            ensureMasks(overlayStep).then(function () {
                setStatus(window.t('maskReady'), false);
            }).catch(function (err) {
                // SegmenterError carries a plain-language reason (offline / timeout / failed)
                var why = (err && err.name === 'SegmenterError') ? err.message : window.t('maskAnalyzeFailed');
                setStatus(window.t('maskAnalyzeFailed'), false);
                if (typeof showToast === 'function') showToast(why, 'error');
            }).then(function () {
                overlayEnd();
                setActionsDisabled(false);
                busy = false;
            });
        }
    };

    window.onMaskSliderChange = function (key) {
        var s = $('mask-' + key); if (!s) return;
        params[key] = parseInt(s.value, 10) || 0;
        var v = $('mask-v-' + key); if (v) v.innerText = params[key];
    };

    window.adjustMaskSlider = function (key, delta) {
        var s = $('mask-' + key); if (!s) return;
        var next = (parseInt(s.value, 10) || 0) + delta * 5;
        next = Math.max(-100, Math.min(100, next));
        s.value = next;
        window.onMaskSliderChange(key);
    };

    window.applyMaskEdit = function () {
        if (busy) return;
        if (typeof originalImage === 'undefined' || !originalImage) {
            if (typeof showToast === 'function') showToast(window.t('toastLoadImage'), 'error');
            return;
        }
        if (!currentMask) {
            if (typeof showToast === 'function') showToast(window.t('maskPickRegion'), 'warning');
            return;
        }
        var hasChange = params.bright || params.contrast || params.sat || params.warmth;
        if (!hasChange) {
            if (typeof showToast === 'function') showToast(window.t('maskAdjustFirst'), 'warning');
            return;
        }
        busy = true;
        setActionsDisabled(true);
        overlayStart(window.t('maskApplyingTitle'), window.t('maskRegionSub', { region: window.t(currentMask) }));
        setStatus(window.t('maskApplyingTo', { region: window.t(currentMask) }), true);
        ensureMasks(overlayStep).then(function () {
            overlayStep(window.t('maskBlending'));
            return nextFrame();
        }).then(function () {
            var mask = maskCache[currentMask];
            return compositeRegion(mask, params);
        }).then(function (canvas) {
            overlayStep(window.t('maskFinalizing'));
            return pushCanvasToMain(canvas);
        }).then(function () {
            // history entry is saved by commitCanvasAsOriginal()
            setStatus(window.t('maskStack'), false);
        }).catch(function (err) {
            console.error(err);
            if (typeof showToast === 'function') showToast((err && err.name === 'SegmenterError') ? err.message : window.t('maskFailed'), 'error');
            setStatus('', false);
        }).then(function () {
            overlayEnd();
            setActionsDisabled(false);
            busy = false;
        });
    };

    window.resetMaskEdit = function () {
        if (busy) return;
        currentMask = null;
        params = { bright: 0, contrast: 0, sat: 0, warmth: 0 };
        var chips = document.querySelectorAll('#p-mask .mask-chip');
        for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
        ['bright', 'contrast', 'sat', 'warmth'].forEach(function (k) {
            var s = $('mask-' + k); var v = $('mask-v-' + k);
            if (s) s.value = 0; if (v) v.innerText = '0';
        });
        var controls = $('mask-controls');
        if (controls) controls.classList.remove('visible');
        setStatus('', false);
        // Keep the mask cache — reset only clears user tweaks, not analysis.
    };

    // Smart per-region auto enhance — computes masks once and bakes all
    // three regions in a single composite for a smoother, faster result.
    window.applyMaskAutoAI = function () {
        if (busy) return;
        if (typeof originalImage === 'undefined' || !originalImage) {
            if (typeof showToast === 'function') showToast(window.t('toastLoadImage'), 'error');
            return;
        }
        busy = true;
        setActionsDisabled(true);
        var btn = $('mask-auto-btn'); if (btn) btn.setAttribute('disabled', 'true');
        overlayStart(window.t('maskAutoTitle'), window.t('maskAutoSub'));
        setStatus(window.t('maskAutoStatus'), true);
        ensureMasks(overlayStep).then(function () {
            overlayStep(window.t('maskAnalyzingTones'));
            return loadImageFromCurrent();
        }).then(function (img) {
            var W = img.naturalWidth || img.width;
            var H = img.naturalHeight || img.height;
            var an = document.createElement('canvas');
            an.width = 128; an.height = Math.max(1, Math.round(128 * H / W));
            var ax = an.getContext('2d');
            ax.drawImage(img, 0, 0, an.width, an.height);
            var d = ax.getImageData(0, 0, an.width, an.height).data;
            var lum = 0, count = d.length / 4;
            for (var i = 0; i < d.length; i += 4) lum += (d[i] + d[i + 1] + d[i + 2]) / 3;
            lum /= count;

            var skyP    = { bright: 6,  contrast: 14, sat: 22, warmth: -8 };
            var personP = { bright: lum < 110 ? 10 : 4, contrast: 8, sat: 6, warmth: 10 };
            var bgP     = { bright: -3, contrast: 10, sat: -6, warmth: 4 };

            overlayStep(window.t('maskBlendingAll'));
            return nextFrame().then(function () {
                var out = document.createElement('canvas');
                out.width = W; out.height = H;
                var octx = out.getContext('2d');
                octx.drawImage(img, 0, 0, W, H);

                paintRegion(octx, img, maskCache.sky,        skyP,    W, H);
                paintRegion(octx, img, maskCache.background, bgP,     W, H);
                paintRegion(octx, img, maskCache.person,     personP, W, H);

                overlayStep(window.t('maskFinalizing'));
                return pushCanvasToMain(out);
            });
        }).then(function () {
            setStatus(window.t('maskEnhancedHint'), false);
        }).catch(function (err) {
            console.error(err);
            if (typeof showToast === 'function') showToast((err && err.name === 'SegmenterError') ? err.message : window.t('maskAutoFailed'), 'error');
            setStatus('', false);
        }).then(function () {
            overlayEnd();
            setActionsDisabled(false);
            if (btn) btn.removeAttribute('disabled');
            busy = false;
        });
    };
})();
