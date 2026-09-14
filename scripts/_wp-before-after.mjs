// Evidence capture for the three refinement packages. Injects representative
// fake SSH profiles (long name, user@ip:port), opens the requested surfaces,
// and saves native-scale screenshots. Usage:
//   node scripts/_wp-before-after.mjs <port> <label> [surfaces...]
// surfaces: main (tabs+terminal), settings (terminal tab), ssh (ssh mgmt)
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 9319);
const LABEL = process.argv[3] ?? 'before';
const SURFACES = process.argv.slice(4).length ? process.argv.slice(4) : ['main', 'settings', 'ssh'];
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
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`)) break;
  await sleep(600);
}
await sleep(1200);
// inject representative fake SSH profiles + open the SSH management list
await val(`(() => {
  TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => !String(p.id).startsWith('e2e-visual-'));
  TabManager.sshProfiles.push(
    { id: 'e2e-visual-1', name: '公司生产集群-华东一区前端静态资源服务器', type: 'ssh', host: '10.241.113.58', port: 60022, username: 'deploy-bot', password: '', encryptedPassword: '', privateKeyPath: '' },
    { id: 'e2e-visual-2', name: '开发测试机 Ubuntu 22.04', type: 'ssh', host: '192.168.41.88', port: 22, username: 'herdr', password: '', encryptedPassword: '', privateKeyPath: '' }
  );
  return TabManager.sshProfiles.length; })()`);

const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/wp-${LABEL}-${name}.png`, Buffer.from(s.result.data, 'base64'));
  console.log(`saved wp-${LABEL}-${name}.png`);
};
if (SURFACES.includes('main')) await shot('main');
if (SURFACES.includes('settings')) {
  await val(`openSettings()`);
  await sleep(900);
  await shot('settings');
}
if (SURFACES.includes('ssh')) {
  if (!(await val(`TabManager.tabs.some(t => t.type === 'settings')`))) { await val(`openSettings()`); await sleep(700); }
  await val(`document.querySelector(".settings-sidebar-item[onclick*='ssh']").click()`);
  await sleep(900);
  await shot('ssh');
}
// capture live computed values for the three packages
const data = await val(`(() => {
  const pick = (sel, props) => { const el = document.querySelector(sel); if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el); const o = { sel }; for (const p of props) o[p] = cs[p]; return o; };
  return JSON.stringify({
    sshName: pick('.ssh-item-name', ['fontSize', 'fontWeight', 'color']),
    sshDetail: pick('.ssh-item-detail', ['fontSize', 'fontWeight', 'color']),
    ddTrigger: pick('.cust-dropdown .dd-trigger', ['fontSize']),
    ddOption: pick('.cust-dropdown .dd-option', ['fontSize']),
    settingsDesc: pick('.settings-card-desc', ['fontSize', 'marginTop']),
    shellRowDesc: pick('#shell-visibility-list .settings-card-desc', ['fontSize', 'marginTop']),
    tab: pick('#tabbar .tab', ['fontSize', 'fontWeight', 'color']),
  }, null, 1); })()`);
console.log('live values:', data);
writeFileSync(`${OUT}/wp-${LABEL}-values.json`, String(data));
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
