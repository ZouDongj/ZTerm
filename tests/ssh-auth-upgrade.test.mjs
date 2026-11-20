// Legacy stored SSH passwords are upgraded after a successful connect
// (batch C / issue #48).
//
// A legacy encoding (bare base64, tauri:, Electron OSCrypt) still
// authenticates, but the credential provenance is not rememberable, so every
// connect asked for a startup-grant confirmation again. The renderer now asks
// the backend to rewrite that one profile in place after the connect succeeds
// and patches the in-memory profile with the returned ciphertext.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setImmediate(r));

function seed(profile) {
    const ctx = loadVm();
    ctx.TabManager.sshProfiles = [profile];
    const tab = wiredTab(ctx, 't1', 'ssh_1', '');
    tab.sshProfileId = profile.id;
    return { ctx, tab };
}

test('C5: a legacy password is upgraded and memory keeps the new ciphertext', async () => {
    const { ctx, tab } = seed({
        id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '',
    });
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' });
    };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileId, 'p1');
    assert.equal(calls[0].expectedPassword, 'bGVnYWN5');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:new',
        'memory patched so the next profile save cannot restore the legacy value');
});

test('C5: a successful ssh-connected event triggers the upgrade', async () => {
    const { ctx } = seed({ id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '' });
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' });
    };

    ctx.__emit('ssh-connected', { tabId: 'ssh_1', attemptId: '' });
    await flush(); await flush();

    assert.equal(calls.length, 1, 'connected transition runs the migration');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:new');
});

test('C5: a password profile that names a key is treated as key auth', async () => {
    const { ctx, tab } = seed({
        id: 'p1', authType: 'password', encryptedPassword: 'dpapi:old',
        privateKeyPath: 'C:/keys/id_ed25519',
    });
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: '' });
    };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(calls.length, 1, 'a key path makes the stored password dead weight');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, '',
        'the clear reply is applied');
});

test('C5: a key label without a key path still authenticates by password', async () => {
    const { ctx, tab } = seed({
        id: 'p1', authType: 'key', encryptedPassword: 'bGVnYWN5', privateKeyPath: '',
    });
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: '' });
    };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedPassword, 'bGVnYWN5', 'it authenticates by password');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'bGVnYWN5',
        'a clear reply must not empty the password that actually authenticates');
});

test('C5: a key label without a key path accepts the migrated ciphertext', async () => {
    const { ctx, tab } = seed({
        id: 'p1', authType: 'key', encryptedPassword: 'bGVnYWN5', privateKeyPath: '',
    });
    ctx.ipcRenderer.invoke = (cmd) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' });
    };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:new');
});

test('C5: a key profile carrying a password has it cleared', async () => {
    const { ctx, tab } = seed({
        id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: 'C:/keys/id_ed25519',
    });
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: '' });
    };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(calls.length, 1, 'key profile with leftover ciphertext is normalized');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, '');
    assert.equal(ctx.TabManager.sshProfiles[0].privateKeyPath, 'C:/keys/id_ed25519');
});

test('C5: a current password is not sent to the backend', async () => {
    const { ctx, tab } = seed({
        id: 'p1', encryptedPassword: 'dpapi:current', privateKeyPath: '',
    });
    let calls = 0;
    ctx.ipcRenderer.invoke = () => { calls++; return new Promise(() => {}); };

    ctx._upgradeStoredSshAuth(tab, null);
    await flush();

    assert.equal(calls, 0, 'no migration round-trip for the current format');
});

test('C5: an unchanged reply leaves memory alone, and a rejected call stays silent', async () => {
    for (const reply of [() => Promise.resolve({ changed: false }), () => Promise.reject(new Error('offline'))]) {
        const { ctx, tab } = seed({ id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '' });
        ctx.ipcRenderer.invoke = reply;
        ctx._upgradeStoredSshAuth(tab, null);
        await flush(); await flush();
        assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'bGVnYWN5');
    }
});

test('C5: a split pane migrates its own profile, not the tab profile', async () => {
    const ctx = loadVm();
    ctx.TabManager.sshProfiles = [
        { id: 'tab-profile', encryptedPassword: 'dGFi', privateKeyPath: '' },
        { id: 'pane-profile', encryptedPassword: 'cGFuZQ==', privateKeyPath: '' },
    ];
    const tab = wiredTab(ctx, 't1', 'ssh_1', '');
    tab.sshProfileId = 'tab-profile';
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const pane = ctx.getAllPanes(tab)[1];
    pane._sshProfileId = 'pane-profile';
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        calls.push([cmd, payload]);
        return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' });
    };

    ctx._upgradeStoredSshAuth(tab, pane);
    await flush(); await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'upgrade-ssh-profile-auth');
    assert.equal(calls[0][1].profileId, 'pane-profile');
    assert.equal(calls[0][1].expectedPassword, 'cGFuZQ==');
    assert.equal(ctx.TabManager.sshProfiles[1].encryptedPassword, 'dpapi:new');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dGFi', 'tab profile untouched');
});

test('C5: a real attempt runs the migration once through the shared transition', async () => {
    const { ctx, tab } = seed({ id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '' });
    const token = ctx.sshAttempts.createAttempt(tab);
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'upgrade-ssh-profile-auth') return new Promise(() => {});
        calls.push(payload);
        return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' });
    };

    ctx.__emit('ssh-connected', { tabId: 'ssh_1', attemptId: token });
    await flush(); await flush();
    assert.equal(calls.length, 1, 'the once-guarded connect transition runs the migration');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:new');

    // A duplicate success (late rpc result or repeated event) must not migrate again.
    ctx.__emit('ssh-connected', { tabId: 'ssh_1', attemptId: token });
    await flush(); await flush();
    assert.equal(calls.length, 1, 'duplicate ssh-connected is a true no-op');
});

test('C5: a failed connect does not migrate', async () => {
    const { ctx, tab } = seed({ id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '' });
    const token = ctx.sshAttempts.createAttempt(tab);
    let calls = 0;
    ctx.ipcRenderer.invoke = () => { calls++; return Promise.resolve({ changed: true, encryptedPassword: 'dpapi:new' }); };

    ctx.__emit('ssh-error', { tabId: 'ssh_1', attemptId: token, error: 'Authentication failed' });
    await flush(); await flush();

    assert.equal(calls, 0, 'no upgrade round-trip after a rejected connect');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'bGVnYWN5');
});

test('C5: an edit made while the upgrade is in flight wins', async () => {
    const { ctx, tab } = seed({ id: 'p1', encryptedPassword: 'bGVnYWN5', privateKeyPath: '' });
    let reply;
    ctx.ipcRenderer.invoke = (cmd) => (cmd === 'upgrade-ssh-profile-auth'
        ? new Promise(r => { reply = r; })
        : new Promise(() => {}));

    ctx._upgradeStoredSshAuth(tab, null);
    ctx.TabManager.sshProfiles[0].encryptedPassword = 'dpapi:typed-while-inflight';
    reply({ changed: true, encryptedPassword: 'dpapi:new' });
    await flush(); await flush();

    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'dpapi:typed-while-inflight',
        'a stale reply must not overwrite a newer profile edit');
});

test('C5: a clear reply never empties a profile switched to password auth', async () => {
    const { ctx, tab } = seed({
        id: 'p1', authType: 'key', encryptedPassword: 'bGVnYWN5', privateKeyPath: 'C:/keys/id_ed25519',
    });
    let reply;
    ctx.ipcRenderer.invoke = (cmd) => (cmd === 'upgrade-ssh-profile-auth'
        ? new Promise(r => { reply = r; })
        : new Promise(() => {}));

    ctx._upgradeStoredSshAuth(tab, null);
    const profile = ctx.TabManager.sshProfiles[0];
    // The user switches the profile to password auth while the key connect's
    // clear reply is still in flight.
    profile.authType = 'password';
    profile.privateKeyPath = '';
    reply({ changed: true, encryptedPassword: '' });
    await flush(); await flush();

    assert.equal(profile.encryptedPassword, 'bGVnYWN5',
        'password auth keeps the ciphertext it now depends on');
});

test('C5: a clear reply cannot empty a password profile', async () => {
    const { ctx, tab } = seed({
        id: 'p1', authType: 'password', encryptedPassword: 'bGVnYWN5', privateKeyPath: '',
    });
    ctx.ipcRenderer.invoke = (cmd) => (cmd === 'upgrade-ssh-profile-auth'
        ? Promise.resolve({ changed: true, encryptedPassword: '' })
        : new Promise(() => {}));

    ctx._upgradeStoredSshAuth(tab, null);
    await flush(); await flush();

    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'bGVnYWN5',
        'only a key profile may lose its stored password');
});
