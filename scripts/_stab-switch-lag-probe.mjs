// Switch-lag probe: the user's real-machine sample was clean at every
// renderer layer while tab switching felt laggy, so measure the SWITCH
// MOMENT itself: rAF gaps timestamped against real mouse clicks on tabs,
// per-instance term.resize() durations (fit-on-switch flip-flop suspect),
// and input handler costs at a 16ms threshold (the hotkey's 50ms threshold
// hides one-frame hitches). Also exercises the hotkey sampler to debug the
// empty-timeline bug.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-switch-lag');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, 'ZTerm.exe'));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9458;
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
let id = 0; const pending = new Map(); const consoleLogs = [];
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160);
    if (m.params.type === 'error' || /perf-sample|Uncaught/.test(txt)) consoleLogs.push(m.params.type + ': ' + txt);
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 250);
  return r.result?.result?.value;
};

// settle
for (let i = 0; i < 45; i++) {
  const done = await val(`TabManager.tabs.filter(t => t.type === 'ssh').every(t => t.connected)`);
  if (done === true) break;
  await sleep(1000);
}
console.log('[settle]', await val(`TabManager.tabs.map(t => t.name).join(',')`));

// Instrument: per-instance term.resize timings + switch log + 16ms events +
// timestamped rAF gaps. All probe-side, zero app changes.
await val(`(() => {
  window.__sw = { resizes: [], switches: [], slowEvents: [], rafGaps: [] };
  for (const t of TabManager.tabs) {
    if (!t.term) continue;
    const orig = t.term.resize.bind(t.term);
    t.term.resize = function (cols, rows) {
      const s = performance.now();
      const r = orig(cols, rows);
      window.__sw.resizes.push({ tab: t.name, cols, rows, ms: +(performance.now() - s).toFixed(1) });
      return r;
    };
    const ow = t.term.write.bind(t.term);
    t.term.write = function (d) {
      const s = performance.now();
      const r = ow(d);
      const ms = performance.now() - s;
      if (ms > 8) window.__sw.switches.push({ kind: 'write', tab: t.name, bytes: String(d).length, ms: +ms.toFixed(1) });
      return r;
    };
  }
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration > 16) window.__sw.slowEvents.push({ type: e.name, dur: +e.duration.toFixed(1), at: Math.round(e.startTime) });
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  let last = performance.now();
  const loop = t => { const g = t - last; last = t; if (g > 12) window.__sw.rafGaps.push({ at: Math.round(t), ms: +g.toFixed(1) }); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const origSw = TabManager.switchTo.bind(TabManager);
  TabManager.switchTo = function (tid) {
    const s = performance.now();
    const r = origSw(tid);
    window.__sw.switches.push({ kind: 'switchTo', to: tid, ms: +(performance.now() - s).toFixed(1) });
    return r;
  };
  return 'armed';
})()`);

// Drive REAL clicks on each tab via the input pipeline, 2 rounds, 800ms apart.
const tabRects = await val(`(() => {
  const out = [];
  document.querySelectorAll('#tabbar .tab').forEach(el => { const r = el.getBoundingClientRect(); out.push({ id: el.dataset.tab, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); });
  return out;
})()`);
console.log('[tabs]', JSON.stringify(tabRects));
for (let round = 0; round < 2; round++) {
  for (const tr of tabRects) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tr.x, y: tr.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tr.x, y: tr.y, button: 'left', clickCount: 1 });
    await sleep(800);
  }
}
await sleep(500);
const res = await val(`JSON.stringify(window.__sw)`);
console.log('[switch-lag result]', res);

// Exercise the hotkey sampler to chase the empty-timeline bug.
await val(`(() => { const btn = document.createElement('button'); btn.id='__fire'; document.body.appendChild(btn);
  btn.onclick = () => { try { SHORTCUT_ACTIONS.perfCapture(); } catch (e) { console.error('hotkey-fire-fail', e); } };
  return typeof SHORTCUT_ACTIONS !== 'undefined' ? 'actions-found' : 'no-SHORTCUT_ACTIONS'; })()`).then(r => console.log('[hotkey]', r));
if (true) {
  const fired = await val(`document.getElementById('__fire').click(); 'fired'`);
  console.log('[hotkey fired]', fired);
  await sleep(4600);
  const tl = await val(`(() => { const m = window.__perfCapturing; return JSON.stringify({ capturing: m }); })()`);
  console.log('[hotkey state]', tl);
  console.log('[page errors]', consoleLogs.slice(-8).join('\n') || '(none)');
}

writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/stab-switchlag-' + Date.now() + '.json', res || '{}');
ws.close();
process.exit(0);
