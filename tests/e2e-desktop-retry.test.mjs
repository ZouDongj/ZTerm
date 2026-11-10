import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopObserverTransientError } from '../scripts/e2e-background-policy.mjs';
import { DESKTOP_RETRY_ENV, respawnDesktopProcess, runWithDesktopRetry } from '../scripts/e2e-desktop-retry.mjs';
import { processExitCode } from '../scripts/e2e-process-supervisor.mjs';

test('a desktop transient cleans the owned run before one fresh-process retry', async () => {
  const events = [];
  const reports = [];
  const code = await runWithDesktopRetry({
    main: async () => { events.push('main'); throw new DesktopObserverTransientError(); },
    cleanup: async () => {
      events.push('cleanup');
      await Promise.resolve();
      events.push('cleaned');
      return true;
    },
    respawn: async () => { events.push('respawn'); return 0; },
    env: {},
    report: message => reports.push(message),
  });
  assert.equal(code, 0);
  assert.deepEqual(events, ['main', 'cleanup', 'cleaned', 'respawn']);
  assert.match(reports.join('\n'), /foreground identity unavailable.*fresh process/s);
});

test('the fresh-process adapter marks the child as the final retry', async () => {
  const child = new EventEmitter();
  const env = { FIXTURE: 'preserved' };
  let invocation;
  const result = respawnDesktopProcess({
    script: 'D:/fixture/e2e-check.mjs', args: ['fixture.exe', '9222'], env,
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  assert.equal(await result, 0);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, ['D:/fixture/e2e-check.mjs', 'fixture.exe', '9222']);
  assert.equal(invocation.options.stdio, 'inherit');
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.FIXTURE, 'preserved');
  assert.equal(invocation.options.env[DESKTOP_RETRY_ENV], '1');
  assert.equal(env[DESKTOP_RETRY_ENV], undefined, 'the parent environment is not mutated');
});

test('the retry sentinel and non-transient failures never spawn another run', async () => {
  for (const fixture of [
    { error: new DesktopObserverTransientError(), env: { [DESKTOP_RETRY_ENV]: '1' }, reason: /foreground identity unavailable/ },
    { error: new Error('foreground owner identity unavailable'), env: {}, reason: /foreground owner identity unavailable/ },
  ]) {
    const events = [];
    const reports = [];
    const code = await runWithDesktopRetry({
      main: async () => { events.push('main'); throw fixture.error; },
      cleanup: () => { events.push('cleanup'); return true; },
      respawn: async () => { events.push('respawn'); return 0; },
      env: fixture.env,
      report: message => reports.push(message),
    });
    assert.equal(code, 1);
    assert.deepEqual(events, ['main', 'cleanup']);
    assert.match(reports.join('\n'), fixture.reason);
  }
});

test('uncertain owned cleanup forbids retry and preserves both failures', async () => {
  for (const cleanup of [
    () => ({ ok: false, reasons: ['owned host survived'] }),
    () => { throw new Error('owned cleanup query failed'); },
  ]) {
    let respawns = 0;
    const reports = [];
    const code = await runWithDesktopRetry({
      main: async () => { throw new DesktopObserverTransientError(); },
      cleanup,
      respawn: async () => { respawns++; return 0; },
      env: {},
      report: message => reports.push(message),
    });
    assert.equal(code, 1);
    assert.equal(respawns, 0);
    assert.match(reports.join('\n'), /foreground identity unavailable/);
    assert.match(reports.join('\n'), /owned (host survived|cleanup query failed)/);
  }
});

test('a successful run needs neither cleanup nor a retry', async () => {
  let calls = 0;
  const code = await runWithDesktopRetry({
    main: async () => {},
    cleanup: () => { calls++; return true; },
    respawn: async () => { calls++; return 1; },
  });
  assert.equal(code, 0);
  assert.equal(calls, 0);
});

test('child signals propagate as conventional nonzero exit statuses', () => {
  assert.equal(processExitCode(0, null), 0);
  assert.equal(processExitCode(7, null), 7);
  assert.equal(processExitCode(null, 'SIGKILL'), 137);
  assert.equal(processExitCode(null, 'SIGTERM'), 143);
});

test('a retry spawn error rejects instead of fabricating an exit', async () => {
  const child = new EventEmitter();
  const result = respawnDesktopProcess({
    script: 'D:/fixture/e2e-check.mjs', env: {},
    spawnProcess: () => child,
  });
  const rejected = assert.rejects(result, /fixture spawn failure/);
  child.emit('error', new Error('fixture spawn failure'));
  await rejected;
});
