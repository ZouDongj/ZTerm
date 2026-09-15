// Memory leak hunt: one local tab, forced GC (--js-flags=--expose-gc), flood
// cycles, and the discriminating experiment — term.clear() after the flood.
// If clear+GC returns the heap to baseline, retention is scrollback-by-
// design; if not, something else holds references (real leak).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-leak');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// unique image name: exit cleanup reaps ONLY this probe's tree by name
const PROBE_IMG = 'zterm-probe-' + (Math.random().toString(36).slice(2, 7)) + '.exe';
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, PROBE_IMG));
writeFileSync(join(TMP, 'data', 'config.json'), JSON.stringify({
  profiles: [], sshProfiles: [],
  lastTabs: [{ name: 'local', type: 'local', command: 'D:\\Program Files\\Git\\bin\\bash.exe', args: [], content: [] }],
}));

const PORT = 9459;
const child = spawn(join(TMP, PROBE_IMG), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --js-flags=--expose-gc`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

let page = null;
for (let i = 0; i < 100 && !page; i++) {
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result?.result?.value;
};

for (let i = 0; i < 30; i++) {
  if ((await val(`TabManager.tabs.length >= 1 && !!TabManager.tabs[0].term`)) === true) break;
  await sleep(500);
}
await val(`ipcRenderer.send('pty-input', { tabId: TabManager.tabs[0].tabId, data: 'cls\\r' })`);
await sleep(500);

const gc = () => val(`(async () => { for (let i = 0; i < 3; i++) { if (typeof gc === 'function') gc(); await new Promise(r => setTimeout(r, 100)); } return typeof gc; })()`);
const stats = async label => {
  const g = await gc();
  await sleep(800);
  const s = await val(`(() => {
    const t = TabManager.tabs[0];
    const buf = t.term.buffer.active;
    let scrollbackCells = 0;
    const step = Math.max(1, Math.floor(buf.length / 200));
    let sampled = 0;
    for (let y = 0; y < buf.length; y += step) { sampled++; scrollbackCells += (buf.getLine(y)?.getTrimmedLength?.() || 0); }
    return {
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      totalHeapMB: performance.memory ? Math.round(performance.memory.totalJSHeapSize / 1048576) : null,
      bufLen: buf.length, sampledAvgCells: Math.round(scrollbackCells / Math.max(1, sampled)),
      contentBuf: (t._contentBuffer || []).length,
      domNodes: document.getElementsByTagName('*').length,
      canvases: document.querySelectorAll('canvas').length,
    };
  })()`);
  const m = await send('Performance.getMetrics').catch(() => null);
  const pm = m && m.result ? Object.fromEntries(m.result.metrics.filter(x => ['Nodes', 'JSEventListeners', 'JSHeapUsedSize', 'Documents'].includes(x.name)).map(x => [x.name, x.value])) : null;
  console.log(`[${label}] gc=${g}`, JSON.stringify(s), pm ? JSON.stringify(pm) : '');
  return s;
};

await send('Performance.enable');
const S0 = await stats('baseline');

// Flood 1: ~20s of colored lines.
const flood = String.raw`for i in $(seq 1 6000); do printf '\033[3%dmline %06d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\033[0m\n' $((i%7+1)) $i; done`;
await val(`ipcRenderer.send('pty-input', { tabId: TabManager.tabs[0].tabId, data: ${JSON.stringify(flood + '\r')} })`);
await sleep(15000);
await stats('after-flood1');

// Discriminator: clear scrollback + GC.
await val(`TabManager.tabs[0].term.clear(); 'cleared'`);
const S1 = await stats('after-clear+gc');
console.log('clear returned to baseline?', S1.heapMB != null && S0.heapMB != null ? (S1.heapMB - S0.heapMB) + 'MB delta' : '?');

// Flood 2 (same volume): plateau higher than flood1's?
await val(`ipcRenderer.send('pty-input', { tabId: TabManager.tabs[0].tabId, data: ${JSON.stringify(flood + '\r')} })`);
await sleep(15000);
await stats('after-flood2');

// clear again + long settle
await val(`TabManager.tabs[0].term.clear()`);
await stats('after-clear2+gc');
ws.close();
process.exit(0);
