import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createInteractionDiagnostics } = require('../src/renderer/interaction-diagnostics.js');

function fixture() {
    let time = 0, counter = 0;
    const timers = new Map(), listeners = new Map(), owners = new Map();
    const document = {
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        getElementById() { return null; }, querySelector() { return null; },
    };
    const api = createInteractionDiagnostics({ document, now: () => time,
        setTimeout(fn, ms) { const id = ++counter; timers.set(id, { fn, at: time + ms }); return id; },
        clearTimeout(id) { timers.delete(id); }, resolveSource: id => owners.has(id) ? { owner: owners.get(id) } : null,
    });
    return { api, owners, listeners, timers,
        advance(ms) { time += ms; for (const [id, item] of [...timers]) if (timers.has(id) && item.at <= time) { timers.delete(id); item.fn(); } },
    };
}

test('disabled diagnostics allocate no timers/listeners and retain no stream or input', () => {
    const f = fixture();
    assert.equal(f.api.receive('a', 'secret'), null);
    assert.equal(f.api.inputSent('a', 'password'), null);
    assert.deepEqual(f.api.snapshot().records, []);
    assert.equal(f.timers.size + f.listeners.size, 0);
});

test('metadata omits payload/key/code/text and copies snapshots', () => {
    const f = fixture(); f.api.start();
    f.listeners.get('keydown')({ type: 'keydown', key: 'secret-key', code: 'secret-code', target: { id: 'input', tagName: 'INPUT', textContent: 'secret-text' } });
    f.api.inputSent('a', 'secret-input');
    const owner = {};
    const t = f.api.receive('a', 'secret-output', { epoch: 7, seq: 4, us: 99, data: 'secret-native' });
    f.api.routed(t, owner, 'secret-output'); f.api.filtered(t, 'secret-filtered'); f.api.parsed(t);
    const snap = f.api.snapshot();
    assert.doesNotMatch(JSON.stringify(snap), /secret-/);
    assert.deepEqual(snap.records.find(r => r.type === 'receive').backend, { epoch: 7, seq: 4, us: 99 });
    snap.records[0].type = 'changed';
    assert.equal(f.api.snapshot().records[0].type, 'start');
    f.api.stop(); assert.equal(f.timers.size + f.listeners.size, 0);
});

test('ring keeps latest entries, then stops at bounded event cap', () => {
    const f = fixture(); f.api.start({ maxRecords: 16 });
    for (let i = 0; i < 100; i++) f.api.inputSent('a', 'x');
    const snap = f.api.snapshot();
    assert.equal(snap.records.length, 16); assert.equal(snap.dropped, 48);
    assert.equal(snap.reason, 'record-cap'); assert.equal(snap.enabled, false);
    assert.equal(snap.records[0].diagnosticInputId, 48);
    assert.equal(f.timers.size + f.listeners.size, 0);
});

test('heartbeat measures delayed execution and timeout cleans all hooks', () => {
    const f = fixture(); f.api.start({ durationMs: 1000 }); f.advance(600);
    assert.equal(f.api.snapshot().records.find(r => r.type === 'heartbeat').lagMs, 350);
    f.advance(400); assert.equal(f.api.snapshot().reason, 'timeout');
    assert.equal(f.timers.size + f.listeners.size, 0);
});

test('raw capture requires one live source, never mixes sources, preserves whole UTF8 chunks', () => {
    const f = fixture(), a = {}, b = {}; f.owners.set('a', a); f.owners.set('b', b);
    assert.throws(() => f.api.start({ raw: { tabId: 'missing' } }), /live/);
    f.api.start({ raw: { tabId: 'a', maxBytes: 4 } });
    for (const [id, owner, data] of [['b', b, 'other-secret'], ['a', a, '汉'], ['a', a, 'ab']]) {
        const token = f.api.receive(id, data); f.api.routed(token, owner, data);
    }
    assert.equal(f.api.snapshot().raw.chunks, undefined);
    const raw = f.api.snapshot({ includeRaw: true }).raw;
    assert.equal(raw.bytes, 3); assert.equal(raw.active, false);
    assert.deepEqual(raw.chunks.map(c => c.data), ['汉']);
});

test('raw resets and owner replacement invalidate capture; callbacks identify stale epoch', () => {
    const f = fixture(), a = {}; f.owners.set('a', a);
    f.api.start({ raw: { tabId: 'a' } });
    const token = f.api.receive('a', 'before'); f.api.routed(token, a, 'before');
    f.api.reset(a); f.api.parsed(token);
    f.api.routed(f.api.receive('a', 'after'), a, 'after');
    assert.equal(f.api.snapshot().raw.reason, 'session-reset');
    assert.equal(f.api.snapshot().records.find(r => r.type === 'parsed').stale, true);
    assert.deepEqual(f.api.snapshot({ includeRaw: true }).raw.chunks.map(c => c.data), ['before']);
    f.api.start({ raw: { tabId: 'a' } }); f.owners.set('a', {});
    f.api.routed(f.api.receive('a', 'new'), f.owners.get('a'), 'new');
    assert.equal(f.api.snapshot().raw.reason, 'source-changed');
});

test('raw timeout is shorter than metadata; stopped run callbacks cannot enter next run', () => {
    const f = fixture(), a = {}; f.owners.set('a', a);
    f.api.start({ raw: { tabId: 'a', durationMs: 100 } });
    const old = f.api.receive('a', 'old'); f.api.routed(old, a, 'old');
    f.advance(100); assert.equal(f.api.snapshot().raw.reason, 'timeout');
    assert.equal(f.api.enabled, true);
    f.api.start(); f.api.parsed(old); assert.equal(f.api.snapshot().records.length, 1);
    f.api.clear(); assert.equal(f.api.snapshot().raw, undefined);
});

test('real IPC callbacks bind captured caret adapter and session epoch', () => {
    const source = fs.readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
    const callbacks = new Map(), parsed = [], writes = [];
    const port = { enqueued: n => parsed.push(['enqueued', n]), parsed: n => parsed.push(['parsed', n]), invalidate() {} };
    const owner = { id: 't', tabId: 'backend', type: 'ssh', _smoothCursor: { _adapter: { softwareCaretPort: port } }, term: { write(data, done) { writes.push({ data, done }); } } };
    const ctx = { ipcRenderer: { on: (n, f) => callbacks.set(n, f) }, TabManager: { tabs: [owner] }, window: {}, ptyBuffers: {}, applyHighlight: s => s,
        createInkCaretObserver: () => ({ push: () => ({ chunkSeq: 1 }) }) };
    vm.createContext(ctx); vm.runInContext(source, ctx);
    callbacks.get('pty-output')({}, { tabId: 'backend', data: 'hello' });
    assert.deepEqual(parsed, [['enqueued', 1]]);
    owner._smoothCursor._adapter = { softwareCaretPort: { parsed: () => assert.fail('replacement adapter received old callback') } };
    writes[0].done(); assert.equal(parsed.length, 1);
    owner._smoothCursor._adapter = { softwareCaretPort: port };
    callbacks.get('pty-output')({}, { tabId: 'backend', data: 'world' });
    vm.runInContext('_resetCaretState(TabManager.tabs[0])', ctx);
    writes[1].done(); assert.equal(parsed.filter(p => p[0] === 'parsed').length, 0);
});

test('real IPC preserves queued completion for empty filtered output', () => {
    const source = fs.readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
    const callbacks = new Map(), actions = [], writes = [];
    const port = { enqueued: n => actions.push(['enqueued', n]), parsed: n => actions.push(['parsed', n]) };
    const owner = { id: 't', tabId: 'backend', type: 'local', _smoothCursor: { _adapter: { softwareCaretPort: port } }, term: { write(data, done) { writes.push({ data, done }); } } };
    const ctx = { ipcRenderer: { on: (n, f) => callbacks.set(n, f) }, TabManager: { tabs: [owner] }, window: {}, ptyBuffers: {}, applyHighlight: s => s,
        createConPtyCaretFilter: () => ({ push: () => '' }),
        createInkCaretObserver: () => ({ push: () => ({ chunkSeq: 3 }) }) };
    vm.createContext(ctx); vm.runInContext(source, ctx);
    callbacks.get('pty-output')({}, { tabId: 'backend', data: 'buffered-by-filter' });
    assert.equal(writes[0].data, ''); assert.deepEqual(actions, [['enqueued', 3]]);
    writes[0].done(); assert.deepEqual(actions, [['enqueued', 3], ['parsed', 3]]);
});

test('real IPC send adds only correlation ID when armed, never mutates caller input', () => {
    const source = fs.readFileSync(new URL('../src/ipc-polyfill.js', import.meta.url), 'utf8');
    const calls = [], recorded = [];
    const diagnostics = { enabled: false, inputSent: (id, data) => { recorded.push([id, data.length]); return 42; } };
    const window = { ZTermDiagnostics: diagnostics, __TAURI__: { core: { invoke(cmd, args) { calls.push({ cmd, args }); return Promise.resolve(); } } } };
    const ctx = { window, console: { log() {}, error() {} } };
    vm.createContext(ctx); vm.runInContext(source, ctx);
    const input = { tabId: 'a', data: 'private input' };
    window.electron.ipcRenderer.send('pty-input', input);
    assert.equal(recorded.length, 0); assert.equal(calls[0].args.args[0], input);
    diagnostics.enabled = true;
    window.electron.ipcRenderer.send('pty-input', input);
    assert.equal(calls[1].args.args[0].diagnosticInputId, 42);
    assert.equal(calls[1].args.args[0].data, input.data);
    assert.equal(input.diagnosticInputId, undefined);
    assert.deepEqual(recorded, [['a', 13]]);
});
