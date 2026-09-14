// End-to-end herdr scenario on the ZTerm mainline build: launch
// `herdr --session test` inside the real app, type in its input line, and
// count adapter retargets/draw passes. This is the acceptance scenario the
// whole caret-fix work exists for (ConPTY used to hide the real cursor
// inside herdr, so no animation ever ran).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.argv[2] ?? 9259);
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
const type = (s) => val(`ipcRenderer.send('pty-input', { tabId: TabManager.tabs.find(t => t.type === "local").tabId, data: ${JSON.stringify(s)} })`);

try { await send('Page.enable'); await send('Page.bringToFront'); } catch {}
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}

// wait for the shell prompt
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
await val(`window.__TAURI__.window.getCurrent().setFocus().catch(()=>{})`);
await sleep(2000);

// launch herdr in a scratch session (never the user's real session)
await type('herdr --session zterm-probe\r');
console.log('herdr launching, waiting for TUI...');
let herdrUp = false;
for (let i = 0; i < 40; i++) {
  herdrUp = await val(`(() => { const t = TabManager.tabs.find(t => t.type === "local");
    if (!t?.term?.buffer?.active) return false;
    // herdr is a fullscreen TUI: alt-screen is the hard signal
    if (t.term.buffer.active.type === 'alternate') return true;
    const b = t.term.buffer.active; let s = '';
    for (let i = Math.max(0, b.length - 20); i < b.length; i++) s += (b.getLine(i)?.translateToString(true) || '') + '\\n';
    return /herdr/i.test(s); })()`);
  if (herdrUp) break;
  await sleep(700);
}
console.log('herdr TUI (alt-screen) detected:', herdrUp, 'at', Date.now() - t0, 'ms');
await sleep(3000); // let it settle

const READ = `(() => { const a = TabManager.tabs.find(t => t.type === "local")._smoothCursor?._adapter;
  if (!a) return null;
  const i = a.instrumentation;
  return { retargets: (i.retargets || []).length, cursorDrawPasses: i.cursorDrawPasses, hidden: a.snapshot?.().cursorHidden ?? null }; })()`;
const base = await val(READ);
console.log('baseline in herdr:', JSON.stringify(base));

// type into the herdr input line through the real input path
for (const ch of 'abcd') { await type(ch); await sleep(450); }
await sleep(1500);
const after = await val(READ);
const dRet = after.retargets - base.retargets;
const dCursor = after.cursorDrawPasses - base.cursorDrawPasses;
console.log(`typing in herdr input: retarget delta=${dRet}, cursorDrawPass delta=${dCursor}`);
console.log(dRet >= 3 && dCursor >= dRet * 4
  ? '*** HERDR SCENARIO HEALTHY: cursor animation live inside herdr (the original pain point) ***'
  : 'herdr animation still starved — caret filter or visibility issue');
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
