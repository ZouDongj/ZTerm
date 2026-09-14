// Probe: (B) what shell does the restored "Git Bash" tab actually run;
// (C) how long does a '+' createTab take end-to-end.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9428;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
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
const val = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + r.exceptionDetails.exception?.description?.slice(0, 200);
  return r.result?.result?.value;
};
// arm raw output capture FIRST (before typing)
await val(`(() => { window.__raw2 = ''; ipcRenderer.on('pty-output', (e, d) => { window.__raw2 += (d.data || ''); }); return 'armed'; })()`);
for (let i = 0; i < 30; i++) {
  if (await val(`TabManager.tabs.filter(t => t.type === 'local').length`) > 0) break;
  await sleep(600);
}
await sleep(1500);
console.log('restored tabs:', await val(`JSON.stringify(TabManager.tabs.map(t => ({ name: t.name, type: t.type, command: t.command })))`));
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'echo SHELL_IS=$0\\r' })`);
await sleep(2000);
const rawTail = String(await val(`window.__raw2.slice(-250)`) || '');
console.log('raw tail:', JSON.stringify(rawTail.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')));
// C: time a fresh default local tab creation
const c = await val(`(async () => {
  const t0 = performance.now();
  const before = TabManager.tabs.length;
  const p = new Promise(res => {
    const check = setInterval(() => {
      if (TabManager.tabs.length > before) { clearInterval(check); res(performance.now() - t0); }
    }, 20);
  });
  const btn = document.getElementById('btn-add-tab');
  btn ? btn.click() : TabManager.createTab({});
  const tabShown = await p;
  const t1 = performance.now();
  await new Promise(res => {
    const check = setInterval(() => {
      const t = TabManager.tabs[TabManager.tabs.length - 1];
      if (t && t.term && t.tabId) { clearInterval(check); res(); }
    }, 20);
  });
  return JSON.stringify({ tabShownMs: +tabShown.toFixed(0), ptyReadyMs: +(performance.now() - t1).toFixed(0) });
})()`);
console.log('createTab timing:', c);
ws.close();
process.exit(0);
