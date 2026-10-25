// ============================================================
// effects.js
// ============================================================
// ==================== EFFECT HELPERS ====================
(function (g) {
// V27 module "effects": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('effects', {
  applyBlacks: [() => applyBlacks, (v) => { applyBlacks = v; }],
  applyExposure: [() => applyExposure, (v) => { applyExposure = v; }],
  applyFastClarity: [() => applyFastClarity, (v) => { applyFastClarity = v; }],
  applyFastGrain: [() => applyFastGrain, (v) => { applyFastGrain = v; }],
  applyFastSharpness: [() => applyFastSharpness, (v) => { applyFastSharpness = v; }],
  applyFastVignette: [() => applyFastVignette, (v) => { applyFastVignette = v; }],
  applyShadows: [() => applyShadows, (v) => { applyShadows = v; }],
  applyTint: [() => applyTint, (v) => { applyTint = v; }],
  applyVibrance: [() => applyVibrance, (v) => { applyVibrance = v; }],
  applyWarmth: [() => applyWarmth, (v) => { applyWarmth = v; }],
  applyWhites: [() => applyWhites, (v) => { applyWhites = v; }],
  hslToRgb: [() => hslToRgb, (v) => { hslToRgb = v; }],
  rgbToHsl: [() => rgbToHsl, (v) => { rgbToHsl = v; }],
});
function applyShadows(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum < 128) {
            const intensity = (128 - lum) / 128;
            const adjustment = factor * intensity * 60;
            data[i] = Math.min(255, Math.max(0, r + adjustment));
            data[i+1] = Math.min(255, Math.max(0, g + adjustment));
            data[i+2] = Math.min(255, Math.max(0, b + adjustment));
        }
    }
}

function applyWhites(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum > 192) {
            const intensity = (lum - 192) / 63;
            const adjustment = factor * intensity * 50;
            data[i] = Math.min(255, Math.max(0, r + adjustment));
            data[i+1] = Math.min(255, Math.max(0, g + adjustment));
            data[i+2] = Math.min(255, Math.max(0, b + adjustment));
        }
    }
}

function applyBlacks(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum < 64) {
            const intensity = (64 - lum) / 64;
            const adjustment = factor * intensity * 40;
            data[i] = Math.min(255, Math.max(0, r + adjustment));
            data[i+1] = Math.min(255, Math.max(0, g + adjustment));
            data[i+2] = Math.min(255, Math.max(0, b + adjustment));
        }
    }
}

function applyTint(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        const adjustment = factor * 30;
        data[i] = Math.min(255, Math.max(0, data[i] + adjustment));
        data[i+1] = Math.min(255, Math.max(0, data[i+1] - adjustment * 0.5));
        data[i+2] = Math.min(255, Math.max(0, data[i+2] + adjustment));
    }
}

function applyVibrance(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 100;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const maxVal = Math.max(r, g, b);
        const minVal = Math.min(r, g, b);
        const sat = maxVal === 0 ? 0 : (maxVal - minVal) / maxVal;
        const intensity = (1 - sat) * factor;
        const avg = (r + g + b) / 3;
        data[i] = Math.min(255, Math.max(0, r + (r - avg) * intensity));
        data[i+1] = Math.min(255, Math.max(0, g + (g - avg) * intensity));
        data[i+2] = Math.min(255, Math.max(0, b + (b - avg) * intensity));
    }
}

function applyExposure(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const midWeight = 1 - Math.abs(lum - 128) / 128;
        const adjustment = factor * midWeight * 40;
        data[i] = Math.min(255, Math.max(0, r + adjustment));
        data[i+1] = Math.min(255, Math.max(0, g + adjustment));
        data[i+2] = Math.min(255, Math.max(0, b + adjustment));
    }
}

function applyWarmth(data, width, height, amount) {
    if (amount === 0) return;
    const factor = amount / 50;
    for (let i = 0; i < data.length; i += 4) {
        if (factor > 0) {
            data[i] = Math.min(255, data[i] + factor * 20);
            data[i+1] = Math.min(255, data[i+1] + factor * 10);
            data[i+2] = Math.min(255, Math.max(0, data[i+2] - factor * 15));
        } else {
            data[i] = Math.min(255, Math.max(0, data[i] + factor * 10));
            data[i+2] = Math.min(255, data[i+2] - factor * 20);
        }
    }
}

function applyFastSharpness(data, width, height, amount) {
    const factor = amount / 100;
    const temp = new Uint8ClampedArray(data);
    const w4 = width * 4;
    for (let y = 1; y < height - 1; y++) {
        const rowOffset = y * w4;
        for (let x = 4; x < w4 - 4; x += 4) {
            const idx = rowOffset + x;
            for (let c = 0; c < 3; c++) {
                const center = temp[idx + c];
                const edge = temp[idx + c - w4] + temp[idx + c + w4] + temp[idx + c - 4] + temp[idx + c + 4];
                data[idx + c] = Math.min(255, Math.max(0, center + (center * 4 - edge) * factor * 0.5));
            }
        }
    }
}

function applyFastClarity(data, amount) {
    const factor = amount / 100;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const protection = lum < 30 ? 0.3 : lum > 220 ? 0.5 : 1;
        const diff = factor * protection;
        data[i] = Math.min(255, Math.max(0, r + (r - lum) * diff));
        data[i+1] = Math.min(255, Math.max(0, g + (g - lum) * diff));
        data[i+2] = Math.min(255, Math.max(0, b + (b - lum) * diff));
    }
}

function applyFastVignette(data, width, height, amount) {
    if (amount === 0) return;
    // Same maths as the WebGL shader: distance in normalised UV space (0..1 on both axes) divided by
    // the corner distance (0.7071). Using UV space keeps preview (GPU) and export (CPU) identical,
    // including on non-square images.
    const strength = amount / 100;      // -100..100: negative = dark vignette, positive = light vignette
    const w4 = width * 4;
    for (let y = 0; y < height; y++) {
        const dv = (y + 0.5) / height - 0.5;
        const dv2 = dv * dv;
        const rowOffset = y * w4;
        for (let x = 0; x < width; x++) {
            const du = (x + 0.5) / width - 0.5;
            let t = Math.sqrt(du * du + dv2) / 0.7071;
            if (t > 1) t = 1;
            const falloff = t * t * (3 - 2 * t); // smoothstep
            const idx = rowOffset + x * 4;
            if (strength < 0) {
                const k = 1 + strength * falloff;
                data[idx]   = Math.max(0, Math.min(255, data[idx]   * k));
                data[idx+1] = Math.max(0, Math.min(255, data[idx+1] * k));
                data[idx+2] = Math.max(0, Math.min(255, data[idx+2] * k));
            } else {
                const k = strength * falloff;
                data[idx]   = Math.max(0, Math.min(255, data[idx]   + (255 - data[idx])   * k));
                data[idx+1] = Math.max(0, Math.min(255, data[idx+1] + (255 - data[idx+1]) * k));
                data[idx+2] = Math.max(0, Math.min(255, data[idx+2] + (255 - data[idx+2]) * k));
            }
        }
    }
}

function applyFastGrain(data, width, height, amount, seed) {
    // Deterministic per-pixel hash noise, same formula as the WebGL shader (u_grainSeed): the pattern is
    // identical in preview and export, does not flicker and does not depend on the export resolution.
    // `seed` is the session grain seed (YoPipeline.grainSeed(): fixed while editing one photo, re-rolled
    // on a new upload); it is added to both hash coordinates exactly like the shader does.
    seed = seed || 0;
    const scale = (amount / 100) * 50;
    const w4 = width * 4;
    for (let y = 0; y < height; y++) {
        const py = ((y + 0.5) / height) * 1080.0;
        for (let x = 0; x < width; x++) {
            const px = ((x + 0.5) / width) * 1920.0 + seed;
            const v = Math.sin(px * 12.9898 + (py + seed) * 78.233) * 43758.5453;
            const noise = (v - Math.floor(v) - 0.5) * scale;
            const i = y * w4 + x * 4;
            data[i]   = Math.min(255, Math.max(0, data[i]   + noise));
            data[i+1] = Math.min(255, Math.max(0, data[i+1] + noise));
            data[i+2] = Math.min(255, Math.max(0, data[i+2] + noise));
        }
    }
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch(max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = function(p, q, t) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
})(globalThis);
