// Reproduce v2: timestamps + in-app retry after the restore failure + exe
// stderr capture. User workspace backed up and restored on exit.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const WS = join(process.env.APPDATA, 'ZTerm', 'workspace.json');
const BAK = WS + '.zt-bak';
copyFileSync(WS, BAK);
const ws = JSON.parse(readFileSync(WS, 'utf8'));
const sshTab = JSON.parse(JSON.stringify(ws.tabs.find(t => t.root?.pane?.launch?.type === 'ssh') || ws.tabs[0]));
sshTab.id = 'tuvss';
sshTab.title = '124.223.14.203 - UVSS';
sshTab.focusedPaneId = 'puvss';
sshTab.root.pane.id = 'puvss';
sshTab.root.pane.title = '124.223.14.203 - UVSS';
Object.assign(sshTab.root.pane.launch, { type: 'ssh', host: '124.223.14.203', port: 6000, username: 'zou', profileId: 'ssh_1784260669556' });
ws.tabs = [sshTab];
ws.activeTabId = 'tuvss';
writeFileSync(WS, JSON.stringify(ws));

const PORT = 9424;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[exe-stderr]', s.slice(0, 200)); });
process.on('exit', () => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { copyFileSync(BAK, WS); unlinkSync(BAK); console.log('workspace restored'); } catch {}
});
let page = null;
while (Date.now() - t0 < 25000) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); if (page) break; } catch {}
  await sleep(300);
}
const bootAt = Date.now();
const wsCdp = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
wsCdp.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => wsCdp.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); wsCdp.send(JSON.stringify({ id: i, method, params })); });
const val = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + r.exceptionDetails.exception?.description?.slice(0, 200);
  return r.result?.result?.value;
};
await val(`(() => { window.__ev = [];
  const mark = () => Date.now() - ${bootAt};
  ipcRenderer.on('ssh-connecting', (e, d) => __ev.push([mark(), 'connecting', d.tabId]));
  ipcRenderer.on('ssh-connected', (e, d) => __ev.push([mark(), 'connected', d.tabId]));
  ipcRenderer.on('ssh-error', (e, d) => __ev.push([mark(), 'error', String(d.error)]));
  return 'armed'; })()`);
console.log('app lastTabs:', await val(`new Promise(res => {
  const once = (e, d) => { ipcRenderer.removeListener('profiles', once);
    res(JSON.stringify((d.lastTabs || []).map(t => ({ type: t.type, name: t.name, host: t.host, hasSR: !!t.splitRoot })))); };
  ipcRenderer.on('profiles', once);
  ipcRenderer.invoke('get-profiles');
})`));
console.log('tabs at arm:', await val(`JSON.stringify(TabManager.tabs.map(t => ({ type: t.type, name: t.name, host: t.host || '' })))`));
// NOTE: restore already happened before we armed; wait for the failure event
for (let i = 0; i < 40; i++) {
  const ev = await val(`JSON.stringify(window.__ev)`);
  if (ev && ev.includes('error')) break;
  await sleep(500);
}
console.log('events:', await val(`JSON.stringify(window.__ev)`));
console.log('tab state:', await val(`JSON.stringify(TabManager.tabs.map(t => ({ type: t.type, connected: t.connected })))`));
// retry in the same instance
console.log('retrying via reconnectTab...');
await val(`(() => { const t = TabManager.tabs.find(t => t.type === 'ssh'); if (t) TabManager.reconnectTab(t.id); return 'retry-sent'; })()`);
for (let i = 0; i < 30; i++) {
  const ev = await val(`JSON.stringify(window.__ev.slice(-2))`);
  if (ev && ev.includes('connected')) break;
  await sleep(500);
}
await sleep(2500);
console.log('after retry:', await val(`JSON.stringify(window.__ev.slice(-3))`));
wsCdp.close();
process.exit(0);
