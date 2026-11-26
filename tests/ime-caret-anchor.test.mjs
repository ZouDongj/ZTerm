// Unit and vendored-parser tests for the IME caret anchor patch and helper
// textarea CSS isolation.
//
// Policy under test:
//   - Helper textarea & composition view must have zero CSS transition lag and
//     zero focus-visible ring override, syncing terminal font metrics so TSF
//     reads exact layout bounds immediately.
//   - All protocol anchoring computes viewport row = ybase + y - ydisp and
//     guards against detached/unmeasured renderers.
//   - Visible protocol cursor -> immediate anchor at protocol cell.
//   - Hidden protocol cursor + perceived caret -> immediate anchor at perceived cell.
//   - Hidden protocol cursor + no perceived caret:
//       * During active composition -> hold the established anchor (clamped to
//         current bounds; never jump to mid-repaint split frames or spinner parks;
//         cold-start hidden sessions anchor once so they never strand at -9999em).
//       * While idle -> cold start anchors immediately; subsequent hidden moves
//         debounce through a short settle window so split ESC[?25l...ESC[?25h
//         frames and multi-block redraws (Kimi menu/status) never teleport the
//         textarea, while permanently-hidden sessions settle cleanly and flush
//         on fast consecutive compositionstart.
//   - Lifecycle sync: reset anchor state across normal/alternate buffer switches,
//     re-anchor on compositionstart, scroll (including mouse-wheel/scrollbar
//     suppressScrollEvent scrolls), dimension/DPR/charSize changes, restore
//     1-cell idle geometry on compositionend & non-229 keydown exit, safely
//     clear dead textarea.value / scrollLeft after real keyboard commits while
//     protecting post-commit keydown(229) punctuation, and dispose cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../src/renderer/ime-caret-anchor.js');
require('../src/vendor/xterm.js');
const { Terminal: BundledTerminal } = globalThis.TabbyXterm;

function createEmitter() {
    const listeners = [];
    const event = listener => {
        listeners.push(listener);
        return {
            dispose() {
                const idx = listeners.indexOf(listener);
                if (idx >= 0) listeners.splice(idx, 1);
            },
        };
    };
    const fire = arg => { for (const l of [...listeners]) l(arg); };
    return { event, fire, count: () => listeners.length };
}

function fakeTerm({
    withHelper = true,
    withOnWillOpen = false,
    withBuffer = false,
    cols = 80,
    rows = 24,
    x = 0,
    y = 0,
    ybase = 0,
    ydisp = 0,
    cellWidth = 8,
    cellHeight = 18,
    hasRenderer = true,
    lineWidths = null,
} = {}) {
    const calls = { sync: 0, update: [], rects: 0, compStart: 0, compEnd: 0, keydown: 0 };
    const willOpen = createEmitter();
    const scroll = createEmitter();
    const dimsChange = createEmitter();
    const dprChange = createEmitter();
    const charSizeChange = createEmitter();
    const bufferActivate = createEmitter();
    const disposables = [];
    let rendererPresent = hasRenderer;
    const view = {
        style: {},
        textContent: '',
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); },
        },
        getBoundingClientRect() {
            calls.rects += 1;
            // Match Chromium: empty composition-view has 0px width.
            const w = view.textContent ? Math.max(10, view.textContent.length * 10) : 0;
            return { width: w, height: view.textContent ? cellHeight : 0 };
        },
    };
    const textarea = {
        style: {},
        value: '',
        scrollLeft: 0,
        selectionStart: 0,
        selectionEnd: 0,
    };
    const dims = { width: cellWidth, height: cellHeight };
    const renderService = {
        hasRenderer() { return rendererPresent; },
        get dimensions() {
            if (!rendererPresent) throw new TypeError('Cannot read properties of undefined (reading dimensions)');
            return { css: { cell: dims } };
        },
        onDimensionsChange: dimsChange.event,
    };
    const core = {
        coreService: { isCursorHidden: false },
        options: { fontFamily: 'TestMono', fontSize: 16 },
        textarea,
        _renderService: renderService,
        _coreBrowserService: { onDprChange: dprChange.event },
        _charSizeService: { onCharSizeChange: charSizeChange.event },
        buffers: { onBufferActivate: bufferActivate.event },
        _compositionView: view,
        _syncTextArea() { calls.sync += 1; },
        onScroll: scroll.event,
        register(d) { disposables.push(d); return d; },
        dispose() { for (const d of disposables.splice(0)) d?.dispose?.(); },
    };
    if (withBuffer) {
        core.cols = cols;
        core.rows = rows;
        core.buffer = {
            x, y, ybase, ydisp,
            lines: {
                get(absRow) {
                    return {
                        getWidth(col) {
                            if (lineWidths && typeof lineWidths[absRow + ':' + col] === 'number') {
                                return lineWidths[absRow + ':' + col];
                            }
                            return 1;
                        },
                    };
                },
            },
            get isCursorInViewport() {
                const vy = this.ybase + this.y - this.ydisp;
                return vy >= 0 && vy < core.rows;
            },
        };
        core._bufferService = {
            get buffer() { return core.buffer; },
            get rows() { return core.rows; },
            get cols() { return core.cols; },
            buffers: core.buffers,
            scrollLines(amount, suppressScrollEvent) {
                const b = core.buffer;
                const prev = b.ydisp;
                b.ydisp = Math.max(0, Math.min(b.ydisp + amount, b.ybase));
                if (b.ydisp !== prev && !suppressScrollEvent) scroll.fire(b.ydisp);
            },
        };
    }
    if (withHelper) {
        core._compositionHelper = {
            _isComposing: false,
            _isSendingComposition: false,
            get isComposing() { return this._isComposing; },
            set isComposing(v) { this._isComposing = !!v; },
            compositionstart() {
                calls.compStart += 1;
                this._isComposing = true;
                view.textContent = '';
                view.classList.add('active');
            },
            compositionend() {
                calls.compEnd += 1;
                this._isComposing = false;
                view.classList.remove('active');
                this._isSendingComposition = true;
                setTimeout(() => { this._isSendingComposition = false; }, 0);
            },
            keydown(e) {
                calls.keydown += 1;
                if (this._isComposing || this._isSendingComposition) {
                    if (e?.keyCode === 229) return false;
                    if (e?.keyCode === 16 || e?.keyCode === 17 || e?.keyCode === 18) return false;
                    this._isComposing = false;
                    this._isSendingComposition = false;
                    view.classList.remove('active');
                }
                return e?.keyCode !== 229;
            },
            updateCompositionElements(dontRecurse) { calls.update.push(dontRecurse); },
        };
    }
    if (withOnWillOpen) {
        core.onWillOpen = willOpen.event;
    }
    const term = { _core: core, onScroll: scroll.event, dispose: () => core.dispose() };
    return {
        term, core, calls, dims,
        setHasRenderer: v => { rendererPresent = v; },
        fireWillOpen: () => willOpen.fire(),
        fireScroll: () => scroll.fire(),
        fireDimsChange: () => dimsChange.fire(),
        fireDprChange: () => dprChange.fire(),
        fireCharSizeChange: () => charSizeChange.fire(),
        fireBufferActivate: () => bufferActivate.fire(),
        listenerCounts: () => ({
            scroll: scroll.count(),
            dims: dimsChange.count(),
            dpr: dprChange.count(),
            charSize: charSizeChange.count(),
            bufferActivate: bufferActivate.count(),
        }),
    };
}

test('app.css excludes .xterm-helper-textarea from global textarea transitions and focus rings', () => {
    const css = readFileSync(new URL('../src/renderer/app.css', import.meta.url), 'utf8');
    // No bare textarea or [tabindex] focus-visible selector leaks onto helper textarea.
    assert.doesNotMatch(css, /button,input,select,textarea,/);
    assert.doesNotMatch(css, /select:focus-visible,input:focus-visible,textarea:focus-visible,/);
    assert.doesNotMatch(css, /\[tabindex\]:focus-visible/);
    assert.doesNotMatch(css, /^textarea\{font-family:inherit\}/m);
    assert.match(css, /\[tabindex\]:not\(\.xterm-helper-textarea\):focus-visible/);
    // Explicit defensive isolation rule on xterm helper elements.
    assert.match(css, /\.xterm \.xterm-helper-textarea[\s\S]*?transition:\s*none/);
    assert.match(css, /\.xterm \.composition-view[\s\S]*?transition:\s*none/);
});

test('idle composition guard reads the public isComposing getter', () => {
    const { term, core, calls } = fakeTerm();
    core._compositionHelper._isComposing = true;
    Object.defineProperty(core._compositionHelper, 'isComposing', { get: () => false });
    core.coreService.isCursorHidden = true;
    core.__imeAnchorPerceivedCaret = () => ({ x: 2, y: 1 });
    assert.equal(api.patchTerminal(term), true);
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(calls.rects, 0, 'composing must return before touching the composition view');
});

test('visible cursor without buffer model: both anchors delegate to xterm', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term), true);
    core._syncTextArea();
    core._compositionHelper.isComposing = true;
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(calls.sync, 1);
    assert.deepEqual(calls.update, [true]);
});

test('detached or unmeasured renderer never throws and does not falsely mark cold-start as anchored', () => {
    const { term, core, dims, setHasRenderer } = fakeTerm({
        withBuffer: true, x: 5, y: 21, hasRenderer: false,
    });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 30 }), true);
    core.coreService.isCursorHidden = true;
    // Detached renderer: RenderService.dimensions would throw if unguarded.
    assert.doesNotThrow(() => core._syncTextArea());
    assert.equal(core.textarea.style.left, undefined);

    // Attached renderer with unmeasured 0x0 cell: must not anchor at (0,0) or latch hasAnchored.
    setHasRenderer(true);
    dims.width = 0;
    dims.height = 0;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, undefined);

    // Once real cell metrics arrive, cold-start hidden cursor still anchors immediately.
    dims.width = 8;
    dims.height = 18;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '40px');
    assert.equal(core.textarea.style.top, '378px');
    core.dispose();
});

test('cold-start hidden cursor without perceived caret anchors immediately so it never strands top-left', () => {
    const { term, core, calls } = fakeTerm({ withBuffer: true, x: 5, y: 21 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 30 }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 0);
    assert.equal(core.textarea.style.left, '40px', 'cold hidden session must not stay at CSS -9999em');
    assert.equal(core.textarea.style.top, '378px');
    core.dispose();
});

test('split ESC[?25l...ESC[?25h redraw while composing holds established anchor and ignores mid-frame park', () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 14, y: 31, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 30 }), true);
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '112px');
    assert.equal(core.textarea.style.top, '558px');

    // Empty compositionstart must keep 1-cell width (8px), not collapse to 1px when view rect is 0x0.
    core._compositionHelper.compositionstart();
    assert.equal(core._compositionView.style.left, '112px');
    assert.equal(core._compositionView.style.top, '558px');
    assert.equal(core.textarea.style.width, '8px', 'empty compositionstart falls back to 1-cell width');
    assert.equal(core.textarea.style.height, '18px', 'empty compositionstart falls back to cell height');

    core._compositionView.textContent = 'nihao';
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(core.textarea.style.width, '50px');

    // ConPTY splits a large ESC[?25l ... ESC[?25h repaint: cursor hidden at (55, 18), perceivedCaret=null.
    core.coreService.isCursorHidden = true;
    core.buffer.x = 55;
    core.buffer.y = 18;
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(core._compositionView.style.left, '112px', 'composition view must not fly to mid-repaint col 55');
    assert.equal(core._compositionView.style.top, '558px', 'composition view must not fly to mid-repaint row 18');
    assert.equal(core.textarea.style.left, '112px', 'textarea must not fly to mid-repaint col 55');
    assert.equal(core.textarea.style.top, '558px', 'textarea must not fly to mid-repaint row 18');

    // Another split chunk at (0, 4).
    core.buffer.x = 0;
    core.buffer.y = 4;
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(core._compositionView.style.left, '112px');
    assert.equal(core._compositionView.style.top, '558px');

    // Second chunk finishes with ESC[?25h back at (14, 31).
    core.coreService.isCursorHidden = false;
    core.buffer.x = 14;
    core.buffer.y = 31;
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(core._compositionView.style.left, '112px');
    assert.equal(core._compositionView.style.top, '558px');
    core.dispose();
});

test('idle transient ESC[?25l...ESC[?25h split never teleports textarea to mid-repaint cell', async () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 14, y: 31, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 35 }), true);
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '112px');
    assert.equal(core.textarea.style.top, '558px');

    // Chunk 1 ends mid-frame with cursor hidden at (55, 18).
    core.coreService.isCursorHidden = true;
    core.buffer.x = 55;
    core.buffer.y = 18;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '112px', 'must not teleport immediately on transient hide');
    assert.equal(core.textarea.style.top, '558px');

    // Chunk 2 arrives 10ms later with ESC[?25h back at (15, 31), cancelling the settle timer.
    await new Promise(r => setTimeout(r, 10));
    core.coreService.isCursorHidden = false;
    core.buffer.x = 15;
    core.buffer.y = 31;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '120px');
    assert.equal(core.textarea.style.top, '558px');

    // Waiting past the settle window must not fire a stale hidden sync.
    await new Promise(r => setTimeout(r, 50));
    assert.equal(core.textarea.style.left, '120px');
    assert.equal(core.textarea.style.top, '558px');
    core.dispose();
});

test('compositionstart during transient ?25l split or transient perceived-caret revoke keeps prior anchor', () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 14, y: 31, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 40 }), true);
    // Case 1: visible session with mid-frame ?25l split in flight.
    core._syncTextArea();
    core.coreService.isCursorHidden = true;
    core.buffer.x = 55;
    core.buffer.y = 18;
    core._syncTextArea();
    core._compositionHelper.compositionstart();
    assert.equal(core._compositionView.style.left, '112px', 'must not flush mid-repaint cell for visible session');
    assert.equal(core._compositionView.style.top, '558px');
    core._compositionHelper.isComposing = false;

    // Case 2: perceived software-caret session transiently revoked (< 40ms) on spinner/scroll.
    let perc = { x: 8, y: 20, width: 1 };
    core.__imeAnchorPerceivedCaret = () => perc;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '64px');
    assert.equal(core.textarea.style.top, '360px');
    perc = null;
    core.buffer.x = 0;
    core.buffer.y = 33;
    core._syncTextArea();
    core._compositionHelper.compositionstart();
    assert.equal(core._compositionView.style.left, '64px', 'transient perceived revoke must not flush hidden park');
    assert.equal(core._compositionView.style.top, '360px');
    core.dispose();
});

test('permanently-hidden agent (Kimi): coalesces menu/status bounce and flushes fast consecutive commits', async () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 6, y: 23, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 25 }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '48px');
    assert.equal(core.textarea.style.top, '414px');

    // Menu/status redraw bounces hidden cursor to (0, 33) then to (7, 21).
    core.buffer.x = 0;
    core.buffer.y = 33;
    core._syncTextArea();
    assert.equal(core.textarea.style.top, '414px', 'must not immediately jump to bottom status row 33');

    core.buffer.x = 7;
    core.buffer.y = 21;
    core._syncTextArea();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.style.left, '56px', 'settled cleanly at new input cell (7, 21)');
    assert.equal(core.textarea.style.top, '378px');

    // Fast consecutive Chinese commit (< settleMs): hidden session flushes on compositionstart.
    core.buffer.x = 11;
    core.buffer.y = 21;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '56px', 'still waiting inside idle settle window');
    core._compositionHelper.compositionstart();
    assert.equal(core._compositionView.style.left, '88px', 'hidden session flushes advance on compositionstart');
    assert.equal(core._compositionView.style.top, '378px');
    assert.equal(core.textarea.style.left, '88px');
    core.dispose();
});

test('buffer switch (normal <-> alternate) resets stale anchor state and re-anchors after parse', async () => {
    const { term, core, fireBufferActivate } = fakeTerm({ withBuffer: true, x: 20, y: 28, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 40 }), true);
    // Visible pwsh prompt at (20, 28).
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '160px');
    assert.equal(core.textarea.style.top, '504px');

    // Launching a hidden-cursor alt-buffer TUI at (4, 10): onBufferActivate fires
    // mid-parse before ?25l / CUP parse; subsequent _syncTextArea cold-anchors immediately.
    fireBufferActivate();
    core.coreService.isCursorHidden = true;
    core.buffer.x = 4;
    core.buffer.y = 10;
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '32px', 'alt-buffer entry cold-anchors immediately');
    assert.equal(core.textarea.style.top, '180px');

    // Exiting alt buffer back to normal buffer with matching (x,y) (no onCursorMove):
    // deferred bufferActivateTimer still re-anchors with updated ybase/ydisp.
    core.coreService.isCursorHidden = false;
    core.buffer.x = 20;
    core.buffer.y = 28;
    fireBufferActivate();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(core.textarea.style.left, '160px');
    assert.equal(core.textarea.style.top, '504px');
    core.dispose();
});

test('viewport scroll offset: ydisp !== ybase uses (ybase + y - ydisp) and resyncs on wheel scroll', () => {
    const { term, core } = fakeTerm({
        withBuffer: true, x: 10, y: 15, ybase: 18, ydisp: 10, rows: 34, cols: 128,
    });
    assert.equal(api.patchTerminal(term), true);
    // Visual row = 18 + 15 - 10 = 23 (NOT buffer.y = 15!).
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '80px');
    assert.equal(core.textarea.style.top, (23 * 18) + 'px', 'must include ybase - ydisp offset');

    // Mouse-wheel / scrollbar scroll calls scrollLines(..., suppressScrollEvent=true).
    core._bufferService.scrollLines(-2, true);
    assert.equal(core.textarea.style.top, (25 * 18) + 'px', 'suppressScrollEvent=true must still resync textarea');

    // Scrolling back to bottom via wheel restores row 15.
    core._bufferService.scrollLines(10, true);
    assert.equal(core.buffer.ydisp, 18);
    assert.equal(core.textarea.style.top, (15 * 18) + 'px');

    // Off-screen cursor does not write out-of-bounds top.
    core.buffer.y = 33;
    core._bufferService.scrollLines(-18, false);
    assert.equal(core.textarea.style.top, (15 * 18) + 'px', 'off-screen cursor keeps previous top');
    core._bufferService.scrollLines(18, false);
    assert.equal(core.textarea.style.top, (33 * 18) + 'px', 'scroll back to bottom re-anchors textarea');
    core.dispose();
});

test('dimensions, DPR, charSize, and shrinking resize re-anchor and clamp lastCell', () => {
    const { term, core, dims, fireDimsChange, fireDprChange, fireCharSizeChange } = fakeTerm({
        withBuffer: true, x: 90, y: 30, rows: 34, cols: 128, cellWidth: 8, cellHeight: 18,
    });
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 40 }), true);
    core._syncTextArea();
    assert.equal(core.textarea.style.left, '720px');
    assert.equal(core.textarea.style.top, '540px');

    // DPR change (moving to 125%/150% monitor) updates metrics without firing onDimensionsChange.
    dims.width = 10;
    dims.height = 22;
    core.options.fontSize = 18;
    fireDprChange();
    assert.equal(core.textarea.style.left, '900px');
    assert.equal(core.textarea.style.top, '660px');
    assert.equal(core.textarea.style.fontSize, '18px');

    // Char size re-measure updates textarea too.
    dims.width = 9;
    dims.height = 20;
    fireCharSizeChange();
    assert.equal(core.textarea.style.left, '810px');
    assert.equal(core.textarea.style.top, '600px');

    // Shrinking pane (128x34 -> 60x20) while transient hidden split is in flight clamps lastCell (90,30) -> (59,19).
    core.coreService.isCursorHidden = true;
    core.buffer.x = 5;
    core.buffer.y = 2;
    core._syncTextArea();
    core.cols = 60;
    core.rows = 20;
    dims.width = 10;
    dims.height = 20;
    fireDimsChange();
    assert.equal(core.textarea.style.left, '590px', 'clamped to new cols - 1, not hidden park or out-of-bounds col 90');
    assert.equal(core.textarea.style.top, '380px', 'clamped to new rows - 1');
    core.dispose();
});

test('keyboard IME commits (keydown(229) before compositionend) still restore 1-cell width and clear textarea.value', async () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 2, y: 31, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term), true);
    core._syncTextArea();

    // Case 1: Normal keyboard commit (idle keydown(229) -> compositionstart -> >20ms -> commit keydown(229) -> compositionend).
    core._compositionHelper.keydown({ keyCode: 229 });
    core._compositionHelper.compositionstart();
    core._compositionView.textContent = 'diyiju';
    core._compositionHelper.updateCompositionElements(true);
    await new Promise(r => setTimeout(r, 25));
    core.textarea.value = '第一句测试中文';
    core.textarea.selectionStart = core.textarea.selectionEnd = 7;
    core.textarea.scrollLeft = 96;
    // Candidate selection keystroke (Space / 1 / Enter) fires keydown(229) while isComposing === true.
    core._compositionHelper.keydown({ keyCode: 229 });
    core._compositionHelper.compositionend();

    assert.equal(core.textarea.style.width, '8px', 'idle width restored immediately');
    assert.equal(core.textarea.value, '第一句测试中文', 'never clear before _finalizeComposition sends');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(core.textarea.value, '', 'keyboard commit must clear dead textarea.value');
    assert.equal(core.textarea.scrollLeft, 0, 'keyboard commit must reset scrollLeft');

    // Case 2: Super-fast (< 20ms) single-keystroke composition whose opening idle keydown(229) guard is still draining.
    core._compositionHelper.keydown({ keyCode: 229 });
    core._compositionHelper.compositionstart();
    core.textarea.value = '快';
    core.textarea.selectionStart = core.textarea.selectionEnd = 1;
    core._compositionHelper.keydown({ keyCode: 229 });
    core._compositionHelper.compositionend();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.value, '', 'fast composition retries cleanup once opening key229 guard drains');

    // Case 3: Non-229 keydown finalizing composition synchronously restores idle 1-cell width.
    core._compositionHelper.compositionstart();
    core._compositionView.textContent = 'nihao';
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(core.textarea.style.width, '50px');
    core._compositionHelper.keydown({ keyCode: 37 }); // ArrowLeft exits composition synchronously
    assert.equal(core._compositionHelper.isComposing, false);
    assert.equal(core.textarea.style.width, '8px', 'non-229 composition exit restores 1-cell width');
    core.dispose();
});

test('textarea.value cleanup aborts if post-commit keydown(229), new composition, or selection is active', async () => {
    const { term, core } = fakeTerm({ withBuffer: true, x: 2, y: 31, rows: 34, cols: 128 });
    assert.equal(api.patchTerminal(term), true);
    core._syncTextArea();

    // Case 1: post-commit keydown(229) (e.g. Chinese punctuation) cancels cleanup.
    core._compositionHelper.compositionstart();
    core.textarea.value = '测试，';
    core.textarea.selectionStart = core.textarea.selectionEnd = 3;
    core._compositionHelper.compositionend();
    core._compositionHelper.keydown({ keyCode: 229 });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.value, '测试，', 'post-commit keydown(229) must cancel value cleanup');

    // Case 2: back-to-back composition starts before cleanup runs.
    core._compositionHelper.compositionstart();
    core.textarea.value = '测试，nihao';
    core.textarea.selectionStart = core.textarea.selectionEnd = 8;
    core._compositionHelper.compositionend();
    core._compositionHelper.compositionstart();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.value, '测试，nihao', 'new composition must abort prior value cleanup');
    core._compositionHelper.isComposing = false;

    // Case 3: active selection in textarea (e.g. Linux middle-click selection mirror).
    core.textarea.selectionStart = 0;
    core.textarea.selectionEnd = 4;
    core._compositionHelper.compositionend();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.value, '测试，nihao', 'active selection must never be wiped');
    core.dispose();
});

test('hidden cursor + perceived caret: textarea anchors at the caret cell with terminal font', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 5, y: 3, width: 2 }) }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 0, 'stock protocol anchoring stays skipped while hidden');
    assert.deepEqual(core.textarea.style, {
        left: '40px',
        top: '54px',
        width: '16px',
        height: '18px',
        lineHeight: '18px',
        zIndex: '-5',
        fontFamily: 'TestMono',
        fontSize: '16px',
    });
    core.dispose();
});

test('hidden cursor + perceived caret: idle renders do not reflow or resize', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 2, y: 1 }) }), true);
    core.coreService.isCursorHidden = true;
    core.textarea.style.width = '24px';
    core.textarea.style.height = '18px';
    core._compositionHelper.updateCompositionElements();
    core._compositionHelper.updateCompositionElements();
    assert.equal(calls.rects, 0, 'stock skips updateCompositionElements while not composing');
    assert.equal(core.textarea.style.width, '24px', 'idle textarea width must not be rewritten');
    assert.equal(core.textarea.style.height, '18px', 'idle textarea height must not be rewritten');
    core.dispose();
});

test('hidden cursor + perceived caret: sync skips while composing', () => {
    const { term, core } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 4, y: 2, width: 1 }) }), true);
    core.coreService.isCursorHidden = true;
    core._compositionHelper.isComposing = true;
    core._syncTextArea();
    assert.deepEqual(core.textarea.style, {}, 'stock _syncTextArea returns while composing');
    core.dispose();
});

test('hidden cursor + perceived caret: composition view anchors at the caret cell', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 2, y: 7 }) }), true);
    core.coreService.isCursorHidden = true;
    core._compositionHelper.isComposing = true;
    core._compositionView.textContent = 'nihao';
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [], 'stock composition anchoring stays skipped while hidden');
    assert.equal(core._compositionView.style.left, '16px');
    assert.equal(core._compositionView.style.top, '126px');
    assert.equal(core._compositionView.style.fontFamily, 'TestMono');
    assert.equal(core._compositionView.style.fontSize, '16px');
    assert.equal(core.textarea.style.left, '16px');
    assert.equal(core.textarea.style.top, '126px');
    assert.equal(core.textarea.style.width, '50px', 'textarea tracks the composition view rect');
    assert.equal(core.textarea.style.fontFamily, 'TestMono');
    assert.equal(core.textarea.style.fontSize, '16px');
    core.dispose();
});

test('provider is read dynamically: swap, broken providers, and settle fallback', async () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 15 }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 1);
    core.__imeAnchorPerceivedCaret = () => ({ x: 1, y: 1, width: 1 });
    core._syncTextArea();
    assert.equal(calls.sync, 1, 'caret known -> stock skipped');
    assert.equal(core.textarea.style.left, '8px');
    core.__imeAnchorPerceivedCaret = () => { throw new Error('boom'); };
    core._syncTextArea();
    assert.equal(calls.sync, 1, 'debounced while already anchored');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(calls.sync, 2, 'settled to stock fallback after hiddenSettleMs');
    core.__imeAnchorPerceivedCaret = () => ({ x: 1.5, y: 2 });
    core._syncTextArea();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(calls.sync, 3);
    let anchorCount = 0;
    core._compositionHelper.isComposing = true;
    core.__imeAnchorPerceivedCaret = () => { anchorCount += 1; return { x: 0, y: 0, width: 1 }; };
    core._compositionHelper.updateCompositionElements();
    assert.equal(anchorCount, 1);
    await new Promise(r => setTimeout(r, 15));
    assert.equal(anchorCount, 2, 'mirrors the stock async re-anchor');
    core.dispose();
});

test('pre-open install: sync guard is immediate, helper patch defers to onWillOpen and stays idempotent', () => {
    const { term, core, calls, fireWillOpen } = fakeTerm({ withHelper: false, withOnWillOpen: true });
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 4, y: 2, width: 1 }) }), true);
    // Calling patchTerminal twice pre-open must stay idempotent.
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 4, y: 2, width: 1 }) }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 0);
    assert.equal(core.textarea.style.left, '32px', 'caret anchoring works before open too');
    core._compositionHelper = {
        isComposing: true,
        updateCompositionElements(dontRecurse) { calls.update.push(dontRecurse); },
    };
    fireWillOpen();
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [], 'hidden cursor: deferred helper patch must hold');
    assert.equal(core._compositionView.style.left, '32px');
    core.coreService.isCursorHidden = false;
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [true]);
    core.dispose();
});

test('dispose cancels all timers and unsubscribes all lifecycle listeners cleanly', async () => {
    const { term, core, listenerCounts } = fakeTerm({ withBuffer: true, x: 4, y: 4 });
    const origScrollLines = core._bufferService.scrollLines;
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 20 }), true);
    assert.deepEqual(listenerCounts(), { scroll: 1, dims: 1, dpr: 1, charSize: 1, bufferActivate: 1 });
    assert.notEqual(core._bufferService.scrollLines, origScrollLines);
    core._syncTextArea();
    core.coreService.isCursorHidden = true;
    core.buffer.x = 20;
    core.buffer.y = 20;
    core._syncTextArea();
    core._compositionHelper.compositionstart();
    core.textarea.value = 'abc';
    core._compositionHelper.compositionend();
    core.dispose();
    assert.deepEqual(listenerCounts(), { scroll: 0, dims: 0, dpr: 0, charSize: 0, bufferActivate: 0 });
    assert.equal(core._bufferService.scrollLines, origScrollLines, 'dispose restores BufferService.scrollLines');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(core.textarea.style.left, '32px', 'disposed hidden timer must not mutate textarea');
    assert.equal(core.textarea.value, 'abc', 'disposed cleanup timer must not mutate textarea');
});

test('real vendored xterm parser & CompositionHelper: wheel scroll, split ?25l...?25h, buffer switch, and exact commit delivery', async () => {
    const term = new BundledTerminal({ cols: 80, rows: 24, scrollback: 100 });
    const core = term._core;
    const ta = { style: {}, value: '', scrollLeft: 0, selectionStart: 0, selectionEnd: 0 };
    const cv = {
        style: {},
        textContent: '',
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } },
        getBoundingClientRect() { return { width: cv.textContent ? cv.textContent.length * 8 : 0, height: 18 }; },
    };
    const renderService = {
        hasRenderer() { return true; },
        dimensions: { css: { cell: { width: 8, height: 18 } } },
        onDimensionsChange: createEmitter().event,
        refreshRows() {},
    };
    core.textarea = ta;
    core._compositionView = cv;
    core._renderService = renderService;
    // Mirror vendored CompositionHelper's _finalizeComposition and
    // _handleAnyTextareaChanges verbatim against real coreService.triggerDataEvent
    // so commit delivery and keydown(229) punctuation timing run against our patch.
    const sent = [];
    const dataSub = term.onData(d => sent.push(d));
    core._compositionHelper = {
        _textarea: ta,
        _compositionView: cv,
        _bufferService: core._bufferService,
        _optionsService: core.optionsService,
        _coreService: core.coreService,
        _renderService: renderService,
        _isComposing: false,
        _isSendingComposition: false,
        _compositionPosition: { start: 0, end: 0 },
        _dataAlreadySent: '',
        get isComposing() { return this._isComposing; },
        compositionstart() {
            this._isComposing = true;
            this._compositionPosition.start = this._textarea.value.length;
            this._compositionView.textContent = '';
            this._dataAlreadySent = '';
            this._compositionView.classList.add('active');
        },
        compositionupdate(e) {
            this._compositionView.textContent = e.data;
            this.updateCompositionElements();
            setTimeout(() => { this._compositionPosition.end = this._textarea.value.length; }, 0);
        },
        compositionend() { this._finalizeComposition(true); },
        keydown(e) {
            if (this._isComposing || this._isSendingComposition) {
                if (e.keyCode === 229) return false;
                if (e.keyCode === 16 || e.keyCode === 17 || e.keyCode === 18) return false;
                this._finalizeComposition(false);
            }
            return e.keyCode !== 229 || (this._handleAnyTextareaChanges(), false);
        },
        _finalizeComposition(wait) {
            this._compositionView.classList.remove('active');
            this._isComposing = false;
            if (wait) {
                const pos = { start: this._compositionPosition.start, end: this._compositionPosition.end };
                this._isSendingComposition = true;
                setTimeout(() => {
                    if (this._isSendingComposition) {
                        this._isSendingComposition = false;
                        pos.start += this._dataAlreadySent.length;
                        const text = this._isComposing
                            ? this._textarea.value.substring(pos.start, pos.end)
                            : this._textarea.value.substring(pos.start);
                        if (text.length > 0) this._coreService.triggerDataEvent(text, true);
                    }
                }, 0);
            } else {
                this._isSendingComposition = false;
                const text = this._textarea.value.substring(this._compositionPosition.start, this._compositionPosition.end);
                this._coreService.triggerDataEvent(text, true);
            }
        },
        _handleAnyTextareaChanges() {
            const old = this._textarea.value;
            setTimeout(() => {
                if (!this._isComposing) {
                    const cur = this._textarea.value;
                    const diff = cur.replace(old, '');
                    this._dataAlreadySent = diff;
                    if (cur.length > old.length) this._coreService.triggerDataEvent(diff, true);
                    else if (cur.length < old.length) this._coreService.triggerDataEvent('\x7f', true);
                    else if (cur.length === old.length && cur !== old) this._coreService.triggerDataEvent(cur, true);
                }
            }, 0);
        },
        updateCompositionElements() {},
    };
    assert.equal(api.patchTerminal(term, { hiddenSettleMs: 30 }), true);
    // Mirror open() wiring (xterm.js:693): onCursorMove triggers _syncTextArea().
    const moveSub = core.onCursorMove(() => core._syncTextArea());

    const write = s => new Promise(r => term.write(s, r));
    // Fill scrollback so ybase > 0 and place visible cursor at row 10, col 12.
    await write('line\r\n'.repeat(30) + '\x1b[11;13H');
    assert.ok(core.buffer.ybase > 5);
    core._syncTextArea();
    assert.equal(ta.style.left, (12 * 8) + 'px');
    assert.equal(ta.style.top, (10 * 18) + 'px');

    // Mouse-wheel scroll up 5 lines (suppressScrollEvent=true) resyncs AUTOMATICALLY without manual _syncTextArea().
    core._bufferService.scrollLines(-5, true);
    assert.equal(core.buffer.ydisp, core.buffer.ybase - 5);
    assert.equal(ta.style.top, (15 * 18) + 'px', 'wheel scroll must resync textarea automatically');

    // Programmatic scroll back to bottom (suppressScrollEvent=false) resyncs automatically.
    core._bufferService.scrollLines(5, false);
    assert.equal(core.buffer.ydisp, core.buffer.ybase);
    assert.equal(ta.style.top, (10 * 18) + 'px');

    // Start realistic keyboard composition, then feed split ConPTY chunk 1 (ESC[?25l ESC[H ... no ESC[?25h).
    core._compositionHelper.keydown({ keyCode: 229 });
    core._compositionHelper.compositionstart();
    ta.value = 'nihao';
    ta.selectionStart = ta.selectionEnd = 5;
    core._compositionHelper.compositionupdate({ data: 'nihao' });
    await write('\x1b[?25l\x1b[H' + 'A'.repeat(40));
    assert.equal(core.coreService.isCursorHidden, true);
    assert.equal(core.buffer.y, 0);
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(cv.style.left, (12 * 8) + 'px', 'real parser split chunk must not pull composition view to (40,0)');
    assert.equal(cv.style.top, (10 * 18) + 'px');
    assert.equal(ta.style.left, (12 * 8) + 'px');
    assert.equal(ta.style.top, (10 * 18) + 'px');

    // Finish split chunk and commit with realistic Space keydown(229) + compositionend.
    await write('\x1b[11;13H\x1b[?25h');
    core._compositionHelper.keydown({ keyCode: 229 });
    ta.value = '你好';
    ta.selectionStart = ta.selectionEnd = 2;
    core._compositionHelper.compositionend();
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(sent, ['你好'], 'committed Chinese text must be delivered intact with zero DEL');
    assert.equal(ta.value, '', 'textarea.value cleared cleanly after commit delivery');

    // Post-commit idle Chinese punctuation via keydown(229) delivers punctuation with zero spurious DEL.
    core._compositionHelper.keydown({ keyCode: 229 });
    ta.value = '，';
    ta.selectionStart = ta.selectionEnd = 1;
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(sent, ['你好', '，'], 'post-commit punctuation delivers cleanly with zero DEL');

    // Switch to alternate buffer with hidden cursor in ONE chunk -> onBufferActivate
    // resets state mid-parse and end-of-parse onCursorMove cold-anchors immediately.
    await write('\x1b[?1049h\x1b[?25l\x1b[5;8H');
    assert.equal(ta.style.left, (7 * 8) + 'px', 'alt-buffer entry resets stale state and anchors immediately');
    assert.equal(ta.style.top, (4 * 18) + 'px');
    // Return to normal buffer where alt (x,y) differs -> onCursorMove re-anchors immediately.
    await write('\x1b[?1049l\x1b[?25h');
    assert.equal(ta.style.top, (10 * 18) + 'px', 'normal-buffer return restores anchor');
    // Return to normal buffer where alt (x,y) EQUALS normal (x,y) -> no onCursorMove,
    // deferred bufferActivateTimer still re-anchors cleanly.
    await write('\x1b[?1049h\x1b[11;13H');
    await write('\x1b[?1049l');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(ta.style.left, (12 * 8) + 'px');
    assert.equal(ta.style.top, (10 * 18) + 'px');

    moveSub.dispose();
    dataSub.dispose();
    term.dispose();
});

test('no helper and no onWillOpen: loud false, no throw', () => {
    const warnings = [];
    const { term } = fakeTerm({ withHelper: false });
    assert.equal(api.patchTerminal(term, { warn: { warn: m => warnings.push(m) } }), false);
    assert.equal(warnings.length, 1);
});

test('changed xterm internals: loud false, no throw', () => {
    const warnings = [];
    const warn = { warn: m => warnings.push(m) };
    assert.equal(api.patchTerminal(null, { warn }), false);
    assert.equal(api.patchTerminal({ _core: {} }, { warn }), false);
    assert.equal(api.patchTerminal({ _core: { coreService: { isCursorHidden: true }, _compositionHelper: {} } }, { warn }), false);
    // Missing boolean isComposing on CompositionHelper must also fail loudly.
    assert.equal(api.patchTerminal({
        _core: {
            _syncTextArea() {},
            coreService: { isCursorHidden: false },
            _compositionHelper: { updateCompositionElements() {} },
        },
    }, { warn }), false);
    assert.equal(warnings.length, 4);
});
