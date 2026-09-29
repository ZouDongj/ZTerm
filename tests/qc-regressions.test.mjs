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

// ── Group combobox ──
// Same keyboard defect as the SSH editor's dropdown (options answered only
// mousedown while Enter dispatches click()), plus a mount leak: openQCEdit
// re-runs initQCGroupCombo on every open, stacking another full listener set
// on the persistent input each time.

function openCombo(ctx) {
    ctx.initQCGroupCombo();
    const input = ctx.document.getElementById('qc-edit-group');
    const menu = ctx.document.getElementById('qc-group-menu');
    input.dispatch('focus', mkEvt());
    return { input, menu };
}

test('Enter picks the active option in the quick-command group dropdown', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const { input, menu } = openCombo(ctx);
    assert.equal(menu.children.length, 2, 'options rendered');

    input.dispatch('keydown', mkEvt({ key: 'ArrowDown' }));
    input.dispatch('keydown', mkEvt({ key: 'Enter' }));

    assert.equal(input.value, 'Ops', 'Enter selects the active group');
    assert.equal(menu.classList.contains('open'), false, 'menu closed after the pick');
});

test('reopening the dialog does not stack another listener set', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const input = ctx.document.getElementById('qc-edit-group');
    const menu = ctx.document.getElementById('qc-group-menu');
    let appends = 0;
    const realAppend = menu.appendChild.bind(menu);
    menu.appendChild = (c) => { appends++; return realAppend(c); };

    ctx.initQCGroupCombo();
    ctx.initQCGroupCombo(); // a second openQCEdit
    input.dispatch('focus', mkEvt());

    assert.equal(appends, 2, 'one render pass for two groups — the mount is idempotent');
});

test('the once-bound dropdown still sees commands added after the first open', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    ctx.initQCGroupCombo();
    setCommands(ctx, [...COMMANDS, { id: '4', name: 'd', command: 'w', group: 'New' }]);
    ctx.initQCGroupCombo(); // reopen after the command set changed

    const input = ctx.document.getElementById('qc-edit-group');
    const menu = ctx.document.getElementById('qc-group-menu');
    input.dispatch('focus', mkEvt());

    const labels = menu.children.map(c => c.textContent);
    assert.deepEqual(labels.sort(), ['Git', 'New', 'Ops'], 'groups are read at render time');
});

// ── closeQC focus restore ──
// Closing via the mask click or the × button (renderer.html inline handlers
// call closeQC directly) left focus on <body> — typing went nowhere. Same
// restore as closePalette: 50ms delay, re-checking at fire time so a
// reopened overlay keeps its own focus.

function stageQcOverlay(ctx) {
    const overlay = ctx.document.getElementById('overlay-qc');
    overlay.className = 'overlay open';
    const refocus = { calls: 0 };
    ctx._refocusActiveTerminal = () => { refocus.calls++; };
    return { overlay, refocus };
}

test('closeQC restores terminal focus after 50ms', () => {
    const ctx = loadQcVm();
    const { overlay, refocus } = stageQcOverlay(ctx);

    ctx.closeQC();
    assert.equal(overlay.classList.contains('open'), false);
    assert.equal(refocus.calls, 0, 'the refocus keeps its 50ms delay');

    ctx.__advance(50);
    assert.equal(refocus.calls, 1, 'the active terminal is refocused');
});

test('no refocus when the overlay reopened inside the window', () => {
    const ctx = loadQcVm();
    const { overlay, refocus } = stageQcOverlay(ctx);

    ctx.closeQC();
    overlay.classList.add('open'); // reopened before the timer fires
    ctx.__advance(50);
    assert.equal(refocus.calls, 0, 'the reopened overlay keeps its input focus');
});

test('no refocus when another overlay opened inside the window', () => {
    const ctx = loadQcVm();
    const { refocus } = stageQcOverlay(ctx);

    ctx.closeQC();
    const other = ctx.document.createElement('div');
    other.className = 'overlay open';
    ctx.document.body.appendChild(other);
    ctx.__advance(50);
    assert.equal(refocus.calls, 0, 'the successor overlay keeps its focus');
});
