// SFTP panel fixes: mkdir edit protection + commit snapshot (T12), download
// session snapshot (T13), upload overwrite confirmation (T14), close-time
// focus liveness check (T38) and the dead-session panel state (T40). All
// driven through the REAL src/renderer/sftp.js in the shared VM seam — only
// the environment is faked (synthetic sessions, deferred invoke bus, manual
// timer firing). No real SSH, files, dialogs or clipboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const F = (name) => ({ name, isDir: false, size: 1, mtime: 0 });

async function openOn(vm, tabId, path, files) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === tabId)[0], { path, files: files || [] });
    await vm.drain();
    await p;
}

function mkdirRow(vm) {
    const row = vm.ctx.document.getElementById('sftp-mkdir-row');
    assert.ok(row, 'mkdir row mounted');
    const input = row.querySelector('input');
    assert.ok(input, 'mkdir input materialized');
    return { row, input };
}

function pressEnter(input) {
    input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
}

function captureConfirms(vm) {
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk, okText) => confirms.push({ msg, onOk, okText });
    return confirms;
}

// ── T12: mkdir inline edit protection + commit snapshot ─────────────────────

test('T12: mkdir entry is refused while the initial open is still loading', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    await vm.drain(); // open request pending: the view is loading, _listed false

    vm.SFTP.mkdir();
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null,
        'no inline input mounts while a user view request owns the view');
    assert.equal(vm.SFTP._mkdir, null, 'no edit state either');

    vm.settle(vm.pending('sftp-open')[0], { path: '/home/a', files: [] });
    await vm.drain();
    await p;

    vm.SFTP.mkdir();
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'entry works once the load settled');
});

test('T12: mkdir commit is refused while the listing never loaded, then re-arms via a background refresh', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    await vm.drain();
    vm.fail(vm.pending('sftp-open')[0], new Error('SFTP not available'));
    await vm.drain();
    await p;
    assert.equal(vm.SFTP._listed, false, 'failed open leaves no valid listing');

    vm.SFTP.mkdir(); // no view request in flight: entry is allowed on the failure state
    const { input } = mkdirRow(vm);
    input.value = 'early';
    pressEnter(input);
    await vm.drain();

    assert.equal(vm.of('sftp-mkdir').length, 0,
        `no mkdir command while the listing is not ready: ${JSON.stringify(vm.of('sftp-mkdir').map(c => c.args))}`);
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'row kept for a retry');
    assert.ok(vm.toasts.some(t => t.isErr && t.msg.includes('尚未加载')),
        `refusal toast shown: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);

    // Recovery path: a background refresh lands a real listing while the row
    // stays open, re-arming the snapshot — the retry then commits normally.
    const r = vm.SFTP.refresh();
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    await r;
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'row survives the background refresh');
    pressEnter(input);
    await vm.drain();
    const mk = vm.of('sftp-mkdir')[0];
    assert.ok(mk, 'retry commits after the listing landed');
    assert.equal(mk.args.tabId, 'sessA');
    assert.equal(mk.args.path, '/early', 'commit targets the directory of the landed listing');
});

test('T12: a background cwd follow preserves the mkdir input and re-targets its commit', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);

    vm.SFTP.mkdir();
    const { input } = mkdirRow(vm);
    input.value = 'newdir';

    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp/followed' });
    await vm.drain(); // follow readdir pending; the row must survive the loading swap
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'row survives the follow loading swap');

    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'row survives the listing re-render');
    assert.equal(vm.SFTP._mkdir && vm.SFTP._mkdir.base, '/tmp/followed',
        'the pending commit is re-targeted at the directory now on screen');
    assert.equal(vm.SFTP._mkdir.moving, false, 'the hold/restore cycle closed cleanly');
    assert.equal(input.value, 'newdir', 'typed value intact');

    pressEnter(input);
    await vm.drain();
    const mk = vm.of('sftp-mkdir')[0];
    assert.ok(mk, 'commit dispatched');
    assert.equal(mk.args.tabId, 'sessA');
    assert.equal(mk.args.path, '/tmp/followed/newdir', 'commit uses the re-targeted snapshot, not a stale directory');
});

test('T12: a user navigation retires the pending mkdir edit', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    vm.SFTP.mkdir();
    assert.ok(vm.SFTP._mkdir, 'edit state present');
    const nav = vm.SFTP.navigate('/elsewhere'); // user navigation
    await vm.drain();
    assert.equal(vm.SFTP._mkdir, null, 'the user navigation ends the edit (breadcrumb parity)');
    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    await nav;
});

// ── T13: download session snapshot ──────────────────────────────────────────

test('T13: download targets the session snapshotted before the save dialog', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);

    const dl = vm.SFTP.download('/srv/app/a.txt', 'a.txt');
    await vm.drain();
    assert.ok(vm.pending('show-save-dialog').length, 'save dialog open');

    // The panel rebinds to another session while the dialog is open.
    const p = vm.SFTP.open('sessB');
    await vm.drain();

    vm.settle(vm.pending('show-save-dialog')[0], { canceled: false, filePath: 'D:/out/a.txt' });
    await vm.drain();

    const call = vm.pending('sftp-download')[0];
    assert.ok(call, 'download dispatched after the dialog confirmed');
    assert.equal(call.args.tabId, 'sessA',
        `transfer goes to the session the user clicked, not the post-dialog binding: ${JSON.stringify(call.args)}`);
    assert.equal(vm.TransferManager._transfers[0].tabId, 'sessA', 'transfer entry owned by the clicked session');
    vm.settle(call, { total: 1 });
    await vm.drain();
    await dl;
    // Settle the rebound panel's own open so no promise is left awaiting.
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/b', files: [] });
    await vm.drain();
    await p;
});

// ── T14: upload overwrite confirmation ──────────────────────────────────────

test('T14: uploading same-name files asks once and holds the batch until confirmed', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    const confirms = captureConfirms(vm);

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/local/a.txt', 'D:/local/b.txt'] });
    await vm.drain();

    assert.equal(confirms.length, 1, 'exactly one confirmation for the whole batch');
    assert.ok(confirms[0].msg.includes('1'), `message carries the conflict count: ${confirms[0].msg}`);
    assert.equal(confirms[0].okText, '覆盖');
    assert.equal(vm.pending('sftp-upload').length, 0, 'no upload starts before the confirmation');

    confirms[0].onOk();
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];
    assert.ok(u1 && u1.args.remotePath === '/srv/app/a.txt', 'conflict file proceeds after OK');
    vm.settle(u1, {});
    await vm.drain();
    const u2 = vm.pending('sftp-upload')[0];
    assert.ok(u2 && u2.args.remotePath === '/srv/app/b.txt', 'the rest of the batch continues');
    vm.settle(u2, {});
    await vm.drain();
    await up;
});

test('T14: dismissing the overwrite confirmation drops the batch', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    const confirms = captureConfirms(vm);

    const up = vm.SFTP.upload(); // deliberately never awaited to completion (cancel leaves it pending)
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/local/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 1, 'confirmation requested');
    // Cancel path: onOk never runs (showConfirm's cancel/backdrop/Escape
    // semantics) — the batch must not upload anything.
    await vm.drain();
    assert.equal(vm.of('sftp-upload').length, 0, 'cancelled confirmation uploads nothing');
    assert.equal(vm.TransferManager._transfers.length, 0, 'no transfer entries created');
    void up;
});

test('T14: an upload without remote name collisions never asks (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('c.txt')]);
    const confirms = captureConfirms(vm);

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/local/a.txt', 'D:/local/b.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 0, 'no confirmation on the conflict-free path');
    const u1 = vm.pending('sftp-upload')[0];
    assert.ok(u1, 'upload starts immediately');
    vm.settle(u1, {});
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await up;
});

test('T14: a dropped batch with a remote name collision confirms before uploading', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('one.txt')]);
    const confirms = captureConfirms(vm);

    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }] },
    });
    await vm.drain();
    assert.equal(confirms.length, 1, 'drop batch asks before overwriting');
    assert.ok(confirms[0].msg.includes('1'), `count in message: ${confirms[0].msg}`);
    assert.equal(vm.of('sftp-upload').length, 0, 'nothing uploads before the confirmation');

    confirms[0].onOk();
    await vm.drain();
    const u = vm.pending('sftp-upload')[0];
    assert.ok(u && u.args.localPath === 'D:/synthetic/one.txt', 'confirmed drop proceeds to upload');
    vm.settle(u, {});
    await vm.drain();
});

// ── T38: SFTP.close delayed focus validates at fire time ────────────────────

test('T38: close focus does not throw when the tab terminal is nulled inside the delay', async () => {
    const vm = await loadSftpVm();
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    let focused = 0;
    tab.term = { focus() { focused++; } };
    vm.SFTP.close();
    tab.term = null; // closed/reconnected inside the 50ms window
    assert.doesNotThrow(() => vm.ctx.__tq.advance(50), 'fire-time null check must not dereference a null term');
    assert.equal(focused, 0, 'no focus call on a dead term slot');
});

test('T38: close focus still lands when the terminal is alive (control)', async () => {
    const vm = await loadSftpVm();
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    let focused = 0;
    tab.term = { focus() { focused++; } };
    vm.SFTP.close();
    vm.ctx.__tq.advance(50);
    assert.equal(focused, 1, 'focus lands once');
});

test('T38: close focus on a split tab validates the focused pane at fire time', async () => {
    const vm = await loadSftpVm();
    vm.ctx.TabManager.tabs.push({
        id: 'tabSplit', tabId: null, name: 'Split', type: 'ssh', connected: true,
        splitRoot: {
            orientation: 'row',
            children: [
                { id: 'paneL', tabId: 'sessL', name: 'L', type: 'ssh', focused: true },
                { id: 'paneR', tabId: 'sessR', name: 'R', type: 'ssh' },
            ],
        },
    });
    vm.ctx.TabManager.activeId = 'tabSplit';
    const pane = vm.ctx.getAllPanes(vm.ctx.TabManager.tabs.find(t => t.id === 'tabSplit'))[0];
    let focused = 0;
    pane.term = { focus() { focused++; } };
    vm.SFTP.close();
    pane.term = null; // pane closed inside the delay
    assert.doesNotThrow(() => vm.ctx.__tq.advance(50), 'pane term null at fire time is guarded');
    assert.equal(focused, 0);
});

test('T38: close focus swallows the throw of a disposed terminal', async () => {
    const vm = await loadSftpVm();
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    const term = new vm.ctx.Terminal(); // RealTerm: focus() throws once disposed
    term.dispose();
    tab.term = term;
    vm.SFTP.close();
    assert.doesNotThrow(() => vm.ctx.__tq.advance(50), 'disposed-terminal focus throw is contained');
    assert.equal(term.focused, false);
});

// ── T40: explicit dead-session state for the panel ──────────────────────────

function deadReason(vm, tabId, reason) {
    vm.emit('ssh-disconnect-reason', { tabId, kind: 'error', reason: reason || 'connection reset', at: 0 });
}

test('T40: a disconnect reason for the dead owner session replaces the listing with a dead state', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt'), F('b.txt')]);
    assert.ok(vm.els.body.children.length > 0, 'listing rendered before the disconnect');

    deadReason(vm, 'sessA');
    await vm.drain();

    assert.ok(vm.els.body.innerHTML.includes('会话已断开'),
        `explicit dead state shown: ${vm.els.body.innerHTML}`);
    assert.equal(vm.SFTP._files.length, 0, 'dead session listing cleared');
    assert.equal(vm.SFTP._listed, false, 'no valid listing claimed anymore');
    assert.equal(vm.SFTP._sessionDead, true, 'panel marked dead');

    // Further navigations are refused: no readdir churn, no error toasts.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 0, 'dead panel issues no navigations');
    assert.ok(vm.els.body.innerHTML.includes('会话已断开'), 'dead state stays on screen');
});

test('T40: a late response of the dead binding cannot repaint over the dead state', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('live.txt')]);

    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd, 'follow in flight when the session dies');

    deadReason(vm, 'sessA');
    await vm.drain();
    assert.ok(vm.els.body.innerHTML.includes('会话已断开'), 'dead state entered');

    vm.settle(rd, { files: [F('zombie.txt')] }); // late success of the dead binding
    await vm.drain();
    assert.ok(!vm.els.body.children.some(c => (c.innerHTML || '').includes('zombie')),
        'the late response renders nothing');
    assert.equal(vm.SFTP._files.length, 0, 'files state untouched by the late response');
    assert.equal(vm.SFTP._path, '/srv/app', 'path not moved by the late response');
});

test('T40: the dead state is ignored while the owner is still connected (race control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    tab.connected = true; // reason raced ahead of ssh-disconnected

    deadReason(vm, 'sessA');
    await vm.drain();
    assert.ok(!vm.els.body.innerHTML.includes('会话已断开'), 'no dead state while connected');
    assert.equal(vm.SFTP._files.length, 1, 'listing intact');
});

test('T40: user-initiated closes and other sessions do not trigger the dead state (controls)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);

    vm.emit('ssh-disconnect-reason', { tabId: 'sessA', kind: 'closed', reason: 'closed by user', at: 0 });
    await vm.drain();
    assert.ok(!vm.els.body.innerHTML.includes('会话已断开'), 'kind "closed" is excluded');

    deadReason(vm, 'sessB'); // another session's disconnect
    await vm.drain();
    assert.ok(!vm.els.body.innerHTML.includes('会话已断开'), 'other sessions do not steer the panel');
    assert.equal(vm.SFTP._files.length, 1, 'listing intact');
});

test('T40: a fresh open() after the death rebinds and clears the dead state', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    deadReason(vm, 'sessA');
    await vm.drain();
    assert.equal(vm.SFTP._sessionDead, true);

    await openOn(vm, 'sessB', '/home/b', [F('b.txt')]);
    assert.equal(vm.SFTP._sessionDead, false, 'rebinding clears the dead state');
    assert.equal(vm.SFTP._tabId, 'sessB');
    assert.ok(vm.els.body.children.some(c => (c.innerHTML || '').includes('b.txt')), 'new session lists normally');
});

// ── T26 follow-up: owner-pane gating in split tabs ──────────────────────────
// tab.connected is AGGREGATED across panes (a live sibling keeps it true), so
// the old `dead = !tab.connected` gate stopped marking a dead split pane's
// panel dead. The gate now reads the OWNING pane's flag, same predicate as
// the terminal's reason line in ipc.js. Panes are hand-staged leaf shapes:
// the listener only walks them via getAllPanes.

function stageSplitOn(vm, ownerConnected) {
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    tab.splitRoot = {
        orientation: 'h',
        children: [
            { id: 'paneA1', tabId: 'sessA', connected: ownerConnected },
            { id: 'paneA2', tabId: 'sessC', connected: true },
        ],
        ratios: [0.5, 0.5],
    };
    // Split ownership: backend ids live on the panes; the aggregated tab flag
    // stays true while the sibling pane is alive.
    tab.tabId = null;
    tab.connected = true;
    return tab;
}

test('T26: a dead owner pane marks the panel dead even with a live split sibling', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    stageSplitOn(vm, false); // owner pane confirmed disconnected, sibling alive

    deadReason(vm, 'sessA');
    await vm.drain();

    assert.equal(vm.SFTP._sessionDead, true, 'owner-pane death is detected through the pane gate');
    assert.ok(vm.els.body.innerHTML.includes('会话已断开'), 'dead state shown');
    assert.equal(vm.SFTP._files.length, 0, 'dead session listing cleared');
});

test('T26: a split pane whose disconnect flip has not landed yet does not go dead (race control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);
    stageSplitOn(vm, undefined); // reason raced ahead of ssh-disconnected

    deadReason(vm, 'sessA');
    await vm.drain();

    assert.equal(vm.SFTP._sessionDead, false, 'only connected === false confirms dead');
    assert.equal(vm.SFTP._files.length, 1, 'listing intact');
});
