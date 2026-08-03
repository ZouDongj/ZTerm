// ZTerm - SFTP 面板 + 传输管理 + 拖拽上传（拆自 renderer.html，纯代码搬运，未改逻辑）

// ── SFTP Panel ──
const SFTP = {
    _tabId: null,      // 当前 SSH 连接的 main 进程 tabId（pty/ssh 的 tabId）
    _path: '/',        // 当前远程路径
    _files: [],        // 当前目录文件列表
    _reqSeq: 0,        // 请求序号：异步响应归属校验（M3，防快速切 tab 错配）
    _pinned: {},       // tabId -> boolean，每个 tab 独立的 pin 状态
    _pinnedPath: {},   // tabId -> path，每个 tab 独立的 pin 路径

    togglePin() {
        const tabId = this._tabId;
        if (!tabId) return;
        this._pinned[tabId] = !this._pinned[tabId];
        if (this._pinned[tabId]) {
            this._pinnedPath[tabId] = this._path;
        } else {
            delete this._pinnedPath[tabId];
        }
        const btn = document.getElementById('sftp-pin-btn');
        if (btn) btn.classList.toggle('pinned', !!this._pinned[tabId]);
    },

    _isPinned(tabId) {
        return !!this._pinned[tabId];
    },

    async open(tabId) {
        // tabId 是 main 进程的 tabId，不是 TabManager 的 tab id
        this._tabId = tabId;
        // 设置连接信息
        const tab = TabManager.tabs.find(t => t.tabId === tabId);
        const connEl = document.getElementById('sftp-conn');
        if (connEl && tab) connEl.textContent = tab.name || '';
        // 总是显示加载中，然后获取文件列表
        this._path = '/';
        document.getElementById('sftp-breadcrumb').innerHTML = '<span>/</span>';
        document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载中…</div>';
        document.getElementById('overlay-sftp').classList.add('open');
        // 恢复该 tab 的 pin 状态到按钮
        const pinBtn = document.getElementById('sftp-pin-btn');
        if (pinBtn) pinBtn.classList.toggle('pinned', this._isPinned(tabId));
        // 如果该 tab pin 住了，直接用 pin 住的目录
        if (this._isPinned(tabId) && this._pinnedPath[tabId]) {
            await this.navigate(this._pinnedPath[tabId]);
            return;
        }
        // M3：请求序号 + 归属校验——期间用户可能切到别的 tab 或关闭面板，
        // 旧请求的响应不得覆盖当前面板状态
        const myTab = tabId;
        const seq = ++SFTP._reqSeq;
        let result;
        try {
            result = await ipcRenderer.invoke('sftp-open', { tabId });
        } catch (e) {
            // 会话不存在/已断开时 Rust 返回 Err（invoke reject），不能留下未处理 rejection
            showToast('无法打开 SFTP: ' + (e?.message || '会话不可用'), true);
            document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载失败</div>';
            return;
        }
        if (seq !== SFTP._reqSeq || this._tabId !== myTab) return;
        const { path: homePath, files, error } = result;
        if (error) {
            showToast(error, true);
            document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载失败</div>';
            return;
        }
        this._path = homePath || '/';
        this._files = (files || []).sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        this._renderBreadcrumb();
        this._renderFiles();
    },

    close() {
        document.getElementById('overlay-sftp').classList.remove('open');
        this._tabId = null;
        // Refocus terminal after closing SFTP panel
        const tab = TabManager.getActive();
        if (tab) {
            if (tab.splitRoot) {
                const focused = getAllPanes(tab).find(p => p.focused);
                if (focused && focused.term) setTimeout(() => focused.term.focus(), 50);
            } else if (tab.term) {
                setTimeout(() => tab.term.focus(), 50);
            }
        }
    },

    get isOpen() {
        return document.getElementById('overlay-sftp').classList.contains('open');
    },

async navigate(path) {
    if (!this._tabId) return;
    const prevPath = this._path;
    // 先验证路径合法性再刷新页面
    const body = document.getElementById('sftp-body');
    body.innerHTML = '<div class="sftp-empty">加载中…</div>';
    // M3：请求序号 + 归属校验（同 open）
    const myTab = this._tabId;
    const seq = ++SFTP._reqSeq;
    let result;
    try {
        result = await ipcRenderer.invoke('sftp-readdir', { tabId: myTab, path });
    } catch (e) {
        // 会话断开时 Rust 返回 Err（invoke reject），显示错误并恢复原内容
        showToast('无法访问: ' + (e?.message || '会话不可用'), true);
        if (seq === SFTP._reqSeq && this._tabId === myTab) {
            this._renderBreadcrumb();
            this._renderFiles();
        }
        return;
    }
    if (seq !== SFTP._reqSeq || this._tabId !== myTab) return;
    const { files, error } = result;
    if (error) {
        showToast('无法访问: ' + error, true);
        // 恢复之前的内容
        this._renderBreadcrumb();
        this._renderFiles();
        return;
    }
    this._path = path;
    this._renderBreadcrumb();
        // 目录在前，同类按名称字母序
        this._files = (files || []).sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        this._renderFiles();
    },

    _renderBreadcrumb() {
        const el = document.getElementById('sftp-breadcrumb');
        el.innerHTML = '';
        const root = document.createElement('span');
        root.textContent = '/';
        root.addEventListener('click', () => this.navigate('/'));
        el.appendChild(root);
        let current = '';
        this._path.split('/').filter(Boolean).forEach(p => {
            current += '/' + p;
            const path = current;
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.textContent = '/';
            el.appendChild(sep);
            const seg = document.createElement('span');
            seg.textContent = p; // textContent 赋值，杜绝文件名注入
            seg.addEventListener('click', () => this.navigate(path));
            el.appendChild(seg);
        });
        // 双击地址栏进入路径编辑（参考 tabby）：面包屑整体替换为输入框，
        // 预填当前路径，回车导航，Esc/blur 恢复面包屑
        el.ondblclick = () => this._editPath();
    },

    _editPath() {
        const el = document.getElementById('sftp-breadcrumb');
        if (!el || el.querySelector('input')) return; // 已在编辑态
        const input = document.createElement('input');
        input.className = 'sftp-path-input inline-edit';
        input.value = this._path || '/';
        input.spellcheck = false;
        el.innerHTML = '';
        el.appendChild(input);
        input.focus();
        // 选中末尾的目录名，方便覆盖输入
        const lastSlash = input.value.lastIndexOf('/');
        if (lastSlash >= 0 && lastSlash < input.value.length - 1) {
            input.setSelectionRange(lastSlash + 1, input.value.length);
        } else {
            input.select();
        }
        let done = false;
        const finish = (navigate) => {
            if (done) return;
            done = true;
            const val = input.value.trim() || '/';
            if (navigate && val !== this._path) {
                this.navigate(val);
            } else {
                this._renderBreadcrumb();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(false));
    },

    _renderFiles() {
        const body = document.getElementById('sftp-body');
        body.innerHTML = '';
        // ".." 行
        if (this._path !== '/') {
            const up = document.createElement('div');
            up.className = 'sftp-item';
            up.innerHTML = '<span class="sftp-item-icon">📁</span><span class="sftp-item-name">..</span>';
            up.addEventListener('click', () => this.goUp());
            body.appendChild(up);
        }
        this._files.forEach(f => {
            const icon = f.isDir ? '📁' : '📄';
            const size = f.isDir ? '' : formatSize(f.size);
            const date = formatDate(f.mtime);
            const fullPath = (this._path === '/' ? '' : this._path) + '/' + f.name;
            const el = document.createElement('div');
            el.className = 'sftp-item';
            el.innerHTML = '<span class="sftp-item-icon">' + icon + '</span>' +
                '<span class="sftp-item-name">' + escHtml(f.name) + '</span>' +
                '<span class="sftp-item-size">' + size + '</span>' +
                '<span class="sftp-item-date">' + date + '</span>';
            // 不用内联 onclick 拼接路径——恶意服务器文件名可注入 HTML 属性
            el.addEventListener('click', () => {
                if (f.isDir) this.navigate(fullPath);
                else this.download(fullPath, f.name);
            });
            body.appendChild(el);
        });
        if (!body.children.length) body.innerHTML = '<div class="sftp-empty">空目录</div>';
    },

    goUp() {
        const parts = this._path.split('/').filter(Boolean);
        parts.pop();
        this.navigate('/' + parts.join('/'));
    },

    async refresh() {
        await this.navigate(this._path);
    },

    async download(remotePath, filename) {
        const result = await ipcRenderer.invoke('show-save-dialog', { defaultPath: filename });
        if (result.canceled) return;
        const tid = TransferManager.add(filename, 'download', this._tabId, result.filePath);
        let transferResult;
        try {
            transferResult = await ipcRenderer.invoke('sftp-download', { tabId: this._tabId, remotePath, localPath: result.filePath, transferId: tid });
        } catch (e) {
            TransferManager.cancel(tid);
            showToast('下载失败: ' + (e?.message || '会话不可用'), true);
            return;
        }
        const { error, total } = transferResult;
        if (error) {
            TransferManager.cancel(tid);
            if (error === 'Transfer cancelled') {
                showToast('下载已取消');
            } else {
                showToast('下载失败: ' + error, true);
            }
        } else {
            TransferManager.complete(tid);
        }
    },

    async uploadLocal(localPath) {
        const filename = localPath.split(/[\\/]/).pop();
        const remotePath = (this._path === '/' ? '' : this._path) + '/' + filename;
        const tid = TransferManager.add(filename, 'upload', this._tabId);
        let transferResult;
        try {
            transferResult = await ipcRenderer.invoke('sftp-upload', { tabId: this._tabId, localPath, remotePath, transferId: tid });
        } catch (e) {
            TransferManager.cancel(tid);
            showToast('上传失败: ' + (e?.message || '会话不可用'), true);
            return;
        }
        const { error } = transferResult;
        if (error) {
            TransferManager.cancel(tid);
            if (error === 'Transfer cancelled') {
                showToast('上传已取消');
            } else {
                showToast('上传失败: ' + error, true);
            }
        } else {
            TransferManager.complete(tid);
            await this.refresh();
        }
    },

    async upload() {
        const result = await ipcRenderer.invoke('show-open-dialog', { properties: ['openFile', 'multiSelections'] });
        if (result.canceled || !result.filePaths.length) return;
        for (const localPath of result.filePaths) {
            await this.uploadLocal(localPath);
        }
    },

    mkdir() {
        // Electron 不支持 window.prompt()——用文件列表顶部的内联输入行代替
        const body = document.getElementById('sftp-body');
        if (document.getElementById('sftp-mkdir-row')) return;
        const row = document.createElement('div');
        row.className = 'sftp-item';
        row.id = 'sftp-mkdir-row';
        row.innerHTML = '<span class="sftp-item-icon">📁</span><input class="inline-edit" placeholder="新建目录名称，Enter 确认 / Esc 取消" style="flex:1;background:rgba(var(--accent-rgb),0.06);border:1.5px solid rgba(var(--accent-rgb),0.25);border-radius:8px;padding:4px 10px;color:#abb2bf;font-size:12.5px;font-family:inherit;outline:none">';
        body.insertBefore(row, body.firstChild);
        const input = row.querySelector('input');
        input.focus();
        var removed = false;
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                if (!removed) { removed = true; row.remove(); }
                return;
            }
            if (e.key !== 'Enter') return;
            const name = input.value.trim();
            if (!removed) { removed = true; row.remove(); }
            if (!name) return;
            const path = (this._path === '/' ? '' : this._path) + '/' + name;
            let result;
            try {
                result = await ipcRenderer.invoke('sftp-mkdir', { tabId: this._tabId, path });
            } catch (e) {
                showToast('创建失败: ' + (e?.message || '会话不可用'), true);
                return;
            }
            const { error } = result;
            if (error) { showToast('创建失败: ' + error, true); return; }
            showToast('目录已创建');
            await this.refresh();
        });
        input.addEventListener('blur', () => { if (!removed) { removed = true; row.remove(); } });
    },

};

// ── Global Transfer Manager ──
const TransferManager = {
    _transfers: [],
    _nextId: 1,
    _history: [],

    add(name, type, tabId, localPath) {
        const id = this._nextId++;
        this._transfers.push({ id, name, type, tabId, localPath, transferred: 0, total: 0, done: false, cancelled: false, startTime: Date.now() });
        this._render();
        this._showButton();
        showToast(type === 'download' ? '开始下载: ' + name : '开始上传: ' + name);
        return id;
    },

    update(id, transferred, total) {
        const t = this._transfers.find(t => t.id === id);
        if (!t) return;
        t.transferred = transferred;
        t.total = total;
        this._render();
    },

    complete(id) {
        const t = this._transfers.find(x => x.id === id);
        if (!t) return;
        t.done = true;
        // Save to in-memory history (lost on app restart, kept during session)
        this._history.unshift({ name: t.name, type: t.type, total: t.total, localPath: t.localPath, completedAt: Date.now() });
        if (this._history.length > 50) this._history.length = 50;
        this._render();
        showToast((t.type === 'download' ? '下载完成: ' : '上传完成: ') + t.name);
        setTimeout(() => this.remove(id), 3000);
    },

    cancel(id) {
        const t = this._transfers.find(x => x.id === id);
        if (!t) return;
        t.cancelled = true;
        ipcRenderer.send('sftp-cancel-transfer', { tabId: t.tabId, transferId: id });
        this._render();
        setTimeout(() => this.remove(id), 1000);
    },

    remove(id) {
        this._transfers = this._transfers.filter(x => x.id !== id);
        this._render();
        if (this._transfers.length === 0 && this._history.length === 0) this._hideButton();
    },

    _render() {
        // 更新状态栏按钮的计数
        const btn = document.getElementById('transfer-btn');
        if (btn) {
            const active = this._transfers.filter(t => !t.done && !t.cancelled).length;
            const countEl = btn.querySelector('.transfer-count');
            const prevCount = countEl.textContent;
            countEl.textContent = active > 0 ? active : '';
            // Pulse animation when count changes
            if (active > 0 && String(active) !== prevCount) {
                countEl.classList.remove('pulse');
                void countEl.offsetWidth;
                countEl.classList.add('pulse');
            }
        }
        // 更新面板内容
        const panel = document.getElementById('transfer-panel');
        if (panel && panel.classList.contains('open')) {
            this._renderPanel();
        }
    },

    _showButton() {
        const btn = document.getElementById('transfer-btn');
        if (btn) btn.classList.add('visible');
    },

    _hideButton() {
        const btn = document.getElementById('transfer-btn');
        if (btn) btn.classList.remove('visible');
        this.closePanel();
    },

    openPanel() {
        this._renderPanel();
        document.getElementById('transfer-panel').classList.add('open');
    },

    closePanel() {
        document.getElementById('transfer-panel').classList.remove('open');
    },

    _renderPanel() {
        const body = document.getElementById('transfer-panel-body');
        let html = '';
        // Active transfers
        this._transfers.forEach(t => {
            const pct = t.total > 0 ? Math.round(t.transferred / t.total * 100) : 0;
            const icon = t.type === 'download'
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
            const barClass = t.cancelled ? 'cancelled' : t.done ? 'done' : '';
            const btn = t.done
                ? '<button class="transfer-item-btn" onclick="TransferManager.remove(' + t.id + ')">✓</button>'
                : '<button class="transfer-item-btn" onclick="TransferManager.cancel(' + t.id + ')">×</button>';
            const elapsed = (Date.now() - t.startTime) / 1000;
            const speed = elapsed > 0 ? t.transferred / elapsed : 0;
            html += '<div class="transfer-item">' +
                '<span class="transfer-item-icon">' + icon + '</span>' +
                '<div class="transfer-item-main">' +
                    '<div class="transfer-item-name">' + escHtml(t.name) + '</div>' +
                    '<div class="transfer-item-bar"><div class="transfer-item-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
                    '<div class="transfer-item-meta">' +
                        '<span>' + formatSize(t.transferred) + ' / ' + formatSize(t.total) + '</span>' +
                        '<span class="speed">' + (t.done ? '完成' : formatSize(speed) + '/s') + '</span>' +
                    '</div>' +
                '</div>' +
                btn +
            '</div>';
        });
        // History (completed transfers, in-memory only — lost on app restart)
        if (this._history.length > 0) {
            if (html) html += '<div style="padding:8px 8px 4px;font-size:11px;color:rgba(171,178,191,0.3);border-top:1px solid rgba(var(--accent-rgb),0.06);margin-top:4px">历史记录</div>';
            this._history.forEach((h, i) => {
                const icon = h.type === 'download'
                    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
                    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
                const canOpen = h.type === 'download' && h.localPath;
                html += '<div class="transfer-item"' + (canOpen ? ' style="cursor:pointer" onclick="TransferManager.openInExplorer(' + i + ')"' : '') + '>' +
                    '<span class="transfer-item-icon">' + icon + '</span>' +
                    '<div class="transfer-item-main">' +
                        '<div class="transfer-item-name">' + escHtml(h.name) + '</div>' +
                        '<div class="transfer-item-meta">' +
                            '<span>' + formatSize(h.total) + '</span>' +
                            '<span class="speed">' + formatDate(h.completedAt) + '</span>' +
                        '</div>' +
                    '</div>' +
                    (canOpen ? '<button class="transfer-item-btn" onclick="event.stopPropagation();TransferManager.openInExplorer(' + i + ')" title="打开所在文件夹">→</button>' : '') +
                    '<button class="transfer-item-btn" onclick="event.stopPropagation();TransferManager.removeHistory(' + i + ')" title="删除记录">×</button>' +
                '</div>';
            });
        }
        body.innerHTML = html || '<div class="transfer-empty">暂无传输任务</div>';
    },

    removeHistory(index) {
        this._history.splice(index, 1);
        this._render();
        if (this._transfers.length === 0 && this._history.length === 0) this._hideButton();
    },

    openInExplorer(index) {
        const h = this._history[index];
        if (h && h.localPath) {
            ipcRenderer.send('open-in-explorer', { path: h.localPath });
        }
    },
};

// SFTP 传输进度
ipcRenderer.on('sftp-progress', (event, { tabId, transferred, total, transferId }) => {
    TransferManager.update(transferId, transferred, total);
});

// SFTP cwd 跟随：SSH 终端 cd 时自动跳转（除非该 tab pin 住）
ipcRenderer.on('sftp-cwd-changed', (event, { tabId, cwd }) => {
    if (SFTP.isOpen && !SFTP._pinned[tabId] && SFTP._tabId === tabId) {
        SFTP.navigate(cwd);
    }
});

// ── SFTP 拖拽上传（拖文件到面板即上传到当前远程目录）──
(() => {
    const win = document.querySelector('#overlay-sftp .sftp-window');
    if (!win) return;
    // Tauri(WebView2) 没有 webUtils.getPathForFile, 文件路径改由窗口级 tauri://drag-* 事件提供
    const isTauri = !!(window.__TAURI__ && window.__TAURI__.event);
    let dragDepth = 0;

    // 统一处理一批本地路径: 文件夹拦截 + 逐个上传
    function _handleDroppedPaths(paths) {
        if (!SFTP.isOpen || !SFTP._tabId) return;
        (paths || []).forEach(p => {
            if (!p) return;
            try {
                if (fs.statSync(p).isDirectory()) {
                    showToast('暂不支持上传文件夹: ' + String(p).split(/[\/]/).pop(), true);
                    return;
                }
            } catch(err) {}
            SFTP.uploadLocal(p);
        });
    }

    // Tauri 拖拽事件是窗口级的, 需要判断释放点是否落在 SFTP 面板内
    // 注意: payload.position 是物理像素, 需除以 devicePixelRatio 换算成 CSS 坐标
    function _pointInPanel(x, y) {
        const dpr = window.devicePixelRatio || 1;
        const el = document.elementFromPoint(x / dpr, y / dpr);
        return !!(el && win.contains(el));
    }

    win.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; win.classList.add('drag-over'); });
    win.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    win.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; win.classList.remove('drag-over'); } });
    win.addEventListener('drop', e => {
        e.preventDefault();
        dragDepth = 0;
        win.classList.remove('drag-over');
        if (isTauri) return; // Tauri 下 dataTransfer.files 拿不到路径, 走 tauri://drag-drop 事件
        if (!SFTP.isOpen || !SFTP._tabId) return;
        [...(e.dataTransfer.files || [])].forEach(f => {
            // Electron 32+ 移除了 File.path，必须用 webUtils.getPathForFile
            let localPath = '';
            try { localPath = webUtils.getPathForFile(f); } catch(err) {}
            if (!localPath) return;
            _handleDroppedPaths([localPath]);
        });
    });

    if (isTauri) {
        const tauriEvent = window.__TAURI__.event;
        // 悬停面板上时显示高亮 (drag-over payload 只有 position)
        tauriEvent.listen('tauri://drag-over', (event) => {
            const pos = event.payload && event.payload.position;
            if (pos && _pointInPanel(pos.x, pos.y)) win.classList.add('drag-over');
            else win.classList.remove('drag-over');
        });
        // 拖出窗口/取消
        tauriEvent.listen('tauri://drag-leave', () => { win.classList.remove('drag-over'); });
        // 释放: 只在面板内才上传
        tauriEvent.listen('tauri://drag-drop', (event) => {
            win.classList.remove('drag-over');
            const payload = event.payload || {};
            const pos = payload.position;
            if (pos && !_pointInPanel(pos.x, pos.y)) return;
            _handleDroppedPaths(payload.paths);
        });
    }
})();

