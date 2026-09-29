// Pane-level credential handles must be released when their owner dies, on
// the same contract as tab._credId (revoke-credential → the main process
// drops the plaintext; Rust's revoke is an idempotent map remove).
// Driven through the REAL tabs.js closeTab / _closePane / init restore paths
// in the shared renderer VM (tests/helpers/renderer-vm.mjs).
//
// Old code: closeTab revoked only tab._credId — a restored split tab (each
// SSH pane registers its OWN _sshCredId, tabs.js _restoreSplitTab) leaked
// every pane handle for the whole app lifetime, _closePane leaked a single
// pane's handle, and the init restore registration that resolved after its
// tab was gone leaked the orphaned handle.
//
// Sharing guards pinned here (these pass on old AND new code — they protect
// live reconnects from the revoke): siblings split from one session inherit
// the SAME credId, and a cloned tab never owns its credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const revokes = (ctx, credId) =>
    ctx.__sends.filter(s => s.cmd === 'revoke-credential' && s.payload && s.payload.credId === credId);

test('closeTab of a split tab revokes every pane credId once (deduped, excluding the tab handle)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    tab._credId = 'cred_t';
    p1._sshCredId = 'cred_t'; // shares the tab-level handle (split inheritance)
    p2._sshCredId = 'cred_b'; // its own registration
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(1000);

    assert.equal(revokes(ctx, 'cred_t').length, 1, 'the tab handle is revoked exactly once');
    assert.equal(revokes(ctx, 'cred_b').length, 1, 'the pane-level handle is revoked exactly once');
    assert.equal(ctx.TabManager.tabs.includes(tab), false, 'tab removed');
});

test('closeTab of a CLONED split tab revokes nothing (the credential belongs to the source)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    tab._cloneCred = true;
    p1._sshCredId = 'cred_a';
    p2._sshCredId = 'cred_b';
    ctx.TabManager.render();

    ctx.TabManager.closeTab(tab.id);
    ctx.__tq.advance(1000);

    assert.equal(ctx.__sends.filter(s => s.cmd === 'revoke-credential').length, 0,
        'a clone owns no credential: nothing is revoked');
});

test('_closePane revokes the pane\'s unshared credId at initiation', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.getAllPanes(tab)[0]._sshCredId = 'cred_a';
    p2._sshCredId = 'cred_b';

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(revokes(ctx, 'cred_b').length, 1, 'the dying pane\'s own handle is released');
    assert.equal(revokes(ctx, 'cred_a').length, 0, 'the survivor\'s handle is untouched');
});

test('_closePane never revokes a credId still shared with a surviving sibling', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.getAllPanes(tab)[0]._sshCredId = 'cred_x';
    p2._sshCredId = 'cred_x'; // split inheritance: one handle, two users

    ctx.TabManager._closePane(tab.id, p2.id);

    assert.equal(revokes(ctx, 'cred_x').length, 0,
        'the surviving sibling still needs the handle for its reconnect');
});

test('init restore: a credential registration that resolves after its tab closed is revoked', async () => {
    const ctx = loadVm();
    const onceHandlers = new Map();
    ctx.ipcRenderer.once = (ch, fn) => onceHandlers.set(ch, fn);
    const deferred = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'get-local-shells') return Promise.resolve([]);
        const rec = { cmd, payload };
        rec.promise = new Promise((res) => { rec.resolve = res; });
        deferred.push(rec);
        return rec.promise;
    };
    ctx.TabManager.init();
    const profilesFn = onceHandlers.get('profiles');
    assert.ok(profilesFn, 'the real profiles handler was registered');
    ctx.TabManager.sshProfiles = [];
    await profilesFn({}, {
        profiles: [],
        sshProfiles: [{ id: 'prof1', name: 'p', host: 'h', username: 'u', encryptedPassword: 'enc' }],
        lastTabs: [
            { name: 'keep', type: 'local', command: 'powershell.exe', args: [] },
            { name: 'dead', type: 'ssh', sshProfileId: 'prof1' },
        ],
    });
    const reg = deferred.find(d => d.cmd === 'register-credential');
    assert.ok(reg, 'restore registered a credential for the encrypted-password profile');
    const dead = ctx.TabManager.tabs.find(t => t.name === 'dead');
    assert.ok(dead, 'restored ssh tab exists');

    // The user closes the tab while the registration round trip is in flight.
    ctx.TabManager.closeTab(dead.id);
    ctx.__tq.advance(1000); // deferred removal ran
    assert.ok(!ctx.TabManager.tabs.includes(dead), 'tab gone before the registration resolves');
    const revokesBefore = revokes(ctx, 'cred_orphan').length;

    reg.resolve({ credId: 'cred_orphan' });
    await new Promise(r => setTimeout(r, 0));

    assert.equal(revokes(ctx, 'cred_orphan').length, revokesBefore + 1,
        'the orphaned handle is released, not stranded in main-process memory');
});
