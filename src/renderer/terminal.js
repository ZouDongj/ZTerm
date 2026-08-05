// ZTerm - 终端创建/接线/搜索/同步输入（拆自 renderer.html，纯代码搬运，未改逻辑）

// ── 渲染引擎选择：xterm.js（默认）或 Ghostty (libghostty WASM 移植) ──
function _getRendererEngine() {
    return _settingsConfig.terminalRenderer === 'ghostty' ? 'ghostty' : 'xterm';
}
let _ghosttyReady = null;
function _loadGhostty() {
    if (!_ghosttyReady) {
        window.__ghosttyState = 'loading:' + Date.now();
        _ghosttyReady = new Promise((resolve, reject) => {
            // ESM 构建：动态 import（相对 renderer.html 解析），wasm 走 ./ghostty-vt.wasm
            // 相对模块路径由 Tauri asset 协议提供（'self'，CSP 允许）。
            // 注意不能用 UMD 构建：其内嵌 data: URL wasm 会被 Tauri 协议拦截返回 500。
            import('/vendor/ghostty-web.esm.js')
                .then(mod => mod.init().then(() => { window.__ghosttyState = 'resolved'; resolve(); }).catch(e => { window.__ghosttyState = 'init-fail:' + e; reject(e); }))
                .catch(e => { window.__ghosttyState = 'import-fail:' + e; reject(e); });
        });
        // 加载失败后允许重试
        _ghosttyReady.catch(() => { _ghosttyReady = null; });
    }
    return _ghosttyReady;
}
function _buildGhosttyOptions() {
    const c = _settingsConfig;
    return {
        cursorBlink: c.cursorBlink === true,
        cursorStyle: c.cursor || 'bar',
        fontSize: c.fontSize || 13.5,
        fontFamily: _normalizeFontFamily(
            c.fontFamily || '"JetBrains Mono","Cascadia Code",Consolas,monospace',
            c.fallbackFont
        ),
        scrollback: c.scrollback || 10000,
        theme: getTerminalTheme(),
        smoothScrollDuration: 80,
    };
}
// Ghostty 引擎搜索 shim（xterm SearchAddon 接口兼容）：
// 基于 scrollback 逐行扫描 + select/scrollToLine 定位，未命中返回空
function _createGhosttySearch(term) {
    const listeners = [];
    let count = 0, idx = 0;
    const notify = () => listeners.forEach(fn => { try { fn({ resultCount: count, resultIndex: count ? idx : 0 }); } catch(e) {} });
    const cellsToText = (cells) => {
        let s = '';
        for (const cell of cells || []) {
            if (cell.codepoint) s += String.fromCodePoint(cell.codepoint);
        }
        return s;
    };
    const find = (q, backwards) => {
        count = 0; idx = 0;
        if (!q || !term.wasmTerm) { notify(); return; }
        const total = term.getScrollbackLength();
        const rows = term.rows || 24;
        const ql = q.toLowerCase();
        const matches = [];
        // 回滚区：getScrollbackLine(i)，绝对行号 = i
        for (let i = 0; i < total; i++) {
            const cells = term.getScrollbackLine(i);
            if (!cells) continue;
            const text = cellsToText(cells).toLowerCase();
            let from = 0;
            for (;;) {
                const at = text.indexOf(ql, from);
                if (at < 0) break;
                matches.push({ line: i, col: at });
                from = at + 1;
            }
        }
        // 屏幕区：wasmTerm.getLine(row)，绝对行号 = total + row
        for (let r = 0; r < rows; r++) {
            const cells = term.wasmTerm.getLine(r);
            if (!cells) continue;
            const text = cellsToText(cells).toLowerCase();
            let from = 0;
            for (;;) {
                const at = text.indexOf(ql, from);
                if (at < 0) break;
                matches.push({ line: total + r, col: at });
                from = at + 1;
            }
        }
        count = matches.length;
        if (!count) { notify(); return; }
        const m = backwards ? matches[matches.length - 1] : matches[0];
        term.scrollToLine(m.line);
        const screenRow = m.line - total;
        if (screenRow >= 0 && screenRow < rows) term.select(m.col, screenRow, q.length);
        notify();
    };
    return {
        onDidChangeResults: fn => listeners.push(fn),
        findNext: q => find(q, false),
        findPrevious: q => find(q, true),
        clearDecorations: () => { count = 0; idx = 0; notify(); },
    };
}

// ── Shared: fit terminal + preserve scroll-to-bottom ──
function _fitWithScroll(term, fitAddon, parentEl) {
    if (!term || !fitAddon || !parentEl) return;
    if (parentEl.clientWidth === 0 || parentEl.clientHeight === 0) return;
    if (term.wasmTerm) {
        // Ghostty 引擎：无 .xterm-viewport，底部判定用 viewportY（0 = 底部）
        const wasAtBottom = term.viewportY < 1;
        fitAddon.fit();
        if (wasAtBottom) {
            requestAnimationFrame(() => { try { term.scrollToBottom(); } catch(e) {} });
        }
        return;
    }
    const vp = parentEl.querySelector('.xterm-viewport');
    const dist = vp ? (vp.scrollHeight - vp.scrollTop - vp.clientHeight) : 0;
    const rowH = vp && term.rows ? (vp.clientHeight / term.rows) : 20;
    const wasAtBottom = dist < rowH;
    fitAddon.fit();
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
                    const body = document.getElementById('pane-body_' + p.id);
                    // 0 尺寸（隐藏 tab 的 pane）不 fit 也不发——否则会把初始 80x24 错误地下发给后端
                    if (!body || body.clientWidth === 0 || body.clientHeight === 0) return;
                    _fitWithScroll(p.term, p.fitAddon, body);
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
            // _windowResizing：窗口拖拽 resize 期间抑制 fit，停止后由
            // split.js 的 resize 结算统一 fit（避免每帧全屏重绘导致抖动）
            if (!_spannerDrag && !TabManager._maximizing && !_windowResizing) _fitWithScroll(tab.term, tab.fitAddon, inner);
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

// ── OSC 52 clipboard provider ──
// Tauri: 走 Rust 命令（系统剪贴板，不受 WebView2 用户手势限制 —— OSC 52 由
// 终端输出触发，navigator.clipboard 在非手势下会抛 NotAllowedError）
// Electron: 走 native clipboard（同步，包装成 Promise 以匹配 addon 接口）
function _createClipboardAddon() {
    const isTauri = !!(window.__TAURI__ && window.__TAURI__.event);
    const provider = {
        readText: (clipboard) => {
            if (clipboard !== 'c') return Promise.resolve('');
            if (isTauri) return ipcRenderer.invoke('clipboard-read-text').catch(() => '');
            return Promise.resolve(require('electron').clipboard.readText());
        },
        writeText: (clipboard, text) => {
            if (clipboard !== 'c') return Promise.resolve();
            if (isTauri) return ipcRenderer.invoke('clipboard-write-text', { text }).catch(() => {});
            require('electron').clipboard.writeText(text);
            return Promise.resolve();
        },
    };
    return new ClipboardAddon(undefined, provider);
}

// 快捷键放行处理器（统一入口）：Ctrl+P（命令面板）/ Ctrl+Shift+P（快捷命令）交给 shortcuts.js 调度。
// 注意两引擎语义相反：xterm 返回 false 停止处理（true 继续）；ghostty 返回 true 阻止处理（false 继续）。
// 按 term.wasmTerm 区分引擎（回退到 xterm 时同样适用）
function _shortcutPassthrough(term, e) {
    const isShortcut =
        (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'p') ||
        (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'P' || e.key === 'p'));
    return term.wasmTerm ? isShortcut : !isShortcut;
}

// ── Terminal wiring (shared by PTY and SSH) ──
function wireTerminal(tab, tabId) {
    tab.tabId = tabId;

    const { wrap, inner } = createTermWrap(tab);
    document.getElementById('main-area').appendChild(wrap);

    if (_getRendererEngine() === 'ghostty') {
        _wireGhosttyTerminal(tab, tabId, wrap, inner);
        return;
    }

    const term = new Terminal(_buildTerminalOptions());
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { term.loadAddon(new WebglAddon()); } catch(e) { console.warn('WebglAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon()); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    tab._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(inner);
    term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
    tab.term = term;
    tab.fitAddon = fitAddon;

    function applyFit() {
        if (_spannerDrag || TabManager._maximizing) return;
        _fitWithScroll(tab.term, fitAddon, inner);
    }

    // 首次 fit：等 DOM 布局完成；后续尺寸变化由 setupWrapResizeObserver 覆盖
    setTimeout(applyFit, 50);

    setupWrapResizeObserver(wrap, tab);

    let _resizeDebounce = null;
    term.onResize(({ cols, rows }) => {
        if (TabManager._maximizing) return;
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            // 动态读取 tab.tabId：重连后后端 tabId 会变化，闭包捕获旧值会发到死连接
            if (tab.tabId) ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols, rows });
        }, 150);
    });

    // Fallback resize after 1s — covers slow-starting shells that missed the initial resize
    setTimeout(() => {
        if (tab.term && tab.term.cols && tab.term.rows && tab.tabId) {
            ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols: tab.term.cols, rows: tab.term.rows });
        }
    }, 1000);

    tab._onDataDisp = term.onData(data => {
        // 动态读取 tab.tabId（重连保留内容模式下，终端复用但后端 tabId 已更新）
        _sendPaneInput(tab, { tabId: tab.tabId }, data);
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
    // Electron 的 clipboard.readText() 是同步的; Tauri(WebView2) 只有异步 Clipboard API,
    // 通过 readTextAsync 分支读取, 两者共用同一段逻辑
    term.element.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        try {
            const clipboard = require('electron').clipboard;
            const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
            if (text) _sendPaneInput(tab, { tabId: tab.tabId }, text);
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

// ── Ghostty 引擎接线（单 tab）：镜像 wireTerminal 的行为 ──
function _wireGhosttyTerminal(tab, tabId, wrap, inner) {
    _loadGhostty().then(async () => {
        if (!TabManager.tabs.includes(tab)) return; // 加载期间 tab 已关闭
        const gw = await import('/vendor/ghostty-web.esm.js');
        const term = new gw.Terminal(_buildGhosttyOptions());
        let fitAddon;
        try { fitAddon = new gw.FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('Ghostty FitAddon init failed:', e); }
        const searchAddon = _createGhosttySearch(term);
        try { term.registerLinkProvider(new gw.UrlRegexProvider(term)); } catch(e) { console.warn('UrlRegexProvider init failed:', e); }

        term.open(inner);
        term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
        tab.term = term;
        tab.fitAddon = fitAddon;
        tab._searchAddon = searchAddon;
        searchAddon.onDidChangeResults(r => {
            document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
        });

        function applyFit() {
            if (_spannerDrag || TabManager._maximizing) return;
            _fitWithScroll(tab.term, fitAddon, inner);
        }
        setTimeout(applyFit, 50);
        setupWrapResizeObserver(wrap, tab);

        let _resizeDebounce = null;
        term.onResize(({ cols, rows }) => {
            if (TabManager._maximizing) return;
            if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
            clearTimeout(_resizeDebounce);
            _resizeDebounce = setTimeout(() => {
                if (tab.tabId) ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols, rows });
            }, 150);
        });

        setTimeout(() => {
            if (tab.term && tab.term.cols && tab.term.rows && tab.tabId) {
                ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols: tab.term.cols, rows: tab.term.rows });
            }
        }, 1000);

        tab._onDataDisp = term.onData(data => {
            _sendPaneInput(tab, { tabId: tab.tabId }, data);
        });
        _bindSyncExitOnClick(tab, term.element);

        term.onBell(() => {
            const bell = _settingsConfig.bell || 'off';
            if (bell === 'off') return;
            if (bell !== 'flash') showToast('🔔 ' + (tab.name || '终端') + ' 响铃');
            if (bell === 'flash' || bell === 'notification+flash') {
                const tabEl = document.querySelector(`.tab[data-tab="${tab.id}"]`);
                if (tabEl) { tabEl.classList.add('bell-flash'); setTimeout(() => tabEl.classList.remove('bell-flash'), 2000); }
            }
        });

        // 选中复制：Ghostty 引擎自带 mouseup 复制（含双击选词），此处不再重复复制；
        // 富文本/智能换行等仅 xterm 生效
        term.onSelectionChange(() => {
            if (_settingsConfig.autoCopy === false) return;
            const sel = term.getSelection();
            if (sel) {
                try {
                    const clipboard = require('electron').clipboard;
                    clipboard.writeText(sel);
                } catch(e) {}
            }
        });

        // 右键粘贴
        term.element.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            if (_settingsConfig.rightClickPaste === false) return;
            try {
                const clipboard = require('electron').clipboard;
                const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
                if (text) _sendPaneInput(tab, { tabId: tab.tabId }, text);
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
    }).catch(err => { window.__ghosttyErr = String((err && err.stack) || err);
        console.error('[ghostty] init failed, falling back to xterm:', err);
        // 加载失败回退 xterm
        if (TabManager.tabs.includes(tab)) _wireXtermFallback(tab, tabId, wrap, inner);
    });
}

// Ghostty 初始化失败时的 xterm 回退（重建 xterm 终端，不重复创建 wrap）
function _wireXtermFallback(tab, tabId, wrap, inner) {
    const term = new Terminal(_buildTerminalOptions());
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) {}
    try { term.loadAddon(new WebglAddon()); } catch(e) {}
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) {}
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) {}
    }
    try { term.loadAddon(_createWebLinksAddon()); } catch(e) {}
    tab._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });
    term.open(inner);
    term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
    tab.term = term;
    tab.fitAddon = fitAddon;
    function applyFit() {
        if (_spannerDrag || TabManager._maximizing) return;
        _fitWithScroll(tab.term, fitAddon, inner);
    }
    setTimeout(applyFit, 50);
    setupWrapResizeObserver(wrap, tab);
    let _resizeDebounce = null;
    term.onResize(({ cols, rows }) => {
        if (TabManager._maximizing) return;
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            if (tab.tabId) ipcRenderer.send('pty-resize', { tabId: tab.tabId, cols, rows });
        }, 150);
    });
    tab._onDataDisp = term.onData(data => {
        _sendPaneInput(tab, { tabId: tab.tabId }, data);
    });
    _bindSyncExitOnClick(tab, term.element);
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
// 用动态查找所属 tab：term.element 在搬家（拖拽分屏）后 DOM 位置改变，
// 从 .split-pane[data-pane] 反查所属 pane → 所属 tab，避免闭包捕获旧 tab 导致退出失效
function _bindSyncExitOnClick(tab, element) {
    if (!element || element._syncExitBound) return;
    element._syncExitBound = true;
    element.addEventListener('mousedown', () => {
        // 动态反查：term.element 的祖先 .split-pane[data-pane] 给出 pane.id，
        // 再从 TabManager.tabs 找到所属 tab（搬迁后自动指向新 tab）
        const paneEl = element.closest('.split-pane');
        let ownerTab = tab; // 兜底：非分屏（单 tab）直接用捕获的 tab
        if (paneEl) {
            const paneId = paneEl.getAttribute('data-pane');
            for (const t of TabManager.tabs) {
                if (t.splitRoot && getAllPanes(t).some(p => p.id === paneId)) { ownerTab = t; break; }
            }
        }
        if (!ownerTab.syncInput) return;
        ownerTab.syncInput = false;
        const rootEl = document.getElementById('split_' + ownerTab.id);
        if (rootEl) rootEl.classList.remove('sync-input');
        showToast('同步输入已关闭');
    });
}

function wireTerminalToPane(tab, pane) {
    const bodyEl = document.getElementById('pane-body_' + pane.id);
    if (!bodyEl) return;

    if (_getRendererEngine() === 'ghostty') {
        _wireGhosttyTerminalToPane(tab, pane, bodyEl);
        return;
    }

    const term = new Terminal(_buildTerminalOptions());
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { term.loadAddon(new WebglAddon()); } catch(e) { console.warn('WebglAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon()); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    pane._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(bodyEl);
    term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
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
        // 初始 fit 后显式直发最终尺寸：首次 fit 的 onResize 可能落在 _layoutTime 抑制窗口被丢弃，
        // 之后的 fit 尺寸未变 onResize 不再触发，会导致后端永远停留在 80x24（nvim 界面混乱）
        const suppressed = TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300;
        if (pane.tabId && pane.term.cols && pane.term.rows && !suppressed) {
            ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols: pane.term.cols, rows: pane.term.rows });
        }
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

    pane._onDataDisp = term.onData(data => {
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
    // 同上: Tauri 走异步 readTextAsync, Electron 走同步 readText
    term.element.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        try {
            const clipboard = require('electron').clipboard;
            const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
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
    // 接线完成后再挂一次尺寸结算兜底（覆盖 onResize 被抑制/未变的场景）
    if (tab.splitRoot) _scheduleSettleResize(tab);
}

// ── Ghostty 引擎接线（分屏 pane）：镜像 wireTerminalToPane 的行为 ──
function _wireGhosttyTerminalToPane(tab, pane, bodyEl) {
    _loadGhostty().then(async () => {
        if (!TabManager.tabs.includes(tab) || !findPane(tab, pane.id)) return; // 加载期间 pane 已关闭
        const gw = await import('/vendor/ghostty-web.esm.js');
        const term = new gw.Terminal(_buildGhosttyOptions());
        let fitAddon;
        try { fitAddon = new gw.FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('Ghostty FitAddon init failed:', e); }
        const searchAddon = _createGhosttySearch(term);
        try { term.registerLinkProvider(new gw.UrlRegexProvider(term)); } catch(e) { console.warn('UrlRegexProvider init failed:', e); }

        term.open(bodyEl);
        term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
        pane.term = term;
        pane.fitAddon = fitAddon;
        pane._searchAddon = searchAddon;
        searchAddon.onDidChangeResults(r => {
            document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
        });

        function applyFit(retries = 10) {
            if (_spannerDrag || TabManager._maximizing) return;
            if (retries <= 0) return;
            if (bodyEl.clientWidth === 0 || bodyEl.clientHeight === 0) {
                setTimeout(() => applyFit(retries - 1), 50);
                return;
            }
            _fitWithScroll(pane.term, fitAddon, bodyEl);
            const suppressed = TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300;
            if (pane.tabId && pane.term.cols && pane.term.rows && !suppressed) {
                ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols: pane.term.cols, rows: pane.term.rows });
            }
        }
        setTimeout(() => applyFit(), 300);

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
            if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
            clearTimeout(_resizeDebounce);
            _resizeDebounce = setTimeout(() => {
                ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols, rows });
            }, 150);
        });

        pane._onDataDisp = term.onData(data => {
            _sendPaneInput(tab, pane, data);
        });
        _bindSyncExitOnClick(tab, term.element);

        term.onBell(() => {
            const bell = _settingsConfig.bell || 'off';
            if (bell === 'off') return;
            if (bell !== 'flash') showToast('🔔 ' + (tab.name || '终端') + ' 响铃');
            if (bell === 'flash' || bell === 'notification+flash') {
                const tabEl = document.querySelector(`.tab[data-tab="${tab.id}"]`);
                if (tabEl) { tabEl.classList.add('bell-flash'); setTimeout(() => tabEl.classList.remove('bell-flash'), 2000); }
            }
        });

        // 选中复制：Ghostty 自带 mouseup 复制，这里只做设置开关的兜底（不重复写剪贴板）
        term.onSelectionChange(() => {
            if (_settingsConfig.autoCopy === false) return;
            const sel = term.getSelection();
            if (sel) {
                try {
                    const clipboard = require('electron').clipboard;
                    clipboard.writeText(sel);
                } catch(e) {}
            }
        });

        term.element.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            if (_settingsConfig.rightClickPaste === false) return;
            try {
                const clipboard = require('electron').clipboard;
                const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
                if (text) _sendPaneInput(tab, pane, text);
            } catch(e) {}
        });

        // Pane 焦点视觉同步（ghostty 无 onFocus 事件，用 textarea focus 兜底）
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
        term.textarea?.addEventListener('focus', syncFocus);

        if (ptyBuffers[pane.tabId]) {
            term.write(ptyBuffers[pane.tabId]);
            delete ptyBuffers[pane.tabId];
        }

        if (TabManager.activeId === tab.id && pane.focused) {
            setTimeout(() => term.focus(), 150);
        }
        if (tab.splitRoot) _scheduleSettleResize(tab);
    }).catch(err => { window.__ghosttyErr = String((err && err.stack) || err);
        console.error('[ghostty] init failed, pane fallback to xterm:', err);
        if (TabManager.tabs.includes(tab) && findPane(tab, pane.id)) {
            const term = new Terminal(_buildTerminalOptions());
            let fitAddon, searchAddon;
            try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) {}
            try { term.loadAddon(new WebglAddon()); } catch(e) {}
            try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) {}
            if (_settingsConfig.osc52 !== false) {
                try { term.loadAddon(_createClipboardAddon()); } catch(e) {}
            }
            try { term.loadAddon(_createWebLinksAddon()); } catch(e) {}
            pane._searchAddon = searchAddon;
            searchAddon.onDidChangeResults(r => {
                document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
            });
            term.open(bodyEl);
            term.attachCustomKeyEventHandler(e => { return _shortcutPassthrough(term, e); });
            pane.term = term;
            pane.fitAddon = fitAddon;
            setTimeout(() => applyFitFallback(), 300);
            function applyFitFallback(retries = 10) {
                if (_spannerDrag || TabManager._maximizing) return;
                if (retries <= 0) return;
                if (bodyEl.clientWidth === 0 || bodyEl.clientHeight === 0) { setTimeout(() => applyFitFallback(retries - 1), 50); return; }
                _fitWithScroll(pane.term, fitAddon, bodyEl);
            }
            if (bodyEl._resizeObserver) { bodyEl._resizeObserver.disconnect(); }
            let rafPending = false;
            const observer = new ResizeObserver(() => {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => { applyFitFallback(); rafPending = false; });
            });
            observer.observe(bodyEl);
            bodyEl._resizeObserver = observer;
            let _resizeDebounce = null;
            term.onResize(({ cols, rows }) => {
                if (TabManager._maximizing) return;
                if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
                clearTimeout(_resizeDebounce);
                _resizeDebounce = setTimeout(() => {
                    ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols, rows });
                }, 150);
            });
            pane._onDataDisp = term.onData(data => { _sendPaneInput(tab, pane, data); });
            _bindSyncExitOnClick(tab, term.element);
            term.element.addEventListener('contextmenu', async (e) => {
                e.preventDefault();
                if (_settingsConfig.rightClickPaste === false) return;
                try {
                    const clipboard = require('electron').clipboard;
                    const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
                    if (text) _sendPaneInput(tab, pane, text);
                } catch(e) {}
            });
            if (ptyBuffers[pane.tabId]) {
                term.write(ptyBuffers[pane.tabId]);
                delete ptyBuffers[pane.tabId];
            }
            if (TabManager.activeId === tab.id && pane.focused) {
                setTimeout(() => term.focus(), 150);
            }
            if (tab.splitRoot) _scheduleSettleResize(tab);
        }
    });
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

