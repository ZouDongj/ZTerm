// ZTerm - Electron main process (PTY + SSH manager)
const { app, BrowserWindow, ipcMain, safeStorage, Menu, session, shell, dialog } = require('electron');
const { spawn } = require('node-pty');
const { execSync, spawnSync } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const russh = require('russh');
const sshBackend = require('./ssh-backend');
const sessionStore = require('./session-store');
const knownHosts = require('./known-hosts');

let mainWindow = null;
let appQuitting = false;
const ptyProcesses = {};   // tabId -> node-pty process
const sshConnections = {}; // tabId -> { stream, write, resize, close }
const cancelledTabIds = new Set(); // 连接建立过程中就被关闭的 tab（onReady 时立即回收）
const pendingHostKeyDecisions = {}; // tabId -> resolve(accept:boolean)，host key 不匹配时等待用户决定

// ── 凭据句柄存储：明文密码/私钥只存在主进程内存，renderer 只持有 credentialId ──
const credentialsStore = {}; // credentialId -> { password?, privateKeyContent?, passphrase? }
let nextCredId = 1;

function safeSend(channel, data) {
    if (!mainWindow || mainWindow.isDestroyed() || appQuitting) return;
    try { mainWindow.webContents.send(channel, data); } catch(e) {}
}

// IPC 来源校验：只接受主窗口自身的请求，防止潜在的 iframe/webview 越权调用
function isFromMainWindow(event) {
    return mainWindow && !mainWindow.isDestroyed() &&
           event.senderFrame === mainWindow.webContents.mainFrame;
}

let nextTabId = 1;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100, height: 720, minWidth: 600, minHeight: 400,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#abb2bf', height: 38 },
        backgroundColor: '#21252b',
        icon: path.join(__dirname, '..', 'build', 'icon.ico'),
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    // CSP：限制资源加载来源，防止 CDN 投毒/MITM 注入恶意脚本
    // style-src 'unsafe-inline' 因大量内联 style；font-src 允许 Google Fonts CDN
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'; " +
                    // script-src 'unsafe-inline' 因 renderer.html 中约 50 个内联 onclick/oninput 等，
                    // TODO: 迁移为 addEventListener 后可收紧为 'self'
                    "script-src 'self' 'unsafe-inline'; " +
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                    "font-src 'self' https://fonts.gstatic.com; " +
                    "img-src 'self' data:; " +
                    "connect-src 'self'"
                ],
            },
        });
    });

    // 阻止渲染进程导航到外部 URL（防止 xterm web-links 等触发远程页面加载到 Node 权限上下文）
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.loadFile('src/renderer.html');

    // Intercept keyboard shortcuts before Electron processes them
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.control && !input.shift && (input.key === 'f' || input.code === 'KeyF')) {
            event.preventDefault();
            safeSend('trigger-search');
        }
        if (input.type === 'keyDown' && input.control && input.shift && (input.key === 'h' || input.code === 'KeyH')) {
            event.preventDefault();
            safeSend('trigger-split-h');
        }
        if (input.type === 'keyDown' && input.control && input.shift && (input.key === 'v' || input.code === 'KeyV')) {
            event.preventDefault();
            safeSend('trigger-split-v');
        }
        // Ctrl+Shift+D: toggle DevTools (dev only - 生产环境禁用，防止键盘获取完整权限)
        if (input.type === 'keyDown' && input.control && input.shift && (input.key === 'd' || input.code === 'KeyD')) {
            if (!app.isPackaged) {
                event.preventDefault();
                if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
                else mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
        }
    });

    mainWindow.on('close', (event) => {
        if (!appQuitting) {
            // 先让渲染进程保存标签页状态，收到确认（或超时兜底）后再真正关闭
            event.preventDefault();
            safeSend('app-before-quit');
            setTimeout(() => {
                appQuitting = true;
                cleanupAll();
                if (mainWindow) mainWindow.destroy();
            }, 800);
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    ipcMain.on('quit-ready', () => {
        if (appQuitting) return;
        appQuitting = true;
        cleanupAll();
        if (mainWindow) mainWindow.destroy();
    });

    ipcMain.on('window-minimize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    });
    ipcMain.on('window-maximize', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
        // Window state change steals focus; tell renderer to refocus terminal
        setTimeout(() => safeSend('refocus-terminal'), 250);
    });

    // Also refocus after manual window resize (e.g. drag corner)
    mainWindow.on('resize', () => {
        safeSend('refocus-terminal');
    });

    // Sync maximize state so renderer can drop border-radius / margins when full-screen
    mainWindow.on('maximize', () => safeSend('window-state-changed', { maximized: true }));
    mainWindow.on('unmaximize', () => safeSend('window-state-changed', { maximized: false }));
    mainWindow.webContents.on('did-finish-load', () => {
        safeSend('window-state-changed', { maximized: mainWindow.isMaximized() });
    });

    ipcMain.on('window-close', () => {
        appQuitting = true;
        cleanupAll();
        if (mainWindow) mainWindow.destroy();
    });
}

function cleanupAll() {
    Object.keys(sftpTransfers).forEach(_cancelSftpTransfers);
    Object.values(ptyProcesses).forEach(p => { try { p.kill(); } catch(e) {} });
    Object.values(sshConnections).forEach(s => { try { s.close(); } catch(e) {} });
}

// ── PTY handlers ──

ipcMain.on('pty-create', (event, { shell, args, cwd, requestId }) => {
    if (!isFromMainWindow(event)) return;
    const tabId = 'tab_' + (nextTabId++);
    const sh = shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const ptyCwd = cwd || process.env.USERPROFILE || process.env.HOME || '.';

    let pty;
    try {
        pty = spawn(sh, Array.isArray(args) ? args : [], {
            name: 'xterm-256color',
            cols: 80, rows: 24,
            cwd: ptyCwd,
            env: process.env,
        });
    } catch(e) {
        // ConPTY 对含空格路径偶发失败，回退 winpty
        try {
            pty = spawn(sh, Array.isArray(args) ? args : [], {
                name: 'xterm-256color',
                cols: 80, rows: 24,
                cwd: ptyCwd,
                env: process.env,
                useConpty: false,
            });
        } catch(e2) {
            event.reply('pty-created', { tabId, requestId, spawnError: sh + ' - ' + e2.message });
            return;
        }
    }

    pty.onData((data) => { safeSend('pty-output', { tabId, data }); });
    pty.onExit(() => {
        safeSend('pty-exit', { tabId });
        delete ptyProcesses[tabId];
    });

    ptyProcesses[tabId] = pty;
    event.reply('pty-created', { tabId, requestId });
});

// ── Local shell detection（类似 Windows Terminal 的动态配置检测）──

function _which(name) {
    return _whichAll(name)[0] || null;
}

function _whichAll(name) {
    try {
        // 使用 spawnSync 传数组参数，不经 shell，杜绝命令注入
        const result = spawnSync('where', [name], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        return result.stdout.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch(e) { return []; }
}

function detectLocalShells() {
    const shells = [];
    const add = (id, name, command, args, icon) => shells.push({ id, name, type: 'local', command, args: args || [], icon: icon || 'local' });

    // PowerShell 7（需单独安装，检测 PATH）
    if (_which('pwsh.exe')) add('pwsh', 'PowerShell', 'pwsh.exe');
    // Windows PowerShell / CMD（Windows 自带）
    add('powershell', 'Windows PowerShell', 'powershell.exe');
    add('cmd', 'Command Prompt', 'cmd.exe');
    // Git Bash：注册表（GitForWindows InstallPath）→ Program Files 常见路径 → git.exe 位置推导
    const gitBashCandidates = [
        process.env['ProgramFiles'] && process.env['ProgramFiles'] + '\\Git\\bin\\bash.exe',
        process.env['ProgramFiles(x86)'] && process.env['ProgramFiles(x86)'] + '\\Git\\bin\\bash.exe',
        process.env['LOCALAPPDATA'] && process.env['LOCALAPPDATA'] + '\\Programs\\Git\\bin\\bash.exe',
    ].filter(Boolean);
    ['HKLM', 'HKCU'].forEach(hive => {
        try {
            // 使用 spawnSync 传数组，不经 shell，杜绝命令注入
            const out = spawnSync('reg', ['query', hive + '\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).stdout.toString();
            const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/);
            if (m) gitBashCandidates.unshift(m[1].trim() + '\\bin\\bash.exe');
        } catch(e) {}
    });
    _whichAll('git.exe').forEach(g => {
        // <root>\cmd\git.exe → <root>\bin\bash.exe
        gitBashCandidates.push(path.join(path.dirname(path.dirname(g)), 'bin', 'bash.exe'));
    });
    const gitBash = [...new Set(gitBashCandidates)].find(p => fs.existsSync(p));
    if (gitBash) add('gitbash', 'Git Bash', gitBash, ['--login', '-i'], 'term');
    // WSL
    if (_which('wsl.exe')) add('wsl', 'WSL', 'wsl.exe', [], 'term');

    return shells;
}

ipcMain.handle('get-local-shells', () => detectLocalShells());

// ── SSH handlers ──

ipcMain.on('ssh-connect', (event, { profile, rendererId }) => {
    if (!isFromMainWindow(event)) return;
    // 端口范围校验
    const port = Number(profile.port) || 22;
    if (!(port > 0 && port < 65536)) return;
    const tabId = 'tab_' + (nextTabId++);
    let settled = false;

    // Manual timeout (30s) — covers both TCP connect and SSH handshake
    const timer = setTimeout(() => {
        if (!settled) {
            settled = true;
            safeSend('ssh-error', { tabId, rendererId, error: 'Connection timed out (30s)' });
            const s = sshConnections[tabId];
            if (s) { try { s.close(); } catch(e) {}; delete sshConnections[tabId]; }
            if (rawClient) { try { rawClient.cancel(); } catch(e) {} }
        }
    }, 30000);

    const callbacks = {
        onReady(sshConn) {
            if (settled || cancelledTabIds.has(tabId)) {
                cancelledTabIds.delete(tabId);
                settled = true;
                clearTimeout(timer);
                try { sshConn.close(); } catch(e) {};
                return;
            }
            settled = true;
            clearTimeout(timer);
            sshConnections[tabId] = sshConn;
            safeSend('ssh-connected', { tabId, rendererId });
        },
        onData(data) {
            // ssh2 emits Buffer; convert to string for xterm compatibility
            const str = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
            // Parse OSC 7 for cwd tracking
            const osc7 = str.match(/\x1b\]7;file:\/\/[^/\x07\x1b\\]*(\/[^\x07\x1b\\]*?)(?:\x07|\x1b\\)/);
            if (osc7) {
                const ssh = sshConnections[tabId];
                if (ssh && ssh.cwd !== osc7[1]) {
                    ssh.cwd = osc7[1];
                    safeSend('sftp-cwd-changed', { tabId, cwd: osc7[1] });
                }
            }
            safeSend('pty-output', { tabId, data: str });
        },
        onDebug(msg) {
            // Forward SSH negotiation messages as terminal output
            safeSend('pty-output', { tabId, data: '\x1b[2m' + msg + '\x1b[0m\r\n' });
        },
        onExit(code) {
            clearTimeout(timer);
            safeSend('ssh-disconnected', { tabId, rendererId });
            // shell 退出后连接本体（transport + SFTP channel）也要释放，否则泄漏且被 keepalive 永久保活
            const s = sshConnections[tabId];
            if (s) { try { s.close(); } catch(e) {}; delete sshConnections[tabId]; }
            _cancelSftpTransfers(tabId);
        },
        onError(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { rawClient.cancel(); } catch(e) {}
            safeSend('ssh-error', { tabId, rendererId, error: err.message || 'SSH connection failed' });
            delete sshConnections[tabId];
        },
        onHostKey(key) {
            // TOFU: 首次连接记录指纹，已知且匹配放行，不匹配需用户确认
            const host = profile.host;
            const result = knownHosts.check(host, port, key);
            if (result.status === 'known') return true;
            if (result.status === 'unknown') {
                knownHosts.trust(host, port, key);
                return true;
            }
            // mismatch: 指纹变更，可能 MITM，需用户确认
            return new Promise((resolve) => {
                pendingHostKeyDecisions[tabId] = (accept, doTrust) => {
                    if (accept && doTrust) knownHosts.trust(host, port, key);
                    resolve(accept);
                };
                safeSend('ssh-hostkey-mismatch', {
                    tabId, rendererId,
                    host, port,
                    oldFingerprint: result.oldFingerprint,
                    oldAlgorithm: result.oldAlgorithm,
                    newFingerprint: result.newFingerprint,
                    newAlgorithm: result.newAlgorithm,
                });
            });
        },
    };

    // 从凭据句柄查表补全明文（renderer 不持有明文密码/私钥内容）
    const cred = profile.credentialId ? credentialsStore[profile.credentialId] : null;
    const rawClient = sshBackend.createSSHConnection({
        host: profile.host,
        port: port,
        username: profile.username,
        password: cred ? cred.password : null,
        privateKey: cred ? cred.privateKeyContent : null,
        passphrase: cred ? cred.passphrase : null,
        followCwd: profile.followCwd === true,
        loginScripts: profile.loginScripts || [],
        cols: 80, rows: 24,
    }, callbacks);

    event.reply('ssh-connecting', { tabId, rendererId });
});

ipcMain.on('ssh-disconnect', (event, { tabId }) => {
    if (!isFromMainWindow(event)) return;
    const s = sshConnections[tabId];
    if (s) {
        try { s.close(); } catch(e) {}
        delete sshConnections[tabId];
    } else {
        // 连接还没建立完成（in-flight），记录取消，onReady 时立即回收
        cancelledTabIds.add(tabId);
    }
    _cancelSftpTransfers(tabId);
});

// 用户对 host key 不匹配的决定：accept(仅本次/更新信任) 或 reject
ipcMain.on('ssh-hostkey-decision', (event, { tabId, accept, trust }) => {
    if (!isFromMainWindow(event)) return;
    const resolve = pendingHostKeyDecisions[tabId];
    if (resolve) {
        delete pendingHostKeyDecisions[tabId];
        resolve(accept, trust);
    }
});

ipcMain.on('pty-input', (event, { tabId, data }) => {
    if (!isFromMainWindow(event)) return;
    const pty = ptyProcesses[tabId];
    if (pty) { try { pty.write(data); } catch(e) {} return; } // 进程退出竞态窗口内 write 会 throw
    const ssh = sshConnections[tabId];
    if (ssh) { ssh.write(data); }
});

ipcMain.on('pty-resize', (event, { tabId, cols, rows }) => {
    if (!isFromMainWindow(event)) return;
    if (!(cols > 0) || !(rows > 0)) return; // 布局塌陷/最小化时的非法尺寸直接丢弃
    const pty = ptyProcesses[tabId];
    if (pty) { try { pty.resize(cols, rows); } catch(e) {} return; }
    const ssh = sshConnections[tabId];
    if (ssh) { ssh.resize(cols, rows); }
});

ipcMain.on('pty-destroy', (event, { tabId }) => {
    if (!isFromMainWindow(event)) return;
    const pty = ptyProcesses[tabId];
    const ssh = sshConnections[tabId];
    if (pty) { try { pty.kill(); } catch(e) {} delete ptyProcesses[tabId]; }
    if (ssh) { try { ssh.close(); } catch(e) {}; delete sshConnections[tabId]; }
    if (!pty && !ssh) cancelledTabIds.add(tabId); // 什么都没有 = SSH 连接还在建立中，onReady 时回收
    _cancelSftpTransfers(tabId);
    event.reply('pty-destroyed', { tabId });
});

// ── Password encryption (safeStorage) ──

ipcMain.on('encrypt-password', (event, { plaintext }) => {
    if (!isFromMainWindow(event)) return;
    if (!safeStorage.isEncryptionAvailable()) {
        event.reply('encrypt-password-result', { error: 'Encryption not available' });
        return;
    }
    try {
        const encrypted = safeStorage.encryptString(plaintext);
        event.reply('encrypt-password-result', { encrypted: encrypted.toString('base64') });
    } catch (e) {
        event.reply('encrypt-password-result', { error: e.message });
    }
});

ipcMain.on('decrypt-password', (event, { encrypted, requestId }) => {
    if (!isFromMainWindow(event)) return;
    if (!safeStorage.isEncryptionAvailable()) {
        event.reply('decrypt-password-result', { error: 'Encryption not available', requestId });
        return;
    }
    try {
        const buf = Buffer.from(encrypted, 'base64');
        const plaintext = safeStorage.decryptString(buf);
        event.reply('decrypt-password-result', { plaintext, requestId });
    } catch (e) {
        event.reply('decrypt-password-result', { error: e.message, requestId });
    }
});

// ── Credential handle (明文密码/私钥只存主进程内存，renderer 只拿 credentialId) ──

// 注册凭据：renderer 传加密密码(由主进程解密) + 私钥路径(由主进程读取内容)，返回 credentialId
// renderer 永不接触明文密码或私钥内容
ipcMain.handle('register-credential', async (event, { encryptedPassword, encryptedPassphrase, privateKeyPath }) => {
    if (!isFromMainWindow(event)) return { error: 'Forbidden' };
    const cred = { password: null, privateKeyContent: null, passphrase: null };
    try {
        if (encryptedPassword && safeStorage.isEncryptionAvailable()) {
            cred.password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
        }
        if (encryptedPassphrase && safeStorage.isEncryptionAvailable()) {
            cred.passphrase = safeStorage.decryptString(Buffer.from(encryptedPassphrase, 'base64'));
        }
        if (privateKeyPath) {
            // 路径穿越防护：拒绝含 .. 的相对路径操纵
            const normalized = path.normalize(privateKeyPath);
            if (normalized !== privateKeyPath || !path.isAbsolute(normalized)) return { error: 'Invalid path' };
            if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) return { error: 'Not a file' };
            // 私钥文件内容由主进程读取，renderer 只传路径（路径不是敏感凭据）
            cred.privateKeyContent = fs.readFileSync(normalized, 'utf-8');
        }
    } catch (e) {
        return { error: e.message };
    }
    const credId = 'cred_' + (nextCredId++);
    credentialsStore[credId] = cred;
    return { credId };
});

// 注销凭据：tab 关闭时调用，从内存清除明文
ipcMain.on('revoke-credential', (event, { credId }) => {
    if (!isFromMainWindow(event)) return;
    if (credentialsStore[credId]) {
        credentialsStore[credId].password = null;
        credentialsStore[credId].privateKeyContent = null;
        credentialsStore[credId].passphrase = null;
        delete credentialsStore[credId];
    }
});

// ── Profiles & Config ──

ipcMain.on('get-profiles', (event) => {
    if (!isFromMainWindow(event)) return;
    event.reply('profiles', {
        profiles: sessionStore.getProfiles(),
        sshProfiles: sessionStore.getSSHProfiles(),
        lastTabs: sessionStore.loadLastTabs(),
    });
});

ipcMain.on('save-ssh-profiles', (event, { sshProfiles }) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveSSHProfiles(sshProfiles);
    event.reply('ssh-profiles-saved');
});

ipcMain.on('save-last-tabs', (event, tabs) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveLastTabs(tabs);
});

ipcMain.on('save-appearance', (event, appearance) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveAppearance(appearance);
});

// ── Transfer history ──

ipcMain.on('save-transfer-history', (event, history) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveTransferHistory(history);
});

ipcMain.on('get-transfer-history', (event) => {
    if (!isFromMainWindow(event)) return;
    event.reply('transfer-history', sessionStore.getTransferHistory());
});

// ── Quick Commands ──

ipcMain.on('get-quick-commands', (event) => {
    if (!isFromMainWindow(event)) return;
    event.reply('quick-commands', sessionStore.getQuickCommands());
});

ipcMain.on('save-quick-commands', (event, commands) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveQuickCommands(commands);
});

// ── Highlight rules ──

ipcMain.on('get-highlight-rules', (event) => {
    if (!isFromMainWindow(event)) return;
    event.reply('highlight-rules', {
        rules: sessionStore.getHighlightRules(),
        settings: sessionStore.getHighlightSettings(),
    });
});

ipcMain.on('save-highlight-rules', (event, { rules, settings }) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveHighlightRules(rules);
    if (settings) sessionStore.saveHighlightSettings(settings);
});

// ── Shortcuts ──

ipcMain.on('save-shortcuts', (event, shortcuts) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveShortcuts(shortcuts);
});

// ── Data directory ──

ipcMain.handle('get-data-dir-info', async (event) => {
    if (!isFromMainWindow(event)) return { error: 'Forbidden' };
    return sessionStore.getDataDirInfo();
});

ipcMain.handle('set-data-dir', (event, { dir }) => {
    if (!isFromMainWindow(event)) return;
    try {
        if (!dir || dir === sessionStore.getDataDirInfo().defaultDir) sessionStore.resetDataDir();
        else {
            if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: 'Invalid directory' };
            sessionStore.setCustomDataDir(dir);
        }
        return { ok: true, info: sessionStore.getDataDirInfo() };
    } catch(e) { return { error: e.message }; }
});

// ── About info（运行时动态读取版本）──

function _pkgVersion(name) {
    const roots = [
        path.join(__dirname, '..'),                                   // dev / asar 内
        path.join(process.resourcesPath || '', 'app.asar.unpacked'),  // 打包 unpack 内
    ];
    for (const root of roots) {
        try {
            const p = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')).version || '';
        } catch(e) {}
    }
    return '';
}

ipcMain.handle('get-about-info', async (event) => {
    if (!isFromMainWindow(event)) return { error: 'Forbidden' };
    return {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        xterm: _pkgVersion('@xterm/xterm'),
        russh: _pkgVersion('russh'),
    };
});

// ── Open in explorer ──
ipcMain.on('open-in-explorer', (event, { path: filePath }) => {
    if (!isFromMainWindow(event)) return;
    if (filePath && path.isAbsolute(filePath) && path.normalize(filePath) === filePath) shell.showItemInFolder(filePath);
});

ipcMain.on('save-terminal-settings', (event, terminal) => {
    if (!isFromMainWindow(event)) return;
    sessionStore.saveTerminalSettings(terminal);
});

// ── System fonts ──
ipcMain.handle('get-system-fonts', async () => {
    try {
        const fontManager = require('fontmanager-redux');
        return new Promise((resolve) => {
            fontManager.getAvailableFonts((fonts) => {
                const families = [...new Set(fonts.map(f => f.family.trim()))].sort();
                resolve(families);
            });
        });
    } catch (e) {
        return [];
    }
});

// ── SFTP handlers (russh API) ──
function _sftpOf(tabId) {
    const ssh = sshConnections[tabId];
    return ssh && ssh.sftp ? ssh.sftp : null;
}

function _sftpTransferOf(tabId) {
    const ssh = sshConnections[tabId];
    return ssh && ssh.sftpTransfer ? ssh.sftpTransfer : null;
}

function _homeDir(tabId) {
    const ssh = sshConnections[tabId];
    return ssh && ssh.username ? '/home/' + ssh.username : '/';
}

function _sftpTypeToIsDir(type) {
    return type === 0; // russh.SFTPFileType.Directory
}
function _sftpTypeToIsLink(type) {
    return type === 2; // russh.SFTPFileType.Symlink
}

const sftpTransfers = {}; // tabId -> { transferId -> { cancelled: boolean } }

function _cleanupTransfer(tabId, transferId) {
    if (!sftpTransfers[tabId]) return;
    delete sftpTransfers[tabId][transferId];
    if (Object.keys(sftpTransfers[tabId]).length === 0) delete sftpTransfers[tabId];
}

// tab 关闭/SSH 断开时标记取消所有进行中传输（传输循环下一轮自行抛出并清理）
function _cancelSftpTransfers(tabId) {
    const t = sftpTransfers[tabId];
    if (t) Object.values(t).forEach(x => { x.cancelled = true; });
}

ipcMain.on('sftp-cancel-transfer', (event, { tabId, transferId }) => {
    if (!isFromMainWindow(event)) return;
    if (sftpTransfers[tabId] && sftpTransfers[tabId][transferId]) {
        sftpTransfers[tabId][transferId].cancelled = true;
    }
});

ipcMain.handle('sftp-open', async (event, { tabId }) => {
    if (!isFromMainWindow(event)) return;
    const sftp = _sftpOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    try {
        const ssh = sshConnections[tabId];
        const dirPath = (ssh && ssh.cwd) || '.';
        const homePath = (ssh && ssh.cwd) || _homeDir(tabId);
        const entries = await sftp.readDirectory(dirPath);
        return {
            path: homePath,
            debug: 'cwd=' + (ssh && ssh.cwd ? ssh.cwd : '(none)'),
            files: entries.map(e => ({
                name: e.name,
                isDir: _sftpTypeToIsDir(e.metadata.type),
                isLink: _sftpTypeToIsLink(e.metadata.type),
                size: e.metadata.size || 0,
                mtime: e.metadata.mtime || 0,
                mode: e.metadata.permissions || 0,
            }))
        };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('sftp-readdir', async (event, { tabId, path: dirPath }) => {
    if (!isFromMainWindow(event)) return;
    const sftp = _sftpOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    try {
        const entries = await sftp.readDirectory(dirPath || '.');
        return {
            files: entries.map(e => ({
                name: e.name,
                isDir: _sftpTypeToIsDir(e.metadata.type),
                isLink: _sftpTypeToIsLink(e.metadata.type),
                size: e.metadata.size || 0,
                mtime: e.metadata.mtime || 0,
                mode: e.metadata.permissions || 0,
            }))
        };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('sftp-home', async (event, { tabId }) => {
    if (!isFromMainWindow(event)) return;
    return { path: _homeDir(tabId) };
});

ipcMain.handle('sftp-download', async (event, { tabId, remotePath, localPath, transferId }) => {
    if (!isFromMainWindow(event)) return;
    // 路径穿越防护：拒绝含 .. 的相对路径操纵
    if (!path.isAbsolute(localPath) || path.normalize(localPath) !== localPath) {
        return { error: 'Invalid local path' };
    }
    const sftp = _sftpTransferOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    // Init transfer state
    if (!sftpTransfers[tabId]) sftpTransfers[tabId] = {};
    sftpTransfers[tabId][transferId] = { cancelled: false };
    let ws = null;
    try {
        const file = await sftp.open(remotePath, russh.OPEN_READ);
        const stat = await sftp.stat(remotePath);
        const total = stat.size || 0;
        let transferred = 0;
        ws = fs.createWriteStream(localPath);
        // 写流错误（磁盘满/拔出/无权限）必须转成 rejection，否则未处理 'error' 事件会崩主进程
        const wsError = new Promise((_, reject) => ws.once('error', reject));
        wsError.catch(() => {}); // 防止先于 await 触发时误报 unhandled rejection
        const wsDone = Promise.race([once(ws, 'finish'), wsError]);
        try {
            while (true) {
                // Check cancellation
                if (sftpTransfers[tabId]?.[transferId]?.cancelled) {
                    throw new Error('Transfer cancelled');
                }
                const chunk = await file.read(256 * 1024);
                if (chunk.length === 0) break;
                // 背压：写不动了等 drain，避免主进程内存无限堆积
                if (!ws.write(Buffer.from(chunk))) {
                    await Promise.race([once(ws, 'drain'), wsError]);
                }
                transferred += chunk.length;
                safeSend('sftp-progress', { tabId, transferred, total, transferId });
            }
        } finally {
            ws.end();
            await file.shutdown().catch(() => {});
        }
        await wsDone; // 等写流真正落盘完成
        _cleanupTransfer(tabId, transferId);
        return { ok: true, total };
    } catch (e) {
        if (ws) { try { ws.destroy(); } catch(e2) {} }
        // 失败/取消时删除半截本地文件
        try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch(e2) {}
        _cleanupTransfer(tabId, transferId);
        return { error: e.message };
    }
});

ipcMain.handle('sftp-upload', async (event, { tabId, localPath, remotePath, transferId }) => {
    if (!isFromMainWindow(event)) return;
    if (!path.isAbsolute(localPath) || path.normalize(localPath) !== localPath) {
        return { error: 'Invalid local path' };
    }
    const sftp = _sftpTransferOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    if (!sftpTransfers[tabId]) sftpTransfers[tabId] = {};
    sftpTransfers[tabId][transferId] = { cancelled: false };
    try {
        const stat = fs.statSync(localPath);
        const total = stat.size;
        let transferred = 0;
        const file = await sftp.open(remotePath, russh.OPEN_WRITE | russh.OPEN_CREATE);
        try {
            const rs = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });
            for await (const chunk of rs) {
                if (sftpTransfers[tabId]?.[transferId]?.cancelled) {
                    throw new Error('Transfer cancelled');
                }
                await file.writeAll(new Uint8Array(chunk));
                transferred += chunk.length;
                safeSend('sftp-progress', { tabId, transferred, total, transferId });
            }
        } finally {
            await file.shutdown();
        }
        _cleanupTransfer(tabId, transferId);
        return { ok: true, total };
    } catch (e) {
        _cleanupTransfer(tabId, transferId);
        return { error: e.message };
    }
});

ipcMain.handle('sftp-delete', async (event, { tabId, path: targetPath, isDir }) => {
    if (!isFromMainWindow(event)) return;
    const sftp = _sftpOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    try {
        if (isDir) await sftp.removeDirectory(targetPath);
        else await sftp.removeFile(targetPath);
        return { ok: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('sftp-rename', async (event, { tabId, oldPath, newPath }) => {
    if (!isFromMainWindow(event)) return;
    const sftp = _sftpOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    try {
        await sftp.rename(oldPath, newPath);
        return { ok: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('sftp-mkdir', async (event, { tabId, path: dirPath }) => {
    if (!isFromMainWindow(event)) return;
    const sftp = _sftpOf(tabId);
    if (!sftp) return { error: 'SFTP not available' };
    try {
        await sftp.createDirectory(dirPath);
        return { ok: true };
    } catch (e) { return { error: e.message }; }
});

// ── File dialog ──
ipcMain.handle('show-open-dialog', async (event, options) => {
    if (!isFromMainWindow(event)) return;
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result;
});

ipcMain.handle('show-save-dialog', async (event, options) => {
    if (!isFromMainWindow(event)) return;
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
});

// ── App lifecycle ──

Menu.setApplicationMenu(null);

// 数据目录：统一使用 %APPDATA%/ZTerm/，不受覆盖安装影响
sessionStore.init();
// 配置损坏时通知 renderer 弹 toast
sessionStore.setCorruptedCallback(() => {
    safeSend('config-corrupted');
});
// SSH known_hosts 初始化（TOFU）
knownHosts.init(app.getPath('userData'));

// 单实例锁：防止多开导致配置写入冲突（EPIPE）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
    appQuitting = true;
    cleanupAll();
    sessionStore.flushNow(); // 退出前确保防抖中的配置落盘
    app.quit();
});
