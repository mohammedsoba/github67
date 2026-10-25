// ============================================================
// reset.js
// ============================================================
// ==================== RESET & LOADING ====================
// Clears every COLOUR edit: adjustment sliders, preset/filter, Color Mix and curves.
// Crop ratio, frame and overlays are untouched. Used by Preset "Original" (R10) and after an AI tool
// has baked the colour edits into the pixels (R11/R12).
(function (g) {
// V27 module "reset": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('reset', {
  resetAllValues: [() => resetAllValues, (v) => { resetAllValues = v; }],
  resetColorEdits: [() => resetColorEdits, (v) => { resetColorEdits = v; }],
});
function resetColorEdits() {
    const keys = Object.keys(sliders);
    for (let i = 0; i < keys.length; i++) sliders[keys[i]] = 0;
    chosenPreset = 'none';
    colorMixData = baseColors.map(function() { return { hue: 0, sat: 0, lum: 0 }; });
    curvesData = {
        rgb: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
        red: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
        green: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
        blue: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}]
    };
    buildCurvesLUTs();
    updateSliderUI();
    renderPresets();
    renderColorMix();
    try {
        const cc = document.getElementById('curvesCanvas');
        if (cc && typeof drawCurves === 'function') drawCurves(cc.getContext('2d'));
    } catch (e) {}
}

function resetAllValues() {
    resetColorEdits();
    cropRatio = 'free';
    fitMode = 'normal';
    // `overlayManager` is a top-level `let` (NOT a window property), so it is checked with typeof. The old
    // overlayManager.updatePanels() call was removed: the overlay editor panels were deleted in V23 (nothing to update),
    // render() redraws the canvas and the selection handles. It threw "updatePanels is not a function" on every new photo.
    if (typeof overlayManager !== 'undefined' && overlayManager) {
        overlayManager.items = [];
        overlayManager.selectedId = null;
        if (typeof overlayManager.render === 'function') overlayManager.render();
    }
    // R6: frame id + controls (+ their UI) are state too - without this a new photo kept exporting the
    // previous photo's frame although the preview showed none.
    if (typeof resetFrameState === 'function') resetFrameState();
    const img = document.getElementById('mainImg');
    img.style.filter = 'none';
    img.style.aspectRatio = 'auto';
    img.style.objectFit = 'contain';
    img.style.width = 'auto';
    img.style.height = 'auto';
    document.getElementById('imgContainer').style.cssText = '';
    cancelCrop();
}

function resetSliders() {
    const keys = Object.keys(sliders);
    for (let i = 0; i < keys.length; i++) sliders[keys[i]] = 0;
    updateSliderUI();
}
})(globalThis);
