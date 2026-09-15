// B2 engagement diagnostic: live raw capture + in-page observer replay to
// find the broken link (stream has no caret frames vs wiring).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-b2diag.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-diag');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9481;
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
const type = async (s, wait = 250) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };

// 1. In-page sanity: does the page-global observer produce a candidate from
//    a known-good synthetic unit? (Wiring of createInkCaretObserver itself.)
const inpage = await val(`(() => {
  const got = [];
  const o = createInkCaretObserver({ onCandidate: c => got.push(c) });
  o.push('\\u001b[?2026h\\u001b[?25l\\u001b]8;;\\u001b\\\\\\u001b[20;31H\\u001b[0;39;49ma\\u001b[0;38;2;40;44;52;48;2;220;223;228mb\\u001b[0m\\u001b[20;32H\\u001b[?25l\\u001b[?2026l');
  return JSON.stringify({ candidates: got.length, x: got[0] && got[0].x, y: got[0] && got[0].y });
})()`);
console.log('[in-page synthetic]', inpage);

// 2. Live raw capture during typing.
await val('globalThis.__ztRawCapture = []; "armed"');
await type('herdr --session zterm-b2diag\r', 3000);
await type('dsh-tui\r', 4000);
await type('ab cd', 900);
const raw = await val(`(globalThis.__ztRawCapture || []).join('')`);
writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/b2-live-raw.txt', raw);
const sig = (raw.match(/\u001b\[0;38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m/g) || []).length;
const units = (raw.match(/\u001b\[\?2026h/g) || []).length;
const shows = (raw.match(/\u001b\[\?25h/g) || []).length;
console.log('[live raw]', JSON.stringify({ len: raw.length, sig, units, shows }));
// Show one signature-bearing unit from the live capture for grammar diff.
const m = raw.match(/\u001b\[\?2026h[^\u001b]*\u001b\[\?25l[\s\S]{0,220}?\u001b\[\?2026l/g);
const withSig = (m || []).filter(b => /0;38;2;\d+;\d+;\d+;48;2;/.test(b)).slice(0, 2);
for (const b of withSig) console.log('[live unit]', JSON.stringify(b.slice(0, 200)));

// cleanup
await type('\u0003', 500); await type('exit\r', 400); await type('\u0002q', 500);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-b2diag kill 2>/dev/null; echo K\\r' })`);
await sleep(800);
ws.close();
process.exit(0);
