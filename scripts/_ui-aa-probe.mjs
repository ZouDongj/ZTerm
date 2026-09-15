// UI AA probe v2: analyze the status bar's plain gray text ("UTF-8" side is
// clean), excluding saturated (colored) pixels like status dots, so the
// metric reflects text anti-aliasing only. Compares default vs
// --disable-lcd-text.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { pngDecode } from './png-codec.mjs';

const PORT = Number(process.argv[2] ?? 9305);
const LCD_FLAG = process.argv.includes('--lcd-flag');
const t0 = Date.now();
const args = [`--remote-debugging-port=${PORT}`];
if (LCD_FLAG) args.push('--disable-lcd-text');
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe', [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args.join(' '),
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}`,
  },
  stdio: 'ignore',
});

// Tree-kill on every exit path (normal exit, process.exit, crash): a leaked
// zterm process tree orphans PTY bash/OpenConsole children, and orphaned
// MSYS2 processes hold cygwin console slots until new Git Bash sessions die
// with "console device allocation failure" (128-console cygwin limit).
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
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

for (let i = 0; i < 25; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`)) break;
  await sleep(600);
}
// status bar right side "UTF-8" — plain gray text, no icons
const M = JSON.parse(await val(`JSON.stringify((() => { const el = document.getElementById('sb-conn'); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`));
await sleep(400);
const s = await send('Page.captureScreenshot', {
  format: 'png', scale: 1,
  clip: { x: M.x - 2, y: M.y - 2, width: M.w + 6, height: M.h + 4, scale: 1 },
});
const file = `artifacts/font-parity-20260913/ui-text-${LCD_FLAG ? 'flag' : 'base'}.png`;
writeFileSync(file, Buffer.from(s.result.data, 'base64'));

const p = pngDecode(readFileSync(file));
let edge = 0, s15 = 0, ssum = 0, sat = 0;
for (let py = 0; py < p.height; py++) {
  for (let px = 0; px < p.width; px++) {
    const i = (py * p.width + px) * 4;
    const r = p.rgba[i], g = p.rgba[i + 1], b = p.rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 60) { sat++; continue; } // colored glyph/icon pixel
    const lum = (r + g + b) / 3;
    if (lum < 40 || lum > 190) continue;
    edge++; ssum += (max - min);
    if (max - min > 15) s15++;
  }
}
console.log(`${LCD_FLAG ? 'WITH --disable-lcd-text' : 'default LCD           '}:`, JSON.stringify({ edge, avgSpread: +(ssum / Math.max(1, edge)).toFixed(1), pctSpread15: +(100 * s15 / Math.max(1, edge)).toFixed(1), excludedSaturated: sat }));
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
