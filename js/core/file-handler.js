// ============================================================
// file-handler.js
// ============================================================
(function (g) {
// V27 module "file-handler": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('file-handler', {
  _bindMainImgLoadOnce: [() => _bindMainImgLoadOnce, (v) => { _bindMainImgLoadOnce = v; }],
  fitImageToWorkspace: [() => fitImageToWorkspace, (v) => { fitImageToWorkspace = v; }],
  handleFileSelect: [() => handleFileSelect, (v) => { handleFileSelect = v; }],
});
function fitImageToWorkspace() {
    const mainImg = document.getElementById('mainImg');
    const container = document.getElementById('imgContainer');
    if (!mainImg || !container || !mainImg.classList.contains('active')) return;
    if (mainImg.style.objectFit === 'cover' && mainImg.style.aspectRatio && mainImg.style.aspectRatio !== 'auto') return;
    mainImg.style.maxWidth = '100%';
    mainImg.style.maxHeight = '100%';
    mainImg.style.width = 'auto';
    mainImg.style.height = 'auto';
    mainImg.style.objectFit = 'contain';
    mainImg.style.objectPosition = 'center center';
    if (typeof _holdOriginalActive !== 'undefined' && _holdOriginalActive) positionCompareElements();   // keep the held "Original" glued to the photo
    if (overlayManager && overlayManager.canvas) overlayManager.resizeCanvas();
}

// V24/G7: the post-load fit used to be `mainImg.onload = ...` (one clobberable slot; the old handleFileSelect override in
// gestures.js lived next to it). It is now a normal listener, registered ONCE (the first upload) so it keeps the same
// position among the other 'load' listeners as the old property handler had. It runs for every #mainImg source change,
// exactly like before.
function _fitAfterMainImgLoad() {
    fitImageToWorkspace();
    requestAnimationFrame(function() {
        fitImageToWorkspace();
    });
}
let _mainImgLoadBound = false;
function _bindMainImgLoadOnce(mainImg) {
    if (_mainImgLoadBound || !mainImg || typeof mainImg.addEventListener !== 'function') return;
    _mainImgLoadBound = true;
    mainImg.addEventListener('load', _fitAfterMainImgLoad);
}

// ==================== FILE HANDLING ====================
// Fast mobile-friendly loader: decodes off main thread when possible and
// downscales huge camera photos before we ever hold them as an <img>.
// Uploads that used to take 10-20s on phones now finish in ~1s.
function handleFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    // Reset the input so choosing the same file twice still fires change
    try { event.target.value = ''; } catch(e) {}
    showLoading(window.t('loadingImage'));

    const MAX_EDIT_DIM = 2560; // hard cap for editing canvas (memory-safe on mobile)
    const PREVIEW_DIM = 1200;

    const finish = function(displayImg) {
        // The spinner MUST be dismissed whatever happens below: any exception in the load sequence (a reset helper, history,
        // the first render ...) used to abort this function before hideLoading(), leaving the overlay up until the next edit.
        try {
            originalImage = displayImg;

            // Freeze the upload-time original for Compare — never overwritten by
            // crop, canvas effects, or any other editing operation.
            originalForCompare = displayImg;

            // New photo -> new grain pattern. This is the ONLY place the session grain seed changes, so grain
            // never flickers while editing and preview == export for the whole session.
            if (typeof YoPipeline !== 'undefined' && YoPipeline.rerollGrainSeed) YoPipeline.rerollGrainSeed();

            // New photo: the "Original" preview starts from the whole new upload (no crop of the previous photo),
            // and the Magic Eraser starts with an empty mask even when the new photo has the same pixel size.
            if (typeof holdOriginalEnd === 'function') holdOriginalEnd();
            if (typeof resetCompareCrop === 'function') resetCompareCrop();
            if (window.MagicEraser && typeof window.MagicEraser.discardStrokes === 'function') window.MagicEraser.discardStrokes();

            let pw = displayImg.naturalWidth;
            let ph = displayImg.naturalHeight;
            if (pw > PREVIEW_DIM || ph > PREVIEW_DIM) {
                const r = Math.min(PREVIEW_DIM / pw, PREVIEW_DIM / ph);
                pw = Math.round(pw * r); ph = Math.round(ph * r);
            }
            previewCanvas.width = pw;
            previewCanvas.height = ph;
            previewCtx.drawImage(displayImg, 0, 0, pw, ph);
            const mainImg = document.getElementById('mainImg');
            mainImg.src = displayImg.src;
            mainImg.className = 'main-img active';
            document.getElementById('uploadBox').style.display = 'none';
            document.getElementById('exportBtn').style.display = 'flex';
            document.getElementById('compareBtn').classList.add('active');
            document.body.classList.add('photo-loaded');     // Y14: drives the floating Undo / Original controls (replaces :has())
            // Fully release any previous portrait state (was the main "Aw, Snap!" cause)
            try {
                if (typeof resetPortraitState === 'function') resetPortraitState();
                const psec = document.getElementById('portrait-init-section');
                const rsec = document.getElementById('portrait-result-section');
                const lsec = document.getElementById('portrait-loading-section');
                if (psec) psec.style.display = 'block';
                if (rsec) rsec.style.display = 'none';
                if (lsec) lsec.style.display = 'none';
            } catch(e) {}
            resetAllValues();
            resetHistory();          // R8: a new photo starts a brand-new history (old URLs released)
            saveToHistory();
            renderPresets();
            _bindMainImgLoadOnce(mainImg);
            if (mainImg.complete) {
                _fitAfterMainImgLoad();
            }
            // The Compare button used to be revealed by a wrapper around handleFileSelect (gestures.js); it is part of
            // "a photo is loaded" now.
            const compareBtn = document.getElementById('compareBtn');
            if (compareBtn) compareBtn.style.display = 'block';

            // Initial default render pass: sizes the overlay canvas and puts the photo through the normal pipeline now,
            // instead of waiting for the first slider / filter click.
            if (typeof applyAllEdits === 'function') applyAllEdits();
        } catch (err) {
            console.error('[upload] could not finish loading the photo:', err);
            showToast(window.t('toastImageLoadFailed'), 'error');
        } finally {
            hideLoading();
        }
    };

    const loadFailed = function() { hideLoading(); showToast(window.t('toastImageLoadFailed'), 'error'); };

    const bitmapToImg = function(bitmap) {
      try {
        let w = bitmap.width, h = bitmap.height;
        const needsScale = w > MAX_EDIT_DIM || h > MAX_EDIT_DIM;
        const cv = document.createElement('canvas');
        if (needsScale) {
            const s = Math.min(MAX_EDIT_DIM / w, MAX_EDIT_DIM / h);
            w = Math.round(w * s); h = Math.round(h * s);
        }
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(bitmap, 0, 0, w, h);
        try { bitmap.close && bitmap.close(); } catch(e) {}
        // R13: transparency (PNG/WebP/GIF/AVIF cut-outs) is detected for the alpha cache; JPEG sources never have alpha.
        const hasAlpha = (file.type && file.type !== 'image/jpeg') ? YoPipeline.canvasHasAlpha(cv) : false;
        // V24/G9: the working copy of the upload is LOSSLESS (PNG), whether or not the photo has transparency. It used to
        // be re-encoded as JPEG 0.92 here, i.e. one lossy generation before the first edit. (The original file bytes are
        // deliberately not passed through: the decode + orientation fix + downscale above is the one path that behaves the
        // same in every WebView.) The user's one lossy encode happens at export.
        canvasToBlobUrl(cv, 'image/png').then(function(res) {
            const img = new Image();
            img.onload = function() { try { img.__yfAlpha = hasAlpha; } catch(e) {} finish(img); };
            img.onerror = loadFailed;
            img.src = res.url;
            cv.width = 0; cv.height = 0;                    // release the 12 MP backing store once it is encoded
        }, function() {
            cv.width = 0; cv.height = 0;
            if (usedFallbackReader) loadFailed();   // no endless retry
            else fallbackReader();
        });
      } catch (err) {
        console.error('[upload] decode failed:', err);
        if (usedFallbackReader) loadFailed(); else fallbackReader();      // one retry through FileReader, then a clear error - never a stuck spinner
      }
    };

    let usedFallbackReader = false;
    const fallbackReader = function() {
        usedFallbackReader = true;
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() { bitmapToImg(img); };
            img.onerror = loadFailed;
            img.src = e.target.result;
        };
        reader.onerror = function() { hideLoading(); showToast(window.t('toastFileReadFailed'), 'error'); };
        reader.readAsDataURL(file);
    };

    if (typeof createImageBitmap === 'function') {
        // createImageBitmap decodes off the main thread — huge on mobile
        const opts = { imageOrientation: 'from-image', premultiplyAlpha: 'default' };
        createImageBitmap(file, opts).then(bitmapToImg).catch(function() {
            // some browsers reject the options object — retry plain
            createImageBitmap(file).then(bitmapToImg).catch(fallbackReader);
        });
    } else {
        fallbackReader();
    }
}
})(globalThis);
