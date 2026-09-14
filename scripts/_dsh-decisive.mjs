// Decisive experiment: in ONE app session measure (a) herdr's own input line
// (known-smooth control) and (b) dsh-tui input (choppy case), sampling the
// smooth-cursor adapter counters per keystroke AND capturing the POST-filter
// stream via a term.write hook.
import { spawn, execSync, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
const PORT = 9417;
const OUT = 'artifacts/caret-capture';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
const hs = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('herdr', ['--session', 'ztprobe3', ...args], { timeout }, (err, stdout) =>
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
const tabId = await val(`TabManager.tabs.find(t => t.type === 'local')?.tabId`);
// hook term.write to capture POST-filter bytes
await val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const orig = t.term.write.bind(t.term);
  window.__post = '';
  t.term.write = function (d) { window.__post += String(d); return orig(d); };
  return 'hooked'; })()`);
await val(`ipcRenderer.send('pty-input', { tabId: '${tabId}', data: 'herdr --session ztprobe3\\r' })`);
await sleep(5000);
let pl = await hs(['pane', 'list']);
const paneId = (pl.out.match(/"pane_id":"(w\d+:p\d+)"/) || [])[1];

const snap = () => val(`(() => {
  const t = TabManager.tabs.find(t => t.type === 'local');
  const a = t && t._smoothCursor && t._smoothCursor._adapter;
  const s = a && a.snapshot ? a.snapshot() : null;
  return s ? JSON.stringify({ cd: s.counters.cursorDrawPasses, bd: s.counters.baseDrawPasses, tgt: s.target ? s.target.x + ',' + s.target.y : null, st: s.drawPassStatus, anim: s.animationActive }) : 'NO_ADAPTER';
})()`);

async function typeKeys(label, keys) {
  await val(`window.__post = ''`);
  let prev = await snap();
  console.log(`[${label}] baseline:`, prev);
  for (const k of keys) {
    await hs(['pane', 'send-keys', paneId, k]);
    await sleep(450);
    const cur = await snap();
    let dCd = '?', tgt = '?';
    try { const a = JSON.parse(prev), b = JSON.parse(cur); dCd = b.cd - a.cd; tgt = b.tgt; } catch {}
    console.log(`  [${label}] key ${k}: +cursorDraws=${dCd} target=${tgt}`);
    prev = cur;
  }
  const post = await val(`window.__post`);
  writeFileSync(`${OUT}/${label}-postfilter.txt`, String(post), 'latin1');
  const c = (re) => ((String(post).match(re) || []).length);
  console.log(`[${label}] POST-FILTER: ?25l=${c(/\x1b\[\?25l/g)} ?25h=${c(/\x1b\[\?25h/g)} blocks=${c(/\x1b\[\?2026h/g)} bytes=${String(post).length}`);
}

// control: herdr's own input line
await hs(['pane', 'focus', paneId]);
await val(`(() => { const t = TabManager.tabs.find(t => t.type === 'local'); t.term.focus(); return document.hasFocus() ? 'doc-focused' : 'doc-bg'; })()`);
await typeKeys('herdr-input', ['a', 'b', 'c', 'd', 'e']);
// clear the input
await hs(['pane', 'send-keys', paneId, 'c-c']);
await sleep(400);

// case: dsh-tui
const TMP = process.env.TEMP.replace(/\\/g, '/').replace(/\/+/g, '/') + '/zt-caret-probe';
await hs(['pane', 'send-text', paneId, ` mkdir -p ${TMP} && cd ${TMP} && dsh-tui\r`]);
await sleep(7000);
await typeKeys('dshtui-input2', ['h', 'e', 'l', 'l', 'o']);
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
