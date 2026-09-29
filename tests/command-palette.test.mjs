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
    const document = {
        getElementById: id => ({ 'overlay-palette': paletteEl, 'palette-input': inputEl }[id] || null),
        querySelector: sel => (sel === '.overlay.open' && (paletteEl.classList.contains('open') || otherOverlayOpen) ? { sentinel: true } : null),
    };
    const context = {
        document, console,
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: id => timers.delete(id),
        _refocusActiveTerminal: () => { refocus.calls++; },
        _getShortcutBindings: () => ({ commandPalette: 'Ctrl+P' }),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(utilsSrc, context);
    vm.runInContext(source, context);
    return {
        context, paletteEl, inputEl, refocus,
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
