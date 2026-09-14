// Cursor smoothness probe v2: single-run self-controlled diff.
// baseline instrumentation -> type 7 chars via pty-input -> delta.
// Expected per keystroke: 1 retarget, ~14 cursor draw passes, sub-frame gaps.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.argv[2] ?? 9255);
const t0 = Date.now();
const child = spawn('src-tauri/target/release/zterm.exe', [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});

// Tree-kill on every exit path (normal exit, process.exit, crash): a leaked
// zterm process tree orphans PTY bash/OpenConsole children, and orphaned
// MSYS2 processes hold cygwin console slots until new Git Bash sessions die
// with "console device allocation failure" (128-console cygwin limit).
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
let page = null;
while (Date.now() - t0 < 25000) {
  try {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html'));
    if (page) break;
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

try { await send('Page.enable'); await send('Page.bringToFront'); } catch {}
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}

// wait for shell prompt in the local tab
for (let i = 0; i < 30; i++) {
  if (await val(`(() => { const t = TabManager.tabs.find(t => t.type === "local");
    if (!t?.term?.buffer?.active) return false;
    const b = t.term.buffer.active;
    for (let i = Math.max(0, b.length - 5); i < b.length; i++) {
      if (/\$|#|>/.test(b.getLine(i)?.translateToString(true) || '')) return true;
    }
    return false; })()`)) break;
  await sleep(700);
}
// foreground the window itself (Tauri), then settle
await val(`window.__TAURI__.window.getCurrent().setFocus().catch(()=>{})`);
await sleep(1500);

const READ = `(() => { const a = TabManager.tabs.find(t => t.type === "local")._smoothCursor?._adapter;
  if (!a) return null;
  const i = a.instrumentation;
  return { retargets: (i.retargets || []).length, cursorDrawPasses: i.cursorDrawPasses,
    baseDrawPasses: i.baseDrawPasses, lastNts: (i.drawTimestamps || []).slice(-16) }; })()`;
const base = await val(READ);
console.log('baseline:', JSON.stringify({ retargets: base.retargets, cursor: base.cursorDrawPasses, base: base.baseDrawPasses }));

for (const ch of 'abcdefg') {
  await val(`ipcRenderer.send('pty-input', { tabId: TabManager.tabs.find(t => t.type === "local").tabId, data: ${JSON.stringify(ch)} })`);
  await sleep(400);
}
await sleep(1500);
const after = await val(READ);
const bufOk = await val(`(() => { const t = TabManager.tabs.find(t => t.type === "local");
  const b = t.term.buffer.active; let s = '';
  for (let i = Math.max(0, b.length - 8); i < b.length; i++) s += (b.getLine(i)?.translateToString(true) || '');
  return s.includes('abcdefg'); })()`);

const dRet = after.retargets - base.retargets;
const dCursor = after.cursorDrawPasses - base.cursorDrawPasses;
const dBase = after.baseDrawPasses - base.baseDrawPasses;
const ts = after.lastNts || [];
let maxGap = 0;
for (let k = 1; k < ts.length; k++) maxGap = Math.max(maxGap, ts[k] - ts[k - 1]);
console.log(`echo in buffer: ${bufOk}`);
console.log(`delta over 7 keys: retargets=${dRet} cursorDrawPasses=${dCursor} baseDrawPasses=${dBase} recentMaxGap=${maxGap.toFixed(1)}ms`);
console.log(dRet >= 5 && dCursor >= dRet * 4
  ? 'ANIMATION HEALTHY: retargets per key with multi-pass cursor animation (baseline shape)'
  : 'animation starved — dig further');
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
