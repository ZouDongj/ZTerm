// IME caret anchor: keep the OS IME candidate window on the caret the user
// actually sees, without chasing transient mid-repaint cursor parks or
// drifting on scrolled viewports / accumulated textarea text.
//
// Stock xterm anchors its helper textarea (_syncTextArea, on onCursorMove) and
// composition overlay (CompositionHelper.updateCompositionElements, on onRender)
// directly to buffer.x/y without checking cursor visibility, ignoring scroll
// viewport offset (ybase - ydisp), skipping compositionstart/scroll/dimension
// resyncs, and retaining committed text in textarea.value across IME commits.
//
// Under Windows ConPTY, full-screen TUIs (Claude Code, dsh-tui, PSReadLine)
// bracket repaints with bare ESC[?25l ... ESC[?25h (no ?2026 sync block); when
// the PTY flusher splits a repaint across chunks, Chunk 1 lands with
// isCursorHidden=true at a random mid-repaint cell. Meanwhile permanently
// hidden-cursor TUIs (kimi) keep isCursorHidden=true for the whole session and
// redraw menus/status lines below the input box before returning to the prompt.
//
// Policy:
//   1. Unified viewport geometry: protocol anchoring computes
//      viewportY = ybase + y - ydisp and syncs textarea font metrics to match
//      the terminal so Blink/TSF layout bounds align with the composition view.
//   2. Protocol cursor visible -> immediate anchor at protocol cell (cancels
//      any pending hidden settle timer).
//   3. Protocol cursor hidden + adapter perceived caret known -> immediate
//      anchor at the perceived caret cell.
//   4. Protocol cursor hidden + no perceived caret:
//      - During active composition: hold the established anchor cell (clamped
//        to current rows/cols) so split ?25l repaints and background spinner
//        frames cannot pull the candidate window away mid-word (cold-start
//        hidden sessions anchor once so they never strand at CSS left: -9999em).
//      - While idle: cold-start anchors immediately; once anchored, debounce
//        for HIDDEN_SETTLE_MS (48ms, covering ConPTY 4ms flushes and 27-36ms
//        twin-wave splits). Visible-cursor repaints cancel the timer on ?25h
//        with zero intermediate jump; permanently-hidden apps coalesce
//        multi-block redraws and flush on fast consecutive compositionstart so
//        the next word never covers just-committed text.
//   5. Lifecycle sync & cleanup: reset anchor state across normal/alternate
//      buffer activation; re-anchor on compositionstart, scroll (including
//      mouse-wheel/scrollbar suppressScrollEvent scrolls), cell-dimension,
//      DPR, and char-size changes; restore 1-cell idle geometry on
//      compositionend or non-229 keydown exit; safely clear dead committed
//      textarea.value / scrollLeft once _finalizeComposition and idle
//      keydown(229) timers complete; dispose all timers and subscriptions on
//      terminal teardown.
//
// Patches xterm internals from the outside so the vendored bundle stays
// mechanically extracted. If a vendor refresh renames internals, patchTerminal
// returns false and warns loudly.
(function installImeCaretAnchor(root) {
    'use strict';

    // Covers ConPTY 4ms flusher chunks and 27-36ms twin-wave repaint splits
    // while staying well below human key-to-IME reaction time.
    const DEFAULT_HIDDEN_SETTLE_MS = 48;
    // Outlives CompositionHelper._handleAnyTextareaChanges's setTimeout(0).
    const KEY229_GUARD_MS = 20;

    function readPerceivedCaret(core) {
        const provider = core.__imeAnchorPerceivedCaret;
        if (typeof provider !== 'function') return null;
        try {
            const cell = provider();
            if (cell && Number.isInteger(cell.x) && Number.isInteger(cell.y)) {
                return { x: cell.x, y: cell.y, width: Math.max(1, cell.width || 1) };
            }
        } catch (e) { /* a broken provider must not break anchoring */ }
        return null;
    }

    // RenderService.dimensions throws when no renderer is attached (pre-open,
    // WebGL swap, teardown), and unmeasured cells start at 0x0. Treat both as
    // unavailable so we never throw or falsely mark cold-start as anchored.
    function cellDimensions(core) {
        const rs = core._renderService;
        if (!rs || (typeof rs.hasRenderer === 'function' && !rs.hasRenderer())) return null;
        let cell;
        try { cell = rs.dimensions?.css?.cell; } catch (e) { return null; }
        if (!cell || !Number.isFinite(cell.width) || cell.width <= 0
            || !Number.isFinite(cell.height) || cell.height <= 0) return null;
        return cell;
    }

    function hasBufferModel(core) {
        const buffer = core.buffer || core._bufferService?.buffer;
        const rows = Number.isInteger(core.rows) ? core.rows : core._bufferService?.rows;
        const cols = Number.isInteger(core.cols) ? core.cols : core._bufferService?.cols;
        return !!buffer && Number.isInteger(buffer.x) && Number.isInteger(buffer.y)
            && Number.isInteger(rows) && rows > 0 && Number.isInteger(cols) && cols > 0;
    }

    function clampCell(core, cell) {
        if (!cell) return null;
        if (!hasBufferModel(core)) return cell;
        const rows = Number.isInteger(core.rows) ? core.rows : core._bufferService.rows;
        const cols = Number.isInteger(core.cols) ? core.cols : core._bufferService.cols;
        return {
            x: Math.max(0, Math.min(cell.x, cols - 1)),
            y: Math.max(0, Math.min(cell.y, rows - 1)),
            width: Math.max(1, cell.width || 1),
        };
    }

    // Viewport-relative 0-based protocol cursor cell (accounting for scrollback
    // offset ybase - ydisp). Returns null when the cursor is scrolled off-screen.
    function readProtocolCell(core) {
        if (!hasBufferModel(core)) return null;
        const buffer = core.buffer || core._bufferService.buffer;
        const rows = Number.isInteger(core.rows) ? core.rows : core._bufferService.rows;
        const cols = Number.isInteger(core.cols) ? core.cols : core._bufferService.cols;
        const ybase = Number.isInteger(buffer.ybase) ? buffer.ybase : 0;
        const ydisp = Number.isInteger(buffer.ydisp) ? buffer.ydisp : ybase;
        const viewportY = ybase + buffer.y - ydisp;
        if (viewportY < 0 || viewportY >= rows) return null;
        const x = Math.max(0, Math.min(buffer.x, cols - 1));
        const line = buffer.lines?.get?.(ybase + buffer.y);
        const width = line && typeof line.getWidth === 'function' ? Math.max(1, line.getWidth(x) || 1) : 1;
        return { x, y: viewportY, width };
    }

    function syncTextareaFont(core, textarea) {
        const options = core.options || {};
        if (typeof options.fontFamily === 'string' && options.fontFamily) {
            textarea.style.fontFamily = options.fontFamily;
        }
        if (Number.isFinite(options.fontSize) && options.fontSize > 0) {
            textarea.style.fontSize = options.fontSize + 'px';
        }
    }

    // Position the helper textarea at `cell` with terminal cell & font metrics.
    function anchorTextareaAt(core, cell) {
        const textarea = core.textarea;
        const dims = cellDimensions(core);
        if (!textarea || !dims || !cell) return false;
        const height = dims.height;
        textarea.style.left = (cell.x * dims.width) + 'px';
        textarea.style.top = (cell.y * height) + 'px';
        textarea.style.width = (dims.width * Math.max(1, cell.width || 1)) + 'px';
        textarea.style.height = height + 'px';
        textarea.style.lineHeight = height + 'px';
        textarea.style.zIndex = '-5';
        syncTextareaFont(core, textarea);
        if (!textarea.value && textarea.scrollLeft) textarea.scrollLeft = 0;
        return true;
    }

    // Position both the composition overlay and helper textarea at `cell`.
    function anchorCompositionAt(core, cell) {
        const view = core._compositionView;
        const textarea = core.textarea;
        const dims = cellDimensions(core);
        if (!view || !textarea || !dims || !cell) return false;
        const height = dims.height;
        const left = (cell.x * dims.width) + 'px';
        const top = (cell.y * height) + 'px';
        const options = core.options || {};
        view.style.left = left;
        view.style.top = top;
        view.style.height = height + 'px';
        view.style.lineHeight = height + 'px';
        view.style.fontFamily = options.fontFamily;
        view.style.fontSize = options.fontSize + 'px';
        const rect = typeof view.getBoundingClientRect === 'function'
            ? view.getBoundingClientRect() : { width: 0, height: 0 };
        const cellWidth = dims.width * Math.max(1, cell.width || 1);
        const targetWidth = rect.width > 0 ? rect.width : Math.max(cellWidth, 1);
        const targetHeight = rect.height > 0 ? rect.height : Math.max(height, 1);
        textarea.style.left = left;
        textarea.style.top = top;
        textarea.style.width = Math.max(targetWidth, 1) + 'px';
        textarea.style.height = Math.max(targetHeight, 1) + 'px';
        textarea.style.lineHeight = targetHeight + 'px';
        syncTextareaFont(core, textarea);
        if (!textarea.value && textarea.scrollLeft) textarea.scrollLeft = 0;
        return true;
    }

    function createState(hiddenSettleMs) {
        return {
            disposed: false,
            hasAnchored: false,
            lastCell: null,
            lastSource: 'none', // 'visible' | 'perceived' | 'hidden' | 'none'
            hiddenSettleMs,
            hiddenTimer: null,
            pendingHidden: false,
            compositionTimer: null,
            valueCleanTimer: null,
            bufferActivateTimer: null,
            pendingKey229: 0,
            key229Timers: new Set(),
            disposables: [],
            scrollSubscribed: false,
            scrollLinesPatched: false,
            dimsSubscribed: false,
            dprSubscribed: false,
            charSizeSubscribed: false,
            bufferActivateSubscribed: false,
            willOpenSubscribed: false,
        };
    }

    function cancelHiddenTimer(state) {
        if (state.hiddenTimer !== null) {
            root.clearTimeout(state.hiddenTimer);
            state.hiddenTimer = null;
        }
        state.pendingHidden = false;
    }

    function cancelValueCleanTimer(state) {
        if (state.valueCleanTimer !== null) {
            root.clearTimeout(state.valueCleanTimer);
            state.valueCleanTimer = null;
        }
    }

    function cancelCompositionTimer(state) {
        if (state.compositionTimer !== null) {
            root.clearTimeout(state.compositionTimer);
            state.compositionTimer = null;
        }
    }

    function cancelBufferActivateTimer(state) {
        if (state.bufferActivateTimer !== null) {
            root.clearTimeout(state.bufferActivateTimer);
            state.bufferActivateTimer = null;
        }
    }

    function disposeState(state) {
        if (state.disposed) return;
        state.disposed = true;
        cancelHiddenTimer(state);
        cancelValueCleanTimer(state);
        cancelCompositionTimer(state);
        cancelBufferActivateTimer(state);
        for (const id of state.key229Timers) root.clearTimeout(id);
        state.key229Timers.clear();
        state.pendingKey229 = 0;
        for (const d of state.disposables.splice(0)) {
            try { d?.dispose?.(); } catch (e) { /* teardown must not throw */ }
        }
    }

    function resyncViewportAnchor(core, state) {
        if (state.disposed) return;
        const helper = core._compositionHelper;
        if (helper?.isComposing) helper.updateCompositionElements(true);
        else core._syncTextArea();
    }

    function resyncMetricAnchor(core, coreService, state) {
        if (state.disposed) return;
        const helper = core._compositionHelper;
        if (helper?.isComposing) {
            helper.updateCompositionElements(true);
            return;
        }
        // Re-project the already anchored cell (clamped to current bounds) under
        // the new cell metrics when a transient hidden split is in flight, rather
        // than jumping to the mid-repaint cursor.
        if (coreService.isCursorHidden && !readPerceivedCaret(core) && state.hasAnchored && state.lastCell) {
            const clamped = clampCell(core, state.lastCell);
            state.lastCell = clamped;
            anchorTextareaAt(core, clamped);
            return;
        }
        core._syncTextArea();
    }

    function subscribeLifecycleEvents(term, core, coreService, state) {
        if (!state.scrollSubscribed) {
            const onScroll = typeof term?.onScroll === 'function'
                ? term.onScroll
                : (typeof core.onScroll === 'function' ? core.onScroll : null);
            if (onScroll) {
                const sub = onScroll(() => resyncViewportAnchor(core, state));
                if (sub) state.disposables.push(sub);
                state.scrollSubscribed = true;
            }
        }
        // User mouse-wheel, scrollbar, and touch scrolling in xterm.js calls
        // BufferService.scrollLines(amount, /* suppressScrollEvent */ true),
        // which updates buffer.ydisp without firing onScroll.
        const bs = core._bufferService;
        if (!state.scrollLinesPatched && bs && typeof bs.scrollLines === 'function') {
            const origScrollLines = bs.scrollLines;
            bs.scrollLines = function (disp, suppressScrollEvent) {
                const buf = this.buffer;
                const before = buf ? buf.ydisp : null;
                const res = origScrollLines.apply(this, arguments);
                if (!state.disposed && suppressScrollEvent && buf && buf.ydisp !== before) {
                    resyncViewportAnchor(core, state);
                }
                return res;
            };
            state.disposables.push({
                dispose() {
                    if (bs.scrollLines !== origScrollLines) bs.scrollLines = origScrollLines;
                },
            });
            state.scrollLinesPatched = true;
        }
        if (!state.dimsSubscribed && typeof core._renderService?.onDimensionsChange === 'function') {
            const sub = core._renderService.onDimensionsChange(() => resyncMetricAnchor(core, coreService, state));
            if (sub) state.disposables.push(sub);
            state.dimsSubscribed = true;
        }
        if (!state.dprSubscribed && typeof core._coreBrowserService?.onDprChange === 'function') {
            const sub = core._coreBrowserService.onDprChange(() => resyncMetricAnchor(core, coreService, state));
            if (sub) state.disposables.push(sub);
            state.dprSubscribed = true;
        }
        if (!state.charSizeSubscribed && typeof core._charSizeService?.onCharSizeChange === 'function') {
            const sub = core._charSizeService.onCharSizeChange(() => resyncMetricAnchor(core, coreService, state));
            if (sub) state.disposables.push(sub);
            state.charSizeSubscribed = true;
        }
        const buffers = core.buffers || core._bufferService?.buffers;
        if (!state.bufferActivateSubscribed && typeof buffers?.onBufferActivate === 'function') {
            const sub = buffers.onBufferActivate(() => {
                if (state.disposed) return;
                cancelHiddenTimer(state);
                cancelBufferActivateTimer(state);
                state.hasAnchored = false;
                state.lastCell = null;
                state.lastSource = 'none';
                // Defer resync past the current parse() call: ESC[?1049h fires
                // onBufferActivate mid-chunk before trailing ESC[?25l / CUP in
                // the same chunk have parsed. If onCursorMove anchors at the end
                // of parse(), this fallback sees hasAnchored=true and no-ops; if
                // restored (x,y) matched and onCursorMove skipped, this catches it.
                state.bufferActivateTimer = root.setTimeout(() => {
                    state.bufferActivateTimer = null;
                    if (state.disposed || state.hasAnchored) return;
                    resyncViewportAnchor(core, state);
                }, 0);
            });
            if (sub) state.disposables.push(sub);
            state.bufferActivateSubscribed = true;
        }
    }

    function patchCompositionHelper(term, core, coreService, state) {
        const helper = core._compositionHelper;
        if (!helper || typeof helper.updateCompositionElements !== 'function'
            || typeof helper.isComposing !== 'boolean') {
            return false;
        }
        subscribeLifecycleEvents(term, core, coreService, state);
        if (helper.__imeAnchorPatched) return true;

        const origUpdate = helper.updateCompositionElements.bind(helper);

        function anchorCompositionNow(dontRecurse) {
            if (state.disposed || !helper.isComposing) return;
            if (!coreService.isCursorHidden) {
                cancelHiddenTimer(state);
                if (hasBufferModel(core)) {
                    const proto = readProtocolCell(core);
                    if (proto) {
                        if (anchorCompositionAt(core, proto)) {
                            state.lastCell = proto;
                            state.hasAnchored = true;
                            state.lastSource = 'visible';
                        }
                    } else if (state.lastCell) {
                        const clamped = clampCell(core, state.lastCell);
                        state.lastCell = clamped;
                        anchorCompositionAt(core, clamped);
                    }
                } else {
                    origUpdate(dontRecurse);
                    state.hasAnchored = true;
                    state.lastSource = 'visible';
                    return;
                }
            } else {
                const perc = readPerceivedCaret(core);
                if (perc) {
                    cancelHiddenTimer(state);
                    const clamped = clampCell(core, perc);
                    if (anchorCompositionAt(core, clamped)) {
                        state.lastCell = clamped;
                        state.hasAnchored = true;
                        state.lastSource = 'perceived';
                    }
                } else if (state.hasAnchored && state.lastCell) {
                    // Active composition must hold its established anchor rather
                    // than chase a hidden mid-repaint cursor or spinner park.
                    const clamped = clampCell(core, state.lastCell);
                    state.lastCell = clamped;
                    anchorCompositionAt(core, clamped);
                } else if (hasBufferModel(core)) {
                    const proto = readProtocolCell(core);
                    if (!proto) return;
                    if (anchorCompositionAt(core, proto)) {
                        state.lastCell = proto;
                        state.hasAnchored = true;
                        state.lastSource = 'hidden';
                    }
                } else {
                    origUpdate(dontRecurse);
                    state.hasAnchored = true;
                    state.lastSource = 'hidden';
                    return;
                }
            }
            if (!dontRecurse) {
                cancelCompositionTimer(state);
                state.compositionTimer = root.setTimeout(() => {
                    state.compositionTimer = null;
                    if (!state.disposed) helper.updateCompositionElements(true);
                }, 0);
            }
        }

        helper.updateCompositionElements = anchorCompositionNow;

        if (typeof helper.compositionstart === 'function') {
            const origStart = helper.compositionstart.bind(helper);
            helper.compositionstart = function () {
                cancelValueCleanTimer(state);
                origStart();
                if (state.disposed) return;
                // Permanently-hidden cursor sessions (e.g. kimi without an active
                // software caret) may have advanced their hidden cursor inside the
                // idle settle window right after the previous commit; flush that
                // advance so the next composition never covers committed text.
                // Visible-cursor splits and transient perceived-caret revokes
                // must NOT flush the hidden protocol park.
                if (coreService.isCursorHidden && !readPerceivedCaret(core)) {
                    if (state.pendingHidden && state.lastSource === 'hidden') {
                        cancelHiddenTimer(state);
                        if (hasBufferModel(core)) {
                            const proto = readProtocolCell(core);
                            if (proto) {
                                state.lastCell = proto;
                                state.hasAnchored = true;
                                state.lastSource = 'hidden';
                            }
                        }
                    } else {
                        cancelHiddenTimer(state);
                    }
                }
                anchorCompositionNow(true);
            };
        }

        if (typeof helper.keydown === 'function') {
            const origKeydown = helper.keydown.bind(helper);
            helper.keydown = function (e) {
                const wasComposing = helper.isComposing;
                if (!state.disposed && e && e.keyCode === 229) {
                    // Always cancel any pending post-commit cleanup when an IME
                    // keydown arrives, but only arm the _handleAnyTextareaChanges
                    // guard when idle (matching xterm CompositionHelper.keydown,
                    // which returns false without arming a timer while composing).
                    cancelValueCleanTimer(state);
                    if (!helper.isComposing && !helper._isSendingComposition) {
                        state.pendingKey229 += 1;
                        const tid = root.setTimeout(() => {
                            state.key229Timers.delete(tid);
                            if (state.pendingKey229 > 0) state.pendingKey229 -= 1;
                        }, KEY229_GUARD_MS);
                        state.key229Timers.add(tid);
                    }
                }
                const res = origKeydown(e);
                // Non-229 keydown finalizing composition synchronously via
                // _finalizeComposition(false) must also restore idle cell geometry.
                if (!state.disposed && wasComposing && !helper.isComposing) {
                    cancelCompositionTimer(state);
                    if (state.hasAnchored && state.lastCell) {
                        const clamped = clampCell(core, state.lastCell);
                        state.lastCell = clamped;
                        anchorTextareaAt(core, clamped);
                    }
                    if (!coreService.isCursorHidden || readPerceivedCaret(core)) core._syncTextArea();
                }
                return res;
            };
        }

        if (typeof helper.compositionend === 'function') {
            const origEnd = helper.compositionend.bind(helper);

            function scheduleValueCleanup(delay, retried) {
                cancelValueCleanTimer(state);
                state.valueCleanTimer = root.setTimeout(() => {
                    state.valueCleanTimer = null;
                    if (state.disposed) return;
                    if (helper.isComposing || helper._isSendingComposition) return;
                    if (state.pendingKey229 > 0) {
                        // A fast (< 20ms) single-keystroke composition may end
                        // before its opening idle keydown(229) guard expires:
                        // retry once after KEY229_GUARD_MS (any post-commit
                        // keydown(229) still cancels this timer immediately).
                        if (!retried) scheduleValueCleanup(KEY229_GUARD_MS, true);
                        return;
                    }
                    const textarea = core.textarea;
                    if (!textarea || !textarea.value) return;
                    if (typeof textarea.selectionStart === 'number'
                        && typeof textarea.selectionEnd === 'number'
                        && textarea.selectionStart !== textarea.selectionEnd) return;
                    textarea.value = '';
                    textarea.scrollLeft = 0;
                }, delay);
            }

            helper.compositionend = function () {
                cancelCompositionTimer(state);
                origEnd();
                if (state.disposed) return;
                // Restore normal 1-cell idle geometry immediately (e.g. cancelling
                // a composition with Esc would otherwise leave width at 1px).
                if (state.hasAnchored && state.lastCell) {
                    const clamped = clampCell(core, state.lastCell);
                    state.lastCell = clamped;
                    anchorTextareaAt(core, clamped);
                }
                if (!coreService.isCursorHidden || readPerceivedCaret(core)) core._syncTextArea();

                // Safely clear dead historical textarea.value after xterm's own
                // _finalizeComposition setTimeout(0) has delivered the commit,
                // preventing unbounded scrollLeft growth across long Chinese input.
                scheduleValueCleanup(0, false);
            };
        }

        helper.__imeAnchorPatched = true;
        return true;
    }

    function patchTerminal(term, options) {
        const log = options?.warn || (root.console || console);
        const core = term && term._core;
        const coreService = core && core.coreService;
        if (!core || typeof core._syncTextArea !== 'function' || !coreService
            || typeof coreService.isCursorHidden !== 'boolean') {
            log.warn('[ime-caret-anchor] xterm internals changed; IME anchor patch not applied');
            return false;
        }
        if (typeof options?.perceivedCaret === 'function') {
            core.__imeAnchorPerceivedCaret = options.perceivedCaret;
        }
        const hiddenSettleMs = Number.isFinite(options?.hiddenSettleMs) && options.hiddenSettleMs >= 0
            ? options.hiddenSettleMs : DEFAULT_HIDDEN_SETTLE_MS;

        let state = core.__imeAnchorState;
        if (!state) {
            state = createState(hiddenSettleMs);
            core.__imeAnchorState = state;
            if (typeof core.register === 'function') {
                core.register({ dispose() { disposeState(state); } });
            }
        } else {
            state.hiddenSettleMs = hiddenSettleMs;
        }

        if (!core.__imeAnchorSyncPatched) {
            const origSync = core._syncTextArea.bind(core);

            function applyProtocolIdleSync(sourceTag) {
                if (hasBufferModel(core)) {
                    const proto = readProtocolCell(core);
                    if (!proto) return false;
                    if (anchorTextareaAt(core, proto)) {
                        state.hasAnchored = true;
                        state.lastCell = proto;
                        state.lastSource = sourceTag;
                        return true;
                    }
                    return false;
                }
                origSync();
                state.hasAnchored = true;
                state.lastSource = sourceTag;
                return true;
            }

            core._syncTextArea = function () {
                if (state.disposed) return;
                // Match stock _syncTextArea: no textarea writes during composition.
                if (core._compositionHelper?.isComposing) return;

                if (!coreService.isCursorHidden) {
                    cancelHiddenTimer(state);
                    applyProtocolIdleSync('visible');
                    return;
                }

                const perc = readPerceivedCaret(core);
                if (perc) {
                    cancelHiddenTimer(state);
                    const clamped = clampCell(core, perc);
                    if (anchorTextareaAt(core, clamped)) {
                        state.hasAnchored = true;
                        state.lastCell = clamped;
                        state.lastSource = 'perceived';
                    }
                    return;
                }

                // Hidden protocol cursor with no perceived caret:
                // Cold-start sessions anchor immediately so textarea never strands
                // at CSS left: -9999em; already-anchored sessions debounce so split
                // ?25l...?25h repaints and multi-block menu redraws never teleport.
                if (!state.hasAnchored) {
                    cancelHiddenTimer(state);
                    applyProtocolIdleSync('hidden');
                    return;
                }

                cancelHiddenTimer(state);
                if (state.hiddenSettleMs === 0) {
                    applyProtocolIdleSync('hidden');
                    return;
                }
                state.pendingHidden = true;
                state.hiddenTimer = root.setTimeout(() => {
                    state.hiddenTimer = null;
                    state.pendingHidden = false;
                    if (state.disposed || core._compositionHelper?.isComposing) return;
                    if (!coreService.isCursorHidden) {
                        applyProtocolIdleSync('visible');
                        return;
                    }
                    const livePerc = readPerceivedCaret(core);
                    if (livePerc) {
                        const clamped = clampCell(core, livePerc);
                        if (anchorTextareaAt(core, clamped)) {
                            state.hasAnchored = true;
                            state.lastCell = clamped;
                            state.lastSource = 'perceived';
                        }
                        return;
                    }
                    applyProtocolIdleSync('hidden');
                }, state.hiddenSettleMs);
            };
            core.__imeAnchorSyncPatched = true;
        }

        subscribeLifecycleEvents(term, core, coreService, state);

        if (patchCompositionHelper(term, core, coreService, state)) return true;
        if (typeof core.onWillOpen === 'function') {
            if (!state.willOpenSubscribed) {
                state.willOpenSubscribed = true;
                const sub = core.onWillOpen(() => {
                    sub.dispose();
                    if (state.disposed) return;
                    if (!patchCompositionHelper(term, core, coreService, state)) {
                        log.warn('[ime-caret-anchor] CompositionHelper missing after open; composition anchor not patched');
                    }
                });
                if (sub) state.disposables.push(sub);
            }
            return true;
        }
        log.warn('[ime-caret-anchor] xterm internals changed; composition anchor patch not applied');
        return false;
    }

    const api = { patchTerminal, DEFAULT_HIDDEN_SETTLE_MS };
    root.__imeCaretAnchor = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
