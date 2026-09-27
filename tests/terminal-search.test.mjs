// Batch 03: terminal search correctness (count/index, navigation, empty and
// no-match queries, close/reopen, active terminal switching and migration),
// driven through the REAL vendored addon-search.js AND the REAL terminal.js /
// tabs.js handlers in one VM. The addon's engine, result tracker, decoration
// manager and event gating all run for real — what is faked is only the
// environment: the DOM, the timers, the IPC bus and a buffer-model Terminal
// that implements the exact surface the addon reads (buffer lines, cells,
// selection, markers, decorations, write/resize events). Nothing in the
// harness emits search results directly.
//
// Environment fakes vs. real components:
// - REAL: src/vendor/addon-search.js (whole bundle), terminal.js, tabs.js,
//   split-layout.js, pane-fields.js, ssh-attempts.js, tab-title-utils.js,
//   ipc.js handler registrations.
// - FAKED: DOM elements, TimerQueue (queued, never auto-run), ipcRenderer
//   recording bus, electron clipboard, RealTerm (buffer model mirroring the
//   xterm API the addon touches; focus() throws once disposed, like xterm).
//
// Red/green honesty (correction round 1): against the BASELINE code every
// count-driven test failed at its FIRST count assertion (the addon's event
// gate never fired without decoration options), so later assertions inside
// those tests were NOT independently exercised pre-fix. Independently red
// pre-fix: the disposed-focus hazard (old code throws) and the correction
// tests below (manual selection erased, first-split/collapse count stuck).
// Tests explicitly labeled "(guard)" pin hazards the fix itself introduces
// or exposes (background addon refresh, close/reopen cleanup); they pass
// trivially on the old code and exist to protect the corrected behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
const vendor = f => readFileSync(new URL(`../src/vendor/${f}`, import.meta.url), 'utf8');

// ── Fake DOM (same contract as split-owner-regressions.test.mjs) ────────────
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
            const cls = String(sel).startsWith('.') ? String(sel).slice(1) : null;
            let cur = this;
            while (cur) { if (cls && classSet(cur.className).has(cls)) return cur; cur = cur.parentElement; }
            return null;
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
        },
        get clientWidth() { return this.parentElement ? this._cw : 0; },
        get clientHeight() { return this.parentElement ? this._ch : 0; },
        focus() { this._focused = true; },
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

function matchesSel(el, sel) {
    const m = /^\.([A-Za-z0-9_-]+)(\[data-(pane|tab)="([^"]+)"\])?$/.exec(sel);
    if (!m) return false;
    if (!classSet(el.className).has(m[1])) return false;
    if (m[2] && el['$data-' + m[3]] !== m[4]) return false;
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
class TimerQueue {
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
    advance(ms) {
        this.now += ms;
        for (;;) {
            const due = [...this.timers.values()].filter(t => t.at <= this.now)
                .sort((a, b) => a.at - b.at || a.seq - b.seq);
            if (!due.length) break;
            this.fireId(due[0].id);
        }
    }
}

// ── RealTerm: buffer model implementing exactly the xterm surface the REAL
// addon-search bundle reads (verified against the vendored source):
// buffer.active.{length,baseY,viewportY,cursorX,cursorY,getLine},
// line.{isWrapped,length,translateToString,getCell}, cell.{getChars,getWidth,
// getCode}, cols/rows, select/clearSelection/getSelectionPosition,
// scrollLines, registerMarker(.line), registerDecoration(.onRender/.onDispose/
// .dispose), onLineFeed/onCursorMove/onResize/onWriteParsed. focus() throws
// once disposed, matching xterm's disposed-terminal behavior. ───────────────
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
class RealTerm {
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
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._addons.forEach(a => a.dispose?.());
    }
}

function loadVm() {
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
    const searchInput = mkEl({ id: 'search-input' }); body.appendChild(searchInput);
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
            createElement: () => mkEl(),
            querySelector: (sel) => queryAll(root, sel)[0] || null,
            querySelectorAll: () => [],
            body,
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
        __tq: tq, __sends: sends, __searchInput: searchInput, __searchCount: searchCount, __mainArea: mainArea,
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
    return ctx;
}

// ── Shared wiring helpers ────────────────────────────────────────────────────
function wiredTab(ctx, id, backendId, content, over = {}) {
    ctx.ptyBuffers[backendId] = content;
    const tab = { id, name: id, type: 'local', command: 'powershell.exe', args: [], connected: true, ...over };
    ctx.TabManager.tabs.push(tab);
    ctx.wireTerminal(tab, backendId);
    return tab;
}
function wiredSplitTab(ctx, id, backend1, content1, backend2, content2) {
    const tab = wiredTab(ctx, id, backend1, content1);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'first split built two panes');
    const p2 = panes[1];
    p2.tabId = backend2;
    ctx.ptyBuffers[backend2] = content2;
    ctx.wireTerminalToPane(tab, p2);
    return { tab, p1: panes[0], p2 };
}
const countText = (ctx) => ctx.__searchCount.textContent;
const aliveDecorations = (term) => term._decorations.filter(d => d.alive).length;
function typeQuery(ctx, q) {
    ctx.__searchInput.value = q;
    ctx.doSearch();
}

const A_TEXT = 'alpha needle one\nplain line\nalpha needle two\nplain line\nalpha needle three';
const B_TEXT = 'alpha needle only\nbravo line\nalpha needle again';

// ═══ 1. Count + navigation through the REAL addon event gate ═══

test('count fires and tracks index for multiple matches (RED old code: no event without decorations)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    ctx.__tq.advance(60); // openSearch input-focus timer
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    assert.ok(ctx.TabManager.getActive().term.hasSelection(), 'first match selected');
    assert.match(ctx.TabManager.getActive().term.getSelection(), /alpha needle/);

    ctx.searchNext();
    assert.equal(countText(ctx), '2/3');
    ctx.searchNext();
    assert.equal(countText(ctx), '3/3');
    // Wraparound forward: past the last match → first again.
    ctx.searchNext();
    assert.equal(countText(ctx), '1/3');
    // Wraparound backward: previous from the first → the last match.
    ctx.searchPrev();
    assert.equal(countText(ctx), '3/3');
    ctx.searchPrev();
    assert.equal(countText(ctx), '2/3');
});

test('query replacement: no-match query blanks the count, new query re-counts', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    typeQuery(ctx, 'zzz-no-such-needle');
    assert.equal(countText(ctx), '', 'no-match query shows an empty count');
    typeQuery(ctx, 'plain');
    assert.equal(countText(ctx), '1/2');
});

// ═══ 2. Empty query clears everything, not just the decorations ═══

test('empty query clears counter, search-owned selection and decorations (guard)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    const term = ctx.TabManager.getActive().term;
    assert.ok(aliveDecorations(term) > 0, 'decorations were created for the query');

    typeQuery(ctx, '');
    assert.equal(countText(ctx), '', 'stale counter must not survive an emptied query');
    assert.equal(term.hasSelection(), false, 'old selection dropped');
    assert.equal(aliveDecorations(term), 0, 'decorations disposed');
    // Enter/Shift+Enter on an empty query follow the same clearing path.
    typeQuery(ctx, 'plain');
    ctx.__searchInput.value = '';
    ctx.searchNext();
    assert.equal(countText(ctx), '');
    assert.equal(aliveDecorations(term), 0);
});

// ═══ 3. Close/reopen: no stale counter, no resurrect from background refresh ═══

test('close clears the counter; background addon refresh cannot resurrect it (guard)', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');

    ctx.closeSearch();
    assert.equal(countText(ctx), '', 'close blanks the counter');
    assert.equal(aliveDecorations(tab.term), 0, 'close disposes the match decorations');
    // Background write on the same terminal: the addon's 200ms refresh fires
    // for its cached decorations options — it must not repopulate the closed bar.
    tab.term.write('alpha needle four\n');
    tab.term.__emitWriteParsed();
    ctx.__tq.advance(300);
    assert.equal(countText(ctx), '', 'closed search bar stays blank');
    assert.equal(ctx.document.getElementById('search-bar').classList.contains('open'), false);
});

test('reopen starts blank: no stale owner, no counter for the dead query (guard)', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    // Ctrl+F again without closing: openSearch resets input/counter AND the
    // previous query's owner state (decorations + cached term).
    ctx.openSearch();
    assert.equal(ctx.__searchInput.value, '');
    assert.equal(countText(ctx), '');
    assert.equal(aliveDecorations(tab.term), 0, 'previous query decorations dropped');
    tab.term.write('alpha needle four\n');
    tab.term.__emitWriteParsed();
    ctx.__tq.advance(300);
    assert.equal(countText(ctx), '', 'background refresh of the dead query writes nothing');
});

// ═══ 4. Active terminal switching refreshes the displayed results ═══

test('switching tabs re-runs the query on the newly active terminal (RED old code: stale count)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    ctx.searchNext();
    assert.equal(countText(ctx), '2/3');
    const termA = ctx.TabManager.tabs.find(t => t.id === 't_a').term;

    ctx.TabManager.switchTo('t_b');
    assert.equal(countText(ctx), '1/2', 'count follows the active terminal (B has 2 matches)');
    assert.equal(aliveDecorations(termA), 0, 'previous terminal decorations dropped');

    // Navigation continues on the NEW owner; wraparound prev lands on its last match.
    ctx.searchPrev();
    assert.equal(countText(ctx), '2/2');

    // Switching back restarts the search on A deterministically.
    ctx.TabManager.switchTo('t_a');
    assert.equal(countText(ctx), '1/3');
});

test('switching to a tab with no match for the query blanks the count (RED old code)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    wiredTab(ctx, 't_c', 'local_c', 'completely different content\nnothing here');
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    ctx.TabManager.switchTo('t_c');
    assert.equal(countText(ctx), '', 'no-match terminal shows an empty count');
    // And the empty terminal's decorations are clean.
    assert.equal(aliveDecorations(ctx.TabManager.tabs.find(t => t.id === 't_c').term), 0);
});

test('pane focus move within a split re-runs the query on the focused pane', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.openSearch();
    p1.focused = true; p2.focused = false;
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');

    ctx.TabManager._focusPane(tab, p2.id);
    assert.equal(countText(ctx), '1/2', 'focused pane B owns the count');
    ctx.TabManager._focusPane(tab, p1.id);
    assert.equal(countText(ctx), '1/3', 'focus back to pane A restores its count');
});

// ═══ 5. Background terminal updates must not overwrite the displayed results ═══

test('background write on another terminal does not overwrite the active count (guard)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');

    // Give B's addon a cached query + decorations options of its own.
    ctx.TabManager.switchTo('t_b');
    assert.equal(countText(ctx), '1/2');
    ctx.TabManager.switchTo('t_a');
    assert.equal(countText(ctx), '1/3');
    ctx.searchNext();
    assert.equal(countText(ctx), '2/3');

    // B receives output in the background: its addon refresh fires 200ms later.
    const termB = ctx.TabManager.tabs.find(t => t.id === 't_b').term;
    termB.write('alpha needle background\n');
    termB.__emitWriteParsed();
    ctx.__tq.advance(300);
    assert.equal(countText(ctx), '2/3', 'the active terminal\'s count is untouched');
});

// ═══ 6. Migration keeps the search following the terminal (batch 01 ownership) ═══

test('extract moves the search with the terminal; both tabs re-count (RED old code)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_m', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_m');
    ctx.openSearch();
    p1.focused = true; p2.focused = false;
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.ok(nt, 'extracted tab exists');
    assert.equal(ctx.TabManager.activeId, nt.id, 'extract switched to the new tab');
    assert.equal(countText(ctx), '1/2', 'extracted terminal owns the count after the switch');

    ctx.TabManager.switchTo('t_m');
    assert.equal(countText(ctx), '1/3', 'surviving tab re-counts its own matches');
});

test('search still follows the focused pane after _exitSplit (batch 01 regression)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_ex', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_ex');
    ctx.openSearch();
    p1.focused = true; p2.focused = false;
    typeQuery(ctx, 'alpha needle');
    assert.equal(countText(ctx), '1/3');
    ctx.TabManager._exitSplit(tab);
    assert.equal(tab.term, p1.term, 'survivor collapsed onto the tab');
    // After the merge the active-terminal resolution moved pane→tab while the
    // owner term stayed the same: navigation continues on the survivor.
    ctx.searchNext();
    assert.equal(countText(ctx), '2/3', 'survivor still searchable after merge');
    // A fresh query re-targets the survivor through the same path.
    typeQuery(ctx, 'plain');
    assert.equal(countText(ctx), '1/2', 'fresh query on the merged terminal');
});

// ═══ 7. Delayed close-focus never targets a disposed terminal ═══
// Reachable sequence in normal clock order: closeSearch schedules its 50ms
// focus; _closePane then disposes the focused pane's terminal SYNCHRONOUSLY
// at initiation (tabs.js), well inside the window. Old code captured the
// focused pane and dereferenced its (now nulled/disposed) term at fire time.

test('closeSearch delayed focus survives _closePane disposing the terminal (RED old code: throws)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_cf', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_cf');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');       // focused pane p2 owns the search
    // No count assertion here: this test pins the DISPOSED-FOCUS hazard, and
    // must fail at that hazard (not at the generic missing count) pre-fix.
    ctx.__tq.advance(2000);               // drain unrelated setup timers

    const dyingTerm = p2.term;
    const mark = ctx.__tq.mark();
    ctx.closeSearch();
    const focusTimers = ctx.__tq.createdAfter(mark).filter(t => t.at - ctx.__tq.now === 50);
    assert.equal(focusTimers.length, 1, 'close scheduled exactly one 50ms focus timer');

    ctx.TabManager._closePane('t_cf', p2.id);
    assert.equal(dyingTerm.disposed, true, 'pane terminal disposed synchronously at initiation');
    assert.equal(p2.term, null, 'pane slot nulled at initiation (removal itself is deferred)');

    // Normal clock order: the 50ms callback fires AFTER the synchronous
    // dispose above. Old code: the captured focused pane's term is nulled →
    // the callback dereferences it and throws.
    assert.doesNotThrow(() => ctx.__tq.advance(60));
    // Deferred removal → _exitSplit → survivor focus chain. The virtual clock
    // jumps to the end of each advance(), so timers scheduled DURING the
    // sweep need one more flush — same semantics as the batch-01 harness.
    ctx.__tq.advance(600);
    ctx.__tq.advance(300);
    assert.equal(tab.term, p1.term, 'collapse handed the tab slot to the survivor');
    assert.equal(p1.term.focused, true, 'focus landed on the surviving terminal');
});

// ═══ 7b. (correction 1) Manual selections survive search cleanup ═══

test('manual selection survives close/empty/owner switch; search-owned selection is cleared (RED old code)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    // No count assertion here: this test pins SELECTION OWNERSHIP and must
    // fail at the manual-preservation assert (not the missing count) pre-fix.
    const termA = ctx.TabManager.tabs.find(t => t.id === 't_a').term;

    // The search's OWN selection (placed by the last find) is cleared on close.
    assert.ok(termA.getSelectionPosition(), 'search placed a selection');
    ctx.closeSearch();
    assert.equal(termA.getSelectionPosition(), undefined, 'search-owned selection cleared on close');

    // The user makes a MANUAL selection after a search — close must keep it.
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    termA.select(0, 1, 3); // reviewer repro: select(x=0, y=1, len=3)
    const manual1 = termA.getSelectionPosition();
    assert.deepEqual(manual1, { start: { x: 0, y: 1 }, end: { x: 3, y: 1 } });
    ctx.closeSearch();
    assert.deepEqual(termA.getSelectionPosition(), manual1, 'manual selection survives closeSearch');
    ctx.openSearch();
    assert.deepEqual(termA.getSelectionPosition(), manual1, 'manual selection survives reopen');

    // Empty query must not erase it either.
    termA.select(1, 0, 5);
    const manual2 = termA.getSelectionPosition();
    ctx.__searchInput.value = '';
    ctx.doSearch();
    assert.deepEqual(termA.getSelectionPosition(), manual2, 'manual selection survives empty query');

    // Owner switch: the previous terminal keeps a manual selection.
    typeQuery(ctx, 'alpha needle');
    termA.select(2, 4, 2);
    const manual3 = termA.getSelectionPosition();
    ctx.TabManager.switchTo('t_b');
    assert.deepEqual(termA.getSelectionPosition(), manual3, 'previous owner keeps its manual selection');
    // The new owner was searched too (regression: switching still works).
    assert.equal(countText(ctx), '1/2');
});

// ═══ 7c. (correction 2a) First split + asynchronous terminal arrival ═══

test('first split moves the search to the pending pane; rebinds when its terminal arrives (RED old code)', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_s1', 'local_1', A_TEXT);
    ctx.TabManager.switchTo('t_s1');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    // Baseline red lands at the REBIND assertion below (the pre-fix counter
    // never fires at all), which is the specific defect under test.
    ctx.__tq.advance(2000); // drain startup timers

    // First split (real method): the existing terminal is demoted onto a pane
    // and the FOCUS moves to the NEW pending pane — no term, no results.
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2);
    const fresh = panes.find(p => !p.term);
    assert.ok(fresh, 'new pane is pending');
    assert.equal(fresh.focused, true);
    assert.equal(countText(ctx), '', 'query stays; the pending pane shows no results');

    // Asynchronous backend arrival through the REAL ipc.js pty-created
    // handler (claims the pane + wires its terminal). The open query must
    // rebind without any further user action.
    ctx.ptyBuffers['local_fresh'] = 'fresh pane alpha needle single';
    ctx.__emit('pty-created', { tabId: 'local_fresh', requestId: fresh.requestId });
    assert.ok(fresh.term && !fresh.term.disposed, 'pane wired by the real handler');
    assert.equal(countText(ctx), '1/1', 'search rebound to the arrived terminal');
    assert.ok(aliveDecorations(fresh.term) > 0, 'fresh owner highlighted');
    const demoted = panes.find(p => p !== fresh);
    assert.equal(aliveDecorations(demoted.term), 0, 'demoted terminal keeps no decorations');
});

// ═══ 7d. (correction 2b) Closing the focused pane of a two-pane split ═══

test('closing the focused pane collapses via _exitSplit and the search follows the survivor (RED old code)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_s2', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_s2');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle'); // focused p2: B_TEXT has 2 matches
    // Baseline red lands at the post-collapse count below (stuck/blank
    // instead of the survivor's), which is the specific defect under test.
    ctx.__tq.advance(2000); // drain startup timers; no user action after this

    ctx.TabManager._closePane('t_s2', p2.id);
    ctx.__tq.advance(600); // let the removal/collapse complete
    assert.equal(ctx.getAllPanes(tab).length, 0, 'split collapsed');
    assert.equal(tab.term, p1.term, 'survivor owns the tab slot');
    // No extra doSearch anywhere: the collapse itself must hand the count over.
    assert.equal(countText(ctx), '1/3', 'survivor A (3 matches) owns the displayed count');
});

// ═══ 8. Options parity: every find call goes through the same option set ═══

test('searchPrev uses the same decoration options as findNext (RED old code: prev-only flags)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    typeQuery(ctx, 'alpha needle');
    ctx.searchNext();
    ctx.searchNext();
    // The old searchPrev passed only {caseSensitive, regex}: no decorations →
    // no event → the counter froze at the last findNext state.
    ctx.searchPrev();
    assert.equal(countText(ctx), '2/3', 'prev updates the count through the same event gate');
});
