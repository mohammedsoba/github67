// ============================================================
// presets.js
// ============================================================
// ==================== PRESETS ====================
// Y1: one small UNEDITED cover-cropped copy of the working photo shared by every preset thumbnail.
// (Thumbnails used mainImg.src: after any pixel-pass edit that is the already-filtered preview, so each
// preset was applied on top of the user's current edits - and a multi-megabyte data URL was copied into
// ~60 inline styles.) Cached per image URL.
(function (g) {
// V27 module "presets": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('presets', {
  applyPreset: [() => applyPreset, (v) => { applyPreset = v; }],
  getPresetFilter: [() => getPresetFilter, (v) => { getPresetFilter = v; }],
  getPresetThumbUrl: [() => getPresetThumbUrl, (v) => { getPresetThumbUrl = v; }],
  renderPresets: [() => renderPresets, (v) => { renderPresets = v; }],
});
var _presetThumb = { key: null, url: '' };
function getPresetThumbUrl() {
    if (typeof originalImage === 'undefined' || !originalImage || !originalImage.src) return '';
    if (_presetThumb.key === originalImage.src) return _presetThumb.url;
    var url = '';
    try {
        var S = 120;                                   // 2x the 60px thumb, crisp on retina
        var iw = originalImage.naturalWidth || originalImage.width;
        var ih = originalImage.naturalHeight || originalImage.height;
        var side = Math.min(iw, ih);
        var cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        var cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(originalImage, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, S, S);
        var alpha = (typeof YoPipeline !== 'undefined') && YoPipeline.imageHasAlpha(originalImage);
        url = cv.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.82);
        cv.width = 0; cv.height = 0;
    } catch (e) { url = ''; }
    _presetThumb = { key: originalImage.src, url: url };
    return url;
}

function renderPresets() {
    const grid = document.getElementById('presetsGrid');
    grid.innerHTML = '';
    const thumbUrl = getPresetThumbUrl();
    for (let i = 0; i < allPresets.length; i++) {
        const p = allPresets[i];
        const item = document.createElement('button');      // Y17: a real button (keyboard + screen reader)
        item.type = 'button';
        item.className = p.id === chosenPreset ? 'preset-item active' : 'preset-item';
        item.setAttribute('aria-pressed', p.id === chosenPreset ? 'true' : 'false');
        item.setAttribute('aria-label', p.name);
        item.onclick = function() { applyPreset(p.id); };
        const thumb = document.createElement('div');
        thumb.className = 'preset-thumb';
        if (thumbUrl && p.id !== 'none') {
            thumb.style.backgroundImage = 'url(' + thumbUrl + ')';
            thumb.style.filter = getPresetFilter(p.style, true);
        } else if (thumbUrl && p.id === 'none') {
            thumb.style.backgroundImage = 'url(' + thumbUrl + ')';       // "Original": the untouched photo
        } else {
            thumb.style.background = p.thumb;
        }
        if (p.badge) {
            const badge = document.createElement('span');
            badge.className = 'preset-badge ' + p.badge.toLowerCase();
            badge.innerText = p.badge;
            thumb.appendChild(badge);
        }
        const label = document.createElement('span');
        label.innerText = p.name;
        item.appendChild(thumb);
        item.appendChild(label);
        grid.appendChild(item);
    }
}

function getPresetFilter(style, isPreview) {
    // Y1: previews use the SAME values as the applied filter. (Scaling the raw percentages by 0.55 turned
    // brightness(110%) into brightness(60%): thumbnails were darker and duller than the real result.)
    const i = 1;   // isPreview kept for API compatibility
    switch(style) {
        // ===== ORIGINAL FILTERS =====
        case 'angelic': return 'brightness(' + (110*i) + '%) contrast(' + (95*i) + '%) saturate(' + (120*i) + '%) sepia(' + (15*i) + '%) hue-rotate(' + (-5*i) + 'deg)';
        case 'boldglamour': return 'contrast(' + (115*i) + '%) saturate(' + (135*i) + '%) brightness(' + (108*i) + '%) sepia(' + (20*i) + '%)';
        case 'butterfly': return 'brightness(' + (115*i) + '%) saturate(' + (140*i) + '%) contrast(' + (95*i) + '%) hue-rotate(' + (10*i) + 'deg)';
        case 'babypink': return 'saturate(' + (130*i) + '%) brightness(' + (112*i) + '%) contrast(' + (90*i) + '%) hue-rotate(' + (320*i) + 'deg)';
        case 'retroglow': return 'sepia(' + (30*i) + '%) contrast(' + (105*i) + '%) saturate(' + (110*i) + '%) brightness(' + (105*i) + '%)';
        case 'poshlight': return 'contrast(' + (110*i) + '%) brightness(' + (115*i) + '%) saturate(' + (85*i) + '%) hue-rotate(' + (180*i) + 'deg)';
        case 'lightfoundation': return 'brightness(' + (108*i) + '%) contrast(' + (98*i) + '%) saturate(' + (95*i) + '%)';
        case 'tezza': return 'contrast(' + (105*i) + '%) saturate(' + (115*i) + '%) brightness(' + (102*i) + '%) sepia(' + (25*i) + '%)';
        case 'juno': return 'saturate(' + (130*i) + '%) contrast(' + (110*i) + '%) brightness(' + (103*i) + '%)';
        case 'lark': return 'brightness(' + (115*i) + '%) saturate(' + (110*i) + '%) contrast(' + (95*i) + '%)';
        case 'gingham': return 'contrast(' + (90*i) + '%) brightness(' + (110*i) + '%) saturate(' + (85*i) + '%)';
        case 'clarendon': return 'contrast(' + (120*i) + '%) saturate(' + (110*i) + '%) brightness(' + (105*i) + '%) hue-rotate(' + (-10*i) + 'deg)';
        case 'moon': return 'grayscale(100%) contrast(' + (130*i) + '%) brightness(' + (90*i) + '%)';
        case 'slumber': return 'brightness(' + (80*i) + '%) contrast(' + (110*i) + '%) saturate(' + (70*i) + '%) sepia(' + (15*i) + '%)';
        case 'c1': return 'contrast(' + (110*i) + '%) saturate(' + (125*i) + '%) brightness(' + (105*i) + '%)';
        case 'a6': return 'contrast(' + (105*i) + '%) brightness(' + (108*i) + '%) saturate(' + (95*i) + '%) sepia(' + (20*i) + '%)';
        case 'hb2': return 'contrast(' + (115*i) + '%) brightness(' + (100*i) + '%) saturate(' + (85*i) + '%) hue-rotate(' + (-15*i) + 'deg)';
        case 'm5': return 'contrast(' + (95*i) + '%) brightness(' + (110*i) + '%) saturate(' + (80*i) + '%)';
        case 'g3': return 'saturate(' + (115*i) + '%) contrast(' + (105*i) + '%) brightness(' + (103*i) + '%) hue-rotate(' + (-20*i) + 'deg)';
        case 'p5': return 'brightness(' + (85*i) + '%) contrast(' + (120*i) + '%) saturate(' + (75*i) + '%)';
        case 'moodyblue': return 'contrast(' + (115*i) + '%) brightness(' + (90*i) + '%) saturate(' + (80*i) + '%) hue-rotate(' + (200*i) + 'deg)';
        case 'oranges': return 'contrast(' + (120*i) + '%) saturate(' + (110*i) + '%) sepia(' + (30*i) + '%) hue-rotate(' + (-15*i) + 'deg)';
        case 'filmlook': return 'contrast(' + (92*i) + '%) brightness(' + (105*i) + '%) saturate(' + (85*i) + '%)';
        case 'matte': return 'contrast(' + (85*i) + '%) brightness(' + (110*i) + '%) saturate(' + (80*i) + '%)';
        case 'faded': return 'contrast(' + (88*i) + '%) brightness(' + (108*i) + '%) saturate(' + (75*i) + '%)';
        case 'cinematic': return 'contrast(' + (110*i) + '%) saturate(' + (105*i) + '%) sepia(' + (8*i) + '%) brightness(' + (100*i) + '%)';
        case 'blockbuster': return 'contrast(' + (125*i) + '%) saturate(' + (115*i) + '%) brightness(' + (95*i) + '%)';
        case 'noir': return 'grayscale(100%) contrast(' + (150*i) + '%) brightness(' + (80*i) + '%)';
        case 'cyberpunk': return 'hue-rotate(' + (160*i) + 'deg) saturate(' + (180*i) + '%) contrast(' + (120*i) + '%) brightness(' + (110*i) + '%)';
        case 'golden': return 'sepia(' + (35*i) + '%) saturate(' + (120*i) + '%) brightness(' + (105*i) + '%) contrast(' + (105*i) + '%)';
        case 'tropical': return 'saturate(' + (140*i) + '%) contrast(' + (110*i) + '%) brightness(' + (108*i) + '%) hue-rotate(' + (-10*i) + 'deg)';
        case 'desert': return 'sepia(' + (40*i) + '%) brightness(' + (105*i) + '%) contrast(' + (110*i) + '%) saturate(' + (90*i) + '%)';
        case 'winter': return 'brightness(' + (110*i) + '%) contrast(' + (105*i) + '%) saturate(' + (70*i) + '%) hue-rotate(' + (190*i) + 'deg)';
        case 'portrait': return 'contrast(' + (103*i) + '%) brightness(' + (106*i) + '%) saturate(' + (92*i) + '%)';
        case 'softglam': return 'brightness(' + (108*i) + '%) contrast(' + (98*i) + '%) saturate(' + (95*i) + '%)';
        case 'airbrush': return 'brightness(' + (110*i) + '%) contrast(' + (95*i) + '%) saturate(' + (90*i) + '%)';
        case 'foodie': return 'saturate(' + (135*i) + '%) contrast(' + (108*i) + '%) brightness(' + (106*i) + '%) hue-rotate(' + (5*i) + 'deg)';
        case 'coffee': return 'sepia(' + (45*i) + '%) brightness(' + (95*i) + '%) contrast(' + (110*i) + '%) saturate(' + (85*i) + '%)';
        case 'creamy': return 'contrast(' + (92*i) + '%) brightness(' + (112*i) + '%) saturate(' + (80*i) + '%)';

        // ===== 20 NEW TRENDING FILTERS — ordered: natural → creative =====

        // 1. Clean — ultra-fresh, barely-there enhancement; removes muddiness without altering colours
        case 'clean': return 'brightness(' + (103*i) + '%) contrast(' + (102*i) + '%) saturate(' + (105*i) + '%)';

        // 2. Natural — true-to-life colour lift; like editing in "Auto" on a professional camera
        case 'natural': return 'brightness(' + (105*i) + '%) contrast(' + (103*i) + '%) saturate(' + (112*i) + '%) sepia(' + (3*i) + '%)';

        // 3. Skin Glow — velvety glow that smooths and warms skin; great for selfies & portraits
        case 'skinglow': return 'brightness(' + (112*i) + '%) contrast(' + (96*i) + '%) saturate(' + (88*i) + '%) sepia(' + (8*i) + '%)';

        // 4. Portrait Pro — studio-level portrait polish; sharpens mid-tones, softens the rest
        case 'portraitpro': return 'brightness(' + (108*i) + '%) contrast(' + (105*i) + '%) saturate(' + (92*i) + '%) sepia(' + (6*i) + '%) hue-rotate(' + (-3*i) + 'deg)';

        // 5. Golden Hour — rich liquid-gold warmth; recreates the magic of the last hour of sunlight
        case 'goldenhour': return 'sepia(' + (28*i) + '%) saturate(' + (128*i) + '%) brightness(' + (110*i) + '%) contrast(' + (108*i) + '%) hue-rotate(' + (-12*i) + 'deg)';

        // 6. Warm Tone — gentle amber cast; brings coziness to any scene
        case 'warmtone': return 'sepia(' + (15*i) + '%) saturate(' + (118*i) + '%) brightness(' + (106*i) + '%) contrast(' + (104*i) + '%)';

        // 7. Cool Tone — crisp, clean coolness; works beautifully on cityscapes & minimalist shots
        case 'cooltone': return 'brightness(' + (106*i) + '%) contrast(' + (110*i) + '%) saturate(' + (88*i) + '%) hue-rotate(' + (-8*i) + 'deg)';

        // 8. Matte Film — lifted blacks, muted saturation; the Instagram matte look perfected
        case 'mattefilm': return 'contrast(' + (80*i) + '%) brightness(' + (114*i) + '%) saturate(' + (70*i) + '%) sepia(' + (8*i) + '%)';

        // 9. HDR — punchy high-dynamic-range pop; every detail leaps out
        case 'hdrpop': return 'contrast(' + (132*i) + '%) saturate(' + (142*i) + '%) brightness(' + (103*i) + '%)';

        // 10. Vibrant — maximum colour saturation; makes every hue sing
        case 'vibrant': return 'saturate(' + (158*i) + '%) contrast(' + (112*i) + '%) brightness(' + (105*i) + '%) hue-rotate(' + (5*i) + 'deg)';

        // 11. Cinematic Pro — Hollywood teal-orange grade; desaturated shadows, rich highlights
        case 'cinematicpro': return 'contrast(' + (120*i) + '%) saturate(' + (92*i) + '%) sepia(' + (15*i) + '%) brightness(' + (96*i) + '%) hue-rotate(' + (-8*i) + 'deg)';

        // 12. Sunset — fiery orange-red dusk palette; transforms any photo into golden magic
        case 'sunsetglow': return 'sepia(' + (32*i) + '%) saturate(' + (122*i) + '%) brightness(' + (108*i) + '%) contrast(' + (113*i) + '%) hue-rotate(' + (-18*i) + 'deg)';

        // 13. Urban — gritty high-contrast street photography look; raw and powerful
        case 'urban': return 'contrast(' + (128*i) + '%) saturate(' + (85*i) + '%) brightness(' + (88*i) + '%) hue-rotate(' + (2*i) + 'deg)';

        // 14. Film Chrome — Fuji Velvia-style neutral film stock; true analogue colour science
        case 'filmchrome': return 'contrast(' + (94*i) + '%) brightness(' + (108*i) + '%) saturate(' + (82*i) + '%) sepia(' + (22*i) + '%) hue-rotate(' + (8*i) + 'deg)';

        // 15. B&W Pro — luminosity-rich black and white; more detail and lift than Noir
        case 'bwpro': return 'grayscale(100%) contrast(' + (122*i) + '%) brightness(' + (108*i) + '%)';

        // 16. Dreamy — hazy, soft-focus fantasy feel; perfect for portraits & lifestyle shots
        case 'dreamy': return 'brightness(' + (120*i) + '%) contrast(' + (85*i) + '%) saturate(' + (100*i) + '%) hue-rotate(' + (12*i) + 'deg)';

        // 17. Glow — radiant overexposed bloom; skin and highlights appear to emit light
        case 'glowsoft': return 'brightness(' + (122*i) + '%) contrast(' + (90*i) + '%) saturate(' + (108*i) + '%) sepia(' + (5*i) + '%)';

        // 18. Sharp Pro — ultra-crisp clarity with punchy contrast; detail-obsessed look
        case 'sharppro': return 'contrast(' + (140*i) + '%) saturate(' + (110*i) + '%) brightness(' + (97*i) + '%)';

        // 19. Vintage Pro — deep amber-sepia aged film; richer and warmer than Retro
        case 'vintagepro': return 'sepia(' + (42*i) + '%) contrast(' + (112*i) + '%) saturate(' + (78*i) + '%) brightness(' + (103*i) + '%) hue-rotate(' + (12*i) + 'deg)';

        // 20. Neon Pop — electric neon shift; bold creative hue rotation for artistic shots
        case 'neonpop': return 'hue-rotate(' + (55*i) + 'deg) saturate(' + (168*i) + '%) contrast(' + (115*i) + '%) brightness(' + (112*i) + '%)';

        default: return '';
    }
}

// Sliders each preset type owns (Y2: used to clear the previous preset before applying a new one)
var PRESET_SLIDER_MAP = {
    warm:    { warmth: 25, sat: 15, contrast: 5 },
    cool:    { warmth: -20, sat: 10, contrast: 10 },
    dark:    { bright: -15, contrast: 15, shadows: -20 },
    bright:  { bright: 15, contrast: 5, sat: 20 },
    soft:    { contrast: -10, sat: -5, clarity: -10 },
    vivid:   { sat: 30, vibrance: 25, contrast: 8 },
    bw:      { sat: -100, contrast: 20, clarity: 15 },
    skin:    { warmth: 10, sat: -5, clarity: 10 },
    green:   { sat: 15, vibrance: 20, contrast: 10 },
    cinematic: { contrast: 10, sat: 5, vignette: 15 },
    // New types for the 20 added filters
    natural: { bright: 3, sat: 8, clarity: 5 },
    hdr:     { contrast: 25, sat: 35, vibrance: 30, clarity: 20 }
};

function applyPreset(presetId) {
    if (!requireImage()) return;
    
    // Show loading immediately for smooth UX
    // Y2: remember which preset was active BEFORE this click (stateless: derived from chosenPreset, so it is
    // also correct after Undo / Reset / a loaded history state).
    const previousPresetId = chosenPreset;
    showLoading(window.t('loadingFilter'));
    updateLoadingSub(window.t('loadingFilterSub'));
    
    // Small delay to let browser render the loading overlay before heavy processing
    setTimeout(function() {
        chosenPreset = presetId;
        renderPresets();
        const preset = allPresets.find(function(p) { return p.id === presetId; });
        if (!preset || presetId === 'none') {
            // Defined scope: "Original" removes the preset/filter AND every colour edit (adjustment
            // sliders, Color Mix, curves). Crop, frame and overlays are kept. It is one undo step.
            resetColorEdits();
            applyAllEdits();
            saveToHistory();
            hideLoading();
            return;
        }
        // Y2: completely remove the previous preset's slider contribution first, so presets never stack
        // (applying B after A used to leave every value A set that B does not overwrite).
        const previous = allPresets.find(function(p) { return p.id === previousPresetId; });
        const previousSettings = previous ? PRESET_SLIDER_MAP[previous.type] : null;
        if (previousSettings) {
            const prevKeys = Object.keys(previousSettings);
            for (let i = 0; i < prevKeys.length; i++) {
                if (sliders.hasOwnProperty(prevKeys[i])) sliders[prevKeys[i]] = 0;
            }
        }
        const settings = PRESET_SLIDER_MAP[preset.type];
        if (settings) {
            const keys = Object.keys(settings);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                if (sliders.hasOwnProperty(key)) sliders[key] = settings[key];
            }
        }
        updateSliderUI();
        applyAllEdits();
        saveToHistory();
        hideLoading();
    }, 80);
}
})(globalThis);
