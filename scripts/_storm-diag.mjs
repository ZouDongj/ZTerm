// Storm diagnostic: capture every ssh-* event from attach onward + snapshot
// tab state every 5s, to see whether ssh-error arrives and what its text is.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe';
const PORT = 9445;
const TMP = `${process.env.TEMP}\\zterm-storm-diag`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + '\\data', { recursive: true });
copyFileSync(EXE, TMP + '\\ZTerm.exe');
writeFileSync(TMP + '\\data\\config.json', JSON.stringify({
  profiles: [],
  sshProfiles: [{ id: 'p1', name: 'badhost', host: '127.0.0.1', port: 1, username: 'x', encryptedPassword: 'AAAA', followCwd: false, loginScripts: [] }],
  lastTabs: [
    { name: 'bad-ssh', type: 'ssh', host: '127.0.0.1', port: 1, user: 'x', sshProfileId: 'p1', args: [], content: [] },
    { name: 'local', type: 'local', command: 'powershell.exe', args: [], content: [] },
  ],
}));

const child = spawn(TMP + '\\ZTerm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[exe]', s.slice(0, 160)); });
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });

const t0 = Date.now();
let page = null;
while (Date.now() - t0 < 30000) {
  try {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t2 => t2.type === 'page' && t2.url.includes('renderer.html'));
    if (page) break;
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 250);
  return r.result?.result?.value;
};
console.log('attached at', Date.now() - t0, 'ms');
await val(`(() => {
  window.__ev = [];
  const t0 = performance.now();
  for (const k of ['ssh-connecting', 'ssh-connected', 'ssh-error', 'ssh-disconnected'])
    ipcRenderer.on(k, (e, d) => window.__ev.push([Math.round(performance.now() - t0), k, d.rendererId, d.tabId, String(d.error || '').slice(0, 80)]));
  return 'armed';
})()`);

for (let round = 0; round < 12; round++) {
  await sleep(5000);
  const ev = JSON.parse((await val('JSON.stringify(window.__ev)')) || '[]');
  const tabs = await val(`JSON.stringify(TabManager.tabs.map(t => ({ id: t.id, type: t.type, tabId: t.tabId, retried: t._sshRetried || 0, hasTerm: !!t.term })))`);
  console.log(`t=${(round + 1) * 5}s events=${ev.length} tabs=${tabs}`);
  if (ev.length) for (const e of ev.slice(-4)) console.log('   ', JSON.stringify(e));
  const wraps = await val(`[...document.querySelectorAll('.term-wrap')].map(w => w.id + (w.classList.contains('active') ? '*' : '')).join(',')`);
  console.log(`    wraps: ${wraps}`);
}
ws.close();
process.exit(0);
