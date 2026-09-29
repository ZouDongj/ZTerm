// Quick-command regressions (quick-commands.js), driven through the REAL
// script in the manager VM (tests/helpers/manager-vm.mjs).
//
// Group rename must finish exactly once: Esc cancels, Enter/blur commits.
// Same defect as the SSH manager's rename (ssh-manager-regressions.test.mjs):
// finish() replaces the still-focused input, Blink dispatches blur
// SYNCHRONOUSLY on that removal, and the Esc path re-entered as finish(true),
// still saving the typed name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQcVm, runIn, mkEvt } from './helpers/manager-vm.mjs';

const COMMANDS = [
    { id: '1', name: 'a', command: 'x', group: 'Ops' },
    { id: '2', name: 'b', command: 'y', group: 'Git' },
    { id: '3', name: 'c', command: 'z', group: 'Ops' },
];

// _qcCommands is a top-level `let` in quick-commands.js: assign it inside the
// VM (a plain ctx._qcCommands write would shadow, not replace, the binding).
function setCommands(ctx, cmds) {
    runIn(ctx, '_qcCommands = ' + JSON.stringify(cmds));
}
const groupsOf = (ctx) => runIn(ctx, '_qcCommands.map(c => c.group)');

// Stage one group header exactly as _qcGroupHtml paints it (name span +
// rename button with its inline onclick attribute).
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
    btn.setAttribute('onclick', 'event.stopPropagation();startRenameQCGroup(this)');
    header.appendChild(span);
    header.appendChild(btn);
    doc.body.appendChild(header);
    return { header, btn };
}

function startRename(ctx, gname) {
    const { header, btn } = stageGroup(ctx, gname);
    ctx.startRenameQCGroup(btn);
    const input = header.querySelector('input');
    assert.ok(input, 'rename input staged');
    assert.equal(ctx.document.activeElement, input, 'rename input holds focus');
    return { header, btn, input };
}

const savesOf = (ctx, cmd) => ctx.__sends.filter(s => s.cmd === cmd);

test('Escape cancels the group rename even though the removal blur re-enters finish', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const { header, input } = startRename(ctx, 'Ops');
    input.value = 'Renamed';

    input.dispatch('keydown', mkEvt({ key: 'Escape' }));

    assert.equal(savesOf(ctx, 'save-quick-commands').length, 0, 'Escape must not save the typed name');
    assert.equal(groupsOf(ctx).join(','), 'Ops,Git,Ops');
    assert.equal(header.querySelector('input'), null, 'rename input is gone');
    assert.equal(header.querySelector('.group-name-text').textContent, 'Ops', 'old name restored');
});

test('Enter commits the group rename exactly once', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const { input } = startRename(ctx, 'Ops');
    input.value = 'Renamed';

    input.dispatch('keydown', mkEvt({ key: 'Enter' })); // Enter blurs, the blur commits

    const saves = savesOf(ctx, 'save-quick-commands');
    assert.equal(saves.length, 1, 'a single finish — the removal blur must not re-commit');
    // payload was built inside the VM: spread into this realm for deepEqual
    assert.deepEqual([...saves[0].payload.map(c => c.group)], ['Renamed', 'Git', 'Renamed']);
});

test('a real blur (clicking away) still commits the group rename', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const { input } = startRename(ctx, 'Ops');
    input.value = 'Renamed';

    input.blur(); // the click moved focus first; blur is the only finish trigger

    assert.equal(savesOf(ctx, 'save-quick-commands').length, 1, 'blur commits');
});
