// ============================================================
// edge-model-ui.js  -  non-blocking progress card for the one-time AI model download (EN / AR)
// ============================================================
// A small floating glass card (css/edge-ai.css): title, 0-100 % bar, "x / y MB", and a Retry / Cancel button.
// It never covers the editor with an overlay - the photo and the other tools stay usable while the model downloads.
//
// It follows YoEdgeModel.subscribe() and shows itself only while there is something to say:
//   downloading / verifying  -> progress          failed  -> localised reason + Retry
//   runtime phase 'starting' -> only right after a download (a cached model starts silently)
// Duplicate triggers cannot stack cards: there is exactly ONE card element, and YoEdgeModel.ensure() is single-flight.
//
// Public API (global YoEdgeModelUI)
//   setPhase('starting' | 'ready' | 'idle')       runtime phase reported by js/portrait/edge-portrait.js
//   showError(code)                                a non-download failure (e.g. 'runtime')
//   onRetry(fn)                                    fn() is called when the user taps Retry
//   hide()                                         hides the card at once
// ============================================================
var YoEdgeModelUI = (function () {
    'use strict';

    var HIDE_AFTER_READY_MS = 1400;
    var card = null, els = {};
    var retryHandler = null;
    var shownForDownload = false;      // a download happened in this session -> the 'starting' phase is worth showing
    var hideTimer = null;
    var errorCode = '';                // failure from outside YoEdgeModel (runtime)
    var phase = 'idle';

    var ERROR_KEYS = {
        'offline': 'edgeErrOffline', 'network': 'edgeErrNetwork', 'http': 'edgeErrHttp', 'size': 'edgeErrCorrupt',
        'hash': 'edgeErrCorrupt', 'quota': 'edgeErrQuota', 'runtime': 'edgeErrRuntime', 'unsupported': 'edgeErrGeneric'
    };

    function tr(key, params) {
        try { if (typeof window !== 'undefined' && typeof window.t === 'function') return window.t(key, params); } catch (e) { /* fall through */ }
        return key;
    }

    function build() {
        if (card) return card;
        card = document.createElement('div');
        card.id = 'edgeAiCard';
        card.className = 'edge-ai-card';
        card.setAttribute('role', 'status');
        card.setAttribute('aria-live', 'polite');
        card.hidden = true;

        var head = document.createElement('div'); head.className = 'edge-ai-head';
        els.title = document.createElement('span'); els.title.className = 'edge-ai-title';
        els.pct = document.createElement('span'); els.pct.className = 'edge-ai-pct';
        head.appendChild(els.title); head.appendChild(els.pct);

        els.bar = document.createElement('div'); els.bar.className = 'edge-ai-bar';
        els.bar.setAttribute('role', 'progressbar');
        els.bar.setAttribute('aria-valuemin', '0'); els.bar.setAttribute('aria-valuemax', '100');
        els.fill = document.createElement('span'); els.fill.className = 'edge-ai-fill';
        els.bar.appendChild(els.fill);

        els.sub = document.createElement('div'); els.sub.className = 'edge-ai-sub';

        var actions = document.createElement('div'); actions.className = 'edge-ai-actions';
        els.retry = document.createElement('button'); els.retry.type = 'button'; els.retry.className = 'edge-ai-btn primary';
        els.cancel = document.createElement('button'); els.cancel.type = 'button'; els.cancel.className = 'edge-ai-btn';
        actions.appendChild(els.retry); actions.appendChild(els.cancel);

        card.appendChild(head); card.appendChild(els.bar); card.appendChild(els.sub); card.appendChild(actions);

        els.retry.addEventListener('click', function () {
            errorCode = '';
            if (typeof retryHandler === 'function') {
                try { retryHandler(); } catch (err) { if (typeof console !== 'undefined') console.error('[edge-ui] retry failed', err); }
            }
        });
        els.cancel.addEventListener('click', function () {
            if (typeof YoEdgeModel !== 'undefined') YoEdgeModel.cancel();
            hide();
        });
        (document.body || document.documentElement).appendChild(card);
        return card;
    }

    function setBar(percent, indeterminate) {
        els.bar.classList.toggle('indeterminate', !!indeterminate);
        if (indeterminate) { els.bar.removeAttribute('aria-valuenow'); els.fill.style.transform = ''; return; }
        els.bar.setAttribute('aria-valuenow', String(percent));
        els.fill.style.transform = 'scaleX(' + (percent / 100).toFixed(4) + ')';          // GPU-friendly: transform only
    }

    function mb(bytes) { return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1); }

    function show() {
        build();
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        card.hidden = false;
        card.classList.add('on');
    }

    function hide() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (!card) return;
        card.classList.remove('on');
        card.hidden = true;
    }

    function renderError(code) {
        show();
        card.classList.add('error');
        els.title.textContent = tr(ERROR_KEYS[code] || 'edgeErrGeneric', { status: '' }).replace(/\s*\(\s*\)/, '');
        els.pct.textContent = '';
        els.sub.textContent = '';
        setBar(0, false);
        els.retry.textContent = tr('edgeRetry');
        els.cancel.textContent = tr('cancel');
        els.retry.hidden = false;
        els.cancel.hidden = false;
    }

    function render(s) {
        if (!s) s = YoEdgeModel.state();
        if (errorCode) { renderError(errorCode); return; }
        if (s.status === 'downloading' || s.status === 'verifying') {
            shownForDownload = true;
            show();
            card.classList.remove('error');
            var verifying = s.status === 'verifying';
            els.title.textContent = tr(verifying ? 'edgeVerifying' : 'edgePreparing');
            els.pct.textContent = verifying ? '' : s.percent + '%';
            els.sub.textContent = verifying ? '' : tr('edgeMb', { done: mb(s.loaded), total: mb(s.total) });
            setBar(s.percent, verifying);
            els.retry.hidden = true;
            els.cancel.hidden = verifying;                    // the checksum pass is short and not cancellable
            els.cancel.textContent = tr('cancel');
        } else if (s.status === 'failed' && s.error) {
            renderError(s.error.code);
            if (s.error.code === 'http') {
                els.title.textContent = tr('edgeErrHttp', { status: s.error.status || '' });
            }
        } else if (phase === 'starting' && shownForDownload) {
            show();
            card.classList.remove('error');
            els.title.textContent = tr('edgeStarting');
            els.pct.textContent = '';
            els.sub.textContent = '';
            setBar(100, true);
            els.retry.hidden = true; els.cancel.hidden = true;
        } else if ((s.status === 'ready' || phase === 'ready') && card && !card.hidden && !card.classList.contains('error')) {
            card.classList.remove('error');
            els.title.textContent = tr('edgeReady');
            els.pct.textContent = '100%';
            els.sub.textContent = '';
            setBar(100, false);
            els.retry.hidden = true; els.cancel.hidden = true;
            if (!hideTimer) hideTimer = setTimeout(hide, HIDE_AFTER_READY_MS);
        } else if (s.status === 'idle' && !errorCode) {
            hide();                                           // cancelled
        }
    }

    function setPhase(p) { phase = p; render(); }
    function showError(code) { errorCode = code || 'runtime'; render(); }
    function onRetry(fn) { retryHandler = fn; }

    if (typeof YoEdgeModel !== 'undefined') YoEdgeModel.subscribe(render);

    return { setPhase: setPhase, showError: showError, onRetry: onRetry, hide: hide, _render: render };
})();
