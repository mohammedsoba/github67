// ============================================================
// navigation.js
// ============================================================
// ==================== NAVIGATION ====================
// R14: the crop box / Apply bar belong to the Crop tab only. Leaving it (main tab or sub-tab) always
// cancels crop mode so the overlay can never linger over other tools or swallow their taps.
(function (g) {
// V27 module "navigation": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('navigation', {
  closeAboutPage: [() => closeAboutPage, (v) => { closeAboutPage = v; }],
  closeSettingsPage: [() => closeSettingsPage, (v) => { closeSettingsPage = v; }],
  closeTopmostLayer: [() => closeTopmostLayer, (v) => { closeTopmostLayer = v; }],
  isBackBlockedByBusy: [() => isBackBlockedByBusy, (v) => { isBackBlockedByBusy = v; }],
  openAboutPage: [() => openAboutPage, (v) => { openAboutPage = v; }],
  openSettingsPage: [() => openSettingsPage, (v) => { openSettingsPage = v; }],
  setLanguage: [() => setLanguage, (v) => { setLanguage = v; }],
  switchMainNav: [() => switchMainNav, (v) => { switchMainNav = v; }],
  switchSubTab: [() => switchSubTab, (v) => { switchSubTab = v; }],
  topmostLayerName: [() => topmostLayerName, (v) => { topmostLayerName = v; }],
});
function _leaveCropIfActive(nextSubTabId) {
    if (typeof isCropMode !== 'undefined' && isCropMode && nextSubTabId !== 'p-crop' &&
        typeof cancelCrop === 'function') {
        cancelCrop();
    }
}

function switchMainNav(tab, element) {
    _leaveCropIfActive(null);
    var tabs = document.querySelectorAll('.nav-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    if (element) element.classList.add('active');

    document.getElementById('editSubMenu').style.display = 'none';
    var _tools = document.getElementById('toolsSubMenu'); if (_tools) _tools.style.display = 'none';
    var _tsm = document.getElementById('textSubMenu'); if (_tsm) _tsm.style.display = 'none';
    var sections = document.querySelectorAll('.panel-content .tab-section');
    for (var j = 0; j < sections.length; j++) {
        sections[j].style.display = 'none';
        sections[j].classList.remove('active');
    }

    if (tab === 'edit') {
        document.getElementById('editSubMenu').style.display = 'flex';
        document.getElementById('p-presets').style.display = 'block';
        document.getElementById('p-presets').classList.add('active');
        var btns = document.querySelectorAll('#editSubMenu .sub-btn');
        for (var b = 0; b < btns.length; b++) btns[b].classList.remove('active');
        btns[0].classList.add('active');
    } else if (tab === 'ai') {
        if (_tools) _tools.style.display = 'flex';
        var abtns = document.querySelectorAll('#toolsSubMenu .sub-btn');
        for (var ab = 0; ab < abtns.length; ab++) abtns[ab].classList.remove('active');
        if (abtns[0]) abtns[0].classList.add('active');
        var eraser = document.getElementById('p-eraser');
        if (eraser) { eraser.style.display = 'block'; eraser.classList.add('active'); }
        if (window.MagicEraser && typeof window.MagicEraser.ensureCurrentImage === 'function') {
            window.MagicEraser.ensureCurrentImage();
        }
    } else if (tab === 'fit') {
        document.getElementById('p-fit-panel').style.display = 'block';
    }
    if (window.MagicEraser && typeof window.MagicEraser.refreshActive === 'function') {
        window.MagicEraser.refreshActive();
    }
    if (typeof window.syncPortraitFocusMode === 'function') window.syncPortraitFocusMode();
}

function switchSubTab(subTabId, element) {
    _leaveCropIfActive(subTabId);
    if (subTabId.startsWith('p-') && document.getElementById('editSubMenu').style.display !== 'none') {
        var ebtns = document.querySelectorAll('#editSubMenu .sub-btn');
        for (var i = 0; i < ebtns.length; i++) ebtns[i].classList.remove('active');
        if (element) element.classList.add('active');
    } else if (subTabId.startsWith('p-') && document.getElementById('toolsSubMenu') && document.getElementById('toolsSubMenu').style.display !== 'none') {
        var tbtns = document.querySelectorAll('#toolsSubMenu .sub-btn');
        for (var j = 0; j < tbtns.length; j++) tbtns[j].classList.remove('active');
        if (element) element.classList.add('active');
    } else if (subTabId.startsWith('p-') && (document.getElementById('textSubMenu') && document.getElementById('textSubMenu').style.display !== 'none')) {
        var xbtns = document.querySelectorAll('#textSubMenu .sub-btn');
        for (var k = 0; k < xbtns.length; k++) xbtns[k].classList.remove('active');
        if (element) element.classList.add('active');
    }
    var sections = document.querySelectorAll('.panel-content .tab-section');
    for (var s = 0; s < sections.length; s++) {
        if (sections[s].id === 'p-fit-panel') continue;
        sections[s].style.display = 'none';
        sections[s].classList.remove('active');
    }
    var target = document.getElementById(subTabId);
    if (target) {
        target.style.display = 'block';
        target.classList.add('active');
    }
    if (subTabId === 'p-crop' && typeof activateCropMode === 'function' && originalImage) {
        var activeBox = document.querySelector('#p-crop .opt-box.active') ||
                        document.querySelector('#p-crop .opt-box');
        var currentRatio = (typeof cropRatio !== 'undefined' && cropRatio) ? cropRatio : 'free';
        activateCropMode(currentRatio, activeBox);
    }
    if (subTabId === 'p-eraser' && window.MagicEraser && typeof window.MagicEraser.ensureCurrentImage === 'function') {
        window.MagicEraser.ensureCurrentImage();
    }
    if (subTabId === 'p-portrait' && typeof window.onPortraitTabEnter === 'function') {
        window.onPortraitTabEnter();
    }
    if (window.MagicEraser && typeof window.MagicEraser.refreshActive === 'function') {
        window.MagicEraser.refreshActive();
    }
    if (typeof window.syncPortraitFocusMode === 'function') window.syncPortraitFocusMode();
}

// ── Language ───────────────────────────────────────────────────
function setLanguage(lang) {
    currentLanguage = lang;

    // Persist to localStorage so it survives app restart
    try { localStorage.setItem('yofilter_language', lang); } catch (e) {}

    // Update active button state
    var btns = document.querySelectorAll('#settingsPage .opt-box[data-lang]');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove('active');
        if (btns[i].getAttribute('data-lang') === lang) btns[i].classList.add('active');
    }

    // Apply all translations + RTL
    if (typeof window.applyI18n === 'function') window.applyI18n();
}

// Settings page navigation
// ---- Settings / About: full-screen dialogs (styles in css/settings.css) ----
// Y4: dialog semantics - aria-hidden toggled, focus moves into the dialog and returns to the opener,
// Escape and the Android hardware Back button close the TOP-most layer (see closeTopmostLayer()).
function _sheetOpen(id, focusId) {
    var el = document.getElementById(id);
    if (!el) return;
    el._opener = document.activeElement;
    el.style.display = 'block';
    el.setAttribute('aria-hidden', 'false');
    var f = document.getElementById(focusId);
    if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
}

function _sheetClose(id) {
    var el = document.getElementById(id);
    if (!el || el.style.display !== 'block') return;
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
    var opener = el._opener;
    el._opener = null;
    if (opener && opener.focus && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
}

function openSettingsPage() {
    _sheetOpen('settingsPage', 'settingsBackBtn');
    // Sync button state
    var btns = document.querySelectorAll('#settingsPage .opt-box[data-lang]');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove('active');
        if (btns[i].getAttribute('data-lang') === currentLanguage) btns[i].classList.add('active');
    }
}

function closeSettingsPage() {
    closeAboutPage();
    _sheetClose('settingsPage');
}

// About App sub-page
function openAboutPage() { _sheetOpen('aboutPage', 'aboutBackBtn'); }

function closeAboutPage() { _sheetClose('aboutPage'); }

// ---- Back / Escape: close the TOP-most open UI layer ------------------------------------------------------
// G13: every dismissible layer is listed ONCE, in z-order (top first). Back / Escape closes the first one that is
// open and reports it; only when none is open does the Cordova handler (js/core/init.js) start the double-press
// exit. Each entry is self-guarding (missing element / module => "not open"), so the list is safe to evaluate at any time.
function _el(id) { return document.getElementById(id); }

var BACK_LAYERS = [
    // 1. A running operation that offers Cancel (AI erase, portrait, ...): Back == tapping Cancel.
    { name: 'loading',
      isOpen: function () { var o = _el('loadingOverlay'), b = _el('loadingCancel'); return !!(o && o.classList.contains('active') && b && !b.hidden); },
      close: function () { var b = _el('loadingCancel'); if (b.click) b.click(); else if (b.onclick) b.onclick(); } },
    // 2-3. Full-screen pages (About sits above Settings)
    { name: 'about',    isOpen: function () { var e = _el('aboutPage');    return !!(e && e.style.display === 'block'); }, close: function () { closeAboutPage(); } },
    { name: 'settings', isOpen: function () { var e = _el('settingsPage'); return !!(e && e.style.display === 'block'); }, close: function () { closeSettingsPage(); } },
    // 4-5. Modals
    { name: 'export',   isOpen: function () { var e = _el('exportModal');  return !!(e && e.classList.contains('active')); }, close: function () { closeExportModal(); } },
    { name: 'premium',  isOpen: function () { var e = _el('premiumModal'); return !!(e && e.classList.contains('active')) && typeof closePremiumModal === 'function'; }, close: function () { closePremiumModal(); } },
    // 6. Crop mode (box + Apply bar)
    { name: 'crop',     isOpen: function () { return typeof isCropMode !== 'undefined' && !!isCropMode && typeof cancelCrop === 'function'; }, close: function () { cancelCrop(); } },
    // 7. Portrait "Set Focus" mode (next tap would set the focal point)
    { name: 'portrait-focus',
      isOpen: function () { return typeof window.isPortraitFocusModeActive === 'function' && window.isPortraitFocusModeActive(); },
      close: function () { window.exitPortraitFocusMode(); } },
    // 8. A selected text / sticker / watermark overlay (handles visible): Back deselects it
    { name: 'overlay-selection',
      isOpen: function () { return typeof overlayManager !== 'undefined' && !!overlayManager && !!overlayManager.selectedId &&
                                   !overlayManager.isDragging && !overlayManager.isResizing && !overlayManager.isRotating; },
      close: function () { overlayManager.selectedId = null; overlayManager.render(); } }
];

// Name of the top-most open layer, or null. (Read-only: used by tests and diagnostics.)
function topmostLayerName() {
    for (var i = 0; i < BACK_LAYERS.length; i++) {
        var layer = BACK_LAYERS[i], open = false;
        try { open = layer.isOpen(); } catch (e) { open = false; }
        if (open) return layer.name;
    }
    return null;
}

// Close the top-most open layer. Returns true if something was closed. Shared by Escape and the Android Back button.
function closeTopmostLayer() {
    var name = topmostLayerName();
    if (!name) return false;
    for (var i = 0; i < BACK_LAYERS.length; i++) {
        if (BACK_LAYERS[i].name === name) { BACK_LAYERS[i].close(); return true; }
    }
    return false;
}

// True while a NON-cancellable operation (export / save / AI step without a Cancel button) holds the loading overlay.
// Back must not silently exit the app in the middle of a save, so the handler warns first (see init.js).
function isBackBlockedByBusy() {
    var o = _el('loadingOverlay'), b = _el('loadingCancel');
    return !!(o && o.classList.contains('active') && !(b && !b.hidden));
}
})(globalThis);
