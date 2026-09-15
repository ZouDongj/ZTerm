// B2 foreground VISUAL evidence probe v3. Boot → dsh-tui setup → READY
// (waits for window.__go, which the operator sets AFTER foregrounding the
// window and focusing the terminal) → nav gesture with the draw gate open
// → dump draw counters/snapshot → 60s hold for external screenshots.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-b2vis3.exe';
const TMP = join(process.env.TEMP, 'zterm-b2-vis3');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9492;
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

await type('herdr --session zterm-b2vis3\r', 3000);
await type('dsh-tui\r', 4000);
for (const ch of 'ab cd') await type(ch);
await sleep(400);
console.log('[READY] activate window + focus terminal, then set window.__go');
for (let i = 0; i < 360; i++) {
  if ((await val('window.__go === true')) === true) break;
  await sleep(500);
}
// settle focus, then verify the gate inputs
await val(`TabManager.tabs.find(x => x.tabId === '${sshTabId}')?.term?.focus?.(); 'ok'`);
await sleep(600);
const pre = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const a = t._smoothCursor._adapter;
  return JSON.stringify({
    docFocus: document.hasFocus(),
    coreFocused: a.instrumentation.counters ? null : null,
    sw: a.instrumentation.softwareCaret,
    swCursor: a.instrumentation.lastSoftwareCursor,
    cursorDrawPasses: a.instrumentation.cursorDrawPasses,
  });
})()`);
console.log('[pre-gesture]', pre);

// the visible gesture: 4 left + 4 right with the draw gate open
for (let i = 0; i < 4; i++) await type('\u001b[D', 320);
for (let i = 0; i < 4; i++) await type('\u001b[C', 320);
await sleep(800);
const post = await val(`(() => {
  const t = TabManager.tabs.find(x => x.tabId === '${sshTabId}');
  const a = t._smoothCursor._adapter;
  const s = a.snapshot();
  return JSON.stringify({
    sw: a.instrumentation.softwareCaret,
    swCursor: a.instrumentation.lastSoftwareCursor,
    target: s.target,
    lastRectangle: s.lastRectangle,
    lastGlyph: s.lastGlyph,
    drawPassStatus: s.drawPassStatus,
    cursorDrawPasses: a.instrumentation.cursorDrawPasses,
    retargets: s.retargets.slice(-6),
  });
})()`);
console.log('[post-gesture]', post);
console.log('[HOLD-60s] screenshot window now');
await sleep(60000);

await type('\u0003', 500); await type('exit\r', 400); await type('\u0002q', 500);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-b2vis3 kill 2>/dev/null; echo K\\r' })`);
ws.close();
process.exit(0);
