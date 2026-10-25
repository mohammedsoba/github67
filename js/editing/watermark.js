// ============================================================
// watermark.js
// ============================================================
// ==================== WATERMARK SYSTEM ====================
// Y16: the small "yf" mark on exported photos is a user setting (Settings > "Watermark on exports").
// Default ON (the behaviour before V22); the choice is stored in localStorage ('yofilter_watermark').
(function (g) {
// V27 module "watermark": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('watermark', {
  drawWatermark: [() => drawWatermark, (v) => { drawWatermark = v; }],
  isWatermarkEnabled: [() => isWatermarkEnabled, (v) => { isWatermarkEnabled = v; }],
  setWatermarkEnabled: [() => setWatermarkEnabled, (v) => { setWatermarkEnabled = v; }],
  toggleWatermarkSetting: [() => toggleWatermarkSetting, (v) => { toggleWatermarkSetting = v; }],
});
var WATERMARK_STORAGE_KEY = 'yofilter_watermark';
var _watermarkEnabled = true;

(function loadWatermarkSetting() {
    try { if (localStorage.getItem(WATERMARK_STORAGE_KEY) === 'off') _watermarkEnabled = false; } catch (e) {}
})();

function isWatermarkEnabled() { return _watermarkEnabled; }

function setWatermarkEnabled(on) {
    _watermarkEnabled = !!on;
    try { localStorage.setItem(WATERMARK_STORAGE_KEY, _watermarkEnabled ? 'on' : 'off'); } catch (e) {}
    syncWatermarkSwitch();
}

// Settings switch (role="switch"): keeps aria-checked and the visual state in sync.
function syncWatermarkSwitch() {
    var sw = document.getElementById('watermarkToggle');
    if (!sw) return;
    sw.setAttribute('aria-checked', _watermarkEnabled ? 'true' : 'false');
    sw.classList.toggle('active', _watermarkEnabled);
}

function toggleWatermarkSetting() {
    setWatermarkEnabled(!_watermarkEnabled);   // the switch itself is the feedback: no toast
}

document.addEventListener('DOMContentLoaded', syncWatermarkSwitch);

function drawWatermark(ctx, width, height) {
    if (!_watermarkEnabled) return;
    ctx.save();
    ctx.globalAlpha = 0.85;
    const fontSize = Math.max(14, Math.min(width, height) * 0.025);
    ctx.font = 'bold ' + fontSize + 'px "Inter", sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = fontSize * 0.08;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const text = 'yf';
    const padding = fontSize * 1.5;
    const x = width - padding;
    const y = height - padding;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
}
})(globalThis);
