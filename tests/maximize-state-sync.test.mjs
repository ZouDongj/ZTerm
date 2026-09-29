// Regression (T33): native maximize paths (titlebar double-click, Win+Up,
// edge snap, startup restore) never reach the window_maximize command, so
// window-state-changed stayed silent and the maximize button glyph/class went
// stale — the button then acted opposite to its icon. Fix: re-read the
// authoritative window state (window.__TAURI__.window.getCurrentWindow()
// .isMaximized(), allowed by core:window:default) on every viewport resize
// and once at window-shown, applying it through the same _applyMaximizeState
// the button path uses. The REAL main.js pieces are extracted and run in a
// minimal VM with a fake DOM/Tauri surface; pre-fix code fails the very first
// extraction assert (no native sync exists), i.e. RED before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSrc = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');

// Extract the REAL main.js pieces under test (order mirrors the file: the seq
// counter must exist before any handler that bumps it is fired).
const seqDecl = mainSrc.match(/let _maxSyncSeq = 0;/);
assert.ok(seqDecl, '_maxSyncSeq declaration found in main.js');
const applySrc = mainSrc.match(/function _applyMaximizeState\(maximized\) \{[\s\S]*?\n\}/);
assert.ok(applySrc, '_applyMaximizeState source found in main.js');
const syncSrc = mainSrc.match(/function _syncMaximizeStateFromWindow\(\) \{[\s\S]*?\n\}/);
assert.ok(syncSrc, '_syncMaximizeStateFromWindow source found in main.js (native maximize state sync missing)');
const stateChangedSrc = mainSrc.match(/ipcRenderer\.on\('window-state-changed', \(event, \{ maximized \}\) => \{[\s\S]*?\n\}\);/);
assert.ok(stateChangedSrc, 'window-state-changed handler source found in main.js');
const resizeWiring = mainSrc.match(/window\.addEventListener\('resize', _syncMaximizeStateFromWindow\);/);
assert.ok(resizeWiring, 'resize listener registration found in main.js');
const shownWiring = mainSrc.match(/ipcRenderer\.on\('window-shown', \(\) => _syncMaximizeStateFromWindow\(\)\);/);
assert.ok(shownWiring, 'window-shown sync registration found in main.js');

// Deferred so tests can control answer ordering of isMaximized.
function deferred() {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise: p, resolve, reject };
}

// Fake presentation surface: exactly what _applyMaximizeState touches.
function mkEl() {
    const el = { textContent: '' };
    const classes = new Set();
    el.classList = {
        toggle(c, force) {
            const on = force === undefined ? !classes.has(c) : !!force;
            on ? classes.add(c) : classes.delete(c);
            return on;
        },
        contains: (c) => classes.has(c),
    };
    return el;
}

// VM fixture: real extracted code, faked document/window/ipcRenderer/__TAURI__.
// `respond` is invoked per isMaximized call and returns a value/promise.
function fixture(respond) {
    const btn = mkEl();
    const winEl = mkEl();
    const resizeHandlers = [];
    const ipcHandlers = new Map();
    const ctx = {
        document: {
            getElementById: (id) => (id === 'win-maximize' ? btn : null),
            querySelector: (sel) => (sel === '.window' ? winEl : null),
        },
        window: {
            addEventListener: (type, fn) => { if (type === 'resize') resizeHandlers.push(fn); },
            __TAURI__: {
                window: {
                    getCurrentWindow: () => ({ isMaximized: () => respond() }),
                },
            },
        },
        ipcRenderer: {
            on: (ch, fn) => {
                if (!ipcHandlers.has(ch)) ipcHandlers.set(ch, []);
                ipcHandlers.get(ch).push(fn);
            },
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // Run the REAL declarations, handler registration, and listener wiring
    // against the fakes, in file order.
    for (const s of [seqDecl[0], applySrc[0], syncSrc[0], stateChangedSrc[0], resizeWiring[0], shownWiring[0]]) {
        vm.runInContext(s, ctx);
    }
    const fireResize = () => resizeHandlers.forEach(fn => fn());
    const emit = (ch, payload) => (ipcHandlers.get(ch) || []).forEach(fn => fn({}, payload));
    return { ctx, btn, winEl, fireResize, emit };
}

const flush = () => new Promise((r) => setImmediate(r));

test('native maximize (Win+Up / titlebar double-click) syncs glyph and class via resize', async () => {
    const { btn, winEl, fireResize } = fixture(() => Promise.resolve(true));
    fireResize();
    await flush();
    assert.equal(btn.textContent, '\uE923', 'restore glyph after native maximize');
    assert.ok(winEl.classList.contains('is-maximized'), 'window carries is-maximized');
});

test('native unmaximize restores the maximize glyph and clears the class', async () => {
    const { btn, winEl, fireResize } = fixture(() => Promise.resolve(false));
    fireResize();
    await flush();
    assert.equal(btn.textContent, '\uE922', 'maximize glyph after native unmaximize');
    assert.ok(!winEl.classList.contains('is-maximized'), 'is-maximized cleared');
});

test('startup window-shown syncs a restored-maximized window without any resize', async () => {
    const { btn, winEl, emit } = fixture(() => Promise.resolve(true));
    emit('window-shown', {});
    await flush();
    assert.equal(btn.textContent, '\uE923', 'restore glyph after startup maximize restore');
    assert.ok(winEl.classList.contains('is-maximized'), 'window carries is-maximized');
});

test('a stale in-flight answer cannot overwrite a newer query result', async () => {
    let mode = 'held';
    const held = deferred();
    const { btn, fireResize } = fixture(() => (mode === 'held' ? held.promise : Promise.resolve(true)));
    fireResize();               // query 1 stays pending (pre-toggle answer: false)
    mode = 'settled';
    fireResize();               // query 2 answers maximized immediately
    await flush();
    assert.equal(btn.textContent, '\uE923', 'latest answer applied');
    held.resolve(false);        // stale pre-toggle answer lands late
    await flush();
    assert.equal(btn.textContent, '\uE923', 'stale answer discarded');
});

test('button-path event retires an in-flight native query', async () => {
    const held = deferred();
    const { btn, fireResize, emit } = fixture(() => held.promise);
    fireResize();               // native query in flight (would answer false)
    emit('window-state-changed', { maximized: true });
    assert.equal(btn.textContent, '\uE923', 'button-path state applied synchronously');
    held.resolve(false);        // pre-toggle answer arrives after the toggle
    await flush();
    assert.equal(btn.textContent, '\uE923', 'in-flight native answer retired by the button path');
});

test('button-path event still applies state unchanged (existing behavior)', async () => {
    const { btn, winEl, emit } = fixture(() => Promise.resolve(false));
    emit('window-state-changed', { maximized: true });
    assert.equal(btn.textContent, '\uE923');
    assert.ok(winEl.classList.contains('is-maximized'));
    emit('window-state-changed', { maximized: false });
    assert.equal(btn.textContent, '\uE922');
    assert.ok(!winEl.classList.contains('is-maximized'));
});

test('missing or broken Tauri API: sync is a silent no-op, presentation untouched', async () => {
    const broken = [
        () => { throw new Error('no window'); },
        () => null,
        () => ({ notIsMaximized: true }),
    ];
    for (const getCurrentWindow of broken) {
        const btn = mkEl();
        const winEl = mkEl();
        const resizeHandlers = [];
        const ctx = {
            document: {
                getElementById: (id) => (id === 'win-maximize' ? btn : null),
                querySelector: (sel) => (sel === '.window' ? winEl : null),
            },
            window: {
                addEventListener: (t, fn) => { if (t === 'resize') resizeHandlers.push(fn); },
                __TAURI__: { window: { getCurrentWindow } },
            },
            ipcRenderer: { on() {} },
        };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        for (const s of [seqDecl[0], applySrc[0], syncSrc[0]]) vm.runInContext(s, ctx);
        btn.textContent = 'untouched';
        assert.doesNotThrow(() => resizeHandlers.forEach(fn => fn()));
        await flush();
        assert.equal(btn.textContent, 'untouched', `presentation untouched (${getCurrentWindow.name || 'case'})`);
    }
    // __TAURI__ entirely absent (pre-Tauri-injection window): same no-op.
    const plain = fixture(() => { throw new Error('must not be called'); });
    plain.ctx.window.__TAURI__ = undefined;
    plain.btn.textContent = 'untouched';
    assert.doesNotThrow(() => plain.fireResize());
    await flush();
    assert.equal(plain.btn.textContent, 'untouched');
});

test('rejected isMaximized keeps the last applied state (no crash)', async () => {
    const { btn, fireResize, emit } = fixture(() => Promise.reject(new Error('ipc failed')));
    emit('window-state-changed', { maximized: true });
    fireResize();
    await flush();
    assert.equal(btn.textContent, '\uE923', 'rejection leaves the last state in place');
});
