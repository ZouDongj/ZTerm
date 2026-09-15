// Capture v2: boot herdr test session, run dsh-tui then opencode in a TEMP
// cwd, type 5 keys into each input, save raw pre-filter streams for the
// caret-pattern diff. Never touches user sessions (ztprobe + %TEMP% cwd).
import { spawn, execSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 9411;
const OUT = 'artifacts/caret-capture';
mkdirSync(OUT, { recursive: true });
const TMP = process.env.TEMP.replace(/\\/g, '/').replace(/\/+/g, '/') + '/zt-caret-probe';
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });
const hs = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('herdr', ['--session', 'ztprobe', ...args], { timeout }, (err, stdout, stderr) =>
    resolve({ err: err ? String(err.message).slice(0, 150) : null, out: String(stdout), se: String(stderr).slice(0, 300) }));
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
await val(`(() => { window.__cap = { chunks: [], on: false };
  ipcRenderer.on('pty-output', (e, d) => { if (window.__cap.on) window.__cap.chunks.push(String(d.data)); });
  return 'armed'; })()`);
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
// boot herdr test session
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'herdr --session ztprobe\\r' })`);
await sleep(5000);
let pl = await hs(['pane', 'list']);
const paneId = (pl.out.match(/"pane_id":"(w\d+:p\d+)"/) || [])[1];
console.log('paneId:', paneId);

async function captureTyped(label, bootCmd, bootWaitMs, keys) {
  // cd to temp dir then launch the target in the pane shell
  await hs(['pane', 'send-text', paneId, ` mkdir -p ${TMP} && cd ${TMP} && ${bootCmd}\r`]);
  await sleep(bootWaitMs);
  const read1 = await hs(['pane', 'read', paneId]);
  console.log(`[${label}] pane tail after boot:`, JSON.stringify(String(read1.out).slice(-180)));
  await val(`window.__cap.chunks = []; window.__cap.on = true`);
  for (const k of keys) {
    const r = await hs(['pane', 'send-keys', paneId, k]);
    if (r.err) console.log('send-keys err:', r.err);
    await sleep(400);
  }
  await sleep(900);
  await val(`window.__cap.on = false`);
  const joined = await val(`window.__cap.chunks.join('')`);
  writeFileSync(`${OUT}/${label}.json`, JSON.stringify({ keys, stream: joined }, null, 0));
  console.log(`[${label}] captured ${joined.length} bytes -> ${OUT}/${label}.json`);
  // exit the target: Ctrl+C twice + fresh prompt
  await hs(['pane', 'send-keys', paneId, 'esc']);
  await sleep(300);
  await hs(['pane', 'send-keys', paneId, 'c-c']);
  await sleep(300);
  await hs(['pane', 'send-keys', paneId, 'c-c']);
  await sleep(1200);
  return joined;
}

await captureTyped('dshtui-input', 'dsh-tui', 7000, ['h', 'e', 'l', 'l', 'o']);
await captureTyped('opencode-input', 'opencode', 9000, ['h', 'e', 'l', 'l', 'o']);
// cleanup
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
