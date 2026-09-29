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

// ── Group combobox keyboard selection ──
// The dropdown options historically listened only for mousedown; the
// keydown handler's Enter branch dispatches click(), which no one answered —
// keyboard selection was dead.

function openCombo(ctx, profiles) {
    ctx.TabManager.sshProfiles = profiles;
    ctx.initGroupCombo();
    const input = ctx.document.getElementById('ssh-edit-group');
    const menu = ctx.document.getElementById('group-menu');
    input.dispatch('focus', mkEvt());
    return { input, menu };
}

test('Enter picks the active option in the SSH group dropdown', () => {
    const ctx = loadSshVm();
    const { input, menu } = openCombo(ctx, [{ id: 'a', group: 'Prod' }, { id: 'b', group: 'Dev' }]);
    assert.equal(menu.children.length, 2, 'options rendered');

    input.dispatch('keydown', mkEvt({ key: 'ArrowDown' }));
    assert.equal(menu.children[0].classList.contains('active'), true);
    input.dispatch('keydown', mkEvt({ key: 'Enter' }));

    assert.equal(input.value, 'Prod', 'Enter selects the active group');
    assert.equal(menu.classList.contains('open'), false, 'menu closed after the pick');
});

test('Enter on the create row keeps the typed group name', () => {
    const ctx = loadSshVm();
    const { input, menu } = openCombo(ctx, [{ id: 'a', group: 'Prod' }]);
    input.value = 'Staging';
    input.dispatch('input', mkEvt());
    assert.equal(menu.children.length, 1, 'only the create row matches');
    assert.equal(menu.children[0].classList.contains('create'), true);

    input.dispatch('keydown', mkEvt({ key: 'ArrowDown' }));
    input.dispatch('keydown', mkEvt({ key: 'Enter' }));

    assert.equal(input.value, 'Staging', 'the typed name is kept');
    assert.equal(menu.classList.contains('open'), false, 'menu closed after the pick');
});

test('a real mouse pick still works through the shared handler', () => {
    const ctx = loadSshVm();
    const { input, menu } = openCombo(ctx, [{ id: 'a', group: 'Prod' }, { id: 'b', group: 'Dev' }]);

    menu.children[1].dispatch('mousedown', mkEvt());

    assert.equal(input.value, 'Dev', 'mousedown picks as before');
    assert.equal(menu.classList.contains('open'), false);
});

// ── Password status row ──
// The "view" mode row claims "密码已加密保存". blur/Esc/× switched to it
// whenever an existing profile was edited — even one that never had a
// password, where the row is a lie. A password-less profile must keep the
// plain edit field (same shape as a new profile's).

function openEdit(ctx, profile) {
    ctx.TabManager.sshProfiles = [profile];
    ctx.openSSHEdit(false, profile.id);
    ctx.__advance(200); // openSSHEdit's deferred slider/select/focus pass
    return {
        statusEl: ctx.document.getElementById('ssh-pwd-status'),
        pwdInput: ctx.document.getElementById('ssh-edit-password'),
        editBtn: ctx.document.getElementById('ssh-pwd-edit-btn'),
        cancelBtn: ctx.document.getElementById('ssh-pwd-inline-cancel'),
    };
}

test('editing a password-less profile never shows the encrypted-saved row on blur', () => {
    const ctx = loadSshVm();
    const { statusEl, pwdInput } = openEdit(ctx, { id: 'p1', name: 'n1', host: 'h1' });
    assert.equal(statusEl.style.display, 'none', 'edit field shown, no status row');

    pwdInput.value = 'secret';
    pwdInput.onblur();

    assert.equal(statusEl.style.display, 'none', 'blur must not raise the false status row');
    assert.equal(pwdInput.style.display, '', 'the edit field stays');
    assert.equal(pwdInput.value, 'secret', 'the typed password survives until the dialog saves');
});

test('editing a password-less profile hides the cancel-back button', () => {
    const ctx = loadSshVm();
    const { cancelBtn } = openEdit(ctx, { id: 'p1', name: 'n1', host: 'h1' });
    assert.equal(cancelBtn.classList.contains('show'), false,
        'no × without a status row to cancel back to (new-profile shape)');
});

test('Escape in the password field of a password-less profile closes the dialog', () => {
    const ctx = loadSshVm();
    const { statusEl, pwdInput } = openEdit(ctx, { id: 'p1', name: 'n1', host: 'h1' });
    pwdInput.value = 'secret';

    pwdInput.onkeydown(mkEvt({ key: 'Escape' }));

    assert.equal(ctx.__overlayCloseCalls, 1, 'same as Esc on the name/host/user fields');
    assert.equal(statusEl.style.display, 'none', 'no false status row either');
});

test('(guard) a profile with a saved password keeps the status-row flow', () => {
    const ctx = loadSshVm();
    const { statusEl, pwdInput, editBtn, cancelBtn } =
        openEdit(ctx, { id: 'p1', name: 'n1', host: 'h1', encryptedPassword: 'enc' });
    assert.equal(statusEl.style.display, 'flex', 'status row shown for a saved password');

    editBtn.onclick(); // 修改 -> edit mode
    assert.equal(statusEl.style.display, 'none');
    assert.equal(cancelBtn.classList.contains('show'), true, '× offered to cancel back');

    pwdInput.value = 'newpass';
    pwdInput.onblur(); // clicking away cancels the edit
    assert.equal(statusEl.style.display, 'flex', 'blur cancels back to the status row');
    assert.equal(ctx.__overlayCloseCalls, 0);

    editBtn.onclick();
    pwdInput.onkeydown(mkEvt({ key: 'Escape' }));
    assert.equal(statusEl.style.display, 'flex', 'Esc cancels back to the status row');
    assert.equal(ctx.__overlayCloseCalls, 0, 'Esc does not close the dialog here');
});

// ── SFTP menu action ──
// The menu item is enabled when ANY pane of the tab is a connected SSH
// session (toggleMenuPopup), but the action required the FOCUSED pane to be
// one — with the focus on a local pane the enabled item silently did
// nothing. The action now falls back to any connected SSH pane (focused
// first), matching the enable check.

function stageSftp(ctx, tab) {
    const opens = [];
    ctx.TabManager.getActive = () => tab;
    ctx.getAllPanes = (t) => t._panes || [];
    ctx.SFTP = { open: (tabId) => opens.push(tabId) };
    return opens;
}

test('SFTP opens from a connected SSH pane when the focus is on a local pane', () => {
    const ctx = loadSshVm();
    const tab = {
        type: 'local', splitRoot: {},
        _panes: [
            { focused: true, type: 'local', tabId: 'local_1' },
            { type: 'ssh', tabId: 'ssh_9' },
        ],
    };
    const opens = stageSftp(ctx, tab);

    ctx.openSFTPFromMenu();

    assert.deepEqual(opens, ['ssh_9'], 'falls back to the connected SSH pane');
});

test('the focused SSH pane still wins in a split', () => {
    const ctx = loadSshVm();
    const tab = {
        type: 'ssh', splitRoot: {},
        _panes: [
            { focused: true, type: 'ssh', tabId: 'ssh_1' },
            { type: 'ssh', tabId: 'ssh_2' },
        ],
    };
    const opens = stageSftp(ctx, tab);

    ctx.openSFTPFromMenu();

    assert.deepEqual(opens, ['ssh_1']);
});

test('no connected SSH pane means no SFTP session', () => {
    const ctx = loadSshVm();
    const splitOpens = stageSftp(ctx, {
        type: 'local', splitRoot: {},
        _panes: [
            { focused: true, type: 'local', tabId: 'local_1' },
            { type: 'ssh' }, // connecting, no backend tabId yet
        ],
    });
    ctx.openSFTPFromMenu();
    assert.deepEqual(splitOpens, []);

    const localOpens = stageSftp(ctx, { type: 'local', tabId: 'local_1' });
    ctx.openSFTPFromMenu();
    assert.deepEqual(localOpens, []);
});

test('(guard) a non-split SSH tab opens SFTP on itself', () => {
    const ctx = loadSshVm();
    const opens = stageSftp(ctx, { type: 'ssh', tabId: 'ssh_3' });
    ctx.openSFTPFromMenu();
    assert.deepEqual(opens, ['ssh_3']);
});
