// Confirm/hostkey modal keyboard ownership (T04): the shared #overlay-confirm
// dialog is a modal — while open its controls must own the keyboard. The old
// code only toggled the .open class, so the xterm helper textarea kept focus:
// typing (including Enter) went straight into the terminal BEHIND the modal.
// Driven through the REAL utils.js showConfirm / closeAllOverlays and the REAL
// ipc.js ssh-hostkey-mismatch handler in the shared renderer VM, mirroring
// tests/ssh-hostkey-decision.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

const utilsSrc = readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8');

// Same loader as ssh-hostkey-decision.test.mjs: utils.js runs after the VM's
// scripts, sharing one global scope, with its requires resolving to the VM
// fakes (see that file for the binding rationale).
function loadUtils(ctx) {
    ctx.window.addEventListener = () => {};
    ctx.require = (name) => {
        if (name === 'electron') return { ipcRenderer: ctx.ipcRenderer, webUtils: {} };
        if (name === '@xterm/xterm') return { Terminal: ctx.Terminal };
        if (name === '@xterm/addon-fit') return { FitAddon: ctx.FitAddon };
        if (name === '@xterm/addon-webgl') return { WebglAddon: ctx.WebglAddon };
        if (name === '@xterm/addon-search') return { SearchAddon: ctx.SearchAddon };
        if (name === '@xterm/addon-clipboard') return { ClipboardAddon: ctx.ClipboardAddon };
        if (name === '@xterm/addon-web-links') return { WebLinksAddon: class {} };
        return {};
    };
    vm.runInContext(utilsSrc, ctx, { filename: 'utils.js' });
}

function mountConfirmDom(ctx) {
    const mk = (id, cls) => {
        const el = ctx.document.createElement('div');
        if (id) el.setAttribute('id', id);
        if (cls) el.className = cls;
        return el;
    };
    ctx.__body.appendChild(mk('toast'));
    const overlay = mk('overlay-confirm', 'overlay');
    overlay.appendChild(mk(null, 'overlay-backdrop'));
    overlay.appendChild(mk('confirm-msg'));
    overlay.appendChild(mk('confirm-cancel'));
    overlay.appendChild(mk('confirm-ok'));
    ctx.__body.appendChild(overlay);
    return overlay;
}

// A tab with a mounted terminal, no backend wiring (focus tests only need the
// .xterm surface that owns the keyboard while no modal is open).
function tabWithTerminal(ctx, id, backendId) {
    const tab = { id, name: id, type: 'local', connected: true, tabId: backendId };
    ctx.TabManager.tabs.push(tab);
    const host = ctx.document.createElement('div');
    ctx.__body.appendChild(host);
    tab.term = new ctx.Terminal();
    tab.term.open(host);
    return tab;
}

// main.js is not part of the VM; install the focus handoff it provides so the
// dialog's dismissal path is observable (counting calls, forwarding to the
// staged terminal so focus really lands there, as in the real page).
function installRefocusStub(ctx, term) {
    ctx.__refocusCalls = 0;
    ctx.__refocusTerm = term || null;
    vm.runInContext(
        'function _refocusActiveTerminal() { globalThis.__refocusCalls++;' +
        ' if (globalThis.__refocusTerm && !globalThis.__refocusTerm.disposed) globalThis.__refocusTerm.focus(); }',
        ctx, { filename: 'refocus-stub.js' });
}

function pendingSshTab(ctx, id) {
    const tab = { id, name: id, type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    return tab;
}

const emitMismatch = (ctx, tabId, attemptId) =>
    ctx.__emit('ssh-hostkey-mismatch', { tabId, attemptId, host: 'h', oldAlgorithm: 'ssh-ed25519', oldFingerprint: 'OLD', newAlgorithm: 'ssh-ed25519', newFingerprint: 'NEW' });
const decisions = (ctx, tabId) =>
    ctx.__sends.filter(s => s.cmd === 'ssh-hostkey-decision' && s.payload && s.payload.tabId === tabId);

const cancelBtn = ctx => ctx.document.getElementById('confirm-cancel');
const okBtn = ctx => ctx.document.getElementById('confirm-ok');

test('showConfirm moves keyboard focus into the modal (safe default button)', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    const overlay = mountConfirmDom(ctx);
    const tab = tabWithTerminal(ctx, 't1', 'b1');
    installRefocusStub(ctx, tab.term);
    ctx.document.activeElement = tab.term.element; // "user is typing in the terminal"

    ctx.showConfirm('确定删除？', () => {});
    assert.equal(overlay.classList.contains('open'), true, 'dialog opened');
    assert.ok(ctx.document.activeElement === cancelBtn(ctx),
        'the safe default (cancel) button owns the keyboard, not the terminal behind the backdrop');
    assert.ok(ctx.document.activeElement !== tab.term.element, 'the xterm surface no longer holds focus');
});

test('showConfirm button dismissal runs the callback once and returns focus to the terminal', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    const tab = tabWithTerminal(ctx, 't2', 'b2');
    installRefocusStub(ctx, tab.term);
    ctx.document.activeElement = tab.term.element;

    let okCalls = 0;
    ctx.showConfirm('确定删除？', () => { okCalls++; });
    okBtn(ctx).dispatch('click'); // what a focused button's native Enter/Space activation fires
    assert.equal(okCalls, 1, 'OK runs exactly once');
    assert.equal(ctx.__refocusCalls, 1, 'dismissal hands focus back to the terminal');
    assert.ok(ctx.document.activeElement === tab.term.element, 'focus lands on the terminal');
    assert.ok(ctx.document.activeElement !== cancelBtn(ctx), 'the modal no longer owns the keyboard');

    // Cancel dismissal restores focus the same way.
    ctx.showConfirm('再次确认？', () => {});
    cancelBtn(ctx).dispatch('click');
    assert.equal(ctx.__refocusCalls, 2, 'cancel also restores terminal focus');
});

test('hostkey dialog focuses the reject default and restores focus on every decision', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    const overlay = mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_hk');
    installRefocusStub(ctx, tab.term);
    ctx.document.activeElement = ctx.document.body;

    emitMismatch(ctx, 'ssh_hk', tab._pendingAttempt);
    assert.equal(overlay.classList.contains('open'), true);
    assert.ok(ctx.document.activeElement === cancelBtn(ctx),
        'the hostkey modal focuses 拒绝 — a stray Enter refuses, never accepts');

    okBtn(ctx).dispatch('click'); // explicit 信任并连接
    const ds = decisions(ctx, 'ssh_hk');
    assert.equal(ds.length, 1);
    assert.deepEqual({ accept: ds[0].payload.accept, trust: ds[0].payload.trust }, { accept: true, trust: true });
    assert.equal(ctx.__refocusCalls, 1, 'focus returns to the terminal after the decision');

    // The same focus discipline holds for the reject default: a stray Enter on
    // the focused button refuses without accepting.
    const tab2 = pendingSshTab(ctx, 't_hkR');
    emitMismatch(ctx, 'ssh_hkR', tab2._pendingAttempt);
    assert.ok(ctx.document.activeElement === cancelBtn(ctx), 'reject default focused again');
    cancelBtn(ctx).dispatch('click'); // what the focused button's Enter fires
    const dR = decisions(ctx, 'ssh_hkR');
    assert.equal(dR.length, 1);
    assert.equal(dR[0].payload.accept, false, 'the focused default refuses');
    assert.equal(ctx.__refocusCalls, 2, 'reject dismissal also restores focus');
});

test('hostkey Escape dismissal (closeAllOverlays) decides reject once and restores focus', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_hkE');
    installRefocusStub(ctx, tab.term);

    emitMismatch(ctx, 'ssh_hkE', tab._pendingAttempt);
    ctx.closeAllOverlays(); // the Escape keydown handler's action
    const ds = decisions(ctx, 'ssh_hkE');
    assert.equal(ds.length, 1, 'backend decision resolved');
    assert.deepEqual({ accept: ds[0].payload.accept, trust: ds[0].payload.trust }, { accept: false, trust: false });
    assert.equal(ctx.__refocusCalls, 1, 'Escape dismissal also returns focus to the terminal');
});

test('a confirm layered on another open overlay does not steal focus to the terminal', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    // The SSH manager/settings-style overlay that stays open beneath.
    const beneath = ctx.document.createElement('div');
    beneath.className = 'overlay';
    beneath.setAttribute('id', 'overlay-ssh-manager');
    ctx.__body.appendChild(beneath);
    beneath.classList.add('open');
    const tab = tabWithTerminal(ctx, 't3', 'b3');
    installRefocusStub(ctx, tab.term);

    ctx.showConfirm('确定删除？', () => {});
    cancelBtn(ctx).dispatch('click');
    assert.equal(ctx.__refocusCalls, 0,
        'the still-open overlay keeps the keyboard — no focus jump behind its back (pre-fix behavior)');
});
