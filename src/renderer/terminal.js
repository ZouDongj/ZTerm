// ZTerm - 终端创建/接线/搜索/同步输入（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Shared: fit terminal + preserve scroll-to-bottom ──
function _fitWithScroll(term, fitAddon, parentEl) {
    if (!term || !fitAddon || !parentEl) return;
    if (parentEl.clientWidth === 0 || parentEl.clientHeight === 0) return;
    const vp = parentEl.querySelector('.xterm-viewport');
    const dist = vp ? (vp.scrollHeight - vp.scrollTop - vp.clientHeight) : 0;
    const rowH = vp && term.rows ? (vp.clientHeight / term.rows) : 20;
    const wasAtBottom = dist < rowH;
    fitAddon.fit();
    if (vp) { vp.style.width = '100%'; vp.style.right = '0'; }
    if (wasAtBottom) {
        // Defer scroll-to-bottom so xterm has finished rendering the new row count
        requestAnimationFrame(() => {
            try { term.scrollToBottom(); } catch(e) {}
            if (vp) vp.scrollTop = vp.scrollHeight;
        });
    }
}

// 布局动画（200ms）结束后的尺寸结算：
// onResize 在 _layoutTime 后 300ms 内会被抑制（terminal.js 内两处），动画结束的最终尺寸会落在
// 抑制窗口里被丢弃，导致后端停留旧尺寸（分屏后 nvim 界面混乱）。这里在 320ms 后统一重 fit 并显式上报。
function _scheduleSettleResize(tab) {
    clearTimeout(tab._resizeSettleTimer);
    tab._resizeSettleTimer = setTimeout(() => {
        if (tab.splitRoot) {
            getAllPanes(tab).forEach(p => {
                if (p.term && p.fitAddon) {
                    _fitWithScroll(p.term, p.fitAddon, document.getElementById('pane-body_' + p.id));
                    if (p.tabId && p.term.cols && p.term.rows) {
                        ipcRenderer.send('pty-resize', { tabId: p.tabId, cols: p.term.cols, rows: p.term.rows });
                    }
                }
            });
        } else if (tab.term && tab.fitAddon) {
            _fitWithScroll(tab.term, tab.fitAddon, tab.term.element ? tab.term.element.parentElement : null);
            if (tab.tabId && tab.term.cols && tab.term.rows) {
                ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols: tab.term.cols, rows: tab.term.rows });
            }
        }
    }, 320);
}

// ── Resize observer helper for single-terminal wraps ──
function setupWrapResizeObserver(wrap, tab) {
    if (!wrap || !tab.term || !tab.fitAddon) return;
    if (wrap._resizeObserver) wrap._resizeObserver.disconnect();
    const inner = wrap.querySelector('.term-inner') || wrap;
    let rafPending = false;
    const ro = new ResizeObserver(() => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            if (!_spannerDrag && !TabManager._maximizing) _fitWithScroll(tab.term, tab.fitAddon, inner);
            rafPending = false;
        });
    });
    ro.observe(wrap);
    wrap._resizeObserver = ro;
}

// Create a .term-wrap with an inner content wrapper. The inner wrapper fills the
// area inside .term-wrap's padding, so xterm's FitAddon measures the real terminal
// area instead of the padded container.
function createTermWrap(tab) {
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap' + (TabManager.activeId === tab.id ? ' active' : '');
    wrap.id = 'wrap_' + tab.id;
    const inner = document.createElement('div');
    inner.className = 'term-inner';
    wrap.appendChild(inner);
    return { wrap, inner };
}

function _buildTerminalOptions() {
    const c = _settingsConfig;
    const fontFamily = _normalizeFontFamily(
        c.fontFamily || '"JetBrains Mono","Cascadia Code",Consolas,monospace',
        c.fallbackFont
    );
    const accentColor = _getAccentColor();
    return {
        cursorBlink: c.cursorBlink === true,
        cursorStyle: c.cursor || 'bar',
        fontSize: c.fontSize || 13.5,
        fontFamily: fontFamily,
        fontWeight: _clampFontWeight(c.fontWeight, '450'),
        fontWeightBold: _clampFontWeight(c.fontWeightBold, '700'),
        lineHeight: c.lineHeight || 1.6,
        scrollback: c.scrollback || 10000,
        minimumContrastRatio: c.minimumContrastRatio || 4,
        drawBoldTextInBrightColors: false,
        theme: getTerminalTheme(),
        allowProposedApi: true,
        customGlyphs: true,
        overviewRuler: { width: 6 },
    };
}

// ── Terminal wiring (shared by PTY and SSH) ──
function wireTerminal(tab, tabId) {
    tab.tabId = tabId;

    const { wrap, inner } = createTermWrap(tab);
    document.getElementById('main-area').appendChild(wrap);

    const term = new Terminal(_buildTerminalOptions());
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try { term.loadAddon(new WebglAddon()); } catch(e) {}
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(new ClipboardAddon()); } catch(e) {}
    }
    try { term.loadAddon(_createWebLinksAddon()); } catch(e) {}
    tab._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(inner);
    term.attachCustomKeyEventHandler(e => {
        // 放行快捷键到 shortcuts.js 调度：Ctrl+P（命令面板）、Ctrl+Shift+P（快捷命令）
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'p') return false;
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'P' || e.key === 'p')) return false;
        return true;
    });
    tab.term = term;
    tab.fitAddon = fitAddon;

    function applyFit(retries = 10) {
        if (_spannerDrag || TabManager._maximizing) return;
        if (retries <= 0) return;
        if (inner.clientWidth === 0 || inner.clientHeight === 0) {
            setTimeout(() => applyFit(retries - 1), 50);
            return;
        }
        _fitWithScroll(tab.term, fitAddon, inner);
    }

    setTimeout(() => applyFit(), 50);

    setupWrapResizeObserver(wrap, tab);

    let _resizeDebounce = null;
    term.onResize(({ cols, rows }) => {
        if (TabManager._maximizing) return;
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            ipcRenderer.send('pty-resize', { tabId, cols, rows });
        }, 150);
    });

    // Fallback resize after 1s — covers slow-starting shells that missed the initial resize
    setTimeout(() => {
        if (tab.term && tab.term.cols && tab.term.rows) {
            ipcRenderer.send('pty-resize', { tabId, cols: tab.term.cols, rows: tab.term.rows });
        }
    }, 1000);

    term.onData(data => {
        _sendPaneInput(tab, { tabId }, data);
    });
    _bindSyncExitOnClick(tab, term.element);

    // ── Bell notification ──
    term.onBell(() => {
        const bell = _settingsConfig.bell || 'off';
        if (bell === 'off') return;
        if (bell !== 'flash') showToast('🔔 ' + (tab.name || '终端') + ' 响铃');
        if (bell === 'flash' || bell === 'notification+flash') {
            const tabEl = document.querySelector(`.tab[data-tab="${tab.id}"]`);
            if (tabEl) { tabEl.classList.add('bell-flash'); setTimeout(() => tabEl.classList.remove('bell-flash'), 2000); }
        }
    });

    // ── Select to copy (with smart wrap handling) ──
    term.onSelectionChange(() => {
        if (_settingsConfig.autoCopy === false) return;
        const sel = term.getSelection();
        if (sel) {
            let text = sel;
            // Smart copy: strip soft-wrap line continuations
            if (_settingsConfig.smartCopy !== false) {
                text = _stripSoftWrap(text, term);
            }
            try {
                const clipboard = require('electron').clipboard;
                if (_settingsConfig.richTextCopy) {
                    // Rich text copy: convert ANSI to HTML
                    const html = _ansiToHtml(sel, term);
                    clipboard.write({ text, html });
                } else {
                    clipboard.writeText(text);
                }
            } catch(e) {}
        }
    });

    // ── Right-click paste ──
    term.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        try {
            const text = require('electron').clipboard.readText();
            if (text) _sendPaneInput(tab, { tabId }, text);
        } catch(e) {}
    });

    if (ptyBuffers[tabId]) {
        term.write(ptyBuffers[tabId]);
        delete ptyBuffers[tabId];
    }

    if (_settingsConfig.restoreLocalContent && tab._contentBuffer && tab._contentBuffer.length > 0) {
        term.write(tab._contentBuffer.join('\r\n') + '\r\n');
    }

    if (TabManager.activeId === tab.id) {
        setTimeout(() => term.focus(), 150);
    }
}

// 分屏同步输入：syncInput 开启时输入广播到该 tab 的所有 pane
function _sendPaneInput(tab, pane, data) {
    if (tab.syncInput && tab.splitRoot) {
        getAllPanes(tab).forEach(p => {
            if (p.tabId) ipcRenderer.send('pty-input', { tabId: p.tabId, data });
        });
    } else if (pane.tabId) {
        ipcRenderer.send('pty-input', { tabId: pane.tabId, data });
    }
}

// 同步输入开启时，点击任意 pane（包括当前聚焦的）退出
function _bindSyncExitOnClick(tab, element) {
    element.addEventListener('mousedown', () => {
        if (!tab.syncInput) return;
        tab.syncInput = false;
        const rootEl = document.getElementById('split_' + tab.id);
        if (rootEl) rootEl.classList.remove('sync-input');
        showToast('同步输入已关闭');
    });
}

function wireTerminalToPane(tab, pane) {
    const bodyEl = document.getElementById('pane-body_' + pane.id);
    if (!bodyEl) return;

    const term = new Terminal(_buildTerminalOptions());
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try { term.loadAddon(new WebglAddon()); } catch(e) {}
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(new ClipboardAddon()); } catch(e) {}
    }
    try { term.loadAddon(_createWebLinksAddon()); } catch(e) {}
    pane._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(bodyEl);
    term.attachCustomKeyEventHandler(e => {
        // 放行快捷键到 shortcuts.js 调度：Ctrl+P（命令面板）、Ctrl+Shift+P（快捷命令）
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'p') return false;
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'P' || e.key === 'p')) return false;
        return true;
    });
    pane.term = term;
    pane.fitAddon = fitAddon;

    function applyFit(retries = 10) {
        if (_spannerDrag || TabManager._maximizing) return;
        if (retries <= 0) return;
        if (bodyEl.clientWidth === 0 || bodyEl.clientHeight === 0) {
            setTimeout(() => applyFit(retries - 1), 50);
            return;
        }
        _fitWithScroll(pane.term, fitAddon, bodyEl);
    }

    // 等 CSS 过渡完成（200ms）后再初始 fit，避免拿到中间态尺寸
    setTimeout(() => applyFit(), 300);

    // Disconnect any previous ResizeObserver on this body to avoid double-fit
    if (bodyEl._resizeObserver) { bodyEl._resizeObserver.disconnect(); }
    let rafPending = false;
    const observer = new ResizeObserver(() => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            applyFit();
            rafPending = false;
        });
    });
    observer.observe(bodyEl);
    bodyEl._resizeObserver = observer;

    let _resizeDebounce = null;
    term.onResize(({ cols, rows }) => {
        if (TabManager._maximizing) return;
        // 分屏布局动画期间（200ms）的中间尺寸不发，等动画稳定后再发
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols, rows });
        }, 150);
    });

    term.onData(data => {
        _sendPaneInput(tab, pane, data);
    });
    _bindSyncExitOnClick(tab, term.element);

    // ── Bell notification ──
    term.onBell(() => {
        const bell = _settingsConfig.bell || 'off';
        if (bell === 'off') return;
        if (bell !== 'flash') showToast('🔔 ' + (tab.name || '终端') + ' 响铃');
        if (bell === 'flash' || bell === 'notification+flash') {
            const tabEl = document.querySelector(`.tab[data-tab="${tab.id}"]`);
            if (tabEl) { tabEl.classList.add('bell-flash'); setTimeout(() => tabEl.classList.remove('bell-flash'), 2000); }
        }
    });

    // ── Select to copy (with smart wrap handling) ──
    term.onSelectionChange(() => {
        if (_settingsConfig.autoCopy === false) return;
        const sel = term.getSelection();
        if (sel) {
            let text = sel;
            // Smart copy: strip soft-wrap line continuations
            if (_settingsConfig.smartCopy !== false) {
                text = _stripSoftWrap(text, term);
            }
            try {
                const clipboard = require('electron').clipboard;
                if (_settingsConfig.richTextCopy) {
                    // Rich text copy: convert ANSI to HTML
                    const html = _ansiToHtml(sel, term);
                    clipboard.write({ text, html });
                } else {
                    clipboard.writeText(text);
                }
            } catch(e) {}
        }
    });

    // ── Right-click paste ──
    term.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        try {
            const text = require('electron').clipboard.readText();
            if (text) _sendPaneInput(tab, pane, text);
        } catch(e) {}
    });

    // Sync pane focus visual when terminal receives focus
    const syncFocus = () => {
        if (TabManager._maximizedPaneId) return;
        const ownerTab = TabManager.tabs.find(t => t.splitRoot && getAllPanes(t).some(pp => pp.id === pane.id));
        if (!ownerTab) return;
        getAllPanes(ownerTab).forEach(p => p.focused = (p.id === pane.id));
        const container = document.getElementById('split_' + ownerTab.id);
        if (container) {
            container.querySelectorAll('.split-pane').forEach(el => {
                el.classList.toggle('active', el.getAttribute('data-pane') === pane.id);
            });
        }
    };
    // Use xterm onFocus if available (v5+), else fall back to textarea focus
    if (typeof term.onFocus === 'function') {
        term.onFocus(syncFocus);
    } else {
        term.textarea?.addEventListener('focus', syncFocus);
    }

    if (ptyBuffers[pane.tabId]) {
        term.write(ptyBuffers[pane.tabId]);
        delete ptyBuffers[pane.tabId];
    }

    if (TabManager.activeId === tab.id && pane.focused) {
        setTimeout(() => term.focus(), 150);
    }
}

// ── Terminal search ──
function _getActiveSearchAddon() {
    const tab = TabManager.getActive();
    if (!tab || tab.type === 'settings') return null;
    if (tab.splitRoot) {
        const focused = getAllPanes(tab).find(p => p.focused);
        return focused?._searchAddon || null;
    }
    return tab._searchAddon || null;
}
function openSearch() {
    const bar = document.getElementById('search-bar');
    bar.classList.add('open');
    document.getElementById('search-input').value = '';
    document.getElementById('search-count').textContent = '';
    setTimeout(() => document.getElementById('search-input').focus(), 50);
}
function closeSearch() {
    document.getElementById('search-bar').classList.remove('open');
    const addon = _getActiveSearchAddon();
    if (addon) { try { addon.clearDecorations(); } catch(e) {} }
    const tab = TabManager.getActive();
    if (tab && tab.term) setTimeout(() => tab.term.focus(), 50);
    else if (tab && tab.splitRoot) {
        const f = getAllPanes(tab).find(p => p.focused);
        if (f && f.term) setTimeout(() => f.term.focus(), 50);
    }
}
function doSearch() {
    const input = document.getElementById('search-input');
    const query = input.value;
    const addon = _getActiveSearchAddon();
    if (!addon || !query) { try { addon?.clearDecorations(); } catch(e) {} return; }
    addon.findNext(query);
}
function searchNext() {
    const addon = _getActiveSearchAddon();
    const query = document.getElementById('search-input').value;
    if (!addon || !query) return;
    addon.findNext(query);
}
function searchPrev() {
    const addon = _getActiveSearchAddon();
    const query = document.getElementById('search-input').value;
    if (!addon || !query) return;
    addon.findPrevious(query, { caseSensitive: false, regex: false });
}
function onSearchKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
    if (e.key === 'Escape') { closeSearch(); }
}

