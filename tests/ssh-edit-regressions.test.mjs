// SSH edit dialog regressions (ssh.js), driven through the REAL script in
// the manager VM (tests/helpers/manager-vm.mjs).
//
// 1. Login-script values must survive rendering and collection byte-for-byte,
//    including quotes, markup characters and every newline convention. The
//    single-line input's native newline stripping must not corrupt stored data.
// 2. Listener stacking: openSSHEdit ran on every dialog open but its targets
//    (group combobox input, save button, inline password buttons) are static
//    page elements — a fresh addEventListener per open piled up handlers and
//    made group typing progressively slower (legacy K3). The bindings are now
//    one-shot; only the option data refreshes per open.
// 3. Floating add-menu: ssh-add-menu is a popup, not an .overlay, so
//    openOverlay's closeAllOverlays pass never dismissed it — a keyboard
//    open of the session selector (Ctrl+Shift+N) or the SSH manager
//    (Ctrl+Shift+S) left the menu floating above the fullscreen overlay.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSshVm, mkEvt } from './helpers/manager-vm.mjs';

// The harness stubs escHtml/escAttr as identity; run the REAL definitions
// from utils.js inside the VM so an escaping regression is actually visible.
function withRealEscapers(ctx) {
    const utilsSrc = readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8');
    const def = (name) => {
        const m = new RegExp('^function ' + name + '\\b.*$', 'm').exec(utilsSrc);
        assert.ok(m, name + ' definition found in utils.js');
        return m[0];
    };
    vm.runInContext(def('escHtml') + '\n' + def('escAttr'), ctx, { filename: 'utils.js (escapers)' });
    return ctx;
}

function paintedScripts(ctx) {
    const container = ctx.document.getElementById('login-scripts-container');
    const rows = container.children.filter(c => c.className === 'login-script-row');
    assert.equal(rows.length, 1, 'one script row appended');
    const querySelectorAll = ctx.document.querySelectorAll;
    ctx.document.querySelectorAll = selector => selector === '#login-scripts-container .login-script-row'
        ? rows
        : querySelectorAll(selector);
    const collected = ctx.collectLoginScripts();
    assert.equal(collected.length, 1, 'one script survives collection');
    return { 'ls-expect': collected[0].expect, 'ls-send': collected[0].send };
}

const listenerCount = (el, type) => (el._listeners.get(type) || []).length;

// ── Login-script value quoting ──

test('a login script with quotes, ampersand and angle brackets round-trips through the row render', () => {
    const ctx = withRealEscapers(loadSshVm());
    ctx.addLoginScriptRow('prompt "yes/no"?', 'echo "done" & <exit>');
    const got = paintedScripts(ctx);
    assert.equal(got['ls-expect'], 'prompt "yes/no"?', 'Expect survives rendering and collection');
    assert.equal(got['ls-send'], 'echo "done" & <exit>', 'Send survives rendering and collection');
});

test('reopening a profile with quoted login scripts repaints them intact', () => {
    const ctx = withRealEscapers(loadSshVm());
    ctx.TabManager.sshProfiles = [{
        id: 'p1', name: 'n1', host: 'h1',
        loginScripts: [{ expect: 'want "yes"?', send: 'send "ok"', isRegex: false, optional: true }],
    }];
    ctx.openSSHEdit(false, 'p1');
    ctx.__advance(200); // openSSHEdit's deferred slider/select/focus pass
    const got = paintedScripts(ctx);
    assert.equal(got['ls-expect'], 'want "yes"?');
    assert.equal(got['ls-send'], 'send "ok"');
});

test('login scripts preserve CR, CRLF and LF byte sequences through collection', () => {
    const ctx = withRealEscapers(loadSshVm());
    const expect = 'first\r\nsecond\nthird\rfourth 雪 😀';
    const send = 'send\r\nnext\nlast\rend " < > &';
    ctx.addLoginScriptRow(expect, send);
    const got = paintedScripts(ctx);
    assert.equal(got['ls-expect'], expect);
    assert.equal(got['ls-send'], send);
});

// ── One-shot dialog bindings (listener count constant across opens) ──

test('repeated dialog opens never stack listeners on the group combobox input', () => {
    const ctx = loadSshVm();
    for (let i = 0; i < 3; i++) { ctx.openSSHEdit(true); ctx.__advance(200); }
    const input = ctx.document.getElementById('ssh-edit-group');
    for (const type of ['focus', 'input', 'mousedown', 'blur', 'keydown']) {
        assert.equal(listenerCount(input, type), 1, `group input "${type}" bound exactly once`);
    }
});

test('repeated dialog opens never stack mousedown guards on the password buttons', () => {
    const ctx = loadSshVm();
    for (let i = 0; i < 3; i++) { ctx.openSSHEdit(true); ctx.__advance(200); }
    assert.equal(listenerCount(ctx.document.getElementById('ssh-edit-save-btn'), 'mousedown'), 1,
        'save button guard bound exactly once');
    for (const id of ['ssh-pwd-inline-save', 'ssh-pwd-inline-cancel', 'ssh-pwd-inline-eye']) {
        assert.equal(listenerCount(ctx.document.getElementById(id), 'mousedown'), 1,
            id + ' guard bound exactly once');
    }
});

test('the once-bound save-button guard still keeps focus in the password field', () => {
    const ctx = loadSshVm();
    ctx.openSSHEdit(true); ctx.__advance(200);
    const pwd = ctx.document.getElementById('ssh-edit-password');
    const saveBtn = ctx.document.getElementById('ssh-edit-save-btn');

    pwd.focus();
    const guard = mkEvt();
    saveBtn.dispatch('mousedown', guard);
    assert.equal(guard.defaultPrevented, true, 'blur prevention active after the single binding');

    // Focus elsewhere: the guard must not swallow the default focus shift
    ctx.document.activeElement = ctx.document.body;
    const plain = mkEvt();
    saveBtn.dispatch('mousedown', plain);
    assert.equal(plain.defaultPrevented, false, 'no preventDefault without the password field focused');
});

test('the once-bound group dropdown still refreshes its options on every open', () => {
    const ctx = loadSshVm();
    const input = ctx.document.getElementById('ssh-edit-group');
    const menu = ctx.document.getElementById('group-menu');

    ctx.TabManager.sshProfiles = [{ id: 'a', group: 'Prod' }];
    ctx.openSSHEdit(true); ctx.__advance(200);
    input.dispatch('focus', mkEvt());
    assert.equal(menu.children.length, 1, 'first open: one group option');

    ctx.TabManager.sshProfiles = [{ id: 'a', group: 'Prod' }, { id: 'b', group: 'Dev' }];
    ctx.openSSHEdit(true); ctx.__advance(200);
    input.dispatch('focus', mkEvt());
    assert.equal(menu.children.length, 2, 'reopen picks up the new group list');
});

// ── Floating add-connection menu closed by fullscreen overlay opens ──

function stageAddMenu(ctx) {
    // getSessionItems delegates to these renderer helpers from other files
    ctx.buildSessionItems = () => [];
    ctx.filterSessionItems = (items) => items;
    // renderSSHManager also repaints the settings-page mirror (settings.js)
    ctx.renderSSHManagerInSettings = () => {};
    // Harness gaps only: window.addEventListener/removeEventListener back the
    // menu's resize-detach hook, and the fake search input lacks removeAttribute
    ctx.addEventListener = () => {};
    ctx.removeEventListener = () => {};
    ctx.document.removeEventListener = () => {};
    ctx.document.getElementById('sessions-search').removeAttribute = () => {};
    const trigger = ctx.document.createElement('button');
    ctx.document.body.appendChild(trigger);
    ctx.openSSHAddMenu(trigger);
    const menu = ctx.document.getElementById('ssh-add-menu');
    assert.equal(menu.classList.contains('open'), true, 'add menu staged open');
    return { trigger, menu };
}

test('opening the session selector closes a floating add-connection menu', () => {
    const ctx = loadSshVm();
    const { trigger, menu } = stageAddMenu(ctx);

    ctx.openSessionSelector();

    assert.equal(menu.classList.contains('open'), false, 'add menu dismissed with the selector');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'trigger state restored');
});

test('opening the SSH manager closes a floating add-connection menu', () => {
    const ctx = loadSshVm();
    const { trigger, menu } = stageAddMenu(ctx);

    ctx.openSSHManager();

    assert.equal(menu.classList.contains('open'), false, 'add menu dismissed with the manager');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'trigger state restored');
});

test('(guard) opening the session selector with no add menu open changes nothing', () => {
    const ctx = loadSshVm();
    ctx.buildSessionItems = () => [];
    ctx.filterSessionItems = (items) => items;
    ctx.document.getElementById('sessions-search').removeAttribute = () => {};
    const menu = ctx.document.getElementById('ssh-add-menu');

    ctx.openSessionSelector();

    assert.equal(menu.classList.contains('open'), false, 'menu stays closed (no error path)');
});
