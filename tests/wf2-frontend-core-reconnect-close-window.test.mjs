// tabs-1: the pre-attempt reconnect window (reconnectTab's 500ms timer,
// clearOnConnect path) holds a tab with term=null / tabId=null and no attempt
// identity yet. That state used to satisfy the last-tab deadShell check in
// closeTab, so clicking the tab's × button inside the window reset the
// mid-reconnect tab to a fresh local shell — which the pending SSH reconnect
// then hijacked (its connecting event overwrote tab.tabId with the SSH session
// id and the local backend leaked). The fix: a tab (or lone surviving pane)
// with _reconnectPending is NOT dead; closing is refused like the existing
// "live attempt / pending local creation" contract.
//
// REAL here: tabs.js / terminal.js / ssh-attempts.js / ipc.js through
// tests/helpers/renderer-vm.mjs; only the environment is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

function mkSshTab(ctx, id, backendId) {
    return wiredTab(ctx, id, backendId, 'boot text', {
        type: 'ssh', host: 'hst', user: 'u', connected: true,
    });
}

test('closeTab refuses (no local reset) while the last tab awaits its reconnect timer', () => {
    const ctx = loadVm();
    const tab = mkSshTab(ctx, 't1', 'ssh_1');

    // Enter the clearOnConnect pre-attempt window: no sshProfileId configured,
    // so _clearOnConnect is the default true — the terminal is disposed and
    // tabId nulled synchronously, the connect fires 500ms later.
    ctx.TabManager.reconnectTab('t1');
    assert.equal(tab._reconnectPending, true, 'reconnect window entered');
    assert.equal(tab.term, null, 'clearOnConnect disposed the terminal');
    assert.equal(tab.tabId, null, 'backend id dropped for the new generation');

    const mark = ctx.__sends.length;
    ctx.TabManager.closeTab('t1'); // the tab × button path (no guard of its own)

    assert.equal(tab.type, 'ssh', 'the mid-reconnect tab is NOT reset to a local shell');
    assert.equal(ctx.__sends.length - mark, 0, 'no pty-create was issued for the reset');
    assert.equal(tab._reconnectPending, true, 'the pending reconnect is untouched');
    assert.equal(ctx.TabManager.tabs.length, 1, 'the tab itself survives (closing refused)');

    // The refused close does not eat the reconnect: the timer still fires and
    // starts the real attempt for this tab.
    ctx.__tq.advance(500);
    assert.ok(ctx.sshAttempts.ownerAttempt(tab), 'the reconnect attempt was created');
});

test('(control) a genuinely dead last tab still resets to the local fallback', () => {
    const ctx = loadVm();
    const tab = mkSshTab(ctx, 't1', 'ssh_1');
    // Simulate a dead shell WITHOUT any pending work: term disposed, backend
    // gone, no attempt, no pending create, no pending reconnect.
    tab.term.dispose(); tab.term = null; tab.fitAddon = null; tab.tabId = null;

    ctx.TabManager.closeTab('t1');

    assert.equal(tab.type, 'local', 'the dead-shell fallback still converts the tab');
    const create = ctx.__sends.find(s => s.cmd === 'pty-create' && s.payload.requestId === 't1');
    assert.ok(create, 'the fallback local pty-create is still issued');
});

test('a lone pane inside its reconnect window survives the sibling close (no whole-tab close)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'local_1', 'a', 'local_2', 'b');
    // Another alive tab keeps closeTab out of the last-tab branch, so the
    // survivorDead path decides between "close the whole tab" and "collapse".
    wiredTab(ctx, 't_other', 'local_9');

    // Stage the exact pre-attempt pane state of _reconnectPane's
    // clearOnConnect window: slots dropped, no attempt identity, waiting on
    // its 500ms timer (a real _reconnectPane on an SSH pane lands here).
    p1.term = null; p1.fitAddon = null; p1.tabId = null; p1.requestId = null;
    p1._pendingAttempt = null; p1._reconnectPending = true;

    ctx.TabManager._closePane(tab.id, p2.id);
    ctx.__tq.advance(250); // pane exit fade + doRemove

    assert.equal(ctx.TabManager.tabs.length, 2, 'the split tab is NOT closed');
    assert.equal(tab.splitRoot, null, 'the tree collapsed onto the reconnecting pane');
    assert.ok(ctx.TabManager.tabs.includes(tab), 'the reconnecting pane keeps its tab');

    // Control: the same staging WITHOUT the pending flag takes the old
    // no-survivor path (whole-tab close).
    const ctx2 = loadVm();
    const s = wiredSplitTab(ctx2, 't1', 'local_1', 'a', 'local_2', 'b');
    wiredTab(ctx2, 't_other', 'local_9');
    s.p1.term = null; s.p1.fitAddon = null; s.p1.tabId = null;
    s.p1.requestId = null; s.p1._pendingAttempt = null; s.p1._reconnectPending = false;
    ctx2.TabManager._closePane(s.tab.id, s.p2.id);
    ctx2.__tq.advance(250);
    assert.ok(ctx2.TabManager._closingTabs.has('t1') || !ctx2.TabManager.tabs.some(t => t.id === 't1'),
        'without a pending reconnect the dead survivor closes the whole tab');
});

test('closing a pane cancels its own pending reconnect flag (a dying pane never reconnects)', () => {
    const ctx = loadVm();
    const { tab, p1 } = wiredSplitTab(ctx, 't1', 'local_1', 'a', 'local_2', 'b');
    p1._reconnectPending = true; // mid reconnect window when the user closes it

    ctx.TabManager._closePane(tab.id, p1.id);

    assert.equal(p1._reconnectPending, false, 'close initiation clears the pending reconnect');
});

// tabs-close-guard: the reconnect timer's fire guard only checked tree
// membership. Burst closes stagger doRemove (200ms + 120ms per queued close),
// so closing 4+ tabs leaves the last removal past the 500ms fire — the timer
// fired on a tab already committed to close and started an orphan SSH
// handshake (disposed by the orphan backstops, but a real extra connect).
// The guard now also honors the closing commitment.
test('the reconnect timer does not fire on a tab committed to close (doRemove still pending)', () => {
    const ctx = loadVm();
    const tab = mkSshTab(ctx, 't1', 'ssh_1');
    // Burst fodder plus a bystander: closing 4 tabs queues t1's doRemove at
    // 200 + 3*120 = 560ms, past the 500ms reconnect fire.
    wiredTab(ctx, 't2', 'local_2');
    wiredTab(ctx, 't3', 'local_3');
    wiredTab(ctx, 't4', 'local_4');
    wiredTab(ctx, 't0', 'local_0');

    ctx.TabManager.reconnectTab('t1');
    assert.equal(tab._reconnectPending, true, 'reconnect window entered');

    ctx.TabManager.closeTab('t2');
    ctx.TabManager.closeTab('t3');
    ctx.TabManager.closeTab('t4');
    ctx.TabManager.closeTab('t1'); // 4th queued close → doRemove at 560ms

    ctx.__tq.advance(500); // the reconnect timer fires; t1's removal is still pending
    assert.ok(ctx.TabManager.tabs.some(t => t.id === 't1'), 'control: t1 is still in the tree (removal pending)');
    assert.equal(ctx.TabManager._closingTabs.has('t1'), true, 'control: t1 is committed to close');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, 0, 'no attempt was created for the closing tab');

    ctx.__tq.advance(100); // the deferred removal lands
    assert.equal(ctx.TabManager.tabs.some(t => t.id === 't1'), false, 't1 is gone');
    assert.equal(ctx.sshAttempts.__tokensForTests().length, 0, 'still no attempt after the removal');
});

test('(control) the reconnect timer still fires amid a burst when this tab is not committed to close', () => {
    const ctx = loadVm();
    const tab = mkSshTab(ctx, 't1', 'ssh_1');
    wiredTab(ctx, 't2', 'local_2');
    wiredTab(ctx, 't3', 'local_3');
    wiredTab(ctx, 't0', 'local_0');

    ctx.TabManager.reconnectTab('t1');
    ctx.TabManager.closeTab('t2');
    ctx.TabManager.closeTab('t3');

    ctx.__tq.advance(500);
    assert.ok(ctx.sshAttempts.ownerAttempt(tab), 'the reconnect fired normally for the untouched tab');
});
