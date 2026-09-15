// Hover expansion verification (post layer-isolation rework):
//   1. CSS-level slot reveal: forcePseudoState hover on an SSH tab → the
//      reconnect slot's computed opacity toggles AND the tab grows ~20px.
//   2. JS-level name expansion: rename a tab to a long name, dispatch a
//      bubbling mouseover (drives our delegated handler, unlike synthetic
//      input which cannot engage :hover) → width grows past the 180px cap;
//      bar mouseleave → collapses back.
//   3. rAF stays clean while the animations run (main-thread health).
//   4. The '+' button never leaves the bar.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.env.TEMP, 'zterm-hover-expand');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
// unique image name: exit cleanup reaps ONLY this probe's tree by name
const PROBE_IMG = 'zterm-probe-' + (Math.random().toString(36).slice(2, 7)) + '.exe';
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/ZTerm.exe', join(TMP, PROBE_IMG));
copyFileSync('D:/Code/MyTerm/ZTerm/src-tauri/target/release/data/config.json', join(TMP, 'data', 'config.json'));

const PORT = 9464;
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

// settle: tabs rendered + ssh connected (spans become -normal)
for (let i = 0; i < 50; i++) {
  if ((await val(`TabManager.tabs.filter(t => t.type === 'ssh' && t.connected).length`)) === 3) break;
  await sleep(500);
}
// rename tab[3] (a Git Bash) to a long name for the truncation scenario
await val(`TabManager.tabs[3].name = 'ZZTRUNCATE-' + 'very long git bash name '.repeat(4); TabManager.render(); TabManager.tabs[3].name`);
await sleep(400);

// rAF sampler for main-thread health during the animations. Arm, then wait
// out the boot-phase wiring (the last SSH terminal's xterm+WebGL init costs
// 200-400ms of main thread) and RESET before the hover tests, so only
// animation-window gaps count.
await val(`(() => { window.__raf = { gaps: [] }; let last = performance.now();
  const l = t => { const g = +(t - last).toFixed(1); if (g > 20) window.__raf.gaps.push({ at: Math.round(t), ms: g }); last = t; requestAnimationFrame(l); }; requestAnimationFrame(l); return 'ok'; })()`);
await sleep(2500);

const widthOf = (idx) => val(`Math.round(document.querySelectorAll('#tabbar .tab')[${idx}].getBoundingClientRect().width)`);

await val('window.__raf.gaps.length = 0');
// ── 1. slot reveal via forced hover on an SSH tab (index 1 = 41.88) ──
await send('DOM.enable'); await send('CSS.enable');
const doc = await send('DOM.getDocument');
const tabs = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '#tabbar .tab' });
const sshNid = tabs.result.nodeIds[1];
const w0 = await widthOf(1);
await send('CSS.forcePseudoState', { nodeId: sshNid, forcedPseudoClasses: ['hover'] });
await sleep(450); // let the 200ms animation settle
const w1 = await widthOf(1);
const op = await val(`(() => { const el = document.querySelectorAll('#tabbar .tab')[1].querySelector('.tab-reconnect-normal'); return el ? getComputedStyle(el).opacity : 'none'; })()`);
await send('CSS.forcePseudoState', { nodeId: sshNid, forcedPseudoClasses: [] });
await sleep(450);
const w1b = await widthOf(1);
console.log(`[slot] width ${w0} -> ${w1} -> ${w1b}, opacity=${op}`);
const slotOk = w1 - w0 >= 10 && Math.abs(w1b - w0) <= 3 && op !== 'none' && op !== '0';

// ── 2. name expansion via synthetic mouseover on the truncated tab ──
const wt0 = await widthOf(3);
const nameFull = await val(`document.querySelectorAll('#tabbar .tab')[3].querySelector('.tab-name').scrollWidth`);
await val(`(() => { const el = document.querySelectorAll('#tabbar .tab')[3]; el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 'sent'; })()`);
await sleep(500);
const wt1 = await widthOf(3);
const st1 = await val(`(() => { const el = document.querySelectorAll('#tabbar .tab')[3]; return JSON.stringify({ mw: el.style.maxWidth, connected: el.isConnected }); })()`);
await val(`(() => { document.getElementById('tabbar').dispatchEvent(new MouseEvent('mouseleave')); return 'left'; })()`);
await sleep(800);
const wt2 = await widthOf(3);
const st2 = await val(`(() => { const el = document.querySelectorAll('#tabbar .tab')[3]; return JSON.stringify({ mw: el.style.maxWidth }); })()`);
console.log(`[name] width ${wt0} -> ${wt1} -> ${wt2}, nameScrollWidth=${nameFull}, expandState=${st1}, afterLeave=${st2}`);
const nameOk = wt1 > 200 && (wt1 - wt0) >= (nameFull - wt0) * 0.85 && Math.abs(wt2 - wt0) <= 3;

// ── 3. rAF health + '+' button containment ──
const raf = await val(`(() => { const m = window.__mark || {}; return JSON.stringify({ marks: m, bigGaps: window.__raf.gaps.slice(0, 10) }); })()`);
const plusIn = await val(`(() => { const bar = document.getElementById('tabbar').getBoundingClientRect(); const b = document.getElementById('btn-add-tab').getBoundingClientRect(); return b.right <= bar.right + 1; })()`);
console.log(`[raf]`, raf, `[+ in bar]`, plusIn);
const marks = JSON.parse(raf).marks;
const bigGaps = JSON.parse(raf).bigGaps || [];
const worstGap = bigGaps.length ? bigGaps[0].ms : 0;

const verdict = slotOk && nameOk && worstGap <= 100 && plusIn === true;
console.log(`VERDICT: ${verdict ? 'CLEAN' : 'BROKEN'} (slot=${slotOk} name=${nameOk} worstGap=${worstGap} plusIn=${plusIn})`);
ws.close();
process.exit(0);
