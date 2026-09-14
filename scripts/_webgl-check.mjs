import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9418;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
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
console.log(await val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const canvases = [...document.querySelectorAll('.xterm-screen canvas')].map(c => c.className || c.tagName);
  const a = t && t._smoothCursor && t._smoothCursor._adapter;
  const s = a && a.snapshot ? a.snapshot() : null;
  return JSON.stringify({
    canvases, hasAdapter: !!a, snapshot: s ? { enabled: s.enabled, smoothEnabled: s.smoothEnabled, renderScope: s.renderScope, cursorStyle: s.cursorStyle } : null,
    dpr: window.devicePixelRatio, animSetting: _settingsConfig.animations,
  }, null, 1); })()`));
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
