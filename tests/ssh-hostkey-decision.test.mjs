// Hostkey mismatch dialog: EVERY dismissal path must resolve the backend's
// suspended decision exactly once (reject by default — never auto-accept).
// Driven through the REAL ipc.js ssh-hostkey-mismatch handler plus the REAL
// utils.js closeAllOverlays / showConfirm in the shared renderer VM
// (tests/helpers/renderer-vm.mjs).
//
// Old-code failure notes per test: the three non-button disappearance paths
// (Escape via closeAllOverlays, superseded by a second mismatch, superseded
// by showConfirm) only tore down the DOM and never sent ssh-hostkey-decision,
// so the oneshot in Rust's check_server_key pended forever — the tab stuck at
// "Connecting to ..." with no error, and the russh connection task (plus the
// server-side TCP) leaked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

const utilsSrc = readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8');

// Load the REAL utils.js into an already-built renderer VM. renderer.html
// loads utils.js before ipc.js, so both scripts share one global scope (its
// lexical const ipcRenderer is what ipc.js's handlers resolve at call time).
// Replicate that here: utils.js's top-level requires must resolve to the SAME
// fakes the VM was built with, or its bindings would shadow the recording bus.
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
        return {}; // fs / path: only touched by functions these tests never call
    };
    vm.runInContext(utilsSrc, ctx, { filename: 'utils.js' });
}

// The confirm-dialog DOM surface the real handlers bind by id (the shared VM
// page does not ship it; renderer.html does).
function mountConfirmDom(ctx) {
    const mk = (id, cls) => {
        const el = ctx.document.createElement('div');
        if (id) el.setAttribute('id', id);
        if (cls) el.className = cls;
        return el;
    };
    ctx.__body.appendChild(mk('toast'));
    const overlay = mk('overlay-confirm', 'overlay');
    overlay.appendChild(mk('confirm-msg'));
    overlay.appendChild(mk('confirm-cancel'));
    overlay.appendChild(mk('confirm-ok'));
    overlay.appendChild(mk(null, 'overlay-backdrop'));
    ctx.__body.appendChild(overlay);
    return overlay;
}

// A REAL pending SSH attempt: _sshConnectWithCredentials creates the attempt
// record synchronously (ownerWants(att) === true from here on); the queued
// invocation never settles in this harness, which a suspended attempt needs.
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

test('Escape (closeAllOverlays) rejects the pending decision exactly once', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    const overlay = mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_hk1');
    emitMismatch(ctx, 'ssh_hk1', tab._pendingAttempt);
    assert.equal(overlay.classList.contains('open'), true, 'dialog opened');
    assert.equal(decisions(ctx, 'ssh_hk1').length, 0, 'no decision before a dismissal');

    ctx.closeAllOverlays(); // what the Escape keydown handler calls
    assert.equal(overlay.classList.contains('open'), false);
    const ds = decisions(ctx, 'ssh_hk1');
    assert.equal(ds.length, 1, 'the suspended backend attempt is unblocked');
    assert.deepEqual({ accept: ds[0].payload.accept, trust: ds[0].payload.trust },
        { accept: false, trust: false }, 'a non-button dismissal refuses — never auto-accepts');
    assert.equal(ctx.document.getElementById('confirm-cancel').textContent, '取消', 'labels restored');
    assert.equal(ctx.document.getElementById('confirm-ok').textContent, '删除', 'labels restored');

    ctx.closeAllOverlays(); // a repeated sweep must not re-answer the oneshot
    assert.equal(decisions(ctx, 'ssh_hk1').length, 1, 'idempotent: exactly one decision per dialog');
});

test('a second mismatch supersedes the first dialog and rejects the first attempt', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    const overlay = mountConfirmDom(ctx);
    const tabA = pendingSshTab(ctx, 't_hkA');
    const tabB = pendingSshTab(ctx, 't_hkB');
    emitMismatch(ctx, 'ssh_A', tabA._pendingAttempt);
    assert.equal(overlay.classList.contains('open'), true);

    emitMismatch(ctx, 'ssh_B', tabB._pendingAttempt); // replaces A's dialog
    assert.equal(overlay.classList.contains('open'), true, 'the second dialog is open');
    const dA = decisions(ctx, 'ssh_A');
    assert.equal(dA.length, 1, 'the superseded attempt still gets its decision');
    assert.equal(dA[0].payload.accept, false);
    assert.equal(decisions(ctx, 'ssh_B').length, 0, 'the live dialog is unanswered');

    ctx.document.getElementById('confirm-ok').dispatch('click'); // user trusts B
    const dB = decisions(ctx, 'ssh_B');
    assert.equal(dB.length, 1);
    assert.deepEqual({ accept: dB[0].payload.accept, trust: dB[0].payload.trust },
        { accept: true, trust: true });
    assert.equal(decisions(ctx, 'ssh_A').length, 1, 'A answered exactly once (no stale listener fired)');
});

test('showConfirm taking the shared DOM rejects the displaced hostkey attempt', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    const overlay = mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_hkC');
    emitMismatch(ctx, 'ssh_C', tab._pendingAttempt);
    assert.equal(overlay.classList.contains('open'), true);

    let okCalls = 0;
    ctx.showConfirm('删除？', () => { okCalls++; });
    assert.equal(overlay.classList.contains('open'), true, 'the confirm dialog shows');
    const dC = decisions(ctx, 'ssh_C');
    assert.equal(dC.length, 1, 'the displaced hostkey attempt is rejected, not left hanging');
    assert.equal(dC[0].payload.accept, false);

    ctx.document.getElementById('confirm-ok').dispatch('click'); // user confirms the delete
    assert.equal(okCalls, 1, 'the confirm callback runs once');
    assert.equal(decisions(ctx, 'ssh_C').length, 1, 'no second hostkey decision leaks through the shared buttons');
});

test('button decisions stay exactly-once against later overlay sweeps', () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_hkD');
    emitMismatch(ctx, 'ssh_D1', tab._pendingAttempt);
    ctx.document.getElementById('confirm-cancel').dispatch('click');
    assert.equal(decisions(ctx, 'ssh_D1').length, 1, 'explicit reject sent');
    ctx.closeAllOverlays();
    assert.equal(decisions(ctx, 'ssh_D1').length, 1, 'a later sweep does not re-answer');

    const tab2 = pendingSshTab(ctx, 't_hkE');
    emitMismatch(ctx, 'ssh_D2', tab2._pendingAttempt);
    ctx.document.getElementById('confirm-ok').dispatch('click');
    const d2 = decisions(ctx, 'ssh_D2');
    assert.equal(d2.length, 1, 'explicit accept sent once');
    assert.equal(d2[0].payload.accept, true);
    ctx.closeAllOverlays();
    assert.equal(decisions(ctx, 'ssh_D2').length, 1, 'no compensating reject follows an accept');
});
