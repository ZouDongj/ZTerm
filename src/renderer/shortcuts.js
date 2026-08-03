// ZTerm - 快捷键注册表 + 调度 + 自定义 UI + 数据目录/关于页（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Keyboard shortcuts ──
// Capture-phase handler for keys that terminal would otherwise eat
// ── Keyboard shortcuts ──
// 必须在 capture 阶段拦截：xterm 会把 F2/Ctrl+W/Ctrl+Tab 等键处理成转义序列
// 并 stopPropagation，冒泡阶段的监听在终端聚焦时永远收不到。
function _comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    // e.code 比 e.key 更可靠——不受键盘布局、Alt 键系统拦截、输入法等影响
    let key = e.key;
    if (!key || key === 'Dead' || key === 'Unidentified') {
        const m = e.code && e.code.match(/^(?:Key|Digit)(\w)$/);
        key = m ? m[1] : (e.code || '');
    }
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join('+');
}

// 默认快捷键绑定（用户自定义覆盖见 _settingsConfig.shortcuts）
const DEFAULT_SHORTCUTS = {
    newTab: 'Ctrl+Shift+N',
    sshPanel: 'Ctrl+Shift+S',
    openSettings: 'Ctrl+,',
    closeTab: 'Ctrl+W',
    closePane: 'Ctrl+Shift+W',
    nextTab: 'Ctrl+Tab',
    prevTab: 'Ctrl+Shift+Tab',
    renameTab: 'F2',
    splitH: 'Ctrl+Shift+H',
    splitV: 'Ctrl+Shift+V',
    maximizePane: 'Ctrl+Shift+ArrowUp',
    extractPane: 'Ctrl+Shift+X',
    nextPane: 'Ctrl+Shift+ArrowRight',
    prevPane: 'Ctrl+Shift+ArrowLeft',
    syncInput: 'Ctrl+Shift+I',
    search: 'Ctrl+F',
    sftp: 'Ctrl+Shift+F',
    quickCommands: 'Ctrl+Shift+P',
    commandPalette: 'Ctrl+P',
    cloneTab: 'Ctrl+Shift+T',
};

function _getShortcutBindings() {
    return { ...DEFAULT_SHORTCUTS, ...(_settingsConfig.shortcuts || {}) };
}

function _cycleTab(delta) {
    const idx = TabManager.tabs.findIndex(t => t.id === TabManager.activeId);
    if (idx === -1 || TabManager.tabs.length < 2) return;
    const next = TabManager.tabs[(idx + delta + TabManager.tabs.length) % TabManager.tabs.length];
    TabManager.switchTo(next.id);
}

const SHORTCUT_ACTIONS = {
    newTab: () => openSessionSelector(),
    sshPanel: () => openSSHManager(),
    quickCommands: () => openQC(),
    openSettings: () => openSettings(),
    closeTab: () => {
        const tab = TabManager.getActive();
        if (!tab || tab.type === 'settings') return;
        if (TabManager.tabs.length <= 1) {
            // 至少保留一个标签页（ZTerm 不能全空）
            showToast('至少保留一个标签页');
            return;
        }
        if (!document.querySelector('.overlay.open')) TabManager.closeTab(tab.id);
    },
    closePane: () => {
        const tab = TabManager.getActive();
        if (!tab || tab.type === 'settings') return;
        if (tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._closePane(tab.id, focused.id);
        } else if (!document.querySelector('.overlay.open')) {
            // 不在分屏（单 terminal 或刚从分屏退出只剩 1 个 pane 后）：等同 Ctrl+W 关闭当前 tab
            // 与 tabby 行为一致
            TabManager.closeTab(tab.id);
        }
    },
    nextTab: () => { if (!document.querySelector('.overlay.open')) _cycleTab(1); },
    prevTab: () => { if (!document.querySelector('.overlay.open')) _cycleTab(-1); },
    renameTab: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) {
            TabManager.startRenameTab(tab.id);
        }
    },
    splitH: () => { if (!document.querySelector('.overlay.open')) TabManager.splitHorizontal(); },
    splitV: () => { if (!document.querySelector('.overlay.open')) TabManager.splitVertical(); },
    syncInput: () => {
        // 分屏同步输入开关（Tabby 同款）：开启后输入广播到当前 tab 的所有 pane
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        tab.syncInput = !tab.syncInput;
        const rootEl = document.getElementById('split_' + tab.id);
        if (rootEl) rootEl.classList.toggle('sync-input', tab.syncInput);
        showToast(tab.syncInput ? '⇶ 同步输入已开启（输入广播到所有窗格）' : '同步输入已关闭');
    },
    maximizePane: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._maximizePane(tab.id, focused.id);
        }
    },
    extractPane: () => {
        // 提取当前聚焦 pane 为独立 tab（无分屏时无操作）
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._extractPaneToTab(tab.id, focused.id);
        }
    },
    nextPane: () => {
        // 分屏内循环聚焦下一个 pane（getAllPanes 深度优先 = 视觉左→右、上→下）
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        const panes = getAllPanes(tab);
        if (panes.length < 2) return;
        const cur = panes.findIndex(p => p.focused);
        const next = panes[(cur + 1) % panes.length];
        TabManager._focusPane(tab, next.id);
    },
    prevPane: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        const panes = getAllPanes(tab);
        if (panes.length < 2) return;
        const cur = panes.findIndex(p => p.focused);
        const prev = panes[(cur - 1 + panes.length) % panes.length];
        TabManager._focusPane(tab, prev.id);
    },
    search: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) openSearch();
    },
    sftp: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings') {
            const panes = tab.splitRoot ? getAllPanes(tab) : [];
            const target = panes.find(p => p.focused) || panes[0] || tab;
            if (target.type === 'ssh' && target.tabId) {
                if (SFTP.isOpen && SFTP._tabId === target.tabId) SFTP.close();
                else SFTP.open(target.tabId);
            }
        }
    },
    commandPalette: () => {
        const palette = document.getElementById('overlay-palette');
        if (palette && palette.classList.contains('open')) {
            closePalette();  // toggle：面板已开 → 关闭
            return;
        }
        if (document.querySelector('.overlay.open')) return;  // 其他 overlay 打开时不响应
        openPalette();
    },
    cloneTab: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) {
            TabManager.cloneTab(tab.id);
        }
    },
};

// ── Shortcut customization (settings page) ──
const SHORTCUT_LABELS = {
    newTab: '新建标签页',
    sshPanel: 'SSH 连接面板',
    openSettings: '打开设置',
    closeTab: '关闭标签页',
    closePane: '关闭聚焦窗格',
    nextTab: '下一个标签页',
    prevTab: '上一个标签页',
    renameTab: '重命名标签页',
    splitH: '左右分屏',
    splitV: '上下分屏',
    maximizePane: '窗格最大化/恢复',
    extractPane: '提取窗格为标签页',
    nextPane: '聚焦下一个窗格',
    prevPane: '聚焦上一个窗格',
    syncInput: '同步输入到所有窗格',
    search: '终端搜索',
    sftp: 'SFTP 文件面板',
    quickCommands: '快捷命令',
    commandPalette: '命令面板',
    cloneTab: '克隆标签页',
};

function _comboDisplay(combo) {
    return combo.replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓')
        .replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→');
}

let _shortcutCapture = null;

function renderShortcutsList() {
    const table = document.getElementById('shortcuts-table');
    if (!table) return;
    const bindings = _getShortcutBindings();
    const overrides = _settingsConfig.shortcuts || {};
    let html = '<tr><th>操作</th><th>快捷键</th><th style="width:110px"></th></tr>';
    Object.keys(SHORTCUT_LABELS).forEach(id => {
        const combo = bindings[id] || '';
        const overridden = overrides[id] !== undefined;
        html += `<tr><td>${SHORTCUT_LABELS[id]}</td><td><kbd>${escHtml(_comboDisplay(combo))}</kbd></td>`
            + `<td style="white-space:nowrap;text-align:right">`
            + `<button class="btn-outline shortcut-edit-btn" onclick="startShortcutCapture('${id}',this)">修改</button>`
            + (overridden ? `<button class="btn-outline shortcut-reset-btn" title="恢复默认（${escHtml(_comboDisplay(DEFAULT_SHORTCUTS[id]))}）" onclick="resetShortcut('${id}')">↺</button>` : '')
            + `</td></tr>`;
    });
    html += `<tr><td>关闭面板 / 退出最大化 / 关闭搜索</td><td><kbd>Esc</kbd></td><td></td></tr>`;
    table.innerHTML = html;
}

function startShortcutCapture(actionId, btn) {
    if (_shortcutCapture) return;
    _shortcutCapture = { actionId };
    btn.textContent = '按下快捷键…';
    btn.classList.add('capturing');
    const onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { finish(null); return; }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // 等待非修饰键
        finish(_comboFromEvent(e));
    };
    const finish = (combo) => {
        document.removeEventListener('keydown', onKey, true);
        _shortcutCapture = null;
        if (combo) {
            const keyPart = combo.split('+').pop();
            const ok = combo.includes('Ctrl+') || combo.includes('Alt+') || /^F\d{1,2}$/.test(keyPart);
            const bindings = _getShortcutBindings();
            const conflict = ok && Object.keys(bindings).find(id => id !== actionId && bindings[id] === combo);
            if (!ok) showToast('普通按键不能单独作为快捷键（需含 Ctrl/Alt，或使用 F1-F12）');
            else if (conflict) showToast('快捷键已被「' + SHORTCUT_LABELS[conflict] + '」占用');
            else {
                if (!_settingsConfig.shortcuts) _settingsConfig.shortcuts = {};
                if (combo === DEFAULT_SHORTCUTS[actionId]) delete _settingsConfig.shortcuts[actionId];
                else _settingsConfig.shortcuts[actionId] = combo;
                persistShortcuts();
            }
        }
        renderShortcutsList();
        // 顶栏菜单的快捷键提示要立即跟随用户最新绑定
        if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
    };
    document.addEventListener('keydown', onKey, true);
}

function resetShortcut(actionId) {
    if (_settingsConfig.shortcuts) delete _settingsConfig.shortcuts[actionId];
    persistShortcuts();
    renderShortcutsList();
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
}

function resetAllShortcuts() {
    _settingsConfig.shortcuts = {};
    persistShortcuts();
    renderShortcutsList();
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
}

function persistShortcuts() {
    ipcRenderer.send('save-shortcuts', _settingsConfig.shortcuts || {});
}

// ── Data directory (settings → 关于) ──
async function loadDataDirInfo() {
    const el = document.getElementById('data-dir-path');
    if (!el) return;
    const info = await ipcRenderer.invoke('get-data-dir-info');
    if (!info) return;
    el.textContent = info.current + (info.isCustom ? '（自定义）' : '（默认）');
    document.getElementById('data-dir-reset').style.display = info.isCustom ? '' : 'none';
}

// ── About info（主进程动态读取版本号）──
async function loadAboutInfo() {
    try {
        const info = await ipcRenderer.invoke('get-about-info');
        if (!info) return;
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('about-ver', '版本 ' + (info.version || '?'));
        set('about-fw', 'Electron ' + (info.electron || '?'));
        set('about-engine', 'xterm.js ' + (info.xterm || '?') + ' + node-pty');
        set('about-ssh', 'russh ' + (info.russh || '?'));
    } catch(e) {}
}

async function changeDataDir() {
    const result = await ipcRenderer.invoke('show-open-dialog', { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return;
    const r = await ipcRenderer.invoke('set-data-dir', { dir: result.filePaths[0] });
    if (r && r.error) { showToast('更改失败: ' + r.error, true); return; }
    showToast('数据目录已更改，配置已迁移');
    loadDataDirInfo();
}

async function resetDataDir() {
    const r = await ipcRenderer.invoke('set-data-dir', { dir: '' });
    if (r && r.error) { showToast('恢复失败: ' + r.error, true); return; }
    showToast('已恢复默认数据目录');
    loadDataDirInfo();
}

document.addEventListener('keydown', e => {
    if (_shortcutCapture) return; // 正在录制新快捷键，交给录制监听器处理
    // Escape：弹窗/最大化恢复的优先级最高，其余情况放行给 xterm（vim 等程序要用）
    if (e.key === 'Escape') {
        // 内联编辑输入框（SFTP 路径/mkdir、分组重命名等）的 Escape
        // 应由输入框自己处理（取消编辑），不能在这里关掉整个 overlay。
        // 本监听器是 capture 阶段，先于 input 的 keydown，必须在这里放行。
        if (e.target && e.target.classList && e.target.classList.contains('inline-edit')) {
            return;
        }
        // combo dropdown menu 开着时（SSH/QC 编辑面板的分组字段），Escape 应先关 menu
        // 而非关整个编辑表单；input keydown 已 stopPropagation（bubble），这里负责放行
        if (document.querySelector('.dd-menu.open')) {
            return;
        }
        const menuPopup = document.getElementById('menu-popup');
        if (menuPopup && menuPopup.classList.contains('open')) {
            menuPopup.classList.remove('open');
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (document.querySelector('.overlay.open')) {
            closeAllOverlays();
            const tab = TabManager.getActive();
            if (tab && tab.term) setTimeout(() => tab.term.focus(), 50);
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (TabManager._maximizedPaneId) {
            const tab = TabManager.getActive();
            if (tab && tab.splitRoot) {
                e.preventDefault(); e.stopPropagation();
                TabManager._maximizePane(tab.id, TabManager._maximizedPaneId);
            }
        }
        return;
    }

    // 在输入框/下拉框里打字时不触发全局快捷键（xterm 的辅助输入框除外）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
        && !(t.classList && t.classList.contains('xterm-helper-textarea'))) return;

    const combo = _comboFromEvent(e);
    const bindings = _getShortcutBindings();
    const actionId = Object.keys(bindings).find(id => bindings[id] === combo);
    if (!actionId || !SHORTCUT_ACTIONS[actionId]) return;
    e.preventDefault(); e.stopPropagation();
    SHORTCUT_ACTIONS[actionId]();
}, true);

