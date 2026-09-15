// Diagnose the UVSS (124.223.14.203) SSH connect failure through the app's
// own connect path, capturing every ssh-* event plus timing.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9415;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
await val(`(() => { window.__ev = [];
  ipcRenderer.on('ssh-connected', (e, d) => __ev.push('connected ' + d.tabId));
  ipcRenderer.on('ssh-error', (e, d) => __ev.push('error: ' + d.error));
  ipcRenderer.on('ssh-hostkey-changed', (e, d) => __ev.push('hostkey-changed ' + JSON.stringify(d).slice(0, 200)));
  return 'armed'; })()`);
console.log('profile info:', await val(`JSON.stringify((TabManager.sshProfiles||[]).filter(p => p.host === '124.223.14.203').map(p => ({ id: p.id, port: p.port, user: p.username, authType: p.authType, hasEnc: !!p.encryptedPassword, keyPath: p.privateKeyPath, followCwd: p.followCwd, loginScripts: (p.loginScripts||[]).length })))`));
const t1 = Date.now();
await val(`selectSession('ssh_1784260669556')`);
for (let i = 0; i < 40; i++) {
  const n = await val(`window.__ev.length`);
  if (n > 0) break;
  await sleep(500);
}
await sleep(2000);
console.log('events:', await val(`JSON.stringify(window.__ev)`), `(${Date.now() - t1}ms)`);
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
