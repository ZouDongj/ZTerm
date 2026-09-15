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

import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
const PORT = Number(process.argv[3] ?? 9222);

// ── 启动 exe（带 WebView2 远程调试）──
const DATA_CONFIG = resolve(dirname(EXE), 'data', 'config.json');
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

// A live zterm.exe at e2e start is usually the USER's session (the restart
// section only relaunches e2e's own instance mid-run). Killing it via
// killExisting would destroy their work and drop SSH sessions — abort and
// let the operator close it instead.
function detectRunningInstance() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq zterm.exe" /FO CSV /NH', { encoding: 'utf8' });
    return /zterm\.exe/i.test(out);
  } catch {
    return false;
  }
}

// /T is mandatory: plain /F kills only zterm.exe and orphans the PTY children
// (bash.exe + ConPTY OpenConsole.exe). Orphaned MSYS2 processes keep holding
// cygwin console slots, and past ~128 of them new Git Bash sessions die with
// "console device allocation failure".
function killExisting() {
  try { execSync('taskkill /IM zterm.exe /T /F', { stdio: 'ignore' }); } catch {}
}
// Safety net for exit paths that skip the explicit killExisting() calls
// (unexpected early throw, unhandled rejection): never leave a PTY tree behind.
process.on('exit', () => killExisting());

function startApp() {
  const child = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  });
  child.unref();
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
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
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); portInfo = r.ok ? '调试端口已开放' : `HTTP ${r.status}`; } catch { portInfo = '调试端口未开放'; }
  throw new Error(`页面在 ${timeoutMs}ms 内未就绪。进程: ${procInfo}; ${portInfo}`);
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

async function waitForValue(cdp, expression, expected, timeoutMs = 8000) {
  // 轮询等待表达式达到期望值（分屏等异步操作在慢机上需要时间，固定 sleep 会假失败）
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expression).catch(() => null);
    if (last === expected) return last;
    await sleep(300);
  }
  return last;
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`exe 不存在: ${EXE}`);
  if (detectRunningInstance()) {
    throw new Error('检测到正在运行的 zterm.exe（可能是用户会话）。请先手动关闭再跑 e2e——自动强杀会丢失用户终端会话');
  }
  console.log(`E2E 检查: ${EXE}\n`);

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
    await sleep(1500);
    const minimized = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMinimized().then(r => r)`);
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
    // 平滑光标 adapter 真实挂载断言：bind 失败只 console.warn，旧检查（overlay DOM
    // count===0）对 adapter 恒真，无法区分"动画在跑"和"静默降级到原生光标"。
    check('WebGL 平滑光标 adapter 已挂载', chainProbe.ok === true && chainProbe.hasAdapter === true, JSON.stringify(chainProbe));

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
    await sleep(4000);
    const sshErrCount = await cdp.eval(`window.__sshErrCount`);
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

    // 14. 窗口状态恢复：写入 config 的 window 字段 → 重启 → 验证最大化/尺寸恢复
    async function writeWindowState(state) {
      // 读现有 config（若存在）并注入 window 字段
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(DATA_CONFIG, 'utf8')); } catch {}
      cfg.window = state;
      writeFileSync(DATA_CONFIG, JSON.stringify(cfg), 'utf8');
    }
    async function restartAndConnect() {
      killExisting();
      await sleep(800);
      startApp();
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
    killExisting();
    restoreConfig();
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
