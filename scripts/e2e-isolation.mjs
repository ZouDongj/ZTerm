import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// Live probes that keep the REAL APPDATA (herdr session discovery only works
// under %APPDATA%\herdr) would otherwise leak the user's configuration into
// the sandbox: on first launch migrate_legacy_config() copies the anchor
// config (%APPDATA%\ZTerm\config.json — sshProfiles with DPAPI credentials,
// lastTabs) into the empty sandbox data dir, and the frontend then
// auto-reconnects the user's SSH tabs from the sandboxed instance.
// Pre-seeding an empty config makes that migration a no-op (the target
// exists) while sanitize_config merges it over the built-in defaults, so
// the sandbox behaves like a stock first run. When the anchor redirects the
// data dir via `dataDir`, the sandbox would read/write that real directory —
// refuse to run instead. Only the key's presence is inspected; no config
// content is read beyond the pointer itself.
export function seedIsolatedConfig(sandbox, appData = process.env.APPDATA) {
  const anchor = join(appData || '', 'ZTerm', 'config.json');
  if (existsSync(anchor)) {
    let pointer = null;
    try {
      pointer = JSON.parse(readFileSync(anchor, 'utf8'))?.dataDir;
    } catch { /* unparseable anchor: treated as no pointer */ }
    if (typeof pointer === 'string' && pointer) {
      throw new Error('anchor config sets a custom dataDir; the sandbox would share that real directory — aborting');
    }
  }
  const dataDir = join(sandbox.directory, 'data');
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'config.json');
  if (!existsSync(target)) writeFileSync(target, '{}\n');
  return target;
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
