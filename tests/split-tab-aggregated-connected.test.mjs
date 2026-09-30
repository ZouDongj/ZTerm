// Split-tab aggregated connected state (T26): tab.connected drives the tab
// dot / "(已断开)" label (tabs.js render), but the ipc.js pane branches wrote it
// from the LATEST pane lifecycle event — one dead pane marked a split tab with
// live panes disconnected. The write side now aggregates: a split tab is
// connected while ANY pane is alive (the same paneConnectedState predicate the
// pane dots use). Display (tabs.js) is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

test('ssh-disconnected for one pane keeps a split tab with a live pane connected', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'b1', null, 'b2', null);

    // p1's session reports connected.
    ctx.__emit('ssh-connected', { tabId: 'b1' });
    assert.equal(p1.connected, true);
    assert.equal(tab.connected, true);

    // p2's session drops: its pane dot goes red, but p1 is still alive — the
    // TAB must stay connected (old write: tab.connected = false).
    ctx.__emit('ssh-disconnected', { tabId: 'b2' });
    assert.equal(p2.connected, false, 'the dead pane itself is marked disconnected');
    assert.equal(p1.connected, true);
    assert.equal(tab.connected, true, 'any live pane keeps the split tab connected');

    // The last live pane drops: NOW the tab is disconnected.
    ctx.__emit('ssh-disconnected', { tabId: 'b1' });
    assert.equal(p1.connected, false);
    assert.equal(tab.connected, false, 'no live pane left: the tab is disconnected');

    // And a reconnect of one pane revives the tab.
    ctx.__emit('ssh-connected', { tabId: 'b2' });
    assert.equal(tab.connected, true);
});

test('pty-exit for one pane of a split keeps the tab connected while a sibling lives', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't2', 'b1', null, 'b2', null);

    ctx.__emit('ssh-connected', { tabId: 'b1' });
    ctx.__emit('pty-exit', { tabId: 'b2' }); // local pane's process exited

    assert.equal(p2.connected, false, 'the exited pane is disconnected');
    assert.equal(tab.connected, true, 'the tab stays connected: p1 is alive');
});

test('a deterministic ssh-error for one pane does not disconnect the whole split tab', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't3', 'b1', null, 'b2', null);

    ctx.__emit('ssh-connected', { tabId: 'b1' });
    ctx.__emit('ssh-error', { tabId: 'b2', error: 'Authentication failed' }); // non-handshake: no retry path

    assert.equal(p2.connected, false, 'the failed pane is disconnected');
    assert.equal(tab.connected, true, 'the sibling pane keeps the tab connected');
});

test('non-split tabs keep the exact single-session semantics', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't4', 'b4', null);

    ctx.__emit('pty-exit', { tabId: 'b4' });
    assert.equal(tab.connected, false, 'a lone tab with no splitRoot is unchanged by the aggregation');
});

test('a manual pane reconnect keeps a split tab with a live sibling connected', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't5', 'b1', null, 'b2', null);
    // _reconnectPane is the SSH pane-header action (type-gated since the
    // mixed-split fix): stage the panes as the SSH panes that button exists
    // on — reconnecting a local pane is no longer a product path.
    p1.type = 'ssh'; p1._sshHost = 'h';
    p2.type = 'ssh'; p2._sshHost = 'h';

    ctx.__emit('ssh-connected', { tabId: 'b1' });
    ctx.__emit('ssh-connected', { tabId: 'b2' });
    assert.equal(tab.connected, true, 'both sessions live');

    // User-initiated force reconnect of ONE pane (tabs.js _reconnectPane):
    // old write flipped the whole tab red for the 500ms window.
    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1.tabId, null, 'old backend id discarded');
    assert.equal(p1.connected, false, 'the reconnecting pane is disconnected for the window');
    assert.equal(p2.connected, true, 'sibling untouched');
    assert.equal(tab.connected, true, 'the live sibling keeps the tab connected through the window');
});
