// SFTP side dock target semantics: the dock follows the ACTIVE TAB's FOCUSED
// pane — currentTargetTabId() is the single rule (settings/local focus → no
// target; focused SSH pane → its backend session; split without a focused
// marker falls back to the first pane), and updateTarget() maps focus/tab
// changes onto suspend (keep _userOpen, hide, retire the view generation) /
// restore (rebind through a fresh open). Driven through the REAL sftp.js in
// the shared sftp VM seam (real TabManager + real getAllPanes walk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm, drain } from './helpers/sftp-vm.mjs';

// Stage the dock's bar button (the harness fixture has no titlebar).
function stageToggleBtn(ctx) {
    const btn = ctx.document.createElement('div');
    btn.id = 'sftp-toggle-btn';
    ctx.document.body.appendChild(btn);
    return btn;
}

function mkTab(ctx, over) {
    const tab = { name: over.id, connected: true, ...over };
    ctx.TabManager.tabs.push(tab);
    return tab;
}

function splitPane(id, type, tabId, focused) {
    return { id, type, tabId, focused: !!focused, name: id };
}

async function openDock(vm, tabId) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    const call = vm.pending('sftp-open', k => k.args.tabId === tabId)[0];
    vm.settle(call, { path: '/home/x', files: [] });
    await vm.drain();
    await p;
}

// ── currentTargetTabId: the focused-pane rule ────────────────────────────────

test('settings tab yields no dock target', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, { id: 'tabSet', type: 'settings' });
    vm.ctx.TabManager.activeId = 'tabSet';
    assert.equal(vm.SFTP.currentTargetTabId(), null);
});

test('local tab yields no dock target', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    assert.equal(vm.SFTP.currentTargetTabId(), null);
});

test('a connected SSH tab targets its own session', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA'; // fixture tab: {type:'ssh', tabId:'sessA'}
    assert.equal(vm.SFTP.currentTargetTabId(), 'sessA');
});

test('an SSH tab without a backend session (connecting) yields no target', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, { id: 'tabConn', type: 'ssh', tabId: null });
    vm.ctx.TabManager.activeId = 'tabConn';
    assert.equal(vm.SFTP.currentTargetTabId(), null);
});

test('split with the focus on a local pane yields no target even with an SSH sibling', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, {
        id: 'tabMix', type: 'local', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_loc', 'local', 'local_9', true),
            splitPane('p_ssh', 'ssh', 'ssh_9', false),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabMix';
    assert.equal(vm.SFTP.currentTargetTabId(), null);
});

test('split with the focus on an SSH pane targets that pane\'s session', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, {
        id: 'tabSplit', type: 'ssh', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_a', 'ssh', 'sessA', false),
            splitPane('p_b', 'ssh', 'sessB', true),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabSplit';
    assert.equal(vm.SFTP.currentTargetTabId(), 'sessB');
});

test('split without a focused marker falls back to the first pane', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    const tab = mkTab(vm.ctx, {
        id: 'tabNoFocus', type: 'ssh', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_x', 'ssh', 'sessB'),
            splitPane('p_y', 'ssh', 'sessA'),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabNoFocus';
    assert.equal(vm.SFTP.currentTargetTabId(), 'sessB');

    // First pane local -> still no target
    tab.splitRoot = { orientation: 'h', children: [
        splitPane('p_l', 'local', 'local_1'),
        splitPane('p_s', 'ssh', 'sessA'),
    ] };
    assert.equal(vm.SFTP.currentTargetTabId(), null);
});

// ── updateTarget: suspend / restore / rebind ────────────────────────────────

test('focusing a non-SSH tab suspends the dock but keeps the user toggle', async () => {
    const vm = await loadSftpVm();
    const btn = stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    assert.equal(vm.SFTP.isOpen, true, 'staging: dock open on sessA');
    assert.equal(vm.SFTP._userOpen, true);
    assert.ok(btn.classList.contains('visible'), 'button visible on an SSH target');
    assert.ok(btn.classList.contains('on'), 'button pressed while the dock shows that session');

    // Focus moves to a local tab
    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP.isOpen, false, 'dock suspended on a non-SSH focus');
    assert.equal(vm.SFTP._userOpen, true, 'the user toggle state survives the suspension');
    assert.equal(vm.els.overlay.classList.contains('open'), false, 'legacy .open class dropped');
    assert.ok(!btn.classList.contains('visible'), 'bar button hides with no SSH target');

    // Refocus the SSH tab: the dock restores through a fresh open of sessA,
    // returning to the directory the suspended view was browsing (a pinned
    // path would still take precedence — covered by the pin tests).
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'dock restored on the SSH refocus');
    assert.equal(vm.SFTP._tabId, 'sessA');
    const reopen = vm.pending('sftp-readdir', k => k.args.tabId === 'sessA' && k.args.path === '/home/x')[0];
    assert.ok(reopen, 'the restore navigates back to the suspended directory');
});

test('updateTarget never auto-opens while the user toggle is off', async () => {
    const vm = await loadSftpVm();
    const btn = stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'no dock without a user toggle');
    assert.equal(vm.of('sftp-open').length, 0, 'no session request either');
    assert.ok(btn.classList.contains('visible'), 'the button still shows the eligible target');
    assert.ok(!btn.classList.contains('on'), 'button not pressed while the dock is closed');
});

test('focus moving to another SSH pane rebinds the dock to that session', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, {
        id: 'tabSplit', type: 'ssh', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_a', 'ssh', 'sessA', true),
            splitPane('p_b', 'ssh', 'sessB', false),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabSplit';
    await openDock(vm, 'sessA');
    assert.equal(vm.SFTP._tabId, 'sessA');

    // Focus moves to pane B: updateTarget rebinds to sessB
    const panes = vm.ctx.getAllPanes(vm.ctx.TabManager.getActive());
    panes.forEach(p => p.focused = p.id === 'p_b');
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP._tabId, 'sessB', 'dock rebound to the newly focused pane');
    const rebind = vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0];
    assert.ok(rebind, 'the rebind issues its own sftp-open request');
});

test('suspend/restore returns to the directory the view was browsing', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    // Browse away from the open result's home directory.
    const nav = vm.SFTP.navigate('/var/log');
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    await nav;
    assert.equal(vm.SFTP._path, '/var/log');

    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'dock suspended');

    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'dock restored');
    const restore = vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0];
    assert.ok(restore, 'the restore navigates back to the suspended directory, not the home dir');
    vm.settle(restore, { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/var/log', 'the listing lands on the restored directory');
    assert.equal(vm.SFTP._suspendedPath, null, 'the record is consumed on restore');
});

test('a suspended record for ANOTHER session is dropped on rebind', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');

    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget(); // suspends sessA at its open path
    assert.ok(vm.SFTP._suspendedPath, 'staging: the suspended path was recorded');

    // Refocus a DIFFERENT SSH session: the record must not leak into it.
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    const restore = vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0];
    assert.ok(restore, 'the dock rebinds to the focused session');
    vm.settle(restore, { path: '/home/b', files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._suspendedPath, null, 'a record for another binding is dropped, not kept');
});

test('a suspend during the in-flight restore keeps the restore destination', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    const nav = vm.SFTP.navigate('/var/log');
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    await nav;

    // First suspend; the refocus starts the restore navigation and STAYS
    // pending (this._path is still the '/' placeholder).
    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.ok(vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0],
        'staging: the restore navigation is in flight');

    // Suspend again before it settles: the record must keep /var/log, not
    // the placeholder '/' this._path still holds.
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP._suspendedPath.tabId, 'sessA',
        'the in-flight destination is recorded, not the placeholder');
    assert.equal(vm.SFTP._suspendedPath.path, '/var/log');

    // And the next restore still navigates back to it. Two readdir requests
    // for the same path are now pending (the superseded first restore + the
    // current one) — settle the LATEST; the superseded one is dropped by the
    // seq ownership check, exactly as in production.
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    const restores = vm.pending('sftp-readdir', k => k.args.path === '/var/log');
    assert.ok(restores.length >= 1, 'the second restore returns to the same directory');
    vm.settle(restores[restores.length - 1], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/var/log');
});

test('close() drops any suspended-path record', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');

    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    assert.ok(vm.SFTP._suspendedPath, 'staging: the suspend recorded a path');

    vm.SFTP.close();
    assert.equal(vm.SFTP._suspendedPath, null, 'a closed dock restores nothing');
    assert.equal(vm.SFTP._pendingRestorePath, null);
});

test('toggleFromBar toggles the focused session and no-ops without a target', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';

    vm.SFTP.toggleFromBar();
    await vm.drain();
    assert.equal(vm.SFTP.isOpen, true, 'first toggle opens the dock on the focused session');
    vm.settle(vm.pending('sftp-open')[0], { path: '/', files: [] });
    await vm.drain();

    vm.SFTP.toggleFromBar();
    assert.equal(vm.SFTP.isOpen, false, 'second toggle closes it');
    assert.equal(vm.SFTP._userOpen, false);

    // No SSH target: the toggle is a no-op
    mkTab(vm.ctx, { id: 'tabSet', type: 'settings' });
    vm.ctx.TabManager.activeId = 'tabSet';
    vm.SFTP.toggleFromBar();
    await drain();
    assert.equal(vm.SFTP.isOpen, false);
    assert.equal(vm.of('sftp-open').length, 1, 'no extra session request without a target');
});
