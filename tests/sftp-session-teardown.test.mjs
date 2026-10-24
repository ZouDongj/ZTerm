// The SFTP panel is bound to one backend session (SFTP._tabId is the pty/ssh
// backend id). Teardown contract (per-tab open-state model):
// - tab close / reconnect discard (TabManager.closeTab / reconnectTab /
//   _reconnectPane): the dying session's memory and the owning tab's open
//   state go (SFTP.forgetTabState), and a bound panel is torn down through
//   SFTP.closeForTab(dyingTabId) — named, never the active-tab close(), so a
//   suspended binding on a BACKGROUND tab cannot wipe the active tab's open
//   state.
// - pane close (TabManager._closePane) while its tab survives: only the dying
//   session's memory goes (SFTP.forgetSession); the panel is NOT closed — the
//   tab keeps its open state and SFTP.updateTarget() rebinds to the remaining
//   focused connected pane or hides the dock.
// Driven through the REAL tabs.js methods in the shared renderer VM
// (tests/helpers/renderer-vm.mjs) with a recording SFTP stub that also models
// the per-tab open-state set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

function stubSftp(ctx, boundTabId, openTabs = []) {
    const stub = {
        _tabId: boundTabId,
        _openTabs: new Set(openTabs), // models SFTP's per-tab open-state seam
        closeCount: 0,      // user-facing close() (active-tab semantics)
        closedForTabs: [],  // teardown closeForTab() targets
        forgotSessions: [],
        forgotTabs: [],
        updateCount: 0,
        close() { this.closeCount++; this._tabId = null; },
        closeForTab(tabId) { this.closedForTabs.push(tabId); this._openTabs.delete(tabId); this._tabId = null; },
        forgetSession(id) { this.forgotSessions.push(id); },
        forgetTabState(tabId, ids) { this.forgotTabs.push({ tabId, ids: [...(ids || [])] }); },
        updateTarget() { this.updateCount++; },
    };
    // tabs.js guards resolve the bare global through a typeof check; the
    // window alias only keeps older harness paths that still read it.
    ctx.window.SFTP = stub;
    ctx.SFTP = stub;
    return stub;
}

test('_closePane keeps the tab\'s dock open state: bound panel is rebound, not closed', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_B', ['t_sp']);

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 0, 'pane close never closes the tab\'s dock');
    assert.equal(sftp.closedForTabs.length, 0, 'and never uses the teardown close either');
    assert.deepEqual(sftp.forgotSessions, ['ssh_B'], 'the dying session\'s memory is cleared');
    assert.ok(sftp.updateCount >= 1, 'the normal update path re-evaluates the binding');
    assert.deepEqual(sftp.forgotTabs, [], 'the tab\'s open state is untouched');
    assert.ok(sftp._openTabs.has('t_sp'), 'the open-state set still names the tab');
});

test('_closePane clears the memory of a dying pane the panel is NOT bound to', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A'); // bound to the sibling that stays

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 0, 'panel bound to the surviving session is untouched');
    assert.equal(sftp._tabId, 'ssh_A');
    assert.deepEqual(sftp.forgotSessions, ['ssh_B'], 'still only the dying session\'s memory goes');
});

test('_reconnectPane tears the bound panel down for the DYING tab and forgets its state', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_B', ['t_sp']);

    ctx.TabManager._reconnectPane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 0, 'teardown never routes through the user-facing close');
    assert.deepEqual(sftp.closedForTabs, [tab.id], 'the teardown close names the dying tab');
    assert.deepEqual(sftp.forgotTabs, [{ tabId: tab.id, ids: ['ssh_B'] }],
        'the tab\'s open state and the old session\'s memory go (no auto-reopen)');
});

test('reconnectTab tears the bound panel down for the DYING tab and forgets its state', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_ssh', 'ssh_A', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A', ['t_ssh']);

    ctx.TabManager.reconnectTab(tab.id);

    assert.equal(sftp.closeCount, 0, 'teardown never routes through the user-facing close');
    assert.deepEqual(sftp.closedForTabs, [tab.id], 'the teardown close names the dying tab');
    assert.deepEqual(sftp.forgotTabs, [{ tabId: tab.id, ids: ['ssh_A'] }],
        'the tab\'s open state and the old session\'s memory go');
});

test('closeTab still tears the panel down for any session of a split tab (shared helper) and forgets the tab', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A', ['t_sp']);
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);

    assert.equal(sftp.closeCount, 0, 'teardown never routes through the user-facing close');
    assert.deepEqual(sftp.closedForTabs, [tab.id], 'the closeTab contract is preserved through the helper');
    assert.deepEqual(sftp.forgotTabs, [{ tabId: tab.id, ids: ['ssh_A', 'ssh_B'] }],
        'the dying tab\'s open state and ALL its sessions\' memories go');
});

test('background closeTab removes the DYING tab\'s open state by name; the active tab\'s survives', () => {
    const ctx = loadVm();
    // The review's exact seam: the active tab t_live has its dock OPENED, but
    // the dock's binding is suspended on the BACKGROUND tab's session — a
    // close() that guesses the active tab would wipe t_live's open state and
    // the dock could never return for it.
    wiredTab(ctx, 't_live', 'ssh_L', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.activeId = 't_live';
    const { tab } = wiredSplitTab(ctx, 't_bg', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A', ['t_live']);
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);

    assert.deepEqual(sftp.closedForTabs, ['t_bg'], 'the teardown names the DYING tab, not the active one');
    assert.equal(sftp.closeCount, 0, 'the user-facing close is never used for teardown');
    assert.ok(sftp._openTabs.has('t_live'), 'the ACTIVE tab\'s open state survives');
    assert.equal(sftp._tabId, null, 'the suspended binding on the dying session drops');
    assert.deepEqual(sftp.forgotTabs, [{ tabId: 't_bg', ids: ['ssh_A', 'ssh_B'] }]);
    assert.equal(ctx.TabManager.activeId, 't_live', 'the active tab did not move');
});

test('closeTab of a BACKGROUND tab clears its SFTP state without touching the bound panel', () => {
    const ctx = loadVm();
    // t_live is active and holds the panel; t_bg is a background split tab.
    const live = wiredTab(ctx, 't_live', 'ssh_L', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.activeId = 't_live';
    const { tab } = wiredSplitTab(ctx, 't_bg', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_L', ['t_live']);
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);

    assert.equal(sftp.closeCount, 0, 'the panel bound to the ACTIVE tab\'s session is untouched');
    assert.equal(sftp.closedForTabs.length, 0, 'no teardown close: the dying sessions are not the binding');
    assert.deepEqual(sftp.forgotTabs, [{ tabId: 't_bg', ids: ['ssh_A', 'ssh_B'] }],
        'the background tab\'s own state still goes');
    assert.equal(ctx.TabManager.activeId, 't_live', 'the active tab did not move');
    void live;
});

test('the last-tab dead-shell reset clears the SFTP open state and hides the dock', () => {
    const ctx = loadVm();
    // A single tab reduced to a terminal-less, session-less shell (all its
    // panes died in the same close window) resets to a local tab: its SFTP
    // open state must go and the dock must hide (the old code left a dead
    // panel mounted over the new local shell).
    const tab = wiredTab(ctx, 't_dead', 'ssh_A', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.activeId = 't_dead';
    const sftp = stubSftp(ctx, 'ssh_A', ['t_dead']);
    ctx.TabManager.render();
    // Kill the shell: no terminal, no session, nothing pending.
    tab.term = null; tab.fitAddon = null; tab.tabId = null; tab.connected = false;

    ctx.TabManager.closeTab('t_dead');

    assert.ok(sftp.forgotTabs.some(e => e.tabId === 't_dead'), 'the dead shell\'s open state is cleared');
    assert.deepEqual(sftp.closedForTabs, ['t_dead'], 'the dock is hidden with the reset, by name');
    assert.equal(sftp.closeCount, 0, 'the user-facing close is never used for teardown');
});
