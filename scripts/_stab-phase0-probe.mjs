// Stability effort Phase 0 probe: measure the restored-tabs scenario that
// the user reported as "hover / interaction very laggy", WITHOUT touching
// any behavior. Isolated run (temp exe + real config copy + fake APPDATA).
//
// Phases (all diagnostics land in window.__diag):
//   A idle    — 10s after all SSH tabs settled
//   B hover   — 60Hz mouse sweeps over the tab bar and the terminal area
//               via CDP Input (real input pipeline, window may stay behind)
//   C switch  — switchTo every tab x2; sync time + time-to-next-paint
// Plus from document-start (via reload): WebGL context creation count,
// persistent longtask + slow-event observers.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-stab-phase0');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, 'ZTerm.exe'));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9455;
const child = spawn(join(TMP, 'ZTerm.exe'), [], {
  env: { ...process.env,
    APPDATA: join(TMP, 'fake-appdata'),
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

// Early instrumentation on the reloaded page: context count + observers.
// Page.enable() first — without it addScriptToEvaluateOnNewDocument is a
// silent no-op (cost us one full probe round).
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  window.__diag = { contexts: { webgl: 0, '2d': 0 }, longTasks: [], slowEvents: [] };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') window.__diag.contexts.webgl++;
    else window.__diag.contexts[type] = (window.__diag.contexts[type] || 0) + 1;
    return orig.apply(this, arguments);
  };
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const a = e.attribution && e.attribution[0];
        window.__diag.longTasks.push({ dur: Math.round(e.duration), at: Math.round(e.startTime), src: (a && (a.containerName || a.name)) || '' });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (e.duration > 30) window.__diag.slowEvents.push({ type: e.name, dur: Math.round(e.duration), at: Math.round(e.startTime) });
    }).observe({ type: 'event', buffered: true, durationThreshold: 30 });
  } catch (e) {}
})()` });
await val('location.reload()');
await sleep(2500);
{
  const armed = await val('typeof window.__diag');
  if (armed !== 'object') { console.log('INJECTION FAILED:', JSON.stringify(armed)); process.exit(1); }
}

// Wait for the restore to settle: all ssh tabs connected (or budget spent).
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const done = await val(`TabManager.tabs.filter(t => t.type === 'ssh').every(t => t.connected)`);
  if (done === true) break;
}
console.log('[settle] tabs:', await val(`JSON.stringify(TabManager.tabs.map(t => ({ n: t.name, t: t.type, c: t.connected })))`));

const phaseSample = (name, ms) => val(`(async () => {
  const t0 = performance.now();
  globalThis.__ztStreamBytes = {};
  const adaptersBefore = TabManager.tabs.map(t => ({ id: t.id, n: t.name,
    c: t._smoothCursor && t._smoothCursor._adapter ? t._smoothCursor._adapter.snapshot().counters.cursorDrawPasses : null,
    b: t._smoothCursor && t._smoothCursor._adapter ? t._smoothCursor._adapter.snapshot().counters.baseDrawPasses : null }));
  const lt0 = window.__diag.longTasks.length, se0 = window.__diag.slowEvents.length;
  const raf = [];
  await new Promise(done => { const loop = t => { raf.push(t); if (t - t0 < ${ms}) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
  const gaps = raf.slice(1).map((v, i) => Math.round(v - raf[i])).sort((a, b) => a - b);
  const q = p => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null;
  const adaptersAfter = TabManager.tabs.map(t => ({ id: t.id,
    c: t._smoothCursor && t._smoothCursor._adapter ? t._smoothCursor._adapter.snapshot().counters.cursorDrawPasses : null,
    b: t._smoothCursor && t._smoothCursor._adapter ? t._smoothCursor._adapter.snapshot().counters.baseDrawPasses : null }));
  const adapters = adaptersAfter.map(a => { const b = adaptersBefore.find(x => x.id === a.id) || {};
    return { n: (b.n || a.id), cursorD: a.c != null && b.c != null ? a.c - b.c : null, baseD: a.b != null && b.b != null ? a.b - b.b : null }; });
  return { phase: '${name}', ms: Math.round(performance.now() - t0), rafCount: raf.length,
    gapP50: q(0.5), gapP95: q(0.95), gapMax: gaps[gaps.length - 1] || null,
    streamBytes: globalThis.__ztStreamBytes || {}, adapters,
    newLongTasks: window.__diag.longTasks.slice(lt0).slice(0, 10), newSlowEvents: window.__diag.slowEvents.slice(se0).slice(0, 10),
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
})()`);

// ── A: idle ──
const A = await phaseSample('idle', 10000);
console.log('[A idle]', JSON.stringify(A));

// ── B: hover sweeps (real CDP input over tab bar, then terminal area) ──
const rects = await val(`(() => {
  const bar = document.getElementById('tabbar').getBoundingClientRect();
  const term = document.querySelector('.term-wrap.active .term-inner');
  const tr = (term || document.querySelector('.term-wrap.active')).getBoundingClientRect();
  return { bar: { x: Math.round(bar.x), y: Math.round(bar.y + bar.height / 2), w: Math.round(bar.width) },
           term: { x: Math.round(tr.x), y: Math.round(tr.y + tr.height / 2), w: Math.round(tr.width) } };
})()`);
const sweep = async (label, r) => {
  val(`(async () => { const t0 = performance.now(); globalThis.__ztStreamBytes = {};
    const b0 = TabManager.tabs.map(t => ({ id: t.id, n: t.name, c: t._smoothCursor?._adapter?.snapshot().counters.cursorDrawPasses ?? null }));
    const raf = []; await new Promise(done => { const loop = t => { raf.push(t); if (t - t0 < 4000) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    window.__sweep = { t0, rafCount: raf.length, bytes0: JSON.parse(JSON.stringify(globalThis.__ztStreamBytes || {})), b0 }; return 'armed'; })()`).catch(() => {});
  for (let i = 0; i < 200; i++) {
    const x = r.x + 8 + ((r.w - 16) * (i % 100)) / 100;
    await send('Input.dispatchMouseEvent', { type: 'mouseMove', x: Math.round(x), y: r.y });
    await sleep(20);
  }
  await sleep(300);
  const res = await val(`(() => { const s = window.__sweep || {}; const raf = [];
    const gaps = []; return { rafCount: s.rafCount, streamBytes: globalThis.__ztStreamBytes || {},
      slowEvents: window.__diag.slowEvents.filter(e => e.at >= s.t0).slice(0, 12),
      longTasks: window.__diag.longTasks.filter(e => e.at >= s.t0).slice(0, 12) }; })()`);
  console.log(`[B ${label}]`, JSON.stringify(res));
  return res;
};
await sweep('tabbar', rects.bar);
await sweep('terminal', rects.term);

// ── C: switch sweep ──
const C = await val(`(async () => {
  const ids = TabManager.tabs.map(t => t.id);
  const out = [];
  for (let round = 0; round < 2; round++) {
    for (const id of ids) {
      await new Promise(r => setTimeout(r, 150));
      const t0 = performance.now();
      TabManager.switchTo(id);
      const sync = performance.now() - t0;
      await new Promise(r => requestAnimationFrame(r));
      const paint = performance.now() - t0;
      out.push({ id, syncMs: +sync.toFixed(1), paintMs: +paint.toFixed(1) });
    }
  }
  return out;
})()`);
console.log('[C switch]', JSON.stringify(C));

// Totals + DOM stats that contextualize the numbers.
const totals = await val(`(() => ({
  contexts: window.__diag.contexts,
  longTaskTotal: window.__diag.longTasks.length,
  longTaskSumMs: window.__diag.longTasks.reduce((s, t) => s + t.dur, 0),
  topLongTasks: [...window.__diag.longTasks].sort((a, b) => b.dur - a.dur).slice(0, 12),
  slowEventTotal: window.__diag.slowEvents.length,
  canvases: document.querySelectorAll('canvas').length,
  tabs: TabManager.tabs.length,
  wraps: document.querySelectorAll('.term-wrap').length,
  jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}))()`);
console.log('[totals]', JSON.stringify(totals));

const report = { at: new Date().toISOString(), idle: A, sweepTabbar: rects.bar, sweepTerminal: rects.term, switching: C, totals };
writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/stab-phase0-' + Date.now() + '.json', JSON.stringify(report, null, 2));
console.log('saved to artifacts/stab-phase0-*.json');
ws.close();
process.exit(0);
