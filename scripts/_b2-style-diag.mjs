// Dump the LIVE parsed cell encoding at the descriptor position vs the
// descriptor's raw-stream bg — to align the style-evidence check with the
// real xterm cell layout (after applyHighlight).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-b2sty.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-sty');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9489;
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
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result?.result?.value;
};
function send(method, params = {}) { return new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); }); }

let sshTabId = null;
for (let i = 0; i < 60; i++) {
  const r = await val(`TabManager.tabs.find(x => x.host === '192.168.41.88' && x.connected)?.tabId`);
  if (r) { sshTabId = r; break; }
  await sleep(1000);
}
console.log('[tab]', sshTabId);
const type = async (s, wait = 420) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };

await type('herdr --session zterm-b2sty2\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch);
await sleep(400);

// Instrument: capture the NEXT published descriptor via the port, then dump
// the parsed cell at that position (bg/ext/chars) from the real buffer.
const cellDump = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const b = t.term.buffer.active;
  // after typing 'ab cd' the app caret cell is the styled space at row 19, col 35
  const out = [];
  for (const [y, x] of [[19, 35], [19, 34]]) {
    const line = b.getLine(y); if (!line) { out.push([y, x, 'no-line']); continue; }
    const cell = line.getCell(x); if (!cell) { out.push([y, x, 'no-cell']); continue; }
    out.push({ y, x, chars: JSON.stringify(cell.getChars()), w: cell.getWidth(),
      isBgRGB: typeof cell.isBgRGB === 'function' ? cell.isBgRGB() : 'n/a',
      isBgPalette: typeof cell.isBgPalette === 'function' ? cell.isBgPalette() : 'n/a',
      bgMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(cell)).filter(m => /bg|Bg|color/i.test(m)),
      bgRgb: typeof cell.getBgRgb === 'function' ? JSON.stringify(cell.getBgRgb()) : 'no-method', });
  }
  return JSON.stringify(out);
})()`);
console.log('[cell]', cellDump);

