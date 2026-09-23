// ZTerm - tab management (the entire TabManager object) (split out of renderer.html as a pure code move, logic unchanged)
const GAP_PX = 8; // fixed pixel gap between panes

// Look up loginScripts from the SSH profile
function _getLoginScripts(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return [];
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return (profile && profile.loginScripts) || [];
}

// Look up clearOnConnect from the SSH profile (default true: clear the terminal on reconnect; false: keep previous content)
function _clearOnConnect(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return true;
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return !profile || profile.clearOnConnect !== false;
}

// SSH connect with credential fallback: after a main-process restart all
// credentialId handles are dead, so re-register from the SSH profile when no
// valid credential is at hand (plaintext never passes through the renderer).
// ALL outbound ssh-connect traffic must go through _enqueueSshConnect's
// app-wide serial queue (session restore, splits, interactive creation,
// reconnects) so concurrent handshakes can never race strict sshd configs.
let _sshConnectChain = Promise.resolve();

// Is anything still listening for this rendererId (tab id or pane requestId)?
// Queue slots can run long after their consumer was closed; sending then
// would open a backend session nobody will ever claim or destroy.
function _rendererIdAlive(rendererId) {
    for (const tab of TabManager.tabs) {
        if (tab.id === rendererId) return true;
        if (tab.splitRoot) {
            if (getAllPanes(tab).some(p => p.requestId === rendererId || p.tabId === rendererId)) return true;
        }
    }
    return false;
}

function _enqueueSshConnect(profile, rendererId) {
    // Rust's early validation (missing host/username) rejects the invoke
    // WITHOUT emitting ssh-error, which would stall a queue slot for 20s and
    // freeze every connect behind it. Drop invalid payloads up front.
    if (!profile || !profile.host || !profile.username) {
        console.warn('[ssh] dropping connect with missing host/username, rendererId=' + rendererId);
        return;
    }
    _sshConnectChain = _sshConnectChain.then(() => new Promise((release) => {
        if (!_rendererIdAlive(rendererId)) { release(); return; }
        let released = false;
        const done = () => {
            if (released) return;
            released = true;
            clearTimeout(timer);
            // release() FIRST: the queue must never wedge on listener cleanup.
            release();
            ipcRenderer.removeListener('ssh-connected', onOk);
            ipcRenderer.removeListener('ssh-error', onErr);
        };
        const matches = (d) => d && (d.rendererId === rendererId || d.tabId === rendererId);
        const onOk = (e, d) => { if (matches(d)) done(); };
        const onErr = (e, d) => { if (matches(d)) done(); };
        const timer = setTimeout(done, 20000);
        ipcRenderer.on('ssh-connected', onOk);
        ipcRenderer.on('ssh-error', onErr);
        ipcRenderer.send('ssh-connect', { profile, rendererId });
    }));
}
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
        _enqueueSshConnect({
            host, port: port || 22, username: user, credentialId: cid || null,
            followCwd, loginScripts: _getLoginScripts(tab, pane),
        }, rendererId);
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
    // Tabs whose exit animation is running and whose deferred removal is
    // scheduled (rapid-close bookkeeping — see closeTab).
    _closingTabs: new Set(),
    _closedTabIds: new Map(), // id → close timestamp; deleted once consumed; entries older than 60s are swept to prevent leaks
    _markClosed(id) {
        if (id == null) return;
        const now = Date.now();
        // Sweep expired entries older than 60s that were never consumed (error path: pty-exit never arrived)
        for (const [k, t] of this._closedTabIds) { if (now - t > 60000) this._closedTabIds.delete(k); }
        this._closedTabIds.set(id, now);
    },
    _consumeClosed(id) { return this._closedTabIds.delete(id); },
    _dragTab: null, // { sourceTabId, targetTabId, side: 'left'|'right' }

    init() {
        // Mount chrome once: addBtn / menuBtn (no longer rebuilt on every render)
        const bar = document.getElementById('tabbar');
        if (bar) {
            if (!document.getElementById('btn-add-tab')) {
                const addBtn = document.createElement('div');
                addBtn.id = 'btn-add-tab';
                addBtn.dataset.tip = '新建标签页（默认终端），Ctrl+Shift+N 选择会话';
                addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
                addBtn.onclick = () => {
                    const p = getDefaultLocalProfile();
                    TabManager.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
                };
                bar.appendChild(addBtn);
            }
            if (!document.getElementById('btn-menu')) {
                const menuBtn = document.createElement('div');
                menuBtn.id = 'btn-menu';
                menuBtn.dataset.tip = '菜单';
                menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
                menuBtn.onclick = (e) => { e.stopPropagation(); toggleMenuPopup(); };
                bar.appendChild(menuBtn);
            }
        }

        ipcRenderer.once('profiles', async (event, { profiles, sshProfiles, lastTabs }) => {
            // Auto-detect local shells (Git Bash/WSL etc.), keeping custom config entries that detection missed
            let detected = [];
            try { detected = await ipcRenderer.invoke('get-local-shells') || []; } catch(e) {}
            const custom = (profiles || []).filter(p => !detected.some(d => d.command === p.command));
            this.profiles = detected.length > 0 ? [...detected, ...custom] : (profiles || []);
            this.sshProfiles = sshProfiles || [];

            // Filter out settings tabs / bad data (older versions may have saved a settings tab into lastTabs)
            const tabsToRestore = ((lastTabs && lastTabs.length > 0) ? lastTabs : [])
                .filter(t => t && typeof t === 'object' && t.type !== 'settings');
            if (tabsToRestore.length === 0) tabsToRestore.push(getDefaultLocalProfile());

            tabsToRestore.forEach(t => {
                // Tabs with split data go through the full restore path
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
                    // Register the credential with the main process for a
                    // credentialId; the plaintext password never reaches the
                    // renderer. The connect itself goes through the app-wide
                    // serial queue — at restore several SSH tabs connect at
                    // once and strict sshd configs randomly drop concurrent
                    // handshakes, whose retry churn used to trigger the
                    // zombie-wrap bug.
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
                        _sshConnectWithCredentials(reTab, null, capturedId);
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
            // Enqueue here only when the restore callback won't: profiles with
            // BOTH a password and a key would otherwise connect twice (the
            // first session succeeds and is orphaned by the second).
            if (sshOpts && sshOpts.host && (sshOpts.credId || sshOpts.privateKey) && !sshOpts._encryptedPwd) {
                _sshConnectWithCredentials(tab, null, id);
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
            _enqueueSshConnect({ host, port: port || 22, username: user, credentialId: credId || null, followCwd, loginScripts: _getLoginScripts(tab) }, id);
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

    // Tabs that are not currently closing (rapid-close safe count: the
    // "keep at least one tab" guards must look through pending removals,
    // otherwise a burst can schedule the last two tabs for removal and
    // leave the app empty).
    aliveCount() {
        return this.tabs.filter(t => !this._closingTabs.has(t.id)).length;
    },

    closeTab(id) {
        // Idempotent: a rapid shortcut burst hits the same tab repeatedly
        // while its exit animation runs — re-closing would re-add the exit
        // class, re-switch tabs and stack extra deferred removals.
        if (this._closingTabs.has(id)) return;
        if (this.aliveCount() <= 1) {
            // The last tab cannot be closed; if its split tree was already emptied (0 panes, error path),
            // reset it to the default local terminal as a fallback so no unclosable empty-split dead tab remains
            const t = this.tabs[0];
            if (t && t.splitRoot && getAllPanes(t).length === 0) {
                t.splitRoot = null;
                t.type = 'local';
                t.command = t.command || 'powershell.exe';
                t.term = null; t.fitAddon = null; t.tabId = null;
                const { wrap: w } = createTermWrap(t);
                document.getElementById('main-area').appendChild(w);
                ipcRenderer.send('pty-create', { shell: t.command, args: t.args || [], requestId: t.id });
                this.render();
            }
            return;
        }
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const tab = this.tabs[idx];
        const wasActive = this.activeId === id;
        // If the tab being closed has the SFTP panel open, close the panel too (so it never points at a destroyed session)
        if (window.SFTP && SFTP._tabId) {
            const ids = tab.splitRoot ? getAllPanes(tab).map(p => p.tabId) : [tab.tabId];
            if (ids.includes(SFTP._tabId)) SFTP.close();
        }
        if (tab.type === 'settings') {
            document.getElementById('settings-pane')?.classList.remove('active');
        }
        this._closingTabs.add(id);
        // Close animation: fade only. The .tab-exit rule must stay free of
        // layout-property transitions — they stall the WebView2 host message
        // pump for seconds (see the rule's comment in app.css).
        const tabEl = document.querySelector(`.tab[data-tab="${id}"]`);
        if (tabEl) tabEl.classList.add('tab-exit');
        // Compute the next tab BEFORE splice (after splice, the old idx+1 occupies idx).
        // Tabs being closed must be skipped: during a burst the tabs array is not yet spliced,
        // so blindly taking a neighbor reactivates a dying tab and later keys ping-pong between dying tabs.
        // Neighbors follow VISUAL order (orderedTabs): the raw array can hold
        // the settings tab mid-list, which would steal the activation from
        // the tab that actually sits next to the closed one on the bar.
        let next = null;
        if (wasActive) {
            const ordered = this.orderedTabs();
            const oidx = ordered.findIndex(t => t.id === id);
            for (let j = oidx + 1; j < ordered.length; j += 1) {
                if (!this._closingTabs.has(ordered[j].id)) { next = ordered[j]; break; }
            }
            if (!next) {
                for (let j = oidx - 1; j >= 0; j -= 1) {
                    if (!this._closingTabs.has(ordered[j].id)) { next = ordered[j]; break; }
                }
            }
        }
        // Switch to next immediately (old wrap hides and next wrap shows at once)
        if (next) this.switchTo(next.id);
        const doRemove = () => {
            // Re-locate idx by id — the user may have reordered or closed other tabs
            // during the animation, and the closure's stale idx would splice the wrong slot
            const cur = this.tabs.findIndex(t => t.id === id);
            if (cur < 0) { this._closingTabs.delete(id); return; } // already closed by another path
            this.tabs.splice(cur, 1);
            this._closingTabs.delete(id);
            // Release the plaintext credential held in main-process memory (if any). Cloned tabs do not own the credential, so it is not revoked
            if (tab._credId && !tab._cloneCred) ipcRenderer.send('revoke-credential', { credId: tab._credId });
            if (tab.splitRoot) {
                getAllPanes(tab).forEach((p, i) => {
                    if (p.tabId) { this._markClosed(p.tabId); ipcRenderer.send('pty-destroy', { tabId: p.tabId, rendererId: id }); delete ptyBuffers[p.tabId]; }
                    // Disconnect pane-body resize observers before dropping
                    // the split subtree — Blink keeps observed nodes (and
                    // their whole DOM subtrees, canvases included) alive.
                    const body = document.getElementById('pane-body_' + p.id);
                    if (body && body._resizeObserver) body._resizeObserver.disconnect();
                    // Stagger per-pane term.dispose like the tab-level
                    // stagger: a split tab closing must not fire N WebGL
                    // context teardowns in one task.
                    if (p.term) setTimeout(() => { try { p._smoothCursor?.dispose(); p._smoothCursor = null; p.term.dispose(); } catch(e) {} }, i * 80);
                });
                const split = document.getElementById('split_' + id);
                if (split) split.remove();
                tab.splitRoot = null; // prevent a stale reference from being treated as a live split by later code
            } else {
                const el = document.getElementById('wrap_' + id);
                if (el) { if (el._resizeObserver) el._resizeObserver.disconnect(); el.remove(); }
                if (tab.tabId) { this._markClosed(tab.tabId); ipcRenderer.send('pty-destroy', { tabId: tab.tabId, rendererId: id }); delete ptyBuffers[tab.tabId]; }
                if (tab.term) try { tab._smoothCursor?.dispose(); tab._smoothCursor = null; tab.term.dispose(); } catch(e) {}
            }
            this.render();
            // Correct activeId regardless of wasActive: a BACKGROUND tab
            // closed via context menu can be activated (Ctrl+Tab) during its
            // staggered removal window — after splice nothing else would fix
            // a dangling activeId (blank main area until a manual click).
            if (this.tabs.length > 0) {
                if (this.tabs.findIndex(t => t.id === this.activeId) < 0 || this._closingTabs.has(this.activeId)) {
                    let newActive = this.tabs[Math.min(cur, this.tabs.length - 1)];
                    if (!newActive || this._closingTabs.has(newActive.id)) {
                        newActive = this.tabs.find(t => !this._closingTabs.has(t.id)) || newActive;
                    }
                    if (newActive && !this._closingTabs.has(newActive.id)) this.switchTo(newActive.id);
                }
            } else if (this.tabs.length === 0) {
                this.activeId = null;
                this.updateActiveClass();
            }
        };
        if (tabEl) {
            // Stagger deferred removals: a rapid burst must not fire N
            // term.dispose() calls (each releasing a WebGL context) at the
            // same instant — parallel context teardown synchronously waits
            // on the GPU process and froze the renderer for seconds.
            const delay = 200 + Math.max(0, this._closingTabs.size - 1) * 120;
            setTimeout(doRemove, delay);
        } else {
            doRemove();
        }
    },

    reconnectTab(id) {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab || tab.type !== 'ssh') return;
        // Supersede any pending ssh-error retry timer for this tab (both
        // would enqueue a connect; the loser's session gets orphaned).
        tab._sshRetryToken = (tab._sshRetryToken || 0) + 1;

        if (tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) this._reconnectPane(tab.id, focused.id);
            return;
        }

        if (tab.tabId) ipcRenderer.send('ssh-disconnect', { tabId: tab.tabId, rendererId: id });
        if (_clearOnConnect(tab, null)) {
            if (tab.term) { try { tab._smoothCursor?.dispose(); tab._smoothCursor = null; tab.term.dispose(); } catch(e) {}; tab.term = null; tab.fitAddon = null; }
            const wrap = document.getElementById('wrap_' + id);
            if (wrap) { if (wrap._resizeObserver) wrap._resizeObserver.disconnect(); wrap.remove(); }
            // Explicitly release ptyBuffers (the old tabId is never reused by a new connection; otherwise buffers pile up 1MB+)
            if (tab.tabId) delete ptyBuffers[tab.tabId];
        } else if (tab.term) {
            // Keep content: write a separator line and scroll to bottom so the user sees the notice
            tab.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
            try { tab.term.scrollToBottom(); } catch(e) {}
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
        // Same supersede as reconnectTab: cancel a pending retry for this pane.
        tab._sshRetryToken = (tab._sshRetryToken || 0) + 1;
        const pane = findPane(tab, paneId);
        if (!pane) return;
        if (pane.tabId) ipcRenderer.send('ssh-disconnect', { tabId: pane.tabId, rendererId: tabId });
        if (_clearOnConnect(tab, pane)) {
            if (pane.term) { try { pane._smoothCursor?.dispose(); pane._smoothCursor = null; pane.term.dispose(); } catch(e) {}; pane.term = null; pane.fitAddon = null; }
            const body = document.getElementById('pane-body_' + pane.id);
            if (body) body.innerHTML = '';
            // Explicitly release ptyBuffers
            if (pane.tabId) delete ptyBuffers[pane.tabId];
        } else if (pane.term) {
            // Keep content: write a separator line and scroll to bottom
            pane.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
            try { pane.term.scrollToBottom(); } catch(e) {}
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

    // Visual tab order: creation/array order with the settings tab pinned to
    // the end. Render, keyboard cycling and close-next selection must all use
    // this single ordering — the array itself can hold settings mid-list (a
    // tab created after settings was opened), which made Ctrl+Alt+H/L cycle
    // in a different order than the bar shows (issue #7).
    orderedTabs() {
        return [...this.tabs].sort((a, b) => {
            if (a.type === 'settings' && b.type !== 'settings') return 1;
            if (a.type !== 'settings' && b.type === 'settings') return -1;
            return 0;
        });
    },

    render() {
        const bar = document.getElementById('tabbar');
        bar.querySelectorAll('.tab').forEach(el => el.remove());

        const addBtn = document.getElementById('btn-add-tab');

        const sortedTabs = this.orderedTabs();
        sortedTabs.forEach(t => {
            const div = document.createElement('div');
            div.className = 'tab';
            div.setAttribute('data-tab', t.id);
            // no native title attribute: the OS tooltip delay is ~1s, which
            // reads as lag when sweeping across tabs. The shared low-latency
            // tooltip below (delegated on #tabbar) replaces it.
            div.dataset.tip = this._tabDisplayName(t);
            div.onclick = () => this.switchTo(t.id);
            div.ondblclick = (e) => { if (t.type !== 'settings') { e.stopPropagation(); this.startRenameTab(t.id); } };
            div.oncontextmenu = (e) => { if (t.type !== 'settings') { e.preventDefault(); this.showTabContextMenu(e, t.id); } };
            // Tab drag (reorder + drag onto the content area to split) uses pointer events:
            // HTML5 draggable is intercepted by Tauri WebView2's window-level DnD handler
            // (dragover never fires, cursor shows no-drop) — same pointer drag as panes (Tabby).
            div.onmousedown = (e) => this._onTabPointerDown(e, t.id);
            let inner;
            if (t.type === 'settings') {
                inner = `<span class="tab-lead-icon">${Icons.iconSvg('settings', 14)}</span><span class="tab-name">${escHtml(this._tabDisplayName(t))}</span>`;
            } else {
                let dotClass = t.connected ? 'connected' : 'disconnected';
                const showDot = _settingsConfig.showStatusDot !== false;
                inner = (showDot ? `<span class="tab-icon ${dotClass}"></span>` : '') + `<span class="tab-name">${escHtml(this._tabDisplayName(t))}</span>`;
                // In split mode the tab label shows no reconnect button; each pane reconnects via its own pane header
                if (t.type === 'ssh' && !t.splitRoot) {
                    const rcClass = t.connected ? 'tab-reconnect-normal' : 'tab-reconnect';
                    const rcTitle = t.connected ? '强制重连' : '重新连接';
                    inner += `<button type="button" class="${rcClass}" title="${rcTitle}" onclick="event.stopPropagation();TabManager.reconnectTab('${t.id}');this.blur()" ondblclick="event.stopPropagation()">${Icons.iconSvg('rotate-cw', 12)}</button>`;
                }
            }
            inner += `<button type="button" class="tab-close" onclick="event.stopPropagation();TabManager.closeTab('${t.id}');this.blur()" ondblclick="event.stopPropagation()">${Icons.iconSvg('x', 13)}</button>`;
            div.innerHTML = inner;
            // A full re-render wipes the exit class of tabs still inside the
            // staggered removal window — they would pop back to full opacity,
            // look alive and intercept clicks. Re-apply so they stay born
            // invisible and inert (no transition, per the .tab-exit rule).
            if (this._closingTabs.has(t.id)) div.classList.add('tab-exit');
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
        // innerHTML swap (no listeners involved); `info` contains user data and
        // must stay escaped, the SVG icon is a static string
        if (t.type === 'settings') {
            document.getElementById('sb-conn').innerHTML = `<span class="sb-conn-icon">${Icons.iconSvg('settings', 12)}</span>设置`;
            return;
        }
        let iconName = 'terminal';
        let info = this._tabDisplayName(t);
        if (t.type === 'ssh') {
            iconName = 'zap';
            info = t.user ? `${t.user}@${t.host}` : t.name;
            if (!t.connected) info += ' (已断开)';
        }
        document.getElementById('sb-conn').innerHTML = `<span class="sb-conn-icon">${Icons.iconSvg(iconName, 12)}</span>${escHtml(info)}`;
    },

    // ── Split pane support (Tabby-aligned absolute model) ──
    _createContainer(orientation) { return { orientation, children: [], ratios: [] }; },

    _newPaneData(tab, srcPane) {
        const id = 'p_' + (this._paneCounter++);
        // Prefer srcPane fields (a split inherits from the focused pane), fall back to the tab
        const src = srcPane || tab;
        const isLocal = (src.type || tab.type || 'local') !== 'ssh';
        return {
            id,
            requestId: id,
            tabId: null,
            term: null,
            fitAddon: null,
            focused: false,
            // Pane name prefers srcPane.name (keeps the original pane name on drag-in/clone), otherwise tab.name (first split)
            name: srcPane ? (srcPane.name || '') : tab.name,
            type: src.type || (isLocal ? 'local' : 'ssh'),
            connected: isLocal || src.connected,
            _sshHost: src._sshHost || src.host,
            _sshPort: src._sshPort || src.port,
            _sshUser: src._sshUser || src.user,
            _sshCredId: src._sshCredId || src._credId,
            _sshProfileId: src._sshProfileId || src.sshProfileId,
            _command: isLocal ? (src._command || src.command || '') : '',
            _args: isLocal ? (src._args || src.args || []) : [],
        };
    },

    _spawnBackendForPane(pane, tab) {
        if (pane.type === 'ssh' && (pane._sshHost || tab.host)) {
            _sshConnectWithCredentials(tab, pane, pane.requestId);
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
            existing._smoothCursor = tab._smoothCursor;
            existing.tabId = tab.tabId;
            existing.focused = false;
            // The stored tool-provided name travels with the terminal onto its
            // new pane wrapper — the split branch of resolveTabDisplayName only reads pane slots.
            if (tab._toolName !== undefined) { existing._toolName = tab._toolName; delete tab._toolName; }
            // Rebind onData: the terminal moved onto the pane, so it must use pane.tabId, not the now-cleared tab.tabId
            if (tab._onDataDisp) { tab._onDataDisp.dispose(); tab._onDataDisp = null; }
            existing._onDataDisp = existing.term?.onData(data => {
                _sendPaneInput(tab, existing, data);
            });
            tab.term = null;
            tab.fitAddon = null;
            tab.tabId = null;
            // The smooth-cursor wrapper now belongs to the pane that received
            // the terminal — leaving the tab-level reference alive would make
            // _inkFeed read a disposed wrapper's null adapter forever.
            tab._smoothCursor = null;
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
        const newPane = this._newPaneData(tab, focused);
        // Kept as a fallback: when the tab lacks a credential, inherit from focused (defensive; _newPaneData normally covers this)
        if (!tab._credId && !newPane._sshCredId && focused._sshCredId) {
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
        this._layoutTime = Date.now();
        this._renderSplit(tab);
        this._spawnBackendForPane(newPane, tab);
        this._updateTabName(tab);
        this.render();
    },

    add(tab, thing, relative, side) {
        // Tabby add semantics: when relative is null (root-edge zone) or the parent container is missing, repack the root container
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
        let rootEl = document.getElementById('split_' + tab.id);
        // splitRoot already torn down (split exited etc.): remove leftover DOM
        if (!tab.splitRoot) {
            if (rootEl) rootEl.remove();
            return;
        }
        // Reuse the existing root: keep pane DOM on tree changes and only update coordinates, so
        // CSS transitions animate smoothly from the old coordinates to the new (reorder animation)
        if (!rootEl) {
            document.getElementById('wrap_' + tab.id)?.remove();
            rootEl = document.createElement('div');
            rootEl.id = 'split_' + tab.id;
            rootEl.className = 'split-root' + (tab.syncInput ? ' sync-input' : '');
            main.appendChild(rootEl);
        } else {
            rootEl.className = 'split-root' + (tab.syncInput ? ' sync-input' : '');
        }
        // Visibility always tracks the active state: paths like cross-tab drag rebuild or reuse an
        // inactive tab's split root; otherwise the new visible root stacks over the active tab (ghost overlay)
        rootEl.style.display = (tab.id === this.activeId) ? '' : 'none';

        const buildPane = (pane) => {
            const el = document.createElement('div');
            el.className = 'split-pane' + (pane.focused ? ' active' : '');
            el.setAttribute('data-pane', pane.id);
            el.onmousedown = () => { if (!tab._maximizedPaneId) this._focusPane(tab, pane.id); };
            // Pane drag-reorder uses a Tabby-style drop-zone layer (rendered at _onPaneDragStart); panes carry no drop listeners of their own
            const dc = (pane.connected !== false && (pane.connected || !!pane.tabId)) ? 'connected' : 'disconnected';
            const showDot = _settingsConfig.showStatusDot !== false;
            const hdr = document.createElement('div');
            hdr.className = 'pane-header';
            // Only SSH panes show the SFTP and reconnect buttons
            const sftpBtn = pane.type === 'ssh' ? '<button title="SFTP" onclick="event.stopPropagation();TabManager._openSFTP(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('folder', 13) + '</button>' : '';
            const reconnectPaneBtn = pane.type === 'ssh' ? '<button title="强制重连" onclick="event.stopPropagation();TabManager._reconnectPane(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('rotate-cw', 12) + '</button>' : '';
            hdr.innerHTML = (showDot ? '<span class="dot ' + dc + '"></span>' : '') +
                '<span class="label">' + escHtml(pane.name || tab.name) + '</span>' +
                sftpBtn +
                reconnectPaneBtn +
                '<button title="extract" onclick="event.stopPropagation();TabManager._extractPaneToTab(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('external-link', 12) + '</button>' +
                '<button title="maximize" onclick="event.stopPropagation();TabManager._maximizePane(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('maximize', 13) + '</button>' +
                '<button title="close" onclick="event.stopPropagation();TabManager._closePane(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('x', 13) + '</button>';
            el.appendChild(hdr);
            // Drag-reorder: same pointer-based drag as Tabby (mousedown tracking, no HTML5 draggable)
            hdr.addEventListener('mousedown', (e) => this._onPaneHeaderMouseDown(e, tab, pane));
            const body = document.createElement('div');
            body.className = 'pane-body';
            body.id = 'pane-body_' + pane.id;
            if (pane.term) body.appendChild(pane.term.element);
            el.appendChild(body);
            return el;
        };

        const allPanes = getAllPanes(tab);
        // Collect existing pane nodes. pane-exit nodes are not excluded: if the pane re-enters the
        // tree within its fade-out window it is revived in place, avoiding duplicate DOM for one data-pane
        const existing = new Map();
        rootEl.querySelectorAll('.split-pane').forEach(el => {
            existing.set(el.getAttribute('data-pane'), el);
        });
        // Suppress ResizeObserver-driven fit during the animation: per-frame pane size changes
        // would trigger continuous full repaints + a pty-resize storm (TUI apps resized repeatedly,
        // terminal flicker); after the animation the 250ms timer below + _scheduleSettleResize settle
        this._layoutAnimating = true;
        const enterIds = [];
        allPanes.forEach(p => {
            let el = existing.get(p.id);
            if (el) {
                existing.delete(p.id);
                el.classList.remove('pane-exit'); // a pane mid-fade-out re-entering the tree is revived
                // Reused node: refresh the connection-status dot (state may have changed with the tree)
                const dc = (p.connected !== false && (p.connected || !!p.tabId)) ? 'connected' : 'disconnected';
                const dot = el.querySelector('.dot');
                if (dot) dot.className = 'dot ' + dc;
                return;
            }
            el = buildPane(p);
            rootEl.appendChild(el);
            const body = document.getElementById('pane-body_' + p.id);
            if (body && p.term) {
                if (body._resizeObserver) body._resizeObserver.disconnect();
                let raf = false;
                const obs = new ResizeObserver(() => {
                    if (raf) return;
                    if (TabManager._layoutAnimating) return;
                    raf = true;
                    requestAnimationFrame(() => {
                        // _windowResizing: suppress fit during window-drag resize (per-frame full repaints + pty-resize
                        // storm); after the drag stops, split.js's resize settle performs one unified fit
                        if (!_spannerDrag && !TabManager._maximizing && !_windowResizing) _fitWithScroll(p.term, p.fitAddon, body);
                        raf = false;
                    });
                });
                obs.observe(body);
                body._resizeObserver = obs;
            }
            enterIds.push(p.id);
        });
        // Panes removed from the tree: fade out, then remove (only present when nodes were reused)
        existing.forEach((el) => {
            el.classList.add('pane-exit');
            setTimeout(() => { if (el.isConnected) el.remove(); }, 200);
        });
        this._layoutTime = Date.now();
        this._layoutSplit(tab);
        // Enter animation for newly created panes
        enterIds.forEach(id => {
            const newEl = rootEl.querySelector('.split-pane[data-pane="' + id + '"]');
            if (newEl) {
                newEl.classList.add('pane-enter');
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    newEl.classList.remove('pane-enter');
                }));
            }
        });
        // Lift the fit suppression (transition 200ms + margin)
        setTimeout(() => { this._layoutAnimating = false; }, 300);
        setTimeout(() => {
            allPanes.forEach(p => {
                if (p.term && p.fitAddon) _fitWithScroll(p.term, p.fitAddon, document.getElementById('pane-body_' + p.id));
            });
        }, 250);
        // After tree changes, existing panes' xterm loses focus; forcibly refocus the focused pane
        const fp = allPanes.find(p => p.focused);
        if (fp && fp.term) setTimeout(() => { try { fp.term.focus(); } catch(e) {} }, 200);
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
        this._layoutInternal(tab, tab.splitRoot, 0, 0, 100, 100, rootEl);
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
        // Settle sizes after the animation (the onResize suppression window drops the final animated size; without this, nvim and other TUI layouts break)
        _scheduleSettleResize(tab);
    },

    _layoutInternal(tab, container, x, y, w, h, rootEl) {
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
                this._layoutInternal(tab, child, childX, childY, childW, childH, rootEl);
            } else {
                // Use the rootEl passed in from outside, avoiding a getElementById + querySelector per leaf
                const el = rootEl ? rootEl.querySelector('.split-pane[data-pane="' + child.id + '"]') : null;
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

    // ── Pane drag swap (swap any two panes' position and size) ──
    _paneDragState: null,

    // Same pointer-based drag as Tabby: mousedown on the header, drag starts past a threshold, drop zones are hit while moving, release performs the insert
    _onPaneHeaderMouseDown(e, tab, pane) {
        if (e.button !== 0 || tab._maximizedPaneId) return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        this._paneDragState = { sourceTab: tab, sourcePane: pane, startX: e.clientX, startY: e.clientY, dragging: false, zones: [], ghost: null };
        const move = (ev) => this._onPanePointerMove(ev);
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            this._onPanePointerUp(ev);
        };
        // mouseup is not dispatched when the pointer leaves the window or it loses focus, so clean up defensively (leftover ghost/translucency/drop zones)
        const cancelDrag = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            this._onPaneDragEnd();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('mouseleave', cancelDrag);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('pointercancel', cancelDrag);
    },

    _onPanePointerMove(e) {
        const state = this._paneDragState;
        if (!state) return;
        if (!state.dragging) {
            if (Math.abs(e.clientX - state.startX) + Math.abs(e.clientY - state.startY) < 5) return;
            state.dragging = true;
            document.body.classList.add('pane-dragging');
            // Source pane turns translucent (Tabby behavior)
            const el = document.querySelector(`.split-pane[data-pane="${state.sourcePane.id}"]`);
            if (el) el.style.opacity = '0.4';
            this._showPaneDropZones(state.sourceTab);
            this._showPaneDragGhost(state, e);
        }
        this._movePaneDragGhost(state, e);
        // Hit detection (Tabby's drop-zone highlight)
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
        ghost.textContent = (state.sourcePane._toolName || '').trim() || state.sourcePane.name || this._tabDisplayName(state.sourceTab);
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

    // ── Same pane drag-reorder as Tabby: compute drop-zone bars; a hit inserts in the side direction ──

    // Compute drop zones (aligned with Tabby layoutInternal): root container edges + per-child side bars + spanner gap bars
    _computePaneDropZones(tab) {
        const zones = [];
        const T = 8; // zone thickness (percent of the split area; Tabby uses 10)
        const walk = (container, x, y, w, h) => {
            const isV = container.orientation === 'v';
            const gap = isV ? (tab._gapYPct || 0) : (tab._gapXPct || 0);
            const size = isV ? h : w;
            const avail = Math.max(size - (container.children.length - 1) * gap, 0);
            const sizes = container.ratios.map(r => r * avail);
            // Root container's four edges (Tabby: root l/t/r/b)
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
                // Spanner gap zone: inserts after the child along the container direction (Tabby adds one for every non-last child)
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
                // Child side zone: inserts on the child's side perpendicular to the parent direction (Tabby adds these for all children)
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
        if (getAllPanes(tab).length < 2) return; // a single pane has nothing to reorder with (Tabby canActivateFor)
        const src = this._paneDragState && this._paneDragState.sourcePane;
        const zones = this._computePaneDropZones(tab).filter(z => !(src && z.relativeTo === src)); // exclude dropping back onto itself (Tabby canActivateFor)
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
        // 1. Detach from the original parent container (Tabby: removeTab before add)
        const parent = getParentOf(tab, sourcePane);
        if (!parent) { this._onPaneDragEnd(); return; }
        const idx = parent.children.indexOf(sourcePane);
        parent.children.splice(idx, 1);
        parent.ratios.splice(idx, 1);
        normalize(tab.splitRoot);
        // 2. Insert per the zone's side at the position relative to relativeTo (reuses the Tabby-semantics add)
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
            this._markClosed(pane.tabId);
            ipcRenderer.send('pty-destroy', { tabId: pane.tabId, rendererId: tabId });
            delete ptyBuffers[pane.tabId]; // prevent permanent buffer leaks (a closed pane is never wired again)
        }
        if (pane.term) try { pane._smoothCursor?.dispose(); pane._smoothCursor = null; pane.term.dispose(); } catch(e) {}
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
                this._updateTabName(tab);
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
        // Do not steal focus mid pane drag (a term.focus() 50ms later would kill a just-started drag)
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
                // onResize/applyFit are fully suppressed during _maximizing, so after fit the final size must be
                // sent explicitly; otherwise the backend stays at the old cols/rows (nvim, htop and other TUI layouts break)
                if (pane.tabId && pane.term.cols && pane.term.rows) {
                    ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols: pane.term.cols, rows: pane.term.rows });
                }
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
        // Rebind onData after moving to the new tab: the original closure referenced pane (the source tab's
        // old pane); switching to nt.tabId ensures input is routed correctly
        if (pane._onDataDisp) { pane._onDataDisp.dispose(); pane._onDataDisp = null; }
        nt._onDataDisp = pane.term?.onData(data => {
            _sendPaneInput(nt, { tabId: nt.tabId }, data);
        });
        // The pane's tool-provided name follows its terminal onto the new single tab.
        if (pane._toolName !== undefined) nt._toolName = pane._toolName;
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
            // The term moves from pane back to tab: dispose the pane's zombie onData listener and rebind to the tab
            if (rp._onDataDisp) { rp._onDataDisp.dispose(); rp._onDataDisp = null; }
            st.term = rp.term;
            st.fitAddon = rp.fitAddon;
            st.tabId = rp.tabId;
            st.name = rp.name || st.name;
            st.type = rp.type || st.type;
            if (rp._toolName !== undefined) st._toolName = rp._toolName; else delete st._toolName;
            if (st.term) {
                st._onDataDisp = st.term.onData(data => {
                    _sendPaneInput(st, { tabId: st.tabId }, data);
                });
            }
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
        this._updateTabName(nt);
        this.render();
        this.switchTo(nt.id);
        this.updateStatus();
    },

    _moveTerminalToTab(sourceTabId, targetTabId, side, targetPaneId) {
        const sourceTab = this.tabs.find(t => t.id === sourceTabId);
        const targetTab = this.tabs.find(t => t.id === targetTabId);
        if (!sourceTab || !targetTab || sourceTab === targetTab) return;
        if (sourceTab.type === 'settings' || targetTab.type === 'settings') return;
        // Validate the target pane still exists first (a shortcut split may have changed the target tree
        // during the drag). Detach the source pane only after validation — otherwise the failure path drops it
        const focusedPane = targetPaneId ? findPane(targetTab, targetPaneId) : null;
        if (targetPaneId && !focusedPane) return;
        let mt = null, mf = null, mid = null, sc = null;
        let paneName = sourceTab.name, paneType = sourceTab.type || 'local';
        let toolName = sourceTab._toolName;
        let sshHost = sourceTab.host, sshPort = sourceTab.port, sshUser = sourceTab.user;
        let sshCredId = sourceTab._credId, sshProfileId = sourceTab.sshProfileId;
        if (sourceTab.splitRoot) {
            const ap = getAllPanes(sourceTab);
            const focused = ap.find(p => p.focused) || ap[ap.length - 1];
            // Readiness check BEFORE tearing the source split tree apart —
            // otherwise an unready pane (SSH still connecting) leaves the
            // tree damaged and the pane's input permanently broken.
            if (!focused || !focused.term || !focused.tabId) return;
            mt = focused.term; mf = focused.fitAddon; mid = focused.tabId;
            // Dispose the dragged pane's onData listener immediately: otherwise after np is rebound below, the term
            // would hold two listeners (the old pane's + np's) and every keypress would fire twice
            if (focused._onDataDisp) { focused._onDataDisp.dispose(); focused._onDataDisp = null; }
            paneName = focused.name || sourceTab.name;
            paneType = focused.type || sourceTab.type || 'local';
            toolName = focused._toolName;
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
                        // The term moves from pane back to tab: dispose the pane's zombie onData listener and rebind to the tab
                        if (rp._onDataDisp) { rp._onDataDisp.dispose(); rp._onDataDisp = null; }
                        sourceTab.term = rp.term;
                        sourceTab.fitAddon = rp.fitAddon;
                        sourceTab._smoothCursor = rp._smoothCursor;
                        sourceTab.tabId = rp.tabId;
                        sourceTab.splitRoot = null;
                        sourceTab.name = rp.name || sourceTab.name;
                        sourceTab.type = rp.type || sourceTab.type;
                        if (rp._toolName !== undefined) sourceTab._toolName = rp._toolName; else delete sourceTab._toolName;
                        if (sourceTab.term) {
                            sourceTab._onDataDisp = sourceTab.term.onData(data => {
                                _sendPaneInput(sourceTab, { tabId: sourceTab.tabId }, data);
                            });
                        }
                        const sp = document.getElementById('split_' + sourceTab.id);
                        if (sp) sp.remove();
                        const { wrap: w, inner: wInner } = createTermWrap(sourceTab);
                        document.getElementById('main-area').appendChild(w);
                        if (sourceTab.term) {
                            wInner.appendChild(sourceTab.term.element);
                            setupWrapResizeObserver(w, sourceTab);
                            if (sourceTab.fitAddon) setTimeout(() => _fitWithScroll(sourceTab.term, sourceTab.fitAddon, wInner), 50);
                        }
                        this._updateTabName(sourceTab);
                    };
                } else if (rem.length === 0) {
                    sc = () => {
                        const i2 = this.tabs.indexOf(sourceTab);
                        if (i2 >= 0) this.tabs.splice(i2, 1);
                        const s2 = document.getElementById('split_' + sourceTab.id);
                        if (s2) s2.remove();
                    };
                } else {
                    sc = () => { this._renderSplit(sourceTab); this._updateTabName(sourceTab); };
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
        // Idempotency guard: if the dragged terminal element is already inside the target split DOM (from any
        // duplicate drop/move via two paths), refuse to insert again — one connection must never appear as two panes
        const tgtRoot = document.getElementById('split_' + targetTab.id);
        if (tgtRoot && mt.element && tgtRoot.contains(mt.element)) {
            console.warn('[tabdrag] terminal already in target split, drop ignored');
            return;
        }
        if (!targetTab.splitRoot) {
            const ew = document.getElementById('wrap_' + targetTab.id);
            if (ew) ew.remove();
            const fp = this._newPaneData(targetTab);
            fp.term = targetTab.term;
            fp.fitAddon = targetTab.fitAddon;
            fp._smoothCursor = targetTab._smoothCursor;
            fp.tabId = targetTab.tabId;
            fp.focused = false;
            // The terminal moves from targetTab onto the fp pane, so onData must use fp.tabId
            // (targetTab.tabId is about to be cleared; a closure over { tabId: tab.tabId } → null would silently drop input)
            if (targetTab._onDataDisp) { targetTab._onDataDisp.dispose(); targetTab._onDataDisp = null; }
            fp._onDataDisp = fp.term?.onData(data => {
                _sendPaneInput(targetTab, fp, data);
            });
            // Same transfer rule as the terminal: the tool-provided name moves onto fp.
            if (targetTab._toolName !== undefined) { fp._toolName = targetTab._toolName; delete targetTab._toolName; }
            targetTab.splitRoot = this._createContainer('h');
            targetTab.splitRoot.children = [fp];
            targetTab.splitRoot.ratios = [1];
            targetTab.term = null;
            targetTab.fitAddon = null;
            targetTab.tabId = null;
            targetTab._smoothCursor = null; // moved onto fp — same transfer rule as addPaneRelativeTo
        }
        // targetPaneId === null → add() with relative=null repacks the root
        // container, i.e. the pane is inserted around the whole split.
        const np = {
            id: 'p_' + (this._paneCounter++),
            requestId: 'p_' + (this._paneCounter - 1),
            term: mt, fitAddon: mf, _smoothCursor: sourceTab._smoothCursor, tabId: mid, focused: true,
            name: paneName, type: paneType,
            connected: !!mid, // having a backend tabId means it is online
            _sshHost: sshHost, _sshPort: sshPort, _sshUser: sshUser,
            _sshCredId: sshCredId, _sshProfileId: sshProfileId,
            _command: paneType !== 'ssh' ? (sourceTab.command || '') : '',
            _args: paneType !== 'ssh' ? (sourceTab.args || []) : [],
        };
        // Rebind onData after the terminal moves: the original closure referenced sourceTab (already spliced away,
        // or its tabId taken over by the new pane); referencing np.tabId directly routes input to the correct pane
        if (mt && sourceTab._onDataDisp) { sourceTab._onDataDisp.dispose(); sourceTab._onDataDisp = null; }
        np._onDataDisp = mt?.onData(data => {
            _sendPaneInput(targetTab, np, data);
        });
        if (toolName !== undefined) np._toolName = toolName;
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
        if (this.activeId !== targetTab.id) this.switchTo(targetTab.id);
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
                this._markClosed(p.tabId);
                ipcRenderer.send('pty-destroy', { tabId: p.tabId, rendererId: tab.id });
            }
            if (i > 0 && p.term) try { p._smoothCursor?.dispose(); p._smoothCursor = null; p.term.dispose(); } catch(e) {}
        });
        // Sync all tab fields from the surviving pane — otherwise tab.type/host/user etc. keep the old tab's type
        // (e.g. an SSH tab exits split leaving a local pane but stays marked SSH: after restart it would really connect via SSH with a mismatched pane name)
        if (fp) {
            tab.type = fp.type || 'local';
            if (fp.type === 'ssh') {
                tab.host = fp._sshHost;
                tab.port = fp._sshPort;
                tab.user = fp._sshUser;
                tab.sshProfileId = fp._sshProfileId;
                tab.command = '';
                tab.args = [];
            } else {
                tab.host = undefined; tab.port = undefined; tab.user = undefined;
                tab.sshProfileId = undefined;
                tab.command = fp._command || '';
                tab.args = fp._args || [];
            }
            tab._credId = fp._sshCredId || tab._credId;
        }
        tab.term = fp?.term || null;
        tab.fitAddon = fp?.fitAddon || null;
        tab.tabId = fp?.tabId || null;
        // The surviving pane's smooth-cursor wrapper must come back with the
        // terminal — otherwise the tab keeps the disposed original wrapper
        // and the software caret silently dies for this tab's whole life.
        tab._smoothCursor = fp?._smoothCursor ?? null;
        // The surviving pane's tool-provided name comes back onto the tab with its term.
        if (fp && fp._toolName !== undefined) tab._toolName = fp._toolName;
        else delete tab._toolName;
        tab.connected = fp?.connected !== false && (fp?.connected || !!fp?.tabId); // sync the connection state, otherwise the status dot/reconnect button are wrong
        tab.splitRoot = null;
        tab._maximizedPaneId = null;
        // The term moves from pane back to tab: the pane's onData listener must be disposed and rebound to the tab,
        // otherwise it stays on the term as a permanent zombie and re-splitting double-binds it — every keypress inputs twice
        if (fp && fp._onDataDisp) { fp._onDataDisp.dispose(); fp._onDataDisp = null; }
        if (tab.term) {
            tab._onDataDisp = tab.term.onData(data => {
                _sendPaneInput(tab, { tabId: tab.tabId }, data);
            });
        }
        // Sync the contentBuffer focus buffer: during split, all panes' output accumulates into tab._contentBuffer,
        // and after exiting the split the buffered content may mismatch the surviving pane's type (SSH content in a
        // local buffer). Simple approach: clear contentBuffer when exiting the split to avoid confusion on restore.
        tab._contentBuffer = [];
        // Disconnect pane-body resize observers before dropping the split
        // subtree (Blink retains observed nodes and their DOM subtrees).
        all.forEach(p => { const body = document.getElementById('pane-body_' + p.id); if (body && body._resizeObserver) body._resizeObserver.disconnect(); });
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

    // ── Tab → split drop zones (unified with pane reorder visuals) ──
    // Uses the same .pane-drop-zone bars as pane drag reorder (consistency).
    _tabSplitZones: null, // { layer, zones, tabId }

    _tabComputeSplitZones(tab) {
        if (tab.splitRoot) {
            // Reuse pane drop zones as-is (root-edge zones included), so the
            // outermost edges of the whole split area get their bars too.
            return this._computePaneDropZones(tab);
        }
        const wrap = document.getElementById('wrap_' + tab.id);
        if (!wrap) return [];
        const T = 8; // bar thickness in % (same as pane zones)
        return [
            { x: 0, y: T, w: T, h: 100 - T * 2, side: 'l', relativeTo: null },
            { x: T, y: 0, w: 100 - T * 2, h: T, side: 't', relativeTo: null },
            { x: 100 - T, y: T, w: T, h: 100 - T * 2, side: 'r', relativeTo: null },
            { x: T, y: 100 - T, w: 100 - T * 2, h: T, side: 'b', relativeTo: null },
        ];
    },

    _tabShowSplitZones(tab) {
        this._tabHideSplitZones();
        const rootEl = tab.splitRoot
            ? document.getElementById('split_' + tab.id)
            : document.getElementById('wrap_' + tab.id);
        if (!rootEl) return;
        const zones = this._tabComputeSplitZones(tab);
        if (zones.length === 0) return;
        const layer = document.createElement('div');
        layer.id = 'tab-drop-layer';
        zones.forEach((z, i) => {
            const el = document.createElement('div');
            el.className = 'pane-drop-zone side-' + z.side;
            el.setAttribute('data-zone-idx', i);
            el.style.left = z.x + '%'; el.style.top = z.y + '%';
            el.style.width = z.w + '%'; el.style.height = z.h + '%';
            layer.appendChild(el);
        });
        rootEl.appendChild(layer);
        this._tabSplitZones = { layer, zones, tabId: tab.id };
    },

    _tabHideSplitZones() {
        this._tabSplitZones = null;
        document.getElementById('tab-drop-layer')?.remove();
    },

    // Geometry hit test on current zones (the drag overlay intercepts mouse
    // events, so ev.target is always the overlay — use rect math).
    _tabHitSplitZone(ev) {
        const st = this._tabSplitZones;
        if (!st || !st.layer) return null;
        for (const z of st.layer.children) {
            const r = z.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                return z;
            }
        }
        return null;
    },

    // ── Tab drag via pointer events ──
    // HTML5 draggable is intercepted by Tauri's window-level DnD handler in
    // WebView2 (dragover never fires, cursor shows the no-drop icon), so tab
    // drag uses the same pointer-based approach as pane drag.
    _onTabPointerDown(e, tabId) {
        if (e.button !== 0) return;
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || tab.type === 'settings') return;
        // Action buttons are semantic <button>s and the rename field is a text input;
        // interactive elements must never start a tab drag.
        if (e.target.closest('button, input, textarea, [contenteditable]')) return;
        e.preventDefault();
        const el = e.currentTarget;
        const startX = e.clientX, startY = e.clientY;
        let dragging = false;
        let dragImage = null;
        const move = (ev) => {
            if (!dragging) {
                if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
                dragging = true;
                this._dragTab = { sourceTabId: tabId, targetTabId: null, side: null, targetPaneId: null };
                el.classList.add('dragging');
                const main = document.getElementById('main-area');
                if (main) main.classList.add('drop-target');
                document.body.classList.add('tab-dragging');
                // Snapshot of the dragged tab (matching the default HTML5 drag image), following the mouse
                const srcEl = document.querySelector('.tab[data-tab="' + tabId + '"]');
                if (srcEl) {
                    const img = srcEl.cloneNode(true);
                    img.className = 'tab tab-drag-image';
                    img.id = 'tab-drag-image';
                    img.removeAttribute('data-tab');
                    document.body.appendChild(img);
                    dragImage = img;
                }
                // Full-screen interception layer: blocks hover/interaction on everything below during the drag
                const overlay = document.createElement('div');
                overlay.id = 'tab-drag-overlay';
                document.body.appendChild(overlay);
            }
            ev.preventDefault();
            if (dragImage) { dragImage.style.left = (ev.clientX + 12) + 'px'; dragImage.style.top = (ev.clientY + 8) + 'px'; }
            // Hit test by geometry: the drag overlay intercepts all mouse
            // events, so ev.target is always the overlay — use rect math.
            // Only entering the content area (main-area) shows the split
            // hints; inside the tabbar only reorder hints are shown.
            const mainEl = document.getElementById('main-area');
            const inMain = !!(mainEl && ev.clientX >= mainEl.getBoundingClientRect().left && ev.clientX <= mainEl.getBoundingClientRect().right && ev.clientY >= mainEl.getBoundingClientRect().top && ev.clientY <= mainEl.getBoundingClientRect().bottom);
            if (inMain) {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
                this._hideDropZone();
                const targetTab = this.getActive();
                if (targetTab && targetTab.type !== 'settings' && this._dragTab.sourceTabId !== targetTab.id) {
                    // Hit test keeps the Electron original tolerance
                    // (wrap 30% edge / pane 28% edge) — the 8% zone bars are
                    // visuals only; a generous hit area matches user intuition
                    // ("drop anywhere near the edge").
                    let side = null, targetPaneId = null;
                    try {
                        if (targetTab.splitRoot) {
                        // 1) Zone-bar hit test first (Tabby's approach: the bars
                        //    are real elements; pointer inside a bar = drop there).
                        //    This gives precise semantics: root top/bottom bar =
                        //    whole split above/below, spanner bar = insert at the
                        //    separator, pane side bar = insert around that pane.
                        if (!this._tabSplitZones || this._tabSplitZones.tabId !== targetTab.id) {
                            this._tabShowSplitZones(targetTab);
                        }
                        const stBars = this._tabSplitZones;
                        if (stBars && stBars.layer) {
                            for (const zEl of stBars.layer.children) {
                                const r = zEl.getBoundingClientRect();
                                if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                                    const z = stBars.zones[parseInt(zEl.getAttribute('data-zone-idx'), 10)];
                                    if (z) {
                                        side = z.side;
                                        targetPaneId = z.relativeTo ? z.relativeTo.id : null;
                                    }
                                    break;
                                }
                            }
                        }
                        // 2) Geometry fallback for the area just outside the bars
                        //    (edge band between 8% bar and the 28% hit area).
                        if (!side) {

                            const hitPad = GAP_PX / 2; // hit the gap/spanner between panes too
                            for (const p of getAllPanes(targetTab)) {
                                const el = document.querySelector('.split-pane[data-pane="' + p.id + '"]');
                                if (!el) continue;
                                const r = el.getBoundingClientRect();
                                if (ev.clientX >= r.left - hitPad && ev.clientX <= r.right + hitPad && ev.clientY >= r.top - hitPad && ev.clientY <= r.bottom + hitPad) {
                                    const rx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
                                    const ry = Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1);
                                    const s = this._pickDropSide(rx, ry, 0.28);
                                    if (s) {
                                        // Vertical edge priority: when the pointer
                                        // is in a pane's top/bottom edge band, t/b
                                        // wins over l/r. In a horizontal split the
                                        // panes span the full height, so t/b means
                                        // "above/below the whole split" — matches
                                        // the intuition of dropping above the
                                        // separator to get one pane on top.
                                        if (ry < 0.28) side = 't';
                                        else if (ry > 0.72) side = 'b';
                                        else side = s;
                                        targetPaneId = p.id;
                                        break;
                                    }
                                }
                            }
                            // Root-level fallback: pointer in the split area's
                            // outer edge band but not inside any pane (top/
                            // bottom padding strip) → insert around the whole
                            // split root (e.g. one pane on top of two).
                            if (!side) {
                                const rootEl = document.getElementById('split_' + targetTab.id);
                                if (rootEl) {
                                    const r = rootEl.getBoundingClientRect();
                                    const rx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
                                    const ry = Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1);
                                    side = this._pickDropSide(rx, ry, 0.30);
                                    targetPaneId = null;
                                }
                            }
                        }
                        } else {
                            const wrap = document.getElementById('wrap_' + targetTab.id);
                            if (wrap) {
                                const r = wrap.getBoundingClientRect();
                                const rx = (ev.clientX - r.left) / r.width;
                                const ry = (ev.clientY - r.top) / r.height;
                                side = this._pickDropSide(rx, ry, 0.30);
                            }
                        }
                    } catch (err) {
                        console.warn('[tabdrag] side calc failed:', err);
                    }
                    // Function first: commit the drop target before any
                    // visual work, so a bar/zone failure can never break the
                    // split action itself.
                    this._dragTab.targetTabId = side ? targetTab.id : null;
                    this._dragTab.side = side;
                    this._dragTab.targetPaneId = targetPaneId;
                    // Visual bars (same as pane reorder) — isolated: any failure
                    // here must not affect the split functionality.
                    try {
                        if (!this._tabSplitZones || this._tabSplitZones.tabId !== targetTab.id) {
                            this._tabShowSplitZones(targetTab);
                        }
                        const st = this._tabSplitZones;
                        if (st && st.layer) {
                            st.layer.querySelectorAll('.pane-drop-zone.drag-over').forEach(el => el.classList.remove('drag-over'));
                            if (side) {
                                let idx = st.zones.findIndex(z => z.side === side && z.relativeTo && z.relativeTo.id === targetPaneId);
                                if (idx < 0) idx = st.zones.findIndex(z => z.side === side && !z.relativeTo);
                                if (idx >= 0) {
                                    const zEl = st.layer.querySelector('[data-zone-idx="' + idx + '"]');
                                    if (zEl) zEl.classList.add('drag-over');
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('[tabdrag] bars failed:', err);
                    }
                } else {
                    this._tabHideSplitZones();
                    this._dragTab.targetTabId = null;
                    this._dragTab.side = null;
                    this._dragTab.targetPaneId = null;
                }
            } else {
                this._tabHideSplitZones();
                const tabbar = document.getElementById('tabbar');
                let hitTabId = null;
                if (tabbar) {
                    for (const t of tabbar.querySelectorAll('.tab[data-tab]')) {
                        const r = t.getBoundingClientRect();
                        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                            hitTabId = t.getAttribute('data-tab');
                            break;
                        }
                    }
                }
                if (hitTabId) {
                    this._onTabDragOver(ev, hitTabId);
                } else {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
                }
            }
        };
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            if (!dragging) return;
            if (dragImage) { dragImage.remove(); dragImage = null; }
            document.getElementById('tab-drag-overlay')?.remove();
            const mainEl = document.getElementById('main-area');
            const inMain = !!(mainEl && ev.clientX >= mainEl.getBoundingClientRect().left && ev.clientX <= mainEl.getBoundingClientRect().right && ev.clientY >= mainEl.getBoundingClientRect().top && ev.clientY <= mainEl.getBoundingClientRect().bottom);
            if (inMain) {
                this._tabHideSplitZones();
                if (this._dragTab && this._dragTab.targetTabId && this._dragTab.side) {
                    const src = this._dragTab.sourceTabId, tgt = this._dragTab.targetTabId, sd = this._dragTab.side, pid = this._dragTab.targetPaneId;
                    this._dragTab = null;
                    try {
                        this._moveTerminalToTab(src, tgt, sd, pid);
                    } catch (err) {
                        console.warn('[tabdrag] drop failed:', err);
                    }
                } else {
                    this._dragTab = null;
                }
            } else {
                const tabbar = document.getElementById('tabbar');
                let hitTabId = null;
                if (tabbar) {
                    for (const t of tabbar.querySelectorAll('.tab[data-tab]')) {
                        const r = t.getBoundingClientRect();
                        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                            hitTabId = t.getAttribute('data-tab');
                            break;
                        }
                    }
                }
                if (hitTabId) this._onTabDrop(ev, hitTabId);
            }
            this._onTabDragEnd();
            document.body.classList.remove('tab-dragging');
        };
        // mouseup is not dispatched when the pointer leaves the window or it loses focus, so clean up drag
        // state defensively (otherwise the full-screen interception layer lingers and the UI freezes until the next in-window mouseup)
        const cancelDrag = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            if (dragImage) { dragImage.remove(); dragImage = null; }
            document.getElementById('tab-drag-overlay')?.remove();
            this._tabHideSplitZones();
            this._dragTab = null;
            this._onTabDragEnd();
            document.body.classList.remove('tab-dragging');
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('mouseleave', cancelDrag);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('pointercancel', cancelDrag);
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
        e.dataTransfer = e.dataTransfer || { dropEffect: 'move' }; // pointer events have no dataTransfer
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
        input.className = 'tab-rename-input inline-edit';
        el.replaceWith(input);
        input.focus();
        input.select();
        const finish = (save) => {
            if (save && input.value.trim()) {
                tab.name = input.value.trim();
                tab._customName = true; // lock the custom name so pane changes no longer overwrite it
            } else if (save && !input.value.trim() && tab.splitRoot) {
                // user cleared the name → restore auto-generation
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
        // Read shortcuts from _getShortcutBindings() so user-remapped bindings are reflected
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
        // Width grows with the shortcut hints (base 180 plus margin for the shortcut text)
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

        // Has splits: deep-clone the split tree and start a new backend for each pane
        if (src.splitRoot) return this._cloneSplitTab(src);

        // Single pane: plain createTab
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
        if (newTab) newTab._cloneCred = true; // mark as a clone so closeTab does not revoke the credential
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
            _cloneCred: true, // closeTab must not revoke; the credential belongs to the source tab
        };
        if (src.type === 'ssh') {
            Object.assign(tab, {
                host: src.host, port: src.port, user: src.user,
                privateKey: src.privateKey,
                sshProfileId: src.sshProfileId,
                // Note: _credId is NOT copied — each pane has its own _sshCredId.
                // Copying it to the tab level would make closeTab send revoke-credential,
                // disconnecting every pane sharing that credential
            });
        }
        // Deep-clone the split tree; leaf nodes keep the source pane's own type/SSH parameters
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

        // During _renderSplit the old and new split-root are both visible, causing layout contention,
        // so hide the new one first; switchTo then displays it correctly in a single-split context
        const newSplit = document.getElementById('split_' + tab.id);
        if (newSplit) newSplit.style.display = 'none';

        // Start backend connections for all leaf panes
        const panes = getAllPanes(tab);
        panes.forEach(p => this._spawnBackendForPane(p, tab));

        this.switchTo(id);
        // DOM layout is stable after switchTo; recompute gaps to fix spanner widths
        requestAnimationFrame(() => this._layoutSplit(tab));
        this._updateTabName(tab);
        this.render();
        return id;
    },

    _updateTabName(tab) {
        if (!tab || tab._customName) return;
        const panes = tab.splitRoot ? getAllPanes(tab) : [];
        const next = resolveTabName(tab, panes);
        const changed = next != null && next !== tab.name;
        if (changed) tab.name = next;
        // Split-tree callers rely on this hook to persist layout mutations even
        // when the computed name is unchanged, so the save stays unconditional
        // for split tabs; a single-terminal tab only saves when its name moved.
        if (tab.splitRoot || changed) this._scheduleSaveConfig();
    },

    // Visible-name overlay: a manual rename wins, then a tool-provided
    // `_toolName` (OSC 1337 rename channel), then the persisted base name.
    // Display-only — the result is never written back to `tab.name`.
    _tabDisplayName(tab) {
        if (!tab) return '';
        if (tab._customName) return tab.name || '';
        return resolveTabDisplayName(tab, tab.splitRoot ? getAllPanes(tab) : []);
    },

    // A tool-provided name changed: refresh the tab strip and (for the active
    // tab) the status bar. No saveConfig — `_toolName` is ephemeral and must
    // never reach the persisted config.
    refreshTabDisplay(tab) {
        this.render();
        if (tab && this.activeId === tab.id) this.updateStatus();
    },

    // Coalesced persistence: under continuous triggers like drags / pane create-destroy, write once per idle window (no more synchronous IPC blocking the render each time)
    _scheduleSaveConfig() {
        if (typeof requestIdleCallback !== 'undefined') {
            if (this._saveConfigIdleHandle) cancelIdleCallback(this._saveConfigIdleHandle);
            this._saveConfigIdleHandle = requestIdleCallback(() => {
                this._saveConfigIdleHandle = null;
                if (typeof saveConfig === 'function') saveConfig();
            });
        } else if (typeof saveConfig === 'function') {
            saveConfig();
        }
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
        tab.splitRoot = deserializeSplitNode(tabData.splitRoot, {
            defaultName: tab.name,
            nextPaneId: () => 'p_' + (this._paneCounter++),
        });
        // Guard against abnormal trees — normalize after deserialization; an empty tree (0 leaves) must not
        // enter the runtime: closing its last pane would leave an unclosable empty-split dead tab. Degraded trees restore as normal tabs.
        if (tab.splitRoot) {
            normalize(tab.splitRoot);
            if (getAllPanes(tab).length === 0) {
                tab.splitRoot = null;
            }
        }
        this.tabs.push(tab);
        if (!tab.splitRoot) {
            // Degraded (empty tree): restore as a normal single-terminal tab and start the backend
            const { wrap: w, inner: wInner } = createTermWrap(tab);
            document.getElementById('main-area').appendChild(w);
            if (tabData.type === 'ssh' && tabData.host) {
                _sshConnectWithCredentials(tab, null, tab.id);
            } else {
                ipcRenderer.send('pty-create', { shell: tab.command, args: tab.args || [], requestId: tab.id });
            }
            this._updateTabName(tab);
            return tab;
        }
        this._renderSplit(tab);
        this._updateTabName(tab);
        // Hide on restore and show only after switchTo activates it, preventing multiple splits from stacking
        const splitEl = document.getElementById('split_' + tab.id);
        if (splitEl) splitEl.style.display = 'none';

        // Register credentials (SSH) and start the backend for each pane
        const panes = getAllPanes(tab);
        panes.forEach(p => {
            if (p.type === 'ssh' && p._sshHost) {
                const prof = (this.sshProfiles || []).find(x => x.id === p._sshProfileId);
                // Credential registration is async; spawn the backend when it completes
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
        e.dataTransfer = e.dataTransfer || { dropEffect: 'move' }; // pointer events have no dataTransfer
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

// ── Shared low-latency tab tooltip ──
// Native title attributes carry a ~1s OS delay, which reads as lag when the
// pointer sweeps across tabs. One delegated listener + one shared element.
// Hover must NEVER change tab geometry — long names stay truncated and
// are fully revealed by this tooltip alone; the handler only switches the
// pending target and does one rect-read/style-write per NEW target inside
// the 120ms timer. No width measurement, no expansion state machine.
(() => {
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    let tip = null, timer = null, current = null;
    const ensure = () => {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'zt-tip';
            document.body.appendChild(tip);
        }
        return tip;
    };
    const hide = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (tip) tip.classList.remove('show');
        current = null;
    };
    bar.addEventListener('mouseover', (e) => {
        // Covers tabs plus the tabbar's two chrome buttons (their dataset.tip shares this low-latency tooltip).
        // Moving between a tab's internal spans/svg resolves to the same
        // closest('.tab') target and must NOT restart the timer.
        const el = e.target.closest('.tab, #btn-add-tab, #btn-menu');
        if (!el || el === current) return;
        hide();
        current = el;
        timer = setTimeout(() => {
            if (!el.isConnected) { hide(); return; }
            const name = (el.dataset.tip || el.querySelector('.tab-name')?.textContent || '').trim();
            if (!name) return;
            const t = ensure();
            t.textContent = name;
            t.classList.add('show');
            const r = el.getBoundingClientRect();
            t.style.left = Math.min(Math.max(8, r.left), window.innerWidth - t.offsetWidth - 8) + 'px';
            t.style.top = (r.bottom + 6) + 'px';
        }, 120);
    });
    bar.addEventListener('mouseleave', hide);
    bar.addEventListener('click', hide, true);
    bar.addEventListener('mousedown', hide, true);
    // Tab re-renders (connect/close/rename state changes) replace the DOM
    // under a possibly stationary pointer — drop stale targets so a tooltip
    // never lingers on detached elements until the next mouse move.
    new MutationObserver(() => { if (current && !current.isConnected) hide(); })
        .observe(bar, { childList: true, subtree: true });
})();
