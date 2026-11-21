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

test('P2: inline password on a key profile stages in the dialog without writing a hybrid profile to disk', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    const profile = {
        id: 'p1', name: 'box', host: 'h1', username: 'u1', authType: 'key',
        encryptedPassword: 'dpapi:legacy-L', privateKeyPath: 'C:/keys/id_ed25519',
    };
    ctx.TabManager.sshProfiles = [profile];
    ctx.openSSHEdit(false, 'p1');
    assert.equal(runIn(ctx, '_sshOpenedPwd'), 'dpapi:legacy-L',
        'dialog snapshots the ciphertext it shows as saved');

    // Switch the dropdown to password auth and click inline save.
    const g = id => ctx.document.getElementById(id);
    g('ssh-edit-auth').value = '密码';
    ctx.updateAuthFields();
    g('ssh-edit-password').value = 'inline-N';
    const saved = [];
    ctx.closeOverlay = () => {};
    ctx.renderSSHManagerInSettings = () => {};
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'encrypt-password') return Promise.resolve({ encrypted: 'dpapi:inline-N' });
        if (cmd === 'save-ssh-profiles') { saved.push(payload); return Promise.resolve({ ok: true }); }
        return new Promise(() => {});
    };
    await ctx._savePasswordInline();
    await flush();
    assert.equal(saved.length, 0,
        'inline save must not persist a hybrid key+password profile before full Save');
    assert.equal(ctx.TabManager.sshProfiles[0].privateKeyPath, 'C:/keys/id_ed25519');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:legacy-L');
    assert.equal(runIn(ctx, '_sshStagedPwd'), 'dpapi:inline-N',
        'staged ciphertext is held in the dialog for atomic commit on full Save');

    // A key connect that started earlier replies now and clears the profile it
    // still saw as key auth.
    ctx.TabManager.sshProfiles[0] = { ...ctx.TabManager.sshProfiles[0], encryptedPassword: '' };

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1, 'full save commits auth mode and staged password atomically');
    const persisted = saved[0].sshProfiles[0];
    assert.equal(persisted.authType, 'password');
    assert.equal(persisted.privateKeyPath, '');
    assert.equal(persisted.encryptedPassword, 'dpapi:inline-N',
        'the secret the user just chose is kept, not the stale legacy one and not empty');
});

test('P4: staged inline password overrides stale legacy ciphertext on full Save without background clear', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [{
        id: 'p1', name: 'box', host: 'h1', username: 'u1', authType: 'key',
        encryptedPassword: 'dpapi:legacy-L', privateKeyPath: 'C:/keys/id_ed25519',
    }];
    ctx.openSSHEdit(false, 'p1');
    const g = id => ctx.document.getElementById(id);
    g('ssh-edit-auth').value = '密码';
    ctx.updateAuthFields();
    g('ssh-edit-password').value = 'inline-N';
    const saved = [];
    ctx.closeOverlay = () => {};
    ctx.renderSSHManagerInSettings = () => {};
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'encrypt-password') return Promise.resolve({ encrypted: 'dpapi:inline-N' });
        if (cmd === 'save-ssh-profiles') { saved.push(payload); return Promise.resolve({ ok: true }); }
        return new Promise(() => {});
    };

    await ctx._savePasswordInline();
    await flush();
    assert.equal(saved.length, 0);
    // Deliberately do NOT clear TabManager.sshProfiles[0].encryptedPassword:
    // the normal path has no background clear, yet full Save must commit the
    // newly staged password rather than stale dpapi:legacy-L.
    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1);
    const persisted = saved[0].sshProfiles[0];
    assert.equal(persisted.authType, 'password');
    assert.equal(persisted.privateKeyPath, '');
    assert.equal(persisted.encryptedPassword, 'dpapi:inline-N');
});

test('P3: a legacy hybrid profile with privateKeyPath opens in key mode and preserves the key on save', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    const hybrid = {
        id: 'p1', name: 'legacy-key', host: 'h1', username: 'u1', authType: 'password',
        encryptedPassword: '', privateKeyPath: 'C:/keys/id_ed25519', note: 'old',
    };
    ctx.TabManager.sshProfiles = [hybrid];
    const { saved } = recordSaves(ctx);

    ctx.openSSHEdit(false, 'p1');
    assert.equal(ctx.document.getElementById('ssh-edit-auth').value, '密钥',
        'non-empty privateKeyPath must open in key mode even if authType says password');
    ctx.document.getElementById('ssh-edit-note').value = 'updated';
    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1);
    const persisted = saved[0].sshProfiles[0];
    assert.equal(persisted.authType, 'key');
    assert.equal(persisted.privateKeyPath, 'C:/keys/id_ed25519');
    assert.equal(persisted.encryptedPassword, '');
    assert.equal(persisted.note, 'updated');

    ctx.openSSHEditFromTemplate('p1');
    assert.equal(ctx.document.getElementById('ssh-edit-auth').value, '密钥',
        'creating from a hybrid template also defaults to key mode');
});

function queueBehindBlocker(ctx, profiles, clearPasswordFor = '') {
    const saved = [];
    let release;
    const gate = new Promise(r => { release = r; });
    ctx.closeOverlay = () => {};
    ctx.renderSSHManagerInSettings = () => {};
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'save-ssh-profiles') return new Promise(() => {});
        saved.push(payload);
        return gate.then(() => ({ ok: true }));
    };
    ctx.TabManager.sshProfiles = profiles;
    // The queue dispatches synchronously when idle, so occupy it before the
    // save under test: otherwise the callback runs while A is still open and
    // the test cannot tell a captured snapshot from a global read. A profile
    // named here loses its ciphertext in the blocker's own write, the same
    // shape a completed background upgrade leaves in memory.
    const blocker = ctx._mutateSSHProfiles(cur => cur.map(p => (
        p.id === clearPasswordFor ? { ...p, encryptedPassword: '' } : { ...p }
    )));
    return { saved, release, blocker };
}

test('P2: a queued save keeps its own dialog snapshot after another profile is opened', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    const a = {
        id: 'a', name: 'alpha', host: 'ha', username: 'u', authType: 'password',
        encryptedPassword: 'dpapi:a-ciphertext', privateKeyPath: '',
    };
    const b = {
        id: 'b', name: 'beta', host: 'hb', username: 'u', authType: 'password',
        encryptedPassword: 'dpapi:b-ciphertext', privateKeyPath: '',
    };
    const { saved, release, blocker } = queueBehindBlocker(ctx, [a, b]);
    ctx.openSSHEdit(false, 'a');
    await flush();
    assert.equal(saved.length, 1, 'the blocker owns the queue');

    const pending = ctx.saveSSHEdit();
    await flush();
    ctx.closeSSHEdit();
    ctx.openSSHEdit(false, 'b');
    release();
    await blocker;
    await pending;
    await flush();

    const savedA = saved.at(-1).sshProfiles.find(p => p.id === 'a');
    assert.equal(savedA.encryptedPassword, 'dpapi:a-ciphertext',
        'A keeps its own ciphertext, not B\'s and not an empty password');
});

test('P2: a queued save restores the ciphertext it opened when memory was cleared', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    const a = {
        id: 'a', name: 'alpha', host: 'ha', username: 'u', authType: 'password',
        encryptedPassword: 'dpapi:a-ciphertext', privateKeyPath: '',
    };
    const b = {
        id: 'b', name: 'beta', host: 'hb', username: 'u', authType: 'password',
        encryptedPassword: '', privateKeyPath: '',
    };
    const { saved, release, blocker } = queueBehindBlocker(ctx, [a, b], 'a');
    ctx.openSSHEdit(false, 'a');
    await flush();
    assert.equal(saved.length, 1, 'the blocker owns the queue');
    assert.equal(saved[0].sshProfiles.find(p => p.id === 'a').encryptedPassword, '',
        'the blocker write is what clears A, and it lands before the queued save runs');

    // A background migration clears the profile behind this queued save: the
    // save may no longer rely on the memory it read while the dialog was open.
    const pending = ctx.saveSSHEdit();
    await flush();
    ctx.closeSSHEdit();
    ctx.openSSHEdit(false, 'b');
    release();
    await blocker;
    await pending;
    await flush();

    const savedA = saved.at(-1).sshProfiles.find(p => p.id === 'a');
    assert.equal(savedA.encryptedPassword, 'dpapi:a-ciphertext',
        'the opened snapshot rescues a cleared profile instead of writing empty');
});
