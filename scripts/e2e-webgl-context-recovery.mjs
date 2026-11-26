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
//   C. Bounded backoff self-heal: a transient GPU outage swallows the first
//      automatic re-attach (new WebGL2 contexts are refused at the canvas API
//      boundary, exactly the "WebGL2 not supported" failure path from issue
//      #44); the bounded retries keep failing while the outage lasts, and once
//      the GPU is back the next backoff slot heals the ACTIVE terminal in
//      place — no tab switch, no user action. The Ctrl+Shift+D report is also
//      verified to carry the read-only webgl segment.
//   D. Simultaneous loss on two tabs: only the ACTIVE tab auto-recovers in
//      the background; the hidden tab recovers on activation, keeping the
//      90ms smooth setting and the live-context budget unchanged.
//   E. Real MSYS vim typing/navigation through the app's REAL input path on
//      the owned local PTY (issue #31): the FIRST animated frame of a typed
//      echo is a plain rectangle slide (base+rectangle, echoSlides
//      increments), while a printable navigation key (`l`) that only moves
//      the caret keeps the scissored glyph inversion (base+rectangle+glyph,
//      echoSlides unchanged). Frames are inspected mid-slide through
//      armFrameCapture(1) + snapshot().capture.held. Optional PNGs under
//      ZTERM_E2E_SHOTS are saved for offline inspection only — the script
//      itself asserts nothing visual.
//   F. Native animation preference override: emulates a WebView2 page stuck on
//      prefers-reduced-motion: reduce and verifies that the live native
//      SPI_GETCLIENTAREAANIMATION state acquired at startup overrides it so
//      cursor draws stay at 90ms.
//   Phases E and F require a local console session with Windows client-area
//   animations enabled. When ZTermReducedMotion reports source === 'native'
//   with remoteSession === true or nativeAnimationsEnabled === false, each
//   phase is reported as an explicit SKIPPED group while Phases A–D still run.
//   Missing or fallback snapshots fail closed and never skip.
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
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createE2eSandbox, killOwnedRuntime, probeDebugPortRange, seedIsolatedConfig, resolveE2eTmpSubdir } from './e2e-isolation.mjs';
import { backgroundDesktopIndex, validateFreshDesktopSnapshot, observeDesktopStream, completeBackgroundHandshake,
  validateNativeHostHealth, renewNativeLease, createBackgroundLease, backgroundNow,
  stopBackgroundRun, readHostProcessDiagnostic, captureProcessExit,
  DesktopObserverTransientError, readDesktopSnapshotWithRetry } from './e2e-background-policy.mjs';
import { connectVerifiedEndpoint } from './e2e-ownership.mjs';
import { requireBackgroundCapability } from './e2e-background-capability.mjs';
import { writeBackgroundJson } from './e2e-background-json.mjs';
import { Cdp } from './e2e-cdp.mjs';
import { respawnDesktopProcess, runWithDesktopRetry } from './e2e-desktop-retry.mjs';
import { runSupervisedScript } from './e2e-process-supervisor.mjs';
import { createOwnedCleanupCoordinator } from './e2e-owned-cleanup.mjs';
import { classifyAnimationPhaseSkip, formatSkipLine, formatSummaryLine } from './e2e-reduced-motion-skip.mjs';

const SOURCE_EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
const PORT = Number(process.argv[3] ?? 9222);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_INDEX = backgroundDesktopIndex(process.env.ZTERM_E2E_DESKTOP ?? '2');

const results = [];
let skippedGroups = 0;
function check(name, pass, detail) {
  results.push({ name, pass: pass === true, detail: detail ?? '' });
  console.log(`${pass === true ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
// A skipped group is not a pass: report it explicitly so the evidence never
// claims animation coverage that could not be exercised in this environment.
function skip(name, reason) {
  skippedGroups += 1;
  console.log(formatSkipLine(name, reason));
}

let sandbox = null;
let ownedChild = null;
let vdHelperExe = null;
let backgroundRun = null;
let backgroundFailure = null;
let backgroundObserverCleanup = null;
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

function readDesktopSnapshotOnce() {
  return new Promise((resolveOnce, rejectOnce) => {
    execFile(resolveVdHelper(), ['inspect', String(DESKTOP_INDEX)],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      (error, stdout) => {
        let parsed = null;
        try { parsed = stdout ? JSON.parse(stdout.trim()) : null; } catch {}
        if (error) {
          if (parsed?.ok === false && parsed.transient === true) {
            rejectOnce(new DesktopObserverTransientError(String(parsed.error || error.message)));
            return;
          }
          rejectOnce(error);
          return;
        }
        if (!parsed) { rejectOnce(new Error('Desktop inspection produced no snapshot')); return; }
        resolveOnce(parsed);
      });
  });
}

async function inspectDesktop() {
  // Baseline and handshake inspections race the operator's window activity the
  // same way the watch stream does; retry only the bounded sampling races.
  return validateFreshDesktopSnapshot(await readDesktopSnapshotWithRetry(readDesktopSnapshotOnce));
}

function stopBackgroundObserver(reason = new Error('Owned background runtime stopped')) {
  if (backgroundObserverCleanup) return backgroundObserverCleanup;
  const run = backgroundRun;
  if (!run) return Promise.resolve(true);
  backgroundObserverCleanup = stopBackgroundRun(run, reason, error => console.error('[e2e] observer cleanup failed: ' + error.message));
  backgroundRun = null;
  return backgroundObserverCleanup;
}

function failBackground(error) {
  if (backgroundFailure) return;
  backgroundFailure = error instanceof Error ? error : new Error(String(error));
  console.error('[e2e] background isolation failed: ' + (backgroundFailure.stack || backgroundFailure.message));
  // killExisting withdraws the lease and aborts CDP before blocking OS queries.
  void killExisting().then(stopped => {
    if (stopped !== true) console.error('[e2e] owned cleanup incomplete: ' + stopped.reasons.join('; '));
  }).catch(cleanupError => console.error('[e2e] owned cleanup failed: ' + cleanupError.message));
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
  backgroundObserverCleanup = null;
  const helper = resolveVdHelper();
  const startedAt = backgroundNow();
  const observer = spawn(helper, ['watch', String(DESKTOP_INDEX), String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { baseline, token, observer, observerExit: captureProcessExit(observer), observation: null, stopping: false, released: false,
    leasePath: join(sandbox.directory, 'background-' + token + '.lease.json'),
    statusPath: join(sandbox.directory, 'background-' + token + '.status.json'),
    binding: null, timer: null, abortController: new AbortController() };
  backgroundRun = run;
  run.observation = observeDesktopStream({
    observer, baseline, startedAt, getOwnedPid: () => ownedChild?.pid,
    // Never require the operator's foreground to stay put: background E2E must
    // not fail just because the user kept working on their own desktop. The
    // native host guard (disabled/NOACTIVATE/minimized on the target desktop),
    // the desktop-id continuity check and the owned-pid foreground/owner-chain
    // checks below still prove the E2E instance never took the user's desktop.
    onTransient: error => console.error('[e2e] transient desktop observation before host launch: ' + error.message),
    onNoForeground: info => console.log('[e2e] no-foreground sample accepted (lock screen / secure desktop / activation gap): ' + JSON.stringify(info)),
    onForegroundRestored: info => console.log('[e2e] foreground samples resumed after no-foreground window: ' + JSON.stringify(info)),
    onFailure: failBackground,
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

const ownedCleanupCoordinator = createOwnedCleanupCoordinator({ stopBackgroundObserver, cleanOwnedRuntime });
function killExisting() { return ownedCleanupCoordinator.killExisting(); }
function cleanOwnedRuntime() {
  let result = true;
  if (sandbox || ownedChild) {
    const child = ownedChild;
    result = killOwnedRuntime({
      child,
      executable: sandbox?.exe,
      sandboxDirectory: sandbox?.directory,
      launchPort,
      launched: !!ownedChild,
    });
  }
  if (result === true || result.hostDisposition === 'dead' || result.hostDisposition === 'killed') ownedChild = null;
  return result;
}

// Best-effort synchronous teardown only; the OS process supervisor covers abrupt exits.
process.on('exit', () => { void killExisting(); });

async function assertUnusedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
  });
}

async function startApp(dataConfig) {
  const previousCleanup = await ownedCleanupCoordinator.beginNextRun();
  if (previousCleanup !== true) throw new Error('Previous owned cleanup was not established: ' + previousCleanup.reasons.join('; '));
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
      LOCALAPPDATA: sandbox.localAppData,
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

// ── Phase E helpers: real vim echo/navigation evidence on the local PTY ────
// Every expression below resolves the LIVE tab object and routes keystrokes
// through the app's real input path (_sendPaneInput: noteInput for echo
// classification + pty-input into the owned local PTY), so the bytes reach
// the real ConPTY → MSYS bash → vim chain exactly like user typing. No SSH,
// no herdr, no process outside the sandboxed instance is ever touched.

// Numeric adapter state around a frame: buffer type, draw pass composition,
// echo slide count, adapter/renderer identity, DPR and the motion settings.
// All Phase E assertions are these numbers/booleans read back from the page.
function phaseESnapshotExpr(tabId) {
  return `(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term) return { missing: 'tab' };
    const adapter = tab._smoothCursor?._adapter;
    if (!adapter) return { missing: 'adapter' };
    const snap = adapter.snapshot();
    const renderer = tab.term._core?._renderService?._renderer?.value;
    return {
      bufferType: tab.term.buffer.active.type,
      adapter: true,
      rendererIsWebgl: !!renderer?._gl,
      dpr: window.devicePixelRatio,
      rendererDpr: typeof renderer?._devicePixelRatio === 'number' ? renderer._devicePixelRatio : null,
      smooth: snap.smoothEnabled,
      reducedMotion: snap.reducedMotion,
      cursorStyle: snap.cursorStyle,
      durationMs: snap.duration,
      drawPassStatus: snap.drawPassStatus,
      echoSlides: snap.counters.echoSlides,
      animationActive: snap.animationActive,
      customDrawSource: snap.caretOwnership.customDrawSource,
      capture: {
        held: snap.capture.held,
        remaining: snap.capture.remaining,
        records: snap.capture.records.map(r => ({ frameId: r.frameId, style: r.style, visual: r.visual, target: r.target })),
      },
    };
  })()`;
}

// Screen rows plus the protocol cursor cell: readiness compares the last
// non-empty row, so prompts above a cleared tail cannot be missed. Typed-text
// staging is asserted through cursorX instead of scraping the modeline.
function phaseEScreenExpr(tabId) {
  return `(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term) return { missing: 'tab' };
    const term = tab.term;
    const b = term.buffer.active;
    const rows = [];
    for (let r = 0; r < term.rows; r += 1) {
      const line = b.getLine(b.baseY + r);
      let text = '';
      if (line) for (let x = 0; x < term.cols; x += 1) text += line.getCell(x)?.getChars() ?? '';
      rows.push(text.replace(/\\s+$/, ''));
    }
    return { type: b.type, cursorX: b.cursorX, cursorY: b.cursorY, rows };
  })()`;
}

// The first 4 cells of the buffer's first line: staging evidence that the
// typed text actually landed through the real PTY echo path ("affa").
function phaseETypedLineExpr(tabId) {
  return `(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term) return null;
    const b = tab.term.buffer.active;
    const line = b.getLine(b.baseY);
    let text = '';
    if (line) for (let x = 0; x < 4; x += 1) text += line.getCell(x)?.getChars() ?? '';
    return text;
  })()`;
}

async function phaseESendKeys(cdp, tabId, data) {
  return cdp.eval(`(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    if (!tab || !tab.term || typeof _sendPaneInput !== 'function') return { sent: false };
    _sendPaneInput(tab, tab, ${JSON.stringify(data)});
    return { sent: true };
  })()`);
}

async function phaseECancelCapture(cdp, tabId) {
  return cdp.eval(`(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    tab?._smoothCursor?._adapter?.cancelFrameCapture?.();
    return true;
  })()`);
}

// Bounded poll; an aborted CDP transport must not be swallowed as a timeout.
async function phaseEPoll(cdp, expression, isDone, timeoutMs, stepMs = 60) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expression).catch(error => {
      if (cdp.failure) throw cdp.failure;
      return null;
    });
    if (last && isDone(last) === true) return { done: true, value: last };
    await sleep(stepMs);
  }
  return { done: false, value: last };
}

async function phaseEReadSnapshot(cdp, tabId) {
  return cdp.eval(phaseESnapshotExpr(tabId)).catch(error => {
    if (cdp.failure) throw cdp.failure;
    return null;
  });
}

// A capture must never straddle two keystrokes: wait for the previous
// animation run to finish (and any held frame to be gone) before arming.
async function phaseEIdle(cdp, tabId, timeoutMs = 2500) {
  return phaseEPoll(cdp, phaseESnapshotExpr(tabId),
    v => v?.animationActive === false && v?.capture?.held === false, timeoutMs);
}

// Arm a ONE-frame capture, type through the REAL app input path, then wait
// for the adapter to HOLD the FIRST animated frame (armFrameCapture parks the
// animation right after that draw so the slide is inspected mid-flight, not
// settled). The capture is always cancelled on failure so no later frame can
// be frozen unexpectedly.
async function phaseECaptureFirstFrame(cdp, tabId, data, timeoutMs = 6000) {
  const idle = await phaseEIdle(cdp, tabId);
  if (!idle.done) return { ok: false, reason: 'previous animation never settled', last: idle.value };
  const armed = await cdp.eval(`(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    return tab?._smoothCursor?._adapter?.armFrameCapture?.(1) ?? null;
  })()`);
  if (armed !== 1) return { ok: false, reason: `armFrameCapture(1) returned ${JSON.stringify(armed)}` };
  const sent = await phaseESendKeys(cdp, tabId, data);
  if (sent?.sent !== true) {
    await phaseECancelCapture(cdp, tabId).catch(() => null);
    return { ok: false, reason: 'keystroke was not routed through _sendPaneInput' };
  }
  const held = await phaseEPoll(cdp, phaseESnapshotExpr(tabId), v => v?.capture?.held === true, timeoutMs);
  if (!held.done) {
    await phaseECancelCapture(cdp, tabId).catch(() => null);
    return { ok: false, reason: `first animated frame not held within ${timeoutMs}ms`, last: held.value };
  }
  return { ok: true, snapshot: held.value };
}

// Release the held frame and let the slide run out before the next step.
async function phaseEReleaseFrame(cdp, tabId) {
  await cdp.eval(`(() => {
    const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabId)});
    tab?._smoothCursor?._adapter?.releaseCapturedFrame?.();
  })()`).catch(() => null);
  return phaseEIdle(cdp, tabId, 3000);
}

// Save a PNG of the currently HELD mid-slide frame for offline inspection.
// Called only while the frame is held; asserts nothing about the pixels.
async function phaseESaveShot(cdp, name) {
  if (!process.env.ZTERM_E2E_SHOTS) return false;
  const directory = resolveE2eTmpSubdir(process.env.ZTERM_E2E_SHOTS);
  mkdirSync(directory, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!shot?.data) return false;
  writeFileSync(join(directory, name), Buffer.from(shot.data, 'base64'));
  return true;
}

// Readiness markers: the LAST non-empty screen row must be the prompt, so a
// stale "PS ..." line left in scrollback cannot match prematurely.
function phaseELastRow(value) {
  return (value?.rows || []).filter(r => r !== '').pop() ?? '';
}
function phaseEBashPromptSeen(value) {
  return /bash-[0-9][\w.\-]*[$#]\s*$/.test(phaseELastRow(value));
}
function phaseEPsPromptSeen(value) {
  return /^PS .*?>/.test(phaseELastRow(value));
}

// Read the renderer's existing ZTermReducedMotion snapshot without triggering
// an IPC refresh (used to prove main.js startup already acquired native state).
async function readReducedMotionSnapshot(cdp) {
  return cdp.eval(`(() => {
    if (typeof ZTermReducedMotion !== 'object' || !ZTermReducedMotion || typeof ZTermReducedMotion.snapshot !== 'function') {
      return null;
    }
    return ZTermReducedMotion.snapshot();
  })()`).catch(() => {
    if (cdp.failure) throw cdp.failure;
    return null;
  });
}

// Refresh the authoritative native Windows animation state via
// ZTermReducedMotion.refresh(). Missing/error/fallback snapshots return null or
// a non-native source so classifyAnimationPhaseSkip fails closed.
async function readNativeReducedMotion(cdp) {
  return cdp.eval(`(async () => {
    if (typeof ZTermReducedMotion !== 'object' || !ZTermReducedMotion || typeof ZTermReducedMotion.refresh !== 'function') {
      return null;
    }
    return await ZTermReducedMotion.refresh();
  })()`).catch(() => {
    if (cdp.failure) throw cdp.failure;
    return null;
  });
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

    // ── Phase C: bounded backoff self-heal (no tab switch) ──
    // Issue #44 needs a transient GPU outage that swallows the first automatic
    // re-attach. While every new WebGL2 context is refused the bounded retries
    // keep failing; once the GPU returns, the next backoff slot must heal the
    // ACTIVE terminal in place — no tab switch, no user action. The outage is
    // injected at the browser API boundary the vendored addon actually uses
    // (canvas.getContext('webgl2') returning null makes the real WebglAddon
    // constructor throw "WebGL2 not supported"); the original function is
    // restored before healing is observed.
    const activeBeforeC = await cdp.eval(`TabManager.activeId`);
    const preC = await probeTab(cdp, tabA);
    if (preC?.adapter !== true || preC?.liveContexts !== 1 || activeBeforeC !== tabA) {
      throw new Error('Phase C precondition failed: ' + JSON.stringify({ preC, activeBeforeC }));
    }
    const lossC = await loseTabContext(cdp, tabA);
    if (lossC.ok !== true) throw new Error('Phase C could not kill the context: ' + JSON.stringify(lossC));
    await cdp.eval(`(() => {
      window.__e2eGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type) {
        if (type === 'webgl' || type === 'webgl2') return null;
        return window.__e2eGetContext.apply(this, arguments);
      };
      return true;
    })()`);
    let outagePane = null, progressedPane = null;
    try {
      await sleep(3600); // vendor 3s restore window; the immediate retry fails
      const duringC = await probeTab(cdp, tabA);
      outagePane = (await cdp.eval(`_webglDiagnosticsSnapshot()`))?.panes?.[0] ?? null;
      check('C：GPU 故障期间活动 tab 退回 DOM，有界重试已消耗且下一次退避在计时（不切标签）',
        duringC?.adapter === false && duringC?.liveContexts === 0 &&
        outagePane?.renderer === 'dom' && outagePane?.lossCount >= 1 &&
        outagePane?.reattachAttempts >= 1 && outagePane?.reattachLimit === 7 &&
        outagePane?.nextRetryDelayMs > 0 &&
        (await cdp.eval(`TabManager.activeId`)) === tabA,
        `loss=${JSON.stringify(lossC)} during=${JSON.stringify(duringC)} diag=${JSON.stringify(outagePane)}`);
      // Bounded poll (no fixed sleep): the next backoff slot proves the
      // timer-driven retry continues with no user action at all.
      progressedPane = null;
      for (let i = 0; i < 24; i += 1) {
        const pane = (await cdp.eval(`_webglDiagnosticsSnapshot()`).catch(() => null))?.panes?.[0] ?? null;
        if (pane && pane.reattachAttempts > outagePane.reattachAttempts) { progressedPane = pane; break; }
        await sleep(250);
      }
      const stillDom = await probeTab(cdp, tabA);
      check('C：无用户操作时退避计时器继续尝试（重挂次数递增，仍未新建 live context）',
        progressedPane !== null &&
        progressedPane.reattachAttempts > outagePane?.reattachAttempts &&
        stillDom?.adapter === false && stillDom?.liveContexts === 0,
        `outage=${JSON.stringify(outagePane)} progressed=${JSON.stringify(progressedPane)}`);
    } finally {
      await cdp.eval(`(() => {
        if (window.__e2eGetContext) {
          HTMLCanvasElement.prototype.getContext = window.__e2eGetContext;
          delete window.__e2eGetContext;
        }
        return true;
      })()`).catch(() => null);
    }
    // The GPU is back: the next bounded retry must restore WebGL + the smooth
    // cursor in place.
    let healedC = null;
    for (let i = 0; i < 48; i++) {
      healedC = await probeTab(cdp, tabA).catch(() => null);
      if (healedC?.adapter === true && healedC?.liveContexts === 1 && healedC?.rendererIsWebgl === true) break;
      await sleep(250);
    }
    const healedPaneC = (await cdp.eval(`_webglDiagnosticsSnapshot()`))?.panes?.[0] ?? null;
    check('C：GPU 恢复后下一次退避重挂在原 tab 自愈（不切标签）',
      healedC?.adapter === true && healedC?.liveContexts === 1 &&
      healedC?.rendererIsWebgl === true && healedC?.liveMark !== lossC.mark &&
      (await cdp.eval(`TabManager.activeId`)) === tabA &&
      healedPaneC?.renderer === 'webgl' && healedPaneC?.reattachAttempts <= 7,
      `loss=${JSON.stringify(lossC)} healed=${JSON.stringify(healedC)} diag=${JSON.stringify(healedPaneC)}`);
    const stayC = await sleep(2000).then(() => probeTab(cdp, tabA)).catch(() => null);
    check('C：退避自愈后 2 秒仍稳定（不掉回 DOM）',
      stayC?.adapter === true && stayC?.liveContexts === 1 && stayC?.rendererIsWebgl === true,
      JSON.stringify(stayC));

    // The Ctrl+Shift+D report carries the read-only webgl segment. Capture the
    // clipboard payload through the real perfCapture path (the sandbox never
    // touches the OS clipboard). Fail closed: when the clipboard shim or the
    // shortcut action is unavailable, perfCapture must not run at all.
    const reportTextC = await cdp.eval(`(async () => {
      window.__e2ePerfReport = null;
      const target = navigator.clipboard;
      if (!target) return null;
      const hadOwn = Object.prototype.hasOwnProperty.call(target, 'writeText');
      const original = target.writeText;
      try {
        Object.defineProperty(target, 'writeText', {
          configurable: true,
          value: text => { window.__e2ePerfReport = text; return Promise.resolve(); },
        });
      } catch (e) { return null; }
      try {
        if (typeof SHORTCUT_ACTIONS !== 'object' || typeof SHORTCUT_ACTIONS.perfCapture !== 'function') return null;
        SHORTCUT_ACTIONS.perfCapture();
        await new Promise(resolve => setTimeout(resolve, 4600));
        return window.__e2ePerfReport;
      } finally {
        try {
          if (hadOwn) Object.defineProperty(target, 'writeText', { configurable: true, value: original });
          else delete target.writeText;
        } catch (e) {}
      }
    })()`).catch(() => null);
    let webglReport = null;
    try { webglReport = reportTextC ? JSON.parse(reportTextC).webgl : null; } catch (e) {}
    const reportPane = webglReport?.panes?.[0] ?? null;
    const paneKeys = ['renderer', 'lossCount', 'lastLossAgoMs', 'reattachAttempts', 'reattachLimit',
      'lastResult', 'lastError', 'lastRetrySource', 'nextRetryDelayMs'];
    const reportPaneKeys = reportPane ? Object.keys(reportPane) : [];
    const reportShapeOk = reportPaneKeys.length === paneKeys.length
      && paneKeys.every(key => reportPaneKeys.includes(key));
    check('C：Ctrl+Shift+D 报告含只读 webgl 段（renderer/丢失/重挂/预算，仅元数据）',
      reportPane?.renderer === 'webgl' && reportPane?.lossCount >= 1 &&
      reportPane?.reattachLimit === 7 && webglReport?.budget === 8 && reportShapeOk,
      `report=${JSON.stringify(webglReport)}`);

    // Re-arm through a real user switch before the simultaneous-loss phase.
    await cdp.eval(`TabManager.switchTo(${JSON.stringify(tabB)}); TabManager.switchTo(${JSON.stringify(tabA)})`);
    const healthyForD = await probeTab(cdp, tabA);
    check('D：健康复用重新武装恢复预算',
      healthyForD?.adapter === true && healthyForD?.liveContexts === 1 && healthyForD?.liveMark === healedC?.liveMark,
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

    // Capture ZTermReducedMotion.snapshot() BEFORE any E2E-driven refresh() so
    // Phase F still proves main.js startup itself acquired the native state
    // (rather than only observing state populated by Phase E's skip check).
    const startupReducedMotion = await readReducedMotionSnapshot(cdp);

    // ── Phase E: real vim typing echo vs same-character navigation (issue #31) ──
    // On the alternate buffer the block caret's slide classification must
    // follow WRITE EVIDENCE, not the printable-input window: a keystroke that
    // echoes text (vim insert mode) slides as a plain rectangle (the trailing
    // caret may cover the just-typed characters but must not flash them
    // inverted), while a printable navigation key (`l`) that only moves the
    // caret keeps the scissored glyph inversion — even though `l` is a
    // printable byte typed right after the echo. Everything runs through the
    // real app input path in the seeded local tab: the owned local PowerShell
    // starts the Git Bash discovered via get-local-shells (HOME pointing into
    // the sandbox so no user config is touched), bash runs --noprofile
    // --norc, and vim runs -u NONE -i NONE -n.
    const phaseEMotion = await readNativeReducedMotion(cdp);
    const phaseESkip = classifyAnimationPhaseSkip(phaseEMotion);
    if (phaseESkip.skip) {
      skip('E: nvim/WebGL animation evidence (issue #31)', phaseESkip.reason);
    } else {
      const phaseE = { vimRunning: false, bashRunning: false, focusPinned: false, previousStyle: null };
      try {
        const shells = await cdp.eval(`(async () => (await ipcRenderer.invoke('get-local-shells')) || [])()`);
        const gitBash = shells.find(s => s?.id === 'gitbash' && typeof s.command === 'string');
        if (!gitBash) throw new Error('Phase E found no Git Bash through get-local-shells: ' + JSON.stringify(shells.map(s => s?.id)));
        // MSYS layout: <root>\bin\bash.exe ships vim at <root>\usr\bin\vim.exe.
        const msysVim = resolve(dirname(gitBash.command), '..', 'usr', 'bin', 'vim.exe');
        if (!existsSync(msysVim)) throw new Error(`Phase E found no MSYS vim next to ${gitBash.command}`);
        const vimHome = join(sandbox.directory, 'phase-e-vim-home');
        const psLiteral = value => {
          if (typeof value !== 'string' || value.includes("'")) throw new Error(`Phase E cannot quote a path for PowerShell: ${value}`);
          return value;
        };
        mkdirSync(vimHome, { recursive: true });

        // Start bash from the OWNED local PowerShell through the real input
        // path. Interactive mode provides the readiness prompt without reading
        // profiles; clear inherited shell prompt/rc variables (e.g. a Git Bash
        // parent's PS1 referencing __git_ps1) so bash emits its built-in
        // `bash-<ver>$` prompt deterministically; TERM=xterm keeps vim on the
        // alternate buffer with full cursor control even though the seeded PTY
        // environment sets no TERM.
        await phaseESendKeys(cdp, tabA, `$env:PS1=$null; $env:PROMPT_COMMAND=$null; $env:MSYS2_PS1=$null; $env:BASH_ENV=$null; $env:ENV=$null; $env:HOME='${psLiteral(vimHome)}'; $env:TERM='xterm'; & '${psLiteral(gitBash.command)}' --noprofile --norc -i\r`);
        const bashPrompt = await phaseEPoll(cdp, phaseEScreenExpr(tabA), phaseEBashPromptSeen, 20000);
        phaseE.bashRunning = bashPrompt.done;
        check('E: MSYS bash started from the owned PowerShell (Git Bash via get-local-shells, HOME inside the sandbox)',
          bashPrompt.done === true,
          `bash=${gitBash.command} vim=${msysVim} HOME=${vimHome} lastRows=${JSON.stringify((bashPrompt.value?.rows || []).filter(Boolean).slice(-2))}`);

        // The alternate buffer is vim's UI-ready marker; keys sent after it are
        // queued by the PTY and processed in order, so the staging below is
        // deterministic without scraping the modeline (compatible-mode vim
        // shows no -- INSERT -- marker; staging is proven from buffer cells).
        await phaseESendKeys(cdp, tabA, '/usr/bin/vim -u NONE -i NONE -n\r');
        const vimUp = await phaseEPoll(cdp, phaseEScreenExpr(tabA), v => v?.type === 'alternate', 20000);
        phaseE.vimRunning = vimUp.done;
        check('E: vim -u NONE -i NONE -n took over the alternate buffer', vimUp.done === true, JSON.stringify(vimUp.value));
        if (!bashPrompt.done || !vimUp.done) throw new Error('Phase E could not stage bash+vim in the owned local tab');
        await sleep(400);

        // The background desktop host never receives OS focus, so the focused
        // bit is pinned on the REAL terminal's browser service the same way
        // scripts/e2e-webgl-atlas.mjs documents it (synthetic service focus —
        // not an OS focus or IME test), and the caret is forced to the block
        // style the echo classification is defined for. Both are undone in the
        // phase cleanup.
        const armedE = await cdp.eval(`(() => {
          const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
          if (!tab || !tab.term || !tab._smoothCursor?._adapter) return { ok: false };
          const adapter = tab._smoothCursor._adapter;
          const previousStyle = tab.term.options.cursorStyle;
          adapter.setCursorStyle('block');
          tab.term.textarea?.focus();
          const svc = tab.term._core?._coreBrowserService;
          const docFocused = document.hasFocus();
          let pinned = false;
          if (svc && svc.isFocused !== true) {
            Object.defineProperty(svc, 'isFocused', { configurable: true, get: () => true });
            pinned = true;
          }
          return { ok: true, previousStyle, docFocused, pinned, serviceFocused: svc?.isFocused === true };
        })()`);
        if (armedE?.ok !== true) throw new Error('Phase E could not arm the block caret: ' + JSON.stringify(armedE));
        phaseE.focusPinned = armedE.pinned === true;
        phaseE.previousStyle = armedE.previousStyle || null;
        const preE = await phaseEReadSnapshot(cdp, tabA);
        check('E: block caret armed on the WebGL adapter (smooth on, reduced motion off, DPR recorded)',
          preE?.bufferType === 'alternate' && preE?.adapter === true && preE?.rendererIsWebgl === true
            && preE?.cursorStyle === 'block' && preE?.smooth === true && preE?.reducedMotion === false,
          JSON.stringify({ state: preE, focus: armedE }));
        if (preE?.adapter !== true || preE?.rendererIsWebgl !== true || preE?.smooth !== true || preE?.reducedMotion !== false) {
          throw new Error('Phase E precondition failed: ' + JSON.stringify({ state: preE, focus: armedE }));
        }

        // Insert mode: vim is guaranteed to be in normal mode here (the first
        // key it receives after startup), and the PTY queues the rest in order.
        await phaseESendKeys(cdp, tabA, 'i');

        // Direct printable input 1: 'a'. The first animated frame must be the
        // plain echo slide, and the character must land at column 0 (insert at
        // the caret — if the staging ever fell back to normal-mode append, the
        // cell read exposes it instead of misreporting a regression).
        const beforeA = await phaseEReadSnapshot(cdp, tabA);
        const frameA = await phaseECaptureFirstFrame(cdp, tabA, 'a');
        if (frameA.ok === true) await phaseESaveShot(cdp, 'webgl-recovery-phase-e-typing-echo.png');
        await phaseEReleaseFrame(cdp, tabA);
        const echoA = await phaseEPoll(cdp, phaseEScreenExpr(tabA), v => v?.type === 'alternate' && v?.cursorX === 1, 6000);
        const typedA = await cdp.eval(phaseETypedLineExpr(tabA)).catch(() => null);
        check('E: typed \'a\' echoes — first animated frame is base+rectangle and echoSlides increments',
          frameA.ok === true && frameA.snapshot?.bufferType === 'alternate'
            && frameA.snapshot?.drawPassStatus === 'base+rectangle'
            && frameA.snapshot?.echoSlides === beforeA.echoSlides + 1
            && frameA.snapshot?.capture?.records?.length === 1
            && frameA.snapshot?.capture?.records?.[0]?.visual?.x < frameA.snapshot?.capture?.records?.[0]?.target?.x
            && echoA.done === true && typedA === 'a',
          `before=${beforeA.echoSlides} cursor=${JSON.stringify(echoA.value && { x: echoA.value.cursorX })} typed=${JSON.stringify(typedA)} frame=${JSON.stringify(frameA.snapshot ?? frameA)}`);
        if (frameA.ok !== true || typedA !== 'a') throw new Error('Phase E typing staging failed: ' + JSON.stringify({ frame: frameA, typed: typedA }));

        // Direct printable input 2: 'f'.
        const beforeF = await phaseEReadSnapshot(cdp, tabA);
        const frameF = await phaseECaptureFirstFrame(cdp, tabA, 'f');
        await phaseEReleaseFrame(cdp, tabA);
        check('E: typed \'f\' echoes — first animated frame is base+rectangle and echoSlides increments',
          frameF.ok === true && frameF.snapshot?.bufferType === 'alternate'
            && frameF.snapshot?.drawPassStatus === 'base+rectangle'
            && frameF.snapshot?.echoSlides === beforeF.echoSlides + 1
            && frameF.snapshot?.capture?.records?.length === 1
            && frameF.snapshot?.capture?.records?.[0]?.visual?.x < frameF.snapshot?.capture?.records?.[0]?.target?.x,
          `before=${beforeF.echoSlides} frame=${JSON.stringify(frameF.snapshot ?? frameF)}`);

        // Burst: both characters in ONE input event — a single noteInput call
        // with the window warm, pinning the plain classification of a burst's
        // leading frame plus the final caret column of the echoed text.
        const beforeBurst = await phaseEReadSnapshot(cdp, tabA);
        const frameBurst = await phaseECaptureFirstFrame(cdp, tabA, 'fa');
        await phaseEReleaseFrame(cdp, tabA);
        const echoBurst = await phaseEPoll(cdp, phaseEScreenExpr(tabA), v => v?.type === 'alternate' && v?.cursorX === 4, 6000);
        const typedBurst = await cdp.eval(phaseETypedLineExpr(tabA)).catch(() => null);
        check('E: typed burst \'fa\' — first animated frame stays base+rectangle and \'affa\' lands with the caret at column 4',
          frameBurst.ok === true && frameBurst.snapshot?.drawPassStatus === 'base+rectangle'
            && frameBurst.snapshot?.echoSlides > beforeBurst.echoSlides
            && frameBurst.snapshot?.capture?.records?.[0]?.target?.x - frameBurst.snapshot?.capture?.records?.[0]?.visual?.x > 1
            && echoBurst.done === true && typedBurst === 'affa',
          `before=${beforeBurst.echoSlides} typed=${JSON.stringify(typedBurst)} cursor=${JSON.stringify(echoBurst.value && { x: echoBurst.value.cursorX })} frame=${JSON.stringify(frameBurst.snapshot ?? frameBurst)}`);
        if (typedBurst !== 'affa') throw new Error('Phase E navigation staging failed (typed=' + JSON.stringify(typedBurst) + ')');

        // Navigation staging: Esc is non-printable input — the real path clears
        // the echo credits and write evidence — then `hh` walks the caret onto
        // the FIRST of the two adjacent 'f' cells just typed. `l` then slides
        // f→f: a printable byte, typed right after the echo, whose vacated cell
        // was NOT written — the exact misclassification risk of issue #31.
        await phaseESendKeys(cdp, tabA, '\x1b');
        const normalMode = await phaseEPoll(cdp, phaseEScreenExpr(tabA),
          v => v?.type === 'alternate' && v?.cursorX === 3, 8000);
        await phaseESendKeys(cdp, tabA, 'hh');
        const onF = await phaseEPoll(cdp, phaseEScreenExpr(tabA),
          v => v?.type === 'alternate' && v?.cursorX === 1, 8000);
        const beforeNav = await phaseEReadSnapshot(cdp, tabA);
        const frameNav = await phaseECaptureFirstFrame(cdp, tabA, 'l');
        if (frameNav.ok === true) await phaseESaveShot(cdp, 'webgl-recovery-phase-e-navigation-glyph.png');
        await phaseEReleaseFrame(cdp, tabA);
        const navLanded = await phaseEPoll(cdp, phaseEScreenExpr(tabA),
          v => v?.type === 'alternate' && v?.cursorX === 2, 6000);
        check('E: navigation \'l\' onto the existing \'f\' — first moving frame stays base+rectangle+glyph and echoSlides does not increment',
          normalMode.done === true && onF.done === true
            && frameNav.ok === true && frameNav.snapshot?.bufferType === 'alternate'
            && frameNav.snapshot?.drawPassStatus === 'base+rectangle+glyph'
            && frameNav.snapshot?.echoSlides === beforeNav.echoSlides
            && frameNav.snapshot?.capture?.records?.length === 1
            && frameNav.snapshot?.capture?.records?.[0]?.visual?.x < frameNav.snapshot?.capture?.records?.[0]?.target?.x
            && navLanded.done === true,
          `staging=${JSON.stringify({ esc: normalMode.done, onF: onF.done, typed: typedBurst })} before=${beforeNav.echoSlides} cursor=${JSON.stringify(navLanded.value && { x: navLanded.value.cursorX })} frame=${JSON.stringify(frameNav.snapshot ?? frameNav)}`);

        // Clean exit through the same real input path: :q! drops vim back into
        // bash, `exit` drops bash back into the owned PowerShell prompt. The
        // PowerShell prompt as the LAST screen row proves both children exited.
        await phaseECancelCapture(cdp, tabA).catch(() => null);
        await phaseESendKeys(cdp, tabA, '\x1b:q!\r');
        const vimQuit = await phaseEPoll(cdp, phaseEScreenExpr(tabA), v => v?.type === 'normal', 8000);
        phaseE.vimRunning = !vimQuit.done;
        let psBack = { done: false, value: null };
        if (vimQuit.done) {
          await phaseESendKeys(cdp, tabA, 'exit\r');
          psBack = await phaseEPoll(cdp, phaseEScreenExpr(tabA), phaseEPsPromptSeen, 8000);
          phaseE.bashRunning = !psBack.done;
        }
        check('E: vim and bash exited cleanly and the PowerShell prompt returned',
          vimQuit.done === true && psBack.done === true,
          `vimQuit=${vimQuit.done} lastRows=${JSON.stringify((psBack.value?.rows || []).slice(-2))}`);
      } finally {
        // Guarded cleanup — never throws past the phase. A pending frame
        // capture must not outlive it (a held frame parks the animation), a
        // leftover vim/bash must not outlive the tab's PowerShell session, and
        // the focus/style pins must come off even when a check failed mid-run.
        try { await phaseECancelCapture(cdp, tabA); } catch (e) { console.error('[e2e] Phase E capture cleanup failed: ' + e.message); }
        if (phaseE.vimRunning) {
          try {
            await phaseESendKeys(cdp, tabA, '\x1b:q!\r');
            const quit = await phaseEPoll(cdp, phaseEScreenExpr(tabA), v => v?.type === 'normal', 6000);
            phaseE.vimRunning = !quit.done;
          } catch (e) { console.error('[e2e] Phase E vim exit failed: ' + e.message); }
        }
        if (phaseE.bashRunning) {
          try {
            await phaseESendKeys(cdp, tabA, 'exit\r');
            const back = await phaseEPoll(cdp, phaseEScreenExpr(tabA), phaseEPsPromptSeen, 6000);
            phaseE.bashRunning = !back.done;
          } catch (e) { console.error('[e2e] Phase E bash exit failed: ' + e.message); }
        }
        if (phaseE.focusPinned) {
          try {
            await cdp.eval(`(() => {
              const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
              try { delete tab?.term?._core?._coreBrowserService?.isFocused; } catch (e) {}
              return true;
            })()`);
          } catch (e) { console.error('[e2e] Phase E focus unpin failed: ' + e.message); }
        }
        if (phaseE.previousStyle) {
          try {
            await cdp.eval(`(() => {
              const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
              try { tab?._smoothCursor?._adapter?.setCursorStyle?.(${JSON.stringify(phaseE.previousStyle)}); } catch (e) {}
              return true;
            })()`);
          } catch (e) { console.error('[e2e] Phase E cursor style restore failed: ' + e.message); }
        }
      }
    }

    // ── Phase F: native animation preference overrides frozen page reduced-motion ──
    // Emulates a WebView2 page stuck on prefers-reduced-motion: reduce (as
    // happens when ZTerm launches during a remote session and returns to the
    // local console). Verifies both that main.js startup ALREADY acquired the
    // authoritative native state (before any manual refresh) AND that an active
    // cursor draw pass under emulated reduce=true stays at 90ms.
    const phaseFMotion = await readNativeReducedMotion(cdp);
    const phaseFSkip = classifyAnimationPhaseSkip(phaseFMotion);
    if (phaseFSkip.skip) {
      skip('F: native animation preference override', phaseFSkip.reason);
    } else {
      let emulatedMediaSet = false;
      try {
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        emulatedMediaSet = true;
        const phaseF = await cdp.eval(`(async () => {
          const beforeRefresh = ZTermReducedMotion.snapshot();
          const tab = TabManager.tabs.find(t => t.id === ${JSON.stringify(tabA)});
          const adapter = tab?._smoothCursor?._adapter ?? null;
          const beforePasses = adapter?.snapshot?.()?.counters?.cursorDrawPasses ?? null;
          const refreshed = await ZTermReducedMotion.refresh();
          const svc = tab?.term?._core?._coreBrowserService;
          let pinned = false;
          if (svc && svc.isFocused !== true) {
            Object.defineProperty(svc, 'isFocused', { configurable: true, get: () => true });
            pinned = true;
          }
          try {
            tab?.term?.refresh?.(0, (tab?.term?.rows || 1) - 1);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const adapterSnap = adapter?.snapshot?.() ?? null;
            return {
              pageMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
              beforeRefresh,
              rm: refreshed,
              beforePasses,
              afterPasses: adapterSnap?.counters?.cursorDrawPasses ?? null,
              adapterReducedMotion: adapterSnap?.reducedMotion ?? null,
              motionDuration: adapterSnap?.motionDuration ?? null,
            };
          } finally {
            if (pinned) { try { delete svc.isFocused; } catch (e) {} }
          }
        })()`);
        // Host precondition: Phase F asserts the live native value, so it needs a
        // local console session with Windows "Animation effects" enabled. Report
        // a violated precondition as its own failing check so it is never
        // mistaken for a product regression.
        check('F: host precondition (local console, Windows animation effects on)',
          phaseF?.rm?.nativeAnimationsEnabled === true && phaseF?.rm?.remoteSession === false,
          `nativeAnimationsEnabled=${phaseF?.rm?.nativeAnimationsEnabled} remoteSession=${phaseF?.rm?.remoteSession}`);
        check('F: native SPI_GETCLIENTAREAANIMATION overrides page prefers-reduced-motion: reduce',
          phaseF?.pageMatches === true
            && startupReducedMotion?.source === 'native'
            && phaseF?.beforeRefresh?.source === 'native'
            && phaseF?.beforeRefresh?.nativeAnimationsEnabled === true
            && phaseF?.beforeRefresh?.pageReducedMotion === true
            && phaseF?.beforeRefresh?.reducedMotion === false
            && phaseF?.rm?.source === 'native'
            && phaseF?.rm?.nativeAnimationsEnabled === true
            && typeof phaseF?.rm?.remoteSession === 'boolean'
            && phaseF?.rm?.pageReducedMotion === true
            && phaseF?.rm?.reducedMotion === false
            && typeof phaseF?.beforePasses === 'number'
            && typeof phaseF?.afterPasses === 'number'
            && phaseF.afterPasses > phaseF.beforePasses
            && phaseF?.adapterReducedMotion === false
            && phaseF?.motionDuration === 90,
          JSON.stringify({ startupReducedMotion, ...(phaseF && typeof phaseF === 'object' ? phaseF : { phaseF }) }));
      } finally {
        if (emulatedMediaSet) {
          await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => null);
        }
      }
    }
  } finally {
    cdp.close();
    const stopped = await killExisting();
    if (stopped !== true) throw new Error(`Owned runtime cleanup failed: ${stopped.reasons.join('; ')}`);
  }

  if (backgroundFailure) throw backgroundFailure;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${formatSummaryLine(results.length - failed.length, results.length, skippedGroups)}`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

runSupervisedScript({
  script: fileURLToPath(import.meta.url), args: process.argv.slice(2),
  preflight: async () => {
    if (!existsSync(SOURCE_EXE)) throw new Error(`exe 不存在: ${SOURCE_EXE}`);
    await requireBackgroundCapability(SOURCE_EXE);
  },
  main: () => runWithDesktopRetry({
    main: () => main().catch(error => { throw backgroundFailure ?? error; }),
    cleanup: killExisting,
    respawn: () => respawnDesktopProcess({ script: fileURLToPath(import.meta.url), args: process.argv.slice(2) }),
  }),
}).then(code => process.exit(code));
