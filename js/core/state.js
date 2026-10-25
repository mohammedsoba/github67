// ============================================================
// state.js
// ============================================================
// ==================== PORTRAIT MODE STATE ====================
// Shared MediaPipe segmenter (also used by bg-removal.js and ai-mask.js).
let portraitSelfieSegmentation = null;
let portraitModelLoaded = false;
// Portrait / Bokeh tool (server-side Depth Anything V2 via POST /api/portrait).
let portraitCurrentBlur = 1;      // blur_level 1..30 sent to the server (1 = completely sharp)
let portraitCurrentSkin = 0;      // skin_smooth 0..100 sent to the server (0 = skin untouched)
let portraitBaseBlob = null;      // pre-portrait image, so slider changes never stack blur
let portraitResultSrc = null;     // data URL of the portrait result currently loaded as originalImage
let portraitRequestSeq = 0;       // increments per request; stale responses are ignored
let portraitAbortCtl = null;      // AbortController of the in-flight request
let portraitBusy = false;
let portraitFocus = { x: 0.5, y: 0.5, set: false };   // tap-to-focus point, normalised 0..1 of the image
// Detect mobile once — used to pick a safer backend and smaller AI input size.
var IS_MOBILE_DEVICE = (function(){
    try {
        return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)
            || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    } catch(e) { return false; }
})();

// ==================== STATE ====================
let currentLanguage = 'en';
let chosenPreset = 'none';
let activeColorIndex = 0;
let activeCurveChannel = 'rgb';
let originalImage = null;         // working image — updated by crop, canvas effects source
let originalForCompare = null;    // frozen upload-time snapshot — NEVER overwritten after set
let historyStack = [];
let historyIndex = -1;
const maxHistory = 20;
let isProcessing = false;
let cropRatio = 'free';
let fitMode = 'normal';
let previewCanvas = null;
let previewCtx = null;
let fullResCanvas = null;
let fullResCtx = null;
let pendingUpdate = null;
let lastFilterString = '';

// Crop state
let isCropMode = false;
let isDrawingCrop = false;

const sliders = {
    bright: 0, contrast: 0, exposure: 0, shadows: 0, whites: 0, blacks: 0,
    sat: 0, vibrance: 0, warmth: 0, tint: 0,
    sharp: 0, clarity: 0, vignette: 0, grain: 0
};

const sliderSteps = {
    bright: 1, contrast: 1, exposure: 1, shadows: 1, whites: 1, blacks: 1,
    sat: 1, vibrance: 1, warmth: 1, tint: 1,
    sharp: 1, clarity: 1, vignette: 1, grain: 1
};

const baseColors = ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8b00ff', '#ff007f'];
let colorMixData = baseColors.map(function() { return { hue: 0, sat: 0, lum: 0 }; });

let curvesData = {
    rgb: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
    red: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
    green: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}],
    blue: [{x:0,y:0}, {x:64,y:64}, {x:128,y:128}, {x:192,y:192}, {x:255,y:255}]
};

let curvesLUT = { rgb: null, red: null, green: null, blue: null };
