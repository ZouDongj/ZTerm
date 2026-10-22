// SSH profiles UI + quick commands regressions (full-readonly-audit
// 2026-10-21 cluster). Driven through the REAL ssh.js / quick-commands.js in
// the manager VM (tests/helpers/manager-vm.mjs) and the REAL tabs.js +
// ipc.js in the renderer VM (tests/helpers/renderer-vm.mjs).
//
// - P2-03: renaming the default SSH group (stored as '', displayed as 默认)
//   matched nothing (p.group === oldName) and silently did nothing.
// - P3-01: SSH save/delete updated the in-memory profile list BEFORE the
//   persist succeeded and swallowed the failure; a failed delete also
//   orphaned its once('ssh-profiles-saved') listener (the NEXT unrelated
//   save then fired a spurious "已删除" toast). Review follow-up: the group
//   rename persist had the same two defects and got the same treatment, so
//   P2-03's tests drive the async invoke path.
// - P3-02 (frontend half): a register-credential refusal caused by an
//   undecryptable stored password (config copied from another Windows
//   user/machine; DPAPI keys are per-user) must surface a specific message
//   instead of a generic registration/auth failure, and the connect path
//   must not fall back to a bare (credential-less) connect. Review
//   follow-up: the session-restore registration path now flags the error
//   state + the specific toast on a refusal instead of a silent gray tab.
// - P3-08 (review follow-up): the new establishment-timeout error wording
//   must stay inside ipc.js's transient classifier so the auto-retry that
//   OS-level timeouts already get still fires.
// - P2-05: a quick command run on the settings tab or a still-connecting
//   SSH tab vanished silently — the panel had already closed, so the
//   command looked executed.
// - P3-05: finishing a QC group rename with an UNCHANGED name re-entered
//   edit mode (the confirm button had no mousedown guard, unlike the SSH
//   group rename).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSshVm, loadQcVm, runIn, mkEvt } from './helpers/manager-vm.mjs';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setImmediate(r));

// renderSSHManager reaches SshDisplay (ssh-display.js, not loaded by the
// manager VM) once profiles render; stub the display model for success paths.
// renderSSHManagerInSettings (settings.js) is likewise not loaded here.
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

// ── P2-03: default SSH group rename ─────────────────────────────────────────

// Stage one group header exactly as _sshGroupHtml paints it (name span +
// rename button with its inline onclick attribute, which startRenameGroup
// reads back to restore the pencil behavior).
function stageSshGroup(ctx, gname) {
    const doc = ctx.document;
    const header = doc.createElement('div');
    header.className = 'ssh-mgr-group-title';
    header.setAttribute('data-group', gname);
    const span = doc.createElement('span');
    span.className = 'group-name-text';
    span.textContent = gname;
    const btn = doc.createElement('button');
    btn.className = 'group-rename';
    btn.setAttribute('onclick', 'event.stopPropagation();startRenameGroup(this)');
    header.appendChild(span);
    header.appendChild(btn);
    doc.body.appendChild(header);
    return { header, btn };
}

// The rename persist runs through invoke (persist-before-memory, P3-01): the
// recorded invocation carries the payload, memory commits after it resolves.
function stageRenameSave(ctx, behavior) {
    const saves = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd !== 'save-ssh-profiles') return new Promise(() => {});
        saves.push({ cmd, payload });
        return behavior === 'reject' ? Promise.reject(new Error('disk read-only')) : Promise.resolve({});
    };
    return saves;
}

test('P2-03: renaming the default SSH group (stored as "") actually renames', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [
        { id: 'a', group: '' }, { id: 'b', group: 'Dev' }, { id: 'c' }, // c: no group key at all
    ];
    const saves = stageRenameSave(ctx);
    const { header, btn } = stageSshGroup(ctx, '默认');
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    assert.ok(input, 'rename input staged');
    input.value = 'Prod';

    input.dispatch('keydown', mkEvt({ key: 'Enter' })); // Enter blurs, the blur commits
    await flush(); await flush();

    assert.equal(saves.length, 1, 'rename persisted once');
    assert.deepEqual(saves[0].payload.sshProfiles.map(p => p.group), ['Prod', 'Dev', 'Prod'],
        'both empty-string and missing groups matched the 默认 display name');
    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.group), ['Prod', 'Dev', 'Prod']);
});

test('P2-03 (guard): renaming a named group leaves default-group profiles alone', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [{ id: 'a', group: '' }, { id: 'b', group: 'Dev' }];
    const saves = stageRenameSave(ctx);
    const { header, btn } = stageSshGroup(ctx, 'Dev');
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    input.value = 'Ops';

    input.dispatch('keydown', mkEvt({ key: 'Enter' }));
    await flush(); await flush();

    assert.equal(saves.length, 1);
    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.group || ''), ['', 'Ops'],
        'the default group keeps its stored empty string (display fallback intact)');
});

// ── P3-01: persist-before-memory, no orphaned once listener ────────────────

// Stage the edit-dialog fields saveSSHEdit reads (the manager VM auto-vivifies
// elements by id; the login-scripts descendant selector resolves to [] there).
function stageSshEditForm(ctx, profile) {
    ctx.TabManager.sshProfiles = [profile];
    runIn(ctx, `_editingSSHId = ${JSON.stringify(profile.id)}; _sshPwdDirty = false;`);
    const g = id => ctx.document.getElementById(id);
    g('ssh-edit-name').value = 'renamed';
    g('ssh-edit-host').value = 'h2';
    g('ssh-edit-port').value = '2222';
    g('ssh-edit-user').value = 'u2';
    g('ssh-edit-password').value = '';
    g('ssh-edit-note').value = '';
    g('ssh-edit-group').value = '';
    g('ssh-edit-auth').value = '密码';
    g('ssh-edit-keypath').value = '';
}

test('P3-01: a failed profile save keeps memory and the dialog untouched', async () => {
    const ctx = loadSshVm();
    stageSshEditForm(ctx, { id: 'p1', name: 'old', host: 'h1', username: 'u1' });
    const closed = [];
    ctx.closeOverlay = id => closed.push(id);
    let renders = 0;
    ctx.renderSSHManagerInSettings = () => renders++;
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'save-ssh-profiles'
        ? Promise.reject(new Error('config is read-only'))
        : new Promise(() => {});

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(ctx.TabManager.sshProfiles[0].name, 'old', 'in-memory profile not mutated');
    assert.equal(ctx.TabManager.sshProfiles[0].host, 'h1');
    assert.equal(renders, 0, 'no re-render on failure');
    assert.deepEqual(closed, [], 'the dialog stays open for a retry');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one error toast');
    assert.match(errToasts[0].msg, /保存失败/);
    assert.ok(!ctx.__toasts.some(t => t.msg === 'SSH 连接已保存'), 'no success toast');
});

test('P3-01 (control): a successful save commits memory, closes and toasts', async () => {
    const ctx = loadSshVm();
    stageSshEditForm(ctx, { id: 'p1', name: 'old', host: 'h1', username: 'u1' });
    const closed = [];
    ctx.closeOverlay = id => closed.push(id);
    let renders = 0;
    ctx.renderSSHManagerInSettings = () => renders++;
    stubSshDisplay(ctx);
    const saved = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'save-ssh-profiles') { saved.push(payload); return Promise.resolve({ ok: true }); }
        return new Promise(() => {});
    };

    await ctx.saveSSHEdit();
    await flush();

    assert.equal(saved.length, 1, 'persisted once');
    assert.equal(ctx.TabManager.sshProfiles[0].name, 'renamed', 'memory committed after persist');
    assert.equal(ctx.TabManager.sshProfiles[0].host, 'h2');
    assert.equal(ctx.TabManager.sshProfiles[0].port, 2222);
    assert.equal(renders, 1, 'manager re-rendered');
    assert.deepEqual(closed, ['overlay-ssh-edit'], 'dialog closed');
    assert.ok(ctx.__toasts.some(t => t.msg === 'SSH 连接已保存' && !t.isError));
});

function stageConfirm(ctx) {
    let onOk = null;
    ctx.showConfirm = (msg, cb) => { onOk = cb; };
    return () => onOk;
}

test('P3-01: a failed profile delete keeps memory and leaves no orphaned listener', async () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h' }];
    const getOnOk = stageConfirm(ctx);
    const onceCalls = [];
    ctx.ipcRenderer.once = (ch) => onceCalls.push(ch);
    let renders = 0;
    ctx.renderSSHManagerInSettings = () => renders++;
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'save-ssh-profiles'
        ? Promise.reject(new Error('config is read-only'))
        : new Promise(() => {});

    ctx.deleteSSHProfile('p1');
    const onOk = getOnOk();
    assert.ok(onOk, 'confirm dialog staged');
    await onOk();
    await flush();

    assert.equal(ctx.TabManager.sshProfiles.length, 1, 'profile kept in memory');
    assert.deepEqual(onceCalls, [], 'no once(ssh-profiles-saved) listener to orphan');
    assert.equal(renders, 0, 'no re-render on failure');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one error toast');
    assert.match(errToasts[0].msg, /删除失败/);
    assert.ok(!ctx.__toasts.some(t => t.msg === 'SSH 连接已删除'), 'no success toast');
});

test('P3-01 (control): a successful delete commits memory and toasts', async () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h' }, { id: 'p2', name: 'm', host: 'h2' }];
    const getOnOk = stageConfirm(ctx);
    let renders = 0;
    ctx.renderSSHManagerInSettings = () => renders++;
    stubSshDisplay(ctx);
    const saved = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'save-ssh-profiles') { saved.push(payload); return Promise.resolve({ ok: true }); }
        return new Promise(() => {});
    };

    ctx.deleteSSHProfile('p1');
    await getOnOk()();
    await flush();

    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.id), ['p2'], 'memory committed after persist');
    assert.deepEqual(saved.length, 1, 'persisted once');
    assert.deepEqual([...saved[0].sshProfiles.map(p => p.id)], ['p2']);
    assert.equal(renders, 1, 'manager re-rendered');
    assert.ok(ctx.__toasts.some(t => t.msg === 'SSH 连接已删除' && !t.isError));
});

test('P3-01: a failed inline password save does not mutate the in-memory ciphertext', async () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h', encryptedPassword: 'enc_old' }];
    runIn(ctx, `_editingSSHId = 'p1'`);
    ctx.document.getElementById('ssh-edit-password').value = 'newpass';
    ctx.ipcRenderer.invoke = (cmd) => {
        if (cmd === 'encrypt-password') return Promise.resolve({ encrypted: 'enc_new' });
        if (cmd === 'save-ssh-profiles') return Promise.reject(new Error('config is read-only'));
        return new Promise(() => {});
    };

    await ctx._savePasswordInline();
    await flush();

    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'enc_old',
        'ciphertext untouched by the failed persist');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one error toast');
    assert.match(errToasts[0].msg, /密码保存失败/);
    assert.ok(!ctx.__toasts.some(t => t.msg === '密码已保存'), 'no success toast');
});

// ── P3-02: undecryptable stored credential (frontend half) ─────────────────
// Backend contract (implemented concurrently in Rust): register-credential
// refuses an undecryptable stored password with errorKind
// 'credential-decrypt-failed' (or a decrypt-flavored error string on older
// builds) and mints no empty-password handle. The frontend matches both
// shapes tolerantly.

function stageConnectProfile(ctx, registerResult) {
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h', username: 'u', encryptedPassword: 'enc' }];
    const created = [];
    ctx.TabManager.createTab = (t) => created.push(t);
    ctx.ipcRenderer.invoke = (cmd) => {
        if (cmd !== 'register-credential') return new Promise(() => {});
        return 'reject' in registerResult
            ? Promise.reject(registerResult.reject)
            : Promise.resolve(registerResult.resolve);
    };
    return created;
}

test('P3-02: connectSSHProfile surfaces the decrypt refusal specifically (errorKind shape)', async () => {
    const ctx = loadSshVm();
    const created = stageConnectProfile(ctx, {
        resolve: { credId: null, error: 'credential decrypt failed', errorKind: 'credential-decrypt-failed' },
    });

    ctx.connectSSHProfile('p1');
    await flush(); await flush();

    assert.equal(created.length, 0, 'no tab created on the refusal');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one error toast');
    assert.match(errToasts[0].msg, /无法在此计算机上解密/, 'specific decrypt message, not generic 凭据注册失败');
});

test('P3-02: the message-only refusal shape (older backend) is matched too', async () => {
    const ctx = loadSshVm();
    const created = stageConnectProfile(ctx, {
        resolve: { credId: null, error: 'Password decrypt failed: DPAPI error 0x8009000b' },
    });

    ctx.connectSSHProfile('p1');
    await flush(); await flush();

    assert.equal(created.length, 0, 'no tab created on the refusal');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1);
    assert.match(errToasts[0].msg, /无法在此计算机上解密/);
});

test('P3-02: a decrypt-flavored invoke rejection is matched; other rejections stay generic', async () => {
    const ctx = loadSshVm();
    const created = stageConnectProfile(ctx, { reject: new Error('credential decrypt failed') });

    ctx.connectSSHProfile('p1');
    await flush(); await flush();

    assert.equal(created.length, 0);
    assert.match(ctx.__toasts.filter(t => t.isError).map(t => t.msg).join('\n'), /无法在此计算机上解密/);

    const ctx2 = loadSshVm();
    const created2 = stageConnectProfile(ctx2, { reject: new Error('ipc down') });
    ctx2.connectSSHProfile('p1');
    await flush(); await flush();
    assert.equal(created2.length, 0);
    const msgs = ctx2.__toasts.filter(t => t.isError).map(t => t.msg);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /凭据注册失败/, 'non-decrypt rejection keeps the generic toast');
});

test('P3-02 (control): a generic registration error keeps the existing toast', async () => {
    const ctx = loadSshVm();
    const created = stageConnectProfile(ctx, { resolve: { credId: null, error: 'store full' } });

    ctx.connectSSHProfile('p1');
    await flush(); await flush();

    assert.equal(created.length, 0);
    const msgs = ctx.__toasts.filter(t => t.isError).map(t => t.msg);
    assert.deepEqual(msgs, ['凭据注册失败: store full']);
});

// The connect path (tabs.js _sshConnectWithCredentials) through the REAL
// tabs.js + ipc.js + ssh-attempts.js: the refusal must fail the attempt with
// the specific reason, never connect bare into a generic auth failure.
function patchInvokeDeferred(ctx) {
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        const rec = { cmd, payload };
        rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
        invokes.push(rec);
        return rec.promise;
    };
    return invokes;
}

function stagePendingSshTab(ctx) {
    ctx.TabManager.sshProfiles = [{ id: 'prof1', name: 'p', host: 'h', username: 'u', encryptedPassword: 'enc' }];
    const tab = {
        id: 't_ssh', name: 't_ssh', type: 'ssh', host: 'h', port: 22, user: 'u',
        sshProfileId: 'prof1', connected: false, tabId: null, term: null, fitAddon: null,
    };
    ctx.TabManager.tabs.push(tab);
    return tab;
}

test('P3-02: the connect path fails with the specific reason instead of a bare connect', async () => {
    const ctx = loadVm();
    const invokes = patchInvokeDeferred(ctx);
    const toasts = [];
    ctx.showToast = (msg, isError) => toasts.push({ msg, isError });
    const tab = stagePendingSshTab(ctx);

    ctx._sshConnectWithCredentials(tab, null);
    const reg = invokes.find(i => i.cmd === 'register-credential');
    assert.ok(reg, 'credential registration invoked');

    reg.resolve({ credId: null, error: 'credential decrypt failed', errorKind: 'credential-decrypt-failed' });
    await flush(); await flush();

    assert.ok(!invokes.some(i => i.cmd === 'ssh-connect'),
        'no bare connect into a generic auth failure');
    assert.equal(tab._sshErrored, true, 'the stored credential is not treated as healthy');
    assert.equal(tab.connected, false);
    assert.ok(toasts.some(t => t.isError && /无法在此计算机上解密/.test(t.msg)),
        'the specific decrypt reason surfaced');
});

test('P3-02 (control): a healthy registration still connects with the fresh handle', async () => {
    const ctx = loadVm();
    const invokes = patchInvokeDeferred(ctx);
    ctx.showToast = () => {};
    const tab = stagePendingSshTab(ctx);

    ctx._sshConnectWithCredentials(tab, null);
    const reg = invokes.find(i => i.cmd === 'register-credential');
    reg.resolve({ credId: 'cred_new' });
    await flush(); await flush();

    const conn = invokes.find(i => i.cmd === 'ssh-connect');
    assert.ok(conn, 'connect enqueued');
    assert.equal(conn.payload.profile.credentialId, 'cred_new', 'fresh handle used');
    assert.equal(tab._credId, 'cred_new', 'wrapper rotated to the fresh handle');
});

// ── P2-05: quick command without a live terminal target ────────────────────

const QC = [{ id: '1', name: 'a', command: 'htop', group: 'Ops' }];

function loadQc(ctx) {
    runIn(ctx, '_qcCommands = ' + JSON.stringify(QC));
}

const ptyInputsOf = (ctx) => ctx.__sends.filter(s => s.cmd === 'pty-input');

test('P2-05: a quick command on the settings tab is rejected with a toast', () => {
    const ctx = loadQcVm();
    loadQc(ctx);
    ctx.TabManager.getActive = () => ({ id: 'settings', type: 'settings' });

    ctx.executeQuickCommand(QC[0]);

    assert.equal(ptyInputsOf(ctx).length, 0, 'nothing injected');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one rejection toast');
    assert.match(errToasts[0].msg, /没有运行中的终端/);
});

test('P2-05: a quick command on a still-connecting SSH tab is rejected with a toast', () => {
    const ctx = loadQcVm();
    loadQc(ctx);
    // Connecting SSH tab: no backend tabId yet (assigned by ssh-connecting).
    ctx.TabManager.getActive = () => ({ id: 't1', type: 'ssh', host: 'h', tabId: null });

    ctx.executeQuickCommand(QC[0]);

    assert.equal(ptyInputsOf(ctx).length, 0, 'nothing injected into a session without a backend id');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1);
    assert.match(errToasts[0].msg, /尚未连接完成/);
});

test('P2-05: a quick command on a split tab whose focused pane is still connecting is rejected', () => {
    const ctx = loadQcVm();
    loadQc(ctx);
    ctx.TabManager.getActive = () => ({ id: 't1', type: 'ssh', splitRoot: {} });
    ctx.getAllPanes = () => [{ focused: true, tabId: null }, { focused: false, tabId: 'ok' }];

    ctx.executeQuickCommand(QC[0]);

    assert.equal(ptyInputsOf(ctx).length, 0, 'not silently rerouted to a sibling pane either');
    assert.equal(ctx.__toasts.filter(t => t.isError).length, 1);
});

test('P2-05: qcRun still closes the panel on the rejection path', () => {
    const ctx = loadQcVm();
    loadQc(ctx);
    const overlay = ctx.document.getElementById('overlay-qc');
    overlay.className = 'overlay open';
    ctx._refocusActiveTerminal = () => {};
    ctx.TabManager.getActive = () => ({ id: 'settings', type: 'settings' });

    ctx.qcRun('1');

    assert.equal(overlay.classList.contains('open'), false, 'panel close behavior unchanged');
    assert.equal(ctx.__toasts.filter(t => t.isError).length, 1, 'rejection toast shown');
});

test('P2-05 (control): a healthy local tab still receives the command', () => {
    const ctx = loadQcVm();
    loadQc(ctx);
    const term = { focus() {} };
    ctx.TabManager.getActive = () => ({ id: 't1', type: 'local', tabId: 'pty_1', term });

    ctx.executeQuickCommand(QC[0]);

    const inputs = ptyInputsOf(ctx);
    assert.equal(inputs.length, 1, 'command injected');
    assert.equal(inputs[0].payload.tabId, 'pty_1');
    assert.equal(inputs[0].payload.data, 'htop');
    assert.equal(ctx.__toasts.length, 0, 'no toast on the success path');
});


// ── P3-01 (review follow-up): the group rename persist had the same defects
// P3-01 removed from save/delete — memory mutated before the write, failure
// swallowed, orphaned once('ssh-profiles-saved') listener. It now persists
// first and commits memory only on success ─────────────────────────────────

test('P3-01: a failed group rename keeps memory and toasts the failure', async () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [{ id: 'a', group: '' }, { id: 'b', group: 'Dev' }];
    const saves = stageRenameSave(ctx, 'reject');
    const { header, btn } = stageSshGroup(ctx, 'Dev');
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    input.value = 'Ops';

    input.dispatch('keydown', mkEvt({ key: 'Enter' }));
    await flush(); await flush();

    assert.equal(saves.length, 1, 'the write was attempted');
    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.group), ['', 'Dev'],
        'memory keeps the old groups when the write fails');
    const errToasts = ctx.__toasts.filter(t => t.isError);
    assert.equal(errToasts.length, 1, 'one error toast');
    assert.match(errToasts[0].msg, /分组重命名失败/);
    assert.ok(!ctx.__toasts.some(t => t.msg === '分组已重命名'), 'no success toast on failure');
});

// ── P3-02 (review follow-up): the session-RESTORE credential registration
// (single SSH tab) failed safe but silently — a decrypt refusal left a gray
// tab with no reason. It now flags the error state and says why ───────────

function stageRestoreVm() {
    const ctx = loadVm();
    let profilesFn = null;
    ctx.ipcRenderer.once = (ch, fn) => { if (ch === 'profiles') profilesFn = fn; };
    const toasts = [];
    ctx.showToast = (msg, isError) => toasts.push({ msg, isError });
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        if (cmd === 'get-local-shells') return Promise.resolve([]);
        const rec = { cmd, payload };
        rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
        invokes.push(rec);
        return rec.promise;
    };
    ctx.TabManager.init();
    return { ctx, invokes, toasts, getProfilesFn: () => profilesFn };
}

const SSH_RESTORE_PROFILES = [{ id: 'prof1', name: 'p', host: 'h', username: 'u', encryptedPassword: 'enc' }];
const SSH_RESTORE_TABS = [{ name: 'box', type: 'ssh', host: 'h', port: 22, user: 'u', sshProfileId: 'prof1' }];

test('P3-02: a decrypt refusal at session restore flags the tab errored with the specific reason', async () => {
    const { ctx, invokes, toasts, getProfilesFn } = stageRestoreVm();
    assert.ok(getProfilesFn(), 'profiles restore handler registered');
    const done = getProfilesFn()({}, {
        profiles: [], sshProfiles: SSH_RESTORE_PROFILES, lastTabs: SSH_RESTORE_TABS,
    });
    await flush();
    const reg = invokes.find(i => i.cmd === 'register-credential');
    assert.ok(reg, 'restore registers the stored credential');

    reg.resolve({ credId: null, error: 'credential decrypt failed', errorKind: 'credential-decrypt-failed' });
    await done; await flush(); await flush();

    const tab = ctx.TabManager.tabs.find(t => t.type === 'ssh');
    assert.ok(tab, 'ssh tab restored');
    assert.equal(tab.connected, false);
    assert.equal(tab._sshErrored, true, 'the stored credential is not treated as healthy');
    assert.ok(!invokes.some(i => i.cmd === 'ssh-connect'), 'no bare connect on the refusal');
    assert.ok(toasts.some(t => t.isError && /无法在此计算机上解密/.test(t.msg)),
        'the specific decrypt reason surfaced at restore');
});

test('P3-02 (guard): a non-decrypt registration failure at restore stays a plain disconnected tab', async () => {
    const { ctx, invokes, toasts, getProfilesFn } = stageRestoreVm();
    const done = getProfilesFn()({}, {
        profiles: [], sshProfiles: SSH_RESTORE_PROFILES, lastTabs: SSH_RESTORE_TABS,
    });
    await flush();
    invokes.find(i => i.cmd === 'register-credential')
        .resolve({ credId: null, error: 'credential store full' });
    await done; await flush(); await flush();

    const tab = ctx.TabManager.tabs.find(t => t.type === 'ssh');
    assert.equal(tab.connected, false);
    assert.ok(!tab._sshErrored, 'no error flag for a generic failure');
    assert.equal(toasts.filter(t => t.isError).length, 0, 'no decrypt toast');
});

// ── P3-08 (review follow-up): the new establishment-timeout wording must
// stay inside ipc.js's transient-failure classifier, or tarpit/slow-network
// connects lose the auto-retry OS-level timeouts (os error 10060) already get

test('P3-08: the establishment-budget timeout auto-retries as transient', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_to', 'ssh_7', undefined, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.__emit('ssh-error', {
        tabId: 'ssh_7', rendererId: tab.id,
        error: 'SSH auth: timed out (establishment budget of 30s exhausted)',
    });
    assert.equal(tab._sshRetried, 1, 'timed-out establishment classified as transient');
});

test('P3-08: the connect-phase timeout wording also auto-retries', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_to2', 'ssh_8', undefined, { type: 'ssh', connected: true, host: 'h', user: 'u' });
    ctx.__emit('ssh-error', {
        tabId: 'ssh_8', rendererId: tab.id,
        error: 'SSH connect (tcp/handshake 1.2.3.4:22): timed out after 30s (no response)',
    });
    assert.equal(tab._sshRetried, 1);
});
