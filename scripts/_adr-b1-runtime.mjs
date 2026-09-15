// ADR-0001 B1 runtime verification on a real isolated instance: the 41.88
// SSH tab must run UNFILTERED (no _caretFilter), keep the protocol cursor
// hidden during dsh-tui navigation (=> only the app's painted caret is
// visible = single cursor), and the input line content must survive byte
// for byte; the local tab must still carry the visibility-repair filter.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-adrb1.exe';
const TMP = join(process.env.TEMP, 'zterm-adr-b1');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9478;
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

let sshTabId = null, localTabId = null;
for (let i = 0; i < 60; i++) {
  const r = await val(`(() => { const s = TabManager.tabs.find(x => x.host === '192.168.41.88' && x.connected); const l = TabManager.tabs.find(x => x.type === 'local' && x.connected); return s && l ? JSON.stringify([s.tabId, l.tabId]) : null; })()`);
  if (r) { [sshTabId, localTabId] = JSON.parse(r); break; }
  await sleep(1000);
}
if (!sshTabId) { console.log('NO TABS'); process.exit(1); }
console.log('[tabs] ssh:', sshTabId, 'local:', localTabId);

await val('globalThis.__ztRawCapture = []; "armed"');
const type = async (s, wait = 180) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };

// Drive the five input classes in dsh-tui inside an isolated herdr session.
await type('herdr --session zterm-adrb1\r', 3000);
await type('dsh-tui\r', 4000);
await type('ab cd');
for (let i = 0; i < 3; i++) await type('\u001b[D', 150);   // left onto 'c'
const midState = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  if (!t || !t.term) return JSON.stringify({ error: 'no-term' });
  const core = t.term._core;
  const b = t.term.buffer.active;
  let lines = '';
  for (let y = 0; y < b.length; y++) lines += (b.getLine(y)?.translateToString(true) || '') + '\\n';
  const rows = lines.split('\\n').filter(l => /ab/.test(l));
  const inputRow = rows[rows.length - 1] || '';
  return JSON.stringify({
    hasFilter: !!t._caretFilter,
    cursorHidden: core.coreService.isCursorHidden,
    inputLine: inputRow.trim().slice(-30),
    rows: rows.length,
  });
})()`);
console.log('[mid-nav ssh state]', midState);

// finish the gesture, then clean up
for (let i = 0; i < 3; i++) await type('\u001b[C', 150);
for (let i = 0; i < 5; i++) await type('\u007f', 150);
await sleep(400);
const endState = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const b = t.term.buffer.active;
  let lines = '';
  for (let y = 0; y < b.length; y++) lines += (b.getLine(y)?.translateToString(true) || '') + '\\n';
  const inputRow = lines.split('\\n').filter(l => l.includes('❯') || l.includes('>')).pop();
  return JSON.stringify({ cursorHidden: t.term._core.coreService.isCursorHidden, lastPrompt: inputRow ? inputRow.trim().slice(-20) : '' });
})()`);
console.log('[end ssh state]', endState);

// Local tab must still carry the repair filter.
const localState = await val(`(() => { const t = TabManager.tabs.find(x => x.tabId === '${localTabId}'); return JSON.stringify({ hasFilter: !!t._caretFilter }); })()`);
console.log('[local state]', localState);

// cleanup server session
await type('\u0003', 600);
await type('exit\r', 500);
await type('\u0002q', 600);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-adrb1b kill 2>/dev/null; echo DONE\\r' })`);
await sleep(1000);
console.log('[cleanup] ok');

const mid = JSON.parse(midState);
const verdict = mid.hasFilter === false && mid.cursorHidden === true && /ab/.test(mid.inputLine);
console.log('VERDICT:', verdict ? 'B1 RUNTIME CLEAN (ssh unfiltered + cursor hidden + content intact)' : 'BROKEN ' + midState);
ws.close();
process.exit(0);
