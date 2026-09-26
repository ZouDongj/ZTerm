// ZTerm - pending pane claim across a split collapse (ADR-0004 item 6).
// Red case against the REAL ipc.js source in a vm: a local split is created
// and the ORIGINAL pane is closed before the new pane's pty-created arrives;
// the pending pane collapses onto its tab carrying only its requestId. The
// old tab branch (`tab.id === requestId`) never matched the pane's request,
// so the handler fell through to the orphan path and DESTROYED the fresh
// backend while the surviving tab sat without a terminal. The claim must now
// also match `tab._ptyRequestId` (local pty) and the same marker on the SSH
// lifecycle events (ssh-connecting / ssh-connected / ssh-error).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');

// TabManager stub whose single tab models the POST-COLLAPSE state: the split
// tree is gone, the surviving pane's fields live on the tab, its backend is
// still pending (_ptyRequestId set, tabId null).
function fixture(over = {}) {
    const callbacks = new Map(), sent = [], wireCalls = [];
    const tab = {
        id: 't_1', type: 'local', splitRoot: null, tabId: null,
        _ptyRequestId: 'p_9', term: null,
        ...over,
    };
    const ctx = {
        ipcRenderer: {
            on: (n, f) => callbacks.set(n, f),
            send: (channel, payload) => sent.push({ channel, payload }),
        },
        TabManager: { tabs: [tab], render() {}, updateStatus() {}, _consumeClosed: () => false },
        window: {},
        ptyBuffers: {},
        applyHighlight: s => s,
        createInkCaretObserver: () => ({ push: () => ({ chunkSeq: 1 }) }),
        // Mirrors the real wireTerminal's first line (tab.tabId = tabId) plus
        // the term the later handlers write into; _scheduleSettleResize lives
        // in terminal.js and is inert for these claims.
        wireTerminal: (t, backendId) => { wireCalls.push({ tab: t, backendId }); t.tabId = backendId; t.term = { write() {} }; },
        showToast: () => {},
        _scheduleSettleResize: () => {},
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(ipcSource, ctx);
    return { callbacks, sent, tab, wireCalls, ctx };
}

test('pty-created claims the collapsed pending pane instead of orphan-destroying', () => {
    const f = fixture();
    f.callbacks.get('pty-created')({}, { tabId: 'local_1', requestId: 'p_9' });
    assert.equal(f.tab.tabId, 'local_1', 'backend id must land on the surviving tab');
    assert.equal(f.tab._ptyRequestId, undefined, 'marker consumed by the claim');
    const destroys = f.sent.filter(s => s.channel === 'pty-destroy');
    assert.equal(destroys.length, 0, 'the fresh backend must NOT be orphan-destroyed');
    assert.ok(f.wireCalls.some(c => c.tab === f.tab && c.backendId === 'local_1'), 'terminal wired for the claimed backend');
});

test('pty-created still destroys a truly orphaned backend (explicit close)', () => {
    // Closing the pending session invalidates the request: the tab is gone,
    // so nothing claims the event and the backend must be destroyed
    const f = fixture();
    f.ctx.TabManager.tabs.length = 0;
    f.callbacks.get('pty-created')({}, { tabId: 'local_2', requestId: 'p_9' });
    const destroys = f.sent.filter(s => s.channel === 'pty-destroy');
    assert.equal(destroys.length, 1);
    assert.equal(destroys[0].payload.tabId, 'local_2');
});

test('ssh-connecting claims the collapsed pending pane via rendererId', () => {
    const f = fixture({ type: 'ssh' });
    f.callbacks.get('ssh-connecting')({}, { tabId: 'ssh_7', rendererId: 'p_9' });
    assert.equal(f.tab.tabId, 'ssh_7', 'connecting phase must adopt the backend id');
    assert.equal(f.tab._ptyRequestId, undefined, 'marker consumed at the claim');
    assert.ok(f.wireCalls.some(c => c.tab === f.tab && c.backendId === 'ssh_7'), 'wireTerminal path invoked for the tab');
});

test('ssh-error reaches the collapsed pending pane (no misdirected toast-only path)', () => {
    const f = fixture({ type: 'ssh' });
    f.callbacks.get('ssh-error')({}, { tabId: 'ssh_8', rendererId: 'p_9', error: 'auth failed' });
    assert.equal(f.tab.tabId, 'ssh_8', 'error path records the backend id');
    assert.equal(f.tab.connected, false);
    assert.ok(f.wireCalls.some(c => c.tab === f.tab), 'error terminal still wired for the pane');
});

test('ssh-connected marks the collapsed pending pane as connected', () => {
    const f = fixture({ type: 'ssh' });
    f.callbacks.get('ssh-connected')({}, { tabId: 'ssh_9', rendererId: 'p_9' });
    assert.equal(f.tab.connected, true);
    assert.ok(f.wireCalls.some(c => c.tab === f.tab && c.backendId === 'ssh_9'));
});
