import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
globalThis.self = globalThis;
const { ClipboardAddon } = require('../src/vendor/addon-clipboard.js');
const { appendContentTail, replayPayload, REPLAY_EPILOGUE } = require('../src/renderer/restore-content.js');
const renderer = name => readFileSync(new URL('../src/renderer/' + name, import.meta.url), 'utf8');
const write = (term, data) => new Promise(resolve => term.write(data, resolve));

function fixture({ enabled = true, read } = {}) {
    const ctx = loadVm();
    ctx.ClipboardAddon = ClipboardAddon;
    ctx.window.__TAURI__ = { event: {} };
    ctx._settingsConfig.osc52 = enabled;
    const calls = [];
    ctx.ipcRenderer.invoke = (command, args) => {
        // Settings persistence is a separate IPC effect; this recorder checks
        // terminal clipboard access while the real settings handler runs.
        if (command === 'save-appearance' || command === 'save-terminal-settings') return Promise.resolve();
        calls.push({ command, args });
        return command === 'clipboard-read-text'
            ? (read ? read() : Promise.resolve('SYNTHETIC_CLIPBOARD'))
            : Promise.resolve();
    };
    vm.runInContext(renderer('settings.js'), ctx);
    vm.runInContext(renderer('restore-content.js'), ctx);
    const term = new globalThis.TabbyXterm.Terminal({ cols: 100, rows: 5, allowProposedApi: true });
    const tab = { id: 'test', type: 'local', tabId: 'local_fixture', term };
    ctx.TabManager.tabs.push(tab);
    term.onData(data => ctx._sendInputForTerm(term, data));
    const addon = ctx._createClipboardAddon();
    term.loadAddon(addon);
    const setPermission = on => {
        ctx.getToggle = name => name === 'toggle-osc52' && on;
        ctx.saveTerminal();
    };
    return { ctx, term, tab, addon, calls, setPermission, inputs: () => ctx.__sends.filter(x => x.cmd === 'pty-input') };
}

test('existing terminal rejects OSC 52 read and write after settings revoke permission', async () => {
    const f = fixture();
    try {
        f.setPermission(false);
        await write(f.term, '\x1b]52;c;?\x07\x1b]52;c;V1JJVEU=\x07');
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.inputs(), []);
    } finally { f.term.dispose(); }
});

test('a terminal created with OSC 52 disabled supports later enable without duplicate handling', async () => {
    const f = fixture({ enabled: false });
    try {
        await write(f.term, '\x1b]52;c;?\x07');
        assert.deepEqual(f.calls, []);
        for (let i = 0; i < 3; i++) { f.setPermission(true); f.setPermission(false); }
        f.setPermission(true);
        await write(f.term, '\x1b]52;c;?\x07\x1b]52;c;V1JJVEU=\x07');
        assert.deepEqual(f.calls.map(x => x.command), ['clipboard-read-text', 'clipboard-write-text']);
        assert.equal(f.inputs().length, 1);
        assert.match(f.inputs()[0].payload.data, /U1lOVEhFVElDX0NMSVBCT0FSRA==/);
    } finally { f.term.dispose(); }
});

for (const transition of ['disable', 'disable-enable', 'reconnect', 'close', 'failed']) {
    test(`pending OSC 52 read cannot reply after ${transition}`, async () => {
        let finishRead;
        let startRead;
        const started = new Promise(resolve => { startRead = resolve; });
        const f = fixture({ read: () => { startRead(); return new Promise(resolve => { finishRead = resolve; }); } });
        try {
            const parsed = write(f.term, '\x1b]52;c;?\x07');
            await started;
            if (transition.startsWith('disable')) f.setPermission(false);
            if (transition === 'disable-enable') f.setPermission(true);
            if (transition === 'reconnect') f.tab.tabId = 'local_replacement';
            if (transition === 'close') f.ctx.TabManager._closingTabs.add(f.tab.id);
            if (transition === 'failed') f.tab._sessionFailed = true;
            finishRead('SYNTHETIC_LATE_SECRET');
            await parsed;
            assert.equal(f.calls.length, 1);
            assert.deepEqual(f.inputs(), []);
        } finally { f.term.dispose(); }
    });
}

test('pending clipboard response follows a same-session owner migration', async () => {
    let finishRead;
    let startRead;
    const started = new Promise(resolve => { startRead = resolve; });
    const f = fixture({ read: () => { startRead(); return new Promise(resolve => { finishRead = resolve; }); } });
    try {
        const parsed = write(f.term, '\x1b]52;c;?\x07');
        await started;
        const replacementOwner = { ...f.tab, id: 'moved' };
        f.ctx.TabManager.tabs = [replacementOwner];
        finishRead('SYNTHETIC_MOVED');
        await parsed;
        assert.equal(f.inputs().length, 1);
        assert.equal(f.inputs()[0].payload.tabId, 'local_fixture');
    } finally { f.term.dispose(); }
});

test('disposed addon suppresses an already-started clipboard response and releases the parser', async () => {
    let finishRead;
    let startRead;
    const started = new Promise(resolve => { startRead = resolve; });
    const f = fixture({ read: () => { startRead(); return new Promise(resolve => { finishRead = resolve; }); } });
    try {
        const parsed = write(f.term, '\x1b]52;c;?\x07after');
        await started;
        // Dispose just the addon while preserving the parser completion oracle.
        // Terminal disposal invokes the same addon lifecycle hook.
        f.addon.dispose();
        finishRead('SYNTHETIC_DISPOSED');
        await parsed;
        assert.deepEqual(f.inputs(), []);
        assert.equal(f.term.buffer.active.getLine(0).translateToString(true), 'after');
    } finally { f.term.dispose(); }
});

test('restored output is display-only even with clipboard, title, bell and query handlers installed', async () => {
    const f = fixture();
    const titles = [], bells = [], metadata = [];
    f.term.onTitleChange(title => titles.push(title));
    f.term.onBell(() => bells.push(true));
    f.term.parser.registerOscHandler(1337, payload => { metadata.push(payload); return true; });
    const controls = '\x1b]52;c;?\x07\x1b]52;c;V1JJVEU=\x1b\\'
        + '\x1b]2;old title\x07\x1b]1337;ZTermTabName=old\x1b\\\x07'
        + '\x1b[5n\x1b[6n\x1b[c\x1b[>c\x1b[?25$p\x1b[18t'
        + '\x1bP$qm\x1b\\\x1b]10;?\x07';
    try {
        let saved = '';
        for (const chunk of ['old\r\n\x1b[31m', controls.slice(0, 10), controls.slice(10), 'red\x1b[0m']) {
            saved = appendContentTail(saved, chunk);
        }
        const replay = replayPayload(saved);
        // Exercise asynchronous parser boundaries within the sanitized stream.
        for (let i = 0; i < replay.length; i += 3) await write(f.term, replay.slice(i, i + 3));
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.inputs(), []);
        assert.deepEqual(titles, []);
        assert.deepEqual(bells, []);
        assert.deepEqual(metadata, []);
        assert.equal(f.term.buffer.active.getLine(0).translateToString(true), 'old');
        assert.equal(f.term.buffer.active.getLine(1).translateToString(true), 'red');
        assert.equal(f.term.buffer.active.getLine(1).getCell(0).getFgColor(), 1);
        // A subsequent live request remains enabled and is answered normally.
        await write(f.term, '\x1b]52;c;?\x07');
        assert.equal(f.calls.length, 1);
        assert.equal(f.inputs().length, 1);
    } finally { f.term.dispose(); }
});

test('display replay preserves CUP positioning and ordinary shell home/clear-screen output', async () => {
    const render = async data => {
        const term = new globalThis.TabbyXterm.Terminal({ cols: 40, rows: 5, allowProposedApi: true });
        try {
            await write(term, data);
            const buffer = term.buffer.active;
            return {
                lines: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)),
                cursorX: buffer.cursorX,
                cursorY: buffer.cursorY,
            };
        } finally { term.dispose(); }
    };
    for (const source of [
        'old\r\nline2\x1b[1;1Hnew',
        'old\r\nline2\x1b[2J\x1b[H$ ',
        'old\r\nline2\x1b[H\x1b[2J$ ',
        'banner\r\nsecond\x1b[3;5Hvalue',
    ]) {
        assert.deepEqual(await render(replayPayload(source)), await render(source + REPLAY_EPILOGUE), JSON.stringify(source));
    }
});

test('terminal wiring renders history before buffered live output and preserves live user input', async () => {
    const ctx = loadVm();
    vm.runInContext(renderer('restore-content.js'), ctx);
    ctx.FitAddon = class { activate() {} dispose() {} fit() {} };
    ctx.ClipboardAddon = ClipboardAddon;
    ctx._createWebLinksAddon = () => ({ activate() {}, dispose() {} });
    const term = new globalThis.TabbyXterm.Terminal({ cols: 100, rows: 5, allowProposedApi: true });
    // DOM is synthetic; terminal parsing and its async write queue are bundled xterm.
    Object.defineProperty(term, 'element', { value: ctx.document.createElement('div') });
    term.open = () => {};
    ctx.Terminal = class { constructor() { return term; } };
    const tab = { id: 'restore', type: 'local', _contentBuffer: 'history' };
    ctx.TabManager.tabs.push(tab);
    ctx._settingsConfig.restoreLocalContent = true;
    ctx.ptyBuffers.local_fixture = 'live';
    try {
        ctx.wireTerminal(tab, 'local_fixture');
        term.input('typed', true);
        await write(term, '');
        assert.equal(term.buffer.active.getLine(0).translateToString(true), 'history');
        assert.equal(term.buffer.active.getLine(1).translateToString(true), 'live');
        assert.deepEqual(ctx.__sends.filter(x => x.cmd === 'pty-input').map(x => x.payload.data), ['typed']);
    } finally { term.dispose(); }
});

for (const split of [false, true]) {
    test(`${split ? 'pane' : 'tab'} wiring installs one handler while OSC 52 is disabled`, async () => {
        const ctx = loadVm();
        ctx._settingsConfig.osc52 = false;
        ctx.window.__TAURI__ = { event: {} };
        vm.runInContext(renderer('settings.js'), ctx);
        ctx.FitAddon = class { activate() {} dispose() {} fit() {} };
        let installs = 0;
        ctx.ClipboardAddon = class extends ClipboardAddon {
            activate(term) { installs++; super.activate(term); }
        };
        ctx._createWebLinksAddon = () => ({ activate() {}, dispose() {} });
        const calls = [];
        ctx.ipcRenderer.invoke = command => {
            if (command !== 'clipboard-read-text') return Promise.resolve([]);
            calls.push(command);
            return Promise.resolve('SYNTHETIC_ENABLED');
        };
        const term = new globalThis.TabbyXterm.Terminal({ allowProposedApi: true });
        Object.defineProperty(term, 'element', { value: ctx.document.createElement('div') });
        term.open = () => {};
        ctx.Terminal = class { constructor() { return term; } };
        const tab = { id: 'wired', type: 'local' };
        ctx.TabManager.tabs.push(tab);
        try {
            if (split) {
                const pane = { id: 'pane', tabId: 'local_fixture', type: 'local' };
                tab.splitRoot = pane;
                const body = ctx.document.createElement('div');
                body.id = 'pane-body_pane';
                ctx.__mainArea.appendChild(body);
                ctx.wireTerminalToPane(tab, pane);
            } else ctx.wireTerminal(tab, 'local_fixture');
            await write(term, '\x1b]52;c;?\x07');
            assert.deepEqual(calls, []);
            ctx.getToggle = name => name === 'toggle-osc52';
            ctx.saveTerminal();
            ctx.saveTerminal();
            await write(term, '\x1b]52;c;?\x07');
            assert.deepEqual(calls, ['clipboard-read-text']);
            assert.equal(installs, 1);
            assert.equal(ctx.__sends.filter(x => x.cmd === 'pty-input').length, 1);
        } finally { term.dispose(); }
    });
}
