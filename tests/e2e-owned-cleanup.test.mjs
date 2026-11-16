import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOwnedCleanupCoordinator } from '../scripts/e2e-owned-cleanup.mjs';
import { DesktopObserverTransientError } from '../scripts/e2e-background-policy.mjs';
import { runWithDesktopRetry } from '../scripts/e2e-desktop-retry.mjs';

const entries = [
  ['e2e-check', 'e2e-check.mjs'],
  ['webgl', 'e2e-webgl-context-recovery.mjs'],
];

function harness() {
  let resolveObserver;
  const observerStopping = new Promise(resolve => { resolveObserver = resolve; });
  const calls = { observer: 0, runtime: 0, respawn: 0 };
  const coordinator = createOwnedCleanupCoordinator({
    stopBackgroundObserver: () => { calls.observer++; return observerStopping; },
    cleanOwnedRuntime: () => { calls.runtime++; return true; },
  });
  return { calls, coordinator, resolveObserver };
}

for (const [entry, file] of entries) {
  test(`${entry} failBackground and wrapper await one shared cleanup credential`, async () => {
    assert.match(readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8'), /createOwnedCleanupCoordinator/);
    const { calls, coordinator, resolveObserver } = harness();
    const first = coordinator.killExisting();
    void first;
    const wrapper = runWithDesktopRetry({
      main: async () => { throw new DesktopObserverTransientError(); },
      cleanup: coordinator.killExisting,
      respawn: async () => { calls.respawn++; return 0; },
      env: {}, report: () => {},
    });
    assert.strictEqual(coordinator.killExisting(), first, 'wrapper must receive the exact first Promise');
    await sleep(20);
    assert.deepEqual(calls, { observer: 1, runtime: 1, respawn: 0 });
    resolveObserver(true);
    assert.equal(await wrapper, 0);
    assert.deepEqual(calls, { observer: 1, runtime: 1, respawn: 1 });
    assert.equal(await coordinator.beginNextRun(), true);
    await coordinator.killExisting();
    assert.deepEqual(calls, { observer: 2, runtime: 2, respawn: 1 }, 'only a new run generation cleans again');
  });

  for (const outcome of ['kill=false', 'timeout']) {
    test(`${entry} failBackground ${outcome} permanently forbids retry`, async () => {
      const { calls, coordinator, resolveObserver } = harness();
      const first = coordinator.killExisting();
      void first;
      const wrapper = runWithDesktopRetry({
        main: async () => { throw new DesktopObserverTransientError(); },
        cleanup: coordinator.killExisting,
        respawn: async () => { calls.respawn++; return 0; },
        env: {}, report: () => {},
      });
      await sleep(10);
      assert.equal(calls.respawn, 0);
      const failure = { ok: false, reasons: [`observer ${outcome}`] };
      resolveObserver(failure);
      assert.equal(await wrapper, 1);
      assert.strictEqual(coordinator.killExisting(), first);
      assert.equal(await coordinator.beginNextRun(), failure);
      assert.deepEqual(calls, { observer: 1, runtime: 1, respawn: 0 });
    });
  }
}
