import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/settings.js', import.meta.url), 'utf8');
const functions = ['persistSettings', 'saveAppearance', 'saveTerminal', 'toggleUiFollowTerminal'].map(name => {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `production ${name} is present`);
    return match[0];
}).join('\n');

function fixture(implementation = () => Promise.resolve()) {
    const calls = [];
    const toasts = [];
    const errors = [];
    const inputs = new Map(Object.entries({
        'set-scrollback': '10000', 'set-line-height': '1.125',
        'set-font-size': '16', 'set-font-weight': '400',
        'set-font-weight-bold': '600', 'set-accent': '#61afef',
    }).map(([id, value]) => [id, { value }]));
    const invoke = (command, payload) => {
        calls.push({ command, payload });
        return implementation(command, payload);
    };
    const context = vm.createContext({
        console: { error: (...args) => errors.push(args) },
        _settingsConfig: { fontSize: 16, scrollback: 10000, accentColor: '#61afef' },
        TabManager: { tabs: [], profiles: [], render() {} },
        document: { getElementById: id => inputs.get(id) || null, querySelector: () => null },
        ipcRenderer: {
            invoke,
            // Match the fire-and-forget polyfill so the regression can expose
            // backend failures that only reach the console in the old path.
            send: (command, payload) => { invoke(command, payload).catch(error => errors.push(error)); },
        },
        showToast: (message, isError) => toasts.push({ message, isError }),
        getToggle: () => true,
        getAllPanes: () => [],
        _normalizeWordSeparators: value => value || '',
        _fontSelectValue: (_id, fallback) => fallback || '',
        _clampFontWeight: (value, fallback) => Number(value || fallback),
        _normalizeFontFamily: value => value,
        updateAccentDot() {}, applyUiFont() {}, _updateNfMonoHint() {},
        applyTerminalScheme() {}, syncUiFollowUI() {},
    });
    vm.runInContext(functions, context);
    return { context, calls, toasts, errors };
}

test('settings save failure is visible even when the UI event ignores its promise', async () => {
    const f = fixture(() => Promise.reject(new Error('synthetic primary write failure')));
    f.context.saveAppearance();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.toasts.length, 1, 'the user must see the persistence failure');
    assert.equal(f.toasts[0].isError, true);
    assert.match(f.toasts[0].message, /保存失败/);
    assert.match(f.toasts[0].message, /synthetic primary write failure/);
    assert.deepEqual(f.calls.map(call => call.command), ['save-appearance']);
});

test('terminal-settings failure stays distinct from a successful appearance save', async () => {
    const f = fixture(command => command === 'save-terminal-settings'
        ? Promise.reject(new Error('synthetic terminal write failure')) : Promise.resolve());
    const saving = f.context.saveTerminal();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].message, /synthetic terminal write failure/);
    assert.ok(saving && typeof saving.then === 'function');
    await assert.rejects(saving, /synthetic terminal write failure/);
});

test('settings writes are sequential and use the same captured snapshot', async () => {
    let release;
    const firstWrite = new Promise(resolve => { release = resolve; });
    const f = fixture(command => command === 'save-appearance' ? firstWrite : Promise.resolve());
    const saving = f.context.persistSettings();
    assert.deepEqual(f.calls.map(call => call.command), ['save-appearance']);
    f.context._settingsConfig.scrollback = 999;
    release();
    await saving;
    assert.deepEqual(f.calls.map(call => call.command), ['save-appearance', 'save-terminal-settings']);
    assert.equal(f.calls[1].payload.scrollback, 10000);
    assert.deepEqual(f.toasts, []);
});

test('UI-font toggle returns the persistence result to explicit callers', async () => {
    const f = fixture(() => Promise.reject(new Error('synthetic toggle write failure')));
    const saving = f.context.toggleUiFollowTerminal();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(saving && typeof saving.then === 'function');
    await assert.rejects(saving, /synthetic toggle write failure/);
    assert.equal(f.toasts.length, 1);
});

test('overlapping snapshots cannot let an older terminal save overwrite the latest value', async () => {
    let releaseA;
    let releaseB;
    const replyA = new Promise(resolve => { releaseA = resolve; });
    const replyB = new Promise(resolve => { releaseB = resolve; });
    const terminalWrites = [];
    const f = fixture((command, payload) => {
        if (command === 'save-appearance') return payload.fontSize === 16 ? replyA : replyB;
        terminalWrites.push(payload.scrollback);
        return Promise.resolve();
    });
    f.context._settingsConfig.hiddenProfiles = ['original'];
    const savingA = f.context.persistSettings();
    f.context._settingsConfig = { ...f.context._settingsConfig, fontSize: 18, scrollback: 20000, hiddenProfiles: ['latest'] };
    const savingB = f.context.persistSettings();
    f.context._settingsConfig.hiddenProfiles.push('after-capture');
    let bFinished = false;
    savingB.then(() => { bFinished = true; });
    releaseB();
    await new Promise(resolve => setImmediate(resolve));
    const bFinishedBeforeA = bFinished;
    releaseA();
    await Promise.all([savingA, savingB]);
    assert.deepEqual(terminalWrites, [10000, 20000], 'the most recent snapshot must remain authoritative');
    assert.equal(bFinishedBeforeA, false, 'the later save must wait for the entire older snapshot');
    assert.deepEqual(f.calls.map(call => call.command), [
        'save-appearance', 'save-terminal-settings', 'save-appearance', 'save-terminal-settings',
    ]);
    assert.deepEqual(f.calls.filter(call => call.command === 'save-terminal-settings')
        .map(call => Array.from(call.payload.hiddenProfiles)), [['original'], ['latest']]);
    assert.deepEqual(f.toasts, []);
});

test('a failed snapshot rejects only its caller and does not stall the next queued save', async () => {
    let rejectA;
    const replyA = new Promise((_resolve, reject) => { rejectA = reject; });
    const terminalWrites = [];
    const f = fixture((command, payload) => {
        if (command === 'save-appearance' && payload.fontSize === 16) return replyA;
        if (command === 'save-terminal-settings') terminalWrites.push(payload.scrollback);
        return Promise.resolve();
    });
    const savingA = f.context.persistSettings();
    const failedA = assert.rejects(savingA, /synthetic first snapshot failure/);
    f.context._settingsConfig = { ...f.context._settingsConfig, fontSize: 18, scrollback: 20000 };
    const savingB = f.context.persistSettings();
    await new Promise(resolve => setImmediate(resolve));
    const callsBeforeFailure = f.calls.map(call => call.command);
    rejectA(new Error('synthetic first snapshot failure'));
    await Promise.all([failedA, savingB]);
    assert.deepEqual(callsBeforeFailure, ['save-appearance']);
    assert.deepEqual(terminalWrites, [20000]);
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].message, /synthetic first snapshot failure/);
    f.context._settingsConfig.scrollback = 30000;
    await f.context.persistSettings();
    assert.deepEqual(terminalWrites, [20000, 30000]);
    assert.equal(f.toasts.length, 1, 'successful queued snapshots must not repeat the previous failure');
});
