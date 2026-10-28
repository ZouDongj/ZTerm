#!/usr/bin/env node
// Native isolated E2E: bounded WebGL context-loss recovery of the smooth
// cursor (work package fix/caret-context-recovery).
//
// Drives the REAL app in the standard e2e sandbox (own exe copy, own profile,
// background desktop placement via scripts/e2e-background-policy.mjs, CDP
// endpoint ownership via scripts/e2e-ownership.mjs) and kills REAL WebGL
// contexts through the WEBGL_lose_context extension — no mocks, no pixel
// claims; all assertions are numeric/boolean state read back from the page.
//
// Phases (each pins one behavior of the fix in src/renderer/terminal.js):
//   A. Unrecovered loss on the ACTIVE tab (no switching): the addon is
//      released and ONE fresh context + adapter is auto-attached, and it
//      stays attached (no flapping). Old behavior: the terminal stayed on
//      the DOM renderer with a null adapter forever.
//   B. Loss followed by a tab switch AWAY AND BACK inside the vendor's 3s
//      restore window: the re-attach replaces the known-lost context
//      immediately instead of reusing the dead record. Old behavior: the
//      early-exit reused the dead addon and the loss handler then left the
//      last visible tab on the DOM renderer with a null adapter.
//   C. Bounded retry: a second unrecovered loss after the automatic recovery
//      stays on the DOM renderer (no third context); a user-driven tab
//      switch re-arms the recovery.
//
// Usage:
//   node scripts/e2e-webgl-context-recovery.mjs [exe-path] [port]
//     exe-path  zterm.exe under test (default src-tauri/target/release/zterm.exe)
//     port      base remote-debugging port (default 9222)
//
// Local PTY tabs only (seeded isolated config, no SSH), so CDP evaluate
// polling is safe per the recorded CDP/SSH boundary. All temp artifacts stay
// in artifacts/e2e-tmp/ via createE2eSandbox. Exit code 0 = all checks pass.

import { spawn, execFileSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createE2eSandbox, killOwnedRuntime, probeDebugPortRange, seedIsolatedConfig } from './e2e-isolation.mjs';
import { backgroundDesktopIndex, validateFreshDesktopSnapshot, observeDesktopStream, completeBackgroundHandshake,
  validateNativeHostHealth, renewNativeLease, createBackgroundLease, backgroundNow,
  stopBackgroundRun, readHostProcessDiagnostic } from './e2e-background-policy.mjs';
import { connectVerifiedEndpoint } from './e2e-ownership.mjs';
import { requireBackgroundCapability } from './e2e-background-capability.mjs';
import { writeBackgroundJson } from './e2e-background-json.mjs';
import { Cdp } from './e2e-cdp.mjs';

const SOURCE_EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
const PORT = Number(process.argv[3] ?? 9222);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_INDEX = backgroundDesktopIndex(process.env.ZTERM_E2E_DESKTOP ?? '2');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: pass === true, detail: detail ?? '' });
  console.log(`${pass === true ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let sandbox = null;
let ownedChild = null;
let vdHelperExe = null;
let backgroundRun = null;
let backgroundFailure = null;
let launchPort = PORT;

// Same isolated shell startup policy as e2e-check.mjs (local tabs only).
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

function killExisting() {
  stopBackgroundObserver();
  if (!sandbox && !ownedChild) return true;
  const child = ownedChild;
  const result = killOwnedRuntime({
    child,
    executable: sandbox?.exe,
    sandboxDirectory: sandbox?.directory,
    launchPort,
    launched: !!ownedChild,
  });
  if (result === true) { ownedChild = null; return true; }
  if (result.hostDisposition === 'dead' || result.hostDisposition === 'killed') ownedChild = null;
  return result;
}

async function assertUnusedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
  });
}

async function startApp(dataConfig) {
  await requireBackgroundCapability(sandbox.exe);
  // Seed an isolated local-only tab set before launch; restoreLocalContent
  // stays off and no SSH profile exists, so nothing here ever touches a real
  // session and CDP evaluate polling is safe for every tab in this run.
  const config = { lastTabs: [{ name: 'GL A', type: 'local', command: 'powershell.exe', args: ['-NoProfile'] }] };
  writeFileSync(dataConfig, JSON.stringify(config), 'utf8');
  const udf = join(sandbox.directory, 'webview-1');
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
  const child = spawn(sandbox.exe, [], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      APPDATA: sandbox.appData,
      LOCALAPPDATA: sandbox.appData,
      ZTERM_E2E_BACKGROUND_POLICY: policyPath,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${launchPort} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
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
    assertBackgroundHealthy();
    backgroundRun.released = true;
    console.log('[e2e] background placement/release verified: ' + JSON.stringify({ pid: child.pid }));
  } catch (error) {
    failBackground(error);
    throw error;
  }
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
  throw new Error(`页面在 ${timeoutMs}ms 内未就绪`);
}

async function connectOwnedPage() {
  const run = backgroundRun;
  const child = ownedChild;
  const port = launchPort;
  return connectVerifiedEndpoint({
    discover: () => waitForPage(), port, executable: sandbox.exe, sandboxDirectory: sandbox.directory,
    child, signal: run?.abortController.signal,
    isCurrent: () => backgroundRun === run && ownedChild === child && launchPort === port && !run?.stopping,
    assertHealthy: assertBackgroundHealthy,
    onDuration: result => console.log('[e2e] endpoint ownership verification: ' + JSON.stringify(result)),
  });
}

async function waitForValue(cdp, expression, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expression).catch(() => null);
    if (last === expected) return last;
    await sleep(250);
  }
  return last;
}

// ── In-page probe helpers (numeric state only; no visual claims) ────────────
// Marks every WebGL addon instance it sees with an incrementing id so phases
// can prove the recovery created a NEW context rather than reviving the old
// one. xterm's Terminal._addonManager._addons holds { instance } wrappers (a disposed addon
// is spliced out by its wrapped dispose); the vendored addon shape
// (instance._renderer._gl) is the one scripts/e2e-webgl-atlas.mjs relies on.
async function probeTab(cdp, tabId) {
  return cdp.eval(`(() => {
    window.__e2eAddonSeq = window.__e2eAddonSeq || 0;
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term) return { missing: true };
    const addons = (tab.term._addonManager?._addons || []).map(w => w && w.instance).filter(a => a && a._renderer && a._renderer._gl);
    const live = addons.filter(a => !a._renderer._gl.isContextLost());
    for (const a of live) if (!a.__e2eMark) a.__e2eMark = ++window.__e2eAddonSeq;
    const wrap = document.getElementById('wrap_' + tab.id);
    const renderer = tab.term._core?._renderService?._renderer?.value;
    const record = _webglByTerm.get(tab.term);
    return {
      adapter: !!tab._smoothCursor?._adapter,
      liveContexts: live.length,
      liveMark: live.length === 1 ? live[0].__e2eMark : (live.length ? -live.length : 0),
      addonCount: addons.length,
      canvasInWrap: !!wrap?.querySelector('.xterm-screen canvas:not(.xterm-link-layer)'),
      rendererIsWebgl: !!renderer?._gl,
      currentContextLost: renderer?._gl?.isContextLost?.() ?? null,
      recordedAddon: !!record?.addon,
      recordedContextLost: record?.addon?._renderer?._gl?.isContextLost?.() ?? null,
    };
  })()`);
}

async function loseTabContext(cdp, tabId) {
  return cdp.eval(`(() => {
    window.__e2eAddonSeq = window.__e2eAddonSeq || 0;
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term) return { ok: false, reason: 'tab or term missing' };
    const addons = (tab.term._addonManager?._addons || []).map(w => w && w.instance).filter(a => a && a._renderer && a._renderer._gl);
    const live = addons.filter(a => !a._renderer._gl.isContextLost());
    if (live.length !== 1) return { ok: false, reason: 'expected exactly one live context, saw ' + live.length };
    const gl = live[0]._renderer._gl;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return { ok: false, reason: 'WEBGL_lose_context unavailable' };
    if (!live[0].__e2eMark) live[0].__e2eMark = ++window.__e2eAddonSeq;
    window.__e2eLostMark = live[0].__e2eMark;
    window.__e2eLossAt = performance.now();
    ext.loseContext();
    return { ok: true, mark: live[0].__e2eMark };
  })()`);
}

async function main() {
  if (!existsSync(SOURCE_EXE)) throw new Error(`exe 不存在: ${SOURCE_EXE}`);
  await requireBackgroundCapability(SOURCE_EXE);
  for (let shift = 0; ; shift += 10) {
    const occupied = probeDebugPortRange(PORT + shift, 1);
    if (occupied.length === 0) { launchPort = PORT + shift; break; }
    if (shift >= 20) {
      const detail = occupied.map((o) => o.unknown
        ? `${o.port}（查询失败）`
        : `${o.port}（${o.holders.map((h) => `${h.pid}:${h.name ?? '未知进程'}`).join('/')}，不会被终止）`).join('、');
      throw new Error(`调试端口段均被占用（${detail}），无法启动 E2E`);
    }
  }
  await assertUnusedPort(launchPort);
  sandbox = createE2eSandbox(SOURCE_EXE);
  const dataConfig = seedIsolatedConfig(sandbox);
  console.log(`E2E source: ${SOURCE_EXE}\nIsolated runtime: ${sandbox.directory}\n`);
  await startApp(dataConfig);
  const cdp = await connectOwnedPage();
  try {
    await waitForValue(cdp, `document.readyState === 'complete' && typeof _settingsConfig === 'object' && !!TabManager`, true, 20000);
    const runtimeData = await cdp.eval(`ipcRenderer.invoke('get-data-dir-info')`);
    if (resolve(runtimeData.current).toLowerCase() !== resolve(dirname(dataConfig)).toLowerCase()) {
      throw new Error('Connected runtime is not using the isolated E2E configuration');
    }
    await cdp.eval(`(() => {
      const isolateArgs = ${isolatedShellArgs.toString()};
      const original = _ptyCreatePayload;
      _ptyCreatePayload = function(shell, args, cwd, requestId) {
        return original(shell, isolateArgs(shell, args || []), cwd, requestId);
      };
    })()`);

    // Wait for the restored tab to be wired AND its WebGL adapter attached.
    await waitForValue(cdp, `(() => {
      const tab = TabManager.getActive();
      return !!tab && !!tab.term && !!tab._smoothCursor?._adapter;
    })()`, true, 30000);
    const tabA = await cdp.eval(`TabManager.getActive().id`);
    const before = await probeTab(cdp, tabA);
    check('初始状态：活动 tab 挂载 WebGL 且 adapter 存在',
      before.adapter === true && before.liveContexts === 1 && before.rendererIsWebgl === true,
      JSON.stringify(before));

    // ── Phase A: unrecovered loss on the active tab, no switching ──
    // A context already lost during startup is the original failure mode, not
    // a reason to skip the test. Use that real loss; otherwise inject one.
    const lossA = before.liveContexts === 1 ? await loseTabContext(cdp, tabA)
      : { ok: true, mark: 'startup-loss', spontaneous: true };
    if (lossA.ok !== true) throw new Error('Phase A could not kill the context: ' + JSON.stringify(lossA));
    // >3s so the vendored restore window elapses and onContextLoss fires;
    // then poll a bounded window for the automatic recovery.
    await sleep(3600);
    let recoveredA = null;
    for (let i = 0; i < 32; i++) {
      recoveredA = await probeTab(cdp, tabA).catch(() => null);
      if (recoveredA?.adapter === true && recoveredA.liveContexts === 1) break;
      await sleep(250);
    }
    const stayA = await sleep(2000).then(() => probeTab(cdp, tabA)).catch(() => null);
    check('A：3 秒未恢复的 context loss 后活动 tab 自动重挂新 context',
      recoveredA?.adapter === true && recoveredA?.liveContexts === 1 && recoveredA?.liveMark !== lossA.mark,
      `loss=${JSON.stringify(lossA)} recovered=${JSON.stringify(recoveredA)}`);
    check('A：重挂后 2 秒仍稳定（不闪烁回退）',
      stayA?.adapter === true && stayA?.liveContexts === 1 && stayA?.rendererIsWebgl === true,
      JSON.stringify(stayA));

    // ── Phase B: loss, then switch away+back INSIDE the 3s restore window ──
    await cdp.eval(`document.getElementById('btn-add-tab').click()`);
    await waitForValue(cdp, `(() => {
      const tab = TabManager.getActive();
      return TabManager.tabs.length === 2 && !!tab?.term && !!tab._smoothCursor?._adapter;
    })()`, true, 30000);
    const tabB = await cdp.eval(`TabManager.getActive().id`);
    const beforeB = await probeTab(cdp, tabB);
    check('B：第二个本地 tab 就绪且挂载 WebGL', beforeB.adapter === true && beforeB.liveContexts === 1,
      `tabB=${JSON.stringify(tabB)} state=${JSON.stringify(beforeB)}`);

    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabA)})`);
    await waitForValue(cdp, `(() => {
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
      return !!tab?._smoothCursor?._adapter;
    })()`, true, 8000);
    const preLossB = await probeTab(cdp, tabA);
    if (preLossB.liveContexts !== 1) throw new Error('Phase B precondition failed: ' + JSON.stringify(preLossB));
    const lossB = await loseTabContext(cdp, tabA);
    if (lossB.ok !== true) throw new Error('Phase B could not kill the context: ' + JSON.stringify(lossB));
    await sleep(1200); // still inside the vendor's 3s restore window
    // Switch away/back and read in one task, before ordinary loss recovery
    // could create a new context at the 3s boundary.
    const recoveredB = await cdp.eval(`(() => {
      TabManager.switchTo(${JSON.stringify(tabB)});
      TabManager.switchTo(${JSON.stringify(tabA)});
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
      const addons = (tab.term._addonManager?._addons || []).map(w => w?.instance).filter(a => a?._renderer?._gl);
      const live = addons.filter(a => !a._renderer._gl.isContextLost());
      window.__e2eAddonSeq = window.__e2eAddonSeq || 0;
      for (const addon of live) if (!addon.__e2eMark) addon.__e2eMark = ++window.__e2eAddonSeq;
      return {
        elapsedMs: performance.now() - window.__e2eLossAt,
        adapter: !!tab._smoothCursor?._adapter,
        liveContexts: live.length,
        liveMark: live.length === 1 ? live[0].__e2eMark : 0,
        rendererIsWebgl: !!tab.term._core?._renderService?._renderer?.value?._gl,
      };
    })()`);
    const stayB = await sleep(2000).then(() => probeTab(cdp, tabA)).catch(() => null);
    check('B：3 秒窗口内切走再切回后，死 context 被立即替换（不沿用旧记录）',
      recoveredB?.elapsedMs < 3000 && recoveredB?.adapter === true && recoveredB?.liveContexts === 1 && recoveredB?.rendererIsWebgl === true && recoveredB?.liveMark !== lossB.mark,
      `loss=${JSON.stringify(lossB)} recovered=${JSON.stringify(recoveredB)}`);
    check('B：恢复后 2 秒仍稳定',
      stayB?.adapter === true && stayB?.liveContexts === 1 && stayB?.rendererIsWebgl === true,
      JSON.stringify(stayB));

    // ── Phase C: bounded retry ──
    // Phase B's recovery went through the user-driven switch path, which
    // re-arms the single-shot budget: this first kill auto-recovers ONCE
    // (fresh mark), and the SECOND kill — after an automatic recovery with no
    // user action in between — must stay on the DOM renderer (bounded).
    const lossC1 = await loseTabContext(cdp, tabA);
    if (lossC1.ok !== true) throw new Error('Phase C could not kill the context: ' + JSON.stringify(lossC1));
    await sleep(3600);
    let recoveredC = null;
    for (let i = 0; i < 32; i++) {
      recoveredC = await probeTab(cdp, tabA).catch(() => null);
      if (recoveredC?.adapter === true && recoveredC?.liveContexts === 1) break;
      await sleep(250);
    }
    check('C：用户路径重挂后第一次 loss 仍自动恢复一次',
      recoveredC?.adapter === true && recoveredC?.liveContexts === 1 && recoveredC?.liveMark !== lossC1.mark,
      `loss=${JSON.stringify(lossC1)} recovered=${JSON.stringify(recoveredC)}`);

    const lossC2 = await loseTabContext(cdp, tabA);
    if (lossC2.ok !== true) throw new Error('Phase C could not kill the second context: ' + JSON.stringify(lossC2));
    await sleep(4600); // >3s loss window + settle; NO switching in between
    const bounded = await probeTab(cdp, tabA).catch(() => null);
    check('C：自动恢复后的第二次 loss 不再自动建第三个 context（重试有界）',
      bounded?.adapter === false && bounded?.liveContexts === 0,
      JSON.stringify(bounded));
    // A user-driven tab switch re-arms the bounded recovery (manual attach).
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabB)})`);
    await sleep(400);
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabA)})`);
    let rearmC = null;
    for (let i = 0; i < 32; i++) {
      rearmC = await probeTab(cdp, tabA).catch(() => null);
      if (rearmC?.adapter === true && rearmC?.liveContexts === 1) break;
      await sleep(250);
    }
    check('C：用户切换 tab 后手动路径重新挂载（重新武装有界恢复）',
      rearmC?.adapter === true && rearmC?.liveContexts === 1 && rearmC?.liveMark !== lossC2.mark,
      `loss=${JSON.stringify(lossC2)} after=${JSON.stringify(rearmC)}`);
    const lossC3 = await loseTabContext(cdp, tabA);
    if (lossC3.ok !== true) throw new Error('Phase C could not kill the re-armed context');
    await sleep(3600);
    const rearmedRecovery = await probeTab(cdp, tabA);
    check('C：用户重挂后再次丢失仍可自动恢复一次',
      rearmedRecovery?.adapter === true && rearmedRecovery?.liveContexts === 1 && rearmedRecovery?.liveMark !== lossC3.mark,
      `loss=${JSON.stringify(lossC3)} after=${JSON.stringify(rearmedRecovery)}`);

    // Re-arm through a real user switch before the simultaneous-loss phase.
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabB)}); TabManager.switchTo(${JSON.stringify(tabA)})`);
    const healthyForD = await probeTab(cdp, tabA);
    check('D：健康复用重新武装恢复预算',
      healthyForD?.adapter === true && healthyForD?.liveContexts === 1 && healthyForD?.liveMark === rearmedRecovery?.liveMark,
      JSON.stringify(healthyForD));
    if (healthyForD?.adapter !== true || healthyForD?.liveContexts !== 1) throw new Error('Phase D re-arm precondition failed');

    // Two terminals lose their contexts together. Only the active one may
    // auto-recover in the background; each tab must recover on activation.
    const lossD1 = await loseTabContext(cdp, tabA);
    const lossD2 = await loseTabContext(cdp, tabB);
    if (lossD1.ok !== true || lossD2.ok !== true) throw new Error('Phase D could not kill both contexts');
    await sleep(3600);
    const activeAfterD = await probeTab(cdp, tabA);
    const hiddenAfterD = await probeTab(cdp, tabB);
    check('D：多 tab 同时丢失时仅活动 tab 后台重挂，隐藏 tab 不新建 context',
      activeAfterD?.adapter === true && activeAfterD?.liveContexts === 1 && hiddenAfterD?.liveContexts === 0,
      JSON.stringify({ activeAfterD, hiddenAfterD }));
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabB)})`);
    const activeBAfterD = await probeTab(cdp, tabB);
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabA)})`);
    const activeAAfterD = await probeTab(cdp, tabA);
    const restoredOptions = await cdp.eval(`(() => {
      const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
      const state = tab._smoothCursor?._adapter?.snapshot();
      return { smooth: state?.smoothEnabled, duration: state?.duration, liveBudget: _webglLive.size };
    })()`);
    check('D：两个 tab 激活后均恢复平滑 WebGL，90ms 设置与上下文预算不变',
      activeBAfterD?.adapter === true && activeBAfterD?.liveContexts === 1 && activeAAfterD?.adapter === true && activeAAfterD?.liveContexts === 1 &&
      restoredOptions?.smooth === true && restoredOptions?.duration === 90 && restoredOptions?.liveBudget <= 8,
      JSON.stringify({ activeBAfterD, activeAAfterD, restoredOptions }));
  } finally {
    cdp.close();
    const stopped = killExisting();
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

main().catch((e) => { console.error(`E2E 失败: ${e.stack || e.message}`); killExisting(); process.exit(1); });
