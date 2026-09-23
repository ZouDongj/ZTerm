// ZTerm - terminal creation/wiring/search/sync-input (extracted verbatim from renderer.html, logic unchanged)
// Rendering engine: xterm.js + WebGL (the experimental libghostty WASM engine has been removed)

// ── Shared: fit terminal + preserve scroll-to-bottom ──
function _fitWithScroll(term, fitAddon, parentEl) {
    if (!term || !fitAddon || !parentEl) return;
    if (parentEl.clientWidth === 0 || parentEl.clientHeight === 0) return;
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

// Size settlement after the layout animation (200ms) ends:
// onResize is suppressed for 300ms after _layoutTime (two places in terminal.js), so the
// animation's final size falls inside the suppression window and is dropped, leaving the
// backend stuck at the old size (nvim UI garbled after splitting). Re-fit and explicitly
// report the size once after 320ms.
function _scheduleSettleResize(tab) {
    clearTimeout(tab._resizeSettleTimer);
    tab._resizeSettleTimer = setTimeout(() => {
        if (tab.splitRoot) {
            getAllPanes(tab).forEach(p => {
                if (p.term && p.fitAddon) {
                    const body = document.getElementById('pane-body_' + p.id);
                    // Zero size (pane of a hidden tab): neither fit nor send — otherwise the initial 80x24 would be wrongly pushed to the backend
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
            // _windowResizing: suppress fit while the window is being drag-resized;
            // after the drag stops, split.js's resize settlement fits everything
            // at once (avoids the jitter of a full-viewport repaint every frame)
            if (!_spannerDrag && !TabManager._maximizing && !_windowResizing) _fitWithScroll(tab.term, tab.fitAddon, inner);
            rafPending = false;
        });
    });
    ro.observe(wrap);
    wrap._resizeObserver = ro;
}

// WebGL-layer smooth cursor (flterm parity: 90ms easeOutCubic, >8-cell jump).
// Wraps the adapter so settings hot-reload keeps the overlay-era interface
// (setOptions/dispose). The Motion class comes from smooth-cursor-overlay.js.
// Falls back to the bare native caret if the adapter cannot bind to this
// xterm build's renderer internals.
function _wireSmoothCursorWebgl(term, webglAddon) {
    if (!webglAddon) return null;
    let adapter = null;
    let retired = false; // disposed on purpose (underline fallback / context loss)
    const create = () => createXtermWebglSmoothCursor({
        terminal: term,
        addon: webglAddon,
        duration: 90,
        jumpDistance: 8,
        cursorStyle: term.options.cursorStyle === 'block' ? 'block' : 'bar',
        // Narrow scope: continuation frames re-render only the rows the caret
        // spans (1-2) instead of the whole viewport. 'full' multiplied every
        // animation frame by a full-viewport WebGL pass — on content-heavy
        // TUIs (ink input boxes redraw ~15KB/keystroke) that stacked dozens
        // of full-screen passes per key and read as severe jank.
        renderScope: 'cursor',
    });
    try {
        adapter = create();
    } catch (e) {
        console.warn('WebGL smooth cursor unavailable, using native caret:', e);
        return null;
    }
    // Context loss would leave the adapter's hooks pointing at dead renderer
    // internals and throw on every frame; retire it and let the native caret
    // take over instead.
    webglAddon.onContextLoss?.(() => {
        retired = true;
        try { adapter?.dispose(); } catch (e) {}
        adapter = null;
        wrapper._adapter = null;
    });
    const wrapper = {
        _adapter: adapter, // exposed for e2e diagnostics
        setOptions(opts) {
            if (!opts) return;
            if ('animations' in opts) {
                // The adapter recomputes motion.duration every render pass;
                // only setSmooth() flips its internal smoothing switch.
                adapter?.setSmooth(opts.animations !== false);
            }
            if ('cursorBlink' in opts) term.options.cursorBlink = opts.cursorBlink === true;
            if ('cursorStyle' in opts) {
                const style = opts.cursorStyle || 'bar';
                term.options.cursorStyle = style;
                if (style === 'underline') {
                    // The adapter can only draw bar/block; the native caret
                    // must render underline, so retire the adapter.
                    if (adapter) {
                        retired = true;
                        try { adapter.dispose(); } catch (e) {}
                        adapter = null;
                    }
                } else if (adapter) {
                    try { adapter.setCursorStyle(style); } catch (e) {}
                } else if (retired) {
                    // Switching back from underline: rebuild the adapter.
                    try {
                        adapter = create();
                        retired = false;
                        adapter.setSmooth(_settingsConfig.animations !== false);
                    } catch (e) { adapter = null; }
                }
                wrapper._adapter = adapter;
            }
        },
        dispose() {
            if (adapter) { try { adapter.dispose(); } catch (e) {} adapter = null; }
            wrapper._adapter = null;
        },
    };
    // The persisted animations setting wins over the adapter's smooth-on
    // default, so toggling works in both directions without a restart.
    if (_settingsConfig.animations === false) adapter.setSmooth(false);
    return wrapper;
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
        c.fontFamily || '"JetBrainsMonoNL NF", "HarmonyOS Sans SC", monospace',
        c.fallbackFont
    );
    const accentColor = _getAccentColor();
    const terminalTheme = getTerminalTheme();
    // Rendering defaults follow the user's Tabby terminal: same extracted
    // bundles, JetBrainsMonoNL NF 16px, weight 400/600, Tabby's linePadding=1
    // (=> lineHeight 1.125, cell height 23px) and allowTransparency=true,
    // which switches the glyph atlas to an alpha canvas and therefore to
    // grayscale anti-aliasing (Tabby does not use LCD subpixel AA; confirmed
    // by pixel-level A/B comparison).
    return {
        cursorBlink: c.cursorBlink === true,
        cursorStyle: c.cursor || 'bar',
        fontSize: c.fontSize || 16,
        fontFamily: fontFamily,
        fontWeight: _clampFontWeight(c.fontWeight, '400'),
        fontWeightBold: _clampFontWeight(c.fontWeightBold, '600'),
        lineHeight: c.lineHeight || 1.125,
        allowTransparency: true,
        scrollback: c.scrollback || 10000,
        minimumContrastRatio: c.minimumContrastRatio || 4,
        drawBoldTextInBrightColors: false,
        // The WebGL smooth-cursor adapter animates the real xterm caret, so
        // the theme caret color must stay visible (the overlay-era
        // transparent-cursor hack would render the animated caret invisible).
        theme: { ...terminalTheme, cursor: terminalTheme.cursor || '#ffffff' },
        allowProposedApi: true,
        customGlyphs: true,
        overviewRuler: { width: 6 },
    };
}

// OSC 8 hyperlinks: same unified entry as plain links, replacing the vendored
// default (confirm() + window.open, which wry swallows). Assigned after
// construction because the activate closure needs the term for the TUI-mode
// consumption gate; OscLinkProvider reads options.linkHandler lazily at
// provideLinks time, so setting it before term.open() still replaces the
// default from birth.
function _installLinkHandler(term) {
    term.options.linkHandler = {
        activate: (event, uri) => LinkOpen.handleLinkActivate(event, uri, { osc8: true, term }),
        hover: (event, uri) => LinkOpen.showLinkTip(event, uri),
        leave: () => LinkOpen.hideLinkTip(),
    };
}

// ── OSC 52 clipboard provider ──
// Tauri: goes through a Rust command (system clipboard, not subject to WebView2's
// user-gesture restriction — OSC 52 is triggered by terminal output, and
// navigator.clipboard throws NotAllowedError outside a gesture)
// Electron: goes through the native clipboard (synchronous, wrapped in a Promise to match the addon interface)
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

// Shortcut passthrough handler (single entry point): Ctrl+P (command palette) and
// Ctrl+Shift+P (quick commands) are handed to shortcuts.js for dispatch.
// xterm semantics: returning false stops processing (true continues).
function _shortcutPassthrough(term, e) {
    const isShortcut =
        (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'p') ||
        (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'P' || e.key === 'p'));
    return !isShortcut;
}

// Ctrl+J over win32-input-mode (local ConPTY sessions only). The legacy byte
// path makes OpenConsole rewrite LF into a Ctrl+Enter INPUT_RECORD, so
// event-level stdin readers (crossterm, kimi) never see Ctrl+J; serializing
// the key as a full INPUT_RECORD (what Windows Terminal emits) delivers it
// intact. Returns true when the event was handled (swallow it), false to
// let xterm process it normally. keyup/keypress are swallowed without a
// resend — only keydown serializes.
//
// The owner is resolved at EVENT TIME by terminal identity: split/drag
// migration moves a term between tab and pane wrappers, and a handler closed
// over the original pair keeps targeting the stale wrapper — whose tabId was
// nulled by the move, so the key was handled yet sent nowhere (swallowed).
// The gate is keyed by backend session id (win32-input.js gatedSessions) for
// the same reason: the id is the only handle that travels with the session.
function _resolveTermOwner(term) {
    if (typeof TabManager === 'undefined' || !TabManager?.tabs) return null;
    for (const tab of TabManager.tabs) {
        if (tab.term === term) return { tab, owner: tab };
        if (tab.splitRoot && typeof getAllPanes === 'function') {
            const pane = getAllPanes(tab).find(p => p.term === term);
            if (pane) return { tab, owner: pane };
        }
    }
    return null;
}

function _tryWin32CtrlJ(term, e) {
    const w32 = typeof window !== 'undefined' ? window.__win32Input : null;
    if (!w32 || !term || !w32.isCtrlJ(e)) return false;
    const resolved = _resolveTermOwner(term);
    if (!resolved) return false;
    const { tab, owner } = resolved;
    if (!owner.tabId || !w32.isGated?.(owner.tabId)) return false;
    // sync-input broadcasts to every pane of the tab — including SSH panes,
    // which must never receive win32 INPUT_RECORD bytes. Use the win32 path
    // only when every recipient's session is gated.
    if (tab.syncInput && tab.splitRoot) {
        const panes = typeof getAllPanes === 'function' ? getAllPanes(tab) : [];
        if (!panes.length || !panes.every(p => p.tabId && w32.isGated(p.tabId))) return false;
    }
    // We own the key from here. Suppress the browser default: WebView2 maps
    // Ctrl+J to its downloads flyout (browser accelerator keys are on the
    // default-action path, so preventDefault suppresses them).
    e.preventDefault?.();
    if (e.type !== 'keydown') return true;
    _sendPaneInput(tab, owner, w32.ctrlJSequence());
    // xterm's swallowed path would also scroll-on-input and re-show the
    // cursor; mirror the part the user can notice.
    owner.term?.scrollToBottom?.();
    return true;
}

// Per-terminal behavior installs: the zterm6 width provider (plane-1 emoji
// are 2 cells, matching what modern TUIs assume — the vendored UnicodeV6
// says 1, which breaks their CUP-based layouts) and the IME caret anchor
// guard (while the protocol cursor is hidden, the IME anchor follows the
// smooth-cursor adapter's perceived caret — the app-drawn caret the user
// actually sees — and falls back to stock protocol anchoring when no caret
// is known, which tracks the insertion point during input phases). Both
// live in our own modules loaded via renderer.html; failures are loud but
// must not break terminal creation. perceivedCaret is looked up lazily
// because the smooth-cursor adapter is only created after term.open().
function _installTerminalBehavior(term, perceivedCaret) {
    try { window.__unicodeWidth?.installOn(term); } catch(e) { console.warn('unicode width install failed:', e); }
    try { window.__imeCaretAnchor?.patchTerminal(term, { perceivedCaret }); } catch(e) { console.warn('IME anchor patch failed:', e); }
}

// ── Terminal wiring (shared by PTY and SSH) ──
function wireTerminal(tab, tabId) {
    tab.tabId = tabId;

    const { wrap, inner } = createTermWrap(tab);
    // Self-heal duplicate wraps: an SSH retry disposes the xterm but can leave
    // the previous wrap mounted. Two elements sharing 'wrap_<id>' break
    // switchTo()'s getElementById (first match wins), and a retry-created wrap
    // keeps its 'active' class forever — a full-viewport absolute layer that
    // covers every tab (the restore "all tabs show one session" bug). Drop
    // any survivor before mounting the new one.
    document.getElementById('wrap_' + tab.id)?.remove();
    document.getElementById('main-area').appendChild(wrap);

    const term = new Terminal(_buildTerminalOptions());
    _installLinkHandler(term);
    _installTerminalBehavior(term, () => tab._smoothCursor?._adapter?.perceivedCaretCell?.() ?? null);
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon(term)); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    tab._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(inner);
    term.attachCustomKeyEventHandler(e => {
        if (_tryWin32CtrlJ(term, e)) return false;
        return _shortcutPassthrough(term, e);
    });
    // The WebGL addon must load AFTER open(): loading it before open loses the
    // render-service registration race to the DOM renderer, silently falling
    // back to DOM rendering (verified: no .xterm-webgl canvas, adapter idle).
    let webglAddon = null;
    try { webglAddon = new WebglAddon(); term.loadAddon(webglAddon); } catch(e) { console.warn('WebglAddon init failed:', e); }
    tab.term = term;
    tab.fitAddon = fitAddon;
    tab._smoothCursor = _wireSmoothCursorWebgl(term, webglAddon);

    function applyFit() {
        if (_spannerDrag || TabManager._maximizing) return;
        _fitWithScroll(tab.term, fitAddon, inner);
    }

    // First fit: wait for DOM layout to settle; later size changes are covered by setupWrapResizeObserver
    setTimeout(applyFit, 50);

    setupWrapResizeObserver(wrap, tab);

    let _resizeDebounce = null;
    term.onResize(({ cols, rows }) => {
        if (TabManager._maximizing) return;
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            // Read tab.tabId dynamically: the backend tabId changes after a reconnect, and a closure-captured stale value would be sent to a dead connection
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
        // Read tab.tabId dynamically (in reconnect-with-content-preserved mode the terminal is reused but the backend tabId has been updated)
        _sendPaneInput(tab, { tabId: tab.tabId }, data);
    });
    _wireOscTitleFollow(term);
    _bindSyncExitOnClick(tab, term.element);

    // ── Bell notification ──
    term.onBell(() => {
        const bell = _settingsConfig.bell || 'off';
        if (bell === 'off') return;
        if (bell !== 'flash') showToast((tab.name || '终端') + ' 响铃');
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
    // Electron's clipboard.readText() is synchronous; Tauri (WebView2) only has the async
    // Clipboard API, read via the readTextAsync branch — both share the same logic
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

// Split-pane sync input: when syncInput is on, input is broadcast to every pane of the tab
function _sendPaneInput(tab, pane, data) {
    if (tab.syncInput && tab.splitRoot) {
        getAllPanes(tab).forEach(p => {
            if (p.tabId) ipcRenderer.send('pty-input', { tabId: p.tabId, data });
        });
    } else if (pane.tabId) {
        ipcRenderer.send('pty-input', { tabId: pane.tabId, data });
    }
}

// OSC 0/2 window title → tab name (issue #10). The owner is resolved at
// EVENT TIME by terminal identity: split/unsplit/extract/drag migrations move
// a term between tab and pane wrappers without re-wiring this hook, so a
// closure over the original tab/pane pair would keep writing the stale
// wrapper (and `_updateTabName` reads `_oscTitle` from whichever slot the
// term is owned by NOW — tab for single-terminal tabs, pane for splits).
function _wireOscTitleFollow(term) {
    term.onTitleChange(title => {
        const resolved = _resolveTermOwner(term);
        if (resolved) _applyOscTitle(resolved.tab, resolved.owner, title);
    });
}

// The title is stored on the pane (or on the tab itself for single-terminal
// tabs) so _updateTabName can rank it above the profile/default name; a
// manual rename (_customName) still wins and leaves the tab untouched. An
// empty title is treated as "no information", not as a reset request.
function _applyOscTitle(ownerTab, paneLike, title) {
    const t = (title || '').trim();
    if (!t || !ownerTab || paneLike._oscTitle === t) return;
    paneLike._oscTitle = t;
    const oldName = ownerTab.name;
    TabManager._updateTabName(ownerTab);
    if (ownerTab.name !== oldName) {
        TabManager.render();
        if (TabManager.activeId === ownerTab.id) TabManager.updateStatus();
    }
}

// While sync input is on, clicking any pane (including the focused one) exits it.
// The owning tab is looked up dynamically: term.element's DOM position changes after a
// move (drag-split), so resolve .split-pane[data-pane] back to its pane and then its tab,
// avoiding a closure over the stale tab that would break the exit.
function _bindSyncExitOnClick(tab, element) {
    if (!element || element._syncExitBound) return;
    element._syncExitBound = true;
    element.addEventListener('mousedown', () => {
        // Dynamic reverse lookup: term.element's ancestor .split-pane[data-pane] gives the
        // pane.id, then TabManager.tabs yields the owning tab (automatically points at the
        // new tab after a move)
        const paneEl = element.closest('.split-pane');
        let ownerTab = tab; // fallback: non-split (single tab) uses the captured tab directly
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

    const term = new Terminal(_buildTerminalOptions());
    _installLinkHandler(term);
    _installTerminalBehavior(term, () => pane._smoothCursor?._adapter?.perceivedCaretCell?.() ?? null);
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon(term)); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    pane._searchAddon = searchAddon;
    searchAddon.onDidChangeResults(r => {
        document.getElementById('search-count').textContent = r?.resultCount ? `${r.resultIndex+1}/${r.resultCount}` : '';
    });

    term.open(bodyEl);
    term.attachCustomKeyEventHandler(e => {
        if (_tryWin32CtrlJ(term, e)) return false;
        return _shortcutPassthrough(term, e);
    });
    // WebGL addon loads after open() — see wireTerminal for the race details.
    let webglAddon = null;
    try { webglAddon = new WebglAddon(); term.loadAddon(webglAddon); } catch(e) { console.warn('WebglAddon init failed:', e); }
    pane.term = term;
    pane.fitAddon = fitAddon;
    pane._smoothCursor = _wireSmoothCursorWebgl(term, webglAddon);

    function applyFit(retries = 10) {
        if (_spannerDrag || TabManager._maximizing) return;
        if (retries <= 0) return;
        if (bodyEl.clientWidth === 0 || bodyEl.clientHeight === 0) {
            setTimeout(() => applyFit(retries - 1), 50);
            return;
        }
        _fitWithScroll(pane.term, fitAddon, bodyEl);
        // After the initial fit, explicitly send the final size directly: the first fit's
        // onResize may fall inside the _layoutTime suppression window and be dropped, and
        // a later fit with unchanged size never fires onResize again — the backend would
        // stay at 80x24 forever (nvim UI garbled)
        const suppressed = TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300;
        if (pane.tabId && pane.term.cols && pane.term.rows && !suppressed) {
            ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols: pane.term.cols, rows: pane.term.rows });
        }
    }

    // Wait for the CSS transition (200ms) to finish before the initial fit, to avoid measuring an intermediate size
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
        // Intermediate sizes during the split layout animation (200ms) are not sent; send once the animation has settled
        if (TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300) return;
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => {
            ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols, rows });
        }, 150);
    });

    pane._onDataDisp = term.onData(data => {
        _sendPaneInput(tab, pane, data);
    });
    _wireOscTitleFollow(term);
    _bindSyncExitOnClick(tab, term.element);

    // ── Bell notification ──
    term.onBell(() => {
        const bell = _settingsConfig.bell || 'off';
        if (bell === 'off') return;
        if (bell !== 'flash') showToast((tab.name || '终端') + ' 响铃');
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
    // Same as above: Tauri reads via async readTextAsync, Electron via synchronous readText
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
    // After wiring is complete, schedule one more size-settlement fallback (covers cases where onResize was suppressed or the size never changed)
    if (tab.splitRoot) _scheduleSettleResize(tab);
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

