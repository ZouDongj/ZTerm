// Shared renderer VM harness (factored from tests/terminal-search.test.mjs,
// batch 04). Runs the REAL terminal.js / tabs.js / split-layout.js /
// pane-fields.js / ssh-attempts.js / tab-title-utils.js / ipc.js and the REAL
// vendored addon-search.js in one VM; faked is only the environment:
//
// - REAL: the renderer scripts above and the addon bundle.
// - FAKED: DOM elements, TimerQueue (queued, never auto-run), ipcRenderer
//   recording bus, electron clipboard, RealTerm (buffer model mirroring the
//   xterm API the addon touches; focus() throws once disposed — a STRICT
//   SENTINEL, deliberately stricter than the bundled xterm, whose focus() is
//   a no-op without an opened textarea: the throw exists to DETECT forbidden
//   focus calls in tests, not to model native disposed behavior. The genuine
//   native crash class is the null term-slot dereference, which this model
//   reproduces exactly.)
//
// DOM focus emulation: document.activeElement starts at <body>; an element's
// focus() moves activeElement to it (as in a real page), and RealTerm.focus()
// moves activeElement to its .xterm element (xterm focuses the helper
// textarea INSIDE .xterm). Tests override activeElement directly to stage a
// specific focus owner; that staging is labeled at each use site.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const src = f => readFileSync(new URL(`../../src/renderer/${f}`, import.meta.url), 'utf8');
const vendor = f => readFileSync(new URL(`../../src/vendor/${f}`, import.meta.url), 'utf8');

// ── Fake DOM ────────────────────────────────────────────────────────────────
// The document whose activeElement tracks focus() calls (one per loadVm).
let activeDoc = null;

function classSet(str) { return new Set(String(str || '').split(/\s+/).filter(Boolean)); }

function mkEl(over = {}) {
    const el = {
        tagName: 'DIV', style: {}, dataset: {}, children: [],
        _listeners: new Map(), _cw: 0, _ch: 0, parentElement: null,
        className: '', id: '', innerHTML: '', textContent: '', value: '',
        setAttribute(k, v) { if (k === 'id') this.id = v; this['$' + k] = v; },
        getAttribute(k) { const v = this['$' + k]; return v === undefined ? null : v; },
        appendChild(c) {
            if (c.parentElement) {
                const i = c.parentElement.children.indexOf(c);
                if (i >= 0) c.parentElement.children.splice(i, 1);
            }
            c.parentElement = this; this.children.push(c); return c;
        },
        insertBefore(c, ref) {
            if (c.parentElement) {
                const i = c.parentElement.children.indexOf(c);
                if (i >= 0) c.parentElement.children.splice(i, 1);
            }
            c.parentElement = this;
            const at = ref ? this.children.indexOf(ref) : -1;
            if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c);
            return c;
        },
        remove() {
            if (this.parentElement) {
                const i = this.parentElement.children.indexOf(this);
                if (i >= 0) this.parentElement.children.splice(i, 1);
            }
            this.parentElement = null;
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
            return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
        },
        get clientWidth() { return this.parentElement ? this._cw : 0; },
        get clientHeight() { return this.parentElement ? this._ch : 0; },
        focus() {
            this._focused = true;
            if (activeDoc) activeDoc.activeElement = this;
        },
        blur() {
            this._focused = false;
            if (activeDoc && activeDoc.activeElement === this) activeDoc.activeElement = activeDoc.body;
        },
        scrollIntoView() {},
    };
    el.classList = {
        add: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
        remove: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
        toggle: (c, force) => {
            const s = classSet(el.className);
            const on = force === undefined ? !s.has(c) : !!force;
            on ? s.add(c) : s.delete(c);
            el.className = [...s].join(' ');
            return on;
        },
        contains: (c) => classSet(el.className).has(c),
    };
    Object.assign(el, over);
    return el;
}

// Selectors supported: dot-chained classes (`.a`, `.a.b`) with an optional
// [data-pane="..."] / [data-tab="..."] attribute filter.
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
    const walk = (n) => { n.children.forEach(c => { if (matchesSel(c, sel)) out.push(c); walk(c); }); };
    walk(root);
    return out;
}
function findById(root, id) {
    if (root.id === id) return root;
    for (const c of root.children) { const hit = findById(c, id); if (hit) return hit; }
    return null;
}

// ── Controllable timer queue (queued, never auto-run) ───────────────────────
export class TimerQueue {
    constructor() { this.seq = 0; this.timers = new Map(); this.now = 0; }
    setTimeout(fn, delay = 0) {
        const id = ++this.seq;
        this.timers.set(id, { id, seq: id, fn, at: this.now + (Number(delay) || 0) });
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    mark() { return this.seq; }
    createdAfter(mark) { return [...this.timers.values()].filter(t => t.seq > mark); }
    fireId(id) {
        const t = this.timers.get(id);
        if (!t) return false;
        this.timers.delete(id);
        t.fn();
        return true;
    }
    // Chronological sweep: each due callback runs AT its scheduled time (the
    // clock moves to that timer's deadline first), then the sweep continues
    // against the target. Timers scheduled INSIDE a callback therefore land
    // at deadline+delay and still run before the target when due — nested
    // timers interleave with outer ones exactly as real queued timeouts do,
    // and the queue finishes at `now + ms`.
    advance(ms) {
        const target = this.now + ms;
        for (;;) {
            const due = [...this.timers.values()].filter(t => t.at <= target)
                .sort((a, b) => a.at - b.at || a.seq - b.seq);
            if (!due.length) break;
            if (due[0].at > this.now) this.now = due[0].at;
            this.fireId(due[0].id);
        }
        this.now = target;
    }
}

// ── RealTerm: buffer model implementing exactly the xterm surface the REAL
// addon-search bundle reads (verified against the vendored source):
// buffer.active.{length,baseY,viewportY,cursorX,cursorY,getLine},
// line.{isWrapped,length,translateToString,getCell}, cell.{getChars,getWidth,
// getCode}, cols/rows, select/clearSelection/getSelectionPosition,
// scrollLines, registerMarker(.line), registerDecoration(.onRender/.onDispose/
// .dispose), onLineFeed/onCursorMove/onResize/onWriteParsed. focus() throws
// once disposed — a STRICT SENTINEL for forbidden focus calls, deliberately
// stricter than the bundled xterm (whose core focus is a no-op without an
// opened textarea; a Node no-DOM load proving that is NOT native
// opened-terminal evidence). Null-slot dereferences reproduce natively. ────
class FakeCell {
    constructor(ch) { this._ch = ch; }
    getChars() { return this._ch; }
    getWidth() { return this._ch ? 1 : 0; }
    getCode() { return this._ch ? this._ch.codePointAt(0) : 0; }
}
class FakeLine {
    constructor(text) { this.text = String(text); this.isWrapped = false; }
    get length() { return this.text.length; }
    translateToString(trimRight) { return trimRight ? this.text.replace(/\s+$/, '') : this.text; }
    getCell(x) { return x >= 0 && x < this.text.length ? new FakeCell(this.text[x]) : null; }
}
function sub(list, cb) {
    list.push(cb);
    return { dispose: () => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); } };
}
export class RealTerm {
    constructor() {
        this.options = {}; this.cols = 80; this.rows = 24;
        this.disposed = false; this.focused = false;
        this._addons = []; this._decorations = []; this._markers = [];
        this._selection = null; this._scrolls = [];
        this._dataSubs = []; this._resizeSubs = []; this._writeSubs = [];
        this._lineFeedSubs = []; this._cursorMoveSubs = [];
        const lines = [];
        this.buffer = {
            active: {
                lines,
                baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0,
                get length() { return lines.length; },
                getLine(i) { return i >= 0 && i < lines.length ? lines[i] : null; },
            },
        };
    }
    loadAddon(a) { this._addons.push(a); a.activate?.(this); }
    open(el) {
        this.element = mkEl();
        this.element.classList.add('xterm');
        el.appendChild(this.element);
    }
    attachCustomKeyEventHandler() {}
    onData(cb) { return sub(this._dataSubs, cb); }
    onResize(cb) { return sub(this._resizeSubs, cb); }
    onWriteParsed(cb) { return sub(this._writeSubs, cb); }
    onLineFeed(cb) { return sub(this._lineFeedSubs, cb); }
    onCursorMove(cb) { return sub(this._cursorMoveSubs, cb); }
    onSelectionChange() { return { dispose() {} }; }
    onBell() { return { dispose() {} }; }
    write(data) {
        const parts = String(data).split(/\r?\n/);
        const a = this.buffer.active;
        for (const p of parts) a.lines.push(new FakeLine(p));
        a.cursorY = a.lines.length - 1;
        a.cursorX = a.lines[a.lines.length - 1].length;
    }
    // Test-side trigger for what real xterm fires after parsing a write.
    __emitWriteParsed() { this._writeSubs.slice().forEach(cb => cb()); }
    select(col, row, len) { this._selection = { col, row, len }; }
    clearSelection() { this._selection = null; }
    hasSelection() { return this._selection !== null; }
    getSelection() {
        if (!this._selection) return '';
        const l = this.buffer.active.lines[this._selection.row];
        return l ? l.text.substr(this._selection.col, this._selection.len) : '';
    }
    getSelectionPosition() {
        if (!this._selection) return undefined;
        const s = this._selection;
        return { start: { x: s.col, y: s.row }, end: { x: s.col + s.len, y: s.row } };
    }
    scrollLines(n) { this._scrolls.push(n); }
    scrollToBottom() {}
    registerMarker(offset) {
        const m = { line: this.buffer.active.cursorY + offset, disposed: false, dispose() { this.disposed = true; } };
        this._markers.push(m);
        return m;
    }
    registerDecoration(opts) {
        const d = {
            opts, marker: opts?.marker ?? null, alive: true, _onRender: [], _onDispose: [],
            onRender(cb) { this._onRender.push(cb); return { dispose() {} }; },
            onDispose(cb) { this._onDispose.push(cb); return { dispose() {} }; },
            dispose() { if (!this.alive) return; this.alive = false; this._onDispose.forEach(cb => cb()); },
        };
        this._decorations.push(d);
        return d;
    }
    resize(cols, rows) {
        if (this.cols === cols && this.rows === rows) return;
        this.cols = cols; this.rows = rows;
        this._resizeSubs.slice().forEach(cb => cb({ cols, rows }));
    }
    focus() {
        if (this.disposed) throw new Error('Terminal has been disposed');
        this.focused = true;
        if (activeDoc && this.element) activeDoc.activeElement = this.element;
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._addons.forEach(a => a.dispose?.());
    }
}

export function loadVm() {
    const tq = new TimerQueue();
    const sends = [];
    const ipcHandlers = new Map();
    const clip = { text: '', readText: () => clip.text, readTextAsync: () => Promise.resolve(clip.text) };

    // Static page elements the product code reaches by id
    const root = mkEl({ _cw: 1200, _ch: 900 });
    const body = mkEl(); root.appendChild(body);
    const mainArea = mkEl({ _cw: 1000, _ch: 800, id: 'main-area' }); body.appendChild(mainArea);
    const tabbar = mkEl({ id: 'tabbar' }); body.appendChild(tabbar);
    tabbar.appendChild(mkEl({ id: 'btn-add-tab' }));
    body.appendChild(mkEl({ id: 'sb-conn' }));
    body.appendChild(mkEl({ id: 'search-bar' }));
    const searchInput = mkEl({ id: 'search-input', tagName: 'INPUT' }); body.appendChild(searchInput);
    const searchCount = mkEl({ id: 'search-count' }); body.appendChild(searchCount);
    body.appendChild(mkEl({ id: 'settings-pane' }));

    const ctx = {
        console,
        crypto: webcrypto,
        setTimeout: (fn, d) => tq.setTimeout(fn, d),
        clearTimeout: (id) => tq.clearTimeout(id),
        // The addon bundle's lifecycle module initializes a microtask-driven
        // async queue at load time (static initializer) — without this the
        // vendor script itself throws during vm load.
        queueMicrotask: (fn) => queueMicrotask(fn),
        requestAnimationFrame: (fn) => { fn(); return 0; },
        document: {
            getElementById: (id) => findById(root, id),
            createElement: (tag) => mkEl({ tagName: String(tag || 'div').toUpperCase() }),
            querySelector: (sel) => queryAll(root, sel)[0] || null,
            querySelectorAll: (sel) => queryAll(root, sel),
            body,
            // Real pages always resolve this; the harness tracks focus() calls.
            activeElement: body,
            addEventListener() {},
        },
        window: {
            __imeCaretAnchor: { patchTerminal: () => true },
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            on(ch, fn) {
                if (!ipcHandlers.has(ch)) ipcHandlers.set(ch, []);
                ipcHandlers.get(ch).push(fn);
            },
            removeListener(ch, fn) {
                const l = ipcHandlers.get(ch) || [];
                const i = l.indexOf(fn);
                if (i >= 0) l.splice(i, 1);
            },
            invoke: () => new Promise(() => {}),
        },
        require: () => ({ clipboard: clip }),
        Terminal: RealTerm,
        FitAddon: class { constructor() {} activate() {} fit() {} },
        ClipboardAddon: class { activate() {} },
        WebglAddon: class {},
        ResizeObserver: class { observe() {} disconnect() {} },
        MutationObserver: class { observe() {} disconnect() {} },
        requestIdleCallback: undefined,
        getTerminalTheme: () => ({}),
        _normalizeFontFamily: (s) => s,
        _getAccentColor: () => 'rgb(97,175,239)',
        _getAccentColorAlpha: (a) => `rgba(97,175,239,${a})`,
        _clampFontWeight: (v, d) => d,
        _settingsConfig: {},
        ptyBuffers: {},
        GAP_PX: 8,
        Icons: { iconSvg: () => 'svg' },
        escHtml: (s) => String(s),
        showToast() {},
        LinkOpen: { handleLinkActivate() {}, showLinkTip() {}, hideLinkTip() {} },
        _createWebLinksAddon: () => ({}),
        saveConfig() {},
        clearAlternateScreen() {},
        __tq: tq, __sends: sends, __searchInput: searchInput, __searchCount: searchCount, __mainArea: mainArea, __body: body,
        // Dispatch synthetic backend events through the REAL ipc.js handlers.
        __emit: (ch, payload) => {
            (ipcHandlers.get(ch) || []).slice().forEach(fn => fn({}, payload));
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext('var _spannerDrag = false; var _windowResizing = false;', ctx);
    // The REAL vendored search addon: its UMD tail assigns a NAMESPACE object
    // to globalThis.SearchAddon when no module/exports/define exists (true in
    // this VM, as in the page). In the real page utils.js then does
    // `const { SearchAddon } = require('@xterm/addon-search')` — a global
    // lexical binding of the UNWRAPPED class that shadows the namespace — so
    // replicate that resolution exactly.
    vm.runInContext(vendor('addon-search.js'), ctx, { filename: 'addon-search.js' });
    ctx.SearchAddon = ctx.SearchAddon.SearchAddon;
    for (const f of ['split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js', 'terminal.js', 'tabs.js', 'ipc.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    ctx._wireSmoothCursorWebgl = () => ({ _adapter: null, dispose() {} });
    activeDoc = ctx.document;
    return ctx;
}

// ── Shared wiring helpers ────────────────────────────────────────────────────
// Single local tab wired through the REAL wireTerminal (term + callbacks).
export function wiredTab(ctx, id, backendId, content, over = {}) {
    if (content !== undefined && content !== null) ctx.ptyBuffers[backendId] = content;
    const tab = { id, name: id, type: 'local', command: 'powershell.exe', args: [], connected: true, ...over };
    ctx.TabManager.tabs.push(tab);
    ctx.wireTerminal(tab, backendId);
    return tab;
}

// Split tab whose two panes both hold wired terminals: the first pane is the
// original tab terminal (real addPaneRelativeTo first-split branch), the
// second is wired the way ipc.js wires a pane once its backend arrives.
export function wiredSplitTab(ctx, id, backend1, content1, backend2, content2, over = {}) {
    const tab = wiredTab(ctx, id, backend1, content1, over);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assertSplit(panes);
    const p2 = panes[1];
    p2.tabId = backend2;
    if (content2 !== undefined && content2 !== null) ctx.ptyBuffers[backend2] = content2;
    ctx.wireTerminalToPane(tab, p2);
    return { tab, p1: panes[0], p2 };
}
function assertSplit(panes) {
    if (panes.length !== 2) throw new Error(`first split built ${panes.length} panes, expected 2`);
}

// Reset the observable focus state before a timed observation window: the
// RealTerm.focused flag is sticky (nothing in the model clears it), so tests
// that count focus LANDINGS within a window clear it first.
export function armFocusWindow(ctx) {
    for (const t of ctx.TabManager.tabs) {
        if (t.term) t.term.focused = false;
        if (t.splitRoot) for (const p of ctx.getAllPanes(t)) if (p.term) p.term.focused = false;
    }
    ctx.document.activeElement = ctx.document.body;
}
