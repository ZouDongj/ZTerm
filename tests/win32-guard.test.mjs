// Guard-chain tests for win32-input-mode Ctrl+J: the only
// things standing between an SSH pane and win32 INPUT_RECORD bytes are
//   (a) the session gate is marked exclusively through the LOCAL-only caret
//       filter wiring in ipc.js (keyed by backend session id, so it survives
//       split/drag migration of the terminal between wrappers), and
//   (b) _tryWin32CtrlJ's event-time owner resolution + sync-input broadcast
//       guard in terminal.js.
// Both are pinned here against the REAL ipc.js and terminal.js sources in a
// vm context (same pattern as da1-handshake.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const conptySource = readFileSync(new URL('../src/renderer/conpty-caret.js', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
const terminalSource = readFileSync(new URL('../src/renderer/terminal.js', import.meta.url), 'utf8');
const win32Source = readFileSync(new URL('../src/renderer/win32-input.js', import.meta.url), 'utf8');
const INIT_BURST = '\u001b[1t\u001b[c\u001b[?1004h\u001b[?9001h';
const W32_CTRLJ = '\u001b[74;36;10;1;8;1_\u001b[74;36;10;0;8;1_';
const termSink = (out) => ({ write: (data) => out.push(data) });

function ipcFixture(tabs, extraGlobals = {}) {
    const callbacks = new Map(), sent = [];
    const ctx = {
        ipcRenderer: {
            on: (n, f) => callbacks.set(n, f),
            send: (channel, payload) => sent.push({ channel, payload }),
        },
        TabManager: { tabs },
        window: {},
        ptyBuffers: {},
        applyHighlight: s => s,
        createInkCaretObserver: () => ({ push: () => ({ chunkSeq: 1 }) }),
        console,
        ...extraGlobals,
    };
    vm.createContext(ctx);
    vm.runInContext(win32Source, ctx); // globalThis.__win32Input for the ipc wiring
    vm.runInContext(conptySource, ctx);
    vm.runInContext(ipcSource, ctx);
    return { callbacks, sent, ctx };
}

test('ipc wiring: local ConPTY init burst flags the owner for win32 input', () => {
    const owner = { id: 't', tabId: 'local_0', type: 'local', term: termSink([]) };
    const f = ipcFixture([owner]);
    assert.equal(owner._win32InputMode, undefined, 'flag starts unset');
    assert.equal(f.ctx.__win32Input.isGated('local_0'), false, 'gate starts unmarked');
    f.callbacks.get('pty-output')({}, { tabId: 'local_0', data: INIT_BURST });
    assert.equal(owner._win32InputMode, true, 'conhost request flags the owner');
    assert.equal(f.ctx.__win32Input.isGated('local_0'), true, 'conhost request gates the session id');
});

test('ipc wiring: SSH streams never get the win32 flag (bytes pass raw)', () => {
    const written = [];
    const owner = { id: 't', tabId: 'ssh_1', type: 'ssh', term: termSink(written) };
    const f = ipcFixture([owner]);
    f.callbacks.get('pty-output')({}, { tabId: 'ssh_1', data: INIT_BURST });
    assert.equal(owner._win32InputMode, undefined, 'SSH owner must never be flagged');
    assert.equal(f.ctx.__win32Input.isGated('ssh_1'), false, 'SSH session id must never be gated');
    assert.equal(written.join(''), INIT_BURST, 'SSH stream untouched');
});

// _tryWin32CtrlJ exercised against the real terminal.js. Only function
// declarations run at load; the call needs window.__win32Input, TabManager,
// getAllPanes, and ipcRenderer (via _sendPaneInput) stubbed into the context.
// Tabs expose their panes through `_panes` (read by the default getAllPanes).
function terminalFixture(tabs, extraGlobals = {}) {
    const sent = [];
    const ctx = {
        window: {},
        TabManager: { tabs },
        ipcRenderer: { send: (channel, payload) => sent.push({ channel, payload }) },
        getAllPanes: (t) => t._panes || [],
        console,
        ...extraGlobals,
    };
    vm.createContext(ctx);
    vm.runInContext(win32Source, ctx); // sets window.__win32Input via globalThis
    ctx.window.__win32Input = ctx.__win32Input; // module attaches to globalThis
    vm.runInContext(terminalSource, ctx);
    return { ctx, sent };
}

const ctrlJ = { type: 'keydown', ctrlKey: true, key: 'j', keyCode: 74 };
const splitTab = (over = {}) => ({ id: 't', type: 'local', splitRoot: {}, _panes: [], ...over });

test('hook: gated local pane sends exactly the win32 Ctrl+J bytes', () => {
    const term = {};
    const pane = { tabId: 'local_1', term };
    const tab = splitTab({ _panes: [pane] });
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    const handled = ctx._tryWin32CtrlJ(term, { ...ctrlJ });
    assert.equal(handled, true);
    const inputs = sent.filter(s => s.channel === 'pty-input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].payload.tabId, 'local_1');
    assert.equal(inputs[0].payload.data, W32_CTRLJ);
});

test('hook: plain (non-split) local tab resolves to itself', () => {
    const term = {};
    const tab = { id: 't', type: 'local', tabId: 'local_1', term };
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ }), true);
    const inputs = sent.filter(s => s.channel === 'pty-input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].payload.tabId, 'local_1');
});

test('hook: sync-input broadcast with an ungated (SSH) pane falls back to legacy', () => {
    const local = { tabId: 'local_1', term: {} };
    const ssh = { tabId: 'ssh_2', term: {} }; // never gated
    const tab = splitTab({ syncInput: true, _panes: [local, ssh] });
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    const handled = ctx._tryWin32CtrlJ(local.term, { ...ctrlJ });
    assert.equal(handled, false, 'must let xterm emit the legacy byte instead');
    assert.equal(sent.filter(s => s.channel === 'pty-input').length, 0,
        'no win32 bytes may leak toward an SSH pane');
});

test('hook: sync-input with every pane gated broadcasts the sequence to all', () => {
    const p1 = { tabId: 'local_1', term: {} };
    const p2 = { tabId: 'local_2', term: {} };
    const tab = splitTab({ syncInput: true, _panes: [p1, p2] });
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    ctx.__win32Input.markGated('local_2');
    const handled = ctx._tryWin32CtrlJ(p1.term, { ...ctrlJ });
    assert.equal(handled, true);
    const tabIds = sent.filter(s => s.channel === 'pty-input').map(s => s.payload.tabId).sort();
    assert.deepEqual(tabIds, ['local_1', 'local_2']);
});

test('hook: ungated local pane (handshake not yet seen) keeps the legacy path', () => {
    const term = {};
    const pane = { tabId: 'local_1', term }; // session id never marked
    const tab = splitTab({ _panes: [pane] });
    const { ctx, sent } = terminalFixture([tab]);
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ }), false);
    assert.equal(sent.length, 0);
});

test('hook: keyup is swallowed without a resend; other ctrl keys pass through', () => {
    const term = {};
    const pane = { tabId: 'local_1', term };
    const tab = splitTab({ _panes: [pane] });
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ, type: 'keyup' }), true, 'keyup swallowed');
    assert.equal(sent.length, 0, 'no resend on keyup');
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ, key: 'k', keyCode: 75 }), false, 'Ctrl+K untouched');
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ, shiftKey: true, key: 'J' }), false, 'Ctrl+Shift+J untouched');
    assert.equal(sent.length, 0);
});

test('hook: handled Ctrl+J suppresses the browser default (WebView2 downloads accelerator)', () => {
    // A trusted unconsumed Ctrl+J bounces back to the browser process, which
    // opens the downloads flyout. Only preventDefault marks it
    // consumed; synthetic KeyboardEvents never exercise that path.
    const term = {};
    const pane = { tabId: 'local_1', term };
    const tab = splitTab({ _panes: [pane] });
    const { ctx } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    let prevented = 0;
    const ev = (type) => ({ ...ctrlJ, type, preventDefault: () => { prevented += 1; } });
    assert.equal(ctx._tryWin32CtrlJ(term, ev('keydown')), true);
    assert.equal(ctx._tryWin32CtrlJ(term, ev('keyup')), true);
    assert.equal(prevented, 2, 'keydown and keyup both suppress the default');
});

test('hook: fall-through paths leave the default action alone', () => {
    const local = { tabId: 'local_1', term: {} };
    const ssh = { tabId: 'ssh_2', term: {} };
    const tab = splitTab({ syncInput: true, _panes: [local, ssh] });
    const { ctx } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    let prevented = 0;
    const ev = { ...ctrlJ, preventDefault: () => { prevented += 1; } };
    assert.equal(ctx._tryWin32CtrlJ(local.term, ev), false, 'mixed broadcast falls back');
    assert.equal(prevented, 0, 'no preventDefault when we do not own the key');
});

// Regression: the key handler used to close over
// the (tab, pane) pair captured at wiring time. addPaneRelativeTo moves the
// terminal into a fresh pane and nulls tab.tabId — the stale closure then
// resolved owner=tab, sent nowhere, and still swallowed the key.
test('hook: split migration keeps Ctrl+J working (owner resolved at event time)', () => {
    const term = {};
    const tab = { id: 't', type: 'local', tabId: 'local_1', term };
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1'); // gated while the term sat on the tab
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ }), true, 'pre-split sanity');
    assert.equal(sent.filter(s => s.channel === 'pty-input').length, 1);
    // Simulate addPaneRelativeTo: the term moves into a pane; the tab wrapper
    // is cleared. The backend session id travels with the pane.
    const existing = { tabId: 'local_1', term };
    const newPane = { tabId: 'local_2', term: {} };
    tab.term = null;
    tab.tabId = null;
    tab.splitRoot = {};
    tab._panes = [existing, newPane];
    sent.length = 0;
    const handled = ctx._tryWin32CtrlJ(term, { ...ctrlJ });
    assert.equal(handled, true, 'key must stay handled after the move');
    const inputs = sent.filter(s => s.channel === 'pty-input');
    assert.equal(inputs.length, 1, 'exactly one send — nothing swallowed, nothing duplicated');
    assert.equal(inputs[0].payload.tabId, 'local_1', 'sent to the migrated session, not the nulled tab');
    assert.equal(inputs[0].payload.data, W32_CTRLJ);
});

// Same stale-closure class, cross-tab variant: _moveTerminalToTab rehomes a
// pane's terminal into another tab's split tree. Resolution must land on the
// NEW owning tab so sync-input broadcast targets the new tree.
test('hook: cross-tab drag resolves to the new owning tab', () => {
    const term = {};
    const source = splitTab({ id: 's' });
    const moved = { tabId: 'local_1', term };
    const target = splitTab({ id: 'd', syncInput: true, _panes: [moved, { tabId: 'local_2', term: {} }] });
    const { ctx, sent } = terminalFixture([source, target]);
    ctx.__win32Input.markGated('local_1');
    ctx.__win32Input.markGated('local_2');
    const handled = ctx._tryWin32CtrlJ(term, { ...ctrlJ });
    assert.equal(handled, true);
    const tabIds = sent.filter(s => s.channel === 'pty-input').map(s => s.payload.tabId).sort();
    assert.deepEqual(tabIds, ['local_1', 'local_2'], 'broadcast follows the target tab tree');
});

test('hook: terminal owned by no tab (mid-teardown) falls through to legacy', () => {
    const term = {};
    const tab = splitTab({ _panes: [{ tabId: 'local_1', term: {} }] });
    const { ctx, sent } = terminalFixture([tab]);
    ctx.__win32Input.markGated('local_1');
    assert.equal(ctx._tryWin32CtrlJ(term, { ...ctrlJ }), false, 'unowned term is not ours to swallow');
    assert.equal(sent.length, 0);
});
