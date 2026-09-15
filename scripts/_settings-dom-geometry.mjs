// DOM geometry of the settings "新建会话列表" group: exact rect relations of
// section title / group hint / card / rows / next section. Run against two
// builds (old release exe = before, rebuilt exe = after) to prove hint
// placement and spacing rhythm without pixel guessing.
// Usage: node scripts/_settings-dom-geometry.mjs <exePath> <port> <label>
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXE = process.argv[2] ?? 'D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe';
const PORT = Number(process.argv[3] ?? 9394);
const LABEL = process.argv[4] ?? 'run';
const t0 = Date.now();
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}`,
  },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {} });
let page = null;
while (Date.now() - t0 < 25000) {
  try {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html'));
    if (page) break;
  } catch {}
  await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

for (let i = 0; i < 25; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`)) break;
  await sleep(600);
}
await val(`openSettings()`);
await sleep(900);

const data = await val(`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
  const page = document.querySelector('.settings-page.active');
  const secs = [...page.querySelectorAll('.settings-section')];
  const sec = secs.find(s => s.textContent.includes('新建会话列表'));
  const card = document.getElementById('shell-visibility-list');
  // hint exists in exactly one of two forms: new static subtitle outside the
  // card, or the old injected desc inside the card
  const hint = page.querySelector('.settings-section-desc') || card.querySelector('.settings-card-desc');
  const rows = [...card.querySelectorAll('.settings-row')];
  const nextSec = secs[secs.indexOf(sec) + 1];
  const prevCard = (() => { // last card of the previous group ("启动")
    let el = sec.previousElementSibling;
    while (el && !el.classList.contains('settings-card')) el = el.previousElementSibling;
    return el;
  })();
  const secCs = getComputedStyle(sec);
  return JSON.stringify({
    hintClass: hint ? hint.className : null,
    hintInsideCard: hint ? card.contains(hint) : null,
    prevCardBottom: prevCard ? prevCard.getBoundingClientRect().bottom : null,
    section: r(sec), sectionFont: secCs.fontSize + ' w' + secCs.fontWeight + ' ls' + secCs.letterSpacing,
    hint: r(hint),
    card: r(card), cardPad: getComputedStyle(card).paddingTop + ' / ' + getComputedStyle(card).paddingBottom,
    rowCount: rows.length, firstRow: r(rows[0]), lastRow: r(rows[rows.length - 1]),
    nextSection: r(nextSec),
  }, null, 1); })()`);
console.log(`=== ${LABEL} (${EXE.includes('debug') ? 'debug/new' : 'release/old'}) ===`);
console.log(data);
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
