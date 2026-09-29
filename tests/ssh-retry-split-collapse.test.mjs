// SSH handshake auto-retry vs a split collapse inside the backoff window.
// Driven through the REAL ipc.js ssh-error handler, the REAL tabs.js
// _closePane/_exitSplit collapse and the REAL _sshConnectChain queue in the
// shared renderer VM (tests/helpers/renderer-vm.mjs); timers are queued and
// fired by advancing the virtual clock, and ssh-connect invocations are
// recorded through a never-settling invoke bridge.
//
// Old-code failure note (first test): the retry's pane-liveness guard only
// accepted the pane still sitting in the tab's split tree. A collapse during
// the backoff adopts the failed pane back into the tab (_exitSplit:
// tab.term = pane.term, splitRoot = null), so the guard went false and the
// scheduled retry died silently — the "retrying in Ns" line was a dead letter
// and the spent retry budget was never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredSplitTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));

// Recording, never-settling invoke bridge: every ssh-connect invocation is
// observable and stays in flight (its queue slot never auto-releases).
function patchInvoke(ctx) {
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        const rec = { cmd, payload };
        rec.promise = new Promise(() => {});
        invokes.push(rec);
        return rec.promise;
    };
    return invokes;
}
const connects = (invokes) => invokes.filter(i => i.cmd === 'ssh-connect');

// Split SSH tab whose SECOND pane is the session that fails. The pane carries
// its own SSH identity fields (as a pane split from an SSH session does);
// _exitSplit adopts exactly these onto the tab when the split collapses.
function sshSplitTab(ctx) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_rt', 'ssh_A', null, 'ssh_B', null,
        { type: 'ssh', connected: true, host: 'h1', user: 'u1' });
    p2.type = 'ssh';
    p2._sshHost = 'h2';
    p2._sshPort = 2222;
    p2._sshUser = 'u2';
    ctx.__tq.advance(2000); // drain setup timers (wiring fits/focuses)
    return { tab, p1, p2 };
}

// A retryable handshake failure on p2's backend, through the REAL handler.
function failP2(ctx, tab, p2) {
    ctx.__emit('ssh-error', { tabId: 'ssh_B', rendererId: p2.requestId, error: 'os error 10061 connection refused' });
    assert.equal(p2.tabId, null, 'retry branch dropped the dead backend id');
    assert.equal(tab._sshRetried, 1, 'retry budget spent');
}

test('split collapse inside the backoff still retries — against the adopted tab', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p1, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);
    assert.equal(connects(invokes).length, 0, 'retry only scheduled, not fired');

    // The sibling closes inside the backoff window: the real close path
    // collapses the split and adopts the FAILED pane back onto the tab.
    ctx.TabManager._closePane(tab.id, p1.id);
    ctx.__tq.advance(1000); // exit animation + deferred collapse (retry still pending)
    assert.equal(tab.splitRoot, null, 'collapsed to a single tab');
    assert.ok(tab.term === p2.term && !p2.term.disposed, 'the failed pane\'s terminal was adopted');
    assert.equal(tab.host, 'h2', 'session identity adopted from the failed pane');

    ctx.__tq.advance(1500); // the 2s backoff elapses
    await flush();
    const cs = connects(invokes);
    assert.equal(cs.length, 1, 'the scheduled retry fired after the collapse');
    assert.equal(cs[0].payload.profile.host, 'h2', 'the retried session is the failed pane\'s own');
    assert.equal(cs[0].payload.profile.username, 'u2');
    assert.equal(ctx.sshAttempts.ownerOf(cs[0].payload.attemptId), tab,
        'the new attempt is owned by the tab, not the dead pane wrapper');
});

test('closing the FAILED pane inside the backoff spawns no retry (dead pane stays dead)', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p1, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);

    ctx.TabManager._closePane(tab.id, p2.id); // the failed pane itself dies
    ctx.__tq.advance(1000); // collapse adopts the SIBLING
    assert.equal(tab.splitRoot, null);
    assert.ok(tab.term === p1.term, 'the healthy sibling was adopted instead');
    assert.equal(p2.term, null, 'the failed pane\'s terminal is gone');

    ctx.__tq.advance(2000); // well past the 2s backoff
    await flush();
    assert.equal(connects(invokes).length, 0, 'no backend is spawned for a dead pane');
});

test('an undisturbed pane retries with its own wrapper (existing path preserved)', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);

    ctx.__tq.advance(2500); // the 2s backoff elapses with the pane still in the tree
    await flush();
    const cs = connects(invokes);
    assert.equal(cs.length, 1, 'retry fired');
    assert.equal(cs[0].payload.profile.host, 'h2', 'pane session fields drive the retry');
    assert.equal(ctx.sshAttempts.ownerOf(cs[0].payload.attemptId), p2,
        'the new attempt is owned by the live pane wrapper');
});
