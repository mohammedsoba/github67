// ============================================================
// modals-export.js
// ============================================================
// ==================== EXPORT WITH QUALITY OPTIONS ====================
(function (g) {
// V27 module "modals-export": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('modals-export', {
  closeExportModal: [() => closeExportModal, (v) => { closeExportModal = v; }],
  closePremiumModal: [() => closePremiumModal, (v) => { closePremiumModal = v; }],
  doExport: [() => doExport, (v) => { doExport = v; }],
  openExportModal: [() => openExportModal, (v) => { openExportModal = v; }],
  saveCanvasToDeviceStorage: [() => saveCanvasToDeviceStorage, (v) => { saveCanvasToDeviceStorage = v; }],
});
function openExportModal() {
    if (!originalImage) {
        showToast(window.t('toastNoImageExport'), 'error');
        return;
    }
    const modal = document.getElementById('exportModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    // Y17: dialog focus - first action button gets focus, the opener gets it back on close
    if (window.YoA11y) window.YoA11y.openDialog(modal, modal.querySelector('.quality-btn'));
}

function closeExportModal(event) {
    if (event && event.target !== event.currentTarget && !event.target.classList.contains('modal-close') && !event.target.classList.contains('modal-btn') && !event.target.classList.contains('quality-btn')) return;
    const modal = document.getElementById('exportModal');
    const wasOpen = modal.classList.contains('active');
    modal.classList.remove('active');
    document.body.style.overflow = '';
    if (wasOpen && window.YoA11y) window.YoA11y.closeDialog(modal);
}

function isCordovaEnv() {
    return !!(window.cordova && window.resolveLocalFileSystemURL);
}

// R20: save an export on a packaged (Cordova) build.
//   1) Preferred: cordova-plugin-photo-library -> the picture is added to the gallery through MediaStore
//      (Android 10+) / PhotoKit (iOS). No broad storage permission, shows up in the Photos/Gallery app.
//      The canvas is encoded straight to a Blob and written to the app CACHE folder (no base64 string
//      on the heap), handed to the plugin, and the temp file is deleted afterwards.
//   2) Fallback (plugin missing, old Android only): write the Blob to Pictures/YoFilter on shared storage.
function saveCanvasToDeviceStorage(canvasElement, fileExt, mimeType, quality, onSuccess, onError) {
    var filename = 'YoFilter_' + Date.now() + '.' + (fileExt || 'png');
    var mime = mimeType || 'image/png';
    var fail = function(msg) { try { onError(msg); } catch (e) {} };

    function writeBlob(dirEntry, name, blob, done) {
        dirEntry.getFile(name, { create: true, exclusive: false }, function(fileEntry) {
            fileEntry.createWriter(function(writer) {
                writer.onwriteend = function() { done(null, fileEntry); };
                writer.onerror = function(e) { done('Write failed: ' + (e && e.toString ? e.toString() : e)); };
                writer.write(blob);
            }, function(e) { done('Create writer failed: ' + JSON.stringify(e)); });
        }, function(e) { done('Get file failed: ' + JSON.stringify(e)); });
    }

    function viaPhotoLibrary(blob) {
        var lib = window.cordova.plugins.photoLibrary;
        var cacheRoot = window.cordova.file && window.cordova.file.cacheDirectory;
        if (!cacheRoot) { fail('No cache directory available'); return; }
        window.resolveLocalFileSystemURL(cacheRoot, function(cacheDir) {
            writeBlob(cacheDir, filename, blob, function(err, fileEntry) {
                if (err) { fail(err); return; }
                var cleanup = function() { try { fileEntry.remove(function() {}, function() {}); } catch (e) {} };
                lib.requestAuthorization({ read: false, write: true }, function() {
                    lib.saveImage(fileEntry.toURL(), 'YoFilter', function() {
                        cleanup();
                        onSuccess(fileEntry.toURL(), filename);
                    }, function(e) { cleanup(); fail('Gallery save failed: ' + (e && e.message ? e.message : e)); });
                }, function(e) { cleanup(); fail('Permission to save photos was denied'); });
            });
        }, function(e) { fail('Resolve cache folder failed: ' + JSON.stringify(e)); });
    }

    function viaLegacyStorage(blob) {
        var targetRoot = (window.cordova && cordova.file && (cordova.file.externalRootDirectory || cordova.file.documentsDirectory)) || '';
        if (!targetRoot) { fail('No writable directory available'); return; }
        window.resolveLocalFileSystemURL(targetRoot, function(root) {
            var finish = function(dir) {
                writeBlob(dir, filename, blob, function(err, fileEntry) {
                    if (err) fail(err); else onSuccess(fileEntry.toURL(), filename);
                });
            };
            root.getDirectory('Pictures', { create: true, exclusive: false }, function(pic) {
                pic.getDirectory('YoFilter', { create: true, exclusive: false }, finish, function() { finish(pic); });
            }, function() { finish(root); });
        }, function(e) { fail('Resolve URL failed: ' + JSON.stringify(e)); });
    }

    try {
        canvasElement.toBlob(function(blob) {
            if (!blob) { fail('Could not encode the image'); return; }
            var hasLib = !!(window.cordova && window.cordova.plugins && window.cordova.plugins.photoLibrary);
            if (hasLib) viaPhotoLibrary(blob); else viaLegacyStorage(blob);
        }, mime, quality);
    } catch (e) {
        fail('Exception: ' + (e && e.message ? e.message : e));
    }
}

// Shrink a canvas to 1x1 so its (potentially 26 MB) backing store is released right away.
function _releaseExportCanvas(c) {
    try { if (c) { c.width = 1; c.height = 1; } } catch (e) {}
}

var _exportBusy = false;

function doExport(qualityLevel) {
    closeExportModal();
    if (!originalImage) return;
    if (_exportBusy) { showToast(window.t('toastExportBusy'), 'warning'); return; }

    let mimeType, quality, fileExt, loadingText, subText;

    switch(qualityLevel) {
        case 'low':
            mimeType = 'image/jpeg';
            quality = 0.6;
            fileExt = 'jpg';
            loadingText = window.t('exportingLow');
            subText = window.t('exportingLowSub');
            break;
        case 'normal':
            mimeType = 'image/jpeg';
            quality = 0.92;
            fileExt = 'jpg';
            loadingText = window.t('exportingNormal');
            subText = window.t('exportingNormalSub');
            break;
        case 'ultra':
            mimeType = 'image/png';
            quality = 1.0;
            fileExt = 'png';
            loadingText = window.t('exportingUltra');
            subText = window.t('exportingUltraSub');
            break;
        default:
            mimeType = 'image/jpeg';
            quality = 0.92;
            fileExt = 'jpg';
            loadingText = window.t('exportingNormal');
            subText = window.t('exportingNormalSub');
    }

    _exportBusy = true;
    showLoading(loadingText);
    updateLoadingSub(subText);

    // Allow UI to render loading before heavy canvas work
    setTimeout(async function() {
        const canvas = document.getElementById('hiddenCanvas');
        let finalCanvas = null;
        let handedToNativeSave = false;     // Cordova callbacks finish the job (and the cleanup) themselves
        const cleanup = function() {
            _releaseExportCanvas(canvas);
            if (finalCanvas && finalCanvas !== canvas) _releaseExportCanvas(finalCanvas);
        };

        try {
            const w = originalImage.naturalWidth || originalImage.width;
            const h = originalImage.naturalHeight || originalImage.height;

            // Same engine as the preview (WebGL shader, CPU fallback with identical maths/order):
            // sliders, curves (all channels), Color Mix, filter chain / preset, alpha preserved.
            YoPipeline.renderEditedCanvas(originalImage, w, h, canvas);
            const ctx = canvas.getContext('2d');

            overlayManager.drawToCanvas(ctx, w, h);
            drawWatermark(ctx, w, h);

            // Flatten the active frame (border, radius, shadow/glow, background) onto the canvas
            finalCanvas = drawFrameToExportCanvas(canvas, { mimeType: mimeType });

            // JPEG has no alpha: flatten transparent cut-outs onto white instead of the encoder's black
            if (mimeType === 'image/jpeg' && finalCanvas === canvas && YoPipeline.imageHasAlpha(originalImage)) {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.restore();
            }

            if (isCordovaEnv()) {
                handedToNativeSave = true;
                saveCanvasToDeviceStorage(
                    finalCanvas,
                    fileExt,
                    mimeType,
                    quality,
                    function(fileUrl, filename) {
                        cleanup(); _exportBusy = false;
                        hideLoading();
                        // G13: non-blocking, translated toast (the native alert() used to freeze the WebView)
                        showToast(window.t('toastSavedName', { name: filename }), 'success');   // a saved file has no visible effect: this one confirmation stays
                    },
                    function(err) {
                        cleanup(); _exportBusy = false;
                        hideLoading();
                        console.error('[export] native save failed', err);   // the technical reason stays in the log, never in the UI
                        showToast(window.t('toastSaveFailed'), 'error');
                    }
                );
                return;
            }

            // Encode straight to a Blob (binary only, no text-encoded copy on the heap), then share (mobile) / download (desktop).
            const blob = await canvasToBlob(finalCanvas, mimeType, quality);
            cleanup();                 // the blob is independent of the canvases: release peak memory now
            hideLoading();             // encoding is done; do not keep the overlay up behind the native share sheet

            const filename = 'yofilter-edited-' + qualityLevel + '-' + Date.now() + '.' + fileExt;
            const result = await saveBlob(blob, filename);
            if (result === 'cancelled') return;

            const label = qualityLevel === 'ultra' ? window.t('exportLabelPng') : window.t('exportLabelJpeg', { q: Math.round(quality * 100) });
            showToast(window.t(result === 'shared' ? 'toastExportShared' : 'toastExportSaved', { label: label, size: blobSizeMB(blob) }), 'success');
        } catch (err) {
            console.error('[export] failed', err);
            showToast(window.t('toastExportFailed'), 'error');
        } finally {
            // Guaranteed: the loading overlay never stays up and the big canvases are always released.
            if (!handedToNativeSave) {
                cleanup();
                hideLoading();
                _exportBusy = false;
            }
        }
    }, 100);
}

// ==================== MODALS & NAV ====================
function closePremiumModal(event) {
    if (event && event.target !== event.currentTarget && !event.target.classList.contains('modal-close') && !event.target.classList.contains('modal-btn')) return;
    const modal = document.getElementById('premiumModal');
    const wasOpen = modal.classList.contains('active');
    modal.classList.remove('active');
    document.body.style.overflow = '';
    if (wasOpen && window.YoA11y) window.YoA11y.closeDialog(modal);
}

// ── Frame flattening helpers ──────────────────────────────────

// Convert a CSS linear-gradient string into a CanvasGradient.
// Handles the common "linear-gradient(Ndeg, #color, #color, ...)" pattern.
function _canvasGradientFromCSS(ctx, gradStr, w, h) {
    var m = gradStr.match(/linear-gradient\(\s*(\d+)deg\s*,([^)]+)\)/);
    if (!m) {
        // Fallback: extract the first recognisable colour
        var fb = (gradStr.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/) || [])[0] || '#000000';
        return fb;
    }
    var angleDeg = parseFloat(m[1]);
    var angleRad = angleDeg * Math.PI / 180;

    // CSS gradient angle: 0° points up, clockwise
    var endX   = (w / 2) * (1 + Math.sin(angleRad));
    var endY   = (h / 2) * (1 - Math.cos(angleRad));
    var startX = w - endX;
    var startY = h - endY;

    var stops = m[2].split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var grad  = ctx.createLinearGradient(startX, startY, endX, endY);
    stops.forEach(function(color, i) {
        grad.addColorStop(i / Math.max(1, stops.length - 1), color);
    });
    return grad;
}

// CSS px -> export px. The on-screen frame is laid out around the DISPLAYED image, so the ratio of the
// export width to the displayed image width keeps padding, border, radius and glow proportional to
// what the user saw (replaces the old fixed "min side / 375" guess).
function _frameExportScale(imgW, imgH) {
    var mi = document.getElementById('mainImg');
    var shown = mi ? mi.getBoundingClientRect().width : 0;
    if (shown > 10) return imgW / shown;
    return Math.min(imgW, imgH) / 375;
}

// Split "a, b(c, d), e" on top-level commas only.
function _splitTopLevelCommas(str) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

// "0 0 12px rgba(1,2,3,0.5), inset 0 0 18px #fff" -> [{inset, x, y, blur, color}]
function _parseBoxShadows(str) {
    var res = [];
    if (!str) return res;
    var re = /^(inset\s+)?(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(.+)$/i;
    var parts = _splitTopLevelCommas(str);
    for (var i = 0; i < parts.length; i++) {
        var m = re.exec(parts[i]);
        if (!m) continue;
        res.push({ inset: !!m[1], x: parseFloat(m[2]), y: parseFloat(m[3]), blur: parseFloat(m[4]),
                   spread: m[5] ? parseFloat(m[5]) : 0, color: m[6].trim() });
    }
    return res;
}

// Rounded-rect sub-path (no roundRect(): older WebViews lack it). Caller does beginPath().
function _rrectSubpath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

// Colour behind the picture in the app: used to fill JPEG exports (JPEG cannot be transparent).
function _exportBackdropColor() {
    var c = '';
    try {
        var vp = document.getElementById('viewport');
        if (vp) c = getComputedStyle(vp).backgroundColor || '';
    } catch (e) {}
    if (!c || c === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c)) c = '#0b0b12';
    return c;
}

// Flatten the currently active frame onto a new canvas and return it.
// If no frame is active the original canvas is returned unchanged.
//   opts.mimeType: 'image/jpeg' -> every transparent pixel (corners, shadow margin) gets an explicit
//                  background; 'image/png' keeps transparency.
function drawFrameToExportCanvas(srcCanvas, opts) {
    opts = opts || {};
    var isJpeg = opts.mimeType === 'image/jpeg';
    if (typeof activeFrameId === 'undefined' || !activeFrameId || activeFrameId === 'none') {
        return srcCanvas;
    }
    var frame = (typeof _findFrame === 'function') ? _findFrame(activeFrameId) : null;
    if (!frame || frame.id === 'none') return srcCanvas;

    var css = (typeof _buildFrameCSS === 'function')
        ? _buildFrameCSS(frame, typeof frameControls !== 'undefined' ? frameControls : {
            thickness: 20, radius: 0, shadow: 0, padding: 0,
            useCustomColor: false, customColor: '#ffffff'
          })
        : null;
    if (!css) return srcCanvas;

    var imgW = srcCanvas.width;
    var imgH = srcCanvas.height;
    var scale = _frameExportScale(imgW, imgH);

    // Padding string "T R B L" (CSS px) -> export px
    var padArr = css.padding.replace(/px/g, '').trim().split(/\s+/).map(Number);
    var padT = padArr[0] || 0;
    var padR = padArr[1] !== undefined ? padArr[1] : padT;
    var padB = padArr[2] !== undefined ? padArr[2] : padT;
    var padL = padArr[3] !== undefined ? padArr[3] : padR;
    padT = Math.round(padT * scale); padR = Math.round(padR * scale);
    padB = Math.round(padB * scale); padL = Math.round(padL * scale);

    // CSS border is added OUTSIDE the padding (box-sizing: border-box only fixes the outer size)
    var bw = 0, borderColor = '';
    if (css.border) {
        var bm = css.border.match(/^(\d+(?:\.\d+)?)px\s+\S+\s+(.+)$/);
        if (bm) { bw = Math.max(1, Math.round(parseFloat(bm[1]) * scale)); borderColor = bm[2].trim(); }
    }

    var boxW = imgW + padL + padR + 2 * bw;
    var boxH = imgH + padT + padB + 2 * bw;
    var radius = Math.round((parseFloat(css.borderRadius) || 0) * scale);

    // Outer glow / drop shadow needs room around the frame box
    var shadows = _parseBoxShadows(css.boxShadow);
    var margin = 0;
    for (var si = 0; si < shadows.length; si++) {
        var sh = shadows[si];
        if (sh.inset) continue;
        margin = Math.max(margin, (sh.blur + Math.max(Math.abs(sh.x), Math.abs(sh.y)) + Math.max(0, sh.spread)) * scale);
    }
    margin = Math.min(Math.ceil(margin), Math.round(0.25 * Math.max(imgW, imgH)));

    var W = boxW + 2 * margin;
    var H = boxH + 2 * margin;
    var bx = margin, by = margin;

    var frCanvas = document.createElement('canvas');
    frCanvas.width  = W;
    frCanvas.height = H;
    var ctx = frCanvas.getContext('2d');

    // JPEG: explicit backdrop under everything (corners, shadow margin); PNG stays transparent
    if (isJpeg) {
        ctx.fillStyle = _exportBackdropColor();
        ctx.fillRect(0, 0, W, H);
    }

    // ── Outer shadows / neon glow (drawn on a scratch canvas, then the box itself is punched out,
    //    exactly like CSS which never paints a shadow underneath its own box)
    var outer = shadows.filter(function(s) { return !s.inset; });
    if (outer.length) {
        var tmp = document.createElement('canvas');
        tmp.width = W; tmp.height = H;
        var tc = tmp.getContext('2d');
        outer.forEach(function(s) {
            tc.save();
            tc.shadowColor   = s.color;
            tc.shadowBlur    = s.blur * scale;
            tc.shadowOffsetX = s.x * scale;
            tc.shadowOffsetY = s.y * scale;
            tc.fillStyle = '#000';
            tc.beginPath(); _rrectSubpath(tc, bx, by, boxW, boxH, radius); tc.fill();
            tc.restore();
        });
        tc.save();
        tc.globalCompositeOperation = 'destination-out';
        tc.beginPath(); _rrectSubpath(tc, bx, by, boxW, boxH, radius); tc.fill();
        tc.restore();
        ctx.drawImage(tmp, 0, 0);
        tmp.width = 0; tmp.height = 0;
    }

    // ── Everything inside the box is clipped to the (rounded) frame outline
    ctx.save();
    ctx.beginPath(); _rrectSubpath(ctx, bx, by, boxW, boxH, radius); ctx.clip();

    // Background fill
    var bg = css.background;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = (bg.indexOf('gradient') !== -1)
            ? _canvasGradientFromCSS(ctx, bg, boxW, boxH)
            : bg;
        if (bg.indexOf('gradient') !== -1) {
            ctx.save(); ctx.translate(bx, by); ctx.fillRect(0, 0, boxW, boxH); ctx.restore();
        } else {
            ctx.fillRect(bx, by, boxW, boxH);
        }
    }

    // Inset shadows (CSS paints them above the background, below the picture)
    shadows.filter(function(s) { return s.inset; }).forEach(function(s) {
        ctx.save();
        ctx.shadowColor   = s.color;
        ctx.shadowBlur    = s.blur * scale;
        ctx.shadowOffsetX = s.x * scale;
        ctx.shadowOffsetY = s.y * scale;
        ctx.fillStyle = '#000';
        var big = Math.max(boxW, boxH) + 400;
        ctx.beginPath();
        ctx.rect(bx - big, by - big, boxW + 2 * big, boxH + 2 * big);
        _rrectSubpath(ctx, bx, by, boxW, boxH, radius);
        ctx.fill('evenodd');
        ctx.restore();
    });

    // Border
    if (bw > 0) {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth   = bw;
        ctx.beginPath();
        _rrectSubpath(ctx, bx + bw / 2, by + bw / 2, boxW - bw, boxH - bw, Math.max(0, radius - bw / 2));
        ctx.stroke();
    }

    // Processed picture - Y13: clipped to the frame's inner radius, exactly like the on-screen photo
    var imgRadius = Math.round((css.imageRadius || 0) * scale);
    if (imgRadius > 0) {
        ctx.save();
        ctx.beginPath(); _rrectSubpath(ctx, bx + bw + padL, by + bw + padT, imgW, imgH, imgRadius); ctx.clip();
        ctx.drawImage(srcCanvas, bx + bw + padL, by + bw + padT, imgW, imgH);
        ctx.restore();
    } else {
        ctx.drawImage(srcCanvas, bx + bw + padL, by + bw + padT, imgW, imgH);
    }
    ctx.restore();

    return frCanvas;
}
})(globalThis);
