// IME caret anchor: keep the OS IME candidate window on the caret the user
// actually SEES. xterm anchors its helper textarea (the rect Chromium reports
// to the IME) to the PROTOCOL cursor on every cursor move (_syncTextArea,
// wired to onCursorMove), and during composition re-anchors both the
// composition view and the textarea to the protocol cursor on every render
// (CompositionHelper.updateCompositionElements) — neither checks visibility.
// Agent TUIs (kimi thinking/working) hide the protocol cursor for the whole
// session and park it next to their spinner on every frame, so:
//   - stock behavior: the candidate window chases the spinner park
//     (field report: candidate flies to the thinking line while typing);
//   - naive "freeze while hidden" (first fix, field regression 2026-09-18):
//     kimi never un-hides the protocol cursor, so the anchor stranded at the
//     textarea's DOM default (screen top-left) for the entire session.
// The caret the user perceives in those TUIs is the app-drawn one, already
// tracked by the smooth-cursor adapter (xterm-smooth-cursor.js). Policy:
//   - protocol cursor visible            -> stock xterm anchoring;
//   - hidden + adapter-owned caret known -> anchor both elements at THAT cell;
//   - hidden + no known caret            -> STOCK protocol anchoring.
// The third branch used to freeze instead (field regression 2026-09-18):
// kimi builds that paint no caret (and every session before the adapter's
// two-unit trust engages, and every revoke gap after a commit) left the
// anchor stranded — at the textarea's DOM default (screen top-left) on a
// fresh session, or on a just-overwritten cell after a commit, so the next
// composition covered the committed text. Live probe evidence
// (scripts/_ime-anchor-probe.mjs): during input phases the protocol cursor
// tracks the insertion point exactly (per-commit advance, constant input
// row), so stock anchoring is correct there; the known gap is composing
// during a spinner/thinking animation with NO trusted caret — stock then
// follows the animation park, i.e. the pre-fix baseline, never worse.
//
// This patches xterm internals from the outside (_core._syncTextArea,
// _core._compositionHelper.updateCompositionElements, coreService
// .isCursorHidden) so the vendored bundle stays mechanically extracted.
// _syncTextArea is patched immediately; _compositionHelper only exists
// after open(), so its patch defers to the one-shot onWillOpen event (fired
// inside open() after the helper is created). If a vendor refresh renames
// the internals, patchTerminal returns false and warns loudly — the native
// E2E check in scripts/e2e-check.mjs pins the behavior so the regression
// cannot ship silently.
//
// options.perceivedCaret: () => ({x, y, width?} | null), viewport-relative
// 0-based cell of the user-perceived caret (the smooth-cursor adapter's
// published descriptor). Stored on core.__imeAnchorPerceivedCaret and read
// dynamically so diagnostics/E2E can swap it.
(function installImeCaretAnchor(root) {
    'use strict';

    function readPerceivedCaret(core) {
        const provider = core.__imeAnchorPerceivedCaret;
        if (typeof provider !== 'function') return null;
        try {
            const cell = provider();
            if (cell && Number.isInteger(cell.x) && Number.isInteger(cell.y)) return cell;
        } catch (e) { /* a broken provider must not break anchoring */ }
        return null;
    }

    function cellDimensions(core) {
        return core._renderService?.dimensions?.css?.cell;
    }

    // Same math as stock _syncTextArea, but at the perceived caret cell.
    function anchorTextareaAt(core, cell) {
        const textarea = core.textarea;
        const dims = cellDimensions(core);
        if (!textarea || !dims) return false;
        const height = dims.height;
        textarea.style.left = (cell.x * dims.width) + 'px';
        textarea.style.top = (cell.y * height) + 'px';
        textarea.style.width = (dims.width * Math.max(1, cell.width || 1)) + 'px';
        textarea.style.height = height + 'px';
        textarea.style.lineHeight = height + 'px';
        textarea.style.zIndex = '-5';
        return true;
    }

    // Same math as stock updateCompositionElements, but at the perceived
    // caret cell (the stock version re-anchors to the hidden protocol cursor
    // on every render — that is the flying-candidate mechanism).
    function anchorCompositionAt(core, cell) {
        const view = core._compositionView;
        const textarea = core.textarea;
        const dims = cellDimensions(core);
        if (!view || !textarea || !dims) return false;
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
            ? view.getBoundingClientRect() : { width: 1, height };
        textarea.style.left = left;
        textarea.style.top = top;
        textarea.style.width = Math.max(rect.width, 1) + 'px';
        textarea.style.height = Math.max(rect.height, 1) + 'px';
        textarea.style.lineHeight = rect.height + 'px';
        return true;
    }

    function patchCompositionHelper(core, coreService) {
        const helper = core._compositionHelper;
        if (!helper || typeof helper.updateCompositionElements !== 'function') return false;
        if (helper.__imeAnchorPatched) return true;
        const update = helper.updateCompositionElements.bind(helper);
        helper.updateCompositionElements = function (dontRecurse) {
            const cell = coreService.isCursorHidden ? readPerceivedCaret(core) : null;
            if (!cell) { update(dontRecurse); return; }
            anchorCompositionAt(core, cell);
            if (!dontRecurse) root.setTimeout(() => helper.updateCompositionElements(true), 0);
        };
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
        if (!core.__imeAnchorSyncPatched) {
            const sync = core._syncTextArea.bind(core);
            core._syncTextArea = function () {
                const cell = coreService.isCursorHidden ? readPerceivedCaret(core) : null;
                if (!cell) { sync(); return; }
                anchorTextareaAt(core, cell);
            };
            core.__imeAnchorSyncPatched = true;
        }
        if (patchCompositionHelper(core, coreService)) return true;
        if (typeof core.onWillOpen === 'function') {
            const sub = core.onWillOpen(() => {
                sub.dispose();
                if (!patchCompositionHelper(core, coreService)) {
                    log.warn('[ime-caret-anchor] CompositionHelper missing after open; composition anchor not patched');
                }
            });
            return true;
        }
        log.warn('[ime-caret-anchor] xterm internals changed; composition anchor patch not applied');
        return false;
    }

    const api = { patchTerminal };
    root.__imeCaretAnchor = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
