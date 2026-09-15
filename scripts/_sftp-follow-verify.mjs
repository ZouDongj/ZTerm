// End-to-end verify of the 1337 CurrentDir follow fix using the app's real
// input path (xterm paste -> onData -> pty-input).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9409;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\zterm-probe-${PORT}` },
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
await val(`(() => { window.__cwd = []; window.__raw = '';
  ipcRenderer.on('sftp-cwd-changed', (e, d) => window.__cwd.push(d.tabId + '=' + d.cwd));
  return 'armed'; })()`);
await val(`connectSSHProfile('ssh_1784621154940')`);
let tabId = null;
for (let i = 0; i < 40; i++) {
  tabId = await val(`(() => { const t = TabManager.tabs.find(t => t.type === 'ssh' && t.connected); return t ? t.tabId : null; })()`);
  if (tabId && tabId !== 'null') break;
  await sleep(700);
}
console.log('connected tabId:', tabId);
// wait for prompt quiet
let prev = -1, stable = 0;
for (let i = 0; i < 40 && stable < 3; i++) {
  await sleep(700);
  const len = await val(`(window.__len = ((window.__len||0) + 1), window.__len)`) === 'EXC: ReferenceError: window is not defined' ? -1 : await val(`TabManager.tabs.find(t => t.tabId === '${tabId}')?.term?.buffer?.active?.length ?? -1`);
  if (len === prev) stable++; else { stable = 0; prev = len; }
}
// real input path: focus the terminal then paste
const pasteRes = await val(`(() => {
  const t = TabManager.tabs.find(t => t.tabId === '${tabId}');
  if (!t || !t.term) return 'no term';
  TabManager.setActive(t.id);
  t.term.focus();
  t.term.paste('cd /tmp');
  t.term.inputHandler? null : null;
  return 'pasted'; })()`);
console.log('paste:', pasteRes);
await sleep(1500);
// send Enter through the same onData path
await val(`(() => { const t = TabManager.tabs.find(t => t.tabId === '${tabId}'); if (t?.term?._core) { t.term._core._onData && t.term._core._onData('\r'); return 'enter-via-core'; } return 'no core'; })()`);
await sleep(2500);
console.log('cwd events:', await val(`JSON.stringify(window.__cwd)`));
console.log('sftp-open path:', await val(`ipcRenderer.invoke('sftp-open', { tabId: '${tabId}' }).then(r => r && r.path).catch(e => 'REJ ' + e)`));
// cleanup probe state
await val(`(() => { const t = TabManager.tabs.find(t => t.type === 'ssh'); if (t) TabManager.closeTab(t.id); return 1; })()`);
await val(`ipcRenderer.invoke('save-last-tabs', [{ type: 'local', name: 'Git Bash' }])`).catch(() => {});
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
