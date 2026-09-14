// Multi-site icon/text alignment audit against the global svg
// vertical-align rule: measures icon center-Y vs adjacent text center-Y on
// every reachable icon+text pairing. Target |delta| <= 1.5px everywhere.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const PORT = 9412;
const t0 = Date.now();
const child = spawn('D:/Code/MyTerm/ZTerm/src-tauri/target/debug/zterm.exe', [], {
  env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\zterm-probe-${PORT}` },
  stdio: 'ignore',
});
process.on('exit', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} });
let page = null;
while (Date.now() - t0 < 25000) {
  try { const ts = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = ts.find(t => t.type === 'page' && t.url.includes('renderer.html')); if (page) break; } catch {}
  await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const val = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300);
  return r.result?.result?.value;
};
for (let i = 0; i < 30; i++) {
  if (await val(`typeof _settingsConfig === 'object' && !!TabManager.tabs.find(t => t.type === 'local')?.term`) === true) break;
  await sleep(600);
}

// fake SSH profiles for the SSH settings list
await val(`(() => {
  TabManager.sshProfiles = (TabManager.sshProfiles || []).filter(p => !String(p.id).startsWith('e2e-visual-'));
  TabManager.sshProfiles.push(
    { id: 'e2e-visual-1', name: '公司生产集群-华东一区前端静态资源服务器', type: 'ssh', host: '10.241.113.58', port: 60022, username: 'deploy-bot' });
  return true; })()`);

const measure = `(pair) => {
  const cy = (el) => { const b = el.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
  const icon = document.querySelector(pair.icon);
  const text = document.querySelector(pair.text);
  if (!icon || !text) return { site: pair.site, missing: true };
  return { site: pair.site, iconCy: +cy(icon).toFixed(2), textCy: +cy(text).toFixed(2), delta: +(cy(icon) - cy(text)).toFixed(2) };
}`;

const results = [];
// 1) statusbar icon vs statusbar text line
await val(`openSettings()`); await sleep(300); await val(`closeSettingsTab && closeSettings ? closeSettings() : TabManager.closeTab(TabManager.tabs.find(t=>t.type==='settings')?.id)`);
await sleep(400);
results.push(await val(`(${measure})({ site: 'statusbar sb-conn', icon: '#sb-conn .sb-conn-icon', text: '#sb-conn' })`));
// 2) settings tab in tabbar
results.push(await val(`openSettings()`)); await sleep(700);
results.push(await val(`(${measure})({ site: 'tab settings', icon: '#tabbar .tab .tab-lead-icon', text: '#tabbar .tab .tab-name' })`));
// 3) SSH settings list item
await val(`switchSettingsTab(document.querySelector(".settings-sidebar-item[onclick*='ssh']"), 'ssh')`); await sleep(500);
results.push(await val(`(${measure})({ site: 'ssh-item icon vs info', icon: '#settings-ssh-list .ssh-item-icon', text: '#settings-ssh-list .ssh-item-info' })`));
// 4) sftp footer buttons (static markup; open overlay without a session)
await val(() => {}, 0); await val(`document.getElementById('overlay-sftp').classList.add('open')`);
results.push(await val(`(${measure})({ site: 'sftp-footer upload btn', icon: '.sftp-footer button .ic-accent', text: '.sftp-footer button' })`));
await val(`document.getElementById('overlay-sftp').classList.remove('open')`);
// 5) menu popup
results.push(await val(`openMenuPopup ? openMenuPopup() : document.getElementById('menu-btn')?.click()`));
await sleep(300);
results.push(await val(`(${measure})({ site: 'menu icon vs label', icon: '#menu-popup .menu-item .menu-icon', text: '#menu-popup .menu-item .menu-label' })`));
await val(`closeMenuPopup()`);
// 6) session selector panel (open via overlay + injected list html)
results.push(await val(`(${measure})({ site: 'shell-visibility row title', icon: '#shell-visibility-list .toggle-switch', text: '#shell-visibility-list .settings-card-title' })`));
const summary = results.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n');
console.log(summary);
writeFileSync('artifacts/font-parity-20260913/align-audit.json', summary);
ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
process.exit(0);
