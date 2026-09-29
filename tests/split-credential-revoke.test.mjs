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
// Sharing guards pinned here (they protect live reconnects from the revoke):
// siblings split from one session inherit the SAME credId, and one id can be
// copied across tabs (clone tabs, pane-extraction adoption). A shared handle
// is revoked ONLY by the LAST referencing wrapper's close — an earlier revoke
// kills every survivor's reconnect with no recovery path (the connect path
// keeps sending the dead id and never falls back to the profile).
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

test('closeTab of a cloned split tab revokes nothing while the source holds the same handles', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    // The clone split tab (_cloneSplitTab copies each pane's _sshCredId)
    // shares both handles with the still-alive source split tab.
    const { tab: clone, p1: cp1, p2: cp2 } = wiredSplitTab(ctx, 't_clone', 'ssh_C', null, 'ssh_D', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const { tab: src } = wiredSplitTab(ctx, 't_src', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.getAllPanes(src)[0]._sshCredId = cp1._sshCredId = 'cred_a';
    ctx.getAllPanes(src)[1]._sshCredId = cp2._sshCredId = 'cred_b';
    ctx.TabManager.render();

    ctx.TabManager.closeTab(clone.id);
    ctx.__tq.advance(1000);

    assert.equal(ctx.__sends.filter(s => s.cmd === 'revoke-credential').length, 0,
        'the source still needs both handles for its own reconnects: nothing is revoked');
});

test('the LAST referencing tab close revokes the shared handles exactly once', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab: clone, p1: cp1, p2: cp2 } = wiredSplitTab(ctx, 't_clone', 'ssh_C', null, 'ssh_D', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const { tab: src } = wiredSplitTab(ctx, 't_src', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.getAllPanes(src)[0]._sshCredId = cp1._sshCredId = 'cred_a';
    ctx.getAllPanes(src)[1]._sshCredId = cp2._sshCredId = 'cred_b';
    ctx.TabManager.render();

    // Source closes first: the clone still references both ids → no revoke.
    ctx.TabManager.closeTab(src.id);
    ctx.__tq.advance(1000);
    assert.equal(revokes(ctx, 'cred_a').length, 0, 'source close leaves the clone\'s handles alone');
    assert.equal(revokes(ctx, 'cred_b').length, 0, 'source close leaves the clone\'s handles alone');

    // The clone is now the last referencer: its close MUST release the
    // plaintext (otherwise it stays in main-process memory forever).
    ctx.TabManager.closeTab(clone.id);
    ctx.__tq.advance(1000);
    assert.equal(revokes(ctx, 'cred_a').length, 1, 'last referencer revokes the shared handle exactly once');
    assert.equal(revokes(ctx, 'cred_b').length, 1, 'last referencer revokes the shared handle exactly once');
});

test('closing the source of a tab-level clone does not revoke the shared _credId (clone reconnect stays armed)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    // cloneTab copies the source's _credId onto the new tab; both tabs now
    // hold 'cred_shared' (old code: the source's close revoked it and the
    // clone's reconnect failed auth permanently with no recovery path).
    const src = { id: 't_src', name: 'src', type: 'ssh', host: 'h', user: 'u', connected: true, tabId: 'ssh_A', _credId: 'cred_shared', term: null, fitAddon: null };
    const clone = { id: 't_clone', name: 'clone', type: 'ssh', host: 'h', user: 'u', connected: true, tabId: 'ssh_B', _credId: 'cred_shared', term: null, fitAddon: null };
    ctx.TabManager.tabs.push(src, clone);
    ctx.TabManager.render();

    ctx.TabManager.closeTab(src.id);
    ctx.__tq.advance(1000);

    assert.equal(revokes(ctx, 'cred_shared').length, 0,
        'the clone still holds the handle: closing the source must not revoke it');
    assert.equal(clone._credId, 'cred_shared', 'the clone reconnects with the intact handle');

    ctx.TabManager.closeTab(clone.id);
    ctx.__tq.advance(1000);
    assert.equal(revokes(ctx, 'cred_shared').length, 1,
        'the clone was the last referencer: its close releases the handle');
});

test('_closePane does not revoke a pane handle adopted by an extracted tab', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    // _extractPaneToTab adopts the pane's _sshCredId onto the new tab
    // (adoptPaneFieldsIntoTab): after extraction both wrappers hold 'cred_x'.
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    p1._sshCredId = 'cred_x';
    const extracted = { id: 't_ex', name: 'ex', type: 'ssh', host: 'h', user: 'u', connected: true, tabId: 'ssh_C', _credId: 'cred_x', term: null, fitAddon: null };
    ctx.TabManager.tabs.push(extracted);
    ctx.TabManager.render();

    ctx.TabManager._closePane(tab.id, p1.id);
    ctx.__tq.advance(300); // let the pane fade + collapse settle
    assert.equal(revokes(ctx, 'cred_x').length, 0,
        'the extracted tab still reconnects through this handle: not revoked');

    // p2 collapses the split (adopted, no credId of its own); closing the
    // extracted tab is now the last reference → release.
    ctx.TabManager.closeTab(extracted.id);
    ctx.__tq.advance(1000);
    assert.equal(revokes(ctx, 'cred_x').length, 1, 'last reference gone: handle revoked exactly once');
    assert.equal(ctx.TabManager.tabs.some(t => t.id === tab.id), true, 'source tab survives the scenario');
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

test('two panes sharing one handle: the SECOND close (last referencer) releases it', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_A', null, 'ssh_B', null, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    const p1 = ctx.getAllPanes(tab)[0];
    p1._sshCredId = 'cred_x';
    p2._sshCredId = 'cred_x';

    ctx.TabManager._closePane(tab.id, p1.id); // first close: the live sibling holds the handle
    assert.equal(revokes(ctx, 'cred_x').length, 0, 'the live sibling still needs the handle');

    ctx.TabManager._closePane(tab.id, p2.id); // last pane: the dying sibling can no longer reconnect
    assert.equal(revokes(ctx, 'cred_x').length, 1,
        'a pane committed to close is not a surviving reference (old code leaked the handle)');

    ctx.__tq.advance(1000); // fades + whole-tab teardown complete
    assert.equal(revokes(ctx, 'cred_x').length, 1,
        'the later tab teardown does not revoke the same handle twice');
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
