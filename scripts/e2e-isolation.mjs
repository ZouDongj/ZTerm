import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function createE2eSandbox(sourceExe, tempRoot = tmpdir()) {
  const directory = mkdtempSync(join(tempRoot, 'zterm-e2e-'));
  const exe = join(directory, 'zterm.exe');
  const appData = join(directory, 'appdata');
  mkdirSync(appData);
  mkdirSync(join(directory, 'data'));
  copyFileSync(resolve(sourceExe), exe);
  return { directory, exe, appData };
}

export function ownsProcess(child, executable, actual) {
  return Boolean(child && Number.isInteger(child.pid) && child.pid > 0 &&
    child.exitCode === null && child.signalCode == null &&
    actual?.ProcessId === child.pid && typeof actual.ExecutablePath === 'string' &&
    resolve(actual.ExecutablePath).toLowerCase() === resolve(executable).toLowerCase());
}

export async function restartOwnedApp({ stop, waitUntilQuiet, start }) {
  if (stop() !== true) throw new Error('Owned process cleanup failed; refusing restart');
  await waitUntilQuiet();
  return start();
}
