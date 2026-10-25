// ============================================================
// ai-auto.js
// ============================================================
// ==================== AI AUTO ====================
(function (g) {
// V27 module "ai-auto": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('ai-auto', {
  applyAutoEnhance: [() => applyAutoEnhance, (v) => { applyAutoEnhance = v; }],
});
function applyAutoEnhance() {
    if (!requireImage()) return;
    showLoading(window.t('toastAnalyzing'));
    updateLoadingSub(window.t('toastOptimalSettings'));
    setTimeout(function() {
        const w = previewCanvas.width;
        const h = previewCanvas.height;
        previewCtx.drawImage(originalImage, 0, 0, w, h);
        const imageData = previewCtx.getImageData(0, 0, w, h);
        const data = imageData.data;
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let totalLum = 0;
        const pixelCount = data.length / 4;
        const step = Math.max(1, Math.floor(pixelCount / 5000));
        let samples = 0;
        for (let i = 0; i < data.length; i += 4 * step) {
            totalR += data[i];
            totalG += data[i+1];
            totalB += data[i+2];
            totalLum += (data[i] + data[i+1] + data[i+2]) / 3;
            samples++;
        }
        const avgR = totalR / samples;
        const avgG = totalG / samples;
        const avgB = totalB / samples;
        const avgLum = totalLum / samples;

        sliders.bright = avgLum < 100 ? 15 : avgLum > 180 ? -10 : 5;
        sliders.contrast = avgLum < 80 ? 10 : 5;
        sliders.sat = avgLum < 100 ? 15 : -5;
        sliders.warmth = avgB > avgR ? 15 : avgR > avgB + 30 ? -10 : 0;
        sliders.shadows = avgLum < 100 ? 20 : 0;
        sliders.whites = avgLum > 150 ? 10 : 0;
        sliders.blacks = avgLum < 80 ? -10 : 0;
        sliders.sharp = 25;
        sliders.clarity = 15;
        sliders.vibrance = 20;

        if (avgLum < 60) chosenPreset = 'slumber';
        else if (avgLum > 180) chosenPreset = 'creamy';
        else if (avgR > avgG + 20 && avgR > avgB + 20) chosenPreset = 'tezza';
        else if (avgB > avgR + 20) chosenPreset = 'moodyblue';
        else chosenPreset = 'cinematic';

        updateSliderUI();
        renderPresets();
        applyAllEdits();
        saveToHistory();
        hideLoading();
    }, 800);
}
})(globalThis);
