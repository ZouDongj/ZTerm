// Unit tests for the IME caret anchor patch.
// xterm anchors the IME helper textarea / composition view to the PROTOCOL
// cursor without checking visibility; agent TUIs hide the protocol cursor
// for whole sessions and park it at their spinner, so the candidate window
// chases the park. Policy under test:
//   visible cursor              -> stock xterm anchoring;
//   hidden + perceived caret    -> anchor both elements at the caret cell
//     (the app-drawn caret the user sees, from the smooth-cursor adapter);
//   hidden + no perceived caret -> STOCK protocol anchoring. (Freezing here
//     stranded the anchor: fresh sessions put it at the textarea's DOM
//     default, screen top-left; post-commit revoke gaps left it on a
//     just-overwritten cell, so the next composition covered committed text.
//     The protocol cursor tracks the insertion point during input phases.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../src/renderer/ime-caret-anchor.js');

function fakeTerm({ withHelper = true, withOnWillOpen = false } = {}) {
    const calls = { sync: 0, update: [] };
    const listeners = [];
    const core = {
        coreService: { isCursorHidden: false },
        options: { fontFamily: 'TestMono', fontSize: 16 },
        textarea: { style: {} },
        _renderService: { dimensions: { css: { cell: { width: 8, height: 18 } } } },
        _compositionView: { style: {}, getBoundingClientRect: () => ({ width: 50, height: 18 }) },
        _syncTextArea() { calls.sync += 1; },
    };
    if (withHelper) {
        core._compositionHelper = {
            updateCompositionElements(dontRecurse) { calls.update.push(dontRecurse); },
        };
    }
    if (withOnWillOpen) {
        core.onWillOpen = l => {
            listeners.push(l);
            return { dispose() { listeners.splice(listeners.indexOf(l), 1); } };
        };
    }
    const fireWillOpen = () => { for (const l of [...listeners]) l(); };
    return { term: { _core: core }, core, calls, listeners, fireWillOpen };
}

test('visible cursor: both anchors delegate to xterm', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term), true);
    core._syncTextArea();
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(calls.sync, 1);
    assert.deepEqual(calls.update, [true]);
});

test('hidden cursor without a perceived caret: stock protocol anchoring', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    core._compositionHelper.updateCompositionElements(true);
    assert.equal(calls.sync, 1, 'no caret -> stock protocol anchoring (probe: it tracks the insertion point)');
    assert.deepEqual(calls.update, [true]);
});

test('hidden cursor + perceived caret: textarea anchors at the caret cell', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 5, y: 3, width: 2 }) }), true);
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 0, 'stock protocol anchoring stays skipped while hidden');
    assert.deepEqual(core.textarea.style, {
        left: '40px', top: '54px', width: '16px', height: '18px', lineHeight: '18px', zIndex: '-5',
    });
});

test('hidden cursor + perceived caret: composition view anchors at the caret cell', () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 2, y: 7 }) }), true);
    core.coreService.isCursorHidden = true;
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [], 'stock composition anchoring stays skipped while hidden');
    assert.equal(core._compositionView.style.left, '16px');
    assert.equal(core._compositionView.style.top, '126px');
    assert.equal(core._compositionView.style.fontFamily, 'TestMono');
    assert.equal(core._compositionView.style.fontSize, '16px');
    assert.equal(core.textarea.style.left, '16px');
    assert.equal(core.textarea.style.top, '126px');
    assert.equal(core.textarea.style.width, '50px', 'textarea tracks the composition view rect');
});

test('provider is read dynamically: swap and broken providers', async () => {
    const { term, core, calls } = fakeTerm();
    assert.equal(api.patchTerminal(term), true);
    core.coreService.isCursorHidden = true;
    // no provider -> stock protocol anchoring
    core._syncTextArea();
    assert.equal(calls.sync, 1);
    // E2E seam: swap the provider on the live core
    core.__imeAnchorPerceivedCaret = () => ({ x: 1, y: 1, width: 1 });
    core._syncTextArea();
    assert.equal(calls.sync, 1, 'caret known -> stock skipped');
    assert.equal(core.textarea.style.left, '8px');
    // a throwing provider must not break anchoring: falls back to stock
    core.__imeAnchorPerceivedCaret = () => { throw new Error('boom'); };
    core._syncTextArea();
    assert.equal(calls.sync, 2);
    // malformed cells are rejected -> stock
    core.__imeAnchorPerceivedCaret = () => ({ x: 1.5, y: 2 });
    core._syncTextArea();
    assert.equal(calls.sync, 3);
    // composition wrapper re-anchors once async when dontRecurse is falsy
    let anchorCount = 0;
    core.__imeAnchorPerceivedCaret = () => { anchorCount += 1; return { x: 0, y: 0, width: 1 }; };
    core._compositionHelper.updateCompositionElements();
    assert.equal(anchorCount, 1);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(anchorCount, 2, 'mirrors the stock async re-anchor');
});

test('pre-open install: sync guard is immediate, helper patch defers to onWillOpen', () => {
    const { term, core, calls, fireWillOpen } = fakeTerm({ withHelper: false, withOnWillOpen: true });
    assert.equal(api.patchTerminal(term, { perceivedCaret: () => ({ x: 4, y: 2, width: 1 }) }), true);
    // sync policy is already active before open()
    core.coreService.isCursorHidden = true;
    core._syncTextArea();
    assert.equal(calls.sync, 0);
    assert.equal(core.textarea.style.left, '32px', 'caret anchoring works before open too');
    // open() creates the helper, then fires onWillOpen
    core._compositionHelper = {
        updateCompositionElements(dontRecurse) { calls.update.push(dontRecurse); },
    };
    fireWillOpen();
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [], 'hidden cursor: deferred helper patch must hold');
    assert.equal(core._compositionView.style.left, '32px');
    core.coreService.isCursorHidden = false;
    core._compositionHelper.updateCompositionElements(true);
    assert.deepEqual(calls.update, [true]);
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
    assert.equal(warnings.length, 3);
});
