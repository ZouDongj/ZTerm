// sftp-1: same-name uploads silently overwrote each other. The overwrite
// confirmation gate (_uploadConflictCount) only compared basenames against the
// panel's static listing, so it was blind to (a) two same-basename files
// inside ONE batch (different folders, one drop from an Explorer search — the
// Tauri drag-drop delivers payload.paths as a single batch, and the dialog
// upload() path shares the same gate) and (b) uploads still in flight to the
// same target (not in the listing until they complete). Backend tmp/backup
// finalize is last-wins, so the earlier transfer's data was deleted with both
// rows reporting success. The fix: same-basename batches are refused up
// front, and in-flight same-target entries count into the confirmation gate.
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

function captureConfirms(vm) {
    const confirms = [];
    vm.ctx.showConfirm = (msg, onOk, okText) => confirms.push({ msg, onOk, okText });
    return confirms;
}

test('a dialog batch with two same-basename files is refused outright', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const confirms = captureConfirms(vm);

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], {
        canceled: false,
        filePaths: ['D:/dirA/a.txt', 'D:/dirB/a.txt'], // same name, different folders
    });
    await vm.drain();

    assert.equal(vm.of('sftp-upload').length, 0, 'nothing uploads');
    assert.equal(confirms.length, 0, 'the batch is refused, not overwrite-confirmed');
    assert.ok(vm.toasts.some(t => t.isErr && t.msg.includes('a.txt') && t.msg.includes('同名')),
        `refusal toast names the conflict: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    void up;
});

test('_duplicateBasenames flags repeated basenames regardless of folder (the drop batch gate)', async () => {
    const vm = await loadSftpVm();
    // The Tauri drag-drop delivers the whole payload.paths as ONE batch; the
    // dup names must surface wherever the folders came from.
    assert.deepEqual(
        Array.from(vm.SFTP._duplicateBasenames(['D:/dirA/a.txt', 'D:/dirB/a.txt', 'D:/dirA/b.txt'])),
        ['a.txt'], 'same basename from different folders is a conflict');
    assert.deepEqual(
        Array.from(vm.SFTP._duplicateBasenames(['D:/dirA/a.txt', 'D:/dirB/b.txt'])),
        [], 'distinct basenames are fine');
    assert.deepEqual(Array.from(vm.SFTP._duplicateBasenames([])), [], 'empty batch is fine');
    assert.deepEqual(
        Array.from(vm.SFTP._duplicateBasenames(['C:/x/a.txt', 'C:/y/a.txt', 'C:/z/a.txt'])),
        ['a.txt'], 'each name reports once');
});

test('an upload still in flight counts as a conflict for the next batch (in-flight gate)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []); // listing empty: only the in-flight entry can conflict
    const confirms = captureConfirms(vm);

    // First upload of a.txt: starts immediately (no remote listing conflict).
    const up1 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirA/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 0, 'the first upload needs no confirmation');
    const u1 = vm.pending('sftp-upload', c => c.args.localPath === 'D:/dirA/a.txt')[0];
    assert.ok(u1, 'first upload in flight (invoke unsettled)');
    assert.ok(vm.TransferManager.hasPendingUploadTo('sessA', '/srv/app/a.txt'),
        'the in-flight target is visible to the gate');

    // Second batch with the same name: the gate must see the in-flight entry.
    const up2 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirB/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 1, 'the in-flight upload triggers the overwrite confirmation');
    assert.equal(vm.pending('sftp-upload').length, 1, 'the second upload waits (only the first is in flight)');

    confirms[0].onOk();
    await vm.drain();
    const u2 = vm.pending('sftp-upload', c => c.args.localPath === 'D:/dirB/a.txt')[0];
    assert.ok(u2, 'the confirmed second upload started');
    vm.settle(u2, {});
    await vm.drain();
    vm.settle(u1, {}); // let the first transfer finish too
    await vm.drain();
    await up1; await up2;
});

test('a completed upload no longer counts as in-flight (gate opens again)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const confirms = captureConfirms(vm);

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirA/a.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await up; // TransferManager.complete ran: the entry is done

    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/srv/app/a.txt'), false,
        'a done entry is not pending');
    assert.equal(confirms.length, 0, 'no stale confirmation was requested');
});

// ── sftp-2: textual path aliases blinded the in-flight gate ──────────────────
// _path is stored raw, so a manually typed '/srv/app/' (or '/srv/./app') went
// into the batch owner as-is: the first batch's in-flight target recorded as
// '/srv/app//a.txt' while the canonical cwd follow '/srv/app' later probed
// '/srv/app/a.txt' — exact-string comparison missed, and the second batch
// silently overwrote the first's data. remotePath generation/comparison (and
// the owner-dir listing check) now run both sides through normalizeRemotePath,
// which canonicalizes slashes/'.'/'..' but never folds case (remote FS may be
// case-sensitive).

// The manual breadcrumb edit's Enter handler, driven through the real editor.
async function typePath(vm, val) {
    vm.SFTP._editPath();
    const input = vm.els.breadcrumb.children[vm.els.breadcrumb.children.length - 1];
    assert.equal(input.className, 'sftp-path-input inline-edit', 'edit input mounted');
    input.value = val;
    input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === val)[0], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, val, `panel really sits at the raw typed path ${val}`);
}

test('a batch typed at /srv/app/ conflicts with an in-flight upload to canonical /srv/app', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    await typePath(vm, '/srv/app/'); // user types the trailing slash; _path keeps the raw form
    const confirms = captureConfirms(vm);

    // Batch 1 at the typed path: uploads immediately (empty listing, nothing in flight).
    const up1 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirA/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 0, 'the first upload needs no confirmation');
    const u1 = vm.pending('sftp-upload', c => c.args.localPath === 'D:/dirA/a.txt')[0];
    assert.ok(u1, 'first upload in flight');
    assert.equal(u1.args.remotePath, '/srv/app/a.txt',
        `the typed trailing slash must not leak into the transfer target: ${JSON.stringify(u1.args)}`);

    // OSC 7 cwd follow canonicalizes the panel to '/srv/app' while batch 1 runs.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/srv/app' });
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/srv/app')[0], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/srv/app');

    // Batch 2, same basename, canonical path: the in-flight entry must collide.
    const up2 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirB/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 1, 'the in-flight upload from the alias-typed batch triggers the confirmation');
    assert.equal(vm.pending('sftp-upload').length, 1, 'the second upload still waits (only the first is in flight)');

    confirms[0].onOk();
    await vm.drain();
    const u2 = vm.pending('sftp-upload', c => c.args.localPath === 'D:/dirB/a.txt')[0];
    assert.ok(u2, 'the confirmed second upload started');
    vm.settle(u2, {});
    await vm.drain();
    vm.settle(u1, {});
    await vm.drain();
    await up1; await up2;
});

test('an in-flight upload to a genuinely different directory never confirms (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    await typePath(vm, '/srv/app/');
    const confirms = captureConfirms(vm);

    const up1 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirA/a.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];
    assert.ok(u1 && u1.args.remotePath === '/srv/app/a.txt');

    // The follow moves to a DIFFERENT directory: same basename, no collision.
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/srv/other' });
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/srv/other')[0], { files: [] });
    await vm.drain();

    const up2 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/dirB/a.txt'] });
    await vm.drain();
    assert.equal(confirms.length, 0, 'a different remote directory is not a conflict');
    const u2 = vm.pending('sftp-upload', c => c.args.localPath === 'D:/dirB/a.txt')[0];
    assert.ok(u2 && u2.args.remotePath === '/srv/other/a.txt',
        `batch 2 uploads straight through to its own directory: ${u2 && JSON.stringify(u2.args)}`);
    vm.settle(u1, {}); vm.settle(u2, {});
    await vm.drain();
    await up1; await up2;
});

test('normalizeRemotePath canonicalizes slashes, dot segments and trailing slashes (boundaries)', async () => {
    const vm = await loadSftpVm();
    const norm = vm.ctx.normalizeRemotePath; // top-level function declaration in the VM global
    assert.equal(typeof norm, 'function');
    assert.equal(norm('/'), '/');
    assert.equal(norm('//'), '/');
    assert.equal(norm('/srv/app/'), '/srv/app');
    assert.equal(norm('/srv/./app'), '/srv/app');
    assert.equal(norm('//srv///app'), '/srv/app');
    assert.equal(norm('/srv/app/../lib'), '/srv/lib');
    assert.equal(norm('/..'), '/');
    assert.equal(norm('/../..'), '/');
    assert.equal(norm('/a/b/../../c'), '/c');
    assert.equal(norm('/Srv/App'), '/Srv/App', 'case is never folded');
    assert.equal(norm('srv/app'), 'srv/app', 'non-absolute input passes through');
    assert.equal(norm(''), '', 'empty input passes through');
    assert.equal(norm(undefined), undefined, 'non-string input passes through');

    // The join itself runs through the normalizer (generation side).
    assert.equal(vm.SFTP._uploadRemotePath({ path: '/' }, 'a.txt'), '/a.txt');
    assert.equal(vm.SFTP._uploadRemotePath({ path: '/srv/app/' }, 'a.txt'), '/srv/app/a.txt');
    assert.equal(vm.SFTP._uploadRemotePath({ path: '/srv/./app/..' }, 'a.txt'), '/srv/a.txt');
});

test('hasPendingUploadTo compares canonical forms, keeps tab scoping and case sensitivity', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('f.txt', 'upload', 'sessA', undefined, '/srv/app/f.txt');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/srv/app/f.txt'), true, 'exact form still matches');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/srv//app/./f.txt'), true, 'alias forms collide');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/srv/app/../app/f.txt'), true, 'dot-dot aliases collide');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/Srv/app/f.txt'), false, 'case-sensitive remotes stay distinct');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessA', '/srv/other/f.txt'), false, 'a different directory stays distinct');
    assert.equal(vm.TransferManager.hasPendingUploadTo('sessB', '/srv/app/f.txt'), false, 'tab scoping unchanged');
});
