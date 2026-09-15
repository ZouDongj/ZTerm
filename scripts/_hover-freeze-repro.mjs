// Freeze reproduction: stress the SSH<->SSH sweep with the animated hover
// expansion. Page-side loop alternates bubbling mouseover between two
// adjacent SSH tabs (drives tooltip IIFE + expand/collapse + CSS via forced
// pseudo-state in parallel), while a node-side heartbeat with timeout
// distinguishes:
//   - main-thread pinned  -> heartbeat eval times out
//   - GPU/compositor hung -> heartbeat answers but Page.captureScreenshot
//                            stalls or returns stale frames
// Report: frozen or not, rAF gaps during stress, expand/collapse counts.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-freeze-repro');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// unique image name: exit cleanup reaps ONLY this probe's tree by name
const PROBE_IMG = 'zterm-probe-' + (Math.random().toString(36).slice(2, 7)) + '.exe';
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, PROBE_IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9465;
const child = spawn(join(TMP, PROBE_IMG), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

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
const send = (method, params = {}, timeoutMs = 4000) => new Promise(resolve => {
  const i = ++id; const to = setTimeout(() => { pending.delete(i); resolve({ __timeout: true }); }, timeoutMs);
  pending.set(i, m => { clearTimeout(to); resolve(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const val = async (code, timeoutMs = 4000) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.__timeout) return '__TIMEOUT__';
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 150);
  return r.result?.result?.value;
};

for (let i = 0; i < 50; i++) {
  if ((await val(`TabManager.tabs.filter(t => t.type === 'ssh' && t.connected).length`)) === 3) break;
  await sleep(500);
}
console.log('[settle] ssh connected');

// Page-side monitor: rAF freeze detector + hover cycle counter.
await val(`(() => {
  window.__mon = { lastFrame: performance.now(), gaps: [], cycles: 0 };
  const l = t => { const g = t - window.__mon.lastFrame; if (g > 50) window.__mon.gaps.push({ at: Math.round(t), ms: Math.round(g) }); window.__mon.lastFrame = t; requestAnimationFrame(l); };
  requestAnimationFrame(l); return 'ok';
})()`);

// Page-side stress: alternate mouseover between tabs 1 and 2 (adjacent SSH),
// 25 switches/s for 30s. Also drives tooltip show/hide cycles.
await val(`window.__stress = setInterval(() => {
  window.__mon.cycles++;
  const els = document.querySelectorAll('#tabbar .tab');
  const el = els[window.__mon.cycles % 2 ? 1 : 2];
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}, 40); 'stress-armed'`);

// Node-side: parallel CSS :hover alternation (the slot max-width animation).
await send('DOM.enable'); await send('CSS.enable');
const doc = await send('DOM.getDocument');
const tabs = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '#tabbar .tab' });
const n1 = tabs.result.nodeIds[1], n2 = tabs.result.nodeIds[2];
let cssTick = 0;
const cssTimer = setInterval(() => {
  const on = (cssTick++ % 2) ? n2 : n1;
  const off = (cssTick % 2) ? n1 : n2;
  send('CSS.forcePseudoState', { nodeId: on, forcedPseudoClasses: ['hover'] }).catch(() => {});
  send('CSS.forcePseudoState', { nodeId: off, forcedPseudoClasses: [] }).catch(() => {});
}, 60);

// Heartbeat: 500ms cadence, 4s timeout = main-thread freeze.
let frozenAt = null, beats = 0;
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  const hb = await val(`performance.now()`, 4000);
  beats++;
  if (hb === '__TIMEOUT__') { frozenAt = Date.now() - t0; break; }
  await sleep(500);
  if (Date.now() - t0 > 32000) break;
}
clearInterval(cssTimer);
await val('clearInterval(window.__stress)');
const mon = await val(`JSON.stringify({ cycles: window.__mon.cycles, gaps: window.__mon.gaps.slice(0, 8), lastFrameAge: Math.round(performance.now() - window.__mon.lastFrame) })`, 4000);
console.log('[result] frozenAtMs=' + frozenAt, 'beats=' + beats, 'mon=' + mon);

// Screenshot sanity: if main thread alive but GPU hung, capture may stall.
if (frozenAt == null) {
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 40 }, 6000);
  console.log('[screenshot]', shot.__timeout ? 'STALLED (GPU suspect)' : 'ok ' + (shot.result ? shot.result.data.length : 0) + 'B');
}
console.log(frozenAt != null ? 'VERDICT: REPRODUCED main-thread freeze at +' + frozenAt + 'ms' : 'VERDICT: no freeze under synthetic stress');
ws.close();
process.exit(0);
