import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureProcessExit, DesktopObserverTransientError, stopBackgroundRun } from '../scripts/e2e-background-policy.mjs';
import { runWithDesktopRetry } from '../scripts/e2e-desktop-retry.mjs';

function fixture(kill) {
  const observer = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill,
  });
  const run = {
    observer,
    observerExit: captureProcessExit(observer),
    observation: null,
    leasePath: null,
    timer: null,
    abortController: new AbortController(),
    stopping: false,
  };
  return { observer, run };
}

async function cleanupAndRetry(run, reports, respawns, timeoutMs) {
  return runWithDesktopRetry({
    main: async () => { throw new DesktopObserverTransientError(); },
    cleanup: () => stopBackgroundRun(run, new Error('fixture stop'), () => {}, { timeoutMs }),
    respawn: async () => { respawns.count++; return 0; },
    env: {},
    report: message => reports.push(message),
  });
}

test('observer cleanup waits for a delayed exact-child exit before retrying', async () => {
  let kills = 0;
  const { observer, run } = fixture(() => { kills++; return true; });
  const reports = [];
  const respawns = { count: 0 };
  const result = cleanupAndRetry(run, reports, respawns, 100);
  await sleep(15);
  assert.equal(respawns.count, 0, 'retry cannot start while the old observer is alive');
  assert.equal(run.abortController.signal.aborted, true, 'abort is still synchronous');
  observer.exitCode = 0;
  observer.emit('exit', 0, null);
  assert.equal(await result, 0);
  assert.equal(kills, 1);
  assert.equal(respawns.count, 1);
});

test('kill=false forbids retry even if an exit event arrives later', async () => {
  const { observer, run } = fixture(() => false);
  const reports = [];
  const respawns = { count: 0 };
  const result = cleanupAndRetry(run, reports, respawns, 50);
  setTimeout(() => { observer.exitCode = 0; observer.emit('exit', 0, null); }, 5);
  assert.equal(await result, 1);
  assert.equal(respawns.count, 0);
  assert.match(reports.join('\n'), /observer kill returned false/);
});

test('an observer that does not exit within its bound forbids retry', async () => {
  const { run } = fixture(() => true);
  const reports = [];
  const respawns = { count: 0 };
  const result = cleanupAndRetry(run, reports, respawns, 15);
  assert.equal(await result, 1);
  assert.equal(respawns.count, 0);
  assert.match(reports.join('\n'), /observer exit timed out/);
});

function realObserver() {
  const observer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore', windowsHide: true,
  });
  const run = {
    observer,
    observerExit: captureProcessExit(observer),
    observation: null,
    leasePath: null,
    timer: null,
    abortController: new AbortController(),
    stopping: false,
  };
  return { observer, run, closed: once(observer, 'close'), kill: observer.kill.bind(observer) };
}

async function disposeRealObserver(context) {
  if (context.observer.exitCode === null && context.observer.signalCode === null) context.kill('SIGKILL');
  await context.closed;
}

test('a real delayed observer exit is awaited before the fresh process starts', async () => {
  const context = realObserver();
  const reports = [];
  const respawns = { count: 0 };
  let exited = false;
  context.observer.once('exit', () => { exited = true; });
  context.observer.kill = () => {
    setTimeout(() => context.kill('SIGKILL'), 75);
    return true;
  };
  try {
    const result = cleanupAndRetry(context.run, reports, respawns, 500);
    await sleep(20);
    assert.equal(respawns.count, 0);
    assert.equal(exited, false);
    assert.equal(await result, 0);
    assert.equal(exited, true);
    assert.equal(respawns.count, 1);
  } finally { await disposeRealObserver(context); }
});

test('a real observer kill=false cannot retry even after its actual exit', async () => {
  const context = realObserver();
  const reports = [];
  const respawns = { count: 0 };
  context.observer.kill = () => false;
  setTimeout(() => context.kill('SIGKILL'), 25);
  try {
    assert.equal(await cleanupAndRetry(context.run, reports, respawns, 200), 1);
    assert.equal(respawns.count, 0);
    assert.match(reports.join('\n'), /observer kill returned false/);
  } finally { await disposeRealObserver(context); }
});

test('a real observer timeout cannot retry and leaves no child behind', async () => {
  const context = realObserver();
  const reports = [];
  const respawns = { count: 0 };
  context.observer.kill = () => true;
  try {
    assert.equal(await cleanupAndRetry(context.run, reports, respawns, 25), 1);
    assert.equal(respawns.count, 0);
    assert.equal(context.observer.exitCode, null, 'fault injection kept the real observer alive');
    assert.match(reports.join('\n'), /observer exit timed out/);
  } finally { await disposeRealObserver(context); }
  assert.equal(context.observer.exitCode !== null || context.observer.signalCode !== null, true);
});
