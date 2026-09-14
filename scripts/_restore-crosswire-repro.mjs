// Reproduce the restore cross-wire: all restored tabs' content became the
// UVSS session after app restart. Runs an ISOLATED copy (temp exe + temp
// data/config.json) so the user's real config is never touched.
// Phases:
//   1. boot, wait for restore to settle, dump per-tab state (host / tabId /
//      connected / xterm buffer tail) -> did the streams cross-wire?
//   2. inject early ssh-event listeners, reload the page, capture the full
//      restore event sequence on the second boot (which connect landed where,
//      errors, retries)
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';

const SRC_EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe';
const SRC_CFG = 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json';
const TMP = `${process.env.TEMP}\\zterm-restore-repro`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + '\\data', { recursive: true });
copyFileSync(SRC_EXE, TMP + '\\ZTerm.exe');
copyFileSync(SRC_CFG, TMP + '\\data\\config.json');

// The anchor config (%APPDATA%) wins if it carries a dataDir pointer — verify
// it does not, otherwise the temp exe would read some other config.
const anchor = JSON.parse(readFileSync(`${process.env.APPDATA}/ZTerm/config.json`, 'utf8'));
console.log('anchor dataDir pointer:', JSON.stringify(anchor.dataDir || null));

const PORT = 9433;
const child = spawn(TMP + '\\ZTerm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[exe]', s.slice(0, 180)); });
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });

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
console.log('boot ms:', Date.now() - t0);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300);
  return r.result?.result?.value;
};

// ── Phase 1: settle + dump final per-tab state ──
await sleep(12000);
const dump = () => `JSON.stringify(TabManager.tabs.map(t => {
  const tail = (() => { try {
    const b = t.term && t.term.buffer.active; if (!b) return '';
    let s = '';
    for (let y = Math.max(0, b.length - 3); y < b.length; y++) s += (b.getLine(y)?.translateToString(true) || '') + ' | ';
    return s.trim();
  } catch (e) { return 'ERR'; } })();
  return { id: t.id, name: t.name, type: t.type, host: t.host || '', tabId: t.tabId, connected: t.connected, retried: t._sshRetried, tail: tail.slice(-140) };
}))`;
console.log('=== PHASE 1: after restore settle ===');
console.log(await val(dump()));

// rAF health (switching "very laggy" report)
console.log('raf gaps p95/max:', await val(`new Promise(res => {
  const ts = []; let n = 0;
  const cb = () => { ts.push(performance.now()); if (++n < 120) requestAnimationFrame(cb); else {
    const gaps = ts.slice(1).map((v, i) => Math.round(v - ts[i])).sort((a, b) => a - b);
    res(JSON.stringify({ p50: gaps[60], p95: gaps[114], max: gaps[gaps.length - 1] }));
  } };
  requestAnimationFrame(cb);
})`));

// ── Phase 2: early listeners + reload, capture the restore sequence ──
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  window.__ev = [];
  const t0 = performance.now();
  const rec = (kind, d) => window.__ev.push([Math.round(performance.now() - t0), kind,
    d.rendererId, d.tabId, String(d.error || '').slice(0, 90)]);
  for (const k of ['ssh-connecting', 'ssh-connected', 'ssh-error', 'ssh-disconnected'])
    ipcRenderer.on(k, (e, d) => rec(k, d));
})()` });
console.log('=== PHASE 2: reload, capture restore sequence ===');
await val('location.reload()');
await sleep(5000); // let the page reload and restore fire
// wait until no new events for 6s (retry backoffs are 2s/5s/10s)
let last = null;
for (let i = 0; i < 40; i++) {
  const ev = await val('JSON.stringify(window.__ev)');
  if (ev === last) { // stable for one poll — check once more later
    await sleep(6000);
    const ev2 = await val('JSON.stringify(window.__ev)');
    if (ev2 === ev) break;
    last = ev2;
  } else { last = ev; }
  await sleep(1000);
}
console.log('events (t_ms, kind, rendererId, tabId, err):');
for (const line of JSON.parse(await val('JSON.stringify(window.__ev)') || '[]'))
  console.log(' ', JSON.stringify(line));
console.log('=== PHASE 2: final state ===');
console.log(await val(dump()));
console.log('pending_state equivalents: retried counts in state above');

ws.close();
process.exit(0);
