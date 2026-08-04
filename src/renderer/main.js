// ZTerm - 启动序列 + 定时保存 + window.electronAPI（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Window controls ──
function _refocusActiveTerminal() {
    const tab = TabManager.getActive();
    if (!tab || tab.type === 'settings') return;
    if (tab.splitRoot) {
        const focused = getAllPanes(tab).find(p => p.focused);
        if (focused && focused.term) focused.term.focus();
    } else if (tab.term) {
        tab.term.focus();
    }
}

window.electronAPI = {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => {
        ipcRenderer.send('window-maximize');
        // Toggle icon will update via window-state-changed event
        setTimeout(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                _refocusActiveTerminal();
            }));
        }, 200);
    },
    close: () => { saveConfig(); ipcRenderer.send('window-close'); },
};

// 窗口最大化/还原时更新图标
ipcRenderer.on('window-state-changed', (event, { maximized }) => {
    const btn = document.getElementById('win-maximize');
    if (btn) btn.textContent = maximized ? '\uE923' : '\uE922'; // Restore ↔ Maximize
    const winEl = document.querySelector('.window');
    if (winEl) winEl.classList.toggle('is-maximized', maximized);
});

document.addEventListener('keydown', e => {
    const sessionsOverlay = document.getElementById('overlay-sessions');
    if (!sessionsOverlay.classList.contains('open')) return;
    const list = document.getElementById('sessions-list');
    const items = [...list.querySelectorAll('.panel-item')];
    const selected = list.querySelector('.panel-item[data-selected]');
    let idx = selected ? items.indexOf(selected) : -1;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < items.length - 1) idx++;
        else idx = 0;
        items.forEach(i => i.removeAttribute('data-selected'));
        items[idx].setAttribute('data-selected', '');
        items[idx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) idx--;
        else idx = items.length - 1;
        items.forEach(i => i.removeAttribute('data-selected'));
        items[idx].setAttribute('data-selected', '');
        items[idx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selected) {
            const sid = selected.getAttribute('data-session-id');
            if (sid) selectSession(sid);
        }
    }
});

// ── Save / Periodic ──
// L4：返回 Promise——退出流程需要等待落盘完成，不能 fire-and-forget
function saveConfig() {
    const tabs = TabManager.tabs
        .filter(t => t.type !== 'settings')
        .map((t, i) => {
            let saveName = t.name;
            const entry = { name: saveName, type: t.type, command: t.command || 'powershell.exe', args: t.args || [], content: t.splitRoot ? [] : (t._contentBuffer || []) };
            if (t.splitRoot) {
                entry.splitRoot = serializeSplitNode(t.splitRoot);
            }
            if (t.type === 'ssh') {
                entry.host = t.host; entry.port = t.port; entry.user = t.user;
                entry.sshProfileId = t.sshProfileId;
            }
            return entry;
        });
    // 无内容/全部关闭时也要保存当前状态，否则旧 lastTabs 残留导致已关闭 tab 复活
    // invoke 等待 Rust 侧写盘完成（save_last_tabs 同步落盘），退出前调用可确保数据持久化
    return ipcRenderer.invoke('save-last-tabs', tabs).catch(e => console.error('[saveConfig]', e));
}

setInterval(() => { saveConfig(); }, 15000);

// 窗口关闭前主进程给一次保存机会（app-before-quit → quit-ready）
ipcRenderer.on('app-before-quit', async () => {
    try { await saveConfig(); } catch(e) {}
    ipcRenderer.send('quit-ready');
});

// 启动动画：窗口状态（位置/大小/最大化）恢复并显示后，主进程 emit 此事件，
// 触发 .window 的淡入动画（克制的 220ms，避免启动突兀）
ipcRenderer.on('window-shown', () => {
    const winEl = document.querySelector('.window');
    if (winEl && !winEl.classList.contains('win-in')) {
        winEl.classList.add('win-in');
        setTimeout(() => winEl.classList.remove('win-in'), 400);
    }
    // 窗口已显示：解除 splash 隐藏禁令；若此前有被推迟的隐藏请求（首帧早于窗口弹出），立即重试
    _windowShownAt = Date.now();
    if (_splashHidePending) { _splashHidePending = false; hideStartupSplash(); }
});

// renderer 加载完成且监听器已注册：通知主进程恢复窗口状态并显示窗口。
// 主进程据此保证 window-shown 一定在监听就绪后 emit（否则启动界面会卡住）
ipcRenderer.invoke('renderer-ready').catch(() => {});

// 启动界面：首个终端首帧渲染完成后淡出（xterm onRender 精确判定 + 3s 兜底）
let _splashHidden = false;
// 窗口显示时间戳：splash 在窗口显示前禁止隐藏（防止窗口弹出前启动页就消失），
// 窗口显示后终端首帧一到立即淡出，不额外停留
let _windowShownAt = 0;
let _splashHidePending = false;
// 绿点加载动画：沿 Z 形方块单向循环移动，一格一格走（当前格变白、下一格变绿），慢速
let _splashLoaderTimer = null;
function startSplashLoader() {
    const cells = document.querySelectorAll('#splash-cells .cell');
    if (!cells.length) return;
    let idx = 0;
    cells[idx].classList.add('loading');
    _splashLoaderTimer = setInterval(() => {
        cells[idx].classList.remove('loading');
        idx = (idx + 1) % cells.length;
        cells[idx].classList.add('loading');
    }, 450); // 450ms/格，13 格一圈约 5.9s，慢速一格一格走
}
function hideStartupSplash(force) {
    if (_splashHidden) return;
    // 窗口未显示（还在恢复状态/未 show）：推迟到 window-shown 后再隐藏
    if (!force && !_windowShownAt) { _splashHidePending = true; return; }
    // 终端首帧已渲染 → 立即淡出（不额外停留，force 兜底路径同样立即）
    _splashHidden = true;
    _splashHidePending = false;
    if (_splashLoaderTimer) { clearInterval(_splashLoaderTimer); _splashLoaderTimer = null; }
    const s = document.getElementById('startup-splash');
    if (s) {
        s.classList.add('leaving');
        setTimeout(() => s.remove(), 450);
    }
}

function armSplashHide() {
    const waitTerm = () => {
        const t = TabManager.tabs.find(t => t.term || (t.splitRoot && getAllPanes(t)[0] && getAllPanes(t)[0].term));
        if (t) {
            const term = t.term || getAllPanes(t)[0].term;
            if (term) {
                const un = term.onRender(() => { un.dispose(); hideStartupSplash(); });
                return;
            }
        }
        setTimeout(waitTerm, 200);
    };
    waitTerm();
    // 兜底 1：window-shown 事件异常丢失时（正常路径主进程等页面加载完才 emit），
    // 强制解除"窗口未显示"禁令并重试，避免 splash 永久滞留
    setTimeout(() => {
        if (!_windowShownAt) _windowShownAt = Date.now();
        if (_splashHidePending) { _splashHidePending = false; hideStartupSplash(); }
    }, 1200);
    // 兜底 2：无论首帧/事件是否正常，3s 后强制隐藏（绕过停留限制）
    setTimeout(() => hideStartupSplash(true), 3000);
}

// ── Settings ──
// ── Init ──
(async () => {
    // 数据目录以主进程解析为准（打包版默认安装目录/data，支持用户自定义指针）
    try {
        const info = await ipcRenderer.invoke('get-data-dir-info');
        if (info && info.current) CONFIG_FILE = path.join(info.current, 'config.json');
    } catch(e) {}
    await loadSettings();
    loadQuickCommands();
    loadHighlightRules();
    applyAccentColor(_settingsConfig.accentColor || '#61afef');
    applyTerminalScheme();
    applyUiFont();
    // 顶栏菜单的快捷键提示需反映用户自定义：loadSettings 之后立刻填
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
    const _winEl = document.querySelector('.window');
    if (_winEl && _settingsConfig.animations === false) _winEl.classList.add('no-animations');
    TabManager.init();
    startSplashLoader();
    armSplashHide();
})();
