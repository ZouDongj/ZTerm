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
        // Closing is committed at initiation: from the moment closeTab marks
        // the tab, its session is dead for routing even though the tab object
        // (with term/backend) stays alive for the exit animation's deferred
        // removal. Skipping it here invalidates every owner-resolved consumer
        // (keyboard input, resize debounces, right-click paste) immediately,
        // without touching the animation or its timers.
        if (TabManager._closingTabs && TabManager._closingTabs.has(tab.id)) continue;
        if (tab.term === term) return { tab, owner: tab };
        if (tab.splitRoot && typeof getAllPanes === 'function') {
            const pane = getAllPanes(tab).find(p => p.term === term);
            if (pane) return { tab, owner: pane };
        }
    }
    return null;
}

// IME caret anchor provider: the smooth-cursor wrapper follows the terminal
// across migrations (split/extract/drag move it between the tab and pane
// slots), so the provider must read the CURRENT owner's wrapper at call
// time. A closure over the wrapper it was wired for keeps reading the old
// owner's cleared slot after the move — IME anchoring would silently fall
// back to the protocol cursor for the rest of the session. An unresolvable
// owner (mid-teardown) yields null, which anchors to the protocol cursor.
function _perceivedCaretProvider(term) {
    return () => {
        const resolved = _resolveTermOwner(term);
        return resolved?.owner?._smoothCursor?._adapter?.perceivedCaretCell?.() ?? null;
    };
}

// Right-click paste, shared by tab- and pane-wired terminals. The target is
// re-resolved after the async clipboard read (the terminal may have migrated
// to another wrapper mid-read), and validated against the backend id captured
// BEFORE the read: a same-session migration is allowed, while a close or a
// reconnect that swapped the backend generation drops the stale paste instead
// of delivering it to whatever session now owns the terminal. A source session
// KNOWN to have failed/disconnected (ssh error/drop or local process exit —
// see the _sessionFailed markers in ipc.js) cancels the paste even when its
// old backend id remains: with sync input on, delivering it would broadcast
// into the still-healthy siblings of the current tab.
async function _pasteFromClipboardInto(term) {
    const startBackend = _resolveTermOwner(term)?.owner?.tabId ?? null;
    try {
        const clipboard = require('electron').clipboard;
        const text = clipboard.readTextAsync ? await clipboard.readTextAsync() : clipboard.readText();
        if (!text) return;
        const resolved = _resolveTermOwner(term);
        if (!resolved) return;
        if ((resolved.owner.tabId ?? null) !== startBackend) return;
        if (resolved.owner._sessionFailed === true) return;
        _sendPaneInput(resolved.tab, resolved.owner, text);
    } catch(e) {}
}

// Input routing for a terminal whose owning wrapper may have changed since the
// listener was registered (split/extract/drag migration): resolve the owner at
// SEND time. An unresolvable term (mid-teardown) sends nowhere instead of into
// a stale wrapper's session; sync-input broadcast follows the CURRENT tab, so
// no input leaks to pre-migration siblings.
function _sendInputForTerm(term, data) {
    const resolved = _resolveTermOwner(term);
    if (!resolved) return;
    _sendPaneInput(resolved.tab, resolved.owner, data);
}

// Resize routing with the same event-time owner resolution: a debounce that
// fires after a migration must address the terminal's CURRENT backend, and a
// wrapper whose backend id is still pending sends nothing.
function _sendResizeForTerm(term, cols, rows) {
    const resolved = _resolveTermOwner(term);
    if (!resolved) return;
    const owner = resolved.owner;
    if (owner && owner.tabId && cols && rows) {
        ipcRenderer.send('pty-resize', { tabId: owner.tabId, cols, rows });
    }
}

// ── Delayed terminal focus (fire-time validation) ──
// Terminals are focused through timers all over the tab/pane lifecycle
// (switchTo, _focusPane, the pane-close survivor, _maximizePane, migrations,
// terminal wiring). The callback runs tens to hundreds of milliseconds after
// scheduling, and inside that window the world moves: panes close (their term
// slot is nulled and the xterm disposed at close initiation), tabs close or
// switch away, panes are extracted/dragged to other owners, and the user can
// focus the search input or an overlay. A scheduling-time guard sees none of
// that, so every delayed focus re-validates at FIRE time:
// 1. resolve the term's CURRENT owner — a closed pane/tab, a terminal on a
//    closing tab or a detached term resolves to none: no focus, no deref;
// 2. the owner's tab must still be the ACTIVE tab;
// 3. in a split, the owner pane must still be the FOCUSED pane — the latest
//    explicit focus target stays authoritative;
// 4. the overlay/form-intent rule below, which depends on WHY the focus was
//    scheduled. Two modes (user focus intent is relative to the ORIGINAL
//    user operation, not to the moment a delayed completion schedules its
//    own timer):
//    - EXPLICIT activation (pane click, tab switch, close/maximize/move):
//      an open overlay (the existing .overlay.open keyboard policy) or a
//      form field (search input, rename field, palette input) that took
//      focus AFTER the activation is newer intent and blocks. A form field
//      that ALREADY held focus at activation does not — the real DOM moves
//      focus into .xterm at mousedown, so a pane click with the search bar
//      open still focuses the clicked terminal.
//    - PASSIVE completion (backend-ready wiring of a fresh terminal, refit,
//      deferred close/collapse machinery): no user activation stands behind
//      the timer — a LIVE form field holding focus at fire time is the
//      user's current state and must survive, even if it was focused before
//      the completion scheduled its timer (the user's original close/split
//      action predates their search/form entry).
//    An element inside .xterm is the terminal's own helper textarea and
//    never blocks.
// Validation gates FOCUS only: callbacks that also fit/resize keep doing
// that work — a skipped stale focus must not suppress required layout.
// A focused form field is LIVE user intent only while its surface is
// actually visible. The one hidden-focus quirk in this app: closeSearch
// leaves the now-invisible search input holding focus; while the bar is
// closed that focus is not live intent (its user dismissed it, and
// closeSearch's own fire-time callback owns the terminal refocus).
function _formFocusIsLive(el) {
    if (el && el.id === 'search-input') {
        const bar = typeof document !== 'undefined' ? document.getElementById('search-bar') : null;
        return !!(bar && bar.classList && bar.classList.contains('open'));
    }
    return true;
}

function _terminalFocusBlockedByIntent(priorFocus, passive) {
    if (typeof document === 'undefined') return false;
    if (document.querySelector('.overlay.open')) return true;
    const el = document.activeElement;
    if (!el) return false;
    if (el.closest && el.closest('.xterm')) return false;
    const tag = el.tagName;
    const isForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    if (!isForm) return false;
    // Passive completion is not a user activation: the user's LIVE form
    // focus always survives it (a dismissed search bar's hidden input does
    // not — see _formFocusIsLive).
    if (passive) return _formFocusIsLive(el);
    // Explicit activation: only a form focus NEWER than the activation
    // blocks (one already focused at activation time reflects the pre-click
    // state, which the real DOM's mousedown replaced).
    return el !== priorFocus;
}

// Focus `term` only if it is still the terminal the user should land on.
// `priorFocus` is the activeElement captured when the delayed work was
// SCHEDULED (null when unknown); `passive` selects the completion-mode
// intent rule. Returns whether the focus landed.
function _focusTerminalIfCurrent(term, priorFocus, passive) {
    if (!term) return false;
    const resolved = _resolveTermOwner(term);
    if (!resolved) return false;
    const { tab, owner } = resolved;
    if (TabManager.activeId !== tab.id) return false;
    if (tab.splitRoot) {
        const focusedPane = typeof getAllPanes === 'function' ? getAllPanes(tab).find(p => p.focused) : null;
        if (!focusedPane || focusedPane !== owner) return false;
    }
    if (_terminalFocusBlockedByIntent(priorFocus, passive)) return false;
    try { term.focus(); return true; } catch (e) { return false; }
}

// Focus-only delayed focus: reads the wrapper's term slot at fire time (a
// close inside the window nulls it), validated by _focusTerminalIfCurrent.
function _scheduleTerminalFocus(getTerm, delay, passive) {
    const priorFocus = (typeof document !== 'undefined' && document.activeElement) || null;
    setTimeout(() => {
        _focusTerminalIfCurrent(typeof getTerm === 'function' ? getTerm() : getTerm, priorFocus, passive);
    }, delay);
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
    _installTerminalBehavior(term, _perceivedCaretProvider(term));
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon(term)); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    _wireSearchAddon(term, searchAddon);

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
            // Owner resolved at FIRE time: the terminal may have migrated to
            // another wrapper during the debounce window, and a closure-captured
            // tabId would send the size to a dead or foreign session
            _sendResizeForTerm(term, cols, rows);
        }, 150);
    });

    // Fallback resize after 1s — covers slow-starting shells that missed the initial resize
    setTimeout(() => {
        if (term && term.cols && term.rows) _sendResizeForTerm(term, term.cols, term.rows);
    }, 1000);

    tab._onDataDisp = term.onData(data => {
        // Owner resolved at send time (reconnect with preserved content swaps
        // the backend id; split/drag migration moves the terminal onto pane
        // wrappers without rebinding this listener)
        _sendInputForTerm(term, data);
    });
    _wireTabRenameChannel(term);
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
        // A search-placed selection is not a user selection: copying it would
        // silently replace the clipboard with the latest match on every
        // typed character.
        if (_isSearchOwnedSelection(term)) return;
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
    // Clipboard API, read via the readTextAsync branch — both share the same
    // logic and the shared _pasteFromClipboardInto implementation (owner
    // re-resolution + session-generation validation).
    term.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        _pasteFromClipboardInto(term);
    });

    if (ptyBuffers[tabId]) {
        term.write(ptyBuffers[tabId]);
        delete ptyBuffers[tabId];
    }

    if (_settingsConfig.restoreLocalContent && tab._contentBuffer) {
        const replay = replayPayload(tab._contentBuffer);
        if (replay) term.write(replay);
    }

    if (TabManager.activeId === tab.id) {
        // Fire-time validated, PASSIVE mode: backend-ready wiring is a
        // completion, not a user activation — a close/reconnect inside the
        // 150ms window disposes this terminal or nulls the tab slot, and any
        // form field the user is holding focus in survives the arrival.
        _scheduleTerminalFocus(() => tab.term, 150, true);
        // The ACTIVE terminal just became usable (late backend arrival /
        // reconnect of the active tab): an open search bar with a query must
        // rebind to it now instead of waiting for the next user action.
        // No-ops unless the bar is open with a query and the owner moved.
        _refreshSearchAfterActiveChange();
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

// Explicit opt-in tab rename channel: OSC 1337 with a `ZTermTabName=` payload
// (ESC ] 1337 ; ZTermTabName=<name> ST, BEL or ST terminator; empty value
// clears). Plain OSC 0/2 window titles deliberately do NOT rename tabs. The
// owner is resolved at EVENT TIME by terminal identity: split/unsplit/
// extract/drag migrations move a term between tab and pane wrappers without
// re-wiring this hook, so a closure over the original tab/pane pair would
// keep writing the stale wrapper (and the display overlay reads `_toolName`
// from whichever slot the term is owned by NOW — tab for single-terminal
// tabs, pane for splits).
function _wireTabRenameChannel(term) {
    if (!term || !term.parser || typeof term.parser.registerOscHandler !== 'function') return;
    // One registration per terminal: the OSC registry is a per-id handler
    // list, so a re-wire of the same term would double-apply every rename.
    if (term._ztermRenameChannelWired) return;
    term._ztermRenameChannelWired = true;
    term.parser.registerOscHandler('1337', (data) => {
        const name = parseTabRenamePayload(data);
        // Not our payload (iTerm2/WezTerm 1337 sequences, ...): decline so a
        // later-registered handler can still consume it.
        if (name === null) return false;
        const resolved = _resolveTermOwner(term);
        if (resolved) _applyToolName(resolved.tab, resolved.owner, name);
        return true;
    });
}

// The tool name is stored on the pane (or on the tab itself for single-
// terminal tabs) and is a pure display overlay: it must never be written into
// tab.name and never persisted. An empty name clears the tool name. Only
// refresh when the visible label actually moved — a manual rename
// (_customName) keeps winning, and a no-op write skips the re-render.
function _applyToolName(ownerTab, paneLike, name) {
    if (!ownerTab || !paneLike) return;
    const oldDisplay = TabManager._tabDisplayName(ownerTab);
    if (name === '') delete paneLike._toolName;
    else paneLike._toolName = name;
    if (TabManager._tabDisplayName(ownerTab) !== oldDisplay) TabManager.refreshTabDisplay(ownerTab);
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
    _installTerminalBehavior(term, _perceivedCaretProvider(term));
    let fitAddon, searchAddon;
    try { fitAddon = new FitAddon(); term.loadAddon(fitAddon); } catch(e) { console.warn('FitAddon init failed:', e); }
    try { searchAddon = new SearchAddon(); term.loadAddon(searchAddon); } catch(e) { console.warn('SearchAddon init failed:', e); }
    // OSC 52 clipboard support
    if (_settingsConfig.osc52 !== false) {
        try { term.loadAddon(_createClipboardAddon()); } catch(e) { console.warn('ClipboardAddon init failed:', e); }
    }
    try { term.loadAddon(_createWebLinksAddon(term)); } catch(e) { console.warn('WebLinksAddon init failed:', e); }
    _wireSearchAddon(term, searchAddon);

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
        // stay at 80x24 forever (nvim UI garbled). The owner is resolved at send time —
        // this terminal may already have migrated off the pane it was wired for.
        const suppressed = TabManager._layoutTime && (Date.now() - TabManager._layoutTime) < 300;
        if (!suppressed && pane.term?.cols && pane.term.rows) {
            _sendResizeForTerm(term, pane.term.cols, pane.term.rows);
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
            // Owner resolved at FIRE time: extract/drag migration may have moved
            // this terminal onto another wrapper during the debounce window
            _sendResizeForTerm(term, cols, rows);
        }, 150);
    });

    pane._onDataDisp = term.onData(data => {
        _sendInputForTerm(term, data);
    });
    _wireTabRenameChannel(term);
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
        // Search-owned selections never reach the clipboard (see wireTerminal).
        if (_isSearchOwnedSelection(term)) return;
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
    // Owner re-resolution + session-generation validation live in
    // _pasteFromClipboardInto (shared with wireTerminal's handler).
    term.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (_settingsConfig.rightClickPaste === false) return;
        _pasteFromClipboardInto(term);
    });

    // Sync pane focus visual when terminal receives focus
    const syncFocus = () => {
        const ownerTab = TabManager.tabs.find(t => t.splitRoot && getAllPanes(t).some(pp => pp.id === pane.id));
        if (!ownerTab) return;
        // Maximize state is per-tab (the owning tab is the single source of
        // truth): while it shows a maximized pane, focus changes are suppressed
        if (ownerTab._maximizedPaneId) return;
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
        // Fire-time validated, PASSIVE mode: backend-ready wiring is a
        // completion, not a user activation — a close/migration inside the
        // 150ms window changes or clears the pane slot, and any form field
        // the user is holding focus in survives the arrival (their split
        // action predates their search/form entry).
        _scheduleTerminalFocus(() => pane.term, 150, true);
        // The ACTIVE pending pane just received its terminal (pty-created →
        // wireTerminalToPane): an open search bar with a query must rebind to
        // the now-usable active terminal. No-ops unless the bar is open with a
        // query and the owner moved.
        _refreshSearchAfterActiveChange();
    }
    // After wiring is complete, schedule one more size-settlement fallback (covers cases where onResize was suppressed or the size never changed)
    if (tab.splitRoot) _scheduleSettleResize(tab);
}

// ── Terminal search ──
// Search capability is keyed by the terminal instance rather than the wrapper
// it was wired for: split/extract/drag migrations move terminals between the
// tab and pane wrapper slots, and a wrapper-slot lookup would miss the addon
// after the move — or keep serving another session's addon from a stale slot.
// The addon itself is loaded ON the terminal; this map is only the ownership
// handle that survives every migration.
const _searchAddonByTerm = new WeakMap();
// The terminal whose addon currently owns the global search bar (its query,
// counter and match decorations). Every result event is gated on it: the
// addon also refreshes results from background writes/resizes, and an
// unguarded handler would let a background terminal overwrite the active
// one's counter or repopulate a closed search bar.
let _searchOwnerTerm = null;
// The query that produced the current selection. The addon anchors a find
// call on the terminal's existing selection; when the QUERY changes that
// selection belongs to the old query and would start the new search
// mid-buffer, so doSearch drops it and every edited query restarts from the
// top. Navigation (Enter/Shift+Enter) keeps the selection to advance.
let _searchLastQuery = '';
function _getActiveSearchTerm() {
    const tab = TabManager.getActive();
    if (!tab || tab.type === 'settings') return null;
    return tab.splitRoot
        ? (getAllPanes(tab).find(p => p.focused)?.term ?? null)
        : (tab.term ?? null);
}
function _getActiveSearchTarget() {
    const term = _getActiveSearchTerm();
    if (!term) return null;
    const addon = _searchAddonByTerm.get(term) || null;
    return addon ? { term, addon } : null;
}
// Shared registration for both wiring paths (tab + pane): the WeakMap
// ownership handle plus the owner-gated counter update.
function _wireSearchAddon(term, searchAddon) {
    if (!term || !searchAddon) return;
    _searchAddonByTerm.set(term, searchAddon);
    searchAddon.onDidChangeResults(r => {
        if (_searchOwnerTerm !== term) return;
        document.getElementById('search-count').textContent = _formatSearchCount(r);
        // Keep the search-owned-selection snapshot current: the event fires
        // after every find (including the addon's own background refresh,
        // which re-selects a match and moves the selection).
        _captureSearchSelection(term);
    });
}
// The selection the last find left on the owner terminal, in buffer
// coordinates. The addon clears and sets the terminal selection itself while
// SEARCHING; the cleanup paths (close/reopen/empty query/owner switch) may
// only drop a selection that is still exactly the one the search placed —
// the user may have made a manual selection afterwards, and erasing that on
// close would destroy their selection.
let _searchSelection = null; // { term, start: {x,y}, end: {x,y} } | null
// Set for exactly the synchronous window in which a find call places its
// match selection: the vendored addon's findNext/findPrevious call
// terminal.select(), which fires onSelectionChange BEFORE the addon's own
// onDidChangeResults (where the snapshot below is refreshed) — at event time
// the snapshot still describes the PREVIOUS match, so the snapshot alone
// cannot recognize the selection being placed right now.
let _searchPlacingSelection = false;
function _captureSearchSelection(term) {
    let pos = null;
    try { pos = term.getSelectionPosition(); } catch(e) { pos = null; }
    _searchSelection = pos ? { term, start: pos.start, end: pos.end } : null;
}
// Clears the terminal's selection ONLY while it is still bit-for-bit the
// selection the search placed (same start/end). Anything else — a later
// manual selection, or no selection — is left untouched.
function _clearSearchOwnedSelection(term) {
    const snapshot = _searchSelection && _searchSelection.term === term ? _searchSelection : null;
    _searchSelection = null;
    if (!snapshot) return;
    let pos = null;
    try { pos = term.getSelectionPosition(); } catch(e) { pos = null; }
    if (!pos) return;
    if (pos.start.x === snapshot.start.x && pos.start.y === snapshot.start.y
        && pos.end.x === snapshot.end.x && pos.end.y === snapshot.end.y) {
        try { term.clearSelection(); } catch(e) {}
    }
}
// True while the terminal's current selection belongs to the search rather
// than the user: either it is being placed synchronously inside a find call
// (flag above), or it is still bit-for-bit the selection the last find left
// behind (same start/end as the snapshot — a later manual selection at a
// different range is the user's and must copy normally). Auto-copy skips
// both: a search match must never overwrite the system clipboard.
function _isSearchOwnedSelection(term) {
    if (_searchPlacingSelection) return true;
    const snapshot = _searchSelection && _searchSelection.term === term ? _searchSelection : null;
    if (!snapshot) return false;
    let pos = null;
    try { pos = term.getSelectionPosition(); } catch(e) { return false; }
    return !!pos && pos.start.x === snapshot.start.x && pos.start.y === snapshot.start.y
        && pos.end.x === snapshot.end.x && pos.end.y === snapshot.end.y;
}
// The vendored addon only fires onDidChangeResults when the find options
// carry a `decorations` object (its internal gate is
// fireResultsChanged(!!options?.decorations)), and the same options drive the
// match highlights and overview-ruler marks. One stable option set for every
// find call also keeps the addon's own didOptionsChange check from
// re-highlighting on each navigation step.
function _searchOptions() {
    return {
        caseSensitive: false,
        regex: false,
        wholeWord: false,
        decorations: {
            matchBackground: _getAccentColorAlpha(0.25),
            activeMatchBackground: _getAccentColorAlpha(0.55),
            matchOverviewRuler: _getAccentColorAlpha(0.45),
            activeMatchColorOverviewRuler: _getAccentColorAlpha(0.8),
        },
    };
}
// resultIndex is -1 when the current selection is not among the tracked
// results (e.g. a refresh race inside the addon) — show nothing rather than
// a bogus "0/N".
function _formatSearchCount(r) {
    return (r && r.resultCount > 0 && r.resultIndex >= 0) ? `${r.resultIndex + 1}/${r.resultCount}` : '';
}
// Clears every trace of the current query: the counter, the decorations and
// the SEARCH-OWNED selection on the OWNING terminal (which may no longer be
// the active one — switching tabs mid-search leaves the old owner
// highlighted), and the owner handle itself. A selection the user made after
// the last match is not search-owned and survives. With the owner cleared,
// the per-terminal result handlers write nothing and the addon's background
// refresh goes inert (no cached search term left on the old owner).
function _resetActiveSearch() {
    document.getElementById('search-count').textContent = '';
    _searchLastQuery = '';
    const owner = _searchOwnerTerm;
    _searchOwnerTerm = null;
    if (!owner) { _searchSelection = null; return; }
    try { _searchAddonByTerm.get(owner)?.clearDecorations(); } catch(e) {}
    _clearSearchOwnedSelection(owner);
}
// Makes `term` the search owner, dropping the previous owner's decorations
// and SEARCH-OWNED selection when the owner actually changes (a tab/pane
// switch moved the search to another terminal; the old owner's highlights
// must not linger on a background surface, and a retained search selection
// would make returning continue from a stale match instead of restarting
// from the top — a manual selection there is not ours to erase). Returns
// true when the owner changed.
function _adoptSearchOwner(term) {
    if (_searchOwnerTerm === term) return false;
    const prev = _searchOwnerTerm;
    _searchOwnerTerm = term;
    if (prev && prev !== term) {
        try { _searchAddonByTerm.get(prev)?.clearDecorations(); } catch(e) {}
        _clearSearchOwnedSelection(prev);
    }
    return true;
}
// TabManager notifies this whenever the ACTIVE TERMINAL may have changed
// (tab switch, pane focus move, split promotion, pane-close fallback). The
// search bar is global: with a query typed, its counter and highlights must
// follow the newly active terminal instead of showing the previous one's
// results. Idempotent by design — a notification that did not move the
// active terminal does nothing, so a repeated notification can never
// double-advance the navigation position.
function _refreshSearchAfterActiveChange() {
    const bar = document.getElementById('search-bar');
    if (!bar || !bar.classList.contains('open')) return;
    if (!document.getElementById('search-input').value) return;
    if (_getActiveSearchTerm() === _searchOwnerTerm) return;
    doSearch();
}
function openSearch() {
    const bar = document.getElementById('search-bar');
    bar.classList.add('open');
    document.getElementById('search-input').value = '';
    // A fresh open drops the previous query's owner state entirely: input and
    // counter start blank, the old owner keeps no decorations, and no
    // background addon refresh can repopulate the counter for the dead query.
    _resetActiveSearch();
    setTimeout(() => {
        if (bar.classList.contains('open')) document.getElementById('search-input').focus();
    }, 50);
}
function closeSearch() {
    document.getElementById('search-bar').classList.remove('open');
    _resetActiveSearch();
    // Focus is re-resolved AT FIRE time: the terminal captured at close can
    // be gone within the 50ms window (tab close disposes it, a switch moved
    // the active slot), and focusing a disposed terminal throws.
    setTimeout(() => {
        const bar = document.getElementById('search-bar');
        if (bar.classList.contains('open')) return;
        const term = _getActiveSearchTerm();
        if (term) { try { term.focus(); } catch(e) {} }
    }, 50);
}
function doSearch() {
    const query = document.getElementById('search-input').value;
    const target = _getActiveSearchTarget();
    if (!target || !query) { _resetActiveSearch(); return; }
    const queryChanged = _searchLastQuery !== query;
    _adoptSearchOwner(target.term);
    // An edited query restarts from the top: the previous query's selection
    // would anchor the new search mid-buffer (addon semantics). Only the
    // search's OWN selection is dropped — a manual selection is not ours.
    if (queryChanged) _clearSearchOwnedSelection(target.term);
    _searchLastQuery = query;
    // The find places its match selection synchronously; flag the window so
    // the auto-copy handler recognizes it as search-owned (see
    // _isSearchOwnedSelection). finally: a throwing addon must not leave the
    // flag set and suppress user copies forever.
    _searchPlacingSelection = true;
    try {
        target.addon.findNext(query, _searchOptions());
    } finally {
        _searchPlacingSelection = false;
    }
    // The event handler captured the fresh selection; capture here too so the
    // snapshot exists even on the no-event paths (e.g. a fresh owner with no
    // decorations wiring ever firing).
    _captureSearchSelection(target.term);
}
function searchNext() { _navigateSearch(1); }
function searchPrev() { _navigateSearch(-1); }
function _navigateSearch(direction) {
    const query = document.getElementById('search-input').value;
    const target = _getActiveSearchTarget();
    if (!target || !query) { _resetActiveSearch(); return; }
    const ownerChanged = _adoptSearchOwner(target.term);
    // A fresh owner always STARTS a search rather than navigating: its addon
    // has no cached term, and findPrevious from the viewport bottom would
    // land on the LAST match — findNext from the top matches every other
    // fresh start (openSearch → type → Enter).
    // Same synchronous find window as doSearch: the placed match selection is
    // search-owned and must not reach the clipboard.
    _searchPlacingSelection = true;
    try {
        if (ownerChanged || direction > 0) target.addon.findNext(query, _searchOptions());
        else target.addon.findPrevious(query, _searchOptions());
    } finally {
        _searchPlacingSelection = false;
    }
    // Keep the search-owned-selection snapshot fresh on this path too (the
    // event handler already captures, this covers any no-event edge).
    _captureSearchSelection(target.term);
}
function onSearchKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
    if (e.key === 'Escape') { closeSearch(); }
}

