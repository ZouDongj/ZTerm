// Regression: closing the command palette via the mask click or the × button
// (renderer.html inline handlers call closePalette directly) left focus on
// <body> — typing went nowhere. Fix: closePalette restores the active terminal
// on a 50ms delay (like closeSearch), re-checking at fire time so an overlay
// opened by an executed action (or a reopened palette) keeps its own focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const utilsSrc = fs.readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/renderer/command-palette.js', import.meta.url), 'utf8');

function mkEl() {
    const classes = new Set();
    return {
        value: '', focusCalls: 0,
        focus() { this.focusCalls++; },
        classList: {
            add: c => classes.add(c),
            remove: c => classes.delete(c),
            contains: c => classes.has(c),
        },
    };
}

function fixture() {
    const paletteEl = mkEl();
    const inputEl = mkEl();
    let otherOverlayOpen = false;
    let now = 0;
    let seq = 0;
    const timers = new Map();
    const refocus = { calls: 0 };
    const bindings = { commandPalette: 'Ctrl+P' };
    const document = {
        getElementById: id => ({ 'overlay-palette': paletteEl, 'palette-input': inputEl }[id] || null),
        querySelector: sel => (sel === '.overlay.open' && (paletteEl.classList.contains('open') || otherOverlayOpen) ? { sentinel: true } : null),
    };
    const context = {
        document, console,
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: id => timers.delete(id),
        _refocusActiveTerminal: () => { refocus.calls++; },
        _getShortcutBindings: () => bindings,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(utilsSrc, context);
    vm.runInContext(source, context);
    return {
        context, paletteEl, inputEl, refocus, bindings,
        setOtherOverlay: v => { otherOverlayOpen = v; },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...timers]) {
                if (timers.has(id) && t.at <= now) { timers.delete(id); t.fn(); }
            }
        },
    };
}

test('closePalette restores terminal focus after 50ms', () => {
    const f = fixture();
    f.context.openPalette();
    f.advance(50); // openPalette's own input-focus timer
    assert.equal(f.paletteEl.classList.contains('open'), true);

    f.context.closePalette();
    assert.equal(f.paletteEl.classList.contains('open'), false);
    assert.equal(f.refocus.calls, 0, 'the refocus keeps its 50ms delay');

    f.advance(50);
    assert.equal(f.refocus.calls, 1, 'the active terminal is refocused');
});

test('no refocus when the executed action opened another overlay inside the window', () => {
    const f = fixture();
    f.context.openPalette();
    f.advance(50);

    f.context.closePalette();          // e.g. Enter on 新建标签页 …
    f.setOtherOverlay(true);           // … immediately opens the session selector
    f.advance(50);
    assert.equal(f.refocus.calls, 0, 'the successor overlay keeps its focus');
});

test('no refocus when the palette itself reopened inside the window', () => {
    const f = fixture();
    f.context.openPalette();
    f.advance(50);

    f.context.closePalette();
    f.context.openPalette();
    f.advance(50);
    assert.equal(f.refocus.calls, 0, 'the reopened palette keeps its input focus');
});

// ── Toggle: the palette's own binding closes it while its input holds focus ──
// Regression: with the palette open, focus lives in palette-input, so the
// global dispatcher's input guard returned before combo matching and the
// commandPalette toggle branch was unreachable — Ctrl+P could not close it.

const keyEvent = (init) => ({
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
});

test('pressing the palette binding inside its input closes the palette', () => {
    const f = fixture();
    f.context.openPalette();
    const ev = keyEvent({ key: 'p', ctrlKey: true });
    f.context.paletteKeyDown(ev);
    assert.equal(ev.defaultPrevented, true, 'the toggle combo is consumed');
    assert.equal(f.paletteEl.classList.contains('open'), false, 'palette closed');

    f.advance(50);
    assert.equal(f.refocus.calls, 1, 'closing via the toggle also restores terminal focus');
});

test('the toggle follows the current binding instead of a hardcoded Ctrl+P', () => {
    const f = fixture();
    f.bindings.commandPalette = 'F4'; // user-rebound
    f.context.openPalette();

    f.context.paletteKeyDown(keyEvent({ key: 'p', ctrlKey: true }));
    assert.equal(f.paletteEl.classList.contains('open'), true, 'Ctrl+P no longer toggles');

    f.context.paletteKeyDown(keyEvent({ key: 'F4' }));
    assert.equal(f.paletteEl.classList.contains('open'), false, 'the custom binding toggles');
});

test('(guard) unrelated keys still reach the input untouched', () => {
    const f = fixture();
    f.context.openPalette();
    const ev = keyEvent({ key: 'x' });
    f.context.paletteKeyDown(ev);
    assert.equal(ev.defaultPrevented, undefined, 'typed text is not consumed');
    assert.equal(f.paletteEl.classList.contains('open'), true, 'palette stays open');
});
