// Issue #46 regression suite: hidden-tab / split-pane viewport desync.
//
// REAL: vendored src/vendor/xterm.js (Terminal, BufferService, Viewport,
// RenderService, DomRenderer, CharSizeService, wheel/scroll handlers),
// vendored src/vendor/addon-fit.js (FitAddon), and real renderer scripts
// (split-layout.js, pane-fields.js, ssh-attempts.js, tab-title-utils.js,
// font-governance.js, terminal.js, tabstrip-layout.js, tabs.js, split.js).
//
// FAKED (environment only): minimal Chromium-faithful DOM model where
// display:none (either style.display === 'none' or a .term-wrap without
// .active) collapses offsetHeight/clientHeight/scrollHeight to 0, sets
// offsetParent to null, resets DOM scrollTop to 0 without emitting a scroll
// event, and drops scrollTop writes while hidden; reparenting a node resets
// descendant scrollTop to 0; while visible, scrollHeight reflects
// .xterm-scroll-area height and scrollTop clamps to [0, scrollHeight -
// clientHeight] (with DPR device-pixel snapping) and queues an async scroll
// event only when the clamped value actually changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TimerQueue } from './helpers/renderer-vm.mjs';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
const vendor = f => readFileSync(new URL(`../src/vendor/${f}`, import.meta.url), 'utf8');

const XTERM_BUNDLE = vendor('xterm.js');
const FIT_BUNDLE = vendor('addon-fit.js');
const CELL_W = 10;
const CELL_H = 21; // With lineHeight 1.125 at DPR 1: floor(21 * 1.125) = 23px

function classSet(str) {
    return new Set(String(str || '').split(/\s+/).filter(Boolean));
}

function createRealXtermEnv({ dpr = 1, width = 800, height = 705 } = {}) {
    const tq = new TimerQueue();
    const rafs = new Map();
    let rafSeq = 1;
    const pendingScrollEvents = [];
    const docListeners = new Map();
    const windowListeners = new Map();
    const sends = [];
    let envWidth = width;
    let envHeight = height;
    let docHidden = false;
    let doc;

    const fake2d = () => ({
        globalCompositeOperation: '',
        fillStyle: '',
        font: '',
        createLinearGradient: () => ({}),
        fillRect() {},
        clearRect() {},
        measureText: () => ({ width: CELL_W, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 5 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
    });

    function isHiddenByCss(el) {
        if (docHidden) return true;
        let cur = el;
        while (cur) {
            if (cur.style && cur.style.display === 'none') return true;
            const cs = classSet(cur.className);
            if (cs.has('term-wrap') && !cs.has('active')) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    function resetSubtreeScrollTop(node) {
        if (node._resetScrollTopSilently) node._resetScrollTopSilently();
        for (const c of node.children || []) resetSubtreeScrollTop(c);
    }

    function mkEl(tag = 'DIV', over = {}) {
        let _scrollTop = 0;
        let _display = '';
        let _className = '';
        const styleObj = {};
        Object.defineProperty(styleObj, 'display', {
            enumerable: true,
            configurable: true,
            get() { return _display; },
            set(v) {
                const prevHidden = isHiddenByCss(el);
                _display = String(v ?? '');
                const nowHidden = isHiddenByCss(el);
                if (!prevHidden && nowHidden) resetSubtreeScrollTop(el);
            },
        });

        const el = {
            tagName: String(tag || 'DIV').toUpperCase(),
            style: styleObj,
            dataset: {},
            children: [],
            _listeners: new Map(),
            id: '',
            innerHTML: '',
            textContent: '',
            value: '',
            tabIndex: 0,
            parentElement: null,
            _customW: null,
            _customH: null,
            get className() { return _className; },
            set className(v) {
                const prevHidden = isHiddenByCss(el);
                _className = String(v || '');
                const nowHidden = isHiddenByCss(el);
                if (!prevHidden && nowHidden) resetSubtreeScrollTop(el);
            },
            get ownerDocument() { return doc; },
            getContext: () => fake2d(),
            setAttribute(k, v) {
                this['$' + k] = v;
                if (k === 'id') this.id = v;
            },
            getAttribute(k) {
                const v = this['$' + k];
                return v === undefined ? null : v;
            },
            appendChild(c) {
                if (c._fragment) {
                    for (const fc of [...c.children]) this.appendChild(fc);
                    c.children.length = 0;
                    return c;
                }
                const wasAttached = !!c.parentElement;
                if (c.parentElement) {
                    const i = c.parentElement.children.indexOf(c);
                    if (i >= 0) c.parentElement.children.splice(i, 1);
                }
                c.parentElement = this;
                this.children.push(c);
                // Reparenting a connected DOM subtree resets descendant scrollTop in Blink.
                if (wasAttached) resetSubtreeScrollTop(c);
                return c;
            },
            insertBefore(c, ref) {
                const wasAttached = !!c.parentElement;
                if (c.parentElement) {
                    const i = c.parentElement.children.indexOf(c);
                    if (i >= 0) c.parentElement.children.splice(i, 1);
                }
                c.parentElement = this;
                const at = ref ? this.children.indexOf(ref) : -1;
                if (at >= 0) this.children.splice(at, 0, c);
                else this.children.push(c);
                if (wasAttached) resetSubtreeScrollTop(c);
                return c;
            },
            insertAdjacentElement(_pos, c) { return this.appendChild(c); },
            removeChild(c) {
                const i = this.children.indexOf(c);
                if (i >= 0) this.children.splice(i, 1);
                c.parentElement = null;
                return c;
            },
            remove() { if (this.parentElement) this.parentElement.removeChild(this); },
            replaceChildren(...cs) {
                this.children.length = 0;
                for (const c of cs) this.appendChild(c);
            },
            addEventListener(type, fn) {
                if (!this._listeners.has(type)) this._listeners.set(type, []);
                this._listeners.get(type).push(fn);
            },
            removeEventListener(type, fn) {
                const l = this._listeners.get(type) || [];
                const i = l.indexOf(fn);
                if (i >= 0) l.splice(i, 1);
            },
            dispatch(type, ev = {}) {
                ev.type = type;
                (this._listeners.get(type) || []).slice().forEach(fn => fn(ev));
            },
            querySelector(sel) { return queryAll(this, sel)[0] || null; },
            querySelectorAll(sel) { return queryAll(this, sel); },
            contains(n) {
                let cur = n;
                while (cur) { if (cur === this) return true; cur = cur.parentElement; }
                return false;
            },
            closest(sel) {
                const classes = String(sel).split('.').filter(Boolean);
                let cur = this;
                while (cur) {
                    const cs = classSet(cur.className);
                    if (classes.every(c => cs.has(c))) return cur;
                    cur = cur.parentElement;
                }
                return null;
            },
            getBoundingClientRect() {
                return {
                    left: 0, top: 0,
                    width: this.offsetWidth, height: this.offsetHeight,
                    right: this.offsetWidth, bottom: this.offsetHeight,
                };
            },
            get isConnected() {
                let cur = this;
                while (cur) { if (cur === doc.body) return true; cur = cur.parentElement; }
                return false;
            },
            get offsetParent() {
                if (!this.isConnected || isHiddenByCss(this)) return null;
                return doc.body;
            },
            get offsetWidth() {
                if (classSet(el.className).has('xterm-char-measure-element')) return 32 * CELL_W;
                if (!this.isConnected || isHiddenByCss(this)) return 0;
                for (let cur = this; cur; cur = cur.parentElement) {
                    if (cur._customW !== null && cur._customW !== undefined) return cur._customW;
                }
                return envWidth;
            },
            get offsetHeight() {
                if (classSet(el.className).has('xterm-char-measure-element')) return CELL_H;
                if (!this.isConnected || isHiddenByCss(this)) return 0;
                for (let cur = this; cur; cur = cur.parentElement) {
                    if (cur._customH !== null && cur._customH !== undefined) return cur._customH;
                }
                return envHeight;
            },
            get clientWidth() { return this.offsetWidth; },
            get clientHeight() { return this.offsetHeight; },
            get scrollHeight() {
                if (!this.isConnected || isHiddenByCss(this)) return 0;
                const sa = this.children.find(c => classSet(c.className).has('xterm-scroll-area'));
                const sh = sa ? (parseFloat(sa.style.height) || 0) : 0;
                return Math.max(this.clientHeight, sh);
            },
            get scrollTop() {
                return (!this.isConnected || isHiddenByCss(this)) ? 0 : _scrollTop;
            },
            set scrollTop(v) {
                if (!this.isConnected || isHiddenByCss(this)) return;
                const max = Math.max(0, this.scrollHeight - this.clientHeight);
                const clamped = Math.max(0, Math.min(Number(v) || 0, max));
                const snapped = Math.round(clamped * ctx.devicePixelRatio) / ctx.devicePixelRatio;
                if (snapped !== _scrollTop) {
                    _scrollTop = snapped;
                    pendingScrollEvents.push(this);
                }
            },
            _resetScrollTopSilently() { _scrollTop = 0; },
            focus() { doc.activeElement = this; },
            blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
            select() {},
            scrollIntoView() {},
            getRootNode() { return doc; },
        };

        el.classList = {
            add: (...cs) => {
                const s = classSet(el.className);
                cs.forEach(c => s.add(c));
                el.className = [...s].join(' ');
            },
            remove: (...cs) => {
                const s = classSet(el.className);
                cs.forEach(c => s.delete(c));
                el.className = [...s].join(' ');
            },
            toggle: (c, force) => {
                const s = classSet(el.className);
                const on = force === undefined ? !s.has(c) : !!force;
                on ? s.add(c) : s.delete(c);
                el.className = [...s].join(' ');
                return on;
            },
            contains: c => classSet(el.className).has(c),
        };
        Object.assign(el, over);
        return el;
    }

    function matchesSel(el, sel) {
        const m = /^((?:\.[A-Za-z0-9_-]+)+)(?:\[data-(pane|tab)="([^"]+)"\])?$/.exec(sel);
        if (!m) return false;
        const cs = classSet(el.className);
        const classes = m[1].split('.').filter(Boolean);
        if (!classes.every(c => cs.has(c))) return false;
        if (m[2] && el['$data-' + m[2]] !== m[3]) return false;
        return true;
    }
    function queryAll(root, sel) {
        const out = [];
        const walk = n => {
            for (const c of n.children || []) {
                if (matchesSel(c, sel)) out.push(c);
                walk(c);
            }
        };
        walk(root);
        return out;
    }
    function findById(root, id) {
        if (root.id === id) return root;
        for (const c of root.children || []) {
            const hit = findById(c, id);
            if (hit) return hit;
        }
        return null;
    }

    const ctx = {
        console,
        crypto: webcrypto,
        setTimeout: (fn, d) => tq.setTimeout(fn, d),
        clearTimeout: id => tq.clearTimeout(id),
        setInterval: () => 0,
        clearInterval: () => {},
        queueMicrotask: fn => queueMicrotask(fn),
        requestAnimationFrame: fn => {
            const id = rafSeq++;
            rafs.set(id, fn);
            return id;
        },
        cancelAnimationFrame: id => rafs.delete(id),
        performance: { now: () => Date.now() },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/120', platform: 'Win32', language: 'en-US' },
        devicePixelRatio: dpr,
        WheelEvent: { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
        addEventListener(type, fn) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const l = windowListeners.get(type) || [];
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
        dispatchEvent: () => true,
        getComputedStyle(el) {
            return {
                getPropertyValue(prop) {
                    if (prop === 'width') return `${el.offsetWidth}px`;
                    if (prop === 'height') return `${el.offsetHeight}px`;
                    return '0px';
                },
            };
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            on() {},
            removeListener() {},
            invoke: () => new Promise(() => {}),
        },
        require: () => ({ clipboard: { readText: () => '', writeText() {} } }),
        ClipboardAddon: class { activate() {} },
        SearchAddon: class { activate() {} onDidChangeResults() {} clearDecorations() {} },
        WebglAddon: class { activate() {} dispose() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        MutationObserver: class { observe() {} disconnect() {} },
        getTerminalTheme: () => ({ background: '#12141c', foreground: '#e8e9f1', cursor: '#ffffff' }),
        colorFgbgForBackground: () => null,
        _normalizeFontFamily: s => s,
        _normalizeWordSeparators: () => '',
        _getAccentColor: () => 'rgb(97,175,239)',
        _getAccentColorAlpha: a => `rgba(97,175,239,${a})`,
        _clampFontWeight: (v, d) => d,
        _settingsConfig: { lineHeight: 1.125, fontSize: 16, scrollback: 10000 },
        ptyBuffers: {},
        GAP_PX: 8,
        Icons: { iconSvg: () => 'svg' },
        escHtml: s => String(s),
        showToast() {},
        LinkOpen: { handleLinkActivate() {}, showLinkTip() {}, hideLinkTip() {} },
        _createWebLinksAddon: () => ({ activate() {} }),
        saveConfig() {},
        clearAlternateScreen() {},
    };
    ctx.window = ctx;
    ctx.self = ctx;
    ctx.globalThis = ctx;

    const body = mkEl('body');
    const mainArea = mkEl('div', { id: 'main-area' });
    const tabbar = mkEl('div', { id: 'tabbar' });
    tabbar.appendChild(mkEl('div', { id: 'btn-add-tab' }));
    body.appendChild(mainArea);
    body.appendChild(tabbar);
    body.appendChild(mkEl('div', { id: 'sb-conn' }));
    body.appendChild(mkEl('div', { id: 'search-bar' }));
    body.appendChild(mkEl('input', { id: 'search-input' }));
    body.appendChild(mkEl('span', { id: 'search-count' }));
    body.appendChild(mkEl('div', { id: 'settings-pane' }));

    doc = {
        body,
        activeElement: body,
        get visibilityState() { return docHidden ? 'hidden' : 'visible'; },
        get defaultView() { return ctx; },
        getElementById: id => findById(body, id),
        createElement: tag => mkEl(tag),
        createDocumentFragment: () => ({
            _fragment: true,
            children: [],
            appendChild(c) { this.children.push(c); return c; },
        }),
        querySelector: sel => queryAll(body, sel)[0] || null,
        querySelectorAll: sel => queryAll(body, sel),
        addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const l = docListeners.get(type) || [];
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
    };
    ctx.document = doc;
    ctx.window.__imeCaretAnchor = { patchTerminal: () => true };

    vm.createContext(ctx);
    vm.runInContext('var _sftpAnimating = false;', ctx);
    vm.runInContext(XTERM_BUNDLE, ctx, { filename: 'xterm.js' });
    vm.runInContext(FIT_BUNDLE, ctx, { filename: 'addon-fit.js' });
    ctx.Terminal = ctx.TabbyXterm.Terminal;
    ctx.FitAddon = ctx.FitAddon.FitAddon;

    for (const f of [
        'split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js',
        'font-governance.js', 'terminal.js', 'tabstrip-layout.js', 'tabs.js', 'ipc.js', 'split.js',
    ]) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    ctx._wireSmoothCursorWebgl = () => ({ _adapter: null, setOptions() {}, dispose() {} });

    function flushFramesAndScrolls() {
        for (let pass = 0; pass < 30; pass++) {
            let ran = false;
            for (const [id, fn] of [...rafs]) {
                rafs.delete(id);
                fn();
                ran = true;
            }
            while (pendingScrollEvents.length) {
                const target = pendingScrollEvents.shift();
                target.dispatch('scroll', {});
                ran = true;
            }
            if (!ran) break;
        }
    }

    function advance(ms) {
        tq.advance(ms);
        flushFramesAndScrolls();
    }

    function writeLines(term, count, prefix = 'line') {
        let out = '';
        for (let i = 0; i < count; i++) out += `${prefix} ${i}\r\n`;
        term._core.writeSync(out);
        flushFramesAndScrolls();
    }

    function wheel(term, deltaY) {
        term.element.dispatch('wheel', {
            deltaY,
            deltaMode: 0,
            shiftKey: false,
            altKey: false,
            ctrlKey: false,
            cancelable: true,
            preventDefault() {},
            stopPropagation() {},
        });
        flushFramesAndScrolls();
    }

    function makeTab(id, backendId) {
        const tab = {
            id, name: id, type: 'local', command: 'powershell.exe', args: [], connected: true,
        };
        ctx.TabManager.tabs.push(tab);
        ctx.wireTerminal(tab, backendId);
        return tab;
    }

    function setSize(w, h) { envWidth = w; envHeight = h; }
    function setDocHidden(hidden) {
        const prev = docHidden;
        docHidden = hidden;
        if (!prev && hidden) resetSubtreeScrollTop(body);
        (docListeners.get('visibilitychange') || []).slice().forEach(fn => fn({}));
        flushFramesAndScrolls();
    }

    return {
        ctx, tq, sends, mainArea, doc,
        flushFramesAndScrolls, advance, writeLines, wheel, makeTab, setSize, setDocHidden,
    };
}

test('control proof: raw vendored xterm.js without viewport sync reproduces both Issue #46 symptoms', () => {
    const env = createRealXtermEnv({ height: 705 }); // 30 rows * 23px = 690px + 15px slack
    const wrap = env.doc.createElement('div');
    wrap.className = 'term-wrap active';
    env.mainArea.appendChild(wrap);

    const term = new env.ctx.Terminal({ cols: 80, rows: 30, lineHeight: 1.125, scrollback: 10000 });
    term.open(wrap);
    env.advance(50);

    const vp = term._core.viewport;
    const vpEl = vp._viewportElement;

    env.writeLines(term, 50, 'init');
    assert.equal(term.buffer.active.viewportY, term.buffer.active.baseY);
    assert.equal(vpEl.scrollTop, term.buffer.active.baseY * vp._currentRowHeight);

    // Hide the wrap (display:none) and stream 500 background lines.
    wrap.classList.remove('active');
    env.writeLines(term, 500, 'bg');
    assert.equal(vp._lastRecordedViewportHeight, 0, 'hidden _innerRefresh recorded offsetHeight === 0');
    assert.equal(vp._ignoreNextScrollEvent, true, 'hidden scrollTop write left _ignoreNextScrollEvent dangling');

    // Unhide WITHOUT our sync fix: screen shows bottom (viewportY === baseY),
    // but DOM scrollTop is 0 and scrollArea is one full page too short.
    wrap.classList.add('active');
    const baseY = term.buffer.active.baseY;
    assert.equal(term.buffer.active.viewportY, baseY);
    assert.equal(vpEl.scrollTop, 0);

    // Symptom 1: wheel DOWN causes an abnormal jump UP near line 0.
    env.wheel(term, 100);
    env.wheel(term, 100);
    assert.ok(term.buffer.active.viewportY < 20, `expected jump near top, got ${term.buffer.active.viewportY}`);

    // Symptom 2: wheel DOWN repeatedly cannot reach the latest page (stuck ~1 page above baseY).
    for (let i = 0; i < 200; i++) env.wheel(term, 100);
    assert.ok(
        baseY - term.buffer.active.viewportY >= term.rows,
        `expected >= ${term.rows} unreachable bottom rows, got ${baseY - term.buffer.active.viewportY}`,
    );
    assert.equal(term._core._bufferService.isUserScrolling, true);
});

test('single tab: hidden background output -> switch back -> zero jump on wheel down & wheel up-then-down reaches exact bottom', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabA = env.makeTab('t_a', 'pty_a');
    const tabB = env.makeTab('t_b', 'pty_b');
    env.ctx.TabManager.switchTo('t_a');
    env.advance(100);

    const vp = tabA.term._core.viewport;
    const vpEl = vp._viewportElement;

    env.writeLines(tabA.term, 50, 'visible');
    assert.equal(tabA.term.buffer.active.viewportY, tabA.term.buffer.active.baseY);

    // Switch to Tab B (Tab A becomes display:none) and stream 500 lines into Tab A.
    env.ctx.TabManager.switchTo('t_b');
    env.advance(50);
    env.writeLines(tabA.term, 500, 'bg');
    assert.equal(vp._lastRecordedViewportHeight, 0, 'background output ran while hidden');

    // Switch back to Tab A: viewport must be synced IMMEDIATELY (before the 10ms fit timer).
    env.ctx.TabManager.switchTo('t_a');
    env.flushFramesAndScrolls();
    const baseY = tabA.term.buffer.active.baseY;
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'stays at bottom immediately on switch back');
    assert.equal(vpEl.scrollTop, baseY * vp._currentRowHeight, 'DOM scrollTop synced immediately');
    assert.equal(vp._lastRecordedViewportHeight, 705, 'scroll area height rebuilt with live offsetHeight');

    // Symptom 1 check BEFORE 10ms timer: wheel DOWN must stay at bottom (zero jump!).
    env.wheel(tabA.term, 100);
    env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down immediately after switch does not jump up');
    assert.equal(tabA.term._core._bufferService.isUserScrolling, false);

    // Advance past 10ms fit timer (_fitTermSync -> _fitWithScroll) and verify again.
    env.advance(50);
    assert.equal(tabA.term.buffer.active.viewportY, baseY);
    assert.equal(vpEl.scrollTop, baseY * vp._currentRowHeight);

    // Symptom 2 check: wheel UP into history, then wheel DOWN must reach the EXACT latest page/line.
    for (let i = 0; i < 20; i++) env.wheel(tabA.term, -100);
    assert.ok(tabA.term.buffer.active.viewportY < baseY - 50, 'scrolled up into long output');
    assert.equal(tabA.term._core._bufferService.isUserScrolling, true);

    for (let i = 0; i < 40; i++) env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down reaches exact bottom (latest page)');
    assert.equal(tabA.term._core._bufferService.isUserScrolling, false, 'auto-follow resumes at bottom');
});

test('single tab with exact row-multiple height and zero background output still restores scrollTop on switch back', () => {
    // 690px === 30 * 23px === css.canvas.height: raw viewport.syncScrollArea(true)
    // short-circuits here because _lastScrollTop stayed stale when display:none reset scrollTop to 0.
    const env = createRealXtermEnv({ height: 690 });
    const tabA = env.makeTab('t_a', 'pty_a');
    env.makeTab('t_b', 'pty_b');
    env.ctx.TabManager.switchTo('t_a');
    env.advance(100);

    env.writeLines(tabA.term, 200, 'line');
    const baseY = tabA.term.buffer.active.baseY;
    const vp = tabA.term._core.viewport;
    const vpEl = vp._viewportElement;
    assert.equal(vp._lastRecordedViewportHeight, vp._renderDimensions.css.canvas.height);

    // Switch away and back with ZERO background output.
    env.ctx.TabManager.switchTo('t_b');
    env.advance(50);
    env.ctx.TabManager.switchTo('t_a');
    env.flushFramesAndScrolls();

    assert.equal(vpEl.scrollTop, baseY * vp._currentRowHeight, 'DOM scrollTop restored despite no output');
    env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down does not jump up');
});

test('single tab: intentionally scrolled-up position is preserved across tab switch + background output, and wheel down reaches bottom', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabA = env.makeTab('t_a', 'pty_a');
    env.makeTab('t_b', 'pty_b');
    env.ctx.TabManager.switchTo('t_a');
    env.advance(100);

    env.writeLines(tabA.term, 300, 'initial');
    // User intentionally scrolls UP into scrollback.
    for (let i = 0; i < 30; i++) env.wheel(tabA.term, -100);
    const savedY = tabA.term.buffer.active.viewportY;
    assert.ok(savedY > 0 && savedY < tabA.term.buffer.active.baseY - 50, `expected mid-scroll position, got ${savedY}`);

    // Switch away and stream 400 background lines into Tab A.
    env.ctx.TabManager.switchTo('t_b');
    env.advance(50);
    env.writeLines(tabA.term, 400, 'bg');

    // Switch back to Tab A (check both immediately and after the 10ms fit timer).
    env.ctx.TabManager.switchTo('t_a');
    env.flushFramesAndScrolls();
    const vp = tabA.term._core.viewport;
    const vpEl = vp._viewportElement;
    assert.equal(tabA.term.buffer.active.viewportY, savedY, 'scrolled-up position preserved immediately');
    assert.equal(vpEl.scrollTop, savedY * vp._currentRowHeight, 'DOM scrollTop matches scrolled-up row');

    env.advance(50);
    assert.equal(tabA.term.buffer.active.viewportY, savedY, 'scrolled-up position preserved after fit timer');
    assert.equal(vpEl.scrollTop, savedY * vp._currentRowHeight, 'DOM scrollTop still matches scrolled-up row');

    // Scrolling DOWN moves forward from savedY (no jump to 0) and reaches the new baseY.
    env.wheel(tabA.term, 100);
    assert.ok(tabA.term.buffer.active.viewportY > savedY, 'first wheel down advances from preserved row');
    for (let i = 0; i < 200; i++) env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, tabA.term.buffer.active.baseY, 'wheel down reaches newest line');
    assert.equal(tabA.term._core._bufferService.isUserScrolling, false);
});

test('single tab: scrolled to top (viewportY === 0) clears dangling _ignoreNextScrollEvent on show', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabA = env.makeTab('t_a', 'pty_a');
    env.makeTab('t_b', 'pty_b');
    env.ctx.TabManager.switchTo('t_a');
    env.advance(100);

    env.writeLines(tabA.term, 200, 'line');
    // Hide and output so hidden _innerRefresh leaves _ignoreNextScrollEvent === true,
    // then move buffer to top (ydisp === 0) while hidden.
    env.ctx.TabManager.switchTo('t_b');
    env.advance(20);
    env.writeLines(tabA.term, 100, 'bg');
    tabA.term.scrollToTop();
    env.flushFramesAndScrolls();
    assert.equal(tabA.term.buffer.active.viewportY, 0);

    env.ctx.TabManager.switchTo('t_a');
    env.flushFramesAndScrolls();
    assert.equal(tabA.term._core.viewport._ignoreNextScrollEvent, false, 'no dangling ignore flag at ydisp === 0');

    // Very first downward wheel tick must take effect (not be swallowed).
    env.wheel(tabA.term, 100);
    assert.ok(tabA.term.buffer.active.viewportY > 0, 'first wheel down scrolls from row 0 immediately');
});

test('split tab: switch away/back syncs ALL panes (focused at bottom + unfocused scrolled up + unfocused at bottom)', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabS = env.makeTab('t_s', 'pty_1');
    env.makeTab('t_other', 'pty_other');
    env.ctx.TabManager.switchTo('t_s');
    env.advance(100);

    // Split tabS into 3 panes: p1 (focused, at bottom), p2 (unfocused, scrolled up), p3 (unfocused, at bottom).
    env.ctx.TabManager.addPaneRelativeTo(tabS, 'r');
    let panes = env.ctx.getAllPanes(tabS);
    panes[1].tabId = 'pty_2';
    env.ctx.wireTerminalToPane(tabS, panes[1]);
    env.ctx.TabManager.addPaneRelativeTo(tabS, 'b');
    panes = env.ctx.getAllPanes(tabS);
    panes[2].tabId = 'pty_3';
    env.ctx.wireTerminalToPane(tabS, panes[2]);
    env.advance(400);

    const [p1, p2, p3] = panes;
    p1.focused = true; p2.focused = false; p3.focused = false;

    env.writeLines(p1.term, 120, 'p1');
    env.writeLines(p2.term, 200, 'p2');
    env.writeLines(p3.term, 120, 'p3');

    // Scroll p2 UP intentionally; leave p1 and p3 at bottom.
    for (let i = 0; i < 20; i++) env.wheel(p2.term, -100);
    const p2SavedY = p2.term.buffer.active.viewportY;
    assert.ok(p2SavedY > 0 && p2SavedY < p2.term.buffer.active.baseY - 30);

    // Switch to another tab (split_t_s becomes display:none) and flood ALL 3 panes in background.
    env.ctx.TabManager.switchTo('t_other');
    env.advance(50);
    env.writeLines(p1.term, 400, 'p1-bg');
    env.writeLines(p2.term, 400, 'p2-bg');
    env.writeLines(p3.term, 400, 'p3-bg');

    // Switch back to split tabS: verify IMMEDIATELY (before 250ms timer) AND after 250ms settle.
    env.ctx.TabManager.switchTo('t_s');
    env.flushFramesAndScrolls();

    for (const p of [p1, p3]) {
        const b = p.term.buffer.active;
        assert.equal(b.viewportY, b.baseY, `${p.id} stays at bottom immediately`);
        assert.equal(p.term._core.viewport._viewportElement.scrollTop, b.baseY * p.term._core.viewport._currentRowHeight);
        env.wheel(p.term, 100);
        assert.equal(b.viewportY, b.baseY, `${p.id} wheel down stays at bottom (no jump)`);
    }
    assert.equal(p2.term.buffer.active.viewportY, p2SavedY, 'unfocused p2 preserves scrolled-up row immediately');
    assert.equal(
        p2.term._core.viewport._viewportElement.scrollTop,
        p2SavedY * p2.term._core.viewport._currentRowHeight,
        'unfocused p2 DOM scrollTop matches scrolled-up row',
    );

    // Advance past the 250ms split settle timer and verify wheel up->down reaches exact bottom on ALL panes.
    env.advance(350);
    assert.equal(p2.term.buffer.active.viewportY, p2SavedY, 'p2 still preserves scrolled-up row after 250ms settle');

    for (const p of [p1, p2, p3]) {
        for (let i = 0; i < 15; i++) env.wheel(p.term, -100);
        for (let i = 0; i < 200; i++) env.wheel(p.term, 100);
        assert.equal(p.term.buffer.active.viewportY, p.term.buffer.active.baseY, `${p.id} wheel down reaches exact bottom`);
        assert.equal(p.term._core._bufferService.isUserScrolling, false);
    }
});

test('split pane maximize -> background output on minimized sibling -> unmaximize repairs sibling viewport', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabS = env.makeTab('t_max', 'pty_1');
    env.ctx.TabManager.switchTo('t_max');
    env.advance(100);

    env.ctx.TabManager.addPaneRelativeTo(tabS, 'r');
    const [p1, p2] = env.ctx.getAllPanes(tabS);
    p2.tabId = 'pty_2';
    env.ctx.wireTerminalToPane(tabS, p2);
    env.advance(400);

    env.writeLines(p2.term, 80, 'before');
    // Maximize p1 -> p2's .split-pane gets style.display = 'none'.
    env.ctx.TabManager._maximizePane(tabS.id, p1.id);
    env.advance(250);

    // Stream 400 lines into minimized p2 while hidden.
    env.writeLines(p2.term, 400, 'minimized-bg');
    assert.equal(p2.term._core.viewport._lastRecordedViewportHeight, 0, 'minimized pane refreshed while hidden');

    // Unmaximize p1 -> p2 becomes visible again.
    env.ctx.TabManager._maximizePane(tabS.id, p1.id);
    env.flushFramesAndScrolls();
    const baseY = p2.term.buffer.active.baseY;
    assert.equal(p2.term.buffer.active.viewportY, baseY);
    assert.equal(p2.term._core.viewport._viewportElement.scrollTop, baseY * p2.term._core.viewport._currentRowHeight);

    env.wheel(p2.term, 100);
    assert.equal(p2.term.buffer.active.viewportY, baseY, 'unmaximized sibling wheel down stays at bottom');
    for (let i = 0; i < 20; i++) env.wheel(p2.term, -100);
    for (let i = 0; i < 50; i++) env.wheel(p2.term, 100);
    assert.equal(p2.term.buffer.active.viewportY, baseY, 'unmaximized sibling wheel up->down reaches exact bottom');
});

test('extract pane to tab reparents term.element and restores viewport scrollTop without jumping', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabS = env.makeTab('t_ex', 'pty_1');
    env.ctx.TabManager.switchTo('t_ex');
    env.advance(100);

    env.ctx.TabManager.addPaneRelativeTo(tabS, 'r');
    const [p1, p2] = env.ctx.getAllPanes(tabS);
    p2.tabId = 'pty_2';
    env.ctx.wireTerminalToPane(tabS, p2);
    env.advance(400);

    env.writeLines(p1.term, 200, 'p1');
    env.writeLines(p2.term, 200, 'p2');
    for (let i = 0; i < 15; i++) env.wheel(p2.term, -100);
    const p2SavedY = p2.term.buffer.active.viewportY;

    // Extract p2 into its own tab (reparents both p1 and p2 into new wraps, activates p2's new tab).
    env.ctx.TabManager._extractPaneToTab(tabS.id, p2.id);
    env.flushFramesAndScrolls();
    env.advance(100);

    const extractedTab = env.ctx.TabManager.getActive();
    assert.equal(extractedTab.term, p2.term);
    assert.equal(p2.term.buffer.active.viewportY, p2SavedY, 'extracted pane keeps scrolled-up row');
    assert.equal(
        p2.term._core.viewport._viewportElement.scrollTop,
        p2SavedY * p2.term._core.viewport._currentRowHeight,
        'extracted pane DOM scrollTop restored after reparenting',
    );

    // Switch back to collapsed source tab (p1 was at bottom).
    env.ctx.TabManager.switchTo(tabS.id);
    env.flushFramesAndScrolls();
    env.advance(50);
    const p1BaseY = p1.term.buffer.active.baseY;
    assert.equal(p1.term.buffer.active.viewportY, p1BaseY);
    assert.equal(p1.term._core.viewport._viewportElement.scrollTop, p1BaseY * p1.term._core.viewport._currentRowHeight);
    env.wheel(p1.term, 100);
    assert.equal(p1.term.buffer.active.viewportY, p1BaseY, 'collapsed source tab wheel down does not jump');
});

test('sub-row container height growth (fit no-op) + spanner drag still syncs scrollArea so wheel reaches exact last line', () => {
    const env = createRealXtermEnv({ height: 690 }); // 30 rows exact
    const tabA = env.makeTab('t_sub', 'pty_sub');
    env.ctx.TabManager.switchTo('t_sub');
    env.advance(100);

    env.writeLines(tabA.term, 300, 'row');
    const baseY = tabA.term.buffer.active.baseY;
    assert.equal(tabA.term.rows, 30);

    // Grow container height by 20px (< 23px rowH -> FitAddon.fit() leaves rows === 30 unchanged!).
    env.setSize(800, 710);
    env.ctx._fitWithScroll(tabA.term, tabA.fitAddon, tabA.term.element.parentElement);
    env.flushFramesAndScrolls();

    assert.equal(tabA.term.rows, 30, 'rows unchanged (fit was a no-op)');
    assert.equal(tabA.term._core.viewport._lastRecordedViewportHeight, 710, 'viewport height updated despite fit no-op');

    for (let i = 0; i < 15; i++) env.wheel(tabA.term, -100);
    for (let i = 0; i < 30; i++) env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down reaches exact bottom line after sub-row growth');

    // Also verify _stopSpannerDrag syncs pane viewports when a drag ends with a sub-row height change.
    const tabS = env.makeTab('t_span', 'pty_s1');
    env.ctx.TabManager.switchTo('t_span');
    env.advance(100);
    env.ctx.TabManager.addPaneRelativeTo(tabS, 'b');
    const [p1, p2] = env.ctx.getAllPanes(tabS);
    p2.tabId = 'pty_s2';
    env.ctx.wireTerminalToPane(tabS, p2);
    env.advance(400);

    const body1 = env.doc.getElementById('pane-body_' + p1.id);
    body1._customH = 690;
    env.ctx._fitWithScroll(p1.term, p1.fitAddon, body1);
    env.flushFramesAndScrolls();
    env.writeLines(p1.term, 250, 'spanner');
    const p1BaseY = p1.term.buffer.active.baseY;
    assert.equal(p1.term.rows, 30);

    // Start and stop a spanner drag where pane 1 grows by +20px (still 30 rows, fit() no-ops).
    env.ctx._startSpannerDrag({ preventDefault() {}, pageY: 350 }, tabS, tabS.splitRoot, 1);
    body1._customH = 710;
    env.ctx._stopSpannerDrag({});
    env.flushFramesAndScrolls();

    assert.equal(p1.term.rows, 30, 'spanner drag left rows unchanged');
    assert.equal(p1.term._core.viewport._lastRecordedViewportHeight, 710, 'spanner release updated viewport height');
    for (let i = 0; i < 15; i++) env.wheel(p1.term, -100);
    for (let i = 0; i < 30; i++) env.wheel(p1.term, 100);
    assert.equal(p1.term.buffer.active.viewportY, p1BaseY, 'wheel down reaches exact bottom after spanner drag');
});

test('paused RenderService resize, renderer swap stale _renderDimensions, and fractional DPR (1.5x) stay synced', () => {
    const env = createRealXtermEnv({ dpr: 1.5, height: 705 });
    const tabA = env.makeTab('t_dpr', 'pty_dpr');
    env.makeTab('t_other', 'pty_other');
    env.ctx.TabManager.switchTo('t_dpr');
    env.advance(100);

    env.writeLines(tabA.term, 400, 'dpr');
    const core = tabA.term._core;
    const rs = core._renderService;
    const vp = core.viewport;

    // 1. Simulate renderer swap (WebGL attach/dispose) leaving vp._renderDimensions stale.
    const fakeOldDims = {
        device: { cell: { width: 10, height: 10 }, canvas: { width: 800, height: 300 } },
        css: { cell: { width: 10, height: 10 }, canvas: { width: 800, height: 1200 } },
    };
    vp._renderDimensions = fakeOldDims;

    // 2. Simulate resize while RenderService._isPaused === true (before IntersectionObserver fires).
    rs._isPaused = true;
    env.setSize(800, 500);
    env.ctx._fitWithScroll(tabA.term, tabA.fitAddon, tabA.term.element.parentElement);
    env.flushFramesAndScrolls();

    assert.equal(vp._renderDimensions, rs.dimensions, 'Viewport._renderDimensions re-bound to live renderer');
    assert.equal(
        rs.dimensions.css.canvas.height,
        Math.round(tabA.term.rows * rs.dimensions.device.cell.height / 1.5),
        'paused resize task flushed so renderer dimensions match live rows',
    );

    // 3. Repeated sync at fractional DPR must not leave _ignoreNextScrollEvent stuck true.
    env.ctx._syncTerminalViewport(tabA.term);
    env.flushFramesAndScrolls();
    assert.equal(vp._ignoreNextScrollEvent, false, 'no dangling ignore flag after fractional-DPR sync');

    // 4. Wheel UP then DOWN reaches exact bottom at 1.5x DPR.
    const baseY = tabA.term.buffer.active.baseY;
    for (let i = 0; i < 20; i++) env.wheel(tabA.term, -100);
    assert.ok(tabA.term.buffer.active.viewportY < baseY - 20);
    for (let i = 0; i < 40; i++) env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'reaches exact bottom at 1.5x DPR');
    assert.equal(core._bufferService.isUserScrolling, false);
});

test('switchTo under _sftpAnimating still suppresses fitAddon.fit() at 10ms while syncing viewport', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabA = env.makeTab('t_sftp', 'pty_sftp');
    env.makeTab('t_other', 'pty_other');
    env.ctx.TabManager.switchTo('t_sftp');
    env.advance(100);

    env.writeLines(tabA.term, 80, 'init');
    env.ctx.TabManager.switchTo('t_other');
    env.advance(50);
    env.writeLines(tabA.term, 300, 'bg');

    let fitCalls = 0;
    const origFit = tabA.fitAddon.fit.bind(tabA.fitAddon);
    tabA.fitAddon.fit = () => { fitCalls++; origFit(); };

    env.ctx._sftpAnimating = true;
    env.ctx.TabManager.switchTo('t_sftp');
    env.advance(20);
    assert.equal(fitCalls, 0, 'fitAddon.fit() stays suppressed during _sftpAnimating');

    const baseY = tabA.term.buffer.active.baseY;
    assert.equal(tabA.term.buffer.active.viewportY, baseY);
    assert.equal(tabA.term._core.viewport._viewportElement.scrollTop, baseY * tabA.term._core.viewport._currentRowHeight);
    env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down stays at bottom even when fit was suppressed');
});

test('window visibilitychange (minimize -> background output -> restore) repairs active tab viewport', () => {
    const env = createRealXtermEnv({ height: 705 });
    const tabA = env.makeTab('t_vis', 'pty_vis');
    env.ctx.TabManager.switchTo('t_vis');
    env.advance(100);

    env.writeLines(tabA.term, 60, 'init');
    env.setDocHidden(true);
    env.writeLines(tabA.term, 300, 'while-minimized');
    assert.equal(tabA.term._core.viewport._lastRecordedViewportHeight, 0);

    env.setDocHidden(false);
    const baseY = tabA.term.buffer.active.baseY;
    assert.equal(tabA.term._core.viewport._lastRecordedViewportHeight, 705);
    assert.equal(tabA.term._core.viewport._viewportElement.scrollTop, baseY * tabA.term._core.viewport._currentRowHeight);

    env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel down stays at bottom after window restore');
    for (let i = 0; i < 20; i++) env.wheel(tabA.term, -100);
    for (let i = 0; i < 40; i++) env.wheel(tabA.term, 100);
    assert.equal(tabA.term.buffer.active.viewportY, baseY, 'wheel up->down reaches exact bottom after window restore');
});
