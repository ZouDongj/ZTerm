// SFTP side dock target semantics (per-tab open-state model): the dock is
// shown ONLY on a frontend tab the user explicitly opened SFTP on, and only
// while that tab's focused pane resolves to a CONNECTED SSH session —
// currentTargetTabId() is the single target rule (settings/local/dead focus →
// no target; focused SSH pane → its backend session; split without a focused
// marker falls back to the first pane), and updateTarget() is a pure
// REFLECTION of the open set (never an auto-open). Hiding (suspend) is
// visual only: each tab keeps its own open state, and each backend session
// keeps its own last-browsed directory (_lastPath, restore priority pin >
// last path > fresh sftp-open). Driven through the REAL sftp.js in the
// shared sftp VM seam (real TabManager + real getAllPanes walk).
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

// Drive one successful navigation to `path` on the current binding.
async function navigateTo(vm, path) {
    const nav = vm.SFTP.navigate(path);
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === path)[0], { files: [] });
    await vm.drain();
    await nav;
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

test('a DISCONNECTED SSH tab yields no target even with a backend id', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, { id: 'tabDead', type: 'ssh', tabId: 'sessDead', connected: false });
    vm.ctx.TabManager.activeId = 'tabDead';
    assert.equal(vm.SFTP.currentTargetTabId(), null,
        'a dead session must not back the dock (no 无法打开 SFTP toast on switch)');
});

test('a split tab whose focused pane is disconnected yields no target', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, {
        id: 'tabSplitDead', type: 'ssh', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_live', 'ssh', 'sessLive', false),
            Object.assign(splitPane('p_dead', 'ssh', 'sessDead', true), { connected: false }),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabSplitDead';
    assert.equal(vm.SFTP.currentTargetTabId(), null);
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

// ── updateTarget: reflection of the per-tab open set ────────────────────────

test('focusing a non-SSH tab suspends the dock but keeps the tab\'s open state', async () => {
    const vm = await loadSftpVm();
    const btn = stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    assert.equal(vm.SFTP.isOpen, true, 'staging: dock open on sessA');
    assert.ok(vm.SFTP._openTabs.has('tabA'), 'staging: tabA recorded as open');
    assert.ok(btn.classList.contains('visible'), 'button visible on an SSH target');
    assert.ok(btn.classList.contains('on'), 'button pressed while the dock shows that session');

    // Focus moves to a local tab
    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP.isOpen, false, 'dock suspended on a non-SSH focus');
    assert.ok(vm.SFTP._openTabs.has('tabA'), 'the open state survives the suspension');
    assert.equal(vm.els.overlay.classList.contains('open'), false, 'legacy .open class dropped');
    assert.ok(!btn.classList.contains('visible'), 'bar button hides with no SSH target');

    // Refocus the SSH tab: the dock restores through a fresh bind of sessA,
    // returning to the directory the panel last listed (a pinned path would
    // still take precedence — covered by the pin tests).
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'dock restored on the SSH refocus');
    assert.equal(vm.SFTP._tabId, 'sessA');
    const reopen = vm.pending('sftp-readdir', k => k.args.tabId === 'sessA' && k.args.path === '/home/x')[0];
    assert.ok(reopen, 'the restore navigates back to the remembered directory');
});

test('updateTarget never auto-opens a tab the user never opened', async () => {
    const vm = await loadSftpVm();
    const btn = stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'no dock without an explicit open');
    assert.equal(vm.of('sftp-open').length, 0, 'no session request either');
    assert.ok(btn.classList.contains('visible'), 'the button still shows the eligible target');
    assert.ok(!btn.classList.contains('on'), 'button not pressed while the dock is closed');
});

test('focus moving to another SSH pane of the SAME tab rebinds the dock to that session', async () => {
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

    // Focus moves to pane B: updateTarget rebinds to sessB (content binding
    // follows the focused pane WITHIN a tab whose SFTP is open)
    const panes = vm.ctx.getAllPanes(vm.ctx.TabManager.getActive());
    panes.forEach(p => p.focused = p.id === 'p_b');
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP._tabId, 'sessB', 'dock rebound to the newly focused pane');
    const rebind = vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0];
    assert.ok(rebind, 'the rebind issues its own sftp-open request');
});

test('switching to an SSH tab that never opened SFTP shows no dock and fires no request', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    assert.equal(vm.SFTP.isOpen, true, 'staging: dock open on tabA/sessA');

    // Switch to another SSH tab that never opened the dock: hidden, and no
    // sftp-open may be issued for its session.
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'no dock on a tab that never opened SFTP');
    assert.equal(vm.of('sftp-open').filter(k => k.args.tabId === 'sessB').length, 0,
        'no sftp-open invoke for the unopened tab');
    assert.ok(vm.SFTP._openTabs.has('tabA'), 'the opened tab keeps its open state');
});

test('switching back to the opened tab restores the dock at the remembered directory', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    await navigateTo(vm, '/var/log');
    assert.equal(vm.SFTP._lastPath['sessA'], '/var/log', 'staging: memory recorded');

    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'dock hidden on the unopened tab');

    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'dock restored on the opened tab');
    assert.equal(vm.SFTP._tabId, 'sessA');
    const restore = vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0];
    assert.ok(restore, 'the restore navigates back to the remembered directory, not the home dir');
    vm.settle(restore, { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/var/log', 'the listing lands on the restored directory');
});

test('suspend/restore returns to the directory the view was browsing', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    // Browse away from the open result's home directory.
    await navigateTo(vm, '/var/log');
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
    assert.equal(vm.SFTP._lastPath['sessA'], '/var/log', 'memory intact after the round trip');
});

test('per-session directory memory survives SSH↔SSH tab switches', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    await navigateTo(vm, '/var/log');

    // Open tabB's dock too and browse elsewhere: both sessions remember
    // their own directory.
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget(); // tabB not opened yet → hidden
    assert.equal(vm.SFTP.isOpen, false);
    vm.SFTP.toggleFromBar();
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/b', files: [] });
    await vm.drain();
    await navigateTo(vm, '/opt');

    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP._tabId, 'sessA');
    assert.ok(vm.pending('sftp-readdir', k => k.args.tabId === 'sessA' && k.args.path === '/var/log')[0],
        'sessA restores its own directory');
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0], { files: [] });
    await vm.drain();

    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP._tabId, 'sessB');
    assert.ok(vm.pending('sftp-readdir', k => k.args.tabId === 'sessB' && k.args.path === '/opt')[0],
        'sessB restores its own directory');
});

test('a suspend during the in-flight restore keeps the restore destination', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    await navigateTo(vm, '/var/log');

    // First suspend; the refocus starts the restore navigation and STAYS
    // pending (this._path is still the '/' placeholder).
    mkTab(vm.ctx, { id: 'tabLocal', type: 'local', tabId: 'local_1' });
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.ok(vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0],
        'staging: the restore navigation is in flight');

    // Suspend again before it settles: the memory must keep /var/log, not the
    // placeholder '/' this._path still holds (memory is written only on
    // listing success, so an unsettled restore cannot corrupt it).
    vm.ctx.TabManager.activeId = 'tabLocal';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP._lastPath['sessA'], '/var/log',
        'the in-flight destination is kept, not the placeholder');

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

test('explicit close keeps the per-session memory: reopen resumes it', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    await navigateTo(vm, '/var/log');

    vm.SFTP.close();
    assert.equal(vm.SFTP.isOpen, false, 'dock closed');
    assert.ok(!vm.SFTP._openTabs.has('tabA'), 'the tab left the open set');
    assert.equal(vm.SFTP._lastPath['sessA'], '/var/log',
        'an explicit close keeps the directory memory');

    // Reopen on the same session: the remembered directory wins over a
    // fresh sftp-open at the remote home.
    vm.SFTP.toggleFromBar();
    await vm.drain();
    assert.equal(vm.SFTP.isOpen, true, 'dock reopened');
    const restore = vm.pending('sftp-readdir', k => k.args.path === '/var/log')[0];
    assert.ok(restore, 'the reopen resumes the remembered directory');
    assert.equal(vm.of('sftp-open').filter(k => k.args.tabId === 'sessA').length, 1,
        'only the staging open ever issued sftp-open');
});

test('a remembered directory that no longer lists self-heals to a fresh open', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    await navigateTo(vm, '/gone/dir');
    assert.equal(vm.SFTP._lastPath['sessA'], '/gone/dir', 'staging: memory recorded');

    // Reopen: the restore navigation fails (directory deleted remotely) —
    // the record must drop so the NEXT open goes fresh instead of failing
    // forever.
    vm.SFTP.close();
    vm.SFTP.toggleFromBar();
    await vm.drain();
    const restore = vm.pending('sftp-readdir', k => k.args.path === '/gone/dir')[0];
    assert.ok(restore, 'the reopen first tries the remembered directory');
    vm.fail(restore, 'no such file or directory');
    await vm.drain();
    assert.equal(vm.SFTP._lastPath['sessA'], undefined, 'the failed restore drops the record');
    assert.ok(vm.els.body.innerHTML.includes('加载失败'), 'the failure is surfaced once');

    vm.SFTP.close();
    vm.SFTP.toggleFromBar();
    await vm.drain();
    const fresh = vm.pending('sftp-open', k => k.args.tabId === 'sessA')[0];
    assert.ok(fresh, 'the next open falls back to a fresh sftp-open at the remote home');
    vm.settle(fresh, { path: '/home/x', files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/home/x', 'the fresh listing lands');
});

test('close() closes only the ACTIVE tab\'s dock; another opened tab keeps its state', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');

    // Open tabB's dock too, then close it from tabB.
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.toggleFromBar();
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/b', files: [] });
    await vm.drain();
    assert.ok(vm.SFTP._openTabs.has('tabA') && vm.SFTP._openTabs.has('tabB'), 'staging: both tabs open');

    vm.SFTP.close();
    assert.ok(!vm.SFTP._openTabs.has('tabB'), 'the closed tab left the open set');
    assert.ok(vm.SFTP._openTabs.has('tabA'), 'the other tab\'s open state is untouched');
    assert.equal(vm.SFTP._lastPath['sessA'], '/home/x', 'the other session\'s memory is untouched');

    // Switching back to tabA shows its dock again.
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'tabA\'s dock reflects its own (still open) state');
    assert.equal(vm.SFTP._tabId, 'sessA');
});

test('closing the bound tab hides the dock; the activating neighbor reflects its own state', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.toggleFromBar();
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/b', files: [] });
    await vm.drain();

    // Back to tabA and close it while the dock is bound to its session: the
    // SFTP-side contract of TabManager.closeTab (closeForTab + forgetTabState)
    // must hide the dock and clear only tabA's state.
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/home/x')[0], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._tabId, 'sessA');
    vm.SFTP.closeForTab('tabA');
    vm.SFTP.forgetTabState('tabA', ['sessA']);
    assert.equal(vm.SFTP.isOpen, false, 'the dock hides with the dying tab');
    assert.ok(vm.SFTP._openTabs.has('tabB'), 'the neighbor\'s open state is preserved');
    assert.equal(vm.SFTP._lastPath['sessA'], undefined, 'the closed tab\'s session memory is cleared');

    // The neighbor activates: the dock shows because THAT tab had SFTP open.
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'the neighbor reflects its own open state');
    assert.equal(vm.SFTP._tabId, 'sessB');
});

test('closing the bound tab hides the dock and an UNOPENED neighbor stays dock-free', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    vm.SFTP.closeForTab('tabA');
    vm.SFTP.forgetTabState('tabA', ['sessA']);

    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'a neighbor that never opened SFTP shows no dock');
    assert.equal(vm.of('sftp-open').filter(k => k.args.tabId === 'sessB').length, 0,
        'and issues no session request');
});

test('a BACKGROUND tab\'s teardown never wipes the ACTIVE tab\'s open state', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.toggleFromBar();
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/b', files: [] });
    await vm.drain();

    // Focus returns to tabA (the dock rebinds to sessA), then tabB's session
    // drops and the user switches to it: the dock suspends while the binding
    // still names tabA's session — a background closeTab(A) must tear THAT
    // tab down by name, not guess the active tab.
    vm.ctx.TabManager.activeId = 'tabA';
    vm.SFTP.updateTarget();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/home/x')[0], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._tabId, 'sessA');
    const tabA = vm.ctx.TabManager.tabs.find(t => t.id === 'tabA');
    const tabB = vm.ctx.TabManager.tabs.find(t => t.id === 'tabB');
    tabB.connected = false;
    vm.ctx.TabManager.activeId = 'tabB';
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'staging: dock suspended on the invalid target');
    assert.equal(vm.SFTP._tabId, 'sessA', 'staging: the suspended binding still names tabA\'s session');

    // The real closeTab teardown pair, aimed at the background tabA.
    vm.ctx.TabManager._closeSftpForSessions(tabA, ['sessA']);
    vm.SFTP.forgetTabState('tabA', ['sessA']);
    assert.equal(vm.SFTP.isOpen, false, 'the dock hides with the dying binding');
    assert.equal(vm.SFTP._tabId, null, 'the dead binding drops');
    assert.ok(vm.SFTP._openTabs.has('tabB'),
        'the ACTIVE tab\'s open state survives the background teardown');
    assert.equal(vm.SFTP._lastPath['sessA'], undefined, 'the dying tab\'s memory is cleared');

    // tabB's session recovers (ssh-connected → updateTarget in ipc.js): the
    // dock returns for tabB.
    tabB.connected = true;
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, true, 'the dock returns for the recovering active tab');
    assert.equal(vm.SFTP._tabId, 'sessB');
});

test('reconnect teardown: the new session\'s ssh-connected does not auto-reopen the dock', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');

    // reconnectTab's SFTP contract: the tab's open state and the old
    // session's memory go with the discarded generation.
    const tabA = vm.ctx.TabManager.tabs.find(t => t.id === 'tabA');
    vm.ctx.TabManager._closeSftpForSessions(tabA, ['sessA']);
    vm.SFTP.forgetTabState('tabA', ['sessA']);
    assert.equal(vm.SFTP.isOpen, false);
    assert.ok(!vm.SFTP._openTabs.has('tabA'));

    // The reconnect lands as a NEW backend id on the same tab; ipc.js's
    // ssh-connected hook re-runs updateTarget — the dock must NOT reopen.
    tabA.tabId = 'sessA2';
    tabA.connected = true;
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'no auto-reopen after a reconnect');
    assert.equal(vm.of('sftp-open').filter(k => k.args.tabId === 'sessA2').length, 0,
        'no session request for the new generation either');
});

test('a dead (disconnected) SSH tab suspends the dock silently and keeps the open state', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    vm.ctx.TabManager.activeId = 'tabA';
    await openDock(vm, 'sessA');

    // The session dies: updateTarget treats it like any non-SSH target —
    // dock hidden, no request, no error toast, open state preserved.
    const tabA = vm.ctx.TabManager.tabs.find(t => t.id === 'tabA');
    tabA.connected = false;
    assert.equal(vm.SFTP.currentTargetTabId(), null, 'a dead session is no dock target');
    vm.SFTP.updateTarget();
    assert.equal(vm.SFTP.isOpen, false, 'dock hidden on the dead tab');
    assert.equal(vm.of('sftp-open').length, 1, 'no additional session request');
    assert.equal(vm.toasts.length, 0, 'no 无法打开 SFTP toast from merely switching');
    assert.ok(vm.SFTP._openTabs.has('tabA'), 'the open state survives the dead focus');

    // The toggle is a no-op there.
    vm.SFTP.toggleFromBar();
    await vm.drain();
    assert.equal(vm.SFTP.isOpen, false, 'toggle does nothing without a live target');
    assert.equal(vm.of('sftp-open').length, 1, 'still no session request');
});

test('pane close: the dock rebinds to the remaining connected SSH pane, open state kept', async () => {
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
    await openDock(vm, 'sessB');
    assert.equal(vm.SFTP._tabId, 'sessB');

    // Simulate _closePane's SFTP contract: the dying session's memory goes,
    // focus hands to the sibling, updateTarget rebinds (the tab's open state
    // is never touched by a pane close).
    vm.SFTP.forgetSession('sessB');
    const tab = vm.ctx.TabManager.getActive();
    tab.splitRoot.children[1] = splitPane('p_a', 'ssh', 'sessA', true); // only pane A remains, focused
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP._tabId, 'sessA', 'rebound to the surviving focused pane');
    const rebind = vm.pending('sftp-open', k => k.args.tabId === 'sessA')[0];
    assert.ok(rebind, 'the rebind issues its own sftp-open request');
    assert.ok(vm.SFTP._openTabs.has('tabSplit'), 'the tab\'s open state survives the pane close');
    assert.equal(vm.SFTP._lastPath['sessB'], undefined, 'the dead pane\'s memory is cleared');
});

test('pane close without a connected SSH survivor hides the dock, open state kept', async () => {
    const vm = await loadSftpVm();
    stageToggleBtn(vm.ctx);
    mkTab(vm.ctx, {
        id: 'tabSplit2', type: 'local', tabId: null,
        splitRoot: { orientation: 'h', children: [
            splitPane('p_loc', 'local', 'local_2', false),
            splitPane('p_ssh', 'ssh', 'sessB', true),
        ] },
    });
    vm.ctx.TabManager.activeId = 'tabSplit2';
    await openDock(vm, 'sessB');
    assert.equal(vm.SFTP.isOpen, true);

    vm.SFTP.forgetSession('sessB');
    const tab = vm.ctx.TabManager.getActive();
    tab.splitRoot.children = [splitPane('p_loc', 'local', 'local_2', true)]; // local survivor focused
    vm.SFTP.updateTarget();

    assert.equal(vm.SFTP.isOpen, false, 'no connected SSH pane → dock hidden');
    assert.ok(vm.SFTP._openTabs.has('tabSplit2'), 'the tab\'s open state survives');
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
    assert.ok(!vm.SFTP._openTabs.has('tabA'));

    // No SSH target: the toggle is a no-op
    mkTab(vm.ctx, { id: 'tabSet', type: 'settings' });
    vm.ctx.TabManager.activeId = 'tabSet';
    vm.SFTP.toggleFromBar();
    await drain();
    assert.equal(vm.SFTP.isOpen, false);
    assert.equal(vm.of('sftp-open').length, 1, 'no extra session request without a target');
});
