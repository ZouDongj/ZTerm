import { spawn, execSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9419;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
const hs = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('herdr', ['--session', 'ztprobe4', ...args], { timeout }, (err, stdout) =>
    resolve({ err: err ? String(err.message).slice(0, 120) : null, out: String(stdout) }));
});
let page = null;
while (Date.now() - t0 < 25000) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); if (page) break; } catch {}
  await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (code) => (await send('Runtime.evaluate', { expression: code, returnByValue: true })).result?.result?.value;
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'herdr --session ztprobe4\r' })`);
await sleep(5000);
let pl = await hs(['pane', 'list']);
const paneId = (pl.out.match(/"pane_id":"(w\d+:p\d+)"/) || [])[1];
const TMP = process.env.TEMP.split(String.fromCharCode(92)).join('/') + '/zt-caret-probe';
await hs(['pane', 'send-text', paneId, ` mkdir -p ${TMP} && cd ${TMP} && dsh-tui\r`]);
await sleep(7000);
await hs(['pane', 'focus', paneId]);
await val(`TabManager.tabs.find(t => t.type === 'local').term.focus()`);
await hs(['pane', 'send-keys', paneId, 'x']);
await sleep(600);
console.log('flags during dsh-tui:', await val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const g = (path, fn) => { try { return fn(); } catch (e) { return 'ERR ' + e.message.slice(0, 60); } };
  return JSON.stringify({
    hasCore: g('core', () => !!t.term._core),
    hidden: g('hidden', () => t.term._core.coreService.isCursorHidden),
    initialized: g('init', () => t.term._core.coreService.isCursorInitialized),
    focused: g('focus', () => t.term._core.coreBrowserService.isFocused),
    cursorX: g('cx', () => t.term._core.buffer.active.cursorX),
    cursorY: g('cy', () => t.term._core.buffer.active.cursorY),
    ydisp: g('yd', () => t.term._core.buffer.ydisp),
    rows: g('rows', () => t.term.rows),
  }); })()`));
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
