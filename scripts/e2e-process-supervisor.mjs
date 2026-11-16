import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_TMP_ROOT, registerExitCleanup } from './e2e-isolation.mjs';

export const PROCESS_SUPERVISOR_ENV = 'ZTERM_E2E_PROCESS_SUPERVISOR';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export function processExitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal) return 128 + (osConstants.signals[signal] ?? 1);
  return 1;
}

export function readOwnProcessStartMs(pid = process.pid, execFile = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid supervisor parent PID');
  const output = execFile('powershell.exe', ['-NoProfile', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`],
  { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const text = String(output).trim();
  if (!/^\d+$/.test(text)) throw new Error('Supervisor parent creation time is unavailable');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Supervisor parent creation time is invalid');
  return value;
}

export function compileProcessWatchdog({ tempRoot = E2E_TMP_ROOT, execFile = execFileSync } = {}) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = registerExitCleanup(mkdtempSync(join(tempRoot, 'zterm-watchdog-')));
  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = [join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync);
  if (!csc) throw new Error('Process watchdog compiler unavailable');
  const source = join(SCRIPT_DIR, 'e2e-process-watchdog.cs');
  const executable = join(directory, 'e2e-process-watchdog.exe');
  execFile(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + executable, source], {
    stdio: 'pipe', timeout: 60000, windowsHide: true, cwd: directory,
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
  });
  if (!existsSync(executable)) throw new Error('Process watchdog compilation produced no executable');
  return { directory, executable };
}

export function spawnSupervisedProcess({ script, args = [], env = process.env,
  onSpawn = () => {}, spawnProcess = spawn, execFile = execFileSync, tempRoot = E2E_TMP_ROOT }) {
  const { directory, executable } = compileProcessWatchdog({ tempRoot, execFile });
  const startedAt = readOwnProcessStartMs(process.pid, execFile);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ['--parent-pid', String(process.pid), '--parent-start-ms', String(startedAt),
      '--', process.execPath, script, ...args], {
      stdio: 'inherit', windowsHide: true, env: { ...env, [PROCESS_SUPERVISOR_ENV]: '1' },
    });
    onSpawn({ pid: child.pid, directory });
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* stale sandbox sweep owns locked residue */ }
      const result = { code: processExitCode(code, signal), signal, watchdogPid: child.pid, directory };
      if (spawnError) reject(spawnError);
      else resolve(result);
    });
  });
}

export async function runSupervisedScript({ script, args = [], main, preflight = async () => {},
  env = process.env, report = message => console.error(message), ...spawnOptions }) {
  try {
    if (env[PROCESS_SUPERVISOR_ENV] === '1') {
      const code = await main();
      return Number.isInteger(code) ? code : 0;
    }
    await preflight();
    const result = await spawnSupervisedProcess({ script, args, env, ...spawnOptions });
    if (result.signal) report(`[e2e] process supervisor exited on ${result.signal}; propagated as ${result.code}`);
    return result.code;
  } catch (error) {
    report(`E2E 失败: ${error?.stack || error?.message || String(error)}`);
    return 1;
  }
}
