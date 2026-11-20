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
import { loadVm, wiredSplitTab, wiredTab } from './helpers/renderer-vm.mjs';

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
    assert.equal(p2._sshRetried, 1, 'retry budget spent by the failing pane');
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

test('whole-tab close initiated late in the backoff suppresses the retry', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);
    wiredTab(ctx, 't_by', 'local_9'); // bystander so the closing tab is not the last one

    // Close the tab at T=1900 of the 2s backoff: the staggered doRemove
    // (~200ms) lands AFTER the retry's fire time, so at T=2000 the tab is
    // still in the array — tree membership alone would let the retry fire
    // an orphan handshake for a tab already committed to close.
    ctx.__tq.advance(1900);
    ctx.TabManager.closeTab(tab.id);
    assert.ok(ctx.TabManager._closingTabs.has(tab.id), 'close committed');
    assert.ok(ctx.TabManager.tabs.includes(tab), 'still in the array during the fade');

    ctx.__tq.advance(500); // past the backoff fire, past the fade
    await flush();
    assert.equal(connects(invokes).length, 0, 'no orphan handshake for a closing tab');
    assert.ok(!ctx.TabManager.tabs.includes(tab), 'the close still completed');
});

test('pane close initiated late in the backoff suppresses the retry', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p1, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);

    // Same window at pane level: _closePane at T=1900 leaves the dying pane
    // in the tree (_closing set) until its doRemove fires past the backoff.
    ctx.__tq.advance(1900);
    ctx.TabManager._closePane(tab.id, p2.id);
    assert.ok(p2._closing, 'pane close committed');
    assert.ok(ctx.TabManager.tabs.some(t => t.id === tab.id && ctx.getAllPanes(t).some(p => p.id === p2.id)),
        'dying pane still in the tree at the retry fire time');

    ctx.__tq.advance(500); // past the backoff fire, past the fade
    await flush();
    assert.equal(connects(invokes).length, 0, 'no backend spawned for a dying pane');
    assert.ok(tab.term === p1.term, 'the collapse adopted the healthy sibling');
});
test('a sibling pane failure neither cancels nor spends the other pane retry', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const { tab, p1, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);
    const p2Token = p2._sshRetryToken;

    ctx.__emit('ssh-error', { tabId: 'ssh_A', rendererId: p1.requestId, error: 'os error 10061 connection refused' });
    assert.equal(p1._sshRetried, 1, 'the sibling spent its own budget');
    assert.equal(p2._sshRetried, 1, 'and did not spend the first pane budget');
    assert.equal(p2._sshRetryToken, p2Token, 'the first pane pending retry keeps its token');
    assert.equal(tab._sshRetried, undefined, 'a split keeps no tab-level budget');

    ctx.__tq.advance(2500);
    await flush();
    const cs = connects(invokes);
    assert.equal(cs.length, 1, 'the earlier retry fired (the second waits in the connect queue)');
    assert.equal(cs[0].payload.profile.host, 'h2', 'the first pane session retried; it was not superseded');
});

test('a sibling pane success does not re-arm the failing pane budget', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const { tab, p1, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2); // p2 spent one retry and dropped its backend id

    ctx.__emit('ssh-connected', { tabId: 'ssh_A', rendererId: p1.requestId });
    assert.equal(p2._sshRetried, 1, 'the failed pane still owns one spent retry');

    p2.tabId = 'ssh_B2'; // backend id of the retried generation
    ctx.__emit('ssh-error', { tabId: 'ssh_B2', rendererId: p2.requestId, error: 'os error 10061 connection refused' });
    assert.equal(p2._sshRetried, 2, 'the second failure continues this pane budget');
});
test('a pane reconnect re-arms only that pane budget', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const { tab, p2 } = sshSplitTab(ctx);
    failP2(ctx, tab, p2);
    p2.tabId = 'ssh_B2';
    ctx.__emit('ssh-connected', { tabId: 'ssh_B2', rendererId: p2.requestId });
    assert.equal(p2._sshRetried, 0, 'the pane that reconnected owns the reset budget');
});
test('reconnecting a split tab does not bump the tab retry token', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const { tab, p1 } = sshSplitTab(ctx);
    const before = tab._sshRetryToken || 0;
    p1.focused = true;
    ctx.TabManager.reconnectTab(tab.id); // split: delegates to the focused pane
    assert.equal(tab._sshRetryToken || 0, before,
        'a split reconnect supersedes only the pane it targets');
});

test('splitting the tab during a tab-level backoff cancels the retry', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const tab = { id: 't_split_retry', name: 'sr', type: 'ssh', host: 'h1', user: 'u1', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500); // pre-attempt window
    await flush();
    const att1 = tab._pendingAttempt;
    assert.ok(att1, 'first attempt in flight');

    ctx.__emit('ssh-error', { tabId: null, attemptId: att1, error: 'connection reset by peer' });
    assert.equal(tab._sshRetried, 1, 'tab-level retry budget spent');

    // Observe the scheduled retry without depending on the serial connect
    // queue, whose first slot never settles under this fake.
    let retried = 0;
    ctx._sshConnectWithCredentials = () => { retried += 1; };

    // The user splits before the backoff elapses: the tab no longer owns the
    // terminal the retry would connect.
    tab.splitRoot = { type: 'v', children: [] };
    ctx.__tq.advance(2500);
    await flush();
    assert.equal(retried, 0, 'a tab retry superseded by a split must not start a second backend');
});

test('a tab-level retry still fires while the tab stays unsplit', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const tab = { id: 't_keep_retry', name: 'kr', type: 'ssh', host: 'h1', user: 'u1', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500);
    await flush();
    const att1 = tab._pendingAttempt;
    ctx.__emit('ssh-error', { tabId: null, attemptId: att1, error: 'connection reset by peer' });

    let retried = 0;
    ctx._sshConnectWithCredentials = () => { retried += 1; };

    ctx.__tq.advance(2500);
    await flush();
    assert.equal(retried, 1, 'the unsplit tab retries normally');
});