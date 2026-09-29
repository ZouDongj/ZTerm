// T16 regression: the split spanner drag registered only document-level
// mousemove/mouseup. When the release happens outside the window (or the
// window loses focus) mouseup is never dispatched — the same environment
// note documented for the pane drag in tabs.js — so the drag stayed live:
// moving the buttonless pointer back over the window kept rewriting the
// split ratios on every mousemove, and the truthy _spannerDrag state kept
// suppressing every pane fit indefinitely (terminal.js/tabs.js fit guards).
//
// REAL in this VM: split-layout.js and split.js (the whole drag state
// machine). Faked: the environment only — minimal document/window with
// recorded listeners, elements with classList, a TabManager recorder.
// The shared renderer-vm harness deliberately does not load split.js, so
// this file builds its own smaller context for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');

function mkTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const l = listeners.get(type) || [];
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
        count(type) { return (listeners.get(type) || []).length; },
        fire(type, ev = {}) { (listeners.get(type) || []).slice().forEach(fn => fn(ev)); },
    };
}

function mkEl() {
    const classes = new Set();
    return {
        className: '',
        // Height 808: with _h 100 and GAP_PX 8 the drag's effectiveSize is a
        // clean 800px, so ratio deltas below stay binary-exact.
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 808, width: 600, height: 808 }),
        classList: {
            add: (...cs) => cs.forEach(c => classes.add(c)),
            remove: (...cs) => cs.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c),
        },
    };
}

function loadSplitVm() {
    const doc = mkTarget();
    const win = mkTarget();
    const rootEl = mkEl();
    const layoutCalls = [];
    const fits = [];
    const mkPane = (id) => ({ id, term: {}, fitAddon: { fit: () => fits.push(id) } });
    const container = {
        orientation: 'v', _x: 0, _y: 0, _w: 100, _h: 100,
        children: [mkPane('a'), mkPane('b')], ratios: [0.5, 0.5],
    };
    const tab = { id: 't1', splitRoot: container };
    const ctx = {
        console,
        document: {
            addEventListener: doc.addEventListener.bind(doc),
            removeEventListener: doc.removeEventListener.bind(doc),
            getElementById: (id) => (id === 'split_t1' ? rootEl : null),
        },
        window: {
            addEventListener: win.addEventListener.bind(win),
            removeEventListener: win.removeEventListener.bind(win),
        },
        GAP_PX: 8,
        TabManager: { tabs: [tab], _layoutSplit: (t) => layoutCalls.push(t) },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // split-layout.js declares getAllPanes/applyDragRatios as globals; split.js
    // consumes them plus GAP_PX/TabManager exactly as the page does.
    vm.runInContext(src('split-layout.js'), ctx, { filename: 'split-layout.js' });
    vm.runInContext(src('split.js'), ctx, { filename: 'split.js' });
    const state = () => vm.runInContext('_spannerDrag', ctx);
    const start = (pageY) => ctx._startSpannerDrag({ preventDefault() {}, pageY }, tab, container, 1);
    return { ctx, doc, win, rootEl, container, tab, layoutCalls, fits, state, start };
}

// A full drag prefix used by every test: grab at pageY 400, move +100px.
// effectiveSize = (100/100)*808 - (2-1)*8 = 800, so +100px = +0.125 ratio:
// 0.5/0.5 -> 0.625/0.375 through the REAL applyDragRatios (min 0.05 clamp
// path untouched), pinning that the ratio math is unchanged by the fix.
function dragPrefix(h) {
    h.start(400);
    h.doc.fire('mousemove', { pageY: 500 });
    assert.deepEqual(h.container.ratios, [0.625, 0.375], 'drag move math unchanged');
    assert.equal(h.layoutCalls.length, 1);
}

test('spanner drag arms window-level lost-release fallbacks', () => {
    const h = loadSplitVm();
    h.start(400);
    assert.equal(h.doc.count('mousemove'), 1, 'one document mousemove listener');
    assert.equal(h.doc.count('mouseup'), 1, 'one document mouseup listener');
    assert.equal(h.win.count('pointerup'), 1, 'window pointerup fallback armed');
    assert.equal(h.win.count('pointercancel'), 1, 'window pointercancel fallback armed');
    assert.equal(h.win.count('blur'), 1, 'window blur fallback armed');
    assert.ok(h.rootEl.classList.contains('resizing'), 'resizing style on during the drag');
    assert.equal(h.fits.length, 0, 'no fit while dragging');
});

test('lost mouseup: window blur ends the drag and restores fit', () => {
    const h = loadSplitVm();
    dragPrefix(h);

    h.win.fire('blur'); // release lost outside the window / focus stolen
    assert.equal(h.state(), null, 'drag state cleared by the blur fallback');
    assert.ok(!h.rootEl.classList.contains('resizing'), 'resizing style cleared');
    assert.deepEqual(h.fits, ['a', 'b'], 'both panes fitted once at drag end');
    assert.equal(h.doc.count('mousemove'), 0, 'mousemove listener removed');
    assert.equal(h.doc.count('mouseup'), 0, 'mouseup listener removed');
    assert.equal(h.win.count('blur'), 0, 'fallback listeners removed');

    // The reported regression: the buttonless pointer back over the window
    // must not keep rewriting the layout (or suppressing fit) anymore.
    h.doc.fire('mousemove', { pageY: 700 });
    assert.deepEqual(h.container.ratios, [0.625, 0.375], 'no ratio rewrite after the fallback end');
    assert.equal(h.layoutCalls.length, 1, 'no layout pass after the fallback end');
    assert.deepEqual(h.fits, ['a', 'b'], 'no extra fit after the fallback end');
});

test('lost mouseup: window pointerup ends the drag and restores fit', () => {
    const h = loadSplitVm();
    dragPrefix(h);

    h.win.fire('pointerup');
    assert.equal(h.state(), null, 'drag state cleared by the pointerup fallback');
    h.doc.fire('mousemove', { pageY: 700 });
    assert.deepEqual(h.container.ratios, [0.625, 0.375], 'no ratio rewrite after the fallback end');
});

test('lost mouseup: window pointercancel ends the drag and restores fit', () => {
    const h = loadSplitVm();
    dragPrefix(h);

    h.win.fire('pointercancel');
    assert.equal(h.state(), null, 'drag state cleared by the pointercancel fallback');
    h.doc.fire('mousemove', { pageY: 700 });
    assert.deepEqual(h.container.ratios, [0.625, 0.375], 'no ratio rewrite after the fallback end');
});

test('normal release still ends the drag once (no double fit)', () => {
    const h = loadSplitVm();
    dragPrefix(h);

    // Browsers deliver pointerup before the compatibility mouseup: the early
    // return on a null drag state makes the second stop a no-op, so exactly
    // one fit pass per pane — the release feel is unchanged.
    h.win.fire('pointerup');
    h.doc.fire('mouseup');
    assert.deepEqual(h.fits, ['a', 'b'], 'exactly one fit per pane on release');
    assert.equal(h.state(), null);
    assert.equal(h.doc.count('mousemove'), 0);
    assert.equal(h.win.count('pointerup'), 0);

    // And a plain in-window mouseup without any pointer event still works.
    const h2 = loadSplitVm();
    dragPrefix(h2);
    h2.doc.fire('mouseup');
    assert.deepEqual(h2.fits, ['a', 'b'], 'mouseup release path unchanged');
    assert.equal(h2.state(), null);
});

test('re-grab while a previous drag is pending ends it without listener leaks', () => {
    const h = loadSplitVm();
    dragPrefix(h);

    // _startSpannerDrag stops any live drag first; with the fallbacks this
    // must also remove the window listeners before arming the new drag.
    h.start(500);
    assert.deepEqual(h.fits, ['a', 'b'], 'the stale drag was settled on re-grab');
    assert.equal(h.doc.count('mousemove'), 1, 'exactly one mousemove listener for the new drag');
    assert.equal(h.doc.count('mouseup'), 1, 'exactly one mouseup listener for the new drag');
    assert.equal(h.win.count('pointerup'), 1, 'exactly one pointerup fallback for the new drag');
    assert.equal(h.win.count('pointercancel'), 1, 'exactly one pointercancel fallback');
    assert.equal(h.win.count('blur'), 1, 'exactly one blur fallback');
    assert.ok(h.rootEl.classList.contains('resizing'), 'resizing style back on for the new drag');
});
