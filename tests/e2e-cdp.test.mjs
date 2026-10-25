import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp } from '../scripts/e2e-cdp.mjs';
import { renewNativeLease, stopBackgroundRun, BACKGROUND_CLOCK_DOMAIN } from '../scripts/e2e-background-policy.mjs';
import { E2E_TMP_ROOT, registerExitCleanup } from '../scripts/e2e-isolation.mjs';

class InertSocket {
  constructor() {
    this.commands = [];
    this.closeCalls = 0;
    queueMicrotask(() => this.onopen?.());
  }
  send(text) {
    const command = JSON.parse(text);
    this.commands.push(command);
    if (command.method === 'Runtime.enable') queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ id: command.id, result: {} }) });
    });
  }
  // Deliberately never emits close: the real regression involved a hung peer.
  close() { this.closeCalls++; }
}

const expected = { token: 'fixture', pid: 20, hwnd: '0x5678', released: true,
  targetDesktopId: '22222222-2222-2222-2222-222222222222' };

test('lost native proof withdraws the lease and releases a pending command into finally without socket close', async () => {
  for (const failure of ['failed', 'stale', 'missing']) {
    mkdirSync(E2E_TMP_ROOT, { recursive: true });
    const directory = registerExitCleanup(mkdtempSync(join(E2E_TMP_ROOT, 'inert-cdp-')));
    const leasePath = join(directory, 'lease.json');
    writeFileSync(leasePath, '{}');
    const controller = new AbortController();
    const leaseAtAbort = [];
    controller.signal.addEventListener('abort', () => leaseAtAbort.push(existsSync(leasePath)));
    const cdp = new Cdp('ws://fixture.invalid', { signal: controller.signal, WebSocketImpl: InertSocket });
    await cdp.connect();
    let cleanupReached = false;
    const pending = (async () => {
      try { await cdp.eval('new Promise(() => {})'); }
      finally { cleanupReached = true; }
    })();
    const rejected = assert.rejects(pending, /native guard proof|watchdog/);
    assert.equal(cdp.pending.size, 1);
    const readStatus = () => failure === 'failed' ? { phase: 'failed', error: 'fixture watchdog timeout' }
      : failure === 'missing' ? null : { ...expected, clockDomain: BACKGROUND_CLOCK_DOMAIN, phase: 'shown', disabled: true, noActivate: true,
        visible: true, minimized: false, onCurrentDesktop: false, onTargetDesktop: true, checkedAt: 1 };
    let renewals = 0;
    let reason;
    try { renewNativeLease({ readStatus, expected, now: () => 10000, renew: () => { renewals++; } }); }
    catch (error) { reason = error; }
    assert.ok(reason);
    stopBackgroundRun({ leasePath, abortController: controller, timer: null }, reason);
    assert.equal(existsSync(leasePath), false);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(leaseAtAbort, [false]);
    assert.equal(cdp.pending.size, 0);
    assert.equal(cdp.ws.closeCalls, 1);
    assert.equal(renewals, 0);
    await rejected;
    assert.equal(cleanupReached, true);
  }
});

test('cancellation rejects a pending connection even if the socket never opens or closes', async () => {
  class SilentSocket {
    constructor() { this.closeCalls = 0; }
    close() { this.closeCalls++; }
  }
  const controller = new AbortController();
  const cdp = new Cdp('ws://fixture.invalid', { signal: controller.signal, WebSocketImpl: SilentSocket });
  const connecting = cdp.connect();
  controller.abort(new Error('fixture startup cancelled'));
  await assert.rejects(connecting, /startup cancelled/);
  assert.equal(cdp.ws.closeCalls, 1);
});

test('transport errors reject pending work without depending on a later close event', async () => {
  const cdp = new Cdp('ws://fixture.invalid', { WebSocketImpl: InertSocket });
  await cdp.connect();
  const pending = cdp.eval('new Promise(() => {})');
  const rejected = assert.rejects(pending, /transport failed/);
  cdp.ws.onerror();
  await rejected;
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.ws.closeCalls, 1);
});

test('the real CDP boundary refuses window activation and still supports successful command results', async () => {
  const cdp = new Cdp('ws://fixture.invalid', { WebSocketImpl: InertSocket });
  await cdp.connect();
  for (const method of ['Browser.setWindowBounds', 'Page.bringToFront', 'Target.activateTarget']) {
    await assert.rejects(cdp.send(method), /forbidden/);
  }
  assert.equal(cdp.ws.commands.length, 1);
  const evaluation = cdp.eval('40 + 2');
  const command = cdp.ws.commands.at(-1);
  cdp.ws.onmessage({ data: JSON.stringify({ id: command.id, result: { result: { value: 42 } } }) });
  assert.equal(await evaluation, 42);
  cdp.close();
});
