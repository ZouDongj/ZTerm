// Reconnect of a PRE-CLAIM SSH session must cancel the in-flight attempt.
// Driven through the REAL tabs.js reconnectTab / _reconnectPane and the REAL
// _sshConnectChain serial queue in the shared renderer VM
// (tests/helpers/renderer-vm.mjs); ipcRenderer.invoke is replaced by a
// recording deferred whose promise never settles, so an uncancelled queue
// slot would hold the replacement for the full 20s fallback — exactly the
// stall the old code produced (terminal already disposed, blank content
// area). The old code only cancelled when a backend id was already claimed
// (closeTab's pre-claim cancel, tabs.js closeTab, was the existing contract).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));

// Recording, never-settling invoke bridge: every ssh-connect invocation is
// observable and stays in flight until the test says otherwise.
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
const connectSent = (invokes, attemptId) =>
    invokes.some(i => i.cmd === 'ssh-connect' && i.payload.attemptId === attemptId);
const cancelSent = (ctx, attemptId) =>
    ctx.__sends.some(s => s.cmd === 'ssh-disconnect' && s.payload && s.payload.attemptId === attemptId);

test('reconnectTab on a pending (pre-claim) SSH tab cancels the attempt and frees the queue slot', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const tab = { id: 't_rc', name: 't_rc', type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    await flush();
    const att1 = tab._pendingAttempt;
    assert.ok(att1, 'gen-1 attempt pending (no backend claimed yet)');
    assert.equal(tab.tabId, null, 'pre-claim precondition');
    assert.ok(connectSent(invokes, att1), 'gen-1 invocation in flight (holds the queue head)');

    ctx.TabManager.reconnectTab(tab.id);
    assert.equal(ctx.sshAttempts.isCancelled(att1), true,
        'reconnect cancels the pre-claim attempt by identity');
    assert.ok(cancelSent(ctx, att1),
        'the cancel rides the reconnect channel with the attempt token');

    ctx.__tq.advance(500); // the replacement delay
    await flush();
    const att2 = tab._pendingAttempt;
    assert.ok(att2 && att2 !== att1, 'replacement attempt created with a NEW identity');
    assert.ok(connectSent(invokes, att2),
        'replacement invocation sent at once (cancelled slot released; no 20s stall)');
});

test('_reconnectPane on a pending (pre-claim) SSH pane cancels the attempt and frees the queue slot', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const tab = wiredTab(ctx, 't_sp', 'ssh_A', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    await flush();
    const p2 = ctx.getAllPanes(tab)[1];
    const att1 = p2._pendingAttempt;
    assert.ok(att1, 'pane attempt pending');
    assert.equal(p2.tabId, null, 'pre-claim precondition');
    assert.ok(connectSent(invokes, att1), 'pane invocation in flight');

    ctx.TabManager._reconnectPane(tab.id, p2.id);
    assert.equal(ctx.sshAttempts.isCancelled(att1), true,
        'pane reconnect cancels the pre-claim attempt by identity');
    assert.ok(cancelSent(ctx, att1), 'the cancel rides the reconnect channel');

    ctx.__tq.advance(500);
    await flush();
    const att2 = p2._pendingAttempt;
    assert.ok(att2 && att2 !== att1, 'pane replacement attempt created with a NEW identity');
    assert.ok(connectSent(invokes, att2),
        'pane replacement invocation sent at once (cancelled slot released)');
});
