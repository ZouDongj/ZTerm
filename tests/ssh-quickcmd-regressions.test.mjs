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

test('P2-03: renaming the default SSH group (stored as "") actually renames', () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [
        { id: 'a', group: '' }, { id: 'b', group: 'Dev' }, { id: 'c' }, // c: no group key at all
    ];
    const { header, btn } = stageSshGroup(ctx, '默认');
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    assert.ok(input, 'rename input staged');
    input.value = 'Prod';

    input.dispatch('keydown', mkEvt({ key: 'Enter' })); // Enter blurs, the blur commits

    const saves = ctx.__sends.filter(s => s.cmd === 'save-ssh-profiles');
    assert.equal(saves.length, 1, 'rename persisted once');
    assert.deepEqual(saves[0].payload.sshProfiles.map(p => p.group), ['Prod', 'Dev', 'Prod'],
        'both empty-string and missing groups matched the 默认 display name');
    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.group), ['Prod', 'Dev', 'Prod']);
});

test('P2-03 (guard): renaming a named group leaves default-group profiles alone', () => {
    const ctx = loadSshVm();
    stubSshDisplay(ctx);
    ctx.TabManager.sshProfiles = [{ id: 'a', group: '' }, { id: 'b', group: 'Dev' }];
    const { header, btn } = stageSshGroup(ctx, 'Dev');
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    input.value = 'Ops';

    input.dispatch('keydown', mkEvt({ key: 'Enter' }));

    const saves = ctx.__sends.filter(s => s.cmd === 'save-ssh-profiles');
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].payload.sshProfiles.map(p => p.group), ['', 'Ops']);
    assert.deepEqual(ctx.TabManager.sshProfiles.map(p => p.group || ''), ['', 'Ops'],
        'the default group keeps its stored empty string (display fallback intact)');
});















