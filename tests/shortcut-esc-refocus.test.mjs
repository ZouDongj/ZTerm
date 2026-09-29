// Regression: Escape closing an overlay restored focus only via
// `tab.term.focus()`, which splits skip entirely (a split tab's term slot is
// null — tabs.js moves the terminal onto panes). Focus fell to <body> and
// typing did nothing. Fix: the Esc branch delegates to the split-aware
// _refocusActiveTerminal() on the same 50ms delay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const utilsSrc = fs.readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');
const mainSrc = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');

// The REAL _refocusActiveTerminal (main.js), extracted so the test tracks the
// implementation instead of a copied stub.
const refocusSrc = mainSrc.match(/function _refocusActiveTerminal\(\) \{[\s\S]*?\n\}/);
assert.ok(refocusSrc, '_refocusActiveTerminal source found in main.js');

function fixture(activeTab) {
    const listeners = new Map();
    let overlayOpen = false;
    let now = 0;
    const timers = new Map();
    let seq = 0;
    const document = {
        addEventListener(type, fn, capture) {
            const key = type + (capture ? ':c' : ':b');
            if (!listeners.has(key)) listeners.set(key, []);
            listeners.get(key).push(fn);
        },
        removeEventListener() {},
        getElementById: () => null,
        querySelector: sel => (sel === '.overlay.open' && overlayOpen ? { sentinel: true } : null),
    };
    const context = {
        document, console,
        _settingsConfig: {},
        ipcRenderer: { send() {} },
        showToast() {},
        TabManager: { getActive: () => activeTab },
        getAllPanes: tab => tab._panes,
        closeAllOverlays: () => { overlayOpen = false; },
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: id => timers.delete(id),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(utilsSrc, context);
    vm.runInContext(refocusSrc[0], context);
    vm.runInContext(source, context);
    const keydown = (init) => {
        const ev = {
            isComposing: false, keyCode: 0,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...init,
        };
        (listeners.get('keydown:c') || []).slice().forEach(fn => fn(ev));
        return ev;
    };
    return {
        context, keydown,
        openOverlay: () => { overlayOpen = true; },
        isOverlayOpen: () => overlayOpen,
        advance(ms) {
            now += ms;
            for (const [id, t] of [...timers]) {
                if (timers.has(id) && t.at <= now) { timers.delete(id); t.fn(); }
            }
        },
    };
}

const mkTerm = () => ({ focusCalls: 0, focus() { this.focusCalls++; } });
// Escape's target is never an inline-edit input in these scenarios.
const ESC_TARGET = { tagName: 'TEXTAREA', classList: { contains: () => false } };

test('Escape closing an overlay refocuses the focused pane of a split tab', () => {
    const p1 = { id: 'p1', focused: false, term: mkTerm() };
    const p2 = { id: 'p2', focused: true, term: mkTerm() };
    const tab = { id: 't_split', type: 'local', term: null, splitRoot: {}, _panes: [p1, p2] };
    const f = fixture(tab);
    f.openOverlay();

    const ev = f.keydown({ key: 'Escape', target: ESC_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the Esc keydown is consumed');
    assert.equal(f.isOverlayOpen(), false, 'the overlay was closed');
    assert.equal(p2.term.focusCalls, 0, 'the refocus keeps its 50ms delay');

    f.advance(50);
    assert.equal(p2.term.focusCalls, 1, 'the focused pane terminal is refocused');
    assert.equal(p1.term.focusCalls, 0, 'the unfocused pane is left alone');
});

test('(guard) Escape closing an overlay still refocuses a single-terminal tab', () => {
    const tab = { id: 't_single', type: 'local', term: mkTerm() };
    const f = fixture(tab);
    f.openOverlay();
    f.keydown({ key: 'Escape', target: ESC_TARGET });
    f.advance(50);
    assert.equal(tab.term.focusCalls, 1);
});

test('(guard) Escape closing an overlay over the settings tab focuses nothing', () => {
    const tab = { id: 't_settings', type: 'settings', term: null };
    const f = fixture(tab);
    f.openOverlay();
    f.keydown({ key: 'Escape', target: ESC_TARGET });
    assert.doesNotThrow(() => f.advance(50));
});
