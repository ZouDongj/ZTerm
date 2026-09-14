// Combined verification probe for the 2026-09-14 fix round. Against a
// rebuilt exe it checks, via live DOM + one screenshot:
//   A. accent swatch active ring is a visible outer ring (not same-color inset)
//   B. toggle ON background equals the full accent color
//   C. ssh-item icon center vs two-line text block center (alignment delta)
//   D. highlight rule preview pixels vs the chosen rule color (darkening?)
//   E. qc management list command font follows the UI/terminal font
// Usage: node scripts/_fix-verify-probe.mjs <exePath> <port>
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { pngDecode } from './png-codec.mjs';

const EXE = process.argv[2] ?? 'D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe';
const PORT = Number(process.argv[3] ?? 9396);
const OUT = 'artifacts/font-parity-20260913';
const t0 = Date.now();
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}`,
  },
  stdio: 'ignore',
});
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
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

for (let i = 0; i < 25; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`)) break;
  await sleep(600);
}

// Inject a highlight rule with a vivid reference color + fake SSH profiles.
const RULE_FG = '#00e5ff';
await val(`(() => {
  window._highlightRules = window._highlightRules || [];
  _highlightRules.length = 0;
  _highlightRules.push({ id: 'probe-hl', enabled: true, text: 'probe-cyan-token', isRegExp: false, isCaseSensitive: false, foreground: true, foregroundColor: '${RULE_FG}', background: false, backgroundColor: '', bold: false, italic: false, underline: false });
  TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => !String(p.id).startsWith('e2e-visual-'));
  TabManager.sshProfiles.push(
    { id: 'e2e-visual-1', name: '公司生产集群-华东一区前端静态资源服务器', type: 'ssh', host: '10.241.113.58', port: 60022, username: 'deploy-bot', password: '', encryptedPassword: '', privateKeyPath: '' },
    { id: 'e2e-visual-2', name: '开发测试机 Ubuntu 22.04', type: 'ssh', host: '192.168.41.88', port: 22, username: 'herdr', password: '', encryptedPassword: '', privateKeyPath: '' }
  );
  return true; })()`);
await val(`openSettings('ssh')`);
await sleep(600);

// A/B/C on the SSH settings page.
const sshData = await val(`(() => {
  const cs = (el) => getComputedStyle(el);
  const row = document.querySelector('#settings-ssh-list .ssh-item');
  const icon = row?.querySelector('.ssh-item-icon');
  const info = row?.querySelector('.ssh-item-info');
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), cy: +((b.top + b.bottom) / 2).toFixed(1), x: +b.left.toFixed(1), w: +b.width.toFixed(1) }; };
  return JSON.stringify({
    iconRect: icon ? r(icon) : null,
    infoRect: info ? r(info) : null,
    iconLineHeight: icon ? cs(icon).lineHeight : null,
    iconContent: icon ? icon.innerHTML.slice(0, 60) : null,
  }); })()`);
console.log('=== C. ssh-item alignment ===');
console.log(sshData);

// Appearance page: swatch ring + toggle color + qc font (settings quickcommands).
await val(`switchSettingsTab(document.querySelector(".settings-sidebar-item[onclick*='appearance']"), 'appearance')`);
await sleep(400);
const appData = await val(`(() => {
  const sw = document.querySelector('.accent-swatch.active') || document.querySelector('.accent-swatch');
  const swCs = sw ? getComputedStyle(sw) : null;
  // force-select the first swatch so the active ring exists for measurement
  if (sw && !sw.classList.contains('active')) { sw.classList.add('active'); }
  const tgOn = document.querySelector('.toggle-switch.on');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  return JSON.stringify({
    swatchShadow: swCs ? swCs.boxShadow : null,
    toggleOnBg: tgOn ? getComputedStyle(tgOn).backgroundColor : null,
    accentRgb: accent,
    toggleEqualsAccent: tgOn ? getComputedStyle(tgOn).backgroundColor === ('rgb(' + accent + ')') : null,
  }); })()`);
console.log('=== A/B. swatch ring + toggle accent ===');
console.log(appData);

await val(`switchSettingsTab(document.querySelector(".settings-sidebar-item[onclick*='quickcommands']"), 'quickcommands')`);
await sleep(400);
const qcData = await val(`(() => {
  const el = document.querySelector('#qc-commands-list .ssh-item-detail');
  return JSON.stringify({
    qcCmdFont: el ? getComputedStyle(el).fontFamily : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
    follows: el ? getComputedStyle(el).fontFamily === getComputedStyle(document.body).fontFamily : null,
  }); })()`);
console.log('=== E. qc command font ===');
console.log(qcData);

// D. highlight preview: open the highlight page, screenshot, pixel-sample the
// rule name color against the chosen ${RULE_FG}.
await val(`switchSettingsTab(document.querySelector(".settings-sidebar-item[onclick*='highlight']"), 'highlight'); renderHighlightRulesList()`);
await sleep(500);
const rect = await val(`(() => {
  const el = document.querySelector('#highlight-rules-list .ssh-item-name');
  if (!el) return null; const b = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }); })()`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}/fix-verify-highlight.png`, Buffer.from(shot.result.data, 'base64'));
let colorReport = 'rect missing';
if (rect) {
  const { x, y, w, h } = JSON.parse(rect);
  const { width, rgba } = pngDecode(readFileSync(`${OUT}/fix-verify-highlight.png`));
  let n = 0, rr = 0, gg = 0, bb = 0;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * width + px) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      // only bright cyan-ish pixels (the text itself), skip the card bg
      if (b > 90 && b > r + 40 && g > 90) { n++; rr += r; gg += g; bb += b; }
    }
  }
  colorReport = n === 0 ? 'no cyan pixels found' : `avg=rgb(${Math.round(rr / n)},${Math.round(gg / n)},${Math.round(bb / n)}) n=${n} chosen=${RULE_FG}`;
}
console.log('=== D. highlight preview color ===');
console.log(colorReport);
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
