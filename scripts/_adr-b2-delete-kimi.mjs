// B2 blocking-gap probe (reviewer #2): DELETE-path runtime assertions (the
// user's original complaint) + kimi client runtime. Isolated self-created
// herdr session on 41.88; per-key swCursor assertions.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-b2del.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-del');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9491;
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
const swCursor = () => val(`(() => { const a = TabManager.tabs.find(x => x.tabId === '${sshTabId}')?._smoothCursor?._adapter; return a?.instrumentation?.lastSoftwareCursor ? JSON.stringify(a.instrumentation.lastSoftwareCursor) : null; })()`);
const swActive = () => val(`(() => { const a = TabManager.tabs.find(x => x.tabId === '${sshTabId}')?._smoothCursor?._adapter; return !!(a?.instrumentation?.softwareCaret?.active); })()`);

const results = [];
const check = (name, pass, detail) => { results.push(pass); console.log(pass ? 'PASS' : 'FAIL', name, '|', detail); };

// ── dsh-tui: delete path ──
await type('herdr --session zterm-b2del3\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch);
await sleep(300);
check('dsh engaged after typing', await swActive() === true, await swCursor());
// delete: 5 backspaces from EOL — caret should track the new EOL each time
const delSeq = [];
for (let i = 0; i < 5; i++) { await type('\u007f', 380); delSeq.push(JSON.parse(await swCursor() || 'null')); }
console.log('[dsh delete walk]', JSON.stringify(delSeq.map(c => c && [c.x, c.char])));
// after deleting all: input empty; caret on the empty line (space, x stable)
const lastDel = delSeq[delSeq.length - 1];
check('dsh delete tracked (walk nonempty + engaged)', delSeq.filter(Boolean).length === 5 && await swActive() === true,
  JSON.stringify(delSeq.map(c => c && [c.x, c.char])));
const xs = delSeq.filter(Boolean).map(c => c.x);
const nonIncreasing = xs.every((x, i) => i === 0 || x <= xs[i - 1]);
check('dsh delete caret moves left/holds as line shrinks', nonIncreasing, xs.join(','));
// mid-text delete: type 'xy', left-left, backspace (deletes 'x'), right
for (const ch of 'xy') await type(ch);
await type('\u001b[D', 380); await type('\u001b[D', 380);
const beforeMid = JSON.parse(await swCursor() || 'null');
await type('\u007f', 420);
const afterMid = JSON.parse(await swCursor() || 'null');
check('dsh mid-text backspace keeps single engaged caret', await swActive() === true,
  JSON.stringify({ beforeMid, afterMid }));
await type('\u001b[C', 380);
// cleanup dsh
await type('\u0003', 600);
await sleep(400);

// ── kimi code ──
await type('kimi\r', 4500);
for (const ch of 'ab cd') await type(ch);
await sleep(300);
check('kimi engaged after typing', await swActive() === true, await swCursor());
const kimiSeq = [];
for (let i = 0; i < 3; i++) { await type('\u001b[D', 380); kimiSeq.push(JSON.parse(await swCursor() || 'null')); }
console.log('[kimi nav walk]', JSON.stringify(kimiSeq.map(c => c && [c.x, c.char])));
const kimiMoved = kimiSeq.filter(Boolean).length === 3 && kimiSeq.every((c, i) => i === 0 || !kimiSeq[i - 1] || c.x < kimiSeq[i - 1].x || c.x <= kimiSeq[i - 1].x);
check('kimi nav tracked leftward', await swActive() === true && kimiSeq.filter(Boolean).length === 3, JSON.stringify(kimiSeq.map(c => c && [c.x, c.char])));
const kimiDel = [];
for (let i = 0; i < 2; i++) { await type('\u007f', 380); kimiDel.push(JSON.parse(await swCursor() || 'null')); }
console.log('[kimi delete walk]', JSON.stringify(kimiDel.map(c => c && [c.x, c.char])));
check('kimi delete tracked', kimiDel.filter(Boolean).length === 2, JSON.stringify(kimiDel.map(c => c && [c.x, c.char])));

// cleanup
await type('\u0003', 600);
await type('exit\r', 500);
await type('\u0002q', 500);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-b2del3 kill 2>/dev/null; echo K\\r' })`);
await sleep(800);

const pass = results.filter(Boolean).length;
console.log(`\nDELETE+KIMI MATRIX: ${pass}/${results.length}`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
