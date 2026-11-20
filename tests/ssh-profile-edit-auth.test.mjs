// Key authentication must not keep a password secret (batch C / C3).
//
// A profile that switched from password to key auth kept the old ciphertext in
// `encryptedPassword`. The backend then decrypted a secret the profile never
// uses (failing the whole connect when the config came from another Windows
// user/machine) and tied its startup-grant fingerprint to that secret, so the
// grant was never reusable. The edit dialog now drops the ciphertext in key
// mode and refuses a key profile with no key path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSshVm, runIn } from './helpers/manager-vm.mjs';

const flush = () => new Promise(r => setImmediate(r));

// renderSSHManager reaches SshDisplay (ssh-display.js, not loaded by the
// manager VM); stub the display model for the success path.
function stubSshDisplay(ctx) {
    ctx.SshDisplay = {
        sshProfileMatches: () => true,
        sshDisplayModel: (p) => ({
            named: true, primary: p.name || p.host, primaryIsHost: false,
            endpoint: p.host || '', user: p.username || '', port: p.port || 22, keyAuth: false,
        }),
    };
    ctx.renderSSHManagerInSettings = ctx.renderSSHManagerInSettings || (() => {});
}

function stageEdit(ctx, profile, { authType, keyPath, password = '', pwdDirty = false }) {
    ctx.TabManager.sshProfiles = [profile];
    runIn(ctx, `_editingSSHId = ${JSON.stringify(profile.id)}; _sshPwdDirty = ${pwdDirty};`);
    const g = id => ctx.document.getElementById(id);
    g('ssh-edit-name').value = profile.name;
    g('ssh-edit-host').value = profile.host;
    g('ssh-edit-port').value = String(profile.port || 22);
    g('ssh-edit-user').value = profile.username || '';
    g('ssh-edit-password').value = password;
    g('ssh-edit-note').value = profile.note || '';
    g('ssh-edit-group').value = profile.group || '';
    g('ssh-edit-auth').value = authType === 'key' ? '密钥' : '密码';
    g('ssh-edit-keypath').value = keyPath;
}

function recordSaves(ctx) {
    const saved = [];
    const closed = [];
    let renders = 0;
    ctx.closeOverlay = id => closed.push(id);
    ctx.renderSSHManagerInSettings = () => renders++;
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'save-ssh-profiles') { saved.push(payload); return Promise.resolve({ ok: true }); }
        return new Promise(() => {});
    };
    return { saved, closed, renders: () => renders };
}

test('C3: saving key auth drops the stored password ciphertext', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    stageEdit(ctx, {
        id: 'p1', name: 'box', host: 'h1', username: 'u1', authType: 'password',
        encryptedPassword: 'dpapi:stale-ciphertext', privateKeyPath: '',
    }, { authType: 'key', keyPath: 'C:/keys/id_ed25519', password: 'typed-but-unused', pwdDirty: true });
    const { saved, closed } = recordSaves(ctx);

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1, 'profile persisted');
    const profile = saved[0].sshProfiles[0];
    assert.equal(profile.authType, 'key');
    assert.equal(profile.privateKeyPath, 'C:/keys/id_ed25519');
    assert.equal(profile.encryptedPassword, '', 'stale password ciphertext dropped');
    assert.deepEqual(closed, ['overlay-ssh-edit']);
});

test('C3: key auth without a key path is refused before any persist', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    stageEdit(ctx, {
        id: 'p1', name: 'box', host: 'h1', username: 'u1', authType: 'password',
        encryptedPassword: 'dpapi:stale-ciphertext', privateKeyPath: '',
    }, { authType: 'key', keyPath: '   ' });
    const { saved, closed } = recordSaves(ctx);

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 0, 'nothing persisted');
    assert.deepEqual(closed, [], 'dialog stays open');
    assert.equal(ctx.TabManager.sshProfiles[0].authType, 'password', 'stored profile untouched');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:stale-ciphertext');
    const err = ctx.__toasts.filter(t => t.isError);
    assert.equal(err.length, 1);
    assert.equal(err[0].msg, '请选择私钥文件');
    assert.equal(ctx.document.activeElement, ctx.document.getElementById('ssh-edit-keypath'),
        'key path field focused for the fix');
});

test('C3 (control): password auth keeps the ciphertext when no new password is typed', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    stageEdit(ctx, {
        id: 'p1', name: 'box', host: 'h1', username: 'u1', authType: 'password',
        encryptedPassword: 'dpapi:stored-ciphertext', privateKeyPath: '',
    }, { authType: 'password', keyPath: '' });
    const { saved } = recordSaves(ctx);

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1);
    assert.equal(saved[0].sshProfiles[0].encryptedPassword, 'dpapi:stored-ciphertext');
    assert.equal(saved[0].sshProfiles[0].privateKeyPath, '');
});
