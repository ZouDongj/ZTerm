// Authoritative native reduced-motion preference & smooth-cursor gate integration.
//
// REAL: src/ipc-polyfill.js, src/renderer/reduced-motion.js,
// src/renderer/smooth-cursor-overlay.js, src/renderer/xterm-smooth-cursor.js,
// and src/renderer/terminal.js's _wireSmoothCursorWebgl wiring.
// FAKED: Tauri __TAURI__ globals / IPC bridge, window/document event targets,
// and the minimal xterm/WebGL surface required by createXtermWebglSmoothCursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReducedMotionController } = require('../src/renderer/reduced-motion.js');
const { SmoothCursorMotion } = require('../src/renderer/smooth-cursor-overlay.js');
const { createXtermWebglSmoothCursor } = require('../src/renderer/xterm-smooth-cursor.js');

function makeEventTarget() {
    const listeners = new Map();
    const captureOf = opts => (typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture));
    const keyOf = (type, opts) => `${type}:${captureOf(opts) ? 1 : 0}`;
    return {
        listeners,
        addEventListener(type, fn, opts) {
            const k = keyOf(type, opts);
            if (!listeners.has(k)) listeners.set(k, new Set());
            listeners.get(k).add(fn);
        },
        removeEventListener(type, fn, opts) {
            listeners.get(keyOf(type, opts))?.delete(fn);
        },
        dispatch(type, ev = {}) {
            for (const phase of [1, 0]) {
                for (const fn of [...(listeners.get(`${type}:${phase}`) || [])]) fn(ev);
            }
        },
        count(type, opts) {
            if (arguments.length >= 2) return listeners.get(keyOf(type, opts))?.size || 0;
            return (listeners.get(`${type}:0`)?.size || 0) + (listeners.get(`${type}:1`)?.size || 0);
        },
    };
}

function makePageMediaQuery(initialMatches) {
    const target = makeEventTarget();
    return {
        matches: initialMatches,
        addEventListener: target.addEventListener,
        removeEventListener: target.removeEventListener,
        setMatches(next) {
            this.matches = next;
            target.dispatch('change', { matches: next });
        },
        listenerCount() { return target.count('change'); },
    };
}

function makeControllerHarness({ pageReduced = true, invokeImpl = null, minPassiveRefreshMs = 15000 } = {}) {
    let nowMs = 100000;
    const win = makeEventTarget();
    const doc = Object.assign(makeEventTarget(), { visibilityState: 'visible' });
    const ipcListeners = new Map();
    const pageQuery = makePageMediaQuery(pageReduced);
    const invokeCalls = [];
    const controller = createReducedMotionController({
        invoke(channel) {
            invokeCalls.push({ channel, at: nowMs });
            if (invokeImpl) return invokeImpl(channel, invokeCalls.length);
            return Promise.resolve({ animationsEnabled: true, remoteSession: false });
        },
        on(channel, fn) {
            if (!ipcListeners.has(channel)) ipcListeners.set(channel, new Set());
            ipcListeners.get(channel).add(fn);
        },
        removeListener(channel, fn) {
            ipcListeners.get(channel)?.delete(fn);
        },
        matchMedia(query) {
            assert.equal(query, '(prefers-reduced-motion: reduce)');
            return pageQuery;
        },
        win,
        doc,
        now: () => nowMs,
        minPassiveRefreshMs,
    });
    return {
        controller,
        win,
        doc,
        pageQuery,
        invokeCalls,
        ipcListeners,
        setNow(ms) { nowMs = ms; },
        advanceNow(ms) { nowMs += ms; },
        emitNativePush(payload) {
            for (const fn of [...(ipcListeners.get('system-animation-preference-changed') || [])]) {
                fn({}, payload);
            }
        },
    };
}

function makeCursorFixture(reducedMotionQuery) {
    let clock = 0;
    const active = { cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, type: 'normal' };
    const coreService = { isCursorHidden: false, isCursorInitialized: true };
    const gl = {
        canvas: { width: 800, height: 480 },
        isContextLost: () => false,
        enable() {}, disable() {}, scissor() {},
    };
    const rectangle = {
        _gl: gl,
        _verticesCursor: { attributes: new Float32Array(160), count: 0 },
        _cursorFloat: new Float32Array([1, 1, 1, 1]),
        _addRectangleFloat() {},
        _colorToFloat32Array: () => new Float32Array([1, 1, 1, 1]),
        renderCursor() {},
    };
    const glyph = {
        _gl: gl,
        _vertices: { attributes: new Float32Array(22), count: 22 },
        _activeBuffer: 0,
        _updateCell() {},
        render() {},
    };
    let redrawRequests = 0;
    const renderer = {
        _gl: gl,
        _canvas: gl.canvas,
        _coreService: coreService,
        _coreBrowserService: { isFocused: true },
        _cursorBlinkStateManager: { value: { isCursorVisible: true } },
        _rectangleRenderer: { value: rectangle },
        _glyphRenderer: { value: glyph },
        _themeService: { colors: { background: { rgba: 0x000000ff }, foreground: { rgba: 0xffffffff }, cursor: { rgba: 0xffffffff }, ansi: [] } },
        dimensions: { device: { cell: { width: 10, height: 20 }, canvas: { width: 800, height: 480 } } },
        _devicePixelRatio: 1,
        _requestRedrawViewport() { redrawRequests += 1; },
        renderRows() {},
    };
    const terminal = {
        cols: 80,
        rows: 24,
        options: { cursorStyle: 'bar', cursorWidth: 1 },
        buffer: { active },
        element: makeEventTarget(),
        onScroll: () => ({ dispose() {} }),
        onResize: () => ({ dispose() {} }),
        _core: {
            _renderService: { _renderer: { value: renderer } },
            buffer: { ydisp: 0, lines: { get: () => null } },
        },
    };
    const addon = { _renderer: renderer };
    const adapter = createXtermWebglSmoothCursor({
        terminal,
        addon,
        MotionClass: SmoothCursorMotion,
        now: () => clock,
        duration: 90,
        jumpDistance: 8,
        cursorStyle: 'bar',
        renderScope: 'cursor',
        reducedMotionQuery,
    });
    return {
        adapter,
        renderer,
        active,
        getRedrawRequests: () => redrawRequests,
        setClock(ms) { clock = ms; },
    };
}

test('native animationsEnabled=true overrides a frozen WebView2 page reduce=true and restores 90ms cursor motion', async () => {
    const h = makeControllerHarness({
        pageReduced: true,
        invokeImpl: () => Promise.resolve({ animationsEnabled: true, remoteSession: false }),
    });
    const f = makeCursorFixture(h.controller.query);

    // Before the first native reply lands, the page query acts as fallback.
    assert.equal(h.controller.query.matches, true);
    assert.equal(h.controller.snapshot().source, 'page-match-media');
    f.renderer.renderRows(0, 1);
    assert.equal(f.adapter.snapshot().reducedMotion, true);
    assert.equal(f.adapter.snapshot().motionDuration, 0);

    // Startup refresh returns the real local Windows preference (animations enabled).
    const changes = [];
    h.controller.query.addEventListener('change', ev => changes.push(ev.matches));
    await h.controller.start();

    assert.deepEqual(changes, [false]);
    assert.equal(h.controller.query.matches, false);
    assert.deepEqual(h.controller.snapshot(), {
        reducedMotion: false,
        nativeAnimationsEnabled: true,
        remoteSession: false,
        pageReducedMotion: true,
        source: 'native',
    });

    // Next draw flips the adapter gate from 0ms to 90ms without restarting.
    f.setClock(100);
    f.renderer.renderRows(0, 1);
    assert.equal(f.adapter.snapshot().reducedMotion, false);
    assert.equal(f.adapter.snapshot().motionDuration, 90);
    assert.equal(f.adapter.snapshot().motionGateChanges.length, 2);

    // Moving the cursor now slides instead of snapping.
    f.setClock(120);
    f.active.cursorX = 3;
    f.renderer.renderRows(0, 1);
    assert.equal(f.adapter.snapshot().animationActive, true);

    // Disposing the adapter must unsubscribe from ZTermReducedMotion.query so
    // later preference flips do not touch a disposed terminal renderer. Spy on
    // the live query to prove the exact subscribed handler is removed.
    const added = [];
    const removed = [];
    const realAdd = h.controller.query.addEventListener;
    const realRemove = h.controller.query.removeEventListener;
    assert.ok(realAdd && realRemove);
    const f2Query = {
        get matches() { return h.controller.query.matches; },
        addEventListener(type, fn) { added.push({ type, fn }); h.controller.query.addEventListener(type, fn); },
        removeEventListener(type, fn) { removed.push({ type, fn }); h.controller.query.removeEventListener(type, fn); },
    };
    const f2 = makeCursorFixture(f2Query);
    f2.renderer.renderRows(0, 1);
    const changeSubs = added.filter(x => x.type === 'change');
    assert.equal(changeSubs.length, 1, 'adapter subscribes exactly one change handler');
    f2.adapter.dispose();
    assert.ok(removed.some(x => x.type === 'change' && x.fn === changeSubs[0].fn),
        'adapter.dispose() must remove the same change handler it added');
    f.adapter.dispose();
    h.controller.stop();
});

test('native animationsEnabled=false (remote session or OS reduced motion) disables animation even when page reduce=false', async () => {
    const h = makeControllerHarness({
        pageReduced: false,
        invokeImpl: () => Promise.resolve({ animationsEnabled: false, remoteSession: true }),
    });
    const f = makeCursorFixture(h.controller.query);

    await h.controller.start();
    assert.equal(h.controller.query.matches, true);
    assert.deepEqual(h.controller.snapshot(), {
        reducedMotion: true,
        nativeAnimationsEnabled: false,
        remoteSession: true,
        pageReducedMotion: false,
        source: 'native',
    });

    f.renderer.renderRows(0, 1);
    assert.equal(f.adapter.snapshot().reducedMotion, true);
    assert.equal(f.adapter.snapshot().motionDuration, 0);
    f.setClock(30);
    f.active.cursorX = 2;
    f.renderer.renderRows(0, 1);
    assert.equal(f.adapter.snapshot().animationActive, false);
    f.adapter.dispose();
    h.controller.stop();
});

test('focus, visibilitychange (visible only), native push event, and throttled passive activity refresh the gate', async () => {
    let response = { animationsEnabled: false, remoteSession: true };
    const h = makeControllerHarness({
        pageReduced: true,
        invokeImpl: () => Promise.resolve(response),
        minPassiveRefreshMs: 15000,
    });
    const changes = [];
    h.controller.query.addEventListener('change', ev => changes.push(ev.matches));

    await h.controller.start();
    assert.equal(h.invokeCalls.length, 1);
    assert.equal(h.controller.query.matches, true);

    // Hidden visibilitychange must NOT invoke.
    h.doc.visibilityState = 'hidden';
    h.doc.dispatch('visibilitychange');
    assert.equal(h.invokeCalls.length, 1);

    // Visible visibilitychange refreshes and heals when back on local console.
    response = { animationsEnabled: true, remoteSession: false };
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.invokeCalls.length, 2);
    assert.equal(h.controller.query.matches, false);
    assert.deepEqual(changes, [false]);

    // Window focus refreshes again (e.g. user reconnected over RDP).
    response = { animationsEnabled: false, remoteSession: true };
    h.win.dispatch('focus');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.invokeCalls.length, 3);
    assert.equal(h.controller.query.matches, true);
    assert.deepEqual(changes, [false, true]);

    // Native Rust push updates immediately without an invoke round-trip.
    h.emitNativePush({ animationsEnabled: true, remoteSession: false });
    assert.equal(h.invokeCalls.length, 3);
    assert.equal(h.controller.query.matches, false);
    assert.deepEqual(changes, [false, true, false]);

    // Duplicate push with unchanged effective state does not fire a spurious change.
    h.emitNativePush({ animationsEnabled: true, remoteSession: false });
    assert.deepEqual(changes, [false, true, false]);

    // Passive keydown/pointerdown inside the 15s cooldown does not invoke.
    h.advanceNow(5000);
    h.win.dispatch('keydown');
    h.win.dispatch('pointerdown');
    assert.equal(h.invokeCalls.length, 3);

    // Once past the 15s cooldown, passive activity triggers a bounded safety-net refresh.
    response = { animationsEnabled: false, remoteSession: false };
    h.advanceNow(10000);
    h.win.dispatch('keydown');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.invokeCalls.length, 4);
    assert.equal(h.controller.query.matches, true);
    assert.deepEqual(changes, [false, true, false, true]);

    // Reading matches/snapshot stays 100% pure (no extra invokes).
    h.advanceNow(60000);
    void h.controller.query.matches;
    void h.controller.snapshot();
    assert.equal(h.invokeCalls.length, 4);

    h.controller.stop();
});

test('in-flight refresh coalescing and sequence guard prevent stale IPC replies from overwriting newer push state', async () => {
    const resolvers = [];
    const h = makeControllerHarness({
        pageReduced: true,
        invokeImpl: () => new Promise(resolve => resolvers.push(resolve)),
    });
    const p1 = h.controller.start();
    const p2 = h.controller.refresh();
    assert.equal(h.invokeCalls.length, 1, 'concurrent refreshes share one in-flight IPC');
    assert.equal(p1, p2);

    // A fresh native push arrives BEFORE the initial invoke resolves.
    h.emitNativePush({ animationsEnabled: true, remoteSession: false });
    assert.equal(h.controller.query.matches, false);

    // Now the stale initial invoke resolves with an older remote-session value: must be ignored.
    resolvers[0]({ animationsEnabled: false, remoteSession: true });
    await p1;
    assert.equal(h.controller.query.matches, false, 'stale IPC reply cannot clobber newer native push');
    assert.equal(h.controller.snapshot().nativeAnimationsEnabled, true);
    h.controller.stop();
});

test('IPC error and null native preference fall back cleanly without clobbering a known native value on transient error', async () => {
    let mode = 'reject';
    const h = makeControllerHarness({
        pageReduced: true,
        invokeImpl: () => {
            if (mode === 'reject') return Promise.reject(new Error('ipc unavailable'));
            if (mode === 'null') return Promise.resolve({ animationsEnabled: null, remoteSession: null });
            return Promise.resolve({ animationsEnabled: true, remoteSession: false });
        },
    });
    const changes = [];
    h.controller.query.addEventListener('change', ev => changes.push(ev.matches));

    // Initial IPC rejection keeps fallback to page matchMedia.
    await h.controller.start();
    assert.equal(h.controller.query.matches, true);
    assert.equal(h.controller.snapshot().source, 'page-match-media');

    // Page query change propagates while in fallback mode.
    h.pageQuery.setMatches(false);
    assert.equal(h.controller.query.matches, false);
    assert.deepEqual(changes, [false]);

    // Native becomes known (true): subsequent page query flips do NOT trigger spurious changes.
    mode = 'ok';
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().source, 'native');
    h.pageQuery.setMatches(true);
    assert.equal(h.controller.query.matches, false);
    assert.deepEqual(changes, [false]);

    // Transient IPC rejection keeps the last known native value.
    mode = 'reject';
    await h.controller.refresh();
    assert.equal(h.controller.query.matches, false);
    assert.equal(h.controller.snapshot().source, 'native');

    // Explicit null from Win32 failure falls back to page matchMedia (currently true).
    mode = 'null';
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().source, 'page-match-media');
    assert.equal(h.controller.query.matches, true);
    assert.deepEqual(changes, [false, true]);
    h.controller.stop();
});

test('stop() releases every window, document, IPC and mediaQuery listener cleanly', async () => {
    const h = makeControllerHarness({ pageReduced: true });
    await h.controller.start();
    assert.equal(h.win.count('focus', false), 1);
    assert.equal(h.win.count('keydown', true), 1);
    assert.equal(h.win.count('pointerdown', true), 1);
    assert.equal(h.doc.count('visibilitychange', false), 1);
    assert.equal(h.ipcListeners.get('system-animation-preference-changed')?.size, 1);
    assert.equal(h.pageQuery.listenerCount(), 1);

    h.controller.stop();
    assert.equal(h.win.count('focus', false), 0);
    assert.equal(h.win.count('keydown', true), 0);
    assert.equal(h.win.count('pointerdown', true), 0);
    assert.equal(h.doc.count('visibilitychange', false), 0);
    assert.equal(h.ipcListeners.get('system-animation-preference-changed')?.size, 0);
    assert.equal(h.pageQuery.listenerCount(), 0);
});

test('missing or throwing matchMedia reports default source and backward clock jump does not freeze passive refresh', async () => {
    // Missing matchMedia (null) also yields the 'default' source.
    const missing = createReducedMotionController({
        matchMedia: null,
        invoke: () => Promise.resolve(null),
        on() {},
        removeListener() {},
        win: null,
        doc: null,
    });
    // Explicit null opts.matchMedia must not fall back to a global matchMedia in Node.
    assert.equal(typeof globalThis.matchMedia, 'undefined');
    assert.equal(missing.snapshot().source, 'default');
    assert.equal(missing.query.matches, false);

    let nowMs = 50000;
    let invokeCount = 0;
    const controller = createReducedMotionController({
        matchMedia() { throw new Error('matchMedia unavailable'); },
        invoke() {
            invokeCount += 1;
            return Promise.resolve({ animationsEnabled: null, remoteSession: null });
        },
        on() {},
        removeListener() {},
        win: makeEventTarget(),
        doc: Object.assign(makeEventTarget(), { visibilityState: 'visible' }),
        now: () => nowMs,
        minPassiveRefreshMs: 15000,
    });
    assert.deepEqual(controller.snapshot(), {
        reducedMotion: false,
        nativeAnimationsEnabled: null,
        remoteSession: null,
        pageReducedMotion: null,
        source: 'default',
    });

    await controller.start();
    assert.equal(invokeCount, 1);
    assert.equal(controller.snapshot().source, 'default');

    // Moving clock backward (e.g. NTP step if Date.now fallback is used) must
    // not pin maybeRefresh() inside a huge negative cooldown.
    nowMs = 1000;
    const p = controller.maybeRefresh();
    assert.ok(p, 'backward clock step should refresh instead of wedging cooldown');
    await p;
    assert.equal(invokeCount, 2);
    controller.stop();
});

test('real ipc-polyfill.js integration: default window.electron.ipcRenderer, pre-TAURI eventQueue flush, and pending listen unlisten on stop()', async () => {
    const polyfillSrc = fs.readFileSync(new URL('../src/ipc-polyfill.js', import.meta.url), 'utf8');
    const rmSrc = fs.readFileSync(new URL('../src/renderer/reduced-motion.js', import.meta.url), 'utf8');

    // Case A: __TAURI__ is NOT injected yet when ipc-polyfill and ZTermReducedMotion.start() run.
    // Once __TAURI__ arrives and the poll interval ticks, eventQueue flushes and pushes update state.
    const intervals = new Map();
    let nextIntervalId = 1;
    const winA = makeEventTarget();
    const docA = Object.assign(makeEventTarget(), { visibilityState: 'visible' });
    const ctxA = {
        console: { log() {}, error() {} },
        window: null,
        document: docA,
        performance: { now: () => 1000 },
        matchMedia: () => makePageMediaQuery(true),
        setInterval(fn) {
            const id = nextIntervalId++;
            intervals.set(id, fn);
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        addEventListener: winA.addEventListener,
        removeEventListener: winA.removeEventListener,
    };
    ctxA.window = ctxA;
    ctxA.globalThis = ctxA;
    vm.createContext(ctxA);
    vm.runInContext(polyfillSrc, ctxA, { filename: 'ipc-polyfill.js' });
    vm.runInContext(rmSrc, ctxA, { filename: 'reduced-motion.js' });

    // Start before __TAURI__ exists: invoke rejects (fallback to page query), listener queues.
    await ctxA.ZTermReducedMotion.start();
    assert.equal(ctxA.ZTermReducedMotion.snapshot().source, 'page-match-media');
    assert.equal(ctxA.ZTermReducedMotion.query.matches, true);

    const tauriHandlersA = new Map();
    const invokedCmdsA = [];
    ctxA.__TAURI__ = {
        core: {
            invoke(cmd) {
                invokedCmdsA.push(cmd);
                return Promise.resolve({ animationsEnabled: true, remoteSession: false });
            },
        },
        event: {
            listen(channel, handler) {
                tauriHandlersA.set(channel, handler);
                return Promise.resolve(() => { tauriHandlersA.delete(channel); });
            },
        },
    };
    // Trigger ipc-polyfill's __TAURI__ readiness poll to flush eventQueue.
    for (const fn of [...intervals.values()]) fn();
    assert.ok(tauriHandlersA.has('system-animation-preference-changed'),
        'pre-TAURI eventQueue must flush and register the native preference channel');

    tauriHandlersA.get('system-animation-preference-changed')({
        payload: { animationsEnabled: true, remoteSession: false },
    });
    assert.equal(ctxA.ZTermReducedMotion.snapshot().source, 'native');
    assert.equal(ctxA.ZTermReducedMotion.query.matches, false);

    await ctxA.ZTermReducedMotion.refresh();
    assert.deepEqual(invokedCmdsA, ['get_system_animation_preference']);
    ctxA.ZTermReducedMotion.stop();

    // Case B: __TAURI__ IS ready, but listen() is still pending when stop() runs.
    // Settling listen() afterward must invoke its unlisten handle, and any late
    // emitted payload must be ignored because started === false.
    const winB = makeEventTarget();
    const docB = Object.assign(makeEventTarget(), { visibilityState: 'visible' });
    let resolveListen = null;
    let capturedListenHandler = null;
    let unlistenCalls = 0;
    const ctxB = {
        console: { log() {}, error() {} },
        window: null,
        document: docB,
        performance: { now: () => 1000 },
        matchMedia: () => makePageMediaQuery(true),
        __TAURI__: {
            core: {
                invoke: () => Promise.resolve({ animationsEnabled: true, remoteSession: false }),
            },
            event: {
                listen(_channel, handler) {
                    capturedListenHandler = handler;
                    return new Promise(resolve => { resolveListen = resolve; });
                },
            },
        },
        addEventListener: winB.addEventListener,
        removeEventListener: winB.removeEventListener,
    };
    ctxB.window = ctxB;
    ctxB.globalThis = ctxB;
    vm.createContext(ctxB);
    vm.runInContext(polyfillSrc, ctxB, { filename: 'ipc-polyfill.js' });
    vm.runInContext(rmSrc, ctxB, { filename: 'reduced-motion.js' });

    const startPromise = ctxB.ZTermReducedMotion.start();
    ctxB.ZTermReducedMotion.stop();
    await startPromise;
    assert.equal(unlistenCalls, 0);
    resolveListen(() => { unlistenCalls += 1; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(unlistenCalls, 1, 'stop() before listen() settles must still invoke unlisten()');

    // Even if a late event fires on the detached handler, !started ignores it.
    capturedListenHandler({ payload: { animationsEnabled: false, remoteSession: true } });
    assert.equal(ctxB.ZTermReducedMotion.snapshot().nativeAnimationsEnabled, true);
});

test('_wireSmoothCursorWebgl passes ZTermReducedMotion.query into createXtermWebglSmoothCursor', () => {
    const terminalSrc = fs.readFileSync(new URL('../src/renderer/terminal.js', import.meta.url), 'utf8');
    const rmSrc = fs.readFileSync(new URL('../src/renderer/reduced-motion.js', import.meta.url), 'utf8');
    let capturedOpts = null;
    const ctx = {
        console,
        document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
        window: { addEventListener() {}, removeEventListener() {} },
        matchMedia: () => makePageMediaQuery(true),
        _settingsConfig: { animations: true },
        createXtermWebglSmoothCursor(opts) {
            capturedOpts = opts;
            return { setSmooth() {}, setCursorStyle() {}, dispose() {} };
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(rmSrc, ctx, { filename: 'reduced-motion.js' });
    vm.runInContext(terminalSrc, ctx, { filename: 'terminal.js' });

    const term = { options: { cursorStyle: 'bar' } };
    const addon = { onContextLoss() {} };
    ctx._wireSmoothCursorWebgl(term, addon);
    assert.ok(capturedOpts, 'createXtermWebglSmoothCursor was called');
    assert.equal(capturedOpts.reducedMotionQuery, ctx.ZTermReducedMotion.query,
        '_wireSmoothCursorWebgl must inject ZTermReducedMotion.query');
});
