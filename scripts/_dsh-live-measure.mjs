// LIVE animation-health measurement for the dsh-tui caret after the
// anti-churn filter change: per-keystroke cursorDrawPasses/baseDrawPasses
// deltas, time from key to first cursor draw, and caret target position.
import { spawn, execSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9416;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
const hs = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('herdr', ['--session', 'ztprobe2', ...args], { timeout }, (err, stdout) =>
    resolve({ err: err ? String(err.message).slice(0, 120) : null, out: String(stdout) }));
});
let page = null;
while (Date.now() - t0 < 25000) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); if (page) break; } catch {}
  await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
await val(`(() => { window.__raw = '';
  ipcRenderer.on('pty-output', (e, d) => { window.__raw += (d.data || ''); });
  return 'armed'; })()`);
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'herdr --session ztprobe2\\r' })`);
await sleep(5000);
let pl = await hs(['pane', 'list']);
const paneId = (pl.out.match(/"pane_id":"(w\d+:p\d+)"/) || [])[1];
console.log('paneId:', paneId);
const TMP = process.env.TEMP.replace(/\\/g, '/').replace(/\/+/g, '/') + '/zt-caret-probe';
await hs(['pane', 'send-text', paneId, ` mkdir -p ${TMP} && cd ${TMP} && dsh-tui\r`]);
await sleep(7000);
await hs(['pane', 'focus', paneId]);

const snap = () => val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const s = t && t._smoothCursor && t._smoothCursor._adapter && t._smoothCursor._adapter.snapshot ? t._smoothCursor._adapter.snapshot() : null;
  return s ? JSON.stringify({ cd: s.counters.cursorDrawPasses, bd: s.counters.baseDrawPasses, tgt: s.target ? s.target.x + ',' + s.target.y : null, anim: s.animationActive }) : 'NO_ADAPTER';
})()`);

let prev = await snap();
console.log('baseline:', prev);
console.log('per-keystroke deltas:');
for (const k of ['h', 'e', 'l', 'l', 'o']) {
  const t1 = Date.now();
  await hs(['pane', 'send-keys', paneId, k]);
  // poll until cursorDrawPasses moves or 1.5s
  let cur = prev, waited = 0;
  while (Date.now() - t1 < 1500) {
    await sleep(40);
    cur = await snap();
    if (typeof cur === 'string' && cur !== prev && !cur.startsWith('NO_ADAPTER')) {
      try { if (JSON.parse(cur).cd > JSON.parse(prev).cd) break; } catch {}
    }
  }
  waited = Date.now() - t1;
  let dCd = '?', dBd = '?', tgt = '?';
  try { const a = JSON.parse(prev), b = JSON.parse(cur); dCd = b.cd - a.cd; dBd = b.bd - a.bd; tgt = b.tgt; } catch {}
  console.log(`  key ${k}: +cursorDraws=${dCd} +baseDraws=${dBd} target=${tgt} firstDrawIn=${waited}ms`);
  prev = cur;
}
// post-filter stream sanity during typing window
const raw = await val(`window.__raw.slice(-400)`);
const count25l = ((raw.match(/\x1b\[\?25l/g) || []).length);
const count25h = ((raw.match(/\x1b\[\?25h/g) || []).length);
console.log('raw tail during typing: ?25l=??? (pre-filter by design); last 200:', JSON.stringify(String(raw).slice(-200)));
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
