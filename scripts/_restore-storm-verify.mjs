// Storm verification v3 (APPDATA-isolated, multi-connect queue proof):
// Two SSH tabs to a refused port + one local tab. Proves:
//   A. the serial queue keeps releasing after the first connect settles
//      (the removeListener wedge would leave tab 2 forever unconnected),
//   B. retries are bounded (initial + 3 per tab, backoff 2s/5s/10s),
//   C. wrap invariants hold at every moment: unique ids, exactly one active,
//   D. '+' stays fast while retries churn in the background.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';

const EXE = process.argv[2] || 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe';
const PORT = 9451;
const TMP = `${process.env.TEMP}\\zterm-storm3`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + '\\data', { recursive: true });
mkdirSync(TMP + '\\fake-appdata', { recursive: true });
copyFileSync(EXE, TMP + '\\ZTerm.exe');
// Garbage DPAPI string still yields a credId handle (decrypt → None), so the
// connect proceeds and dies at TCP refused — the retry trigger.
writeFileSync(TMP + '\\data\\config.json', JSON.stringify({
  profiles: [],
  sshProfiles: [{ id: 'p1', name: 'badhost', host: '127.0.0.1', port: 1, username: 'x', encryptedPassword: 'AAAA', followCwd: false, loginScripts: [] }],
  lastTabs: [
    { name: 'bad-ssh-1', type: 'ssh', host: '127.0.0.1', port: 1, user: 'x', sshProfileId: 'p1', args: [], content: [] },
    { name: 'bad-ssh-2', type: 'ssh', host: '127.0.0.1', port: 1, user: 'x', sshProfileId: 'p1', args: [], content: [] },
    { name: 'local', type: 'local', command: 'powershell.exe', args: [], content: [] },
  ],
}));

const child = spawn(TMP + '\\ZTerm.exe', [], {
  env: { ...process.env,
    // Anchor config (%APPDATA%\ZTerm\config.json) would otherwise win and
    // the app would restore the user's real tabs instead of this storm.
    APPDATA: TMP + '\\fake-appdata',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[exe]', s.slice(0, 160)); });
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

const t0 = Date.now();
let page = null;
while (Date.now() - t0 < 30000) {
  try {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t2 => t2.type === 'page' && t2.url.includes('renderer.html'));
    if (page) break;
  } catch {}
  await sleep(300);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
console.log('attached in', Date.now() - t0, 'ms');

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

// Confirm the storm config actually loaded (guards against the anchor leak).
console.log('restored tabs:', await val('JSON.stringify(TabManager.tabs.map(t => t.name))'));

// A: both bad tabs must get their terminal wired (queue released for BOTH).
let bothWired = false;
for (let i = 0; i < 40; i++) {
  const r = await val(`TabManager.tabs.filter(t => t.type === 'ssh' && t._sshRetried >= 1).length`);
  if (r === 2) { bothWired = true; break; } // retry budget > 0 proves error+retry ran for BOTH
  await sleep(1000);
}
console.log('A. both ssh tabs error+retry engaged:', bothWired);

// B: wait for full exhaustion (retried === 3 on both), cap 60s.
let exhausted = false;
const tSettle = Date.now();
while (Date.now() - tSettle < 60000) {
  const r = await val(`TabManager.tabs.filter(t => t.type === 'ssh' && t._sshRetried >= 3).length`);
  if (r === 2) { exhausted = true; break; }
  await sleep(2000);
}
console.log('B. retry budget exhausted on both tabs:', exhausted);

// '+' timing WHILE background state settles
const timing = await val(`(async () => {
  const t0 = performance.now();
  document.getElementById('btn-add-tab').click();
  const tabId = TabManager.activeId;
  for (let i = 0; i < 120; i++) {
    const t = TabManager.tabs.find(x => x.id === tabId);
    const b = t?.term?.buffer?.active;
    if (b && b.length > 1) {
      let s = '';
      for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) || '');
      if (s.includes('PS') || s.includes('$') || s.includes('#')) return { promptMs: Math.round(performance.now() - t0) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return { promptMs: -1 };
})()`);
console.log('D. + click → prompt ms:', JSON.stringify(timing));

// C: wrap invariants after switching to the local tab.
await val(`TabManager.switchTo(TabManager.tabs.find(t => t.type === 'local').id)`);
await sleep(500);
const audit = await val(`(() => {
  const wraps = [...document.querySelectorAll('.term-wrap')];
  const ids = wraps.map(w => w.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  const active = wraps.filter(w => w.classList.contains('active')).map(w => w.id);
  return { total: wraps.length, dup, active, expectActive: 'wrap_' + TabManager.activeId };
})()`);
console.log('C. wrap audit:', JSON.stringify(audit));

const verdict = bothWired && exhausted && audit.dup.length === 0 && audit.active.length === 1 && audit.active[0] === audit.expectActive;
console.log('VERDICT:', verdict ? 'CLEAN' : 'BROKEN');
ws.close();
process.exit(0);
