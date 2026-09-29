// Repair-plan batch 01 gaps A–E: session/terminal ownership regressions,
// driven through the REAL terminal.js wiring callbacks AND the REAL tabs.js
// migration methods in one VM. Only the xterm addon classes, the DOM and the
// timers are fakes; split-layout.js, pane-fields.js, tab-title-utils.js,
// terminal.js and tabs.js are the real modules. Old-code failure notes are
// stated per test.
//
// Harness specifics that matter for the assertions:
// - Timers are queued, never auto-run: tests fire exact timer ids (or advance
//   the virtual clock) so pre-migration callbacks can be replayed AFTER a
//   migration/close/reconnect, which immediate-execution stubs cannot prove.
// - Element geometry is readable only while attached (clientWidth/Height are 0
//   once detached), so hidden/zero/disposed DOM guards are exercised for real.
// - FakeFitAddon measures term.element.parentElement (xterm semantics), so the
//   .term-inner content area vs the padded container distinction is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');

const CELL_W = 10, CELL_H = 10;

// ── Fake DOM ────────────────────────────────────────────────────────────────
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
        // Detached elements report zero size, like a real DOM
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
    // Minimal matcher for the selectors the product code actually uses on
    // these trees: one class, optionally with [data-pane="..."]/[data-tab="..."]
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

// ── Controllable timer queue ────────────────────────────────────────────────
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

// ── Fakes for the xterm surface the wiring code touches ─────────────────────
class FakeTerminal {
    constructor() {
        this.options = {}; this.cols = 80; this.rows = 24;
        this.text = ''; this.disposed = false;
        this._dataSubs = []; this._resizeSubs = [];
    }
    loadAddon(a) { a.activate?.(this); }
    open(el) {
        this.element = mkEl();
        this.element.classList.add('xterm');
        el.appendChild(this.element);
    }
    onData(cb) {
        this._dataSubs.push(cb);
        return { dispose: () => { const i = this._dataSubs.indexOf(cb); if (i >= 0) this._dataSubs.splice(i, 1); } };
    }
    onResize(cb) {
        this._resizeSubs.push(cb);
        return { dispose: () => { const i = this._resizeSubs.indexOf(cb); if (i >= 0) this._resizeSubs.splice(i, 1); } };
    }
    onSelectionChange() { return { dispose() {} }; }
    onBell() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    write(d) { this.text += String(d); }
    resize(cols, rows) {
        if (this.cols === cols && this.rows === rows) return;
        this.cols = cols; this.rows = rows;
        this._resizeSubs.slice().forEach(cb => cb({ cols, rows }));
    }
    getSelection() { return ''; }
    dispose() { this.disposed = true; }
    focus() {}
    scrollToBottom() {}
}

function loadVm() {
    const tq = new TimerQueue();
    const sends = [];
    const fitLog = [];
    const ipcHandlers = new Map();    // channel -> [handler] registered by ipc.js
    const imeProviders = new Map();   // term -> perceivedCaret provider installed on it
    const adapterCells = new Map();   // term -> {x,y} the fake smooth-cursor adapter reports
    const searchAddons = [];          // every FakeSearchAddon ever created
    const clip = {
        text: '', next: null,
        readText: () => clip.text,
        readTextAsync: () => (clip.next ? clip.next : Promise.resolve(clip.text)),
    };

    class FakeFitAddon {
        constructor() { this.term = null; }
        activate(term) { this.term = term; }
        fit() {
            const parent = this.term?.element?.parentElement;
            const w = parent ? parent.clientWidth : 0;
            const h = parent ? parent.clientHeight : 0;
            if (!w || !h) return; // zero-size guard, same contract as the real addon
            const cols = Math.max(2, Math.floor(w / CELL_W));
            const rows = Math.max(2, Math.floor(h / CELL_H));
            fitLog.push({
                term: this.term, parent, w, h, cols, rows,
                onInner: !!(parent && parent.classList.contains('term-inner')),
            });
            this.term.resize(cols, rows);
        }
    }
    class FakeSearchAddon {
        constructor() { this.term = null; this.hits = []; this.cleared = 0; searchAddons.push(this); }
        activate(term) { this.term = term; }
        findNext(q) {
            const found = String(this.term?.text || '').includes(q);
            this.hits.push({ q, found, term: this.term });
            return found;
        }
        findPrevious(q) { return this.findNext(q); }
        clearDecorations() { this.cleared += 1; }
        onDidChangeResults() { return { dispose() {} }; }
    }

    // Static page elements the product code reaches by id
    const root = mkEl({ _cw: 1200, _ch: 900 });
    const body = mkEl(); root.appendChild(body);
    const mainArea = mkEl({ _cw: 1000, _ch: 800, id: 'main-area' }); body.appendChild(mainArea);
    const tabbar = mkEl({ id: 'tabbar' }); body.appendChild(tabbar);
    const addBtn = mkEl({ id: 'btn-add-tab' }); tabbar.appendChild(addBtn);
    body.appendChild(mkEl({ id: 'sb-conn' }));
    body.appendChild(mkEl({ id: 'search-bar' }));
    const searchInput = mkEl({ id: 'search-input' }); body.appendChild(searchInput);
    body.appendChild(mkEl({ id: 'search-count' }));
    body.appendChild(mkEl({ id: 'settings-pane' }));

    const ctx = {
        console,
        crypto: webcrypto, // the real WebView2 renderer always has this
        setTimeout: (fn, d) => tq.setTimeout(fn, d),
        clearTimeout: (id) => tq.clearTimeout(id),
        requestAnimationFrame: (fn) => { fn(); return 0; },
        document: {
            getElementById: (id) => findById(root, id),
            createElement: () => mkEl(),
            // Single-element matcher (same selector subset as mkEl): enough
            // for closeTab to find its `.tab[data-tab=...]` element and take
            // the DEFERRED removal path — the animation window under test.
            querySelector: (sel) => queryAll(root, sel)[0] || null,
            querySelectorAll: () => [],
            body,
            addEventListener() {},
        },
        window: {
            __imeCaretAnchor: {
                patchTerminal(term, opts) { imeProviders.set(term, opts.perceivedCaret); return true; },
            },
        },
        // Recording event bus: ipc.js registers its REAL handlers at load
        // time; tests dispatch synthetic backend events through them.
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
            // Producer-shaped: an invocation stays pending until settled —
            // instantly-fulfilled stubs would fake queue completion.
            invoke: () => new Promise(() => {}),
        },
        require: () => ({ clipboard: clip }),
        Terminal: FakeTerminal,
        FitAddon: FakeFitAddon,
        SearchAddon: FakeSearchAddon,
        ClipboardAddon: class { activate() {} },
        WebglAddon: class {},
        ResizeObserver: class { observe() {} disconnect() {} },
        MutationObserver: class { observe() {} disconnect() {} },
        requestIdleCallback: undefined,
        getTerminalTheme: () => ({}),
        _normalizeFontFamily: (s) => s,
        _getAccentColor: () => '#ffffff',
        // utils.js global the search decoration options read (page always has it)
        _getAccentColorAlpha: (a) => `rgba(255,255,255,${a})`,
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
        // highlight.js owns this (alt-screen tracking); its behavior is
        // irrelevant to these tests, ipc.js only calls it on PTY events.
        clearAlternateScreen() {},
        // test-side handles onto the fake surfaces
        __tq: tq, __sends: sends, __fitLog: fitLog,
        __imeProviders: imeProviders, __adapterCells: adapterCells,
        __clip: clip, __searchInput: searchInput, __mainArea: mainArea,
        __searchHitsFor: (q) => searchAddons.flatMap(a => a.hits.filter(h => h.q === q)),
        __emit: (ch, payload) => {
            (ipcHandlers.get(ch) || []).slice().forEach(fn => fn({}, payload));
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // split.js owns these as script-level `let`s; the parts of it terminal.js
    // reads at fit time are just the drag/window-resize suppression flags.
    vm.runInContext('var _spannerDrag = false; var _windowResizing = false;', ctx);
    for (const f of ['split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js', 'terminal.js', 'tabs.js', 'ipc.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    // Replace the WebGL smooth-cursor factory: the adapter is per-terminal and
    // reports the cell the test parked on it (the real one animates pixels).
    ctx._wireSmoothCursorWebgl = (term) => {
        const adapter = {
            perceivedCaretCell: () => {
                const cell = adapterCells.get(term);
                return cell ? { x: cell.x, y: cell.y } : null;
            },
        };
        return { _adapter: adapter, dispose() {} };
    };
    return ctx;
}

const flushAsync = () => new Promise(r => setTimeout(r, 0));

// Producer-shaped ssh-connecting claim: the real payload carries the attempt
// token its owner awaits (created here, bound to the wrapper), so pre-claim
// panes/tabs resolve through the attempt pass exactly like production.
function sshConnecting(ctx, wrapper, tabId) {
    const att = ctx.sshAttempts.createAttempt(wrapper);
    ctx.__emit('ssh-connecting', { tabId, rendererId: 'legacy', attemptId: att });
    return att;
}

// Single local tab wired through the REAL wireTerminal (term + callbacks).
function wiredTab(ctx, id, backendId, over = {}) {
    const tab = { id, name: id, type: 'local', command: 'powershell.exe', args: [], connected: true, ...over };
    ctx.TabManager.tabs.push(tab);
    ctx.wireTerminal(tab, backendId);
    return tab;
}

// Split tab whose two panes both hold wired terminals: the first pane is the
// original tab terminal (real addPaneRelativeTo first-split branch), the
// second is wired the way ipc.js wires a pane once its backend arrives.
function wiredSplitTab(ctx, id, backend1, backend2) {
    const tab = wiredTab(ctx, id, backend1);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'first split built two panes');
    const p2 = panes[1];
    p2.tabId = backend2; // what pty-created/ssh-connecting claiming does
    ctx.wireTerminalToPane(tab, p2);
    return { tab, p1: panes[0], p2 };
}

// ═══ A. IME perceivedCaret follows the terminal's CURRENT owner ═══

test('A: perceivedCaret survives single→split (adapter moved to the pane)', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_a1', 'local_1');
    ctx.__adapterCells.set(tab.term, { x: 7, y: 2 });
    const provider = ctx.__imeProviders.get(tab.term);
    assert.ok(provider, 'provider installed at wiring time');
    assert.deepEqual(provider(), { x: 7, y: 2 }, 'pre-migration anchor');

    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    // Old code: the closure still read tab._smoothCursor, which the split
    // cleared — the provider returned null right after the first split.
    assert.deepEqual(provider(), { x: 7, y: 2 }, 'same session anchor after split');
    const p1 = ctx.getAllPanes(tab)[0];
    assert.deepEqual(p1._smoothCursor?._adapter?.perceivedCaretCell?.(), { x: 7, y: 2 });
});

test('A: perceivedCaret survives pane→extracted tab and ignores the cleared old owner', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_a2', 'local_1', 'local_2');
    ctx.__adapterCells.set(p1.term, { x: 3, y: 9 });
    ctx.__adapterCells.set(p2.term, { x: 11, y: 5 });
    const providerP2 = ctx.__imeProviders.get(p2.term);

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.ok(nt, 'extracted tab owns p2 terminal');
    assert.notEqual(nt, tab);
    // Old code: the provider read the ORIGINAL pane wrapper, whose
    // _smoothCursor the extract cleared → null while the new tab still held
    // the live adapter.
    assert.deepEqual(providerP2(), { x: 11, y: 5 }, 'extracted session keeps its anchor');
    // The surviving tab holds a DIFFERENT adapter and is never consulted.
    assert.deepEqual(ctx.__imeProviders.get(p1.term)(), { x: 3, y: 9 });
});

test('A: perceivedCaret survives cross-tab drag migration', () => {
    const ctx = loadVm();
    const src = wiredTab(ctx, 't_a3s', 'local_1');
    const tgt = wiredTab(ctx, 't_a3t', 'local_2');
    ctx.__adapterCells.set(src.term, { x: 21, y: 4 });
    const provider = ctx.__imeProviders.get(src.term);

    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 't', null);
    const moved = ctx.getAllPanes(tgt).find(p => p.term === src.term);
    assert.ok(moved, 'terminal moved onto the target split');
    assert.deepEqual(provider(), { x: 21, y: 4 }, 'anchor follows the drag');
});

test('A: perceivedCaret falls back to null once the session is closed', () => {
    const ctx = loadVm();
    const other = wiredTab(ctx, 't_keep', 'local_9');
    ctx.__adapterCells.set(other.term, { x: 8, y: 8 });
    const tab = wiredTab(ctx, 't_a4', 'local_1');
    ctx.__adapterCells.set(tab.term, { x: 5, y: 6 });
    const provider = ctx.__imeProviders.get(tab.term);
    assert.deepEqual(provider(), { x: 5, y: 6 });

    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(400); // let the staggered removal complete
    assert.equal(ctx.TabManager.tabs.includes(tab), false);
    assert.equal(provider(), null, 'unresolvable owner → protocol-anchor fallback');
    // Closing one session never disturbs another tab's anchor.
    assert.deepEqual(ctx.__imeProviders.get(other.term)(), { x: 8, y: 8 });
});

// ═══ B. Search addon follows the terminal, not the wrapper slot ═══

test('B: search hits only the FOCUSED pane after the first split', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_b1', 'local_1', 'local_2');
    ctx.TabManager.switchTo(tab.id); // searching requires an ACTIVE tab
    p1.term.text = 'alpha-needle line';
    p2.term.text = 'bravo-needle line';

    p1.focused = true; p2.focused = false;
    ctx.__searchInput.value = 'alpha-needle';
    ctx.doSearch();
    // Old code: the focused pane never received a _searchAddon on the split
    // (only the tab slot was filled at wireTerminal time) → no hits at all.
    let hits = ctx.__searchHitsFor('alpha-needle');
    assert.equal(hits.length, 1, 'exactly the focused pane is searched');
    assert.equal(hits[0].term, p1.term, 'hit came from p1 content');
    assert.equal(hits[0].found, true);

    p1.focused = false; p2.focused = true;
    ctx.__searchInput.value = 'bravo-needle';
    ctx.doSearch();
    hits = ctx.__searchHitsFor('bravo-needle');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].term, p2.term, 'hit came from p2 content');
    // Searching p2 must never report p2's terminal as a match for p1's text.
    ctx.__searchInput.value = 'alpha-needle';
    ctx.doSearch();
    const wrong = ctx.__searchHitsFor('alpha-needle').filter(h => h.term === p2.term && h.found);
    assert.equal(wrong.length, 0, 'p2 content does not contain p1 text');
});

test('B: extract moves search with the terminal; both tabs stay searchable', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_b2', 'local_1', 'local_2');
    p1.term.text = 'alpha-needle line';
    p2.term.text = 'bravo-needle line';

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.ok(nt, 'extracted tab exists');
    assert.equal(ctx.TabManager.activeId, nt.id, 'extract switches to the new tab');

    // Old code: nt had no _searchAddon and the collapsed tab kept reading its
    // own stale slot → searching after an extract found nothing.
    ctx.__searchInput.value = 'bravo-needle';
    ctx.doSearch();
    const hitsB = ctx.__searchHitsFor('bravo-needle');
    assert.equal(hitsB.length, 1, 'extracted tab searched exactly once');
    assert.equal(hitsB[0].term, p2.term, 'hit came from the extracted content');

    ctx.TabManager.switchTo(tab.id);
    ctx.__searchInput.value = 'alpha-needle';
    ctx.doSearch();
    const hitsA = ctx.__searchHitsFor('alpha-needle');
    assert.equal(hitsA.length, 1);
    assert.equal(hitsA[0].term, p1.term, 'remaining tab searched its own content');
});

test('B: closing one tab does not break the other tab\'s search', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_b3', 'local_1', 'local_2');
    p1.term.text = 'alpha-needle line';
    p2.term.text = 'bravo-needle line';
    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t.term === p2.term);
    assert.notEqual(nt, tab);

    ctx.TabManager.closeTab(nt.id);
    ctx.__tq.advance(500);
    assert.equal(ctx.TabManager.tabs.includes(nt), false);

    ctx.__searchInput.value = 'alpha-needle';
    ctx.doSearch();
    const hits = ctx.__searchHitsFor('alpha-needle');
    assert.equal(hits.length, 1, 'surviving tab still searchable');
    assert.equal(hits[0].term, p1.term);
});

// ═══ C. Surviving/extracted connection state follows the adopted session ═══

test('C: extract-collapse syncs the surviving pane connected=false (online A, disconnected B)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_c1', 'local_1', 'local_2');
    p1.connected = true;
    p2.connected = false; // e.g. an SSH pane whose session dropped

    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    // Old code: st.connected kept the container's stale true.
    assert.equal(tab.connected, false, 'surviving tab shows the surviving session state');
    assert.equal(tab.term, p2.term);
});

test('C: extract keeps a connecting (backend assigned, not yet online) survivor offline', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_c2', 'local_1', 'local_2');
    p1.connected = true;
    // ssh-connecting assigns the backend id while the pane is still offline.
    p2.connected = false;
    assert.ok(p2.tabId, 'precondition: backend id present');
    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    assert.equal(tab.connected, false, 'backend id alone must not read as online');
});

test('C: cross-tab drag collapse syncs the surviving pane connected state', () => {
    const ctx = loadVm();
    const { tab: src, p1, p2 } = wiredSplitTab(ctx, 't_c3s', 'local_1', 'local_2');
    const tgt = wiredTab(ctx, 't_c3t', 'local_3');
    // addPaneRelativeTo leaves the SECOND pane focused → p2 moves, p1 survives.
    p1.connected = false;
    p2.connected = true;

    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'r', null);
    assert.equal(src.term, p1.term, 'survivor collapsed back onto the tab');
    // Old code: sourceTab.connected kept the container's stale true.
    assert.equal(src.connected, false, 'source tab state follows the survivor');
});

test('C: drag carries the MOVED session state onto the new pane (not !!tabId)', () => {
    const ctx = loadVm();
    // Disconnected SSH single tab dragged into another tab.
    const src = wiredTab(ctx, 't_c4s', 'ssh_1', { type: 'ssh', connected: false, host: 'h1', user: 'u1' });
    const tgt = wiredTab(ctx, 't_c4t', 'local_3');
    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'b', null);
    const moved = ctx.getAllPanes(tgt).find(p => p.term === src.term);
    assert.ok(moved, 'pane landed on the target');
    // Old code: connected: !!mid treated the backend id as online.
    assert.equal(moved.connected, false, 'moved pane shows its own session state');
});

test('C: extracted tab connected state matches the extracted session (regression)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_c5', 'local_1', 'local_2');
    p2.connected = false;
    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.equal(nt.connected, false, 'extracted tab offline with its session');
    assert.equal(tab.connected, true, 'remaining tab stays online');
});

test('C: _exitSplit keeps syncing the connection state (existing regression guard)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_c6', 'local_1', 'local_2');
    p1.connected = false; // the first pane survives _exitSplit
    ctx.TabManager._exitSplit(tab);
    assert.equal(tab.connected, false);
});

// ═══ D. Async paste validates the session generation ═══

function startPaste(ctx, term) {
    let resolveFn;
    ctx.__clip.next = new Promise((res) => { resolveFn = res; });
    term.element.dispatch('contextmenu', { preventDefault() {}, stopPropagation() {} });
    return (text) => { resolveFn(text); return flushAsync(); };
}

test('D: same-session migration during the clipboard read still pastes once', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_d1', 'local_1', 'local_2');
    const done = startPaste(ctx, p1.term);
    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    const nt = ctx.TabManager.tabs.find(t => t.term === p1.term);
    assert.ok(nt && nt !== tab);
    await done('PASTE-D1');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-D1');
    assert.equal(pastes.length, 1, 'exactly one paste');
    assert.equal(pastes[0].payload.tabId, 'local_1', 'delivered to the same backend via its new wrapper');
});

test('D: close during the clipboard read drops the paste (zero sends)', async () => {
    const ctx = loadVm();
    const other = wiredTab(ctx, 't_d2k', 'local_9');
    const tab = wiredTab(ctx, 't_d2', 'local_1');
    const done = startPaste(ctx, tab.term);
    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(500);
    assert.equal(ctx.TabManager.tabs.includes(tab), false);
    await done('PASTE-D2');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-D2');
    assert.equal(pastes.length, 0, 'stale paste must not reach any session');
    assert.ok(ctx.TabManager.tabs.includes(other));
});

test('D: reconnect generation swap during the clipboard read drops the paste', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_d3', 'ssh_1', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    const done = startPaste(ctx, tab.term);
    // What a preserve-content reconnect does: same terminal, NEW backend id.
    tab.connected = false;
    tab.tabId = 'ssh_77';
    await done('PASTE-D3');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-D3');
    // Old code: the post-await resolve() only checked ownership, not the
    // generation — the old paste landed in the replacement session.
    assert.equal(pastes.length, 0, 'a paste for a replaced generation must be dropped');
});

test('D: sync-input switch during the read follows the CURRENT tab rule', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_d4', 'local_1', 'local_2');
    const done = startPaste(ctx, p1.term);
    tab.syncInput = true; // enabled while the read is pending
    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    await done('PASTE-D4');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-D4');
    // After the extract p1's tab has a single pane: current-tab sync rule → 1 send.
    assert.equal(pastes.length, 1);
    assert.equal(pastes[0].payload.tabId, 'local_1');
});

// ═══ E. Timer queues, exact A-above-B → extract-bottom-B resize path ═══

test('E: A dragged above B, then bottom B extracted — geometry and per-backend resize', () => {
    const ctx = loadVm();
    // Settle the layout suppression window so resize events are not dropped.
    ctx.TabManager._layoutTime = 0;

    const tabA = wiredTab(ctx, 't_eA', 'ssh_A', { type: 'ssh', connected: true });
    const tabB = wiredTab(ctx, 't_eB', 'ssh_B', { type: 'ssh', connected: true });
    const termA = tabA.term, termB = tabB.term;
    // Exact user order: drag A onto the TOP of B, then extract the bottom B.
    ctx.TabManager._moveTerminalToTab('t_eA', 't_eB', 't', null);
    const panes = ctx.getAllPanes(tabB);
    assert.equal(panes.length, 2, 'B tab now holds A-top/B-bottom');
    const topA = panes[0], bottomB = panes[1];
    assert.equal(topA.term, termA, 'A sits above');
    assert.equal(bottomB.term, termB, 'B stays at the bottom');

    ctx.TabManager._extractPaneToTab('t_eB', bottomB.id);
    const ntB = ctx.TabManager.tabs.find(t => t.term === termB);
    assert.ok(ntB && ntB !== tabB, 'B extracted into its own tab');
    assert.equal(tabB.term, termA, 'A survives on the original tab object');
    assert.equal(tabB.tabId, 'ssh_A');

    // Distinct geometry: A's restored content area 700x600 (60 rows), B's 700x580 (58 rows).
    const wrapA = ctx.document.getElementById('wrap_' + tabB.id);
    const wrapB = ctx.document.getElementById('wrap_' + ntB.id);
    const innerA = wrapA && wrapA.querySelector('.term-inner');
    const innerB = wrapB && wrapB.querySelector('.term-inner');
    assert.ok(innerA && innerB, 'both restored tabs use the standard wrap/inner structure');
    assert.equal(wrapA.querySelectorAll('.term-inner').length, 1);
    assert.equal(wrapB.querySelectorAll('.term-inner').length, 1);
    innerA._cw = 700; innerA._ch = 600;
    innerB._cw = 700; innerB._ch = 580;

    // Fire ONLY the pending 50ms fit timers (the extract restore fits; the
    // pre-migration wiring fits are inert: their wraps were detached).
    const fits50 = [...ctx.__tq.timers.values()].filter(t => t.at - ctx.__tq.now === 50);
    assert.ok(fits50.length >= 2, 'extract scheduled the restore fits (50ms)');
    ctx.__sends.length = 0;
    ctx.__fitLog.length = 0;
    fits50.forEach(t => ctx.__tq.fireId(t.id));

    const lastFor = new Map();
    ctx.__fitLog.forEach(f => lastFor.set(f.term, f));
    const fitA = lastFor.get(termA), fitB = lastFor.get(termB);
    assert.ok(fitA && fitB, 'both terminals were fitted');
    assert.equal(fitA.onInner, true, 'A fitted against .term-inner');
    assert.equal(fitB.onInner, true, 'B fitted against .term-inner');
    assert.equal(fitA.rows, 60, 'A geometry 600/10');
    assert.equal(fitB.rows, 58, 'B geometry 580/10');

    const resizes = ctx.__sends.filter(s => s.cmd === 'pty-resize');
    const lastResize = new Map();
    resizes.forEach(r => lastResize.set(r.payload.tabId, r.payload));
    const dims = (p) => ({ tabId: p?.tabId, cols: p?.cols, rows: p?.rows });
    assert.deepEqual(dims(lastResize.get('ssh_A')), { tabId: 'ssh_A', cols: 70, rows: 60 }, 'A backend got A dims');
    assert.deepEqual(dims(lastResize.get('ssh_B')), { tabId: 'ssh_B', cols: 70, rows: 58 }, 'B backend got B dims');
    assert.equal(resizes.some(r => r.payload.tabId === 'ssh_A' && r.payload.rows === 58), false,
        'B dims must never be sent to the A backend (the old closure defect)');

    // Debounce phase: distinct sizes, fired as pure timer callbacks after the
    // migration. The switchTo() during extract re-armed the 300ms layout
    // suppression window; treat the layout as settled (same state the user
    // reaches ~300ms after any migration).
    ctx.TabManager._layoutTime = 0;
    ctx.__sends.length = 0;
    const mark2 = ctx.__tq.mark();
    termA.resize(70, 62);
    termB.resize(70, 57);
    const debounces = ctx.__tq.createdAfter(mark2);
    assert.equal(debounces.length, 2, 'one debounce per terminal');
    debounces.forEach(t => ctx.__tq.fireId(t.id));
    const dr = ctx.__sends.filter(s => s.cmd === 'pty-resize');
    assert.deepEqual(dr.map(r => [r.payload.tabId, r.payload.rows]).sort(),
        [['ssh_A', 62], ['ssh_B', 57]], 'each backend received only its own terminal size');
});

test('E: pre-migration pane fit timer never uses the detached pane body', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_e2', 'local_1', 'local_2');
    // The pane wiring scheduled a 300ms initial fit against p2's ORIGINAL body.
    const wireTimers = [...ctx.__tq.timers.values()].filter(t => t.at - ctx.__tq.now === 300);
    assert.ok(wireTimers.length >= 1, 'pane wiring scheduled the 300ms initial fit');
    const oldBody = ctx.document.getElementById('pane-body_' + p2.id);
    assert.ok(oldBody, 'p2 body existed at wiring time');

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    // Silence every other pending callback so ONLY the old pane timer runs.
    const keep = new Set(wireTimers.map(t => t.id));
    [...ctx.__tq.timers.keys()].forEach(id => { if (!keep.has(id)) ctx.__tq.clearTimeout(id); });
    ctx.__sends.length = 0;
    ctx.__fitLog.length = 0;
    // Fire the OLD timer (and its zero-size retry chain) after the migration.
    wireTimers.forEach(t => ctx.__tq.fireId(t.id));
    for (let i = 0; i < 12; i++) {
        const retries = [...ctx.__tq.timers.values()].filter(t => t.at - ctx.__tq.now === 50);
        if (!retries.length) break;
        retries.forEach(t => ctx.__tq.fireId(t.id));
    }
    assert.equal(ctx.__fitLog.filter(f => f.parent === oldBody).length, 0,
        'no fit may measure the detached pre-migration body');
    assert.equal(ctx.__sends.filter(s => s.cmd === 'pty-resize').length, 0,
        'stale pane timers must not push geometry anywhere');
});

test('E: pre-migration resize debounce is inert after the terminal is closed', () => {
    const ctx = loadVm();
    ctx.TabManager._layoutTime = 0;
    const other = wiredTab(ctx, 't_e3k', 'local_9');
    const tab = wiredTab(ctx, 't_e3', 'local_1');
    const mark = ctx.__tq.mark();
    tab.term.resize(100, 40);
    const debounce = ctx.__tq.createdAfter(mark);
    assert.equal(debounce.length, 1, 'resize scheduled exactly one debounce');

    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(500);
    ctx.__sends.length = 0;
    ctx.__tq.fireId(debounce[0].id); // the OLD callback fires after the close
    assert.equal(ctx.__sends.filter(s => s.cmd === 'pty-resize').length, 0,
        'an unresolvable owner sends nothing');
    assert.ok(ctx.TabManager.tabs.includes(other));
});

test('E: settle-resize timer reads fire-time state after a collapse', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_e4', 'local_1', 'local_2');
    // wireTerminalToPane scheduled the 320ms settle for the SPLIT tab.
    const settle = [...ctx.__tq.timers.values()].filter(t => t.at - ctx.__tq.now === 320);
    assert.ok(settle.length >= 1, 'settle timer scheduled at wiring');

    ctx.TabManager._extractPaneToTab(tab.id, p2.id); // collapses the split
    const inner = ctx.document.getElementById('wrap_' + tab.id)?.querySelector('.term-inner');
    assert.ok(inner, 'survivor restored with standard inner');
    inner._cw = 500; inner._ch = 400;
    // Keep only the settle timer pending.
    const keepSettle = new Set(settle.map(t => t.id));
    [...ctx.__tq.timers.keys()].forEach(id => { if (!keepSettle.has(id)) ctx.__tq.clearTimeout(id); });
    ctx.__sends.length = 0;
    settle.forEach(t => ctx.__tq.fireId(t.id));
    const rs = ctx.__sends.filter(s => s.cmd === 'pty-resize');
    // The settle ran the single-tab branch at FIRE time: fit the survivor and
    // report to the survivor's backend only.
    assert.equal(rs.length, 1);
    assert.equal(rs[0].payload.tabId, 'local_1', 'survivor backend');
    assert.equal(rs[0].payload.rows, 40, '400/10 rows from the new inner');
});

test('E: old debounce after a backend swap addresses the live backend', () => {
    const ctx = loadVm();
    ctx.TabManager._layoutTime = 0;
    const tab = wiredTab(ctx, 't_e5', 'ssh_1', { type: 'ssh', connected: true });
    const mark = ctx.__tq.mark();
    tab.term.resize(90, 50);
    const debounce = ctx.__tq.createdAfter(mark);
    assert.equal(debounce.length, 1);
    // A reconnect swapped the backend under the same terminal.
    tab.tabId = 'ssh_88';
    ctx.__sends.length = 0;
    ctx.__tq.fireId(debounce[0].id);
    const rs = ctx.__sends.filter(s => s.cmd === 'pty-resize');
    assert.equal(rs.length, 1);
    assert.equal(rs[0].payload.tabId, 'ssh_88', 'resize follows the live session');
});

// ═══ D (close timing): the close is committed at initiation, not removal ═══
// The deferred clipboard read resolves INSIDE the close animation window,
// BEFORE any removal timer fires (the timer queue is never advanced).

test('D-close: paste resolving inside the closeTab window sends nothing', async () => {
    const ctx = loadVm();
    const other = wiredTab(ctx, 't_ck_k', 'local_9');
    const tab = wiredTab(ctx, 't_ck', 'local_1');
    ctx.TabManager.render(); // build the tab strip so closeTab finds its element
    const done = startPaste(ctx, tab.term);
    ctx.TabManager.closeTab(tab.id);
    // No timer advance: the tab is still in `tabs` with its backend attached.
    assert.equal(ctx.TabManager.tabs.includes(tab), true, 'precondition: inside the removal window');
    assert.equal(ctx.TabManager._closingTabs.has(tab.id), true);
    await done('PASTE-CLOSE-WIN');
    // Old code: the owner still resolved with an unchanged backend id and the
    // paste was delivered to the closing session.
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-CLOSE-WIN');
    assert.equal(pastes.length, 0, 'close initiation must invalidate the pending paste');
    // The animation still runs to completion normally.
    ctx.__tq.advance(600);
    assert.equal(ctx.TabManager.tabs.includes(tab), false, 'removal timer unaffected');
    assert.ok(ctx.TabManager.tabs.includes(other));
});

test('D-close: paste resolving inside the _closePane window with sync input sends nothing anywhere', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_cp', 'local_1', 'local_2');
    tab.syncInput = true;
    const done = startPaste(ctx, p1.term);
    ctx.TabManager._closePane(tab.id, p1.id);
    // No timer advance: p1 is still in the split tree for its exit animation,
    // but its backend was destroyed at initiation.
    assert.ok(ctx.getAllPanes(tab).includes(p1), 'precondition: inside the exit-animation window');
    await done('PASTE-PANE-WIN');
    // Old code: _sendPaneInput broadcast the paste to EVERY pane with sync
    // input on — including the SURVIVING sibling's live backend.
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-PANE-WIN');
    assert.equal(pastes.length, 0, 'zero IPC sends of any kind, not just to the closed backend');
    // The surviving pane is untouched and still works.
    assert.ok(p2.term && !p2.term.disposed, 'surviving sibling terminal intact');
    ctx.__tq.advance(600);
    assert.equal(ctx.getAllPanes(tab).includes(p1), false, 'pane removal timer unaffected');
});

test('D-close: ordinary sync-input broadcast is preserved (no close involved)', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_syn', 'local_1', 'local_2');
    tab.syncInput = true;
    const done = startPaste(ctx, p1.term);
    await done('PASTE-SYNC');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-SYNC');
    assert.equal(pastes.length, 2, 'current-tab sync rule still broadcasts to both panes');
    assert.deepEqual(pastes.map(p => p.payload.tabId).sort(), ['local_1', 'local_2']);
});

// ═══ D (connection failure): deferred read vs a failing session, through the
// REAL ipc.js ssh-error handler (dispatched via the recording event bus) ═══

test('D-fail: handshake-class failure during the read drops the paste (real ipc.js handler)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_cf', 'ssh_1', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    const done = startPaste(ctx, tab.term);
    // Real handler, handshake-class error: the retry branch nulls the backend
    // id and schedules a reconnect — the session generation is invalidated.
    ctx.__emit('ssh-error', { tabId: 'ssh_1', rendererId: tab.id, error: 'os error 10061 connection refused' });
    assert.equal(tab.tabId, null, 'retry branch dropped the dead backend id');
    await done('PASTE-FAIL');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-FAIL');
    assert.equal(pastes.length, 0, 'generation invalidated by the failed connection');
    // The retry was scheduled through the real queue (backoff timer, never fired here).
    assert.equal(tab._sshRetried, 1);
});

test('D-fail: deterministic failure keeps the id — paste is CANCELLED (real handler)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_df', 'ssh_2', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    // Genuine reachable sequence: connecting → connected (live) → read →
    // deterministic failure with the terminal PRESERVED and the id retained.
    sshConnecting(ctx, tab, 'ssh_2');
    ctx.__emit('ssh-connected', { tabId: 'ssh_2', rendererId: tab.id });
    assert.equal(tab.connected, true, 'source is live before the read');
    const done = startPaste(ctx, tab.term);
    ctx.__emit('ssh-error', { tabId: 'ssh_2', rendererId: tab.id, error: 'authentication failed' });
    assert.equal(tab.connected, false);
    assert.equal(tab.tabId, 'ssh_2', 'deterministic branch keeps the session id');
    await done('PASTE-DET');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-DET');
    // Corrected expectation (adjudication): a source session KNOWN to have
    // failed cancels the paste even though the old backend id remains.
    assert.equal(pastes.length, 0, 'failed source session → zero sends');
});

// ═══ D (failed source session): a pending paste whose SOURCE session is
// known to have failed/disconnected is cancelled even when the old backend
// id remains — otherwise the sync-input broadcast delivers it into the
// still-HEALTHY siblings of the current tab. All lifecycle transitions go
// through the REAL ipc.js handlers; the terminal is preserved (never
// disposed) by the failure, exactly like the production deterministic path.
//
// Read-to-error order classification covered below:
//   (a) live → read starts → error → resolve        → cancel (sync + no-sync)
//   (b) error → read starts → resolve               → cancel (same seam)
//   (c) error → reconnect recovery → read           → allowed (marker cleared)
//   (d) live → read starts → migration → resolve    → allowed (existing d1)
//   (e) live → read starts → error → migration → resolve → cancel (marker migrates)

test('D-fail: failed SSH source pane cancels the paste everywhere (sync input, real handlers)', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_fs1', 'ssh_1', 'local_2');
    // Bring the SSH source pane live through the real lifecycle.
    sshConnecting(ctx, p1, 'ssh_1');
    ctx.__emit('ssh-connected', { tabId: 'ssh_1', rendererId: p1.requestId });
    assert.equal(p1.connected, true, 'source pane live');
    assert.ok(p2.tabId === 'local_2' && !p2.term.disposed, 'sibling pane healthy');

    const done = startPaste(ctx, p1.term);
    // Deterministic failure: terminal preserved, backend id retained.
    ctx.__emit('ssh-error', { tabId: 'ssh_1', rendererId: p1.requestId, error: 'authentication failed' });
    // Aggregated connected state: the healthy sibling keeps the split tab
    // connected, so the failure is asserted on the owning pane's marker.
    assert.equal(p1._sessionFailed, true, 'failure recorded on the source pane');
    assert.equal(p1.tabId, 'ssh_1', 'old backend id retained (the hazard precondition)');
    assert.ok(p1.term && !p1.term.disposed, 'terminal preserved by the failure');
    tab.syncInput = true;

    await done('PASTE-FSYNC');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-FSYNC');
    // Old code: _sendPaneInput broadcast the stale paste into the healthy
    // sibling's live backend (and the dead source id).
    assert.equal(pastes.length, 0, 'zero input sends anywhere — healthy sibling included');
});

test('D-fail: failed SSH source tab cancels the paste without sync input (real handlers)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_fs2', 'ssh_3', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    sshConnecting(ctx, tab, 'ssh_3');
    ctx.__emit('ssh-connected', { tabId: 'ssh_3', rendererId: tab.id });
    const done = startPaste(ctx, tab.term);
    ctx.__emit('ssh-error', { tabId: 'ssh_3', rendererId: tab.id, error: 'authentication failed' });
    await done('PASTE-FNOSYNC');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-FNOSYNC');
    assert.equal(pastes.length, 0, 'no send to the dead backend either');
});

test('D-fail: read started AFTER the failure is cancelled too (order b)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_fs3', 'ssh_4', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    sshConnecting(ctx, tab, 'ssh_4');
    ctx.__emit('ssh-connected', { tabId: 'ssh_4', rendererId: tab.id });
    ctx.__emit('ssh-error', { tabId: 'ssh_4', rendererId: tab.id, error: 'authentication failed' });
    const done = startPaste(ctx, tab.term);
    await done('PASTE-AFTERFAIL');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-AFTERFAIL');
    assert.equal(pastes.length, 0, 'right-click on a known-failed session pastes nowhere');
});

test('D-fail: local process exit cancels the pending paste (real pty-exit handler)', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_fs4', 'local_1', 'local_2');
    tab.syncInput = true;
    const done = startPaste(ctx, p1.term);
    // The local equivalent of a session death: process exited, id retained.
    ctx.__emit('pty-exit', { tabId: 'local_1' });
    // Aggregated connected state: the healthy sibling keeps the split tab
    // connected, so the exit is asserted on the owning pane's marker.
    assert.equal(p1._sessionFailed, true, 'exit recorded on the source pane');
    assert.equal(p1.tabId, 'local_1', 'backend id retained');
    await done('PASTE-EXIT');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-EXIT');
    assert.equal(pastes.length, 0, 'no broadcast into the healthy sibling after process exit');
});

test('D-fail: reconnect recovery re-enables pasting (order c, real handlers)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_fs5', 'ssh_5', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    sshConnecting(ctx, tab, 'ssh_5');
    ctx.__emit('ssh-connected', { tabId: 'ssh_5', rendererId: tab.id });
    ctx.__emit('ssh-error', { tabId: 'ssh_5', rendererId: tab.id, error: 'authentication failed' });
    // User reconnects: reconnectTab nulls the dead backend id BEFORE the new
    // generation is enqueued (tabs.js reconnectTab), then connecting fires.
    tab.tabId = null;
    sshConnecting(ctx, tab, 'ssh_50');
    ctx.__emit('ssh-connected', { tabId: 'ssh_50', rendererId: tab.id });
    assert.equal(tab.connected, true, 'live again');
    const done = startPaste(ctx, tab.term);
    await done('PASTE-RECOVER');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-RECOVER');
    assert.equal(pastes.length, 1, 'healthy session pastes normally');
    assert.equal(pastes[0].payload.tabId, 'ssh_50', 'delivered to the live generation');
});

test('D-fail: the failure marker follows the session across an extract (order e)', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_fs6', 'local_1', 'ssh_6');
    sshConnecting(ctx, p2, 'ssh_6');
    ctx.__emit('ssh-connected', { tabId: 'ssh_6', rendererId: p2.requestId });
    const done = startPaste(ctx, p2.term);
    ctx.__emit('ssh-error', { tabId: 'ssh_6', rendererId: p2.requestId, error: 'authentication failed' });
    // The failed session's terminal is extracted while the read is pending.
    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.ok(nt, 'failed session extracted into its own tab');
    await done('PASTE-EXTRACTFAIL');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-EXTRACTFAIL');
    assert.equal(pastes.length, 0, 'marker migrated with the session — still cancelled');
});

// ═══ D (promotion must keep failure state): a known-failed single terminal
// with a pending read is promoted tab→pane; the marker must travel with the
// EXISTING session, while newly spawned independent sessions must NOT
// inherit it. ═══

test('P-fail: first-split promotion keeps the failure marker (sync, healthy sibling via real pty-created)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_p1', 'ssh_1', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    sshConnecting(ctx, tab, 'ssh_1');
    ctx.__emit('ssh-connected', { tabId: 'ssh_1', rendererId: tab.id });
    assert.equal(tab._sessionFailed, false);
    const done = startPaste(ctx, tab.term);
    // Deterministic failure: terminal + backend id preserved, marker set.
    ctx.__emit('ssh-error', { tabId: 'ssh_1', rendererId: tab.id, error: 'authentication failed' });
    assert.equal(tab._sessionFailed, true, 'precondition: source known failed');

    // Promote the failed terminal onto a pane (real first-split path).
    const failedTerm = tab.term;
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    const existing = panes.find(p => p.term === failedTerm);
    assert.ok(existing, 'failed terminal promoted onto the existing pane');
    // Old code: the promotion copied term/backend/smooth-cursor but NOT the
    // marker — the pane read as a live session again.
    assert.equal(existing._sessionFailed, true, 'marker follows the existing session');

    // The newly spawned sibling gets a live backend through the REAL claim.
    const fresh = panes.find(p => p !== existing);
    ctx.__emit('pty-created', { tabId: 'local_9', requestId: fresh.requestId });
    assert.equal(fresh.tabId, 'local_9');
    assert.equal(fresh._sessionFailed, false, 'fresh independent session inherits no failure');

    tab.syncInput = true;
    await done('PASTE-PROMO');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-PROMO');
    assert.equal(pastes.length, 0, 'zero sends — healthy fresh sibling included');
});

test('P-fail: drag target-conversion fp keeps the failure marker (sync, healthy dragged-in sibling)', async () => {
    const ctx = loadVm();
    const tgt = wiredTab(ctx, 't_p2t', 'ssh_2', { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    const src = wiredTab(ctx, 't_p2s', 'local_3');
    sshConnecting(ctx, tgt, 'ssh_2');
    ctx.__emit('ssh-connected', { tabId: 'ssh_2', rendererId: tgt.id });
    const termT = tgt.term;
    const done = startPaste(ctx, termT);
    ctx.__emit('ssh-error', { tabId: 'ssh_2', rendererId: tgt.id, error: 'authentication failed' });
    assert.equal(tgt._sessionFailed, true);

    tgt.syncInput = true;
    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'b', null);
    const fp = ctx.getAllPanes(tgt).find(p => p.term === termT);
    assert.ok(fp, 'failed target terminal converted onto fp');
    // Old code: fp lost the marker → the stale paste broadcast into the
    // healthy dragged-in sibling.
    assert.equal(fp._sessionFailed, true, 'marker follows the existing session');
    await done('PASTE-FP');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-FP');
    assert.equal(pastes.length, 0, 'zero sends anywhere');
});

// ═══ D (fresh local generation): a successful pty-created claim must permit
// paste again (invariant guard); a failed spawn stays correctly failed. The
// closeTab empty-last-split recovery ENTRY could not be reproduced through
// public methods in this harness (see report) — the claim branches are
// exercised directly with the recovery-shaped pre-claim state. ═══

test('G-fail: successful pty-created single-tab claim clears the failure marker', async () => {
    const ctx = loadVm();
    const other = wiredTab(ctx, 't_g0', 'local_8');
    const tab = wiredTab(ctx, 't_g1', 'local_1');
    // Real failure marker on the tab (single-tab branch of the real handler).
    ctx.__emit('pty-exit', { tabId: 'local_1' });
    assert.equal(tab._sessionFailed, true);
    // Recovery-shaped pre-claim state: the failed backend is gone, a fresh
    // creation with this tab as its requestId is in flight (what closeTab's
    // empty-last-split recovery sends).
    tab.term = null; tab.fitAddon = null; tab.tabId = null;
    ctx.__emit('pty-created', { tabId: 'local_77', requestId: tab.id });
    assert.equal(tab.tabId, 'local_77', 'fresh backend claimed');
    assert.equal(tab._sessionFailed, false, 'fresh generation is live for paste');
    // Paste into the FRESH session must deliver.
    const done = startPaste(ctx, tab.term);
    await done('PASTE-FRESH');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-FRESH');
    assert.equal(pastes.length, 1, 'fresh generation pastes normally');
    assert.equal(pastes[0].payload.tabId, 'local_77');
    assert.ok(ctx.TabManager.tabs.includes(other));
});

test('G-fail: spawnError claim stays failed (real pty-created handler)', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_g2', 'local_1');
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const fresh = ctx.getAllPanes(tab).find(p => !p.term);
    ctx.__emit('pty-created', { tabId: 'local_5', requestId: fresh.requestId, spawnError: 'access denied' });
    assert.equal(fresh.tabId, 'local_5');
    assert.equal(fresh._sessionFailed, true, 'failed spawn must not read as pasteable');
    const done = startPaste(ctx, fresh.term);
    await done('PASTE-SPAWNERR');
    const pastes = ctx.__sends.filter(s => s.cmd === 'pty-input' && s.payload.data === 'PASTE-SPAWNERR');
    assert.equal(pastes.length, 0, 'spawn-failed session accepts no paste');
});

// ═══ C+D (combined): independent-tab origins + delayed producer-shaped IPC.
// B originates on rendererId t_B with backend B; A is dragged above B; the
// bottom/original B is extracted (old t_B now shows A). A delayed ssh-error /
// ssh-connected carrying backend B AND rendererId t_B must reach ONLY B's
// current owner — the old t.id === rendererId fallback must not write A's
// state. ═══

function independentAOverB_extract(ctx) {
    const tabA = wiredTab(ctx, 't_A', 'ssh_A', { type: 'ssh', connected: true, host: 'a', user: 'u' });
    const tabB = wiredTab(ctx, 't_B', 'ssh_B', { type: 'ssh', connected: false, host: 'b', user: 'u' });
    // Real connecting setup for B (preserved terminal, backend assigned).
    sshConnecting(ctx, tabB, 'ssh_B');
    const termB = tabB.term;
    ctx.TabManager._moveTerminalToTab('t_A', 't_B', 't', null);
    const bottomB = ctx.getAllPanes(tabB).find(p => p.term === termB);
    assert.ok(bottomB, 'B sits at the bottom of its own tab');
    ctx.TabManager._extractPaneToTab('t_B', bottomB.id);
    const ntB = ctx.TabManager.tabs.find(t => t.term === termB);
    assert.ok(ntB && ntB !== tabB, 'B extracted');
    assert.equal(tabB.term, tabA.term, 'old t_B now shows A');
    assert.equal(tabB.tabId, 'ssh_A');
    return { tabA, tabB, ntB, termB };
}

test('X-delayed: producer events for backend B reach only B (error then completion)', () => {
    const ctx = loadVm();
    const { tabA, tabB, ntB } = independentAOverB_extract(ctx);

    // Delayed producer-shaped failure for B, carrying B's ORIGINAL rendererId.
    ctx.__emit('ssh-error', { tabId: 'ssh_B', rendererId: 't_B', error: 'authentication failed' });
    assert.equal(ntB.connected, false, 'failure state lands on B\'s current owner');
    assert.equal(ntB._sessionFailed, true);
    // Old code: the single-tab fallback matched t_B by rendererId and wrote
    // A's tab failed.
    assert.equal(tabB.connected, true, 'A remains online');
    assert.notEqual(tabB._sessionFailed, true, 'A never marked failed');
    assert.equal(tabA.connected, true);

    // Delayed completion for B (same producer pair) must also reach only B.
    ctx.__emit('ssh-connected', { tabId: 'ssh_B', rendererId: 't_B' });
    assert.equal(ntB.connected, true, 'B live again on its real owner');
    assert.equal(ntB._sessionFailed, false);
    assert.equal(tabB.connected, true, 'A untouched by B\'s completion');
});

test('X-delayed: stale error after B reconnects is dropped for everyone', () => {
    const ctx = loadVm();
    const { tabA, tabB, ntB } = independentAOverB_extract(ctx);
    // B fails, then reconnects (new generation, real handler pair).
    ctx.__emit('ssh-error', { tabId: 'ssh_B', rendererId: 't_B', error: 'authentication failed' });
    ntB.tabId = null; // what reconnectTab does before re-enqueueing
    sshConnecting(ctx, ntB, 'ssh_B2');
    ctx.__emit('ssh-connected', { tabId: 'ssh_B2', rendererId: ntB.id });
    assert.equal(ntB.connected, true, 'B live on its new generation');

    // A stale producer event for the DEAD generation arrives late.
    ctx.__emit('ssh-error', { tabId: 'ssh_B', rendererId: 't_B', error: 'authentication failed' });
    assert.equal(ntB.connected, true, 'live generation unaffected by the stale error');
    assert.equal(ntB._sessionFailed, false);
    assert.equal(tabB.connected, true, 'A still untouched');
    assert.notEqual(tabB._sessionFailed, true);
});

// ═══ C (delayed events): ssh-connected / ssh-error AFTER a migration, routed
// through the REAL ipc.js handlers — a delayed event may only touch the
// session it belongs to ═══

test('C-delayed: ssh-connected after extract lands on the extracted tab only (real handler)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_dc', 'ssh_A', 'ssh_B');
    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p2.term);
    assert.ok(nt);
    tab.connected = false; // survivor starts offline
    nt.connected = false;

    // The extracted session's backend completes LATE (delayed ssh-connected).
    ctx.__emit('ssh-connected', { tabId: 'ssh_B', rendererId: p2.requestId });
    assert.equal(nt.connected, true, 'extracted tab adopted its own session state');
    assert.equal(tab.connected, false, 'surviving tab state untouched by the delayed event');

    // And a delayed error for the survivor must not touch the extracted tab.
    ctx.__emit('ssh-error', { tabId: 'ssh_A', rendererId: tab.id, error: 'authentication failed' });
    assert.equal(tab.connected, false);
    assert.equal(nt.connected, true, 'extracted tab still online after the sibling error');
});

// ═══ B (remaining paths): search after _exitSplit and after cross-tab drag ═══

test('B: search follows the surviving terminal after _exitSplit', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_bs', 'local_1', 'local_2');
    p1.term.text = 'exit-alpha-needle';
    p2.term.text = 'exit-bravo-needle';
    ctx.TabManager.switchTo(tab.id);

    ctx.TabManager._exitSplit(tab); // p1 survives, p2's session is destroyed
    assert.equal(ctx.getAllPanes(tab).length, 0, 'split collapsed');
    ctx.__searchInput.value = 'exit-alpha-needle';
    ctx.doSearch();
    let hits = ctx.__searchHitsFor('exit-alpha-needle');
    assert.equal(hits.length, 1, 'survivor searchable after merge');
    assert.equal(hits[0].term, p1.term);
    assert.equal(hits[0].found, true);

    ctx.__searchInput.value = 'exit-bravo-needle';
    ctx.doSearch();
    hits = ctx.__searchHitsFor('exit-bravo-needle');
    assert.equal(hits.filter(h => h.found).length, 0, 'destroyed sibling content is unreachable');
});

test('B: search follows the focused pane after a cross-tab drag (differing content)', () => {
    const ctx = loadVm();
    const src = wiredTab(ctx, 't_bd_s', 'local_1');
    const tgt = wiredTab(ctx, 't_bd_t', 'local_2');
    src.term.text = 'drag-alpha-needle';
    tgt.term.text = 'drag-bravo-needle';

    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'r', null);
    const panes = ctx.getAllPanes(tgt);
    assert.equal(panes.length, 2, 'target now holds both terminals');
    const termT = panes.find(p => p.term !== src.term).term; // tgt.term is null once it splits
    // The moved pane is focused by the drag; the tab switched to is the target.
    ctx.__searchInput.value = 'drag-alpha-needle';
    ctx.doSearch();
    let hits = ctx.__searchHitsFor('drag-alpha-needle');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].term, src.term, 'moved terminal searchable in its new home');

    panes.forEach(p => (p.focused = p.term === termT));
    ctx.__searchInput.value = 'drag-bravo-needle';
    ctx.doSearch();
    hits = ctx.__searchHitsFor('drag-bravo-needle');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].term, termT, 'target terminal searchable with the other content');
});
