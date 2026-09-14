// R2 geometry verification: tabbar/main alignment, tab vs pane radius,
// statusbar transition presence + toggle heights.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9422;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
let page = null;
while (Date.now() - t0 < 25000) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); if (page) break; } catch {}
  await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true });
  if (r.exceptionDetails) return 'EXC: ' + r.exceptionDetails.exception?.description?.slice(0, 120);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}
console.log(await val(`(() => {
  const g = (f) => { try { return f(); } catch (e) { return 'ERR ' + e.message.slice(0, 40); } };
  return JSON.stringify({
    firstTabLeft: g(() => +document.getElementById('tabbar').getBoundingClientRect().left.toFixed(1)),
    mainLeft: g(() => +document.getElementById('main-area').getBoundingClientRect().left.toFixed(1)),
    alignDelta: g(() => +(document.getElementById('tabbar').getBoundingClientRect().left - document.getElementById('main-area').getBoundingClientRect().left).toFixed(1)),
    tabRadius: g(() => getComputedStyle(document.querySelector('#tabbar .tab')).borderRadius),
    paneRadius: g(() => { const p = document.querySelector('.split-pane'); return p ? getComputedStyle(p).borderRadius : 'no-pane'; }),
    sbTransition: g(() => getComputedStyle(document.querySelector('.statusbar')).transition.slice(0, 70)),
  }, null, 1); })()`));
await val(`toggleStatusbar()`);
await sleep(450);
console.log('after hide:', await val(`JSON.stringify({ hidden: document.body.classList.contains('hide-statusbar'), h: document.querySelector('.statusbar').getBoundingClientRect().height })`));
await val(`toggleStatusbar()`);
await sleep(450);
console.log('after show:', await val(`JSON.stringify({ hidden: document.body.classList.contains('hide-statusbar'), h: document.querySelector('.statusbar').getBoundingClientRect().height })`));
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
