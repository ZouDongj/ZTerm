import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  backgroundDesktopIndex, validateDesktopSnapshot, validateBackgroundContinuity,
  validateFreshDesktopSnapshot, observeDesktopStream, validatePlacedHost, completeBackgroundHandshake,
  validateNativeHostHealth, renewNativeLease, readHostProcessDiagnostic,
  BACKGROUND_CLOCK_DOMAIN, backgroundNow, createBackgroundLease,
} from '../scripts/e2e-background-policy.mjs';

const baseline = {
  ok: true,
  clockDomain: BACKGROUND_CLOCK_DOMAIN,
  currentDesktopId: '11111111-1111-1111-1111-111111111111',
  targetDesktopId: '22222222-2222-2222-2222-222222222222',
  foregroundHwnd: '0x1234', foregroundPid: 10, foregroundOwnerPids: [10],
  observedAt: backgroundNow(),
};
const expected = { token: 'fixture-token', pid: 20, targetDesktopId: baseline.targetDesktopId };
const placed = { ...expected, clockDomain: BACKGROUND_CLOCK_DOMAIN, phase: 'placed', hwnd: '0x5678', disabled: true, noActivate: true,
  visible: true, minimized: true, onCurrentDesktop: false, onTargetDesktop: true };
const fresh = replacement => ({ ...baseline, observedAt: backgroundNow(), ...replacement });
const observerChild = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
const emitSample = (observer, replacement) => observer.stdout.emit('data', JSON.stringify(fresh(replacement)) + '\n');

test('background mode never interprets off or invalid indices as foreground permission', () => {
  assert.equal(backgroundDesktopIndex(), 1);
  for (const value of ['off', '0', '-1', 'NaN', '', '2.5']) assert.throws(() => backgroundDesktopIndex(value));
});

test('preflight rejects the active target and incomplete inspection', () => {
  assert.equal(validateDesktopSnapshot(baseline), baseline);
  assert.throws(() => validateDesktopSnapshot({ ...baseline, targetDesktopId: baseline.currentDesktopId }));
  assert.throws(() => validateDesktopSnapshot({ ...baseline, foregroundHwnd: '0x0' }));
  assert.throws(() => validateDesktopSnapshot({ ...baseline, ok: false }));
  for (const field of ['currentDesktopId', 'targetDesktopId']) {
    assert.throws(() => validateDesktopSnapshot({ ...baseline, [field]: '00000000-0000-0000-0000-000000000000' }));
  }
  for (const owners of [undefined, '10', [], [10.5], [0], [30], [10, '20']]) {
    assert.throws(() => validateDesktopSnapshot({ ...baseline, foregroundOwnerPids: owners }));
  }
  for (const observedAt of [undefined, null, 0, -1, 1.5, '100']) {
    assert.throws(() => validateDesktopSnapshot({ ...baseline, observedAt }));
  }
});

test('continuity rejects desktop changes and owned foreground without changing the user desktop', () => {
  assert.throws(() => validateBackgroundContinuity(baseline, { ...baseline, currentDesktopId: '33333333-3333-3333-3333-333333333333' }, 20));
  assert.throws(() => validateBackgroundContinuity(baseline, { ...baseline, foregroundPid: 20, foregroundOwnerPids: [20] }, 20));
  assert.throws(() => validateBackgroundContinuity(baseline, { ...baseline, foregroundOwnerPids: [10, 20] }, 20));
  assert.throws(() => validateBackgroundContinuity(baseline, { ...baseline, foregroundHwnd: '0x9999' }, 20, true));
  assert.doesNotThrow(() => validateBackgroundContinuity(baseline, { ...baseline, foregroundHwnd: '0x9999', foregroundPid: 30, foregroundOwnerPids: [30] }, 20));
});

test('placement must prove the exact disabled minimized owned host', () => {
  assert.equal(validatePlacedHost(placed, expected), placed);
  for (const replacement of [{ token: 'old' }, { pid: 30 }, { disabled: false }, { noActivate: false },
    { visible: false }, { minimized: false }, { onCurrentDesktop: true }, { onTargetDesktop: false }, { phase: 'guarded' }]) {
    assert.throws(() => validatePlacedHost({ ...placed, ...replacement }, expected));
  }
});

test('release happens only after placement and unchanged desktop/foreground proof', async () => {
  const calls = [];
  const shown = { ...placed, phase: 'shown', minimized: false };
  const result = await completeBackgroundHandshake({
    baseline, expected,
    readPlacement: async () => { calls.push('placement'); return placed; },
    inspect: async () => { calls.push('inspect'); return fresh(); },
    release: async binding => { calls.push('release'); assert.deepEqual(binding, { token: expected.token, pid: expected.pid, hwnd: placed.hwnd }); },
    readShown: async () => { calls.push('shown'); return shown; },
  });
  assert.equal(result, shown);
  assert.deepEqual(calls, ['placement', 'inspect', 'release', 'shown', 'inspect']);
});

test('failed placement or lost foreground evidence never releases the app', async () => {
  for (const badPlacement of [true, false]) {
    let released = false;
    await assert.rejects(completeBackgroundHandshake({
      baseline, expected,
      readPlacement: async () => badPlacement ? { ...placed, disabled: false } : placed,
      inspect: async () => fresh({ foregroundHwnd: '0x9999' }),
      release: async () => { released = true; },
      readShown: async () => { throw new Error('unreachable'); },
    }));
    assert.equal(released, false);
  }
});

test('nil desktop or ambiguous owner proof cannot release an otherwise placed host', async () => {
  for (const replacement of [{ currentDesktopId: '00000000-0000-0000-0000-000000000000' }, { foregroundOwnerPids: '10' }]) {
    let released = false;
    await assert.rejects(completeBackgroundHandshake({
      baseline, expected, readPlacement: async () => placed,
      inspect: async () => fresh(replacement),
      release: async () => { released = true; }, readShown: async () => ({ ...placed, phase: 'shown' }),
    }));
    assert.equal(released, false);
  }
});

test('stale, future, and pre-watch samples cannot establish fresh proof', () => {
  const now = 10000;
  assert.equal(validateFreshDesktopSnapshot({ ...baseline, observedAt: now }, now, now).observedAt, now);
  for (const observedAt of [now - 1501, now + 1, now - 1]) {
    assert.throws(() => validateFreshDesktopSnapshot({ ...baseline, observedAt }, now, now));
  }
});

test('observer startup waits for its own complete fresh sample before host spawn', async () => {
  const observer = observerChild();
  const observation = observeDesktopStream({ observer, baseline: fresh(), requireSameForeground: () => true });
  let spawned = false;
  const launch = (async () => { await observation.ready; observation.assertHealthy(); spawned = true; })();
  try {
    await Promise.resolve();
    assert.equal(spawned, false);
    assert.throws(() => observation.assertHealthy());
    const line = JSON.stringify(fresh());
    observer.stdout.emit('data', line.slice(0, 20));
    await Promise.resolve();
    assert.equal(spawned, false);
    observer.stdout.emit('data', line.slice(20) + '\n');
    await launch;
    assert.equal(spawned, true);
  } finally { observation.stop(); }
});

test('failed, absent, or unsafe first observer proof never reaches host spawn', async () => {
  for (const failure of ['exit', 'error', 'malformed', 'desktop', 'foreground', 'stale', 'future', 'absent']) {
    const observer = observerChild();
    let failures = 0;
    const observation = observeDesktopStream({ observer, baseline: fresh(), startupTimeoutMs: 15,
      requireSameForeground: () => true, onFailure: () => { failures++; } });
    let spawned = false;
    const launch = (async () => { await observation.ready; observation.assertHealthy(); spawned = true; })();
    const rejected = assert.rejects(launch);
    if (failure === 'exit') observer.emit('exit', 3);
    else if (failure === 'error') observer.emit('error', new Error('fixture observer failure'));
    else if (failure === 'malformed') observer.stdout.emit('data', '{oops}\n');
    else if (failure === 'desktop') emitSample(observer, { currentDesktopId: baseline.targetDesktopId });
    else if (failure === 'foreground') emitSample(observer, { foregroundHwnd: '0x9999' });
    else if (failure === 'stale') emitSample(observer, { observedAt: backgroundNow() - 2000 });
    else if (failure === 'future') emitSample(observer, { observedAt: backgroundNow() + 2000 });
    try {
      await rejected;
      assert.equal(spawned, false, failure);
      assert.equal(failures, 1, failure);
    } finally { observation.stop(); }
  }
});

test('a ready observer still fails on stale proof, lost ownership continuity, or observer exit', async () => {
  let now = backgroundNow();
  let pid = null;
  const observer = observerChild();
  const failures = [];
  const observation = observeDesktopStream({ observer, baseline: { ...baseline, observedAt: now },
    now: () => now, getOwnedPid: () => pid, onFailure: error => failures.push(error) });
  try {
    observer.stdout.emit('data', JSON.stringify({ ...baseline, observedAt: now }) + '\n');
    await observation.ready;
    pid = 20;
    assert.doesNotThrow(() => observation.assertHealthy());
    now += 1501;
    assert.throws(() => observation.assertHealthy());
    observer.stdout.emit('data', JSON.stringify({ ...baseline, observedAt: now, foregroundOwnerPids: [10, 20] }) + '\n');
    assert.equal(failures.length, 1);
    assert.throws(() => observation.assertHealthy(), /acquired foreground/);
    observer.emit('exit', 0);
    assert.equal(failures.length, 1);
  } finally { observation.stop(); }
});

test('shown proof rejects a still minimized, activatable, hidden, or misplaced host', async () => {
  for (const replacement of [{ minimized: true }, { noActivate: false }, { disabled: false },
    { visible: false }, { onTargetDesktop: false }, { onCurrentDesktop: true }]) {
    await assert.rejects(completeBackgroundHandshake({
      baseline, expected, readPlacement: async () => placed, inspect: async () => fresh(),
      release: async () => {}, readShown: async () => ({ ...placed, phase: 'shown', minimized: false, ...replacement }),
    }));
  }
});

test('released native health allows real minimize and restore while preserving every guard', () => {
  const now = 10000;
  const binding = { ...expected, hwnd: placed.hwnd, released: true };
  for (const minimized of [true, false]) {
    const status = { ...placed, phase: 'shown', minimized, checkedAt: now };
    assert.equal(validateNativeHostHealth(status, binding, now), status);
    assert.doesNotThrow(() => validateNativeHostHealth({ ...status, visible: false }, binding, now));
    for (const replacement of [{ disabled: false }, { noActivate: false }, { visible: undefined },
      { onCurrentDesktop: true }, { onTargetDesktop: false }, { token: 'old' }, { pid: 30 },
      { hwnd: '0x9999' }, { targetDesktopId: baseline.currentDesktopId }, { checkedAt: undefined },
      { checkedAt: now + 1 }, { minimized: null }, { phase: 'placed' }]) {
      assert.throws(() => validateNativeHostHealth({ ...status, ...replacement }, binding, now));
    }
  }
});

test('a frozen native heartbeat cannot renew leases while desktop observation stays fresh', () => {
  let now = 10000;
  const status = { ...placed, phase: 'shown', minimized: false, checkedAt: now };
  let renewals = 0;
  const renewal = { readStatus: () => status, expected: { ...expected, hwnd: placed.hwnd, released: true },
    now: () => now, renew: () => { renewals++; } };
  renewNativeLease(renewal);
  assert.equal(renewals, 1);
  now += 1501;
  assert.doesNotThrow(() => validateFreshDesktopSnapshot({ ...baseline, observedAt: now }, now));
  assert.throws(() => renewNativeLease(renewal), /native guard proof/);
  assert.equal(renewals, 1);
});

test('failed, missing, and unreadable native health never renew an observer lease', () => {
  const binding = { ...expected, hwnd: placed.hwnd, released: true };
  let renewals = 0;
  for (const readStatus of [() => ({ ...placed, phase: 'failed', error: 'fixture GUI watchdog timed out' }),
    () => null, () => { throw new Error('fixture native status unavailable'); }]) {
    assert.throws(() => renewNativeLease({ readStatus, expected: binding, renew: () => { renewals++; } }));
  }
  assert.equal(renewals, 0);
});

test('process diagnostics execute one hidden asynchronous executable with explicit arguments and a bound', async () => {
  let calls = 0;
  const controller = new AbortController();
  const output = await readHostProcessDiagnostic((executable, argv, options, callback) => {
    calls++;
    assert.equal(executable, 'tasklist.exe');
    assert.deepEqual(argv, ['/FI', 'IMAGENAME eq zterm.exe', '/FO', 'CSV', '/NH']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, 3000);
    assert.equal(options.signal, controller.signal);
    queueMicrotask(() => callback(null, ' inert diagnostic result\r\n'));
  }, controller.signal);
  assert.equal(output, 'inert diagnostic result');
  assert.equal(calls, 1);
});

test('all cross-process timing proof rejects missing or unknown clock domains', () => {
  const now = 10000;
  const binding = { ...expected, hwnd: placed.hwnd, released: true };
  for (const clockDomain of [undefined, null, 'unix-ms', 'Windows-boot-ms']) {
    assert.throws(() => validateFreshDesktopSnapshot({ ...baseline, clockDomain, observedAt: now }, now));
    assert.throws(() => validatePlacedHost({ ...placed, clockDomain }, expected));
    assert.throws(() => validateNativeHostHealth({ ...placed, phase: 'shown', minimized: false,
      clockDomain, checkedAt: now }, binding, now));
  }
});

test('observer birth is captured before spawn rather than after its first sample', async () => {
  const observer = observerChild();
  const observation = observeDesktopStream({ observer, baseline: { ...baseline, observedAt: 10000 },
    now: () => 10020, startedAt: 10000 });
  try {
    observer.stdout.emit('data', JSON.stringify({ ...baseline, observedAt: 10010 }) + '\n');
    await observation.ready;
    assert.doesNotThrow(() => observation.assertHealthy());
  } finally { observation.stop(); }
});

test('wall-clock jumps do not change observer, native health, or lease clock domains', () => {
  const wallNow = Date.now;
  const snapshot = fresh();
  const binding = { ...expected, hwnd: placed.hwnd, released: true };
  const status = { ...placed, phase: 'shown', minimized: false, checkedAt: backgroundNow() };
  let renewals = 0;
  try {
    for (const wall of [0, 1, 9000000000000000]) {
      Date.now = () => wall;
      assert.doesNotThrow(() => validateFreshDesktopSnapshot(snapshot));
      assert.doesNotThrow(() => validateNativeHostHealth(status, binding));
      renewNativeLease({ readStatus: () => status, expected: binding, renew: () => { renewals++; } });
      const lease = createBackgroundLease(binding);
      assert.equal(lease.clockDomain, BACKGROUND_CLOCK_DOMAIN);
      assert.ok(lease.renewedAt >= snapshot.observedAt && lease.renewedAt <= backgroundNow());
      assert.notEqual(lease.renewedAt, wall);
    }
    assert.equal(renewals, 3);
  } finally { Date.now = wallNow; }
});
