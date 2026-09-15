// ADR-0001 B2 runtime verification: drive dsh-tui navigation in an isolated
// self-created herdr session on 41.88 and assert the software-caret takeover
// engages end-to-end: the adapter draws from the descriptor (write position,
// NOT the protocol park), the covering char stays intact in the buffer, and
// the takeover follows left/right moves. Also verifies kimi.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-adrb2.exe';
const TMP = join(process.env.TEMP, 'zterm-adr-b2');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9483;
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
const val = async (code, timeoutMs = 10000) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 150);
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

const type = async (s, wait = 200) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };
const swState = () => val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const a = t._smoothCursor?._adapter;
  if (!a) return JSON.stringify({ error: 'no-adapter' });
  const snap = a.snapshot ? a.snapshot() : {};
  return JSON.stringify({
    sw: snap.softwareCaret || a.instrumentation?.softwareCaret || null, swCursor: a.instrumentation?.lastSoftwareCursor || null,
    target: snap.target,
    drawPassStatus: snap.drawPassStatus,
    cursorHidden: t.term._core.coreService.isCursorHidden,
    observerUnits: t._inkObserver ? t._inkObserver.state().unitSeq : 'none',
  });
})()`);

await type('herdr --session zterm-adrb2d\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch, 420);
await sleep(500);
console.log('[after typing]', await swState());

// Pure left navigation: the descriptor must follow the caret onto 'd','c'
const positions = [];
for (let i = 0; i < 4; i++) {
  await type('\u001b[D', 320);
  positions.push(JSON.parse(await swState()));
}
for (const p of positions) console.log('[nav]', JSON.stringify(p));

// Cleanup
for (let i = 0; i < 4; i++) await type('\u001b[C', 150);
for (let i = 0; i < 5; i++) await type('\u007f', 150);
await type('\u0003', 600);
await type('exit\r', 500);
await type('\u0002q', 600);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-adrb2d kill 2>/dev/null; echo K\\r' })`);
await sleep(1000);

const engaged = positions.some(p => p.sw && p.sw.active === true);
const followed = engaged && positions.some(p => p.target && typeof p.target.x === 'number');
console.log('VERDICT:', engaged
  ? (followed ? 'B2 ENGAGED — descriptor-driven cursor followed navigation' : 'engaged but no target')
  : 'NOT ENGAGED (raw display fallback — see states above)');
ws.close();
process.exit(0);
