// ============================================================
// color-mix.js
// ============================================================
// ==================== COLOR MIX ====================
(function (g) {
// V27 module "color-mix": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('color-mix', {
  adjustColorMix: [() => adjustColorMix, (v) => { adjustColorMix = v; }],
  onColorMixChange: [() => onColorMixChange, (v) => { onColorMixChange = v; }],
  renderColorMix: [() => renderColorMix, (v) => { renderColorMix = v; }],
});
var MIX_COLOR_KEYS = ['mixRed', 'mixOrange', 'mixYellow', 'mixGreen', 'mixAqua', 'mixBlue', 'mixPurple', 'mixMagenta'];   // same order as baseColors

function renderColorMix() {
    const container = document.getElementById('mixCircles');
    container.innerHTML = '';
    for (let i = 0; i < baseColors.length; i++) {
        const color = baseColors[i];
        const dot = document.createElement('button');       // Y17: a real button, named for screen readers
        dot.type = 'button';
        dot.className = i === activeColorIndex ? 'color-dot active' : 'color-dot';
        dot.setAttribute('aria-pressed', i === activeColorIndex ? 'true' : 'false');
        dot.setAttribute('aria-label', window.t(MIX_COLOR_KEYS[i] || 'ariaMixColors'));
        dot.style.backgroundColor = color;
        dot.onclick = function() {
            activeColorIndex = i;
            const dots = document.querySelectorAll('.color-dot');
            for (let d = 0; d < dots.length; d++) dots[d].classList.remove('active');
            dot.classList.add('active');
            document.getElementById('mix-hue').value = colorMixData[i].hue;
            document.getElementById('mix-sat').value = colorMixData[i].sat;
            document.getElementById('mix-lum').value = colorMixData[i].lum;
            document.getElementById('v-hue').innerText = colorMixData[i].hue;
            document.getElementById('v-sat-mix').innerText = colorMixData[i].sat;
            document.getElementById('v-lum').innerText = colorMixData[i].lum;
        };
        container.appendChild(dot);
    }
}

function onColorMixChange() {
    const h = parseInt(document.getElementById('mix-hue').value);
    const s = parseInt(document.getElementById('mix-sat').value);
    const l = parseInt(document.getElementById('mix-lum').value);
    colorMixData[activeColorIndex] = { hue: h, sat: s, lum: l };
    document.getElementById('v-hue').innerText = h;
    document.getElementById('v-sat-mix').innerText = s;
    document.getElementById('v-lum').innerText = l;
    applyAllEdits();
    scheduleHistorySave();
}

function adjustColorMix(prop, dir) {
    const slider = document.getElementById('mix-' + prop);
    let val = parseInt(slider.value) + (dir * 1);
    val = Math.max(-100, Math.min(100, val));
    slider.value = val;
    onColorMixChange();
}

// colour names are translated: rebuild the dots when the language changes
document.addEventListener('yofilter:i18n', function () { if (document.getElementById('mixCircles')) renderColorMix(); });
})(globalThis);
