// ============================================================
// overlay-manager.js
// ============================================================
// ==================== OVERLAY SYSTEM ====================
(function (g) {
// V27 module "overlay-manager": private helpers stay inside this closure; only the manifest below is shared. Body is intentionally not re-indented.
YF.expose('overlay-manager', {
  OverlayManager: [() => OverlayManager],
  overlayManager: [() => overlayManager, (v) => { overlayManager = v; }],
});
class OverlayManager {
    constructor() {
        this.items = [];
        this.selectedId = null;
        this.nextId = 1;
        this.isDragging = false;
        this.isResizing = false;
        this.isRotating = false;
        this.dragStart = { x: 0, y: 0 };
        this.itemStart = { x: 0, y: 0, w: 0, h: 0, rot: 0 };
        this.resizeHandle = null;
        this.canvas = document.getElementById('overlayCanvas');
        // Enable sub-pixel rendering for crisp canvas output
        this.ctx = this.canvas.getContext('2d', { desynchronized: false });
        // Track device pixel ratio and CSS dimensions for HiDPI canvas scaling
        this.dpr = window.devicePixelRatio || 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        // V23/G2: last geometry applied by resizeCanvas() and "bitmap not allocated yet" flag (see below).
        this._geom = null;
        this._backingDirty = false;
        this.initEvents();
    }

    initEvents() {
        const c = this.canvas;
        const self = this;
        // rAF-coalesce pointer moves so hitTest + render run at most once per
        // animation frame during fast drags. IMPORTANT: preventDefault() must
        // be called synchronously during touchmove dispatch (rAF runs later),
        // so we call it in the wrapper before scheduling the async work.
        const rafMove = (window.Perf ? Perf.rafThrottle(function(e){ self.onPointerMove(e); }) : function(e){ self.onPointerMove(e); });
        const touchMoveHandler = function(e) {
            if (self.selectedId && (self.isDragging || self.isResizing || self.isRotating)) {
                // Prevent the page from scrolling while manipulating an overlay.
                if (e.cancelable) e.preventDefault();
            }
            rafMove(e);
        };
        c.addEventListener('mousedown', function(e) { self.onPointerDown(e); });
        c.addEventListener('mousemove', rafMove);
        c.addEventListener('mouseup', function(e) { self.onPointerUp(e); });
        c.addEventListener('touchstart', function(e) { self.onPointerDown(e); }, { passive: false });
        // G5: the cancelable touchmove listener exists only while an item is being dragged / resized / rotated
        // (attached in onPointerDown, removed in onPointerUp). Touch devices have no hover, so nothing is lost
        // when no drag is running. touchend / touchcancel never cancel -> passive.
        this._touchMoveHandler = touchMoveHandler;
        c.addEventListener('touchend', function(e) { self.onPointerUp(e); }, { passive: true });
        // An interrupted touch (system gesture, incoming call, palm rejection) must end the drag too,
        // otherwise isDragging stays true and the next move keeps dragging the item.
        c.addEventListener('touchcancel', function(e) { self.onPointerUp(e); }, { passive: true });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (self.selectedId && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
                    self.deleteItem(self.selectedId);
                }
            }
        });
    }

    getPointerPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    getItemBounds(item) {
        const w = item.width || item.size || item.fontSize * 3 || 100;
        const h = item.height || item.size || item.fontSize || 100;
        return { x: item.x - w/2, y: item.y - h/2, w: w, h: h };
    }

    hitTest(x, y) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            const b = this.getItemBounds(item);
            const cx = item.x;
            const cy = item.y;
            const cos = Math.cos(-item.rotation * Math.PI / 180);
            const sin = Math.sin(-item.rotation * Math.PI / 180);
            const rx = cos * (x - cx) - sin * (y - cy);
            const ry = sin * (x - cx) + cos * (y - cy);
            if (rx >= -b.w/2 - 10 && rx <= b.w/2 + 10 && ry >= -b.h/2 - 10 && ry <= b.h/2 + 10) {
                return item;
            }
        }
        return null;
    }

    getHandle(x, y, item) {
        const b = this.getItemBounds(item);
        const handles = [
            { name: 'nw', x: b.x, y: b.y },
            { name: 'ne', x: b.x + b.w, y: b.y },
            { name: 'sw', x: b.x, y: b.y + b.h },
            { name: 'se', x: b.x + b.w, y: b.y + b.h },
            { name: 'rot', x: b.x + b.w/2, y: b.y - 25 }
        ];
        for (let h = 0; h < handles.length; h++) {
            if (Math.hypot(handles[h].x - x, handles[h].y - y) < 12) return handles[h].name;
        }
        return null;
    }

    onPointerDown(e) {
        if (!originalImage) return;
        e.preventDefault();
        const pos = this.getPointerPos(e);
        const hit = this.hitTest(pos.x, pos.y);
        if (hit) {
            const handle = this.getHandle(pos.x, pos.y, hit);
            this.selectedId = hit.id;
            if (handle === 'rot') {
                this.isRotating = true;
            } else if (handle) {
                this.isResizing = true;
                this.resizeHandle = handle;
            } else {
                this.isDragging = true;
            }
            if (e.touches) this.canvas.addEventListener('touchmove', this._touchMoveHandler, { passive: false });
            this.dragStart = pos;
            this.itemStart = { x: hit.x, y: hit.y, w: hit.width || hit.size || hit.fontSize * 3, h: hit.height || hit.size || hit.fontSize, rot: hit.rotation };
            this.render();
        } else {
            this.selectedId = null;
            this.render();
        }
    }

    onPointerMove(e) {
        if (!this.selectedId || (!this.isDragging && !this.isResizing && !this.isRotating)) {
            const pos = this.getPointerPos(e);
            const hit = this.hitTest(pos.x, pos.y);
            if (hit) {
                const handle = this.getHandle(pos.x, pos.y, hit);
                if (handle === 'rot') this.canvas.className = 'overlay-canvas rotating';
                else if (handle) this.canvas.className = 'overlay-canvas resizing-' + handle;
                else this.canvas.className = 'overlay-canvas has-selection';
            } else {
                this.canvas.className = 'overlay-canvas';
            }
            return;
        }
        e.preventDefault();
        const pos = this.getPointerPos(e);
        const item = this.items.find(function(i) { return i.id === this.selectedId; }.bind(this));
        if (!item) return;

        if (this.isDragging) {
            item.x = this.itemStart.x + (pos.x - this.dragStart.x);
            item.y = this.itemStart.y + (pos.y - this.dragStart.y);
        } else if (this.isResizing) {
            const dx = pos.x - this.dragStart.x;
            const dy = pos.y - this.dragStart.y;
            if (item.type === 'text') {
                const newSize = Math.max(12, this.itemStart.w + dx);
                item.fontSize = newSize;
            } else {
                const scale = Math.max(0.2, (this.itemStart.w + dx) / this.itemStart.w);
                if (item.type === 'sticker') {
                    item.size = Math.max(10, this.itemStart.w * scale);
                } else {
                    item.width = Math.max(10, this.itemStart.w * scale);
                    item.height = Math.max(10, this.itemStart.h * scale);
                }
            }
        } else if (this.isRotating) {
            const angle = Math.atan2(pos.y - item.y, pos.x - item.x) * 180 / Math.PI + 90;
            item.rotation = angle;
        }
        this.render();
    }

    onPointerUp(e) {
        this.canvas.removeEventListener('touchmove', this._touchMoveHandler, { passive: false });
        if (this.isDragging || this.isResizing || this.isRotating) {
            this.isDragging = false;
            this.isResizing = false;
            this.isRotating = false;
            this.resizeHandle = null;
            saveToHistory();
        }
    }

    addText(config) {
        // Default center in CSS pixel space (cssWidth/cssHeight), not device pixel space
        const cW = this.cssWidth || this.canvas.width;
        const cH = this.cssHeight || this.canvas.height;
        const item = {
            type: 'text',
            id: this.nextId++,
            text: config.text || 'New Text',
            x: config.x || cW / 2,
            y: config.y || cH / 2,
            fontSize: config.fontSize || 40,
            fontFamily: config.fontFamily || 'Inter',
            color: config.color || '#ffffff',
            align: 'center',
            bold: false,
            italic: false,
            shadow: false,
            stroke: false,
            opacity: 1,
            rotation: 0,
            letterSpacing: 0,
            bgBox: false,
            width: 0,
            height: 0
        };
        this.measureText(item);
        this.items.push(item);
        this.selectedId = item.id;
        this.render();
        saveToHistory();
        return item;
    }

    measureText(item) {
        // Always measure in the DPR-scaled coordinate space so item.width/height
        // are in CSS pixels — matching item.x / item.y and hit-test coordinates.
        const dpr = this.dpr || 1;
        this.ctx.save();
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.font = (item.bold ? 'bold ' : '') + (item.italic ? 'italic ' : '') + item.fontSize + 'px "' + item.fontFamily + '", sans-serif';
        const metrics = this.ctx.measureText(item.text);
        item.width = metrics.width + item.letterSpacing * item.text.length;
        item.height = item.fontSize * 1.2;
        this.ctx.restore();
    }

    addSticker(emoji, x, y) {
        const cW = this.cssWidth || this.canvas.width;
        const cH = this.cssHeight || this.canvas.height;
        const item = {
            type: 'sticker',
            id: this.nextId++,
            emoji: emoji,
            x: x || cW / 2,
            y: y || cH / 2,
            size: 60,
            rotation: 0,
            opacity: 1
        };
        this.items.push(item);
        this.selectedId = item.id;
        this.render();
        saveToHistory();
    }

    addShape(shapeType, config) {
        const size = 100;
        const cW = this.cssWidth || this.canvas.width;
        const cH = this.cssHeight || this.canvas.height;
        const item = {
            type: 'shape',
            id: this.nextId++,
            shapeType: shapeType,
            x: config && config.x ? config.x : cW / 2,
            y: config && config.y ? config.y : cH / 2,
            width: size,
            height: size,
            color: config && config.color ? config.color : '#ffffff',
            fill: true,
            strokeWidth: 0,
            rotation: 0,
            opacity: 1
        };
        this.items.push(item);
        this.selectedId = item.id;
        this.render();
        saveToHistory();
    }

    addFxOverlay(fxType) {
        const cW = this.cssWidth || this.canvas.width;
        const cH = this.cssHeight || this.canvas.height;
        const item = {
            type: 'fx',
            id: this.nextId++,
            fxType: fxType,
            x: cW / 2,
            y: cH / 2,
            width: cW,
            height: cH,
            opacity: 0.4,
            blend: 1,
            rotation: 0
        };
        this.items.push(item);
        this.selectedId = item.id;
        this.render();
        saveToHistory();
    }

    deleteItem(id) {
        this.items = this.items.filter(function(i) { return i.id !== id; });
        if (this.selectedId === id) this.selectedId = null;
        this.render();
        saveToHistory();
    }

    duplicateItem(id) {
        const item = this.items.find(function(i) { return i.id === id; });
        if (!item) return;
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = this.nextId++;
        copy.x += 20;
        copy.y += 20;
        this.items.push(copy);
        this.selectedId = copy.id;
        this.render();
        saveToHistory();
    }

    moveLayer(id, dir) {
        const idx = this.items.findIndex(function(i) { return i.id === id; });
        if (idx === -1) return;
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= this.items.length) return;
        const temp = this.items[idx];
        this.items[idx] = this.items[newIdx];
        this.items[newIdx] = temp;
        this.render();
        saveToHistory();
    }

    clearAll() {
        this.items = [];
        this.selectedId = null;
        this.render();
        saveToHistory();
    }

    getSelectedItem() {
        return this.items.find(function(i) { return i.id === this.selectedId; }.bind(this));
    }

    resizeCanvas() {
        const container = document.getElementById('imgContainer');
        const img = document.getElementById('mainImg');
        if (!container || !img || !img.classList.contains('active')) return;
        const rect = img.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const left = rect.left - cRect.left;
        const top = rect.top - cRect.top;

        // V23/G2 early-out #1: same box, same DPR and the canvas is already shown -> position, CSS size,
        // coordinate space and bitmap are all still correct. Assigning canvas.width/height would only
        // re-allocate and clear the bitmap (this used to happen on every slider frame).
        const g = this._geom;
        if (g && g.dpr === dpr && g.w === rect.width && g.h === rect.height && g.left === left && g.top === top &&
            this.canvas.style.display === 'block') return;
        this._geom = { dpr: dpr, w: rect.width, h: rect.height, left: left, top: top };

        // Store DPR and CSS dimensions — all item coordinates are in CSS pixels
        this.dpr = dpr;
        this.cssWidth = rect.width;
        this.cssHeight = rect.height;
        this.canvas.style.display = 'block';
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = left + 'px';
        this.canvas.style.top = top + 'px';
        // CSS size matches the image element exactly
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';

        // V23/G2 early-out #2: nothing to draw -> keep the geometry (add* needs cssWidth/cssHeight and the
        // pointer maths use the CSS box) but do NOT allocate / clear a DPR-sized bitmap. render() allocates
        // it the moment something is actually drawn.
        if (this.items.length === 0 && !this.selectedId) { this._backingDirty = true; return; }
        this._syncBacking();
    }

    // Backing store is DPR× larger for crisp Retina/HiDPI rendering. Runs only when the geometry changed
    // and there is something to draw (or render() is about to draw).
    _syncBacking() {
        this._backingDirty = false;
        const w = Math.round(this.cssWidth * this.dpr);
        const h = Math.round(this.cssHeight * this.dpr);
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        this.render();
    }

    render() {
        if (this._backingDirty) { this._syncBacking(); return; }   // allocates, then renders once
        const ctx = this.ctx;
        const dpr = this.dpr || 1;
        // CSS-space dimensions used for all coordinate operations
        const cssW = this.cssWidth || (this.canvas.width / dpr);
        const cssH = this.cssHeight || (this.canvas.height / dpr);
        // Apply DPR scale so all drawing coordinates are in CSS pixels —
        // matching item.x / item.y (set from CSS-pixel pointer positions).
        // This produces crisp output on Retina/HiDPI displays.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            ctx.save();
            ctx.globalAlpha = item.opacity;
            ctx.translate(item.x, item.y);
            ctx.rotate(item.rotation * Math.PI / 180);

            if (item.type === 'text') {
                this.renderTextItem(ctx, item);
            } else if (item.type === 'sticker') {
                this.renderStickerItem(ctx, item);
            } else if (item.type === 'shape') {
                this.renderShapeItem(ctx, item);
            } else if (item.type === 'fx') {
                // Pass CSS dimensions so fx effects fill the CSS-pixel canvas space
                this.renderFxItem(ctx, item, cssW, cssH);
            }
            ctx.restore();
        }

        if (this.selectedId) {
            const item = this.getSelectedItem();
            if (item) this.drawSelection(ctx, item);
        }
    }

    renderTextItem(ctx, item) {
        ctx.font = (item.bold ? 'bold ' : '') + (item.italic ? 'italic ' : '') + item.fontSize + 'px "' + item.fontFamily + '", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const metrics = ctx.measureText(item.text);
        const textW = metrics.width + item.letterSpacing * item.text.length;
        const textH = item.fontSize * 1.2;
        item.width = textW;
        item.height = textH;

        if (item.bgBox) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.beginPath();
            ctx.roundRect(-textW/2 - 10, -textH/2 - 5, textW + 20, textH + 10, 8);
            ctx.fill();
        }

        if (item.shadow) {
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetX = 3;
            ctx.shadowOffsetY = 3;
        }

        if (item.stroke) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = Math.max(2, item.fontSize * 0.08);
            ctx.strokeText(item.text, 0, 0);
        }

        if (item.color === 'gradient') {
            const grad = ctx.createLinearGradient(-textW/2, 0, textW/2, 0);
            grad.addColorStop(0, '#7c3aed');
            grad.addColorStop(1, '#db2777');
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = item.color;
        }

        if (item.letterSpacing !== 0) {
            let xOffset = -textW / 2;
            for (let ch = 0; ch < item.text.length; ch++) {
                const char = item.text[ch];
                ctx.fillText(char, xOffset + ctx.measureText(char).width / 2, 0);
                xOffset += ctx.measureText(char).width + item.letterSpacing;
            }
        } else {
            ctx.fillText(item.text, 0, 0);
        }
        ctx.shadowColor = 'transparent';
    }

    renderStickerItem(ctx, item) {
        ctx.font = item.size + 'px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.emoji, 0, 0);
    }

    renderShapeItem(ctx, item) {
        ctx.fillStyle = item.color;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.strokeWidth;
        const w = item.width;
        const h = item.height;

        ctx.beginPath();
        switch(item.shapeType) {
            case 'rect':
                if (item.fill) ctx.fillRect(-w/2, -h/2, w, h);
                if (item.strokeWidth > 0) ctx.strokeRect(-w/2, -h/2, w, h);
                break;
            case 'circle':
                ctx.arc(0, 0, w/2, 0, Math.PI * 2);
                if (item.fill) ctx.fill();
                if (item.strokeWidth > 0) ctx.stroke();
                break;
            case 'line':
                ctx.moveTo(-w/2, 0);
                ctx.lineTo(w/2, 0);
                ctx.stroke();
                break;
            case 'arrow':
                ctx.moveTo(-w/2, 0);
                ctx.lineTo(w/2, 0);
                ctx.lineTo(w/2 - 10, -8);
                ctx.moveTo(w/2, 0);
                ctx.lineTo(w/2 - 10, 8);
                ctx.stroke();
                break;
            case 'star':
                for (let i = 0; i < 5; i++) {
                    const angle = (i * 4 * Math.PI / 5) - Math.PI / 2;
                    const x = Math.cos(angle) * w/2;
                    const y = Math.sin(angle) * w/2;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.closePath();
                if (item.fill) ctx.fill();
                if (item.strokeWidth > 0) ctx.stroke();
                break;
            case 'heart':
                const topCurveHeight = h * 0.3;
                ctx.moveTo(0, topCurveHeight);
                ctx.bezierCurveTo(0, 0, -w/2, 0, -w/2, topCurveHeight);
                ctx.bezierCurveTo(-w/2, h/2 + topCurveHeight / 2, 0, h/2 + topCurveHeight, 0, h/2 + topCurveHeight);
                ctx.bezierCurveTo(0, h/2 + topCurveHeight, w/2, h/2 + topCurveHeight / 2, w/2, topCurveHeight);
                ctx.bezierCurveTo(w/2, 0, 0, 0, 0, topCurveHeight);
                ctx.closePath();
                if (item.fill) ctx.fill();
                if (item.strokeWidth > 0) ctx.stroke();
                break;
            case 'triangle':
                ctx.moveTo(0, -h/2);
                ctx.lineTo(w/2, h/2);
                ctx.lineTo(-w/2, h/2);
                ctx.closePath();
                if (item.fill) ctx.fill();
                if (item.strokeWidth > 0) ctx.stroke();
                break;
            case 'diamond':
                ctx.moveTo(0, -h/2);
                ctx.lineTo(w/2, 0);
                ctx.lineTo(0, h/2);
                ctx.lineTo(-w/2, 0);
                ctx.closePath();
                if (item.fill) ctx.fill();
                if (item.strokeWidth > 0) ctx.stroke();
                break;
        }
    }

    // Deterministic PRNG (mulberry32) seeded from the item id: dust / scratches used Math.random() inside
    // render(), so they re-rolled on every redraw (flicker) and the export differed from the preview.
    _fxRandom(item) {
        let a = (Math.imul((item && item.id) || 1, 2654435761)) >>> 0;
        return function() {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    renderFxItem(ctx, item, cw, ch) {
        const rnd = this._fxRandom(item);
        ctx.globalAlpha = item.opacity * item.blend;
        switch(item.fxType) {
            case 'lightleak-orange':
                const g1 = ctx.createRadialGradient(-cw*0.2, -ch*0.2, 0, cw*0.3, ch*0.3, cw*0.8);
                g1.addColorStop(0, 'rgba(255, 140, 0, 0.6)');
                g1.addColorStop(1, 'rgba(255, 140, 0, 0)');
                ctx.fillStyle = g1;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'lightleak-red':
                const g2 = ctx.createRadialGradient(cw*0.5, -ch*0.3, 0, cw*0.5, ch*0.2, cw);
                g2.addColorStop(0, 'rgba(255, 0, 0, 0.5)');
                g2.addColorStop(1, 'rgba(255, 0, 0, 0)');
                ctx.fillStyle = g2;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'lightleak-blue':
                const g3 = ctx.createRadialGradient(-cw*0.3, ch*0.5, 0, cw*0.2, ch*0.5, cw*0.7);
                g3.addColorStop(0, 'rgba(0, 100, 255, 0.5)');
                g3.addColorStop(1, 'rgba(0, 100, 255, 0)');
                ctx.fillStyle = g3;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'lightleak-purple':
                const g4 = ctx.createRadialGradient(cw*0.5, ch*0.5, 0, cw*0.5, ch*0.5, cw*0.6);
                g4.addColorStop(0, 'rgba(150, 0, 255, 0.4)');
                g4.addColorStop(1, 'rgba(150, 0, 255, 0)');
                ctx.fillStyle = g4;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'lightleak-rainbow':
                const g5 = ctx.createLinearGradient(-cw/2, -ch/2, cw/2, ch/2);
                g5.addColorStop(0, 'rgba(255,0,0,0.2)');
                g5.addColorStop(0.2, 'rgba(255,165,0,0.2)');
                g5.addColorStop(0.4, 'rgba(255,255,0,0.2)');
                g5.addColorStop(0.6, 'rgba(0,255,0,0.2)');
                g5.addColorStop(0.8, 'rgba(0,0,255,0.2)');
                g5.addColorStop(1, 'rgba(255,0,255,0.2)');
                ctx.fillStyle = g5;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'dust':
                for (let i = 0; i < 80; i++) {
                    const dx = (rnd() - 0.5) * cw;
                    const dy = (rnd() - 0.5) * ch;
                    const r = rnd() * 2 + 0.5;
                    ctx.fillStyle = 'rgba(255,255,255,' + (rnd() * 0.4 + 0.1) + ')';
                    ctx.beginPath();
                    ctx.arc(dx, dy, r, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            case 'scratches':
                ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                ctx.lineWidth = 0.5;
                for (let i = 0; i < 15; i++) {
                    ctx.beginPath();
                    ctx.moveTo((rnd() - 0.5) * cw, (rnd() - 0.5) * ch);
                    ctx.lineTo((rnd() - 0.5) * cw, (rnd() - 0.5) * ch);
                    ctx.stroke();
                }
                break;
            case 'vignette-strong':
                const g6 = ctx.createRadialGradient(0, 0, cw*0.3, 0, 0, cw*0.9);
                g6.addColorStop(0, 'rgba(0,0,0,0)');
                g6.addColorStop(1, 'rgba(0,0,0,0.7)');
                ctx.fillStyle = g6;
                ctx.fillRect(-cw/2, -ch/2, cw, ch);
                break;
            case 'filmframe':
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 15;
                ctx.strokeRect(-cw/2 + 10, -ch/2 + 10, cw - 20, ch - 20);
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 8;
                ctx.strokeRect(-cw/2 + 18, -ch/2 + 18, cw - 36, ch - 36);
                break;
        }
    }

    drawSelection(ctx, item) {
        const b = this.getItemBounds(item);
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(item.rotation * Math.PI / 180);
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(-b.w/2 - 5, -b.h/2 - 5, b.w + 10, b.h + 10);
        ctx.setLineDash([]);

        const handles = [
            { x: -b.w/2 - 5, y: -b.h/2 - 5 },
            { x: b.w/2 + 5, y: -b.h/2 - 5 },
            { x: -b.w/2 - 5, y: b.h/2 + 5 },
            { x: b.w/2 + 5, y: b.h/2 + 5 },
            { x: 0, y: -b.h/2 - 25 }
        ];
        for (let i = 0; i < handles.length; i++) {
            ctx.fillStyle = i === 4 ? '#e2ad4f' : '#6366f1';
            ctx.beginPath();
            ctx.arc(handles[i].x, handles[i].y, i === 4 ? 6 : 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.restore();
    }

    drawToCanvas(targetCtx, targetW, targetH) {
        // Use CSS dimensions (not device-pixel canvas dimensions) so that item
        // positions and sizes scale correctly into the export image.
        const cssW = this.cssWidth || (this.canvas.width / (this.dpr || 1));
        const cssH = this.cssHeight || (this.canvas.height / (this.dpr || 1));
        const scaleX = targetW / cssW;
        const scaleY = targetH / cssH;
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            targetCtx.save();
            targetCtx.globalAlpha = item.opacity;
            targetCtx.translate(item.x * scaleX, item.y * scaleY);
            targetCtx.rotate(item.rotation * Math.PI / 180);
            if (item.type === 'text') {
                targetCtx.font = (item.bold ? 'bold ' : '') + (item.italic ? 'italic ' : '') + (item.fontSize * scaleX) + 'px "' + item.fontFamily + '", sans-serif';
                targetCtx.textAlign = 'center';
                targetCtx.textBaseline = 'middle';
                const metrics = targetCtx.measureText(item.text);
                const tw = metrics.width + item.letterSpacing * item.text.length * scaleX;
                const th = item.fontSize * scaleX * 1.2;
                if (item.bgBox) {
                    targetCtx.fillStyle = 'rgba(0,0,0,0.5)';
                    targetCtx.beginPath();
                    targetCtx.roundRect(-tw/2 - 10*scaleX, -th/2 - 5*scaleX, tw + 20*scaleX, th + 10*scaleX, 8*scaleX);
                    targetCtx.fill();
                }
                if (item.shadow) {
                    targetCtx.shadowColor = 'rgba(0,0,0,0.5)';
                    targetCtx.shadowBlur = 10 * scaleX;
                    targetCtx.shadowOffsetX = 3 * scaleX;
                    targetCtx.shadowOffsetY = 3 * scaleX;
                }
                if (item.stroke) {
                    targetCtx.strokeStyle = '#000000';
                    targetCtx.lineWidth = Math.max(2, item.fontSize * scaleX * 0.08);
                    targetCtx.strokeText(item.text, 0, 0);
                }
                if (item.color === 'gradient') {
                    const grad = targetCtx.createLinearGradient(-tw/2, 0, tw/2, 0);
                    grad.addColorStop(0, '#7c3aed');
                    grad.addColorStop(1, '#db2777');
                    targetCtx.fillStyle = grad;
                } else {
                    targetCtx.fillStyle = item.color;
                }
                if (item.letterSpacing !== 0) {
                    let xOff = -tw / 2;
                    for (let ch = 0; ch < item.text.length; ch++) {
                        const char = item.text[ch];
                        targetCtx.fillText(char, xOff + targetCtx.measureText(char).width / 2, 0);
                        xOff += targetCtx.measureText(char).width + item.letterSpacing * scaleX;
                    }
                } else {
                    targetCtx.fillText(item.text, 0, 0);
                }
                targetCtx.shadowColor = 'transparent';
            } else if (item.type === 'sticker') {
                targetCtx.font = (item.size * scaleX) + 'px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", sans-serif';
                targetCtx.textAlign = 'center';
                targetCtx.textBaseline = 'middle';
                targetCtx.fillText(item.emoji, 0, 0);
            } else if (item.type === 'shape') {
                targetCtx.fillStyle = item.color;
                targetCtx.strokeStyle = item.color;
                targetCtx.lineWidth = item.strokeWidth * scaleX;
                const w = item.width * scaleX;
                const h = item.height * scaleY;
                targetCtx.beginPath();
                switch(item.shapeType) {
                    case 'rect':
                        if (item.fill) targetCtx.fillRect(-w/2, -h/2, w, h);
                        if (item.strokeWidth > 0) targetCtx.strokeRect(-w/2, -h/2, w, h);
                        break;
                    case 'circle':
                        targetCtx.arc(0, 0, w/2, 0, Math.PI * 2);
                        if (item.fill) targetCtx.fill();
                        if (item.strokeWidth > 0) targetCtx.stroke();
                        break;
                    case 'line':
                        targetCtx.moveTo(-w/2, 0);
                        targetCtx.lineTo(w/2, 0);
                        targetCtx.stroke();
                        break;
                    case 'arrow':
                        targetCtx.moveTo(-w/2, 0);
                        targetCtx.lineTo(w/2, 0);
                        targetCtx.lineTo(w/2 - 10*scaleX, -8*scaleX);
                        targetCtx.moveTo(w/2, 0);
                        targetCtx.lineTo(w/2 - 10*scaleX, 8*scaleX);
                        targetCtx.stroke();
                        break;
                    case 'star':
                        for (let i = 0; i < 5; i++) {
                            const angle = (i * 4 * Math.PI / 5) - Math.PI / 2;
                            const x = Math.cos(angle) * w/2;
                            const y = Math.sin(angle) * w/2;
                            if (i === 0) targetCtx.moveTo(x, y); else targetCtx.lineTo(x, y);
                        }
                        targetCtx.closePath();
                        if (item.fill) targetCtx.fill();
                        if (item.strokeWidth > 0) targetCtx.stroke();
                        break;
                    case 'heart':
                        const tch = h * 0.3;
                        targetCtx.moveTo(0, tch);
                        targetCtx.bezierCurveTo(0, 0, -w/2, 0, -w/2, tch);
                        targetCtx.bezierCurveTo(-w/2, h/2 + tch/2, 0, h/2 + tch, 0, h/2 + tch);
                        targetCtx.bezierCurveTo(0, h/2 + tch, w/2, h/2 + tch/2, w/2, tch);
                        targetCtx.bezierCurveTo(w/2, 0, 0, 0, 0, tch);
                        targetCtx.closePath();
                        if (item.fill) targetCtx.fill();
                        if (item.strokeWidth > 0) targetCtx.stroke();
                        break;
                    case 'triangle':
                        targetCtx.moveTo(0, -h/2);
                        targetCtx.lineTo(w/2, h/2);
                        targetCtx.lineTo(-w/2, h/2);
                        targetCtx.closePath();
                        if (item.fill) targetCtx.fill();
                        if (item.strokeWidth > 0) targetCtx.stroke();
                        break;
                    case 'diamond':
                        targetCtx.moveTo(0, -h/2);
                        targetCtx.lineTo(w/2, 0);
                        targetCtx.lineTo(0, h/2);
                        targetCtx.lineTo(-w/2, 0);
                        targetCtx.closePath();
                        if (item.fill) targetCtx.fill();
                        if (item.strokeWidth > 0) targetCtx.stroke();
                        break;
                }
            } else if (item.type === 'fx') {
                this.renderFxItem(targetCtx, item, targetW, targetH);
            }
            targetCtx.restore();
        }
    }
}

let overlayManager = new OverlayManager();
})(globalThis);
