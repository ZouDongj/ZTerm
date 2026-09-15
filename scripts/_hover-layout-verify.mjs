// Mechanical verification of the reconnect-slot fix, v2: use
// CSS.forcePseudoState to drive :hover per tab (synthetic input does NOT
// engage :hover in background windows — v1 was vacuous). A rAF sampler
// fingerprints every tab's {x,width} each frame; forcing/unforcing hover on
// every tab (dwell included) must produce ZERO layout changes, while the
// reconnect icon's computed opacity must actually toggle (non-vacuity).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-hover-fix2');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// unique image name: exit cleanup reaps ONLY this probe's tree by name
const PROBE_IMG = 'zterm-probe-' + (Math.random().toString(36).slice(2, 7)) + '.exe';
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, PROBE_IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9461;
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
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async code => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result?.result?.value;
};

for (let i = 0; i < 40; i++) {
  const n = await val(`document.querySelectorAll('#tabbar .tab').length`);
  if (typeof n === 'number' && n >= 3) break;
  await sleep(500);
}
// The reconnect slot renders as .tab-reconnect-normal only once an SSH tab
// CONNECTS (disconnected tabs get the amber .tab-reconnect variant). Wait for
// the connects — that's the state the bug lived in.
for (let i = 0; i < 50; i++) {
  const r = await val(`JSON.stringify({ spans: document.querySelectorAll('.tab-reconnect-normal').length, ssh: TabManager.tabs.filter(t => t.type === 'ssh' && t.connected).length })`);
  try { const j = JSON.parse(r); if (j.spans >= 1) break; } catch {}
  await sleep(500);
}

// Geometry sampler: per-frame fingerprint of every tab {x,width}.
await val(`(() => {
  window.__geo = { frames: 0, changes: 0, samples: [] };
  const fp = () => [...document.querySelectorAll('#tabbar .tab')].map(el => {
    const r = el.getBoundingClientRect();
    return Math.round(r.x) + ':' + Math.round(r.width);
  }).join('|');
  let last = fp();
  const loop = () => { const cur = fp(); window.__geo.frames++; if (cur !== last) { window.__geo.changes++; window.__geo.samples.push(cur); last = cur; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return 'armed';
})()`);

// Resolve DOM node ids for every tab, then force/unforce :hover on each.
await send('DOM.enable');
await send('CSS.enable');
const doc = await send('DOM.getDocument');
const tabs = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '#tabbar .tab' });
const nodeIds = tabs.result.nodeIds || [];
console.log('[tabs]', nodeIds.length);

let opacityToggled = false;
for (const nid of nodeIds) {
  await send('CSS.forcePseudoState', { nodeId: nid, forcedPseudoClasses: ['hover'] });
  await sleep(450);
  // Forced pseudo-states apply at computed-style resolution, NOT at DOM
  // selector matching — so read every reconnect span's computed opacity
  // instead of querying '.tab:hover ...' (that stays null by design).
  const op = await val(`Math.max(0, ...[...document.querySelectorAll('.tab-reconnect-normal')].map(el => parseFloat(getComputedStyle(el).opacity)))`);
  if (typeof op === 'number' && op > 0.1) opacityToggled = true;
  await send('CSS.forcePseudoState', { nodeId: nid, forcedPseudoClasses: [] });
  await sleep(450);
}
console.log('[reconnect opacity toggled on some tab]', opacityToggled);

const res = JSON.parse(await val('JSON.stringify(window.__geo)'));
console.log('[geometry]', JSON.stringify({ frames: res.frames, layoutChanges: res.changes, samples: res.samples.slice(0, 4) }));
const verdict = res.changes === 0 && opacityToggled;
console.log(verdict
  ? 'VERDICT: CLEAN — hover engaged (opacity toggled), zero layout shifts across ' + res.frames + ' frames'
  : 'VERDICT: BROKEN (layoutChanges=' + res.changes + ', opacityToggled=' + opacityToggled + ')');
ws.close();
process.exit(0);
