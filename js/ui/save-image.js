// ============================================================
// save-image.js - shared "get this image out of the app" helpers (Task P1.6)
// ============================================================
// Used by the three export entry points: Export modal (modals-export.js), Magic Eraser
// "Download HD" (magic-eraser.js) and Portrait "Save" (portrait-mode.js).
//
//   canvasToBlob(canvas, type, quality) -> Promise<Blob>
//   saveBlob(blob, filename)            -> Promise<'shared' | 'cancelled' | 'downloaded'>
//   blobSizeMB(blob)                    -> string, e.g. "3.4"
//
// Everything stays a Blob end to end: no toDataURL / base64 string is ever created on the JS heap.
// Cordova storage (saveCanvasToDeviceStorage in modals-export.js) is a separate path and is not touched here.
//
// V24/G8: canvasToBlob() is THE canvas.toBlob() wrapper of the app. history.js canvasToBlobUrl() (blob + registered URL),
// file-handler.js, portrait-mode.js, magic-eraser.js and compare.js all go through it - no private copies.

// canvas.toBlob() as a Promise. Rejects if the canvas cannot be encoded (null / empty blob).
(function (g) {
// V27 module "save-image": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('save-image', {
  blobSizeMB: [() => blobSizeMB, (v) => { blobSizeMB = v; }],
  canvasToBlob: [() => canvasToBlob, (v) => { canvasToBlob = v; }],
  saveBlob: [() => saveBlob, (v) => { saveBlob = v; }],
});
function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
        if (!canvas || typeof canvas.toBlob !== 'function') {
            reject(new Error('Could not encode the image'));
            return;
        }
        try {
            canvas.toBlob(function (blob) {
                if (!blob || !blob.size) reject(new Error('Could not encode the image'));
                else resolve(blob);
            }, type || 'image/png', quality);
        } catch (err) {
            reject(err);
        }
    });
}

// Real encoded size in MB (one decimal), from blob.size.
function blobSizeMB(blob) {
    return ((blob && blob.size || 0) / 1024 / 1024).toFixed(1);
}

// Touch-first device (phone/tablet). Desktops and hybrid laptops report a fine primary pointer.
function _isCoarsePointer() {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) {
        return false;
    }
}

// Returns a File when the browser can natively share it, otherwise null.
function _shareableFile(blob, filename) {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' ||
        typeof navigator.canShare !== 'function' || typeof File !== 'function') return null;
    try {
        var file = new File([blob], filename, { type: blob.type || 'image/png' });
        return navigator.canShare({ files: [file] }) ? file : null;
    } catch (e) {
        return null;
    }
}

// Classic anchor download from an object URL; the URL is revoked after 4 s (the download has started by then).
function _downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

// Phones/tablets: open the native share sheet (Save Image -> Photos / Gallery). Everything else, or any
// share failure other than the user dismissing the sheet: plain download.
async function saveBlob(blob, filename) {
    if (_isCoarsePointer()) {
        var file = _shareableFile(blob, filename);
        if (file) {
            try {
                await navigator.share({ files: [file] });
                return 'shared';
            } catch (err) {
                if (err && err.name === 'AbortError') return 'cancelled';   // user closed the sheet: not an error
                // NotAllowedError (user-activation expired), DataError, ... -> fall back to a normal download
            }
        }
    }
    _downloadBlob(blob, filename);
    return 'downloaded';
}
})(globalThis);
