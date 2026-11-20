// Overlay dismissal must settle pending execution-trust consent: Escape /
// closeAllOverlays traditionally only removed the .open class, leaving the
// confirm promise (and the backend's prepare-execution challenge) pending
// forever. The overlay dismiss registry drains on every "close everything"
// path and settles the dialog exactly once as a denial.
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
        if (cmd === 'pty-create') return Promise.resolve({});
        return Promise.resolve({});
    };
    vm.runInContext(trustSrc, ctx, { filename: 'execution-trust.js' });
    return { calls, broker: ctx.window.ZTermExecutionTrust };
}

const drain = () => new Promise(resolve => setImmediate(resolve));
const outcome = promise => Promise.race([
    promise.then(() => ({ resolved: true }), error => ({ rejected: error })),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 250)),
]);

const overlay = ctx => ctx.document.getElementById('overlay-confirm');
const cancelBtn = ctx => ctx.document.getElementById('confirm-cancel');
const count = (calls, cmd) => calls.filter(call => call.cmd === cmd).length;

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
