import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

// WebView2 browser processes can outlive their host on this machine (see the
// startApp comment in e2e-check.mjs): after the host dies they keep the CDP
// port bound and a relaunch then collides with EADDRINUSE. The sandbox path
// appears in their --user-data-folder argument, which is a strong ownership
// signal (fresh mkdtemp per run), so sweeping them is safe.
export function killSandboxBrowsers(sandboxDirectory) {
  if (!sandboxDirectory) return;
  try {
    const escaped = sandboxDirectory.replace(/'/g, "''");
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8' }).trim();
    if (!output) return;
    for (const line of output.split(/\r?\n/)) {
      const pid = Number.parseInt(line, 10);
      if (Number.isInteger(pid) && pid > 0) {
        try { execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      }
    }
  } catch { /* sweep is best-effort; the port-quiet poll remains the guard */ }
}

// Force-killed WebView2 browsers can survive their host with an unreadable
// command line (mid-teardown), so the sandbox-path sweep cannot see them.
// The suite asserts the debug port is free at startup, so any LISTENING
// process on it at cleanup time belongs to this run.
export function killPortHolder(port) {
  if (!Number.isInteger(port)) return;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`],
      { encoding: 'utf8' }).trim();
    if (!output) return;
    for (const line of output.split(/\r?\n/)) {
      const pid = Number.parseInt(line, 10);
      if (Number.isInteger(pid) && pid > 0) {
        try { execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      }
    }
  } catch { /* best-effort; the port-quiet poll remains the guard */ }
}

export async function restartOwnedApp({ stop, waitUntilQuiet, start }) {
  if (stop() !== true) throw new Error('Owned process cleanup failed; refusing restart');
  await waitUntilQuiet();
  return start();
}

// Startup sweep for the per-launch debug port range. Per-launch ports isolate
// launches WITHIN one run, but a stale listener from a PREVIOUS run can still
// squat on one (observed: launch 3's port was already served by an orphaned
// browser — /json answered yet never listed the renderer page). Kill holders
// whose image belongs to us (msedgewebview2/zterm); a foreign process or a
// dead-PID zombie socket cannot be killed, so that port is reported occupied
// and the caller shifts the base port instead. Returns still-occupied ports.
export function sweepDebugPortRange(base, count) {
  const occupied = [];
  const listenersOf = (port) => {
    // Get-NetTCPConnection exits 1 with EMPTY stdout when nothing listens
    // (its "no matching objects" error is suppressed but still sets the code)
    // — a free port and a hard query failure must stay distinguishable, so
    // read stdout off the thrown error before giving up.
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Get-Unique`],
        { encoding: 'utf8' }).trim();
    } catch (e) {
      if (e && e.stdout != null) return String(e.stdout).trim();
      return null; // powershell itself failed → treat as unknown/occupied
    }
  };
  for (let port = base; port < base + count; port++) {
    let pids = listenersOf(port);
    if (pids === null) { occupied.push(port); continue; }
    if (pids) {
      for (const line of pids.split(/\r?\n/)) {
        const pid = Number.parseInt(line, 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        let name = '';
        try {
          name = execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`],
            { encoding: 'utf8' }).trim();
        } catch { /* unknown → do not touch */ }
        if (/^(msedgewebview2|zterm)$/i.test(name)) {
          try { execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
        }
      }
      // Re-check after the sweep: a killed process can leave the socket bound
      // briefly, and foreign/dead-PID holders were deliberately not touched.
      pids = listenersOf(port);
      if (pids === null || pids) occupied.push(port);
    }
  }
  return occupied;
}
