// Overlay dismissal must settle pending execution-trust consent exactly once
// without denying a request whose dialog is still queued behind another
// modal. closeAllOverlays runs the visible confirm cleanup and the hostkey
// cleanup; both are idempotent, and showConfirm's onDismiss settles a visible
// trust prompt while a queued one stays pending until tick() shows it.
//
// Uses the shared renderer VM plus the REAL utils.js and execution-trust.js:
// showConfirm, closeAllOverlays and the trust broker all run unmodified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

const utilsSrc = readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8');
const trustSrc = readFileSync(new URL('../src/renderer/execution-trust.js', import.meta.url), 'utf8');
const shortcutsSrc = readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');
const shortcutUtilsSrc = readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8');

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

// Deterministic interval registry so the broker's polling tick never depends
// on wall-clock timers.
function loadTrust(ctx, responses) {
    const calls = [];
    const timers = new Map();
    let nextTimer = 1;
    ctx.setInterval = (fn) => { const id = nextTimer++; timers.set(id, fn); return id; };
    ctx.clearInterval = (id) => { timers.delete(id); };
    ctx.crypto = { randomUUID: () => 'test-owner' };
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        calls.push({ cmd, payload });
        if (cmd === 'prepare-execution') return Promise.resolve(responses.prepare);
        if (cmd === 'decide-execution') return Promise.resolve({ ticket: 'ticket-1' });
        if (cmd === 'pty-create' || cmd === 'cancel-execution') return Promise.resolve({});
        // Any other call (notably ssh-connect) stays suspended: a real SSH
        // attempt must not settle just because the test replaced the bridge.
        return new Promise(() => {});
    };
    vm.runInContext(trustSrc, ctx, { filename: 'execution-trust.js' });
    const pulse = () => { for (const fn of Array.from(timers.values())) fn(); };
    return { calls, broker: ctx.window.ZTermExecutionTrust, pulse };
}

// The real Escape handler and its delayed refocus, with deterministic timers.
// _refocusActiveTerminal stands in for main.js and records a focus landing the
// way a real terminal focus would: activeElement moves off the modal controls.
function loadShortcuts(ctx) {
    const timers = [];
    const focusLog = [];
    let seq = 0;
    let now = 0;
    ctx.setTimeout = (fn, ms = 0) => {
        const id = ++seq;
        timers.push({ id, fn, at: now + (Number(ms) || 0) });
        return id;
    };
    ctx.clearTimeout = id => {
        const index = timers.findIndex(timer => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
    };
    ctx._refocusActiveTerminal = () => {
        focusLog.push(ctx.document.activeElement);
        ctx.document.activeElement = ctx.document.body;
    };
    const listeners = [];
    const add = ctx.document.addEventListener.bind(ctx.document);
    ctx.document.addEventListener = (type, fn, capture) => {
        if (type === 'keydown' && capture) listeners.push(fn);
        add(type, fn, capture);
    };
    vm.runInContext(shortcutUtilsSrc, ctx, { filename: 'shortcut-utils.js' });
    vm.runInContext(shortcutsSrc, ctx, { filename: 'shortcuts.js' });
    return {
        focusLog,
        clearFocusLog() { focusLog.length = 0; },
        pressEscape() {
            const event = {
                key: 'Escape', isComposing: false, keyCode: 0,
                target: { tagName: 'TEXTAREA', classList: { contains: () => false } },
                preventDefault() {}, stopPropagation() {},
            };
            for (const fn of listeners) fn(event);
        },
        advance(ms) {
            now += ms;
            for (;;) {
                const due = timers.filter(timer => timer.at <= now)
                    .sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                timers.splice(timers.indexOf(due), 1);
                due.fn();
            }
        },
    };
}

const drain = () => new Promise(resolve => setImmediate(resolve));
const outcome = promise => Promise.race([
    promise.then(() => ({ resolved: true }), error => ({ rejected: error })),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 250)),
]);

const overlay = ctx => ctx.document.getElementById('overlay-confirm');
const cancelBtn = ctx => ctx.document.getElementById('confirm-cancel');
const count = (calls, cmd) => calls.filter(call => call.cmd === cmd).length;
const confirmCleanupRef = ctx => vm.runInContext('_activeConfirmCleanup', ctx);

// A REAL pending SSH attempt for the hostkey dialog (same shape as
// tests/ssh-hostkey-decision.test.mjs).
function pendingSshTab(ctx, id) {
    const tab = { id, name: id, type: 'ssh', host: 'h', user: 'u', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);
    ctx._sshConnectWithCredentials(tab, null);
    return tab;
}

const emitMismatch = (ctx, tabId, attemptId) =>
    ctx.__emit('ssh-hostkey-mismatch', { tabId, attemptId, host: 'h', oldAlgorithm: 'ssh-ed25519', oldFingerprint: 'OLD', newAlgorithm: 'ssh-ed25519', newFingerprint: 'NEW' });
const sshDecisions = (ctx, tabId) =>
    ctx.__sends.filter(s => s.cmd === 'ssh-hostkey-decision' && s.payload && s.payload.tabId === tabId);

test('Escape denies a pending SSH execution-trust prompt exactly once', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    ctx.sshAttempts = { ownerWants: () => true, ownerAttempt: () => null };
    const { calls, broker } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-1', description: '共享启动配置需要本账户确认。', canRemember: false },
    });

    const running = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-1');
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'consent dialog is showing');
    assert.equal(count(calls, 'decide-execution'), 0);

    ctx.closeAllOverlays();
    const result = await outcome(running);
    await drain();

    assert.ok(result.rejected, `authorization must be denied, got ${JSON.stringify(result)}`);
    assert.match(String(result.rejected.message), /启动已取消/);
    assert.equal(count(calls, 'cancel-execution'), 1, 'one backend cancellation for the dismissal');
    const cancelCall = calls.find(call => call.cmd === 'cancel-execution');
    assert.equal(cancelCall.payload.owner, 'ssh:attempt-1');
    assert.equal(count(calls, 'decide-execution'), 0, 'a dismissed prompt is never allowed');
    assert.equal(overlay(ctx).classList.contains('open'), false, 'overlay closed');

    // Racing the old button with the dismissal must not settle/reply twice.
    ctx.closeAllOverlays();
    cancelBtn(ctx).dispatch('click');
    await drain();
    assert.equal(count(calls, 'cancel-execution'), 1, 'settlement is idempotent');
});

test('Escape settles a pending local start without launching the command', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    ctx.TabManager.tabs.push({ id: 'local-owner', type: 'local' });
    const { calls, broker } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-2', description: '本机启动配置需要确认。', canRemember: false },
    });

    let launches = 0;
    const running = broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, () => {
        launches++;
        return Promise.resolve();
    });
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'consent dialog is showing');

    ctx.closeAllOverlays();
    const result = await outcome(running);
    assert.ok(result.resolved, `startLocal must not stay suspended, got ${JSON.stringify(result)}`);
    assert.equal(launches, 0, 'no process is launched after a dismissal');
    assert.equal(count(calls, 'decide-execution'), 0, 'a dismissed prompt is never allowed');
    assert.equal(count(calls, 'cancel-execution'), 1, 'the backend is told to cancel exactly once');
    assert.equal(calls.find(call => call.cmd === 'cancel-execution').payload.requestId, 'local-owner');
});

test('a trust request queued behind a plain confirm survives the first closeAllOverlays', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    ctx.sshAttempts = { ownerWants: () => true, ownerAttempt: () => null };
    const { calls, broker, pulse } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-q1', description: 'queued trust prompt', canRemember: false },
    });
    ctx.showConfirm('blocking delete', () => {});
    assert.equal(confirmCleanupRef(ctx) !== null, true, 'plain confirm owns the shared dialog');

    const running = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-q1');
    running.catch(() => {});
    await drain();
    assert.equal(count(calls, 'cancel-execution'), 0, 'queued request is not denied');

    ctx.closeAllOverlays();
    await drain();
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    await drain();
    assert.equal(settled, false, 'the user never saw this prompt, so it stays pending');
    assert.equal(count(calls, 'cancel-execution'), 0, 'no backend cancellation for a hidden prompt');

    pulse();
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'the queued trust prompt appears');
    assert.equal(ctx.document.getElementById('confirm-msg').textContent, 'queued trust prompt');

    ctx.closeAllOverlays();
    const result = await outcome(running);
    await drain();
    assert.ok(result.rejected, 'the second Escape denies the visible prompt');
    assert.equal(count(calls, 'cancel-execution'), 1, 'exactly one cancellation after the prompt was shown');
    assert.equal(count(calls, 'decide-execution'), 0, 'a dismissed prompt is never allowed');
});

test('a trust request queued behind a hostkey dialog survives the hostkey rejection', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    const tab = pendingSshTab(ctx, 't_queue');
    emitMismatch(ctx, 'ssh_queue', tab._pendingAttempt);
    assert.equal(overlay(ctx).classList.contains('open'), true, 'hostkey dialog is showing');

    // Keep the real attempt registry (the connect chain still needs armSlot)
    // and only make the trust request's owner look alive.
    const attempts = ctx.sshAttempts;
    const ownerWants = attempts.ownerWants;
    attempts.ownerWants = token => token === 'attempt-q2' || ownerWants(token);
    attempts.ownerAttempt = () => null;
    const { calls, broker, pulse } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-q2', description: 'queued after hostkey', canRemember: false },
    });
    const running = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-q2');
    running.catch(() => {});
    await drain();
    assert.equal(count(calls, 'cancel-execution'), 0, 'queued request is not denied');

    ctx.closeAllOverlays();
    await drain();
    const decisions = sshDecisions(ctx, 'ssh_queue');
    assert.equal(decisions.length, 1, 'the visible hostkey dialog is rejected once');
    assert.equal(decisions[0].payload.accept, false);
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    await drain();
    assert.equal(settled, false, 'the hidden trust prompt stays pending');
    assert.equal(count(calls, 'cancel-execution'), 0, 'no backend cancellation for a hidden prompt');

    pulse();
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'the trust prompt appears after the hostkey dialog');
    assert.equal(ctx.document.getElementById('confirm-msg').textContent, 'queued after hostkey');

    ctx.closeAllOverlays();
    const result = await outcome(running);
    await drain();
    assert.ok(result.rejected);
    assert.equal(count(calls, 'cancel-execution'), 1, 'the second Escape cancels the visible trust prompt');
    assert.equal(count(calls, 'decide-execution'), 0);
});

test('closeAllOverlays clears the confirm cleanup pointer for later prompts', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    ctx.showConfirm('plain delete', () => {});
    assert.equal(confirmCleanupRef(ctx) !== null, true);

    ctx.closeAllOverlays();
    assert.equal(confirmCleanupRef(ctx), null, 'Escape clears the stale cleanup');

    ctx.sshAttempts = { ownerWants: () => true, ownerAttempt: () => null };
    const { calls, broker } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-late', description: 'later prompt', canRemember: false },
    });
    const running = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-late');
    running.catch(() => {});
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'a later trust prompt is not blocked');
    assert.equal(ctx.document.getElementById('confirm-msg').textContent, 'later prompt');
    assert.equal(count(calls, 'cancel-execution'), 0);

    ctx.closeAllOverlays();
    await outcome(running);
    await drain();
    assert.equal(count(calls, 'cancel-execution'), 1);
});

test('Escape on T1 leaves the keyboard with the queued T2 prompt', async () => {
    const ctx = loadVm();
    loadUtils(ctx);
    mountConfirmDom(ctx);
    ctx.sshAttempts = { ownerWants: () => true, ownerAttempt: () => null };
    const { calls, broker } = loadTrust(ctx, {
        prepare: { challengeId: 'challenge-focus', description: 'queued trust dialog', canRemember: false },
    });

    const first = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-focus-1');
    first.catch(() => {});
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'T1 is visible');

    const second = broker.authorizeSsh({ shell: 'fixture.exe' }, 'attempt-focus-2');
    second.catch(() => {});
    await drain();
    assert.equal(overlay(ctx).classList.contains('open'), true, 'T1 still owns the shared dialog');

    const shortcuts = loadShortcuts(ctx);
    shortcuts.pressEscape();
    await drain();

    const firstResult = await outcome(first);
    assert.ok(firstResult.rejected, 'T1 is denied by the first Escape');
    let secondSettled = false;
    second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await drain();
    assert.equal(secondSettled, false, 'T2 stays pending while its dialog is visible');
    assert.equal(overlay(ctx).classList.contains('open'), true, 'T2 took over the shared dialog');
    assert.equal(ctx.document.getElementById('confirm-msg').textContent, 'queued trust dialog');
    assert.equal(ctx.document.activeElement, cancelBtn(ctx), 'T2 owns the keyboard');

    // The synchronous focus restore from T1's cleanup is not the regression:
    // only the delayed Escape refocus must stay away while T2 is visible.
    shortcuts.clearFocusLog();
    shortcuts.advance(50);
    await drain();
    assert.equal(shortcuts.focusLog.length, 0, 'the delayed refocus does not steal T2 focus');
    assert.equal(ctx.document.activeElement, cancelBtn(ctx), 'focus stays on the modal');

    ctx.closeAllOverlays();
    const secondResult = await outcome(second);
    await drain();
    assert.ok(secondResult.rejected);
    assert.equal(count(calls, 'cancel-execution'), 2, 'each visible dismissal cancels exactly once');
    assert.equal(count(calls, 'decide-execution'), 0);
});
