// Freeze repro: the user's exact gesture, automated at maximum event rate —
// hover a LONG-NAME tab (expansion), then while it collapses, alternate
// mouseovers between it and its neighbors (a pointer crossing the sliding
// geometry). Heartbeat with timeout detects a pinned main thread; rAF gaps
// quantify the degradation. Run against the pre-fix exe first, then rebuilt.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const EXE = process.argv[2] || 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe';
const LABEL = process.argv[3] || 'a';
const TMP = join(process.env.TEMP, 'zterm-hover-storm-' + LABEL);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// Unique image name: the exit cleanup can then reap ONLY this probe's tree
// by image name (killing the shared 'zterm.exe' name would hit the user's
// real instance; killing by PID leaks children whose parent died first —
// that leak polluted the machine's GPU with whole zombie app instances).
const IMG = 'zterm-probe-' + LABEL + '.exe';
copyFileSync(EXE, join(TMP, IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = LABEL === 'a' ? 9466 : 9467;
const child = spawn(join(TMP, IMG), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

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
// Make tab[0] (UVSS) long enough to force a big expansion; arm monitors.
await val(`(() => {
  TabManager.tabs[0].name = TabManager.tabs[0].name + ' — long-name expansion test padding padding padding';
  TabManager.render();
  window.__mon = { lastFrame: performance.now(), gaps: [], events: 0 };
  const l = t => { const g = t - window.__mon.lastFrame; if (g > 30) window.__mon.gaps.push({ at: Math.round(t), ms: Math.round(g) }); window.__mon.lastFrame = t; requestAnimationFrame(l); };
  requestAnimationFrame(l);
  return 'ok';
})()`);
await sleep(2500);
await val('window.__mon.gaps.length = 0; "reset"');

// The user's gesture at maximum rate: expand tab[0], then IMMEDIATELY (during
// the 200ms collapse) storm alternating mouseovers between tab[0] and its
// neighbors, from page side (no round-trip bottleneck). 3 seconds per round,
// 3 rounds with the storm starting at 0/60/120ms after the leave.
for (let round = 0; round < 3; round++) {
  await val(`(async () => {
    const els = [...document.querySelectorAll('#tabbar .tab')];
    // hover the long tab (expand)
    els[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120 + ${round * 60}));
    // leave the bar (collapse starts), then storm alternation
    document.getElementById('tabbar').dispatchEvent(new MouseEvent('mouseleave'));
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 3000) {
      const el = els[(++n) % 4 === 0 ? 0 : (n % 4)];
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      if (n % 7 === 0) document.getElementById('tabbar').dispatchEvent(new MouseEvent('mouseleave'));
      window.__mon.events++;
      await new Promise(r => setTimeout(r, 1));
    }
    return n;
  })()`, 20000);
  await sleep(800);
}

const mon = await val(`JSON.stringify({ events: window.__mon.events, gaps: window.__mon.gaps.slice(0, 10), maxGap: window.__mon.gaps.reduce((m, g) => Math.max(m, g.ms), 0) })`, 6000);
console.log(`[${LABEL}]`, mon);
const j = JSON.parse(mon);
console.log(`[${LABEL}] VERDICT: ${j.maxGap > 250 ? 'DEGRADED/FREEZE-CLASS (maxGap ' + j.maxGap + 'ms)' : 'OK (maxGap ' + j.maxGap + 'ms over ' + j.events + ' events)'}`);
ws.close();
process.exit(0);
