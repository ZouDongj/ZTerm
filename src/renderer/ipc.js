// ZTerm - ipcRenderer listeners and pty-output routing

// SSH attempt identity registry (ssh-attempts.js). Optional-chained so
// partial harnesses loading only this file keep working; the real renderer
// always loads the module first (renderer.html script order).
const _sshAttempts = (typeof sshAttempts !== 'undefined') ? sshAttempts : null;

// Update the pane status dot DOM (TabManager.render() does not repaint pane headers, so it must be updated manually)
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
// The same stream position also answers the ConPTY bring-up handshake: the
// filter swallows OpenConsole's opening DA1 probe and onDa1Query replies with
// a VT220-class response, or the shell's first output stalls ~3s.
function _conPtyCaretFix(owner, data, ownerType) {
    const factory = typeof createConPtyCaretFilter === 'function'
        ? createConPtyCaretFilter
        : window.createConPtyCaretFilter;
    if (!factory) return data;
    // Transport policy: the repair addresses ConPTY byte-stream
    // mutations and applies to LOCAL PTY sessions only. SSH streams reach
    // xterm exactly as the application emitted them — the old blanket fix
    // mode ran on them too, deleting painted caret cells (content loss) and
    // forcing a second cursor beside the app's own caret during deletion and
    // navigation (the reported double caret).
    const allowed = typeof caretRepairAllowed === 'function'
        ? caretRepairAllowed
        : (typeof window !== 'undefined' ? window.__conPtyCaretInternals?.caretRepairAllowed : null);
    if (allowed ? !allowed(ownerType) : ownerType === 'ssh') return data;
    if (!owner._caretFilter) owner._caretFilter = factory({ mode: 'fix', onDa1Query: () => {
        // OpenConsole blocks the shell's first output on a VT220-class DA1
        // reply; xterm's own answer (ESC[?1;2c) is ignored by it, so the
        // filter swallowed the query and we answer here instead.
        const response = globalThis.__conPtyCaretInternals?.CONPTY_DA1_RESPONSE;
        if (response && owner.tabId) ipcRenderer.send('pty-input', { tabId: owner.tabId, data: response });
    }, onWin32InputMode: () => {
        // conhost invited win32-input-mode on this (local) session: key
        // events may now be serialized as full INPUT_RECORDs (win32-input.js).
        // SSH never enters this filter, so the flag can only stick locally.
        owner._win32InputMode = true;
        // Gate keyed by the backend session id: split/drag migration moves
        // this terminal to a different tab/pane wrapper, and the id is the
        // only handle that survives the move.
        globalThis.__win32Input?.markGated?.(owner.tabId);
    } });
    const out = owner._caretFilter.push(data);
    return typeof out === 'string' ? out : data;
}

// Feed the RAW stream (pre-filter, pre-highlight) into the
// per-owner ink caret observer and return this chunk's ordinal. The write
// callback in pty-output reports the ordinal back to the adapter once xterm
// has fully parsed it (the watermark binding).
function _inkFeed(owner, tab, pane, data) {
    if (typeof data !== 'string' || !data) return null;
    const adapter = (pane || tab)?._smoothCursor?._adapter;
    const port = adapter?.softwareCaretPort;
    if (!port) return null;
    // Adapter identity changes on WebGL context loss / renderer rebuild —
    // the observer's port closure would feed a disposed adapter. Recreate
    // with the live port whenever the adapter changed.
    if (owner._inkObserver && owner._inkObserverAdapter !== adapter) owner._inkObserver = null;
    owner._inkObserverAdapter = adapter;
    if (!owner._inkObserver) {
        const factory = typeof createInkCaretObserver === 'function'
            ? createInkCaretObserver
            : window.createInkCaretObserver;
        if (!factory) return null;
        const term = (pane || tab)?.term;
        owner._inkObserver = factory({
            rows: term?.rows,
            cols: term?.cols,
            onCandidate: c => port.candidate(c),
            onUnit: u => port.unit(u),
            onInvalidate: reason => port.invalidate('observer:' + reason),
        });
    }
    // Scroll/wrap modeling needs the live geometry (cheap no-op normally).
    const liveTerm = (pane || tab)?.term;
    if (liveTerm) owner._inkObserver.setSize?.(liveTerm.rows, liveTerm.cols);
    const seq = owner._inkObserver.push(data).chunkSeq;
    port.enqueued?.(seq);
    return { seq, port, adapter, observer: owner._inkObserver, term: liveTerm,
        generation: port.generation?.(), epoch: owner._inkSessionEpoch || 0 };
}

function _inkParsedCheckpoint(ink) {
    const term = ink.term;
    if (!term || !ink.port.isParsed?.(ink.seq)) return;
    const active = term.buffer?.active;
    const core = term._core;
    const buffer = core?.buffer;
    const modes = core?.coreService?.decPrivateModes;
    const attr = core?._inputHandler?._curAttrData;
    const safe = !!active && !!buffer && !!modes && !!attr
        && active.viewportY === active.baseY
        && modes.origin === false && modes.wraparound === true && modes.reverseWraparound === false
        && core.coreService.modes?.insertMode === false
        && buffer.scrollTop === 0 && buffer.scrollBottom === term.rows - 1
        && attr.fg === 0 && attr.bg === 0 && attr.extended?.ext === 0 && attr.extended?.urlId === 0;
    ink.observer.checkpoint?.({ seq: ink.seq, safe, x: active?.cursorX, y: active?.cursorY,
        rows: term.rows, cols: term.cols });
}

function _outputParsed(owner, ink, diagnostic) {
    if (!ink && !diagnostic) return undefined;
    return () => {
        if (ink && (owner._inkSessionEpoch || 0) === ink.epoch && owner._smoothCursor?._adapter === ink.adapter
            && owner._inkObserver === ink.observer && owner.term === ink.term) {
            ink.port.parsed(ink.seq);
            if (ink.port.generation?.() === ink.generation) _inkParsedCheckpoint(ink);
        }
        if (diagnostic) globalThis.ZTermDiagnostics?.parsed(diagnostic);
    };
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
            if (pane) { _resetCaretState(pane); return; }
        }
        if (tab.tabId === tabId) { _resetCaretState(tab); return; }
    }
}
function _resetCaretState(owner) {
    owner._inkSessionEpoch = (owner._inkSessionEpoch || 0) + 1;
    if (globalThis.ZTermDiagnostics?.enabled) globalThis.ZTermDiagnostics.reset(owner);
    delete owner._caretFilter;
    // Session reset: the ink observer's candidates belong to the dead
    // session's coordinate space — drop them and invalidate the descriptor.
    owner._inkObserver = null;
    owner._smoothCursor?._adapter?.softwareCaretPort?.invalidate('session-reset');
}

ipcRenderer.on('pty-output', (event, { tabId, data, nativeTrace }) => {
    const diagnostics = globalThis.ZTermDiagnostics?.enabled ? globalThis.ZTermDiagnostics : null;
    const diagnostic = diagnostics?.receive(tabId, data, nativeTrace);
    // Diagnostic-only RAW capture: grabs the stream BEFORE any caret
    // filtering so samples are pristine pre-filter evidence, not the
    // post-fix cache. Armed by setting globalThis.__ztRawCapture = [];
    // one property check per chunk when disarmed. Bounded by the armer.
    if (globalThis.__ztRawCapture) globalThis.__ztRawCapture.push(data);
    // Diagnostic-only stream volume counter: armed by setting globalThis.__ztStreamBytes
    // to an object (a plain global lookup otherwise — no cost when off).
    if (globalThis.__ztStreamBytes) globalThis.__ztStreamBytes[tabId] = (globalThis.__ztStreamBytes[tabId] || 0) + (data ? data.length : 0);
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId);
            if (pane) {
                diagnostics?.routed(diagnostic, pane, data);
                if (!tab._contentBuffer) tab._contentBuffer = '';
                // Observe the RAW bytes first, then the transport filter,
                // then write with a parse-watermark callback.
                const inkSeq = _inkFeed(pane, tab, pane, data);
                // ConPTY caret fix must run before buffering so the filter sees
                // the full stream in order; ptyBuffers then holds repaired bytes.
                if (typeof data === 'string' && data) data = _conPtyCaretFix(pane, data, pane.type || tab.type);
                diagnostics?.filtered(diagnostic, data);
                if (pane.term) {
                    pane.term.write(applyHighlight(data, tabId),
                        _outputParsed(pane, inkSeq, diagnostic));
                } else {
                    let _b = ptyBuffers[tabId] || ''; _b += data; if (_b.length > 1048576) _b = _b.slice(-524288); ptyBuffers[tabId] = _b;
                }
                return;
            }
        }
        if (tab.tabId === tabId) {
            diagnostics?.routed(diagnostic, tab, data);
            if (!tab._contentBuffer) tab._contentBuffer = '';
            const inkSeq = _inkFeed(tab, tab, null, data);
            if (typeof data === 'string' && data) data = _conPtyCaretFix(tab, data, tab.type);
            diagnostics?.filtered(diagnostic, data);
            // Track alternate screen (nvim, less, etc.) — don't save TUI content.
            // Gate is chunk-granular and order matters: a chunk containing the
            // alt-screen ENTER is not captured (flag set before the gate), while
            // a chunk containing the EXIT is captured including the exit itself
            // — replay's alt-balance scan strips that stray token (its enter
            // was never captured), so it cannot teleport the replay cursor.
            if (data.includes('\x1b[?1049h')) tab._altScreen = true;
            if (data.includes('\x1b[?1049l')) tab._altScreen = false;
            if (!tab._altScreen) tab._contentBuffer = appendContentTail(tab._contentBuffer, data);
            if (tab.term) {
                if (ptyBuffers[tabId]) {
                    tab.term.write(ptyBuffers[tabId]);
                    delete ptyBuffers[tabId];
                }
                tab.term.write(applyHighlight(data, tabId),
                    _outputParsed(tab, inkSeq, diagnostic));
            } else {
                let _b = ptyBuffers[tabId] || ''; _b += data; if (_b.length > 1048576) _b = _b.slice(-524288); ptyBuffers[tabId] = _b;
            }
            return;
        }
    }
});

// ── IPC: PTY created (local) ──
ipcRenderer.on('pty-created', (event, { tabId, requestId, spawnError }) => {
    if (requestId) {
        for (const tab of TabManager.tabs) {
            // A tab inside its close window cancelled its pending requests at
            // initiation and must not claim a new backend during the fade —
            // skip it so the result falls through to the orphan destroy.
            if (TabManager._closingTabs?.has(tab.id)) continue;
            if (tab.splitRoot) {
                // Claim only through a still-live request marker: close
                // initiation clears pane.requestId, and a bare pane-id lookup
                // (requestId === pane.id at spawn time) would match the dying
                // pane anyway and resurrect a terminal nobody disposes.
                const pane = getAllPanes(tab).find(p => p.requestId === requestId);
                if (pane) {
                    if (globalThis.ZTermDiagnostics?.enabled) globalThis.ZTermDiagnostics.reset(pane);
                    pane.tabId = tabId;
                    // Owner-scoped reset: at this point the pane still carried
                    // the PREVIOUS session's tabId, so a lookup by the new
                    // tabId never matched (respawn would inherit the old
                    // filter with da1Seen=1 and never answer the handshake).
                    _resetCaretState(pane);
                    // Fresh local generation: a successful claim is live for
                    // input again; a failed spawn is correctly represented as
                    // a failed session (paste stays cancelled).
                    pane._sessionFailed = !!spawnError;
                    wireTerminalToPane(tab, pane);
                    if (spawnError && pane.term) pane.term.write('\r\n\x1b[31m[ZTerm] 启动失败: ' + spawnError + '\x1b[0m\r\n');
                    // Sync fit + report the size immediately: the local pty starts at 80x24, so this shortens the window before it reaches the real size
                    _syncFitAndReportSize(tab, pane);
                    return;
                }
            } else if (tab.id === requestId || tab._ptyRequestId === requestId) {
                if (globalThis.ZTermDiagnostics?.enabled) globalThis.ZTermDiagnostics.reset(tab);
                delete tab._ptyRequestId;
                _resetCaretState(tab); // see the split branch above
                // Same generation rule as the pane claim: success is live,
                // a failed spawn stays failed.
                tab._sessionFailed = !!spawnError;
                if (!tab.term) {
                    wireTerminal(tab, tabId);
                    if (spawnError && tab.term) tab.term.write('\r\n\x1b[31m[ZTerm] 启动失败: ' + spawnError + '\x1b[0m\r\n');
                    _syncFitAndReportSize(tab, null);
                    return;
                }
            }
        }
    }
    // Unclaimed orphan pty — destroy it to avoid leaking the process
    ipcRenderer.send('pty-destroy', { tabId });
});

// ── IPC: unclaimed SSH creation results ──
// A creation result whose consumer is gone (tab closed while the handshake
// was running, or a stale generation after a reconnect) owns a backend nobody
// will ever input into or close — the main process registers the session and
// its reader/keepalive tasks keep running until app exit. Dispose it here,
// the same commitment the orphan branch of pty-created makes for local
// creates: the backend id disconnects a registered session (and cancels a
// still-in-flight attempt of exactly that generation), the attempt token
// cancels a pre-claim attempt. Idempotent by construction.
function _disposeUnclaimedSsh(tabId, attemptId) {
    const payload = {};
    if (tabId) payload.tabId = tabId;
    if (attemptId) payload.attemptId = attemptId;
    if (payload.tabId || payload.attemptId) ipcRenderer.send('ssh-disconnect', payload);
}

// ── IPC: SSH connecting ──
// The SSH handshake starts here (onReady only arrives after auth completes, a window of seconds):
// build the term and fit now, then immediately send the real cols/rows to the main process,
// which caches them as pendingSizes and uses them when opening the PTY on onReady — the PTY starts at the real size, no 80x24 flicker
function _syncFitAndReportSize(tab, pane) {
    const term = pane ? pane.term : tab.term;
    const fitAddon = pane ? pane.fitAddon : tab.fitAddon;
    const parentEl = pane
        ? document.getElementById('pane-body_' + pane.id)
        : (term && term.element ? term.element.parentElement : null);
    if (!term || !fitAddon || !parentEl) return;
    // Wait one frame for the DOM to settle, then fit + send the size straight to the main process (the PTY is not open yet; the main process caches it as pendingSizes)
    requestAnimationFrame(() => {
        _fitWithScroll(term, fitAddon, parentEl);
        const backendTabId = pane ? pane.tabId : tab.tabId;
        if (backendTabId && term.cols && term.rows) {
            ipcRenderer.send('pty-resize', { tabId: backendTabId, cols: term.cols, rows: term.rows });
        }
    });
}

// ── Session-owner resolution for backend lifecycle events ──
// The backend id is a session's CURRENT identity (authoritative pass 1: a
// delayed event reaches the session's CURRENT owner even after its terminal
// migrated to another tab/pane). Pass 2 resolves the ATTEMPT TOKEN to the
// wrapper currently awaiting it — identity, never a display address, so a
// stale event for a replaced/cancelled attempt finds no owner (its token is
// detached) and a migrated wrapper is still found after extract/collapse.
function _findSessionOwner(tabId, attemptId) {
    for (const tab of TabManager.tabs) {
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => tabId && p.tabId === tabId);
            if (pane) return { tab, pane };
        } else if (tabId && tab.tabId === tabId) {
            return { tab, pane: null };
        }
    }
    if (!_sshAttempts || !attemptId || !_sshAttempts.ownerWants(attemptId)) return null;
    const w = _sshAttempts.ownerOf(attemptId);
    if (!w) return null;
    for (const tab of TabManager.tabs) {
        // A tab inside its close window cancelled its attempts at initiation;
        // it must not claim a new session during the fade.
        if (TabManager._closingTabs?.has(tab.id)) continue;
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p === w);
            if (pane) return { tab, pane };
        } else if (tab === w) {
            return { tab, pane: null };
        }
    }
    return null;
}

// ── Shared, idempotent attempt-lifecycle transitions ──
// The lifecycle events and the own invocation result travel independent
// channels and may arrive in ANY order. Both sides funnel into these three
// appliers; the attempt registry's beginClaim/finishUi guards make each UI
// application happen exactly once, so neither order duplicates terminals,
// banners or notifications, and a late duplicate regresses nothing.
// Each applier returns true when an owner consumed the transition; false
// means unclaimed (the caller disposes the result's own backend).

function _applySshConnecting(attemptId, tabId) {
    const hit = _findSessionOwner(tabId, attemptId);
    if (!hit) return false;
    const { tab, pane } = hit;
    // First connecting-application wins; a late/second one (duplicate event,
    // or an event after an rpc-first claim) must not regress the owner.
    // Legacy events without an attempt token skip the registry guard (the
    // real producer always sends attemptId; pass 1 routed by backend id).
    if (_sshAttempts && attemptId && !_sshAttempts.beginClaim(attemptId, tabId)) return true;
    if (pane) {
        if (globalThis.ZTermDiagnostics?.enabled) globalThis.ZTermDiagnostics.reset(pane);
        pane.tabId = tabId;
        // A fresh connect attempt is a NEW session generation: any
        // failure marker from a previous generation no longer applies.
        pane._sessionFailed = false;
        // In preserve mode (clearOnConnect=false) the terminal already exists: do not rebuild it, or the preserved content would be replaced with an empty terminal
        if (!pane.term) wireTerminalToPane(tab, pane);
        if (pane.term) {
            pane.term.write('\x1b[33mConnecting to ' + (pane._sshHost || tab.host || pane.name || tab.name) + '...\x1b[0m\r\n');
            _syncFitAndReportSize(tab, pane);
        }
        return true;
    }
    if (globalThis.ZTermDiagnostics?.enabled) globalThis.ZTermDiagnostics.reset(tab);
    tab.tabId = tabId;
    tab._sessionFailed = false; // new generation — see the pane branch
    if (!tab.term) wireTerminal(tab, tabId);
    if (tab.term) tab.term.write('\x1b[33mConnecting to ' + (tab.host || tab.name) + '...\x1b[0m\r\n');
    _syncFitAndReportSize(tab, null);
    return true;
}

function _applySshConnected(attemptId, tabId) {
    if (!tabId) return false;
    const hit = _findSessionOwner(tabId, attemptId);
    if (!hit) return false;
    const { tab, pane } = hit;
    const firstApplication = !_sshAttempts || !attemptId || _sshAttempts.finishUi(attemptId, 'ok');
    if (firstApplication) {
        // First terminal application (either channel): full connected UI.
        _resetCaretFilterById(tabId);
        if (pane) {
            tab._sshRetried = 0; // connected: re-arm THIS tab's handshake retry budget
            if (!pane.term) wireTerminalToPane(tab, pane);
            if (pane.term) pane.term.write('\r\n\x1b[32m[SSH Connected]\x1b[0m\r\n');
            tab.connected = true;
            pane._sessionFailed = false; // live again — pending input is valid
            _updatePaneDot(pane, true);
        } else {
            tab._sshRetried = 0;
            tab.connected = true;
            tab._sessionFailed = false; // live again — see the split branch
            if (!tab.term) wireTerminal(tab, tabId);
            if (tab.term) tab.term.write('\r\n\x1b[32m[SSH Connected]\x1b[0m\r\n');
        }
        TabManager.render();
        TabManager.updateStatus();
        showToast('SSH 已连接: ' + _sshDisplayName(tab, pane));
        // Fallback size settle: the connecting phase already fit and opened the PTY at the right size via pendingSizes,
        // but if the container had zero size during connecting (tab hidden, etc.), settle once more here; after connected the size is registered and usable
        _scheduleSettleResize(tab);
        return true;
    }
    // Already applied by the other channel: a TRUE no-op. A duplicate success
    // (late rpc result or duplicate event) must not regress newer lifecycle
    // state — a real disconnection after the first success stays terminal
    // (connected=false, _sessionFailed=true, terminal text and caret filter
    // untouched), and no second banner/toast fires.
    return true;
}

// Failure application shared by the ssh-error event and the own invocation
// rejection (Rust validates host/port/username/attemptId BEFORE any emit, so
// the rejection can be the ONLY failure signal). Applies at most once.
function _applySshFailed(attemptId, tabId, error) {
    const hit = _findSessionOwner(tabId, attemptId);
    if (!hit) return false;
    const { tab, pane } = hit;
    if (_sshAttempts && attemptId && !_sshAttempts.finishUi(attemptId, 'failed')) return true; // other channel applied (legacy events without a token always apply)
    const msg = error || 'SSH connect failed';
    if (pane) {
        if (pane.term) {
            pane.term.write('\r\n\x1b[31m[SSH Error] ' + msg + '\x1b[0m\r\n');
        } else {
            wireTerminalToPane(tab, pane);
            if (pane.term) pane.term.write('\r\n\x1b[31m[SSH Error] ' + msg + '\x1b[0m\r\n');
        }
        tab.connected = false;
        // The terminal (and the backend id) is preserved, but the session is
        // known failed — pending input for THIS pane must be cancelled even
        // though the old id remains (sync input would relay it to siblings).
        pane._sessionFailed = true;
        _updatePaneDot(pane, false);
    } else {
        tab.connected = false;
        tab._sessionFailed = true; // same liveness marker as the pane branch
        if (!tab.tabId && tabId) tab.tabId = tabId;
        if (tab.term) {
            tab.term.write('\r\n\x1b[31m[SSH Error] ' + msg + '\x1b[0m\r\n');
        } else {
            wireTerminal(tab, tabId);
            if (tab.term) tab.term.write('\r\n\x1b[31m[SSH Error] ' + msg + '\x1b[0m\r\n');
        }
    }
    TabManager.render();
    TabManager.updateStatus();
    showToast('SSH 连接失败: ' + msg, true);
    return true;
}

ipcRenderer.on('ssh-connecting', (event, { tabId, rendererId, attemptId } = {}) => {
    // attemptId is always present from the current producer; without it the
    // event still routes by backend identity (legacy shape) but cannot
    // correlate with an attempt for the pending fallback.
    if (!_applySshConnecting(attemptId, tabId)) _disposeUnclaimedSsh(tabId, attemptId);
});

// ── IPC: SSH connected ──
// SSH display name: prefer the SSH profile name over the dynamically composed tab name (split panes compose names like "A | B")
function _sshDisplayName(tab, pane) {
    const pId = (pane && pane._sshProfileId) || tab.sshProfileId;
    const prof = pId ? (TabManager.sshProfiles || []).find(x => x.id === pId) : null;
    return (prof && prof.name) || (pane && pane.name) || tab.host || tab.name;
}

ipcRenderer.on('ssh-connected', (event, { tabId, rendererId, attemptId } = {}) => {
    if (!_applySshConnected(attemptId, tabId)) _disposeUnclaimedSsh(tabId, attemptId);
});

// The own invocation result may arrive before, between or after the
// lifecycle events (independent channels). The registry calls this applier
// on every rpc terminal state; it reuses the same guarded transitions, so
// either order applies exactly once and a missed event still completes the
// UI handoff (the success result carries the backend id).
if (_sshAttempts) {
    _sshAttempts.setRpcApplier((token, kind, backendId, errText) => {
        if (kind === 'ok') {
            _applySshConnecting(token, backendId);
            if (!_applySshConnected(token, backendId)) _disposeUnclaimedSsh(backendId, token);
        } else if (kind === 'failed') {
            // No-event failure paths (early validation, transport rejection):
            // apply to the still-current owner at most once; the attempt
            // record retires with this terminal state.
            _applySshFailed(token, backendId, errText);
        }
        // 'cancelled': our own cancel already released everything; the
        // invocation exit is silent by design.
    });
}

// ── IPC: SSH error ──
ipcRenderer.on('ssh-error', (event, { tabId, rendererId, attemptId, error }) => {
    // Backend identity first (see _findSessionOwner): a delayed error must
    // reach the session's current owner, never a wrapper that merely shares
    // a display address with a different live session.
    const hit = _findSessionOwner(tabId, attemptId);
    const tab = hit ? hit.tab : null;
    const pane = hit ? hit.pane : null;
    // Stale-generation failures (the owner replaced/cancelled this attempt)
    // surface nothing: the toast would describe a connection the user
    // explicitly discarded, not the pending replacement.
    if (!tab) {
        if (_sshAttempts && attemptId ? _sshAttempts.finalState(attemptId) == null : true) showToast('[SSH] ' + error, true);
        _disposeUnclaimedSsh(tabId, attemptId);
        return;
    }
    // Classify transient errors from the russh error text (timeout / connection dropped / key exchange failure)
    // and auto-retry only those; deterministic errors like auth failure or unknown host key are not retried.
    // The old regex /handshake|lost before/ was written for Electron ssh2 errors; regular russh errors never matched it, so transient failures were never retried
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
        // The failed attempt's UI side is terminal from here on (the retry
        // line below is its own presentation); the shared failure applier is
        // not used on this branch.
        if (_sshAttempts && attemptId) _sshAttempts.finishUi(attemptId, 'failed');
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
                // The retry REPLACES the failed generation: cancel its
                // attempt by identity (backend id + token) — never a display
                // address — and release its queue slot.
                _cancelSshAttemptOf(pane, pane.tabId, 'ssh-disconnect');
                delete ptyBuffers[pane.tabId];
                // Reset the caret filter explicitly: the ssh-disconnected
                // event lookup happens after pane.tabId is nulled and would
                // miss, leaving a filter stuck mid-sync-block on the KEPT
                // term to swallow the reconnect's fresh output.
                delete pane._caretFilter;
            }
            pane.tabId = null;
            // The source session is known dead: pending input (e.g. an
            // in-flight right-click paste) must be cancelled, not delivered.
            pane._sessionFailed = true;
        } else {
            if (tab.tabId) {
                _cancelSshAttemptOf(tab, tab.tabId, 'ssh-disconnect'); // same identity-exact discard
                delete ptyBuffers[tab.tabId];
                delete tab._caretFilter; // same as the pane branch above
                tab._altScreen = false;
            }
            tab.tabId = null;
            tab._sessionFailed = true; // same liveness marker as the pane branch
        }
        // A manual reconnect (reconnectTab / clicking a down tab) supersedes
        // this scheduled retry: both would start a new attempt and the
        // loser's session gets orphaned. reconnectTab bumps the token, making
        // superseded timers no-op. Pane liveness is checked separately —
        // closing the pane (not the tab) during the backoff must not spawn a
        // backend for a dead pane.
        const token = (tab._sshRetryToken = (tab._sshRetryToken || 0) + 1);
        // A split collapse during the backoff adopts the failed pane back
        // into the tab (_exitSplit: tab.term = pane.term, splitRoot = null) —
        // the pane leaves the tree, yet its session is still owed this retry.
        // Term identity detects the adoption (a destroyed pane's terminal
        // never matches the adopted one); extract and cross-tab drag cannot
        // race this — both require pane.tabId, which the retry branch above
        // already cleared.
        const paneAdopted = () => !!pane && !tab.splitRoot && !!retryTerm && tab.term === retryTerm;
        const stillWanted = () => tab._sshRetryToken === token && TabManager.tabs.includes(tab)
            && (!pane || paneAdopted()
                || TabManager.tabs.some(t => t.id === tab.id && getAllPanes(t).some(p => p.id === pane.id)));
        setTimeout(() => {
            if (!stillWanted()) return; // superseded / tab or pane closed
            // The retry is a NEW attempt identity (the old one was cancelled
            // explicitly above — no implicit supersede). An adopted pane's
            // wrapper is dead — its session fields moved onto the tab with the
            // terminal, so the retry connects the tab instead.
            _sshConnectWithCredentials(tab, paneAdopted() ? null : pane);
        }, backoffMs);
        return;
    }
    // Deterministic failure: the shared, once-guarded application.
    _applySshFailed(attemptId, tabId, error);
});

// ── IPC: SSH disconnected ──
ipcRenderer.on('ssh-disconnected', (event, { tabId, reason, path }) => {
    // The filter may be stuck mid-sync-block from the dead session; drop it so
    // a reconnect cannot inherit a filter that swallows all fresh output.
    _resetCaretFilterById(tabId);
    clearAlternateScreen(tabId);
    if (TabManager._consumeClosed(tabId)) {
        return;
    }
    const line = '\r\n\x1b[33m[SSH Disconnected]\x1b[0m' + (reason ? ` \x1b[2m${reason}\x1b[0m` : '') + '\r\n';
    // Session-level event (no attempt payload): backend-id routing only.
    const hit = _findSessionOwner(tabId, null);
    if (!hit) return;
    const { tab, pane } = hit;
    if (pane) {
        tab.connected = false;
        // Known-disconnected source session: cancel pending input.
        pane._sessionFailed = true;
        _updatePaneDot(pane, false);
        if (pane.term) pane.term.write(line);
        TabManager.render();
        TabManager.updateStatus();
        return;
    }
    tab.connected = false;
    tab._sessionFailed = true; // same liveness marker as the pane branch
    if (tab.term) tab.term.write(line);
    TabManager.render();
    TabManager.updateStatus();
});

// ── IPC: SSH disconnect reason (session-level, from russh's disconnected() callback) ──
// Arrives independently of ssh-disconnected — the channel reader usually
// wins the race, so the reason typically lands AFTER the disconnect line.
// Append it as a dim line, but only onto a tab that is actually in the
// disconnected state; user-initiated closes (kind "closed") go to the
// console only, since the user knows they closed it.
ipcRenderer.on('ssh-disconnect-reason', (event, { tabId, kind, reason, at }) => {
    console.debug('[ssh] disconnect reason:', { tabId, kind, reason, at: at ? new Date(at).toISOString() : null });
    if (kind === 'closed' || !reason) return;
    for (const tab of TabManager.tabs) {
        let term = null;
        if (tab.splitRoot) {
            const pane = getAllPanes(tab).find(p => p.tabId === tabId);
            if (pane) term = pane.term;
            else continue;
        } else if (tab.tabId === tabId) {
            term = tab.term;
        } else continue;
        if (term && !tab.connected) {
            const ts = at ? new Date(at).toLocaleTimeString() : '';
            term.write(`\x1b[2m[SSH] ${reason}${ts ? ' · ' + ts : ''}\x1b[0m\r\n`);
        }
        return;
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
                // Local twin of an SSH failure: process gone, id retained —
                // pending input for THIS pane is cancelled.
                pane._sessionFailed = true;
                _updatePaneDot(pane, false);
                TabManager.render();
                return;
            }
        } else if (tab.tabId === tabId) {
            tab.connected = false;
            tab._sessionFailed = true; // same liveness marker as the pane branch
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
            // After a window size change, settle the final terminal size for every tab (covers corners a single terminal's wrap ResizeObserver may miss)
            _scheduleSettleResize(tab);
        });
    });
});

// The main process has backed up and rebuilt the corrupted config file; notify the user
ipcRenderer.on('config-corrupted', () => {
    showToast('配置文件已损坏，已备份并恢复默认设置', true);
});

// SSH host key mismatch alert (possible MITM): let the user decide whether to keep connecting.
// Cleanup for the currently active hostkey dialog. EVERY dismissal path must
// resolve the backend's suspended decision: check_server_key awaits it on a
// oneshot (zterm.rs), so a dialog that vanishes without one hangs the attempt
// at "Connecting to ..." forever and leaks the russh task. The cleanup below
// therefore sends an idempotent reject itself; only the buttons record an
// explicit decision first. closeAllOverlays (Escape) runs this cleanup, and a
// second mismatch / showConfirm supersedes the dialog through it.
let _activeHostkeyCleanup = null;

ipcRenderer.on('ssh-hostkey-mismatch', (event, { tabId, attemptId, host, oldAlgorithm, oldFingerprint, newAlgorithm, newFingerprint }) => {
    // Correlate with the attempt BEFORE touching the shared dialog: the
    // mismatch fires after the NATIVE connecting emit but possibly before
    // the frontend processed the claim, so only the attempt token reliably
    // identifies the consumer. A dead/unknown attempt (closed, cancelled,
    // superseded, or a pre-reload epoch) must NOT open a modal or clean up
    // another live attempt's dialog — reject only its own decision by
    // backend id so the suspended task unblocks and exits. No security
    // decision is ever auto-accepted.
    if (!attemptId || !_sshAttempts || !_sshAttempts.ownerWants(attemptId)) {
        ipcRenderer.send('ssh-hostkey-decision', { tabId, accept: false, trust: false });
        return;
    }
    if (_activeHostkeyCleanup) _activeHostkeyCleanup();
    // showConfirm (delete/update confirmations) shares this DOM but keeps its
    // own cleanup registry; unbind it too or this dialog's buttons would also
    // fire its stale callbacks.
    if (typeof _activeConfirmCleanup === 'function' && _activeConfirmCleanup) _activeConfirmCleanup();
    const msg = `⚠ 主机密钥变更警告\n\n主机 ${host} 的密钥指纹与已知记录不符，可能存在中间人攻击。\n\n旧指纹 (${oldAlgorithm}):\n${oldFingerprint}\n\n新指纹 (${newAlgorithm}):\n${newFingerprint}\n\n是否信任新密钥并继续连接？`;
    document.getElementById('confirm-msg').textContent = msg;
    const overlay = document.getElementById('overlay-confirm');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');
    cancelBtn.textContent = '拒绝';
    okBtn.textContent = '信任并连接';

    // Exactly one decision per dialog, whatever the dismissal path: the
    // non-button paths (Escape via closeAllOverlays, superseded by a second
    // mismatch or by showConfirm) only run cleanup, so the refusal defaults
    // here — reject, never auto-accept. onAccept pre-records its decision.
    let decided = false;
    const decide = (accept, trust) => {
        if (decided) return;
        decided = true;
        ipcRenderer.send('ssh-hostkey-decision', { tabId, accept, trust });
    };
    const cleanup = () => {
        _activeHostkeyCleanup = null;
        overlay.classList.remove('open');
        cancelBtn.removeEventListener('click', onReject);
        okBtn.removeEventListener('click', onAccept);
        overlay.querySelector('.overlay-backdrop').removeEventListener('click', onReject);
        // Restore the default button labels
        cancelBtn.textContent = '取消';
        okBtn.textContent = '删除';
        decide(false, false);
    };
    const onReject = () => {
        cleanup();
    };
    const onAccept = () => {
        decide(true, true);
        cleanup();
    };

    cancelBtn.addEventListener('click', onReject);
    okBtn.addEventListener('click', onAccept);
    overlay.querySelector('.overlay-backdrop').addEventListener('click', onReject);
    overlay.classList.add('open');
    _activeHostkeyCleanup = cleanup;
});
