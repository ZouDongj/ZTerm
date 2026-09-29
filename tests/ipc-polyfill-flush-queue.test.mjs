// ipc-polyfill flushQueue: every queued channel's dispatch closure must bind
// its OWN channel. The loop declared the iteration variable with `var`, so
// after the loop every closure read the LAST channel — a queued `on('a')` and
// `on('b')` both dispatched channel b's callbacks: events crossed channels on
// the degraded (pre-__TAURI__) path. `let` gives each iteration an independent
// binding; nothing else about the flush path changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const polyfillSrc = readFileSync(new URL('../src/ipc-polyfill.js', import.meta.url), 'utf8');

// Load the polyfill with __TAURI__ NOT yet injected (the queueing race the
// flush path exists for), then inject it and run one poll tick to flush.
function loadDeferredTauri() {
    const tauriListeners = new Map(); // channel -> handler Tauri's listen registered
    const pollTicks = [];
    const ctx = {
        console: { log() {}, error() {} },
        setInterval: (fn) => { pollTicks.push(fn); return pollTicks.length; },
        clearInterval() {},
        window: {}, // no __TAURI__ yet
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(polyfillSrc, ctx, { filename: 'ipc-polyfill.js' });

    const on = (channel, cb) => ctx.window.electron.ipcRenderer.on(channel, cb);
    const injectTauri = () => {
        ctx.window.__TAURI__ = {
            core: { invoke: () => Promise.resolve() },
            event: {
                listen: (ch, fn) => { tauriListeners.set(ch, fn); return Promise.resolve(function() {}); },
            },
        };
    };
    const flush = () => {
        assert.ok(pollTicks.length > 0, 'the polyfill armed its __TAURI__ poll');
        pollTicks[pollTicks.length - 1](); // one 100ms poll tick: sees Tauri, flushes
    };
    const emit = (channel, payload) => tauriListeners.get(channel)({ payload });
    return { on, injectTauri, flush, emit };
}

test('queued listeners dispatch on their own channel after the deferred flush', () => {
    const h = loadDeferredTauri();
    const aCalls = [];
    const bCalls = [];
    h.on('pty-output', (_ev, payload) => aCalls.push(payload));
    h.on('ssh-connected', (_ev, payload) => bCalls.push(payload));

    h.injectTauri(); // Tauri lands after the on() calls — the degraded path
    h.flush();
    assert.equal(aCalls.length, 0, 'nothing dispatched before a backend event');

    h.emit('pty-output', 'chunk-1');
    h.emit('ssh-connected', { tabId: 't1' });

    // Old `var` failure: both closures read the LAST channel, so the
    // pty-output event ran the ssh-connected callbacks (and vice versa).
    assert.deepEqual(aCalls, ['chunk-1'], 'pty-output listener got only pty-output payloads');
    assert.deepEqual(bCalls, [{ tabId: 't1' }], 'ssh-connected listener got only ssh-connected payloads');
});

test('a single queued channel keeps the exact pre-fix dispatch behavior', () => {
    const h = loadDeferredTauri();
    const calls = [];
    h.on('pty-exit', (_ev, payload) => calls.push(payload));
    h.injectTauri();
    h.flush();
    h.emit('pty-exit', { tabId: 'x' });
    h.emit('pty-exit', { tabId: 'y' });
    assert.deepEqual(calls, [{ tabId: 'x' }, { tabId: 'y' }], 'non-once listeners stay live across events');
});
