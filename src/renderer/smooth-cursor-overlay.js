// ZTerm - xterm smooth cursor proof of concept.
// The motion state is kept independent from DOM/animation frames so it can be
// tested without a browser. The DOM adapter is intentionally xterm-only.

const _smoothCursorRoot = typeof globalThis !== 'undefined' ? globalThis : this;

function _smoothFinite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function _smoothDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function _smoothEaseOutCubic(progress) {
    const p = Math.max(0, Math.min(1, progress));
    return 1 - Math.pow(1 - p, 3);
}

class SmoothCursorMotion {
    constructor({ duration = 90, jumpDistance = 8, now = () => performance.now() } = {}) {
        this.duration = Math.max(0, _smoothFinite(duration, 90));
        this.jumpDistance = Math.max(0, _smoothFinite(jumpDistance, 8));
        this.now = now;
        this.position = { x: 0, y: 0 };
        this.target = { x: 0, y: 0 };
        this.from = { x: 0, y: 0 };
        this.startedAt = 0;
        this.animating = false;
        this.initialized = false;
        this.disposed = false;
    }

    _point(x, y) {
        return { x: _smoothFinite(x), y: _smoothFinite(y) };
    }

    setTarget(x, y, at = this.now()) {
        if (this.disposed) return this.position;
        const target = this._point(x, y);
        if (!this.initialized) {
            this.position = { ...target };
            this.from = { ...target };
            this.target = { ...target };
            this.startedAt = _smoothFinite(at);
            this.initialized = true;
            this.animating = false;
            return this.position;
        }
        // Continue from the current visual position when a new target arrives
        // during an existing animation, rather than restarting from the old cell.
        this.tick(at);
        this.from = { ...this.position };
        this.target = { ...target };
        this.startedAt = _smoothFinite(at);
        if (this.duration === 0 || _smoothDistance(this.position, target) > this.jumpDistance) {
            this.position = { ...target };
            this.from = { ...target };
            this.animating = false;
        } else {
            this.animating = this.position.x !== target.x || this.position.y !== target.y;
        }
        return this.position;
    }

    reposition(x, y, at = this.now()) {
        if (this.disposed) return this.position;
        const point = this._point(x, y);
        this.position = { ...point };
        this.from = { ...point };
        this.target = { ...point };
        this.startedAt = _smoothFinite(at);
        this.initialized = true;
        this.animating = false;
        return this.position;
    }

    tick(at = this.now()) {
        if (this.disposed || !this.initialized || !this.animating) return this.position;
        if (this.duration === 0) {
            this.position = { ...this.target };
            this.animating = false;
            return this.position;
        }
        const elapsed = Math.max(0, _smoothFinite(at) - this.startedAt);
        const progress = Math.min(1, elapsed / this.duration);
        const eased = _smoothEaseOutCubic(progress);
        this.position = {
            x: this.from.x + (this.target.x - this.from.x) * eased,
            y: this.from.y + (this.target.y - this.from.y) * eased,
        };
        if (progress >= 1) {
            this.position = { ...this.target };
            this.animating = false;
        }
        return this.position;
    }

    dispose() {
        this.disposed = true;
        this.animating = false;
    }
}

class SmoothCursorOverlay {
    constructor(term, host, {
        duration = 90,
        jumpDistance = 8,
        cursorBlink = true,
        cursorStyle = 'bar',
        cursorColor = '#ffffff',
        animations = true,
    } = {}) {
        this.term = term;
        this.host = host;
        this.duration = animations ? duration : 0;
        this.cursorBlink = cursorBlink;
        this.cursorStyle = cursorStyle;
        this.cursorColor = cursorColor;
        this._motion = new SmoothCursorMotion({ duration: this.duration, jumpDistance });
        this._raf = 0;
        this._blinkTimer = 0;
        this._blinkVisible = true;
        this._disposed = false;
        this._disposables = [];
        this._resizeObserver = null;
        this._lastTarget = null;
        this._pendingTarget = null;
        this._pendingImmediate = false;
        this._renderEpoch = 0;
        this._dpr = 1;
        this._createElement();
        this._bind();
        this._syncTarget(true);
        this._scheduleBlink();
    }

    _createElement() {
        if (!this.host || typeof document === 'undefined') return;
        // Host is the xterm element itself so the overlay follows it when tabs
        // move between single and split-pane layouts.
        const currentPosition = typeof getComputedStyle === 'function' ? getComputedStyle(this.host).position : '';
        if (currentPosition === 'static') this.host.style.position = 'relative';
        const el = document.createElement('canvas');
        el.className = 'smooth-cursor-overlay';
        el.setAttribute('aria-hidden', 'true');
        el.style.pointerEvents = 'none';
        el.style.position = 'absolute';
        el.style.inset = '0';
        el.style.zIndex = '11';
        this.element = el;
        this.context = el.getContext('2d', { alpha: true });
        this.host.appendChild(el);
    }

    _listen(disposable) {
        if (disposable && typeof disposable.dispose === 'function') this._disposables.push(disposable);
    }

    _bind() {
        if (!this.term) return;
        this._listen(this.term.onCursorMove?.(() => this._queueTarget(false)));
        this._listen(this.term.onRender?.(() => this._commitTarget()));
        this._listen(this.term.onResize?.(() => this._reposition()));
        this._listen(this.term.onScroll?.(() => this._reposition()));
        const viewport = this.term.element?.querySelector('.xterm-viewport');
        if (viewport) viewport.addEventListener('scroll', this._onScroll = () => this._reposition(), { passive: true });
        if (this.host && typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this._reposition());
            this._resizeObserver.observe(this.host);
        }
    }

    _scheduleBlink() {
        if (!this.cursorBlink || typeof setInterval !== 'function') return;
        this._blinkTimer = setInterval(() => {
            if (this._disposed) return;
            this._blinkVisible = !this._blinkVisible;
            this._scheduleRender();
        }, 530);
    }

    _getTarget() {
        const buffer = this.term?.buffer?.active;
        if (!buffer) return { x: 0, y: 0 };
        return { x: _smoothFinite(buffer.cursorX), y: _smoothFinite(buffer.cursorY) };
    }

    _queueTarget(immediate) {
        if (this._disposed) return;
        this._pendingTarget = this._getTarget();
        this._pendingImmediate = this._pendingImmediate || immediate;
        // Cursor moves are committed from onRender, after xterm has painted the
        // corresponding frame. This coalesces parser bursts into the latest target.
        if (immediate) this._commitTarget();
    }

    _commitTarget() {
        if (this._disposed) return;
        if (!this._pendingTarget && !this._pendingImmediate) {
            this._scheduleRender();
            return;
        }
        const target = this._pendingTarget || this._getTarget();
        const immediate = this._pendingImmediate;
        this._pendingTarget = null;
        this._pendingImmediate = false;
        this._lastTarget = target;
        if (immediate) this._motion.reposition(target.x, target.y);
        else this._motion.setTarget(target.x, target.y, performance.now());
        this._renderEpoch++;
        this._scheduleRender();
    }

    _syncTarget(immediate) {
        this._queueTarget(immediate);
        if (immediate) this._commitTarget();
    }

    _metrics() {
        const cell = this.term?._core?._renderService?.dimensions?.css?.cell;
        const screen = this.term?.element?.querySelector('.xterm-screen');
        const screenRect = screen?.getBoundingClientRect?.();
        const hostRect = this.host?.getBoundingClientRect?.();
        if (!hostRect || !screenRect) return null;
        const width = _smoothFinite(cell?.width, screenRect.width / Math.max(1, this.term?.cols || 1));
        const height = _smoothFinite(cell?.height, screenRect.height / Math.max(1, this.term?.rows || 1));
        if (!(width > 0 && height > 0)) return null;
        return { width, height, left: screenRect.left - hostRect.left, top: screenRect.top - hostRect.top };
    }

    _reposition() {
        if (this._disposed) return;
        this._pendingTarget = this._getTarget();
        this._pendingImmediate = true;
        this._commitTarget();
    }

    _isScrolledBack() {
        const viewport = this.term?.element?.querySelector('.xterm-viewport');
        if (!viewport) return false;
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1;
    }

    _resizeCanvas() {
        if (!this.element || !this.context || !this.host) return null;
        const rect = this.host.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            this.element.style.opacity = '0';
            return null;
        }
        const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
        this._dpr = dpr;
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (this.element.width !== width || this.element.height !== height) {
            this.element.width = width;
            this.element.height = height;
        }
        this.element.style.width = `${rect.width}px`;
        this.element.style.height = `${rect.height}px`;
        this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { width: rect.width, height: rect.height };
    }

    _clearCanvas(size) {
        if (!this.context || !size) return;
        this.context.clearRect(0, 0, size.width, size.height);
    }

    _scheduleRender() {
        if (this._disposed || this._raf || typeof requestAnimationFrame !== 'function') return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this._render(performance.now());
        });
    }

    _render(now) {
        if (this._disposed || !this.element || !this.context) return;
        const size = this._resizeCanvas();
        if (!size) return;
        this._clearCanvas(size);
        this._motion.tick(now);
        const metrics = this._metrics();
        if (!metrics || !this._blinkVisible || this._isScrolledBack()) {
            this.element.style.opacity = '0';
        } else {
            this.element.style.opacity = '1';
            this._applyStyle(metrics);
        }
        if (this._motion.animating) this._scheduleRender();
    }

    _applyStyle(metrics) {
        const ctx = this.context;
        const p = this._motion.position;
        const x = metrics.left + p.x * metrics.width;
        const y = metrics.top + p.y * metrics.height;
        const barWidth = Math.max(1, Math.round(metrics.width * 0.12));
        const underlineHeight = Math.max(1, Math.round(metrics.height * 0.12));
        ctx.fillStyle = this.cursorColor;
        ctx.strokeStyle = this.cursorColor;
        ctx.lineWidth = 1;
        if (this.cursorStyle === 'underline') {
            ctx.fillRect(x, y + metrics.height - underlineHeight, metrics.width, underlineHeight);
        } else if (this.cursorStyle === 'bar') {
            ctx.fillRect(x, y, barWidth, metrics.height);
        } else if (this.cursorStyle === 'outline' || this.cursorStyle === 'hollow') {
            ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, metrics.width - 1), Math.max(0, metrics.height - 1));
        } else {
            ctx.fillRect(x, y, metrics.width, metrics.height);
        }
    }

    setOptions({ cursorBlink, cursorStyle, cursorColor, animations } = {}) {
        if (cursorBlink !== undefined) this.cursorBlink = cursorBlink;
        if (cursorStyle) this.cursorStyle = cursorStyle;
        if (cursorColor) this.cursorColor = cursorColor;
        if (animations !== undefined) {
            this.duration = animations ? 90 : 0;
            this._motion.duration = this.duration;
        }
        if (!this.cursorBlink) {
            clearInterval(this._blinkTimer);
            this._blinkTimer = 0;
            this._blinkVisible = true;
        } else if (!this._blinkTimer) this._scheduleBlink();
        this._reposition();
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._motion.dispose();
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this._blinkTimer) clearInterval(this._blinkTimer);
        this._clearCanvas({ width: this.element?.clientWidth || 0, height: this.element?.clientHeight || 0 });
        this._disposables.forEach(d => { try { d.dispose(); } catch(e) {} });
        this._disposables = [];
        const viewport = this.term?.element?.querySelector('.xterm-viewport');
        if (viewport && this._onScroll) viewport.removeEventListener('scroll', this._onScroll);
        this._resizeObserver?.disconnect();
        this.element?.remove();
    }
}

_smoothCursorRoot.SmoothCursorMotion = SmoothCursorMotion;
_smoothCursorRoot.SmoothCursorOverlay = SmoothCursorOverlay;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SmoothCursorMotion, SmoothCursorOverlay, _smoothEaseOutCubic };
}
