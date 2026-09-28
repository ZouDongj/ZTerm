// ZTerm - SFTP panel + transfer manager + drag-and-drop upload

// ── SFTP Panel ──
const SFTP = {
    _tabId: null,      // main-process tabId of the current SSH connection (the pty/ssh tabId)
    _path: '/',        // current remote path
    _files: [],        // file list of the current directory
    _listed: false,    // whether the current panel binding has a valid rendered listing (reset on open)
    _reqSeq: 0,        // request sequence number: async response ownership check (prevents stale responses after fast tab switches)
    _viewReq: null,    // identity {seq,epoch} of the LATEST unsettled view request (open/navigate) of the current binding; the view is loading while this is set. Superseded requests of the same binding no longer count: only the latest request owns the loading state
    _viewEpoch: 0,     // panel-binding generation: open()/close() bump it, so an obsolete request's finally block cannot touch the loading identity
    _refreshInFlight: null,  // identity {epoch} of the upload-refresh run that owns the coalescing slot; only that run's own finally may clear/drain it (a stale finally cannot touch a successor view)
    _refreshQueued: null,    // owner {tabId,path} owed one coalesced follow-up refresh once the current binding's in-flight refresh settles
    _editingPath: false, // breadcrumb path edit in progress (a cwd follow must not destroy it)
    _pinned: {},       // tabId -> boolean, per-tab pin state
    _pinnedPath: {},   // tabId -> path, per-tab pinned path

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
        // tabId here is the main-process tabId, not TabManager's tab id
        this._tabId = tabId;
        // set connection info
        const tab = TabManager.tabs.find(t => t.tabId === tabId);
        const connEl = document.getElementById('sftp-conn');
        if (connEl && tab) connEl.textContent = tab.name || '';
        // always show the loading state first, then fetch the file list; reset ALL
        // session-bound listing state before the first await so a later failure can
        // never render the previous session's rows into this panel
        this._path = '/';
        this._files = [];
        this._listed = false;
        // A fresh binding starts a new request generation: in-flight requests of
        // the previous binding (even of this same backend after close/reopen) no
        // longer count as loads of this view and cannot re-arm its refreshes.
        // Retiring the refresh slot also disowns the previous binding's running
        // refresh: its finally can no longer clear or drain anything here.
        this._viewEpoch++;
        this._viewReq = null;
        this._refreshQueued = null;
        this._refreshInFlight = null;
        document.getElementById('sftp-breadcrumb').innerHTML = '<span>/</span>';
        document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载中…</div>';
        document.getElementById('overlay-sftp').classList.add('open');
        // restore this tab's pin state onto the button
        const pinBtn = document.getElementById('sftp-pin-btn');
        if (pinBtn) pinBtn.classList.toggle('pinned', this._isPinned(tabId));
        // if this tab is pinned, navigate straight to the pinned directory
        if (this._isPinned(tabId) && this._pinnedPath[tabId]) {
            await this.navigate(this._pinnedPath[tabId]);
            return;
        }
        // Request sequence + ownership check: the user may switch tabs or close
        // the panel meanwhile; a stale response must not overwrite the current panel state
        const myTab = tabId;
        const seq = ++SFTP._reqSeq;
        const req = { seq, epoch: this._viewEpoch };
        this._viewReq = req;
        try {
            let result;
            try {
                result = await ipcRenderer.invoke('sftp-open', { tabId });
            } catch (e) {
                // Rust returns Err (invoke rejects) when the session is missing/disconnected; do not leave an unhandled rejection.
                // The ownership check applies to failures and to hidden panels alike:
                // closeOverlay (the Esc/backdrop route) only removes the .open class, so a
                // request whose panel is no longer visible must not surface its obsolete error.
                if (seq !== SFTP._reqSeq || this._tabId !== myTab || !SFTP.isOpen) return;
                showToast('无法打开 SFTP: ' + (e?.message || '会话不可用'), true);
                document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载失败</div>';
                return;
            }
            if (seq !== SFTP._reqSeq || this._tabId !== myTab || !SFTP.isOpen) return;
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
            this._listed = true;
            this._renderBreadcrumb();
            this._renderFiles();
        } finally {
            // Only the latest request of the current binding owns the loading
            // state; a superseded or retired request's finally touches nothing.
            if (this._viewReq === req) this._viewReq = null;
        }
    },

    close() {
        document.getElementById('overlay-sftp').classList.remove('open');
        this._tabId = null;
        // The binding is gone: retire its request generation so no in-flight
        // open/navigate of the old view can touch the loading identity or re-arm
        // a deferred refresh, and disown the old view's running refresh so its
        // finally cannot clear/drain a successor view's slot; the next open()
        // starts from a clean slate.
        this._viewEpoch++;
        this._viewReq = null;
        this._refreshQueued = null;
        this._refreshInFlight = null;
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

    async navigate(path, opts) {
        if (!this._tabId) return;
        // validate the path before refreshing the view
        const body = document.getElementById('sftp-body');
        body.innerHTML = '<div class="sftp-empty">加载中…</div>';
        // Request sequence + ownership check (same as open); a closed panel
        // (any close route, including closeOverlay's class-only removal) owns nothing
        const myTab = this._tabId;
        const seq = ++SFTP._reqSeq;
        const req = { seq, epoch: this._viewEpoch };
        // The latest request takes over the loading state: an earlier request of
        // this same binding is now obsolete and must no longer suppress the
        // view's upload refreshes once it settles.
        this._viewReq = req;
        try {
            let result;
            try {
                result = await ipcRenderer.invoke('sftp-readdir', { tabId: myTab, path });
            } catch (e) {
                // Rust returns Err (invoke rejects) on session disconnect. Failures obey the
                // same ownership check as successes: a superseded request's rejection must be silent.
                if (seq === SFTP._reqSeq && this._tabId === myTab && SFTP.isOpen) {
                    if (opts && opts.follow && this._isPinned(myTab)) { this._dropFollow(); return; }
                    this._navFailed(e?.message || '会话不可用', opts);
                }
                return;
            }
            if (seq !== SFTP._reqSeq || this._tabId !== myTab || !SFTP.isOpen) return;
            if (opts && opts.follow && this._isPinned(myTab)) { this._dropFollow(); return; }
            const { files, error } = result;
            if (error) {
                this._navFailed(error, opts);
                return;
            }
            this._path = path;
            // directories first, then alphabetical by name within each kind
            this._files = (files || []).sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this._listed = true;
            this._renderListing(opts && (opts.follow || opts.refresh));
        } finally {
            // Only the latest request of the current binding owns the loading
            // state; a superseded or retired request's finally touches nothing.
            if (this._viewReq === req) this._viewReq = null;
        }
    },

    // A cwd follow that was in flight when the user pinned the panel: the pinned
    // directory stays fixed, so the stale follow result (success or failure) is
    // dropped silently and the pinned listing is put back on screen.
    _dropFollow() {
        this._renderListing(true);
    },

    // Render breadcrumb + file list. A non-user navigation (cwd follow, upload
    // refresh) arriving while the user is editing the breadcrumb path must not
    // destroy the editor: the listing state is still updated (the panel did move
    // for a follow), the file list renders so the body is never stuck loading,
    // and the editor's own Enter/Esc exit re-renders the breadcrumb from the
    // then-current path. Direct user navigations still end an in-progress edit.
    _renderListing(nonUser) {
        if (!(nonUser && this._editingPath)) this._renderBreadcrumb();
        this._renderFiles();
    },

    // Current-owner navigation failure: report the error, and either keep this
    // panel's last valid listing or — when the panel never obtained one (fresh
    // open, pinned reopen, follow that superseded the initial listing request) —
    // show an honest failure state instead of the previous session's rows or a
    // misleading "empty directory".
    _navFailed(msg, opts) {
        showToast('无法访问: ' + msg, true);
        if (!this._listed) {
            document.getElementById('sftp-body').innerHTML = '<div class="sftp-empty">加载失败</div>';
        } else {
            this._renderListing(opts && (opts.follow || opts.refresh));
        }
    },

    _renderBreadcrumb() {
        const el = document.getElementById('sftp-breadcrumb');
        el.innerHTML = '';
        this._editingPath = false; // any listing render ends an in-progress path edit
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
            seg.textContent = p; // assign via textContent to prevent filename injection
            seg.addEventListener('click', () => this.navigate(path));
            el.appendChild(seg);
        });
        // Double-click the address bar to edit the path (as in tabby): the breadcrumb is
        // replaced by an input prefilled with the current path; Enter navigates, Esc/blur restores the breadcrumb
        el.ondblclick = () => this._editPath();
    },

    _editPath() {
        const el = document.getElementById('sftp-breadcrumb');
        if (!el || el.querySelector('input')) return; // already in edit mode
        this._editingPath = true;
        const input = document.createElement('input');
        input.className = 'sftp-path-input inline-edit';
        input.value = this._path || '/';
        input.spellcheck = false;
        el.innerHTML = '';
        el.appendChild(input);
        input.focus();
        // select the trailing directory name so typing overwrites it
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
        // ".." row
        if (this._path !== '/') {
            const up = document.createElement('div');
            up.className = 'sftp-item';
            up.innerHTML = '<span class="sftp-item-icon ic-amber">' + Icons.iconSvg('folder', 14) + '</span><span class="sftp-item-name">..</span>';
            up.addEventListener('click', () => this.goUp());
            body.appendChild(up);
        }
        this._files.forEach(f => {
            const icon = f.isDir ? '<span class="ic-amber">' + Icons.iconSvg('folder', 14) + '</span>' : Icons.iconSvg('file', 14);
            const size = f.isDir ? '' : formatSize(f.size);
            const date = formatDate(f.mtime);
            const fullPath = (this._path === '/' ? '' : this._path) + '/' + f.name;
            const el = document.createElement('div');
            el.className = 'sftp-item';
            el.innerHTML = '<span class="sftp-item-icon">' + icon + '</span>' +
                '<span class="sftp-item-name">' + escHtml(f.name) + '</span>' +
                '<span class="sftp-item-size">' + size + '</span>' +
                '<span class="sftp-item-date">' + date + '</span>';
            // no inline onclick with concatenated paths — a malicious server filename could inject HTML attributes
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
        await this.navigate(this._path, { refresh: true });
    },

    // Upload-triggered refreshes are background cleanup of the unchanged view:
    // concurrent completions coalesce behind the one refresh already in flight,
    // and the owed follow-up re-validates ownership before firing so a newer
    // user navigation or panel binding is never overwritten by the cleanup.
    // Each run carries its binding identity: only the run that still owns the
    // slot may clear it and drain the queue, so a stale finally (its panel was
    // closed/rebound, or a newer run already took the slot) touches nothing.
    _startOwnerRefresh() {
        this._refreshQueued = null;
        const run = { epoch: this._viewEpoch };
        this._refreshInFlight = run;
        this.refresh().catch(() => {}).finally(() => {
            if (this._refreshInFlight !== run) return;
            this._refreshInFlight = null;
            this._drainQueuedRefresh();
        });
    },

    _drainQueuedRefresh() {
        if (!this._refreshQueued || this._refreshInFlight) return;
        const owed = this._refreshQueued;
        this._refreshQueued = null;
        if (SFTP.isOpen && this._tabId === owed.tabId && this._path === owed.path && !this._viewReq) {
            this._startOwnerRefresh();
        }
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

    // owner = { tabId, path } captured when the batch started: every file in the
    // batch targets that session/path even if the panel closes or rebinds to
    // another session mid-batch (transfers are background work by design).
    async uploadLocal(localPath, owner) {
        const filename = localPath.split(/[\\/]/).pop();
        const remotePath = (owner.path === '/' ? '' : owner.path) + '/' + filename;
        const tid = TransferManager.add(filename, 'upload', owner.tabId);
        let transferResult;
        try {
            transferResult = await ipcRenderer.invoke('sftp-upload', { tabId: owner.tabId, localPath, remotePath, transferId: tid });
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
            // Refresh only the view that still owns this upload, and only as
            // background cleanup: the panel must still be open on the owner's
            // session/path, and the LATEST view request of that binding being in
            // flight (a newer USER navigation) owns the view — issuing a refresh
            // here would supersede it with the upload's now-stale path. A refresh
            // already running for THIS binding's earlier completion coalesces into
            // one follow-up readdir; a foreign binding's refresh (its panel was
            // closed/rebound) owns nothing here and must not delay this view.
            if (SFTP.isOpen && this._tabId === owner.tabId && this._path === owner.path) {
                const inflight = this._refreshInFlight;
                if (inflight && inflight.epoch === this._viewEpoch) {
                    this._refreshQueued = owner;
                } else if (!this._viewReq) {
                    this._startOwnerRefresh();
                }
            }
        }
    },

    async upload() {
        // Snapshot the operation target BEFORE the file-dialog await: the panel
        // may be closed or rebound to another session while the dialog is open.
        const owner = { tabId: this._tabId, path: this._path };
        const result = await ipcRenderer.invoke('show-open-dialog', { properties: ['openFile', 'multiSelections'] });
        if (result.canceled || !result.filePaths.length) return;
        for (const localPath of result.filePaths) {
            await this.uploadLocal(localPath, owner);
        }
    },

    mkdir() {
        // Electron does not support window.prompt() — use an inline input row at the top of the file list instead
        const body = document.getElementById('sftp-body');
        if (document.getElementById('sftp-mkdir-row')) return;
        const row = document.createElement('div');
        row.className = 'sftp-item';
        row.id = 'sftp-mkdir-row';
        row.innerHTML = '<span class="sftp-item-icon ic-amber">' + Icons.iconSvg('folder', 14) + '</span><input class="inline-edit" placeholder="新建目录名称，Enter 确认 / Esc 取消" style="flex:1;background:rgba(var(--accent-rgb),0.06);border:1.5px solid rgba(var(--accent-rgb),0.25);border-radius:8px;padding:4px 10px;color:#abb2bf;font-size:12.5px;font-family:inherit;outline:none">';
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
    _collapsedGroups: new Set(),

    // Session display name for a transfer owner (snapshotted at add/complete
    // time so closed sessions still group correctly afterwards).
    _sessionLabel(tabId) {
        for (const tab of (TabManager.tabs || [])) {
            if (tab.tabId === tabId) {
                if (tab.splitRoot) {
                    const pane = getAllPanes(tab).find(p => p.tabId === tabId);
                    if (pane) return pane.name || tab.name || tab.host || tabId;
                }
                return tab.name || tab.host || tabId;
            }
        }
        return '已关闭会话';
    },

    add(name, type, tabId, localPath) {
        const id = this._nextId++;
        this._transfers.push({ id, name, type, tabId, localPath, sessionLabel: this._sessionLabel(tabId), transferred: 0, total: 0, done: false, cancelled: false, startTime: Date.now(), _lastUpdate: Date.now(), _lastBytes: 0, _speed: 0 });
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
        // Throttled rendering: sftp-progress events arrive far faster than the eye can perceive,
        // and rebuilding the whole panel per event makes the speed/progress text flicker;
        // coalescing to one render per 300ms keeps speed and progress visually stable
        if (this._panelTimer) return;
        this._panelTimer = setTimeout(() => {
            this._panelTimer = null;
            this._render();
        }, 300);
    },

    complete(id) {
        const t = this._transfers.find(x => x.id === id);
        if (!t) return;
        t.done = true;
        // Save to in-memory history (lost on app restart, kept during session);
        // tabId + label snapshot keeps the session grouping intact after close
        this._history.unshift({ name: t.name, type: t.type, total: t.total, localPath: t.localPath, tabId: t.tabId, sessionLabel: t.sessionLabel, completedAt: Date.now() });
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
        // Top-bar button: count badge + activity dot (dot shows while
        // transfers are running and the flyout is closed — Flutter parity).
        const btn = document.getElementById('transfer-btn');
        if (btn) {
            const active = this._transfers.filter(t => !t.done && !t.cancelled).length;
            const countEl = btn.querySelector('.transfer-count');
            const prevCount = countEl.textContent;
            countEl.textContent = active > 0 ? active : '';
            if (active > 0 && String(active) !== prevCount) {
                countEl.classList.remove('pulse');
                void countEl.offsetWidth;
                countEl.classList.add('pulse');
            }
            const panelOpen = document.getElementById('transfer-panel')?.classList.contains('open');
            btn.classList.toggle('has-active', active > 0 && !panelOpen);
        }
        // update panel content
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
        const panel = document.getElementById('transfer-panel');
        const win = document.getElementById('transfer-window');
        panel.classList.add('open');
        // Flyout anchors below its titlebar button (bottom-left aligned,
        // WinUI MenuFlyout style), not centered like the old status-bar panel.
        const btn = document.getElementById('transfer-btn');
        if (btn && win) {
            const r = btn.getBoundingClientRect();
            win.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 380)) + 'px';
            win.style.right = 'auto';
        }
        btn?.classList.remove('has-active'); // dot hides while the flyout is open
    },

    closePanel() {
        document.getElementById('transfer-panel').classList.remove('open');
        this._render(); // re-evaluate the activity dot now that the flyout closed
    },

    toggleGroup(tabId) {
        if (!this._collapsedGroups.delete(tabId)) this._collapsedGroups.add(tabId);
        this._renderPanel();
    },

    expandAll() { this._collapsedGroups.clear(); this._renderPanel(); },
    collapseAll() { this._groups().forEach(g => this._collapsedGroups.add(g.tabId)); this._renderPanel(); },

    // Group transfers by owning session, first-seen order (active entries
    // establish group order; history-only groups follow). Order never jumps
    // while transfers progress — ported from the Flutter flyout semantics.
    _groups() {
        const order = [];
        const activeBy = new Map();
        const historyBy = new Map();
        const owner = (tabId, label) => {
            if (!activeBy.has(tabId)) { order.push(tabId); activeBy.set(tabId, []); historyBy.set(tabId, []); }
        };
        for (const t of this._transfers) { owner(t.tabId); activeBy.get(t.tabId).push(t); }
        for (const h of this._history) { owner(h.tabId || 'history'); historyBy.get(h.tabId || 'history').push(h); }
        return order.map(tabId => {
            const active = activeBy.get(tabId);
            const rate = active.reduce((sum, t) => sum + (t.done || t.cancelled ? 0 : (t._speed || 0)), 0);
            const uploads = active.filter(t => t.type === 'upload' && !t.done && !t.cancelled).length;
            const running = active.filter(t => !t.done && !t.cancelled).length;
            // Transfer direction indicator (download / upload / mixed) as inline SVG
            const dirIcon = running === 0 ? '' : uploads === 0 ? '<span class="ic-green">' + Icons.iconSvg('arrow-down', 12) + '</span>' : uploads === running ? '<span class="ic-accent">' + Icons.iconSvg('arrow-up', 12) + '</span>' : '<span class="ic-accent">' + Icons.iconSvg('arrow-up-down', 12) + '</span>';
            return {
                tabId,
                label: (active[0] || historyBy.get(tabId)[0] || {}).sessionLabel || '已关闭会话',
                active, history: historyBy.get(tabId), rate, dirIcon, running,
            };
        });
    },

    _renderPanel() {
        const body = document.getElementById('transfer-panel-body');
        const countEl = document.getElementById('transfer-header-count');
        const actionsEl = document.getElementById('transfer-header-actions');
        const groups = this._groups();
        const activeTotal = groups.reduce((s, g) => s + g.running, 0);
        if (countEl) {
            countEl.textContent = String(activeTotal);
            countEl.classList.toggle('live', activeTotal > 0);
        }
        if (actionsEl) {
            actionsEl.innerHTML = groups.length > 1
                ? '<button class="transfer-group-btn" onclick="TransferManager.expandAll()">全部展开</button>' +
                  '<button class="transfer-group-btn" onclick="TransferManager.collapseAll()">全部折叠</button>'
                : '';
        }
        let html = '';
        for (const g of groups) {
            const collapsed = this._collapsedGroups.has(g.tabId);
            const rateText = g.running > 0 && g.rate > 0 ? g.dirIcon + ' ' + formatSize(g.rate) + '/s' : '';
            html += '<div class="transfer-group">' +
                '<div class="transfer-group-header" onclick="TransferManager.toggleGroup(\'' + escHtml(g.tabId) + '\')">' +
                    '<span class="transfer-group-caret">' + (collapsed ? Icons.iconSvg('chevron-right', 12) : Icons.iconSvg('chevron-down', 12)) + '</span>' +
                    '<span class="transfer-group-name">' + escHtml(g.label) + '</span>' +
                    '<span class="transfer-group-count">' + (g.active.length + g.history.length) + '</span>' +
                    (rateText ? '<span class="transfer-group-rate">' + rateText + '</span>' : '') +
                '</div>';
            if (!collapsed) {
                html += '<div class="transfer-group-body">';
                for (const t of g.active) html += this._activeItemHtml(t);
                for (let i = 0; i < g.history.length; i++) {
                    // history index is global (removeHistory splices by it)
                    const globalIdx = this._history.indexOf(g.history[i]);
                    html += this._historyItemHtml(g.history[i], globalIdx);
                }
                html += '</div>';
            }
            html += '</div>';
        }
        body.innerHTML = html || '<div class="transfer-empty">暂无传输记录</div>';
    },

    _activeItemHtml(t) {
        const pct = t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : 0;
        const icon = t.type === 'download'
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        const barClass = t.cancelled ? 'cancelled' : t.done ? 'done' : '';
        const btn = t.done
            ? '<button class="transfer-item-btn" onclick="TransferManager.remove(' + t.id + ')">' + Icons.iconSvg('check', 12) + '</button>'
            : '<button class="transfer-item-btn" onclick="TransferManager.cancel(' + t.id + ')">' + Icons.iconSvg('x', 12) + '</button>';
        // Speed is smoothed with an EMA (instantaneous rate over the recent window) instead of
        // a whole-transfer average, which drifts monotonically and jumps on bursts — a main source of text jitter
        const now = Date.now();
        let speed = t._speed || 0;
        if (!t.done && !t.cancelled) {
            const dt = (now - t._lastUpdate) / 1000;
            if (dt > 0.05) {
                const inst = Math.max(0, t.transferred - t._lastBytes) / dt;
                t._speed = t._speed > 0 ? t._speed * 0.6 + inst * 0.4 : inst;
                t._lastUpdate = now;
                t._lastBytes = t.transferred;
                speed = t._speed;
            }
        }
        const speedText = t.done ? '完成' : t.cancelled ? '已取消' : (speed > 0 ? formatSize(speed) + '/s' : '0 B/s');
        // 4px bar with eased width transitions (Flutter TransferProgressBar:
        // 0.001-equivalent dead zone is covered by the 300ms render throttle)
        return '<div class="transfer-item">' +
            '<span class="transfer-item-icon">' + icon + '</span>' +
            '<div class="transfer-item-main">' +
                '<div class="transfer-item-name">' + escHtml(t.name) + '</div>' +
                '<div class="transfer-item-bar"><div class="transfer-item-bar-fill ' + barClass + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                '<div class="transfer-item-meta">' +
                    '<span>' + formatSize(t.transferred) + ' / ' + formatSize(t.total) + '</span>' +
                    '<span class="speed">' + speedText + '</span>' +
                '</div>' +
            '</div>' +
            btn +
        '</div>';
    },

    _historyItemHtml(h, globalIdx) {
        const icon = h.type === 'download'
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        const canOpen = h.type === 'download' && h.localPath;
        return '<div class="transfer-item"' + (canOpen ? ' style="cursor:pointer" onclick="TransferManager.openInExplorer(' + globalIdx + ')"' : '') + '>' +
            '<span class="transfer-item-icon">' + icon + '</span>' +
            '<div class="transfer-item-main">' +
                '<div class="transfer-item-name">' + escHtml(h.name) + '</div>' +
                '<div class="transfer-item-meta">' +
                    '<span>' + formatSize(h.total) + '</span>' +
                    '<span class="speed">' + formatDate(h.completedAt) + '</span>' +
                '</div>' +
            '</div>' +
            (canOpen ? '<button class="transfer-item-btn" onclick="event.stopPropagation();TransferManager.openInExplorer(' + globalIdx + ')" title="打开所在文件夹">' + Icons.iconSvg('folder-open', 13) + '</button>' : '') +
            '<button class="transfer-item-btn" onclick="event.stopPropagation();TransferManager.removeHistory(' + globalIdx + ')" title="删除记录">' + Icons.iconSvg('x', 12) + '</button>' +
        '</div>';
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

// SFTP transfer progress
ipcRenderer.on('sftp-progress', (event, { tabId, transferred, total, transferId }) => {
    TransferManager.update(transferId, transferred, total);
});

// SFTP cwd follow: auto-navigate when the SSH terminal cd's. Ownership rules:
// only the OPEN panel's own live session follows (background other-session
// events never steer it), pinned sessions stay fixed, and an in-progress
// breadcrumb path edit must not be destroyed by a follow re-render.
ipcRenderer.on('sftp-cwd-changed', (event, { tabId, cwd } = {}) => {
    if (SFTP.isOpen && !SFTP._isPinned(tabId) && SFTP._tabId === tabId && !SFTP._editingPath) {
        SFTP.navigate(cwd, { follow: true });
    }
});

// ── SFTP drag-and-drop upload (drop files onto the panel to upload into the current remote directory) ──
(() => {
    const win = document.querySelector('#overlay-sftp .sftp-window');
    if (!win) return;
    // Tauri (WebView2) has no webUtils.getPathForFile; file paths come from window-level tauri://drag-* events instead
    const isTauri = !!(window.__TAURI__ && window.__TAURI__.event);
    let dragDepth = 0;

    // Handle a batch of local paths uniformly: reject folders + upload files one by one
    function _handleDroppedPaths(paths) {
        if (!SFTP.isOpen || !SFTP._tabId) return;
        // Same ownership contract as upload(): one snapshot for the whole batch,
        // taken synchronously at drop time (uploads still start concurrently).
        const owner = { tabId: SFTP._tabId, path: SFTP._path };
        (paths || []).forEach(p => {
            if (!p) return;
            try {
                if (fs.statSync(p).isDirectory()) {
                    showToast('暂不支持上传文件夹: ' + String(p).split(/[\/]/).pop(), true);
                    return;
                }
            } catch(err) {}
            SFTP.uploadLocal(p, owner);
        });
    }

    // Tauri drag events are window-level, so we must check whether the drop point falls inside the SFTP panel
    // Note: payload.position is in physical pixels; divide by devicePixelRatio to get CSS coordinates
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
        if (isTauri) return; // under Tauri, dataTransfer.files has no paths; use the tauri://drag-drop event instead
        if (!SFTP.isOpen || !SFTP._tabId) return;
        [...(e.dataTransfer.files || [])].forEach(f => {
            // Electron 32+ removed File.path; must use webUtils.getPathForFile
            let localPath = '';
            try { localPath = webUtils.getPathForFile(f); } catch(err) {}
            if (!localPath) return;
            _handleDroppedPaths([localPath]);
        });
    });

    if (isTauri) {
        const tauriEvent = window.__TAURI__.event;
        // highlight while hovering over the panel (drag-over payload only carries position)
        tauriEvent.listen('tauri://drag-over', (event) => {
            const pos = event.payload && event.payload.position;
            if (pos && _pointInPanel(pos.x, pos.y)) win.classList.add('drag-over');
            else win.classList.remove('drag-over');
        });
        // dragged out of the window / cancelled
        tauriEvent.listen('tauri://drag-leave', () => { win.classList.remove('drag-over'); });
        // drop: upload only when released inside the panel
        tauriEvent.listen('tauri://drag-drop', (event) => {
            win.classList.remove('drag-over');
            const payload = event.payload || {};
            const pos = payload.position;
            if (pos && !_pointInPanel(pos.x, pos.y)) return;
            _handleDroppedPaths(payload.paths);
        });
    }
})();

