// B2 foreground VISUAL evidence probe: boots the isolated instance, drives
// dsh-tui typing + navigation, and waits for `window.__go` (set from outside
// once the window has been ACTIVATED) before the gesture — so the draw path
// (focused=true) actually executes. Dumps draw-proof instrumentation.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe';
const IMG = 'zterm-probe-b2vis.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-vis');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9486;
const child = spawn(join(TMP, IMG), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

let page = null;
for (let i = 0; i < 300 && !page; i++) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); } catch {}
  await sleep(250);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (code, timeoutMs = 15000) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result?.result?.value;
};

let sshTabId = null;
for (let i = 0; i < 60; i++) {
  const r = await val(`TabManager.tabs.find(x => x.host === '192.168.41.88' && x.connected)?.tabId`);
  if (r) { sshTabId = r; break; }
  await sleep(1000);
}
if (!sshTabId) { console.log('NO SSH TAB'); process.exit(1); }
console.log('[tab]', sshTabId);
const type = async (s, wait = 420) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };

await type('herdr --session zterm-b2vis2\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch);
await sleep(400);
TabManager.tabs.find(x => x.tabId === sshTabId)?.term?.focus?.();
console.log('[READY] window can be activated now; waiting for __go');
// wait for the activation signal (up to 3 min)
for (let i = 0; i < 360; i++) {
  if ((await val('window.__go === true')) === true) break;
  await sleep(500);
}
const focusState = await val(`(() => { const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}'); const a = t._smoothCursor._adapter; return JSON.stringify({ focused: t.term._core.coreBrowserService.isFocused, sw: a.instrumentation.softwareCaret, swCursor: a.instrumentation.lastSoftwareCursor }); })()`);
console.log('[focus]', focusState);
// focus the terminal so the draw gate opens even if activation only focused the window
await val(`TabManager.tabs.find(x => x.tabId === '${sshTabId}').term.focus(); 'focused'`);
await sleep(300);

const draw0 = await val(`(() => { const a = TabManager.tabs.find(x => x.tabId === '${sshTabId}')._smoothCursor._adapter; return JSON.stringify(a.instrumentation.counters); })()`);
// the visual gesture: left-right navigation with live drawing
for (let i = 0; i < 4; i++) await type('\u001b[D', 300);
for (let i = 0; i < 4; i++) await type('\u001b[C', 300);
await sleep(700);
const snap = await val(`(() => { const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}'); const a = t._smoothCursor._adapter; const s = a.snapshot(); return JSON.stringify({ sw: a.instrumentation.softwareCaret, target: s.target, lastRectangle: s.lastRectangle, drawPassStatus: s.drawPassStatus, counters: s.counters, draw0: null }); })()`);
console.log('[draw-before]', draw0);
console.log('[snapshot]', snap);
console.log('[HOLD] window stays open 90s for external screenshots');
await sleep(90000);
// cleanup
await type('\u0003', 500); await type('exit\r', 400); await type('\u0002q', 500);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-b2vis2 kill 2>/dev/null; echo K\\r' })`);
ws.close();
process.exit(0);
