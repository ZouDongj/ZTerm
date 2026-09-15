// Decisive v3: no herdr CLI calls during the measurement window (each CLI
// spawn steals window focus on Windows and freezes the adapter). Keys go
// through pty-input directly; term.focus() happens AFTER the last CLI call.
import { spawn, execSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9420;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });
const hs = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('herdr', ['--session', 'ztprobe5', ...args], { timeout }, (err, stdout) =>
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
// setup phase (CLI allowed): boot herdr + dsh-tui
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'herdr --session ztprobe5\\r' })`);
await sleep(5000);
let pl = await hs(['pane', 'list']);
const paneId = (pl.out.match(/"pane_id":"(w\d+:p\d+)"/) || [])[1];
const TMP = process.env.TEMP.split(String.fromCharCode(92)).join('/') + '/zt-caret-probe';
await hs(['pane', 'send-text', paneId, ` mkdir -p ${TMP} && cd ${TMP} && dsh-tui\r`]);
await sleep(8000);
await hs(['pane', 'focus', paneId]);
await sleep(1000);
// instrument handler costs
await val(`(() => {
  window.__t = [];
  const origAH = window.applyHighlight;
  if (origAH) window.applyHighlight = function (d, tabId) { const t0 = performance.now(); const r = origAH(d, tabId); const ms = performance.now() - t0; if (ms > 1) window.__t.push(['hl', d.length, +ms.toFixed(1)]); return r; };
  const t = TabManager.tabs.find(t => t.type === 'local');
  const ow = t.term.write.bind(t.term);
  t.term.write = function (d) { const t0 = performance.now(); const r = ow(d); const ms = performance.now() - t0; if (ms > 1) window.__t.push(['write', String(d).length, +ms.toFixed(1)]); return r; };
  return 'instrumented'; })()`);
// measurement phase: NO CLI. Bring the app window to the OS foreground
// (textarea focus in a background window is unreliable in WebView2), then
// retry term.focus() until the adapter reports a drawable cursor.
try {
  execSync(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(${child.pid})"`, { stdio: 'ignore' });
} catch {}
await sleep(600);
for (let f = 0; f < 8; f++) {
  const st = await val(`(() => {
    window.focus();
    const t = TabManager.tabs.find(t => t.type === 'local');
    t.term.focus();
    const a = t._smoothCursor && t._smoothCursor._adapter;
    const s = a && a.snapshot ? a.snapshot() : null;
    return s ? s.drawPassStatus : 'none';
  })()`);
  if (st && st !== 'base-only') { console.log('focus ok after', f, 'tries:', st); break; }
  await sleep(800);
}

const snap = () => val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const a = t && t._smoothCursor && t._smoothCursor._adapter;
  const s = a && a.snapshot ? a.snapshot() : null;
  return s ? JSON.stringify({ cd: s.counters.cursorDrawPasses, tgt: s.target ? s.target.x + ',' + s.target.y : null, st: s.drawPassStatus, gaps: s.recentDrawGapMs }) : 'NO_ADAPTER';
})()`);

console.log('baseline:', await snap());
let prev = await snap();
for (const k of ['h', 'e', 'l', 'l', 'o']) {
  await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: '${k}' })`);
  await sleep(500);
  const cur = await snap();
  let dCd = '?', tgt = '?', st = '?';
  try { const a = JSON.parse(prev), b = JSON.parse(cur); dCd = b.cd - a.cd; tgt = b.tgt; st = b.st; } catch {}
  console.log(`  key ${k}: +cursorDraws=${dCd} target=${tgt} status=${st}`);
  prev = cur;
}
// fast burst: 10 keys at ~40ms cadence
await val(`ipcRenderer.send('pty-input', { tabId: '', data: 'qwertyuiop' })`);
await sleep(1200);
const fast = await snap();
console.log('FAST BURST (10 keys at once):', fast);
console.log('handler timings (>1ms):', await val(`JSON.stringify(window.__t.slice(0, 40))`));
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
