// ============================================================
// color-mix-apply.js
// ============================================================
(function (g) {
// V27 module "color-mix-apply": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('color-mix-apply', {
  applyColorMix: [() => applyColorMix, (v) => { applyColorMix = v; }],
});
function applyColorMix(data, width, height) {
    // Strict Lightroom-style HSL isolation.
    // Each color channel affects ONLY pixels whose hue lies inside a bounded
    // window around that channel's center hue. Outside the window the weight
    // is exactly 0.0, so unrelated colors (sky, skin, etc.) remain untouched
    // when a single channel slider is moved.
    let hasAdjustment = false;
    for (let i = 0; i < colorMixData.length; i++) {
        if (colorMixData[i].hue !== 0 || colorMixData[i].sat !== 0 || colorMixData[i].lum !== 0) {
            hasAdjustment = true;
            break;
        }
    }
    if (!hasAdjustment) return;

    // Channel order must match the UI: Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta
    const targetHues = [0, 30, 60, 120, 180, 240, 270, 330];
    // Half-width of each channel's influence window (degrees). Beyond this
    // distance from the channel center, weight is strictly 0.
    const HALF_WINDOW = 45;
    // Saturation gate: near-gray pixels have an unreliable hue, so we fade
    // the effect out below this saturation threshold to avoid tinting grays.
    const SAT_GATE_LOW = 8;   // below this: zero effect
    const SAT_GATE_HIGH = 20; // above this: full effect

    // smoothstep(0..1) for a soft, non-pixelated falloff at the window edge.
    const smoothstep = function(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return t * t * (3 - 2 * t);
    };

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const hsl = rgbToHsl(r, g, b);
        const h = hsl[0];
        const s = hsl[1];
        const l = hsl[2];

        // Saturation gate: fully desaturated pixels have no meaningful hue,
        // so no color-mix channel should touch them.
        const satGate = smoothstep((s - SAT_GATE_LOW) / (SAT_GATE_HIGH - SAT_GATE_LOW));
        if (satGate <= 0) continue;

        let deltaH = 0;
        let deltaS = 0;
        let deltaL = 0;
        let anyWeight = false;

        for (let c = 0; c < 8; c++) {
            const cd = colorMixData[c];
            if (cd.hue === 0 && cd.sat === 0 && cd.lum === 0) continue;

            // Circular hue distance in degrees.
            let hueDiff = Math.abs(h - targetHues[c]);
            if (hueDiff > 180) hueDiff = 360 - hueDiff;

            // Hard cutoff: outside the window, weight = 0 exactly.
            if (hueDiff >= HALF_WINDOW) continue;

            // Smooth bell-like falloff inside the window: 1 at center, 0 at edge.
            const t = 1 - (hueDiff / HALF_WINDOW);
            const weight = smoothstep(t) * satGate;
            if (weight <= 0) continue;

            anyWeight = true;
            // NOTE: no averaging by totalWeight — that would erase the falloff.
            // Each channel contributes its own weighted delta directly.
            deltaH += cd.hue * weight;
            deltaS += cd.sat * weight;
            deltaL += cd.lum * weight;
        }

        if (!anyWeight) continue;

        // Scale factors match the perceptual response of Lightroom HSL panels.
        let newH = (h + deltaH * 0.6) % 360;
        if (newH < 0) newH += 360;
        const newS = Math.max(0, Math.min(100, s + deltaS * 0.8));
        const newL = Math.max(0, Math.min(100, l + deltaL * 0.5));

        const rgb = hslToRgb(newH, newS, newL);
        data[i]     = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
    }
}
})(globalThis);
