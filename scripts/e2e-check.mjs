#!/usr/bin/env node
// ZTerm E2E 检查：验证打包版前端的核心交互可用性。
//
// 背景：CSP 的 script-src 一旦被注入 hash（Tauri 自动行为），'unsafe-inline'
// 会被规范忽略，导致所有 inline onclick 静默失效（按钮 hover 正常、点击无反应、
// 无任何报错）。cargo test 与语法检查都抓不到这类问题，只能靠运行时验证。
//
// 用法：
//   node scripts/e2e-check.mjs [exe-path] [port]
//     exe-path  要验证的 zterm.exe 路径（默认 src-tauri/target/release/zterm.exe）
//     port      WebView2 远程调试端口（默认 9222）
//
// 退出码：全部通过为 0，任一失败为 1。
// 依赖：Node 22+（全局 fetch / WebSocket），无第三方包。

import { spawn, execSync, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { createE2eSandbox, ownsProcess, restartOwnedApp, killSandboxBrowsers, killPortHolder, sweepDebugPortRange } from './e2e-isolation.mjs';

const SOURCE_EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
let EXE = SOURCE_EXE;
const PORT = Number(process.argv[3] ?? 9222);
// Each launch gets its own debug port (and browser profile): a force-killed
// WebView2 can leave a zombie LISTEN socket whose owning PID no longer exists
// — nothing left to kill, only the kernel releases it — so reusing one port
// across restarts is a deterministic EADDRINUSE under load. Per-launch ports
// make restarts immune. BASE_PORT is resolved in main(): the launch range
// BASE..BASE+4 is swept first (stale listeners from PREVIOUS runs) and the
// base shifts by 10 while any port stays occupied.
let BASE_PORT = PORT;
let launchPort = PORT;
let sandbox = null;
let ownedChild = null;
let launchCount = 0;

// ── 启动 exe（带 WebView2 远程调试）──
let DATA_CONFIG = null;
let configBackup = null;
// null = unknown (backup never ran or failed) — restoreConfig must NEVER
// delete the live config in that state. This guard exists because a silent
// backup failure used to leave configBackup null while the config was real,
// and the else-branch below then DELETED the user's data.
let configExistedAtStart = null;

function backupConfig() {
  // E2E 创建的 tab/ssh profile 会被前端 15s 周期保存进 data/config.json，
  // 污染下次启动的标签恢复；启动前备份、结束时恢复。
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

// Only the exact process launched from this fresh sandbox may be terminated.
// Never use an image-name kill: even a failed preflight runs the exit hook.
function killExisting() {
  const child = ownedChild;
  // The port sweep is only safe once this run has actually launched an
  // instance: on a failed preflight (never launched) a foreign listener on
  // PORT is someone else's process and must not be killed.
  const sweepPort = () => { if (launchCount > 0) killPortHolder(launchPort); };
  if (!sandbox || !child?.pid || child.exitCode !== null) {
    ownedChild = null;
    // The host may be gone while its WebView2 browsers still hold the CDP
    // port — sweep them by sandbox path and by port or the restart below
    // collides.
    killSandboxBrowsers(sandbox?.directory);
    sweepPort();
    return true;
  }
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`], { encoding: 'utf8' }).trim();
    const actual = output ? JSON.parse(output) : null;
    if (!actual) { ownedChild = null; killSandboxBrowsers(sandbox.directory); sweepPort(); return true; }
    if (!ownsProcess(child, EXE, actual)) {
      console.error('[e2e] refusing cleanup: process ownership mismatch');
      return false;
    }
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killSandboxBrowsers(sandbox.directory);
    sweepPort();
    ownedChild = null;
    return true;
  } catch (error) {
    // taskkill can lose the race against a process that is already exiting;
    // confirm via WMI and only refuse the restart when the host provably
    // survives a second attempt.
    try {
      const alive = () => {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' }).trim();
        return !!out;
      };
      if (alive()) {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* fall through */ }
      }
      if (alive()) {
        console.error('[e2e] owned process cleanup failed:', error.message);
        return false;
      }
      killSandboxBrowsers(sandbox.directory);
      sweepPort();
      ownedChild = null;
      return true;
    } catch (inner) {
      console.error('[e2e] owned process cleanup failed:', inner.message);
      return false;
    }
  }
}
// Safety net for exit paths that skip the explicit killExisting() calls
// (unexpected early throw, unhandled rejection): never leave a PTY tree behind.
process.on('exit', () => killExisting());

function startApp() {
  if (ownedChild) throw new Error('Previous owned process has not been released');
  // Fresh, unique browser profile per launch: WebView2 browser processes on
  // this machine can outlive their host for a long while, and a relaunch
  // onto the same profile attaches to the half-dead browser — the debug
  // port then never opens (30s+ hangs). A never-used profile has no stale
  // browser to attach to.
  const udf = join(sandbox.directory, `webview-${++launchCount}`);
  launchPort = BASE_PORT + launchCount - 1;
  const child = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      APPDATA: sandbox.appData,
      LOCALAPPDATA: sandbox.appData,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${launchPort}`,
      WEBVIEW2_USER_DATA_FOLDER: udf,
    },
  });
  ownedChild = child;
  child.on('error', error => console.error('[e2e] isolated launch failed:', error.message));
  child.unref();
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${launchPort}/json`);
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find((p) => p.type === 'page' && p.url.includes('renderer.html'));
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  // 诊断：进程与调试端口状态，帮助区分"exe 未启动"与"WebView2 不可用"
  let procInfo = '(不可用)';
  try { procInfo = execSync('tasklist /FI "IMAGENAME eq zterm.exe" /FO CSV /NH', { encoding: 'utf8' }).trim() || '(无 zterm 进程)'; } catch {}
  let portInfo = '(不可用)';
  try { const r = await fetch(`http://127.0.0.1:${launchPort}/json/version`); portInfo = r.ok ? '调试端口已开放' : `HTTP ${r.status}`; } catch { portInfo = '调试端口未开放'; }
  // Target list: distinguishes "port served by a stale browser" (empty or
  // foreign targets) from "app alive but renderer stuck" (targets present,
  // renderer.html missing).
  let targetsInfo = '(不可用)';
  try {
    const r = await fetch(`http://127.0.0.1:${launchPort}/json`);
    const list = await r.json();
    targetsInfo = list.length ? list.map(t => `${t.type}:${String(t.url).slice(0, 90)}`).join(' | ') : '(空目标列表)';
  } catch { targetsInfo = '(目标列表获取失败)'; }
  throw new Error(`页面在 ${timeoutMs}ms 内未就绪。进程: ${procInfo}; ${portInfo}; 目标: ${targetsInfo}`);
}

// ── CDP 会话 ──
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = d.exception?.description || d.text || 'unknown';
      throw new Error(`JS 异常: ${String(desc).split('\n').slice(0, 3).join(' | ')}`);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ── 检查项 ──
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitForValue(cdp, expression, expected, timeoutMs = 8000, mode = 'eq') {
  // 轮询等待表达式达到期望值（分屏等异步操作在慢机上需要时间，固定 sleep 会假失败）。
  // mode='gt0'：等待数值 > 0（SSH 失败事件这类只增计数——串行连接队列里排在
  // 恢复 tab 的重连退避后面时，事件可能十几秒后才出现）。
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
  // The launch range BASE..BASE+4 must be fully free: sweep stale holders
  // from previous runs (image-verified msedgewebview2/zterm only), and shift
  // the base by 10 while anything remains (foreign listener or an unkillable
  // dead-PID zombie socket — final run: launch 3 hit a stale port that served
  // /json yet never listed the renderer page).
  for (let shift = 0; ; shift += 10) {
    const occupied = sweepDebugPortRange(PORT + shift, 5);
    if (occupied.length === 0) { BASE_PORT = PORT + shift; launchPort = BASE_PORT; break; }
    if (shift >= 20) throw new Error(`调试端口段均被占用（${occupied.join(', ')}），无法启动 E2E`);
  }
  await assertUnusedPort(BASE_PORT);
  sandbox = createE2eSandbox(SOURCE_EXE);
  EXE = sandbox.exe;
  DATA_CONFIG = join(sandbox.directory, 'data', 'config.json');
  console.log(`E2E source: ${SOURCE_EXE}\nIsolated runtime: ${sandbox.directory}\n`);

  killExisting();
  backupConfig();
  startApp();
  const wsUrl = await waitForPage();
  const cdp = new Cdp(wsUrl);
  await cdp.connect();

  try {
    // 等页面完全加载（CDP 页面一出现即可连，但此时网络栈可能未就绪，
    // 立即 fetch 自身会 Failed to fetch——先等 readyState=complete 再开始检查）。
    // WebView2 启动期间页面会 reload 一次：complete 状态下旧文档仍在时
    // renderer/*.js 尚未执行，_settingsConfig 未定义——以 settings 就绪
    // （loadSettings 已跑）作为"脚本已执行"的硬标志，防止 eval 打在旧文档上。
    await waitForValue(cdp, `document.readyState === 'complete' && typeof _settingsConfig === 'object' && !!TabManager`, true, 20000);
    const runtimeData = await cdp.eval(`ipcRenderer.invoke('get-data-dir-info')`);
    if (resolve(runtimeData.current).toLowerCase() !== resolve(dirname(DATA_CONFIG)).toLowerCase()) {
      throw new Error('Connected runtime is not using the isolated E2E configuration');
    }

    // 0. 启动界面：结构正确（只显示图标 + 绿点动画）+ 首帧渲染后自动淡出（最多等 5s）；兜底主动隐藏防遮挡后续检查
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
    // 只验静态结构（动画运行有独立的轮询检查；startSplashLoader 在 async Init 中启动，可能晚于此检查）
    const structOk = splashStruct.missing === true || (splashStruct.cells === 13 &&
      !splashStruct.hasName && !splashStruct.hasHint && splashStruct.hasLogo);
    check('启动界面结构：仅图标 + 13 格 Z', structOk === true, JSON.stringify(splashStruct));
    // 动画验证：splash 存在时轮询绿点出现（startSplashLoader 在 async Init 中启动，
    // 可能晚于结构检查）；splash 已被移除同样视为通过
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

    // 1. CSP：'unsafe-inline' 必须真正生效（未被 Tauri 注入的 hash 挤掉）
    // fetch 自身在页面刚就绪时偶发失败，重试几次
    let csp = null;
    for (let i = 0; i < 5 && csp === null; i++) {
      try { csp = await cdp.eval(`fetch(location.href, {cache:'no-store'}).then(r => r.headers.get('content-security-policy'))`); }
      catch { await sleep(500); }
    }
    const hasUnsafeInline = /script-src[^;]*'unsafe-inline'/.test(csp ?? '');
    const hasHash = /script-src[^;]*'sha256-/.test(csp ?? '');
    check('CSP script-src 含生效的 unsafe-inline', hasUnsafeInline && !hasHash, (csp ?? '').slice(0, 80) + '...');

    // 2. inline onclick 编译成功（CSP 拦截时这里会是 undefined/null）
    for (const id of ['win-minimize', 'win-maximize', 'win-close']) {
      const t = await cdp.eval(`typeof document.getElementById('${id}').onclick`);
      check(`按钮 #${id} onclick 已编译`, t === 'function', `typeof=${t}`);
    }
    const menuOnclick = await cdp.eval(`typeof document.querySelector('.menu-item').onclick`);
    check('菜单项 onclick 已编译', menuOnclick === 'function', `typeof=${menuOnclick}`);

    // 3. 核心交互函数可用（顶层全局函数链完整）
    const fns = await cdp.eval(`['openPalette','openSettings','openSFTPFromMenu','TabManager'].map(n => n + '=' + typeof (n==='TabManager' ? TabManager : eval(n))).join(', ')`);
    check('核心交互函数存在', fns.includes('openPalette=function') && fns.includes('openSettings=function') && fns.includes('TabManager=object'), fns);

    // 4. 最小化按钮：合成点击 → 窗口真正最小化
    await cdp.eval(`document.getElementById('win-minimize').click()`);
    // Poll instead of a fixed sleep: on a loaded machine the minimize
    // transition outlasts 1.5s and a single query fails spuriously.
    const minimized = await waitForValue(cdp, `window.__TAURI__.window.getCurrentWindow().isMinimized().then(r => r)`, true, 8000);
    check('点击最小化后窗口最小化', minimized === true, `isMinimized=${minimized}`);

    // 恢复窗口：优先 CDP 直接操作（避免 Tauri ACL 限制 unminimize）
    let restored = false;
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      restored = true;
    } catch {}
    if (!restored) {
      // 备选：Windows 对最小化窗口执行最大化会先恢复再最大化
      await cdp.eval(`document.getElementById('win-maximize').click()`);
      await sleep(1500);
    }
    await sleep(1000);

    // 5. 最大化按钮：点击 → 最大化（CDP 恢复成功则从 normal 状态点；否则窗口已随备选恢复并最大化）
    if (restored) {
      await cdp.eval(`document.getElementById('win-maximize').click()`);
      await sleep(1500);
    }
    const maximizedNow = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    check('点击最大化后窗口最大化', maximizedNow === true, `isMaximized=${maximizedNow}`);
    await cdp.eval(`document.getElementById('win-maximize').click()`);
    await sleep(1500);
    const isRestored = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    check('再次点击后还原', isRestored === false, `isMaximized=${isRestored}`);

    // 6. 菜单项点击：命令面板 overlay 打开
    await cdp.eval(`document.querySelector('.menu-item[onclick*="openPalette"]')?.click()`);
    await sleep(800);
    const paletteOpen = await cdp.eval(`document.getElementById('overlay-palette').classList.contains('open')`);
    check('菜单点击打开命令面板', paletteOpen === true, `overlay-palette.open=${paletteOpen}`);
    await cdp.eval(`closePalette()`);
    await sleep(300);

    // 7. IPC 链路：窗口命令真实可达（回调式验证，避免只测点击）
    const ipcOk = await cdp.eval(`window.__TAURI__.core.invoke('window_maximize').then(() => 'ok').catch(e => 'err: ' + e)`);
    check('IPC invoke window_maximize 可达', ipcOk === 'ok', String(ipcOk));
    await cdp.eval(`document.getElementById('win-maximize').click()`); // 还原
    await sleep(1000);

    // 8. 标签页：新增 tab
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

    // 9. 分屏：水平分割 → 2 个 pane；再垂直分割 → 3 个 pane（轮询等待，防 pty 未 attach 假失败）
    await cdp.eval(`TabManager.splitHorizontal()`);
    const panesAfterH = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 2);
    check('水平分割产生 2 个 pane', panesAfterH === 2, `panes=${panesAfterH}`);
    await cdp.eval(`TabManager.splitVertical()`);
    const panesAfterV = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 3);
    check('垂直分割产生 3 个 pane', panesAfterV === 3, `panes=${panesAfterV}`);

    // 9.5 本地 PTY 数据全链路：pty-input → ConPTY 回显 → 4ms flusher →
    //     pty-output → xterm buffer。Rust flusher 回归（不 emit/死锁）时回显丢失，
    //     这条会假死——它是本地 tab 内容唯一的自动化失败信号。
    //     注入层用 pty-input 而非合成 KeyboardEvent：xterm 5 对合成 keydown
    //     大面积丢字（实测 echo 后仅个别字符产生 onData），键盘→onData 半截
    //     属于 xterm 自身代码，由 Ghostty 输入链路检查另行覆盖。
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
    // 平滑光标 adapter 真实挂载断言：bind 失败只 console.warn，旧检查（overlay DOM
    // count===0）对 adapter 恒真，无法区分"动画在跑"和"静默降级到原生光标"。
    check('WebGL 平滑光标 adapter 已挂载', chainProbe.ok === true && chainProbe.hasAdapter === true, JSON.stringify(chainProbe));

    // 月相/plane-1 emoji 宽度：zterm6 provider 必须已激活且把 plane-1 emoji
    // 计为 2 格（kimi tip 行实测 U+1F311 按 2 格布局；vendored UnicodeV6 算
    // 1，导致 2 格字形溢出到从不擦除的邻格、旧字符叠进月亮——现场截图）。
    // term.write 走同一个 InputHandler->charProperties 路径，钉住 buffer 布局。
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

    // IME 锚点：协议光标可见时原生跟随；隐藏且无软件光标时回退原生协议锚定
    //（现场探针实证：输入阶段协议光标精确跟随插入点——冻结策略会把锚点钉在
    // textarea 的 DOM 默认位或刚被覆盖的旧 caret 格，候选窗卡左上/拼音覆盖
    // 已提交内容）；隐藏且软件光标（用户实际看到的 app 自绘 caret）位置已知
    // 时，锚点必须落在软件光标格——kimi 整段会话不显示协议光标，无 caret 时
    // 回退原生是最坏基线。该检查同时钉住 patch 的内部锚点
    //（_core/_syncTextArea/isCursorHidden）存在。
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
      // 软件光标分支：临时把 provider 换成固定格（模拟 adapter 已接管），
      // 隐藏 CUP 到别处，textarea 必须锚在软件光标格而非协议 park 位。
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

    // 10. 设置页：打开 → settings tab 出现；页面切换
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

    // 11. SSH 失败路径：连接立即拒绝的地址 → ssh-error 事件被处理、前端不崩溃
    // 用 Tauri event API 直接计数 ssh-error（不依赖 UI 临时状态如 toast，更稳定）
    await cdp.eval(`window.__sshErrCount = 0; window.__TAURI__.event.listen('ssh-error', () => { window.__sshErrCount = (window.__sshErrCount || 0) + 1; })`);
    await cdp.eval(`
      (() => {
        const existing = TabManager.tabs.find(t => t.type === 'ssh');
        if (existing) TabManager.closeTab(existing.id);
        TabManager.sshProfiles = TabManager.sshProfiles || [];
        TabManager.sshProfiles.push({
          id: 'e2e-fail', name: 'E2E Fail', type: 'ssh', host: '127.0.0.1', port: 1,
          username: 'e2e', password: '', encryptedPassword: '', privateKeyPath: '',
        });
        connectSSHProfile('e2e-fail');
        return true;
      })()
    `);
    const sshErrCount = await waitForValue(cdp, `window.__sshErrCount`, (v) => v > 0, 40000, 'gt0');
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

    // 11b. 快捷命令“末尾回车自动执行”开关：UI 存在、toggle 生效、注入语义正确
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
    // 注入语义：关闭时剥末尾回车，开启时保留
    const stripOff = await cdp.eval(`_settingsConfig.qcAutoEnter = false; stripTrailingNewline('echo hi\\n')`);
    const stripOn = await cdp.eval(`_settingsConfig.qcAutoEnter = true; 'echo hi\\n'`);
    check('注入语义：关剥开保', stripOff === 'echo hi' && stripOn === 'echo hi\n', JSON.stringify({ stripOff, stripOn }));
    // 恢复默认（关闭）并关闭设置页
    await cdp.eval(`_settingsConfig.qcAutoEnter = false; document.getElementById('qc-auto-enter').classList.remove('on'); closeSettingsTab()`);
    await sleep(600);

    // 11c. 字体：枚举无 @ 竖排变体；界面字体设置项存在且应用生效
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
    // 界面字体跟随开关：默认开 → 界面字体行隐藏
    const followDefault = await cdp.eval(`document.getElementById('toggle-ui-follow').classList.contains('on')`);
    const uiRowHidden = await cdp.eval(`document.getElementById('row-ui-font').style.display === 'none'`);
    const fontBefore = await cdp.eval(`document.body.style.fontFamily || '(css默认)'`);
    check('界面字体跟随开关默认开且隐藏设置行', followDefault === true && uiRowHidden === true, `follow=${followDefault}, rowHidden=${uiRowHidden}`);
    // 跟随模式下 body 应用终端字体组合
    const followApplied = await cdp.eval(`document.body.style.fontFamily.includes('monospace') || document.body.style.fontFamily.includes('JetBrains') || document.body.style.fontFamily.includes('Consolas') || getComputedStyle(document.body).fontFamily.includes('JetBrains') || getComputedStyle(document.body).fontFamily.includes('monospace')`);
    check('跟随模式下界面使用终端字体', followApplied === true, `body=${fontBefore.slice(0, 60)}`);
    // 关闭跟随 → 界面字体行显示 → 选界面字体应用
    await cdp.eval(`toggleUiFollowTerminal()`);
    await sleep(500);
    const uiRowShown = await cdp.eval(`document.getElementById('row-ui-font').style.display !== 'none'`);
    check('关闭跟随后面临字体行显示', uiRowShown === true, `rowShown=${uiRowShown}`);
    const setResult = await cdp.eval(`document.getElementById('set-ui-font').value = "'Consolas',sans-serif"; saveAppearance(); document.body.style.fontFamily`);
    check('界面字体选择应用生效', setResult.includes('Consolas'), `after=${setResult.slice(0, 60)}`);
    // 输入框跟随界面字体：强调色输入框/快捷命令命令框的计算字体应含界面字体
    const accentFont = await cdp.eval(`getComputedStyle(document.getElementById('set-accent')).fontFamily`);
    const qcFont = await cdp.eval(`getComputedStyle(document.getElementById('qc-edit-command')).fontFamily`);
    check('输入框跟随界面字体', accentFont.includes('Consolas') && qcFont.includes('Consolas'),
      `accent=${accentFont.slice(0, 40)}, qc=${qcFont.slice(0, 40)}`);
    // 自定义下拉列表字体跟随界面字体（dd-option 曾硬编码 Segoe UI 不随界面字体）
    const ddOptionFont = await cdp.eval(`(() => {
      const el = document.querySelector('.cust-dropdown .dd-option');
      return el ? getComputedStyle(el).fontFamily : '(无 dd-option)';
    })()`);
    check('自定义下拉列表字体跟随界面字体', ddOptionFont.includes('Consolas'), `dd-option=${ddOptionFont.slice(0, 50)}`);
    // 按钮跟随界面字体（btn-primary 等曾硬编码 Segoe UI）
    const btnFont = await cdp.eval(`(() => {
      const el = document.querySelector('.btn-primary');
      return el ? getComputedStyle(el).fontFamily : '(无 .btn-primary)';
    })()`);
    check('按钮字体跟随界面字体', btnFont.includes('Consolas'), `btn=${btnFont.slice(0, 50)}`);
    // 恢复默认（跟随开）
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
      wrapper: !!document.querySelector('#set-font')?.parentNode?.querySelector('.cust-dropdown')
    })`).catch(() => null);
    check('设置页字体列表缓存：二次打开不重复枚举', !!fontCacheProbe && fontCacheProbe.calls === 1 && fontCacheProbe.options > 0 && fontCacheProbe.wrapper === true, JSON.stringify(fontCacheProbe));
    const convGuard = await cdp.eval(`(() => {
      const sel = document.getElementById('set-font');
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

    // 12. SFTP 面板：打开 → 面板可见 → 关闭
    await cdp.eval(`SFTP.open('e2e-dummy-tab')`);
    await sleep(800);
    const sftpOpen = await cdp.eval(`document.getElementById('overlay-sftp').classList.contains('open')`);
    const sftpBreadcrumb = await cdp.eval(`document.getElementById('sftp-breadcrumb')?.textContent`);
    check('SFTP 面板打开', sftpOpen === true, `overlay-sftp.open=${sftpOpen}, breadcrumb=${sftpBreadcrumb}`);
    await cdp.eval(`SFTP.close()`);
    await sleep(500);
    const sftpClosed = await cdp.eval(`!document.getElementById('overlay-sftp').classList.contains('open')`);
    check('SFTP 面板关闭', sftpClosed === true, `overlay-sftp.open=${!sftpClosed}`);

    // 13.5 xterm 键盘→onData 链路（attachCustomKeyEventHandler 语义防回归：
    // 放行逻辑返回值写反会吞掉所有按键）。合成小写字母 keydown 在 xterm 5 上可靠
    // （大写/符号大面积丢字，勿扩展字符集）；PTY→回显→buffer 由 9.5 覆盖。
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

    // 13.6 About-page update card state machine (mocked IPC: no real
    // download, no real exit). Covers the full flow 新版发现 → 下载更新 →
    // 就绪 → 重启并安装, plus the SSH-blocker confirm dialog (open / cancel /
    // button-label restore).
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
    // (mock holds ready back for ~4 ticks): sample until 下载中 50% appears.
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
    // 无阻断：直接 apply，不弹确认框
    await cdp.eval(`applyUpdate(); 'applying'`);
    await sleep(400);
    const updApplied = await cdp.eval(`({ n: window.__e2eApplied, overlayOpen: document.getElementById('overlay-confirm').classList.contains('open') })`);
    check('更新卡片：无 SSH/SFTP 阻断直接安装', updApplied.n === 1 && updApplied.overlayOpen === false, JSON.stringify(updApplied));
    // 有阻断（临时伪 SSH tab）：弹确认框；取消后恢复按钮默认文案
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

    // 13.7 SSH manager + session selector (design/ssh-session-ui-design.md).
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
    // take), was a toast shown. (final8 failed opaque: saved=false after 4s
    // while the isolated probe passes 3/3 with 4-8ms encrypt.)
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
    // Edit-existing regression: status row → 修改 → input → blur cancels back.
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
      // that (observed once in the field: backToView=false with everything
      // else green). Focus explicitly, record whether the auto-focus worked,
      // then poll the cancel-back briefly instead of reading synchronously.
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
        pwdRowHidden: document.getElementById('ssh-pwd-row').style.display === 'none'
      };
      closeOverlay('overlay-ssh-edit');
      return r2;
    })()`).catch(() => null);
    check('模板选择：管理浮层入口+键盘导航 Enter 选中（" 副本"后缀/keypath 携带/密码行隐藏）', !!tplKeyProbe &&
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

    // 13.8 Terminal link opening (ADR-0003): plain links reach the open-url
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
          const line = buf.getLine(y)?.translateToString(true) || '';
          const col = line.indexOf(needle);
          if (col < 0) continue;
          const row = y - buf.viewportY;
          if (row < 0 || row >= term.rows) continue;
          const screen = term.element.querySelector('.xterm-screen');
          const r = screen.getBoundingClientRect();
          return { screen, row, col, r,
            px: r.left + (col + 0.5) * (r.width / term.cols),
            py: r.top + (row + 0.5) * (r.height / term.rows) };
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
            res({ at: 'hover@' + p.row + ':' + p.col, shown: !!tip && tip.classList.contains('show'), text: tip ? tip.textContent : '' });
          }, 250);
        }, 60));
      };
      window.__linkClick = (needle, ctrl) => {
        const p = locate(needle);
        if (!p) return Promise.resolve('not-found');
        const opts = { bubbles: true, cancelable: true, button: 0, ctrlKey: !!ctrl, clientX: p.px, clientY: p.py };
        p.screen.dispatchEvent(new MouseEvent('mousemove', opts));
        return new Promise(res => setTimeout(() => {
          p.screen.dispatchEvent(new MouseEvent('mousedown', opts));
          p.screen.dispatchEvent(new MouseEvent('mouseup', opts));
          res('click@' + p.row + ':' + p.col);
        }, 200));
      };
      const tab = TabManager.tabs.find(t => t.type === 'local');
      TabManager.switchTo(tab.id);
      return tab.id;
    })()`).catch(() => null);
    await sleep(600);
    await cdp.eval(`(() => {
      const term = TabManager.tabs.find(t => t.type === 'local').term;
      term.write('\\r\\nhttps://e2e-link.example/plain-path\\r\\n');
      term.write('\\x1b]8;;https://e2e-osc8.example/real-target\\x07osc8-label\\x1b]8;;\\x07\\r\\n');
      return 'written';
    })()`).catch(() => null);
    await sleep(600);
    const linkPlain = await cdp.eval(`window.__linkClick('e2e-link.example', true)`).catch(e => 'eval-err');
    await sleep(300);
    const plainState = await cdp.eval(`({ calls: window.__linkOpenCalls, overlay: document.getElementById('overlay-confirm').classList.contains('open') })`);
    check('终端链接：Ctrl+点击纯文本链接直开一次', typeof linkPlain === 'string' && linkPlain.startsWith('click@') && plainState.calls.length === 1 && plainState.calls[0] === 'https://e2e-link.example/plain-path' && plainState.overlay === false,
      JSON.stringify({ linkPlain, ...plainState, setup: linkSetup }));
    const linkNoCtrl = await cdp.eval(`window.__linkClick('e2e-link.example', false)`).catch(() => 'eval-err');
    await sleep(300);
    const noCtrlCalls = await cdp.eval(`window.__linkOpenCalls.length`);
    check('终端链接：无 Ctrl 点击不打开', typeof linkNoCtrl === 'string' && linkNoCtrl.startsWith('click@') && noCtrlCalls === 1, JSON.stringify({ linkNoCtrl, noCtrlCalls }));
    const linkHover = await cdp.eval(`window.__linkHover('e2e-link.example')`).catch(() => null);
    const hoverOk = !!linkHover && linkHover.shown === true && linkHover.text.includes('https://e2e-link.example/plain-path') && linkHover.text.includes('Ctrl+点击打开');
    check('终端链接：悬停提示真实目标与手势', hoverOk === true, JSON.stringify(linkHover));
    await cdp.eval(`window.__linkClick('osc8-label', true)`).catch(() => 'eval-err');
    await sleep(300);
    const oscConfirm = await cdp.eval(`({
      open: document.getElementById('overlay-confirm').classList.contains('open'),
      msg: document.getElementById('confirm-msg').textContent,
      okText: document.getElementById('confirm-ok').textContent,
      calls: window.__linkOpenCalls.length
    })`);
    const oscConfirmOk = oscConfirm.open === true && oscConfirm.msg.includes('https://e2e-osc8.example/real-target') && oscConfirm.okText === '打开' && oscConfirm.calls === 1;
    check('终端链接：OSC8 先弹确认（真实目标，未打开）', oscConfirmOk === true, JSON.stringify(oscConfirm));
    await cdp.eval(`document.getElementById('confirm-cancel').click(); 'cancel'`);
    await sleep(250);
    const oscAfterCancel = await cdp.eval(`({ open: document.getElementById('overlay-confirm').classList.contains('open'), calls: window.__linkOpenCalls.length })`);
    await cdp.eval(`window.__linkClick('osc8-label', true)`).catch(() => 'eval-err');
    await sleep(300);
    await cdp.eval(`document.getElementById('confirm-ok').click(); 'ok'`);
    await sleep(300);
    const oscAfterOk = await cdp.eval(`({ open: document.getElementById('overlay-confirm').classList.contains('open'), calls: window.__linkOpenCalls })`);
    const oscFlowOk = oscAfterCancel.open === false && oscAfterCancel.calls === 1 && oscAfterOk.open === false && oscAfterOk.calls.length === 2 && oscAfterOk.calls[1] === 'https://e2e-osc8.example/real-target';
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
    check('终端链接：拖出链接后抬起不打开', !!linkDrag && linkDrag.calls === 2 && linkDrag.overlay === false, JSON.stringify(linkDrag));
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
    check('终端链接：Ctrl+右键不打开', !!linkRight && linkRight.calls === 2 && linkRight.overlay === false, JSON.stringify(linkRight));
    const notesProbe = await cdp.eval(`(() => {
      window.__updateUrl = 'https://notes.example/release';
      goUpdateReleaseNotes();
      return window.__linkOpenCalls.length;
    })()`);
    check('更新说明链接走统一 open-url 入口', notesProbe === 3, `calls=${notesProbe}`);
    const notesFail = await cdp.eval(`(async () => {
      const prev = ipcRenderer.invoke;
      ipcRenderer.invoke = (cmd) => cmd === 'open-url' ? Promise.reject('blockedProtocol') : prev(cmd);
      goUpdateReleaseNotes();
      await new Promise(r => setTimeout(r, 120));
      ipcRenderer.invoke = prev;
      const t = document.getElementById('toast');
      return { shown: t.classList.contains('show'), text: t.textContent };
    })()`);
    const notesFailOk = notesFail.shown === true && notesFail.text.includes('无法打开链接') && notesFail.text.includes('blockedProtocol');
    check('更新说明链接失败弹出错误反馈', notesFailOk === true, JSON.stringify(notesFail));
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

    // 13.10 Settings SSH page: section titles + one settings-card per group
    // (design/ssh-settings-card-design.md). Shared renderer/DOM untouched —
    // the card chrome is scoped to the .settings-card-list class (shared with
    // the quick-commands settings page, 13.11) while the overlay manager
    // stays flat. Re-seed fixtures (13.9 cleaned them out).
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
      (cardStruct.cardShadow || '').includes('inset') && cardStruct.cardPadding === '6px 16px' &&
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
    // Floating surfaces must carry the inset hairline border (zt-tip parity)
    // so menus read as distinct from the dark terminal background.
    const menuEdge = await cdp.eval(`(() => {
      const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
      // WebView2 keeps the var()-containing declaration verbatim (no rgba
      // whitespace normalization), so compare with whitespace stripped.
      const hasEdge = sel => rules.some(r => r.selectorText === sel &&
        (r.style.boxShadow || '').replace(/\\s+/g, '').includes('inset0001pxrgba(255,255,255,0.06)'));
      return { popup: hasEdge('.menu-popup'), tabCtx: hasEdge('.tab-context-menu'),
               dd: hasEdge('.cust-dropdown .dd-menu'), combo: hasEdge('.cust-combo .dd-menu'),
               transfer: hasEdge('.transfer-window') };
    })()`).catch(() => null);
    check('浮层菜单：下拉与传输记录面板均带 inset 描边', !!menuEdge && menuEdge.popup === true && menuEdge.tabCtx === true && menuEdge.dd === true && menuEdge.combo === true && menuEdge.transfer === true, JSON.stringify(menuEdge));
    // The container's focus-within accent border is the search field's only
    // focus indicator (the inner input's ring is intentionally off). Read
    // after a real sleep: border-color has a 120ms transition.
    const searchFocusPre = await cdp.eval(`(() => {
      const box = document.querySelector('[data-page="ssh"] .settings-toolbar .ssh-mgr-search');
      const input = document.querySelector('[data-ssh-search="settings-ssh-list"]');
      if (!box || !input) return null;
      const before = getComputedStyle(box).borderColor;
      input.focus();
      return { before };
    })()`).catch(() => null);
    await sleep(250);
    const searchFocusPost = await cdp.eval(`(() => {
      const box = document.querySelector('[data-page="ssh"] .settings-toolbar .ssh-mgr-search');
      if (!box) return null;
      const r = { after: getComputedStyle(box).borderColor,
                  focused: document.activeElement === document.querySelector('[data-ssh-search="settings-ssh-list"]') };
      document.activeElement.blur();
      return r;
    })()`).catch(() => null);
    const searchFocusOk = !!searchFocusPre && !!searchFocusPost && searchFocusPost.focused === true &&
      searchFocusPre.before !== searchFocusPost.after && searchFocusPost.after.includes('97, 175, 239');
    check('SSH 设置页：搜索框焦点有容器强调边框', searchFocusOk === true, JSON.stringify({ ...searchFocusPre, ...searchFocusPost }));
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

    // 13.14 Issue #10 regression: an OSC 0/2 window title written by the
    // session (remote shell, an AI agent, ...) must become the tab name and
    // reach the tab bar label; a manual rename (_customName) must keep
    // winning over later title sequences; and the title must keep following
    // the terminal across the tab→split migration (the term moves onto a
    // pane wrapper, so both the stored title and the event-time owner
    // resolution must move with it).
    const oscTitle = await cdp.eval(`(async () => {
      const T = TabManager;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const poll = async (fn, n = 40) => { for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(100); } return false; };
      const baseActive = T.activeId;
      const baseCount = T.tabs.length;
      const p = getDefaultLocalProfile();
      T.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
      const tab = T.tabs[T.tabs.length - 1];
      const out = { wired: false, followed: false, lockedHeld: false, unlockedFollows: false,
                    titleMovedToPane: false, splitFollows: false, collapsedBack: false,
                    collapseFollows: false, settled: false };
      try {
        out.wired = await poll(() => tab.term && tab.tabId);
        if (!out.wired) return out;
        // Wait out the shell's own startup title (Git Bash emits one with the
        // first prompt; PowerShell never does — then this is just a 2.5s
        // settle). After the first prompt the shell only re-titles on input,
        // which this probe never sends.
        await poll(() => !!tab._oscTitle, 25);
        await sleep(200);
        const label = () => document.querySelector('.tab[data-tab="' + tab.id + '"] .tab-name')?.textContent || '';
        const origTerm = tab.term;
        origTerm.write('\\x1b]0;E2E_OSC_TITLE\\x07');
        out.followed = await poll(() => tab.name === 'E2E_OSC_TITLE' && label() === 'E2E_OSC_TITLE');
        tab._customName = true;
        origTerm.write('\\x1b]2;E2E_LOCKED\\x07');
        await sleep(400);
        out.lockedHeld = tab.name === 'E2E_OSC_TITLE';
        delete tab._customName;
        T._updateTabName(tab);
        out.unlockedFollows = tab.name === 'E2E_LOCKED';
        // Split: the original terminal moves onto a pane wrapper. Its stored
        // title and its future titles must keep driving the tab name.
        T.addPaneRelativeTo(tab, 'r');
        const splitReady = await poll(() => tab.splitRoot && getAllPanes(tab).length === 2, 50);
        if (splitReady) {
          const origPane = getAllPanes(tab).find(pp => pp.term === origTerm);
          // Invariant: the title moved onto the pane slot (tab slot cleared).
          // Don't assert the exact string — a late shell re-title may replace it.
          out.titleMovedToPane = !!origPane && typeof origPane._oscTitle === 'string' &&
            origPane._oscTitle.length > 0 && tab._oscTitle === undefined;
          origTerm.write('\\x1b]0;E2E_AFTER_SPLIT\\x07');
          out.splitFollows = await poll(() => tab.name.includes('E2E_AFTER_SPLIT'));
          // Collapse back to a single terminal: the stored title must move
          // back onto the tab slot and keep following new titles.
          const other = getAllPanes(tab).find(pp => pp.term !== origTerm);
          if (other) T._closePane(tab.id, other.id);
          out.collapsedBack = await poll(() => !tab.splitRoot && tab.term === origTerm, 40);
          if (out.collapsedBack) {
            origTerm.write('\\x1b]0;E2E_AFTER_COLLAPSE\\x07');
            out.collapseFollows = await poll(() => tab.name === 'E2E_AFTER_COLLAPSE');
          }
        }
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
    check('OSC 标题序列跟随为标签名且尊重手动重命名（issue #10 回归）',
      !!oscTitle && oscTitle.wired === true && oscTitle.followed === true &&
      oscTitle.lockedHeld === true && oscTitle.unlockedFollows === true &&
      oscTitle.titleMovedToPane === true && oscTitle.splitFollows === true &&
      oscTitle.collapsedBack === true && oscTitle.collapseFollows === true && oscTitle.settled === true,
      JSON.stringify(oscTitle));

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
      await sleep(500);
      try { proxyPersisted = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')).terminal?.updateProxy === 'http://127.0.0.1:1'; } catch {}
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

    // 14. 窗口状态恢复：写入 config 的 window 字段 → 重启 → 验证最大化/尺寸恢复
    async function writeWindowState(state) {
      // 读现有 config（若存在）并注入 window 字段
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
      const url = await waitForPage();
      const c2 = new Cdp(url);
      await c2.connect();
      return c2;
    }
    // 窗口状态恢复由 renderer-ready 触发（页面加载完成后异步执行），轮询等待。
    // 注意：innerWidth 是 CSS 像素，set_size 恢复的是物理像素（outer_size 保存值），
    // 期望宽度 = expectW / devicePixelRatio，比较时按 DPR 换算避免缩放缩放下误报失败。
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
    killExisting();
    await sleep(500);
  } finally {
    cdp.close();
    const stopped = killExisting();
    restoreConfig();
    if (!stopped) throw new Error('Owned runtime cleanup failed');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(`E2E 失败: ${e.message}`); killExisting(); restoreConfig(); process.exit(1); });
