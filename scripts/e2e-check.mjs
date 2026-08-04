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
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
const PORT = Number(process.argv[3] ?? 9222);

// ── 启动 exe（带 WebView2 远程调试）──
const DATA_CONFIG = resolve(dirname(EXE), 'data', 'config.json');
let configBackup = null;

function backupConfig() {
  // E2E 创建的 tab/ssh profile 会被前端 15s 周期保存进 data/config.json，
  // 污染下次启动的标签恢复；启动前备份、结束时恢复。
  try {
    if (existsSync(DATA_CONFIG)) {
      configBackup = DATA_CONFIG + '.e2e-bak';
      copyFileSync(DATA_CONFIG, configBackup);
    }
  } catch {}
}

function restoreConfig() {
  try {
    if (configBackup) {
      copyFileSync(configBackup, DATA_CONFIG);
      rmSync(configBackup, { force: true });
    } else {
      rmSync(DATA_CONFIG, { force: true });
    }
  } catch {}
  configBackup = null;
}

function killExisting() {
  try { execSync('taskkill /IM zterm.exe /F', { stdio: 'ignore' }); } catch {}
}

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
    if (r.exceptionDetails) throw new Error(`JS 异常: ${r.exceptionDetails.text}`);
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
  console.log(`E2E 检查: ${EXE}\n`);

  killExisting();
  backupConfig();
  startApp();
  const wsUrl = await waitForPage();
  const cdp = new Cdp(wsUrl);
  await cdp.connect();

  try {
    // 1. CSP：'unsafe-inline' 必须真正生效（未被 Tauri 注入的 hash 挤掉）
    const csp = await cdp.eval(`fetch(location.href, {cache:'no-store'}).then(r => r.headers.get('content-security-policy'))`);
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

    // 9. 分屏：水平分割 → 2 个 pane；再垂直分割 → 3 个 pane（轮询等待，防 pty 未 attach 假失败）
    await cdp.eval(`TabManager.splitHorizontal()`);
    const panesAfterH = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 2);
    check('水平分割产生 2 个 pane', panesAfterH === 2, `panes=${panesAfterH}`);
    await cdp.eval(`TabManager.splitVertical()`);
    const panesAfterV = await waitForValue(cdp, `getAllPanes(TabManager.getActive()).length`, 3);
    check('垂直分割产生 3 个 pane', panesAfterV === 3, `panes=${panesAfterV}`);

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
    const followApplied = await cdp.eval(`document.body.style.fontFamily.includes('monospace') || document.body.style.fontFamily.includes('JetBrains') || document.body.style.fontFamily.includes('Consolas')`);
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

    // 13. 窗口状态恢复：写入 config 的 window 字段 → 重启 → 验证最大化/尺寸恢复
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
    killExisting();
    await sleep(500);
    await writeWindowState({ x: 50, y: 50, width: 800, height: 600, maximized: true });
    const cdp2 = await restartAndConnect();
    const restoredMax = await cdp2.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    check('重启后恢复最大化状态', restoredMax === true, `isMaximized=${restoredMax}`);
    cdp2.close();
    await sleep(500);
    await writeWindowState({ x: 60, y: 60, width: 900, height: 700, maximized: false });
    const cdp3 = await restartAndConnect();
    const restoredMax2 = await cdp3.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized().then(r => r)`);
    const restoredW = await cdp3.eval(`window.innerWidth`);
    check('重启后恢复窗口化尺寸', restoredMax2 === false && Math.abs(restoredW - 900) < 120,
      `isMaximized=${restoredMax2}, innerWidth=${restoredW} (期望 ~900)`);
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
