// SFTP row/blank context menu (right-click): selection + menu only — the
// gesture must never trigger the row's left-click semantics (navigate /
// download). File rows offer download/rename/delete, directory rows
// open/rename/delete, the immutable ".." row offers nothing, and the blank
// list area offers mkdir/upload/refresh. Actions carry the right-click snapshot
// ({tabId, path, name, isDir} + listing names) so an async dialog or a panel
// rebind mid-flight cannot retarget them at the wrong session (upload-owner
// contract). Driven through the REAL src/renderer/sftp.js in the shared VM
// seam; the real src/renderer/context-menu.js (when present) supplies the
// shared menu surface. No real SSH, files, dialogs or clipboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const CONTEXT_MENU_SRC = existsSync(new URL('../src/renderer/context-menu.js', import.meta.url))
    ? readFileSync(new URL('../src/renderer/context-menu.js', import.meta.url), 'utf8')
    : null;

async function loadMenuVm() {
    const vmx = await loadSftpVm();
    if (CONTEXT_MENU_SRC) {
        vm.runInContext(CONTEXT_MENU_SRC, vmx.ctx, { filename: 'context-menu.js' });
        vmx.ctx.ContextMenu = vm.runInContext('ContextMenu', vmx.ctx);
    }
    return vmx;
}

async function openOn(vm, tabId, path, files) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === tabId)[0], { path, files: files || [] });
    await vm.drain();
    await p;
}

const FILES = [
    { name: 'notes.txt', isDir: false, size: 5, mtime: 0 },
    { name: 'assets', isDir: true, size: 0, mtime: 0 },
    { name: 'z-report.md', isDir: false, size: 9, mtime: 0 },
];

function rowItems(vm) {
    return vm.els.body.children.filter(c => c.classList.contains('sftp-item'));
}

function fileRow(vm, name) {
    // File rows are the ones carrying the hover download button.
    return rowItems(vm).find(r =>
        r.children.some(c => c.classList && c.classList.contains('sftp-item-dl')) &&
        rowText(r).includes(name));
}

function rowText(row) {
    // innerHTML is string-only in the seam; the name is inside it.
    return String(row.innerHTML || '');
}

function menuEl(vm) {
    return vm.ctx.document.getElementById('app-context-menu');
}

function menuLabels(vm) {
    const menu = menuEl(vm);
    assert.ok(menu, 'context menu element (#app-context-menu) mounted');
    return menu.children
        .filter(c => c.classList.contains('tab-context-item'))
        .map(c => String(c.textContent || ''));
}

function rightClick(target) {
    let prevented = false, stopped = false;
    target.dispatch('contextmenu', {
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
        clientX: 40, clientY: 40,
        target,
    });
    return { prevented, stopped };
}

function clickItem(vm, label) {
    const menu = menuEl(vm);
    const item = menu.children.find(c => String(c.textContent || '') === label);
    assert.ok(item, `menu item "${label}" present`);
    item.dispatch('click', { preventDefault() {}, stopPropagation() {} });
}

// ── Gesture contract: select + menu, never the left-click semantics ──

test('file row contextmenu selects the row and opens 下载/重命名/删除 without navigating or downloading', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    assert.ok(row, 'notes.txt row rendered');

    const mark = vm.calls.length;
    const gesture = rightClick(row);
    assert.equal(gesture.prevented, true, 'contextmenu default must be prevented');
    assert.equal(gesture.stopped, true, 'row handler keeps the body-level blank-area menu from stacking');
    assert.deepEqual(menuLabels(vm), ['下载', '重命名', '删除']);
    assert.equal(row.classList.contains('selected'), true, 'right-clicked row carries .selected');
    const others = rowItems(vm).filter(r => r !== row);
    assert.ok(others.every(r => !r.classList.contains('selected')), 'selection is single');
    // THE regression pin: right-click must not fire the left-click actions.
    const cmds = vm.calls.slice(mark).map(c => c.cmd);
    assert.ok(!cmds.includes('sftp-readdir'), `right-click must not navigate (saw ${cmds})`);
    assert.ok(!cmds.includes('show-save-dialog'), `right-click must not download (saw ${cmds})`);
    assert.ok(!cmds.includes('sftp-download'), `right-click must not start a transfer (saw ${cmds})`);
});

test('directory row contextmenu offers 打开/重命名/删除; ".." stays immutable', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const dirRow = rowItems(vm).find(r => !r.children.some(c => c.classList && c.classList.contains('sftp-item-dl')) && rowText(r).includes('assets'));
    assert.ok(dirRow, 'assets dir row rendered');
    const gesture = rightClick(dirRow);
    assert.equal(gesture.prevented, true);
    assert.deepEqual(menuLabels(vm), ['打开', '重命名', '删除']);

    // The ".." row is not a mutable target: no menu, still suppressed.
    const upRow = rowItems(vm).find(r => rowText(r).includes('..'));
    assert.ok(upRow, '".." row rendered');
    const upGesture = rightClick(upRow);
    assert.equal(upGesture.prevented, true, 'browser menu must not appear on ".."');
    assert.equal(menuEl(vm), null, 'no menu for the immutable parent row');
});

test('blank list area contextmenu offers 新建目录/上传/刷新 and each action works', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);

    const gesture = rightClick(vm.els.body);
    assert.equal(gesture.prevented, true);
    assert.deepEqual(menuLabels(vm), ['新建目录', '上传', '刷新']);

    // The mkdir action opens the real inline row editor.
    clickItem(vm, '新建目录');
    assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'), 'mkdir row opened from the blank menu');
    vm.ctx.document.getElementById('sftp-mkdir-row').remove(); // reset for the next action
    vm.SFTP._mkdir = null;

    // The upload action requests the real file picker (no real dialog in the VM).
    rightClick(vm.els.body);
    clickItem(vm, '上传');
    await vm.drain();
    assert.ok(vm.pending('show-open-dialog').length === 1, 'upload asked for the file picker');
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: true, filePaths: [] });
    await vm.drain();

    // Refresh issues a background readdir of the current directory.
    rightClick(vm.els.body);
    clickItem(vm, '刷新');
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd, 'refresh issued a readdir');
    assert.equal(rd.args.tabId, 'sessA');
    assert.equal(rd.args.path, '/srv/app');
});

test('menu 下载 uses the snapshot session even after the panel rebinds mid-menu', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    rightClick(row);

    // Rebind to another session while the menu is still open.
    const p = vm.SFTP.open('sessB');
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/bob', files: [] });
    await vm.drain();
    await p;

    clickItem(vm, '下载');
    await vm.drain();
    const dlg = vm.pending('show-save-dialog')[0];
    assert.ok(dlg, 'save dialog requested');
    assert.equal(dlg.args.defaultPath, 'notes.txt');
    vm.settle(dlg, { canceled: false, filePath: 'C:/dl/notes.txt' });
    await vm.drain();
    const dl = vm.pending('sftp-download')[0];
    assert.ok(dl, 'sftp-download started');
    assert.equal(dl.args.tabId, 'sessA', 'download targets the session captured at right-click');
    assert.equal(dl.args.remotePath, '/srv/app/notes.txt');
    vm.settle(dl, { error: 'Transfer cancelled' });
    await vm.drain();
});

// ── Inline rename ──

function startRename(vm, row) {
    rightClick(row);
    clickItem(vm, '重命名');
    const input = row.children.find(c => c.tagName === 'INPUT');
    assert.ok(input, 'rename input mounted in the row');
    return input;
}

function pressKey(input, key) {
    input.dispatch('keydown', { key, preventDefault() {}, stopPropagation() {} });
}

test('rename commits through sftp-rename with the captured session/path and refreshes the owner view', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    const input = startRename(vm, row);
    assert.equal(input.value, 'notes.txt', 'editor prefilled with the current name');

    input.value = 'diary.txt';
    pressKey(input, 'Enter');
    await vm.drain();
    const rn = vm.pending('sftp-rename')[0];
    assert.ok(rn, 'sftp-rename invoked');
    assert.deepEqual({ tabId: rn.args.tabId, oldPath: rn.args.oldPath, newPath: rn.args.newPath },
        { tabId: 'sessA', oldPath: '/srv/app/notes.txt', newPath: '/srv/app/diary.txt' });
    assert.ok(!row.children.some(c => c.tagName === 'INPUT'), 'editor closed on commit');

    vm.settle(rn, { ok: true });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd, 'success refreshed the owning view');
    assert.equal(rd.args.tabId, 'sessA');
    assert.equal(rd.args.path, '/srv/app');
});

test('rename rejects empty/./../slash/NUL names and existing targets without invoking', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const bad = ['', '.', '..', 'sub/dir', 'nul\0name', 'assets'];
    for (const value of bad) {
        const row = fileRow(vm, 'notes.txt');
        const input = startRename(vm, row);
        input.value = value;
        pressKey(input, 'Enter');
        await vm.drain();
        assert.equal(vm.pending('sftp-rename').length, 0, `rename "${JSON.stringify(value)}" must not reach the backend`);
        assert.ok(row.children.some(c => c.tagName === 'INPUT'), `editor stays open after refusing "${JSON.stringify(value)}"`);
        assert.ok(vm.toasts.some(t => t.isErr), `refusal of "${JSON.stringify(value)}" explains itself`);
        vm.toasts.length = 0;
        pressKey(input, 'Escape'); // close for the next case
    }
    // Unchanged name: a no-op close, still no invoke, no error toast.
    const row = fileRow(vm, 'notes.txt');
    const input = startRename(vm, row);
    input.value = 'notes.txt';
    pressKey(input, 'Enter');
    await vm.drain();
    assert.equal(vm.pending('sftp-rename').length, 0);
    assert.ok(!row.children.some(c => c.tagName === 'INPUT'), 'unchanged name closes the editor');
    assert.equal(vm.toasts.length, 0, 'unchanged name is not an error');
});

test('rename passes names VERBATIM — no trimming, `a` and `a ` stay distinct', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    // Leading/trailing/inner spaces travel byte-for-byte: a trimming client
    // would silently retarget `a` renames at the wrong file.
    const cases = [
        [' diary ', '/srv/app/ diary '],
        ['  ', '/srv/app/  '],
        ['notes .txt', '/srv/app/notes .txt'],
    ];
    for (const [typed, expectedPath] of cases) {
        const row = fileRow(vm, 'notes.txt');
        const input = startRename(vm, row);
        input.value = typed;
        pressKey(input, 'Enter');
        await vm.drain();
        const rn = vm.pending('sftp-rename')[0];
        assert.ok(rn, `rename "${JSON.stringify(typed)}" must reach the backend (no silent trim refusal)`);
        assert.equal(rn.args.oldPath, '/srv/app/notes.txt');
        assert.equal(rn.args.newPath, expectedPath, `newPath must be verbatim for "${JSON.stringify(typed)}"`);
        vm.settle(rn, { ok: true });
        await vm.drain();
        vm.settle(vm.pending('sftp-readdir')[0], { files: FILES });
        await vm.drain();
        vm.toasts.length = 0;
    }
});

test('rename keydown ignores IME composition events (Enter no commit, Escape no cancel)', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    let row = fileRow(vm, 'notes.txt');
    let input = startRename(vm, row);
    input.value = 'composing-name';
    input.dispatch('keydown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() {} });
    await vm.drain();
    assert.equal(vm.pending('sftp-rename').length, 0, 'composing Enter must not commit');

    input.dispatch('keydown', { key: 'Escape', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() {} });
    assert.ok(row.children.some(c => c.tagName === 'INPUT'), 'composing Escape must not cancel the editor');
    assert.equal(vm.pending('sftp-rename').length, 0);

    // A plain Enter after the composition ends still commits.
    input.value = 'committed.txt';
    pressKey(input, 'Enter');
    await vm.drain();
    const rn = vm.pending('sftp-rename')[0];
    assert.ok(rn, 'plain Enter commits after composition');
    assert.equal(rn.args.newPath, '/srv/app/committed.txt');
});

test('rename cancels on Escape and on blur without invoking', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    let row = fileRow(vm, 'notes.txt');
    let input = startRename(vm, row);
    input.value = 'typed-then-esc.txt';
    pressKey(input, 'Escape');
    assert.ok(!row.children.some(c => c.tagName === 'INPUT'), 'Escape closes the editor');
    assert.equal(vm.pending('sftp-rename').length, 0);

    row = fileRow(vm, 'notes.txt');
    input = startRename(vm, row);
    input.value = 'typed-then-blur.txt';
    input.dispatch('blur', {});
    await vm.drain();
    assert.ok(!row.children.some(c => c.tagName === 'INPUT'), 'blur cancels the editor');
    assert.equal(vm.pending('sftp-rename').length, 0);
});

test('a background listing refresh during rename cancels the edit safely instead of committing', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    const input = startRename(vm, row);
    input.value = 'half-typed.txt';

    // cwd follow → navigate → re-render while the editor is open.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/elsewhere' });
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/elsewhere')[0], { files: [] });
    await vm.drain();

    assert.equal(vm.pending('sftp-rename').length, 0, 'no rename must be committed by a background refresh');
    assert.equal(vm.toasts.filter(t => t.isErr).length, 0, 'the safe cancel is silent');
    // Enter on the detached editor must never reach the backend either.
    pressKey(input, 'Enter');
    await vm.drain();
    assert.equal(vm.pending('sftp-rename').length, 0);
});

test('session death during rename cancels the edit without invoking', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    const input = startRename(vm, row);
    input.value = 'doomed.txt';

    // Mark the bound session dead through the real listener (dead pane state).
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    tab.connected = false;
    vm.emit('ssh-disconnect-reason', { tabId: 'sessA', kind: 'error', reason: 'reset' });
    await vm.drain();

    assert.equal(vm.pending('sftp-rename').length, 0);
    pressKey(input, 'Enter');
    await vm.drain();
    assert.equal(vm.pending('sftp-rename').length, 0, 'a dead editor must not commit');
});

test('a rename commit still targets the captured session after a mid-await rebind, without refreshing the new view', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const row = fileRow(vm, 'notes.txt');
    const input = startRename(vm, row);
    input.value = 'moved.txt';
    pressKey(input, 'Enter');
    await vm.drain();
    const rn = vm.pending('sftp-rename')[0];
    assert.ok(rn, 'rename invoked against the captured session');

    // Rebind while the rename is in flight; its completion must not touch B.
    const p = vm.SFTP.open('sessB');
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] });
    await vm.drain();
    await p;

    vm.settle(rn, { ok: true });
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 0, 'the stale rename must not refresh (or navigate) B\'s view');
    assert.ok(vm.els.body.children.length > 0, 'B\'s listing stays rendered');
});

// ── Delete ──

test('file delete confirms with the shared dialog, defaults to cancel, then removes and refreshes', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk, okText) => confirms.push({ msg, onOk, okText });

    const row = fileRow(vm, 'notes.txt');
    rightClick(row);
    clickItem(vm, '删除');
    await vm.drain();
    assert.equal(confirms.length, 1, 'delete asks through showConfirm');
    assert.ok(confirms[0].msg.includes('notes.txt'), 'confirm names the target');
    assert.equal(vm.pending('sftp-remove').length, 0, 'nothing is removed before confirmation');

    confirms[0].onOk();
    await vm.drain();
    const rm = vm.pending('sftp-remove')[0];
    assert.ok(rm, 'sftp-remove invoked after OK');
    assert.deepEqual({ tabId: rm.args.tabId, path: rm.args.path, isDir: rm.args.isDir },
        { tabId: 'sessA', path: '/srv/app/notes.txt', isDir: false });

    vm.settle(rm, { ok: true });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd, 'successful removal refreshed the owner view');
    assert.equal(rd.args.path, '/srv/app');
});

test('directory delete names the empty-directory contract and removes via isDir', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk, okText) => confirms.push({ msg, onOk, okText });

    const dirRow = rowItems(vm).find(r => rowText(r).includes('assets'));
    rightClick(dirRow);
    clickItem(vm, '删除');
    await vm.drain();
    assert.equal(confirms.length, 1);
    assert.ok(confirms[0].msg.includes('空目录'), 'directory delete states the empty-directory contract');

    confirms[0].onOk();
    await vm.drain();
    const rm = vm.pending('sftp-remove')[0];
    assert.ok(rm);
    assert.equal(rm.args.isDir, true, 'directories remove through remove_dir (isDir)');

    // A server refusal (non-empty) reports and keeps the listing usable.
    vm.settle(rm, { error: 'failure' });
    await vm.drain();
    assert.ok(vm.toasts.some(t => t.isErr), 'server refusal surfaces as an error toast');
    assert.ok(vm.els.body.children.length > 0, 'listing remains on screen after a failed delete');
});

test('delete confirmation cancelled never invokes sftp-remove', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk) => confirms.push({ msg, onOk });
    const row = fileRow(vm, 'z-report.md');
    rightClick(row);
    clickItem(vm, '删除');
    await vm.drain();
    // Cancelled: onOk is never run (showConfirm's cancel/backdrop/Escape semantics).
    assert.equal(vm.pending('sftp-remove').length, 0);
});

test('a mid-confirm rebind does not retarget the delete and does not refresh the new view', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk) => confirms.push({ msg, onOk });
    const row = fileRow(vm, 'notes.txt');
    rightClick(row);
    clickItem(vm, '删除');
    await vm.drain();

    const p = vm.SFTP.open('sessB');
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], { path: '/home/bob', files: [] });
    await vm.drain();
    await p;

    confirms[0].onOk();
    await vm.drain();
    const rm = vm.pending('sftp-remove')[0];
    assert.ok(rm, 'remove invoked after OK');
    assert.equal(rm.args.tabId, 'sessA', 'remove targets the session captured at right-click');
    assert.equal(rm.args.path, '/srv/app/notes.txt');
    vm.settle(rm, { ok: true });
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 0, 'the stale removal must not refresh B\'s view');
});

// ── Blank-menu ownership & availability (right-click snapshot contract) ──

function blankClick(vm) {
    rightClick(vm.els.body);
}

function itemDisabled(vm, label) {
    const menu = menuEl(vm);
    const item = menu.children.find(c => String(c.textContent || '') === label);
    assert.ok(item, `menu item "${label}" present`);
    return item.classList.contains('disabled');
}

// Staging: bring the panel back to sessA@/srv/app (remembered-path restore
// or fresh open — settle whichever request the real model issues), then
// rebind to sessB, so a menu captured on A faces the moved view.
async function ensureOnA(vm) {
    if (vm.SFTP._tabId === 'sessA' && vm.SFTP._path === '/srv/app') return;
    const p = vm.SFTP.open('sessA');
    await vm.drain();
    const oc = vm.pending('sftp-open', k => k.args.tabId === 'sessA')[0];
    if (oc) vm.settle(oc, { path: '/srv/app', files: FILES });
    else {
        const rd = vm.pending('sftp-readdir', k => k.args.tabId === 'sessA' && k.args.path === '/srv/app')[0];
        if (rd) vm.settle(rd, { files: FILES });
    }
    await vm.drain();
    await p;
}

async function rebindToB(vm) {
    const p = vm.SFTP.open('sessB');
    await vm.drain();
    const oc = vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0];
    if (oc) vm.settle(oc, { path: '/home/bob', files: [] });
    else {
        const rd = vm.pending('sftp-readdir', k => k.args.tabId === 'sessB')[0];
        if (rd) vm.settle(rd, { files: [] });
    }
    await vm.drain();
    await p;
}

test('blank menu actions carry the right-click snapshot across a rebind', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);

    // Refresh: the menu captured A; after the rebind its action must be a
    // no-op — never a refresh/navigation of B's view.
    blankClick(vm);
    await rebindToB(vm);
    clickItem(vm, '刷新');
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 0, 'a stale refresh must not navigate/reload the new view');

    // Upload: the batch owner is the snapshot (sessA@/srv/app), never the
    // binding the panel happens to hold at action time.
    await ensureOnA(vm);
    blankClick(vm);
    await rebindToB(vm);
    clickItem(vm, '上传');
    await vm.drain();
    const dlg = vm.pending('show-open-dialog')[0];
    assert.ok(dlg, 'picker requested');
    vm.settle(dlg, { canceled: false, filePaths: ['C:/e2e/f.txt'] });
    await vm.drain();
    const up = vm.pending('sftp-upload')[0];
    assert.ok(up, 'upload started');
    assert.equal(up.args.tabId, 'sessA', 'upload targets the session captured at right-click');
    assert.equal(up.args.remotePath, '/srv/app/f.txt', 'upload targets the directory captured at right-click');
    vm.settle(up, { error: 'Transfer cancelled' });
    await vm.drain();

    // mkdir: a stale gesture must not open its editor on the new view.
    await ensureOnA(vm);
    blankClick(vm);
    await rebindToB(vm);
    clickItem(vm, '新建目录');
    await vm.drain();
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null,
        'a stale mkdir must not open its editor on the new view');
});

test('blank menu actions do not follow a cwd change that happened mid-menu', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    blankClick(vm);
    // A cwd follow moves the view while the menu is open.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/elsewhere' });
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/elsewhere')[0], { files: [] });
    await vm.drain();
    const follows = vm.pending('sftp-readdir').length;

    clickItem(vm, '刷新');
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, follows,
        'the stale refresh must not steer the view (no new readdir for the followed directory)');
});

test('blank menu offers no fake mutations on an unloaded (loading) view', async () => {
    const vm = await loadMenuVm();
    const p = vm.SFTP.open('sessA'); // left pending: view is loading, nothing listed
    await vm.drain();
    blankClick(vm);
    assert.equal(itemDisabled(vm, '新建目录'), true, 'mkdir is not available while the listing loads');
    assert.equal(itemDisabled(vm, '上传'), true, 'upload is not available while the listing loads');
    assert.equal(itemDisabled(vm, '刷新'), true, 'refresh is not available on an unready view either');
    // The disabled items are inert: clicking them changes nothing.
    clickItem(vm, '新建目录');
    clickItem(vm, '上传');
    await vm.drain();
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null, 'no mkdir editor on a loading view');
    assert.equal(vm.pending('show-open-dialog').length, 0, 'no picker on a loading view');
    vm.settle(vm.pending('sftp-open')[0], { path: '/srv/app', files: FILES });
    await vm.drain();
    await p;
});

test('blank menu offers no mutations on a dead session', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    tab.connected = false;
    vm.emit('ssh-disconnect-reason', { tabId: 'sessA', kind: 'error', reason: 'reset' });
    await vm.drain();

    blankClick(vm);
    assert.equal(itemDisabled(vm, '新建目录'), true, 'dead session: mkdir unavailable');
    assert.equal(itemDisabled(vm, '上传'), true, 'dead session: upload unavailable');
    assert.equal(itemDisabled(vm, '刷新'), true, 'dead session: refresh unavailable');
    clickItem(vm, '上传');
    await vm.drain();
    assert.equal(vm.pending('show-open-dialog').length, 0, 'dead session: no picker from a disabled action');
});

test('blank menu stays available on a listed but EMPTY directory', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', []); // listed and settled, just empty
    blankClick(vm);
    assert.equal(itemDisabled(vm, '新建目录'), false, 'an empty directory still accepts mkdir');
    assert.equal(itemDisabled(vm, '上传'), false, 'an empty directory still accepts upload');
    assert.equal(itemDisabled(vm, '刷新'), false, 'an empty directory still accepts refresh');
});

// ── Blank menu vs a pending view request (navigate/follow in flight) ──

test('blank menu disables with no IPC while a navigation from a listed view is unsettled, and recovers after settle', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);

    // A user navigation off the listed view, left unsettled: the body is
    // wiped to a loading swap while _listed still carries the old listing.
    const nav = vm.SFTP.navigate('/tmp');
    nav.catch(() => {});
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir', k => k.args.path === '/tmp').length, 1,
        'the navigation is in flight');

    blankClick(vm);
    assert.equal(itemDisabled(vm, '新建目录'), true, 'mkdir disabled while the navigation is unsettled');
    assert.equal(itemDisabled(vm, '上传'), true, 'upload disabled while the navigation is unsettled');
    assert.equal(itemDisabled(vm, '刷新'), true, 'refresh disabled while the navigation is unsettled');

    // The disabled items are inert: no mkdir row, no picker, no IPC at all.
    const mark = vm.calls.length;
    clickItem(vm, '新建目录');
    clickItem(vm, '上传');
    clickItem(vm, '刷新');
    await vm.drain();
    assert.equal(vm.calls.length, mark, 'no IPC from actions on the pending view');
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null, 'no mkdir editor on the pending view');

    // Settle: the view is listed again and the menu recovers.
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/tmp')[0], { files: FILES });
    await vm.drain();
    await nav;
    blankClick(vm);
    assert.equal(itemDisabled(vm, '新建目录'), false, 'mkdir recovers after the navigation settles');
    assert.equal(itemDisabled(vm, '上传'), false, 'upload recovers after the navigation settles');
    assert.equal(itemDisabled(vm, '刷新'), false, 'refresh recovers after the navigation settles');

    // The recovered actions work: refresh re-renders the settled view.
    clickItem(vm, '刷新');
    await vm.drain();
    const rd = vm.pending('sftp-readdir', k => k.args.path === '/tmp')[0];
    assert.ok(rd, 'refresh issued a readdir of the settled view');
    vm.settle(rd, { files: FILES });
    await vm.drain();
});

test('blank menu actions captured on a settled view refuse a view that went pending mid-menu', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);

    // Upload: the snapshot was ready at right-click time, but a cwd follow
    // put a view request in flight — the batch must not start on it.
    blankClick(vm);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/elsewhere' });
    await vm.drain();
    clickItem(vm, '上传');
    await vm.drain();
    assert.equal(vm.pending('show-open-dialog').length, 0,
        'no picker while the followed view is still in flight');
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/elsewhere')[0], { files: [] });
    await vm.drain();

    // Refresh: the refusal also means the in-flight navigation is never
    // superseded (no second readdir snapping the view back).
    blankClick(vm);
    assert.equal(itemDisabled(vm, '刷新'), false, 'captured while settled: the item was offered enabled');
    const nav = vm.SFTP.navigate('/tmp');
    nav.catch(() => {});
    await vm.drain();
    clickItem(vm, '刷新');
    await vm.drain();
    let pend = vm.pending('sftp-readdir');
    assert.equal(pend.length, 1, 'the refresh must not supersede the in-flight navigation');
    assert.equal(pend[0].args.path, '/tmp');
    vm.settle(pend[0], { files: FILES });
    await vm.drain();
    await nav;

    // mkdir: a stale gesture on a re-pending view opens no editor.
    blankClick(vm);
    const nav2 = vm.SFTP.navigate('/tmp2');
    nav2.catch(() => {});
    await vm.drain();
    clickItem(vm, '新建目录');
    await vm.drain();
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null,
        'no mkdir editor while the view re-pends');
    pend = vm.pending('sftp-readdir');
    assert.equal(pend.length, 1);
    vm.settle(pend[0], { files: FILES });
    await vm.drain();
    await nav2;
});

test('directory 打开 refuses a view that went pending mid-menu and still follows the settled path', async () => {
    const vm = await loadMenuVm();
    await openOn(vm, 'sessA', '/srv/app', FILES);
    const dirRow = rowItems(vm).find(r => rowText(r).includes('assets'));
    assert.ok(dirRow, 'assets dir row rendered');
    rightClick(dirRow);
    assert.deepEqual(menuLabels(vm), ['打开', '重命名', '删除']);

    // A cwd follow starts while the menu is open; its readdir is in flight.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/elsewhere' });
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 1, "the follow's readdir is in flight");

    // Open captured the settled view; clicking it must not navigate by the
    // stale _path — that would add a readdir and supersede the follow.
    clickItem(vm, '打开');
    await vm.drain();
    const pend = vm.pending('sftp-readdir');
    assert.equal(pend.length, 1, '打开 must not add a readdir while the follow is unsettled');
    assert.equal(pend[0].args.path, '/elsewhere', "the pending request is still the follow's own");

    // Settle: the view follows the NEW path — the superseded shape would
    // drop this response and leave the panel stuck loading.
    vm.settle(pend[0], { files: [{ name: 'sub', isDir: true, size: 0, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/elsewhere', 'the follow settles onto the new path');
    assert.ok(rowItems(vm).some(r => rowText(r).includes('sub')), 'the new listing rendered');

    // Once settled, the open action navigates into the child again.
    const subRow = rowItems(vm).find(r => rowText(r).includes('sub'));
    rightClick(subRow);
    clickItem(vm, '打开');
    await vm.drain();
    const rd = vm.pending('sftp-readdir', k => k.args.path === '/elsewhere/sub')[0];
    assert.ok(rd, '打开 navigates into the directory on a settled view');
    vm.settle(rd, { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/elsewhere/sub');
});
