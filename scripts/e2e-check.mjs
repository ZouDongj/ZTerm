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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.argv[2] ?? 'src-tauri/target/release/zterm.exe');
const PORT = Number(process.argv[3] ?? 9222);

// ── 启动 exe（带 WebView2 远程调试）──
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
  throw new Error(`页面在 ${timeoutMs}ms 内未就绪（exe 是否启动成功？）`);
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

async function main() {
  if (!existsSync(EXE)) throw new Error(`exe 不存在: ${EXE}`);
  console.log(`E2E 检查: ${EXE}\n`);

  killExisting();
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
  } finally {
    cdp.close();
    killExisting();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(`E2E 失败: ${e.message}`); killExisting(); process.exit(1); });
