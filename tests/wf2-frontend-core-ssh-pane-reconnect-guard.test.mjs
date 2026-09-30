// ssh-1: reconnectTab's split branch used to take the FOCUSED pane without a
// type check, while the pane header's reconnect button gates on
// pane.type === 'ssh'. A local pane dragged into an SSH tab (ADR-0004
// cross-tab move keeps pane.type 'local') got "reconnected": its terminal was
// cleared, a brand-new SSH session was opened inside it, and its local
// backend id went out through ssh-disconnect (which unmanages a Local session
// without killing it). The fix: both reconnectTab's split branch and the
// _reconnectPane entry refuse non-SSH panes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// Mixed split shaped like the ADR-0004 drag-in: an SSH tab whose focused pane
// is a LOCAL pane (_sshHost/_sshProfileId undefined), plus an SSH sibling.
function mixedSplit(ctx) {
    const tab = wiredTab(ctx, 't_ssh', 'ssh_0', 'ssh boot', {
        type: 'ssh', host: 'hst', user: 'u', connected: false,
    });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const [pLocal, pSsh] = ctx.getAllPanes(tab);
    // Drag-in semantics: the promoted pane stays the tab's own session but a
    // dragged LOCAL pane keeps its own type and carries no SSH fields.
    pLocal.type = 'local';
    pLocal._sshHost = undefined; pLocal._sshProfileId = undefined;
    pSsh.type = 'ssh'; pSsh._sshHost = 'hst';
    return { tab, pLocal, pSsh };
}

test('reconnectTab skips a focused local pane in an SSH split (no clear, no connect, no misdirected disconnect)', () => {
    const ctx = loadVm();
    const { tab, pLocal } = mixedSplit(ctx);
    ctx.TabManager._focusPane(tab, pLocal.id);
    const termBefore = pLocal.term;

    const mark = ctx.__sends.length;
    ctx.TabManager.reconnectTab(tab.id);

    assert.equal(pLocal.term, termBefore, 'the local pane terminal is not disposed');
    assert.notEqual(pLocal.term?.disposed, true, 'terminal still alive');
    assert.equal(pLocal._reconnectPending, undefined, 'no reconnect window opened on it');
    assert.equal(ctx.__sends.length - mark, 0, 'no ssh-disconnect / connect traffic for the pane');
    assert.equal(ctx.sshAttempts.ownerAttempt(pLocal), null, 'no SSH attempt targets the local pane');
});

test('the same tab still reconnects when the focused pane is an SSH pane (gesture not dead)', () => {
    const ctx = loadVm();
    const { tab, pSsh } = mixedSplit(ctx);
    ctx.TabManager._focusPane(tab, pSsh.id);

    ctx.TabManager.reconnectTab(tab.id);

    assert.equal(pSsh._reconnectPending, true, 'the SSH pane entered its reconnect window');
    assert.equal(pSsh.term, null, 'clearOnConnect disposed its terminal for the new generation');
});

test('_reconnectPane entry refuses a local pane regardless of the caller', () => {
    const ctx = loadVm();
    const { tab, pLocal } = mixedSplit(ctx);
    const termBefore = pLocal.term;

    ctx.TabManager._reconnectPane(tab.id, pLocal.id);

    assert.equal(pLocal.term, termBefore, 'entry guard leaves the local pane untouched');
    assert.equal(pLocal.tabId, 'ssh_0', 'its backend binding is untouched');
    assert.equal(ctx.sshAttempts.ownerAttempt(pLocal), null, 'no attempt created');
});
