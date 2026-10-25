import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectVerifiedEndpoint, verifyEndpointOffThread } from '../scripts/e2e-ownership.mjs';
import { observeDesktopStream, renewNativeLease, validateNativeHostHealth,
  BACKGROUND_CLOCK_DOMAIN, backgroundNow } from '../scripts/e2e-background-policy.mjs';

const endpoint = 'ws://127.0.0.1:9222/devtools/page/fixture';
const host = () => ({ pid: 20, exitCode: null, signalCode: null });
const defaults = child => ({ child, port: 9222, executable: 'D:/fixture/zterm.exe',
  sandboxDirectory: 'D:/fixture', discover: async () => endpoint });

function socketFixture() {
  const instances = [];
  class Socket {
    constructor() { instances.push(this); queueMicrotask(() => this.onopen?.()); }
    send(text) {
      const { id } = JSON.parse(text);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result: {} }) }));
    }
    close() {}
  }
  return { instances, Socket };
}

class InertWorker extends EventEmitter {
  unref() {}
  terminate() { this.terminated = true; return Promise.resolve(0); }
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Inert worker fixture did not become ready');
    await sleep(5);
  }
}

test('a blocked ownership worker leaves real observer and lease timers running beyond the freshness window', async () => {
  const child = host();
  const controller = new AbortController();
  const observer = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  const baseline = { ok: true, clockDomain: BACKGROUND_CLOCK_DOMAIN, currentDesktopId: '11111111-1111-1111-1111-111111111111',
    targetDesktopId: '22222222-2222-2222-2222-222222222222', foregroundHwnd: '0x1234',
    foregroundPid: 10, foregroundOwnerPids: [10], observedAt: backgroundNow() };
  const binding = { token: 'fixture', pid: child.pid, hwnd: '0x5678', released: true,
    targetDesktopId: baseline.targetDesktopId };
  const native = { ...binding, clockDomain: BACKGROUND_CLOCK_DOMAIN, phase: 'shown', disabled: true, noActivate: true,
    visible: true, minimized: false, onTargetDesktop: true, onCurrentDesktop: false, checkedAt: backgroundNow() };
  const observation = observeDesktopStream({ observer, baseline, getOwnedPid: () => child.pid });
  let samples = 0, leases = 0;
  let heartbeatFailure;
  function pulse() {
    observer.stdout.emit('data', JSON.stringify({ ...baseline, observedAt: backgroundNow() }) + '\n');
    native.checkedAt = backgroundNow();
    samples++;
    try {
      observation.assertHealthy();
      renewNativeLease({ readStatus: () => native, expected: binding, renew: () => { leases++; } });
    } catch (error) { heartbeatFailure = error; }
  }
  pulse();
  await observation.ready;
  const timer = setInterval(pulse, 40);
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const sockets = socketFixture();
  const timings = [];
  let cdp;
  const result = connectVerifiedEndpoint({ ...defaults(child), signal: controller.signal,
    assertHealthy: () => { observation.assertHealthy(); validateNativeHostHealth(native, binding); },
    onDuration: value => timings.push(value), WebSocketImpl: sockets.Socket,
    createWorker: request => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.gate);
      Atomics.store(gate, 0, 1);
      Atomics.wait(gate, 1, 0);
      parentPort.postMessage({ kind: 'ownership', verdict: true });
    `, { eval: true, workerData: { ...request, gate: gate.buffer } }),
  }).then(value => ({ value }), error => ({ error }));
  try {
    await until(() => Atomics.load(gate, 0) === 1);
    await sleep(1700);
    assert.equal(heartbeatFailure, undefined);
    assert.ok(samples >= 10);
    assert.ok(leases >= 10);
    assert.equal(sockets.instances.length, 0);
    observation.assertHealthy();
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    const outcome = await result;
    if (outcome.error) throw outcome.error;
    cdp = outcome.value;
    assert.equal(sockets.instances.length, 1);
    assert.equal(timings.length, 1);
    assert.equal(timings[0].outcome, 'owned');
    assert.ok(timings[0].elapsedMs >= 1500);
  } finally {
    clearInterval(timer);
    controller.abort(new Error('Inert fixture finished'));
    observation.stop();
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    cdp?.close();
  }
});

test('cancelled, replaced, or exited original hosts cannot attach using a late positive worker result', async () => {
  for (const change of ['cancelled', 'generation', 'replacement', 'exit', 'pid']) {
    const child = host();
    let currentChild = child, generation = 1;
    const controller = new AbortController();
    const worker = new InertWorker();
    const sockets = socketFixture();
    let started = false;
    const result = connectVerifiedEndpoint({ ...defaults(child), signal: controller.signal,
      isCurrent: () => currentChild === child && generation === 1, WebSocketImpl: sockets.Socket,
      createWorker: request => {
        started = true;
        assert.deepEqual(request.child, { pid: 20, exitCode: null, signalCode: null });
        return worker;
      },
    }).then(value => ({ value }), error => ({ error }));
    await until(() => started);
    if (change === 'cancelled') controller.abort(new Error('fixture cancellation'));
    else if (change === 'generation') generation++;
    else if (change === 'replacement') currentChild = host();
    else if (change === 'exit') child.exitCode = 0;
    else child.pid++;
    worker.emit('message', { kind: 'ownership', verdict: true });
    const outcome = await result;
    assert.ok(outcome.error, change);
    assert.equal(sockets.instances.length, 0, change);
    assert.equal(worker.terminated, true, change);
  }
});

test('a generation change after verifier approval is checked again before opening the socket', async () => {
  const child = host();
  const worker = new InertWorker();
  const sockets = socketFixture();
  let generation = 1;
  const result = connectVerifiedEndpoint({ ...defaults(child), isCurrent: () => generation === 1,
    WebSocketImpl: sockets.Socket, onDuration: () => { generation++; },
    createWorker: () => { queueMicrotask(() => worker.emit('message', { kind: 'ownership', verdict: true })); return worker; },
  });
  await assert.rejects(result, /obsolete or exited/);
  assert.equal(sockets.instances.length, 0);
});

test('offloaded ownership keeps the exact strict verdict boundary', async () => {
  for (const verdict of [false, null, { ok: false, reasons: ['fixture foreign listener'] }, { ok: true }]) {
    const worker = new InertWorker();
    const sockets = socketFixture();
    await assert.rejects(connectVerifiedEndpoint({ ...defaults(host()), WebSocketImpl: sockets.Socket,
      createWorker: () => { queueMicrotask(() => worker.emit('message', { kind: 'ownership', verdict })); return worker; },
    }), /refusing CDP attach/);
    assert.equal(sockets.instances.length, 0);
  }
});

test('an already exited handle, worker failure, or missing verdict never approves attachment', async () => {
  let spawned = false;
  await assert.rejects(verifyEndpointOffThread({ ...defaults({ ...host(), exitCode: 0 }),
    createWorker: () => { spawned = true; return new InertWorker(); },
  }), /obsolete or exited/);
  assert.equal(spawned, false);
  for (const event of ['error', 'exit', 'message']) {
    const worker = new InertWorker();
    await assert.rejects(verifyEndpointOffThread({ ...defaults(host()), createWorker: () => {
      queueMicrotask(() => worker.emit(event, event === 'error' ? new Error('fixture verifier error')
        : event === 'exit' ? 0 : { kind: 'incomplete' }));
      return worker;
    } }));
    assert.equal(worker.terminated, true);
  }
});
