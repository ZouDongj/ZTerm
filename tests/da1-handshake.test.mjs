// Integration guard for the ConPTY DA1 handshake reply path.
// OpenConsole blocks the shell's first output until a VT220-class DA1 reply
// arrives; the caret filter swallows the probe and ipc.js answers it. The
// filter's own units live in conpty-caret.test.mjs — this file exercises the
// REAL ipc.js wiring: correct channel, correct tabId, the exported constant
// as the single source of the reply string, and SSH isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { CONPTY_DA1_RESPONSE } = require('../src/renderer/conpty-caret.js');

const conptySource = readFileSync(new URL('../src/renderer/conpty-caret.js', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
const INIT_BURST = '\u001b[1t\u001b[c\u001b[?1004h\u001b[?9001h';
const termSink = (out) => ({ write: (data) => out.push(data) });

function fixture(tabs, extraGlobals = {}) {
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
    vm.runInContext(conptySource, ctx); // real filter: sets createConPtyCaretFilter + __conPtyCaretInternals
    vm.runInContext(ipcSource, ctx);
    return { callbacks, sent };
}

test('local PTY: first DA1 is answered once via pty-input and stripped from the stream', () => {
    const written = [];
    const owner = { id: 't', tabId: 'local_0', type: 'local', term: termSink(written) };
    const f = fixture([owner]);
    f.callbacks.get('pty-output')({}, { tabId: 'local_0', data: INIT_BURST });

    const replies = f.sent.filter(s => s.channel === 'pty-input');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].payload.tabId, 'local_0');
    assert.equal(replies[0].payload.data, CONPTY_DA1_RESPONSE, 'reply must be the exported constant');

    const out = written.join('');
    assert.ok(!out.includes('\u001b[c'), 'query must not reach xterm');
    assert.ok(out.includes('\u001b[1t') && out.includes('\u001b[?1004h'),
        'neighbouring init bytes pass through: ' + JSON.stringify(out));

    // A later DA1 probe (an app querying the terminal) reaches xterm and is
    // not answered by us a second time.
    f.callbacks.get('pty-output')({}, { tabId: 'local_0', data: '\u001b[c' });
    assert.equal(f.sent.filter(s => s.channel === 'pty-input').length, 1);
    assert.ok(written.join('').includes('\u001b[c'));
});

test('SSH stream: no filter, no reply, bytes pass through raw', () => {
    const written = [];
    const owner = { id: 't', tabId: 'ssh_1', type: 'ssh', term: termSink(written) };
    const f = fixture([owner]);
    f.callbacks.get('pty-output')({}, { tabId: 'ssh_1', data: INIT_BURST });
    assert.equal(f.sent.filter(s => s.channel === 'pty-input').length, 0);
    assert.equal(written.join(''), INIT_BURST);
});

test('split pane: the reply carries the pane tabId, not the parent tab', () => {
    const written = [];
    const pane = { id: 'p', tabId: 'local_3', type: 'local', term: termSink(written) };
    const tab = { id: 't', type: 'local', splitRoot: true, panes: [pane] };
    const f = fixture([tab], { getAllPanes: (t) => t.panes || [] });
    f.callbacks.get('pty-output')({}, { tabId: 'local_3', data: INIT_BURST });
    const replies = f.sent.filter(s => s.channel === 'pty-input');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].payload.tabId, 'local_3');
    assert.ok(!written.join('').includes('\u001b[c'));
});
