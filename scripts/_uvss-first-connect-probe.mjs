// Capture the first-attempt error text for each restored SSH tab (real
// config copy, isolated APPDATA + temp exe so nothing user-facing changes).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-uvss-first');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// unique image name: exit cleanup reaps ONLY this probe's tree by name
const PROBE_IMG = 'zterm-probe-' + (Math.random().toString(36).slice(2, 7)) + '.exe';
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, PROBE_IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9452;
const child = spawn(join(TMP, PROBE_IMG), [], {
  env: { ...process.env,
    APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

let page = null;
for (let i = 0; i < 80 && !page; i++) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); } catch {}
  await sleep(250);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const val = async code => {
  const r = await new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: code, returnByValue: true, awaitPromise: true } })); });
  if (r.exceptionDetails) return 'EXC';
  return r.result?.result?.value;
};
await val(`window.__ev = []; const t0 = performance.now();
  for (const k of ['ssh-connecting','ssh-connected','ssh-error'])
    ipcRenderer.on(k, (e, d) => __ev.push([Math.round(performance.now()-t0), k, d.rendererId, String(d.error||'').slice(0,110)]));`);
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  if ((await val(`__ev.filter(e=>e[1]==='ssh-connected').length`)) >= 3) break;
}
const ev = JSON.parse(await val('JSON.stringify(window.__ev)'));
for (const e of ev) console.log(JSON.stringify(e));
ws.close();
process.exit(0);
