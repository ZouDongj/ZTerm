// A second reconnect trigger inside the 500ms pre-attempt window must be
// merged, not stacked: between initiation and the timer fire there is NO
// attempt identity yet (the token is created inside the timer callback), so
// nothing cancels the first trigger's pending connect. Old code scheduled one
// timer per trigger — both fired 500ms apart, each starting a full SSH
// connect; when the first attempt claimed between the two fires, the second
// connected again and the first session stayed alive with no owner (orphan).
// Driven through the REAL tabs.js reconnectTab / _reconnectPane and the REAL
// _sshConnectChain serial queue in the shared renderer VM. ssh-connect
// invocations resolve at once ('settle' mode) so the queue never masks a
// stacked second connect; 'never' mode keeps an attempt permanently in
// flight where the test needs one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));

function patchInvoke(ctx, mode = 'settle') {
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        const rec = { cmd, payload };
        rec.promise = (cmd === 'ssh-connect' && mode === 'settle')
            ? Promise.resolve({ tabId: 'ssh_' + (invokes.filter(i => i.cmd === 'ssh-connect').length + 1) })
            : new Promise(() => {});
        invokes.push(rec);
        return rec.promise;
    };
    return invokes;
}
const connects = (invokes) => invokes.filter(i => i.cmd === 'ssh-connect');

test('reconnectTab double-trigger inside the 500ms window starts ONE connect', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const keep = { id: 't_keep', name: 'keep', type: 'local', command: 'powershell.exe', args: [], connected: true };
    const tab = { id: 't_rc', name: 'rc', type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(keep, tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(400); // second trigger lands INSIDE the first trigger's window
    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(100); // first timer deadline (t=500): its attempt invokes and settles
    await flush();
    ctx.__tq.advance(400); // old code: the second timer's deadline (t=900)
    await flush();

    assert.equal(connects(invokes).length, 1,
        'both triggers merge into one ssh-connect (old code started two full connections)');
});

test('the merged window cannot orphan the first connection (claim race)', async () => {
    // A fast server settles the first connect before the old code's second
    // timer fired: the second connection then overwrote tab.tabId and the
    // first session stayed alive in the main process with no owner and no
    // destroy order ever sent for it.
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const keep = { id: 't_keep', name: 'keep', type: 'local', command: 'powershell.exe', args: [], connected: true };
    const tab = { id: 't_rc', name: 'rc', type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(keep, tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(400);
    ctx.TabManager.reconnectTab(tab.id); // inside the window
    ctx.__tq.advance(100);
    await flush(); // first connection settles and claims
    assert.equal(tab.tabId, 'ssh_1', 'first connection claimed the tab');
    ctx.__tq.advance(400); // old code: the second timer's deadline (t=900)
    await flush();

    assert.equal(connects(invokes).length, 1, 'no second connection was started');
    assert.equal(tab.tabId, 'ssh_1', 'the claimed session is still the tab\'s session');
    const discards = ctx.__sends.filter(s =>
        (s.cmd === 'pty-destroy' || s.cmd === 'ssh-disconnect')
        && s.payload && (s.payload.tabId === 'ssh_1' || s.payload.attemptId));
    assert.equal(discards.length, 0,
        'the live claimed session was never discarded (old code orphaned it by overwriting tabId)');
});

test('_reconnectPane double-trigger inside the 500ms window starts ONE connect', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const tab = wiredTab(ctx, 't_sp', 'ssh_A', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    await flush(); // the split itself spawns (and here settles) the new pane's connect
    const p2 = ctx.getAllPanes(tab)[1];
    assert.ok(p2.tabId, 'pane backend claimed by the spawn attempt');
    const base = invokes.length;

    ctx.TabManager._reconnectPane(tab.id, p2.id);
    ctx.__tq.advance(400);
    ctx.TabManager._reconnectPane(tab.id, p2.id); // second trigger inside the window
    ctx.__tq.advance(100); // t=500: the first timer's deadline
    await flush();
    ctx.__tq.advance(400); // t=900: old code's second timer deadline
    await flush();

    assert.equal(connects(invokes.slice(base)).length, 1,
        'the pane reconnect merges into one ssh-connect');
});

test('a re-trigger AFTER the window still supersedes the in-flight attempt by identity', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx, 'never');
    const keep = { id: 't_keep', name: 'keep', type: 'local', command: 'powershell.exe', args: [], connected: true };
    const tab = { id: 't_rc', name: 'rc', type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(keep, tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500);
    await flush();
    const att1 = tab._pendingAttempt;
    assert.ok(att1 && connects(invokes).some(i => i.payload.attemptId === att1),
        'first attempt in flight (invocation never settles)');

    // The window is over: an explicit re-trigger must NOT be merged — it
    // supersedes the in-flight attempt by identity and starts a replacement.
    ctx.TabManager.reconnectTab(tab.id);
    assert.equal(ctx.sshAttempts.isCancelled(att1), true,
        'the explicit re-trigger cancels the in-flight attempt by identity');
    ctx.__tq.advance(500);
    await flush();
    const att2 = tab._pendingAttempt;
    assert.ok(att2 && att2 !== att1, 'replacement attempt created');
    assert.equal(connects(invokes).length, 2,
        'exactly two connects total: the superseded one plus its replacement');
});
