// ADR-0001 B0: capture RAW (pre-filter) delete & pure-navigation samples
// from dsh-tui and kimi code inside an ISOLATED, SELF-CREATED herdr session
// on the 41.88 SSH rig. Never touches the user's running herdr sessions.
// All interaction happens in a probe-owned ZTerm instance (real config copy,
// fake APPDATA, unique image name); raw bytes are grabbed in pty-output
// BEFORE _conPtyCaretFix via globalThis.__ztRawCapture.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-adrb0.exe';
const TMP = join(process.env.TEMP, 'zterm-adr-b0');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9476;
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

// Find the 41.88 tab and arm raw capture.
let sshTabId = null;
for (let i = 0; i < 60; i++) {
  const r = await val(`(() => { const t = TabManager.tabs.find(x => x.host === '192.168.41.88' && x.connected); return t ? t.tabId : null; })()`);
  if (r) { sshTabId = r; break; }
  await sleep(1000);
}
if (!sshTabId) { console.log('NO 41.88 TAB'); process.exit(1); }
console.log('[tab]', sshTabId);
await val('globalThis.__ztRawCapture = []; "armed"');

const type = async (s, wait = 180) => { await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: ${JSON.stringify(s)} }); 'sent'`); await sleep(wait); };
const rawTail = (n = 300) => val(`(globalThis.__ztRawCapture || []).join('').slice(-${n})`);
const rawLen = () => val(`(globalThis.__ztRawCapture || []).length`);

// ── step 1: input reachability probe ──
await type('echo ZB0MARK$((1+1))\r', 2200);
const tail = await rawTail(400);
const reachable = typeof tail === 'string' && tail.includes('ZB0MARK2');
console.log('[reachability]', reachable ? 'OK' : 'FAIL', JSON.stringify(String(tail).slice(-120)));
if (!reachable) { console.log('pty-input cannot drive this SSH tab — falling back needed'); process.exit(2); }

// ── step 2: isolated herdr session + dsh-tui ──
await val('globalThis.__ztRawCapture = []; "reset"');
await type('herdr --session zterm-adrb0\r', 3000);
await type('dsh-tui\r', 4000);
{
  const t = await rawTail(200);
  console.log('[dsh-tui booted]', /38;2;\d+;\d+;\d+;48;2;/.test(String(t)) ? 'painted-glyph shapes present' : 'no painted glyph yet', JSON.stringify(String(t).slice(-80)));
}

// ── step 3: the five input classes in the dsh-tui input box ──
// forward typing
await type('ab cd');
// pure left navigation to line start (5 cells: d,c,space,b,a)
for (let i = 0; i < 5; i++) await type('\u001b[D', 150);
// pure right navigation back to line end
for (let i = 0; i < 5; i++) await type('\u001b[C', 150);
// backspace delete-all at EOL
for (let i = 0; i < 5; i++) await type('\u007f', 150);
// retype + mid-line delete test: type 'xy', left x2, Backspace (deletes 'x'), then right
await type('xy');
for (let i = 0; i < 2; i++) await type('\u001b[D', 150);
await type('\u007f', 180);
await type('\u001b[C', 180);
await sleep(600);

const dshRaw = await val(`(globalThis.__ztRawCapture || []).join('')`);
writeFileSync('D:/Code/MyTerm/ZTerm/tests/fixtures/dshtui-b0-nav-delete.txt', dshRaw, null);
console.log('[dsh sample]', dshRaw.length, 'bytes -> tests/fixtures/dshtui-b0-nav-delete.txt');

// ── step 4: cleanup dsh-tui, then try kimi code in the same herdr session ──
await type('\u0003', 800); // Ctrl+C exit dsh-tui
await sleep(600);
await val('globalThis.__ztRawCapture = []; "reset"');
await type('kimi\r', 4000);
{
  const t = await rawTail(300);
  console.log('[kimi]', String(t).slice(-100));
}
await type('ab cd');
for (let i = 0; i < 5; i++) await type('\u001b[D', 150);
for (let i = 0; i < 5; i++) await type('\u001b[C', 150);
for (let i = 0; i < 5; i++) await type('\u007f', 150);
await sleep(600);
const kimiRaw = await val(`(globalThis.__ztRawCapture || []).join('')`);
writeFileSync('D:/Code/MyTerm/ZTerm/tests/fixtures/kimi-b0-nav-delete.txt', kimiRaw);
console.log('[kimi sample]', kimiRaw.length, 'bytes -> tests/fixtures/kimi-b0-nav-delete.txt');

// ── step 5: clean up the server-side test session ──
await type('\u0003', 600);      // exit kimi input/UI
await type('exit\r', 800);      // leave pane shell if any
await type('\u0002q', 800);     // herdr detach (Ctrl+B q)
await sleep(400);
await val(`ipcRenderer.send('pty-input', { tabId: '${sshTabId}', data: 'herdr --session zterm-adrb0 kill 2>/dev/null || herdr kill-session zterm-adrb0 2>/dev/null; echo ZB0CLEAN\\r' })`);
await sleep(1500);
console.log('[cleanup] tail:', JSON.stringify(String(await rawTail(120)).slice(-100)));

ws.close();
process.exit(0);
