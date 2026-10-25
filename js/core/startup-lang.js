// startup-lang.js - extracted verbatim from the inline <script> at the end of index.html (Task P1.5).
// Loaded with `defer` as the LAST script, so state.js (currentLanguage), i18n.js (applyI18n)
// are guaranteed to be initialised before it runs.
(function () {
    // Load saved language from localStorage before anything renders
    try {
        var saved = localStorage.getItem('yofilter_language');
        if (saved === 'ar' || saved === 'en') {
            currentLanguage = saved;
        }
    } catch (e) {}

    // Apply translations immediately
    if (typeof window.applyI18n === 'function') {
        window.applyI18n();
    }

    // Curves channel buttons (Red / Green / Blue / Reset) are translated like every other label (data-i18n).
    document.addEventListener('DOMContentLoaded', function () {
        // Re-apply i18n after full DOM is ready
        if (typeof window.applyI18n === 'function') {
            window.applyI18n();
        }

        // Sync language button state
        var btns = document.querySelectorAll('#settingsPage .opt-box[data-lang]');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.remove('active');
            if (btns[i].getAttribute('data-lang') === currentLanguage) {
                btns[i].classList.add('active');
            }
        }
    });
})();
