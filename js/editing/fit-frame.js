// ============================================================
// fit-frame.js  — Frame section (fully rewritten)
// ONLY the Frame tab (p-fit-panel) is affected.
// All other sections of the application are untouched.
// Backward compatibility with existing fitMode/undo is preserved.
// ============================================================

// ===================== FRAME STATE =====================
(function (g) {
// V27 module "fit-frame": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('fit-frame', {
  FRAME_DEFS: [() => FRAME_DEFS, (v) => { FRAME_DEFS = v; }],
  _applyFitContainer: [() => _applyFitContainer, (v) => { _applyFitContainer = v; }],
  _buildFrameCSS: [() => _buildFrameCSS, (v) => { _buildFrameCSS = v; }],
  _findFrame: [() => _findFrame, (v) => { _findFrame = v; }],
  _frameSupportsCustomColor: [() => _frameSupportsCustomColor, (v) => { _frameSupportsCustomColor = v; }],
  _setFrameImageRadius: [() => _setFrameImageRadius, (v) => { _setFrameImageRadius = v; }],
  _setSliderAndLabel: [() => _setSliderAndLabel, (v) => { _setSliderAndLabel = v; }],
  activeFrameCat: [() => activeFrameCat, (v) => { activeFrameCat = v; }],
  activeFrameId: [() => activeFrameId, (v) => { activeFrameId = v; }],
  applyFrame: [() => applyFrame, (v) => { applyFrame = v; }],
  filterFrameCat: [() => filterFrameCat, (v) => { filterFrameCat = v; }],
  frameControls: [() => frameControls, (v) => { frameControls = v; }],
  getFrameState: [() => getFrameState, (v) => { getFrameState = v; }],
  onFrameColorChange: [() => onFrameColorChange, (v) => { onFrameColorChange = v; }],
  onFrameControlChange: [() => onFrameControlChange, (v) => { onFrameControlChange = v; }],
  renderFrameGrid: [() => renderFrameGrid, (v) => { renderFrameGrid = v; }],
  resetFrameControls: [() => resetFrameControls, (v) => { resetFrameControls = v; }],
  resetFrameState: [() => resetFrameState, (v) => { resetFrameState = v; }],
  setFrameState: [() => setFrameState, (v) => { setFrameState = v; }],
  toggleFrameCustomColor: [() => toggleFrameCustomColor, (v) => { toggleFrameCustomColor = v; }],
});
var frameControls = {
    thickness:      20,    // 0-60 px of frame padding
    radius:         0,     // 0-80 px border-radius
    shadow:         0,     // 0-100 drop-shadow intensity
    padding:        0,     // 0-40 px extra inner padding
    useCustomColor: false,
    customColor:    '#ffffff'
};
var activeFrameId  = 'none';
var activeFrameCat = 'all';

// ===================== FRAME DEFINITIONS =====================
// Each frame: id, name, cat, bg, optional: thin|polaroid|neon|neonColor|rounded|backdropBlur|border|baseShadow, thumb
var FRAME_DEFS = [

    // ──── MINIMAL ────
    { id: 'none',         name: 'None',        cat: 'minimal',
      bg: 'transparent',
      thumb: 'linear-gradient(135deg,#1a1a24,#2a2a35)' },

    { id: 'min-white',    name: 'White',        cat: 'minimal',
      bg: '#ffffff',
      thumb: 'linear-gradient(135deg,#ffffff,#e8e8e8)' },

    { id: 'min-black',    name: 'Black',        cat: 'minimal',
      bg: '#000000',
      thumb: 'linear-gradient(135deg,#000000,#2a2a2a)' },

    { id: 'min-thin-w',   name: 'Thin White',   cat: 'minimal',
      bg: '#ffffff',       thin: true,
      thumb: 'linear-gradient(135deg,#ffffff,#cccccc)' },

    { id: 'min-thin-b',   name: 'Thin Black',   cat: 'minimal',
      bg: '#000000',       thin: true,
      thumb: 'linear-gradient(135deg,#111111,#333333)' },

    { id: 'min-gray',     name: 'Gray',         cat: 'minimal',
      bg: '#888888',
      thumb: 'linear-gradient(135deg,#888888,#aaaaaa)' },

    // ──── POLAROID ────
    { id: 'pol-classic',  name: 'Classic',      cat: 'polaroid',
      bg: '#ffffff',       polaroid: true,
      thumb: 'linear-gradient(135deg,#ffffff,#eeeeee)' },

    { id: 'pol-vintage',  name: 'Vintage',      cat: 'polaroid',
      bg: '#f5f0e8',       polaroid: true,
      thumb: 'linear-gradient(135deg,#f5f0e8,#ede0cc)' },

    { id: 'pol-dark',     name: 'Dark',         cat: 'polaroid',
      bg: '#1a1a1a',       polaroid: true,
      thumb: 'linear-gradient(135deg,#1a1a1a,#333333)' },

    { id: 'pol-blush',    name: 'Blush',        cat: 'polaroid',
      bg: '#fde8e8',       polaroid: true,
      thumb: 'linear-gradient(135deg,#fde8e8,#fbbcbc)' },

    { id: 'pol-cream',    name: 'Cream',        cat: 'polaroid',
      bg: '#fef9e7',       polaroid: true,
      thumb: 'linear-gradient(135deg,#fef9e7,#fdedb0)' },

    // ──── FILM ────
    { id: 'film-strip',   name: 'Strip',        cat: 'film',
      bg: '#111111',       border: '4px solid #222222',
      thumb: 'linear-gradient(135deg,#111111,#2a2a2a)' },

    { id: 'film-35mm',    name: '35mm',         cat: 'film',
      bg: '#0d0d0d',       border: '6px solid #000000',
      thumb: 'linear-gradient(135deg,#0d0d0d,#1a1a1a)' },

    { id: 'film-cinema',  name: 'Cinema',       cat: 'film',
      bg: '#000000',       border: '10px solid #0a0a0a',
      thumb: 'linear-gradient(135deg,#000000,#111111)' },

    { id: 'film-kodak',   name: 'Kodak',        cat: 'film',
      bg: '#ffc107',       border: '3px solid #e6a800',
      thumb: 'linear-gradient(135deg,#ffc107,#ff9800)' },

    // ──── NEON ────
    { id: 'neon-purple',  name: 'Purple',       cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(139,92,246,',
      border: '2px solid rgba(139,92,246,0.9)',
      thumb: 'linear-gradient(135deg,#4c1d95,#7c3aed)' },

    { id: 'neon-blue',    name: 'Blue',         cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(59,130,246,',
      border: '2px solid rgba(59,130,246,0.9)',
      thumb: 'linear-gradient(135deg,#1e3a8a,#3b82f6)' },

    { id: 'neon-pink',    name: 'Pink',         cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(236,72,153,',
      border: '2px solid rgba(236,72,153,0.9)',
      thumb: 'linear-gradient(135deg,#831843,#ec4899)' },

    { id: 'neon-cyan',    name: 'Cyan',         cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(6,182,212,',
      border: '2px solid rgba(6,182,212,0.9)',
      thumb: 'linear-gradient(135deg,#164e63,#06b6d4)' },

    { id: 'neon-green',   name: 'Green',        cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(16,185,129,',
      border: '2px solid rgba(16,185,129,0.9)',
      thumb: 'linear-gradient(135deg,#064e3b,#10b981)' },

    { id: 'neon-orange',  name: 'Orange',       cat: 'neon',
      bg: 'transparent',   neon: true, neonColor: 'rgba(249,115,22,',
      border: '2px solid rgba(249,115,22,0.9)',
      thumb: 'linear-gradient(135deg,#7c2d12,#f97316)' },

    // ──── LUXURY ────
    { id: 'lux-gold',     name: 'Gold',         cat: 'luxury',
      bg: 'linear-gradient(135deg,#78350f,#fbbf24,#78350f)',
      border: '1px solid rgba(251,191,36,0.5)',
      thumb: 'linear-gradient(135deg,#78350f,#fbbf24)' },

    { id: 'lux-rosegold', name: 'Rose Gold',    cat: 'luxury',
      bg: 'linear-gradient(135deg,#9d174d,#f9a8d4,#9d174d)',
      thumb: 'linear-gradient(135deg,#9d174d,#f9a8d4)' },

    { id: 'lux-silver',   name: 'Silver',       cat: 'luxury',
      bg: 'linear-gradient(135deg,#6b7280,#e5e7eb,#6b7280)',
      thumb: 'linear-gradient(135deg,#6b7280,#e5e7eb)' },

    { id: 'lux-bronze',   name: 'Bronze',       cat: 'luxury',
      bg: 'linear-gradient(135deg,#78350f,#d97706,#78350f)',
      thumb: 'linear-gradient(135deg,#78350f,#d97706)' },

    { id: 'lux-platinum', name: 'Platinum',     cat: 'luxury',
      bg: 'linear-gradient(135deg,#9ca3af,#f3f4f6,#9ca3af)',
      thumb: 'linear-gradient(135deg,#9ca3af,#f3f4f6)' },

    // ──── GRADIENT ────
    { id: 'grad-sunset',  name: 'Sunset',       cat: 'gradient',
      bg: 'linear-gradient(135deg,#7c3aed,#db2777)',
      thumb: 'linear-gradient(135deg,#7c3aed,#db2777)' },

    { id: 'grad-ocean',   name: 'Ocean',        cat: 'gradient',
      bg: 'linear-gradient(135deg,#0369a1,#06b6d4)',
      thumb: 'linear-gradient(135deg,#0369a1,#06b6d4)' },

    { id: 'grad-aurora',  name: 'Aurora',       cat: 'gradient',
      bg: 'linear-gradient(135deg,#10b981,#7c3aed)',
      thumb: 'linear-gradient(135deg,#10b981,#7c3aed)' },

    { id: 'grad-fire',    name: 'Fire',         cat: 'gradient',
      bg: 'linear-gradient(135deg,#dc2626,#f97316)',
      thumb: 'linear-gradient(135deg,#dc2626,#f97316)' },

    { id: 'grad-cotton',  name: 'Cotton',       cat: 'gradient',
      bg: 'linear-gradient(135deg,#f9a8d4,#c4b5fd)',
      thumb: 'linear-gradient(135deg,#f9a8d4,#c4b5fd)' },

    { id: 'grad-mint',    name: 'Mint',         cat: 'gradient',
      bg: 'linear-gradient(135deg,#86efac,#67e8f9)',
      thumb: 'linear-gradient(135deg,#86efac,#67e8f9)' },

    { id: 'grad-goldrush',name: 'Gold Rush',    cat: 'gradient',
      bg: 'linear-gradient(135deg,#f59e0b,#ef4444)',
      thumb: 'linear-gradient(135deg,#f59e0b,#ef4444)' },

    // ──── SOCIAL MEDIA ────
    { id: 'soc-insta',    name: 'Instagram',    cat: 'social',
      bg: 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)',
      thumb: 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)' },

    { id: 'soc-tiktok',   name: 'TikTok',       cat: 'social',
      bg: '#010101',
      neon: true, neonColor: 'rgba(105,201,208,',
      border: '3px solid #69C9D0',
      thumb: 'linear-gradient(135deg,#010101,#69C9D0)' },

    { id: 'soc-twitter',  name: 'X / Twitter',  cat: 'social',
      bg: '#000000',       border: '3px solid #1DA1F2',
      thumb: 'linear-gradient(135deg,#000000,#1DA1F2)' },

    { id: 'soc-youtube',  name: 'YouTube',      cat: 'social',
      bg: '#000000',
      neon: true, neonColor: 'rgba(255,0,0,',
      border: '3px solid #FF0000',
      thumb: 'linear-gradient(135deg,#000000,#FF0000)' },

    // ──── ROUNDED ────
    { id: 'rnd-white',    name: 'Soft White',   cat: 'rounded',
      bg: '#ffffff',       rounded: true,
      thumb: 'linear-gradient(135deg,#ffffff,#eeeeee)' },

    { id: 'rnd-dark',     name: 'Dark',         cat: 'rounded',
      bg: '#111111',       rounded: true,
      thumb: 'linear-gradient(135deg,#111111,#222222)' },

    { id: 'rnd-card',     name: 'Card',         cat: 'rounded',
      bg: '#1e1e2e',       rounded: true,
      border: '1px solid rgba(255,255,255,0.1)',
      baseShadow: '0 20px 60px rgba(0,0,0,0.5)',
      thumb: 'linear-gradient(135deg,#1e1e2e,#2d2d44)' },

    { id: 'rnd-frost',    name: 'Frost',        cat: 'rounded',
      bg: 'rgba(255,255,255,0.06)', rounded: true, backdropBlur: true,
      border: '1px solid rgba(255,255,255,0.14)',
      thumb: 'linear-gradient(135deg,rgba(180,180,255,0.5),rgba(255,255,255,0.2))' },

    // ──── VINTAGE ────
    { id: 'vin-aged',     name: 'Aged',         cat: 'vintage',
      bg: '#d4b896',       border: '2px solid #b89a72',
      thumb: 'linear-gradient(135deg,#d4b896,#b89a72)' },

    { id: 'vin-sepia',    name: 'Sepia',        cat: 'vintage',
      bg: '#c8a96e',       border: '3px solid #8b6914',
      thumb: 'linear-gradient(135deg,#c8a96e,#8b6914)' },

    { id: 'vin-retro',    name: 'Retro',        cat: 'vintage',
      bg: '#e8dcc8',       border: '4px solid #8b7355',
      baseShadow: 'inset 0 0 30px rgba(0,0,0,0.18)',
      thumb: 'linear-gradient(135deg,#e8dcc8,#8b7355)' },

    { id: 'vin-brown',    name: 'Brown',        cat: 'vintage',
      bg: '#3d2b1f',       border: '2px solid #6b4c35',
      thumb: 'linear-gradient(135deg,#3d2b1f,#6b4c35)' },

    { id: 'vin-olive',    name: 'Olive',        cat: 'vintage',
      bg: '#4a4a2a',       border: '2px solid #6b6b3a',
      thumb: 'linear-gradient(135deg,#4a4a2a,#8b8b3a)' },

    // ──── CLEAN ────
    { id: 'cln-white',    name: 'White',        cat: 'clean',
      bg: '#ffffff',
      thumb: 'linear-gradient(135deg,#ffffff,#f5f5f5)' },

    { id: 'cln-black',    name: 'Black',        cat: 'clean',
      bg: '#000000',
      thumb: 'linear-gradient(135deg,#000000,#222222)' },

    { id: 'cln-charcoal', name: 'Charcoal',     cat: 'clean',
      bg: '#2d2d2d',
      thumb: 'linear-gradient(135deg,#2d2d2d,#444444)' },

    { id: 'cln-cream',    name: 'Cream',        cat: 'clean',
      bg: '#fef9e7',
      thumb: 'linear-gradient(135deg,#fef9e7,#fdedb0)' },

    { id: 'cln-navy',     name: 'Navy',         cat: 'clean',
      bg: '#1e3a5f',
      thumb: 'linear-gradient(135deg,#1e3a5f,#2e5080)' },

    { id: 'cln-forest',   name: 'Forest',       cat: 'clean',
      bg: '#1a3a2a',
      thumb: 'linear-gradient(135deg,#1a3a2a,#2d5a3a)' }
];

// ===================== FRAME RULES (Y13) =====================
// A custom colour only replaces a SOLID background. Neon frames (their colour IS the glow), the frosted-glass
// frame (a translucent tint over a blur) and gradient frames have nothing to recolour, so the colour controls
// are switched off for them instead of silently doing nothing (or flattening the glass into a solid block).
function _frameSupportsCustomColor(frame) {
    if (!frame || frame.id === 'none') return false;
    if (frame.neon || frame.backdropBlur) return false;
    var bg = frame.bg || 'transparent';
    if (bg === 'transparent' || bg.indexOf('gradient') !== -1 || bg.indexOf('rgba') === 0) return false;
    return true;
}

// Largest frame padding per side (CSS px). Thickness (60) + padding (40) = 100 px per side is fine on a tablet
// but on a 360 px phone it eats the whole photo: cap the total at 12% of the shorter workspace side. The same
// function feeds the preview AND the export, so both stay identical.
function _framePadCap() {
    var vp = document.getElementById('viewport');
    var w = vp ? vp.clientWidth : (window.innerWidth || 360);
    var h = vp ? vp.clientHeight : (window.innerHeight || 640);
    var m = Math.min(w, h) || 360;
    return Math.max(8, Math.round(m * 0.12));
}

// ===================== CSS BUILDER =====================
// Builds the CSS property object for a given frame + control values.
// Pure function — no side effects. Returns null for the 'none' frame.
function _buildFrameCSS(frame, ctrl) {
    if (!frame || frame.id === 'none') return null;

    var t = ctrl.thickness;   // base padding
    var r = ctrl.radius;
    var s = ctrl.shadow;
    var p = ctrl.padding;     // extra inner padding

    // Thin frames use 40% of the thickness value
    if (frame.thin) t = Math.max(0, Math.round(t * 0.4));

    // Padding: polaroid bottom is 2.5× the side
    // Y13: cap extreme padding on small screens; a polaroid keeps its 2.5x bottom proportion when scaled down
    var wantSide = t + p;
    var wantBottom = frame.polaroid ? (Math.round(t * 2.5) + p) : wantSide;
    var cap = _framePadCap();
    var k = wantSide > cap ? cap / wantSide : 1;
    var side = Math.round(wantSide * k);
    var bottom = Math.min(Math.round(wantBottom * k), Math.round(cap * 2.5));
    var padT = side;
    var padR = side;
    var padL = side;
    var padB = bottom;

    // Background — custom color overrides solid colours only
    var bg = frame.bg || 'transparent';
    if (ctrl.useCustomColor && ctrl.customColor && _frameSupportsCustomColor(frame)) {
        bg = ctrl.customColor;
    }

    // Border radius — rounded frames start from a 16 px baseline
    var borderRadius = r;
    if (frame.rounded) borderRadius = 16 + r;

    // Shadow composition
    var shadowParts = [];
    if (frame.baseShadow) shadowParts.push(frame.baseShadow);

    if (frame.neon && frame.neonColor) {
        var nc = frame.neonColor;
        // Scale glow with shadow slider
        var gi  = 0.75 + (s / 100) * 0.25;
        var gs1 = 12 + Math.round(s * 0.3);
        var gs2 = 30 + Math.round(s * 0.5);
        shadowParts.push('0 0 ' + gs1 + 'px ' + nc + gi.toFixed(2) + ')');
        shadowParts.push('0 0 ' + gs2 + 'px ' + nc + (gi * 0.5).toFixed(2) + ')');
        shadowParts.push('inset 0 0 18px ' + nc + '0.10)');
    } else if (s > 0) {
        var op = (s / 100) * 0.72;
        var sz = Math.round(4 + s * 0.44);
        shadowParts.push(
            '0 ' + Math.round(sz * 0.45) + 'px ' + sz + 'px rgba(0,0,0,' + op.toFixed(2) + ')'
        );
    }
    var boxShadow = shadowParts.length ? shadowParts.join(', ') : '';

    // Backdrop filter (frost glass)
    var bdFilter = frame.backdropBlur ? 'blur(20px) saturate(1.4)' : '';

    // Inner radius of the photo = outer radius minus border and padding (concentric corners). The preview and the
    // export both clip the picture to it, so the photo never pokes out of a rounded frame.
    var bwPx = 0;
    if (frame.border) { var bm = /^(\d+(?:\.\d+)?)px/.exec(frame.border); if (bm) bwPx = parseFloat(bm[1]); }
    var imageRadius = Math.max(0, Math.round(borderRadius - bwPx - Math.min(side, bottom)));

    return {
        imageRadius:    imageRadius,
        padding:        padT + 'px ' + padR + 'px ' + padB + 'px ' + padL + 'px',
        background:     bg,
        border:         frame.border   || '',
        borderRadius:   borderRadius + 'px',
        boxShadow:      boxShadow,
        backdropFilter: bdFilter
    };
}

// ===================== CONTAINER APPLIER =====================
// Applies the CSS for a given fitMode string to #imgContainer.
// Handles both legacy mode strings AND new frame IDs.
function _applyFitContainer(mode) {
    var container = document.getElementById('imgContainer');
    if (!container) return;
    container.style.cssText = '';  // reset all inline styles
    _setFrameImageRadius(null);

    // ── Legacy modes (kept for undo / history compatibility) ──
    switch (mode) {
        case 'white-frame':
            container.style.padding    = '24px';
            container.style.background = '#ffffff';
            return;
        case 'black-frame':
            container.style.padding    = '24px';
            container.style.background = '#000000';
            return;
        case 'blur-bg':
            container.style.padding         = '20px';
            container.style.background      = 'rgba(255,255,255,0.05)';
            container.style.backdropFilter  = 'blur(20px)';
            container.style.webkitBackdropFilter = 'blur(20px)';
            return;
        case 'neon-glow':
            container.style.boxShadow =
                '0 0 30px rgba(124,58,237,0.5), 0 0 60px rgba(219,39,119,0.3)';
            return;
        case 'shadow-border':
            container.style.border    = '3px solid #111';
            container.style.boxShadow = '0 12px 40px rgba(0,0,0,0.8)';
            return;
        case 'gradient-frame':
            container.style.padding    = '16px';
            container.style.background = 'linear-gradient(135deg,#7c3aed,#db2777)';
            return;
        case 'normal':
        case '':
        case 'none':
            return;
    }

    // ── New frame system — look up by id ──
    var frame = _findFrame(mode);
    if (!frame || frame.id === 'none') return;

    var css = _buildFrameCSS(frame, frameControls);
    if (!css) return;

    _setFrameImageRadius(css.imageRadius);
    container.style.padding       = css.padding;
    container.style.background    = css.background;
    if (css.border)         container.style.border         = css.border;
    if (css.borderRadius)   container.style.borderRadius   = css.borderRadius;
    if (css.boxShadow)      container.style.boxShadow      = css.boxShadow;
    if (css.backdropFilter) {
        container.style.backdropFilter        = css.backdropFilter;
        container.style.webkitBackdropFilter  = css.backdropFilter;
    }
}

// Round the photo (and the held "Original" overlay) to the frame's inner radius; null = stylesheet default.
function _setFrameImageRadius(px) {
    var ids = ['mainImg', 'compareImg'];
    for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.style.borderRadius = (px === null || px === undefined) ? '' : px + 'px';
    }
}

// Helper: find a frame definition by id
function _findFrame(id) {
    for (var i = 0; i < FRAME_DEFS.length; i++) {
        if (FRAME_DEFS[i].id === id) return FRAME_DEFS[i];
    }
    return null;
}

// ===================== FRAME STATE (history / reset) =====================
var _FRAME_DEFAULTS = { thickness: 20, radius: 0, shadow: 0, padding: 0, useCustomColor: false, customColor: '#ffffff' };

// Snapshot of EVERYTHING that defines the frame (stored in every history state, read by the export).
function getFrameState() {
    return {
        id: activeFrameId,
        controls: {
            thickness:      frameControls.thickness,
            radius:         frameControls.radius,
            shadow:         frameControls.shadow,
            padding:        frameControls.padding,
            useCustomColor: frameControls.useCustomColor,
            customColor:    frameControls.customColor
        }
    };
}

// Restore a snapshot: id, controls, container CSS and all frame UI (sliders, colour, grid highlight).
// `controls: null` keeps the current controls (used for states saved before V19).
function setFrameState(st) {
    var id = (st && st.id) || 'none';
    if (id !== 'none' && !_findFrame(id)) id = 'none';
    if (st && st.controls) {
        for (var k in _FRAME_DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(_FRAME_DEFAULTS, k) && st.controls[k] !== undefined) {
                frameControls[k] = st.controls[k];
            }
        }
    }
    activeFrameId = id;
    _applyFitContainer(id !== 'none' ? id : fitMode);
    syncFrameUI();
}

// Back to "no frame" with default controls (new photo, Reset all, AI result that replaces the image).
function resetFrameState() {
    for (var k in _FRAME_DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(_FRAME_DEFAULTS, k)) frameControls[k] = _FRAME_DEFAULTS[k];
    }
    activeFrameId = 'none';
    fitMode = 'normal';
    var container = document.getElementById('imgContainer');
    if (container) container.style.cssText = '';
    _setFrameImageRadius(null);
    syncFrameUI();
}

// Push the in-memory frame state into the panel (no history side effects).
function syncFrameUI() {
    _setSliderAndLabel('fc-thickness', 'fc-thickness-val', frameControls.thickness);
    _setSliderAndLabel('fc-radius',    'fc-radius-val',    frameControls.radius);
    _setSliderAndLabel('fc-shadow',    'fc-shadow-val',    frameControls.shadow);
    _setSliderAndLabel('fc-padding',   'fc-padding-val',   frameControls.padding);
    var colorEl = document.getElementById('fc-color');
    if (colorEl) colorEl.value = frameControls.customColor;
    _syncFrameColorUI();
    if (document.getElementById('frameGrid')) renderFrameGrid(activeFrameCat);
}

// Y13: colour picker + On/Off switch follow what the ACTIVE frame supports.
function _syncFrameColorUI() {
    var frame = _findFrame(activeFrameId);
    var supported = !frame || frame.id === 'none' || _frameSupportsCustomColor(frame);
    var on = supported && frameControls.useCustomColor;
    var colorEl = document.getElementById('fc-color');
    var btn = document.getElementById('fc-color-toggle');
    var row = btn ? btn.parentNode : null;
    var note = document.getElementById('fc-color-note');
    if (btn) {
        btn.textContent = window.t(on ? 'stateOn' : 'off');
        btn.classList.toggle('on', on);
        btn.disabled = !supported;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (colorEl) colorEl.disabled = !supported;
    if (row) row.classList.toggle('is-disabled', !supported);
    if (note) note.hidden = supported;
}

// ===================== NEW FRAME FUNCTIONS =====================

// Apply a frame by ID (from thumbnail click)
function applyFrame(id) {
    activeFrameId = id;
    fitMode       = id;   // keep fitMode in sync for undo
    _applyFitContainer(id);
    renderFrameGrid(activeFrameCat);
    setTimeout(function() {
        if (typeof overlayManager !== 'undefined' && overlayManager.resizeCanvas) {
            overlayManager.resizeCanvas();
        }
    }, 300);
    _syncFrameColorUI();
    saveToHistory();
}

// Filter the grid to a specific category
function filterFrameCat(cat, el) {
    activeFrameCat = cat;
    var chips = document.querySelectorAll('.frame-cat');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
    if (el) el.classList.add('active');
    renderFrameGrid(cat);
}

// Render the frame thumbnails for the given category
function renderFrameGrid(cat) {
    var grid = document.getElementById('frameGrid');
    if (!grid) return;
    grid.innerHTML = '';

    var list = (cat === 'all')
        ? FRAME_DEFS
        : FRAME_DEFS.filter(function(f) { return f.cat === cat; });

    for (var i = 0; i < list.length; i++) {
        (function(frame) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'frame-item' + (frame.id === activeFrameId ? ' active' : '');
            item.setAttribute('aria-pressed', frame.id === activeFrameId ? 'true' : 'false');
            item.setAttribute('aria-label', frame.name);
            item.onclick = function() { applyFrame(frame.id); };

            // Thumbnail
            var thumb = document.createElement('div');
            thumb.className = 'frame-thumb';

            if (frame.id === 'none') {
                // "None" — show the checkerboard BG colour
                thumb.style.background = frame.thumb;
            } else {
                // Outer = frame colour; inner div = photo area
                thumb.style.background = frame.thumb;
                if (frame.neon && frame.neonColor) {
                    thumb.style.boxShadow =
                        '0 0 8px ' + frame.neonColor + '0.9),' +
                        '0 0 18px ' + frame.neonColor + '0.5)';
                }
                var inner = document.createElement('div');
                inner.className = 'frame-thumb-img-placeholder';
                thumb.appendChild(inner);
            }

            // Label
            var label = document.createElement('span');
            label.textContent = frame.name;

            item.appendChild(thumb);
            item.appendChild(label);
            grid.appendChild(item);
        })(list[i]);
    }
}

// Called by every frame-control slider
function onFrameControlChange(key) {
    // Read all sliders
    var tEl = document.getElementById('fc-thickness');
    var rEl = document.getElementById('fc-radius');
    var sEl = document.getElementById('fc-shadow');
    var pEl = document.getElementById('fc-padding');

    if (tEl) frameControls.thickness = parseInt(tEl.value, 10);
    if (rEl) frameControls.radius    = parseInt(rEl.value, 10);
    if (sEl) frameControls.shadow    = parseInt(sEl.value, 10);
    if (pEl) frameControls.padding   = parseInt(pEl.value, 10);

    // Update value labels
    _updateFrameValLabel('fc-thickness', 'fc-thickness-val');
    _updateFrameValLabel('fc-radius',    'fc-radius-val');
    _updateFrameValLabel('fc-shadow',    'fc-shadow-val');
    _updateFrameValLabel('fc-padding',   'fc-padding-val');

    // Re-apply if a frame is active
    if (activeFrameId && activeFrameId !== 'none') {
        _applyFitContainer(activeFrameId);
        if (typeof scheduleHistorySave === 'function') scheduleHistorySave();   // R6: undoable
    }
}

function _updateFrameValLabel(sliderId, labelId) {
    var sl = document.getElementById(sliderId);
    var lb = document.getElementById(labelId);
    if (sl && lb) lb.textContent = sl.value;
}

// Called when the colour picker value changes
function onFrameColorChange() {
    var colorEl = document.getElementById('fc-color');
    if (colorEl) frameControls.customColor = colorEl.value;
    if (frameControls.useCustomColor && activeFrameId && activeFrameId !== 'none' && _frameSupportsCustomColor(_findFrame(activeFrameId))) {
        _applyFitContainer(activeFrameId);
        if (typeof scheduleHistorySave === 'function') scheduleHistorySave();   // R6: undoable
    }
}

// Toggle custom colour override on/off
function toggleFrameCustomColor() {
    var frame = _findFrame(activeFrameId);
    if (frame && frame.id !== 'none' && !_frameSupportsCustomColor(frame)) return;   // not valid for this frame
    frameControls.useCustomColor = !frameControls.useCustomColor;
    _syncFrameColorUI();
    if (activeFrameId && activeFrameId !== 'none') {
        _applyFitContainer(activeFrameId);
        saveToHistory();                                                         // R6: undoable
    }
}

// Reset all controls to defaults
function resetFrameControls() {
    frameControls.thickness      = 20;
    frameControls.radius         = 0;
    frameControls.shadow         = 0;
    frameControls.padding        = 0;
    frameControls.useCustomColor = false;
    frameControls.customColor    = '#ffffff';

    _setSliderAndLabel('fc-thickness', 'fc-thickness-val', 20);
    _setSliderAndLabel('fc-radius',    'fc-radius-val',    0);
    _setSliderAndLabel('fc-shadow',    'fc-shadow-val',    0);
    _setSliderAndLabel('fc-padding',   'fc-padding-val',   0);

    var colorEl = document.getElementById('fc-color');
    if (colorEl) colorEl.value = '#ffffff';

    _syncFrameColorUI();

    if (activeFrameId && activeFrameId !== 'none') {
        _applyFitContainer(activeFrameId);
        saveToHistory();                                                         // R6: undoable
    }
}

function _setSliderAndLabel(sliderId, labelId, value) {
    var sl = document.getElementById(sliderId);
    var lb = document.getElementById(labelId);
    if (sl) sl.value = value;
    if (lb) lb.textContent = value;
}

// Language switch: the On/Off label and the frame list are re-rendered in the new language.
document.addEventListener('yofilter:i18n', function () { _syncFrameColorUI(); if (document.getElementById('frameGrid')) renderFrameGrid(activeFrameCat); });

// ===================== AUTO-INIT =====================
// Renders the frame grid as soon as the DOM is ready.
(function () {
    function _initFrameGrid() {
        if (document.getElementById('frameGrid')) {
            renderFrameGrid('all');
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initFrameGrid);
    } else {
        _initFrameGrid();
    }
})();
})(globalThis);
