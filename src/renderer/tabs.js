// ZTerm - 标签页管理（TabManager 整个对象）（拆自 renderer.html，纯代码搬运，未改逻辑）
const GAP_PX = 8; // pane 间距固定像素值

// 查询 SSH profile 中的 loginScripts
function _getLoginScripts(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return [];
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return (profile && profile.loginScripts) || [];
}

// 查询 SSH profile 的 clearOnConnect（默认 true：重连清空终端；false：保留之前内容）
function _clearOnConnect(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return true;
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return !profile || profile.clearOnConnect !== false;
}

// SSH 连接（含凭据兜底）：主进程重启后 credentialId 句柄全部失效，
// 没有有效凭据时从 SSH profile 重新注册（明文不经过 renderer）
function _sshConnectWithCredentials(tab, pane, rendererId) {
    const isPane = !!pane;
    const host = isPane ? (pane._sshHost || tab.host) : tab.host;
    const port = isPane ? (pane._sshPort || tab.port) : tab.port;
    const user = isPane ? (pane._sshUser || tab.user) : tab.user;
    const credId = isPane ? (pane._sshCredId || tab._credId) : tab._credId;
    const pId = isPane ? (pane._sshProfileId || tab.sshProfileId) : tab.sshProfileId;
    let followCwd = false;
    if (pId) {
        const p = (TabManager.sshProfiles || []).find(x => x.id === pId);
        if (p) followCwd = !!p.followCwd;
    }
    const send = (cid) => {
        ipcRenderer.send('ssh-connect', {
            profile: { host, port, username: user, credentialId: cid || null, followCwd, loginScripts: _getLoginScripts(tab, pane) },
            rendererId,
        });
    };
    if (credId) { send(credId); return; }
    const prof = pId ? (TabManager.sshProfiles || []).find(x => x.id === pId) : null;
    if (prof && (prof.encryptedPassword || prof.privateKeyPath)) {
        ipcRenderer.invoke('register-credential', {
            encryptedPassword: prof.encryptedPassword || '',
            privateKeyPath: prof.privateKeyPath || '',
        }).then(({ credId: newCredId }) => {
            if (newCredId) {
                if (isPane) pane._sshCredId = newCredId;
                else tab._credId = newCredId;
            }
            send(newCredId);
        }).catch(() => send(null));
    } else {
        send(null);
    }
}

// ── Tab Manager ──
const TabManager = {
    tabs: [],
    activeId: null,
    _counter: 1,
    _paneCounter: 1,
    _activeTabEl: null,
    profiles: [],
    sshProfiles: [],
    _maximizedPaneId: null,
    _closedTabIds: new Set(),
    _dragTab: null, // { sourceTabId, targetTabId, side: 'left'|'right' }

    init() {
        ipcRenderer.once('profiles', async (event, { profiles, sshProfiles, lastTabs }) => {
            // 自动探测本机 shell（Git Bash/WSL 等），保留 config 里探测不到的自定义条目
            let detected = [];
            try { detected = await ipcRenderer.invoke('get-local-shells') || []; } catch(e) {}
            const custom = (profiles || []).filter(p => !detected.some(d => d.command === p.command));
            this.profiles = detected.length > 0 ? [...detected, ...custom] : (profiles || []);
            this.sshProfiles = sshProfiles || [];

            // 过滤设置页/坏数据（旧版本可能把 settings tab 存进了 lastTabs）
            const tabsToRestore = ((lastTabs && lastTabs.length > 0) ? lastTabs : [])
                .filter(t => t && typeof t === 'object' && t.type !== 'settings');
            if (tabsToRestore.length === 0) tabsToRestore.push(getDefaultLocalProfile());

            tabsToRestore.forEach(t => {
                // 有分屏数据则走完整恢复路径
                if (t.splitRoot) {
                    this._restoreSplitTab(t);
                    return;
                }
                let sshOpts = null;
                if (t.type === 'ssh') {
                    sshOpts = { host: t.host, port: t.port, user: t.user, sshProfileId: t.sshProfileId };
                    if (t.sshProfileId) {
                        const profile = (this.sshProfiles || []).find(p => p.id === t.sshProfileId);
                        if (profile) {
                            sshOpts.host = sshOpts.host || profile.host;
                            sshOpts.port = sshOpts.port || profile.port;
                            sshOpts.user = sshOpts.user || profile.username;
                            sshOpts.privateKey = profile.privateKeyPath;
                            sshOpts._encryptedPwd = profile.encryptedPassword;
                            sshOpts.followCwd = !!profile.followCwd;
                            sshOpts.loginScripts = profile.loginScripts || [];
                        }
                    }
                }
                const tid = this.createTabSilent(t.name, t.command || 'powershell.exe', t.type || 'local', sshOpts, t.args);
                const tab = this.tabs.find(x => x.id === tid);
                if (tab && t.content) tab._contentBuffer = t.content;

                if (sshOpts && sshOpts._encryptedPwd) {
                    const capturedId = tid;
                    const capturedOpts = sshOpts;
                    // 注册凭据到主进程，拿 credentialId；明文密码不回传 renderer
                    ipcRenderer.invoke('register-credential', {
                        encryptedPassword: sshOpts._encryptedPwd,
                        privateKeyPath: sshOpts.privateKey,
                    }).then(({ credId, error }) => {
                        const reTab = this.tabs.find(x => x.id === capturedId);
                        if (!reTab || reTab.connected) return;
                        if (error || !credId) {
                            reTab.connected = false;
                            this.render();
                            return;
                        }
                        reTab._credId = credId;
                        ipcRenderer.send('ssh-connect', {
                            profile: { host: capturedOpts.host, port: capturedOpts.port || 22, username: capturedOpts.user, credentialId: credId, followCwd: capturedOpts.followCwd, loginScripts: capturedOpts.loginScripts || [] },
                            rendererId: capturedId,
                        });
                    });
                }
            });
            this.render();
            if (this.tabs.length > 0) {
                this.switchTo(this.tabs[0].id);
            }
        });
        ipcRenderer.send('get-profiles');

        const main = document.getElementById('main-area');
        if (main) {
            main.ondragover = (e) => this._onMainDragOver(e);
            main.ondragleave = (e) => this._onMainDragLeave(e);
            main.ondrop = (e) => this._onMainDrop(e);
        }
    },

    createTabSilent(name, command, type, sshOpts, args) {
        const id = 't_' + (this._counter++);
        const isSSH = type === 'ssh';
        const tab = {
            id, name: name || 'PowerShell', type: type || 'local',
            command: isSSH ? '' : (command || 'powershell.exe'),
            args: isSSH ? [] : (args || []),
            connected: !isSSH,
        };
        if (isSSH && sshOpts) {
            Object.assign(tab, {
                host: sshOpts.host, port: sshOpts.port, user: sshOpts.user,
                privateKey: sshOpts.privateKey, sshProfileId: sshOpts.sshProfileId,
                _credId: sshOpts.credId,
            });
        }
        this.tabs.push(tab);
        if (isSSH) {
            if (sshOpts && sshOpts.host && (sshOpts.credId || sshOpts.privateKey)) {
                ipcRenderer.send('ssh-connect', { profile: { host: sshOpts.host, port: sshOpts.port || 22, username: sshOpts.user, credentialId: sshOpts.credId, followCwd: sshOpts.followCwd, loginScripts: sshOpts.loginScripts || [] }, rendererId: id });
            }
        } else {
            ipcRenderer.send('pty-create', { shell: tab.command, args: tab.args, cwd: _settingsConfig.startupDir || undefined, requestId: id });
        }
        return id;
    },

    createTab(options = {}) {
        const { name, type, command, args, host, port, user, credId, privateKey, sshProfileId } = options;
        const id = 't_' + (this._counter++);
        const isSSH = type === 'ssh';
        const tab = {
            id, name: name || 'PowerShell',
            type: type || 'local',
            command: isSSH ? '' : (command || 'powershell.exe'),
            args: isSSH ? [] : (args || []),
            connected: !isSSH,
            host, port, user, _credId: credId, privateKey, sshProfileId,
        };
        this.tabs.push(tab);
        this.switchTo(id);
        this.render();
        if (isSSH) {
            // Look up followCwd from SSH profile
            let followCwd = false;
            if (sshProfileId) {
                const p = (TabManager.sshProfiles || []).find(x => x.id === sshProfileId);
                if (p) followCwd = !!p.followCwd;
            }
            ipcRenderer.send('ssh-connect', { profile: { host, port, username: user, credentialId: credId, followCwd, loginScripts: _getLoginScripts(tab) }, rendererId: id });
        } else {
            ipcRenderer.send('pty-create', { shell: tab.command, args: tab.args, cwd: _settingsConfig.startupDir || undefined, requestId: id });
        }
        return id;
    },

    switchTo(id) {
        if (this.activeId === id) {
            const tab = this.tabs.find(t => t.id === id);
            if (tab && tab.type === 'ssh' && !tab.connected) this.reconnectTab(id);
            return;
        }
        if (this.activeId) {
            const oldTab = this.tabs.find(t => t.id === this.activeId);
            if (oldTab && oldTab.type === 'settings') {
                document.getElementById('settings-pane').classList.remove('active');
            } else if (oldTab && oldTab.splitRoot) {
                const split = document.getElementById('split_' + this.activeId);
                if (split) split.style.display = 'none';
            } else {
                const el = document.getElementById('wrap_' + this.activeId);
                if (el) el.classList.remove('active');
            }
        }
        this.activeId = id;
        this.updateActiveClass();
        const tab = this.tabs.find(t => t.id === id);
        if (tab && tab.type === 'settings') {
            document.getElementById('settings-pane').classList.add('active');
            const sshPage = document.querySelector('#settings-content .settings-page[data-page="ssh"]');
            if (sshPage && sshPage.classList.contains('active')) renderSSHManagerInSettings();
            loadSettingsIntoForm();
        } else if (tab && tab.splitRoot) {
            const split = document.getElementById('split_' + id);
            if (split) { split.style.display = 'flex'; this._layoutTime = Date.now(); this._layoutSplit(tab); }
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused && focused.term) {
                if (focused.fitAddon) setTimeout(() => {
                    _fitWithScroll(focused.term, focused.fitAddon, document.getElementById('pane-body_' + focused.id));
                }, 250);
                setTimeout(() => focused.term.focus(), 250);
            }
        } else {
            const el = document.getElementById('wrap_' + id);
            if (el) {
                el.classList.add('active');
                if (tab && tab.fitAddon) setTimeout(() => {
                    _fitWithScroll(tab.term, tab.fitAddon, tab.term?.element?.parentElement);
                }, 10);
                if (tab && tab.term) setTimeout(() => tab.term.focus(), 100);
            }
        }
        this.updateStatus();
    },

    closeTab(id) {
        if (this.tabs.length <= 1) return;
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const tab = this.tabs[idx];
        const wasActive = this.activeId === id;
        if (tab.type === 'settings') {
            document.getElementById('settings-pane')?.classList.remove('active');
        }
        // 关闭动画：tab 元素缩小淡出（200ms cubic-bezier 0.05,0.7,0.1,1，与 panel/pane 同曲线）
        const tabEl = document.querySelector(`.tab[data-tab="${id}"]`);
        if (tabEl) tabEl.classList.add('tab-exit');
        // 算 next tab：必须在 splice 之前算（splice 后 idx 位置会被原 idx+1 占据）
        // 优先取右侧 (idx+1)，关的是最后一个则取左侧 (idx-1)
        let next = null;
        if (wasActive) {
            if (idx + 1 < this.tabs.length) {
                next = this.tabs[idx + 1];
            } else {
                next = this.tabs[idx - 1];
            }
        }
        // 立即切到 next（老 wrap 立即 hide，next wrap 立即 show）
        if (next) this.switchTo(next.id);
        const doRemove = () => {
            this.tabs.splice(idx, 1);
            // 释放主进程内存中的明文凭据（如果有）。克隆出的 tab 不拥有凭据所有权，不撤
            if (tab._credId && !tab._cloneCred) ipcRenderer.send('revoke-credential', { credId: tab._credId });
            if (tab.splitRoot) {
                getAllPanes(tab).forEach(p => {
                    if (p.tabId) { ipcRenderer.send('pty-destroy', { tabId: p.tabId }); delete ptyBuffers[p.tabId]; }
                    if (p.term) try { p.term.dispose(); } catch(e) {}
                });
                const split = document.getElementById('split_' + id);
                if (split) split.remove();
                tab.splitRoot = null; // 防止残留引用被后续代码误判为仍存活
            } else {
                const el = document.getElementById('wrap_' + id);
                if (el) el.remove();
                if (tab.tabId) { ipcRenderer.send('pty-destroy', { tabId: tab.tabId }); delete ptyBuffers[tab.tabId]; }
                if (tab.term) try { tab.term.dispose(); } catch(e) {}
            }
            this.render();
        };
        if (tabEl) {
            setTimeout(doRemove, 200);
        } else {
            doRemove();
        }
    },

    reconnectTab(id) {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab || tab.type !== 'ssh') return;

        if (tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) this._reconnectPane(tab.id, focused.id);
            return;
        }

        if (tab.tabId) ipcRenderer.send('ssh-disconnect', { tabId: tab.tabId });
        if (_clearOnConnect(tab, null)) {
            if (tab.term) { try { tab.term.dispose(); } catch(e) {}; tab.term = null; tab.fitAddon = null; }
            const wrap = document.getElementById('wrap_' + id);
            if (wrap) wrap.remove();
        } else if (tab.term) {
            // 保留内容：写入分隔线，新输出接在旧内容后面
            tab.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
        }
        tab.tabId = null;
        tab.connected = false;
        this.render();
        this.updateStatus();
        setTimeout(() => {
            if (!this.tabs.find(t => t.id === id)) return;
            _sshConnectWithCredentials(tab, null, id);
        }, 500);
    },

    _reconnectPane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        const pane = findPane(tab, paneId);
        if (!pane) return;
        if (pane.tabId) ipcRenderer.send('ssh-disconnect', { tabId: pane.tabId });
        if (_clearOnConnect(tab, pane)) {
            if (pane.term) { try { pane.term.dispose(); } catch(e) {}; pane.term = null; pane.fitAddon = null; }
            const body = document.getElementById('pane-body_' + pane.id);
            if (body) body.innerHTML = '';
        } else if (pane.term) {
            // 保留内容：写入分隔线，新输出接在旧内容后面
            pane.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
        }
        pane.tabId = null;
        tab.connected = false;
        this.render();
        this.updateStatus();
        setTimeout(() => {
            if (!this.tabs.find(t => t.id === tab.id)) return;
            _sshConnectWithCredentials(tab, pane, pane.requestId);
        }, 500);
    },

    getActive() { return this.tabs.find(t => t.id === this.activeId); },

    render() {
        const bar = document.getElementById('tabbar');
        bar.querySelectorAll('.tab').forEach(el => el.remove());

        let addBtn = document.getElementById('btn-add-tab');
        if (!addBtn) {
            addBtn = document.createElement('div');
            addBtn.id = 'btn-add-tab';
            addBtn.title = '新建标签页（默认终端），Ctrl+Shift+N 选择会话';
            addBtn.textContent = '+';
            addBtn.onclick = () => {
                const p = getDefaultLocalProfile();
                TabManager.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
            };
            bar.appendChild(addBtn);
        }
        if (!document.getElementById('btn-menu')) {
            const menuBtn = document.createElement('div');
            menuBtn.id = 'btn-menu';
            menuBtn.title = '菜单';
            menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
            menuBtn.onclick = (e) => { e.stopPropagation(); toggleMenuPopup(); };
            bar.appendChild(menuBtn);
        }

        // Render non-settings tabs first, settings tab always at the end (rightmost)
        const sortedTabs = [...this.tabs].sort((a, b) => {
            if (a.type === 'settings' && b.type !== 'settings') return 1;
            if (a.type !== 'settings' && b.type === 'settings') return -1;
            return 0;
        });
        sortedTabs.forEach(t => {
            const div = document.createElement('div');
            div.className = 'tab';
            div.setAttribute('data-tab', t.id);
            div.title = t.name;
            div.draggable = (t.type !== 'settings');
            div.onclick = () => this.switchTo(t.id);
            div.ondblclick = (e) => { if (t.type !== 'settings') { e.stopPropagation(); this.startRenameTab(t.id); } };
            div.oncontextmenu = (e) => { if (t.type !== 'settings') { e.preventDefault(); this.showTabContextMenu(e, t.id); } };
            div.ondragstart = (e) => this._onTabDragStart(e, t.id);
            div.ondragend = (e) => this._onTabDragEnd(e);
            // Drag-to-reorder within tabbar
            div.ondragover = (e) => this._onTabDragOver(e, t.id);
            div.ondrop = (e) => this._onTabDrop(e, t.id);
            let inner;
            if (t.type === 'settings') {
                inner = `<span style="font-size:14px">⚙</span> ${t.name}`;
            } else {
                let dotClass = t.connected ? 'connected' : 'disconnected';
                const showDot = _settingsConfig.showStatusDot !== false;
                inner = (showDot ? `<span class="tab-icon ${dotClass}"></span>` : '') + `<span class="tab-name">${escHtml(t.name)}</span>`;
                // 分屏时不在 tab 标签显示重连按钮，改为 pane header 里各 pane 独立重连
                if (t.type === 'ssh' && !t.splitRoot) {
                    const rcClass = t.connected ? 'tab-reconnect-normal' : 'tab-reconnect';
                    const rcTitle = t.connected ? '强制重连' : '重新连接';
                    inner += `<span class="${rcClass}" title="${rcTitle}" onclick="event.stopPropagation();TabManager.reconnectTab('${t.id}')">↻</span>`;
                }
            }
            inner += `<span class="tab-close" onclick="event.stopPropagation();TabManager.closeTab('${t.id}')">×</span>`;
            div.innerHTML = inner;
            bar.insertBefore(div, addBtn);
        });
        this.updateActiveClass();
    },

    updateActiveClass() {
        if (this._activeTabEl) this._activeTabEl.classList.remove('active');
        const bar = document.getElementById('tabbar');
        if (!bar) return;
        const el = bar.querySelector(`.tab[data-tab="${this.activeId}"]`);
        if (el) {
            el.classList.add('active');
            this._activeTabEl = el;
        }
    },

    updateStatus() {
        const t = this.getActive();
        if (!t) return;
        if (t.type === 'settings') {
            document.getElementById('sb-conn').textContent = '⚙ 设置';
            return;
        }
        let icon = '⊞';
        let info = t.name;
        if (t.type === 'ssh') {
            icon = '⚡';
            info = t.user ? `${t.user}@${t.host}` : t.name;
            if (!t.connected) info += ' (已断开)';
        }
        document.getElementById('sb-conn').textContent = `${icon} ${info}`;
    },

    // ── Split pane support (Tabby-aligned absolute model) ──
    _createContainer(orientation) { return { orientation, children: [], ratios: [] }; },

    _newPaneData(tab) {
        const id = 'p_' + (this._paneCounter++);
        const isLocal = tab.type !== 'ssh';
        return {
            id,
            requestId: id,
            tabId: null,
            term: null,
            fitAddon: null,
            focused: false,
            name: tab.name,
            type: tab.type || 'local',
            connected: isLocal || tab.connected,
            _sshHost: tab.host,
            _sshPort: tab.port,
            _sshUser: tab.user,
            _sshCredId: tab._credId,
            _sshProfileId: tab.sshProfileId,
            _command: isLocal ? (tab.command || '') : '',
            _args: isLocal ? (tab.args || []) : [],
        };
    },

    _spawnBackendForPane(pane, tab) {
        const host = pane._sshHost || tab.host;
        const port = pane._sshPort || tab.port;
        const user = pane._sshUser || tab.user;
        let credId = pane._sshCredId || tab._credId;
        if (pane.type === 'ssh' && host) {
            const doConnect = (cid) => {
                let followCwd = false;
                const pId = pane._sshProfileId || tab.sshProfileId;
                if (pId) {
                    const p = (TabManager.sshProfiles || []).find(x => x.id === pId);
                    if (p) followCwd = !!p.followCwd;
                }
                ipcRenderer.send('ssh-connect', {
                    profile: { host, port, username: user, credentialId: cid || null, followCwd, loginScripts: _getLoginScripts(tab, pane) },
                    rendererId: pane.requestId,
                });
            };
            // 没有凭据时从 SSH profile 重新注册
            if (!credId) {
                const pId = pane._sshProfileId || tab.sshProfileId;
                const prof = pId ? (TabManager.sshProfiles || []).find(x => x.id === pId) : null;
                if (prof && (prof.encryptedPassword || prof.privateKeyPath)) {
                    ipcRenderer.invoke('register-credential', {
                        encryptedPassword: prof.encryptedPassword || '',
                        privateKeyPath: prof.privateKeyPath || '',
                    }).then(({ credId: newCredId }) => {
                        if (newCredId) pane._sshCredId = newCredId;
                        doConnect(newCredId);
                    }).catch(() => doConnect(null));
                    return;
                }
            }
            doConnect(credId);
        } else {
            ipcRenderer.send('pty-create', { shell: pane._command || tab.command || 'powershell.exe', args: pane._args || tab.args || [], cwd: _settingsConfig.startupDir || undefined, requestId: pane.requestId });
        }
    },

    splitHorizontal() {
        const tab = this.getActive();
        if (tab && tab.type !== 'settings') this.addPaneRelativeTo(tab, 'r');
    },

    splitVertical() {
        const tab = this.getActive();
        if (tab && tab.type !== 'settings') this.addPaneRelativeTo(tab, 'b');
    },

    addPaneRelativeTo(tab, side) {
        if (!tab.splitRoot) {
            if (!tab.term && !tab.tabId) return;
            const ew = document.getElementById('wrap_' + tab.id);
            if (ew) ew.remove();
            const existing = this._newPaneData(tab);
            existing.term = tab.term;
            existing.fitAddon = tab.fitAddon;
            existing.tabId = tab.tabId;
            existing.focused = false;
            tab.term = null;
            tab.fitAddon = null;
            tab.tabId = null;
            const newPane = this._newPaneData(tab);
            const isH = side === 'l' || side === 'r';
            tab.splitRoot = this._createContainer(isH ? 'h' : 'v');
            if (side === 'l' || side === 't') tab.splitRoot.children = [newPane, existing];
            else tab.splitRoot.children = [existing, newPane];
            tab.splitRoot.ratios = [0.5, 0.5];
            newPane.focused = true;
            this._maximizedPaneId = null;
            this._renderSplit(tab);
            this._spawnBackendForPane(newPane, tab);
            this._updateTabName(tab);
            this.render();
            return;
        }
        const all = getAllPanes(tab);
        const focused = all.find(p => p.focused) || all[all.length - 1];
        if (!focused) return;
        const newPane = this._newPaneData(tab);
        // 若 tab 缺少凭据（如 restore 出来的 split tab），从 focused pane 继承
        if (!tab._credId && focused._sshCredId) {
            newPane._sshHost = focused._sshHost || tab.host;
            newPane._sshPort = focused._sshPort || tab.port;
            newPane._sshUser = focused._sshUser || tab.user;
            newPane._sshCredId = focused._sshCredId;
            newPane._sshProfileId = focused._sshProfileId || tab.sshProfileId;
        }
        this.add(tab, newPane, focused, side);
        all.forEach(p => p.focused = false);
        newPane.focused = true;
        this._maximizedPaneId = null;
        tab._newPaneId = newPane.id;
        this._layoutTime = Date.now();
        this._renderSplit(tab);
        this._spawnBackendForPane(newPane, tab);
        this._updateTabName(tab);
        this.render();
    },

    add(tab, thing, relative, side) {
        // Tabby add 语义：relative 为空（根边缘 zone）或未找到父容器时，重打包根容器
        let target = relative ? getParentOf(tab, relative) : null;
        if (!target) {
            target = this._createContainer(['l', 'r'].includes(side) ? 'h' : 'v');
            target.children = [tab.splitRoot];
            target.ratios = [1];
            tab.splitRoot = target;
        }
        let insertIndex = relative
            ? target.children.indexOf(relative) + ('tl'.includes(side) ? 0 : 1)
            : 'tl'.includes(side) ? 0 : -1;
        if (
            (target.orientation === 'v' && ['l', 'r'].includes(side)) ||
            (target.orientation === 'h' && ['t', 'b'].includes(side))
        ) {
            const newContainer = this._createContainer(['l', 'r'].includes(side) ? 'h' : 'v');
            newContainer.children = relative ? [relative] : [];
            newContainer.ratios = [1];
            target.children.splice(relative ? target.children.indexOf(relative) : -1, 1, newContainer);
            target = newContainer;
            insertIndex = 'tl'.includes(side) ? 0 : 1;
        }
        for (let i = 0; i < target.children.length; i++) {
            target.ratios[i] *= target.children.length / (target.children.length + 1);
        }
        if (insertIndex === -1) insertIndex = target.ratios.length;
        target.ratios.splice(insertIndex, 0, 1 / (target.children.length + 1));
        target.children.splice(insertIndex, 0, thing);
        normalize(tab.splitRoot);
    },

    _renderSplit(tab) {
        const main = document.getElementById('main-area');
        const old = document.getElementById('split_' + tab.id);
        if (old) old.remove();
        document.getElementById('wrap_' + tab.id)?.remove();
        if (!tab.splitRoot) return;

        const rootEl = document.createElement('div');
        rootEl.id = 'split_' + tab.id;
        rootEl.className = 'split-root' + (tab.syncInput ? ' sync-input' : '');
        main.appendChild(rootEl);

        const buildPane = (pane) => {
            const el = document.createElement('div');
            el.className = 'split-pane' + (pane.focused ? ' active' : '');
            el.setAttribute('data-pane', pane.id);
            el.onmousedown = () => { if (!tab._maximizedPaneId) this._focusPane(tab, pane.id); };
            // pane 拖拽重排走 Tabby 式 drop zone 层（_onPaneDragStart 时渲染），pane 自身不挂 drop 监听
            const dc = (pane.connected !== false && (pane.connected || !!pane.tabId)) ? 'connected' : 'disconnected';
            const showDot = _settingsConfig.showStatusDot !== false;
            const hdr = document.createElement('div');
            hdr.className = 'pane-header';
            // 只在 SSH pane 中显示 SFTP 和重连按钮
            const sftpBtn = pane.type === 'ssh' ? '<button title="SFTP" onclick="event.stopPropagation();TabManager._openSFTP(\'' + tab.id + '\',\'' + pane.id + '\')">📁</button>' : '';
            const reconnectPaneBtn = pane.type === 'ssh' ? '<button title="强制重连" onclick="event.stopPropagation();TabManager._reconnectPane(\'' + tab.id + '\',\'' + pane.id + '\')">↻</button>' : '';
            hdr.innerHTML = (showDot ? '<span class="dot ' + dc + '"></span>' : '') +
                '<span class="label">' + escHtml(pane.name || tab.name) + '</span>' +
                sftpBtn +
                reconnectPaneBtn +
                '<button title="extract" onclick="event.stopPropagation();TabManager._extractPaneToTab(\'' + tab.id + '\',\'' + pane.id + '\')">&#11023;</button>' +
                '<button title="maximize" onclick="event.stopPropagation();TabManager._maximizePane(\'' + tab.id + '\',\'' + pane.id + '\')">⛶</button>' +
                '<button title="close" onclick="event.stopPropagation();TabManager._closePane(\'' + tab.id + '\',\'' + pane.id + '\')">×</button>';
            el.appendChild(hdr);
            // 拖拽重排：Tabby 同款指针拖拽（mousedown 跟踪，不用 HTML5 draggable）
            hdr.addEventListener('mousedown', (e) => this._onPaneHeaderMouseDown(e, tab, pane));
            const body = document.createElement('div');
            body.className = 'pane-body';
            body.id = 'pane-body_' + pane.id;
            if (pane.term) body.appendChild(pane.term.element);
            el.appendChild(body);
            return el;
        };

        const allPanes = getAllPanes(tab);
        allPanes.forEach(p => {
            rootEl.appendChild(buildPane(p));
            const body = document.getElementById('pane-body_' + p.id);
            if (body && p.term) {
                if (body._resizeObserver) body._resizeObserver.disconnect();
                let raf = false;
                const obs = new ResizeObserver(() => {
                    if (raf) return;
                    raf = true;
                    requestAnimationFrame(() => {
                        if (!_spannerDrag && !TabManager._maximizing) _fitWithScroll(p.term, p.fitAddon, body);
                        raf = false;
                    });
                });
                obs.observe(body);
                body._resizeObserver = obs;
            }
        });
        this._layoutTime = Date.now();
        this._layoutSplit(tab);
        // Enter animation for newly created pane
        if (tab._newPaneId) {
            const newId = tab._newPaneId;
            delete tab._newPaneId;
            const newEl = rootEl.querySelector('.split-pane[data-pane="' + newId + '"]');
            if (newEl) {
                newEl.classList.add('pane-enter');
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    newEl.classList.remove('pane-enter');
                }));
            }
        }
        setTimeout(() => {
            allPanes.forEach(p => {
                if (p.term && p.fitAddon) _fitWithScroll(p.term, p.fitAddon, document.getElementById('pane-body_' + p.id));
            });
        }, 250);
    },

    _layoutSplit(tab) {
        if (!tab.splitRoot) return;
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl) return;
        const rootRect = rootEl.getBoundingClientRect();
        tab._gapXPct = (GAP_PX / rootRect.width) * 100;
        tab._gapYPct = (GAP_PX / rootRect.height) * 100;
        const maximizedPane = tab._maximizedPaneId ? findPane(tab, tab._maximizedPaneId) : null;
        const panes = getAllPanes(tab);
        panes.forEach(p => {
            const el = rootEl.querySelector('.split-pane[data-pane="' + p.id + '"]');
            if (el) {
                el.classList.toggle('active', p.focused && !maximizedPane);
                el.classList.toggle('maximized', maximizedPane === p);
                el.classList.toggle('minimized', !!maximizedPane && maximizedPane !== p);
                el.style.display = '';
            }
        });
        this._layoutInternal(tab, tab.splitRoot, 0, 0, 100, 100);
        rootEl.querySelectorAll('.split-spanner').forEach(s => s.remove());
        if (maximizedPane) {
            const maxEl = rootEl.querySelector('.split-pane[data-pane="' + maximizedPane.id + '"]');
            if (maxEl) {
                maxEl.style.left = '0';
                maxEl.style.top = '0';
                maxEl.style.width = '100%';
                maxEl.style.height = '100%';
            }
            rootEl.querySelectorAll('.split-pane').forEach(el => {
                if (el !== maxEl) el.style.display = 'none';
            });
            return;
        }
        this._addSpanners(tab, tab.splitRoot);
        // 动画结束后的尺寸结算（onResize 抑制窗口会丢掉动画末的最终尺寸，否则 nvim 等 TUI 界面混乱）
        _scheduleSettleResize(tab);
    },

    _layoutInternal(tab, container, x, y, w, h) {
        container._x = x;
        container._y = y;
        container._w = w;
        container._h = h;
        const isV = container.orientation === 'v';
        const gap = isV ? (tab._gapYPct || 0) : (tab._gapXPct || 0);
        const size = isV ? h : w;
        const n = container.children.length;
        const totalGap = (n - 1) * gap;
        const avail = Math.max(size - totalGap, 0);
        const sizes = container.ratios.map(r => r * avail);
        let offset = 0;
        container.children.forEach((child, i) => {
            const childX = isV ? x : x + offset;
            const childY = isV ? y + offset : y;
            const childW = isV ? w : sizes[i];
            const childH = isV ? sizes[i] : h;
            if (child.orientation) {
                this._layoutInternal(tab, child, childX, childY, childW, childH);
            } else {
                const el = document.getElementById('split_' + tab.id)?.querySelector('.split-pane[data-pane="' + child.id + '"]');
                if (el) {
                    if (tab._maximizedPaneId && tab._maximizedPaneId === child.id) {
                        el.style.left = '0.5%';
                        el.style.top = '0.5%';
                        el.style.width = '99%';
                        el.style.height = '99%';
                    } else {
                        el.style.left = childX + '%';
                        el.style.top = childY + '%';
                        el.style.width = childW + '%';
                        el.style.height = childH + '%';
                    }
                }
            }
            offset += sizes[i] + gap;
        });
    },

    _addSpanners(tab, container) {
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl) return;
        const isH = container.orientation === 'h';
        const gap = isH ? (tab._gapXPct || 0) : (tab._gapYPct || 0);
        const size = isH ? container._w : container._h;
        const n = container.children.length;
        const totalGap = (n - 1) * gap;
        const avail = Math.max(size - totalGap, 0);
        let offset = 0;
        for (let i = 1; i < n; i++) {
            offset += container.ratios[i - 1] * avail + gap;
            const spanner = document.createElement('div');
            // Horizontal container -> vertical divider; vertical container -> horizontal divider
            spanner.className = 'split-spanner ' + (isH ? 'v' : 'h');
            if (isH) {
                spanner.style.left = (container._x + offset - gap / 2) + '%';
                spanner.style.top = container._y + '%';
                spanner.style.height = container._h + '%';
            } else {
                spanner.style.top = (container._y + offset - gap / 2) + '%';
                spanner.style.left = container._x + '%';
                spanner.style.width = container._w + '%';
            }
            spanner.onmousedown = (e) => _startSpannerDrag(e, tab, container, i);
            spanner.ondblclick = (e) => {
                e.stopPropagation();
                const r = (container.ratios[i - 1] + container.ratios[i]) / 2;
                container.ratios[i - 1] = r;
                container.ratios[i] = r;
                this._layoutSplit(tab);
            };
            rootEl.appendChild(spanner);
        }
        container.children.forEach(child => {
            if (child.orientation) this._addSpanners(tab, child);
        });
    },

    // ── Pane drag swap（任意两个 pane 交换位置和尺寸）──
    _paneDragState: null,

    // Tabby 同款指针拖拽：mousedown 按下标题，移动超阈值进入拖拽，移动中命中 drop zone，松开执行插入
    _onPaneHeaderMouseDown(e, tab, pane) {
        if (e.button !== 0 || tab._maximizedPaneId) return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        this._paneDragState = { sourceTab: tab, sourcePane: pane, startX: e.clientX, startY: e.clientY, dragging: false, zones: [], ghost: null };
        const move = (ev) => this._onPanePointerMove(ev);
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            this._onPanePointerUp(ev);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    },

    _onPanePointerMove(e) {
        const state = this._paneDragState;
        if (!state) return;
        if (!state.dragging) {
            if (Math.abs(e.clientX - state.startX) + Math.abs(e.clientY - state.startY) < 5) return;
            state.dragging = true;
            document.body.classList.add('pane-dragging');
            // 源 pane 半透明（Tabby 行为）
            const el = document.querySelector(`.split-pane[data-pane="${state.sourcePane.id}"]`);
            if (el) el.style.opacity = '0.4';
            this._showPaneDropZones(state.sourceTab);
            this._showPaneDragGhost(state, e);
        }
        this._movePaneDragGhost(state, e);
        // 命中检测（Tabby 的 drop zone highlighted）
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const zoneEl = hit && hit.closest ? hit.closest('.pane-drop-zone') : null;
        document.querySelectorAll('.pane-drop-zone.drag-over').forEach(el => { if (el !== zoneEl) el.classList.remove('drag-over'); });
        if (zoneEl) zoneEl.classList.add('drag-over');
    },

    _onPanePointerUp(e) {
        const state = this._paneDragState;
        if (!state) return;
        if (state.dragging) {
            const hit = document.elementFromPoint(e.clientX, e.clientY);
            const zoneEl = hit && hit.closest ? hit.closest('.pane-drop-zone') : null;
            if (zoneEl) {
                const zone = state.zones[parseInt(zoneEl.getAttribute('data-zone-idx'), 10)];
                if (zone) this._movePaneToZone(state.sourceTab, zone);
            }
        }
        this._onPaneDragEnd();
    },

    _showPaneDragGhost(state, e) {
        const ghost = document.createElement('div');
        ghost.className = 'pane-drag-ghost';
        ghost.textContent = state.sourcePane.name || state.sourceTab.name;
        document.body.appendChild(ghost);
        state.ghost = ghost;
        this._movePaneDragGhost(state, e);
    },

    _movePaneDragGhost(state, e) {
        if (state.ghost) {
            state.ghost.style.left = (e.clientX + 12) + 'px';
            state.ghost.style.top = (e.clientY + 14) + 'px';
        }
    },

    // ── Tabby 同款 pane 拖拽重排：计算 drop zone 条带，命中即按 side 定向插入 ──

    // 计算 drop zones（对齐 Tabby layoutInternal）：根容器四边 + 每个 child 的侧边条 + spanner 缝隙条
    _computePaneDropZones(tab) {
        const zones = [];
        const T = 8; // zone 厚度（占 split 区域百分比，Tabby 为 10）
        const walk = (container, x, y, w, h) => {
            const isV = container.orientation === 'v';
            const gap = isV ? (tab._gapYPct || 0) : (tab._gapXPct || 0);
            const size = isV ? h : w;
            const avail = Math.max(size - (container.children.length - 1) * gap, 0);
            const sizes = container.ratios.map(r => r * avail);
            // 根容器四边（Tabby: root 的 l/t/r/b）
            if (container === tab.splitRoot) {
                zones.push({ x: x - T / 2, y: y + T, w: T, h: h - T * 2, side: 'l', relativeTo: null });
                zones.push({ x, y: y - T / 2, w, h: T, side: 't', relativeTo: null });
                zones.push({ x: x + w - T / 2, y: y + T, w: T, h: h - T * 2, side: 'r', relativeTo: null });
                zones.push({ x, y: y + h - T / 2, w, h: T, side: 'b', relativeTo: null });
            }
            let offset = 0;
            container.children.forEach((child, i) => {
                const childX = isV ? x : x + offset;
                const childY = isV ? y + offset : y;
                const childW = isV ? w : sizes[i];
                const childH = isV ? sizes[i] : h;
                if (child.orientation) walk(child, childX, childY, childW, childH);
                offset += sizes[i];
                // spanner 缝隙 zone：沿容器方向插到 child 之后（Tabby: 对每个非末尾 child 都加）
                if (i !== container.ratios.length - 1) {
                    zones.push({
                        x: isV ? childX + T : childX + offset - T / 2,
                        y: isV ? childY + offset - T / 2 : childY + T,
                        w: isV ? childW - T * 2 : T,
                        h: isV ? T : childH - T * 2,
                        side: isV ? 'b' : 'r',
                        relativeTo: child,
                    });
                }
                // child 侧边 zone：垂直于父方向插到 child 对应侧（Tabby 对所有 child 都加）
                if (isV) {
                    zones.push({ x: childX, y: childY + T, w: T, h: childH - T * 2, side: 'l', relativeTo: child });
                    zones.push({ x: childX + childW - T, y: childY + T, w: T, h: childH - T * 2, side: 'r', relativeTo: child });
                } else {
                    zones.push({ x: childX + T, y: childY, w: childW - T * 2, h: T, side: 't', relativeTo: child });
                    zones.push({ x: childX + T, y: childY + childH - T, w: childW - T * 2, h: T, side: 'b', relativeTo: child });
                }
                offset += gap;
            });
        };
        walk(tab.splitRoot, 0, 0, 100, 100);
        return zones;
    },

    _showPaneDropZones(tab) {
        this._hidePaneDropZones();
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl || !tab.splitRoot) return;
        if (getAllPanes(tab).length < 2) return; // 单 pane 无重排对象（Tabby canActivateFor）
        const src = this._paneDragState && this._paneDragState.sourcePane;
        const zones = this._computePaneDropZones(tab).filter(z => !(src && z.relativeTo === src)); // 排除拖回自身（Tabby canActivateFor）
        if (this._paneDragState) this._paneDragState.zones = zones;
        const layer = document.createElement('div');
        layer.id = 'pane-drop-layer';
        zones.forEach((z, i) => {
            const el = document.createElement('div');
            el.className = 'pane-drop-zone side-' + z.side;
            el.setAttribute('data-zone-idx', i);
            el.style.left = z.x + '%'; el.style.top = z.y + '%';
            el.style.width = z.w + '%'; el.style.height = z.h + '%';
            layer.appendChild(el);
        });
        rootEl.appendChild(layer);
    },

    _hidePaneDropZones() {
        document.getElementById('pane-drop-layer')?.remove();
    },

    _movePaneToZone(tab, zone) {
        const state = this._paneDragState;
        if (!state) return;
        const sourcePane = state.sourcePane;
        if (zone.relativeTo === sourcePane) { this._onPaneDragEnd(); return; }
        // 1. 从原父容器摘除（Tabby: add 之前先 removeTab）
        const parent = getParentOf(tab, sourcePane);
        if (!parent) { this._onPaneDragEnd(); return; }
        const idx = parent.children.indexOf(sourcePane);
        parent.children.splice(idx, 1);
        parent.ratios.splice(idx, 1);
        normalize(tab.splitRoot);
        // 2. 按 zone 的 side 插入到 relativeTo 对应位置（复用 Tabby 语义的 add）
        this.add(tab, sourcePane, zone.relativeTo, zone.side);
        this._onPaneDragEnd();
        this._renderSplit(tab);
    },

    _onPaneDragEnd() {
        document.body.classList.remove('pane-dragging');
        this._hidePaneDropZones();
        const state = this._paneDragState;
        if (state) {
            if (state.ghost) state.ghost.remove();
            const el = document.querySelector(`.split-pane[data-pane="${state.sourcePane.id}"]`);
            if (el) el.style.opacity = '';
        }
        this._paneDragState = null;
    },

    _closePane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || !tab.splitRoot) return;
        const pane = findPane(tab, paneId);
        if (!pane) return;
        if (tab._maximizedPaneId === paneId) tab._maximizedPaneId = null;
        // Destroy backend immediately but keep the DOM for exit animation
        if (pane.tabId) {
            this._closedTabIds.add(pane.tabId);
            ipcRenderer.send('pty-destroy', { tabId: pane.tabId });
            delete ptyBuffers[pane.tabId]; // 防止 buffer 永久泄漏（pane 关闭后不会再 wire）
        }
        if (pane.term) try { pane.term.dispose(); } catch(e) {}
        // Exit animation: fade + shrink, then remove from tree and re-render
        const rootEl = document.getElementById('split_' + tab.id);
        const paneEl = rootEl ? rootEl.querySelector('.split-pane[data-pane="' + paneId + '"]') : null;
        const doRemove = () => {
            const parent = getParentOf(tab, pane);
            if (parent) {
                const idx = parent.children.indexOf(pane);
                if (idx >= 0) { parent.children.splice(idx, 1); parent.ratios.splice(idx, 1); }
            }
            normalize(tab.splitRoot);
            const rem = getAllPanes(tab);
            if (rem.length === 0) {
                this.closeTab(tabId);
            } else if (rem.length === 1) {
                tab.name = rem[0]?.name || tab.name;
                this._exitSplit(tab);
                this.render();
            } else {
                if (!rem.some(p => p.focused)) rem[0].focused = true;
                this._renderSplit(tab);
                this._updateTabName(tab);
                this.render();
                const focused = rem.find(p => p.focused);
                if (focused && focused.term) {
                    setTimeout(() => {
                        _fitWithScroll(focused.term, focused.fitAddon, document.getElementById('pane-body_' + focused.id));
                        try { focused.term.focus(); } catch(e) {}
                    }, 150);
                }
            }
        };
        if (paneEl) {
            paneEl.classList.add('pane-exit');
            setTimeout(doRemove, 200);
        } else {
            doRemove();
        }
    },

    _focusPane(tab, paneId) {
        if (tab._maximizedPaneId) return;
        const all = getAllPanes(tab);
        all.forEach(p => p.focused = (p.id === paneId));
        const rootEl = document.getElementById('split_' + tab.id);
        if (rootEl) {
            rootEl.querySelectorAll('.split-pane').forEach(el => {
                el.classList.toggle('active', el.getAttribute('data-pane') === paneId);
            });
        }
        const pane = findPane(tab, paneId);
        // pane 拖拽中不抢焦点（50ms 后的 term.focus() 会杀死刚起步的 HTML5 drag）
        if (pane && pane.term) setTimeout(() => { if (!this._paneDragState) pane.term.focus(); }, 50);
    },

    _maximizePane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || !tab.splitRoot) return;
        if (tab._maximizedPaneId === paneId) {
            tab._maximizedPaneId = null;
        } else {
            tab._maximizedPaneId = paneId;
            const pane = findPane(tab, paneId);
            if (pane) getAllPanes(tab).forEach(p => p.focused = (p.id === paneId));
        }
        this._maximizing = true;
        this._layoutSplit(tab);
        const pane = findPane(tab, tab._maximizedPaneId || paneId);
        if (pane && pane.term && pane.fitAddon) {
            setTimeout(() => {
                this._maximizing = false;
                const body = document.getElementById('pane-body_' + pane.id);
                if (body) _fitWithScroll(pane.term, pane.fitAddon, body);
                try { pane.term.focus(); } catch(e) {}
            }, 220);
        } else {
            setTimeout(() => { this._maximizing = false; }, 220);
        }
    },

    _extractPaneToTab(tabId, paneId) {
        const st = this.tabs.find(t => t.id === tabId);
        if (!st || !st.splitRoot) return;
        const pane = findPane(st, paneId);
        if (!pane || !pane.term || !pane.tabId) return;
        const isSSH = pane.type === 'ssh' || pane._sshHost;
        const nt = {
            id: 't_' + (this._counter++),
            name: pane.name || st.name,
            type: isSSH ? 'ssh' : (pane.type || st.type || 'local'),
            command: pane._command || st.command || 'powershell.exe',
            args: pane._args || st.args || [],
            connected: pane.connected !== false && (pane.connected || !!pane.tabId),
            term: pane.term,
            fitAddon: pane.fitAddon,
            tabId: pane.tabId,
            splitRoot: null,
        };
        if (isSSH) {
            nt.host = pane._sshHost || st.host;
            nt.port = pane._sshPort || st.port;
            nt.user = pane._sshUser || st.user;
            nt._credId = pane._sshCredId || st._credId;
            nt.sshProfileId = pane._sshProfileId || st.sshProfileId;
        }
        this.tabs.push(nt);
        const parent = getParentOf(st, pane);
        if (parent) {
            const idx = parent.children.indexOf(pane);
            parent.children.splice(idx, 1);
            parent.ratios.splice(idx, 1);
        }
        if (st._maximizedPaneId === paneId) st._maximizedPaneId = null;
        normalize(st.splitRoot);
        const rem = getAllPanes(st);
        if (rem.length === 0) {
            const idx = this.tabs.indexOf(st);
            if (idx >= 0) this.tabs.splice(idx, 1);
            const sp = document.getElementById('split_' + st.id);
            if (sp) sp.remove();
        } else if (rem.length === 1) {
            const rp = rem[0];
            st.splitRoot = null;
            if (!rem.some(p => p.focused)) rp.focused = true;
            st.term = rp.term;
            st.fitAddon = rp.fitAddon;
            st.tabId = rp.tabId;
            st.name = rp.name || st.name;
            st.type = rp.type || st.type;
            const os = document.getElementById('split_' + st.id);
            if (os) os.remove();
            const w = document.createElement('div');
            w.className = 'term-wrap' + (this.activeId === st.id ? ' active' : '');
            w.id = 'wrap_' + st.id;
            document.getElementById('main-area').appendChild(w);
            if (st.term) {
                w.appendChild(st.term.element);
                if (st.fitAddon) setTimeout(() => st.fitAddon.fit(), 50);
            }
        } else {
            if (!rem.some(p => p.focused)) rem[0].focused = true;
            this._renderSplit(st);
        }
        const { wrap: nw, inner: nInner } = createTermWrap(nt);
        document.getElementById('main-area').appendChild(nw);
        if (nt.term) {
            nInner.appendChild(nt.term.element);
            setupWrapResizeObserver(nw, nt);
            if (nt.fitAddon) setTimeout(() => _fitWithScroll(nt.term, nt.fitAddon, nInner), 50);
        }
        this._updateTabName(st);
        this.render();
        this.switchTo(nt.id);
        this.updateStatus();
    },

    _moveTerminalToTab(sourceTabId, targetTabId, side, targetPaneId) {
        const sourceTab = this.tabs.find(t => t.id === sourceTabId);
        const targetTab = this.tabs.find(t => t.id === targetTabId);
        if (!sourceTab || !targetTab || sourceTab === targetTab) return;
        if (sourceTab.type === 'settings' || targetTab.type === 'settings') return;
        let mt = null, mf = null, mid = null, sc = null;
        let paneName = sourceTab.name, paneType = sourceTab.type || 'local';
        let sshHost = sourceTab.host, sshPort = sourceTab.port, sshUser = sourceTab.user;
        let sshCredId = sourceTab._credId, sshProfileId = sourceTab.sshProfileId;
        if (sourceTab.splitRoot) {
            const ap = getAllPanes(sourceTab);
            const focused = ap.find(p => p.focused) || ap[ap.length - 1];
            mt = focused.term; mf = focused.fitAddon; mid = focused.tabId;
            paneName = focused.name || sourceTab.name;
            paneType = focused.type || sourceTab.type || 'local';
            sshHost = focused._sshHost || sourceTab.host;
            sshPort = focused._sshPort || sourceTab.port;
            sshUser = focused._sshUser || sourceTab.user;
            sshCredId = focused._sshCredId || sourceTab._credId;
            sshProfileId = focused._sshProfileId || sourceTab.sshProfileId;
            const parent = getParentOf(sourceTab, focused);
            if (parent) {
                const idx = parent.children.indexOf(focused);
                parent.children.splice(idx, 1);
                parent.ratios.splice(idx, 1);
                normalize(sourceTab.splitRoot);
                const rem = getAllPanes(sourceTab);
                if (rem.length === 1) {
                    sc = () => {
                        const rp = rem[0];
                        sourceTab.term = rp.term;
                        sourceTab.fitAddon = rp.fitAddon;
                        sourceTab.tabId = rp.tabId;
                        sourceTab.splitRoot = null;
                        sourceTab.name = rp.name || sourceTab.name;
                        sourceTab.type = rp.type || sourceTab.type;
                        const sp = document.getElementById('split_' + sourceTab.id);
                        if (sp) sp.remove();
                        const { wrap: w, inner: wInner } = createTermWrap(sourceTab);
                        document.getElementById('main-area').appendChild(w);
                        if (sourceTab.term) {
                            wInner.appendChild(sourceTab.term.element);
                            setupWrapResizeObserver(w, sourceTab);
                            if (sourceTab.fitAddon) setTimeout(() => _fitWithScroll(sourceTab.term, sourceTab.fitAddon, wInner), 50);
                        }
                    };
                } else if (rem.length === 0) {
                    sc = () => {
                        const i2 = this.tabs.indexOf(sourceTab);
                        if (i2 >= 0) this.tabs.splice(i2, 1);
                        const s2 = document.getElementById('split_' + sourceTab.id);
                        if (s2) s2.remove();
                    };
                } else {
                    sc = () => { this._renderSplit(sourceTab); };
                }
            }
        } else {
            mt = sourceTab.term; mf = sourceTab.fitAddon; mid = sourceTab.tabId;
            const idx = this.tabs.indexOf(sourceTab);
            sc = () => {
                this.tabs.splice(idx, 1);
                const el = document.getElementById('wrap_' + sourceTab.id);
                if (el) el.remove();
            };
        }
        if (!mt || !mid) return;
        if (!targetTab.splitRoot) {
            const ew = document.getElementById('wrap_' + targetTab.id);
            if (ew) ew.remove();
            const fp = this._newPaneData(targetTab);
            fp.term = targetTab.term;
            fp.fitAddon = targetTab.fitAddon;
            fp.tabId = targetTab.tabId;
            fp.focused = false;
            targetTab.splitRoot = this._createContainer('h');
            targetTab.splitRoot.children = [fp];
            targetTab.splitRoot.ratios = [1];
            targetTab.term = null;
            targetTab.fitAddon = null;
            targetTab.tabId = null;
        }
        const focusedPane = targetPaneId ? findPane(targetTab, targetPaneId) : (getAllPanes(targetTab).find(p => p.focused) || getAllPanes(targetTab)[0]);
        if (!focusedPane) { if (sc) sc(); return; }
        const np = {
            id: 'p_' + (this._paneCounter++),
            requestId: 'p_' + (this._paneCounter - 1),
            term: mt, fitAddon: mf, tabId: mid, focused: true,
            name: paneName, type: paneType,
            connected: !!mid, // 有 backend tabId 说明在线
            _sshHost: sshHost, _sshPort: sshPort, _sshUser: sshUser,
            _sshCredId: sshCredId, _sshProfileId: sshProfileId,
            _command: paneType !== 'ssh' ? (sourceTab.command || '') : '',
            _args: paneType !== 'ssh' ? (sourceTab.args || []) : [],
        };
        this.add(targetTab, np, focusedPane, side);
        getAllPanes(targetTab).forEach(p => p.focused = false);
        np.focused = true;
        targetTab._maximizedPaneId = null;
        const ss = document.getElementById('split_' + sourceTabId);
        if (ss && sourceTabId !== targetTabId) ss.remove();
        const sw = document.getElementById('wrap_' + sourceTabId);
        if (sw && sourceTabId !== targetTabId) sw.remove();
        if (sc) sc();
        this._renderSplit(targetTab);
        this.switchTo(targetTab.id);
        this._updateTabName(targetTab);
        this.render();
        this.updateStatus();
        setTimeout(() => { if (mt) try { mt.focus(); } catch(e) {} }, 150);
    },

    _exitSplit(tab) {
        const all = getAllPanes(tab);
        const fp = all[0];
        all.forEach((p, i) => {
            if (i > 0 && p.tabId) {
                this._closedTabIds.add(p.tabId);
                ipcRenderer.send('pty-destroy', { tabId: p.tabId });
            }
            if (i > 0 && p.term) try { p.term.dispose(); } catch(e) {}
        });
        tab.term = fp?.term || null;
        tab.fitAddon = fp?.fitAddon || null;
        tab.tabId = fp?.tabId || null;
        tab.splitRoot = null;
        tab._maximizedPaneId = null;
        const os = document.getElementById('split_' + tab.id);
        if (os) os.remove();
        const sw = document.getElementById('wrap_' + tab.id);
        if (sw) { if (sw._resizeObserver) sw._resizeObserver.disconnect(); sw.remove(); }
        const { wrap: w, inner: wInner } = createTermWrap(tab);
        document.getElementById('main-area').appendChild(w);
        if (tab.term) {
            wInner.appendChild(tab.term.element);
            setupWrapResizeObserver(w, tab);
            if (tab.fitAddon) setTimeout(() => _fitWithScroll(tab.term, tab.fitAddon, wInner), 50);
        }
        if (this.activeId === tab.id && tab.term) setTimeout(() => tab.term.focus(), 100);
    },

    _onTabDragStart(e, tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || tab.type === 'settings') { e.preventDefault(); return; }
        this._dragTab = { sourceTabId: tabId, targetTabId: null, side: null, targetPaneId: null };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tabId);
        const el = document.querySelector('.tab[data-tab="' + tabId + '"]');
        if (el) setTimeout(() => el.classList.add('dragging'), 0);
        const main = document.getElementById('main-area');
        if (main) main.classList.add('drop-target');
    },

    _onTabDragEnd(e) {
        document.querySelectorAll('.tab').forEach(el => { el.classList.remove('dragging', 'drag-over-left', 'drag-over-right'); });
        const main = document.getElementById('main-area');
        if (main) main.classList.remove('drop-target');
        this._hideDropZone();
        this._dragTab = null;
    },

    // Drag-to-reorder within tabbar
    _onTabDragOver(e, targetTabId) {
        if (!this._dragTab || this._dragTab.sourceTabId === targetTabId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const el = document.querySelector('.tab[data-tab="' + targetTabId + '"]');
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const isLeft = e.clientX < midX;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        el.classList.add(isLeft ? 'drag-over-left' : 'drag-over-right');
    },

    _onTabDrop(e, targetTabId) {
        if (!this._dragTab) return;
        e.preventDefault();
        e.stopPropagation();
        const sourceId = this._dragTab.sourceTabId;
        if (sourceId === targetTabId) return;
        const sourceIdx = this.tabs.findIndex(t => t.id === sourceId);
        const targetIdx = this.tabs.findIndex(t => t.id === targetTabId);
        if (sourceIdx < 0 || targetIdx < 0) return;
        const el = document.querySelector('.tab[data-tab="' + targetTabId + '"]');
        const rect = el ? el.getBoundingClientRect() : null;
        const insertBefore = rect ? (e.clientX < rect.left + rect.width / 2) : true;
        const [moved] = this.tabs.splice(sourceIdx, 1);
        let insertIdx = this.tabs.findIndex(t => t.id === targetTabId);
        if (!insertBefore) insertIdx += 1;
        this.tabs.splice(insertIdx, 0, moved);
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        this.render();
    },

    // F2 / double-click rename
    startRenameTab(tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        const el = document.querySelector('.tab[data-tab="' + tabId + '"] .tab-name');
        if (!el) return;
        const oldName = tab.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.className = 'tab-rename-input';
        el.replaceWith(input);
        input.focus();
        input.select();
        const finish = (save) => {
            if (save && input.value.trim()) {
                tab.name = input.value.trim();
                tab._customName = true; // 锁定自定义名，pane 变动不再覆盖
            } else if (save && !input.value.trim() && tab.splitRoot) {
                // 用户清空名称 → 恢复自动生成
                delete tab._customName;
                this._updateTabName(tab);
            }
            this.render();
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
            e.stopPropagation();
        };
        input.onblur = () => finish(true);
        input.onclick = (e) => e.stopPropagation();
    },

    // Right-click context menu
    showTabContextMenu(e, tabId) {
        this._hideTabContextMenu();
        const menu = document.createElement('div');
        menu.id = 'tab-context-menu';
        menu.className = 'tab-context-menu';
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        // 快捷键从 _getShortcutBindings() 查当前绑定：用户改过要跟随
        const bindings = _getShortcutBindings();
        const items = [
            { label: '重命名', actionId: 'renameTab', action: () => this.startRenameTab(tabId) },
            { label: '克隆标签页', actionId: 'cloneTab', action: () => this.cloneTab(tabId) },
            { label: '关闭', actionId: 'closeTab', action: () => this.closeTab(tabId) },
            { label: '关闭其他标签页', actionId: null, action: () => this.closeOtherTabs(tabId) },
        ];
        items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'tab-context-item';
            const combo = item.actionId ? (bindings[item.actionId] || '') : '';
            el.innerHTML = `<span>${escHtml(item.label)}</span>` + (combo ? `<span class="tab-context-shortcut">${escHtml(_comboDisplay(combo))}</span>` : '');
            el.onclick = () => { this._hideTabContextMenu(); item.action(); };
            menu.appendChild(el);
        });
        document.body.appendChild(menu);
        // 宽度跟随快捷键提示扩展（180 起 + shortcut text 宽度余量）
        const x = Math.min(e.clientX, window.innerWidth - 220);
        const y = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        setTimeout(() => document.addEventListener('click', this._hideTabContextMenuBound = () => this._hideTabContextMenu(), { once: true }), 0);
    },

    _hideTabContextMenu() {
        const menu = document.getElementById('tab-context-menu');
        if (menu) menu.remove();
    },

    closeOtherTabs(keepId) {
        const toClose = this.tabs.filter(t => t.id !== keepId && t.type !== 'settings');
        toClose.forEach(t => this.closeTab(t.id));
    },

    cloneTab(tabId) {
        const src = this.tabs.find(t => t.id === tabId);
        if (!src || src.type === 'settings') return;

        // 有分屏：深度克隆 split tree，为每个 pane 启动新后端
        if (src.splitRoot) return this._cloneSplitTab(src);

        // 单窗格：直接 createTab
        const options = { name: src.name, type: src.type };
        if (src.type === 'ssh') {
            options.host = src.host;
            options.port = src.port;
            options.user = src.user;
            options.credId = src._credId;
            options.privateKey = src.privateKey;
            options.sshProfileId = src.sshProfileId;
        } else {
            options.command = src.command;
            options.args = src.args;
        }
        const newId = this.createTab(options);
        const newTab = this.tabs.find(t => t.id === newId);
        if (newTab) newTab._cloneCred = true; // 标记为克隆，closeTab 不撤证
        return newId;
    },

    _cloneSplitTab(src) {
        const id = 't_' + (this._counter++);
        const tab = {
            id,
            name: src.name,
            type: src.type,
            command: src.command,
            args: [...(src.args || [])],
            connected: false,
            _cloneCred: true, // closeTab 时不撤证，凭据属于源 tab
        };
        if (src.type === 'ssh') {
            Object.assign(tab, {
                host: src.host, port: src.port, user: src.user,
                privateKey: src.privateKey,
                sshProfileId: src.sshProfileId,
                // 注意：不复制 _credId——每个 pane 有自己的 _sshCredId
                // 若复制到 tab 级别，closeTab 时会 revoke-credential
                // 导致所有共享此凭据的 pane 断连
            });
        }
        // 深度克隆 split tree，叶子节点保留源 pane 自己的 type/SSH 参数
        const clonePane = (srcPane) => ({
            id: 'p_' + (this._paneCounter++),
            requestId: null,
            tabId: null, term: null, fitAddon: null,
            focused: srcPane.focused,
            name: srcPane.name,
            type: srcPane.type || 'local',
            connected: srcPane.type !== 'ssh',
            _sshHost: srcPane._sshHost,
            _sshPort: srcPane._sshPort,
            _sshUser: srcPane._sshUser,
            _sshCredId: srcPane._sshCredId,
            _sshProfileId: srcPane._sshProfileId,
            _command: srcPane._command || '',
            _args: srcPane._args || [],
        });
        const cloneTree = (node) => {
            if (node.orientation) {
                return {
                    orientation: node.orientation,
                    children: node.children.map(cloneTree),
                    ratios: [...node.ratios],
                };
            }
            const p = clonePane(node);
            p.requestId = p.id;
            return p;
        };
        tab.splitRoot = cloneTree(src.splitRoot);

        this.tabs.push(tab);
        this._renderSplit(tab);

        // _renderSplit 时新旧 split-root 同时可见导致布局争抢，
        // 先把新的藏起来，switchTo 再在单 split 环境下正确展示
        const newSplit = document.getElementById('split_' + tab.id);
        if (newSplit) newSplit.style.display = 'none';

        // 为所有叶子 pane 启动后端连接
        const panes = getAllPanes(tab);
        panes.forEach(p => this._spawnBackendForPane(p, tab));

        this.switchTo(id);
        // switchTo 后 DOM 布局已稳定，重新计算 gap 修正 spanner 宽度
        requestAnimationFrame(() => this._layoutSplit(tab));
        this._updateTabName(tab);
        this.render();
        return id;
    },

    _updateTabName(tab) {
        if (!tab.splitRoot || tab._customName) return;
        const panes = getAllPanes(tab);
        if (panes.length <= 1) {
            tab.name = panes[0]?.name || tab.name;
        } else {
            // Tabby updateTitle 语义：pane 名拼接前去重（同一连接/终端的多个 pane 只显示一次）
            const names = panes.map(p => p.name || '').filter(n => n);
            tab.name = [...new Set(names)].join(' | ');
        }
        // pane 变动后立即存盘，不等 15s 定时器
        if (typeof saveConfig === 'function') saveConfig();
    },

    _deserializeSplitTree(saved, tab) {
        if (!saved) return null;
        if (saved.orientation) {
            return {
                orientation: saved.orientation,
                children: saved.children.map(c => this._deserializeSplitTree(c, tab)),
                ratios: saved.ratios,
            };
        }
        const id = 'p_' + (this._paneCounter++);
        const isSSH = saved.paneType === 'ssh' || !!saved.sshHost;
        return {
            id, requestId: id,
            tabId: null, term: null, fitAddon: null, focused: false,
            name: saved.name || tab.name,
            type: isSSH ? 'ssh' : (saved.paneType || 'local'),
            connected: !isSSH, // local 直接在线，SSH 等握手
            _sshHost: saved.sshHost, _sshPort: saved.sshPort, _sshUser: saved.sshUser,
            _sshProfileId: saved.sshProfileId,
            _command: isSSH ? '' : (saved.command || ''),
            _args: isSSH ? [] : (saved.args || []),
        };
    },

    _restoreSplitTab(tabData) {
        const id = 't_' + (this._counter++);
        const tab = {
            id, name: tabData.name, type: tabData.type,
            command: tabData.command || 'powershell.exe',
            args: tabData.args || [],
            connected: false,
        };
        if (tabData.type === 'ssh') {
            Object.assign(tab, {
                host: tabData.host, port: tabData.port, user: tabData.user,
                sshProfileId: tabData.sshProfileId,
            });
        }
        tab.splitRoot = this._deserializeSplitTree(tabData.splitRoot, tab);
        this.tabs.push(tab);
        this._renderSplit(tab);
        this._updateTabName(tab);
        // 恢复时先隐藏，等 switchTo 激活后再显示，防止多个 split 叠加
        const splitEl = document.getElementById('split_' + tab.id);
        if (splitEl) splitEl.style.display = 'none';

        // 为每个 pane 注册凭据（SSH）并启动后端
        const panes = getAllPanes(tab);
        panes.forEach(p => {
            if (p.type === 'ssh' && p._sshHost) {
                const prof = (this.sshProfiles || []).find(x => x.id === p._sshProfileId);
                // 凭据注册是异步的，完成后 spawn 后端
                const doSpawn = (credId) => {
                    if (credId) p._sshCredId = credId;
                    this._spawnBackendForPane(p, tab);
                };
                if (prof && (prof.encryptedPassword !== undefined || prof.privateKeyPath)) {
                    ipcRenderer.invoke('register-credential', {
                        encryptedPassword: prof.encryptedPassword,
                        privateKeyPath: prof.privateKeyPath,
                    }).then(({ credId }) => doSpawn(credId)).catch(() => doSpawn(null));
                } else {
                    doSpawn(null);
                }
            } else {
                this._spawnBackendForPane(p, tab);
            }
        });
        return tab;
    },

    _showDropZone() {
        let dz = document.getElementById('drop-zone-overlay');
        if (!dz) {
            dz = document.createElement('div');
            dz.id = 'drop-zone-overlay';
            dz.className = 'drop-zone';
            dz.innerHTML = '<div class=zone-left></div><div class=zone-right></div><div class=zone-top></div><div class=zone-bottom></div>';
            document.getElementById('main-area').appendChild(dz);
        }
        dz.classList.add('active');
    },

    _hideDropZone() {
        const dz = document.getElementById('drop-zone-overlay');
        if (dz) {
            dz.classList.remove('active');
            dz.querySelectorAll('.zone').forEach(z => z.classList.remove('show'));
        }
        document.querySelectorAll('.split-pane.drop-target, .term-wrap.drop-target').forEach(el => { el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-top', 'drop-bottom'); });
    },

    _pickDropSide(rx, ry, edge = 0.28) {
        const dL = rx, dR = 1 - rx, dT = ry, dB = 1 - ry;
        const minD = Math.min(dL, dR, dT, dB);
        if (minD > edge) return null;
        const eps = 0.001;
        if (Math.abs(minD - dL) < eps) return 'l';
        if (Math.abs(minD - dR) < eps) return 'r';
        if (Math.abs(minD - dT) < eps) return 't';
        return 'b';
    },

    _onMainDragOver(e) {
        if (!this._dragTab) return;
        const targetTab = this.getActive();
        if (!targetTab || targetTab.type === 'settings') return;
        if (this._dragTab.sourceTabId === targetTab.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const main = document.getElementById('main-area');
        if (!main) return;
        const rect = main.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        document.querySelectorAll('.split-pane.drop-target, .term-wrap.drop-target').forEach(el => { el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-top', 'drop-bottom'); });
        const sideToClass = s => s ? { l: 'left', r: 'right', t: 'top', b: 'bottom' }[s] : null;
        let side = null, targetPaneEl = null;
        if (targetTab.splitRoot) {
            this._hideDropZone();
            const paneEls = main.querySelectorAll('#split_' + targetTab.id + ' .split-pane');
            const hitPad = GAP_PX / 2;
            for (const el of paneEls) {
                const pr = el.getBoundingClientRect();
                if (x >= pr.left - rect.left - hitPad && x <= pr.right - rect.left + hitPad && y >= pr.top - rect.top - hitPad && y <= pr.bottom - rect.top + hitPad) {
                    const pid = el.getAttribute('data-pane');
                    const tp = findPane(targetTab, pid);
                    if (tp) {
                        const rx = (x - (pr.left - rect.left)) / pr.width, ry = (y - (pr.top - rect.top)) / pr.height;
                        side = this._pickDropSide(rx, ry);
                        if (side) targetPaneEl = el;
                    }
                    break;
                }
            }
        } else {
            this._hideDropZone();
            const wrap = document.getElementById('wrap_' + targetTab.id);
            if (wrap) {
                const wr = wrap.getBoundingClientRect();
                const rx = (e.clientX - wr.left) / wr.width;
                const ry = (e.clientY - wr.top) / wr.height;
                side = this._pickDropSide(rx, ry, 0.30);
                if (side) wrap.classList.add('drop-target', 'drop-' + sideToClass(side));
            }
        }
        if (targetPaneEl && side) targetPaneEl.classList.add('drop-target', 'drop-' + sideToClass(side));
        this._dragTab.targetTabId = side ? targetTab.id : null;
        this._dragTab.side = side;
        this._dragTab.targetPaneId = (targetPaneEl && side) ? targetPaneEl.getAttribute('data-pane') : null;
    },

    _onMainDragLeave(e) { const main = document.getElementById('main-area'); if (main && !main.contains(e.relatedTarget)) this._hideDropZone(); },

    _onMainDrop(e) {
        e.preventDefault();
        this._hideDropZone();
        if (!this._dragTab || !this._dragTab.targetTabId || !this._dragTab.side) { this._dragTab = null; return; }
        const src = this._dragTab.sourceTabId, tgt = this._dragTab.targetTabId, sd = this._dragTab.side, pid = this._dragTab.targetPaneId;
        this._dragTab = null;
        this._moveTerminalToTab(src, tgt, sd, pid);
    },

    _openSFTP(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || !tab.splitRoot) return;
        const pane = findPane(tab, paneId);
        if (!pane || !pane.tabId) return;
        SFTP.open(pane.tabId);
    },

};
