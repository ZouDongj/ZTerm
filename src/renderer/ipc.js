// ZTerm - ipcRenderer 监听器 + pty-output 路由（拆自 renderer.html，纯代码搬运，未改逻辑）

// 更新 pane 状态点 DOM（TabManager.render() 不重绘 pane header，需手动更新）
function _updatePaneDot(pane, connected) {
    pane.connected = connected;
    const el = document.querySelector(`.split-pane[data-pane="${pane.id}"] .pane-header .dot`);
    if (el) {
        el.classList.remove('connected', 'disconnected');
        el.classList.add(connected ? 'connected' : 'disconnected');
    }
}

// ConPTY rewrites the app's trailing `ESC[?25h` into `ESC[?25l` and paints its
// own reverse-video caret cell, which permanently hides the real cursor and
// kills smooth-cursor animations inside TUI apps (herdr etc.). The filter is
// per-tab/per-pane because it carries cross-chunk state (sync blocks, UTF-8).
function _conPtyCaretFix(owner, data) {
    const factory = typeof createConPtyCaretFilter === 'function'
        ? createConPtyCaretFilter
        : window.createConPtyCaretFilter;
    if (!factory) return data;
    if (!owner._caretFilter) owner._caretFilter = factory({ mode: 'fix' });
    const out = owner._caretFilter.push(data);
    return typeof out === 'string' ? out : data;
}

// Drop the caret filter at session boundaries. If a TUI left the filter in
// the middle of a synchronized-output block (inSync=true, e.g. the SSH
// connection died mid-frame), the filter would swallow every byte of the
// next session's output into its block buffer — the terminal would look
// frozen until some other TUI happened to open and close a sync block.
function _resetCaretFilterById(tabId) {
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId);
            if (pane) { delete pane._caretFilter; return; }
        }
        if (tab.tabId === tabId) { delete tab._caretFilter; return; }
    }
}

ipcRenderer.on('pty-output', (event, { tabId, data }) => {
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId);
            if (pane) {
                if (!tab._contentBuffer) tab._contentBuffer = [];
                // ConPTY caret fix must run before buffering so the filter sees
                // the full stream in order; ptyBuffers then holds repaired bytes.
                if (typeof data === 'string' && data) data = _conPtyCaretFix(pane, data);
                if (pane.term) {
                    pane.term.write(applyHighlight(data, tabId));
                } else {
                    let _b = ptyBuffers[tabId] || ''; _b += data; if (_b.length > 1048576) _b = _b.slice(-524288); ptyBuffers[tabId] = _b;
                }
                return;
            }
        }
        if (tab.tabId === tabId) {
            if (!tab._contentBuffer) tab._contentBuffer = [];
            if (typeof data === 'string' && data) data = _conPtyCaretFix(tab, data);
            // Track alternate screen (nvim, less, etc.) — don't save TUI content
            if (data.includes('\x1b[?1049h')) tab._altScreen = true;
            if (data.includes('\x1b[?1049l')) tab._altScreen = false;
            if (!tab._altScreen) {
                const lines = data.split('\n');
                for (const line of lines) {
                    if (line) tab._contentBuffer.push(line);
                }
                if (tab._contentBuffer.length > 500) {
                    tab._contentBuffer = tab._contentBuffer.slice(-500);
                }
            }
            if (tab.term) {
                if (ptyBuffers[tabId]) {
                    tab.term.write(ptyBuffers[tabId]);
                    delete ptyBuffers[tabId];
                }
                tab.term.write(applyHighlight(data, tabId));
            } else {
                let _b = ptyBuffers[tabId] || ''; _b += data; if (_b.length > 1048576) _b = _b.slice(-524288); ptyBuffers[tabId] = _b;
            }
            return;
        }
    }
});

// ── IPC: PTY created (local) ──
ipcRenderer.on('pty-created', (event, { tabId, requestId, spawnError }) => {
    _resetCaretFilterById(tabId);
    if (requestId) {
        for (const tab of TabManager.tabs) {
            if (tab.splitRoot) {
                const pane = findPane(tab, requestId) || getAllPanes(tab).find(p => p.requestId === requestId);
                if (pane) {
                    pane.tabId = tabId;
                    wireTerminalToPane(tab, pane);
                    if (spawnError && pane.term) pane.term.write('\r\n\x1b[31m[ZTerm] 启动失败: ' + spawnError + '\x1b[0m\r\n');
                    // 同步 fit + 立即上报尺寸：本地 pty 以 80x24 开启，缩短到真实尺寸的窗口
                    _syncFitAndReportSize(tab, pane);
                    return;
                }
            } else if (tab.id === requestId || tab._ptyRequestId === requestId) {
                delete tab._ptyRequestId;
                if (!tab.term) {
                    wireTerminal(tab, tabId);
                    if (spawnError && tab.term) tab.term.write('\r\n\x1b[31m[ZTerm] 启动失败: ' + spawnError + '\x1b[0m\r\n');
                    _syncFitAndReportSize(tab, null);
                    return;
                }
            }
        }
    }
    // 无人认领的孤儿 pty——回收，避免进程泄漏
    ipcRenderer.send('pty-destroy', { tabId });
});

// ── IPC: SSH connecting ──
// SSH 握手开始（onReady 在认证完成后才来，有几秒窗口）：
// 此时建好 term 并 fit，立刻把真实 cols/rows 发给主进程存入 pendingSizes，
// 主进程在 onReady 开 PTY 时取用 → PTY 一开就是真实尺寸，无 80x24 闪烁
function _syncFitAndReportSize(tab, pane) {
    const term = pane ? pane.term : tab.term;
    const fitAddon = pane ? pane.fitAddon : tab.fitAddon;
    const parentEl = pane
        ? document.getElementById('pane-body_' + pane.id)
        : (term && term.element ? term.element.parentElement : null);
    if (!term || !fitAddon || !parentEl) return;
    // 等一帧让 DOM 落位，再 fit + 直发尺寸到主进程（此时 PTY 未开，主进程缓存为 pendingSizes）
    requestAnimationFrame(() => {
        _fitWithScroll(term, fitAddon, parentEl);
        const backendTabId = pane ? pane.tabId : tab.tabId;
        if (backendTabId && term.cols && term.rows) {
            ipcRenderer.send('pty-resize', { tabId: backendTabId, cols: term.cols, rows: term.rows });
        }
    });
}

ipcRenderer.on('ssh-connecting', (event, { tabId, rendererId }) => {
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = findPane(tab, rendererId) || getAllPanes(tab).find(p => p.requestId === rendererId);
            if (pane) {
                pane.tabId = tabId;
                // 保留模式（clearOnConnect=false）下终端已存在：不重建，否则保留的内容被替换成空终端
                if (!pane.term) wireTerminalToPane(tab, pane);
                if (pane.term) {
                    pane.term.write('\x1b[33mConnecting to ' + (pane._sshHost || tab.host || pane.name || tab.name) + '...\x1b[0m\r\n');
                    _syncFitAndReportSize(tab, pane);
                }
                return;
            }
        } else if (tab.id === rendererId) {
            tab.tabId = tabId;
            if (!tab.term) wireTerminal(tab, tabId);
            if (tab.term) tab.term.write('\x1b[33mConnecting to ' + (tab.host || tab.name) + '...\x1b[0m\r\n');
            _syncFitAndReportSize(tab, null);
            return;
        }
    }
});

// ── IPC: SSH connected ──
// SSH 展示名：优先 SSH 配置名，不用动态拼接的 tab 名（分屏命名会拼成 "A | B"）
function _sshDisplayName(tab, pane) {
    const pId = (pane && pane._sshProfileId) || tab.sshProfileId;
    const prof = pId ? (TabManager.sshProfiles || []).find(x => x.id === pId) : null;
    return (prof && prof.name) || (pane && pane.name) || tab.host || tab.name;
}

ipcRenderer.on('ssh-connected', (event, { tabId, rendererId }) => {
    _resetCaretFilterById(tabId);
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId || p.requestId === rendererId);
            if (pane) {
                tab._sshRetried = 0; // connected: re-arm THIS tab's handshake retry budget
                if (!pane.term) wireTerminalToPane(tab, pane);
                if (pane.term) pane.term.write('\r\n\x1b[32m[SSH Connected]\x1b[0m\r\n');
                tab.connected = true;
                _updatePaneDot(pane, true);
                TabManager.render();
                TabManager.updateStatus();
                showToast('SSH 已连接: ' + _sshDisplayName(tab, pane));
                // 兜底尺寸结算：connecting 阶段已 fit 并通过 pendingSizes 让 PTY 开对尺寸，
                // 但若 connecting 时容器 0 尺寸（tab 不可见等），这里补一次；connected 后尺寸已注册可用
                _scheduleSettleResize(tab);
                return;
            }
        } else if (tab.tabId === tabId || tab.id === rendererId) {
            tab._sshRetried = 0; // connected: re-arm THIS tab's handshake retry budget
            tab.connected = true;
            if (!tab.term) wireTerminal(tab, tabId);
            if (tab.term) tab.term.write('\r\n\x1b[32m[SSH Connected]\x1b[0m\r\n');
            TabManager.render();
            TabManager.updateStatus();
            showToast('SSH 已连接: ' + _sshDisplayName(tab, null));
            _scheduleSettleResize(tab); // 兜底尺寸结算，与分屏分支对称
            return;
        }
    }
});

// ── IPC: SSH error ──
ipcRenderer.on('ssh-error', (event, { tabId, rendererId, error }) => {
    let tab = null, pane = null;
    for (const t of TabManager.tabs) {
        if (t.splitRoot) {
            const p = getAllPanes(t).find(pp => pp.tabId === tabId || pp.requestId === rendererId);
            if (p) { tab = t; pane = p; break; }
        } else if (t.id === rendererId || t.tabId === tabId) {
            // 只精确匹配——不能把错误写到任意"还在连接中"的 SSH tab 上
            tab = t; break;
        }
    }
    if (!tab) { showToast('[SSH] ' + error, true); return; }
    // M6：按 russh 错误文本类别判断瞬时性错误（超时/连接被断/密钥交换失败）才自动重试一次；
    // 认证失败、未知主机密钥等确定性错误不重试。原正则 /handshake|lost before/ 是给
    // Electron ssh2 错误写的，russh 常规错误不命中导致瞬时失败从不重试
    // Handshake-class failures include the bare russh "Disconnected" that
    // strict sshd configs (MaxStartups-style random early drop, fail2ban)
    // produce while several connections arrive close together — retry with
    // backoff rides out the server-side drop instead of surfacing it.
    // Windows io errors localize ("由于目标计算机积极拒绝" on zh-CN), so the
    // WSA codes are matched directly: 10054 reset / 10060 timeout /
    // 10061 refused.
    const isHandshakeErr = /timeout|timed out|connection (closed|refused|reset)|key exchange|network|eof|tcp\/handshake.*disconnected|os error 100(54|60|61)/i.test(error);
    const retryCount = (tab._sshRetried || 0);
    if (isHandshakeErr && retryCount < 3) {
        tab._sshRetried = retryCount + 1;
        const backoffMs = [2000, 5000, 10000][Math.min(retryCount, 2)];
        // Keep the terminal mounted through automatic retries: write the
        // status line into the existing xterm instead of disposing it. The
        // old flow (dispose term + remove wrap) blanked the tab's whole
        // display area for the entire backoff window and churned a fresh
        // WebGL stack per attempt. Content accumulates so the user sees the
        // full retry trail; a manual reconnect (reconnectTab) still honors
        // clearOnConnect for a clean slate.
        const retryTerm = pane ? pane.term : tab.term;
        if (retryTerm) retryTerm.write(`\r\n\x1b[33m[SSH] handshake dropped, retrying in ${Math.round(backoffMs / 1000)}s (${tab._sshRetried}/3)...\x1b[0m\r\n`);
        if (pane) {
            if (pane.tabId) {
                ipcRenderer.send('ssh-disconnect', { tabId: pane.tabId, rendererId: tab.id });
                delete ptyBuffers[pane.tabId];
                // Reset the caret filter explicitly: the ssh-disconnected
                // event lookup happens after pane.tabId is nulled and would
                // miss, leaving a filter stuck mid-sync-block on the KEPT
                // term to swallow the reconnect's fresh output.
                delete pane._caretFilter;
            }
            pane.tabId = null;
        } else {
            if (tab.tabId) {
                ipcRenderer.send('ssh-disconnect', { tabId: tab.tabId, rendererId: tab.id });
                delete ptyBuffers[tab.tabId];
                delete tab._caretFilter; // same as the pane branch above
                tab._altScreen = false;
            }
            tab.tabId = null;
        }
        // A manual reconnect (reconnectTab / clicking a down tab) supersedes
        // this scheduled retry: both would enqueue a connect for the same
        // rendererId and the loser's session gets orphaned. reconnectTab
        // bumps the token, making superseded timers no-op. Pane liveness is
        // checked separately — closing the pane (not the tab) during the
        // backoff must not spawn a backend for a dead pane.
        const token = (tab._sshRetryToken = (tab._sshRetryToken || 0) + 1);
        const stillWanted = () => tab._sshRetryToken === token && TabManager.tabs.includes(tab)
            && (!pane || TabManager.tabs.some(t => t.id === tab.id && getAllPanes(t).some(p => p.id === pane.id)));
        setTimeout(() => {
            if (!stillWanted()) return; // superseded / tab or pane closed
            _sshConnectWithCredentials(tab, pane, pane ? pane.requestId : tab.id);
        }, backoffMs);
        return;
    }
    if (pane) {
        if (pane.term) {
            pane.term.write('\r\n\x1b[31m[SSH Error] ' + error + '\x1b[0m\r\n');
        } else {
            wireTerminalToPane(tab, pane);
            if (pane.term) pane.term.write('\r\n\x1b[31m[SSH Error] ' + error + '\x1b[0m\r\n');
        }
        tab.connected = false;
        _updatePaneDot(pane, false);
        TabManager.render();
        TabManager.updateStatus();
        showToast('SSH 连接失败: ' + error, true);
        return;
    }
    tab.connected = false;
    if (!tab.tabId) tab.tabId = tabId;
    if (tab.term) {
        tab.term.write('\r\n\x1b[31m[SSH Error] ' + error + '\x1b[0m\r\n');
    } else {
        wireTerminal(tab, tabId);
        if (tab.term) tab.term.write('\r\n\x1b[31m[SSH Error] ' + error + '\x1b[0m\r\n');
    }
    TabManager.render();
    TabManager.updateStatus();
    showToast('SSH 连接失败: ' + error, true);
});

// ── IPC: SSH disconnected ──
ipcRenderer.on('ssh-disconnected', (event, { tabId, rendererId }) => {
    // The filter may be stuck mid-sync-block from the dead session; drop it so
    // a reconnect cannot inherit a filter that swallows all fresh output.
    _resetCaretFilterById(tabId);
    clearAlternateScreen(tabId);
    if (TabManager._consumeClosed(tabId)) {
        return;
    }
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId || p.requestId === rendererId);
            if (pane) {
                tab.connected = false;
                _updatePaneDot(pane, false);
                if (pane.term) pane.term.write('\r\n\x1b[33m[SSH Disconnected]\x1b[0m\r\n');
                TabManager.render();
                TabManager.updateStatus();
                return;
            }
        } else if (tab.tabId === tabId || tab.id === rendererId) {
            tab.connected = false;
            if (tab.term) tab.term.write('\r\n\x1b[33m[SSH Disconnected]\x1b[0m\r\n');
            TabManager.render();
            TabManager.updateStatus();
            return;
        }
    }
});

// ── IPC: PTY exit ──
ipcRenderer.on('pty-exit', (event, { tabId }) => {
    _resetCaretFilterById(tabId);
    clearAlternateScreen(tabId);
    if (TabManager._consumeClosed(tabId)) {
        return;
    }
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId);
            if (pane && pane.term) {
                pane.term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
                tab.connected = false;
                _updatePaneDot(pane, false);
                TabManager.render();
                return;
            }
        } else if (tab.tabId === tabId) {
            tab.connected = false;
            if (tab.term) tab.term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
            TabManager.render();
            return;
        }
    }
});

ipcRenderer.on('pty-destroyed', () => {});

// ── IPC: Refocus terminal after window state changes ──
ipcRenderer.on('trigger-search', () => {
    const tab = TabManager.getActive();
    if (tab && tab.type !== 'settings') openSearch();
});

ipcRenderer.on('trigger-split-h', () => {
    if (!document.querySelector('.overlay.open')) {
        TabManager.splitHorizontal();
    }
});

ipcRenderer.on('trigger-split-v', () => {
    if (!document.querySelector('.overlay.open')) {
        TabManager.splitVertical();
    }
});

ipcRenderer.on('refocus-terminal', () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        _refocusActiveTerminal();
    }));
});

ipcRenderer.on('window-state-changed', (event, { maximized }) => {
    const winEl = document.querySelector('.window');
    if (!winEl) return;
    winEl.classList.toggle('is-maximized', maximized);
    // Recalculate gap percentages and relayout panes/spanners for the new viewport size
    requestAnimationFrame(() => {
        TabManager.tabs.forEach(tab => {
            if (tab.splitRoot) TabManager._layoutSplit(tab);
            // 窗口尺寸变化后对所有 tab 结算最终终端尺寸（覆盖单 terminal 的 wrap RO 可能漏发的边角）
            _scheduleSettleResize(tab);
        });
    });
});

// 配置文件损坏已被主进程备份并重建，通知用户
ipcRenderer.on('config-corrupted', () => {
    showToast('配置文件已损坏，已备份并恢复默认设置', true);
});

// SSH host key 不匹配告警（可能 MITM），让用户决定是否继续连接
// 当前活跃 hostkey 弹窗的 cleanup：Escape 关闭（closeAllOverlays）不触发 cleanup，
// 旧回调会叠加到下次弹窗（可能放行未确认的主机）。打开新弹窗前先解绑旧的。
let _activeHostkeyCleanup = null;

ipcRenderer.on('ssh-hostkey-mismatch', (event, { tabId, host, oldAlgorithm, oldFingerprint, newAlgorithm, newFingerprint }) => {
    if (_activeHostkeyCleanup) _activeHostkeyCleanup();
    const msg = `⚠ 主机密钥变更警告\n\n主机 ${host} 的密钥指纹与已知记录不符，可能存在中间人攻击。\n\n旧指纹 (${oldAlgorithm}):\n${oldFingerprint}\n\n新指纹 (${newAlgorithm}):\n${newFingerprint}\n\n是否信任新密钥并继续连接？`;
    document.getElementById('confirm-msg').textContent = msg;
    const overlay = document.getElementById('overlay-confirm');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');
    cancelBtn.textContent = '拒绝';
    okBtn.textContent = '信任并连接';

    const cleanup = () => {
        _activeHostkeyCleanup = null;
        overlay.classList.remove('open');
        cancelBtn.removeEventListener('click', onReject);
        okBtn.removeEventListener('click', onAccept);
        overlay.querySelector('.overlay-backdrop').removeEventListener('click', onReject);
        // 恢复默认按钮文案
        cancelBtn.textContent = '取消';
        okBtn.textContent = '删除';
    };
    const onReject = () => {
        cleanup();
        ipcRenderer.send('ssh-hostkey-decision', { tabId, accept: false, trust: false });
    };
    const onAccept = () => {
        cleanup();
        ipcRenderer.send('ssh-hostkey-decision', { tabId, accept: true, trust: true });
    };

    cancelBtn.addEventListener('click', onReject);
    okBtn.addEventListener('click', onAccept);
    overlay.querySelector('.overlay-backdrop').addEventListener('click', onReject);
    overlay.classList.add('open');
    _activeHostkeyCleanup = cleanup;
});

