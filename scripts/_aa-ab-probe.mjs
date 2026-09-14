// Single-variable A/B for allowTransparency (v2). Sample is written on a
// cleared screen at fixed rows; analysis is restricted to row 0 (plain ASCII)
// pixel band; foreground/background reference colors come from the live
// xterm theme. Metric: channel spread on true anti-aliasing edge pixels
// (RGB subpixel AA -> large spread; grayscale AA -> spread ~ 0).
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { pngDecode } from './png-codec.mjs';

const PORT = Number(process.argv[2] ?? 9287);
const OUT = 'artifacts/font-parity-20260913';
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/release/zterm.exe', [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}`,
  },
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
  if (await val(`!!TabManager.tabs.find(t => t.type === 'local')?.term?.element`)) break;
  await sleep(600);
}
// Clear screen, write 4 fixed rows; row 0 = plain ASCII (analysis target)
await val(`(() => { const t = TabManager.tabs.find(t => t.type === 'local').term;
  t.write('\\x1b[2J\\x1b[H');
  t.write('HEllO World 0123 HEllO World 0123\\r\\n');
  t.write('\\u4e2d\\u6587\\u6d4b\\u8bd5 \\u4f60\\u597d\\u4e16\\u754c\\r\\n');
  t.write('\\x1b[1mbold HEllO 0123\\x1b[0m\\r\\n');
  t.write('\\x1b[41mred bg HEllO\\x1b[0m\\r\\n');
  return true; })()`);
await sleep(1200);

const meta = await val(`(() => { const tab = TabManager.tabs.find(t => t.type === 'local');
  const t = tab.term;
  const d = t._core._renderService.dimensions;
  const c = [...t.element.querySelectorAll('canvas')].find(c => !c.className);
  const r = c.getBoundingClientRect();
  const th = t.options.theme;
  return JSON.stringify({ x: r.x, y: r.y, cellH: d.css.cell.height, fg: th.foreground, bg: th.background }); })()`);
const { x, y, cellH, fg, bg } = JSON.parse(meta);
console.log('meta:', JSON.stringify({ x, y, cellH, fg, bg }));

async function capture(label, allowTransparency) {
  await val(`(() => { const tab = TabManager.tabs.find(t => t.type === 'local');
    const t = tab.term;
    t.options.allowTransparency = ${allowTransparency};
    const renderer = t._core._renderService._renderer.value;
    // The glyph atlas caches LCD-rasterized glyphs from the previous mode;
    // clearing it forces re-rasterization under the new canvas alpha mode.
    try { renderer.clearTextureAtlas(); } catch (e) {}
    try { renderer._requestRedrawViewport(); } catch (e) {}
    return true; })()`);
  await sleep(1200);
  // clip = row 0 band only (ASCII row), plus padding rows for reference
  const shot = await send('Page.captureScreenshot', {
    format: 'png', scale: 1,
    clip: { x, y, width: 520, height: Math.ceil(cellH * 2.2), scale: 1 },
  });
  const file = `${OUT}/ab-${label}.png`;
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  return file;
}

const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const [FR, FG, FB] = hex2rgb(fg || '#abb2bf');
const [BR, BG, BB] = hex2rgb(bg || '#282c34');

function analyze(file) {
  const png = pngDecode(readFileSync(file));
  const { width, height, rgba } = png;
  let edge = 0, spreadSum = 0, spread15 = 0;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = (py * width + px) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const dFg = Math.abs(r - FR) + Math.abs(g - FG) + Math.abs(b - FB);
      const dBg = Math.abs(r - BR) + Math.abs(g - BG) + Math.abs(b - BB);
      if (dBg < 30) continue;   // pure background
      if (dFg < 45) continue;   // pure glyph interior
      // true AA transition pixel
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      edge += 1; spreadSum += spread;
      if (spread > 15) spread15 += 1;
    }
  }
  return { edge, avgSpread: +(spreadSum / Math.max(1, edge)).toFixed(1), pctSpread15: +(100 * spread15 / Math.max(1, edge)).toFixed(1) };
}

const pngA = await capture('transparency-false', 'false');
const pngB = await capture('transparency-true', 'true');
const a = analyze(pngA), b = analyze(pngB);
console.log('false (current):', JSON.stringify(a));
console.log('true  (Tabby)  :', JSON.stringify(b));
console.log(a.pctSpread15 > 30 && b.pctSpread15 < 8
  ? 'CONFIRMED: allowTransparency=false => RGB subpixel AA; true => grayscale AA'
  : a.pctSpread15 < 8 && b.pctSpread15 < 8
    ? 'BOTH grayscale: allowTransparency does not control AA here'
    : 'INCONCLUSIVE: inspect ab-*.png pairs');
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
