// tabs-2: _reconnectPane's 500ms pre-attempt timer used to connect the pane
// object captured at initiation. The survivorDead carve-out (_closePane /
// closeTab treat _reconnectPending as "not dead") made a sibling-close
// collapse around a mid-reconnect pane reachable: _exitSplit adopts the
// pane's identity onto the tab and the pane leaves the tree, yet the timer
// still connected the stale pane object — the attempt bound to a wrapper no
// owner resolution can find, the fresh session was unclaimed-disposed, and
// the collapsed tab stayed terminal-less with its reconnect silently lost.
// Closing the pane itself inside the window had the same orphan shape. The
// fix resolves the owner at fire time (the ipc.js ssh-error retry idiom):
// an adopted pane still holds its flag (a closed pane lost it to
// _closePane's dying reset), so the flag discriminates the two outcomes.
//
// REAL here: tabs.js / terminal.js / ssh-attempts.js / ipc.js through
// tests/helpers/renderer-vm.mjs; only the environment is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// An SSH split whose two panes both carry the tab's SSH identity, plus a
// bystander tab that keeps closeTab out of the last-tab branch (so the
// survivorDead path alone decides between collapse and whole-tab close).
function sshSplit(ctx) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'ssh_1', 'a', 'ssh_2', 'b', {
        type: 'ssh', host: 'hst', user: 'u', connected: true,
    });
    wiredTab(ctx, 't_other', 'local_9');
    return { tab, p1, p2 };
}

test('a pane reconnect survives the sibling-close collapse: the timer connects the tab, not the detached pane', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = sshSplit(ctx);

    // Real path: no sshProfileId configured, so _clearOnConnect is the
    // default true — the pane terminal is disposed and the connect fires
    // 500ms later.
    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1._reconnectPending, true, 'pre-attempt window entered');
    assert.equal(p1.term, null, 'clearOnConnect disposed the pane terminal');
    assert.equal(p1.tabId, null, 'backend id dropped for the new generation');

    ctx.TabManager._closePane(tab.id, p2.id);
    ctx.__tq.advance(250); // pane exit fade + doRemove
    assert.equal(tab.splitRoot, null, 'the tree collapsed onto the reconnecting pane');
    assert.equal(tab.type, 'ssh', 'the tab adopted the pane session identity');

    ctx.__tq.advance(500); // the pane reconnect timer fires AFTER the collapse

    const token = tab._pendingAttempt;
    assert.ok(token, 'the reconnect attempt was created');
    assert.equal(ctx.sshAttempts.ownerOf(token), tab, 'the collapsed tab owns the attempt');
    assert.ok(!p1._pendingAttempt, 'no attempt stays bound to the tree-less pane object');
});

test('closing the reconnecting pane inside the window spawns no orphan attempt', () => {
    const ctx = loadVm();
    const { tab, p1 } = sshSplit(ctx);

    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1._reconnectPending, true, 'pre-attempt window entered');

    ctx.TabManager._closePane(tab.id, p1.id); // the pane the timer still holds
    ctx.__tq.advance(250); // fade + doRemove → collapse onto the surviving sibling
    assert.equal(tab.splitRoot, null, 'control: the split collapsed around the sibling');

    // The collapse legitimately transfers the sibling's own pending attempt
    // onto the tab (_exitSplit bookkeeping) — the orphan check is that the
    // closed pane's timer adds NOTHING on top of it.
    const tokensAfterCollapse = ctx.sshAttempts.__tokensForTests().length;
    const tabAttemptAfterCollapse = tab._pendingAttempt;

    ctx.__tq.advance(500); // the reconnect timer fires with the closed pane

    assert.ok(!p1._pendingAttempt, 'no attempt for the closed pane');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, tokensAfterCollapse,
        'the timer created no new attempt');
    assert.equal(tab._pendingAttempt, tabAttemptAfterCollapse,
        'the collapsed tab keeps exactly its transferred attempt, un-hijacked');
});

test('(control) the pane reconnect is unchanged while the split stays alive', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = sshSplit(ctx);

    ctx.TabManager._reconnectPane(tab.id, p1.id);
    ctx.__tq.advance(500); // no close, no collapse — the plain in-split path

    assert.equal(tab.splitRoot !== null, true, 'the split is untouched');
    const token = p1._pendingAttempt;
    assert.ok(token, 'the reconnect attempt was created');
    assert.equal(ctx.sshAttempts.ownerOf(token), p1, 'the pane still in the tree owns it');
    assert.equal(ctx.sshAttempts.ownerOf(token) === p2, false, 'not the sibling');
    assert.equal(p1._reconnectPending, false, 'the window closed');
});

// tabs-close-guard (pane): the fire-time ownership resolution only checked
// tree membership. A close initiated inside the last ~200ms of the window
// keeps the pane in the tree for its fade while _closing is already set —
// the timer fired on the dying pane and started an orphan attempt. The same
// hole existed for any pane of a tab whose whole-tab doRemove was still
// pending (closeTab leaves pane flags untouched during the fade).
test('the pane reconnect timer does not fire on a pane committed to close (fade still pending)', () => {
    const ctx = loadVm();
    const { tab, p1 } = sshSplit(ctx);

    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1._reconnectPending, true, 'pre-attempt window entered');
    // Baseline: the split's own creation attempt (the second pane's spawn)
    // predates the window; the orphan check is that the timer adds NOTHING.
    const baseline = ctx.sshAttempts.__tokensForTests().length;

    ctx.__tq.advance(310); // close initiated at T=310 → pane doRemove at 510
    ctx.TabManager._closePane(tab.id, p1.id);
    assert.equal(p1._closing, true, 'close commitment made');

    ctx.__tq.advance(190); // T=500: the timer fires while the pane is still in the tree
    assert.ok(ctx.getAllPanes(tab).some(p => p.id === p1.id), 'control: the dying pane is still in the tree');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, baseline, 'no attempt was created for the dying pane');

    ctx.__tq.advance(200); // the pane removal + collapse land
    assert.equal(tab.splitRoot, null, 'the split collapsed onto the sibling');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, baseline, 'still no attempt after the removal');
});

test('the pane reconnect timer does not fire when the whole tab is committed to close (doRemove still pending)', () => {
    const ctx = loadVm();
    const { tab, p1 } = sshSplit(ctx);

    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1._reconnectPending, true, 'pre-attempt window entered');
    // Baseline: the split's own creation attempt (the second pane's spawn)
    // predates the window; the orphan check is that the timer adds NOTHING.
    const baseline = ctx.sshAttempts.__tokensForTests().length;

    ctx.__tq.advance(310); // whole-tab close at T=310 → tab doRemove at 510
    ctx.TabManager.closeTab(tab.id);

    ctx.__tq.advance(190); // T=500: the timer fires with the tab still in the array
    assert.ok(ctx.TabManager.tabs.some(t => t.id === tab.id), 'control: the tab is still in the array');
    assert.equal(ctx.TabManager._closingTabs.has(tab.id), true, 'control: the tab is committed to close');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, baseline, 'no attempt was created for the doomed split');

    ctx.__tq.advance(200); // the deferred tab removal lands
    assert.equal(ctx.TabManager.tabs.some(t => t.id === tab.id), false, 'the tab is gone');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, baseline, 'still no attempt after the removal');
});
