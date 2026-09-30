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
