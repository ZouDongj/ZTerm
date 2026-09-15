// Align the N2 style-evidence check with the REAL xterm cell encoding:
// after typing 'ab cd' in dsh-tui, the app's caret cell is a styled space
// at (y=19, x=35) with bg 220;223;228 in the raw stream. Dump what the
// parsed buffer actually holds there via every available cell API.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-b2enc.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-enc');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9490;
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
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 250);
  return r.result?.result?.value;
};

let sshTabId = null;
for (let i = 0; i < 60; i++) {
  const r = await val(`TabManager.tabs.find(x => x.host === '192.168.41.88' && x.connected)?.tabId`);
  if (r) { sshTabId = r; break; }
  await sleep(1000);
}
console.log('[tab]', sshTabId);
const type = async (s, wait = 420) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };

await type('herdr --session zterm-b2enc\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch);
await sleep(500);

const dump = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const b = t.term.buffer.active;
  const out = [];
  for (const x of [35, 34, 31]) {
    const line = b.getLine(19);
    const cell = line && line.getCell(x);
    if (!cell) { out.push({ x, err: 'no-cell' }); continue; }
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(cell));
    const rec = { x, chars: cell.getChars(), w: cell.getWidth(), api: proto.filter(m => /bg|Bg|Fg|fg|color/i.test(m)) };
    for (const m of rec.api) { try { rec[m] = typeof cell[m] === 'function' ? String(cell[m]()) : String(cell[m]); } catch (e) { rec[m] = 'throw'; } }
    out.push(rec);
  }
  return JSON.stringify(out);
})()`);
console.log('[cells]', dump);

await type('\u0003', 500); await type('exit\r', 400); await type('\u0002q', 500);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-b2enc kill 2>/dev/null; echo K\\r' })`);
await sleep(800);
ws.close();
process.exit(0);
