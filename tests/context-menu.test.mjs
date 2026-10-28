// In-app text-edit context menu (src/renderer/context-menu.js): with the
// native WebView2 menus disabled, plain input/textarea controls get an
// application menu (cut/copy/paste/select-all) driven through the real
// clipboard IPC commands. Password fields never expose copy/cut;
// readonly/disabled controls never get fake-available edit actions; the
// xterm helper textarea and IME composition are never intercepted. Async
// clipboard results re-validate the control (connection + focus + menu
// generation) before applying. Runs the real script inside the shared
// sftp-vm seam; clipboard invoke settlements are driven by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const SRC = existsSync(new URL('../src/renderer/context-menu.js', import.meta.url))
    ? readFileSync(new URL('../src/renderer/context-menu.js', import.meta.url), 'utf8')
    : null;

const SHORTCUTS_SRC = existsSync(new URL('../src/renderer/shortcuts.js', import.meta.url))
    ? readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8')
    : null;

async function loadMenuVm() {
    const vmx = await loadSftpVm();
    if (SRC) {
        vm.runInContext(SRC, vmx.ctx, { filename: 'context-menu.js' });
        vmx.ctx.ContextMenu = vm.runInContext('ContextMenu', vmx.ctx);
    }
    return vmx;
}

function fireDocContextMenu(ctx, target, over = {}) {
    // The document capture listener is recorded (never auto-run); drive the
    // REAL registered handlers with a synthetic event.
    const ev = {
        target,
        _prevented: false,
        _stopped: false,
        preventDefault() { ev._prevented = true; },
        stopPropagation() { ev._stopped = true; },
        stopImmediatePropagation() { ev._stopped = true; },
        clientX: 10, clientY: 10,
        isComposing: false,
        ...over,
    };
    for (const fn of (ctx.__docListeners.get('contextmenu') || []).slice()) fn(ev);
    return ev;
}

function menuEl(vm) {
    return vm.ctx.document.getElementById('app-context-menu');
}

function menuItems(vm) {
    const menu = menuEl(vm);
    assert.ok(menu, 'menu element mounted');
    return menu.children.filter(c => c.classList.contains('tab-context-item'));
}

function itemState(vm) {
    return menuItems(vm).map(c => ({ label: String(c.textContent || ''), disabled: c.classList.contains('disabled') }));
}

function clickItem(vm, label) {
    const item = menuItems(vm).find(c => String(c.textContent || '') === label);
    assert.ok(item, `menu item "${label}" present`);
    item.dispatch('click', { preventDefault() {}, stopPropagation() {} });
}

function makeInput(ctx, over = {}) {
    const el = ctx.document.createElement('input');
    Object.assign(el, { value: '' }, over);
    // Model a real focused control: caret offsets always exist (a real
    // input's selectionStart is never undefined), positioned at the end
    // after a value assignment.
    if (typeof el.selectionStart !== 'number') {
        el.selectionStart = String(el.value || '').length;
        el.selectionEnd = el.selectionStart;
    }
    ctx.document.body.appendChild(el);
    return el;
}

test('right-click on a text input opens the in-app edit menu and suppresses the browser menu', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'hello world' });
    input.selectionStart = 0; input.selectionEnd = 5;
    vm.ctx.document.activeElement = input;

    const ev = fireDocContextMenu(vm.ctx, input);
    assert.equal(ev._prevented, true, 'native menu suppressed');
    assert.equal(ev._stopped, true, 'downstream handlers must not stack their own menu');
    const labels = itemState(vm).map(i => i.label);
    assert.deepEqual(labels, ['剪切', '复制', '粘贴', '全选']);
});

test('selection-dependent items reflect the current selection; password hides copy/cut', async () => {
    const vm = await loadMenuVm();
    // No selection: cut/copy disabled, paste/select-all usable.
    let input = makeInput(vm.ctx, { value: 'abc' });
    fireDocContextMenu(vm.ctx, input);
    let state = itemState(vm);
    assert.deepEqual(state, [
        { label: '剪切', disabled: true },
        { label: '复制', disabled: true },
        { label: '粘贴', disabled: false },
        { label: '全选', disabled: false },
    ]);

    // With a selection everything is usable.
    input.selectionStart = 0; input.selectionEnd = 2;
    fireDocContextMenu(vm.ctx, input);
    assert.deepEqual(itemState(vm).every(i => !i.disabled), true, 'selection enables cut/copy');

    // Password: reading actions are never offered as usable.
    input = makeInput(vm.ctx, { value: 'secret', type: 'password' });
    input.selectionStart = 0; input.selectionEnd = 6;
    fireDocContextMenu(vm.ctx, input);
    state = itemState(vm);
    assert.deepEqual(state.filter(i => i.label === '剪切' || i.label === '复制').every(i => i.disabled), true,
        'password copy/cut are not usable');
    assert.deepEqual(state.filter(i => i.label === '粘贴' || i.label === '全选').every(i => !i.disabled), true,
        'password paste/select-all stay usable');
});

test('readonly and disabled controls never get fake-available edit actions', async () => {
    const vm = await loadMenuVm();
    // readonly: copy works, mutating actions disabled.
    let input = makeInput(vm.ctx, { value: 'locked', readOnly: true });
    input.selectionStart = 0; input.selectionEnd = 6;
    fireDocContextMenu(vm.ctx, input);
    const ro = Object.fromEntries(itemState(vm).map(i => [i.label, i.disabled]));
    assert.equal(ro['剪切'], true);
    assert.equal(ro['粘贴'], true);
    assert.equal(ro['复制'], false, 'copying from a readonly field is legitimate');

    // disabled: no menu at all (nothing on it is actionable).
    input = makeInput(vm.ctx, { value: 'x', disabled: true });
    const ev = fireDocContextMenu(vm.ctx, input);
    assert.equal(ev._prevented, true, 'browser menu still suppressed');
    assert.equal(menuEl(vm), null, 'no in-app menu for a disabled control');
});

test('non-text inputs and the xterm helper textarea are not intercepted', async () => {
    const vm = await loadMenuVm();
    // A checkbox is not a text control: no menu, and propagation continues.
    const box = makeInput(vm.ctx, { type: 'checkbox' });
    let ev = fireDocContextMenu(vm.ctx, box);
    assert.equal(ev._stopped, false, 'non-text targets keep propagating to existing handlers');
    assert.equal(menuEl(vm), null, 'no menu for a non-text control');

    // The xterm helper textarea belongs to the terminal: never intercepted.
    const helper = vm.ctx.document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    vm.ctx.document.body.appendChild(helper);
    ev = fireDocContextMenu(vm.ctx, helper);
    assert.equal(ev._stopped, false, 'terminal helper textarea is never stolen');
    assert.equal(menuEl(vm), null, 'no in-app menu over the terminal');
});

test('cut and copy go through the clipboard IPC and edit through input events', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'hello world' });
    input.selectionStart = 0; input.selectionEnd = 5;
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);
    vm.ctx.document.activeElement = input;

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '复制');
    await vm.drain();
    let call = vm.pending('clipboard-write-text')[0];
    assert.ok(call, 'copy used the clipboard IPC command');
    assert.equal(call.args.text, 'hello');
    vm.settle(call, { ok: true });
    await vm.drain();
    assert.equal(input.value, 'hello world', 'copy does not modify the field');
    assert.equal(menuEl(vm), null, 'menu closed after the clipboard result');

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '剪切');
    await vm.drain();
    call = vm.pending('clipboard-write-text')[0];
    assert.ok(call, 'cut used the clipboard IPC command');
    vm.settle(call, { ok: true });
    await vm.drain();
    assert.equal(input.value, ' world', 'cut removed the selection');
    assert.ok(inputEvents >= 1, 'the edit fired an input event the app can observe');
});

test('paste reads the clipboard through IPC, revalidates the control, and inserts at the caret', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'ab' });
    input.selectionStart = 1; input.selectionEnd = 1;
    vm.ctx.document.activeElement = input;

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '粘贴');
    await vm.drain();
    const call = vm.pending('clipboard-read-text')[0];
    assert.ok(call, 'paste used the clipboard IPC command');
    vm.settle(call, 'X');
    await vm.drain();
    await vm.drain();
    assert.equal(input.value, 'aXb', 'pasted text landed at the caret');
    assert.equal(menuEl(vm), null, 'menu closed after the paste settled');
});

test('an async paste whose control died mid-flight applies nothing', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'ab' });
    vm.ctx.document.activeElement = input;

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '粘贴');
    await vm.drain();
    const call = vm.pending('clipboard-read-text')[0];
    assert.ok(call);
    // The view re-rendered and the control is gone before the read resolves.
    input.remove();
    vm.settle(call, 'LATE');
    await vm.drain();
    await vm.drain();
    assert.equal(input.value, 'ab', 'a disconnected control is never edited');
});

test('a superseded menu generation applies no stale paste', async () => {
    const vm = await loadMenuVm();
    const first = makeInput(vm.ctx, { value: 'one' });
    const second = makeInput(vm.ctx, { value: 'two' });
    vm.ctx.document.activeElement = first;

    fireDocContextMenu(vm.ctx, first);
    clickItem(vm, '粘贴');
    await vm.drain();
    const stale = vm.pending('clipboard-read-text')[0];
    assert.ok(stale);

    // A second menu supersedes the first before its clipboard read lands.
    // (A real browser focuses the right-clicked control on mousedown; the
    // menu chrome itself never moves focus.)
    fireDocContextMenu(vm.ctx, second);
    vm.ctx.document.activeElement = second;
    clickItem(vm, '粘贴');
    await vm.drain();
    const pendingReads = vm.pending('clipboard-read-text');
    assert.equal(pendingReads.length, 2, 'two in-flight reads (stale + fresh)');
    const fresh = pendingReads[1];
    assert.ok(fresh);
    vm.settle(stale, 'STALE');
    vm.settle(fresh, 'FRESH');
    await vm.drain();
    await vm.drain();
    assert.equal(first.value, 'one', 'stale generation applied nothing');
    assert.equal(second.value, 'twoFRESH', 'the current generation applied the paste');
});

test('select-all works without the clipboard and closes the menu', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'pick me' });
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '全选');
    await vm.drain();
    assert.equal(vm.pending('clipboard-read-text').length + vm.pending('clipboard-write-text').length, 0,
        'select-all never touches the clipboard');
    assert.equal(menuEl(vm), null, 'menu closed');
});

test('menu closes on an outside mousedown and returns focus, without leftover listeners', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'x' });
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    assert.ok(menuEl(vm));

    const before = vm.ctx.__docListeners.get('mousedown')?.length || 0;
    const outside = makeInput(vm.ctx, { value: 'y' });
    for (const fn of (vm.ctx.__docListeners.get('mousedown') || []).slice()) fn({ target: outside });
    await vm.drain();
    assert.equal(menuEl(vm), null, 'outside mousedown closed the menu');
    assert.equal(vm.ctx.document.activeElement, input, 'focus returned to the edited control');
    const after = vm.ctx.__docListeners.get('mousedown')?.length || 0;
    assert.ok(after <= before, `listener removed on close (${before} -> ${after})`);
});

test('keyboard: Escape closes through document-level routing, arrows move the visual active item, Enter activates', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'abc' });
    input.selectionStart = 0; input.selectionEnd = 3; // every item enabled
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    const menu = menuEl(vm);
    assert.equal(menu.getAttribute('role'), 'menu', 'menu exposes role=menu');
    assert.ok(menu.children.some(c => c.getAttribute('role') === 'menuitem'), 'items expose role=menuitem');

    // The editor keeps DOM focus the whole time: menu keys are routed through
    // the document-capture handler, never through a focused menu item.
    const key = (k, over = {}) => {
        const ev = { key: k, target: input, preventDefault() { ev._p = true; }, stopPropagation() { ev._s = true; }, ...over };
        for (const fn of (vm.ctx.__docListeners.get('keydown') || []).slice()) fn(ev);
        return ev;
    };
    // Arrows move the VISUAL active item without touching DOM focus.
    let ev = key('ArrowDown');
    assert.equal(ev._p, true, 'menu keys are consumed before the editor sees them');
    assert.equal(vm.ctx.document.activeElement, input, 'arrows never move DOM focus off the editor');
    const items = menuItems(vm);
    const activeAfterDown = items.filter(c => c.classList.contains('active')).map(c => c.textContent);
    assert.deepEqual(activeAfterDown, ['复制'], 'ArrowDown moved the visual active item from 剪切 to 复制');
    key('ArrowUp');
    assert.deepEqual(menuItems(vm).filter(c => c.classList.contains('active')).map(c => c.textContent), ['剪切'],
        'ArrowUp moved it back');

    // Enter activates the ACTIVE item (here: select-all via End navigation).
    key('End');
    assert.deepEqual(menuItems(vm).filter(c => c.classList.contains('active')).map(c => c.textContent), ['全选']);
    input.selectionStart = input.selectionEnd = 0;
    ev = key('Enter');
    assert.equal(ev._p, true, 'Enter is consumed by the menu');
    assert.equal(input.selectionStart, 0, 'select-all ran through the menu activation');
    assert.equal(menuEl(vm), null, 'menu closed after activation');

    // Escape closes through the same routing.
    fireDocContextMenu(vm.ctx, input);
    ev = key('Escape');
    assert.equal(ev._p, true, 'Escape is consumed by the menu');
    assert.equal(menuEl(vm), null, 'Escape closed the menu');
});

test('opening the menu never moves DOM focus off the edited control', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'x' });
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    assert.ok(menuEl(vm), 'menu mounted');
    assert.equal(vm.ctx.document.activeElement, input,
        'the menu chrome must never take DOM focus (an inline editor under it would blur-cancel)');
});

test('menu item pointerdown is prevented so clicking an item never steals focus', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'x' });
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    const item = menuItems(vm)[2]; // Paste
    let prevented = false;
    item.dispatch('pointerdown', { preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true, 'pointerdown on a menu item is preventDefault-ed (no focus transfer)');
    assert.equal(vm.ctx.document.activeElement, input, 'DOM focus stays on the edited control');
});

test('IME composition keys never activate the menu', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'ab' });
    vm.ctx.document.activeElement = input;
    fireDocContextMenu(vm.ctx, input);
    // Composing Enter/Space/Escape must pass through untouched: no
    // activation, no close, no key consumption.
    const key = (k) => {
        const ev = { key: k, isComposing: true, keyCode: 229, target: input, preventDefault() { ev._p = true; }, stopPropagation() { ev._s = true; } };
        for (const fn of (vm.ctx.__docListeners.get('keydown') || []).slice()) fn(ev);
        return ev;
    };
    for (const k of ['Enter', ' ', 'Escape', 'ArrowDown']) {
        const ev = key(k);
        assert.equal(ev._p, undefined, `composing ${JSON.stringify(k)} must not be consumed`);
        assert.equal(ev._s, undefined, `composing ${JSON.stringify(k)} must not be stopped`);
    }
    assert.ok(menuEl(vm), 'composing keys did not close the menu');
    assert.equal(vm.pending('clipboard-read-text').length, 0, 'composing Enter did not activate any item');
});

test('number-style control (selection APIs throw): no fake cut/copy; failed paste surfaces a toast, never a silent edit', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { type: 'number', value: '12' });
    // Model a real Chromium number input: reading/writing selection throws.
    const thrower = () => { throw new Error("type=number doesn't support selection"); };
    Object.defineProperty(input, 'selectionStart', { get: thrower, set: thrower });
    Object.defineProperty(input, 'selectionEnd', { get: thrower, set: thrower });
    vm.ctx.document.activeElement = input;

    fireDocContextMenu(vm.ctx, input);
    assert.ok(menuEl(vm), 'the menu itself must survive selection-API failures');
    const state = itemState(vm);
    assert.deepEqual(state.filter(i => i.label === '剪切' || i.label === '复制').every(i => i.disabled), true,
        'unreadable selection: cut/copy are not fake-available');
    assert.deepEqual(state.filter(i => i.label === '粘贴').every(i => !i.disabled), true, 'paste stays available');

    const toastsBefore = vm.toasts.length;
    clickItem(vm, '粘贴');
    await vm.drain();
    const call = vm.pending('clipboard-read-text')[0];
    assert.ok(call, 'paste used the clipboard IPC');
    vm.settle(call, '9');
    await vm.drain();
    await vm.drain();
    // The fake VM has no execCommand and the control's selection APIs throw:
    // the edit must fail VISIBLY (toast) and not pretend success.
    assert.equal(input.value, '12', 'a control whose editing APIs all failed is never silently edited');
    assert.ok(vm.toasts.length > toastsBefore && vm.toasts[vm.toasts.length - 1].isErr,
        'the failed paste surfaces an error toast');
});

test('a successful clipboard edit fires input and change exactly once each', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'ab' });
    input.selectionStart = 1; input.selectionEnd = 1;
    vm.ctx.document.activeElement = input;
    let inputs = 0, changes = 0;
    input.addEventListener('input', () => inputs++);
    input.addEventListener('change', () => changes++);

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '粘贴');
    await vm.drain();
    vm.settle(vm.pending('clipboard-read-text')[0], 'X');
    await vm.drain();
    await vm.drain();
    assert.equal(input.value, 'aXb');
    assert.equal(inputs, 1, 'exactly one input event');
    assert.equal(changes, 1, 'exactly one change event (the onchange save chain must see it)');

    // Cut also reports change once.
    input.selectionStart = 0; input.selectionEnd = 2;
    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '剪切');
    await vm.drain();
    vm.settle(vm.pending('clipboard-write-text')[0], { ok: true });
    await vm.drain();
    await vm.drain();
    assert.equal(input.value, 'b', 'cut removed the 0..2 selection');
    assert.equal(inputs, 2, 'cut added exactly one input event');
    assert.equal(changes, 2, 'cut added exactly one change event');
});

test('clipboard IPC failures surface a visible toast, not only a console error', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'ab' });
    vm.ctx.document.activeElement = input;

    // Read failure (paste).
    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '粘贴');
    await vm.drain();
    const toastsBefore = vm.toasts.length;
    vm.fail(vm.pending('clipboard-read-text')[0], 'backend down');
    await vm.drain();
    await vm.drain();
    assert.ok(vm.toasts.length > toastsBefore && vm.toasts.slice(toastsBefore).some(t => t.isErr),
        'a failed clipboard read must be visible to the user');

    // Write failure (copy).
    input.selectionStart = 0; input.selectionEnd = 2;
    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '复制');
    await vm.drain();
    const toastsBefore2 = vm.toasts.length;
    vm.fail(vm.pending('clipboard-write-text')[0], 'backend down');
    await vm.drain();
    await vm.drain();
    assert.ok(vm.toasts.length > toastsBefore2 && vm.toasts.slice(toastsBefore2).some(t => t.isErr),
        'a failed clipboard write must be visible to the user');
});

test('the right-press entry gesture never moves focus off the edited control', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'half' });
    vm.ctx.document.activeElement = input;

    const press = (button, target) => {
        const ev = { button, target, _p: false, preventDefault() { ev._p = true; } };
        for (const fn of (vm.ctx.__docListeners.get('mousedown') || []).slice()) fn(ev);
        return ev;
    };
    // Right-press on the edited control: the focus-moving default is
    // suppressed (an editor under the gesture must not blur-commit/cancel
    // before its menu even opens).
    let ev = press(2, input);
    assert.equal(ev._p, true, 'right-press on a text control is preventDefault-ed');
    assert.equal(vm.ctx.document.activeElement, input, 'focus stays on the editor through the gesture');

    // Left presses and non-text targets keep their native behavior.
    ev = press(0, input);
    assert.equal(ev._p, false, 'left-press is untouched');
    const row = vm.ctx.document.createElement('div');
    ev = press(2, row);
    assert.equal(ev._p, false, 'right-press on non-text surfaces keeps its default');
});

// The right-press suppression keeps an ALREADY-FOCUSED editor's focus; an
// unfocused control must keep the native focus move (the menu's async edits
// require activeElement to be the target — refusing the focus there would
// break paste/cut on every unfocused field).
test('right-press keeps its native focus move for an unfocused control', async () => {
    const vm = await loadMenuVm();
    const a = makeInput(vm.ctx, { value: 'aaa' });
    const b = makeInput(vm.ctx, { value: 'bbb' });
    vm.ctx.document.activeElement = a; // focus sits on A; the press targets B

    const press = (button, target) => {
        const ev = { button, target, _p: false, preventDefault() { ev._p = true; } };
        for (const fn of (vm.ctx.__docListeners.get('mousedown') || []).slice()) fn(ev);
        return ev;
    };
    const ev = press(2, b);
    assert.equal(ev._p, false, 'unfocused target keeps the native focus move');
    // The focused editor still gets its protection.
    const evA = press(2, a);
    assert.equal(evA._p, true, 'the already-focused control keeps the suppression');
});

// Cut snapshots the selection: a value/selection change during the clipboard
// IPC must refuse the deletion (the copy stands), fire no change, and say so.
test('cut refuses to delete a selection that changed during the IPC wait', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'old' });
    input.selectionStart = 0; input.selectionEnd = 3;
    vm.ctx.document.activeElement = input;
    let changes = 0, inputs = 0;
    input.addEventListener('change', () => changes++);
    input.addEventListener('input', () => inputs++);

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '剪切');
    await vm.drain();
    const call = vm.pending('clipboard-write-text')[0];
    assert.ok(call, 'cut used the clipboard IPC with the snapshotted text');
    assert.equal(call.args.text, 'old');
    // The user edits the field while the write is in flight.
    input.value = 'NEWER';
    input.selectionStart = 0; input.selectionEnd = 5;
    vm.settle(call, { ok: true });
    await vm.drain();
    await vm.drain();

    assert.equal(input.value, 'NEWER', 'the changed selection/value is never deleted');
    assert.equal(inputs, 0, 'a refused cut fires no input event');
    assert.equal(changes, 0, 'a refused cut fires no change event');
    assert.ok(vm.toasts.some(t => t.isErr), 'the refusal explains itself (copied, not cut)');
});

// Control: an UNCHANGED selection during the IPC wait still cuts normally.
test('cut still deletes when the selection is unchanged across the IPC wait', async () => {
    const vm = await loadMenuVm();
    const input = makeInput(vm.ctx, { value: 'abc' });
    input.selectionStart = 0; input.selectionEnd = 2;
    vm.ctx.document.activeElement = input;
    let changes = 0;
    input.addEventListener('change', () => changes++);

    fireDocContextMenu(vm.ctx, input);
    clickItem(vm, '剪切');
    await vm.drain();
    vm.settle(vm.pending('clipboard-write-text')[0], { ok: true });
    await vm.drain();
    await vm.drain();
    assert.equal(input.value, 'c', 'the unchanged selection was cut');
    assert.equal(changes, 1, 'exactly one change event');
});

// The global shortcuts.js Escape capture registers BEFORE the app menu's
// per-open keydown listener, so a COMPOSING Escape in a non-inline-edit
// input would popModalLayer (closing the menu) before the menu's own IME
// guard sees the key. The shortcuts path must pass composition keys through;
// a plain Escape still closes LIFO. Drives the REAL shortcuts.js listeners
// in registration order with synthetic keyboard events — this is NOT an OS
// IME acceptance test (composition flags are synthetic).
test('shortcuts Escape passes IME-composition keys through; plain Escape still closes LIFO', async () => {
    const vmx = await loadMenuVm();
    const ctx = vmx.ctx;
    // Stubs the close actions the shortcuts Escape path calls (utils.js is
    // not loaded in this seam); recorders make the defect directly visible.
    const closeCalls = [];
    ctx.popModalLayer = () => { closeCalls.push('popModalLayer'); return false; };
    ctx.closeAllOverlays = () => { closeCalls.push('closeAllOverlays'); };
ctx.browserAcceleratorDenied = () => false; // shortcut-utils stub: no denied combos in this test
ctx._refocusActiveTerminal = () => {}; // focus-return stub (utils.js not loaded here)
    // Load the REAL shortcuts.js AFTER context-menu.js — same relative order
    // as the page (page-load listener before per-open menu listener).
    vm.runInContext(SHORTCUTS_SRC, ctx, { filename: 'shortcuts.js' });

    const input = makeInput(ctx, { value: 'composing' }); // NOT .inline-edit
    ctx.document.activeElement = input;
    fireDocContextMenu(ctx, input);
    assert.ok(menuEl(vmx), 'menu open over the input');

    // Real listener order: everything registered on document keydown, in
    // registration order (shortcuts' capture first, the menu's per-open
    // listener last).
    const fireKey = (over = {}) => {
        const ev = { key: 'Escape', target: input, isComposing: false, keyCode: 27,
            _p: false, _s: false, preventDefault() { ev._p = true; }, stopPropagation() { ev._s = true; }, ...over };
        for (const fn of (ctx.__docListeners.get('keydown') || []).slice()) fn(ev);
        return ev;
    };
    const composing = fireKey({ isComposing: true, keyCode: 229 });
    assert.equal(composing._p, false, 'composing Escape is not consumed by shortcuts');
    assert.equal(closeCalls.length, 0, 'composing Escape never reaches the close path');
    assert.ok(menuEl(vmx), 'the menu survives a composing Escape (its own IME guard holds)');

    const plain = fireKey();
    assert.ok(closeCalls.length >= 1, 'plain Escape runs the normal LIFO close path');
    assert.equal(menuEl(vmx), null, 'plain Escape closes the menu (menu listener + LIFO)');
});
