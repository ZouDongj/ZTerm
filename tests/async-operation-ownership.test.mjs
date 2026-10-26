import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';
import { loadSshVm } from './helpers/manager-vm.mjs';

async function openOn(v, session, path, files = []) {
    const opening = v.SFTP.open(session);
    v.settle(v.pending('sftp-open')[0], { path, files });
    await opening;
}

test('upload cannot use the root placeholder before the first listing', async () => {
    const v = await loadSftpVm();
    v.SFTP.open('sessA');
    v.SFTP.upload();
    const dialog = v.pending('show-open-dialog')[0];
    if (dialog) v.settle(dialog, { canceled: false, filePaths: ['D:/synthetic/report.txt'] });
    await v.drain();
    assert.equal(v.of('sftp-upload').length, 0);
});

test('an upload retains the known conflict when cwd follow runs during the picker', async () => {
    const v = await loadSftpVm();
    await openOn(v, 'sessA', '/srv/app', [{ name: 'config.json', isDir: false, size: 1 }]);
    let confirmations = 0;
    v.ctx.showConfirm = () => { confirmations++; };
    v.SFTP.upload();
    v.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/srv/other' });
    v.settle(v.pending('sftp-readdir')[0], { files: [] });
    await v.drain();
    v.settle(v.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/config.json'] });
    await v.drain();
    assert.equal(confirmations, 1);
    assert.equal(v.of('sftp-upload').length, 0);
});

test('upload preserves the server interpretation of symlink parent paths', async () => {
    const v = await loadSftpVm();
    await openOn(v, 'sessA', '/home/u');
    const nav = v.SFTP.navigate('/home/u/link/..');
    v.settle(v.pending('sftp-readdir')[0], { files: [] });
    await nav;
    v.SFTP.upload();
    v.settle(v.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/report.txt'] });
    await v.drain();
    assert.equal(v.of('sftp-upload')[0].args.remotePath, '/home/u/link/../report.txt');
});

test('inline password save remains bound to its originating profile', async () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [
        { id: 'A', name: 'A', host: 'host-a', username: 'u', encryptedPassword: 'old-A' },
        { id: 'B', name: 'B', host: 'host-b', username: 'u', encryptedPassword: 'old-B' },
    ];
    let finishEncryption;
    const saves = [];
    ctx.ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'encrypt-password') return new Promise(resolve => { finishEncryption = resolve; });
        if (cmd === 'save-ssh-profiles') { saves.push(args); return Promise.resolve({}); }
        throw new Error('Unexpected IPC: ' + cmd);
    };
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const save = ctx._savePasswordInline();
    ctx.closeSSHEdit();
    ctx.openSSHEdit(false, 'B');
    ctx.document.getElementById('ssh-edit-password').value = 'unsaved-B-input';
    finishEncryption({ encrypted: 'new-A' });
    await save;
    assert.equal(saves[0].sshProfiles.find(p => p.id === 'B').encryptedPassword, 'old-B');
    assert.equal(ctx.document.getElementById('ssh-edit-password').value, 'unsaved-B-input');
});

test('drop rejects an uncommitted directory and allows upload after the listing arrives', async () => {
    const v = await loadSftpVm();
    const opening = v.SFTP.open('sessA');
    const drop = () => v.els.sftpWin.dispatch('drop', {
        preventDefault() {}, dataTransfer: { files: [{ path: 'D:/synthetic/report.txt' }] },
    });
    drop();
    await v.drain();
    assert.equal(v.of('local-path-stat').length, 0);
    assert.equal(v.of('sftp-upload').length, 0);
    v.settle(v.pending('sftp-open')[0], { path: '/home/u/link/..', files: [] });
    await opening;
    drop();
    await v.drain();
    assert.equal(v.of('sftp-upload')[0].args.remotePath, '/home/u/link/../report.txt');
});

test('confirmed picker upload uses its original directory after panel rebinding', async () => {
    const v = await loadSftpVm();
    await openOn(v, 'sessA', '/original', [{ name: 'same.txt', isDir: false }]);
    let confirm;
    v.ctx.showConfirm = (message, onOk) => { confirm = onOk; };
    v.SFTP.upload();
    await openOn(v, 'sessB', '/other', []);
    v.settle(v.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/same.txt'] });
    await v.drain();
    assert.equal(typeof confirm, 'function');
    assert.equal(v.of('sftp-upload').length, 0);
    confirm();
    await v.drain();
    assert.equal(v.of('sftp-upload')[0].args.tabId, 'sessA');
    assert.equal(v.of('sftp-upload')[0].args.remotePath, '/original/same.txt');
});

test('full profile save captures id and login scripts before encryption without closing the next editor', async () => {
    const ctx = loadSshVm();
    ctx.openOverlay = id => ctx.document.getElementById(id).classList.add('open');
    ctx.closeOverlay = id => ctx.document.getElementById(id).classList.remove('open');
    ctx.TabManager.sshProfiles = [
        { id: 'A', name: 'A', host: 'host-a', username: 'u' },
        { id: 'B', name: 'B', host: 'host-b', username: 'u', encryptedPassword: 'old-B' },
    ];
    let finishEncryption;
    const saves = [];
    ctx.ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'encrypt-password') return new Promise(resolve => { finishEncryption = resolve; });
        if (cmd === 'save-ssh-profiles') { saves.push(args); return Promise.resolve({}); }
        throw new Error('Unexpected IPC: ' + cmd);
    };
    let scripts = [{ expect: 'A>', send: 'synthetic A' }];
    ctx.collectLoginScripts = () => scripts.map(script => ({ ...script }));
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const save = ctx.saveSSHEdit();
    ctx.closeSSHEdit();
    ctx.openSSHEdit(false, 'B');
    scripts = [{ expect: 'B>', send: 'synthetic B' }];
    finishEncryption({ encrypted: 'new-A' });
    await save;
    const savedA = saves[0].sshProfiles.find(p => p.id === 'A');
    assert.equal(savedA.encryptedPassword, 'new-A');
    assert.equal(savedA.loginScripts[0].send, 'synthetic A');
    assert.equal(saves[0].sshProfiles.find(p => p.id === 'B').host, 'host-b');
    assert.equal(ctx.document.getElementById('overlay-ssh-edit').classList.contains('open'), true);
    assert.equal(ctx.document.getElementById('ssh-edit-host').value, 'host-b');
});

for (const method of ['_savePasswordInline', 'saveSSHEdit']) {
    test(`${method} does not resurrect a profile deleted while encryption is pending`, async () => {
        const ctx = loadSshVm();
        ctx.TabManager.sshProfiles = [{ id: 'A', name: 'A', host: 'host-a', username: 'u' }];
        let finishEncryption;
        let saves = 0;
        ctx.ipcRenderer.invoke = cmd => {
            if (cmd === 'encrypt-password') return new Promise(resolve => { finishEncryption = resolve; });
            if (cmd === 'save-ssh-profiles') { saves++; return Promise.resolve({}); }
            throw new Error('Unexpected IPC: ' + cmd);
        };
        ctx.openSSHEdit(false, 'A');
        ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
        const save = ctx[method]();
        ctx.TabManager.sshProfiles = [];
        finishEncryption({ encrypted: 'new-A' });
        await save;
        assert.equal(saves, 0);
        assert.equal(ctx.TabManager.sshProfiles.length, 0);
    });
}

async function nextTurn() { await new Promise(resolve => setImmediate(resolve)); }

function profilePersistenceFixture() {
    const ctx = loadSshVm();
    ctx.renderSSHManager = () => {};
    ctx.TabManager.sshProfiles = [
        { id: 'A', name: 'A', host: 'host-a', username: 'u', encryptedPassword: 'old-A' },
        { id: 'B', name: 'B', host: 'host-b', username: 'u', encryptedPassword: 'old-B' },
    ];
    const saves = [];
    ctx.ipcRenderer.invoke = (command, args) => {
        if (command === 'encrypt-password') return Promise.resolve({ encrypted: 'new-A' });
        assert.equal(command, 'save-ssh-profiles');
        return new Promise((resolve, reject) => saves.push({
            profiles: JSON.parse(JSON.stringify(args.sshProfiles)), resolve, reject,
        }));
    };
    return { ctx, saves };
}

for (const method of ['_savePasswordInline', 'saveSSHEdit']) {
    for (const outcome of ['success', 'error']) {
        test(`${method} suppresses stale ${outcome} UI after an editor switch without retargeting persistence`, async () => {
            const { ctx, saves } = profilePersistenceFixture();
            ctx.openSSHEdit(false, 'A');
            if (method === 'saveSSHEdit') ctx.document.getElementById('ssh-pwd-edit-btn').onclick();
            ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
            const save = ctx[method]();
            await nextTurn();
            assert.equal(saves.length, 1, 'the original profile operation reached persistence');

            ctx.closeSSHEdit();
            ctx.openSSHEdit(false, 'B');
            const toastCount = ctx.__toasts.length;
            let managerRenders = 0;
            ctx.renderSSHManager = () => { managerRenders++; };
            if (outcome === 'success') saves[0].resolve({});
            else saves[0].reject(new Error('synthetic stale write failure'));
            await save;

            assert.equal(saves[0].profiles.find(p => p.id === 'A').encryptedPassword, 'new-A',
                'persistence still targets the originating profile');
            assert.equal(saves[0].profiles.find(p => p.id === 'B').encryptedPassword, 'old-B');
            assert.equal(ctx.TabManager.sshProfiles.find(p => p.id === 'A').encryptedPassword,
                outcome === 'success' ? 'new-A' : 'old-A');
            assert.equal(ctx.document.getElementById('ssh-edit-host').value, 'host-b',
                'the newer editor remains active');
            assert.equal(ctx.__toasts.length, toastCount, 'no stale toast crosses the editor boundary');
            assert.equal(managerRenders, 0, 'no stale manager render crosses the editor boundary');
        });
    }
}

test('a second profile save rebases on the first save committed during the persistence await', async () => {
    const { ctx, saves } = profilePersistenceFixture();
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const saveA = ctx._savePasswordInline();
    await nextTurn();
    ctx.closeSSHEdit();
    ctx.openSSHEdit(false, 'B');
    ctx.document.getElementById('ssh-edit-name').value = 'B renamed';
    const saveB = ctx.saveSSHEdit();
    saves[0].resolve({});
    await nextTurn();
    assert.equal(saves[1].profiles.find(p => p.id === 'A').encryptedPassword, 'new-A');
    saves[1].resolve({});
    await Promise.all([saveA, saveB]);
    assert.equal(ctx.TabManager.sshProfiles.find(p => p.id === 'B').name, 'B renamed');
    assert.equal(ctx.TabManager.sshProfiles.find(p => p.id === 'A').encryptedPassword, 'new-A');
});

test('confirmed deletion during a pending profile persistence cannot be undone by its old completion', async () => {
    const { ctx, saves } = profilePersistenceFixture();
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const saveA = ctx._savePasswordInline();
    await nextTurn();
    let confirmDelete;
    ctx.showConfirm = (message, onOk) => { confirmDelete = onOk; };
    ctx.deleteSSHProfile('A');
    const deletion = confirmDelete();
    // The unfixed implementation dispatches both whole-list writes at once;
    // force its delete completion to arrive before the stale save completion.
    if (saves[1]) { saves[1].resolve({}); await nextTurn(); }
    saves[0].resolve({});
    await nextTurn();
    saves[1].resolve({});
    await Promise.all([saveA, deletion]);
    assert.equal(ctx.TabManager.sshProfiles.some(p => p.id === 'A'), false);
    assert.equal(saves[1].profiles.some(p => p.id === 'A'), false);
});

test('a failed profile mutation releases the queue without publishing its uncommitted password', async () => {
    const { ctx, saves } = profilePersistenceFixture();
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const saveA = ctx._savePasswordInline();
    await nextTurn();
    ctx.openSSHEdit(false, 'B');
    ctx.document.getElementById('ssh-edit-name').value = 'B renamed';
    const saveB = ctx.saveSSHEdit();
    assert.equal(saves.length, 1);
    saves[0].reject(new Error('synthetic write failure'));
    await nextTurn();
    assert.equal(saves[1].profiles.find(p => p.id === 'A').encryptedPassword, 'old-A');
    saves[1].resolve({});
    await Promise.all([saveA, saveB]);
    assert.equal(ctx.TabManager.sshProfiles.find(p => p.id === 'B').name, 'B renamed');
});

test('full save without a new password retains an earlier queued password update on the same profile', async () => {
    const { ctx, saves } = profilePersistenceFixture();
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const passwordSave = ctx._savePasswordInline();
    await nextTurn();
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-name').value = 'A renamed';
    const profileSave = ctx.saveSSHEdit();
    saves[0].resolve({});
    await nextTurn();
    assert.equal(saves[1].profiles.find(p => p.id === 'A').encryptedPassword, 'new-A');
    saves[1].resolve({});
    await Promise.all([passwordSave, profileSave]);
});

test('group rename queues behind profile persistence and keeps the committed password', async () => {
    const { ctx, saves } = profilePersistenceFixture();
    ctx.TabManager.sshProfiles[0].group = 'Original';
    ctx.openSSHEdit(false, 'A');
    ctx.document.getElementById('ssh-edit-password').value = 'synthetic-A-password';
    const passwordSave = ctx._savePasswordInline();
    await nextTurn();
    const header = ctx.document.createElement('div');
    header.className = 'ssh-mgr-group-title';
    header.setAttribute('data-group', 'Original');
    const label = ctx.document.createElement('span');
    label.className = 'group-name-text';
    header.appendChild(label);
    const button = ctx.document.createElement('button');
    header.appendChild(button);
    ctx.document.body.appendChild(header);
    ctx.startRenameGroup(button);
    const input = header.querySelector('input');
    input.value = 'Renamed';
    input.blur();
    assert.equal(saves.length, 1);
    saves[0].resolve({});
    await nextTurn();
    const updated = saves[1].profiles.find(p => p.id === 'A');
    assert.equal(updated.encryptedPassword, 'new-A');
    assert.equal(updated.group, 'Renamed');
    saves[1].resolve({});
    await passwordSave;
    await nextTurn();
    assert.equal(ctx.TabManager.sshProfiles.find(p => p.id === 'A').group, 'Renamed');
});
