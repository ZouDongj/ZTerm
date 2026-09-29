// The SFTP panel is bound to one backend session (SFTP._tabId is the pty/ssh
// backend id): every teardown of that session must close the panel, or it
// keeps showing a dead session's listing and every operation fails with
// "session unavailable". closeTab already had the contract (now the shared
// TabManager._closeSftpForSessions); the old _closePane / _reconnectPane /
// reconnectTab paths had none.
// Driven through the REAL tabs.js methods in the shared renderer VM
// (tests/helpers/renderer-vm.mjs) with a stub SFTP panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

function stubSftp(ctx, boundTabId) {
    const stub = {
        _tabId: boundTabId,
        closeCount: 0,
        close() { this.closeCount++; this._tabId = null; },
    };
    ctx.window.SFTP = stub; // the production guard reads window.SFTP
    ctx.SFTP = stub;        // ...and then the bare global
    return stub;
}

test('_closePane closes the SFTP panel bound to that pane\'s session', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_B');

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 1, 'panel bound to the dying session is closed at initiation');
    assert.equal(sftp._tabId, null, 'binding cleared');
});

test('_closePane leaves a panel bound to a SURVIVING pane alone', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A'); // bound to the sibling that stays

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 0, 'panel bound to the surviving session is untouched');
    assert.equal(sftp._tabId, 'ssh_A');
});

test('_reconnectPane closes the SFTP panel bound to the discarded session', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_B');

    ctx.TabManager._reconnectPane(tab.id, p2.id);

    assert.equal(sftp.closeCount, 1, 'panel closed with the discarded generation');
});

test('reconnectTab closes the SFTP panel bound to the discarded session', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_ssh', 'ssh_A', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A');

    ctx.TabManager.reconnectTab(tab.id);

    assert.equal(sftp.closeCount, 1, 'panel closed with the discarded generation');
});

test('closeTab still closes the panel for any session of a split tab (shared helper)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const sftp = stubSftp(ctx, 'ssh_A');
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);

    assert.equal(sftp.closeCount, 1, 'the closeTab contract is preserved through the helper');
});
