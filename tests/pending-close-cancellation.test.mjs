// ZTerm - pending-creation cancellation at close initiation (attempt identity).
// Driven through the REAL tabs.js close/migration methods AND the REAL ipc.js
// handlers registered in one VM; timers are queued and never auto-run, so
// every "late event" lands inside the real deferred close window, which each
// test asserts it really entered. SSH connects go through the REAL
// `_sshConnectChain` queue whose `ipcRenderer.invoke('ssh-connect')` calls
// are CONTROLLABLE deferreds (producer-shaped: the test resolves/rejects
// each invocation exactly when the producer would). The Rust consumer is a
// source-faithful transcription (PendingRegistryModel below) kept in
// lock-step with zterm.rs cancel_pending/complete_pending.
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

// ── Controllable timer queue (never auto-runs) ──────────────────────────────
class TimerQueue {
    constructor() { this.seq = 0; this.timers = new Map(); this.now = 0; }
    setTimeout(fn, delay = 0) {
        const id = ++this.seq;
        this.timers.set(id, { id, seq: id, fn, at: this.now + (Number(delay) || 0) });
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
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

// ── Fakes for the xterm surface ─────────────────────────────────────────────
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
    const ipcHandlers = new Map();
    const invokes = [];   // controllable deferred ipcRenderer.invoke calls
    const toasts = [];

    class FakeFitAddon {
        constructor() { this.term = null; }
        activate(term) { this.term = term; }
        fit() {
            const parent = this.term?.element?.parentElement;
            const w = parent ? parent.clientWidth : 0;
            const h = parent ? parent.clientHeight : 0;
            if (!w || !h) return;
            this.term.resize(Math.max(2, Math.floor(w / CELL_W)), Math.max(2, Math.floor(h / CELL_H)));
        }
    }
    class FakeSearchAddon {
        activate() {}
        onDidChangeResults() { return { dispose() {} }; }
    }

    const root = mkEl({ _cw: 1200, _ch: 900 });
    const body = mkEl(); root.appendChild(body);
    const mainArea = mkEl({ _cw: 1000, _ch: 800, id: 'main-area' }); body.appendChild(mainArea);
    const tabbar = mkEl({ id: 'tabbar' }); body.appendChild(tabbar);
    const addBtn = mkEl({ id: 'btn-add-tab' }); tabbar.appendChild(addBtn);
    body.appendChild(mkEl({ id: 'sb-conn' }));
    body.appendChild(mkEl({ id: 'search-bar' }));
    body.appendChild(mkEl({ id: 'search-input' }));
    body.appendChild(mkEl({ id: 'search-count' }));
    body.appendChild(mkEl({ id: 'settings-pane' }));
    // Hostkey confirm dialog surface (the real handler binds these by id).
    const overlay = mkEl({ id: 'overlay-confirm' });
    overlay.appendChild(mkEl({ id: 'confirm-msg' }));
    overlay.appendChild(mkEl({ id: 'confirm-cancel' }));
    overlay.appendChild(mkEl({ id: 'confirm-ok' }));
    overlay.appendChild(mkEl({ className: 'overlay-backdrop' }));
    body.appendChild(overlay);

    const ctx = {
        console,
        crypto: webcrypto, // the real WebView2 renderer always has this
        setTimeout: (fn, d) => tq.setTimeout(fn, d),
        clearTimeout: (id) => tq.clearTimeout(id),
        requestAnimationFrame: (fn) => { fn(); return 0; },
        document: {
            getElementById: (id) => findById(root, id),
            createElement: () => mkEl(),
            querySelector: (sel) => queryAll(root, sel)[0] || null,
            querySelectorAll: () => [],
            body,
            addEventListener() {},
        },
        window: {},
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
            // Controllable, producer-shaped: each invocation stays pending
            // until the test settles it — exactly what the real bridge does.
            invoke: (cmd, payload) => {
                sends.push({ cmd, payload });
                const rec = { cmd, payload, state: 'pending', value: null, error: null };
                rec.promise = new Promise((res, rej) => {
                    rec.resolve = (v) => { if (rec.state !== 'pending') return; rec.state = 'ok'; rec.value = v; res(v); };
                    rec.reject = (e) => { if (rec.state !== 'pending') return; rec.state = 'err'; rec.error = e; rej(e); };
                });
                invokes.push(rec);
                return rec.promise;
            },
        },
        require: () => ({ clipboard: { readText: () => '', writeText() {} } }),
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
        _clampFontWeight: (v, d) => d,
        _settingsConfig: {},
        ptyBuffers: {},
        GAP_PX: 8,
        Icons: { iconSvg: () => 'svg' },
        escHtml: (s) => String(s),
        showToast: (m, isErr) => toasts.push({ m, isErr: !!isErr }),
        LinkOpen: { handleLinkActivate() {}, showLinkTip() {}, hideLinkTip() {} },
        _createWebLinksAddon: () => ({}),
        saveConfig() {},
        clearAlternateScreen() {},
        __tq: tq, __sends: sends, __invokes: invokes, __toasts: toasts, __root: root,
        __emit: (ch, payload) => {
            (ipcHandlers.get(ch) || []).slice().forEach(fn => fn({}, payload));
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext('var _spannerDrag = false; var _windowResizing = false;', ctx);
    for (const f of ['split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js', 'terminal.js', 'tabs.js', 'ipc.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    ctx.sshAttempts = vm.runInContext('sshAttempts', ctx);
    ctx._wireSmoothCursorWebgl = () => ({ _adapter: {}, dispose() {} });
    return ctx;
}

const flushAsync = () => new Promise(r => setTimeout(r, 0));

// Single wired tab (real wireTerminal: term + callbacks + wrap mounted).
function wiredTab(ctx, id, backendId, over = {}) {
    const tab = { id, name: id, type: 'local', command: 'powershell.exe', args: [], connected: true, ...over };
    ctx.TabManager.tabs.push(tab);
    ctx.wireTerminal(tab, backendId);
    return tab;
}

// A REAL pending pane: wiredTab + real addPaneRelativeTo spawns the second
// pane and sends its creation request (local pty-create).
function pendingSplit(ctx, id, backend1, over = {}) {
    const tab = wiredTab(ctx, id, backend1, over);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'first split built two panes');
    const pending = panes[1];
    assert.ok(pending.requestId, 'pending pane carries a creation request id');
    assert.equal(pending.tabId, null, 'pending pane has no backend yet');
    assert.equal(pending.term, null, 'pending pane has no terminal yet');
    return { tab, live: panes[0], pending };
}

// A REAL pending SSH tab: `_sshConnectWithCredentials` creates the attempt
// and enqueues it. When `head` is true the tab's invocation must already be
// in flight (it is the queue head); a queued tab's invocation legitimately
// does not exist yet.
async function pendingSshTab(ctx, id, over = {}, head = true) {
    const tab = { id, name: id, type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null, ...over };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    await flushAsync();
    if (head) {
        const inv = ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tab._pendingAttempt).pop();
        assert.ok(inv, 'ssh-connect invocation recorded through the real queue');
    }
    return tab;
}

const sendsOf = (ctx, cmd, pred = () => true) =>
    ctx.__sends.filter(s => s.cmd === cmd && pred(s.payload));
const invOf = (ctx, attemptId) =>
    ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === attemptId).pop();
const bannerCount = (term, banner) => term.text.split(banner).length - 1;

// ── Source-faithful Rust pending-registry consumer ──────────────────────────
// Mirrors zterm.rs: entries keyed by attemptId; cancel_pending(Backend|Attempt);
// session removal by backend id. Keep in sync with the Rust helpers.
class PendingRegistryModel {
    constructor() {
        this.entries = new Map(); // attemptId -> { cancel, backend }
        this.counter = 0;
        this.cancelledBackends = [];
        this.disconnectedSessions = [];
        this._mark = 0;
    }
    connect(attemptId) {
        const backend = 'ssh_m' + (++this.counter);
        this.entries.set(attemptId, { cancel: false, backend });
        return backend;
    }
    _cancel(selector) {
        let key = null;
        if (selector.tabId) {
            for (const [k, e] of this.entries) if (e.backend === selector.tabId) { key = k; break; }
        } else if (selector.attemptId) {
            key = selector.attemptId;
        }
        if (!key) return null;
        const e = this.entries.get(key);
        this.entries.delete(key);
        e.cancel = true;
        this.cancelledBackends.push(e.backend);
        return e.backend;
    }
    consume(ctx) {
        for (let i = this._mark; i < ctx.__sends.length; i++) {
            const s = ctx.__sends[i];
            const p = s.payload || {};
            if (s.cmd === 'ssh-connect' && p.attemptId) this.connect(p.attemptId);
            if (s.cmd === 'pty-destroy' || s.cmd === 'ssh-disconnect') {
                if (p.tabId || p.attemptId) this._cancel({ tabId: p.tabId || null, attemptId: p.attemptId || null });
                if (p.tabId) this.disconnectedSessions.push(p.tabId);
            }
        }
        this._mark = ctx.__sends.length;
    }
    emit(ctx, ch, payload) {
        ctx.__emit(ch, payload);
        this.consume(ctx);
    }
    alive(attemptId) { const e = this.entries.get(attemptId); return !!e && !e.cancel; }
    entry(attemptId) { return this.entries.get(attemptId); }
}

// ═══ R1: pending LOCAL pane closed — pty-created inside the exit window ═══

test('pane-close pending(local): pty-created in the exit window is disposed, not claimed', () => {
    const ctx = loadVm();
    const { tab, live, pending } = pendingSplit(ctx, 't_r1', 'local_1');
    const rid = pending.requestId;
    assert.ok(sendsOf(ctx, 'pty-create', p => p.requestId === rid).length === 1, 'creation request really sent');

    ctx.TabManager._closePane(tab.id, pending.id);
    assert.ok(ctx.getAllPanes(tab).includes(pending), 'inside the exit-animation window');
    assert.equal(pending.term, null, 'no terminal on the dying pane');

    ctx.__emit('pty-created', { tabId: 'local_2', requestId: rid });
    assert.equal(pending.term, null, 'a closing pane must not resurrect a terminal');
    assert.equal(pending.tabId, null, 'a closing pane must not adopt the backend id');
    assert.equal(sendsOf(ctx, 'pty-destroy', p => p.tabId === 'local_2').length, 1,
        'the late creation result is orphan-destroyed');

    assert.ok(live.term && !live.term.disposed, 'surviving pane terminal intact');
    ctx.__tq.advance(300);
    assert.equal(ctx.getAllPanes(tab).includes(pending), false, 'removal timer unaffected');
    assert.ok(live.term && !live.term.disposed, 'survivor intact after removal');
});

// ═══ R2: pending SSH pane closed — connecting inside the exit window ═══

test('pane-close pending(ssh): late connecting in the exit window is disposed, attempt cancelled', async () => {
    const ctx = loadVm();
    const { tab, live, pending } = pendingSplit(ctx, 't_r2', 'ssh_A', { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const model = new PendingRegistryModel();
    await flushAsync();
    model.consume(ctx);
    const att = pending._pendingAttempt;
    const bid = model.entry(att)?.backend;
    assert.ok(att && bid, 'pane attempt registered with its backend identity');

    ctx.TabManager._closePane(tab.id, pending.id);
    assert.ok(ctx.getAllPanes(tab).includes(pending), 'inside the exit-animation window');
    model.consume(ctx);
    assert.ok(!model.alive(att), 'close initiation cancels the pane\'s own attempt');
    assert.ok(sendsOf(ctx, 'pty-destroy', p => p.attemptId === att).length === 1,
        'cancel carries the attempt token (identity, not a display address)');

    ctx.__emit('ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(pending.term, null, 'no terminal resurrected into the dying pane');
    assert.equal(pending.tabId, null, 'dying pane does not adopt the backend id');
    assert.ok(sendsOf(ctx, 'ssh-disconnect', p => p.tabId === bid && p.attemptId === att).length === 1,
        'unclaimed connecting result disposed by its own identity');

    ctx.__tq.advance(300);
    assert.equal(ctx.getAllPanes(tab).includes(pending), false);
    assert.ok(live.term && !live.term.disposed, 'survivor intact');
});

// ═══ R3: closeTab of a PENDING ssh tab ═══

test('closeTab pending(ssh) tab: no claim during the window, late completion disposed', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_r3');
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = tab._pendingAttempt;
    const bid = model.entry(att).backend;
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);
    assert.ok(ctx.TabManager.tabs.includes(tab), 'inside the deferred removal window');
    model.consume(ctx);
    assert.ok(!model.alive(att), 'close initiation cancels the tab-level attempt');

    ctx.__emit('ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.term, null, 'closing tab claims no terminal');
    assert.equal(tab.tabId, null, 'closing tab adopts no backend id');
    assert.equal(ctx.document.getElementById('wrap_' + tab.id), null, 'no wrap resurrected for the closing tab');

    ctx.__tq.advance(600);
    assert.equal(ctx.TabManager.tabs.includes(tab), false, 'tab removed');
    assert.ok(ctx.TabManager.tabs.includes(keep), 'sibling tab untouched');

    ctx.__emit('ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.ok(sendsOf(ctx, 'ssh-disconnect', p => p.tabId === bid).length >= 1,
        'ownerless completion is disposed, not silently dropped');
    assert.equal(tab.connected, false, 'no state resurrection for the closed tab');
});

// ═══ R4: closeTab of a split tab holding a pending LOCAL pane ═══

test('closeTab split tab: the pending local pane\'s late creation is orphan-destroyed', () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const { tab, pending } = pendingSplit(ctx, 't_r4', 'local_1');
    const rid = pending.requestId;
    ctx.TabManager.render();
    ctx.__sends.length = 0;

    ctx.TabManager.closeTab(tab.id);
    assert.ok(ctx.TabManager._closingTabs.has(tab.id), 'inside the close window');

    ctx.__emit('pty-created', { tabId: 'local_2', requestId: rid });
    assert.equal(pending.term, null, 'pane of a closing tab claims no terminal');
    assert.equal(sendsOf(ctx, 'pty-destroy', p => p.tabId === 'local_2').length, 1,
        'late local creation result orphan-destroyed');

    ctx.__tq.advance(600);
    assert.equal(ctx.TabManager.tabs.includes(tab), false);
    assert.ok(ctx.TabManager.tabs.includes(keep));
});

// ═══ R5/R6: stale old-generation events during a legitimate reconnect ═══

// Build a gen-1 SSH session through the real lifecycle (attempt + claim +
// connected + settled invocation), the way an actual first connect runs.
async function liveSshTab(ctx, id) {
    const tab = { id, name: id, type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    await flushAsync();
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = tab._pendingAttempt;
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    invOf(ctx, att).resolve({ tabId: bid }); // own invocation completes
    await flushAsync();
    assert.equal(tab.connected, true, 'gen-1 live');
    return { tab, att, bid, model };
}

test('reconnectTab: stale old-generation error cannot hijack the pending replacement', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const { tab, att: att1, bid: bid1 } = await liveSshTab(ctx, 't_r5');
    const model = new PendingRegistryModel();
    model.consume(ctx);
    ctx.TabManager.render();

    ctx.TabManager.reconnectTab(tab.id);
    assert.equal(tab.tabId, null, 'reconnect released the old generation');
    ctx.__tq.advance(500);
    await flushAsync();
    const att2 = tab._pendingAttempt;
    assert.ok(att2 && att2 !== att1, 'replacement attempt created with a NEW identity');
    model.consume(ctx);
    assert.ok(model.alive(att2), 'replacement attempt registered');

    // Stale gen-1 error dequeued after the reconnect.
    const toastsBefore = ctx.__toasts.length;
    model.emit(ctx, 'ssh-error', { tabId: bid1, rendererId: 'legacy', attemptId: att1, error: 'SSH PTY: boom' });
    assert.notEqual(tab.tabId, bid1, 'stale error must not re-adopt the dead backend id');
    assert.notEqual(tab._sessionFailed, true, 'stale error must not fail the replacement');
    assert.equal(ctx.__toasts.length, toastsBefore, 'stale-generation failure surfaces nothing');
    assert.ok(model.alive(att2), 'stale error cannot cancel the replacement attempt');

    // The replacement proceeds: its own invocation completes.
    const bid2 = model.entry(att2).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    model.emit(ctx, 'ssh-connected', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    invOf(ctx, att2).resolve({ tabId: bid2 });
    await flushAsync();
    assert.equal(tab.tabId, bid2, 'replacement claimed');
    assert.equal(tab.connected, true);
    assert.ok(ctx.TabManager.tabs.includes(keep));
});

test('_reconnectPane: stale old-generation error is dropped for the replacing pane', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_r6', 'ssh_A', { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    const p2 = panes[1];
    // Real pending attempt for the new pane.
    p2.type = 'ssh';
    p2._sshHost = 'h'; p2._sshUser = 'u';
    ctx._sshConnectWithCredentials(tab, p2);
    await flushAsync();
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = p2._pendingAttempt;
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(p2.tabId, bid, 'pane claimed; auth pending');

    ctx.TabManager._reconnectPane(tab.id, p2.id);
    model.consume(ctx);
    assert.ok(!model.alive(att), 'reconnect cancels the pane\'s old attempt by identity');
    assert.equal(p2.tabId, null, 'pane reconnect released the old id');

    // Dead generation's error lands inside the replacement window.
    model.emit(ctx, 'ssh-error', { tabId: bid, rendererId: 'legacy', attemptId: att, error: 'SSH PTY: boom' });
    assert.equal(p2.term, null, 'stale error must not resurrect an error terminal');
    assert.notEqual(p2._sessionFailed, true, 'stale error must not fail the replacement');

    ctx.__tq.advance(500);
    await flushAsync();
    const att2 = p2._pendingAttempt;
    assert.ok(att2 && att2 !== att, 'replacement attempt registered under a NEW identity');
    model.consume(ctx);
    const bid2 = model.entry(att2)?.backend;
    assert.ok(bid2, 'replacement invocation sent (queue not stuck behind the zombie slot)');
    model.emit(ctx, 'ssh-connecting', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    model.emit(ctx, 'ssh-connected', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    invOf(ctx, att2).resolve({ tabId: bid2 });
    await flushAsync();
    assert.equal(p2.tabId, bid2, 'pane replacement claimed');
    assert.ok(p2.term && !p2.term.disposed, 'pane replacement terminal wired');
});

// ═══ R7 (migration positive): pending LOCAL request survives the live
// sibling's close and claims on the collapsed tab (ADR-0004 item 6) ═══

test('migration: pending local pane survives the live sibling\'s close and claims on the collapsed tab', () => {
    const ctx = loadVm();
    const { tab, live, pending } = pendingSplit(ctx, 't_r7', 'local_1');
    const rid = pending.requestId;

    ctx.TabManager._closePane(tab.id, live.id);
    assert.ok(sendsOf(ctx, 'pty-destroy', p => p.tabId === 'local_1').length >= 1, 'live sibling backend destroyed');
    ctx.__tq.advance(300); // collapse completes
    assert.equal(tab.splitRoot, null, 'split collapsed');
    assert.equal(tab._ptyRequestId, rid, 'pending local request followed the surviving owner');

    ctx.__emit('pty-created', { tabId: 'local_2', requestId: rid });
    assert.equal(tab.tabId, 'local_2', 'pending request completes once on its new owner');
    assert.ok(tab.term && !tab.term.disposed, 'terminal wired for the claimed backend');
    assert.equal(sendsOf(ctx, 'pty-destroy', p => p.tabId === 'local_2').length, 0,
        'the legitimate claim is never orphan-destroyed');
});

// ═══ R8: stale old-generation COMPLETION cannot cancel/release the
// replacement (backend identity is exact by construction) ═══

test('R8: stale old-generation ssh-connected/ssh-connecting cannot touch the replacement', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const { tab, att: att1, bid: bid1 } = await liveSshTab(ctx, 't_r8');
    const model = new PendingRegistryModel();
    model.consume(ctx);
    ctx.TabManager.render();

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500);
    await flushAsync();
    const att2 = tab._pendingAttempt;
    model.consume(ctx);
    const bid2 = model.entry(att2).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    assert.equal(tab.tabId, bid2, 'A2 claimed; handshake pending');

    // Stale completions of the DEAD generation, same lineage.
    model.emit(ctx, 'ssh-connected', { tabId: bid1, rendererId: 'legacy', attemptId: att1 });
    assert.ok(model.alive(att2), 'BLOCKER: stale completion must not cancel the replacement attempt');
    assert.equal(tab.tabId, bid2, 'stale completion does not re-route the owner');
    assert.ok(sendsOf(ctx, 'ssh-disconnect', p => p.tabId === bid1).length >= 1,
        'dead old session still disposed by backend id');

    model.emit(ctx, 'ssh-connecting', { tabId: bid1, rendererId: 'legacy', attemptId: att1 });
    assert.ok(model.alive(att2), 'stale connecting must not cancel the replacement either');

    // The replacement itself settles normally.
    model.emit(ctx, 'ssh-connected', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    invOf(ctx, att2).resolve({ tabId: bid2 });
    await flushAsync();
    assert.equal(tab.connected, true, 'replacement is live');
});

// ═══ R9: claimed/auth-pending phase; identity survives migrations ═══

test('R9: closing an auth-pending CLAIMED pane cancels its own attempt at initiation', async () => {
    const ctx = loadVm();
    const { tab, live, pending } = pendingSplit(ctx, 't_r9a', 'ssh_A', { type: 'ssh', connected: true, host: 'h', user: 'u' });
    await flushAsync();
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = pending._pendingAttempt;
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(pending.tabId, bid, 'claimed; auth still pending');

    ctx.TabManager._closePane(tab.id, pending.id);
    model.consume(ctx);
    assert.ok(!model.alive(att), 'claimed pane close cancels THIS pane\'s attempt');
    assert.ok(model.disconnectedSessions.includes(bid), 'the session generation is destroyed by backend id');
    assert.ok(live.term && !live.term.disposed, 'sibling terminal intact');
});

// Reachable merge ordering: pending original SSH tab + connected tab dragged
// in; the original attempt must survive the merge and stay cancellable.
async function mergedPendingB(ctx) {
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tB = { id: 't_B', name: 't_B', type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tB);
    ctx._sshConnectWithCredentials(tB, null);
    await flushAsync();
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = tB._pendingAttempt;
    const bBackend = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bBackend, rendererId: 'legacy', attemptId: att });
    assert.equal(tB.tabId, bBackend, 'B claimed; auth still pending');

    const tA = wiredTab(ctx, 't_A', 'local_A');
    ctx.TabManager._moveTerminalToTab(tA.id, tB.id, 't', null);
    const paneB = ctx.getAllPanes(tB).find(p => p.tabId === bBackend);
    assert.ok(paneB, 'B relocated as a pane of its own tab');
    assert.equal(paneB._pendingAttempt, att, 'the attempt followed the promotion (identity, not address)');
    ctx.TabManager._extractPaneToTab(tB.id, paneB.id);
    const nt = ctx.TabManager.tabs.find(t => t !== tB && t.tabId === bBackend);
    assert.ok(nt, 'B extracted into a new tab (identity-changing migration)');
    assert.equal(nt._pendingAttempt, att, 'the attempt followed the extraction');
    assert.equal(tB.tabId, 'local_A', 'original container collapsed to A');
    return { keep, tB, nt, att, bBackend, model };
}

test('R13: closing an extracted auth-pending tab cancels its pending generation', async () => {
    const ctx = loadVm();
    const { keep, tB, nt, att, bBackend, model } = await mergedPendingB(ctx);
    ctx.TabManager.render();
    const sentBefore = ctx.__sends.length;

    ctx.TabManager.closeTab(nt.id);
    ctx.__tq.advance(600); // deferred removal: the destroy commit
    await flushAsync();
    model.consume(ctx);
    assert.ok(!model.alive(att),
        'the intended pending generation must actually cancel (identity survives the migration)');
    const destroys = ctx.__sends.slice(sentBefore).filter(s => s.cmd === 'pty-destroy' || s.cmd === 'ssh-disconnect');
    assert.ok(destroys.some(s => s.payload.tabId === bBackend), 'B\'s backend generation destroyed by id');
    assert.ok(ctx.TabManager.tabs.includes(keep) && ctx.TabManager.tabs.includes(tB), 'containers intact');
});

test('R13: reconnecting an extracted auth-pending tab cancels the old attempt and sends the replacement', async () => {
    const ctx = loadVm();
    const { nt, att, bBackend, model } = await mergedPendingB(ctx);
    ctx.TabManager.render();
    const connectsBefore = ctx.__invokes.filter(i => i.cmd === 'ssh-connect').length;

    ctx.TabManager.reconnectTab(nt.id);
    model.consume(ctx);
    assert.ok(!model.alive(att), 'reconnect must cancel the old pending generation');

    ctx.__tq.advance(500); // replacement delay; the old slot was released
    await flushAsync();
    const connects = ctx.__invokes.filter(i => i.cmd === 'ssh-connect');
    assert.equal(connects.length, connectsBefore + 1, 'the replacement must actually be sent');
    const att2 = nt._pendingAttempt;
    assert.ok(att2 && att2 !== att, 'replacement attempt has a NEW identity');
    model.consume(ctx);
    assert.ok(model.alive(att2), 'replacement attempt registered');
});

// ═══ R14: closing the reused ORIGINAL container must hold a pending
// stranger's queue slot (backend guard AND queue guard) ═══

test('R14: closing the reused container cannot release a pending stranger\'s slot', async () => {
    const ctx = loadVm();
    const { tB, att, bBackend, model } = await mergedPendingB(ctx);
    // C queued behind B's waiting slot.
    const tC = { id: 't_C', name: 't_C', type: 'ssh', host: 'c', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tC);
    ctx._sshConnectWithCredentials(tC, null);
    await flushAsync();
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tC._pendingAttempt).length, 0,
        'precondition: C queued behind B, unsent');
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tB.id); // container now holds connected A
    ctx.__tq.advance(600); // deferred removal
    await flushAsync();
    model.consume(ctx);
    assert.ok(model.alive(att), 'backend guard: B\'s attempt untouched by the container close');
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tC._pendingAttempt).length, 0,
        'QUEUE GUARD: the queue must stay held — B is still in flight under this lineage');

    // When B legitimately settles, C may proceed.
    model.emit(ctx, 'ssh-connected', { tabId: bBackend, rendererId: 'legacy', attemptId: att });
    invOf(ctx, att).resolve({ tabId: bBackend });
    await flushAsync();
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tC._pendingAttempt).length, 1,
        'B\'s own settlement advances C exactly once');
});

// ═══ R11: queue semantics under the own-invocation settlement ═══

async function queueFixture(ctx) {
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tabA = await pendingSshTab(ctx, 't_qa');
    const tabB = { id: 't_qb', name: 't_qb', type: 'ssh', host: 'b', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tabB);
    ctx._sshConnectWithCredentials(tabB, null);
    await flushAsync();
    return { keep, tabA, tabB };
}

test('R11: closing the in-flight head request advances the queue promptly, exactly once', async () => {
    const ctx = loadVm();
    const { keep, tabA, tabB } = await queueFixture(ctx);
    const aAtt = tabA._pendingAttempt;
    assert.ok(invOf(ctx, aAtt), 'head invocation in flight (slot waiting)');
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'queued request not sent yet');
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tabA.id);
    await flushAsync(); // NO timer advance: prompt advancement only
    assert.ok(invOf(ctx, tabB._pendingAttempt), 'next live request advances at once');
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tabB._pendingAttempt).length, 1,
        'exactly once');
    invOf(ctx, tabB._pendingAttempt).resolve({ tabId: 'ssh_qb' });
    await flushAsync();
    assert.ok(ctx.TabManager.tabs.includes(keep));
});

test('R11: closing a queued UNSSENT request must never start it', async () => {
    const ctx = loadVm();
    const { tabA, tabB } = await queueFixture(ctx);
    const aAtt = tabA._pendingAttempt; // captured before settlement retires it
    ctx.TabManager.render();
    ctx.TabManager.closeTab(tabB.id); // still queued behind A
    // A completes: the chain runs B's slot, which drops it — no invocation.
    invOf(ctx, aAtt).resolve({ tabId: 'ssh_qa' });
    await flushAsync();
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'closed queued request is never sent');
    assert.ok(invOf(ctx, aAtt), 'A sent exactly once');
});

test('R11: lifecycle events never release the queue; only the own invocation does', async () => {
    const ctx = loadVm();
    const { tabA, tabB } = await queueFixture(ctx);
    // Producer-shaped events (even matching ones) must not advance the queue.
    ctx.__emit('ssh-connected', { tabId: 'ssh_other', rendererId: 'legacy', attemptId: 'att_other' });
    ctx.__emit('ssh-connected', { tabId: 'ssh_qa', rendererId: 'legacy', attemptId: tabA._pendingAttempt });
    await flushAsync();
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'slot A still holds the chain');
    invOf(ctx, tabA._pendingAttempt).resolve({ tabId: 'ssh_qa' });
    await flushAsync();
    assert.ok(invOf(ctx, tabB._pendingAttempt), 'own invocation settlement advances the queue');
    invOf(ctx, tabB._pendingAttempt).resolve({ tabId: 'ssh_qb' });
    await flushAsync();
});

test('R11: closing a CLAIMED auth-pending tab releases its slot at removal', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tabA = await pendingSshTab(ctx, 't_qc');
    const tabB = await pendingSshTab(ctx, 't_qd', {}, false); // queued behind A
    const aAtt = tabA._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(aAtt).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: aAtt });
    assert.equal(tabA.tabId, bid, 'claimed; auth still pending (slot waiting)');
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'B queued behind');
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tabA.id);
    await flushAsync();
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined,
        'slot still held inside the close window (teardown is at removal)');
    ctx.__tq.advance(350); // doRemove: destroy committed + slot released
    await flushAsync();
    assert.ok(invOf(ctx, tabB._pendingAttempt), 'next live request advances once the cancel is committed');
    model.consume(ctx);
    assert.ok(!model.alive(aAtt), 'claimed generation cancelled with its identity');
    invOf(ctx, tabB._pendingAttempt).resolve({ tabId: 'ssh_qd2' });
    await flushAsync();
});

// ═══ R12: the round-2 spec-review blocker — a stale old-generation event
// sharing the lineage must not release the successor's waiting slot ═══

test('R12: stale old-generation events cannot release the successor\'s slot', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const { tab, att: att1, bid: bid1 } = await liveSshTab(ctx, 't_r12');
    const model = new PendingRegistryModel();
    model.consume(ctx);
    ctx.TabManager.render();

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500);
    await flushAsync();
    const att2 = tab._pendingAttempt;
    model.consume(ctx);
    const bid2 = model.entry(att2).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    assert.equal(tab.tabId, bid2, 'A2 claimed; handshake pending (slot waiting)');

    // B queued behind A2's slot.
    const tabB = await pendingSshTab(ctx, 't_r12b', {}, false); // queued behind A2
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'precondition: B queued, unsent');

    // Stale OLD-generation completion, same lineage, different backend.
    model.emit(ctx, 'ssh-connected', { tabId: bid1, rendererId: 'legacy', attemptId: att1 });
    await flushAsync();
    assert.ok(model.alive(att2), 'backend guard: A2 attempt still alive');
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined,
        'BLOCKER: a stale event must not release A2\'s waiting slot');

    // Same flavor with a stale old-generation error.
    model.emit(ctx, 'ssh-error', { tabId: bid1, rendererId: 'legacy', attemptId: att1, error: 'SSH PTY: boom' });
    await flushAsync();
    assert.ok(model.alive(att2), 'A2 attempt still alive after the stale error');
    assert.equal(invOf(ctx, tabB._pendingAttempt), undefined, 'stale error must not release A2\'s slot either');

    // Only A2's OWN settlement may advance the queue — then B starts once.
    model.emit(ctx, 'ssh-connected', { tabId: bid2, rendererId: 'legacy', attemptId: att2 });
    invOf(ctx, att2).resolve({ tabId: bid2 });
    await flushAsync();
    assert.ok(invOf(ctx, tabB._pendingAttempt), 'A2\'s own settlement advances B');
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.payload.attemptId === tabB._pendingAttempt).length, 1,
        'exactly once');
    invOf(ctx, tabB._pendingAttempt).resolve({ tabId: 'ssh_qb' });
    await flushAsync();
    assert.ok(ctx.TabManager.tabs.includes(keep));
});

// ═══ Ordering: the lifecycle events and the own invocation result may
// arrive in ANY order; one shared idempotent transition applies once ═══

test('T1 lifecycle-first: events apply, late invocation result adds nothing', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t1');
    const att = tab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.connected, true);
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1);
    const term1 = tab.term;
    invOf(ctx, att).resolve({ tabId: bid }); // RPC settles LAST
    await flushAsync();
    assert.equal(tab.term, term1, 'no second terminal');
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1, 'no duplicate banner');
    assert.equal(tab.connected, true, 'no regression');
});

test('T2 rpc-first: the result completes the UI handoff; late events add nothing', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t2');
    const att = tab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    // The invocation settles FIRST (its result carries the backend id).
    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    assert.equal(tab.tabId, bid, 'claim secured from the result identity');
    assert.equal(tab.connected, true, 'UI handoff completed');
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1);
    const term1 = tab.term;
    // Late lifecycle events must not duplicate or regress anything.
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.connected, true, 'late connecting must not regress a connected state');
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.term, term1, 'no second terminal');
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1, 'no duplicate banner');
});

test('T3 duplicate connected events write the banner exactly once', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t3');
    const att = tab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1);
    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    assert.equal(bannerCount(tab.term, '[SSH Connected]'), 1);
});

// ═══ No-event terminal paths (early validation rejects BEFORE any emit;
// transport rejection) must finish through the own invocation ═══

test('T4 no-event failure: invalid payload applies the failure to its owner exactly once', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    // No host: the real helper creates the attempt, the enqueue drops it —
    // the ONLY failure signal is the shared transition (no ssh-error event).
    const tab = { id: 't_t4', name: 't_t4', type: 'ssh', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    await flushAsync();
    // The drop retires the attempt synchronously (owner field cleared) —
    // recover the token through the module's test seam.
    const att = ctx.sshAttempts.__tokensForTests().pop();
    assert.ok(att, 'attempt exists');
    assert.equal(ctx.__invokes.filter(i => i.cmd === 'ssh-connect').length, 0, 'invalid payload never invoked');
    assert.ok(tab.term && tab.term.text.includes('SSH Error'), 'failure applied to the owner');
    assert.equal(tab._sessionFailed, true, 'session marked failed');
    assert.equal(ctx.__toasts.filter(t => t.isErr).length, 1, 'one failure toast');
    assert.equal(ctx.sshAttempts.finalState(att), 'failed', 'record retired safely without any event');
    // A late duplicate event for the same attempt adds nothing.
    const text = tab.term.text;
    ctx.__emit('ssh-error', { tabId: null, rendererId: 'legacy', attemptId: att, error: 'dup' });
    assert.equal(tab.term.text, text, 'no duplicate error write');
});

test('T4 no-event failure: invocation rejection (no ssh-error event) applies once', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t4b');
    const att = tab._pendingAttempt;
    invOf(ctx, att).reject('ssh-connect: missing attemptId'); // transport/validation rejection
    await flushAsync();
    assert.ok(tab.term && tab.term.text.includes('SSH Error'), 'failure applied to the owner');
    assert.equal(tab._sessionFailed, true);
    assert.equal(ctx.sshAttempts.finalState(att), 'failed');
});

// ═══ Cancellation interleaved with completion: a cancelled attempt that
// nevertheless completed is disposed by its own identity — nothing else ═══

test('T5 cancel interleaved with completion: disposal only, no resurrection', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t5');
    const att = tab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.tabId, bid, 'claimed; auth pending');

    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(600); // removal: attempt cancelled by identity
    await flushAsync();
    model.consume(ctx);
    assert.ok(!model.alive(att), 'cancelled');
    assert.equal(ctx.TabManager.tabs.includes(tab), false, 'tab gone');
    const termAtClose = tab.term; // claimed before close; disposed at removal

    // The invocation completes anyway (past its last checkpoint).
    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    assert.equal(tab.term, termAtClose, 'no terminal resurrection for the closed owner');
    assert.ok(termAtClose.disposed, 'the closed owner\'s terminal stays disposed');
    assert.ok(sendsOf(ctx, 'ssh-disconnect', p => p.tabId === bid && p.attemptId === att).length >= 1,
        'the unwanted completed session is disposed by its own identity');
});

// ═══ Slot timeout releases the slot only; a legitimate late success still
// routes (the record stays addressable) ═══

test('T6 timer expiry then legitimate late success still claims', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_t6');
    const att = tab._pendingAttempt;
    // B queued behind: the fallback must release the SLOT so B proceeds...
    const tabB = await pendingSshTab(ctx, 't_t6b', {}, false); // queued behind A
    ctx.__tq.advance(20000); // the 20s fallback fires for A's slot only
    await flushAsync();
    assert.ok(invOf(ctx, tabB._pendingAttempt), 'fallback released the slot; B proceeds');
    // ...but A's attempt is still alive and addressable.
    assert.equal(ctx.sshAttempts.isCancelled(att), false, 'timeout did not cancel the attempt');
    assert.ok(ctx.sshAttempts.ownerWants(att), 'attempt still wanted/addressable');
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    assert.equal(tab.tabId, bid, 'late legitimate success still claims its owner');
    assert.equal(tab.connected, true);
});

// ═══ Hostkey: correlated by attempt identity; dead attempts never open or
// clean up dialogs; decisions rejected only for their own backend ═══

test('HK1: mismatch arriving before the connecting claim opens the dialog for the right owner', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_hk1'); // attempt exists, NO connecting event yet
    const att = tab._pendingAttempt;
    const overlay = ctx.document.getElementById('overlay-confirm');
    assert.equal(overlay.classList.contains('open'), false);

    ctx.__emit('ssh-hostkey-mismatch', { tabId: 'ssh_hk', attemptId: att, host: 'h', oldAlgorithm: 'ssh-ed25519', oldFingerprint: 'AAA', newAlgorithm: 'ssh-ed25519', newFingerprint: 'BBB' });
    assert.equal(overlay.classList.contains('open'), true, 'live attempt: dialog opens');
    // The user's explicit REJECT decision reaches its own backend id.
    ctx.document.getElementById('confirm-cancel').dispatch('click');
    assert.equal(overlay.classList.contains('open'), false);
    assert.ok(sendsOf(ctx, 'ssh-hostkey-decision', p => p.tabId === 'ssh_hk' && p.accept === false).length === 1);
});

test('HK2: cancelled late mismatch rejects only its own decision, no stale modal', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    // Attempt A is live with its dialog OPEN.
    const tabA = await pendingSshTab(ctx, 't_hk2a');
    ctx.__emit('ssh-hostkey-mismatch', { tabId: 'ssh_a', attemptId: tabA._pendingAttempt, host: 'a', oldAlgorithm: 'ed', oldFingerprint: 'A', newAlgorithm: 'ed', newFingerprint: 'B' });
    const overlay = ctx.document.getElementById('overlay-confirm');
    assert.equal(overlay.classList.contains('open'), true);

    // Attempt B was cancelled (its tab closed) — its late mismatch must not
    // open a new modal nor clean up A's live dialog.
    const tabB = await pendingSshTab(ctx, 't_hk2b', {}, false); // queued
    const attB = tabB._pendingAttempt;
    ctx.TabManager.closeTab(tabB.id);
    ctx.__tq.advance(600);
    await flushAsync();
    ctx.__emit('ssh-hostkey-mismatch', { tabId: 'ssh_b', attemptId: attB, host: 'b', oldAlgorithm: 'ed', oldFingerprint: 'C', newAlgorithm: 'ed', newFingerprint: 'D' });
    assert.equal(overlay.classList.contains('open'), true, 'the live dialog is untouched');
    assert.ok(sendsOf(ctx, 'ssh-hostkey-decision', p => p.tabId === 'ssh_b' && p.accept === false).length === 1,
        'the dead attempt\'s own decision is rejected so its task unblocks');
    assert.equal(sendsOf(ctx, 'ssh-hostkey-decision', p => p.tabId === 'ssh_a').length, 0,
        'the live attempt\'s decision was not answered by the guard');
});

// ═══ D1 (main-review probe 1): a duplicate success arriving after a real
// disconnection must be a TRUE no-op — it must not flip connected back on,
// clear liveness markers, rewrite the terminal or reset the caret filter ═══

test('D1: duplicate success after disconnection preserves the disconnect (tab)', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const tab = await pendingSshTab(ctx, 't_d1');
    const att = tab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.connected, true, 'genuine success applies');

    // Newer lifecycle state: the session drops.
    ctx.__emit('ssh-disconnected', { tabId: bid, reason: 'network gone' });
    assert.equal(tab.connected, false);
    assert.equal(tab._sessionFailed, true);
    assert.ok(tab.term.text.includes('[SSH Disconnected]'), 'disconnect line visible');
    const text = tab.term.text;
    const toastsAfterDisconnect = ctx.__toasts.length;

    // The OWN invocation settles late — the duplicate success channel.
    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    assert.equal(tab.connected, false, 'duplicate success must not revive a disconnected tab');
    assert.equal(tab._sessionFailed, true, 'liveness marker preserved');
    assert.equal(tab.term.text, text, 'no terminal writes on the duplicate');
    assert.equal(ctx.__toasts.length, toastsAfterDisconnect, 'no new notification');

    // A late duplicate EVENT is equally inert.
    ctx.__emit('ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(tab.connected, false, 'late duplicate event changes nothing');
    assert.equal(tab._sessionFailed, true);
});

test('D1: duplicate success after disconnection preserves the disconnect (pane)', async () => {
    const ctx = loadVm();
    const { tab, pending } = pendingSplit(ctx, 't_d1p', 'ssh_A', { type: 'ssh', connected: true, host: 'h', user: 'u' });
    await flushAsync();
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const att = pending._pendingAttempt;
    const bid = model.entry(att).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: bid, rendererId: 'legacy', attemptId: att });
    model.emit(ctx, 'ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(pending.connected, true);

    ctx.__emit('ssh-disconnected', { tabId: bid, reason: 'reset' });
    assert.equal(pending.connected, false);
    assert.equal(pending._sessionFailed, true);

    invOf(ctx, att).resolve({ tabId: bid });
    await flushAsync();
    ctx.__emit('ssh-connected', { tabId: bid, rendererId: 'legacy', attemptId: att });
    assert.equal(pending.connected, false, 'pane not revived by either duplicate channel');
    assert.equal(pending._sessionFailed, true, 'pane liveness marker preserved');
});

// ═══ D2 (main-review probe 3): the attempt of a pane moved OUT of a split
// must transfer from the REMOVED pane object (the real moved owner), so
// closing the moved pane releases its queue slot at once — not only via the
// backend-cancel route that waits for the invocation/fallback ═══

test('D2: moving a claimed pane transfers its attempt; closing it releases the queue immediately', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    // S: pending SSH head, claimed (auth pending, invocation in flight).
    const sTab = await pendingSshTab(ctx, 't_s');
    const sAtt = sTab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const sBid = model.entry(sAtt).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: sBid, rendererId: 'legacy', attemptId: sAtt });
    assert.equal(sTab.tabId, sBid, 'S claimed; auth pending');

    // Sibling Q queued behind S's waiting slot (real spawn on split).
    ctx.TabManager.addPaneRelativeTo(sTab, 'b');
    const sPane = ctx.getAllPanes(sTab).find(p => p.tabId === sBid);
    const qPane = ctx.getAllPanes(sTab).find(p => p !== sPane);
    const qAtt = qPane._pendingAttempt;
    assert.ok(sPane && qPane && qAtt, 'split spawned a queued SSH sibling with its own attempt');
    assert.equal(invOf(ctx, qAtt), undefined, 'Q queued, unsent');

    // Focus S's pane and drag it into a separate target tab.
    ctx.TabManager._focusPane(sTab, sPane.id); // takes the tab OBJECT
    const tTgt = wiredTab(ctx, 't_tgt', 'local_T');
    ctx.TabManager._moveTerminalToTab(sTab.id, tTgt.id, 't', null);
    const moved = ctx.getAllPanes(tTgt).find(p => p.tabId === sBid);
    assert.ok(moved, 'S relocated as a pane of the target');
    assert.equal(ctx.sshAttempts.ownerOf(sAtt), moved, 'the attempt follows the ACTUAL moved pane');
    assert.equal(moved._pendingAttempt, sAtt);
    // The surviving sibling keeps its own independent binding — which the
    // source collapse then legitimately carries onto the collapsed tab (a
    // migration of ITS owner, never of the moved attempt).
    assert.equal(ctx.sshAttempts.ownerOf(qAtt), sTab, 'survivor binding followed its own collapse');
    assert.equal(sTab.tabId === sBid, false, 'source no longer claims S by pass 1');

    // Closing the moved pane must release S's queue slot at once: Q starts
    // after Promise flushing — WITHOUT settling S's invocation and WITHOUT
    // the 20s fallback.
    ctx.TabManager._closePane(tTgt.id, moved.id);
    await flushAsync();
    model.consume(ctx);
    assert.ok(!model.alive(sAtt), 'S cancelled by identity');
    assert.ok(invOf(ctx, qAtt), 'Q starts immediately (slot released with the cancel)');
    assert.ok(model.alive(qAtt), 'Q untouched');
    invOf(ctx, qAtt).resolve({ tabId: 'ssh_q' });
    await flushAsync();
});

test('D2: reconnecting that moved pane cancels its attempt and sends the replacement', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const sTab = await pendingSshTab(ctx, 't_s2');
    const sAtt = sTab._pendingAttempt;
    const model = new PendingRegistryModel();
    model.consume(ctx);
    const sBid = model.entry(sAtt).backend;
    model.emit(ctx, 'ssh-connecting', { tabId: sBid, rendererId: 'legacy', attemptId: sAtt });
    ctx.TabManager.addPaneRelativeTo(sTab, 'b');
    const sPane = ctx.getAllPanes(sTab).find(p => p.tabId === sBid);
    ctx.TabManager._focusPane(sTab, sPane.id); // takes the tab OBJECT
    const tTgt = wiredTab(ctx, 't_tgt2', 'local_T2');
    ctx.TabManager._moveTerminalToTab(sTab.id, tTgt.id, 't', null);
    const moved = ctx.getAllPanes(tTgt).find(p => p.tabId === sBid);
    assert.equal(ctx.sshAttempts.ownerOf(sAtt), moved, 'precondition: attempt on the moved pane');

    ctx.TabManager._reconnectPane(tTgt.id, moved.id);
    model.consume(ctx);
    assert.ok(!model.alive(sAtt), 'moved pane reconnect cancels its attempt by identity');
    // S's released slot advances to the queued SIBLING first (serial queue):
    // settle whatever sibling invocation the chain started, then the
    // replacement follows.
    await flushAsync();
    const queued = ctx.__invokes.filter(i => i.cmd === 'ssh-connect' && i.state === 'pending' && i.payload.attemptId !== sAtt);
    for (const q of queued) q.resolve({ tabId: 'ssh_q_' + q.payload.attemptId });
    ctx.__tq.advance(500);
    await flushAsync();
    const att2 = moved._pendingAttempt;
    assert.ok(att2 && att2 !== sAtt, 'replacement attempt for the moved pane');
    assert.ok(invOf(ctx, att2), 'replacement sent (slot released with the cancel)');
});

// ═══ D3 (main-review probe 2): cancelling work that never invoked must
// retire its owner/resources immediately; no nonexistent RPC is awaited ═══

test('D3: closing an unsent queued attempt retires it immediately', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    const { tabA, tabB } = await queueFixture(ctx);
    const aAtt = tabA._pendingAttempt;
    const bAtt = tabB._pendingAttempt;
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tabB.id);
    ctx.__tq.advance(600); // B removed
    // RED against the frozen candidate: the record retained the removed
    // owner forever, awaiting an RPC that can never arrive.
    assert.equal(ctx.sshAttempts.ownerOf(bAtt), null, 'unsent cancellation drops its owner');
    assert.equal(tabB._pendingAttempt, null, 'removed wrapper\'s field cleared');
    assert.equal(ctx.sshAttempts.finalState(bAtt), 'cancelled', 'record retired to the finished map');

    // A settles; B's queue entry is visited and skipped — never invoked.
    invOf(ctx, aAtt).resolve({ tabId: 'ssh_qa' });
    await flushAsync();
    assert.equal(invOf(ctx, bAtt), undefined, 'never sent after cancellation');
    // The wrapper accepts a successor attempt cleanly (field was cleared).
    const fresh = ctx.sshAttempts.createAttempt(tabB);
    assert.equal(tabB._pendingAttempt, fresh, 'successor-field protection');
});

test('D3: credential continuation respects a cancelled unsent attempt', async () => {
    const ctx = loadVm();
    const keep = wiredTab(ctx, 't_keep', 'local_9');
    // No live credential and a profile with an encrypted password: the real
    // helper must register a credential BEFORE enqueueing the connect.
    ctx.TabManager.sshProfiles = [{ id: 'prof1', name: 'p', host: 'h', username: 'u', encryptedPassword: 'enc' }];
    const tab = { id: 't_cr', name: 't_cr', type: 'ssh', host: 'h', user: 'u', sshProfileId: 'prof1', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    await flushAsync();
    const credInv = ctx.__invokes.find(i => i.cmd === 'register-credential');
    assert.ok(credInv, 'credential registration pending (connect not yet invoked)');
    const att = tab._pendingAttempt;
    assert.ok(att, 'attempt exists while the credential registers');
    assert.equal(invOf(ctx, att), undefined, 'not invoked yet');

    // Close during registration: the attempt is unsent — it must retire NOW.
    ctx.TabManager.render();
    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(600);
    assert.equal(ctx.sshAttempts.ownerOf(att), null, 'retired while the credential was registering');
    assert.equal(tab._pendingAttempt, null);

    // The credential resolves late: the continuation must not enqueue.
    credInv.resolve({ credId: 'c1' });
    await flushAsync();
    assert.equal(invOf(ctx, att), undefined, 'never invoked after the cancel');
    // The profile-derived handle is potentially shared: never revoked here.
    assert.equal(sendsOf(ctx, 'revoke-credential').length, 0);
});
