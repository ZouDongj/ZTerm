// Minimal step-debug of the phase0 probe's failing expressions.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-stab-debug');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, 'ZTerm.exe'));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9456;
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
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  return { exc: r.exceptionDetails ? (r.exceptionDetails.exception?.description || '').slice(0, 300) : null, v: r.result?.result?.value };
};

await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diag = { x: 1 };' });
console.log('1 pre-reload __diag:', JSON.stringify(await val('typeof window.__diag')));
await val('location.reload()');
await sleep(2000);
console.log('2 post-reload __diag:', JSON.stringify(await val('typeof window.__diag')));
console.log('3 visibility:', JSON.stringify(await val('document.visibilityState + "/" + document.hasFocus()')));
console.log('4 rAF fires:', JSON.stringify(await val('new Promise(res => { let n = 0; const t0 = performance.now(); const l = () => { n++; if (performance.now() - t0 > 1500) res(n + " rAFs in 1.5s"); else requestAnimationFrame(l); }; requestAnimationFrame(l); })')));
console.log('5 TabManager:', JSON.stringify(await val('typeof TabManager')));
ws.close();
process.exit(0);
