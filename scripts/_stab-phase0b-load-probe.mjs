// Stability Phase 0b: same three-phase measurement UNDER SYNTHETIC STREAM
// LOAD. The idle probe was clean, so the user-visible lag must need real
// workload (herdr-style continuous output). Flood 3 local Git Bash tabs with
// colored-line + cursor-jump output (poor-man's TUI repaint) and re-measure
// idle-under-load / hover / switch. Local only — nothing runs on the user's
// servers.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-stab-phase0b');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, 'ZTerm.exe'));
// Storm-free variant of the real config: keep the 4 local Git Bash tabs,
// drop the SSH ones (no server traffic needed for this measurement).
const real = JSON.parse(await (await import('node:fs/promises')).readFile(
  'D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', 'utf8'));
real.lastTabs = (real.lastTabs || []).filter(t => t.type === 'local');
writeFileSync(join(TMP, 'data', 'config.json'), JSON.stringify(real));

const PORT = 9457;
const child = spawn(join(TMP, 'ZTerm.exe'), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });

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

// Wait for restore + terms wired (empty tab list must NOT short-circuit).
for (let i = 0; i < 40; i++) {
  const ready = await val(`TabManager.tabs.length >= 4 && TabManager.tabs.filter(t => t.type === 'local').every(t => t.term)`);
  if (ready === true) break;
  await sleep(500);
}
console.log('[boot] tabs:', await val(`TabManager.tabs.map(t => t.name).join(',')`));

// Start flood loops in 3 background tabs (bash printf loops; the active tab
// stays clean so hover measurements aren't confounded by its own redraws).
// Pure-builtin printf loop (no $(date) — MSYS forks per substitution and
// caps throughput at ~5KB/s, far below a TUI repaint stream).
const flood = String.raw`while :; do printf '\033[3%dmrow %06d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\033[0m\n' $((RANDOM%7+1)) $RANDOM; done`;
const floodTabIds = [];
for (const t of JSON.parse(await val(`JSON.stringify(TabManager.tabs.filter(x => x.type === 'local').slice(1, 4).map(x => ({ id: x.id, tabId: x.tabId })))`))) {
  await val(`ipcRenderer.send('pty-input', { tabId: '${t.tabId}', data: ${JSON.stringify(flood + '\r')} })`);
  floodTabIds.push(t);
}
await sleep(3000);
// Flood sanity: each target tab must be streaming >50KB/3s, else the
// measurement below would silently run against idle tabs again.
{
  const chk = await val(`(async () => { globalThis.__ztStreamBytes = {}; await new Promise(r => setTimeout(r, 2000)); return JSON.stringify(globalThis.__ztStreamBytes); })()`);
  const bytes = Object.values(JSON.parse(chk || '{}')).reduce((s, v) => s + v, 0);
  console.log('[flood-check] bytes/2s:', bytes);
  if (bytes < 50000) { console.log('FLOOD FAILED — aborting'); process.exit(1); }
}
console.log('[flood] 3 tabs streaming, active tab:', await val('TabManager.getActive().name'));

const phaseSample = (name, ms) => val(`(async () => {
  const t0 = performance.now();
  globalThis.__ztStreamBytes = {};
  const adaptersBefore = TabManager.tabs.map(t => ({ id: t.id, n: t.name,
    c: t._smoothCursor?._adapter ? t._smoothCursor._adapter.snapshot().counters.cursorDrawPasses : null,
    b: t._smoothCursor?._adapter ? t._smoothCursor._adapter.snapshot().counters.baseDrawPasses : null }));
  const raf = [];
  await new Promise(done => { const loop = t => { raf.push(t); if (t - t0 < ${ms}) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
  const gaps = raf.slice(1).map((v, i) => Math.round(v - raf[i])).sort((a, b) => a - b);
  const q = p => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null;
  const after = TabManager.tabs.map(t => ({ id: t.id,
    c: t._smoothCursor?._adapter ? t._smoothCursor._adapter.snapshot().counters.cursorDrawPasses : null,
    b: t._smoothCursor?._adapter ? t._smoothCursor._adapter.snapshot().counters.baseDrawPasses : null }));
  const adapters = after.map(a => { const b = adaptersBefore.find(x => x.id === a.id) || {};
    return { n: b.n || a.id, cursorD: a.c != null && b.c != null ? a.c - b.c : null, baseD: a.b != null && b.b != null ? a.b - b.b : null }; });
  return { phase: '${name}', rafCount: raf.length, gapP50: q(0.5), gapP95: q(0.95), gapMax: gaps[gaps.length - 1] || null,
    streamBytes: globalThis.__ztStreamBytes || {}, adapters,
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
})()`);

const A = await phaseSample('idle-under-load', 8000);
console.log('[A load-idle]', JSON.stringify(A));

// hover sweeps
const rects = await val(`(() => {
  const bar = document.getElementById('tabbar').getBoundingClientRect();
  const term = (document.querySelector('.term-wrap.active .term-inner') || document.body).getBoundingClientRect();
  return { bar: { x: Math.round(bar.x), y: Math.round(bar.y + bar.height / 2), w: Math.round(bar.width) },
           term: { x: Math.round(term.x), y: Math.round(term.y + term.height / 2), w: Math.round(term.width) } };
})()`);
const sweepPhase = async label => {
  const armed = await val(`(async () => { window.__sw = { t0: performance.now(), raf: [] };
    await new Promise(done => { const loop = t => { window.__sw.raf.push(t); if (t - window.__sw.t0 < 4000) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    return 'ok'; })()`);
  if (armed !== 'ok') { console.log('[B ' + label + '] arming failed'); return; }
};
// interleave: run the sweep with input events while rAF loop runs in page
const sweepWithInput = async (label, r) => {
  val(`(async () => { const t0 = performance.now(); const raf = [];
    await new Promise(done => { const loop = t => { raf.push(t); if (t - t0 < 4000) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    const gaps = raf.slice(1).map((v, i) => Math.round(v - raf[i])).sort((a, b) => a - b);
    window.__sweepRes = { rafCount: raf.length, p50: gaps[Math.floor(gaps.length/2)], p95: gaps[Math.floor(gaps.length*0.95)], max: gaps[gaps.length-1] }; })()`).catch(() => {});
  for (let i = 0; i < 200; i++) {
    const x = r.x + 8 + ((r.w - 16) * (i % 100)) / 100;
    await send('Input.dispatchMouseEvent', { type: 'mouseMove', x: Math.round(x), y: r.y });
    await sleep(20);
  }
  await sleep(400);
  console.log(`[B ${label}]`, JSON.stringify(await val('JSON.stringify(window.__sweepRes)')));
};
await sweepWithInput('tabbar', rects.bar);
await sweepWithInput('terminal', rects.term);

// switch sweep under load
const C = await val(`(async () => {
  const ids = TabManager.tabs.map(t => t.id);
  const out = [];
  for (const id of ids) {
    await new Promise(r => setTimeout(r, 150));
    const t0 = performance.now();
    TabManager.switchTo(id);
    const sync = performance.now() - t0;
    await new Promise(r => requestAnimationFrame(r));
    const paint = performance.now() - t0;
    out.push({ id, syncMs: +sync.toFixed(1), paintMs: +paint.toFixed(1) });
  }
  return out;
})()`);
console.log('[C switch-under-load]', JSON.stringify(C));

// stop floods (Ctrl+C) and take a post-load idle sample
await val(`(() => { for (const t of TabManager.tabs.filter(x => x.type === 'local')) { if (t.tabId) ipcRenderer.send('pty-input', { tabId: t.tabId, data: '\\u0003' }); } return 'stopped'; })()`);
await sleep(1500);
const D = await phaseSample('post-load-idle', 5000);
console.log('[D post-load]', JSON.stringify(D));

writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/stab-phase0b-' + Date.now() + '.json', JSON.stringify({ A, C, D }, null, 2));
ws.close();
process.exit(0);
