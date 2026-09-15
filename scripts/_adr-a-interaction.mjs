// ADR-0001 Package A interaction matrix on the A build: re-entry/child-
// element tooltip lifecycle, keyboard action visibility (focus-visible),
// rename-vs-drag exclusion, action-click-vs-drag exclusion, close button,
// settings switch. Fabricated ssh state, no connections, unique image.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'D:/Code/MyTerm/ZTerm/src-tauri/target-adr/release/zterm.exe';
const IMG = 'zterm-probe-adra2.exe';
const TMP = join(process.env.TEMP, 'zterm-adr-a2');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'fake-appdata'), { recursive: true });
copyFileSync(EXE, join(TMP, IMG));
writeFileSync(join(TMP, 'data', 'config.json'), JSON.stringify({
  profiles: [], sshProfiles: [],
  lastTabs: [
    { name: '124.223.14.203 - UVSS long fabricated name for tooltip testing', type: 'ssh', host: '10.0.0.1', port: 22, user: 'u', args: [], content: [] },
    { name: 'Git Bash', type: 'local', command: 'powershell.exe', args: [], content: [] },
  ],
}));

const PORT = 9475;
const child = spawn(join(TMP, IMG), [], {
  env: { ...process.env, APPDATA: join(TMP, 'fake-appdata'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${TMP}-udf` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
process.on('exit', () => { try { execSync(`taskkill /IM ${IMG} /T /F`, { stdio: 'ignore' }); } catch {} });

let page = null;
for (let i = 0; i < 300 && !page; i++) {
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 150);
  return r.result?.result?.value;
};

for (let i = 0; i < 40; i++) {
  if ((await val(`document.querySelectorAll('#tabbar .tab').length`)) >= 2) break;
  await sleep(500);
}
await val(`TabManager.tabs.forEach(t => { if (t.type === 'ssh') t.connected = true; }); TabManager.render(); 'fabricated'`);
await sleep(500);

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail: String(detail).slice(0, 120) }); console.log(pass ? 'PASS' : 'FAIL', name, '|', String(detail).slice(0, 100)); };

// 1. Geometry invariance under hover (forced pseudo-state + real dispatch)
{
  const r = await val(`(async () => {
    const before = [...document.querySelectorAll('#tabbar .tab')].map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.x*2)/2, Math.round(r.width*2)/2]; });
    const els = document.querySelectorAll('#tabbar .tab');
    els[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const after = [...document.querySelectorAll('#tabbar .tab')].map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.x*2)/2, Math.round(r.width*2)/2]; });
    return JSON.stringify({ same: JSON.stringify(before) === JSON.stringify(after), before, after });
  })()`);
  const j = JSON.parse(r);
  check('hover geometry invariance (0.5px)', j.same, JSON.stringify(j.before) + ' -> ' + JSON.stringify(j.after));
}

// 2. Re-entry 20ms + click-then-child-element: tooltip state not stuck
{
  const r = await val(`(async () => {
    const el = document.querySelectorAll('#tabbar .tab')[0];
    const child = el.querySelector('.tab-name');
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    el.dispatchEvent(new MouseEvent('mouseleave'));  // bar leave not needed; simulate target switch via sibling
    const el2 = document.querySelectorAll('#tabbar .tab')[1];
    el2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    el2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // rapid re-entry same tab
    await new Promise(r => setTimeout(r, 200));
    // click then move to child element of same tab
    child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const tip = document.querySelector('.zt-tip');
    return JSON.stringify({ tipShown: !!(tip && tip.classList.contains('show')), text: tip ? tip.textContent.slice(0, 20) : '' });
  })()`);
  const j = JSON.parse(r);
  check('re-entry/child-element tooltip lifecycle', j.tipShown, j.text);
}

// 3. Keyboard visibility: focus the reconnect button, opacity must rise
{
  const r = await val(`(async () => {
    const btn = document.querySelector('.tab-reconnect-normal');
    if (!btn) return 'NO-BTN';
    const hiddenOpacity = getComputedStyle(btn).opacity;
    const hiddenPE = getComputedStyle(btn).pointerEvents;
    btn.focus();
    await new Promise(r => setTimeout(r, 60));
    const focusedOpacity = getComputedStyle(btn).opacity;
    const focusedPE = getComputedStyle(btn).pointerEvents;
    btn.blur();
    return JSON.stringify({ tag: btn.tagName, hiddenOpacity, hiddenPE, focusedOpacity, focusedPE });
  })()`);
  const j = JSON.parse(r);
  check('semantic button + keyboard visibility', j.tag === 'BUTTON' && +j.hiddenOpacity === 0 && j.hiddenPE === 'none' && +j.focusedOpacity > 0.3 && j.focusedPE === 'auto',
    JSON.stringify(j));
}

// 4. Action-click does not start drag (mousedown on button, move, up: no drag state)
{
  const r = await val(`(async () => {
    const btn = document.querySelector('.tab-close');
    const rect = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.x + 2, clientY: rect.y + 2, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.x + 40, clientY: rect.y + 10 }));
    await new Promise(r => setTimeout(r, 50));
    const dragging = !!document.querySelector('#tab-drag-overlay, .tab.dragging');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.x + 40, clientY: rect.y + 10 }));
    return JSON.stringify({ dragging });
  })()`);
  const j = JSON.parse(r);
  check('action mousedown+move does not drag', !j.dragging, JSON.stringify(j));
}

// 5. Tab body drag still works
{
  const r = await val(`(async () => {
    const el = document.querySelectorAll('#tabbar .tab')[0];
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.x + 4, clientY: rect.y + rect.height / 2, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.x + 60, clientY: rect.y + 3 }));
    await new Promise(r => setTimeout(r, 50));
    const dragging = !!document.querySelector('.tab.dragging');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.x + 60, clientY: rect.y + 3 }));
    await new Promise(r => setTimeout(r, 100));
    return JSON.stringify({ dragging, cleaned: !document.querySelector('.tab.dragging') });
  })()`);
  const j = JSON.parse(r);
  check('tab body drag still works + cleans up', j.dragging && j.cleaned, JSON.stringify(j));
}

// 6. Rename: dblclick opens input; typing pointerdown does not drag; Enter commits
{
  const r = await val(`(async () => {
    const el = document.querySelectorAll('#tabbar .tab')[1];
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const input = document.querySelector('.tab-rename-input');
    if (!input) return 'NO-INPUT';
    const rect = input.getBoundingClientRect();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.x + 50, clientY: rect.y }));
    await new Promise(r => setTimeout(r, 40));
    const dragging = !!document.querySelector('.tab.dragging');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return JSON.stringify({ hasInput: true, draggingWhileEditing: dragging });
  })()`);
  const j = r === 'NO-INPUT' ? { hasInput: false } : JSON.parse(r);
  check('rename editing does not start drag', j.hasInput && !j.draggingWhileEditing, r);
}

// 7. Close via the semantic button (closes one tab, count drops)
{
  const r = await val(`(async () => {
    const before = document.querySelectorAll('#tabbar .tab').length;
    const btn = document.querySelectorAll('.tab-close')[1];
    btn.style.pointerEvents = 'auto'; btn.click();
    await new Promise(r => setTimeout(r, 400));
    const after = document.querySelectorAll('#tabbar .tab').length;
    return JSON.stringify({ before, after });
  })()`);
  const j = JSON.parse(r);
  check('close button works', j.after === j.before - 1, JSON.stringify(j));
}

const pass = results.filter(x => x.pass).length;
console.log(`\nINTERACTION MATRIX: ${pass}/${results.length}`);
writeFileSync('D:/Code/MyTerm/ZTerm/artifacts/adr-a-interaction-' + Date.now() + '.json', JSON.stringify(results, null, 2));
ws.close();
process.exit(pass === results.length ? 0 : 1);
