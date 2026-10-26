import { rmSync } from 'node:fs';
import { uptime } from 'node:os';

export const BACKGROUND_CLOCK_DOMAIN = 'windows-boot-ms';

// On Windows, libuv uses GetTickCount64()/1000.0 for os.uptime().
export function backgroundNow(readUptime = uptime) { return Math.floor(readUptime() * 1000); }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HWND = /^0x[0-9a-f]{1,16}$/i;
const NIL_GUID = '00000000-0000-0000-0000-000000000000';
const OBSERVATION_MAX_AGE_MS = 1500;

export function backgroundDesktopIndex(value = '2') {
  const desktop = Number(String(value).trim());
  if (!Number.isInteger(desktop) || desktop < 1) {
    throw new Error('Background E2E requires a valid desktop number; foreground fallback is disabled');
  }
  return desktop - 1;
}

export function validateDesktopSnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true || snapshot.clockDomain !== BACKGROUND_CLOCK_DOMAIN || !GUID.test(snapshot.currentDesktopId)
      || !GUID.test(snapshot.targetDesktopId) || snapshot.currentDesktopId === NIL_GUID
      || snapshot.targetDesktopId === NIL_GUID || !HWND.test(snapshot.foregroundHwnd)
      || BigInt(snapshot.foregroundHwnd) === 0n || !Number.isInteger(snapshot.foregroundPid)
      || snapshot.foregroundPid <= 0 || snapshot.foregroundPid > 0xffffffff
      || !Array.isArray(snapshot.foregroundOwnerPids) || snapshot.foregroundOwnerPids.length < 1
      || snapshot.foregroundOwnerPids.length > 8 || snapshot.foregroundOwnerPids[0] !== snapshot.foregroundPid
      || !snapshot.foregroundOwnerPids.every(pid => Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff)
      || !Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt <= 0) {
    throw new Error('Desktop/foreground inspection is incomplete; refusing background E2E');
  }
  if (snapshot.currentDesktopId.toLowerCase() === snapshot.targetDesktopId.toLowerCase()) {
    throw new Error('The requested test desktop is active; refusing to launch on the user desktop');
  }
  return snapshot;
}

export function validateFreshDesktopSnapshot(snapshot, now = backgroundNow(), notBefore = 0) {
  validateDesktopSnapshot(snapshot);
  if (snapshot.observedAt < notBefore || snapshot.observedAt > now
      || now - snapshot.observedAt > OBSERVATION_MAX_AGE_MS) {
    throw new Error('Fresh background observer proof is unavailable');
  }
  return snapshot;
}

export function validateBackgroundContinuity(before, after, ownedPid, requireSameForeground = false) {
  validateDesktopSnapshot(before);
  validateDesktopSnapshot(after);
  if (after.currentDesktopId.toLowerCase() !== before.currentDesktopId.toLowerCase()
      || after.targetDesktopId.toLowerCase() !== before.targetDesktopId.toLowerCase()) {
    throw new Error('Desktop changed during background E2E; stopping only the owned test instance');
  }
  const owners = [after.foregroundPid, ...(after.foregroundOwnerPids || [])];
  if (ownedPid && owners.includes(ownedPid)) {
    throw new Error('The owned test instance acquired foreground; background isolation failed');
  }
  if (requireSameForeground && (before.foregroundHwnd !== after.foregroundHwnd
      || before.foregroundPid !== after.foregroundPid)) {
    throw new Error('Foreground changed during startup; non-interference could not be established');
  }
  return after;
}

// This boundary consumes a read-only child stream; it never starts a host.
export function observeDesktopStream({ observer, baseline, getOwnedPid = () => null,
  requireSameForeground = () => false, onFailure = () => {}, now = backgroundNow, startedAt = now(), startupTimeoutMs = 3000 }) {
  validateFreshDesktopSnapshot(baseline, now());
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > now()) {
    throw new Error('Observer birth boundary is unavailable');
  }
  let latest = null;
  let failure = null;
  let stopped = false;
  let buffer = '';
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupTimer = setTimeout(() => fail(new Error('Desktop observer did not provide startup proof')), startupTimeoutMs);
  function fail(error) {
    if (stopped || failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    clearTimeout(startupTimer);
    rejectReady(failure);
    onFailure(failure);
  }
  function assertHealthy() {
    if (failure) throw failure;
    if (stopped || !latest) throw new Error('Fresh background observer proof is unavailable');
    validateFreshDesktopSnapshot(latest, now(), startedAt);
    return validateBackgroundContinuity(baseline, latest, getOwnedPid(), requireSameForeground());
  }
  observer.stdout.on('data', chunk => {
    if (stopped || failure) return;
    buffer += chunk.toString();
    if (buffer.length > 65536) { fail(new Error('Observer output exceeded its bound')); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const snapshot = validateFreshDesktopSnapshot(JSON.parse(line), now(), startedAt);
        validateBackgroundContinuity(baseline, snapshot, getOwnedPid(), requireSameForeground());
        latest = snapshot;
        clearTimeout(startupTimer);
        resolveReady(snapshot);
      } catch (error) { fail(error); return; }
    }
  });
  observer.on('error', fail);
  observer.on('exit', code => fail(new Error('Desktop observer exited: ' + code)));
  return {
    ready, assertHealthy,
    stop() {
      stopped = true;
      clearTimeout(startupTimer);
      rejectReady(new Error('Desktop observer stopped before startup proof'));
    },
  };
}

export function validatePlacedHost(status, expected) {
  if (!Number.isInteger(expected.pid) || expected.pid <= 0 || typeof expected.token !== 'string' || !expected.token
      || !status || status.clockDomain !== BACKGROUND_CLOCK_DOMAIN || status.token !== expected.token || status.pid !== expected.pid
      || status.phase !== 'placed' || status.disabled !== true || status.noActivate !== true
      || status.visible !== true || status.minimized !== true
      || status.onCurrentDesktop !== false || status.onTargetDesktop !== true || !HWND.test(status.hwnd)
      || BigInt(status.hwnd) === 0n
      || status.targetDesktopId?.toLowerCase() !== expected.targetDesktopId.toLowerCase()) {
    throw new Error('Owned background host has not established its disabled desktop placement barrier');
  }
  return status;
}

export function validateNativeHostHealth(status, expected, now = backgroundNow()) {
  if (status?.phase === 'failed') throw new Error(status.error || 'Native background guard failed');
  if (!status || status.clockDomain !== BACKGROUND_CLOCK_DOMAIN || status.token !== expected.token || status.pid !== expected.pid || status.hwnd !== expected.hwnd
      || !['placed', 'shown'].includes(status.phase) || (expected.released && status.phase !== 'shown')
      || status.disabled !== true || status.noActivate !== true || typeof status.visible !== 'boolean'
      || (!expected.released && status.visible !== true)
      || typeof status.minimized !== 'boolean' || (status.phase === 'placed' && status.minimized !== true)
      || status.onCurrentDesktop !== false || status.onTargetDesktop !== true
      || status.targetDesktopId?.toLowerCase() !== expected.targetDesktopId.toLowerCase()
      || !Number.isSafeInteger(status.checkedAt) || status.checkedAt <= 0 || status.checkedAt > now
      || now - status.checkedAt > OBSERVATION_MAX_AGE_MS) {
    throw new Error('Fresh owned native guard proof is unavailable');
  }
  return status;
}

export function renewNativeLease({ readStatus, expected, renew, now = backgroundNow }) {
  validateNativeHostHealth(readStatus(), expected, now());
  renew();
}

export function createBackgroundLease(binding, now = backgroundNow()) {
  return { ...binding, clockDomain: BACKGROUND_CLOCK_DOMAIN, renewedAt: now };
}

export function stopBackgroundRun(run, reason, onCleanupError = () => {}) {
  run.stopping = true;
  clearInterval(run.timer);
  if (run.leasePath) {
    try { rmSync(run.leasePath, { force: true }); } catch (error) { onCleanupError(error); }
  }
  run.abortController.abort(reason);
  run.observation?.stop();
  if (run.observer && run.observer.exitCode === null) {
    try { run.observer.kill(); } catch (error) { onCleanupError(error); }
  }
}

export async function readHostProcessDiagnostic(execFile, signal) {
  const output = await new Promise((resolve, reject) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq zterm.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000, signal },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return output.trim() || '(无 zterm 进程)';
}

export async function completeBackgroundHandshake({ baseline, expected, readPlacement, inspect, release, readShown }) {
  validateDesktopSnapshot(baseline);
  const placed = validatePlacedHost(await readPlacement(), expected);
  validateBackgroundContinuity(baseline, validateFreshDesktopSnapshot(await inspect()), expected.pid, true);
  await release({ token: expected.token, pid: expected.pid, hwnd: placed.hwnd });
  const shown = await readShown();
  if (!shown || shown.clockDomain !== BACKGROUND_CLOCK_DOMAIN || shown.token !== expected.token || shown.pid !== expected.pid
      || shown.hwnd !== placed.hwnd || shown.phase !== 'shown' || shown.disabled !== true
      || shown.noActivate !== true || shown.visible !== true || shown.minimized !== false
      || shown.onCurrentDesktop !== false || shown.onTargetDesktop !== true
      || shown.targetDesktopId?.toLowerCase() !== expected.targetDesktopId.toLowerCase()) {
    throw new Error('Background release did not produce a verified disabled host');
  }
  validateBackgroundContinuity(baseline, validateFreshDesktopSnapshot(await inspect()), expected.pid, true);
  return shown;
}
