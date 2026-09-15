// ADR-0001 Package A, step 1: bounded OLD-version sampling (baseline
// a1083a2 release exe). Real tab DOM + FABRICATED ssh state (tabs restored
// from a crafted config with no credentials — createTabSilent never sends
// ssh-connect; connected flags flipped via CDP for the visual state only).
// No servers, no user instances (unique probe image name).
// Records: per-frame rect fingerprints of ALL tabs (geometry changes),
// inline style mutations on tabs (layout writes), rAF gaps, plus a
// re-entry/boundary sweep modeled on the user's gesture. External heartbeat
// guards against the old freeze; everything is time-boxed.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe';
const IMG = 'zterm-probe-adra.exe';
const TMP = join(process.env.TEMP, 'zterm-adr-a');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
writeFileSync(join(TMP, 'data', 'config.json'), JSON.stringify({
  profiles: [], sshProfiles: [],
  lastTabs: [
    { name: '124.223.14.203 - UVSS a very long fabricated name for truncation testing', type: 'ssh', host: '10.0.0.1', port: 22, user: 'u', args: [], content: [] },
    { name: '192.168.41.88', type: 'ssh', host: '10.0.0.2', port: 22, user: 'u', args: [], content: [] },
    { name: '192.168.41.89', type: 'ssh', host: '10.0.0.3', port: 22, user: 'u', args: [], content: [] },
    { name: 'Git Bash', type: 'local', command: 'powershell.exe', args: [], content: [] },
    { name: 'Git Bash', type: 'local', command: 'powershell.exe', args: [], content: [] },
  ],
}));

const PORT = 9470;
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
const send = (method, params = {}, timeoutMs = 5000) => new Promise(resolve => {
  const i = ++id; const to = setTimeout(() => { pending.delete(i); resolve({ __timeout: true }); }, timeoutMs);
  pending.set(i, m => { clearTimeout(to); resolve(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const val = async (code, timeoutMs = 5000) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.__timeout) return '__TIMEOUT__';
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 150);
  return r.result?.result?.value;
};

for (let i = 0; i < 40; i++) {
  if ((await val(`document.querySelectorAll('#tabbar .tab').length`)) >= 5) break;
  await sleep(500);
}
// Fabricated connected state: renders the .tab-reconnect-normal slot
// WITHOUT any connection attempt (no credentials existed to connect with).
await val(`TabManager.tabs.forEach(t => { if (t.type === 'ssh') { t.connected = true; } }); TabManager.render(); 'fabricated'`);
await sleep(800);

// Observers: rect fingerprint per frame (geometry changes), MutationObserver
// on tab style attributes (layout writes), rAF gap log.
await val(`(() => {
  window.__a = { geo: 0, geoSamples: [], styleWrites: 0, gaps: [], events: 0 };
  const bar = document.getElementById('tabbar');
  const fp = () => [...bar.querySelectorAll('.tab')].map(el => { const r = el.getBoundingClientRect(); return Math.round(r.x) + ':' + Math.round(r.width); }).join('|');
  let last = fp();
  const loop = t => { const cur = fp(); if (cur !== last) { window.__a.geo++; window.__a.geoSamples.push(cur); last = cur; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  new MutationObserver(muts => { for (const m of muts) if (m.attributeName === 'style') window.__a.styleWrites++; })
    .observe(bar, { subtree: true, attributes: true, attributeFilter: ['style'] });
  let lf = performance.now();
  const l2 = t => { const g = t - lf; if (g > 30) window.__a.gaps.push({ at: Math.round(t), ms: Math.round(g) }); lf = t; requestAnimationFrame(l2); };
  requestAnimationFrame(l2);
  return 'armed';
})()`);

// Sweep program (time-boxed, mirrors the user's gesture classes):
//  S1 plain sweeps across all tabs (mouseover dispatch per tab, 3 rounds)
//  S2 boundary re-entry: long tab <-> neighbor alternation with short gaps
//  S3 the collapse-window storm (the historical freeze gesture)
const sweep = async (name, fn, ms) => {
  await val('window.__a.geo = 0; window.__a.styleWrites = 0; window.__a.gaps.length = 0; "reset"');
  const r = await val(`(async () => { const els = [...document.querySelectorAll('#tabbar .tab')];
    ${fn}
    return 'done'; })()`, ms + 8000);
  await sleep(600);
  const out = await val(`JSON.stringify({ phase: '${name}', result: ${JSON.stringify(r).slice(0, 40) ? 'arguments' : 'x'}, geo: window.__a.geo, styleWrites: window.__a.styleWrites, gaps: window.__a.gaps.slice(0, 6), geoFirst: window.__a.geoSamples[0] || null })`);
  console.log(out);
};

await sweep('S1-plain', `
  for (let round = 0; round < 3; round++) {
    for (const el of els) { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 60)); }
    for (let i = els.length - 1; i >= 0; i--) { els[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 60)); }
  }`, 3000);

await sweep('S2-reentry', `
  for (let i = 0; i < 30; i++) {
    els[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, i % 2 ? 20 : 100));
    els[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, i % 2 ? 20 : 100));
  }`, 5000);

await sweep('S3-storm', `
  for (let i = 0; i < 800; i++) {
    const el = els[i % 4 === 0 ? 0 : (i % 4)];
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    if (i % 7 === 0) document.getElementById('tabbar').dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise(r => setTimeout(r, 1));
  }`, 5000);

// Tooltip sanity: does a target tooltip appear for the long tab?
const tipShown = await val(`(async () => {
  const el = document.querySelectorAll('#tabbar .tab')[0];
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const tip = document.querySelector('.zt-tip');
  return tip && tip.classList.contains('show') ? tip.textContent.slice(0, 30) : 'NO-TOOLTIP';
})()`);
console.log('tooltip:', tipShown);

const total = await val(`JSON.stringify({ totalGeo: window.__a.geo, totalStyle: window.__a.styleWrites })`);
writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/adr-a-old-sample-' + Date.now() + '.json', JSON.stringify({ tooltip: tipShown, tail: total }));
console.log('OLD-SAMPLE DONE', total);
ws.close();
process.exit(0);
