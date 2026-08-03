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
    // 顶栏菜单的快捷键提示需反映用户自定义：loadSettings 之后立刻填
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
    const _winEl = document.querySelector('.window');
    if (_winEl && _settingsConfig.animations === false) _winEl.classList.add('no-animations');
    TabManager.init();
})();
