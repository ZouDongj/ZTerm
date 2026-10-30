#!/usr/bin/env node
// ZTerm E2E checks: verify the packaged frontend's core interactions work.
//
// Background: once a hash is injected into the CSP script-src (Tauri does
// this automatically), the spec ignores 'unsafe-inline', so every inline
// onclick silently stops working (buttons hover fine, clicks do nothing, no
// error is reported). cargo test and syntax checks cannot catch this class
// of issue — only runtime verification can.
//
// Usage:
//   node scripts/e2e-check.mjs [exe-path] [port]
//     exe-path  path to the zterm.exe under test (default src-tauri/target/release/zterm.exe)
//     port      WebView2 remote debugging port (default 9222)
//
// Exit code: 0 when all checks pass, 1 on any failure.
// Dependencies: Node 22+ (global fetch / WebSocket); no third-party packages.

import { spawn, execFileSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createE2eSandbox, restartOwnedApp, killOwnedRuntime, probeDebugPortRange } from './e2e-isolation.mjs';
import { backgroundDesktopIndex, validateFreshDesktopSnapshot, observeDesktopStream, completeBackgroundHandshake,
  validateNativeHostHealth, renewNativeLease, createBackgroundLease, backgroundNow,
  stopBackgroundRun, readHostProcessDiagnostic } from './e2e-background-policy.mjs';
import { connectVerifiedEndpoint } from './e2e-ownership.mjs';
import { requireBackgroundCapability } from './e2e-background-capability.mjs';
import { writeBackgroundJson } from './e2e-background-json.mjs';
import { consentCancellationPassed, executionConsent, createSshFailureApproval, createUiSshFixture, createSshFailureEndpoint } from './e2e-execution-fixtures.mjs';
import { runWebglAtlasChecks } from './e2e-webgl-atlas.mjs';

const SOURCE_EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
let EXE = SOURCE_EXE;
const PORT = Number(process.argv[3] ?? 9222);
// Each launch gets its own debug port (and browser profile): a force-killed
// WebView2 can leave a zombie LISTEN socket whose owning PID no longer exists
// — nothing left to kill, only the kernel releases it — so reusing one port
// across restarts is a deterministic EADDRINUSE under load. Per-launch ports
// make restarts immune. This suite performs 6 launches (initial run plus 5
// restarts), so the whole plan BASE..BASE+5 must be free. BASE_PORT is
// resolved in main(): the launch range is probed READ-ONLY first (any holder
// — including the user's own ZTerm or WebView2 — is reported and left alone)
// and the base shifts by 10 while any planned port stays occupied or
// unqueryable; startApp revalidates its exact port again before spawning.
const LAUNCH_PLAN = 6;
let BASE_PORT = PORT;
let launchPort = PORT;
let sandbox = null;
let ownedChild = null;
let launchCount = 0;

// ── Virtual-desktop isolation ──
// The app owns placement of its permanently disabled HWND. The helper only
// observes desktop/foreground identity; missing proof never permits fallback.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_INDEX = backgroundDesktopIndex(process.env.ZTERM_E2E_DESKTOP ?? '2');
let vdHelperExe = null;
let backgroundRun = null;
let backgroundFailure = null;

// ── Launch the exe (with WebView2 remote debugging) ──
let DATA_CONFIG = null;
let configBackup = null;
// null = unknown (backup never ran or failed) — restoreConfig must NEVER
// delete the live config in that state. This guard exists because a silent
// backup failure used to leave configBackup null while the config was real,
// and the else-branch below then DELETED the user's data.
let configExistedAtStart = null;

function backupConfig() {
  // Tabs/SSH profiles created by the E2E run are persisted into
  // data/config.json by the frontend's 15s periodic save and would pollute
  // the next launch's tab restore — back up before launch, restore at the end.
  try {
    configExistedAtStart = existsSync(DATA_CONFIG);
    if (configExistedAtStart) {
      configBackup = DATA_CONFIG + '.e2e-bak';
      copyFileSync(DATA_CONFIG, configBackup);
      // A partial backup would resurrect corrupted state on restore —
      // verify the copy landed at the same size before trusting it.
      if (statSync(configBackup).size !== statSync(DATA_CONFIG).size) {
        throw new Error('partial backup copy');
      }
    }
  } catch (e) {
    console.error('[e2e] config backup failed — leaving data/config.json untouched:', e.message);
    configBackup = null;
    configExistedAtStart = null;
  }
}

function restoreConfig() {
  try {
    if (configBackup && existsSync(configBackup)) {
      copyFileSync(configBackup, DATA_CONFIG);
      rmSync(configBackup, { force: true });
    } else if (configExistedAtStart === false) {
      // Config genuinely absent at start: remove what the e2e app wrote.
      rmSync(DATA_CONFIG, { force: true });
    }
    // configExistedAtStart === null → unknown state: keep what is on disk.
  } catch (e) {
    console.error('[e2e] config restore failed:', e.message);
  }
  configBackup = null;
  configExistedAtStart = null;
}

// Binder for the exported killOwnedRuntime orchestration (the decision logic
// lives in e2e-isolation.mjs so it is testable against a mocked OS boundary).
// Only processes PROVEN to belong to this run are terminated; everything else
// stays alive and is reported. Returns exactly true when cleanup is
// established, or { ok: false, reasons } — restarts and the final gate treat
// that as a failure instead of silently assuming a clean state.
function killExisting() {
  stopBackgroundObserver();
  if (!sandbox && !ownedChild) return true;
  const child = ownedChild;
  const result = killOwnedRuntime({
    child,
    executable: EXE,
    sandboxDirectory: sandbox?.directory,
    launchPort,
    launched: launchCount > 0,
  });
  if (result === true) { ownedChild = null; return true; }
  // Keep the handle only while it still refers to something that may be ours
  // (mismatch/unknown/failed); dead/killed handles are released.
  if (result.hostDisposition === 'dead' || result.hostDisposition === 'killed') ownedChild = null;
  return result;
}
// Compile a read-only observer before any app launch. No foreground fallback.
function resolveVdHelper() {
  if (vdHelperExe) return vdHelperExe;
  const src = join(SCRIPT_DIR, 'e2e-vdesktop-move.cs');
  if (!existsSync(src)) throw new Error('Background observer source missing');
  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = [join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync);
  if (!csc) throw new Error('Background observer compiler unavailable');
  const out = join(sandbox.directory, 'e2e-desktop-observer.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + out, src],
    { stdio: 'pipe', timeout: 60000, windowsHide: true });
  if (!existsSync(out)) throw new Error('Background observer compilation produced no executable');
  vdHelperExe = out;
  return out;
}

async function inspectDesktop() {
  const output = await new Promise((resolveOutput, reject) => {
    execFile(resolveVdHelper(), ['inspect', String(DESKTOP_INDEX)],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      (error, stdout) => error ? reject(error) : resolveOutput(stdout));
  });
  return validateFreshDesktopSnapshot(JSON.parse(output.trim()));
}

function stopBackgroundObserver(reason = new Error('Owned background runtime stopped')) {
  const run = backgroundRun;
  if (!run) return;
  stopBackgroundRun(run, reason, error => console.error('[e2e] observer cleanup failed: ' + error.message));
  backgroundRun = null;
}

function failBackground(error) {
  if (backgroundFailure) return;
  backgroundFailure = error instanceof Error ? error : new Error(String(error));
  console.error('[e2e] background isolation failed: ' + (backgroundFailure.stack || backgroundFailure.message));
  // Withdraw the lease and reject pending CDP work before any blocking OS query.
  stopBackgroundObserver(backgroundFailure);
  try {
    const stopped = killExisting();
    if (stopped !== true) console.error('[e2e] owned cleanup incomplete: ' + stopped.reasons.join('; '));
  } catch (cleanupError) { console.error('[e2e] owned cleanup failed: ' + cleanupError.message); }
}

function nativeExpected(run) {
  return { ...run.binding, targetDesktopId: run.baseline.targetDesktopId, released: run.released };
}

function readNativeStatus(run) {
  return JSON.parse(readFileSync(run.statusPath, 'utf8'));
}

function assertBackgroundHealthy() {
  if (backgroundFailure) throw backgroundFailure;
  const run = backgroundRun;
  if (!run || run.stopping || !run.observation) {
    throw new Error('Fresh background observer proof is unavailable');
  }
  const desktop = run.observation.assertHealthy();
  if (run.binding) {
    if (!ownedChild || ownedChild.pid !== run.binding.pid || ownedChild.exitCode !== null || ownedChild.signalCode != null) {
      throw new Error('Owned background host exited');
    }
    validateNativeHostHealth(readNativeStatus(run), nativeExpected(run));
  }
  return desktop;
}

function renewBackgroundLease() {
  assertBackgroundHealthy();
  const run = backgroundRun;
  if (run.binding) renewNativeLease({
    readStatus: () => readNativeStatus(run), expected: nativeExpected(run),
    renew: () => writeBackgroundJson(run.leasePath, createBackgroundLease(run.binding), assertBackgroundHealthy),
  });
}

async function beginBackgroundObserver(baseline, token) {
  if (backgroundFailure) throw backgroundFailure;
  const helper = resolveVdHelper();
  const startedAt = backgroundNow();
  const observer = spawn(helper, ['watch', String(DESKTOP_INDEX), String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { baseline, token, observer, observation: null, stopping: false, released: false,
    leasePath: join(sandbox.directory, 'background-' + token + '.lease.json'),
    statusPath: join(sandbox.directory, 'background-' + token + '.status.json'),
    binding: null, timer: null, abortController: new AbortController() };
  backgroundRun = run;
  run.observation = observeDesktopStream({
    observer, baseline, startedAt, getOwnedPid: () => ownedChild?.pid,
    requireSameForeground: () => !run.released, onFailure: failBackground,
  });
  await run.observation.ready;
  assertBackgroundHealthy();
  run.timer = setInterval(() => {
    if (run.stopping) return;
    try { renewBackgroundLease(); } catch (error) { failBackground(error); }
  }, 250);
}

async function waitForBackgroundPhase(path, phase) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    assertBackgroundHealthy();
    if (!ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode != null) throw new Error('Background host exited before release');
    if (existsSync(path)) {
      const status = JSON.parse(readFileSync(path, 'utf8'));
      if (status.phase === 'failed') throw new Error(status.error || 'Background host refused isolation');
      if (status.phase === phase) return status;
    }
    await sleep(100);
  }
  throw new Error('Background host timed out waiting for ' + phase);
}

// Safety net for exit paths that skip the explicit killExisting() calls
// (unexpected early throw, unhandled rejection): never leave a PTY tree behind.
process.on('exit', () => killExisting());

function isolatedShellArgs(command, args = []) {
  const name = String(command || 'powershell.exe').replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) {
    return ['-NoProfile', ...args.filter(arg => !/^-noprofile$/i.test(arg))];
  }
  if (/^cmd(\.exe)?$/.test(name)) return ['/d', ...args.filter(arg => !/^\/d$/i.test(arg))];
  if (/^bash(\.exe)?$/.test(name)) {
    return ['--noprofile', '--norc', ...args.filter(arg => !['--noprofile', '--norc', '--login', '-l'].includes(arg))];
  }
  throw new Error(`E2E shell has no isolated startup policy: ${name}`);
}

function prepareIsolatedShellConfig() {
  const config = existsSync(DATA_CONFIG) ? JSON.parse(readFileSync(DATA_CONFIG, 'utf8')) : {};
  const protect = (owner, inheritedCommand) => {
    if (!owner || typeof owner !== 'object') return;
    const command = owner.command || inheritedCommand || 'powershell.exe';
    if (owner.splitRoot) { protect(owner.splitRoot, command); return; }
    if (Array.isArray(owner.children)) { owner.children.forEach(child => protect(child, command)); return; }
    if (owner.type === 'ssh' || owner.paneType === 'ssh') return;
    owner.args = isolatedShellArgs(command, owner.args || []);
  };
  if (!Array.isArray(config.lastTabs) || config.lastTabs.length === 0) {
    config.lastTabs = [{ name: 'PowerShell', type: 'local', command: 'powershell.exe', args: ['-NoProfile'] }];
  }
  config.lastTabs.forEach(tab => protect(tab));
  writeFileSync(DATA_CONFIG, JSON.stringify(config), 'utf8');
}

async function installIsolatedShellGuard(cdp) {
  await waitForValue(cdp, `typeof _ptyCreatePayload === 'function' && typeof _settingsConfig === 'object'`, true, 20000);
  await cdp.eval(`(() => {
    const isolateArgs = ${isolatedShellArgs.toString()};
    const original = _ptyCreatePayload;
    _ptyCreatePayload = function(shell, args, cwd, requestId) {
      return original(shell, isolateArgs(shell, args || []), cwd, requestId);
    };
  })()`);
}

async function startApp() {
  if (ownedChild) throw new Error('Previous owned process has not been released');
  await requireBackgroundCapability(EXE);
  // USERPROFILE must remain valid for WebView2. Isolate shell startup explicitly
  // instead of allowing restored shells to execute the operator's profiles.
  prepareIsolatedShellConfig();
  // Fresh, unique browser profile per launch: WebView2 browser processes on
  // this machine can outlive their host for a long while, and a relaunch
  // onto the same profile attaches to the half-dead browser — the debug
  // port then never opens (30s+ hangs). A never-used profile has no stale
  // browser to attach to.
  const udf = join(sandbox.directory, `webview-${++launchCount}`);
  launchPort = BASE_PORT + launchCount - 1;
  // Revalidate THIS launch's port read-only right before spawning: a foreign
  // process may have taken it since startup (holder replacement). Report and
  // abort — never kill the holder, never launch onto a taken port.
  const occupied = probeDebugPortRange(launchPort, 1);
  if (occupied.length > 0) {
    const o = occupied[0];
    const detail = o.unknown
      ? `${o.port}（监听查询失败）`
      : `${o.port}（${o.holders.map((h) => `${h.pid}:${h.name ?? '未知进程'}`).join('/')}，不会被终止）`;
    throw new Error(`调试端口 ${detail} 在启动前被占用；拒绝在非自有端口上启动`);
  }
  const baseline = await inspectDesktop();
  const token = randomUUID();
  const policyPath = join(sandbox.directory, 'background-' + token + '.json');
  const statusPath = join(sandbox.directory, 'background-' + token + '.status.json');
  const releasePath = join(sandbox.directory, 'background-' + token + '.release.json');
  writeBackgroundJson(policyPath, { token, targetDesktopId: baseline.targetDesktopId });
  await beginBackgroundObserver(baseline, token);
  assertBackgroundHealthy();
  const child = spawn(EXE, [], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      APPDATA: sandbox.appData,
      LOCALAPPDATA: sandbox.appData,
      ZTERM_E2E_BACKGROUND_POLICY: policyPath,
      // The anti-throttling flags keep rAF/rendering/timers running while the
      // window sits on a non-visible virtual desktop (occlusion would
      // otherwise throttle Chromium and break frame-sampling probes).
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${launchPort} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling${Number(process.env.ZTERM_E2E_FORCE_DPR) > 0 ? ` --force-device-scale-factor=${Number(process.env.ZTERM_E2E_FORCE_DPR)}` : ''}`,
      WEBVIEW2_USER_DATA_FOLDER: udf,
    },
  });
  ownedChild = child;
  child.on('error', error => { if (!child.pid) ownedChild = null; failBackground(error); });
  child.unref();
  try {
    await completeBackgroundHandshake({
      baseline, expected: { token, pid: child.pid, targetDesktopId: baseline.targetDesktopId },
      readPlacement: () => waitForBackgroundPhase(statusPath, 'placed'),
      inspect: inspectDesktop,
      release: async binding => {
        backgroundRun.binding = binding;
        renewBackgroundLease();
        writeBackgroundJson(releasePath, binding);
      },
      readShown: () => waitForBackgroundPhase(statusPath, 'shown'),
    });
    const final = assertBackgroundHealthy();
    backgroundRun.released = true;
    console.log('[e2e] background placement/release verified: ' + JSON.stringify({ pid: child.pid, baseline, final }));
  } catch (error) {
    failBackground(error);
    throw error;
  }
}

async function assertUnusedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
  });
}

async function waitForPage(timeoutMs = 30000) {
  assertBackgroundHealthy();
  const signal = backgroundRun.abortController.signal;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertBackgroundHealthy();
    try {
      const res = await fetch(`http://127.0.0.1:${launchPort}/json`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find((p) => p.type === 'page' && p.url.includes('renderer.html'));
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  // Diagnostics: process and debug-port state, to tell "exe never started"
  // apart from "WebView2 unavailable"
  let procInfo = '(不可用)';
  assertBackgroundHealthy();
  try { procInfo = await readHostProcessDiagnostic(execFile, signal); } catch {}
  let portInfo = '(不可用)';
  try { const r = await fetch(`http://127.0.0.1:${launchPort}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) }); portInfo = r.ok ? '调试端口已开放' : `HTTP ${r.status}`; } catch { portInfo = '调试端口未开放'; }
  // Target list: distinguishes "port served by a stale browser" (empty or
  // foreign targets) from "app alive but renderer stuck" (targets present,
  // renderer.html missing).
  let targetsInfo = '(不可用)';
  try {
    const r = await fetch(`http://127.0.0.1:${launchPort}/json`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
    const list = await r.json();
    targetsInfo = list.length ? list.map(t => `${t.type}:${String(t.url).slice(0, 90)}`).join(' | ') : '(空目标列表)';
  } catch { targetsInfo = '(目标列表获取失败)'; }
  throw new Error(`页面在 ${timeoutMs}ms 内未就绪。进程: ${procInfo}; ${portInfo}; 目标: ${targetsInfo}`);
}

async function connectOwnedPage() {
  const run = backgroundRun;
  const child = ownedChild;
  const port = launchPort;
  return connectVerifiedEndpoint({
    discover: () => waitForPage(), port, executable: EXE, sandboxDirectory: sandbox.directory,
    child, signal: run?.abortController.signal,
    isCurrent: () => backgroundRun === run && ownedChild === child && launchPort === port && !run?.stopping,
    assertHealthy: assertBackgroundHealthy,
    onDuration: result => console.log('[e2e] endpoint ownership verification: ' + JSON.stringify(result)),
  });
}

// ── Checks ──
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitForValue(cdp, expression, expected, timeoutMs = 8000, mode = 'eq') {
  // Poll until the expression reaches the expected value (async work such as
  // splitting takes time on slow machines; a fixed sleep would fail
  // spuriously). mode='gt0': wait for a number > 0 (monotonic counters such
  // as the SSH failure event — queued behind a restored tab's reconnect
  // backoff in the serial connection queue, it may only fire after 10+ s).
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expression).catch(() => null);
    const hit = mode === 'gt0' ? (typeof last === 'number' && last > 0) : last === expected;
    if (hit) return last;
    await sleep(300);
  }
  return last;
}

async function main() {
  if (!existsSync(SOURCE_EXE)) throw new Error(`exe 不存在: ${SOURCE_EXE}`);
  await requireBackgroundCapability(SOURCE_EXE);
  // The complete launch plan BASE..BASE+LAUNCH_PLAN-1 must be free. Discovery
  // is READ-ONLY: holders are never killed (an image name proves nothing —
  // the user may run their own ZTerm or WebView2 on these ports). Shift the
  // base by 10 while anything stays occupied or unqueryable (a stale port can
  // serve /json yet never list the renderer page), and fail with holder
  // diagnostics when the bounded range is exhausted.
  for (let shift = 0; ; shift += 10) {
    const occupied = probeDebugPortRange(PORT + shift, LAUNCH_PLAN);
    if (occupied.length === 0) { BASE_PORT = PORT + shift; launchPort = BASE_PORT; break; }
    if (shift >= 20) {
      const detail = occupied.map((o) => o.unknown
        ? `${o.port}（查询失败）`
        : `${o.port}（${o.holders.map((h) => `${h.pid}:${h.name ?? '未知进程'}`).join('/')}，不会被终止）`).join('、');
      throw new Error(`调试端口段均被占用（${detail}），无法启动 E2E`);
    }
  }
  await assertUnusedPort(BASE_PORT);
  sandbox = createE2eSandbox(SOURCE_EXE);
  EXE = sandbox.exe;
  DATA_CONFIG = join(sandbox.directory, 'data', 'config.json');
  console.log(`E2E source: ${SOURCE_EXE}\nIsolated runtime: ${sandbox.directory}\n`);

  killExisting();
  backupConfig();
  await startApp();
  // Identity gate BEFORE any attach/evaluate: /json discovery is harmless,
  // but a CDP session on a replaced/foreign endpoint could interfere with
  // someone else's instance (Runtime.evaluate vs real SSH sessions is a
  // recorded failure class). The gate binds the ownership proof to the
  // discovered endpoint's own loopback address/port. The later
  // get-data-dir-info check stays as an independent in-page guard, not the
  // ownership proof.
  const cdp = await connectOwnedPage();
  let sshFailureEndpoint = null;

  try {
    // Wait for the page to fully load (the CDP page is connectable as soon as
    // it appears, but the network stack may not be ready yet — an immediate
    // fetch of itself fails with "Failed to fetch", so wait for
    // readyState=complete before running checks). WebView2 reloads the page
    // once during startup: while readyState is complete on the old document,
    // renderer/*.js has not executed there and _settingsConfig is undefined —
    // use settings readiness (loadSettings has run) as the hard "scripts have
    // executed" signal so evals never land on the old document.
    await waitForValue(cdp, `document.readyState === 'complete' && typeof _settingsConfig === 'object' && !!TabManager`, true, 20000);
    const runtimeData = await cdp.eval(`ipcRenderer.invoke('get-data-dir-info')`);
    if (resolve(runtimeData.current).toLowerCase() !== resolve(dirname(DATA_CONFIG)).toLowerCase()) {
      throw new Error('Connected runtime is not using the isolated E2E configuration');
    }
    // All new local PTYs still use the real product payload builder; only shell
    // startup flags are restricted by this test fixture. Existing restored
    // sessions were protected on disk before launch by startApp().
    await installIsolatedShellGuard(cdp);

    // 0.5 Native WebView2 UI policy: the browser UI integrations must be
    // disabled AS READ BACK through the settings getters (the probe command
    // exists only under the owned background E2E runtime; production
    // invocations are refused). Layers of proof, each staying in its lane:
    // THIS check proves the WebView2 settings layer via the getters; the
    // defaultPrevented assertions in the menu sections prove the DOM-level
    // cancellation. No claim is made here about the native popup's visual
    // appearance — capturing that is not possible without showing it.
    const nativePolicy = await cdp.eval(`ipcRenderer.invoke('browser-ui-policy')`)
      .catch(e => ({ error: String(e && e.message || e) }));
    check('原生 WebView2：默认右键菜单/浏览器加速键/密码自动保存/自动填充/缩放/链接悬停状态栏均已禁用（读回验证）',
      !nativePolicy.error && nativePolicy.readBackComplete === true &&
      nativePolicy.defaultContextMenusDisabled === true &&
      nativePolicy.browserAcceleratorKeysDisabled === true &&
      nativePolicy.passwordAutosaveDisabled === true &&
      nativePolicy.generalAutofillDisabled === true &&
      nativePolicy.zoomControlDisabled === true &&
      nativePolicy.statusBarDisabled === true,
      JSON.stringify(nativePolicy));

    // 0. Startup splash: correct structure (icon + green-dot animation only)
    // plus auto fade-out after the first frame (wait at most 5s); force-hide
    // as a fallback so it cannot block later checks
    const splashExists = await cdp.eval(`!!document.getElementById('startup-splash')`);
    const splashStruct = await cdp.eval(`(() => {
      const s = document.getElementById('startup-splash');
      if (!s) return { missing: true };
      return {
        cells: s.querySelectorAll('.cell').length,
        loading: s.querySelectorAll('.cell.loading').length,
        leaving: s.classList.contains('leaving'),
        hasName: !!s.querySelector('.startup-name'),
        hasHint: !!s.querySelector('.startup-hint'),
        hasLogo: !!s.querySelector('svg.startup-logo')
      };
    })()`);
    // Verify static structure only (the running animation has its own poll
    // check; startSplashLoader starts inside async Init and may run later
    // than this check)
    const structOk = splashStruct.missing === true || (splashStruct.cells === 13 &&
      !splashStruct.hasName && !splashStruct.hasHint && splashStruct.hasLogo);
    check('启动界面结构：仅图标 + 13 格 Z', structOk === true, JSON.stringify(splashStruct));
    // Animation check: while the splash exists, poll for the green dots to
    // appear (startSplashLoader starts inside async Init, possibly after the
    // structure check); a splash already removed also counts as passing
    let animOk = true;
    if (!splashStruct.missing) {
      animOk = false;
      for (let i = 0; i < 12; i++) {
        if (await cdp.eval(`!document.getElementById('startup-splash')`)) { animOk = true; break; }
        if ((await cdp.eval(`document.querySelectorAll('#splash-cells .cell.loading').length`)) > 0) { animOk = true; break; }
        await sleep(200);
      }
    }
    check('绿点动画运行（或已随 splash 移除）', animOk === true, `splash存在=${!splashStruct.missing}`);

    // xterm POC smoke check: the selected engine may not have a terminal yet at this
    // early point (the initial tab is wired asynchronously). Verify the shared
    // module plus any already-created overlay; renderer-specific creation is checked
    // after the Ghostty switch below.
    const cursorPoc = await cdp.eval(`(() => {
      const engine = _settingsConfig.terminalRenderer || 'xterm';
      const overlays = [...document.querySelectorAll('.smooth-cursor-overlay')];
      return {
        engine,
        count: overlays.length,
        pointerEvents: overlays[0]?.style.pointerEvents || null,
        tagName: overlays[0]?.tagName || null,
        hasMotion: typeof window.SmoothCursorMotion === 'function'
      };
    })()`);
    const cursorPocOk = cursorPoc.hasMotion &&
      (cursorPoc.count === 0 || (cursorPoc.tagName === 'CANVAS' && cursorPoc.pointerEvents === 'none'));
    check('平滑光标 POC 模块与隔离规则正确', cursorPocOk, JSON.stringify(cursorPoc));
    let splashGone = false;
    for (let i = 0; i < 25; i++) {
      splashGone = await cdp.eval(`!document.getElementById('startup-splash')`);
      if (splashGone) break;
      await sleep(200);
    }
    if (!splashGone) await cdp.eval(`hideStartupSplash()`);
    check('启动界面首帧渲染后自动淡出', splashGone === true, `splash存在=${splashExists}, 自动移除=${splashGone}`);

    await waitForValue(cdp, `(() => { const tab = TabManager.getActive(); return !!tab && (tab.term || getAllPanes(tab).some(p => p.term)); })()`, true, 20000);
    await runWebglAtlasChecks(cdp, check, {
      defaultAtlasCap: process.env.ZTERM_E2E_WEBGL_DEFAULT_CAP === '1',
      deviceScaleFactor: Number(process.env.ZTERM_E2E_WEBGL_DPR) || 0,
    });
    if (process.env.ZTERM_E2E_WEBGL_ONLY === '1') {
      const failed = results.filter(r => !r.pass);
      console.log(`WebGL-only: ${results.length - failed.length}/${results.length} checks passed`);
      if (failed.length) throw new Error('WebGL-only checks failed: ' + failed.map(r => r.name).join(', '));
      return;
    }

    // 1. CSP: 'unsafe-inline' must actually be in effect (not pushed out by a
    // Tauri-injected hash). Fetching the page itself can fail sporadically
    // right after readiness — retry a few times
    let csp = null;
    for (let i = 0; i < 5 && csp === null; i++) {
      try { csp = await cdp.eval(`fetch(location.href, {cache:'no-store'}).then(r => r.headers.get('content-security-policy'))`); }
      catch { await sleep(500); }
    }
    const hasUnsafeInline = /script-src[^;]*'unsafe-inline'/.test(csp ?? '');
    const hasHash = /script-src[^;]*'sha256-/.test(csp ?? '');
    check('CSP script-src 含生效的 unsafe-inline', hasUnsafeInline && !hasHash, (csp ?? '').slice(0, 80) + '...');

    // 2. inline onclick compiled (these would be undefined/null when the CSP blocks them)
    for (const id of ['win-minimize', 'win-maximize', 'win-close']) {
      const t = await cdp.eval(`typeof document.getElementById('${id}').onclick`);
      check(`按钮 #${id} onclick 已编译`, t === 'function', `typeof=${t}`);
    }
    const menuOnclick = await cdp.eval(`typeof document.querySelector('.menu-item').onclick`);
    check('菜单项 onclick 已编译', menuOnclick === 'function', `typeof=${menuOnclick}`);

    // 3. Core interaction functions available (top-level global function chain intact)
    const fns = await cdp.eval(`['openPalette','openSettings','openSFTPFromMenu','TabManager'].map(n => n + '=' + typeof (n==='TabManager' ? TabManager : eval(n))).join(', ')`);
    check('核心交互函数存在', fns.includes('openPalette=function') && fns.includes('openSettings=function') && fns.includes('TabManager=object'), fns);

    // 4. Minimize button: synthetic click → window actually minimizes
    await cdp.eval(`document.getElementById('win-minimize').click()`);
    // Poll instead of a fixed sleep: on a loaded machine the minimize
    // transition outlasts 1.5s and a single query fails spuriously.
    const minimized = await waitForValue(cdp, `window.__TAURI__.window.getCurrentWindow().isMinimized().then(r => r)`, true, 8000);
    check('点击最小化后窗口最小化', minimized === true, `isMinimized=${minimized}`);

    // Exercise the real product action on the persistently disabled host.
    // Browser.setWindowBounds can target another native HWND and is forbidden.
    await cdp.eval(`document.getElementById('win-maximize').click()`);
    await sleep(1500);
    await sleep(1000);

    // 5. The product maximize action must restore and maximize the minimized host.
    const maximizedNow = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    check('点击最大化后窗口最大化', maximizedNow === true, `isMaximized=${maximizedNow}`);
    await cdp.eval(`document.getElementById('win-maximize').click()`);
    await sleep(1500);
    const isRestored = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    check('再次点击后还原', isRestored === false, `isMaximized=${isRestored}`);

    // 6. Menu item click: command palette overlay opens
    await cdp.eval(`document.querySelector('.menu-item[onclick*="openPalette"]')?.click()`);
    await sleep(800);
    const paletteOpen = await cdp.eval(`document.getElementById('overlay-palette').classList.contains('open')`);
    check('菜单点击打开命令面板', paletteOpen === true, `overlay-palette.open=${paletteOpen}`);
    await cdp.eval(`closePalette()`);
    await sleep(300);

    // 7. IPC path: window commands genuinely reachable (verified via callback, not just the click)
    const ipcOk = await cdp.eval(`window.__TAURI__.core.invoke('window_maximize').then(() => 'ok').catch(e => 'err: ' + e)`);
    check('IPC invoke window_maximize 可达', ipcOk === 'ok', String(ipcOk));
    await cdp.eval(`document.getElementById('win-maximize').click()`); // restore
    await sleep(1000);

    // 8. Tabs: add a new tab
    const tabCountBefore = await cdp.eval(`document.querySelectorAll('#tabbar .tab').length`);
    await cdp.eval(`document.getElementById('btn-add-tab').click()`);
    await sleep(2000);
    const tabCountAfter = await cdp.eval(`document.querySelectorAll('#tabbar .tab').length`);
    check('点击 + 新增标签页', tabCountAfter === tabCountBefore + 1, `${tabCountBefore} -> ${tabCountAfter}`);
    // 8.5 Wrap-layer integrity: SSH retries used to leave the previous wrap
    //     mounted (duplicate id) while the retry-created wrap kept 'active'
    //     forever — a full-viewport layer covering every tab. Wrap ids must
    //     stay unique and exactly one wrap may be active, owned by the active
    //     tab. Poll for the new tab's wrap first (slow ConPTY spawn would
    //     otherwise make this flake with zero active wraps).
    const newWrapCount = await waitForValue(cdp, `document.querySelectorAll('.term-wrap').length`, tabCountAfter, 8000);
    check('+ 新增 tab 后 wrap 已挂载', newWrapCount === tabCountAfter, `wraps=${newWrapCount}, tabs=${tabCountAfter}`);
    const wrapAudit = await cdp.eval(`(() => {
      const wraps = [...document.querySelectorAll('.term-wrap')];
      const ids = wraps.map(w => w.id);
      const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
      const activeWraps = wraps.filter(w => w.classList.contains('active'));
      return { total: wraps.length, dup, activeIds: activeWraps.map(w => w.id), expect: 'wrap_' + TabManager.activeId };
    })()`);
    check('wrap 层无重复 id', wrapAudit.dup.length === 0, JSON.stringify(wrapAudit));
    check('active wrap 唯一且属于当前 tab', wrapAudit.activeIds.length === 1 && wrapAudit.activeIds[0] === wrapAudit.expect, JSON.stringify(wrapAudit));
    // 8.6 The '+' button must be an SVG icon (a text '+' rendered oddly under
    //     some font fallbacks)
    const addBtnSvg = await cdp.eval(`!!document.querySelector('#btn-add-tab svg')`);
    check('新建标签按钮为 SVG 图标', addBtnSvg === true, `svg=${addBtnSvg}`);

    // 9. Split: horizontal split → 2 panes; then vertical split → 3 panes
    // (poll, so a not-yet-attached pty cannot fail spuriously)
    await cdp.eval(`TabManager.splitHorizontal()`);
    const panesAfterH = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 2);
    check('水平分割产生 2 个 pane', panesAfterH === 2, `panes=${panesAfterH}`);
    await cdp.eval(`TabManager.splitVertical()`);
    const panesAfterV = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 3);
    check('垂直分割产生 3 个 pane', panesAfterV === 3, `panes=${panesAfterV}`);

    // 9.5 Local PTY data path end to end: pty-input → ConPTY echo → 4ms
    //     flusher → pty-output → xterm buffer. When the Rust flusher regresses
    //     (no emit / deadlock) the echo is lost and this check stalls — it is
    //     the only automated failure signal for local-tab content. Injection
    //     uses pty-input rather than synthetic KeyboardEvents: xterm 5 drops
    //     most synthetic keydown characters (measured: after the echo only a
    //     few characters produce onData); the keyboard→onData half belongs to
    //     xterm's own code and is covered separately by the Ghostty input-path
    //     check.
    const MARKER = 'ZTERM-E2E-42';
    const diagnosticArm = await cdp.eval(`(async () => {
      const pane = getAllPanes(TabManager.getActive())[0];
      if (!pane?.tabId || !window.ZTermDiagnostics) return { enabled: false };
      ZTermDiagnostics.start({ durationMs: 10000, maxRecords: 1024 });
      return await ZTermDiagnostics.native('arm', { tabId: pane.tabId, durationMs: 10000, capacity: 1024 });
    })()`);
    check('诊断原生接口可显式启用', diagnosticArm.enabled === true, `enabled=${diagnosticArm.enabled}`);
    const chainProbe = await cdp.eval(`(() => {
      const tab = TabManager.getActive();
      const pane = getAllPanes(tab)[0];
      if (!pane?.term) return { ok: false, why: 'no-term' };
      ipcRenderer.send('pty-input', { tabId: pane.tabId, data: 'echo ${MARKER}\\r' });
      return { ok: true, hasAdapter: !!pane._smoothCursor?._adapter, engine: _settingsConfig.terminalRenderer || 'xterm' };
    })()`).catch(() => ({ ok: false, why: 'eval-fail' }));
    let markerFound = false;
    for (let i = 0; i < 15; i++) {
      const buf = await cdp.eval(`(() => {
        const tab = TabManager.getActive();
        const pane = getAllPanes(tab)[0];
        const b = pane.term?.buffer?.active;
        if (!b) return '';
        let s = '';
        for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString(true) || '') + '\\n';
        return s;
      })()`).catch(() => '');
      if (buf.includes(MARKER)) { markerFound = true; break; }
      await sleep(400);
    }
    check('本地 PTY 全链路：按键回显进入 buffer（flusher+IPC）', markerFound === true, markerFound ? 'echoed' : (chainProbe.why || 'marker-not-found'));
    const diagnosticResult = await cdp.eval(`(async () => {
      const native = await ZTermDiagnostics.native('stop');
      ZTermDiagnostics.stop();
      const frontend = ZTermDiagnostics.snapshot();
      const serialized = JSON.stringify({ frontend, native });
      return {
        nativeKinds: native.events.map(e => e.kind),
        frontendKinds: frontend.records.map(e => e.type),
        hasTerminalContent: serialized.includes('${MARKER}'),
        frontendStopped: !frontend.enabled, nativeStopped: !native.enabled,
      };
    })()`);
    check('本地诊断记录实际读写边界', ['input-invoke', 'write-begin', 'write-end', 'raw-read', 'output-emit'].every(k => diagnosticResult.nativeKinds.includes(k)), JSON.stringify(diagnosticResult.nativeKinds));
    check('前端诊断记录实际接收与解析', ['input-send', 'receive', 'parsed'].every(k => diagnosticResult.frontendKinds.includes(k)), JSON.stringify(diagnosticResult.frontendKinds));
    check('普通诊断不包含终端正文且可停止', !diagnosticResult.hasTerminalContent && diagnosticResult.frontendStopped && diagnosticResult.nativeStopped);
    // Real mount assertion for the smooth-cursor adapter: a failed bind only
    // console.warns, and the old check (overlay DOM count === 0) is always
    // true for the adapter — it cannot tell "animation running" apart from
    // "silently fell back to the native cursor".
    check('WebGL 平滑光标 adapter 已挂载', chainProbe.ok === true && chainProbe.hasAdapter === true, JSON.stringify(chainProbe));

    // Moon-phase / plane-1 emoji width: the zterm6 provider must be active and
    // count plane-1 emoji as 2 cells (kimi's tip line lays U+1F311 out as
    // 2 cells; the vendored UnicodeV6 counts it as 1, so the 2-cell glyph
    // overflows into a neighbor cell that is never erased and old characters
    // bleed into the moon glyph). term.write goes through the same
    // InputHandler->charProperties path, pinning the buffer layout.
    const moonProbe = await cdp.eval(`(async () => {
      const pane = getAllPanes(TabManager.getActive())[0];
      const term = pane?.term;
      if (!term) return { ok: false, why: 'no-term' };
      const write = s => new Promise(r => term.write(s, r));
      await write('\\r\\n');
      const b = term.buffer.active;
      // getLine() takes an absolute buffer index; cursorY is viewport-relative.
      const row = b.baseY + b.cursorY;
      await write('\\uD83C\\uDF11ab');
      const line = b.getLine(row);
      return { ok: true, active: term.unicode?.activeVersion,
        w0: line?.getCell(0)?.getWidth(), w1: line?.getCell(1)?.getWidth(),
        c2: line?.getCell(2)?.getChars(), cx: b.cursorX };
    })()`);
    check('月相 emoji 宽度=2（zterm6 provider 已激活）',
      moonProbe.active === 'zterm6' && moonProbe.w0 === 2 && moonProbe.w1 === 0 && moonProbe.c2 === 'a' && moonProbe.cx === 4,
      JSON.stringify(moonProbe));

    // IME anchor: while the protocol cursor is visible the textarea follows it
    // natively; while hidden with no software cursor, fall back to native
    // protocol anchoring (during input the protocol cursor tracks the
    // insertion point exactly — freezing the anchor would pin it to the
    // textarea's default DOM position or a just-overwritten stale caret cell,
    // stranding the candidate window top-left or letting pinyin overwrite
    // committed text); while hidden with a software cursor (the app-drawn
    // caret the user actually sees) whose position is known, the anchor must
    // land on the software cursor cell — kimi never shows the protocol cursor
    // for a whole session, so the no-caret native fallback is the worst-case
    // baseline. The check also pins the patch's internal anchors
    // (_core/_syncTextArea/isCursorHidden) as present.
    const imeProbe = await cdp.eval(`(async () => {
      const pane = getAllPanes(TabManager.getActive())[0];
      const term = pane?.term;
      if (!term?.textarea) return { ok: false, why: 'no-term' };
      term.textarea.focus();
      const write = s => new Promise(r => term.write(s, r));
      const pos = () => ({ left: term.textarea.style.left, top: term.textarea.style.top });
      const core = term._core;
      const cell = core?._renderService?.dimensions?.css?.cell;
      const px = (x, y) => cell ? { left: (x * cell.width) + 'px', top: (y * cell.height) + 'px' } : null;
      await write('\\u001b[?25h\\u001b[10;10H');
      const p1 = pos();
      await write('\\u001b[?25l\\u001b[20;40H');
      const p2 = pos();
      await write('\\u001b[?25h\\u001b[12;12H');
      const p3 = pos();
      // Software-cursor branch: temporarily swap the provider for a fixed cell
      // (simulating an adapter that has taken over), hide-CUP elsewhere — the
      // textarea must anchor at the software cursor cell, not the protocol park position.
      const prevProvider = core?.__imeAnchorPerceivedCaret;
      let p4 = null;
      if (core && cell) {
        core.__imeAnchorPerceivedCaret = () => ({ x: 15, y: 5, width: 1 });
        await write('\\u001b[?25l\\u001b[22;30H');
        p4 = pos();
        core.__imeAnchorPerceivedCaret = prevProvider;
        await write('\\u001b[?25h');
      }
      return { ok: true, p1, p2, p3, p4,
        e1: px(9, 9), e2: px(39, 19), e3: px(11, 11), e4: px(15, 5),
        hiddenKnown: typeof core?.coreService?.isCursorHidden === 'boolean' };
    })()`);
    // Numeric compare with an epsilon: at fractional devicePixelRatio (e.g. a
    // 175% monitor) the expected cell math is a long float while the browser
    // serializes style.top to a few decimals — string equality only holds at
    // integer CSS px (DPR 1.0). 0.01px covers serialization noise and is far
    // below one cell.
    const nearPx = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) <= 0.01;
    check('IME 锚点：可见跟随、隐藏无软件光标回退协议锚定、有软件光标位优先',
      imeProbe.hiddenKnown === true
        && nearPx(imeProbe.p1.left, imeProbe.e1.left) && nearPx(imeProbe.p1.top, imeProbe.e1.top)
        && nearPx(imeProbe.p2.left, imeProbe.e2.left) && nearPx(imeProbe.p2.top, imeProbe.e2.top)
        && nearPx(imeProbe.p3.left, imeProbe.e3.left) && nearPx(imeProbe.p3.top, imeProbe.e3.top)
        && imeProbe.p4 !== null && nearPx(imeProbe.p4.left, imeProbe.e4.left) && nearPx(imeProbe.p4.top, imeProbe.e4.top),
      JSON.stringify(imeProbe));

    // 9.8 Terminal search (batch 03): synthetic local content + the REAL
    //     bundled xterm/addon-search through the REAL renderer handlers.
    //     The addon only fires result events when find options carry a
    //     `decorations` object, so the #search-count text is the end-to-end
    //     signal for both the option plumbing and the active-terminal
    //     ownership gating (background refresh must not overwrite it).
    const searchProbeSetup = await cdp.eval(`(async () => {
      const tab = TabManager.getActive();
      const panes = getAllPanes(tab);
      const targets = (panes.length ? panes : [tab]).filter(p => p?.term);
      if (!targets.length) return { ok: false, why: 'no-terms' };
      const write = (t, s) => new Promise(r => t.write(s, r));
      await write(targets[0].term, '\\r\\nZTERM-SRC-A alpha needle one\\r\\nplain filler\\r\\nZTERM-SRC-A alpha needle two\\r\\nplain filler\\r\\nZTERM-SRC-A alpha needle three\\r\\n');
      // Pane[1] keeps its own distinct marker lines AND carries exactly ONE
      // match for the shared A-query, so the pane-switch step below expects
      // a real 1/1 count from the SAME query (seed/query consistency).
      if (targets[1]) await write(targets[1].term, '\\r\\nZTERM-SRC-B bravo filler\\r\\nZTERM-SRC-A alpha needle shared\\r\\n');
      return { ok: true, terms: targets.length };
    })()`);
    check('搜索用例：合成内容写入活动 tab 的终端', searchProbeSetup.ok === true, JSON.stringify(searchProbeSetup));
    if (searchProbeSetup.ok) {
      const activePanes = await cdp.eval(`getAllPanes(TabManager.getActive()).filter(p => p?.term).map(p => p.id)`);
      // Start focused on pane[0] so the search owner is deterministic.
      if (activePanes.length > 1) await cdp.eval(`TabManager._focusPane(TabManager.getActive(), ${JSON.stringify(activePanes[0])})`);
      await cdp.eval(`openSearch()`);
      await sleep(200);
      await cdp.eval(`document.getElementById('search-input').value = 'ZTERM-SRC-A alpha needle'; doSearch();`);
      const countFirst = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '1/3');
      check('搜索计数：首个匹配显示 1/3', countFirst === '1/3', `count=${countFirst}`);
      await cdp.eval(`searchNext()`);
      const countNext = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '2/3');
      await cdp.eval(`searchNext()`);
      const countLast = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '3/3');
      await cdp.eval(`searchNext()`);
      const countWrap = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '1/3');
      await cdp.eval(`searchPrev()`);
      const countWrapPrev = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '3/3');
      check('搜索导航：next 推进、越界回绕、prev 反向回绕',
        countNext === '2/3' && countLast === '3/3' && countWrap === '1/3' && countWrapPrev === '3/3',
        `next=${countNext}, last=${countLast}, wrap=${countWrap}, wrapPrev=${countWrapPrev}`);
      const decorWithQuery = await waitForValue(cdp, `document.querySelectorAll('.xterm-find-result-decoration').length`, 1, 5000, 'gt0');
      check('搜索高亮：decorations 真实渲染', decorWithQuery > 0, `decorations=${decorWithQuery}`);
      // Query replacement: no-match blanks the counter and clears the selection.
      await cdp.eval(`document.getElementById('search-input').value = 'ZTERM-SRC-NOMATCH'; doSearch();`);
      const countNoMatch = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '');
      const selCleared = await waitForValue(cdp, `(() => {
        const active = TabManager.getActive();
        const term = (getAllPanes(active).find(p => p.focused) || active).term;
        return term && term.hasSelection() === false ? 1 : 0;
      })()`, 1);
      check('查询替换：无匹配清空计数与选区', countNoMatch === '' && selCleared === 1, `count='${countNoMatch}', selCleared=${selCleared === 1}`);
      // Empty query: stale counter must not survive.
      await cdp.eval(`document.getElementById('search-input').value = 'ZTERM-SRC-A alpha needle'; doSearch();`);
      await waitForValue(cdp, `document.getElementById('search-count').textContent`, '1/3');
      await cdp.eval(`document.getElementById('search-input').value = ''; doSearch();`);
      const countEmpty = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '');
      check('空查询：计数与残留状态清除', countEmpty === '', `count='${countEmpty}'`);
      // Switch the focused pane (if the split gave us a second terminal): the
      // count must follow the newly active terminal for the same query.
      if (activePanes.length > 1) {
        await cdp.eval(`document.getElementById('search-input').value = 'ZTERM-SRC-A alpha needle'; doSearch();`);
        await waitForValue(cdp, `document.getElementById('search-count').textContent`, '1/3');
        await cdp.eval(`TabManager._focusPane(TabManager.getActive(), ${JSON.stringify(activePanes[1])})`);
        const countSwitched = await waitForValue(cdp, `document.getElementById('search-count').textContent`, '1/1');
        check('切换聚焦 pane：计数跟随新活动终端', countSwitched === '1/1', `count=${countSwitched}`);
        // Background output on pane[0] must not overwrite pane[1]'s count.
        await cdp.eval(`(() => {
          const tab = TabManager.getActive();
          const p0 = getAllPanes(tab).find(p => p.id === ${JSON.stringify(activePanes[0])});
          if (p0?.term) p0.term.write('ZTERM-SRC-A alpha needle background\\r\\n');
          return true;
        })()`);
        await sleep(1200); // addon background refresh is 200ms + render
        const countAfterBg = await cdp.eval(`document.getElementById('search-count').textContent`);
        check('后台终端输出不得改写活动终端计数', countAfterBg === '1/1', `count=${countAfterBg}`);
      }
      // Close + reopen: blank state, and a background refresh cannot resurrect
      // the closed bar's counter.
      await cdp.eval(`closeSearch()`);
      await sleep(200);
      const closedState = await cdp.eval(`(() => ({
        open: document.getElementById('search-bar').classList.contains('open'),
        count: document.getElementById('search-count').textContent,
      }))()`);
      await cdp.eval(`(() => {
        const tab = TabManager.getActive();
        const term = (getAllPanes(tab).find(p => p.focused) || tab).term;
        if (term) term.write('ZTERM-SRC-A alpha needle after-close\\r\\n');
        return true;
      })()`);
      await sleep(1200);
      const resurrect = await cdp.eval(`document.getElementById('search-count').textContent`);
      check('关闭搜索：计数清空且不被后台刷新复活',
        closedState.open === false && closedState.count === '' && resurrect === '',
        `open=${closedState.open}, count='${closedState.count}', afterBg='${resurrect}'`);
      await cdp.eval(`openSearch()`);
      await sleep(200);
      const reopened = await cdp.eval(`(() => ({
        open: document.getElementById('search-bar').classList.contains('open'),
        input: document.getElementById('search-input').value,
        count: document.getElementById('search-count').textContent,
      }))()`);
      check('重开搜索：输入与计数重置', reopened.open === true && reopened.input === '' && reopened.count === '', JSON.stringify(reopened));
      await cdp.eval(`closeSearch()`);
      await sleep(150);
    }

    // 10. Settings page: open → a settings tab appears; switch pages
    await cdp.eval(`openSettings()`);
    await sleep(1000);
    const settingsOpen = await cdp.eval(`TabManager.tabs.some(t => t.type === 'settings')`);
    check('打开设置页', settingsOpen === true, `settings tab=${settingsOpen}`);
    await cdp.eval(`document.querySelector('.settings-sidebar-item[onclick*="appearance"]').click()`);
    await sleep(800);
    const appearanceActive = await cdp.eval(`document.querySelector('.settings-sidebar-item.active')?.getAttribute('onclick')?.includes('appearance')`);
    check('设置页切换到外观', appearanceActive === true, String(appearanceActive));
    await cdp.eval(`closeSettingsTab()`);
    await sleep(800);

    // 10b. The machine-registered standard Git Bash must offer an explicit
    // remembered grant even when its install root is outside ProgramFiles.
    // No consent is approved through the product UI here, and no shell starts.
    const gitStarted = await cdp.eval(`(async () => {
      const shells = await ipcRenderer.invoke('get-local-shells');
      const git = shells.find(s => s.id === 'gitbash');
      if (!git) return { found: false };
      const owner = 'local:e2e-standard-git-classify';
      const classification = await ipcRenderer.invoke('prepare-execution', {
        kind: 'local', owner, payload: { shell: git.command, args: git.args },
      });
      await ipcRenderer.invoke('cancel-execution', { owner });
      if (classification.ticket) return { found: true, safe: true };
      const tab = TabManager.tabs.find(t => t.type === 'local' && !t.splitRoot && !TabManager._closingTabs.has(t.id));
      if (!tab) return { found: false, reason: 'no single local terminal owner' };
      TabManager.switchTo(tab.id);
      window.__e2eGitLaunches = 0;
      window.__e2eGitStart = ZTermExecutionTrust.startLocal(
        { requestId: tab.id, shell: git.command, args: git.args },
        () => { window.__e2eGitLaunches += 1; });
      return { found: true, safe: false };
    })()`);
    if (gitStarted?.found !== true) throw new Error('Machine Git Bash discovery is unavailable');
    if (!gitStarted.safe) {
      const gitDialogReady = await waitForValue(cdp,
        `document.getElementById('overlay-confirm').classList.contains('open') && document.getElementById('confirm-msg').textContent.includes('bash.exe')`, true, 15000);
      const gitReview = await cdp.eval(`(() => {
        const ok = document.getElementById('confirm-ok'), cancel = document.getElementById('confirm-cancel');
        const a = getComputedStyle(ok), b = getComputedStyle(cancel);
        return {
          primary: ok.classList.contains('btn-primary'), outline: cancel.classList.contains('btn-outline'),
          rememberPresent: !!document.querySelector('.execution-remember'),
          sameHeight: a.height === b.height && a.height === '30px',
          sameRadius: a.borderRadius === b.borderRadius && a.borderRadius === '8px',
          sameFont: a.fontFamily === b.fontFamily && a.fontSize === b.fontSize,
          safeFocus: document.activeElement === cancel,
        };
      })()`);
      check('标准 Git Bash：明确提供可记住的本账户授权', gitDialogReady === true && gitReview.rememberPresent === true, JSON.stringify(gitReview));
      check('授权弹窗：按钮风格尺寸一致且默认焦点为取消', gitReview.primary === true && gitReview.outline === true && gitReview.sameHeight === true && gitReview.sameRadius === true && gitReview.sameFont === true && gitReview.safeFocus === true, JSON.stringify(gitReview));
      if (process.env.ZTERM_E2E_SHOTS) {
        mkdirSync(process.env.ZTERM_E2E_SHOTS, { recursive: true });
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (shot?.data) writeFileSync(join(process.env.ZTERM_E2E_SHOTS, 'execution-standard-git.png'), Buffer.from(shot.data, 'base64'));
      }
      const gitCancelled = await cdp.eval(`(async () => {
        document.getElementById('confirm-cancel').click();
        await window.__e2eGitStart;
        return { launches: window.__e2eGitLaunches, open: document.getElementById('overlay-confirm').classList.contains('open') };
      })()`);
      if (gitCancelled.launches !== 0 || gitCancelled.open !== false) throw new Error('Git authorization cancellation started a shell or stranded the modal');
      const gitGrantStore = join(sandbox.directory, 'execution-trust.v1.bin');
      if (existsSync(gitGrantStore)) throw new Error('Git grant fixture requires an absent sandbox grant store');
      const gitGrant = await cdp.eval(`(async () => {
        const shells = await ipcRenderer.invoke('get-local-shells');
        const git = shells.find(s => s.id === 'gitbash');
        const owner = 'local:e2e-standard-git-grant';
        const payload = { shell: git.command, args: git.args };
        try {
          const first = await ipcRenderer.invoke('prepare-execution', { kind: 'local', owner, payload });
          if (!first.challengeId) return { firstTicket: true, canRemember: first.canRemember === true };
          await ipcRenderer.invoke('decide-execution', { challengeId: first.challengeId, allow: true, remember: true });
          const second = await ipcRenderer.invoke('prepare-execution', { kind: 'local', owner, payload });
          return { firstTicket: false, canRemember: first.canRemember === true, rememberedTicket: !!second.ticket };
        } finally { await ipcRenderer.invoke('cancel-execution', { owner }); }
      })()`);
      check('标准 Git Bash：记住授权后相同启动配置免再次确认', gitGrant.canRemember === true && (gitGrant.firstTicket === true || gitGrant.rememberedTicket === true), JSON.stringify(gitGrant));
      if (!gitGrant.firstTicket) rmSync(gitGrantStore, { force: false });
      if (existsSync(gitGrantStore)) throw new Error('Git grant fixture did not restore the absent sandbox grant store');
    } else {
      check('ProgramFiles Git Bash：保留既有直接授权', gitStarted.safe === true);
      if (existsSync(join(sandbox.directory, 'execution-trust.v1.bin'))) throw new Error('Safe Git Bash must not create a grant store');
    }

    // 11. SSH failure path: an owned listener closes before authentication →
    // the ssh-error event is handled and the frontend does not crash. Count
    // ssh-error directly via the Tauri event API (does not depend on transient
    // UI state like toasts — more stable)
    sshFailureEndpoint = await createSshFailureEndpoint();
    const consentGrantPath = join(sandbox.directory, 'execution-trust.v1.bin');
    if (existsSync(consentGrantPath)) throw new Error('Native consent fixture sandbox already contains remembered grants');
    const consentEndpoint = JSON.stringify({ host: sshFailureEndpoint.host, port: sshFailureEndpoint.port });
    const consentRead = `(${executionConsent.toString()})(document, ${consentEndpoint})`;
    await cdp.eval(`window.__sshErrCount = 0; window.__TAURI__.event.listen('ssh-error', () => { window.__sshErrCount = (window.__sshErrCount || 0) + 1; })`);
    const consentAttempt = await cdp.eval(`
      (() => {
        const existing = TabManager.tabs.find(t => t.type === 'ssh');
        if (existing) TabManager.closeTab(existing.id);
        TabManager.sshProfiles = TabManager.sshProfiles || [];
        TabManager.sshProfiles.push({
          id: 'e2e-fail', name: 'E2E Fail', type: 'ssh', host: '127.0.0.1', port: ${sshFailureEndpoint.port},
          username: 'e2e', password: '', encryptedPassword: '', privateKeyPath: '',
        });
        connectSSHProfile('e2e-fail');
        const tab = TabManager.tabs.find(t => t.sshProfileId === 'e2e-fail');
        return { tabId: tab.id, attemptId: sshAttempts.ownerAttempt(tab) };
      })()
    `);
    if (!consentAttempt?.tabId || !consentAttempt?.attemptId) throw new Error('Native consent fixture has no attempt owner');
    await waitForValue(cdp, `(${consentRead}).shown`, true, 15000);
    const cancelledConsent = await cdp.eval(`(${executionConsent.toString()})(document, ${consentEndpoint}, 'cancel')`);
    check('执行授权：真实 SSH 确认默认不记忆，取消前没有连接', cancelledConsent.shown === true &&
      cancelledConsent.rememberPresent === true && cancelledConsent.rememberChecked === false &&
      cancelledConsent.allowLabel === '仅本次允许' && sshFailureEndpoint.state.connections === 0,
      JSON.stringify({ ...cancelledConsent, connections: sshFailureEndpoint.state.connections }));
    const consentCancellationReady = await waitForValue(cdp, `(() => {
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(consentAttempt.tabId)});
      const token = ${JSON.stringify(consentAttempt.attemptId)};
      return !document.getElementById('overlay-confirm').classList.contains('open') &&
        !sshAttempts.ownerWants(token) && !sshAttempts.ownerOf(token) && !sshAttempts.ownerAttempt(tab) &&
        sshAttempts.finalState(token) != null;
    })()`, true, 15000);
    const consentRetirement = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(consentAttempt.tabId)});
      const token = ${JSON.stringify(consentAttempt.attemptId)};
      return { tabPresent: !!tab, dialogClosed: !document.getElementById('overlay-confirm').classList.contains('open'),
        ownerWants: sshAttempts.ownerWants(token), ownerBound: !!sshAttempts.ownerOf(token), ownerPending: !!sshAttempts.ownerAttempt(tab),
        finalState: sshAttempts.finalState(token), errors: window.__sshErrCount };
    })()`);
    const consentCancellationOk = consentCancellationPassed(consentCancellationReady, consentRetirement, sshFailureEndpoint.state.connections);
    check('执行授权：取消后 owner 已退役且没有原生连接', consentCancellationOk,
      JSON.stringify({ ...consentRetirement, settled: consentCancellationReady, connections: sshFailureEndpoint.state.connections }));
    if (!consentCancellationOk) throw new Error('Real Cancel did not retire its owner before cleanup');
    // These idempotent calls are cleanup only. They cannot supply acceptance
    // evidence for the product Cancel button above.
    await cdp.eval(`(async () => {
      const token = ${JSON.stringify(consentAttempt.attemptId)};
      await ZTermExecutionTrust.cancel('ssh:' + token);
      await ipcRenderer.invoke('ssh-disconnect', { attemptId: token });
    })()`);
    if (sshFailureEndpoint.state.connections !== 0) throw new Error('Cancelled consent reached the owned loopback listener');
    await cdp.eval(`TabManager.reconnectTab(${JSON.stringify(consentAttempt.tabId)})`);
    await waitForValue(cdp, `(${consentRead}).shown`, true, 15000);
    const reconnectedConsent = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(consentAttempt.tabId)});
      return { attemptId: sshAttempts.ownerAttempt(tab), previousRetired: !sshAttempts.ownerWants(${JSON.stringify(consentAttempt.attemptId)}) };
    })()`);
    if (!reconnectedConsent.attemptId || reconnectedConsent.attemptId === consentAttempt.attemptId || !reconnectedConsent.previousRetired) {
      throw new Error('Consent reconnect did not create a fresh attempt owner');
    }
    const allowedConsent = await cdp.eval(`(() => {
      const reviewed = (${executionConsent.toString()})(document, ${consentEndpoint}, 'allow-once');
      // The first decision comes from the real product button. Only future
      // retry preparations may use the narrow native one-use fixture helper.
      window.__sshFailPrev = ipcRenderer.invoke;
      window.__sshFailApproval = (${createSshFailureApproval.toString()})(window.__sshFailPrev, ${consentEndpoint});
      ipcRenderer.invoke = window.__sshFailApproval.invoke;
      return reviewed;
    })()`);
    await waitForValue(cdp, `!document.getElementById('overlay-confirm').classList.contains('open')`, true, 5000);
    const sshErrCount = await waitForValue(cdp, `window.__sshErrCount`, (v) => v > 0, 40000, 'gt0');
    const consentGrantAbsent = !existsSync(consentGrantPath);
    check('执行授权：真实仅本次允许按钮经过原生决定后连接', allowedConsent.shown === true &&
      allowedConsent.rememberPresent === true && allowedConsent.rememberChecked === false &&
      allowedConsent.allowLabel === '仅本次允许' && sshFailureEndpoint.state.connections > 0 && consentGrantAbsent,
      JSON.stringify({ ...allowedConsent, connections: sshFailureEndpoint.state.connections, attemptId: reconnectedConsent.attemptId, grantFileAbsent: consentGrantAbsent }));
    if (!consentGrantAbsent) throw new Error('One-time consent created a remembered grant in the owned sandbox');
    const sshTabAlive = await cdp.eval(`TabManager.tabs.some(t => t.type === 'ssh')`);
    const appAlive = await cdp.eval(`typeof TabManager.getActive === 'function'`);
    check('SSH 连接失败被处理且前端存活', sshTabAlive && appAlive && sshErrCount > 0,
      `sshTab=${sshTabAlive}, alive=${appAlive}, ssh-error 事件=${sshErrCount}`);
    // 11a. Re-audit the wrap layers after the SSH failure path: the retry
    //      cycle (dispose xterm → reconnect → wireTerminal) is exactly where
    //      duplicate/zombie wraps used to appear, and section 8.5 runs before
    //      any retry has happened. Retries may still be in flight (backoff
    //      2s/5s/10s) — the invariant must hold at every moment regardless.
    const wrapAudit2 = await cdp.eval(`(() => {
      const wraps = [...document.querySelectorAll('.term-wrap')];
      const ids = wraps.map(w => w.id);
      const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
      const activeWraps = wraps.filter(w => w.classList.contains('active'));
      const activeTab = TabManager.getActive();
      const ownerOk = activeWraps.length === 0 ? activeTab?.splitRoot === true || activeTab?.type === 'settings'
        : activeWraps.length === 1 && activeWraps[0].id === 'wrap_' + TabManager.activeId;
      return { total: wraps.length, dup, activeIds: activeWraps.map(w => w.id), ownerOk };
    })()`);
    check('SSH 重试后 wrap 层仍无重复且 active 归属正确', wrapAudit2.dup.length === 0 && wrapAudit2.ownerOk === true, JSON.stringify(wrapAudit2));

    // 11b. Quick-command "auto-execute trailing newline" toggle: UI exists, toggle works, injection semantics correct
    await cdp.eval(`openSettings('quickcommands')`);
    await sleep(1000);
    const qcToggleExists = await cdp.eval(`!!document.getElementById('qc-auto-enter')`);
    const qcToggleDefault = await cdp.eval(`document.getElementById('qc-auto-enter').classList.contains('on')`);
    check('快捷命令开关存在且默认关闭', qcToggleExists && !qcToggleDefault, `exists=${qcToggleExists}, defaultOn=${qcToggleDefault}`);
    await cdp.eval(`toggleQCAutoEnter()`);
    await sleep(500);
    const qcToggleOn = await cdp.eval(`document.getElementById('qc-auto-enter').classList.contains('on')`);
    const qcSetting = await cdp.eval(`_settingsConfig.qcAutoEnter`);
    check('开关 toggle 生效', qcToggleOn === true && qcSetting === true, `classOn=${qcToggleOn}, config=${qcSetting}`);
    // Injection semantics: off strips the trailing newline, on keeps it
    const stripOff = await cdp.eval(`_settingsConfig.qcAutoEnter = false; stripTrailingNewline('echo hi\\n')`);
    const stripOn = await cdp.eval(`_settingsConfig.qcAutoEnter = true; 'echo hi\\n'`);
    check('注入语义：关剥开保', stripOff === 'echo hi' && stripOn === 'echo hi\n', JSON.stringify({ stripOff, stripOn }));
    // Restore the default (off) and close the settings page
    await cdp.eval(`_settingsConfig.qcAutoEnter = false; document.getElementById('qc-auto-enter').classList.remove('on'); closeSettingsTab()`);
    await sleep(600);

    // 11c. Fonts: enumeration contains no @ vertical variants; the UI font
    // setting exists and applying it takes effect
    const fontList = await cdp.eval(`window.electron.ipcRenderer.invoke('get-system-fonts').then(f => f).catch(e => 'ERR: ' + e)`);
    check('字体枚举可用', Array.isArray(fontList), String(fontList).slice(0, 60));
    const atFonts = (Array.isArray(fontList) ? fontList : []).filter(f => f.startsWith('@'));
    const systemFonts = (Array.isArray(fontList) ? fontList : []).filter(f => ['System', 'Terminal', 'Fixedsys'].includes(f));
    check('字体列表无 @ 竖排变体/系统保留字体', atFonts.length === 0 && systemFonts.length === 0,
      `@字体=${atFonts.length}, 保留字体=${systemFonts.length}, 总数=${Array.isArray(fontList) ? fontList.length : '?'}`);
    await cdp.eval(`openSettings('appearance')`);
    await sleep(1000);
    const uiFontSelect = await cdp.eval(`!!document.getElementById('set-ui-font')`);
    const uiFontOptions = await cdp.eval(`document.getElementById('set-ui-font')?.options.length || 0`);
    check('界面字体设置项存在且有选项', uiFontSelect && uiFontOptions > 0, `options=${uiFontOptions}`);
    // UI-font follow toggle: default on → the UI font row is hidden
    const followDefault = await cdp.eval(`document.getElementById('toggle-ui-follow').classList.contains('on')`);
    const uiRowHidden = await cdp.eval(`document.getElementById('row-ui-font').style.display === 'none'`);
    const fontBefore = await cdp.eval(`document.body.style.fontFamily || '(css默认)'`);
    check('界面字体跟随开关默认开且隐藏设置行', followDefault === true && uiRowHidden === true, `follow=${followDefault}, rowHidden=${uiRowHidden}`);
    // In follow mode body gets the terminal font stack
    const followApplied = await cdp.eval(`document.body.style.fontFamily.includes('monospace') || document.body.style.fontFamily.includes('JetBrains') || document.body.style.fontFamily.includes('Consolas') || getComputedStyle(document.body).fontFamily.includes('JetBrains') || getComputedStyle(document.body).fontFamily.includes('monospace')`);
    check('跟随模式下界面使用终端字体', followApplied === true, `body=${fontBefore.slice(0, 60)}`);
    // Turn follow off → the UI font row appears → pick a UI font and apply
    await cdp.eval(`toggleUiFollowTerminal()`);
    await sleep(500);
    const uiRowShown = await cdp.eval(`document.getElementById('row-ui-font').style.display !== 'none'`);
    check('关闭跟随后面临字体行显示', uiRowShown === true, `rowShown=${uiRowShown}`);
    const setResult = await cdp.eval(`document.getElementById('set-ui-font').value = "'Consolas',sans-serif"; saveAppearance(); document.body.style.fontFamily`);
    check('界面字体选择应用生效', setResult.includes('Consolas'), `after=${setResult.slice(0, 60)}`);
    // Inputs follow the UI font: the computed font of the accent-color input
    // and the quick-command command input must contain the UI font
    const accentFont = await cdp.eval(`getComputedStyle(document.getElementById('set-accent')).fontFamily`);
    const qcFont = await cdp.eval(`getComputedStyle(document.getElementById('qc-edit-command')).fontFamily`);
    check('输入框跟随界面字体', accentFont.includes('Consolas') && qcFont.includes('Consolas'),
      `accent=${accentFont.slice(0, 40)}, qc=${qcFont.slice(0, 40)}`);
    // Custom dropdown options follow the UI font (dd-option used to hardcode
    // Segoe UI and ignore the UI font)
    const ddOptionFont = await cdp.eval(`(() => {
      const el = document.querySelector('.cust-dropdown .dd-option');
      return el ? getComputedStyle(el).fontFamily : '(无 dd-option)';
    })()`);
    check('自定义下拉列表字体跟随界面字体', ddOptionFont.includes('Consolas'), `dd-option=${ddOptionFont.slice(0, 50)}`);
    // Buttons follow the UI font (btn-primary etc. used to hardcode Segoe UI)
    const btnFont = await cdp.eval(`(() => {
      const el = document.querySelector('.btn-primary');
      return el ? getComputedStyle(el).fontFamily : '(无 .btn-primary)';
    })()`);
    check('按钮字体跟随界面字体', btnFont.includes('Consolas'), `btn=${btnFont.slice(0, 50)}`);

    // 11c-F2. Font comboboxes (Tabby-style filterable input over the hidden
    // native select): the four font fields mount a .font-combo, typing filters
    // the menu, click/Enter commits to the select + saveAppearance, free text
    // becomes an extra option, empty input selects the sentinel, Esc closes
    // only the menu. Runs while the follow toggle is off so all rows show.
    await cdp.eval(`window.__e2eFontBackup = [_settingsConfig.fontFamily, _settingsConfig.fallbackFont, _settingsConfig.uiFont].join('|'); convertSelects(); 'sync'`);
    const comboMounted = await cdp.eval(`(() => {
      const ids = ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font'];
      return ids.map(id => {
        const sel = document.getElementById(id);
        const w = sel && sel.parentNode.querySelector('.font-combo');
        return { id, wrapper: !!w, hidden: !!sel && sel.style.display === 'none',
                 shows: w ? w.querySelector('input').value : null };
      });
    })()`);
    const mountedOk = Array.isArray(comboMounted) && comboMounted.every(r => r.wrapper && r.hidden);
    check('字体过滤框：四个字段均挂载且原生 select 隐藏', mountedOk === true, JSON.stringify(comboMounted).slice(0, 200));
    check('字体过滤框：输入框显示当前选中字体裸名', !!comboMounted && comboMounted[1].shows === 'Consolas', JSON.stringify(comboMounted && comboMounted[1]));
    const filterProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const input = wrap.querySelector('input');
      input.value = 'consol';
      input.dispatchEvent(new Event('input'));
      const opts = [...wrap.querySelectorAll('.dd-option[data-opt-index]')].map(d => d.textContent);
      return { open: wrap.querySelector('.dd-menu').classList.contains('open'),
               count: opts.length, allMatch: opts.every(t => t.toLowerCase().includes('consol')) };
    })()`);
    check('字体过滤框：输入过滤菜单（忽略大小写子串）', !!filterProbe && filterProbe.open && filterProbe.count > 0 && filterProbe.allMatch, JSON.stringify(filterProbe));
    const pickProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const opt = [...wrap.querySelectorAll('.dd-option[data-opt-index]')].find(d => d.textContent === 'Consolas');
      if (!opt) return { found: false };
      opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return { found: true, after: sel.value, shows: wrap.querySelector('input').value,
               menuClosed: !wrap.querySelector('.dd-menu').classList.contains('open'),
               saved: _settingsConfig.fontFamily };
    })()`);
    check('字体过滤框：点击选项提交并保存', !!pickProbe && pickProbe.found && pickProbe.after === "'Consolas',monospace" && pickProbe.shows === 'Consolas' && pickProbe.menuClosed && pickProbe.saved === "'Consolas',monospace", JSON.stringify(pickProbe));
    const kbProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-ui-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const input = wrap.querySelector('input');
      input.value = 'segoe ui';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const label = sel.options[sel.selectedIndex].textContent;
      return { value: sel.value, shows: input.value, saved: _settingsConfig.uiFont, label };
    })()`);
    // Enumeration order is undefined (registry order): pin the commit shape,
    // not which 'segoe ui' variant happens to sort first.
    check('字体过滤框：键盘 ↓+Enter 选中首个匹配', !!kbProbe && kbProbe.label.toLowerCase().includes('segoe ui') && kbProbe.value === `'${kbProbe.label}',sans-serif` && kbProbe.shows === kbProbe.label && kbProbe.saved === kbProbe.value, JSON.stringify(kbProbe));
    const freeProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-fallback-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const input = wrap.querySelector('input');
      input.value = 'NoSuch Font XYZ';
      input.dispatchEvent(new Event('input'));
      const noneHint = wrap.querySelector('.dd-option.dd-none') ? wrap.querySelector('.dd-option.dd-none').textContent : null;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { noneHint, value: sel.value, extraText: sel.options[sel.selectedIndex].textContent, saved: _settingsConfig.fallbackFont };
    })()`);
    check('字体过滤框：自由文本生成 extra 选项并选中（裸名）', !!freeProbe && freeProbe.value === 'NoSuch Font XYZ' && freeProbe.extraText === 'NoSuch Font XYZ' && freeProbe.saved === 'NoSuch Font XYZ' && /无匹配/.test(freeProbe.noneHint || ''), JSON.stringify(freeProbe));
    const emptyProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-ui-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const input = wrap.querySelector('input');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { value: sel.value, shows: input.value, saved: _settingsConfig.uiFont };
    })()`);
    check('字体过滤框：空输入选中哨兵（系统默认）', !!emptyProbe && emptyProbe.value === '' && emptyProbe.shows === '系统默认' && emptyProbe.saved === '', JSON.stringify(emptyProbe));
    const fontEscProbe = await cdp.eval(`(() => {
      const sel = document.getElementById('set-font');
      const wrap = sel.parentNode.querySelector('.font-combo');
      const input = wrap.querySelector('input');
      input.dispatchEvent(new Event('focus'));
      const openBefore = wrap.querySelector('.dd-menu').classList.contains('open');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { openBefore,
               openAfter: wrap.querySelector('.dd-menu').classList.contains('open'),
               settingsStillOpen: !!document.querySelector('.settings-pane.active') };
    })()`);
    check('字体过滤框：Esc 只关菜单不关设置页', !!fontEscProbe && fontEscProbe.openBefore && !fontEscProbe.openAfter && fontEscProbe.settingsStillOpen, JSON.stringify(fontEscProbe));
    // Restore the fonts captured before this section (set-font was switched to
    // Consolas, fallback to the fake font, uiFont went through Segoe UI + '').
    await cdp.eval(`(() => {
      const parts = window.__e2eFontBackup.split('|');
      const setBack = (id, v) => { const s = document.getElementById(id); if (![...s.options].some(o => o.value === v)) { const opt = document.createElement('option'); opt.value = v; opt.textContent = v; s.appendChild(opt); } s.value = v; };
      setBack('set-font', parts[0]); setBack('set-fallback-font', parts[1]); setBack('set-ui-font', parts[2]);
      saveAppearance();
      return 'restored:' + _settingsConfig.fontFamily;
    })()`);
    // Restore the default (follow on)
    await cdp.eval(`_settingsConfig.uiFollowTerminal = true; syncUiFollowUI(); applyUiFont(); closeSettingsTab()`);
    await sleep(500);

    // 11d. Settings-open cost guards (post-close tab-hover jank report): the
    // system-font IPC result is cached after the first visit, and
    // convertSelects skips wrapper rebuilds while options + selection are
    // unchanged (rebuild only on a real change).
    await cdp.eval(`(() => {
      window.__e2eFontCalls = 0;
      window.__e2ePrevInvokeFonts = ipcRenderer.invoke;
      _systemFontsCache = null;
      _systemFontsPromise = null;
      ipcRenderer.invoke = (cmd, args) => { if (cmd === 'get-system-fonts') window.__e2eFontCalls++; return window.__e2ePrevInvokeFonts(cmd, args); };
      openSettings('appearance');
      return 'armed';
    })()`);
    await sleep(900);
    await cdp.eval(`closeSettingsTab(); 'fc1'`);
    await sleep(300);
    await cdp.eval(`openSettings('appearance'); 'fc2'`);
    await sleep(600);
    const fontCacheProbe = await cdp.eval(`({
      calls: window.__e2eFontCalls,
      options: document.getElementById('set-font')?.options.length || 0,
      wrapper: document.querySelector('#set-font')?.parentNode?.querySelectorAll('.font-combo').length === 1
    })`).catch(() => null);
    check('设置页字体列表缓存：二次打开不重复枚举', !!fontCacheProbe && fontCacheProbe.calls === 1 && fontCacheProbe.options > 0 && fontCacheProbe.wrapper === true, JSON.stringify(fontCacheProbe));
    const convGuard = await cdp.eval(`(() => {
      // The font selects are font-combos now; the signature guard is exercised
      // on the terminal-scheme select, which still converts to a cust-dropdown.
      const sel = document.getElementById('set-terminal-scheme');
      const origIdx = sel.selectedIndex;
      const w1 = sel.parentNode.querySelector('.cust-dropdown');
      convertSelects();
      const same = sel.parentNode.querySelector('.cust-dropdown') === w1;
      sel.selectedIndex = (origIdx + 1) % sel.options.length;
      convertSelects();
      const w2 = sel.parentNode.querySelector('.cust-dropdown');
      const rebuilt = w2 !== w1;
      const triggerShows = w2.querySelector('.dd-trigger').textContent === sel.options[sel.selectedIndex].text;
      sel.selectedIndex = origIdx; // restore (no change event → nothing persisted)
      convertSelects();
      return { same, rebuilt, triggerShows };
    })()`).catch(() => null);
    check('convertSelects 签名守卫：未变跳过 / 选择变化重建', !!convGuard && convGuard.same === true && convGuard.rebuilt === true && convGuard.triggerShows === true, JSON.stringify(convGuard));
    await cdp.eval(`(() => { ipcRenderer.invoke = window.__e2ePrevInvokeFonts; closeSettingsTab(); return 'restored'; })()`).catch(() => null);
    await sleep(300);

    // 11e. Split-pane header connection state (U-01/U-06): pane headers are
    //      built once per pane node and render() never repaints them, so the
    //      header dot AND the pane-reconnect button must follow the pane's
    //      SSH lifecycle through _refreshPaneHeaderState. The old code baked
    //      the button into freshly built headers only — a pane that
    //      disconnected after its node existed never gained the button, a
    //      reconnect never dropped it, and _applySshConnecting left a stale
    //      dot. Everything here is the real lifecycle: authorization transport
    //      and ssh-connect are stubbed ONLY for the fixture profile
    //      (host 'stub.invalid'), so no dial ever leaves the renderer and the
    //      section-11 retry loop against the owned listener stays native.
    //      Events travel the real Tauri channel into ipc.js, the attempt
    //      registry applies connecting/connected through the rpc applier, and
    //      the assertions read the real DOM.
    await cdp.eval(`(() => {
      window.__sshStubPrev = ipcRenderer.invoke;
      window.__sshStub = (${createUiSshFixture.toString()})(window.__sshStubPrev);
      ipcRenderer.invoke = window.__sshStub.invoke;
      TabManager.sshProfiles = TabManager.sshProfiles || [];
      TabManager.sshProfiles.push({
        id: 'e2e-ssh-stub', name: 'E2E SSH Stub', type: 'ssh', host: 'stub.invalid', port: 22,
        username: 'e2e', password: '', encryptedPassword: '', privateKeyPath: '',
      });
      connectSSHProfile('e2e-ssh-stub');
      return 'armed';
    })()`);
    try {
      await waitForValue(cdp, `(() => {
        const t = TabManager.tabs.find(x => x.host === 'stub.invalid');
        return !!(t && t.term && t.tabId && t.connected === true);
      })()`, true, 15000);
      const SSHT = JSON.stringify(await cdp.eval(`TabManager.tabs.find(x => x.host === 'stub.invalid').id`));
      // Control: the NON-split SSH tab keeps its tab-strip reconnect entry
      // through the same lifecycle (render()'s inline button, !splitRoot
      // gate) — disconnected offers 重新连接, the connecting phase shows the
      // busy entry, connected keeps the force variant. No pane button may
      // exist anywhere while unsplit. __TAURI__.event.emit delivers through
      // the backend (a round trip), so each read must wait for the handler
      // to run — reading synchronously after emit would see the old DOM.
      const stripRead = () => cdp.eval(`(() => {
        const t = TabManager.tabs.find(x => x.id === ${SSHT});
        // All three strip variants: disconnected/busy carry the base
        // tab-reconnect token, connected renders tab-reconnect-normal only.
        const el = document.querySelector('.tab[data-tab="' + t.id + '"] .tab-reconnect, .tab[data-tab="' + t.id + '"] .tab-reconnect-normal');
        return {
          connected: t.connected, connecting: t._sshConnecting === true,
          btn: !!el, busy: !!(el && el.classList.contains('tab-reconnect-busy')),
          normal: !!(el && el.classList.contains('tab-reconnect-normal')), title: el ? el.title : null,
          paneBtn: !!document.querySelector('.pane-reconnect'),
        };
      })()`);
      await cdp.eval(`window.__TAURI__.event.emit('ssh-disconnected', { tabId: TabManager.tabs.find(x => x.id === ${SSHT}).tabId, reason: 'e2e fixture' })`);
      await sleep(300);
      const stripDisc = await stripRead();
      await cdp.eval(`window.__TAURI__.event.emit('ssh-connecting', { tabId: TabManager.tabs.find(x => x.id === ${SSHT}).tabId })`);
      await sleep(300);
      const stripConnecting = await stripRead();
      await cdp.eval(`window.__TAURI__.event.emit('ssh-connected', { tabId: TabManager.tabs.find(x => x.id === ${SSHT}).tabId })`);
      await sleep(300);
      const stripConnected = await stripRead();
      check('SSH 标签条重连按钮随生命周期保持（非分屏对照，U-01）',
        stripDisc.connected === false && stripDisc.btn === true && stripDisc.busy === false && stripDisc.title === '重新连接' &&
        stripConnecting.connecting === true && stripConnecting.btn === true && stripConnecting.busy === true &&
        stripConnected.connected === true && stripConnected.btn === true && stripConnected.normal === true && stripConnected.title === '强制重连' &&
        stripDisc.paneBtn === false,
        JSON.stringify({ stripDisc, stripConnecting, stripConnected }));
      // Split the connected SSH tab: both panes start connected (the new
      // pane's own stubbed connect applies through the real rpc applier).
      await cdp.eval(`(() => { TabManager.switchTo(${SSHT}); TabManager.splitHorizontal(); return true; })()`);
      await waitForValue(cdp, `(() => {
        const t = TabManager.tabs.find(x => x.id === ${SSHT});
        if (!t || !t.splitRoot) return false;
        const panes = getAllPanes(t);
        if (panes.length !== 2 || !panes.every(p => p.type === 'ssh' && p.term && p.tabId)) return false;
        return panes.every(p => {
          const h = document.querySelector('.split-pane[data-pane="' + p.id + '"] .pane-header');
          const dot = h && h.querySelector('.dot');
          return !!dot && dot.className === 'dot connected' && !h.querySelector('.pane-reconnect');
        });
      })()`, true, 15000);
      const paneInfo = await cdp.eval(`(() => {
        const t = TabManager.tabs.find(x => x.id === ${SSHT});
        const panes = getAllPanes(t);
        return { ids: panes.map(p => p.id), tabIds: panes.map(p => p.tabId) };
      })()`);
      const PA = JSON.stringify(paneInfo.ids[0]);
      const PB = JSON.stringify(paneInfo.ids[1]);
      const PAT = JSON.stringify(paneInfo.tabIds[0]);
      const paneHeaderState = () => cdp.eval(`(() => {
        const read = (pid) => {
          const h = document.querySelector('.split-pane[data-pane="' + pid + '"] .pane-header');
          const dot = h && h.querySelector('.dot');
          const btn = h && h.querySelector('.pane-reconnect');
          return { dot: dot ? dot.className : null, btn: !!btn, title: btn ? btn.title : null };
        };
        const t = TabManager.tabs.find(x => x.id === ${SSHT});
        return {
          a: read(${PA}), b: read(${PB}),
          stripBtn: !!document.querySelector('.tab[data-tab="' + t.id + '"] .tab-reconnect, .tab[data-tab="' + t.id + '"] .tab-reconnect-normal'),
        };
      })()`);
      // U-01 pin: ssh-disconnected on a LIVE pane node must add the pane
      // header's reconnect button and flip its dot — the exact transition
      // the baked-in button could not serve. The sibling pane and the tab
      // strip (split gate) must stay untouched.
      await cdp.eval(`window.__TAURI__.event.emit('ssh-disconnected', { tabId: ${PAT}, reason: 'e2e fixture' })`);
      await sleep(300);
      const paneDisc = await paneHeaderState();
      check('分屏 SSH pane 断开后头部出现「重新连接」按钮且 dot 变 disconnected（U-01/U-06）',
        paneDisc.a.dot === 'dot disconnected' && paneDisc.a.btn === true && paneDisc.a.title === '重新连接' &&
        paneDisc.b.dot === 'dot connected' && paneDisc.b.btn === false &&
        paneDisc.stripBtn === false,
        JSON.stringify(paneDisc));
      // U-06 pin: the connecting transition must drop the stale button and
      // show the busy dot (the old _applySshConnecting never synced the
      // header at all).
      await cdp.eval(`window.__TAURI__.event.emit('ssh-connecting', { tabId: ${PAT} })`);
      await sleep(300);
      const paneConn = await paneHeaderState();
      check('分屏 SSH pane 重连中 dot 变 connecting 且按钮消失（U-06）',
        paneConn.a.dot === 'dot connecting' && paneConn.a.btn === false &&
        paneConn.b.dot === 'dot connected' && paneConn.b.btn === false,
        JSON.stringify(paneConn));
      // Connected: dot connected, button never (re)appears for a live pane.
      await cdp.eval(`window.__TAURI__.event.emit('ssh-connected', { tabId: ${PAT} })`);
      await sleep(300);
      const paneLive = await paneHeaderState();
      check('分屏 SSH pane 连接成功 dot 变 connected 且无重连按钮',
        paneLive.a.dot === 'dot connected' && paneLive.a.btn === false &&
        paneLive.b.dot === 'dot connected' && paneLive.b.btn === false,
        JSON.stringify(paneLive));
      // Local panes never offer reconnect: pty-exit on a local split pane
      // still runs the same state sync (the dot must flip) but the button is
      // gated to SSH panes — this pins the guard, not a no-op.
      const phTab = await cdp.eval(`TabManager.createTab({ name: 'E2E-PANEEXIT', type: 'local' })`);
      const PH = JSON.stringify(phTab);
      await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${PH}); return !!(t && t.term && t.tabId); })()`, true, 15000);
      await cdp.eval(`(() => { TabManager.switchTo(${PH}); TabManager.splitHorizontal(); return true; })()`);
      await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${PH})).filter(p => p.term && p.tabId).length`, 2, 15000);
      const phPane = await cdp.eval(`(() => {
        const panes = getAllPanes(TabManager.tabs.find(x => x.id === ${PH}));
        return { tabId: panes[0].tabId, id: panes[0].id };
      })()`);
      await cdp.eval(`window.__TAURI__.event.emit('pty-exit', { tabId: ${JSON.stringify(phPane.tabId)} })`);
      await sleep(300);
      const localExit = await cdp.eval(`(() => {
        const h = document.querySelector('.split-pane[data-pane="' + ${JSON.stringify(phPane.id)} + '"] .pane-header');
        const dot = h && h.querySelector('.dot');
        return { dot: dot ? dot.className : null, btn: !!h.querySelector('.pane-reconnect') };
      })()`);
      check('local 分屏 pane 退出后 dot 变 disconnected 但不出现 pane 重连按钮',
        localExit.dot === 'dot disconnected' && localExit.btn === false,
        JSON.stringify(localExit));
      // Unwind: close both fixture tabs, drop the stub profile, and restore
      // the unwrapped invoke — verified, mirroring the SFTP gate discipline.
      const hdrCleanup = await cdp.eval(`(() => {
        const r = {};
        try {
          try { TabManager.closeTab(${SSHT}); } catch (e) { r.sshCloseErr = String(e && e.message || e); }
          const lt = TabManager.tabs.find(x => x.name === 'E2E-PANEEXIT');
          try { if (lt) TabManager.closeTab(lt.id); } catch (e) { r.localCloseErr = String(e && e.message || e); }
          TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => p.id !== 'e2e-ssh-stub');
          r.profileGone = !(TabManager.sshProfiles || []).some(p => p.id === 'e2e-ssh-stub');
        } catch (e) { r.err = String(e && e.message || e); }
        ipcRenderer.invoke = window.__sshStubPrev;
        r.invokeRestored = ipcRenderer.invoke === window.__sshStubPrev;
        r.stubCalls = window.__sshStub.calls;
        r.stubPrepares = window.__sshStub.prepares;
        return r;
      })()`).catch(e => ({ evalError: String(e && e.message || e) }));
      await sleep(900); // let the staggered tab removals settle
      const hdrResidual = await cdp.eval(`(() => ({
        sshGone: !TabManager.tabs.some(x => x.id === ${SSHT}),
        localGone: !TabManager.tabs.some(x => x.name === 'E2E-PANEEXIT'),
        paneBtns: document.querySelectorAll('.pane-reconnect').length,
      }))()`).catch(() => null);
      await cdp.eval(`(() => { delete window.__sshStub; delete window.__sshStubPrev; return true; })()`).catch(() => null);
      check('U-01/U-06 fixture 清理：stub invoke 恢复、标签与 profile 移除',
        !!hdrCleanup && hdrCleanup.invokeRestored === true && hdrCleanup.profileGone === true &&
        !hdrCleanup.evalError && !hdrCleanup.sshCloseErr && !hdrCleanup.localCloseErr && hdrCleanup.stubCalls >= 2 && hdrCleanup.stubPrepares >= hdrCleanup.stubCalls &&
        !!hdrResidual && hdrResidual.sshGone === true && hdrResidual.localGone === true && hdrResidual.paneBtns === 0,
        JSON.stringify({ hdrCleanup, hdrResidual }));
    } finally {
      // Restore the page even when a check above throws, so section 12+ sees
      // an unwrapped invoke and no half-torn fixture.
      await cdp.eval(`(() => {
        if (window.__sshStubPrev) ipcRenderer.invoke = window.__sshStubPrev;
        const t = TabManager.tabs.find(x => x.host === 'stub.invalid');
        if (t) { try { TabManager.closeTab(t.id); } catch (e) {} }
        const lt = TabManager.tabs.find(x => x.name === 'E2E-PANEEXIT');
        if (lt) { try { TabManager.closeTab(lt.id); } catch (e) {} }
        TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => p.id !== 'e2e-ssh-stub');
        delete window.__sshStub; delete window.__sshStubPrev;
        return true;
      })()`).catch(() => null);
      await sleep(400);
    }

    // 12. SFTP panel: open → panel visible → close
    // Section 11 leaves a real retry chain (backoff 2s/5s/10s) running against
    // the owned loopback listener: every ssh-error in the retry branch calls
    // SFTP.updateTarget() (ipc.js), which re-reads the ACTIVE tab against the
    // per-tab open set and suspends a dock whose active tab shows no connected
    // SSH target — including this section's artificial 'e2e-dummy-tab'
    // binding. The product behavior is by design (the dock reflects the
    // active tab's own open state and focus); the artificial binding is what
    // makes the window observable. Exhaust the chain deterministically: bump
    // the retry token so scheduled retries no-op at fire time, and exhaust the
    // budget so an arriving in-flight error takes the terminal branch (no
    // updateTarget, no new attempt).
    await cdp.eval(`(() => {
      for (const t of TabManager.tabs) {
        t._sshRetryToken = (t._sshRetryToken || 0) + 1;
        t._sshRetried = 99;
      }
      return true;
    })()`);
    await sleep(300); // let an in-flight attempt's terminal error land before the window
    const nativeFixtureCleanup = await cdp.eval(`(async () => {
      const targets = TabManager.tabs.filter(t => t.type === 'ssh' && t.host === '127.0.0.1' && Number(t.port) === ${sshFailureEndpoint.port});
      const identities = targets.map(t => ({ attemptId: sshAttempts.ownerAttempt(t), tabId: t.tabId }));
      for (const tab of targets) TabManager.closeTab(tab.id);
      for (const identity of identities) {
        if (identity.attemptId) await ipcRenderer.invoke('cancel-execution', { owner: 'ssh:' + identity.attemptId });
        if (identity.attemptId || identity.tabId) await ipcRenderer.invoke('ssh-disconnect', identity);
      }
      TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => p.id !== 'e2e-fail');
      const approval = window.__sshFailApproval;
      await approval.cancelAll();
      const restored = ipcRenderer.invoke === approval.invoke;
      if (!restored) throw new Error('Native SSH fixture transport was not restored by the UI fixture');
      ipcRenderer.invoke = window.__sshFailPrev;
      delete window.__sshFailApproval; delete window.__sshFailPrev;
      return { restored, retired: targets.length, prepares: approval.prepares, approvals: approval.approvals };
    })()`);
    check('SSH native fixture 使用一次授权并恢复 transport', nativeFixtureCleanup.restored === true &&
      nativeFixtureCleanup.retired > 0 && nativeFixtureCleanup.approvals > 0 && nativeFixtureCleanup.prepares >= nativeFixtureCleanup.approvals &&
      sshFailureEndpoint.state.connections > 0 && sshFailureEndpoint.state.error === null,
      JSON.stringify({ ...nativeFixtureCleanup, endpoint: sshFailureEndpoint.state }));
    await sleep(400); // settle the fixture tab removal before the artificial SFTP binding
    await cdp.eval(`SFTP.open('e2e-dummy-tab')`);
    await sleep(800);
    const sftpOpen = await cdp.eval(`document.getElementById('overlay-sftp').classList.contains('open')`);
    const sftpBreadcrumb = await cdp.eval(`document.getElementById('sftp-breadcrumb')?.textContent`);
    check('SFTP 面板打开', sftpOpen === true, `overlay-sftp.open=${sftpOpen}, breadcrumb=${sftpBreadcrumb}`);
    await cdp.eval(`SFTP.close()`);
    await sleep(500);
    const sftpClosed = await cdp.eval(`!document.getElementById('overlay-sftp').classList.contains('open')`);
    check('SFTP 面板关闭', sftpClosed === true, `overlay-sftp.open=${!sftpClosed}`);

    // 12a. SFTP session/operation ownership (batch 06): real DOM + REAL renderer
    //      methods (SFTP.open/upload/navigate/togglePin) behind a synthetic
    //      SFTP/dialog IPC boundary — no real file picker, upload, clipboard or
    //      server. ipcRenderer.invoke is wrapped only for the sftp-*/dialog
    //      commands with programmable deferred settlements; everything is
    //      restored (and the restore VERIFIED) in the finally block so later
    //      sections see a clean page. Synthetic session ids never reach the real
    //      backend. Cdp.eval awaits promises, so gated actions must be STARTED
    //      through __sftpGate.run (void start + rejection recording) and then
    //      driven with bounded polls of the observed gate state — never by
    //      awaiting the action's own deferred promise.
    await cdp.eval(`(() => {
      window.__sftpOrigInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__sftpGate = {
        log: [],
        errors: [],    // unexpected action rejections — fail the section, never hidden
        cleanup: false, // true while the section unwinds: rejections caused by the cleanup itself are expected
        run(label, fn) {
          try {
            const p = fn();
            if (p && typeof p.catch === 'function') {
              p.catch(e => { if (!this.cleanup) this.errors.push(label + ': ' + (e && e.message || e)); });
            }
          } catch (e) {
            this.errors.push(label + ' (sync): ' + (e && e.message || e));
          }
          return 'started';
        },
        settle(pred, value) {
          const c = this.log.find(c => !c.settled && pred(c));
          if (c) { c.settled = true; c.resolve(value); }
          return !!c;
        },
        fail(pred, err) {
          const c = this.log.find(c => !c.settled && pred(c));
          if (c) { c.settled = true; c.reject(new Error(err)); }
          return !!c;
        },
        pending(pred) {
          return this.log.filter(c => !c.settled && (!pred || pred(c))).map(c => ({ cmd: c.cmd, args: c.args }));
        },
      };
      ipcRenderer.invoke = (cmd, args) => {
        if (['sftp-open', 'sftp-readdir', 'sftp-upload', 'sftp-rename', 'sftp-remove', 'show-open-dialog', 'show-save-dialog'].includes(cmd)) {
          return new Promise((resolve, reject) => { window.__sftpGate.log.push({ cmd, args, resolve, reject, settled: false }); });
        }
        return window.__sftpOrigInvoke(cmd, args);
      };
      return 'armed';
    })()`);
    try {
      const A = 'zterm-e2e-a', B = 'zterm-e2e-b';
      // A) Upload batch keeps the owner captured at start across a panel rebind:
      //    the queued file 2 must go to A's session/path and the completion must
      //    not re-list B's panel through A's stale callback.
      await cdp.eval(`window.__sftpGate.run('open-a1', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.run('upload-a1', () => SFTP.upload())`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'show-open-dialog').length`, 1, 5000);
      const dlgSettled = await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'show-open-dialog', { canceled: false, filePaths: ['C:/e2e/f1.txt', 'C:/e2e/f2.txt'] })`);
      await sleep(300);
      const u1 = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-upload')[0] || null`);
      check('SFTP 归属：上传批次首个文件发往所属会话 A', dlgSettled === true && !!u1 && u1.args.tabId === A && u1.args.remotePath === '/srv/app/f1.txt', JSON.stringify(u1));
      await cdp.eval(`window.__sftpGate.run('rebind-b1', () => { SFTP.close(); return SFTP.open(${JSON.stringify(B)}); })`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}, { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-upload' && c.args.remotePath === '/srv/app/f1.txt', {})`);
      await sleep(300);
      const sftpOwnerA = await cdp.eval(`({
        bReaddirs: window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.tabId === ${JSON.stringify(B)}),
        nextUpload: window.__sftpGate.pending(c => c.cmd === 'sftp-upload')[0] || null,
        bRows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
      })`);
      check('SFTP 归属：面板改绑 B 后排队文件仍发往 A 且不改刷 B',
        sftpOwnerA.bReaddirs.length === 0 && !!sftpOwnerA.nextUpload &&
        sftpOwnerA.nextUpload.args.tabId === A && sftpOwnerA.nextUpload.args.remotePath === '/srv/app/f2.txt' &&
        sftpOwnerA.bRows.includes('readme.md'),
        JSON.stringify(sftpOwnerA));
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-upload' && c.args.tabId === ${JSON.stringify(A)}, {})`);
      await sleep(300);

      // B) A late rejection of a superseded open must not overwrite B's listing.
      // Fresh-open staging note (applies to the resets in C-H too): these
      // pre-J subsections stage rebinds through direct SFTP.open(X) and were
      // written against the old global model, where open() ALWAYS issued a
      // fresh sftp-open. Under the per-session directory memory, a remembered
      // path (or a leftover pin) redirects open(X) into a restore
      // sftp-readdir instead — the waitForValue('sftp-open') below would
      // stall and every settle/fail would no-op. Each subsection resets
      // _lastPath (and pins where it does not stage them itself) so its
      // opens are exactly the fresh opens the section verifies; the
      // ownership assertions are untouched, and section J covers the
      // restore semantics against the real model.
      await cdp.eval(`SFTP._lastPath = {}`);
      await cdp.eval(`window.__sftpGate.run('rebind-a2', () => { SFTP.close(); return SFTP.open(${JSON.stringify(A)}); })`); // A's open stays pending
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.run('rebind-b2', () => { SFTP.close(); return SFTP.open(${JSON.stringify(B)}); })`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}, { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.fail(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, 'SFTP not available')`);
      await sleep(300);
      const sftpLateRej = await cdp.eval(`({
        failed: document.getElementById('sftp-body').innerHTML.includes('加载失败'),
        rows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
      })`);
      check('SFTP 归属：被取代的 open 迟到失败不覆盖 B 的列表', sftpLateRej.failed === false && sftpLateRej.rows.includes('readme.md'), JSON.stringify(sftpLateRej));

      // C) Failed pinned reopen shows the honest failure state in the REAL DOM:
      //    the previous session's rows must be gone (innerHTML replacement), and
      //    no stale row can dispatch a download against the new session.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`SFTP._lastPath = {}`); // fresh-open staging (see B)
      await cdp.eval(`window.__sftpGate.run('open-b3', () => SFTP.open(${JSON.stringify(B)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}, { path: '/var/log', files: [{ name: 'syslog', isDir: false, size: 5, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`SFTP.togglePin()`);
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`window.__sftpGate.run('open-a3', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/home/alice', files: [{ name: 'report.txt', isDir: false, size: 9, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`window.__sftpGate.run('open-b4', () => SFTP.open(${JSON.stringify(B)}))`); // pinned: straight to /var/log readdir
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      const pinnedNav = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir')[0] || null`);
      await cdp.eval(`window.__sftpGate.fail(c => c.cmd === 'sftp-readdir' && c.args.tabId === ${JSON.stringify(B)}, 'connection lost')`);
      await sleep(300);
      const sftpPinned = await cdp.eval(`({
        failed: document.getElementById('sftp-body').innerHTML.includes('加载失败'),
        rows: [...document.querySelectorAll('#sftp-body .sftp-item')].length,
        aliceNames: document.getElementById('sftp-body').innerHTML.includes('report.txt'),
      })`);
      check('SFTP 归属：固定的重开失败显示真实错误态且无上一会话文件行',
        !!pinnedNav && pinnedNav.args.tabId === B && pinnedNav.args.path === '/var/log' &&
        sftpPinned.failed === true && sftpPinned.rows === 0 && sftpPinned.aliceNames === false,
        JSON.stringify({ pinnedNav, ...sftpPinned }));

      // D) cwd follow (synthetic backend events through the real Tauri event
      //    channel): only the panel's own live session follows; pinned stays.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`SFTP._lastPath = {}`); // fresh-open staging (see B)
      await cdp.eval(`window.__sftpGate.run('open-a4', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [] })`);
      await sleep(300);
      await cdp.eval(`window.__TAURI__.event.emit('sftp-cwd-changed', { tabId: ${JSON.stringify(A)}, cwd: '/tmp' })`);
      await sleep(300);
      const sftpFollow = await cdp.eval(`({
        pending: window.__sftpGate.pending(c => c.cmd === 'sftp-readdir'),
      })`);
      const followOk = sftpFollow.pending.length === 1 && sftpFollow.pending[0].args.tabId === A && sftpFollow.pending[0].args.path === '/tmp';
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/tmp', { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] })`);
      await sleep(300);
      const sftpFollowRendered = await cdp.eval(`({
        path: SFTP._path,
        rows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
      })`);
      check('SFTP 归属：cwd 跟随仅导航所属会话并渲染', followOk && sftpFollowRendered.path === '/tmp' && sftpFollowRendered.rows.includes('tmpfile.txt'),
        JSON.stringify({ sftpFollow, ...sftpFollowRendered }));
      await cdp.eval(`window.__TAURI__.event.emit('sftp-cwd-changed', { tabId: ${JSON.stringify(B)}, cwd: '/elsewhere' })`);
      await sleep(300);
      const sftpFollowOther = await cdp.eval(`window.__sftpGate.pending().length`);
      check('SFTP 归属：其他会话的 cwd 事件不导航当前面板', sftpFollowOther === 0, `pending=${sftpFollowOther}`);
      await cdp.eval(`SFTP.togglePin()`);
      await sleep(200);
      await cdp.eval(`window.__TAURI__.event.emit('sftp-cwd-changed', { tabId: ${JSON.stringify(A)}, cwd: '/pinned-should-stay' })`);
      await sleep(300);
      const sftpFollowPinned = await cdp.eval(`({
        pending: window.__sftpGate.pending().length,
        path: SFTP._path,
      })`);
      check('SFTP 归属：固定（pin）后 cwd 跟随不再导航', sftpFollowPinned.pending === 0 && sftpFollowPinned.path === '/tmp', JSON.stringify(sftpFollowPinned));

      // E) (batch 06 correction 1) A late open failure of a panel hidden
      //    through the ORDINARY close route (real SFTP.close(): hides the
      //    dock and retires the view generation) must not surface its
      //    obsolete error; a visible panel's own failure keeps its real
      //    feedback.
      await cdp.eval(`SFTP.togglePin()`); // unpin A again for the later sections
      await sleep(200);
      await cdp.eval(`SFTP._lastPath = {}`); // fresh-open staging (see B)
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`window.__sftpGate.run('open-a5', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`SFTP.close()`); // the real dock-era close route
      await sleep(200);
      await cdp.eval(`window.__sftpGate.fail(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, 'connection lost')`);
      await sleep(300);
      const sftpOverlayClose = await cdp.eval(`({
        failed: document.getElementById('sftp-body').innerHTML.includes('加载失败'),
        toastMsg: document.getElementById('toast').textContent,
        toastShown: document.getElementById('toast').classList.contains('show'),
      })`);
      check('SFTP 归属：面板关闭后迟到的 open 失败不再报错',
        sftpOverlayClose.failed === false && !sftpOverlayClose.toastMsg.includes('无法打开 SFTP'),
        JSON.stringify(sftpOverlayClose));
      await cdp.eval(`window.__sftpGate.run('open-a6', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.fail(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, 'connection lost')`);
      await sleep(300);
      const sftpOverlayCloseCtl = await cdp.eval(`({
        failed: document.getElementById('sftp-body').innerHTML.includes('加载失败'),
        toastMsg: document.getElementById('toast').textContent,
      })`);
      check('SFTP 归属：可见面板自身的 open 失败仍显示错误（对照）',
        sftpOverlayCloseCtl.failed === true && sftpOverlayCloseCtl.toastMsg.includes('无法打开 SFTP'),
        JSON.stringify(sftpOverlayCloseCtl));

      // F) A follow completing while the user edits the breadcrumb path keeps
      //    the editor (real DOM input), renders the listing behind it, and the
      //    editor's Enter still navigates the typed path.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`SFTP._lastPath = {}`); // fresh-open staging (see B)
      await cdp.eval(`window.__sftpGate.run('open-a7', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [] })`);
      await sleep(300);
      await cdp.eval(`window.__TAURI__.event.emit('sftp-cwd-changed', { tabId: ${JSON.stringify(A)}, cwd: '/tmp' })`);
      await sleep(300);
      const editMounted = await cdp.eval(`(() => { SFTP._editPath(); const i = document.querySelector('#sftp-breadcrumb input'); if (i) i.value = '/typed/path'; return !!i; })()`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/tmp', { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] })`);
      await sleep(300);
      const sftpEditFollow = await cdp.eval(`(() => {
        const input = document.querySelector('#sftp-breadcrumb input');
        return {
          editorAlive: !!input && input.value === '/typed/path',
          loading: document.getElementById('sftp-body').innerHTML.includes('加载中'),
          rows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
        };
      })()`);
      check('SFTP 归属：路径编辑中完成的 cwd 跟随保留编辑器并渲染列表',
        editMounted === true && sftpEditFollow.editorAlive === true &&
        sftpEditFollow.loading === false && sftpEditFollow.rows.includes('tmpfile.txt'),
        JSON.stringify({ editMounted, ...sftpEditFollow }));
      await cdp.eval(`(() => { const i = document.querySelector('#sftp-breadcrumb input'); if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
      await sleep(300);
      const typedNav = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/typed/path').length`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/typed/path', { files: [] })`);
      await sleep(300);
      const sftpEditEnter = await cdp.eval(`({
        path: SFTP._path,
        editorGone: !document.querySelector('#sftp-breadcrumb input'),
        crumbs: document.getElementById('sftp-breadcrumb').textContent,
      })`);
      check('SFTP 归属：保留的编辑器 Enter 仍按输入路径导航',
        typedNav === 1 && sftpEditEnter.path === '/typed/path' && sftpEditEnter.editorGone === true,
        JSON.stringify({ typedNav, ...sftpEditEnter }));

      // G) A stale in-flight open of a previous binding must not suppress the
      //    current view's upload-completion refresh.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      // Fresh-open staging (see B), pins included: section C left B pinned at
      // /var/log, and this section's open(B) must be a fresh sftp-open so the
      // pending-readdir count below is genuinely the upload refresh.
      await cdp.eval(`SFTP._lastPath = {}; SFTP._pinned = {}; SFTP._pinnedPath = {};`);
      await cdp.eval(`window.__sftpGate.run('open-a8', () => SFTP.open(${JSON.stringify(A)}))`); // A's open stays pending
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.run('rebind-b6', () => { SFTP.close(); return SFTP.open(${JSON.stringify(B)}); })`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}, { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.run('upload-b6', () => SFTP.uploadLocal('C:/e2e/new.txt', { tabId: ${JSON.stringify(B)}, path: '/home/bob' }))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-upload' && c.args.tabId === ${JSON.stringify(B)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-upload' && c.args.tabId === ${JSON.stringify(B)}, {})`);
      await sleep(300);
      const sftpEpochRefresh = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.tabId === ${JSON.stringify(B)}).length`);
      check('SFTP 归属：前一会话未完成的 open 不阻塞当前视图的上传刷新', sftpEpochRefresh === 1, `pending=${sftpEpochRefresh}`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.tabId === ${JSON.stringify(B)}, { files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }, { name: 'new.txt', isDir: false, size: 1, mtime: 0 }] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/old', files: [] })`);
      await sleep(300);

      // H) Concurrent upload completions coalesce: the unchanged view eventually
      //    lists every completed file.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`SFTP._lastPath = {}`); // fresh-open staging (see B)
      await cdp.eval(`window.__sftpGate.run('open-a9', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [] })`);
      await sleep(300);
      await cdp.eval(`(() => { const o = { tabId: ${JSON.stringify(A)}, path: '/srv/app' }; window.__sftpGate.run('coalesce-1', () => SFTP.uploadLocal('C:/e2e/one.txt', o)); window.__sftpGate.run('coalesce-2', () => SFTP.uploadLocal('C:/e2e/two.txt', o)); return 'started'; })()`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-upload').length`, 2, 5000);
      const sftpCoalesceUps = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-upload').length`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-upload' && c.args.remotePath === '/srv/app/one.txt', {})`);
      await sleep(300);
      const sftpCoalesceFirst = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir').length`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-upload' && c.args.remotePath === '/srv/app/two.txt', {})`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }] })`);
      await sleep(300);
      const sftpCoalesceFollowup = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app').length`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }, { name: 'two.txt', isDir: false, size: 2, mtime: 0 }] })`);
      await sleep(300);
      const sftpCoalesce = await cdp.eval(`({
        rows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
      })`);
      check('SFTP 归属：并发上传的合并刷新最终列出全部完成文件',
        sftpCoalesceUps === 2 && sftpCoalesceFirst === 1 && sftpCoalesceFollowup === 1 &&
        sftpCoalesce.rows.includes('one.txt') && sftpCoalesce.rows.includes('two.txt'),
        JSON.stringify({ sftpCoalesceUps, sftpCoalesceFirst, sftpCoalesceFollowup, ...sftpCoalesce }));

      // I) U-02 breadcrumb single-click guard (REAL mouse, CDP Input domain):
      //    the root crumb's glyph is an SVG child whose className is an
      //    SVGAnimatedString — the old class-word test (/\bseg\b/ on
      //    String(target.className)) could never match it, so a real click
      //    on the icon fell through to the bar's edit branch and opened the
      //    path editor instead of navigating. The fix resolves the click
      //    through closest('.seg') and makes the glyph pointer-transparent,
      //    so the REAL hit target inside the icon is the .seg-root span.
      //    Every click below is dispatched at the element's rendered
      //    position — the defect only exists on the real event chain, so
      //    calling handlers directly would prove nothing.
      async function u02ClickAt(x, y, clickCount = 1) {
        const seq = clickCount === 2
          ? [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]
          : [['mousePressed', 1], ['mouseReleased', 1]];
        for (const [type, cc] of seq) {
          await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: cc });
        }
        await sleep(200);
      }
      const u02EditorState = () => cdp.eval(`(() => ({
        editor: !!document.querySelector('#sftp-breadcrumb input.sftp-path-input'),
        pendingNav: window.__sftpGate.pending(c => c.cmd === 'sftp-readdir').length,
      }))()`);
      const u02CloseEditor = () => cdp.eval(`(() => {
        const i = document.querySelector('#sftp-breadcrumb input.sftp-path-input');
        if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return !document.querySelector('#sftp-breadcrumb input.sftp-path-input');
      })()`);
      const u02Center = (sel) => cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
      })()`);
      // Panel state after H): open on A at /srv/app — root + two segments +
      // separators on screen, and a dry gate.
      const u02Pre = await cdp.eval(`(() => ({
        open: document.getElementById('overlay-sftp').classList.contains('open'),
        path: SFTP._path,
        seps: document.querySelectorAll('#sftp-breadcrumb .sep').length,
        pending: window.__sftpGate.pending().length,
      }))()`);
      // Non-segment single clicks still open the editor: a separator, the
      // "…" crumb (produced by the real overflow collapse) and blank bar
      // space — none may start a navigation.
      const sepPos = await u02Center('#sftp-breadcrumb .sep');
      let afterSep = null, sepClosed = false;
      if (sepPos) {
        await u02ClickAt(sepPos.x, sepPos.y);
        afterSep = await u02EditorState();
        sepClosed = afterSep.editor ? await u02CloseEditor() : false;
      }
      const blankPos = await cdp.eval(`(() => {
        const bar = document.getElementById('sftp-pathbar');
        const bc = document.getElementById('sftp-breadcrumb');
        if (!bar || !bc) return null;
        const pr = bar.getBoundingClientRect(), cr = bc.getBoundingClientRect();
        const x = Math.min(pr.right - 8, cr.right + 12);
        return x > cr.right ? { x: Math.round(x), y: Math.round(pr.top + pr.height / 2) } : null;
      })()`);
      let afterBlank = null, blankClosed = false;
      if (blankPos) {
        await u02ClickAt(blankPos.x, blankPos.y);
        afterBlank = await u02EditorState();
        blankClosed = afterBlank.editor ? await u02CloseEditor() : false;
      }
      // Force the real overflow collapse to expose the "…" crumb.
      const moreShrunk = await cdp.eval(`(() => {
        const bc = document.getElementById('sftp-breadcrumb');
        bc.style.maxWidth = '64px';
        SFTP._renderBreadcrumb();
        return !!bc.querySelector('.more');
      })()`);
      const morePos = moreShrunk ? await u02Center('#sftp-breadcrumb .more') : null;
      let afterMore = null, moreClosed = false;
      if (morePos) {
        await u02ClickAt(morePos.x, morePos.y);
        afterMore = await u02EditorState();
        moreClosed = afterMore.editor ? await u02CloseEditor() : false;
      }
      await cdp.eval(`(() => { const bc = document.getElementById('sftp-breadcrumb'); bc.style.maxWidth = ''; SFTP._renderBreadcrumb(); return true; })()`);
      check('SFTP 面包屑：分隔符/「…」/空白单击仍进入路径编辑（不导航，U-02 对照）',
        u02Pre.open === true && u02Pre.path === '/srv/app' && u02Pre.seps >= 1 && u02Pre.pending === 0 &&
        !!sepPos && !!afterSep && afterSep.editor === true && afterSep.pendingNav === 0 && sepClosed === true &&
        !!blankPos && !!afterBlank && afterBlank.editor === true && afterBlank.pendingNav === 0 && blankClosed === true &&
        moreShrunk === true && !!morePos && !!afterMore && afterMore.editor === true && afterMore.pendingNav === 0 && moreClosed === true,
        JSON.stringify({ u02Pre, sepPos, afterSep, blankPos, afterBlank, moreShrunk, morePos, afterMore }));
      // Double-click anywhere still edits: on the icon itself the gesture's
      // first click starts the real navigation to /, and the dblclick entry
      // must preempt it (the pending readdir goes stale) and open the editor.
      const iconPosDbl = await u02Center('#sftp-breadcrumb .seg-root svg');
      let afterDbl = null, dblNav = 0, dblClosed = false;
      if (iconPosDbl) {
        await u02ClickAt(iconPosDbl.x, iconPosDbl.y, 2);
        afterDbl = await u02EditorState();
        dblNav = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/').length`);
        for (let i = 0; i < dblNav; i++) {
          await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/', { files: [] })`);
        }
        dblClosed = afterDbl.editor ? await u02CloseEditor() : false;
      }
      check('SFTP 面包屑：根目录图标双击仍打开路径编辑器并抢占首次单击的导航',
        !!iconPosDbl && !!afterDbl && afterDbl.editor === true && dblNav >= 1 && dblClosed === true,
        JSON.stringify({ iconPosDbl, afterDbl, dblNav }));
      // THE regression pin: a single real click on the root icon navigates
      // to / and never opens the editor. Pre-fix the same click's real
      // target was the SVG, the guard missed it, and the bar's edit branch
      // preempted the just-started navigation — editor on screen and the
      // listing never moved.
      const iconPos = await u02Center('#sftp-breadcrumb .seg-root svg');
      const iconHit = iconPos ? await cdp.eval(`(() => {
        const el = document.elementFromPoint(${iconPos.x}, ${iconPos.y});
        return el ? { tag: el.tagName, inSeg: !!el.closest('.seg') } : null;
      })()`) : null;
      let afterIcon = null;
      if (iconPos) {
        await u02ClickAt(iconPos.x, iconPos.y);
        afterIcon = await cdp.eval(`(() => {
          const nav = window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/')[0] || null;
          return {
            editor: !!document.querySelector('#sftp-breadcrumb input.sftp-path-input'),
            nav: nav ? { tabId: nav.args.tabId, path: nav.args.path } : null,
          };
        })()`);
        await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/', { files: [{ name: 'root-note.txt', isDir: false, size: 1, mtime: 0 }] })`);
      }
      await sleep(300);
      const rootRendered = await cdp.eval(`(() => ({
        path: SFTP._path,
        seps: document.querySelectorAll('#sftp-breadcrumb .sep').length,
        rows: [...document.querySelectorAll('#sftp-body .sftp-item-name')].map(e => e.textContent),
      }))()`);
      check('SFTP 面包屑：根目录图标真实单击导航到 / 且不打开路径编辑器（U-02）',
        !!iconPos && !!iconHit && iconHit.inSeg === true && !!afterIcon &&
        afterIcon.editor === false && !!afterIcon.nav && afterIcon.nav.tabId === A && afterIcon.nav.path === '/' &&
        rootRendered.path === '/' && rootRendered.seps === 0 && rootRendered.rows.includes('root-note.txt'),
        JSON.stringify({ iconPos, iconHit, afterIcon, rootRendered }));

      // J) Per-tab open-state model: the dock is shown ONLY on a frontend tab
      //    the user explicitly opened SFTP on. Switching to an SSH tab that
      //    never opened it shows no dock and fires no request; switching back
      //    restores the dock at the remembered directory. Two synthetic tabs
      //    (never wired to a backend; their session ids stay inside the gate)
      //    ride the REAL switchTo → SFTP.updateTarget reflection path.
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`(() => {
        // Deterministic staging: drop the earlier subsections' per-session
        // memories and per-tab open states (fixture reset, not product path).
        SFTP._lastPath = {}; SFTP._openTabs.clear();
        TabManager.tabs.push({ id: 'e2e-ft-a', type: 'ssh', tabId: ${JSON.stringify(A)}, name: 'E2E-FTA', connected: true });
        TabManager.tabs.push({ id: 'e2e-ft-b', type: 'ssh', tabId: ${JSON.stringify(B)}, name: 'E2E-FTB', connected: true });
        TabManager.render();
        TabManager.switchTo('e2e-ft-a');
        return TabManager.activeId;
      })()`);
      await sleep(300);
      // Open the dock on tab A through the real bar toggle, then browse away
      // from home so the remembered directory is observable.
      await cdp.eval(`SFTP.toggleFromBar()`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [] })`);
      await sleep(300);
      await cdp.eval(`window.__sftpGate.run('per-tab-nav', () => SFTP.navigate('/srv/app/deep'))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app/deep').length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app/deep', { files: [] })`);
      await sleep(300);
      const perTabOpenA = await cdp.eval(`(() => ({ open: SFTP.isOpen, tabId: SFTP._tabId, inSet: SFTP._openTabs.has('e2e-ft-a') }))()`);
      check('SFTP 每标签：A 上显式打开后 dock 绑定 A',
        perTabOpenA.open === true && perTabOpenA.tabId === A && perTabOpenA.inSet === true,
        JSON.stringify(perTabOpenA));

      // Switch to tab B (never opened): no dock, no sftp-open for B, A's state kept.
      await cdp.eval(`TabManager.switchTo('e2e-ft-b')`);
      await sleep(300);
      const perTabHidden = await cdp.eval(`(() => ({
        open: SFTP.isOpen,
        bOpens: window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(B)}).length,
        aKept: SFTP._openTabs.has('e2e-ft-a'),
      }))()`);
      check('SFTP 每标签：切到未打开过的 B 隐藏 dock 且不发 sftp-open',
        perTabHidden.open === false && perTabHidden.bOpens === 0 && perTabHidden.aKept === true,
        JSON.stringify(perTabHidden));

      // Back to A: the dock restores at the remembered directory (a readdir
      // resume, not a fresh sftp-open at the remote home).
      await cdp.eval(`TabManager.switchTo('e2e-ft-a')`);
      const perTabRestorePending = await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app/deep').length`, 1, 5000);
      const perTabNoFreshOpen = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app/deep', { files: [] })`);
      await sleep(300);
      const perTabRestore = await cdp.eval(`(() => ({ open: SFTP.isOpen, tabId: SFTP._tabId, path: SFTP._path }))()`);
      check('SFTP 每标签：切回 A 恢复 dock 并回到记忆目录',
        perTabRestorePending === 1 && perTabNoFreshOpen === 0 &&
        perTabRestore.open === true && perTabRestore.tabId === A && perTabRestore.path === '/srv/app/deep',
        JSON.stringify({ perTabRestorePending, perTabNoFreshOpen, perTabRestore }));

      // Close on A (the header × path through the public close): the tab
      // leaves the open set — leaving and returning shows no dock (per-tab
      // close, not a global toggle).
      await cdp.eval(`SFTP.close()`);
      await sleep(200);
      await cdp.eval(`TabManager.switchTo('e2e-ft-b')`);
      await sleep(200);
      await cdp.eval(`TabManager.switchTo('e2e-ft-a')`);
      await sleep(300);
      const perTabClosed = await cdp.eval(`(() => ({ open: SFTP.isOpen, aOpen: SFTP._openTabs.has('e2e-ft-a') }))()`);
      check('SFTP 每标签：A 上关闭后切回 A 无 dock', perTabClosed.open === false && perTabClosed.aOpen === false, JSON.stringify(perTabClosed));

      // K) Row/blank context menu (right-click): select + menu only — the
      //    gesture must never trigger the row's left-click semantics
      //    (navigate / download). File rows offer download/rename/delete,
      //    directory rows open/rename/delete, ".." nothing; actions carry the snapshot
      //    captured at right-click ({tabId, path, name, isDir}).
      // Fresh-open staging (see B): J left remembered paths, which would
      // turn this open(A) into a restore readdir instead of a fresh open.
      await cdp.eval(`SFTP.close(); SFTP._lastPath = {}; SFTP._pinned = {}; SFTP._pinnedPath = {};`);
      await sleep(200);
      await cdp.eval(`window.__sftpGate.run('menu-open-a', () => SFTP.open(${JSON.stringify(A)}))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}).length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-open' && c.args.tabId === ${JSON.stringify(A)}, { path: '/srv/app', files: [
        { name: 'notes.txt', isDir: false, size: 5, mtime: 0 },
        { name: 'assets', isDir: true, size: 0, mtime: 0 },
      ] })`);
      await sleep(300);
      const menuRows = () => `[...document.querySelectorAll('#sftp-body .sftp-item')]`;
      const captureContextShot = async (name) => {
        const dir = process.env.ZTERM_E2E_SHOTS || '';
        if (!dir) return;
        await cdp.send('Page.enable').catch(() => {});
        const image = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (image?.data) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name + '.png'), Buffer.from(image.data, 'base64'));
        } else {
          console.log(`[e2e] context screenshot unavailable: ${name}`);
        }
      };
      const rowMenuProbe = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => r.querySelector('.sftp-item-dl') && r.textContent.includes('notes.txt'));
        if (!row) return { ok: false, why: 'no-row' };
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 });
        row.dispatchEvent(ev);
        const menu = document.getElementById('app-context-menu');
        return {
          ok: true,
          prevented: ev.defaultPrevented,
          selected: row.classList.contains('selected'),
          labels: menu ? [...menu.children].map(c => c.textContent) : null,
          role: menu ? menu.getAttribute('role') : null,
          pendingNav: window.__sftpGate.pending(c => c.cmd === 'sftp-readdir').length,
          pendingSave: window.__sftpGate.pending(c => c.cmd === 'show-save-dialog').length,
        };
      })()`);
      check('SFTP 右键：文件行=选中+下载/重命名/删除菜单，不触发导航/下载',
        rowMenuProbe.ok === true && rowMenuProbe.prevented === true && rowMenuProbe.selected === true &&
        Array.isArray(rowMenuProbe.labels) && rowMenuProbe.labels.join() === '下载,重命名,删除' &&
        rowMenuProbe.role === 'menu' && rowMenuProbe.pendingNav === 0 && rowMenuProbe.pendingSave === 0,
        JSON.stringify(rowMenuProbe));
      // Screenshot of the APPLICATION menu for visual review — it documents
      // the in-app menu only; native-menu disablement is proven by the
      // getter read-back (0.5) and DOM defaultPrevented, not by this image.
      await captureContextShot('sftp-row-context-menu');

      const dirMenuProbe = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => !r.querySelector('.sftp-item-dl') && r.textContent.includes('assets'));
        const up = ${menuRows()}.find(r => r.textContent.trim() === '..');
        if (!row || !up) return { ok: false, why: 'no-rows' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 90 }));
        const dirMenu = document.getElementById('app-context-menu');
        const dirLabels = dirMenu ? [...dirMenu.children].map(c => c.textContent) : null;
        const upEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
        up.dispatchEvent(upEv);
        const menuAfterUp = document.getElementById('app-context-menu');
        return { ok: true, dirLabels, upPrevented: upEv.defaultPrevented, menuAfterUp: !!menuAfterUp };
      })()`);
      check('SFTP 右键：目录行=打开/重命名/删除，".." 不可变更且不弹菜单',
        dirMenuProbe.ok === true && Array.isArray(dirMenuProbe.dirLabels) &&
        dirMenuProbe.dirLabels.join() === '打开,重命名,删除' &&
        dirMenuProbe.upPrevented === true && dirMenuProbe.menuAfterUp === false,
        JSON.stringify(dirMenuProbe));

      const blankMenuProbe = await cdp.eval(`(() => {
        const body = document.getElementById('sftp-body');
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 320 });
        body.dispatchEvent(ev);
        const menu = document.getElementById('app-context-menu');
        return { prevented: ev.defaultPrevented, labels: menu ? [...menu.children].map(c => c.textContent) : null };
      })()`);
      check('SFTP 右键：列表空白=新建目录/上传/刷新',
        blankMenuProbe.prevented === true && Array.isArray(blankMenuProbe.labels) &&
        blankMenuProbe.labels.join() === '新建目录,上传,刷新',
        JSON.stringify(blankMenuProbe));
      await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'menu-closed'; })()`);

      // Rename through the menu: inline editor commits sftp-rename with the
      // snapshot captured at right-click, then refreshes the owning view.
      const renameStart = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => r.querySelector('.sftp-item-dl') && r.textContent.includes('notes.txt'));
        if (!row) return { ok: false, why: 'no-row' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }));
        const menu = document.getElementById('app-context-menu');
        const item = menu && [...menu.children].find(c => c.textContent === '重命名');
        if (!item) return { ok: false, why: 'no-item' };
        item.click();
        const input = row.querySelector('input.sftp-rename-input');
        return { ok: !!input, prefill: input ? input.value : null };
      })()`);
      await sleep(200);
      await captureContextShot('sftp-inline-rename');
      await cdp.eval(`(() => {
        const input = document.querySelector('#sftp-body input.sftp-rename-input');
        if (!input) return 'no-editor';
        input.value = 'diary.txt';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return 'committed';
      })()`);
      await sleep(300);
      const renameCall = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-rename')[0] || null`);
      check('SFTP 右键：重命名内联编辑以快照提交 sftp-rename',
        renameStart.ok === true && renameStart.prefill === 'notes.txt' && !!renameCall &&
        renameCall.args.tabId === A && renameCall.args.oldPath === '/srv/app/notes.txt' && renameCall.args.newPath === '/srv/app/diary.txt',
        JSON.stringify({ renameStart, renameCall }));
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-rename', { ok: true })`);
      await sleep(300);
      const renameRefresh = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app').length`);
      check('SFTP 右键：重命名成功后刷新所属视图', renameRefresh === 1, `pending readdir=${renameRefresh}`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [
        { name: 'diary.txt', isDir: false, size: 5, mtime: 0 },
        { name: 'assets', isDir: true, size: 0, mtime: 0 },
      ] })`);
      await sleep(300);

      // Delete: showConfirm (cancel-focused by default) gates sftp-remove.
      const delCancel = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => r.querySelector('.sftp-item-dl') && r.textContent.includes('diary.txt'));
        if (!row) return { ok: false, why: 'no-row' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }));
        const menu = document.getElementById('app-context-menu');
        const item = menu && [...menu.children].find(c => c.textContent === '删除');
        if (!item) return { ok: false, why: 'no-item' };
        item.click();
        return {
          ok: true,
          overlayOpen: document.getElementById('overlay-confirm').classList.contains('open'),
          msg: document.getElementById('confirm-msg').textContent,
          cancelFocused: document.activeElement === document.getElementById('confirm-cancel'),
          pendingRemove: window.__sftpGate.pending(c => c.cmd === 'sftp-remove').length,
        };
      })()`);
      check('SFTP 右键：删除走 showConfirm、默认焦点取消、未确认不调用',
        delCancel.ok === true && delCancel.overlayOpen === true && delCancel.msg.includes('diary.txt') &&
        delCancel.cancelFocused === true && delCancel.pendingRemove === 0,
        JSON.stringify(delCancel));
      await captureContextShot('sftp-delete-confirm');
      await cdp.eval(`(() => { document.getElementById('confirm-cancel').click(); return 'cancelled'; })()`);
      await sleep(200);
      const afterCancel = await cdp.eval(`(() => ({
        confirmClosed: !document.getElementById('overlay-confirm').classList.contains('open'),
        pendingRemove: window.__sftpGate.pending(c => c.cmd === 'sftp-remove').length,
      }))()`);
      const delOkPath = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => r.querySelector('.sftp-item-dl') && r.textContent.includes('diary.txt'));
        if (!row) return { ok: false, why: 'no-row' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }));
        const menu = document.getElementById('app-context-menu');
        const item = menu && [...menu.children].find(c => c.textContent === '删除');
        if (!item) return { ok: false, why: 'no-item' };
        item.click();
        document.getElementById('confirm-ok').click();
        return { ok: true };
      })()`);
      await sleep(300);
      const removeCall = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-remove')[0] || null`);
      check('SFTP 右键：确认后 sftp-remove 按快照调用，取消路径未调用',
        delOkPath.ok === true && afterCancel.confirmClosed === true && afterCancel.pendingRemove === 0 &&
        !!removeCall && removeCall.args.tabId === A && removeCall.args.path === '/srv/app/diary.txt' && removeCall.args.isDir === false,
        JSON.stringify({ afterCancel, delOkPath, removeCall }));
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-remove', { ok: true })`);
      await sleep(300);
      const removeRefresh = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app').length`);
      check('SFTP 右键：删除成功后刷新所属视图', removeRefresh === 1, `pending readdir=${removeRefresh}`);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [{ name: 'assets', isDir: true, size: 0, mtime: 0 }] })`);
      await sleep(300);

      // Directory delete names the empty-directory contract and routes to
      // rmdir (isDir); a server refusal keeps the listing usable.
      const dirDel = await cdp.eval(`(() => {
        const row = ${menuRows()}.find(r => !r.querySelector('.sftp-item-dl') && r.textContent.includes('assets'));
        if (!row) return { ok: false, why: 'no-row' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 90 }));
        const menu = document.getElementById('app-context-menu');
        const item = menu && [...menu.children].find(c => c.textContent === '删除');
        if (!item) return { ok: false, why: 'no-item' };
        item.click();
        return { ok: true, msg: document.getElementById('confirm-msg').textContent };
      })()`);
      await cdp.eval(`(() => { if (document.getElementById('overlay-confirm').classList.contains('open')) document.getElementById('confirm-ok').click(); return 'ok'; })()`);
      await sleep(300);
      const dirRemoveCall = await cdp.eval(`window.__sftpGate.pending(c => c.cmd === 'sftp-remove')[0] || null`);
      check('SFTP 右键：目录删除明确空目录约束并按 isDir 走 rmdir',
        dirDel.ok === true && dirDel.msg.includes('assets') && dirDel.msg.includes('空目录') &&
        !!dirRemoveCall && dirRemoveCall.args.isDir === true && dirRemoveCall.args.path === '/srv/app/assets',
        JSON.stringify({ dirDel, dirRemoveCall }));
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-remove', { error: 'failure (not empty)' })`);
      await sleep(300);
      const dirRefused = await cdp.eval(`(() => ({
        rowsStillListed: document.querySelectorAll('#sftp-body .sftp-item').length,
        confirmClosed: !document.getElementById('overlay-confirm').classList.contains('open'),
      }))()`);
      check('SFTP 右键：非空目录被服务端拒绝后列表仍可用', dirRefused.rowsStillListed >= 1 && dirRefused.confirmClosed === true,
        JSON.stringify(dirRefused));
      await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'k-menu-closed'; })()`);

      // Stage the listing so a FILE row (with its hover download button) and
      // a DIRECTORY row are both present for the real-pointer probes below.
      await cdp.eval(`window.__sftpGate.run('stage-l', () => SFTP.navigate('/srv/app'))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app').length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [
        { name: 'rowfile.txt', isDir: false, size: 4, mtime: 0 },
        { name: 'rowdir', isDir: true, size: 0, mtime: 0 },
      ] })`);
      await sleep(300);

      // L) REAL pointer right-clicks (CDP Input domain). A bubble-end
      //    listener records defaultPrevented AFTER every handler ran; each
      //    target's menu is asserted by its SPECIFIC item labels (a bare
      //    "3 items" count could pass with the wrong menu).
      await cdp.eval(`(() => {
        window.__ctxEnd = { prevented: null, fired: 0 };
        document.addEventListener('contextmenu', (e) => {
          window.__ctxEnd.fired++;
          Promise.resolve().then(() => { window.__ctxEnd.prevented = e.defaultPrevented; });
        }, true);
        return 'armed';
      })()`);
      const centerOf = async (js) => await cdp.eval(`(() => {
        const el = ${js};
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      const realRightAt = async (pos) => {
        if (!pos) return { pos: null };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'right', buttons: 2, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'right', buttons: 2, clickCount: 1 });
        await sleep(350);
        const state = await cdp.eval(`(() => {
          const menu = document.getElementById('app-context-menu');
          return {
            prevented: window.__ctxEnd.prevented,
            fired: window.__ctxEnd.fired,
            open: !!menu,
            labels: menu ? [...menu.children].map(c => c.textContent) : null,
          };
        })()`);
        return { pos, ...state };
      };
      const realRightOn = async (js, keepMenu) => {
        const state = await realRightAt(await centerOf(js));
        if (!keepMenu) await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'closed'; })()`);
        return state;
      };

      // L1) A FILE row (carries the hover download button) → file menu.
      const fileRowReal = await realRightOn(`${menuRows()}.find(r => r.querySelector('.sftp-item-dl'))`, true);
      const fileMenuBounds = await cdp.eval(`(() => {
        const menu = document.getElementById('app-context-menu');
        if (!menu) return { bounded: false };
        const r = menu.getBoundingClientRect();
        return { bounded: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
      })()`);
      await captureContextShot('sftp-pointer-context-menu');
      check('SFTP 真实指针：文件行右键=下载/重命名/删除且 defaultPrevented',
        fileRowReal.pos !== null && fileRowReal.fired >= 1 && fileRowReal.prevented === true &&
        Array.isArray(fileRowReal.labels) && fileRowReal.labels.join() === '下载,重命名,删除' && fileMenuBounds.bounded === true,
        JSON.stringify({ fileRowReal, fileMenuBounds }));
      await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'closed'; })()`);

      // L2) A DIRECTORY row (no download button) → directory menu.
      const dirRowReal = await realRightOn(`${menuRows()}.find(r => !r.querySelector('.sftp-item-dl') && r.textContent.trim() !== '..')`);
      check('SFTP 真实指针：目录行右键=打开/重命名/删除且 defaultPrevented',
        dirRowReal.pos !== null && dirRowReal.prevented === true &&
        Array.isArray(dirRowReal.labels) && dirRowReal.labels.join() === '打开,重命名,删除',
        JSON.stringify(dirRowReal));

      // L3) The blank area BELOW the rows (actual coordinates inside
      //     sftp-body under the last row) → the directory-level menu.
      const blankMenuPos = await cdp.eval(`(() => {
        const body = document.getElementById('sftp-body');
        if (!body) return null;
        const r = body.getBoundingClientRect();
        // Below the rows, inside the body's lower-left corner.
        return { x: Math.round(r.left + 30), y: Math.round(r.bottom - 8) };
      })()`);
      const blankReal = await realRightAt(blankMenuPos);
      check('SFTP 真实指针：列表空白右键=新建目录/上传/刷新且 defaultPrevented',
        blankReal.pos !== null && blankReal.prevented === true &&
        Array.isArray(blankReal.labels) && blankReal.labels.join() === '新建目录,上传,刷新',
        JSON.stringify(blankReal));
      await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'closed'; })()`);

      // L4) The empty-directory message itself is blank-area territory: an
      //     empty listing still offers the directory menu (real event chain,
      //     right-click ON the .sftp-empty child).
      // The empty-directory message only renders at the ROOT — a non-root empty
      // directory still shows the ".." row (which is its own right-click
      // territory), so the empty-message probe navigates to "/".
      await cdp.eval(`window.__sftpGate.run('empty-nav', () => SFTP.navigate('/'))`);
      await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/').length`, 1, 5000);
      await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/', { files: [] })`);
      await sleep(300);
      const emptyReal = await realRightOn(`document.querySelector('#sftp-body .sftp-empty')`);
      check('SFTP 真实指针：空目录提示右键仍给目录菜单',
        emptyReal.pos !== null && emptyReal.prevented === true &&
        Array.isArray(emptyReal.labels) && emptyReal.labels.join() === '新建目录,上传,刷新',
        JSON.stringify(emptyReal));

      // L5) Rename editor under the real event chain: a real CLICK on the
      //     editor must not trigger the row's left-click semantics, a real
      //     right-click opens the TEXT menu without closing the editor, and
      //     a menu paste keeps the editor alive (no blur-cancel, no commit).
      //     Clipboard IPC is mocked at the invoke boundary — the system
      //     clipboard is never touched here.
      await cdp.eval(`(() => {
        window.__clipPrevInvoke = ipcRenderer.invoke.bind(ipcRenderer);
        window.__clipMock = { text: 'PASTED', writes: [] };
        ipcRenderer.invoke = (cmd, args) => {
          if (cmd === 'clipboard-read-text') return Promise.resolve(window.__clipMock.text);
          if (cmd === 'clipboard-write-text') { window.__clipMock.writes.push(args && args.text); return Promise.resolve({ ok: true }); }
          return window.__clipPrevInvoke(cmd, args);
        };
        return 'clip-mock-armed';
      })()`);
      let renameChain = null;
      try {
        await cdp.eval(`window.__sftpGate.run('back-a', () => SFTP.navigate('/srv/app'))`);
        await waitForValue(cdp, `window.__sftpGate.pending(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app').length`, 1, 5000);
        await cdp.eval(`window.__sftpGate.settle(c => c.cmd === 'sftp-readdir' && c.args.path === '/srv/app', { files: [
          { name: 'chain.txt', isDir: false, size: 3, mtime: 0 },
        ] })`);
        await sleep(300);
        // Open the rename editor through the real menu.
        await cdp.eval(`(() => {
          const row = ${menuRows()}.find(r => r.querySelector('.sftp-item-dl'));
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }));
          const menu = document.getElementById('app-context-menu');
          [...menu.children].find(c => c.textContent === '重命名').click();
          return 'editor-open';
        })()`);
        await sleep(200);
        const editorPos = await centerOf(`document.querySelector('#sftp-body input.sftp-rename-input')`);
        let clickLeak = null;
        if (editorPos) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editorPos.x, y: editorPos.y, button: 'left', buttons: 1, clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editorPos.x, y: editorPos.y, button: 'left', buttons: 1, clickCount: 1 });
          await sleep(300);
          clickLeak = await cdp.eval(`(() => ({
            editorOpen: !!document.querySelector('#sftp-body input.sftp-rename-input'),
            nav: window.__sftpGate.pending(c => c.cmd === 'sftp-readdir').length,
            save: window.__sftpGate.pending(c => c.cmd === 'show-save-dialog').length,
          }))()`);
        }
        // Real right-click on the editor → the TEXT menu replaces the row
        // menu, and the editor (still holding DOM focus) stays open.
        const editorMenu = await realRightAt(editorPos);
        const focusHeld = await cdp.eval(`(() => {
          const i = document.querySelector('#sftp-body input.sftp-rename-input');
          return { editorOpen: !!i, focused: i === document.activeElement };
        })()`);
        // Paste through the menu: the mocked clipboard delivers 'PASTED';
        // the editor had its name selected, so the paste replaces it.
        await cdp.eval(`(() => {
          const i = document.querySelector('#sftp-body input.sftp-rename-input');
          i.dataset.evtInput = 0; i.dataset.evtChange = 0;
          i.addEventListener('input', () => i.dataset.evtInput++);
          i.addEventListener('change', () => i.dataset.evtChange++);
          const menu = document.getElementById('app-context-menu');
          const paste = menu && [...menu.children].find(c => c.textContent === '粘贴');
          if (paste) paste.click();
          return paste ? 'clicked' : 'no-paste-item';
        })()`);
        await sleep(400);
        const afterPaste = await cdp.eval(`(() => {
          const i = document.querySelector('#sftp-body input.sftp-rename-input');
          return {
            editorOpen: !!i,
            value: i ? i.value : null,
            inputs: i ? Number(i.dataset.evtInput || 0) : 0,
            changes: i ? Number(i.dataset.evtChange || 0) : 0,
            renameInvoked: window.__sftpGate.pending(c => c.cmd === 'sftp-rename').length,
          };
        })()`);
        // IME Enter must not commit.
        await cdp.eval(`(() => {
          const i = document.querySelector('#sftp-body input.sftp-rename-input');
          if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
          return 'ime-enter';
        })()`);
        await sleep(200);
        const afterIme = await cdp.eval(`(() => ({
          editorOpen: !!document.querySelector('#sftp-body input.sftp-rename-input'),
          renameInvoked: window.__sftpGate.pending(c => c.cmd === 'sftp-rename').length,
        }))()`);
        // Escape cancels cleanly; nothing was ever invoked.
        await cdp.eval(`(() => {
          const i = document.querySelector('#sftp-body input.sftp-rename-input');
          if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          return 'esc';
        })()`);
        await sleep(200);
        const afterEsc = await cdp.eval(`(() => ({
          editorOpen: !!document.querySelector('#sftp-body input.sftp-rename-input'),
          renameInvoked: window.__sftpGate.pending(c => c.cmd === 'sftp-rename').length,
        }))()`);
        renameChain = { editorPos, clickLeak, editorMenu, focusHeld, afterPaste, afterIme, afterEsc };
      } finally {
        await cdp.eval(`(() => { ipcRenderer.invoke = window.__clipPrevInvoke; delete window.__clipPrevInvoke; delete window.__clipMock; return 'clip-mock-restored'; })()`).catch(() => null);
      }
      check('SFTP 重命名编辑链：真实点击不触发行语义、右键文本菜单不夺焦、粘贴可继续编辑',
        renameChain && renameChain.editorPos !== null &&
        renameChain.clickLeak && renameChain.clickLeak.editorOpen === true &&
        renameChain.clickLeak.nav === 0 && renameChain.clickLeak.save === 0 &&
        renameChain.editorMenu.prevented === true &&
        Array.isArray(renameChain.editorMenu.labels) && renameChain.editorMenu.labels.join() === '剪切,复制,粘贴,全选' &&
        renameChain.focusHeld.editorOpen === true && renameChain.focusHeld.focused === true &&
        // The real click collapsed the select-all to a caret, so the paste
        // INSERTS at it: assert the inserted text, the exact event counts,
        // and that the editor survived (no blur-cancel, no commit).
        renameChain.afterPaste.editorOpen === true &&
        String(renameChain.afterPaste.value).includes('PASTED') &&
        renameChain.afterPaste.inputs === 1 && renameChain.afterPaste.changes === 1 &&
        renameChain.afterPaste.renameInvoked === 0 &&
        renameChain.afterIme.editorOpen === true && renameChain.afterIme.renameInvoked === 0 &&
        renameChain.afterEsc.editorOpen === false && renameChain.afterEsc.renameInvoked === 0,
        JSON.stringify(renameChain));

      // Fixture teardown: null the synthetic session ids first so the real
      // closeTab never sends backend events for the synthetic sessions.
      await cdp.eval(`(() => {
        for (const id of ['e2e-ft-a', 'e2e-ft-b']) {
          const t = TabManager.tabs.find(x => x.id === id);
          if (t) { t.tabId = null; try { TabManager.closeTab(id); } catch (e) {} }
        }
        return true;
      })()`);
      await sleep(500);

      // Unexpected action rejections recorded by the gate fail the section
      // explicitly instead of dying as background console errors.
      const sftpGateErrors = await cdp.eval(`window.__sftpGate ? window.__sftpGate.errors.slice() : ['gate-missing']`);
      check('SFTP 归属：fixture 未记录未预期的动作拒绝', Array.isArray(sftpGateErrors) && sftpGateErrors.length === 0, JSON.stringify(sftpGateErrors));
    } finally {
      // Phase 1 (gate still armed): mark cleanup so rejections caused by the
      // unwinding itself are expected, then reject every still-pending synthetic
      // call — bounded rounds absorb follow-up requests the rejections trigger,
      // so no gated promise is left hanging and none escapes to the backend.
      let drainInfo = null;
      for (let round = 0; round < 5; round++) {
        drainInfo = await cdp.eval(`(() => {
          const g = window.__sftpGate;
          if (!g) return { gate: false, pending: -1 };
          g.cleanup = true;
          const open = g.log.filter(c => !c.settled);
          for (const c of open) { c.settled = true; try { c.reject(new Error('e2e sftp section end')); } catch (e) {} }
          return { gate: true, pending: open.length };
        })()`).catch(e => ({ gate: false, pending: -1, evalError: String(e && e.message || e) }));
        if (!drainInfo || drainInfo.pending <= 0) break;
        await sleep(200);
      }
      // Phase 2: restore the real invoke and the owned fixture state, and VERIFY
      // the restore — an unconfirmed restore must fail the gate, not pass
      // silently as a clean run.
      const sftpRestore = await cdp.eval(`(() => {
        const g = window.__sftpGate;
        const r = { gate: !!g, invokeRestored: false, pendingAtRestore: -1, stateReset: false, errors: g ? g.errors.slice() : ['gate-missing'] };
        if (g && window.__sftpOrigInvoke) {
          ipcRenderer.invoke = window.__sftpOrigInvoke;
          r.invokeRestored = ipcRenderer.invoke === window.__sftpOrigInvoke;
          r.pendingAtRestore = g.log.filter(c => !c.settled).length;
        }
        try {
          SFTP.close();
          SFTP._pinned = {}; SFTP._pinnedPath = {};
          SFTP._openTabs.clear(); SFTP._lastPath = {};
          SFTP._editingPath = false; SFTP._viewReq = null; SFTP._refreshInFlight = null; SFTP._refreshQueued = null;
          TransferManager._transfers = []; TransferManager._history = [];
          try { TransferManager._render(); } catch (e) { r.renderError = String(e && e.message || e); }
          // The state reset must also resync the bar button (fixture state,
          // not a user action — clearDone() would keep active transfers).
          try { TransferManager._syncButtonVisibility(); } catch (e) { r.syncError = String(e && e.message || e); }
          r.stateReset = true;
        } catch (e) { r.stateError = String(e && e.message || e); }
        delete window.__sftpGate; delete window.__sftpOrigInvoke;
        return r;
      })()`).catch(e => ({ evalError: String(e && e.message || e) }));
      check('SFTP 归属：fixture 清理完成且原 invoke 恢复经过验证',
        !!sftpRestore && sftpRestore.invokeRestored === true && sftpRestore.stateReset === true &&
        sftpRestore.pendingAtRestore === 0 && Array.isArray(sftpRestore.errors) && sftpRestore.errors.length === 0,
        JSON.stringify({ drainInfo, sftpRestore }));
      await sleep(300);
    }

    // 13.5 xterm keyboard→onData path (regression guard for the
    // attachCustomKeyEventHandler semantics: an inverted pass-through return
    // value swallows every key). Synthetic lowercase keydown is reliable on
    // xterm 5 (uppercase/symbols drop massively — do not widen the charset);
    // PTY→echo→buffer is covered by 9.5.
    const inputProbe = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(t => t.type === 'local');
      if (!tab?.term?.textarea) return { ok: false, why: 'no-textarea' };
      window.__inData = '';
      tab.term.onData(d => { window.__inData += d; });
      tab.term.textarea.focus();
      const fire = (key, code, keyCode) => {
        tab.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true, cancelable: true }));
      };
      fire('x', 'KeyX', 88);
      fire('y', 'KeyY', 89);
      fire('Enter', 'Enter', 13);
      return { ok: true };
    })()`).catch(() => ({ ok: false, why: 'eval-fail' }));
    await sleep(800);
    const gotInput = await cdp.eval(`window.__inData || ''`).catch(() => '');
    const inputOk = inputProbe.ok === true && gotInput.includes('x') && gotInput.includes('y') && gotInput.includes('\r');
    check('xterm 键盘链路：合成按键→onData 编码', inputOk === true, inputProbe.why || JSON.stringify(gotInput));

    // 13.5b In-app text-edit context menu: with the native menus disabled,
    //      plain inputs expose cut/copy/paste/select-all. The clipboard IPC is
    //      MOCKED at the invoke boundary for this whole section — the system
    //      clipboard is never read or written here (a real read failure used
    //      to fall back to writing; the mock cannot lose user data and makes
    //      the failure path assertable). The original invoke is saved and
    //      restored-verified in the finally block.
    await cdp.eval(`(() => {
      window.__clipPrevInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__clipMock = { text: '', writes: [], reads: 0, failNextRead: false };
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'clipboard-read-text') {
          window.__clipMock.reads++;
          if (window.__clipMock.failNextRead) { window.__clipMock.failNextRead = false; return Promise.reject(new Error('mock clipboard down')); }
          return Promise.resolve(window.__clipMock.text);
        }
        if (cmd === 'clipboard-write-text') { window.__clipMock.writes.push(args && args.text); window.__clipMock.text = args && args.text || ''; return Promise.resolve({ ok: true }); }
        return window.__clipPrevInvoke(cmd, args);
      };
      return 'armed';
    })()`);
    let clipRestoreOk = false;
    try {
      // Probe the native editing command's REAL semantics on this engine
      // (informs the menu's edit path; insertText does not touch the
      // clipboard).
      const execProbe = await cdp.eval(`(() => {
        const mk = (type) => { const i = document.createElement('input'); if (type) i.type = type; document.body.appendChild(i); return i; };
        const text = mk(''); const num = mk('number');
        const listen = (el) => { const c = { input: 0, change: 0 }; el.addEventListener('input', () => c.input++); el.addEventListener('change', () => c.change++); return c; };
        const ct = listen(text), cn = listen(num);
        text.value = 'ab'; text.focus(); text.setSelectionRange(1, 1);
        const ins1 = document.execCommand('insertText', false, 'X');
        const afterText = { value: text.value, caret: text.selectionStart, input: ct.input, change: ct.change };
        num.value = '12'; num.focus();
        // Per spec, controls without selection support return null from
        // selectionStart (Chromium does not throw).
        let numSel = 'other';
        try { numSel = num.selectionStart === null ? 'null' : 'value'; } catch (e) { numSel = 'throws'; }
        const ins2 = document.execCommand('insertText', false, '9');
        let numSelectWorks = false;
        try { num.select(); numSelectWorks = num.selectionStart === 0; } catch (e) { numSelectWorks = false; }
        const afterNum = { value: num.value, input: cn.input, change: cn.change, numSelectWorks };
        text.remove(); num.remove();
        return { ins1, afterText, numSel, ins2, afterNum };
      })()`).catch(e => ({ error: String(e && e.message || e) }));
      check('execCommand 探针：insertText 在文本/数字控件的原生编辑语义（caret 保持、input 恰一次）',
        !execProbe.error && execProbe.ins1 === true && execProbe.afterText.value === 'aXb' &&
        execProbe.afterText.caret === 2 && execProbe.afterText.input === 1 && execProbe.afterText.change === 0 &&
        execProbe.numSel === 'null' && execProbe.ins2 === true && execProbe.afterNum.value === '129' &&
        execProbe.afterNum.input === 1 && execProbe.afterNum.change === 0,
        JSON.stringify(execProbe));

      // Real product control (the search bar input): menu shape + full
      // mocked cut→paste round trip with exact event counts.
      const textMenuProbe = await cdp.eval(`(() => {
        openSearch();
        const input = document.getElementById('search-input');
        input.value = 'menu-probe';
        input.focus();
        input.setSelectionRange(0, 4);
        input.dataset.evtInput = 0; input.dataset.evtChange = 0;
        input.addEventListener('input', () => input.dataset.evtInput++);
        input.addEventListener('change', () => input.dataset.evtChange++);
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 });
        input.dispatchEvent(ev);
        const menu = document.getElementById('app-context-menu');
        return {
          prevented: ev.defaultPrevented,
          labels: menu ? [...menu.children].map(c => ({ label: c.textContent, disabled: c.classList.contains('disabled') })) : null,
          role: menu ? menu.getAttribute('role') : null,
          focusHeld: document.activeElement === input,
        };
      })()`).catch(e => ({ error: String(e && e.message || e) }));
      check('文本右键菜单：输入框暴露 剪切/复制/粘贴/全选且不夺焦（选区驱动可用态）',
        !textMenuProbe.error && textMenuProbe.prevented === true && Array.isArray(textMenuProbe.labels) &&
        textMenuProbe.labels.map(i => i.label).join() === '剪切,复制,粘贴,全选' &&
        textMenuProbe.labels.every(i => !i.disabled) === true && textMenuProbe.role === 'menu' &&
        textMenuProbe.focusHeld === true,
        JSON.stringify(textMenuProbe));
      {
        const shotDirEnv = process.env.ZTERM_E2E_SHOTS || '';
        if (shotDirEnv) {
          const menuShot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
          if (menuShot?.data) {
            mkdirSync(shotDirEnv, { recursive: true });
            writeFileSync(join(shotDirEnv, 'text-edit-context-menu.png'), Buffer.from(menuShot.data, 'base64'));
          }
        }
      }
      const clipRoundTrip = await cdp.eval(`(async () => {
        const input = document.getElementById('search-input');
        const mock = window.__clipMock;
        input.value = 'abc';
        input.focus();
        input.setSelectionRange(0, 3);
        let ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 });
        input.dispatchEvent(ev);
        let menu = document.getElementById('app-context-menu');
        const cut = menu && [...menu.children].find(c => c.textContent === '剪切');
        if (!cut) return { ok: false, why: 'no-cut-item' };
        cut.click();
        await new Promise(r => setTimeout(r, 300));
        const afterCut = input.value;
        const clipAfterCut = mock.text;
        const writesAfterCut = mock.writes.slice();
        input.value = '';
        input.focus();
        ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 });
        input.dispatchEvent(ev);
        menu = document.getElementById('app-context-menu');
        const paste = menu && [...menu.children].find(c => c.textContent === '粘贴');
        if (!paste) return { ok: false, why: 'no-paste-item' };
        paste.click();
        await new Promise(r => setTimeout(r, 300));
        const afterPaste = input.value;
        const inputs = Number(input.dataset.evtInput || 0), changes = Number(input.dataset.evtChange || 0);
        return { ok: true, afterCut, clipAfterCut, writesAfterCut, afterPaste, inputs, changes };
      })()`).catch(e => ({ ok: false, error: String(e && e.message || e) }));
      check('文本右键菜单：剪切→(mock)剪贴板 IPC→粘贴 回到输入框（input/change 各恰一次）',
        clipRoundTrip.ok === true && clipRoundTrip.afterCut === '' &&
        clipRoundTrip.clipAfterCut === 'abc' && JSON.stringify(clipRoundTrip.writesAfterCut) === '["abc"]' &&
        clipRoundTrip.afterPaste === 'abc' && clipRoundTrip.inputs === 2 && clipRoundTrip.changes === 2,
        JSON.stringify(clipRoundTrip));

      // A clipboard IPC failure must be VISIBLE (toast), never silent.
      const clipFail = await cdp.eval(`(async () => {
        const input = document.getElementById('search-input');
        window.__clipMock.failNextRead = true;
        input.value = 'keep';
        input.focus();
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 });
        input.dispatchEvent(ev);
        const menu = document.getElementById('app-context-menu');
        [...menu.children].find(c => c.textContent === '粘贴').click();
        await new Promise(r => setTimeout(r, 300));
        const toast = document.getElementById('toast');
        return { value: input.value, toastShown: toast.classList.contains('show'), toastText: toast.textContent };
      })()`).catch(e => ({ error: String(e && e.message || e) }));
      check('文本右键菜单：剪贴板 IPC 失败给用户可见 toast',
        !clipFail.error && clipFail.value === 'keep' && clipFail.toastShown === true &&
        String(clipFail.toastText).includes('剪贴板'),
        JSON.stringify(clipFail));

      // A real type=number setting input (set-contrast): unreadable
      // selection must not offer fake cut/copy, paste goes through the
      // native edit command, and the onchange save chain runs (stubbed — no
      // user config is written).
      const numberProbe = await cdp.eval(`(async () => {
        closeSearch();
        openSettings('appearance');
        // switchSettingsTab (and its loadSettingsIntoForm) runs on a 50ms
        // timer and would overwrite the staged value — let it settle first.
        await new Promise(r => setTimeout(r, 300));
        const num = document.getElementById('set-contrast');
        if (!num) { try { closeSettingsTab(); } catch (e) {} return { ok: false, why: 'no-input' }; }
        window.__saveCalls = 0;
        window.__origSaveAppearance = saveAppearance;
        saveAppearance = () => { window.__saveCalls++; };
        try {
          num.value = '';
          num.focus();
          const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 });
          num.dispatchEvent(ev);
          const menu = document.getElementById('app-context-menu');
          if (!menu) return { ok: false, why: 'no-menu' };
          const state = [...menu.children].map(c => ({ label: c.textContent, disabled: c.classList.contains('disabled') }));
          window.__clipMock.text = '7';
          const paste = [...menu.children].find(c => c.textContent === '粘贴');
          paste.click();
          await new Promise(r => setTimeout(r, 300));
          return { ok: true, state, value: num.value, saves: window.__saveCalls };
        } finally {
          saveAppearance = window.__origSaveAppearance; delete window.__origSaveAppearance;
          try { closeSettingsTab(); } catch (e) {}
        }
      })()`).catch(e => ({ ok: false, error: String(e && e.message || e) }));
      check('文本右键菜单：number 设置项无假剪切/复制、粘贴经原生编辑命令且 onchange 保存链触发',
        numberProbe.ok === true && Array.isArray(numberProbe.state) &&
        numberProbe.state.filter(i => i.label === '剪切' || i.label === '复制').every(i => i.disabled) === true &&
        numberProbe.state.filter(i => i.label === '粘贴').every(i => !i.disabled) === true &&
        numberProbe.value === '7' && numberProbe.saves >= 1,
        JSON.stringify(numberProbe));
    } finally {
      clipRestoreOk = await cdp.eval(`(() => {
        if (!window.__clipPrevInvoke) return false;
        const target = window.__clipPrevInvoke;
        ipcRenderer.invoke = target;
        const restored = ipcRenderer.invoke === target;
        delete window.__clipPrevInvoke; delete window.__clipMock;
        return restored;
      })()`).catch(() => false);
    }
    check('文本右键菜单：剪贴板 mock fixture 已恢复并验证', clipRestoreOk === true);
    await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); try { closeSearch(); } catch (e) {} return 'text-menu-clean'; })()`);
    await sleep(150);

    // 13.5c REAL pointer right-click across the remaining surfaces: the tab
    //      rename editor (continuation under the text menu), the settings
    //      tab, the SSH edit form, the transfer flyout, and the terminal
    //      (right-click paste temporarily disabled — the system clipboard
    //      is never touched by any of these probes). defaultPrevented is
    //      recorded by a bubble-end listener, i.e. AFTER every handler ran.
    await cdp.eval(`(() => {
      window.__ctxEnd2 = { prevented: null, fired: 0 };
      document.addEventListener('contextmenu', (e) => {
        window.__ctxEnd2.fired++;
        Promise.resolve().then(() => { window.__ctxEnd2.prevented = e.defaultPrevented; });
      }, true);
      window.__clipPrevInvoke2 = ipcRenderer.invoke.bind(ipcRenderer);
      window.__clipMock2 = { text: 'TABPASTE' };
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'clipboard-read-text') return Promise.resolve(window.__clipMock2.text);
        if (cmd === 'clipboard-write-text') { window.__clipMock2.text = args && args.text || ''; return Promise.resolve({ ok: true }); }
        return window.__clipPrevInvoke2(cmd, args);
      };
      return 'armed';
    })()`);
    const surfaceCenter = async (js) => await cdp.eval(`(() => {
      const el = ${js};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const surfaceRight = async (js, keepMenu) => {
      const pos = await surfaceCenter(js);
      if (!pos) return { pos: null };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'right', buttons: 2, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'right', buttons: 2, clickCount: 1 });
      await sleep(350);
      const state = await cdp.eval(`(() => {
        const menu = document.getElementById('app-context-menu');
        return {
          prevented: window.__ctxEnd2.prevented,
          fired: window.__ctxEnd2.fired,
          labels: menu ? [...menu.children].map(c => c.textContent) : null,
        };
      })()`);
      if (!keepMenu) await cdp.eval(`(() => { if (window.ContextMenu) ContextMenu.close(); return 'closed'; })()`);
      return { pos, ...state };
    };
    try {
      // Focus sits on control A; the real right-press targets control B.
      // B keeps the NATIVE focus move (only already-focused editors get the
      // suppression), so the menu's paste must land in B with focus on it.
      // Both the original and pasted scrollback values are valid: the change
      // handler must not reject them or alter later local-PTY startup paths.
      const crossFocus = await cdp.eval(`(async () => {
        openSettings('terminal');
        await new Promise(r => setTimeout(r, 300));
        const a = document.getElementById('set-startup-dir');
        const b = document.getElementById('set-scrollback');
        if (!a || !b) return { ok: false, why: 'no-inputs' };
        a.focus();
        b.value = '11000';
        window.__clipMock2.text = '12000';
        b.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        const rect = b.getBoundingClientRect();
        const visible = rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
        // Surface evidence BEFORE the gesture: the reopen must have landed
        // on a live settings tab with the settings pane actually shown, and
        // the press point must hit the target input (not whatever view was
        // underneath — the proven failure mode).
        const active = TabManager.getActive();
        const pane = document.getElementById('settings-pane');
        const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
        return {
          ok: true,
          hadFocusOnA: document.activeElement === a,
          visible,
          onSettings: !!(active && active.type === 'settings' && !TabManager._closingTabs.has(active.id)),
          paneActive: !!(pane && pane.classList.contains('active')),
          hitInput: !!(hit && (hit === b || (b.contains && b.contains(hit)))),
          hitDesc: hit && (hit.tagName + '#' + (hit.id || '')),
        };
      })()`);
      const crossMenu = crossFocus.ok ? await surfaceRight(`document.getElementById('set-scrollback')`, true) : { pos: null };
      const crossPaste = crossMenu.pos ? await cdp.eval(`(async () => {
        const b = document.getElementById('set-scrollback');
        if (!b) return { ok: false, why: 'no-input' };
        const menu = document.getElementById('app-context-menu');
        if (!menu) return { ok: false, why: 'no-menu' };
        b.select(); // deterministic: the paste replaces the whole field
        [...menu.children].find(c => c.textContent === '粘贴').click();
        await new Promise(r => setTimeout(r, 300));
        const value = b.value;
        const focused = document.activeElement === b;
        b.value = '10000';
        b.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value, focused };
      })()`) : { ok: false, why: 'no-menu' };
      await cdp.eval(`(() => { window.__clipMock2.text = 'TABPASTE'; try { closeSettingsTab(); } catch (e) {} return 'closed'; })()`);
      await sleep(200);
      check('文本右键菜单：焦点在另一控件时右键 B 仍可粘贴（设置页可见、命中 B、原生聚焦不被抑制）',
        crossFocus.ok === true && crossFocus.hadFocusOnA === true && crossFocus.visible === true &&
        crossFocus.onSettings === true && crossFocus.paneActive === true && crossFocus.hitInput === true &&
        crossMenu.pos !== null && crossMenu.prevented === true &&
        Array.isArray(crossMenu.labels) && crossMenu.labels.join() === '剪切,复制,粘贴,全选' &&
        crossPaste.ok === true && crossPaste.focused === true && crossPaste.value === '12000',
        JSON.stringify({ crossFocus, crossMenu, crossPaste }));

      // Number select() proof: deleting after select must clear the fresh
      // control. Native delete exercises the actual selection without any
      // clipboard read/write or a misleading empty-copy control.
      const numSelectProbe = await cdp.eval(`(() => {
        openSettings('appearance');
        return new Promise(resolve => setTimeout(() => {
          const parent = document.getElementById('settings-content');
          const num = document.createElement('input');
          num.type = 'number';
          num.value = '12345';
          parent.appendChild(num);
          try {
            num.focus();
            num.select();
            const deleted = document.execCommand('delete');
            resolve({ ok: true, deleted, after: num.value });
          } finally {
            num.remove();
            try { closeSettingsTab(); } catch (e) {}
          }
        }, 300));
      })()`);
      check('number 控件 select() 后原生删除清空所选内容（零剪贴板读写）',
        numSelectProbe.ok === true && numSelectProbe.deleted === true && numSelectProbe.after === '',
        JSON.stringify(numSelectProbe));

      // Tab rename under the REAL doRemove scenario: a half-typed rename
      // with the text menu open (real right-press) while a BACKGROUND tab
      // closes through the real closeTab — its doRemove render re-seats the
      // kept rename node, which fired a synchronous blur that committed the
      // half-typed name (root-caused in artifacts/e2e-tmp/06-tab-focus-
      // state.log). The editor must survive with focus/selection, nothing
      // may commit, and paste must continue editing afterwards.
      const spareId = await cdp.eval(`TabManager.createTab({ name: 'E2E-RENAME-SPARE', type: 'local' })`);
      await sleep(400); // let the spare's backend land before the staging
      const tabRename = await cdp.eval(`(async () => {
        const tabEl = [...document.querySelectorAll('#tabbar .tab')].find(el => {
          const t = (TabManager.tabs.find(x => x.id === el.getAttribute('data-tab')) || {});
          return t.type !== 'settings' && t.id !== ${JSON.stringify(spareId)};
        });
        if (!tabEl) return { ok: false, why: 'no-tab' };
        const tabId = tabEl.getAttribute('data-tab');
        const before = TabManager.tabs.find(t => t.id === tabId).name;
        TabManager.switchTo(tabId);
        await new Promise(r => setTimeout(r, 350));
        tabEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        const input = document.querySelector('.tab-rename-input');
        if (!input) return { ok: false, why: 'no-editor' };
        input.focus();
        input.value = 'HALF-TYPED';
        input.select();
        return { ok: true, tabId, before,
          nameWhileEditing: TabManager.tabs.find(t => t.id === tabId).name,
          focused: document.activeElement === input };
      })()`);
      // keepMenu: the paste step below clicks the item of THIS real-gesture menu.
      const tabMenuState = tabRename.ok ? await surfaceRight(`document.querySelector('.tab-rename-input')`, true) : { pos: null };
      // The REAL doRemove: close the spare background tab while the editor
      // and its menu are open — the render must reseat without committing.
      const afterDoRemove = (tabRename.ok && tabMenuState.pos) ? await cdp.eval(`(async () => {
        TabManager.closeTab(${JSON.stringify(spareId)});
        await new Promise(r => setTimeout(r, 350));
        const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabRename.tabId)});
        const input = document.querySelector('.tab-rename-input');
        return {
          editorOpen: !!input,
          focused: input === document.activeElement,
          name: tab && tab.name,
          custom: !!(tab && tab._customName),
          menuOpen: !!document.getElementById('app-context-menu'),
        };
      })()`) : null;
      const tabPaste = (tabRename.ok && afterDoRemove && afterDoRemove.editorOpen && tabMenuState.pos) ? await cdp.eval(`(async () => {
        const input = document.querySelector('.tab-rename-input');
        const tabId = input.closest('.tab').getAttribute('data-tab');
        const menu = document.getElementById('app-context-menu');
        if (!menu) return { ok: false, why: 'no-menu' };
        [...menu.children].find(c => c.textContent === '粘贴').click();
        await new Promise(r => setTimeout(r, 300));
        const stillOpen = !!document.querySelector('.tab-rename-input');
        const value = input.value;
        const nameAfterPaste = TabManager.tabs.find(t => t.id === tabId).name;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 150));
        const nameAfterIme = TabManager.tabs.find(t => t.id === tabId).name;
        const openAfterIme = !!document.querySelector('.tab-rename-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 200));
        const openAfterEsc = !!document.querySelector('.tab-rename-input');
        const nameAfterEsc = TabManager.tabs.find(t => t.id === tabId).name;
        return { ok: true, value, stillOpen, nameAfterPaste, nameAfterIme, openAfterIme, openAfterEsc, nameAfterEsc };
      })()`) : { ok: false, why: 'editor-gone', diag: { afterDoRemove, tabMenuState } };
      check('标签重命名：doRemove 重排不提交半名（焦点/编辑续写保留，IME Enter 不提交）',
        tabRename.ok === true && tabRename.focused === true && tabRename.nameWhileEditing === tabRename.before &&
        tabMenuState.pos !== null && tabMenuState.prevented === true &&
        Array.isArray(tabMenuState.labels) && tabMenuState.labels.join() === '剪切,复制,粘贴,全选' &&
        afterDoRemove && afterDoRemove.editorOpen === true && afterDoRemove.focused === true &&
        afterDoRemove.name === tabRename.before && afterDoRemove.custom === false && afterDoRemove.menuOpen === true &&
        tabPaste.ok === true && tabPaste.stillOpen === true && String(tabPaste.value).includes('TABPASTE') &&
        tabPaste.nameAfterPaste === tabRename.before && tabPaste.nameAfterIme === tabRename.before &&
        tabPaste.openAfterIme === true && tabPaste.openAfterEsc === false && tabPaste.nameAfterEsc === tabRename.before,
        JSON.stringify({ tabRename, tabMenuState, afterDoRemove, tabPaste }));

      // Settings tab: suppressed, no app menu (the settings tab owns no tab
      // actions; the browser menu must not appear either).
      await cdp.eval(`openSettings()`);
      await sleep(300);
      const settingsTab = await surfaceRight(`[...document.querySelectorAll('#tabbar .tab')].find(el => ((TabManager.tabs.find(t => t.id === el.getAttribute('data-tab')) || {}).type) === 'settings')`);
      await cdp.eval(`try { closeSettingsTab(); } catch (e) {}`);
      await sleep(200);
      check('设置标签右键：defaultPrevented 且无应用菜单',
        settingsTab.pos !== null && settingsTab.prevented === true && settingsTab.labels === null,
        JSON.stringify(settingsTab));

      // SSH edit form: a plain text input gets the app text menu.
      await cdp.eval(`openSSHEdit(true)`);
      await sleep(300);
      const sshForm = await surfaceRight(`document.getElementById('ssh-edit-name')`);
      await cdp.eval(`closeAllOverlays()`);
      await sleep(200);
      check('SSH 表单右键：文本输入得到应用编辑菜单',
        sshForm.pos !== null && sshForm.prevented === true &&
        Array.isArray(sshForm.labels) && sshForm.labels.join() === '剪切,复制,粘贴,全选',
        JSON.stringify(sshForm));

      // Transfer flyout: suppressed, no app menu (non-text surface).
      await cdp.eval(`TransferManager.openPanel()`);
      await sleep(250);
      const flyout = await surfaceRight(`document.querySelector('#transfer-window') || document.getElementById('transfer-window')`);
      await cdp.eval(`TransferManager.closePanel()`);
      await sleep(150);
      check('传输浮窗右键：defaultPrevented 且无应用菜单',
        flyout.pos !== null && flyout.prevented === true && flyout.labels === null,
        JSON.stringify(flyout));

      // Terminal: right-click paste disabled for the probe (restored right
      // after) — the terminal's own handler suppresses the default, the app
      // menu never appears, and no clipboard IPC happens.
      const termProbe = await cdp.eval(`(() => {
        const tab = TabManager.getActive();
        const term = tab && (tab.term || (tab.splitRoot && (getAllPanes(tab).find(p => p.focused) || getAllPanes(tab)[0]).term));
        const el = term && term.element;
        if (!el) return { ok: false, why: 'no-term' };
        // undefined is a legitimate saved value (setting absent = enabled):
        // remember presence separately so the restore can delete the key.
        window.__hadRightClickPaste = Object.prototype.hasOwnProperty.call(_settingsConfig, 'rightClickPaste');
        window.__oldRightClickPaste = _settingsConfig.rightClickPaste;
        _settingsConfig.rightClickPaste = false;
        return { ok: true };
      })()`);
      let termState = { pos: null };
      if (termProbe.ok) {
        termState = await surfaceRight(`(TabManager.getActive().term || (getAllPanes(TabManager.getActive()).find(p => p.focused) || getAllPanes(TabManager.getActive())[0]).term).element`);
      }
      const termRestored = await cdp.eval(`(() => {
        if (typeof window.__hadRightClickPaste !== 'boolean') return false;
        if (window.__hadRightClickPaste) _settingsConfig.rightClickPaste = window.__oldRightClickPaste;
        else delete _settingsConfig.rightClickPaste;
        delete window.__oldRightClickPaste; delete window.__hadRightClickPaste;
        return _settingsConfig.rightClickPaste !== false;
      })()`);
      check('终端右键：终端自身处理且无应用菜单（paste 设置已复原，未触碰剪贴板）',
        termProbe.ok === true && termState.pos !== null && termState.prevented === true &&
        termState.labels === null && termRestored === true,
        JSON.stringify({ termProbe, termState, termRestored }));
    } finally {
      await cdp.eval(`(() => {
        if (window.__clipPrevInvoke2) {
          const target = window.__clipPrevInvoke2;
          ipcRenderer.invoke = target;
          const ok = ipcRenderer.invoke === target;
          delete window.__clipPrevInvoke2; delete window.__clipMock2;
          if (window.__hadRightClickPaste === true) _settingsConfig.rightClickPaste = window.__oldRightClickPaste;
          else if (window.__hadRightClickPaste === false) delete _settingsConfig.rightClickPaste;
          delete window.__oldRightClickPaste; delete window.__hadRightClickPaste;
          window.__surfaceRestoreOk = ok;
          return ok;
        }
        window.__surfaceRestoreOk = false;
        return false;
      })()`).catch(() => null);
    }
    const surfaceRestoreOk = await cdp.eval(`(() => { const v = !!window.__surfaceRestoreOk; delete window.__surfaceRestoreOk; return v; })()`).catch(() => false);
    check('跨表面右键探针：fixture 已恢复并验证', surfaceRestoreOk === true);
    // 13.6 About-page update card state machine (mocked IPC: no real
    // download, no real exit). Covers the full flow: new version found →
    // download update → ready → restart and install, plus the SSH-blocker
    // confirm dialog (open / cancel / button-label restore).
    const updMock = await cdp.eval(`(() => {
      window.__e2eOrigInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__e2eDlState = { phase: 'idle' };
      window.__e2eDlStarted = false;
      window.__e2eStatePolls = 0;
      window.__e2eApplied = 0;
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'check-update') return Promise.resolve({ current: '1.0.0', latest: '9.9.9', tag: 'v9.9.9', url: 'https://example.com/rel', newer: true, ready: false });
        if (cmd === 'download-update') {
          // Resolve after ~4 poll ticks so the 500ms poll loop first renders
          // the downloading phase (state polls 1-3 below) and then ready.
          window.__e2eDlStarted = true;
          return new Promise(res => setTimeout(() => {
            window.__e2eDlState = { phase: 'ready', tag: 'v9.9.9' };
            res(window.__e2eDlState);
          }, 2200));
        }
        if (cmd === 'update-download-state') {
          if (!window.__e2eDlStarted) return Promise.resolve({ phase: 'idle' });
          window.__e2eStatePolls++;
          return Promise.resolve(window.__e2eStatePolls <= 3
            ? { phase: 'downloading', tag: 'v9.9.9', downloaded: 50, total: 100 }
            : { phase: 'ready', tag: 'v9.9.9' });
        }
        if (cmd === 'apply-update') { window.__e2eApplied++; return Promise.resolve({ ok: true }); }
        return window.__e2eOrigInvoke(cmd, args);
      };
      openSettings('about');
      return 'mocked';
    })()`).catch(e => 'eval-fail: ' + e.message);
    await sleep(800);
    const updInit = await cdp.eval(`({
      desc: document.getElementById('update-check-desc')?.textContent,
      dlHidden: document.getElementById('btn-update-download')?.style.display === 'none',
      applyHidden: document.getElementById('btn-update-apply')?.style.display === 'none',
      notesHidden: document.getElementById('update-release-notes')?.style.display === 'none'
    })`);
    check('更新卡片初始态（mock 后）', updMock === 'mocked' && updInit.dlHidden === true && updInit.applyHidden === true,
      JSON.stringify({ updMock, ...updInit }));
    await cdp.eval(`checkForUpdates(); 'checking'`);
    const updNewer = await waitForValue(cdp, `document.getElementById('update-check-desc')?.textContent || ''`, '发现新版本 9.9.9（当前 1.0.0）');
    const updNewerUi = await cdp.eval(`({
      dlShown: document.getElementById('btn-update-download')?.style.display !== 'none',
      dlText: document.getElementById('btn-update-download')?.textContent,
      applyHidden: document.getElementById('btn-update-apply')?.style.display === 'none',
      notesShown: document.getElementById('update-release-notes')?.style.display !== 'none'
    })`);
    check('更新卡片：发现新版显示下载入口', updNewer === '发现新版本 9.9.9（当前 1.0.0）' && updNewerUi.dlShown === true && updNewerUi.dlText === '下载更新' && updNewerUi.applyHidden === true && updNewerUi.notesShown === true,
      JSON.stringify({ desc: updNewer, ...updNewerUi }));
    await cdp.eval(`startUpdateDownload(); 'downloading'`);
    // The 500ms poll must render the downloading phase before ready arrives
    // (mock holds ready back for ~4 ticks): sample until '下载中 50%' appears.
    let updDlPhase = null;
    for (let i = 0; i < 16 && !updDlPhase; i++) {
      const s = await cdp.eval(`({
        text: document.getElementById('btn-update-download')?.textContent,
        disabled: document.getElementById('btn-update-download')?.disabled,
        checkDisabled: document.getElementById('btn-check-update')?.disabled
      })`).catch(() => null);
      if (s && s.text === '下载中 50%') updDlPhase = s;
      else await sleep(250);
    }
    check('更新卡片：轮询驱动下载中进度', !!updDlPhase && updDlPhase.disabled === true && updDlPhase.checkDisabled === true, JSON.stringify(updDlPhase));
    const updReadyDesc = await waitForValue(cdp, `document.getElementById('update-check-desc')?.textContent || ''`, 'v9.9.9 已下载完成，随时可安装');
    const updReadyUi = await cdp.eval(`({
      applyShown: document.getElementById('btn-update-apply')?.style.display !== 'none',
      applyText: document.getElementById('btn-update-apply')?.textContent,
      dlHidden: document.getElementById('btn-update-download')?.style.display === 'none'
    })`);
    check('更新卡片：下载完成进入就绪态', updReadyDesc === 'v9.9.9 已下载完成，随时可安装' && updReadyUi.applyShown === true && updReadyUi.applyText === '重启并安装 v9.9.9' && updReadyUi.dlHidden === true,
      JSON.stringify({ desc: updReadyDesc, ...updReadyUi }));
    // No blocker: apply directly, no confirm dialog
    await cdp.eval(`applyUpdate(); 'applying'`);
    await sleep(400);
    const updApplied = await cdp.eval(`({ n: window.__e2eApplied, overlayOpen: document.getElementById('overlay-confirm').classList.contains('open') })`);
    check('更新卡片：无 SSH/SFTP 阻断直接安装', updApplied.n === 1 && updApplied.overlayOpen === false, JSON.stringify(updApplied));
    // With a blocker (temporary fake SSH tab): the confirm dialog appears;
    // cancelling restores the button's default label
    const updConfirm = await cdp.eval(`(() => {
      const fake = { id: '__e2e_fake_ssh', type: 'ssh', connected: true, name: 'fake' };
      TabManager.tabs.push(fake);
      let r = {};
      try {
        // Previous successful apply left the button disabled ("正在退出…");
        // re-arm it so this path is exercised from a clean ready state.
        const applyBtn = document.getElementById('btn-update-apply');
        applyBtn.disabled = false;
        applyUpdate();
        const ov = document.getElementById('overlay-confirm');
        r.open = ov.classList.contains('open');
        r.msg = document.getElementById('confirm-msg').textContent;
        r.okText = document.getElementById('confirm-ok').textContent;
        r.appliedBefore = window.__e2eApplied;
        document.getElementById('confirm-cancel').click();
        r.closedAfterCancel = !ov.classList.contains('open');
        r.okTextRestored = document.getElementById('confirm-ok').textContent;
        r.appliedAfter = window.__e2eApplied;
      } finally {
        TabManager.tabs.splice(TabManager.tabs.indexOf(fake), 1);
      }
      return r;
    })()`);
    const updConfirmOk = updConfirm.open === true && /1 个已连接的 SSH 会话/.test(updConfirm.msg || '') &&
      updConfirm.okText === '退出并安装' && updConfirm.appliedBefore === 1 &&
      updConfirm.closedAfterCancel === true && updConfirm.okTextRestored === '删除' && updConfirm.appliedAfter === 1;
    check('更新卡片：SSH 阻断确认框（取消不安装）', updConfirmOk === true, JSON.stringify(updConfirm));
    // ready:true short-circuit: when check_update reports an installer that
    // is already downloaded and verified, the card must jump straight to the
    // apply state and must NOT trigger another download. The card is first
    // perturbed to the up-to-date state so only the ready branch itself can
    // produce the asserted ready rendering.
    await cdp.eval(`(() => {
      window.__e2eDlCalls = 0;
      const prevInvoke = ipcRenderer.invoke;
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'download-update') window.__e2eDlCalls++;
        if (cmd === 'check-update') return Promise.resolve({ current: '1.0.0', latest: '9.9.9', tag: 'v9.9.9', url: 'https://example.com/rel', newer: true, ready: true });
        return prevInvoke(cmd, args);
      };
      document.getElementById('update-check-desc').textContent = '已是最新版本 (1.0.0)';
      document.getElementById('btn-update-apply').style.display = 'none';
      document.getElementById('btn-update-download').style.display = '';
      checkForUpdates();
      return 'armed';
    })()`);
    const updShortDesc = await waitForValue(cdp, `document.getElementById('update-check-desc')?.textContent || ''`, 'v9.9.9 已下载完成，随时可安装');
    const updShortUi = await cdp.eval(`({
      applyShown: document.getElementById('btn-update-apply')?.style.display !== 'none',
      applyText: document.getElementById('btn-update-apply')?.textContent,
      dlHidden: document.getElementById('btn-update-download')?.style.display === 'none',
      dlCalls: window.__e2eDlCalls
    })`);
    check('更新卡片：ready 直跳安装态不触发重下', updShortDesc === 'v9.9.9 已下载完成，随时可安装' && updShortUi.applyShown === true && updShortUi.applyText === '重启并安装 v9.9.9' && updShortUi.dlHidden === true && updShortUi.dlCalls === 0,
      JSON.stringify({ desc: updShortDesc, ...updShortUi }));
    // Failure mapping: the backend's stable [tag] must surface as friendly
    // guidance with the raw detail kept; unknown errors pass through as-is.
    await cdp.eval(`(() => {
      const prevInvoke = ipcRenderer.invoke;
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'check-update') return Promise.reject(new Error('update check failed [timeout]: timeout: global'));
        return prevInvoke(cmd, args);
      };
      checkForUpdates();
      return 'armed-fail';
    })()`);
    const updFailDesc = await waitForValue(cdp, `document.getElementById('update-check-desc')?.textContent || ''`, '检查失败：网络超时，无法连接更新服务器（请检查网络或代理设置）。详细信息：update check failed [timeout]: timeout: global');
    const updPassThrough = await cdp.eval(`_friendlyUpdateError('update check: bad response json: xyz')`).catch(() => null);
    check('更新卡片：超时错误映射友好文案（未知错误透传）',
      typeof updFailDesc === 'string' && updFailDesc.includes('网络超时，无法连接更新服务器') && updFailDesc.includes('[timeout]: timeout: global') &&
      updPassThrough === 'update check: bad response json: xyz',
      JSON.stringify({ updFailDesc, updPassThrough }));
    await cdp.eval(`(() => { ipcRenderer.invoke = window.__e2eOrigInvoke; closeSettingsTab(); return 'restored'; })()`).catch(() => null);
    await sleep(300);

    // 13.7 SSH manager page + session selector: grouped rows, live search,
    // collapse state, and a combobox-style picker.
    // Fixtures use documentation-only addresses (TEST-NET-1 / 2001:db8 / .example):
    // no real connection is ever opened — SSH dispatch is captured with a
    // createTab stub and the edit overlay is pure UI.
    // ZTERM_E2E_SHOTS=<dir> additionally captures UI screenshots there.
    const shotDir = process.env.ZTERM_E2E_SHOTS || '';
    await cdp.send('Page.enable').catch(() => {});
    async function shot(name) {
      if (!shotDir) return;
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (r?.data) {
          mkdirSync(shotDir, { recursive: true });
          writeFileSync(join(shotDir, name + '.png'), Buffer.from(r.data, 'base64'));
        }
      } catch (e) { console.log(`[e2e] screenshot ${name} failed: ${e.message}`); }
    }
    // Editor and confirmation actions share one left-to-right contract. These
    // probes only open and cancel isolated UI; they never submit an edit,
    // authorize execution, or open a connection.
    const dialogActionCases = [
      { name: 'ssh-edit', overlay: 'overlay-ssh-edit', open: 'openSSHEdit(true)',
        primary: '#ssh-edit-save-btn', cancel: '#overlay-ssh-edit .ssh-edit-footer .btn-outline' },
      { name: 'quick-command', overlay: 'overlay-qc-edit', open: 'openQCEdit(true)',
        primary: '#overlay-qc-edit .btn-primary', cancel: '#overlay-qc-edit .btn-outline' },
      { name: 'highlight', overlay: 'overlay-highlight-edit', open: 'openHighlightEdit(true)',
        primary: '#overlay-highlight-edit .btn-primary', cancel: '#overlay-highlight-edit .btn-outline' },
      { name: 'shared-confirm', overlay: 'overlay-confirm',
        open: "showConfirm('按钮顺序验证', () => {}, '确认')", primary: '#confirm-ok', cancel: '#confirm-cancel' },
      { name: 'color-picker', overlay: 'color-picker-overlay', open: "openColorPicker('#61afef', () => {})",
        primary: '.color-picker-ok', cancel: '.color-picker-cancel' },
    ];
    const dialogActionResults = [];
    for (const dialog of dialogActionCases) {
      const geometry = await cdp.eval(`(async () => {
        closeAllOverlays();
        closeColorPicker();
        ${dialog.open};
        await new Promise(requestAnimationFrame);
        const overlay = document.getElementById(${JSON.stringify(dialog.overlay)});
        const primary = document.querySelector(${JSON.stringify(dialog.primary)});
        const cancel = document.querySelector(${JSON.stringify(dialog.cancel)});
        const primaryRect = primary?.getBoundingClientRect();
        const cancelRect = cancel?.getBoundingClientRect();
        return {
          opened: overlay?.classList.contains('open') === true,
          primaryBeforeCancel: !!(primary?.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING),
          primaryRight: primaryRect?.right,
          cancelLeft: cancelRect?.left,
          primaryWidth: primaryRect?.width,
          primaryHeight: primaryRect?.height,
          cancelWidth: cancelRect?.width,
          cancelHeight: cancelRect?.height,
          primaryLabel: primary?.textContent,
          cancelLabel: cancel?.textContent,
          cancelFocused: document.activeElement === cancel,
        };
      })()`).catch(e => ({ error: String(e) }));
      dialogActionResults.push({ name: dialog.name, ...geometry });
      await shot('dialog-actions-' + dialog.name);
      const dismissed = await cdp.eval(`(() => {
        document.querySelector(${JSON.stringify(dialog.cancel)})?.click();
        return !document.getElementById(${JSON.stringify(dialog.overlay)}).classList.contains('open');
      })()`).catch(() => false);
      dialogActionResults[dialogActionResults.length - 1].dismissed = dismissed;
    }
    check('编辑与确认弹窗：主操作在左、取消在右且默认焦点安全',
      dialogActionResults.every(r => r.opened === true && r.primaryBeforeCancel === true &&
        r.primaryWidth > 0 && r.primaryHeight > 0 && r.cancelWidth > 0 && r.cancelHeight > 0 &&
        r.primaryRight <= r.cancelLeft && r.dismissed === true &&
        (r.name !== 'shared-confirm' || r.cancelFocused === true)),
      JSON.stringify(dialogActionResults));
    await cdp.eval(`closeAllOverlays(); closeColorPicker(); 'dialog-order-clean'`);

    const sshFxCount = await cdp.eval(`(() => {
      TabManager.sshProfiles = [
        { id: 'e2essh1', name: '', host: '192.0.2.10', port: 22, username: 'deploy', group: '生产', authType: 'password' },
        { id: 'e2essh2', name: '构建机', host: 'builder.example.com', port: 2222, username: 'ci', group: '生产', authType: 'key', privateKeyPath: 'C:/keys/ci' },
        { id: 'e2essh3', name: '日志', host: '2001:db8::5', port: 0, username: 'root', group: '观测', authType: 'password' }
      ];
      openSettings('ssh');
      return TabManager.sshProfiles.length;
    })()`).catch(() => 0);
    await sleep(500);
    const mgrStruct = await cdp.eval(`(() => {
      const list = document.getElementById('settings-ssh-list');
      const rows = [...list.querySelectorAll('.ssh-mgr-row')].map(row => ({
        id: row.dataset.profileId,
        primary: row.querySelector('.ssh-mgr-primary')?.textContent,
        isHost: row.querySelector('.ssh-mgr-primary')?.classList.contains('host') === true,
        meta: (row.querySelector('.ssh-mgr-meta')?.textContent || '').replace(/\\s+/g, ''),
        key: !!row.querySelector('.ssh-mgr-key'),
        actions: [...row.querySelectorAll('.ssh-mgr-btn')].map(b => b.dataset.action)
      }));
      return { rows,
        groups: [...list.querySelectorAll('.ssh-mgr-group-title')].map(h => h.dataset.group),
        count: document.querySelector('[data-ssh-count="settings-ssh-list"]')?.textContent };
    })()`).catch(() => null);
    const mgrOk = sshFxCount === 3 && !!mgrStruct &&
      JSON.stringify(mgrStruct.groups) === JSON.stringify(['生产', '观测']) &&
      mgrStruct.rows.length === 3 &&
      mgrStruct.rows[0].id === 'e2essh1' && mgrStruct.rows[0].primary === '192.0.2.10' && mgrStruct.rows[0].isHost === true &&
      mgrStruct.rows[0].meta.includes('deploy') && mgrStruct.rows[0].meta.includes('端口22') && mgrStruct.rows[0].key === false &&
      mgrStruct.rows[1].primary === '构建机' && mgrStruct.rows[1].isHost === false &&
      mgrStruct.rows[1].meta.includes('builder.example.com:2222') && mgrStruct.rows[1].meta.includes('ci') && mgrStruct.rows[1].key === true &&
      mgrStruct.rows[2].meta.includes('[2001:db8::5]:22') && mgrStruct.rows[2].meta.includes('root') &&
      mgrStruct.rows.every(r => JSON.stringify(r.actions) === JSON.stringify(['connect', 'edit', 'delete'])) &&
      mgrStruct.count === '3 个连接';
    check('SSH 管理页：地址/端口/密钥徽标/IPv6/计数渲染', mgrOk === true, JSON.stringify(mgrStruct));
    await shot('ssh-settings-page');
    // Search narrows rows + count and force-expands the matched group; clearing
    // the query must restore the pre-search collapse view (view-state round trip).
    await cdp.eval(`filterSSHManager('settings-ssh-list', '构建'); 'q1'`);
    const mgrQuery = await cdp.eval(`({
      rows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length,
      count: document.querySelector('[data-ssh-count="settings-ssh-list"]').textContent,
      expanded: [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-title')].map(h => h.getAttribute('aria-expanded'))
    })`);
    check('SSH 管理页：搜索过滤命中并强制展开', mgrQuery.rows === 1 && mgrQuery.count === '1 / 3 个连接' && mgrQuery.expanded.length === 1 && mgrQuery.expanded[0] === 'true', JSON.stringify(mgrQuery));
    await cdp.eval(`filterSSHManager('settings-ssh-list', ''); 'q0'`);
    await cdp.eval(`document.querySelector('#settings-ssh-list .ssh-mgr-group-title[data-group="生产"]').click(); 'c1'`);
    const mgrCollapsed = await cdp.eval(`({
      collapsedItems: document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-items.collapsed').length,
      visibleRows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length,
      count: document.querySelector('[data-ssh-count="settings-ssh-list"]').textContent
    })`);
    await cdp.eval(`filterSSHManager('settings-ssh-list', '构建'); filterSSHManager('settings-ssh-list', ''); 'cycle'`);
    const mgrStillCollapsed = await cdp.eval(`document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-items.collapsed').length`);
    check('SSH 管理页：折叠选择跨搜索往返保持', mgrCollapsed.collapsedItems === 1 && mgrCollapsed.visibleRows === 1 && mgrCollapsed.count === '3 个连接' && mgrStillCollapsed === 1,
      JSON.stringify({ ...mgrCollapsed, mgrStillCollapsed }));
    await cdp.eval(`expandAllGroups('settings-ssh-list'); 'exp'`);
    await cdp.eval(`filterSSHManager('settings-ssh-list', 'zzz-no-match'); 'q9'`);
    const mgrEmpty = await cdp.eval(`(document.querySelector('#settings-ssh-list .ssh-mgr-empty')?.textContent || '').includes('没有匹配的连接')`);
    check('SSH 管理页：零结果空态', mgrEmpty === true, '');
    await shot('ssh-manager-empty');
    await cdp.eval(`filterSSHManager('settings-ssh-list', ''); 'q00'`);
    // Second entry: standalone manager overlay renders the same data; the edit
    // action opens the prefilled editor (no network involved).
    await cdp.eval(`openSSHManager(); 'm1'`);
    await sleep(350);
    const ovlStruct = await cdp.eval(`({
      open: document.getElementById('overlay-ssh-manager').classList.contains('open'),
      rows: document.querySelectorAll('#ssh-manager-list .ssh-mgr-row').length,
      primaries: [...document.querySelectorAll('#ssh-manager-list .ssh-mgr-primary')].map(e => e.textContent),
      count: document.querySelector('[data-ssh-count="ssh-manager-list"]')?.textContent,
      focus: document.activeElement?.id
    })`);
    const ovlOk = ovlStruct.open === true && ovlStruct.rows === 3 && ovlStruct.count === '3 个连接' &&
      JSON.stringify(ovlStruct.primaries) === JSON.stringify(['192.0.2.10', '构建机', '日志']) && ovlStruct.focus === 'ssh-manager-search';
    check('SSH 管理浮层：第二入口数据一致 + 搜索聚焦', ovlOk === true, JSON.stringify(ovlStruct));
    await shot('ssh-manager-overlay');
    const editProbe = await cdp.eval(`(() => {
      document.querySelector('#ssh-manager-list .ssh-mgr-row[data-profile-id="e2essh1"] .ssh-mgr-btn[data-action="edit"]').click();
      return { open: document.getElementById('overlay-ssh-edit').classList.contains('open'),
        host: document.getElementById('ssh-edit-host').value,
        user: document.getElementById('ssh-edit-user').value };
    })()`).catch(() => null);
    check('SSH 管理：编辑动作打开预填表单', !!editProbe && editProbe.open === true && editProbe.host === '192.0.2.10' && editProbe.user === 'deploy', JSON.stringify(editProbe));
    await cdp.eval(`closeOverlay('overlay-ssh-edit'); closeOverlay('overlay-ssh-manager'); 'c9'`);
    // New-profile password flow (user-reported bug): the typed password must
    // survive blur, Enter saves the whole dialog, Esc closes it — the global
    // Esc handler skips inline-edit inputs, so the field handles it itself.
    const newPwdProbe = await cdp.eval(`(() => {
      openSSHEdit(true);
      const pwd = document.getElementById('ssh-edit-password');
      pwd.value = 's3cret-e2e';
      pwd.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('ssh-edit-name').focus(); // blurs the password field
      const eye = document.getElementById('ssh-pwd-inline-eye');
      return {
        visible: pwd.style.display !== 'none',
        kept: pwd.value === 's3cret-e2e',
        saveShown: document.getElementById('ssh-pwd-inline-save').classList.contains('show'),
        cancelShown: document.getElementById('ssh-pwd-inline-cancel').classList.contains('show'),
        eyeShown: eye.classList.contains('show'),
        eyeRight: eye.style.right,
        padRight: pwd.style.paddingRight,
        statusHidden: document.getElementById('ssh-pwd-status').style.display === 'none'
      };
    })()`).catch(() => null);
    check('SSH 新建：密码输入跨失焦保留（无内联按钮）', !!newPwdProbe &&
      newPwdProbe.visible === true && newPwdProbe.kept === true &&
      newPwdProbe.saveShown === false && newPwdProbe.cancelShown === false &&
      newPwdProbe.eyeShown === true && newPwdProbe.eyeRight === '8px' &&
      newPwdProbe.padRight === '32px' && newPwdProbe.statusHidden === true,
      JSON.stringify(newPwdProbe));
    // Instrument the save chain so a failure payload shows WHERE it stopped:
    // did saveSSHEdit fire, did encrypt-password resolve (and how long did it
    // take), was a toast shown. (This path once failed opaquely — saved=false
    // after 4s — while the encrypt step itself takes only 4-8ms.)
    await cdp.eval(`(() => {
      window.__e2eSaveTrace = { saves: 0, ipc: [], toasts: [] };
      if (!window.__e2eOrigSaveSSHEdit) {
        window.__e2eOrigSaveSSHEdit = window.saveSSHEdit;
        window.saveSSHEdit = function (...a) {
          window.__e2eSaveTrace.saves++;
          return window.__e2eOrigSaveSSHEdit.apply(this, a);
        };
      }
      if (!window.__e2eTraceInvokePatched) {
        window.__e2eTraceInvokePatched = true;
        const prev = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (cmd, args) => {
          if (cmd !== 'encrypt-password' && cmd !== 'save-ssh-profiles') return prev(cmd, args);
          const t0 = Date.now();
          return prev(cmd, args).then(
            v => { window.__e2eSaveTrace.ipc.push({ cmd, ms: Date.now() - t0, ok: true }); return v; },
            e => { window.__e2eSaveTrace.ipc.push({ cmd, ms: Date.now() - t0, ok: false, err: String(e).slice(0, 120) }); return Promise.reject(e); });
        };
        const prevToast = window.showToast;
        window.showToast = (msg, isErr) => { window.__e2eSaveTrace.toasts.push(String(msg)); return prevToast(msg, isErr); };
      }
      return 'traced';
    })()`).catch(() => null);
    const enterSave = await cdp.eval(`(async () => {
      document.getElementById('ssh-edit-name').value = 'e2e-tmp-pwd';
      document.getElementById('ssh-edit-host').value = '198.51.100.7';
      document.getElementById('ssh-edit-user').value = 'probe';
      const pwd = document.getElementById('ssh-edit-password');
      pwd.focus();
      pwd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      // saveSSHEdit awaits DPAPI encryption, then pushes the profile and
      // closes the dialog. Wait for the WHOLE save to settle — under load
      // the encrypt can outlast a short fixed sleep, and a late in-flight
      // save would re-add the profile after the fixture-restore below (a
      // leaked 4th profile then fails every downstream row-count check).
      let saved = null, closed = false;
      for (let i = 0; i < 40 && !(saved && closed); i++) {
        await new Promise(r => setTimeout(r, 100));
        saved = (TabManager.sshProfiles || []).find(p => p.host === '198.51.100.7') || null;
        closed = !document.getElementById('overlay-ssh-edit').classList.contains('open');
      }
      return { saved: !!saved, hasPwd: !!(saved && saved.encryptedPassword), overlayOpen: !closed,
        trace: window.__e2eSaveTrace };
    })()`).catch(() => null);
    check('SSH 新建：密码框 Enter 保存整个表单（含密码）', !!enterSave && enterSave.saved === true && enterSave.hasPwd === true && enterSave.overlayOpen === false, JSON.stringify(enterSave));
    // Drop the temp profile and restore the 3-row fixture: the session
    // selector below asserts sshRows === 3. If the save above failed and is
    // still in flight, let it settle first so its late push cannot re-leak
    // the temp profile after this filter.
    await cdp.eval(`(async () => {
      for (let i = 0; i < 30; i++) {
        if (!document.getElementById('overlay-ssh-edit').classList.contains('open')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => p.host !== '198.51.100.7');
      await ipcRenderer.invoke('save-ssh-profiles', { sshProfiles: TabManager.sshProfiles });
      renderSSHManager();
      return TabManager.sshProfiles.length;
    })()`).catch(() => null);
    const escProbe = await cdp.eval(`(() => {
      openSSHEdit(true);
      const pwd = document.getElementById('ssh-edit-password');
      pwd.focus();
      pwd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { overlayOpen: document.getElementById('overlay-ssh-edit').classList.contains('open') };
    })()`).catch(() => null);
    check('SSH 新建：密码框 Esc 关闭对话框', !!escProbe && escProbe.overlayOpen === false, JSON.stringify(escProbe));
    // Edit-existing regression: status row → '修改' → input → blur cancels back.
    const editPwdProbe = await cdp.eval(`(async () => {
      const fx = TabManager.sshProfiles.find(p => p.id === 'e2essh1');
      fx.encryptedPassword = 'e2e-cipher';
      openSSHEdit(false, 'e2essh1');
      const pwd = document.getElementById('ssh-edit-password');
      const st = document.getElementById('ssh-pwd-status');
      const viewMode = st.style.display === 'flex' && pwd.style.display === 'none';
      document.getElementById('ssh-pwd-edit-btn').click();
      const cancelBtn = document.getElementById('ssh-pwd-inline-cancel');
      const eye = document.getElementById('ssh-pwd-inline-eye');
      const editMode = pwd.style.display !== 'none' && cancelBtn.classList.contains('show') &&
        eye.style.right === '44px' && pwd.style.paddingRight === '64px';
      pwd.value = 'newpass';
      pwd.dispatchEvent(new Event('input', { bubbles: true }));
      const saveShown = document.getElementById('ssh-pwd-inline-save').classList.contains('show');
      // Blur cancel requires the field to actually hold focus. The edit-mode
      // render does focus() it, but an OS-unfocused sandbox window can drop
      // that focus (leaving backToView=false with everything else green).
      // Focus explicitly, record whether the auto-focus worked, then poll the
      // cancel-back briefly instead of reading synchronously.
      pwd.focus();
      const hadFocus = document.activeElement === pwd;
      document.getElementById('ssh-edit-name').focus();
      let backToView = false;
      for (let i = 0; i < 20 && !backToView; i++) {
        await new Promise(r => setTimeout(r, 50));
        backToView = st.style.display === 'flex' && pwd.style.display === 'none' && pwd.value === '';
      }
      const diag = { hadFocus, activeAfter: document.activeElement && document.activeElement.id,
        stDisplay: st.style.display, pwdDisplay: pwd.style.display, pwdVal: pwd.value };
      delete fx.encryptedPassword; // restore fixture
      closeOverlay('overlay-ssh-edit');
      return { viewMode, editMode, saveShown, backToView, diag };
    })()`).catch(() => null);
    check('SSH 编辑：已配密码 view→修改→输入→失焦回退 回归', !!editPwdProbe && editPwdProbe.viewMode === true && editPwdProbe.editMode === true && editPwdProbe.saveShown === true && editPwdProbe.backToView === true, JSON.stringify(editPwdProbe));
    // Key-auth browse button (F1): follows the auth toggle's disabled state;
    // picking fills the keypath input, cancel leaves it untouched. The dialog
    // invoke is stubbed so no native dialog ever appears.
    const keyBrowseProbe = await cdp.eval(`(async () => {
      const r = {};
      const prev = ipcRenderer.invoke;
      let dialogCalls = 0;
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'show-open-dialog') { dialogCalls++; return Promise.resolve(window.__keyBrowseMock); }
        return prev(cmd, args);
      };
      try {
        openSSHEdit(true);
        const keyInput = document.getElementById('ssh-edit-keypath');
        const btn = document.getElementById('ssh-key-browse');
        r.initialDisabled = keyInput.disabled === true && btn.disabled === true; // password mode default
        setSSHAuth('密钥');
        r.keyModeEnabled = keyInput.disabled === false && btn.disabled === false;
        window.__keyBrowseMock = { canceled: true, filePaths: [] };
        keyInput.value = '';
        btn.click();
        await new Promise(rs => setTimeout(rs, 100));
        r.cancelKeepsEmpty = keyInput.value === '';
        window.__keyBrowseMock = { canceled: false, filePaths: ['C:/keys/e2e_id_rsa'] };
        btn.click();
        await new Promise(rs => setTimeout(rs, 100));
        r.filled = keyInput.value;
        setSSHAuth('密码');
        r.restoredDisabled = keyInput.disabled === true && btn.disabled === true;
        r.dialogCalls = dialogCalls;
        // Busy guard: a second click while the dialog is pending must not open
        // another one; resolving it then fills the input (overlay still open).
        setSSHAuth('密钥');
        let resolvePending;
        window.__keyBrowseMock = null;
        ipcRenderer.invoke = (cmd, args) => {
          if (cmd === 'show-open-dialog') { dialogCalls++; return new Promise(res => { resolvePending = res; }); }
          return prev(cmd, args);
        };
        const callsBefore = dialogCalls;
        browseSshKeyPath();
        browseSshKeyPath();
        await new Promise(rs => setTimeout(rs, 50));
        r.spamSingleDialog = dialogCalls === callsBefore + 1;
        resolvePending({ canceled: false, filePaths: ['D:/keys/pending.pem'] });
        await new Promise(rs => setTimeout(rs, 50));
        r.pendingFilled = keyInput.value;
        // Late resolve after the overlay closed must not write into the form.
        closeOverlay('overlay-ssh-edit');
        keyInput.value = 'sentinel';
        browseSshKeyPath();
        await new Promise(rs => setTimeout(rs, 50));
        resolvePending({ canceled: false, filePaths: ['D:/keys/late.pem'] });
        await new Promise(rs => setTimeout(rs, 50));
        r.lateWriteDropped = keyInput.value === 'sentinel';
        closeOverlay('overlay-ssh-edit');
      } finally {
        ipcRenderer.invoke = prev;
        delete window.__keyBrowseMock;
      }
      return r;
    })()`).catch(() => null);
    check('SSH 密钥：浏览按钮回填私钥路径（取消不动字段，随认证方式联动禁用，连击/迟到写入被守卫）',
      !!keyBrowseProbe && keyBrowseProbe.initialDisabled === true && keyBrowseProbe.keyModeEnabled === true &&
      keyBrowseProbe.cancelKeepsEmpty === true && keyBrowseProbe.filled === 'C:/keys/e2e_id_rsa' &&
      keyBrowseProbe.restoredDisabled === true && keyBrowseProbe.dialogCalls === 2 &&
      keyBrowseProbe.spamSingleDialog === true && keyBrowseProbe.pendingFilled === 'D:/keys/pending.pem' &&
      keyBrowseProbe.lateWriteDropped === true,
      JSON.stringify(keyBrowseProbe));
    // Template flow (issue #5): the "添加连接" buttons open a small menu —
    // blank new, or new-from-template via a picker overlay that mirrors the
    // session selector. The prefill/save behavior (DPAPI ciphertext carried
    // via the "已保存" status row, login scripts copied) is unchanged from the
    // original row-action design.
    const addMenuProbe = await cdp.eval(`(() => {
      const btn = document.querySelector('[data-ssh-add="settings"]');
      btn.click();
      const menu = document.getElementById('ssh-add-menu');
      const items = [...menu.querySelectorAll('.menu-item')];
      const r = btn.getBoundingClientRect();
      const open = menu.classList.contains('open');
      const topOk = Math.abs(parseFloat(menu.style.top) - (r.bottom + 6)) < 2;
      // Opens toward bottom-right when the menu fits (left edge aligns with
      // the trigger's left edge); otherwise right-aligned fallback. At the
      // default 1100px window the settings-page button is too far right, so
      // the fallback branch is what runs here — assert the formula, and use
      // the overlay button (below) to pin the primary branch.
      const mw = menu.offsetWidth;
      const expect = Math.max(8, Math.min(
        (r.left + mw + 8 <= window.innerWidth) ? r.left : r.right - mw,
        window.innerWidth - mw - 8));
      const leftOk = Math.abs(parseFloat(menu.style.left) - expect) < 2;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const labels = items.map(i => i.textContent.trim());
      // Esc closes the menu and returns focus to the trigger.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const closedByEsc = !menu.classList.contains('open') &&
        btn.getAttribute('aria-expanded') === 'false' && document.activeElement === btn;
      return { open, topOk, leftOk, expanded, labels, closedByEsc };
    })()`).catch(() => null);
    check('添加连接菜单：开合/位置/双项/aria-expanded', !!addMenuProbe &&
      addMenuProbe.open === true && addMenuProbe.topOk === true && addMenuProbe.leftOk === true && addMenuProbe.expanded === true &&
      JSON.stringify(addMenuProbe.labels) === JSON.stringify(['从模板新建…', '完全新建']),
      JSON.stringify(addMenuProbe));
    // The overlay trigger has room to its right at 1100px — pin the primary
    // bottom-right (left-anchored) branch there.
    const addMenuOverlayProbe = await cdp.eval(`(() => {
      openSSHManager();
      const btn = document.querySelector('[data-ssh-add="overlay"]');
      if (!btn) return { err: 'no overlay trigger' };
      btn.click();
      const menu = document.getElementById('ssh-add-menu');
      const r = btn.getBoundingClientRect();
      const mw = menu.offsetWidth;
      const fits = r.left + mw + 8 <= window.innerWidth;
      const leftOk = fits && Math.abs(parseFloat(menu.style.left) - r.left) < 2;
      const open = menu.classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      closeOverlay('overlay-ssh-manager');
      return { fits, leftOk, open };
    })()`).catch(() => null);
    check('添加连接菜单（浮层入口）：向右下展开（左缘锚定按钮）', !!addMenuOverlayProbe &&
      addMenuOverlayProbe.fits === true && addMenuOverlayProbe.leftOk === true && addMenuOverlayProbe.open === true,
      JSON.stringify(addMenuOverlayProbe));
    check('添加连接菜单：Esc 关闭且焦点回触发按钮', !!addMenuProbe && addMenuProbe.closedByEsc === true, JSON.stringify(addMenuProbe));
    const blankProbe = await cdp.eval(`(() => {
      document.querySelector('[data-ssh-add="settings"]').click();
      document.getElementById('ssh-add-blank').click();
      return {
        menuOpen: document.getElementById('ssh-add-menu').classList.contains('open'),
        open: document.getElementById('overlay-ssh-edit').classList.contains('open'),
        title: document.getElementById('ssh-edit-title').textContent,
        host: document.getElementById('ssh-edit-host').value,
        name: document.getElementById('ssh-edit-name').value
      };
    })()`).catch(() => null);
    check('添加连接菜单：完全新建打开空白对话框', !!blankProbe &&
      blankProbe.menuOpen === false && blankProbe.open === true &&
      blankProbe.title === '添加 SSH 连接' && blankProbe.host === '' && blankProbe.name === '',
      JSON.stringify(blankProbe));
    await cdp.eval(`closeOverlay('overlay-ssh-edit'); 'closed'`).catch(() => null);
    // Picker: opens from the menu, lists only SSH profiles, searches, and a
    // click prefills the dialog from the chosen template.
    const tplPickerProbe = await cdp.eval(`(async () => {
      const fx = TabManager.sshProfiles.find(p => p.id === 'e2essh1');
      fx.encryptedPassword = 'e2e-tpl-cipher';
      fx.loginScripts = [{ expect: 'ogin:', send: 'root', isRegex: false, optional: false }];
      document.querySelector('[data-ssh-add="settings"]').click();
      document.getElementById('ssh-add-template').click();
      await new Promise(r => setTimeout(r, 250));
      const rows = () => [...document.querySelectorAll('#ssh-template-list .ss-row')].map(r2 => r2.dataset.id);
      const open = document.getElementById('overlay-ssh-template').classList.contains('open');
      const title = document.getElementById('ssh-template-title').textContent;
      const menuClosed = !document.getElementById('ssh-add-menu').classList.contains('open');
      const all = rows();
      const selFirst = document.querySelector('#ssh-template-list .ss-row[aria-selected="true"]')?.dataset.id || null;
      filterSSHTemplates('构建');
      const narrowed = rows();
      filterSSHTemplates('');
      const restored = rows();
      document.querySelector('#ssh-template-list .ss-row[data-id="ssh_e2essh1"]').click();
      const pwd = document.getElementById('ssh-edit-password');
      const st = document.getElementById('ssh-pwd-status');
      return {
        open, title, menuClosed, all, selFirst, narrowed, restored,
        pickerClosed: !document.getElementById('overlay-ssh-template').classList.contains('open'),
        editOpen: document.getElementById('overlay-ssh-edit').classList.contains('open'),
        editTitle: document.getElementById('ssh-edit-title').textContent,
        name: document.getElementById('ssh-edit-name').value,
        host: document.getElementById('ssh-edit-host').value,
        user: document.getElementById('ssh-edit-user').value,
        group: document.getElementById('ssh-edit-group').value,
        port: document.getElementById('ssh-edit-port').value,
        viewMode: st.style.display === 'flex' && pwd.style.display === 'none',
        scripts: document.querySelectorAll('#login-scripts-container .login-script-row').length
      };
    })()`).catch(() => null);
    check('模板选择浮层：打开/列表/搜索/清空恢复', !!tplPickerProbe &&
      tplPickerProbe.open === true && tplPickerProbe.title === '选择模板连接' && tplPickerProbe.menuClosed === true &&
      JSON.stringify(tplPickerProbe.all) === JSON.stringify(['ssh_e2essh1', 'ssh_e2essh2', 'ssh_e2essh3']) &&
      tplPickerProbe.selFirst === 'ssh_e2essh1' &&
      JSON.stringify(tplPickerProbe.narrowed) === JSON.stringify(['ssh_e2essh2']) &&
      tplPickerProbe.restored.length === 3,
      JSON.stringify(tplPickerProbe));
    check('模板选择→预填新连接对话框（密码状态行+登录脚本携带）', !!tplPickerProbe &&
      tplPickerProbe.pickerClosed === true && tplPickerProbe.editOpen === true &&
      tplPickerProbe.editTitle === '从模板新建 SSH 连接' &&
      tplPickerProbe.name === '' && tplPickerProbe.host === '192.0.2.10' && tplPickerProbe.user === 'deploy' &&
      tplPickerProbe.group === '生产' && String(tplPickerProbe.port) === '22' &&
      tplPickerProbe.viewMode === true && tplPickerProbe.scripts === 1,
      JSON.stringify(tplPickerProbe));
    const tplSave = await cdp.eval(`(async () => {
      document.getElementById('ssh-edit-name').value = 'e2e-tpl';
      document.getElementById('ssh-edit-host').value = '198.51.100.9';
      saveSSHEdit();
      await new Promise(r => setTimeout(r, 600));
      const tpl = (TabManager.sshProfiles || []).find(p => p.name === 'e2e-tpl');
      const src = TabManager.sshProfiles.find(p => p.id === 'e2essh1');
      return { found: !!tpl, id: tpl && tpl.id, host: tpl && tpl.host,
        pwd: tpl && tpl.encryptedPassword, group: tpl && tpl.group,
        user: tpl && tpl.username, port: tpl && tpl.port,
        scripts: tpl && tpl.loginScripts && tpl.loginScripts.length,
        srcHost: src && src.host,
        overlayOpen: document.getElementById('overlay-ssh-edit').classList.contains('open') };
    })()`).catch(() => null);
    check('模板新建：保存为新 profile（密码密文/分组/脚本携带，id 全新，源不变）', !!tplSave &&
      tplSave.found === true && tplSave.id && tplSave.id !== 'e2essh1' &&
      tplSave.host === '198.51.100.9' && tplSave.pwd === 'e2e-tpl-cipher' &&
      tplSave.group === '生产' && tplSave.user === 'deploy' && Number(tplSave.port) === 22 &&
      tplSave.scripts === 1 && tplSave.srcHost === '192.0.2.10' && tplSave.overlayOpen === false,
      JSON.stringify(tplSave));
    // Restore the 3-row fixture (drop the template-created profile + the
    // seeded fields) so the session selector's sshRows === 3 assertion below
    // still holds.
    await cdp.eval(`(async () => {
      TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => p.name !== 'e2e-tpl');
      const fx = TabManager.sshProfiles.find(p => p.id === 'e2essh1');
      delete fx.encryptedPassword;
      delete fx.loginScripts;
      await ipcRenderer.invoke('save-ssh-profiles', { sshProfiles: TabManager.sshProfiles });
      renderSSHManager();
      return TabManager.sshProfiles.length;
    })()`).catch(() => null);
    // Keyboard path from the manager overlay's add button: menu -> template ->
    // ArrowDown/Enter picks the second profile (named + key auth), covering
    // the "副本" suffix branch and the private-key carry (password row hidden).
    const tplKeyProbe = await cdp.eval(`(async () => {
      openSSHManager();
      await new Promise(r => setTimeout(r, 200));
      const ovBtn = document.querySelector('[data-ssh-add="overlay"]');
      ovBtn.click();
      const menuOpen = document.getElementById('ssh-add-menu').classList.contains('open');
      document.getElementById('ssh-add-template').click();
      await new Promise(r => setTimeout(r, 250));
      const pickerOpen = document.getElementById('overlay-ssh-template').classList.contains('open');
      const mgrClosed = !document.getElementById('overlay-ssh-manager').classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      const sel = document.querySelector('#ssh-template-list .ss-row[aria-selected="true"]')?.dataset.id || null;
      const actDesc = document.getElementById('ssh-template-search').getAttribute('aria-activedescendant');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 50));
      const r2 = {
        menuOpen, pickerOpen, mgrClosed, sel, actDesc,
        editTitle: document.getElementById('ssh-edit-title').textContent,
        name: document.getElementById('ssh-edit-name').value,
        host: document.getElementById('ssh-edit-host').value,
        port: document.getElementById('ssh-edit-port').value,
        user: document.getElementById('ssh-edit-user').value,
        auth: document.getElementById('ssh-edit-auth').value,
        keypath: document.getElementById('ssh-edit-keypath').value,
        pwdRowHidden: document.getElementById('ssh-pwd-field').style.display === 'none' &&
          document.getElementById('ssh-pwd-row').style.display !== 'none'
      };
      closeOverlay('overlay-ssh-edit');
      return r2;
    })()`).catch(() => null);
    check('模板选择：管理浮层入口+键盘导航 Enter 选中（" 副本"后缀/keypath 携带/密码字段隐藏且备注行保留）', !!tplKeyProbe &&
      tplKeyProbe.menuOpen === true && tplKeyProbe.pickerOpen === true && tplKeyProbe.mgrClosed === true &&
      tplKeyProbe.sel === 'ssh_e2essh2' && tplKeyProbe.actDesc === 'ssh-tpl-opt-ssh_e2essh2' &&
      tplKeyProbe.editTitle === '从模板新建 SSH 连接' &&
      tplKeyProbe.name === '构建机 副本' && tplKeyProbe.host === 'builder.example.com' &&
      String(tplKeyProbe.port) === '2222' && tplKeyProbe.user === 'ci' &&
      tplKeyProbe.auth === '密钥' && tplKeyProbe.keypath === 'C:/keys/ci' &&
      tplKeyProbe.pwdRowHidden === true,
      JSON.stringify(tplKeyProbe));
    // Picker Esc closes only the picker and restores focus to the invoking
    // add button (opener restore, same contract as the session selector).
    const tplEscProbe = await cdp.eval(`(async () => {
      const btn = document.querySelector('[data-ssh-add="settings"]');
      btn.click();
      document.getElementById('ssh-add-template').click();
      await new Promise(r => setTimeout(r, 250));
      const open = document.getElementById('overlay-ssh-template').classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 50));
      return { open,
        closed: !document.getElementById('overlay-ssh-template').classList.contains('open'),
        focusBack: document.activeElement === btn };
    })()`).catch(() => null);
    check('模板选择浮层：Esc 关闭且焦点回添加按钮', !!tplEscProbe &&
      tplEscProbe.open === true && tplEscProbe.closed === true && tplEscProbe.focusBack === true,
      JSON.stringify(tplEscProbe));
    // Zero profiles: the template entry is disabled and the pick guard does
    // not open the picker (mouse is already blocked by pointer-events:none).
    const tplDisabledProbe = await cdp.eval(`(() => {
      const saved = TabManager.sshProfiles;
      TabManager.sshProfiles = [];
      const btn = document.querySelector('[data-ssh-add="settings"]');
      btn.click();
      const tpl = document.getElementById('ssh-add-template');
      const disabled = tpl.classList.contains('disabled') && tpl.getAttribute('aria-disabled') === 'true';
      sshAddMenuPick('template'); // guard: must not open the picker
      const pickerStayedClosed = !document.getElementById('overlay-ssh-template').classList.contains('open');
      closeSSHAddMenu(false);
      TabManager.sshProfiles = saved;
      return { disabled, pickerStayedClosed };
    })()`).catch(() => null);
    check('添加连接菜单：零连接时"从模板新建"禁用且守卫不打开选择器', !!tplDisabledProbe &&
      tplDisabledProbe.disabled === true && tplDisabledProbe.pickerStayedClosed === true,
      JSON.stringify(tplDisabledProbe));
    // Session selector: combobox semantics, default-local preselection, wrap
    // navigation, IME guard, button-Enter guard and click/Enter dispatch
    // (createTab stubbed — a real dispatch would dial the fixture host).
    const selSetup = await cdp.eval(`(() => {
      window.__e2eCreated = [];
      window.__e2eOrigCreateTab = TabManager.createTab.bind(TabManager);
      TabManager.createTab = (opts) => { window.__e2eCreated.push(opts); return { id: 'stub' }; };
      openSessionSelector();
      return 'ok';
    })()`).catch(() => null);
    await sleep(400);
    const selInit = await cdp.eval(`(() => {
      const items = getSessionItems('');
      const search = document.getElementById('sessions-search');
      return {
        open: document.getElementById('overlay-sessions').classList.contains('open'),
        focus: document.activeElement?.id,
        role: search.getAttribute('role'), controls: search.getAttribute('aria-controls'),
        listRole: document.getElementById('sessions-list').getAttribute('role'),
        optionRole: document.querySelector('#sessions-list .ss-row')?.getAttribute('role'),
        sshRows: items.filter(i => i.type === 'ssh').length,
        active: _sessionSel.activeId,
        actDesc: search.getAttribute('aria-activedescendant'),
        selectedRow: document.querySelector('#sessions-list .ss-row[aria-selected="true"]')?.dataset.id
      };
    })()`);
    const selInitOk = selSetup === 'ok' && selInit.open === true && selInit.focus === 'sessions-search' &&
      selInit.role === 'combobox' && selInit.controls === 'sessions-list' && selInit.listRole === 'listbox' && selInit.optionRole === 'option' &&
      selInit.sshRows === 3 && !!selInit.active && selInit.active.startsWith('local_') &&
      selInit.selectedRow === selInit.active && selInit.actDesc === 'sess-opt-' + selInit.active;
    check('会话选择器：combobox 语义 + 默认本地预选 + 焦点', selInitOk === true, JSON.stringify(selInit));
    await shot('session-selector');
    const selNav = await cdp.eval(`(() => {
      const items = getSessionItems('');
      const search = document.getElementById('sessions-search');
      const start = _sessionSel.activeId;
      const idx = items.findIndex(i => i.id === start);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      const wrapped = _sessionSel.activeId;
      const expectWrap = items[(idx - 1 + items.length) % items.length].id;
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return { start, wrapped, expectWrap, back: _sessionSel.activeId };
    })()`);
    check('会话选择器：↑↓ 循环导航', selNav.wrapped === selNav.expectWrap && selNav.back === selNav.start, JSON.stringify(selNav));
    const selIme = await cdp.eval(`(() => {
      const search = document.getElementById('sessions-search');
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      return { created: window.__e2eCreated.length, open: document.getElementById('overlay-sessions').classList.contains('open') };
    })()`);
    check('会话选择器：IME 合成中 Enter 不触发打开', selIme.created === 0 && selIme.open === true, JSON.stringify(selIme));
    const selBtn = await cdp.eval(`(() => {
      const btn = document.querySelector('#overlay-sessions .ss-manage');
      btn.focus();
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { created: window.__e2eCreated.length, open: document.getElementById('overlay-sessions').classList.contains('open') };
    })()`);
    check('会话选择器：按钮上的 Enter 不劫持', selBtn.created === 0 && selBtn.open === true, JSON.stringify(selBtn));
    const selEnter = await cdp.eval(`(() => {
      const search = document.getElementById('sessions-search');
      search.value = '日志';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = [...document.querySelectorAll('#sessions-list .ss-row')].map(r => r.dataset.id);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { rows, created: window.__e2eCreated, open: document.getElementById('overlay-sessions').classList.contains('open') };
    })()`);
    const selEnterOk = JSON.stringify(selEnter.rows) === JSON.stringify(['ssh_e2essh3']) &&
      selEnter.created.length === 1 && selEnter.created[0].type === 'ssh' && selEnter.created[0].host === '2001:db8::5' &&
      selEnter.created[0].user === 'root' && selEnter.created[0].sshProfileId === 'e2essh3' && selEnter.open === false;
    check('会话选择器：过滤后 Enter 精确打开目标', selEnterOk === true, JSON.stringify(selEnter));
    const selClick = await cdp.eval(`(() => {
      openSessionSelector();
      const row = [...document.querySelectorAll('#sessions-list .ss-row')].find(r => r.dataset.id === 'ssh_e2essh1');
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { created: window.__e2eCreated.map(c => c.sshProfileId || c.type),
        open: document.getElementById('overlay-sessions').classList.contains('open') };
    })()`);
    check('会话选择器：点击行打开该目标', selClick.created.length === 2 && selClick.created[1] === 'e2essh1' && selClick.open === false, JSON.stringify(selClick));
    const selEsc = await cdp.eval(`(() => {
      openSessionSelector();
      document.getElementById('sessions-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const closed = !document.getElementById('overlay-sessions').classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return { closed, sel: _sessionSel };
    })()`);
    check('会话选择器：Esc 关闭并解绑按键', selEsc.closed === true && selEsc.sel === null, JSON.stringify(selEsc));
    await cdp.eval(`(() => { TabManager.createTab = window.__e2eOrigCreateTab; return 'unstub'; })()`);
    // Narrow viewport via CDP emulation (OS-level setSize needs the
    // core:window:allow-set-size capability, which the app deliberately does
    // not grant the renderer): the 560px media query still applies. The
    // override sits in try/finally so a failed assertion can never leak an
    // emulated viewport into the remaining sections.
    const emulated = await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 720, deviceScaleFactor: 1, mobile: false }).then(() => true).catch(() => false);
    try {
      await sleep(400);
      const narrow = await cdp.eval(`({ w: window.innerWidth, rows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length })`).catch(() => ({ w: 0, rows: 0 }));
      check('窄窗口（560px）SSH 列表仍完整渲染', emulated === true && narrow.w === 560 && narrow.rows === 3, JSON.stringify({ emulated, ...narrow }));
      await shot('ssh-settings-narrow');
      // The fixed-560px manager panel must stay inside the narrower viewport
      // (inline max-width: calc(100vw - 32px) on the .ssh-manager-panel div).
      await cdp.eval(`openSSHManager(); 'm-narrow'`).catch(() => null);
      await sleep(350);
      const panelFit = await cdp.eval(`(() => {
        const r = document.querySelector('#overlay-ssh-manager .panel').getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
      })()`).catch(() => null);
      check('窄窗口（560px）管理浮层面板不溢出视口', !!panelFit && panelFit.left >= 0 && panelFit.right <= panelFit.vw, JSON.stringify(panelFit));
      await cdp.eval(`closeOverlay('overlay-ssh-manager'); 'm-narrow-off'`).catch(() => null);
      // Extreme 320px pass: rows still render, panel still fits.
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false }).catch(() => null);
      await sleep(350);
      const tiny = await cdp.eval(`({ w: window.innerWidth, rows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length })`).catch(() => ({ w: 0, rows: 0 }));
      await cdp.eval(`openSSHManager(); 'm-tiny'`).catch(() => null);
      await sleep(350);
      const tinyFit = await cdp.eval(`(() => {
        const r = document.querySelector('#overlay-ssh-manager .panel').getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
      })()`).catch(() => null);
      check('极窄窗口（320px）列表渲染且面板不溢出', tiny.w === 320 && tiny.rows === 3 && !!tinyFit && tinyFit.left >= 0 && tinyFit.right <= tinyFit.vw,
        JSON.stringify({ ...tiny, ...tinyFit }));
      await cdp.eval(`closeOverlay('overlay-ssh-manager'); 'm-tiny-off'`).catch(() => null);
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => null);
    }
    await sleep(300);
    // Clear-button visibility follows the query (the .ss-clear[hidden] rule
    // must beat display:flex), and clicking it resets the search.
    const clearBtn = await cdp.eval(`(() => {
      openSessionSelector();
      const search = document.getElementById('sessions-search');
      const clear = document.getElementById('sessions-clear');
      const initiallyHidden = clear.hidden && getComputedStyle(clear).display === 'none';
      search.value = 'x';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const shownWhenTyping = !clear.hidden && getComputedStyle(clear).display !== 'none';
      clear.click();
      return { initiallyHidden, shownWhenTyping,
        hiddenAfterClear: clear.hidden && getComputedStyle(clear).display === 'none',
        query: search.value };
    })()`).catch(() => null);
    check('会话选择器：清空按钮显隐联动并可点击清空', !!clearBtn && clearBtn.initiallyHidden && clearBtn.shownWhenTyping && clearBtn.hiddenAfterClear && clearBtn.query === '',
      JSON.stringify(clearBtn));
    // IME composition must not close the overlay (Escape with keyCode 229 is a
    // candidate-window cancel, not an overlay close).
    const imeEsc = await cdp.eval(`(() => {
      const search = document.getElementById('sessions-search');
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
      return document.getElementById('overlay-sessions').classList.contains('open');
    })()`).catch(() => false);
    check('会话选择器：IME 合成中 Esc(229) 不关闭', imeEsc === true, '');
    // Esc with a visible opener restores focus to that opener.
    const escFocus = await cdp.eval(`(() => {
      const opener = document.querySelector('[data-ssh-search="settings-ssh-list"]');
      if (!opener) return { opener: false };
      opener.focus();
      openSessionSelector();
      document.getElementById('sessions-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { opener: true,
        closed: !document.getElementById('overlay-sessions').classList.contains('open'),
        back: document.activeElement === opener };
    })()`).catch(() => null);
    check('会话选择器：Esc 关闭后焦点回到打开者', !!escFocus && escFocus.closed === true && escFocus.back === true, JSON.stringify(escFocus));
    // Selector → manager overlay → back: both entries hand focus over and the
    // panels swap exactly once.
    const roundtrip = await cdp.eval(`(() => {
      openSessionSelector();
      document.querySelector('#overlay-sessions .ss-manage').click();
      const mgrOpen = document.getElementById('overlay-ssh-manager').classList.contains('open');
      const selClosed = !document.getElementById('overlay-sessions').classList.contains('open');
      document.querySelector('#overlay-ssh-manager .ss-manage').click();
      return { mgrOpen, selClosed,
        selBack: document.getElementById('overlay-sessions').classList.contains('open'),
        mgrClosed: !document.getElementById('overlay-ssh-manager').classList.contains('open') };
    })()`).catch(() => null);
    check('会话选择器↔管理浮层往返', !!roundtrip && roundtrip.mgrOpen && roundtrip.selClosed && roundtrip.selBack && roundtrip.mgrClosed, JSON.stringify(roundtrip));
    // Tab trap wraps in both directions over the visible focusable set.
    const tabTrap = await cdp.eval(`(() => {
      const panel = document.querySelector('#overlay-sessions .panel');
      const focusables = [...panel.querySelectorAll('input, button')].filter(el => !el.hidden && el.offsetParent !== null);
      const first = focusables[0], last = focusables[focusables.length - 1];
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      const wrappedBack = document.activeElement === last;
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true }));
      return { wrappedBack, wrappedFwd: document.activeElement === first, n: focusables.length };
    })()`).catch(() => null);
    check('会话选择器：Tab/Shift+Tab 焦点陷阱双向循环', !!tabTrap && tabTrap.n >= 3 && tabTrap.wrappedBack && tabTrap.wrappedFwd, JSON.stringify(tabTrap));
    // Zero-result navigation is a no-op (no crash, selection stays empty).
    const zeroNav = await cdp.eval(`(() => {
      const search = document.getElementById('sessions-search');
      search.value = 'zzz-none';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = document.querySelectorAll('#sessions-list .ss-row').length;
      const before = _sessionSel && _sessionSel.activeId;
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      const after = _sessionSel && _sessionSel.activeId;
      const open = document.getElementById('overlay-sessions').classList.contains('open');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return { rows, before, after, open };
    })()`).catch(() => null);
    check('会话选择器：零结果时方向键为空操作', !!zeroNav && zeroNav.rows === 0 && zeroNav.before === zeroNav.after && zeroNav.open === true, JSON.stringify(zeroNav));
    await cdp.eval(`_closeSessionSelector(false); 'sel-off'`).catch(() => null);
    // A hidden opener (button inside a since-closed overlay) must not receive
    // focus back; the fallback path runs instead of stranding focus.
    const hiddenOpener = await cdp.eval(`(() => {
      openSSHManager();
      const btn = document.querySelector('#overlay-ssh-manager .ss-manage');
      btn.focus();
      openSessionSelector(); // openOverlay closes the manager → opener hidden
      document.getElementById('sessions-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { closed: !document.getElementById('overlay-sessions').classList.contains('open') };
    })()`).catch(() => null);
    await sleep(250); // outlast the 100ms deferred focus of the closed opening
    const hiddenOpenerFocus = await cdp.eval(`(() => {
      const ae = document.activeElement;
      return { tag: ae && ae.tagName, id: ae && ae.id,
        inSessions: !!(ae && ae.closest && ae.closest('#overlay-sessions')),
        isMgrBtn: !!(ae && ae.classList && ae.classList.contains('ss-manage')) };
    })()`).catch(() => null);
    check('隐藏打开者不回收焦点且延迟聚焦不复活', !!hiddenOpener && hiddenOpener.closed === true && !!hiddenOpenerFocus &&
      hiddenOpenerFocus.inSessions === false && hiddenOpenerFocus.isMgrBtn === false,
      JSON.stringify({ ...hiddenOpener, ...hiddenOpenerFocus }));
    // Manager redraws keep the focused control: icon button vs row identity
    // restore to their own kind, and a group title survives its own toggle.
    const focusKeep = await cdp.eval(`(() => {
      const list = document.getElementById('settings-ssh-list');
      const editSel = '.ssh-mgr-row[data-profile-id="e2essh1"] .ssh-mgr-btn[data-action="edit"]';
      list.querySelector(editSel).focus();
      filterSSHManager('settings-ssh-list', '192'); // row survives the query
      const afterQuery = document.activeElement === list.querySelector(editSel);
      filterSSHManager('settings-ssh-list', '');
      const afterClear = document.activeElement === list.querySelector(editSel);
      const idSel = '.ssh-mgr-row[data-profile-id="e2essh2"] .ssh-mgr-identity';
      list.querySelector(idSel).focus();
      filterSSHManager('settings-ssh-list', '构建');
      const identityKept = document.activeElement === list.querySelector(idSel);
      filterSSHManager('settings-ssh-list', '');
      const gh = list.querySelector('.ssh-mgr-group-title[data-group="生产"]');
      gh.focus();
      toggleSSHGroup(gh); // collapses: rows leave the DOM, the title stays
      const ghKept = document.activeElement === list.querySelector('.ssh-mgr-group-title[data-group="生产"]');
      toggleSSHGroup(list.querySelector('.ssh-mgr-group-title[data-group="生产"]'));
      return { afterQuery, afterClear, identityKept, ghKept };
    })()`).catch(() => null);
    check('SSH 管理页：重绘后焦点按控件类型还原', !!focusKeep && focusKeep.afterQuery && focusKeep.afterClear && focusKeep.identityKept && focusKeep.ghKept,
      JSON.stringify(focusKeep));
    // Removing every profile under a focused row drops to the empty state and
    // hands focus to the container search instead of a detached node.
    const emptyFocus = await cdp.eval(`(() => {
      const list = document.getElementById('settings-ssh-list');
      list.querySelector('.ssh-mgr-row[data-profile-id="e2essh1"] .ssh-mgr-btn[data-action="edit"]').focus();
      const saved = TabManager.sshProfiles;
      TabManager.sshProfiles = [];
      renderSSHManagerInto(list, _sshMgrView('settings-ssh-list'));
      const empty = (list.querySelector('.ssh-mgr-empty')?.textContent || '').includes('暂无 SSH 连接');
      const focusInSearch = !!(document.activeElement && document.activeElement.matches &&
        document.activeElement.matches('[data-ssh-search="settings-ssh-list"]'));
      const addBtn = !!list.querySelector('.ssh-mgr-empty-actions button');
      TabManager.sshProfiles = saved;
      renderSSHManagerInto(list, _sshMgrView('settings-ssh-list'));
      const restored = list.querySelectorAll('.ssh-mgr-row').length === 3;
      return { empty, focusInSearch, addBtn, restored };
    })()`).catch(() => null);
    check('SSH 管理页：零 profile 空态 + 焦点回落搜索', !!emptyFocus && emptyFocus.empty && emptyFocus.focusInSearch && emptyFocus.addBtn && emptyFocus.restored,
      JSON.stringify(emptyFocus));
    // Hostile fixture: quotes/markup in names and groups, a dirty string port.
    // Nothing may create elements or handlers; values round-trip via dataset;
    // the port collapses to the 22 default.
    const evilProbe = await cdp.eval(`(() => {
      const list = document.getElementById('settings-ssh-list');
      const saved = TabManager.sshProfiles;
      window.__evilFired = 0;
      window.__evil = () => { window.__evilFired++; };
      TabManager.sshProfiles = [
        { id: 'evil1', name: 'x</span><img src=x onerror="window.__evil()">', host: '198.51.100.7',
          port: '6000;window.__evil()', username: 'u<script>', group: 'g" onmouseover="window.__evil()', authType: 'password' }
      ];
      renderSSHManagerInto(list, _sshMgrView('settings-ssh-list'));
      const imgs = list.querySelectorAll('img').length;
      const scripts = list.querySelectorAll('script').length;
      const evilHandlers = [...list.querySelectorAll('*')]
        .filter(el => [...el.attributes].some(a => /^on/i.test(a.name) && a.value.includes('__evil'))).length;
      const row = list.querySelector('.ssh-mgr-row[data-profile-id="evil1"]');
      const roundtrip = !!row && row.dataset.profileId === 'evil1';
      const metaText = row ? (row.querySelector('.ssh-mgr-meta')?.textContent || '') : '';
      const gh = list.querySelector('.ssh-mgr-group-title');
      const groupRoundtrip = !!gh && gh.dataset.group === 'g" onmouseover="window.__evil()';
      const fired = window.__evilFired;
      TabManager.sshProfiles = saved;
      renderSSHManagerInto(list, _sshMgrView('settings-ssh-list'));
      const restored = list.querySelectorAll('.ssh-mgr-row').length === 3;
      return { imgs, scripts, evilHandlers, roundtrip, groupRoundtrip, metaText, fired, restored };
    })()`).catch(() => null);
    const evilOk = !!evilProbe && evilProbe.imgs === 0 && evilProbe.scripts === 0 && evilProbe.evilHandlers === 0 &&
      evilProbe.roundtrip === true && evilProbe.groupRoundtrip === true && evilProbe.fired === 0 &&
      evilProbe.metaText.includes('198.51.100.7:22') && evilProbe.restored === true;
    check('SSH 管理页：恶意名称/分组/脏端口零注入且数据往返', evilOk === true, JSON.stringify(evilProbe));
    // Leave the app as found (fixtures never reached the network).
    await cdp.eval(`(() => { TabManager.sshProfiles = []; _sshMgrViews.clear(); closeSettingsTab(); return 'clean'; })()`).catch(() => null);
    await sleep(300);

    // 13.8 Terminal link opening: plain links reach the open-url
    // IPC only via bare Ctrl+click; OSC 8 links confirm first and show the
    // real target; hover shows target + gesture hint; the release-notes link
    // shares the unified entry and toasts on failure. The IPC is wrapped, so
    // nothing in this section ever reaches the OS shell.
    const linkSetup = await cdp.eval(`(() => {
      window.__linkOpenCalls = [];
      window.__linkOrigInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = (cmd, args) => {
        if (cmd === 'open-url') { window.__linkOpenCalls.push(String((args && args.url) || '')); return Promise.resolve({ ok: true }); }
        return window.__linkOrigInvoke(cmd, args);
      };
      const locate = (needle) => {
        const term = TabManager.tabs.find(t => t.type === 'local').term;
        const buf = term.buffer.active;
        for (let y = 0; y < buf.length; y++) {
          const bufferLine = buf.getLine(y);
          const line = bufferLine?.translateToString(true) || '';
          const col = line.indexOf(needle);
          if (col < 0) continue;
          const row = y - buf.viewportY;
          if (row < 0 || row >= term.rows) continue;
          // String indices are not terminal cell columns when CJK/wide glyphs
          // precede the match. Map through the actual buffer cells.
          const bufferCell = buf.getNullCell();
          let cellCol = col, offset = 0;
          for (let x = 0; x < line.length && offset < col; x++) {
            bufferLine.getCell(x, bufferCell);
            if (bufferCell.getWidth() !== 0) offset += bufferCell.getChars().length || 1;
            cellCol = x + 1;
          }
          const screen = term.element.querySelector('.xterm-screen');
          const r = screen.getBoundingClientRect();
          const cell = term._core._renderService.dimensions.css.cell;
          return { screen, row, col: cellCol, r,
            px: r.left + (cellCol + 0.5) * cell.width,
            py: r.top + (row + 0.5) * cell.height };
        }
        return null;
      };
      window.__linkHover = (needle) => {
        const p = locate(needle);
        if (!p) return Promise.resolve({ at: 'not-found' });
        // xterm re-evaluates hover only when the buffer cell changes; an
        // earlier click hid the tip while the link stayed current, so first
        // move off the link (top-left corner is never a link), then back on.
        const corner = { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.r.left + 2, clientY: p.r.top + 2 };
        const over = { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.px, clientY: p.py };
        p.screen.dispatchEvent(new MouseEvent('mousemove', corner));
        return new Promise(res => setTimeout(() => {
          p.screen.dispatchEvent(new MouseEvent('mousemove', over));
          setTimeout(() => {
            const tip = document.querySelector('.link-tip');
            res({ at: 'hover@' + p.row + ':' + p.col, shown: !!tip && tip.classList.contains('show'), text: tip ? tip.textContent : '',
              font: tip ? getComputedStyle(tip.querySelector('.link-tip-target')).fontFamily : '',
              uiFont: getComputedStyle(document.body).fontFamily });
          }, 250);
        }, 60));
      };
      window.__linkClick = (needle, ctrl, refreshDuringDown = false) => {
        const p = locate(needle);
        if (!p) return Promise.resolve('not-found');
        const term = TabManager.tabs.find(t => t.type === 'local').term;
        // Same re-arm discipline as __linkHover: xterm re-evaluates hover only
        // on a buffer-cell change, and a resize/activation may have cleared
        // the current link since the last move — move off the link first,
        // then back on, then press. Without the detour a repeated click on
        // the same cell is not guaranteed to re-arm the link.
        const corner = { bubbles: true, cancelable: true, button: 0, ctrlKey: !!ctrl, clientX: p.r.left + 2, clientY: p.r.top + 2 };
        const opts = { bubbles: true, cancelable: true, button: 0, ctrlKey: !!ctrl, clientX: p.px, clientY: p.py };
        p.screen.dispatchEvent(new MouseEvent('mousemove', corner));
        return new Promise(res => setTimeout(() => {
          p.screen.dispatchEvent(new MouseEvent('mousemove', opts));
          setTimeout(() => {
            p.screen.dispatchEvent(new MouseEvent('mousedown', opts));
            if (!refreshDuringDown) {
              p.screen.dispatchEvent(new MouseEvent('mouseup', opts));
              res('click@' + p.row + ':' + p.col);
              return;
            }
            const down = term._core.linkifier._mouseDownLink;
            term.refresh(p.row, p.row);
            let remaining = 40;
            const finish = () => {
              const current = term._core.linkifier._currentLink;
              p.screen.dispatchEvent(new MouseEvent('mouseup', opts));
              res((current && current !== down ? 'refresh-swapped@' : 'refresh-stale@') + p.row + ':' + p.col);
            };
            const waitForRefresh = () => {
              const current = term._core.linkifier._currentLink;
              if ((current && current !== down) || --remaining <= 0) finish();
              else setTimeout(waitForRefresh, 25);
            };
            waitForRefresh();
          }, 200);
        }, 60));
      };
      const tab = TabManager.tabs.find(t => t.type === 'local');
      TabManager.switchTo(tab.id);
      return tab.id;
    })()`).catch(error => ({ error: String(error), stack: error?.stack }));
    await sleep(600);
    await cdp.eval(`(() => {
      const term = TabManager.tabs.find(t => t.type === 'local').term;
      term.write('\\r\\nhttps://e2e-link.example/plain-path\\r\\n');
      term.write('进展栏目已经上线，地址是 https://e2e-link.example:3000/progress/，用原来的私人站账号登录。\\r\\n');
      term.write('\\x1b]8;;https://e2e-osc8.example/real-target\\x07osc8-label\\x1b]8;;\\x07\\r\\n');
      return 'written';
    })()`).catch(() => null);
    await sleep(600);
    const linkPlain = await cdp.eval(`window.__linkClick('e2e-link.example', true)`).catch(e => 'eval-err');
    await sleep(300);
    const plainState = await cdp.eval(`({ calls: window.__linkOpenCalls, overlay: document.getElementById('overlay-confirm').classList.contains('open') })`);
    check('终端链接：Ctrl+点击纯文本链接直开一次', typeof linkPlain === 'string' && linkPlain.startsWith('click@') && plainState.calls.length === 1 && plainState.calls[0] === 'https://e2e-link.example/plain-path' && plainState.overlay === false,
      JSON.stringify({ linkPlain, ...plainState, setup: linkSetup }));
    const linkRefresh = await cdp.eval(`window.__linkClick('e2e-link.example', true, true)`).catch(() => 'eval-err');
    await sleep(300);
    const linkRefreshCalls = await cdp.eval(`window.__linkOpenCalls.length`);
    check('终端链接：按下期间刷新后抬起仍恰好打开一次', typeof linkRefresh === 'string' && linkRefresh.startsWith('refresh-swapped@') && linkRefreshCalls === plainState.calls.length + 1, JSON.stringify({ linkRefresh, linkRefreshCalls }));
    const linkCjk = await cdp.eval(`window.__linkClick('e2e-link.example:3000', true)`).catch(error => String(error));
    await sleep(300);
    const linkCjkCalls = await cdp.eval(`window.__linkOpenCalls`);
    check('终端链接：中文逗号后的文字不进入识别目标', typeof linkCjk === 'string' && linkCjk.startsWith('click@') && linkCjkCalls.length === linkRefreshCalls + 1 && linkCjkCalls.at(-1) === 'https://e2e-link.example:3000/progress/', JSON.stringify({ linkCjk, linkCjkCalls }));
    const cjkHover = await cdp.eval(`window.__linkHover('e2e-link.example:3000')`).catch(error => String(error));
    check('终端链接：中文语境悬停只显示有界地址', !!cjkHover && cjkHover.shown === true && cjkHover.text.includes('https://e2e-link.example:3000/progress/') && !cjkHover.text.includes('用原来的'), JSON.stringify(cjkHover));
    if (process.env.ZTERM_E2E_SHOTS && cjkHover?.shown === true) {
      mkdirSync(process.env.ZTERM_E2E_SHOTS, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot?.data) writeFileSync(join(process.env.ZTERM_E2E_SHOTS, 'link-cjk-boundary.png'), Buffer.from(shot.data, 'base64'));
    }
    const linkNoCtrl = await cdp.eval(`window.__linkClick('e2e-link.example', false)`).catch(() => 'eval-err');
    await sleep(300);
    const noCtrlCalls = await cdp.eval(`window.__linkOpenCalls.length`);
    check('终端链接：无 Ctrl 点击不打开', typeof linkNoCtrl === 'string' && linkNoCtrl.startsWith('click@') && noCtrlCalls === linkCjkCalls.length, JSON.stringify({ linkNoCtrl, noCtrlCalls }));
    const linkHover = await cdp.eval(`window.__linkHover('e2e-link.example')`).catch(() => null);
    const hoverOk = !!linkHover && linkHover.shown === true && linkHover.text.includes('https://e2e-link.example/plain-path') && linkHover.text.includes('Ctrl+点击打开');
    check('终端链接：悬停提示真实目标与手势', hoverOk === true, JSON.stringify(linkHover));
    check('终端链接：提示字体与应用界面字体一致', !!linkHover && linkHover.font === linkHover.uiFont, JSON.stringify({ font: linkHover?.font, uiFont: linkHover?.uiFont }));
    // Ride-along on the existing hover moment: one screenshot of the hover
    // state for visual REVIEW of the bottom-left corner (where WebView2's
    // link-hover status bar used to draw). Review material only — the
    // status-bar disablement itself is proven by the settings read-back in
    // 0.5, not by this image.
    {
      const shotDirEnv = process.env.ZTERM_E2E_SHOTS || '';
      if (shotDirEnv && hoverOk === true) {
        const hoverShot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (hoverShot?.data) {
          mkdirSync(shotDirEnv, { recursive: true });
          writeFileSync(join(shotDirEnv, 'link-hover-statusbar-review.png'), Buffer.from(hoverShot.data, 'base64'));
        }
      }
    }
    const oscBaseline = await cdp.eval(`window.__linkOpenCalls.length`);
    await cdp.eval(`window.__linkClick('osc8-label', true)`).catch(() => 'eval-err');
    await sleep(300);
    const oscConfirm = await cdp.eval(`({
      open: document.getElementById('overlay-confirm').classList.contains('open'),
      msg: document.getElementById('confirm-msg').textContent,
      okText: document.getElementById('confirm-ok').textContent,
      calls: window.__linkOpenCalls.length
    })`);
    const oscConfirmOk = oscConfirm.open === true && oscConfirm.msg.includes('https://e2e-osc8.example/real-target') && oscConfirm.okText === '打开' && oscConfirm.calls === oscBaseline;
    check('终端链接：OSC8 先弹确认（真实目标，未打开）', oscConfirmOk === true, JSON.stringify(oscConfirm));
    await cdp.eval(`document.getElementById('confirm-cancel').click(); 'cancel'`);
    await sleep(250);
    const oscAfterCancel = await cdp.eval(`({ open: document.getElementById('overlay-confirm').classList.contains('open'), calls: window.__linkOpenCalls.length })`);
    await cdp.eval(`window.__linkClick('osc8-label', true)`).catch(() => 'eval-err');
    await sleep(300);
    await cdp.eval(`document.getElementById('confirm-ok').click(); 'ok'`);
    await sleep(300);
    const oscAfterOk = await cdp.eval(`({ open: document.getElementById('overlay-confirm').classList.contains('open'), calls: window.__linkOpenCalls })`);
    const oscFlowOk = oscAfterCancel.open === false && oscAfterCancel.calls === oscBaseline && oscAfterOk.open === false && oscAfterOk.calls.length === oscBaseline + 1 && oscAfterOk.calls.at(-1) === 'https://e2e-osc8.example/real-target';
    check('终端链接：OSC8 取消零调用、确定调用一次', oscFlowOk === true, JSON.stringify({ oscAfterCancel, oscAfterOk }));
    // Drag-select gesture: press on the link, move off it, release elsewhere —
    // the Linkifier only activates when down/up land on the same link, so this
    // must never open (calls stay at 2 from the earlier plain + OSC8 opens).
    const linkDrag = await cdp.eval(`(() => {
      const term = TabManager.tabs.find(t => t.type === 'local').term;
      const buf = term.buffer.active;
      let p = null;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y)?.translateToString(true) || '';
        const col = line.indexOf('e2e-link.example');
        if (col < 0) continue;
        const row = y - buf.viewportY;
        if (row < 0 || row >= term.rows) continue;
        const screen = term.element.querySelector('.xterm-screen');
        const r = screen.getBoundingClientRect();
        p = { screen, px: r.left + (col + 0.5) * (r.width / term.cols), py: r.top + (row + 0.5) * (r.height / term.rows), left: r.left, top: r.top };
        break;
      }
      if (!p) return Promise.resolve('not-found');
      const on = { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.px, clientY: p.py };
      const off = { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.left + 3, clientY: p.top + 3 };
      p.screen.dispatchEvent(new MouseEvent('mousemove', on));
      return new Promise(res => setTimeout(() => {
        p.screen.dispatchEvent(new MouseEvent('mousedown', on));
        p.screen.dispatchEvent(new MouseEvent('mousemove', off));
        p.screen.dispatchEvent(new MouseEvent('mouseup', off));
        setTimeout(() => res({ calls: window.__linkOpenCalls.length,
          overlay: document.getElementById('overlay-confirm').classList.contains('open') }), 150);
      }, 200));
    })()`).catch(() => null);
    check('终端链接：拖出链接后抬起不打开', !!linkDrag && linkDrag.calls === oscAfterOk.calls.length && linkDrag.overlay === false, JSON.stringify(linkDrag));
    // Right button (even with Ctrl) is not an activation gesture.
    const linkRight = await cdp.eval(`(() => {
      const term = TabManager.tabs.find(t => t.type === 'local').term;
      const buf = term.buffer.active;
      let p = null;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y)?.translateToString(true) || '';
        const col = line.indexOf('e2e-link.example');
        if (col < 0) continue;
        const row = y - buf.viewportY;
        if (row < 0 || row >= term.rows) continue;
        const screen = term.element.querySelector('.xterm-screen');
        const r = screen.getBoundingClientRect();
        p = { screen, px: r.left + (col + 0.5) * (r.width / term.cols), py: r.top + (row + 0.5) * (r.height / term.rows) };
        break;
      }
      if (!p) return Promise.resolve('not-found');
      const opts = { bubbles: true, cancelable: true, button: 2, ctrlKey: true, clientX: p.px, clientY: p.py };
      p.screen.dispatchEvent(new MouseEvent('mousemove', opts));
      return new Promise(res => setTimeout(() => {
        p.screen.dispatchEvent(new MouseEvent('mousedown', opts));
        p.screen.dispatchEvent(new MouseEvent('mouseup', opts));
        setTimeout(() => res({ calls: window.__linkOpenCalls.length,
          overlay: document.getElementById('overlay-confirm').classList.contains('open') }), 150);
      }, 200));
    })()`).catch(() => null);
    check('终端链接：Ctrl+右键不打开', !!linkRight && linkRight.calls === oscAfterOk.calls.length && linkRight.overlay === false, JSON.stringify(linkRight));
    const notesProbe = await cdp.eval(`(() => {
      window.__updateUrl = 'https://notes.example/release';
      goUpdateReleaseNotes();
      return window.__linkOpenCalls.length;
    })()`);
    check('更新说明链接走统一 open-url 入口', notesProbe === oscAfterOk.calls.length + 1, `calls=${notesProbe}`);
    const notesFail = await cdp.eval(`(async () => {
      const read = () => {
        const t = document.getElementById('toast');
        return { shown: t.classList.contains('show'), text: t.textContent };
      };
      // The toast element is a global singleton shared by every notification,
      // so an ambient toast (e.g. a dead-SSH auto-retry failure from an earlier
      // section) can overwrite ours inside the 120ms window. Retry until the
      // expected error text is observed; report the attempt count.
      for (let attempt = 1; attempt <= 6; attempt++) {
        const prev = ipcRenderer.invoke;
        ipcRenderer.invoke = (cmd) => cmd === 'open-url' ? Promise.reject('blockedProtocol') : prev(cmd);
        try {
          goUpdateReleaseNotes();
          await new Promise(r => setTimeout(r, 120));
        } finally {
          ipcRenderer.invoke = prev;
        }
        const state = read();
        if (state.shown === true && state.text.includes('无法打开链接') && state.text.includes('blockedProtocol')) {
          return { ok: true, attempt, ...state };
        }
        await new Promise(r => setTimeout(r, 350));
      }
      return { ok: false, ...read() };
    })()`);
    check('更新说明链接失败弹出错误反馈', notesFail.ok === true, JSON.stringify(notesFail));
    const standardToast = await cdp.eval(`(() => {
      showToast('E2E 页内通知');
      const el = document.getElementById('toast');
      const style = getComputedStyle(el);
      const reference = document.createElement('span');
      reference.style.visibility = 'hidden';
      document.body.appendChild(reference);
      reference.style.color = 'rgb(var(--accent-rgb))';
      const accent = getComputedStyle(reference).color;
      reference.style.color = 'var(--accent-contrast)';
      const contrast = getComputedStyle(reference).color;
      reference.remove();
      return { className: el.className, background: style.backgroundColor, accent,
        color: style.color, contrast, radius: style.borderRadius };
    })()`);
    check('页内通知保持统一强调色胶囊样式', standardToast?.className === 'toast show'
      && standardToast.background === standardToast.accent
      && standardToast.color === standardToast.contrast && standardToast.radius === '20px', JSON.stringify(standardToast));
    await shot('toast-standard');
    await cdp.eval(`(() => { ipcRenderer.invoke = window.__linkOrigInvoke; window.__updateUrl = ''; return 'restored'; })()`).catch(() => null);

    // 13.9 Overlay style unification + search focus-ring + action-icon optical
    // alignment (user-reported visual issues). Re-seed SSH fixtures (13.7's
    // cleanup removed them) so the settings manager renders rows again.
    await cdp.eval(`(() => {
      TabManager.sshProfiles = [
        { id: 'e2essh1', name: '', host: '192.0.2.10', port: 22, username: 'deploy', group: '生产', authType: 'password' },
        { id: 'e2essh2', name: '构建机', host: 'builder.example.com', port: 2222, username: 'ci', group: '生产', authType: 'key' }
      ];
      openSettings('ssh');
      return 'seeded';
    })()`).catch(() => null);
    await sleep(450);
    // A) Search inputs inside bordered containers must not show the global
    // input focus ring (the container's focus-within border is the indicator).
    const ringProbe = await cdp.eval(`(() => {
      openSessionSelector();
      const s1 = document.getElementById('sessions-search');
      s1.focus();
      const r1 = getComputedStyle(s1).boxShadow;
      _closeSessionSelector(false);
      const s2 = document.querySelector('[data-ssh-search="settings-ssh-list"]');
      let r2 = 'missing';
      if (s2) { s2.focus(); r2 = getComputedStyle(s2).boxShadow; s2.blur(); }
      return { r1, r2 };
    })()`).catch(() => null);
    check('搜索框无内层焦点环（选择器/SSH 管理）', !!ringProbe && ringProbe.r1 === 'none' && ringProbe.r2 === 'none', JSON.stringify(ringProbe));
    // B) Row action icons: same rendered size, glyph ink centers within 0.6
    // viewBox units vertically (optical alignment, DPR-safe).
    const iconAlign = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-row')];
      if (!rows.length) return { missing: true };
      const svgs = [...rows[0].querySelectorAll('.ssh-mgr-btn svg')];
      const info = svgs.map(s => {
        const bb = s.getBBox();
        return { w: s.getAttribute('width'), cy: +(bb.y + bb.height / 2).toFixed(2) };
      });
      const cys = info.map(i => i.cy);
      return { info, spread: +(Math.max(...cys) - Math.min(...cys)).toFixed(2), n: svgs.length };
    })()`).catch(() => null);
    const iconAlignOk = !!iconAlign && iconAlign.n === 3 && iconAlign.spread <= 0.6 &&
      iconAlign.info.every(i => i.w === '14');
    check('SSH 行尾操作图标光学对齐（同尺寸/墨心一致）', iconAlignOk === true, JSON.stringify(iconAlign));
    // C1) Quick commands overlay carries the session-selector chrome (header
    // with title + close, ss-search, footer hints + manage entry), keeps its
    // data and keyboard flow, and closes on Esc.
    await cdp.eval(`openQC(); 'qc-open'`).catch(() => null);
    await sleep(350);
    const qcStruct = await cdp.eval(`(() => {
      const panel = document.querySelector('#overlay-qc .qc-panel');
      const items = [...document.querySelectorAll('#qc-list .v3-item')];
      const sel = document.querySelector('#qc-list .v3-item[data-selected]');
      const unsel = document.querySelector('#qc-list .v3-item:not([data-selected])');
      const itemCs = items.length ? getComputedStyle(items[0]) : null;
      const barCs = sel ? getComputedStyle(sel, '::before') : null;
      return {
        open: document.getElementById('overlay-qc').classList.contains('open'),
        title: document.getElementById('qc-title')?.textContent,
        close: !!panel.querySelector('.ss-close'),
        searchBox: !!panel.querySelector('.ss-search'),
        focus: document.activeElement && document.activeElement.id,
        sections: [...document.querySelectorAll('#qc-list .v3-section')].map(e => e.textContent),
        rows: items.length,
        roleOpt: items.length > 0 && items.every(e => e.getAttribute('role') === 'option' && ['true', 'false'].includes(e.getAttribute('aria-selected'))),
        selAria: sel ? sel.getAttribute('aria-selected') : '',
        selAccent: sel ? getComputedStyle(sel).backgroundColor : '',
        selBar: sel ? getComputedStyle(sel, '::before').width : '',
        itemTransProp: itemCs ? itemCs.transitionProperty : '',
        itemTransDur: itemCs ? itemCs.transitionDuration : '',
        barOp: barCs ? barCs.opacity : '',
        barTransProp: barCs ? barCs.transitionProperty : '',
        unselBarOp: unsel ? getComputedStyle(unsel, '::before').opacity : '',
        manage: panel.querySelector('.ss-manage')?.textContent,
        hints: panel.querySelectorAll('.ss-hints kbd').length
      };
    })()`).catch(() => null);
    const qcOk = !!qcStruct && qcStruct.open === true && qcStruct.title === '快捷命令' && qcStruct.close === true &&
      qcStruct.searchBox === true && qcStruct.focus === 'qc-input' && qcStruct.rows >= 1 &&
      qcStruct.sections.length >= 1 && qcStruct.roleOpt === true && qcStruct.selAria === 'true' &&
      qcStruct.selAccent.includes('0.14') && qcStruct.selBar === '2px' &&
      (qcStruct.manage || '').includes('管理命令') && qcStruct.hints === 3;
    check('快捷命令浮窗：选择器风格结构 + 数据与选中态', qcOk === true, JSON.stringify(qcStruct));
    // Selection chrome transitions in one synced 70ms ease-out (background +
    // border on the row, opacity on the always-rendered indicator bar — a bar
    // created/destroyed with the selection state cannot transition).
    const qcTransOk = !!qcStruct &&
      qcStruct.itemTransProp.includes('background-color') && qcStruct.itemTransProp.includes('border-color') &&
      qcStruct.itemTransDur.includes('0.07s') &&
      qcStruct.barTransProp.includes('opacity') && qcStruct.barOp === '1' && qcStruct.unselBarOp === '0';
    check('快捷命令浮窗：选中态 70ms 同步过渡 + 指示条渐显', qcTransOk === true, JSON.stringify(qcStruct));
    await shot('qc-overlay');
    const qcEsc = await cdp.eval(`(() => {
      document.getElementById('qc-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return !document.getElementById('overlay-qc').classList.contains('open');
    })()`).catch(() => false);
    check('快捷命令浮窗：Esc 关闭', qcEsc === true, '');
    // C2) Command palette: same chrome, search narrows rows, Esc closes (never
    // dispatch Enter here — palette Enter executes real actions).
    await cdp.eval(`openPalette(); 'pal-open'`).catch(() => null);
    await sleep(350);
    const palStruct = await cdp.eval(`(() => {
      const panel = document.querySelector('#overlay-palette .palette-panel');
      const inp = document.getElementById('palette-input');
      const all = document.querySelectorAll('#palette-list .v3-item').length;
      inp.value = 'ssh';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const narrowedItems = [...document.querySelectorAll('#palette-list .v3-item')];
      const narrowed = narrowedItems.length;
      const sel = document.querySelector('#palette-list .v3-item[data-selected]');
      const itemCs = narrowedItems.length ? getComputedStyle(narrowedItems[0]) : null;
      const barCs = sel ? getComputedStyle(sel, '::before') : null;
      return {
        open: document.getElementById('overlay-palette').classList.contains('open'),
        title: document.getElementById('palette-title')?.textContent,
        close: !!panel.querySelector('.ss-close'),
        focus: document.activeElement && document.activeElement.id,
        all, narrowed,
        roleOpt: narrowed > 0 && narrowedItems.every(e => e.getAttribute('role') === 'option' && ['true', 'false'].includes(e.getAttribute('aria-selected'))),
        selAria: sel ? sel.getAttribute('aria-selected') : '',
        hasKbd: !!document.querySelector('#palette-list .v3-kbd'),
        selAccent: sel ? getComputedStyle(sel).backgroundColor : '',
        itemTransProp: itemCs ? itemCs.transitionProperty : '',
        itemTransDur: itemCs ? itemCs.transitionDuration : '',
        barOp: barCs ? barCs.opacity : '',
        hints: panel.querySelectorAll('.ss-hints kbd').length
      };
    })()`).catch(() => null);
    const palOk = !!palStruct && palStruct.open === true && palStruct.title === '命令面板' && palStruct.close === true &&
      palStruct.focus === 'palette-input' && palStruct.all >= 10 && palStruct.narrowed >= 1 && palStruct.narrowed < palStruct.all &&
      palStruct.roleOpt === true && palStruct.selAria === 'true' &&
      palStruct.hasKbd === true && palStruct.selAccent.includes('0.14') && palStruct.hints === 3 &&
      palStruct.itemTransProp.includes('background-color') && palStruct.itemTransProp.includes('border-color') &&
      palStruct.itemTransDur.includes('0.07s') && palStruct.barOp === '1';
    check('命令面板浮窗：选择器风格结构 + 搜索过滤', palOk === true, JSON.stringify(palStruct));
    await shot('palette-overlay');
    const palEsc = await cdp.eval(`(() => {
      document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return !document.getElementById('overlay-palette').classList.contains('open');
    })()`).catch(() => false);
    check('命令面板浮窗：Esc 关闭', palEsc === true, '');
    // Leave 13.9 as found: fixtures out, settings page closed.
    await cdp.eval(`(() => { TabManager.sshProfiles = []; _sshMgrViews.clear(); closeSettingsTab(); return 'clean-13.9'; })()`).catch(() => null);
    await sleep(250);

    // 13.10 Settings SSH page: section titles + one settings-card per group.
    // Shared renderer/DOM untouched — the card chrome is scoped to the
    // .settings-card-list class (shared with the quick-commands settings page,
    // 13.11) while the overlay manager stays flat. Re-seed fixtures (13.9
    // cleaned them out).
    await cdp.eval(`(() => {
      TabManager.sshProfiles = [
        { id: 'e2essh1', name: '', host: '192.0.2.10', port: 22, username: 'deploy', group: '生产', authType: 'password' },
        { id: 'e2essh2', name: '构建机', host: 'builder.example.com', port: 2222, username: 'ci', group: '生产', authType: 'key' },
        { id: 'e2essh3', name: '', host: '2001:db8::7', port: 22, username: 'root', group: '运维', authType: 'key' }
      ];
      openSettings('ssh');
      return 'seeded-13.10';
    })()`).catch(() => null);
    await sleep(450);
    const cardStruct = await cdp.eval(`(() => {
      const groups = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group')];
      const cards = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-items')];
      const cs = cards[0] ? getComputedStyle(cards[0]) : null;
      const title = document.querySelector('#settings-ssh-list .ssh-mgr-group-title');
      const rule = title && title.querySelector('.group-rule');
      const row = document.querySelector('#settings-ssh-list .ssh-mgr-row');
      const refCard = document.querySelector('.settings-card');
      const page = document.querySelector('[data-page="ssh"]');
      const heading = page.querySelector('.settings-page-heading');
      const toolbar = page.querySelector('.settings-toolbar');
      const add = page.querySelector('.settings-primary-add');
      const addCs = add ? getComputedStyle(add) : null;
      return {
        groups: groups.length, cards: cards.length,
        cardBg: cs && cs.backgroundColor,
        refCardBg: refCard ? getComputedStyle(refCard).backgroundColor : 'missing',
        cardRadius: cs && cs.borderRadius,
        cardShadow: cs && cs.boxShadow, cardPadding: cs && cs.padding,
        cardHairline: cs ? getComputedStyle(cards[0], '::before').content : null,
        ruleDisplay: rule ? getComputedStyle(rule).display : 'missing',
        titleWeight: title && getComputedStyle(title).fontWeight,
        titleTracking: title && getComputedStyle(title).letterSpacing,
        rowBg: row && getComputedStyle(row).backgroundColor,
        headingBtns: heading ? heading.querySelectorAll('button').length : -1,
        addBtn: !!add, addH: addCs && addCs.height, addRadius: addCs && addCs.borderRadius,
        quietBtns: toolbar ? [...toolbar.querySelectorAll('.settings-quiet-action')].map(b => b.textContent) : []
      };
    })()`).catch(() => null);
    // Card surface must equal the appearance page's .settings-card surface
    // (scheme-derived token, not a hardcoded color).
    const cardOk = !!cardStruct && cardStruct.groups === 2 && cardStruct.cards === 2 &&
      cardStruct.refCardBg.startsWith('rgb') && cardStruct.cardBg === cardStruct.refCardBg &&
      cardStruct.cardRadius === '14px' &&
      cardStruct.cardShadow === 'none' && cardStruct.cardHairline === '""' && cardStruct.cardPadding === '6px 16px' &&
      cardStruct.ruleDisplay === 'none' && cardStruct.titleWeight === '600' &&
      !['normal', '0px'].includes(cardStruct.titleTracking || '') &&
      cardStruct.rowBg === 'rgba(0, 0, 0, 0)' &&
      cardStruct.headingBtns === 1 && cardStruct.addBtn === true &&
      cardStruct.addH === '32px' && cardStruct.addRadius === '9px' &&
      cardStruct.quietBtns.join(',') === '折叠全部,展开全部';
    check('SSH 设置页：每组一张设置卡片 + 分节标题 + 工具栏', cardOk === true, JSON.stringify(cardStruct));
    // Card-row hover is the user-picked combo (rounded wash + accent edge
    // bar), now provided by the BASE .ssh-mgr-row rules so the flat manager
    // overlay shares the exact same hover; the card scope only overrides
    // the geometry (inset box + bar offset). The identity carries no
    // redundant native title tooltip (aria-label retained).
    const hoverRule = await cdp.eval(`(() => {
      const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
      const wash = rules.some(r => r.selectorText === '.ssh-mgr-row:hover' && (r.style.backgroundColor || '') !== '');
      const bar = rules.some(r => r.selectorText === '.ssh-mgr-row:hover::before' && (r.style.opacity || '') !== '');
      const cardGeom = rules.some(r => r.selectorText === '.settings-card-list .ssh-mgr-row' && (r.style.margin || '').includes('-8px'));
      const cardBar = rules.some(r => r.selectorText === '.settings-card-list .ssh-mgr-row::before' && (r.style.left || '') !== '');
      const idEl = document.querySelector('#settings-ssh-list .ssh-mgr-identity');
      return { wash, bar, cardGeom, cardBar,
               identityNoTitle: idEl ? !idEl.hasAttribute('title') && !!idEl.getAttribute('aria-label') : null };
    })()`).catch(() => null);
    check('设置卡片行 hover：组合规则由基础类统一提供 + 卡片几何覆盖（无冗余 title）', !!hoverRule && hoverRule.wash === true && hoverRule.bar === true && hoverRule.cardGeom === true && hoverRule.cardBar === true && hoverRule.identityNoTitle === true, JSON.stringify(hoverRule));
    // Live hover: force :hover on both a settings-card row and a flat
    // manager-overlay row (the overlay list is re-rendered here so the probe
    // does not depend on stale DOM from earlier sections), poll for the bar's
    // transition end-state (fixed sleeps can read mid-transition values under
    // load), then assert the computed combo. The forced state is reset in
    // finally so a failed read cannot leak :hover into later checks.
    await cdp.eval(`renderSSHManager(); 'rerender'`).catch(() => null);
    const hoverLive = await (async () => {
      const nodes = [];
      try {
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const doc = await cdp.send('DOM.getDocument');
        for (const sel of ['#settings-ssh-list .ssh-mgr-row', '#ssh-manager-list .ssh-mgr-row']) {
          const n = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
          if (n && n.nodeId) nodes.push(n.nodeId);
        }
        for (const nodeId of nodes) {
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        }
        let v = null;
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          v = await cdp.eval(`(() => {
            const read = (sel) => {
              const row = document.querySelector(sel);
              if (!row) return null;
              const cs = getComputedStyle(row);
              const bar = getComputedStyle(row, '::before');
              return { bg: cs.backgroundColor, radius: cs.borderRadius,
                       barOpacity: bar.opacity, barW: bar.width, barColor: bar.backgroundColor,
                       barH: bar.height };
            };
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
            return { card: read('#settings-ssh-list .ssh-mgr-row'),
                     flat: read('#ssh-manager-list .ssh-mgr-row'),
                     expectedBar: 'rgb(' + accent.split(/\\s*,\\s*|\\s+/).join(', ') + ')' };
          })()`);
          if (v && v.card && v.flat && v.card.barOpacity === '0.85' && v.flat.barOpacity === '0.85') break;
        }
        return v;
      } catch { return null; }
      finally {
        for (const nodeId of nodes) {
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => null);
        }
      }
    })();
    check('设置卡片行 hover：实测圆角色块 + accent 指示条（计算值）', !!hoverLive && !!hoverLive.card &&
      hoverLive.card.bg === 'rgba(255, 255, 255, 0.05)' && hoverLive.card.radius === '9px' &&
      hoverLive.card.barOpacity === '0.85' && hoverLive.card.barW === '3px' && hoverLive.card.barH === '26px' &&
      hoverLive.card.barColor === hoverLive.expectedBar,
      JSON.stringify(hoverLive));
    check('SSH 管理浮层行 hover：同款圆角色块 + accent 指示条（计算值）', !!hoverLive && !!hoverLive.flat &&
      hoverLive.flat.bg === 'rgba(255, 255, 255, 0.05)' && hoverLive.flat.radius === '7px' &&
      hoverLive.flat.barOpacity === '0.85' && hoverLive.flat.barW === '3px' && hoverLive.flat.barH === '26px' &&
      hoverLive.flat.barColor === hoverLive.expectedBar,
      JSON.stringify(hoverLive && hoverLive.flat));
    // Floating surfaces carry the v12 top-lit hairline (a gradient pseudo
    // element) instead of a uniform inset ring.
    const menuEdge = await cdp.eval(`(() => {
      const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
      const hairlineRules = rules.filter(r => (r.selectorText || '').includes('::before') &&
        ((r.style.getPropertyValue('mask-composite') || '').includes('exclude') ||
         (r.style.getPropertyValue('-webkit-mask-composite') || '').includes('xor')));
      const hasEdge = sel => hairlineRules.some(r => (r.selectorText || '').includes(sel));
      return { popup: hasEdge('.menu-popup::before'), tabCtx: hasEdge('.tab-context-menu::before'),
               dd: hasEdge('.dd-menu::before'), combo: hasEdge('.dd-menu::before'),
               transfer: hasEdge('.transfer-window::before') };
    })()`).catch(() => null);
    check('浮层菜单：下拉与传输记录面板均带顶部受光发丝线', !!menuEdge && menuEdge.popup === true && menuEdge.tabCtx === true && menuEdge.dd === true && menuEdge.combo === true && menuEdge.transfer === true, JSON.stringify(menuEdge));
    // The search field's focus indicator is an inner accent ring on the
    // container (the inner input's ring is intentionally off), matching the
    // unified field system's inset focus.
    const searchFocusPre = await cdp.eval(`(() => {
      const box = document.querySelector('[data-page="ssh"] .settings-toolbar .ssh-mgr-search');
      const input = document.querySelector('[data-ssh-search="settings-ssh-list"]');
      if (!box || !input) return null;
      const before = getComputedStyle(box).boxShadow;
      input.focus();
      return { before };
    })()`).catch(() => null);
    await sleep(250);
    const searchFocusPost = await cdp.eval(`(() => {
      const box = document.querySelector('[data-page="ssh"] .settings-toolbar .ssh-mgr-search');
      if (!box) return null;
      const r = { after: getComputedStyle(box).boxShadow,
                  border: getComputedStyle(box).borderColor,
                  focused: document.activeElement === document.querySelector('[data-ssh-search="settings-ssh-list"]') };
      document.activeElement.blur();
      return r;
    })()`).catch(() => null);
    const searchFocusOk = !!searchFocusPre && !!searchFocusPost && searchFocusPost.focused === true &&
      searchFocusPre.before !== searchFocusPost.after &&
      searchFocusPost.after.includes('inset') && searchFocusPost.after.includes('97, 175, 239') &&
      searchFocusPost.border === 'rgba(0, 0, 0, 0)';
    check('SSH 设置页：搜索框焦点有容器内强调环', searchFocusOk === true, JSON.stringify({ ...searchFocusPre, ...searchFocusPost }));
    await shot('settings-ssh-cards');
    // Same-condition reference: the appearance page in the very same window,
    // DPR, theme and UI font, for the side-by-side chrome comparison.
    await cdp.eval(`openSettings('appearance'); 'appearance-13.10'`).catch(() => null);
    await sleep(350);
    await shot('settings-appearance-ref');
    await cdp.eval(`openSettings('ssh'); 'ssh-13.10'`).catch(() => null);
    await sleep(350);
    // Collapse-all via the moved toolbar buttons hides each whole card but
    // keeps the section titles; expand-all restores. Real button clicks, not
    // the bare functions, so the rewired toolbar itself is exercised.
    const collapseAll = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('[data-page="ssh"] .settings-toolbar .settings-quiet-action')];
      btns[0].click();
      const cards = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-items')];
      const titles = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-title')];
      return {
        hidden: cards.every(c => c.classList.contains('collapsed') && getComputedStyle(c).display === 'none' && c.offsetHeight === 0),
        titlesUp: titles.every(t => t.offsetHeight > 0),
        n: cards.length
      };
    })()`).catch(() => null);
    check('SSH 设置页：折叠全部隐藏整张卡片保留组标题', !!collapseAll && collapseAll.hidden === true && collapseAll.titlesUp === true && collapseAll.n === 2, JSON.stringify(collapseAll));
    await shot('ssh-settings-collapsed');
    const expandAllBack = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('[data-page="ssh"] .settings-toolbar .settings-quiet-action')];
      btns[1].click();
      const cards = [...document.querySelectorAll('#settings-ssh-list .ssh-mgr-group-items')];
      return cards.every(c => !c.classList.contains('collapsed') && c.offsetHeight > 0);
    })()`).catch(() => false);
    check('SSH 设置页：展开全部恢复卡片', expandAllBack === true, '');
    // Rename entry: opacity-revealed on focus (keyboard reachable), and the
    // reveal must not nudge the section title's height. The opacity has a
    // 120ms transition, so the post-focus read happens after a real sleep.
    const renamePre = await cdp.eval(`(() => {
      const title = document.querySelector('#settings-ssh-list .ssh-mgr-group-title');
      const btn = title && title.querySelector('.group-rename');
      if (!btn) return null;
      const h0 = title.offsetHeight;
      const op0 = getComputedStyle(btn).opacity;
      btn.focus();
      return { h0, op0 };
    })()`).catch(() => null);
    await sleep(250);
    const renamePost = await cdp.eval(`(() => {
      const title = document.querySelector('#settings-ssh-list .ssh-mgr-group-title');
      const btn = title && title.querySelector('.group-rename');
      if (!btn) return null;
      const r = { op1: getComputedStyle(btn).opacity, h1: title.offsetHeight,
                  focused: document.activeElement === btn };
      btn.blur();
      return r;
    })()`).catch(() => null);
    const renameOk = !!renamePre && !!renamePost && renamePre.op0 === '0' && renamePost.focused === true &&
      renamePost.op1 === '1' && renamePre.h0 === renamePost.h1;
    check('SSH 设置页：重命名入口焦点显现且不挤动标题', renameOk === true, JSON.stringify({ ...renamePre, ...renamePost }));
    // Overlay manager stays flat: same shared rows, no card chrome, rule kept.
    await cdp.eval(`openSSHManager(); 'mgr-13.10'`).catch(() => null);
    await sleep(350);
    const overlayFlat = await cdp.eval(`(() => {
      const items = document.querySelector('#ssh-manager-list .ssh-mgr-group-items');
      if (!items) return null;
      const cs = getComputedStyle(items);
      const rule = document.querySelector('#ssh-manager-list .group-rule');
      return { bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow,
               rule: rule ? getComputedStyle(rule).display : 'missing' };
    })()`).catch(() => null);
    check('SSH 管理浮层：保持平铺（无卡片样式）', !!overlayFlat && overlayFlat.bg === 'rgba(0, 0, 0, 0)' && overlayFlat.radius === '0px' && overlayFlat.shadow === 'none' && overlayFlat.rule !== 'none', JSON.stringify(overlayFlat));
    await shot('ssh-overlay-flat');
    await cdp.eval(`closeOverlay('overlay-ssh-manager'); 'mgr-13.10-off'`).catch(() => null);
    // Narrow (560px) and 150% zoom passes (CDP emulation, try/finally so a
    // failure can never leak an emulated viewport into later sections):
    // toolbar actions wrap to their own row, card padding tightens, rows and
    // card radius survive the zoom.
    const emu10 = await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 720, deviceScaleFactor: 1, mobile: false }).then(() => true).catch(() => false);
    try {
      await sleep(400);
      const narrowCard = await cdp.eval(`(() => {
        const toolbar = document.querySelector('[data-page="ssh"] .settings-toolbar');
        const actions = document.querySelector('[data-page="ssh"] .settings-toolbar-actions');
        const search = toolbar && toolbar.querySelector('.ssh-mgr-search');
        const card = document.querySelector('#settings-ssh-list .ssh-mgr-group-items');
        return { w: window.innerWidth,
                 wrapped: actions && search ? actions.getBoundingClientRect().top > search.getBoundingClientRect().top : null,
                 cardPadding: card ? getComputedStyle(card).padding : '',
                 rows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length };
      })()`).catch(() => null);
      check('窄窗口（560px）：工具栏动作换行且卡片内边距收窄', emu10 === true && !!narrowCard && narrowCard.w === 560 && narrowCard.wrapped === true && narrowCard.cardPadding === '6px 12px' && narrowCard.rows === 3, JSON.stringify(narrowCard));
      await shot('ssh-settings-cards-narrow');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1.5, mobile: false }).catch(() => null);
      await sleep(350);
      const zoomCard = await cdp.eval(`(() => {
        const card = document.querySelector('#settings-ssh-list .ssh-mgr-group-items');
        const cs = card ? getComputedStyle(card) : null;
        return { dpr: window.devicePixelRatio, radius: cs && cs.borderRadius,
                 rows: document.querySelectorAll('#settings-ssh-list .ssh-mgr-row').length };
      })()`).catch(() => null);
      check('150% 缩放：卡片圆角与行渲染保持', !!zoomCard && Math.abs(zoomCard.dpr - 1.5) < 0.01 && zoomCard.radius === '14px' && zoomCard.rows === 3, JSON.stringify(zoomCard));
      await shot('ssh-settings-cards-zoom150');
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => null);
    }
    await sleep(300);
    // Leave 13.10 as found: fixtures out, settings page closed.
    await cdp.eval(`(() => { TabManager.sshProfiles = []; _sshMgrViews.clear(); closeSettingsTab(); return 'clean-13.10'; })()`).catch(() => null);
    await sleep(250);

    // 13.11 Settings quick-commands page: same card chrome as the SSH settings
    // page (section titles + one settings-card per group), live search with
    // force-expand + collapse restore, delegated edit/delete routing, rename
    // derived from data-group, and focus continuity across redraws.
    await cdp.eval(`(() => {
      window.__qcBackup = _qcCommands;
      _qcCommands = [
        { id: 'e2eqc1', name: '查看系统信息', command: 'htop', group: '常用' },
        { id: 'e2eqc2', name: '查看磁盘使用', command: 'df -h', group: '常用' },
        { id: 'e2eqc3', name: '同步仓库', command: 'git pull', group: '运维' }
      ];
      _qcSettingsView.query = '';
      _qcSettingsView.collapsed.clear();
      openSettings('quickcommands');
      return 'seeded-13.11';
    })()`).catch(() => null);
    await sleep(450);
    const qcCard = await cdp.eval(`(() => {
      const list = document.getElementById('qc-commands-list');
      const page = document.querySelector('[data-page="quickcommands"]');
      const groups = [...list.querySelectorAll('.ssh-mgr-group')];
      const cards = [...list.querySelectorAll('.ssh-mgr-group-items')];
      const cs = cards[0] ? getComputedStyle(cards[0]) : null;
      const refCard = document.querySelector('.settings-card');
      const heading = page.querySelector('.settings-page-heading');
      const toolbar = page.querySelector('.settings-toolbar');
      const row = list.querySelector('.ssh-mgr-row');
      const rule = list.querySelector('.group-rule');
      return {
        groups: groups.length, cards: cards.length,
        rows: list.querySelectorAll('.ssh-mgr-row').length,
        cardBg: cs && cs.backgroundColor,
        refCardBg: refCard ? getComputedStyle(refCard).backgroundColor : 'missing',
        cardRadius: cs && cs.borderRadius,
        ruleDisplay: rule ? getComputedStyle(rule).display : 'missing',
        headingBtns: heading ? heading.querySelectorAll('button').length : -1,
        addTxt: heading ? (heading.querySelector('.settings-primary-add') || {}).textContent : '',
        quietBtns: toolbar ? [...toolbar.querySelectorAll('.settings-quiet-action')].map(b => b.textContent) : [],
        count: (page.querySelector('[data-qc-count]') || {}).textContent,
        hasSshListClass: list.classList.contains('ssh-mgr-list'),
        rowName: row ? row.querySelector('.ssh-mgr-primary').textContent : '',
        rowCmd: row ? row.querySelector('.ssh-mgr-meta .mono').textContent : ''
      };
    })()`).catch(() => null);
    const qcCardOk = !!qcCard && qcCard.groups === 2 && qcCard.cards === 2 && qcCard.rows === 3 &&
      qcCard.refCardBg.startsWith('rgb') && qcCard.cardBg === qcCard.refCardBg &&
      qcCard.cardRadius === '14px' && qcCard.ruleDisplay === 'none' &&
      qcCard.headingBtns === 1 && (qcCard.addTxt || '').includes('添加命令') &&
      qcCard.quietBtns.join(',') === '折叠全部,展开全部' && qcCard.count === '3 个命令' &&
      qcCard.hasSshListClass === false && qcCard.rowName === '查看系统信息' && qcCard.rowCmd === 'htop';
    check('快捷命令设置页：分节标题 + 每组一张设置卡片', qcCardOk === true, JSON.stringify(qcCard));
    // Same card-hover parity as the SSH page: no row fill, no redundant title.
    const qcHover = await cdp.eval(`(() => {
      const idEl = document.querySelector('#qc-commands-list .ssh-mgr-identity');
      return { identityNoTitle: idEl ? !idEl.hasAttribute('title') && !!idEl.getAttribute('aria-label') : null };
    })()`).catch(() => null);
    check('快捷命令设置页：行无冗余 title tooltip', !!qcHover && qcHover.identityNoTitle === true, JSON.stringify(qcHover));
    await shot('qc-settings-page');
    // Collapse-all via the real toolbar buttons hides each whole card but
    // keeps the section titles; expand-all restores.
    const qcCollapse = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('[data-page="quickcommands"] .settings-toolbar .settings-quiet-action')];
      btns[0].click();
      const cards = [...document.querySelectorAll('#qc-commands-list .ssh-mgr-group-items')];
      const titles = [...document.querySelectorAll('#qc-commands-list .ssh-mgr-group-title')];
      return {
        hidden: cards.every(c => c.classList.contains('collapsed') && getComputedStyle(c).display === 'none'),
        titlesUp: titles.every(t => t.offsetHeight > 0),
        n: cards.length
      };
    })()`).catch(() => null);
    check('快捷命令设置页：折叠全部隐藏整张卡片保留组标题', !!qcCollapse && qcCollapse.hidden === true && qcCollapse.titlesUp === true && qcCollapse.n === 2, JSON.stringify(qcCollapse));
    await shot('qc-settings-collapsed');
    const qcExpandBack = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('[data-page="quickcommands"] .settings-toolbar .settings-quiet-action')];
      btns[1].click();
      const cards = [...document.querySelectorAll('#qc-commands-list .ssh-mgr-group-items')];
      return cards.every(c => !c.classList.contains('collapsed') && c.offsetHeight > 0);
    })()`).catch(() => false);
    check('快捷命令设置页：展开全部恢复卡片', qcExpandBack === true, '');
    // Collapse one group, then search: matched groups force-expand and the
    // count switches to M / N; clearing the query restores the collapse.
    const qcSearch = await cdp.eval(`(() => {
      const title = document.querySelector('#qc-commands-list .ssh-mgr-group-title[data-group="运维"]');
      title.click();
      // The click re-renders the list, so re-query instead of trusting the
      // now-detached title reference.
      const collapsedBefore = document.querySelector('#qc-commands-list .ssh-mgr-group-title[data-group="运维"]').classList.contains('collapsed');
      const input = document.querySelector('[data-qc-search]');
      input.value = 'htop';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const groups = [...document.querySelectorAll('#qc-commands-list .ssh-mgr-group')];
      const rows = [...document.querySelectorAll('#qc-commands-list .ssh-mgr-row')];
      return {
        collapsedBefore,
        groupsDuring: groups.map(g => g.querySelector('.ssh-mgr-group-title').dataset.group),
        rowsDuring: rows.map(r => r.dataset.qcId),
        countDuring: document.querySelector('[data-qc-count]').textContent
      };
    })()`).catch(() => null);
    const qcSearchOk = !!qcSearch && qcSearch.collapsedBefore === true &&
      qcSearch.groupsDuring.join(',') === '常用' && qcSearch.rowsDuring.join(',') === 'e2eqc1' &&
      qcSearch.countDuring === '1 / 3 个命令';
    check('快捷命令设置页：搜索过滤 + 命中组强制展开 + 计数', qcSearchOk === true, JSON.stringify(qcSearch));
    const qcSearchClear = await cdp.eval(`(() => {
      const input = document.querySelector('[data-qc-search]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const t = document.querySelector('#qc-commands-list .ssh-mgr-group-title[data-group="运维"]');
      return { collapsedAfter: t.classList.contains('collapsed'),
               rows: document.querySelectorAll('#qc-commands-list .ssh-mgr-row').length,
               count: document.querySelector('[data-qc-count]').textContent };
    })()`).catch(() => null);
    check('快捷命令设置页：清空搜索恢复折叠态', !!qcSearchClear && qcSearchClear.collapsedAfter === true && qcSearchClear.rows === 2 && qcSearchClear.count === '3 个命令', JSON.stringify(qcSearchClear));
    // Delegated row actions: identity click opens the edit overlay prefilled.
    const qcEdit = await cdp.eval(`(() => {
      const row = document.querySelector('#qc-commands-list .ssh-mgr-row[data-qc-id="e2eqc2"]');
      row.querySelector('.ssh-mgr-identity').click();
      const opened = document.getElementById('overlay-qc-edit').classList.contains('open');
      const title = document.getElementById('qc-edit-title').textContent;
      const name = document.getElementById('qc-edit-name').value;
      const cmd = document.getElementById('qc-edit-command').value;
      closeQCEdit();
      return { opened, title, name, cmd };
    })()`).catch(() => null);
    check('快捷命令设置页：点击行打开编辑并预填', !!qcEdit && qcEdit.opened === true && qcEdit.title === '编辑命令' && qcEdit.name === '查看磁盘使用' && qcEdit.cmd === 'df -h', JSON.stringify(qcEdit));
    // Delete routes through the confirm dialog; cancelling keeps the command.
    const qcDelete = await cdp.eval(`(() => {
      const row = document.querySelector('#qc-commands-list .ssh-mgr-row[data-qc-id="e2eqc1"]');
      row.querySelector('.ssh-mgr-btn[data-action="delete"]').click();
      const opened = document.getElementById('overlay-confirm').classList.contains('open');
      const msg = document.getElementById('confirm-msg').textContent;
      document.getElementById('confirm-cancel').click();
      return { opened, msg, still: _qcCommands.some(c => c.id === 'e2eqc1') };
    })()`).catch(() => null);
    check('快捷命令设置页：删除走确认弹窗且取消保留', !!qcDelete && qcDelete.opened === true && qcDelete.msg.includes('删除') && qcDelete.still === true, JSON.stringify(qcDelete));
    // Rename entry derives the group name from data-group (no inline JS
    // interpolation); Esc cancels and restores the title DOM.
    const qcRename = await cdp.eval(`(() => {
      const title = document.querySelector('#qc-commands-list .ssh-mgr-group-title[data-group="常用"]');
      title.querySelector('.group-rename').click();
      const input = title.querySelector('input.group-name-input');
      const val = input ? input.value : null;
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { val, restored: !!title.querySelector('.group-name-text'),
               noInput: !title.querySelector('input') };
    })()`).catch(() => null);
    check('快捷命令设置页：重命名从 data-group 派生且 Esc 还原', !!qcRename && qcRename.val === '常用' && qcRename.restored === true && qcRename.noInput === true, JSON.stringify(qcRename));
    // Focus continuity: re-rendering lands focus on the same logical control.
    const qcFocus = await cdp.eval(`(() => {
      const btn = document.querySelector('#qc-commands-list .ssh-mgr-row[data-qc-id="e2eqc2"] .ssh-mgr-btn[data-action="edit"]');
      btn.focus();
      renderQCCommandsList();
      const after = document.activeElement;
      const row = after && after.closest('.ssh-mgr-row');
      return { isBtn: !!after && after.classList.contains('ssh-mgr-btn'),
               action: after && after.dataset.action,
               qcId: row && row.dataset.qcId };
    })()`).catch(() => null);
    check('快捷命令设置页：重绘后焦点还原到同一逻辑控件', !!qcFocus && qcFocus.isBtn === true && qcFocus.action === 'edit' && qcFocus.qcId === 'e2eqc2', JSON.stringify(qcFocus));
    // Empty states: no data at all vs. no search match.
    const qcEmpty = await cdp.eval(`(() => {
      const backup = _qcCommands;
      const list = document.getElementById('qc-commands-list');
      _qcCommands = [];
      renderQCCommandsList();
      const noData = list.textContent.includes('暂无命令');
      const addBtn = !!list.querySelector('.ssh-mgr-empty-actions .btn-primary');
      _qcCommands = backup;
      // Decouple from earlier steps' collapse state: assert a fully expanded
      // restore instead of whatever the search step left behind.
      _qcSettingsView.collapsed.clear();
      renderQCCommandsList();
      const input = document.querySelector('[data-qc-search]');
      input.value = 'zzzz-no-match';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const noMatch = list.textContent.includes('没有匹配的命令');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { noData, addBtn, noMatch,
               restored: list.querySelectorAll('.ssh-mgr-row').length === 3 };
    })()`).catch(() => null);
    check('快捷命令设置页：双空态（无数据/无匹配）', !!qcEmpty && qcEmpty.noData === true && qcEmpty.addBtn === true && qcEmpty.noMatch === true && qcEmpty.restored === true, JSON.stringify(qcEmpty));
    // Narrow (560px) pass: toolbar actions wrap to their own row and the card
    // padding tightens (same shared classes as the SSH settings page).
    const emu11 = await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 720, deviceScaleFactor: 1, mobile: false }).then(() => true).catch(() => false);
    try {
      await sleep(400);
      const narrowQc = await cdp.eval(`(() => {
        const page = document.querySelector('[data-page="quickcommands"]');
        const toolbar = page.querySelector('.settings-toolbar');
        const actions = page.querySelector('.settings-toolbar-actions');
        const search = toolbar && toolbar.querySelector('.ssh-mgr-search');
        const card = document.querySelector('#qc-commands-list .ssh-mgr-group-items');
        return { w: window.innerWidth,
                 wrapped: actions && search ? actions.getBoundingClientRect().top > search.getBoundingClientRect().top : null,
                 cardPadding: card ? getComputedStyle(card).padding : '' };
      })()`).catch(() => null);
      check('窄窗口（560px）：快捷命令页工具栏换行且卡片内边距收窄', emu11 === true && !!narrowQc && narrowQc.w === 560 && narrowQc.wrapped === true && narrowQc.cardPadding === '6px 12px', JSON.stringify(narrowQc));
      await shot('qc-settings-narrow');
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => null);
    }
    await sleep(300);
    // Leave 13.11 as found: real commands back, view state cleared, page closed.
    await cdp.eval(`(() => {
      _qcCommands = window.__qcBackup || [];
      delete window.__qcBackup;
      _qcSettingsView.query = '';
      _qcSettingsView.collapsed.clear();
      const input = document.querySelector('[data-qc-search]');
      if (input) input.value = '';
      renderQCCommandsList();
      closeSettingsTab();
      return 'clean-13.11';
    })()`).catch(() => null);
    await sleep(250);

    // 13.12 Issue #7 regression: keyboard cycling must follow the bar's
    // VISUAL order. Opening settings and THEN creating another tab leaves
    // the settings tab mid-array; the render pins it rightmost, so raw array
    // order and visual order diverge — cycling used the array and jumped in
    // a non-visual order.
    // The 13.11 cleanup closed the settings tab through the staggered
    // removal path; wait it out or openSettings() below would focus a dying
    // tab that _cycleTab then filters from the alive set.
    await cdp.eval(`(async () => {
      for (let i = 0; i < 40; i++) {
        if (TabManager._closingTabs.size === 0 && !TabManager.tabs.some(t => t.type === 'settings')) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })()`).catch(() => null);
    const cycleOrder = await cdp.eval(`(async () => {
      const T = TabManager;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const baseIds = T.tabs.map(t => t.id);
      const baseActive = T.activeId;
      openSettings();
      const settingsId = T.tabs.find(t => t.type === 'settings').id;
      const p = getDefaultLocalProfile();
      T.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
      const extraId = T.tabs[T.tabs.length - 1].id;
      const settingsMidArray = T.tabs.findIndex(t => t.id === settingsId) < T.tabs.length - 1;
      const ordered = T.orderedTabs();
      const orderedLastIsSettings = ordered[ordered.length - 1].id === settingsId;
      const domOrder = [...document.querySelectorAll('#tabbar .tab')].map(el => el.dataset.tab);
      const domMatchesOrdered = JSON.stringify(domOrder) === JSON.stringify(ordered.map(t => t.id));
      const key = (init) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      T.switchTo(settingsId);
      key({ key: 'Tab', ctrlKey: true, shiftKey: true }); // prevTab → visually last non-settings
      const prevLanded = T.activeId;
      key({ key: 'Tab', ctrlKey: true }); // nextTab → back to settings
      const nextLanded = T.activeId;
      // Cleanup: close the extra tab and the settings tab, wait for the
      // staggered removal to settle, restore the original active tab.
      T.closeTab(extraId);
      T.closeTab(settingsId);
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        if (T.tabs.length === baseIds.length && T._closingTabs.size === 0 &&
            document.querySelectorAll('#tabbar .tab').length === baseIds.length) break;
      }
      if (T.activeId !== baseActive) T.switchTo(baseActive);
      const settled = T.tabs.length === baseIds.length && T._closingTabs.size === 0 &&
        document.querySelectorAll('#tabbar .tab').length === baseIds.length && T.activeId === baseActive;
      return { settingsMidArray, orderedLastIsSettings, domMatchesOrdered,
               prevLanded, expectPrev: extraId, nextLanded, expectNext: settingsId, settled };
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    check('标签页循环切换遵循视觉顺序（issue #7 回归）',
      !!cycleOrder && cycleOrder.settingsMidArray === true && cycleOrder.orderedLastIsSettings === true &&
      cycleOrder.domMatchesOrdered === true && cycleOrder.prevLanded === cycleOrder.expectPrev &&
      cycleOrder.nextLanded === cycleOrder.expectNext && cycleOrder.settled === true,
      JSON.stringify(cycleOrder));

    // 13.13 Issue #9 regression: after a highlighted keyword, the text that
    // follows on the same line must get its ORIGINAL SGR rendition back —
    // the old end sequence reset to the terminal default and washed colored
    // text white.
    const hlRestore = await cdp.eval(`(() => {
      const backupRules = _highlightRules;
      const backupSettings = _highlightSettings;
      try {
        _highlightRules = [{ id: 'hl_e2e', text: 'ERROR', enabled: true, isRegExp: false, isCaseSensitive: false,
                             foreground: true, foregroundColor: '#e06c75', background: false, backgroundColor: '',
                             bold: false, italic: false, underline: false }];
        _highlightSettings = { highlightEnabled: true, highlightAlternateDisable: true };
        const line = '\\x1b[38;2;97;175;239minfo: build ERROR done\\x1b[39m';
        const out = applyHighlight(line, 'e2e-tab');
        const kw = out.indexOf('ERROR');
        const after = kw >= 0 ? out.slice(kw + 5) : '';
        return { ok: kw >= 0,
                 restores: after.startsWith('\\x1b[38;2;97;175;239m'),
                 wipes: after.startsWith('\\x1b[39m'),
                 kwColored: out.includes('\\x1b[38;2;224;108;117mERROR') };
      } finally {
        _highlightRules = backupRules;
        _highlightSettings = backupSettings;
      }
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    check('高亮关键字后同行文本恢复原色（issue #9 回归）',
      !!hlRestore && hlRestore.ok === true && hlRestore.restores === true &&
      hlRestore.wipes === false && hlRestore.kwColored === true,
      JSON.stringify(hlRestore));

    // 13.14 Tab naming contract: OSC 0/2 window titles written by the session
    // must NOT rename the tab (regression guard for the rejected title
    // auto-follow); the explicit opt-in OSC 1337 `ZTermTabName=` channel sets
    // an ephemeral display-only name that never touches `tab.name`, loses to
    // a manual rename, rides the terminal across the tab→split→tab migration
    // (the term moves between tab and pane wrappers), and clears on an empty
    // payload.
    const tabRename = await cdp.eval(`(async () => {
      const T = TabManager;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const poll = async (fn, n = 40) => { for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(100); } return false; };
      const baseActive = T.activeId;
      const baseCount = T.tabs.length;
      const p = getDefaultLocalProfile();
      T.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
      const tab = T.tabs[T.tabs.length - 1];
      const baseName = tab.name;
      const out = { wired: false, osc0Ignored: false, osc2Ignored: false, toolShown: false,
                    nameUntouched: false, stShown: false, lockedHeld: false, unlockedShows: false,
                    toolMovedToPane: false, splitShowsTool: false, collapsedBack: false,
                    collapseShowsTool: false, cleared: false, settled: false };
      try {
        out.wired = await poll(() => tab.term && tab.tabId);
        if (!out.wired) return out;
        const label = () => document.querySelector('.tab[data-tab="' + tab.id + '"] .tab-name')?.textContent || '';
        const origTerm = tab.term;
        // (a) OSC 0 / OSC 2 must change neither the visible label nor tab.name.
        origTerm.write('\\x1b]0;E2E_OSC0\\x07');
        await sleep(400);
        out.osc0Ignored = tab.name === baseName && label() === baseName;
        origTerm.write('\\x1b]2;E2E_OSC2\\x07');
        await sleep(400);
        out.osc2Ignored = tab.name === baseName && label() === baseName;
        // (b) The opt-in channel overlays the visible label only.
        origTerm.write('\\x1b]1337;ZTermTabName=E2E_TOOL\\x07');
        out.toolShown = await poll(() => label() === 'E2E_TOOL');
        out.nameUntouched = tab.name === baseName && tab._toolName === 'E2E_TOOL';
        // The ST terminator is accepted the same way as BEL.
        origTerm.write('\\x1b]1337;ZTermTabName=E2E_TOOL_ST\\x1b\\\\');
        out.stShown = await poll(() => label() === 'E2E_TOOL_ST' && tab._toolName === 'E2E_TOOL_ST');
        // (c) A manual rename outranks the tool name: even a fresh tool write
        // updates the stored name but not the visible label.
        tab._customName = true;
        tab.name = 'E2E_MANUAL';
        T.render();
        origTerm.write('\\x1b]1337;ZTermTabName=E2E_TOOL\\x07');
        await sleep(400);
        out.lockedHeld = label() === 'E2E_MANUAL' && tab._toolName === 'E2E_TOOL';
        delete tab._customName;
        tab.name = baseName;
        T.render();
        out.unlockedShows = await poll(() => label() === 'E2E_TOOL');
        // (d) Split: the original terminal moves onto a pane wrapper and the
        // tool name rides it onto the pane slot. The split label joins pane
        // names, so the tool name shows as part of the join here.
        T.addPaneRelativeTo(tab, 'r');
        const splitReady = await poll(() => tab.splitRoot && getAllPanes(tab).length === 2, 50);
        if (splitReady) {
          const origPane = getAllPanes(tab).find(pp => pp.term === origTerm);
          // Invariant: the name moved onto the pane slot (tab slot cleared).
          out.toolMovedToPane = !!origPane && origPane._toolName === 'E2E_TOOL' && tab._toolName === undefined;
          out.splitShowsTool = await poll(() => label().includes('E2E_TOOL'));
          // Collapse back to a single terminal: the name must move back onto
          // the tab slot and keep driving the label.
          const other = getAllPanes(tab).find(pp => pp.term !== origTerm);
          if (other) T._closePane(tab.id, other.id);
          out.collapsedBack = await poll(() => !tab.splitRoot && tab.term === origTerm, 40);
          if (out.collapsedBack) {
            out.collapseShowsTool = await poll(() => label() === 'E2E_TOOL' && tab._toolName === 'E2E_TOOL');
          }
        }
        // (e) Empty payload clears the tool name and restores the base label.
        // Also valid if the collapse above failed: the write resolves the
        // owner pane by terminal identity, and two equal pane names dedup-
        // join back to the base label.
        origTerm.write('\\x1b]1337;ZTermTabName=\\x07');
        out.cleared = await poll(() => label() === baseName && tab.name === baseName && tab._toolName === undefined);
      } finally {
        if (T.tabs.includes(tab)) T.closeTab(tab.id);
        for (let i = 0; i < 40; i++) {
          await sleep(100);
          if (T.tabs.length === baseCount && T._closingTabs.size === 0) break;
        }
        if (T.activeId !== baseActive && T.tabs.some(t => t.id === baseActive)) T.switchTo(baseActive);
        out.settled = T.tabs.length === baseCount && T._closingTabs.size === 0;
      }
      return out;
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    check('OSC 0/2 不改名；1337 ZTermTabName 通道提供临时显示名且随分屏迁移（issue #10 行为反转）',
      !!tabRename && tabRename.wired === true && tabRename.osc0Ignored === true &&
      tabRename.osc2Ignored === true && tabRename.toolShown === true &&
      tabRename.nameUntouched === true && tabRename.stShown === true && tabRename.lockedHeld === true &&
      tabRename.unlockedShows === true && tabRename.toolMovedToPane === true &&
      tabRename.splitShowsTool === true && tabRename.collapsedBack === true &&
      tabRename.collapseShowsTool === true && tabRename.cleared === true && tabRename.settled === true,
      JSON.stringify(tabRename));

    // 13.15 Update proxy setting: the input must persist into config.json
    // (terminal.updateProxy) and actually steer the update HTTP agent — a
    // dead proxy must fail check-update fast with [connect], an invalid
    // proxy URL with the validation error. Both checks are offline-safe:
    // 127.0.0.1:1 refuses instantly and validation needs no network at all.
    const updProxySetup = await cdp.eval(`(async () => {
      openSettings('about');
      await new Promise(r => setTimeout(r, 300));
      const input = document.getElementById('set-update-proxy');
      if (!input) return { hasInput: false };
      input.value = 'http://127.0.0.1:1';
      saveTerminal();
      return { hasInput: true };
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    let proxyPersisted = null, updProxyDead = 'skipped', updProxyInvalid = 'skipped', updProxyRoundTrip = 'skipped';
    if (updProxySetup && updProxySetup.hasInput === true) {
      // Never touch the real network unless the dead-proxy setup landed.
      // persistSettings() fires save-appearance via fire-and-forget
      // ipcRenderer.send, so the disk write lands asynchronously — poll the
      // config file instead of racing a fixed sleep (the 500ms one-shot read
      // flaked false on a loaded machine while every later step passed).
      for (let i = 0; i < 25 && proxyPersisted !== true; i++) {
        await sleep(200);
        try { proxyPersisted = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).terminal?.updateProxy === 'http://127.0.0.1:1'; } catch {}
      }
      updProxyDead = await cdp.eval(`(async () => {
        try { await ipcRenderer.invoke('check-update'); return ''; }
        catch (e) { return String((e && e.message) || e); }
      })()`).catch((e) => 'eval-fail: ' + String((e && e.message) || e));
      updProxyInvalid = await cdp.eval(`(async () => {
        document.getElementById('set-update-proxy').value = 'not a url';
        saveTerminal();
        await new Promise(r => setTimeout(r, 400));
        try { await ipcRenderer.invoke('check-update'); return ''; }
        catch (e) { return String((e && e.message) || e); }
      })()`).catch((e) => 'eval-fail: ' + String((e && e.message) || e));
      // Load round-trip: persist a value, close + reopen settings, the input
      // must show it again.
      updProxyRoundTrip = await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.getElementById('set-update-proxy').value = 'http://127.0.0.1:9';
        saveTerminal();
        await sleep(400);
        closeSettingsTab();
        for (let i = 0; i < 40; i++) {
          await sleep(100);
          if (TabManager._closingTabs.size === 0 && !TabManager.tabs.some(t => t.type === 'settings')) break;
        }
        openSettings('about');
        await sleep(400);
        return document.getElementById('set-update-proxy')?.value ?? null;
      })()`).catch((e) => 'eval-fail: ' + String((e && e.message) || e));
    }
    await cdp.eval(`(() => {
      const input = document.getElementById('set-update-proxy');
      if (input) input.value = '';
      saveTerminal();
      closeSettingsTab();
      return 'cleared';
    })()`).catch(() => null);
    let proxyCleared = false;
    for (let i = 0; i < 20; i++) {
      try { if (JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).terminal?.updateProxy === '') { proxyCleared = true; break; } } catch {}
      await sleep(200);
    }
    await sleep(250);
    check('更新代理设置生效（死代理快速失败 / 非法代理报校验错 / 回填）',
      updProxySetup?.hasInput === true && proxyPersisted === true &&
      typeof updProxyDead === 'string' && updProxyDead.includes('[connect]') &&
      typeof updProxyInvalid === 'string' && updProxyInvalid.includes('invalid update proxy') &&
      updProxyRoundTrip === 'http://127.0.0.1:9' && proxyCleared === true,
      JSON.stringify({ setup: updProxySetup, persisted: proxyPersisted, dead: updProxyDead, invalid: updProxyInvalid, roundTrip: updProxyRoundTrip, cleared: proxyCleared }));

    // 14.9 Double-click word separators (issue #8): with the vendored
    //     default a double-click selects the whole CIDR ('.' and '/' are not
    //     separators); after configuring '/' as a separator the same click
    //     stops at it. Covers live-apply to a tab opened BEFORE the change,
    //     the startup path (tab opened after), a split pane (creation path
    //     and live reset), the clear-restores-default path (xterm's option
    //     sanitizer substitutes the vendored default for ''), and disk
    //     persistence of the setting.
    const wsTab = await cdp.eval(`TabManager.createTab({ name: 'E2E-WS', type: 'local' })`);
    const WS = JSON.stringify(wsTab);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${WS}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`(() => { TabManager.switchTo(${WS}); return true; })()`);
    // Fixture goes straight into the buffer: word selection reads the
    // buffer, not the PTY input path.
    async function wsWrite(termExpr, marker) {
      await cdp.eval(`(() => { (${termExpr}).write('192.168.1.2/24 ' + ${JSON.stringify(marker)} + '\\r\\n'); return true; })()`);
      await waitForValue(cdp, `(() => {
        const term = (${termExpr});
        const b = term.buffer.active;
        for (let i = b.length - 1; i >= 0; i--) { const l = b.getLine(i); if (l && l.translateToString(true).includes(${JSON.stringify(marker)})) return true; }
        return false;
      })()`, true, 8000);
    }
    // Viewport pixel of the middle of "168" on the LAST fixture line (the
    // one just written; earlier lines may have scrolled out).
    async function wsCellPos(termExpr, marker) {
      return cdp.eval(`(() => {
        const term = (${termExpr});
        if (!term) return null;
        const b = term.buffer.active;
        let row = -1, col = -1;
        for (let i = b.length - 1; i >= 0; i--) {
          const l = b.getLine(i); if (!l) continue;
          const s = l.translateToString(true);
          const k = s.indexOf('192.168.1.2/24');
          if (k >= 0 && s.includes(${JSON.stringify(marker)})) { row = i; col = k + 5; break; }
        }
        if (row < 0) return null;
        const dims = term._core._renderService.dimensions.css.cell;
        const cv = term.element.querySelector('canvas');
        const rect = (cv || term.element).getBoundingClientRect();
        const vx = row - b.viewportY;
        if (vx < 0) return null;
        return { x: Math.round(rect.left + (col + 0.5) * dims.width), y: Math.round(rect.top + (vx + 0.5) * dims.height) };
      })()`);
    }
    async function wsDoubleClick(termExpr, marker) {
      const pos = await wsCellPos(termExpr, marker);
      if (!pos) return 'no-pos';
      for (const [type, clickCount] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount });
      }
      await sleep(150);
      return cdp.eval(`(() => { const t = (${termExpr}); return t.hasSelection() ? t.getSelection() : ''; })()`);
    }
    const wsTermExpr = `TabManager.tabs.find(x => x.id === ${WS}).term`;
    await wsWrite(wsTermExpr, 'WS1');
    const wsSelDefault = await wsDoubleClick(wsTermExpr, 'WS1');
    check('双击选词：默认分隔符整选 CIDR', wsSelDefault === '192.168.1.2/24', JSON.stringify({ sel: wsSelDefault }));
    // Configure '/' → live-apply reaches the already-open tab.
    const wsSetup = await cdp.eval(`(async () => {
      openSettings('terminal');
      await new Promise(r => setTimeout(r, 300));
      const input = document.getElementById('set-word-separators');
      if (!input) return { hasInput: false };
      input.value = '/';
      saveTerminal();
      closeSettingsTab();
      TabManager.switchTo(${WS});
      await new Promise(r => setTimeout(r, 100));
      const t = TabManager.tabs.find(x => x.id === ${WS});
      return { hasInput: true, raw: t.term.options.wordSeparator };
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    await wsWrite(wsTermExpr, 'WS2');
    const wsSelLive = wsSetup && wsSetup.hasInput === true ? await wsDoubleClick(wsTermExpr, 'WS2') : 'no-setup';
    // The configured set REPLACES the default: with '/' alone, space is no
    // longer a separator, so a fixture landing on the shell prompt's line
    // legitimately selects through the prompt. The feature's observable is
    // the right edge stopping at '/', not the left edge's extent.
    const wsLiveOk = typeof wsSelLive === 'string' && wsSelLive.endsWith('192.168.1.2') && !wsSelLive.includes('/');
    check('双击选词：配置 / 后已开终端即时生效', wsLiveOk, JSON.stringify({ setup: wsSetup, sel: wsSelLive }));
    // Startup path: a tab created while '/' is configured.
    const wsTab2 = await cdp.eval(`TabManager.createTab({ name: 'E2E-WS2', type: 'local' })`);
    const WS2 = JSON.stringify(wsTab2);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${WS2}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`(() => { TabManager.switchTo(${WS2}); return true; })()`);
    const ws2TermExpr = `TabManager.tabs.find(x => x.id === ${WS2}).term`;
    const ws2Raw = await cdp.eval(`(() => (${ws2TermExpr}).options.wordSeparator)()`);
    await wsWrite(ws2TermExpr, 'WS3');
    const wsSelStartup = await wsDoubleClick(ws2TermExpr, 'WS3');
    const wsStartupOk = typeof wsSelStartup === 'string' && wsSelStartup.endsWith('192.168.1.2') && !wsSelStartup.includes('/');
    check('双击选词：新建终端启动路径带上分隔符', ws2Raw === '/' && wsStartupOk, JSON.stringify({ raw: ws2Raw, sel: wsSelStartup }));
    // Split pane: creation options include the separator.
    await cdp.eval(`TabManager.splitHorizontal()`);
    await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${WS2})).filter(p => p.term && p.tabId).length`, 2, 15000);
    const wsPaneExpr = `getAllPanes(TabManager.tabs.find(x => x.id === ${WS2}))[1].term`;
    await cdp.eval(`(() => { (${wsPaneExpr}).focus(); return true; })()`);
    await wsWrite(wsPaneExpr, 'WS4');
    const wsSelPane = await wsDoubleClick(wsPaneExpr, 'WS4');
    const wsPaneOk = typeof wsSelPane === 'string' && wsSelPane.endsWith('192.168.1.2') && !wsSelPane.includes('/');
    check('双击选词：分屏面板同样生效', wsPaneOk, JSON.stringify({ sel: wsSelPane }));
    // Clear the setting → xterm's sanitizer restores the vendored default,
    // live, split panes included.
    const wsClear = await cdp.eval(`(async () => {
      openSettings('terminal');
      await new Promise(r => setTimeout(r, 300));
      const input = document.getElementById('set-word-separators');
      input.value = '';
      saveTerminal();
      closeSettingsTab();
      TabManager.switchTo(${WS2});
      await new Promise(r => setTimeout(r, 100));
      return { raw: (${wsPaneExpr}).options.wordSeparator };
    })()`).catch(() => null);
    await wsWrite(wsPaneExpr, 'WS5');
    const wsSelCleared = await wsDoubleClick(wsPaneExpr, 'WS5');
    check('双击选词：清空设置恢复默认（含分屏面板）', wsSelCleared === '192.168.1.2/24', JSON.stringify({ clear: wsClear, sel: wsSelCleared }));
    // Persistence: set '/' once more and poll the config file, then clear.
    await cdp.eval(`(async () => {
      openSettings('terminal');
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('set-word-separators').value = '/';
      saveTerminal();
      closeSettingsTab();
      return 'set';
    })()`).catch(() => null);
    let wsPersisted = null;
    for (let i = 0; i < 25 && wsPersisted !== true; i++) {
      await sleep(200);
      try { wsPersisted = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).terminal?.wordSeparators === '/'; } catch {}
    }
    await cdp.eval(`(async () => {
      openSettings('terminal');
      await new Promise(r => setTimeout(r, 300));
      const v = document.getElementById('set-word-separators')?.value;
      document.getElementById('set-word-separators').value = '';
      saveTerminal();
      closeSettingsTab();
      return v;
    })()`).catch(() => null);
    let wsClearedDisk = false;
    for (let i = 0; i < 25 && wsClearedDisk !== true; i++) {
      await sleep(200);
      try { const v = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).terminal?.wordSeparators; if (v === '' || v === undefined) { wsClearedDisk = true; break; } } catch {}
    }
    check('双击选词：设置持久化与回填', wsPersisted === true && wsClearedDisk === true, JSON.stringify({ persisted: wsPersisted, cleared: wsClearedDisk }));
    // Tidy: close both fixture tabs so later sections see a clean strip.
    await cdp.eval(`(() => { try { TabManager.closeTab(${WS2}); TabManager.closeTab(${WS}); } catch (e) {} return true; })()`);
    await sleep(300);

    // 14.10 Reconnect shortcut + Win as its own modifier (issues #19, #23):
    //     real Ctrl+Shift+R key events reconnect the active SSH tab and
    //     no-op (but stay consumed) on a local tab; rebinding to Ctrl+Win+R
    //     moves the action to the exact new combo — Ctrl+Shift+R stops
    //     firing, proving Win is matched as a distinct modifier instead of
    //     folding into Ctrl. reconnectTab itself is spied, never dialed.
    const scTab = await cdp.eval(`TabManager.createTab({ name: 'E2E-SC', type: 'local' })`);
    const SC = JSON.stringify(scTab);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${SC}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(x => x.id === ${SC});
      window.__e2eReconnectCalls = 0;
      window.__e2eOrigReconnect = TabManager.reconnectTab.bind(TabManager);
      TabManager.reconnectTab = () => { window.__e2eReconnectCalls++; };
      tab.type = 'ssh'; // routing guard only; the spy swallows the dial
      TabManager.switchTo(${SC});
      return true;
    })()`);
    async function sendCombo(key, code, vk, modifiers) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      await sleep(120);
      return cdp.eval(`window.__e2eReconnectCalls`);
    }
    const scOnSsh = await sendCombo('R', 'KeyR', 82, 2 | 8); // Ctrl+Shift+R
    await cdp.eval(`(() => { const t = TabManager.tabs.find(x => x.id === ${SC}); t.type = 'local'; return true; })()`);
    const scOnLocal = await sendCombo('R', 'KeyR', 82, 2 | 8);
    check('重连快捷键：Ctrl+Shift+R 仅对 SSH 标签生效', scOnSsh === 1 && scOnLocal === 1, JSON.stringify({ ssh: scOnSsh, local: scOnLocal }));
    // Rebind to Ctrl+Win+R through the config object (the capture UI is unit
    // covered; here the live matcher must honor the new combo exactly).
    await cdp.eval(`(() => {
      const t = TabManager.tabs.find(x => x.id === ${SC}); t.type = 'ssh';
      _settingsConfig.shortcuts = { ...(_settingsConfig.shortcuts || {}), reconnectTab: 'Ctrl+Win+R' };
      persistSettings();
      return true;
    })()`);
    const scOldCombo = await sendCombo('R', 'KeyR', 82, 2 | 8);   // Ctrl+Shift+R no longer bound
    const scWinCombo = await sendCombo('r', 'KeyR', 82, 2 | 4);   // Ctrl+Win+R (Meta bit, no Shift)
    check('重连快捷键：改绑 Ctrl+Win+R 精确匹配（Win 不并入 Ctrl）', scOldCombo === 1 && scWinCombo === 2, JSON.stringify({ old: scOldCombo, win: scWinCombo }));
    // Command palette lists the action with its live combo.
    const scPalette = await cdp.eval(`(async () => {
      openPalette();
      await new Promise(r => setTimeout(r, 150));
      const rows = [...document.querySelectorAll('#palette-list *')].map(el => el.textContent);
      const hit = rows.some(t => t.includes('重新连接'));
      closePalette();
      return hit;
    })()`).catch(() => null);
    check('重连快捷键：命令面板收录重连动作', scPalette === true, JSON.stringify({ hit: scPalette }));
    // Restore every override and close the fixture tab.
    await cdp.eval(`(() => {
      TabManager.reconnectTab = window.__e2eOrigReconnect;
      const t = TabManager.tabs.find(x => x.id === ${SC});
      if (t) { t.type = 'local'; }
      if (_settingsConfig.shortcuts) { delete _settingsConfig.shortcuts.reconnectTab; persistSettings(); }
      try { TabManager.closeTab(${SC}); } catch (e) {}
      return true;
    })()`);
    let scRestored = false;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      try { const s = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).shortcuts; if (!s || !s.reconnectTab) { scRestored = true; break; } } catch {}
    }
    await sleep(200);

    // 15. ADR-0004 split session ownership & layout migration: per-tab
    //     maximize state with a REAL Esc key, split-while-maximized pane
    //     visibility, extract-to-tab wrap geometry + smooth-cursor transfer,
    //     post-migration resize routing, and right-click paste routing. All
    //     overrides (ipcRenderer.send recorder, clipboard shim) are restored
    //     in finally blocks so later sections see a clean page.
    await cdp.eval(`(() => { try { closeAllOverlays(); } catch (e) {} return true; })()`);
    // 15.1 Esc exits the ACTIVE tab's maximize (per-tab state, real key event)
    const adr4TabA = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-A', type: 'local' })`);
    const A = JSON.stringify(adr4TabA);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${A}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`TabManager.splitHorizontal()`);
    await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${A})).filter(p => p.term && p.tabId).length`, 2, 15000);
    await cdp.eval(`(() => { const tab = TabManager.tabs.find(x => x.id === ${A}); TabManager._maximizePane(tab.id, getAllPanes(tab)[0].id); return true; })()`);
    await waitForValue(cdp, `TabManager._maximizing === false && !!TabManager.tabs.find(x => x.id === ${A})._maximizedPaneId`, true, 8000);
    await sleep(400); // let _maximizePane's own focus() land
    await cdp.eval(`(() => { const tab = TabManager.tabs.find(x => x.id === ${A}); const p = getAllPanes(tab).find(q => q.id === tab._maximizedPaneId); if (p?.term) p.term.focus(); return true; })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    const adr4EscState = await waitForValue(cdp, `(() => {
      const tab = TabManager.tabs.find(x => x.id === ${A});
      if (!tab || tab._maximizedPaneId) return false;
      const el = document.getElementById('split_' + tab.id);
      if (!el) return false;
      const panes = [...el.querySelectorAll('.split-pane')];
      return panes.length === 2 && panes.every(p => p.style.display !== 'none' && p.getBoundingClientRect().height > 0);
    })()`, true, 8000);
    check('ADR4：真实 Esc 退出当前标签面板最大化（双面板恢复可见）', adr4EscState === true, JSON.stringify(adr4EscState));
    // 15.2 split while maximized un-maximizes and keeps the NEW pane visible
    await cdp.eval(`(() => { const tab = TabManager.tabs.find(x => x.id === ${A}); TabManager._maximizePane(tab.id, getAllPanes(tab)[0].id); return true; })()`);
    await waitForValue(cdp, `!!TabManager.tabs.find(x => x.id === ${A})._maximizedPaneId`, true, 8000);
    await cdp.eval(`TabManager.splitHorizontal()`);
    const adr4SplitMaxState = await waitForValue(cdp, `(() => {
      const tab = TabManager.tabs.find(x => x.id === ${A});
      if (!tab || tab._maximizedPaneId) return false;
      const panes = getAllPanes(tab);
      if (panes.length !== 3) return false;
      const el = document.getElementById('split_' + tab.id);
      if (!el) return false;
      return [...el.querySelectorAll('.split-pane')].filter(p => p.style.display !== 'none' && p.getBoundingClientRect().height > 0).length === 3;
    })()`, true, 8000);
    check('ADR4：最大化期间分屏解除最大化且新面板可见', adr4SplitMaxState === true, JSON.stringify(adr4SplitMaxState));
    // 15.3 extract one pane: both resulting tabs keep the smooth-cursor
    //     adapter and the restored single-tab wrap uses the standard inner
    //     geometry (one .term-inner holding the terminal element)
    const adr4TabB = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-B', type: 'local' })`);
    const B = JSON.stringify(adr4TabB);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${B}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`TabManager.splitHorizontal()`);
    await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${B})).filter(p => p.term && p.tabId).length`, 2, 15000);
    const adr4ExtractedId = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(x => x.id === ${B});
      const pane = getAllPanes(tab)[0];
      TabManager._extractPaneToTab(tab.id, pane.id);
      return TabManager.tabs[TabManager.tabs.length - 1].id;
    })()`);
    const N = JSON.stringify(adr4ExtractedId);
    const adr4ExtReady = await waitForValue(cdp, `(() => {
      const st = TabManager.tabs.find(x => x.id === ${B});
      const nt = TabManager.tabs.find(x => x.id === ${N});
      if (!st || !nt || st.splitRoot || !st.term || !nt.term) return false;
      return !!document.getElementById('wrap_' + st.id) && !!document.getElementById('wrap_' + nt.id);
    })()`, true, 10000);
    const adr4ExtDetail = await cdp.eval(`(() => {
      const st = TabManager.tabs.find(x => x.id === ${B});
      const nt = TabManager.tabs.find(x => x.id === ${N});
      const stWrap = document.getElementById('wrap_' + st.id);
      const ntWrap = document.getElementById('wrap_' + nt.id);
      return {
        a: !!st._smoothCursor?._adapter, b: !!nt._smoothCursor?._adapter,
        stInner: stWrap ? stWrap.querySelectorAll('.term-inner').length : -1,
        ntInner: ntWrap ? ntWrap.querySelectorAll('.term-inner').length : -1,
        stInInner: !!st.term?.element?.closest('.term-inner'),
        ntInInner: !!nt.term?.element?.closest('.term-inner'),
      };
    })()`);
    check('ADR4：拆出后两端平滑光标存活且恢复 wrap 使用标准内层几何',
      adr4ExtReady === true && adr4ExtDetail.a === true && adr4ExtDetail.b === true &&
      adr4ExtDetail.stInner === 1 && adr4ExtDetail.ntInner === 1 &&
      adr4ExtDetail.stInInner === true && adr4ExtDetail.ntInInner === true,
      JSON.stringify(adr4ExtDetail));
    // 15.4 resize ownership after migration: force each terminal's onResize
    //     with DISTINCT rows (equal values could mask a misroute); every
    //     pty-resize must be addressed to that terminal's OWN backend id.
    //     The old closure kept the pre-migration wrapper and sent the
    //     extracted terminal's size to the REMAINING tab's backend.
    await cdp.eval(`(() => {
      window.__e2eSendLog = [];
      window.__e2eOrigSend = window.electron.ipcRenderer.send;
      window.electron.ipcRenderer.send = function (ch, payload) { window.__e2eSendLog.push({ ch, payload }); };
      return true;
    })()`);
    try {
      await cdp.eval(`(() => {
        const st = TabManager.tabs.find(x => x.id === ${B});
        const nt = TabManager.tabs.find(x => x.id === ${N});
        _fitWithScroll(st.term, st.fitAddon, st.term.element ? st.term.element.parentElement : null);
        _fitWithScroll(nt.term, nt.fitAddon, nt.term.element ? nt.term.element.parentElement : null);
        st.term.resize(st.term.cols, st.term.rows + 4);
        nt.term.resize(nt.term.cols, nt.term.rows + 9);
        return true;
      })()`);
      await sleep(600); // 150ms resize debounce + margin
      const adr4Resize = await cdp.eval(`(() => {
        const st = TabManager.tabs.find(x => x.id === ${B});
        const nt = TabManager.tabs.find(x => x.id === ${N});
        const rs = window.__e2eSendLog.filter(x => x.ch === 'pty-resize').map(x => ({ tabId: x.payload.tabId, rows: x.payload.rows }));
        const last = {};
        rs.forEach(r => { last[r.tabId] = r; });
        return { stTabId: st.tabId, ntTabId: nt.tabId, stRows: st.term.rows, ntRows: nt.term.rows,
          lastSt: last[st.tabId] || null, lastNt: last[nt.tabId] || null,
          stCount: rs.filter(r => r.tabId === st.tabId).length, ntCount: rs.filter(r => r.tabId === nt.tabId).length };
      })()`);
      check('ADR4：迁移后 resize 各自送达所属 backend',
        !!adr4Resize.lastSt && !!adr4Resize.lastNt &&
        adr4Resize.lastSt.rows === adr4Resize.stRows && adr4Resize.lastNt.rows === adr4Resize.ntRows &&
        adr4Resize.stCount >= 1 && adr4Resize.ntCount >= 1,
        JSON.stringify(adr4Resize));
    } finally {
      await cdp.eval(`(() => { if (window.__e2eOrigSend) { window.electron.ipcRenderer.send = window.__e2eOrigSend; window.__e2eOrigSend = null; } window.__e2eSendLog = null; return true; })()`);
    }
    // 15.5 right-click paste routing: the extracted terminal's contextmenu
    //     handler was wired while it was a pane; after the migration it must
    //     paste into the CURRENT owner exactly once. The renderer.html
    //     require('electron') shim's clipboard object is stubbed for the
    //     probe and restored right after.
    await cdp.eval(`(() => {
      window.__e2eSendLog = [];
      window.__e2eOrigSend = window.electron.ipcRenderer.send;
      window.electron.ipcRenderer.send = function (ch, payload) { window.__e2eSendLog.push({ ch, payload }); };
      const clip = require('electron').clipboard;
      window.__e2eClipBackup = { readText: clip.readText, readTextAsync: clip.readTextAsync };
      clip.readText = () => 'PASTE-PROBE';
      clip.readTextAsync = () => Promise.resolve('PASTE-PROBE');
      return true;
    })()`);
    try {
      await cdp.eval(`(() => { const nt = TabManager.tabs.find(x => x.id === ${N}); nt.term.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
      await sleep(400);
      const adr4Paste = await cdp.eval(`(() => {
        const nt = TabManager.tabs.find(x => x.id === ${N});
        const inputs = window.__e2eSendLog.filter(x => x.ch === 'pty-input' && x.payload.data === 'PASTE-PROBE');
        return { ntTabId: nt.tabId, inputs: inputs.map(x => x.payload) };
      })()`);
      check('ADR4：右键粘贴按当前归属投递（单次、正确 backend）',
        adr4Paste.inputs.length === 1 && adr4Paste.inputs[0].tabId === adr4Paste.ntTabId,
        JSON.stringify(adr4Paste));
    } finally {
      await cdp.eval(`(() => {
        if (window.__e2eOrigSend) { window.electron.ipcRenderer.send = window.__e2eOrigSend; window.__e2eOrigSend = null; }
        if (window.__e2eClipBackup) {
          const clip = require('electron').clipboard;
          clip.readText = window.__e2eClipBackup.readText;
          clip.readTextAsync = window.__e2eClipBackup.readTextAsync;
          window.__e2eClipBackup = null;
        }
        window.__e2eSendLog = null;
        return true;
      })()`);
    }
    // 15.6 search addon follows the terminal (repair-plan gap B): two
    //     terminals seeded with distinct marker text; after an extract the
    //     search bar (real doSearch → real SearchAddon → real buffer) finds
    //     ONLY the active terminal's content on both sides.
    const adr4TabC = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-C', type: 'local' })`);
    const C = JSON.stringify(adr4TabC);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${C}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`TabManager.splitHorizontal()`);
    await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${C})).filter(p => p.term && p.tabId).length`, 2, 15000);
    const adr4CExt = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(x => x.id === ${C});
      const panes = getAllPanes(tab);
      panes[0].term.write('ZTERM-SEARCH-ALPHA\\r\\n');
      panes[1].term.write('ZTERM-SEARCH-BRAVO\\r\\n');
      TabManager._extractPaneToTab(tab.id, panes[1].id);
      return TabManager.tabs[TabManager.tabs.length - 1].id;
    })()`);
    const CC = JSON.stringify(adr4CExt);
    // Hard precondition: both markers parsed into the buffers (scan every
    // line; waitForValue alone returns silently on timeout and would let a
    // missing fixture masquerade as a search failure).
    const bufPre = await waitForValue(cdp, `(() => {
      const has = (tabId, needle) => {
        const t = TabManager.tabs.find(x => x.id === tabId);
        if (!t || !t.term) return false;
        const b = t.term.buffer.active;
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i);
          if (l && l.translateToString(true).includes(needle)) return true;
        }
        return false;
      };
      return has(${C}, 'ZTERM-SEARCH-ALPHA') && has(${CC}, 'ZTERM-SEARCH-BRAVO');
    })()`, true, 8000);
    if (bufPre !== true) throw new Error('ADR4 search fixture: marker text never reached the terminal buffers');
    // The count badge is NOT a valid observable: the vendored addon only
    // fires onDidChangeResults for findNext(query, {decorations:true}), which
    // the product never passes. Assert the real user-visible semantics
    // instead: doSearch() → findNextWithSelection SELECTS the match in the
    // ACTIVE terminal's buffer (and clears the selection on a miss).
    async function searchSelects(query) {
      await cdp.eval(`(() => { document.getElementById('search-input').value = ${JSON.stringify(query)}; doSearch(); return true; })()`);
      for (let i = 0; i < 10; i++) {
        const sel = await cdp.eval(`(() => {
          const tab = TabManager.getActive();
          if (!tab || !tab.term) return null;
          return tab.term.hasSelection() ? tab.term.getSelection() : '';
        })()`);
        if (sel) return sel;
        await sleep(150);
      }
      return '';
    }
    // Active tab after the extract is the NEW tab (BRAVO content only)
    const hitNew = await searchSelects('ZTERM-SEARCH-BRAVO');
    const missNew = await searchSelects('ZTERM-SEARCH-ALPHA');
    await cdp.eval(`(() => { TabManager.switchTo(${C}); return true; })()`);
    const hitSrc = await searchSelects('ZTERM-SEARCH-ALPHA');
    check('ADR4：搜索适配器随终端迁移（仅命中活动终端内容）',
      hitNew === 'ZTERM-SEARCH-BRAVO' && missNew === '' && hitSrc === 'ZTERM-SEARCH-ALPHA',
      JSON.stringify({ hitNew, missNew, hitSrc }));
    await cdp.eval(`(() => { try { closeSearch(); } catch (e) {} return true; })()`);

    // 15.7 IME perceivedCaret provider reads the CURRENT owner (gap A): the
    //     provider installed on the extracted terminal is the real one from
    //     ime-caret-anchor (stored on the core); only the adapter leaf is
    //     wrapped to count calls. Old code: 0 calls (old wrapper cleared).
    const imeProv = await cdp.eval(`(() => {
      const nt = TabManager.tabs.find(x => x.id === ${CC});
      if (!nt || !nt.term || !nt.term._core) return { ok: false, why: 'nt' };
      const prov = nt.term._core.__imeAnchorPerceivedCaret;
      if (typeof prov !== 'function') return { ok: false, why: 'provider' };
      const adapter = nt._smoothCursor && nt._smoothCursor._adapter;
      if (!adapter || typeof adapter.perceivedCaretCell !== 'function') return { ok: false, why: 'adapter' };
      let calls = 0;
      const orig = adapter.perceivedCaretCell;
      adapter.perceivedCaretCell = function () { calls += 1; return orig.call(this); };
      let val = null;
      try { val = prov(); } finally { adapter.perceivedCaretCell = orig; }
      return { ok: true, calls, val: val ? 'cell' : 'null' };
    })()`);
    check('ADR4：IME perceivedCaret 提供者按当前归属读取适配器（提取后仍指向新 owner）',
      imeProv.ok === true && imeProv.calls >= 1, JSON.stringify(imeProv));

    // 15.8 paste generation validation (gap D), close path with the REAL
    //     closeTab: the clipboard read resolves IMMEDIATELY after the close
    //     starts — inside the ~200ms exit-animation window where the tab
    //     still holds its backend — and must deliver ZERO input.
    const adr4TabD = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-D', type: 'local' })`);
    const D = JSON.stringify(adr4TabD);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${D}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`(() => {
      window.__e2eSendLog = [];
      window.__e2eOrigSend = window.electron.ipcRenderer.send;
      window.electron.ipcRenderer.send = function (ch, payload) { window.__e2eSendLog.push({ ch, payload }); };
      const clip = require('electron').clipboard;
      window.__e2eClipBackup = { readText: clip.readText, readTextAsync: clip.readTextAsync };
      window.__e2ePasteGate = { resolve: null };
      clip.readTextAsync = () => new Promise(r => { window.__e2ePasteGate.resolve = r; });
      clip.readText = () => '';
      return true;
    })()`);
    try {
      await cdp.eval(`(() => { TabManager.tabs.find(x => x.id === ${D}).term.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
      await cdp.eval(`(() => { TabManager.closeTab(${D}); return TabManager._closingTabs.has(${D}); })()`).then((inWindow) => {
        if (inWindow !== true) throw new Error('ADR4 close-paste: tab was removed synchronously; window not exercised');
      });
      // Resolve INSIDE the removal window (before the 200ms deferred removal).
      await cdp.eval(`window.__e2ePasteGate.resolve('PASTE-CLOSED')`);
      await sleep(400); // let the removal finish before counting
      const closedPaste = await cdp.eval(`window.__e2eSendLog.filter(x => x.ch === 'pty-input' && x.payload.data === 'PASTE-CLOSED').length`);
      check('ADR4：粘贴读取期间会话关闭（动画窗口内）→ 零投递', closedPaste === 0, `count=${closedPaste}`);
    } finally {
      await cdp.eval(`(() => {
        if (window.__e2eOrigSend) { window.electron.ipcRenderer.send = window.__e2eOrigSend; window.__e2eOrigSend = null; }
        if (window.__e2eClipBackup) {
          const clip = require('electron').clipboard;
          clip.readText = window.__e2eClipBackup.readText;
          clip.readTextAsync = window.__e2eClipBackup.readTextAsync;
          window.__e2eClipBackup = null;
        }
        window.__e2eSendLog = null; window.__e2ePasteGate = null;
        return true;
      })()`);
    }
    // 15.8b paste generation validation, reconnect-swap path: the backend id
    //     swap a preserve-content reconnect performs is applied to the state
    //     (ssh-connecting semantics — a REAL reconnect needs an authorized
    //     SSH connection, not available here); the handler under test is real.
    const adr4TabE = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-E', type: 'local' })`);
    const E = JSON.stringify(adr4TabE);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${E}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`(() => {
      window.__e2eSendLog = [];
      window.__e2eOrigSend = window.electron.ipcRenderer.send;
      window.electron.ipcRenderer.send = function (ch, payload) { window.__e2eSendLog.push({ ch, payload }); };
      const clip = require('electron').clipboard;
      window.__e2eClipBackup = { readText: clip.readText, readTextAsync: clip.readTextAsync };
      window.__e2ePasteGate = { resolve: null };
      clip.readTextAsync = () => new Promise(r => { window.__e2ePasteGate.resolve = r; });
      clip.readText = () => '';
      return true;
    })()`);
    try {
      await cdp.eval(`(() => { TabManager.tabs.find(x => x.id === ${E}).term.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
      // Simulate the reconnect swap: same terminal, NEW backend generation.
      await cdp.eval(`(() => { const t = TabManager.tabs.find(x => x.id === ${E}); t.connected = false; t.tabId = t.tabId + '_swap'; return true; })()`);
      await cdp.eval(`window.__e2ePasteGate.resolve('PASTE-SWAP')`);
      await sleep(300);
      const swapPaste = await cdp.eval(`window.__e2eSendLog.filter(x => x.ch === 'pty-input' && x.payload.data === 'PASTE-SWAP').length`);
      check('ADR4：粘贴读取期间后端换代 → 零投递', swapPaste === 0, `count=${swapPaste}`);
    } finally {
      await cdp.eval(`(() => {
        if (window.__e2eOrigSend) { window.electron.ipcRenderer.send = window.__e2eOrigSend; window.__e2eOrigSend = null; }
        if (window.__e2eClipBackup) {
          const clip = require('electron').clipboard;
          clip.readText = window.__e2eClipBackup.readText;
          clip.readTextAsync = window.__e2eClipBackup.readTextAsync;
          window.__e2eClipBackup = null;
        }
        window.__e2eSendLog = null; window.__e2ePasteGate = null;
        return true;
      })()`);
    }
    // 15.9 surviving tab connection state follows the adopted session (gap C):
    //     the disconnected pane state is synthetic (no authorized SSH drop
    //     here), the extract and the tab-strip render are real.
    const adr4TabF = await cdp.eval(`TabManager.createTab({ name: 'E2E-ADR4-F', type: 'local' })`);
    const F = JSON.stringify(adr4TabF);
    await waitForValue(cdp, `(() => { const t = TabManager.tabs.find(x => x.id === ${F}); return !!(t && t.term && t.tabId); })()`, true, 15000);
    await cdp.eval(`TabManager.splitHorizontal()`);
    await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${F})).filter(p => p.term && p.tabId).length`, 2, 15000);
    const adr4FState = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(x => x.id === ${F});
      const panes = getAllPanes(tab);
      panes[0].connected = true;
      panes[1].connected = false; // e.g. a dropped SSH pane
      TabManager._extractPaneToTab(tab.id, panes[0].id);
      const dot = document.querySelector('.tab[data-tab="' + ${F} + '"] .tab-icon');
      return { connected: tab.connected, dotClass: dot ? dot.className : null };
    })()`);
    check('ADR4：拆出后剩余标签连接状态来自存活会话（渲染为 disconnected 圆点）',
      adr4FState.connected === false && /disconnected/.test(adr4FState.dotClass || ''),
      JSON.stringify(adr4FState));

    // 15.10 delayed terminal focus lifecycle (batch 04): delayed focus timers
    //     must re-validate their target at fire time. The oracle records the
    //     actual focusin EVENT HISTORY during each window (a final-state
    //     snapshot alone can pass after a transient wrong focus followed by a
    //     correction), plus the final normal-focus state. Late-readiness vs
    //     search is unit-covered through the REAL pty-created claim path
    //     (tests/terminal-focus-lifecycle.test.mjs §14b) — natively the
    //     backend-arrival instant is not controllable against openSearch's
    //     50ms input timer, so it is not staged here.
    {
      // Uncaught timer errors (the old null-deref class) surface as window
      // error events — count them across the whole section. The focusin
      // recorder maps each focus landing to its surface (pane:<id> /
      // wrap:<id> / input:<id>) so a transient stale focus is visible even
      // when a later correct focus fixes the final state.
      await cdp.eval(`(() => {
        window.__flErr = 0;
        window.__flHist = [];
        window.addEventListener('error', () => { window.__flErr++; });
        document.addEventListener('focusin', (e) => {
          const t = e.target;
          let surface = t.tagName || '?';
          const pane = t.closest ? t.closest('.split-pane') : null;
          if (pane) surface = 'pane:' + pane.getAttribute('data-pane');
          else {
            const wrap = t.closest ? t.closest('.term-wrap') : null;
            if (wrap) surface = 'wrap:' + wrap.id;
            else if (t.id) surface = 'input:' + t.id;
          }
          window.__flHist.push(surface);
        }, true);
        return true;
      })()`);
      const flA = await cdp.eval(`TabManager.createTab({ name: 'E2E-FL-A', type: 'local' })`);
      const A2 = JSON.stringify(flA);
      await waitForValue(cdp, `!!(TabManager.tabs.find(x => x.id === ${A2}) || {}).term`, true, 15000);
      await cdp.eval(`TabManager.splitHorizontal()`);
      await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${A2})).filter(p => p.term && p.tabId).length`, 2, 15000);
      const flPanes = await cdp.eval(`getAllPanes(TabManager.tabs.find(x => x.id === ${A2})).filter(p => p.term && p.tabId).map(p => p.id)`);
      const twoPanes = Array.isArray(flPanes) && flPanes.length === 2;
      if (twoPanes) {
        const P0 = JSON.stringify(flPanes[0]);
        const P1 = JSON.stringify(flPanes[1]);

        // (b) PANE RACE on two VISIBLE panes (a hidden tab's textarea cannot
        // take focus, so it is a weak control): click pane[0] then pane[1] in
        // one tick. Both 50ms timers fire; the superseded pane[0] timer must
        // not land — its focusin would be recorded even though the final
        // state is pane[1].
        await cdp.eval(`(() => {
          const tab = TabManager.tabs.find(x => x.id === ${A2});
          window.__flHist = [];
          TabManager._focusPane(tab, ${P0});
          TabManager._focusPane(tab, ${P1});
          return true;
        })()`);
        await sleep(400);
        const flRace = await cdp.eval(`(() => {
          const tab = TabManager.tabs.find(x => x.id === ${A2});
          const panes = getAllPanes(tab);
          const p1Body = document.getElementById('pane-body_' + ${P1});
          return {
            errors: window.__flErr,
            hist: window.__flHist.slice(),
            stalePane0Focus: window.__flHist.some(s => s === 'pane:' + ${P0}),
            p1FocusedNow: !!p1Body && p1Body.contains(document.activeElement),
            p1MarkedFocused: panes.find(p => p.id === ${P1})?.focused === true,
          };
        })()`);
        check('焦点生命周期：面板连点后过期面板定时器不得落地（含事件历史）',
          flRace.errors === 0 && flRace.stalePane0Focus === false &&
          flRace.p1FocusedNow === true && flRace.p1MarkedFocused === true,
          JSON.stringify(flRace.hist.concat(flRace)));

        // (a) focus pane[1], close it in the same tick (inside the 50ms
        // window): no error, and the collapse focuses the survivor.
        await cdp.eval(`(() => { window.__flHist = []; return true; })()`);
        await cdp.eval(`(() => {
          const tab = TabManager.tabs.find(x => x.id === ${A2});
          TabManager._focusPane(tab, ${P1});
          TabManager._closePane(${A2}, ${P1});
          return true;
        })()`);
        await sleep(500); // 50ms focus timer + 200ms exit animation + collapse refocus
        const flClose = await cdp.eval(`(() => {
          const tab = TabManager.tabs.find(x => x.id === ${A2});
          const wrap = document.getElementById('wrap_' + ${A2});
          return {
            errors: window.__flErr,
            hist: window.__flHist.slice(),
            collapsed: !!tab && !tab.splitRoot && !!tab.term,
            survivorFocused: !!wrap && wrap.contains(document.activeElement),
          };
        })()`);
        check('焦点生命周期：窗口内关闭聚焦面板不抛错，幸存者正常获焦',
          flClose.errors === 0 && flClose.collapsed === true && flClose.survivorFocused === true,
          JSON.stringify(flClose.hist.concat(flClose)));

        // (a2) close-then-search: the deferred removal (200ms) completes
        // AFTER the user opened the search bar — the collapse completion is
        // passive and must not steal the input's focus (unit: round-2 repro
        // 1; here with real removal timers). Re-split first: (a) collapsed A.
        await cdp.eval(`TabManager.splitHorizontal()`);
        await waitForValue(cdp, `getAllPanes(TabManager.tabs.find(x => x.id === ${A2})).filter(p => p.term && p.tabId).length`, 2, 15000);
        const flP2 = await cdp.eval(`getAllPanes(TabManager.tabs.find(x => x.id === ${A2})).filter(p => p.term && p.tabId).map(p => p.id)`);
        if (Array.isArray(flP2) && flP2.length === 2) {
          const F1 = JSON.stringify(flP2[1]); // the new focused pane
          await cdp.eval(`(() => { window.__flHist = []; return true; })()`);
          await cdp.eval(`(() => {
            TabManager._closePane(${A2}, ${F1}); // deferred removal at +200ms
            openSearch();                        // the user's newer intent (+50ms input)
            return true;
          })()`);
          await sleep(900); // removal 200ms + collapse refocus 100ms + margin
          const flCloseSearch = await cdp.eval(`(() => {
            const hist = window.__flHist.slice();
            const inputIdx = hist.indexOf('input:search-input');
            return {
              errors: window.__flErr,
              hist,
              inputFocusRecorded: inputIdx >= 0,
              inputFocused: document.activeElement === document.getElementById('search-input'),
              collapsed: !TabManager.tabs.find(x => x.id === ${A2})?.splitRoot,
              terminalLandingAfterInput: inputIdx >= 0 && hist.slice(inputIdx + 1).some(s => s.startsWith('wrap:') || s.startsWith('pane:')),
            };
          })()`);
          check('焦点生命周期：延迟折叠完成不抢占已打开的搜索输入框（含事件历史）',
            flCloseSearch.errors === 0 && flCloseSearch.inputFocusRecorded === true && flCloseSearch.inputFocused === true &&
            flCloseSearch.collapsed === true && flCloseSearch.terminalLandingAfterInput === false,
            JSON.stringify(flCloseSearch.hist.concat(flCloseSearch)));
          await cdp.eval(`closeSearch()`);
          await sleep(250);
        } else {
          check('焦点生命周期：二次分屏就绪（a2 前置条件）', false, `panes=${JSON.stringify(flP2)}`);
        }

        // (c) Ctrl+F inside the switch window: the search input keeps focus
        // (the stale switch timer must not land AFTER the input — checked in
        // the history, not just the final state), and closing the search
        // returns focus to the terminal.
        const flB = await cdp.eval(`TabManager.createTab({ name: 'E2E-FL-B', type: 'local' })`);
        const B2 = JSON.stringify(flB);
        await waitForValue(cdp, `!!(TabManager.tabs.find(x => x.id === ${B2}) || {}).term`, true, 15000);
        await cdp.eval(`(() => { window.__flHist = []; return true; })()`);
        await cdp.eval(`(() => {
          TabManager.switchTo(${A2});   // schedules A's 100ms refocus (stale-in-waiting)
          openSearch();                 // newer intent: the search input (focused at +50ms)
          return true;
        })()`);
        await sleep(400);
        const flSearch = await cdp.eval(`(() => {
          const hist = window.__flHist.slice();
          const inputIdx = hist.indexOf('input:search-input');
          return {
            errors: window.__flErr,
            hist,
            inputFocusRecorded: inputIdx >= 0,
            inputFocused: document.activeElement === document.getElementById('search-input'),
            terminalLandingAfterInput: inputIdx >= 0 && hist.slice(inputIdx + 1).some(s => s.startsWith('wrap:') || s.startsWith('pane:')),
          };
        })()`);
        check('焦点生命周期：搜索输入框焦点不被过期终端定时器抢占（含事件历史）',
          flSearch.errors === 0 && flSearch.inputFocusRecorded === true && flSearch.inputFocused === true && flSearch.terminalLandingAfterInput === false,
          JSON.stringify(flSearch.hist));
        await cdp.eval(`closeSearch()`);
        await sleep(250);
        const flAfterClose = await cdp.eval(`(() => ({
          focusedInA: !!document.getElementById('wrap_' + ${A2}) && document.getElementById('wrap_' + ${A2}).contains(document.activeElement),
        }))()`);
        check('焦点生命周期：关闭搜索后终端恢复正常聚焦',
          flAfterClose.focusedInA === true, JSON.stringify(flAfterClose));
        await cdp.eval(`(() => { [${A2}, ${B2}].forEach(id => { try { TabManager.closeTab(id); } catch (e) {} }); return true; })()`).catch(() => null);
        await sleep(400);
      } else {
        check('焦点生命周期：分屏面板就绪（前置条件）', false, `panes=${JSON.stringify(flPanes)}`);
      }
    }

    // 15.11 Tab strip overflow: squeezing the bar below the 100px/tab floor
    //     must flip the strip to overflow mode (scroll arrows shown,
    //     background tabs pinned at exactly 100px, arrow nudge scrolls the
    //     viewport), and expanding it well past the content total must
    //     return it to sparse (no inline width pinning, arrows hidden, add
    //     button hugging the last tab). The crowded states also EXPAND the
    //     active tab (and a hovered background tab after a short dwell)
    //     toward its content width so its name/icons stay readable. The
    //     restore check uses an oversized basis rather than the natural
    //     width: the live session can carry enough tabs that even the full
    //     window stays in overflow.
    const stripOv = await cdp.eval(`(async () => {
      const bar = document.getElementById('tabbar');
      const vp = document.getElementById('tab-viewport');
      if (!bar || !vp) return { error: 'strip chrome missing' };
      const created = [];
      while (TabManager.tabs.length < 3) {
        created.push(TabManager.createTab({ name: 'E2E-STRIP', type: 'local' }));
      }
      const n = TabManager.tabs.length;
      const squeeze = Math.max(160, n * 100 - 20);
      bar.style.flex = '0 0 ' + squeeze + 'px';
      TabManager._relayout(true);
      const leftBtn = document.getElementById('tab-scroll-left');
      const rightBtn = document.getElementById('tab-scroll-right');
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
      const rows = [...vp.querySelectorAll('.tab')].map(el => ({ w: el.offsetWidth, active: el.classList.contains('active') }));
      // The live session may already sit in overflow with the strip scrolled
      // to the active tab — start from the left edge so the nudge can move.
      vp.scrollLeft = 0;
      const before = vp.scrollLeft;
      TabManager._nudgeTabStrip(1);
      const afterNudge = vp.scrollLeft;
      const menuBtn = document.getElementById('btn-menu');
      const overflow = {
        cls: bar.classList.contains('tabbar-overflow'),
        arrows: shown(leftBtn) && shown(rightBtn),
        // Background tabs pinned at the floor (TAB_MIN_WIDTH 100); the
        // active tab widened toward its content width (clamped to
        // [TAB_MIN_WIDTH, TAB_MAX_WIDTH] = [100, 240]).
        widths100: rows.length === n && rows.every(r => r.active ? (r.w >= 100 && r.w <= 240) : r.w === 100),
        activeExpanded: rows.some(r => r.active && r.w > 100),
        nudged: afterNudge > before,
        // Breathing reserve: even jammed full, the menu button stops
        // TAB_STRIP_RIGHT_RESERVE (48) px short of the bar's right edge.
        gapToEdge: menuBtn ? Math.round(bar.getBoundingClientRect().right - menuBtn.getBoundingClientRect().right) : null,
      };
      // Hover expansion: the hovered background tab widens past the floor
      // after the dwell; leaving the viewport collapses it back. Poll for
      // the widening rather than sleeping a fixed span past the 150ms dwell.
      const hoverEl = [...vp.querySelectorAll('.tab')].find(el => !el.classList.contains('active'));
      let hoverW = null, hoverCollapsedW = null;
      if (hoverEl) {
        hoverEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        for (let i = 0; i < 10 && !(hoverW > 100); i++) {
          await new Promise(r => setTimeout(r, 60));
          hoverW = hoverEl.offsetWidth;
        }
        vp.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise(r => setTimeout(r, 30));
        hoverCollapsedW = hoverEl.offsetWidth;
      }
      overflow.hoverExpanded = hoverW != null && hoverW > 100;
      overflow.hoverCollapsed = hoverCollapsedW === 100;
      // Expand far past any plausible content total: deterministic sparse
      // regardless of how many tabs the live session carries (the basis
      // overflows the window, but clientWidth still reports it).
      bar.style.flex = '0 0 ' + (n * 260 + 400) + 'px';
      TabManager._relayout(true);
      // Widths change instantly, but the strip FLIP from the preceding hover
      // expansion may still be interpolating transforms. Measure the settled
      // frame so hug reflects layout, not mid-animation rects.
      await new Promise(r => setTimeout(r, 260));
      const lastTab = [...vp.querySelectorAll('.tab')].pop();
      const addBtn = document.getElementById('btn-add-tab');
      const hug = (lastTab && addBtn)
        ? addBtn.getBoundingClientRect().left - lastTab.getBoundingClientRect().right : null;
      const restored = {
        state: TabManager._lastStripPlan && TabManager._lastStripPlan.state,
        noClasses: !bar.classList.contains('tabbar-overflow') && !bar.classList.contains('tabbar-sharing'),
        arrowsHidden: !shown(leftBtn) && !shown(rightBtn),
        inlineCleared: [...vp.querySelectorAll('.tab')].every(el => el.style.width === ''),
        hug,
      };
      // Hand the strip back to its natural width for the following sections.
      bar.style.flex = '';
      TabManager._relayout(true);
      for (const id of created) { try { TabManager.closeTab(id); } catch (e) {} }
      return { n, squeeze, rows, overflow, restored };
    })()`).catch((e) => ({ evalError: String((e && e.message) || e) }));
    check('标签栏溢出：窄条出现滚动箭头且后台 tab 钉在 100px（active/hover 展宽），拉宽后恢复 sparse（不钉宽、按钮紧跟）',
      !!stripOv && stripOv.overflow && stripOv.overflow.cls === true && stripOv.overflow.arrows === true &&
      stripOv.overflow.widths100 === true && stripOv.overflow.activeExpanded === true &&
      stripOv.overflow.hoverExpanded === true && stripOv.overflow.hoverCollapsed === true &&
      stripOv.overflow.nudged === true &&
      stripOv.overflow.gapToEdge != null && Math.abs(stripOv.overflow.gapToEdge - 48) <= 3 &&
      stripOv.restored && stripOv.restored.state === 'sparse' && stripOv.restored.noClasses === true &&
      stripOv.restored.arrowsHidden === true && stripOv.restored.inlineCleared === true &&
      stripOv.restored.hug != null && stripOv.restored.hug >= 0 && stripOv.restored.hug < 40,
      JSON.stringify(stripOv));
    await sleep(500); // let the staggered removals of the padding tabs settle

    // Cleanup: close this section's tabs (after the send path is restored, so
    // the pty-destroy traffic reaches the backends)
    await cdp.eval(`(() => { [${A}, ${B}, ${N}, ${C}, ${CC}, ${E}, ${F}].forEach(id => { try { TabManager.closeTab(id); } catch (e) {} }); return true; })()`).catch(() => null);
    await sleep(600); // let the staggered tab removals settle before section 14

    // 14. Window state restore: write the window field into config → restart →
    // verify maximized/size restore
    async function writeWindowState(state) {
      // Read the existing config (if any) and inject the window field
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')); } catch {}
      cfg.window = state;
      writeFileSync(DATA_CONFIG, JSON.stringify(cfg), 'utf8');
    }
    async function restartAndConnect() {
      await restartOwnedApp({ stop: killExisting, start: startApp, waitUntilQuiet: async () => {
      await sleep(800);
      // The relaunch gets a fresh debug port and browser profile, so a
      // slow-to-die old browser cannot collide with the new instance. This
      // poll is best-effort settle time only: after a force kill the old
      // LISTEN socket can linger in the kernel with no owning PID left to
      // kill, so never gate the restart on the old port.
      const portQuiet = Date.now() + 15000;
      while (Date.now() < portQuiet) {
        try {
          await fetch(`http://127.0.0.1:${launchPort}/json/version`, { signal: AbortSignal.timeout(1000) });
          await sleep(400);
          continue;
        } catch { break; } // connection refused → old browser is gone
      }
      } });
      // Same pre-attach identity gate (destination binding + ownership,
      // including the sandbox-profile fallback) as the initial connection.
      const c2 = await connectOwnedPage();
      await installIsolatedShellGuard(c2);
      return c2;
    }
    // Window state restore is triggered by renderer-ready (runs async after
    // page load), so poll for it. Note: innerWidth is in CSS pixels while
    // set_size restores physical pixels (the saved outer_size value), so the
    // expected width is expectW / devicePixelRatio — convert by DPR when
    // comparing to avoid false failures under display scaling.
    async function assertWindowRestored(cdp, expectMax, expectW) {
      for (let i = 0; i < 25; i++) {
        const max = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`).catch(() => false);
        if (max !== expectMax) { await sleep(300); continue; }
        if (expectW) {
          const dpr = await cdp.eval(`window.devicePixelRatio`).catch(() => 1);
          const w = await cdp.eval(`window.innerWidth`).catch(() => 0);
          if (Math.abs(w * dpr - expectW) < 120) return { max, w, dpr };
          await sleep(300);
          continue;
        }
        return { max, w: 0, dpr: 1 };
      }
      return { max: null, w: 0, dpr: 1 };
    }
    killExisting();
    await sleep(500);
    await writeWindowState({ x: 50, y: 50, width: 800, height: 600, maximized: true });
    const cdp2 = await restartAndConnect();
    const r2 = await assertWindowRestored(cdp2, true, null);
    check('重启后恢复最大化状态', r2.max === true, `isMaximized=${r2.max}`);
    cdp2.close();
    await sleep(500);
    await writeWindowState({ x: 60, y: 60, width: 900, height: 700, maximized: false });
    const cdp3 = await restartAndConnect();
    const r3 = await assertWindowRestored(cdp3, false, 900);
    check('重启后恢复窗口化尺寸', r3.max === false && r3.w !== 0,
      `isMaximized=${r3.max}, innerWidth=${r3.w} (期望 ~900/${r3.dpr} CSS px)`);
    cdp3.close();

    // 14.1 Issue #14 regression: restart-restore content replay. Capture used
    // to split every pty chunk on '\n' and push the pieces as lines, so chunk
    // boundaries became permanent line breaks (SSH per-keystroke echo restored
    // one letter per line, TUI history garbled). The tail is now a raw string;
    // these checks pin the seeded-config → restart → replay path end to end.
    // Config writes happen after killExisting() and before the relaunch: the
    // running app rewrites config.json every 15s, so seeding while it is alive
    // races the periodic save.
    function seedRestoreTabs(content) {
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')); } catch {}
      cfg.terminal = { ...(cfg.terminal || {}), restoreLocalContent: true };
      cfg.lastTabs = [{ name: 'RestoreA', type: 'local', command: 'powershell.exe', args: [], content }];
      writeFileSync(DATA_CONFIG, JSON.stringify(cfg), 'utf8');
    }
    async function restoredTopLines(cdp) {
      // TabManager restores tabs during init; the replay lands when the local
      // pty is wired, so poll the active terminal's buffer top rows.
      for (let i = 0; i < 20; i++) {
        const state = await cdp.eval(`(() => {
          const tab = TabManager.getActive();
          const b = tab && tab.term && tab.term.buffer ? tab.term.buffer.active : null;
          if (!b) return null;
          const l0 = b.getLine(0)?.translateToString(true) || '';
          if (!l0) return null;
          return { l0, l1: b.getLine(1)?.translateToString(true) || '' };
        })()`).catch(() => null);
        if (state) return state;
        await sleep(400);
      }
      return null;
    }

    // (a) raw string tail: a line split across capture chunks must restore as
    // ONE line — the vertical-letters regression pin.
    killExisting();
    await sleep(500);
    await seedRestoreTabs('[root@x ~]# echo test\r\ntest output\r\n');
    const cdpR1 = await restartAndConnect();
    const r1lines = await restoredTopLines(cdpR1);
    check('重启恢复：整行内容不再断成竖排单字符（#14）',
      !!r1lines && r1lines.l0.includes('[root@x ~]# echo test') && r1lines.l1.includes('test output'),
      JSON.stringify(r1lines));
    cdpR1.close();

    // (b) legacy array-of-lines save migrates through the same replay intact.
    killExisting();
    await sleep(500);
    await seedRestoreTabs(['[root@y ~]# ls', 'file1']);
    const cdpR2 = await restartAndConnect();
    const r2lines = await restoredTopLines(cdpR2);
    check('重启恢复：旧版行数组内容完整迁移回放',
      !!r2lines && r2lines.l0.includes('[root@y ~]# ls') && r2lines.l1.includes('file1'),
      JSON.stringify(r2lines));
    cdpR2.close();

    // (c) state-reset epilogue: a tail ending inside a killed TUI (cursor
    // hidden) must end the replay with the cursor visible again.
    killExisting();
    await sleep(500);
    await seedRestoreTabs('restore-epilogue-check\x1b[?25l');
    const cdpR3 = await restartAndConnect();
    let r3state = null;
    let r3ok = false;
    for (let i = 0; i < 20 && !r3ok; i++) {
      const s = await cdpR3.eval(`(() => {
        const tab = TabManager.getActive();
        if (!tab || !tab.term) return null;
        const b = tab.term.buffer.active;
        let hit = false;
        for (let y = 0; y < b.length; y++) {
          if ((b.getLine(y)?.translateToString(true) || '').includes('restore-epilogue-check')) { hit = true; break; }
        }
        if (!hit) return null;
        return { hidden: tab.term._core.coreService.isCursorHidden };
      })()`).catch(() => null);
      if (s) { r3state = s; if (s.hidden === false) r3ok = true; }
      if (!r3ok) await sleep(400);
    }
    check('重启恢复：回放后隐藏光标被重置为可见',
      r3ok === true && r3state?.hidden === false,
      JSON.stringify(r3state));
    cdpR3.close();

    killExisting();
    await sleep(500);
  } finally {
    cdp.close();
    const stopped = killExisting();
    restoreConfig();
    await sshFailureEndpoint?.close();
    // Anything other than exactly true — owned kill failure or an explicit
    // incomplete-cleanup report (unproven live holder on a launch port) —
    // fails the run; uncertain cleanup is never treated as success.
    if (stopped !== true) throw new Error(`Owned runtime cleanup failed: ${stopped.reasons.join('; ')}`);
  }

  if (backgroundFailure) throw backgroundFailure;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(`E2E 失败: ${e.stack || e.message}`); killExisting(); restoreConfig(); process.exit(1); });
