// SSH manager regressions (ssh.js), driven through the REAL script in the
// manager VM (tests/helpers/manager-vm.mjs).
//
// Group rename must finish exactly once: Esc cancels, Enter/blur commits.
// The defect: finish() replaces the still-focused input with a span — Blink
// dispatches blur SYNCHRONOUSLY when a DOM removal unloads the focused
// element (modelled by the harness's replaceWith), so the Esc path
// (finish(false)) re-entered as finish(true) and still saved the typed name.
// The repo's own guard precedent is sftp.js _editPath (let done = false),
// already applied to tab rename in tabs.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSshVm, mkEvt } from './helpers/manager-vm.mjs';

// Stage one group header exactly as _sshGroupHtml paints it: title row with
// the name span and the rename button (its inline onclick attribute kept, as
// startRenameGroup reads it back to restore the pencil behavior).
function stageGroup(ctx, gname) {
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

function startRename(ctx, gname) {
    const { header, btn } = stageGroup(ctx, gname);
    ctx.startRenameGroup(btn);
    const input = header.querySelector('input');
    assert.ok(input, 'rename input staged');
    assert.equal(ctx.document.activeElement, input, 'rename input holds focus');
    return { header, btn, input };
}

const savesOf = (ctx, cmd) => ctx.__sends.filter(s => s.cmd === cmd);

test('Escape cancels the group rename even though the removal blur re-enters finish', () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [
        { id: 'a', group: 'Prod' }, { id: 'b', group: 'Dev' }, { id: 'c', group: 'Prod' },
    ];
    const { header, input } = startRename(ctx, 'Prod');
    input.value = 'Renamed';

    input.dispatch('keydown', mkEvt({ key: 'Escape' }));

    assert.equal(savesOf(ctx, 'save-ssh-profiles').length, 0, 'Escape must not save the typed name');
    assert.equal(ctx.TabManager.sshProfiles.map(p => p.group).join(','), 'Prod,Dev,Prod');
    assert.equal(header.querySelector('input'), null, 'rename input is gone');
    assert.equal(header.querySelector('.group-name-text').textContent, 'Prod', 'old name restored');
});

test('Enter commits the group rename exactly once', () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [
        { id: 'a', group: 'Prod' }, { id: 'b', group: 'Dev' }, { id: 'c', group: 'Prod' },
    ];
    const { input } = startRename(ctx, 'Prod');
    input.value = 'Renamed';

    input.dispatch('keydown', mkEvt({ key: 'Enter' })); // Enter blurs, the blur commits

    const saves = savesOf(ctx, 'save-ssh-profiles');
    assert.equal(saves.length, 1, 'a single finish — the removal blur must not re-commit');
    assert.deepEqual(saves[0].payload.sshProfiles.map(p => p.group), ['Renamed', 'Dev', 'Renamed']);
});

test('a real blur (clicking away) still commits the group rename', () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'a', group: 'Prod' }];
    const { input } = startRename(ctx, 'Prod');
    input.value = 'Renamed';

    input.blur(); // the click moved focus first; blur is the only finish trigger

    assert.equal(savesOf(ctx, 'save-ssh-profiles').length, 1, 'blur commits');
});

// ── Confirm (✓) button ──
// The ✓ is the same <button> as the pencil. Without a mousedown guard the
// press moves focus to the button first, the input's blur commits, and the
// arriving click then lands on the just-restored pencil handler — the
// confirm re-enters rename mode instead of finishing.

test('the confirm button blocks the mousedown focus shift', () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'a', group: 'Prod' }];
    const { btn, input } = startRename(ctx, 'Prod');

    const ev = mkEvt();
    btn.dispatch('mousedown', ev);

    assert.equal(ev.defaultPrevented, true, 'mousedown default prevented so the input keeps focus');
    assert.equal(ctx.document.activeElement, input, 'focus stays in the rename input');
});

test('clicking the confirm button commits once and does not re-enter rename', () => {
    const ctx = loadSshVm();
    ctx.TabManager.sshProfiles = [{ id: 'a', group: 'Prod' }];
    const { header, btn, input } = startRename(ctx, 'Prod');
    input.value = 'Renamed';

    btn.dispatch('mousedown', mkEvt());
    btn.dispatch('click', mkEvt());

    assert.equal(savesOf(ctx, 'save-ssh-profiles').length, 1, 'the click commits exactly once');
    assert.equal(header.querySelector('input'), null, 'rename finished — no re-entry');
    assert.equal(header.querySelector('.group-name-text').textContent, 'Renamed');
    assert.equal(btn.onclick, null, 'finish closure cleared');
    assert.equal(btn.getAttribute('onclick'), 'event.stopPropagation();startRenameGroup(this)',
        'pencil attribute handler restored for the next rename');
});
