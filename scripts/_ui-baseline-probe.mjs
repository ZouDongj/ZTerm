// UI typography baseline: computed font-size/weight/color for the elements in
// scope (tabs, status bar, settings rows, controls) plus WCAG contrast
// against the ACTUAL derived surface backgrounds. Config claims are ignored.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 9313);
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
// open the settings page so its elements exist
await val(`openSettings()`);
await sleep(900);

const data = await val(`(async () => {
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.85) return bg;
      n = n.parentElement;
    }
    return { r: 14, g: 16, b: 19, a: 1 };
  };
  const sample = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const bg = effBg(el);
    if (!fg) return { sel, color: cs.color };
    const er = Math.round(fg.r * fg.a + bg.r * (1 - fg.a));
    const eg = Math.round(fg.g * fg.a + bg.g * (1 - fg.a));
    const eb = Math.round(fg.b * fg.a + bg.b * (1 - fg.a));
    const L1 = lum(er, eg, eb), L2 = lum(bg.r, bg.g, bg.b);
    const ratio = +((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2);
    return { sel, fontSize: cs.fontSize, weight: cs.fontWeight, color: cs.color,
      effFg: 'rgb(' + er + ',' + eg + ',' + eb + ')', bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')', contrast: ratio };
  };
  const sels = [
    '#tabbar .tab', '#tabbar .tab.active', '.statusbar', '#sb-conn',
    '.settings-sidebar-item', '.settings-sidebar-item.active',
    '.settings-card-title', '.settings-card-desc', '.settings-card-control select',
    '.settings-card-control input', '.toggle-label', '.toggle-desc',
    '.menu-item', '.menu-label', '.menu-shortcut',
  ];
  return JSON.stringify({ tokens: {
    text1: getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim(),
    text2: getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim(),
    text3: getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim(),
    surfaceWin: getComputedStyle(document.documentElement).getPropertyValue('--surface-win').trim(),
    surfaceFloat: getComputedStyle(document.documentElement).getPropertyValue('--surface-float').trim(),
    surfaceCard: getComputedStyle(document.documentElement).getPropertyValue('--surface-card').trim(),
  }, samples: sels.map(sample) }, null, 1); })()`);
console.log(data);
writeFileSync('artifacts/font-parity-20260913/ui-baseline.json', String(data));
ws.close();
try { execSync(`taskkill /IM ${PROBE_IMG} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
