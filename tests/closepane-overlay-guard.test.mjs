// Regression: closePane's split branch was the only pane action without the
// `.overlay.open` guard. With an OSC8 "open link?" confirm open (showConfirm
// never moves focus, so the xterm textarea keeps it), Alt+Shift+W destroyed
// the focused pane's session behind the modal. Fix: same overlay early-return
// as every sibling pane action.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const utilsSrc = fs.readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');

function fixture(activeTab) {
    const listeners = new Map();
    let overlayOpen = false;
    const calls = { closePane: [], closeTab: [] };
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
        TabManager: {
            getActive: () => activeTab,
            aliveCount: () => 2,
            _closePane: (tabId, paneId) => calls.closePane.push([tabId, paneId]),
            closeTab: id => calls.closeTab.push(id),
        },
        getAllPanes: tab => tab._panes,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(utilsSrc, context);
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
    return { calls, keydown, openOverlay: () => { overlayOpen = true; } };
}

// Focus stays in xterm's helper textarea while showConfirm is open.
const XTERM_TARGET = { tagName: 'TEXTAREA', classList: { contains: c => c === 'xterm-helper-textarea' } };
const CLOSE_PANE_KEY = { key: 'W', altKey: true, shiftKey: true, target: XTERM_TARGET };

const splitTab = () => ({
    id: 't_split', type: 'local', term: null, splitRoot: {},
    _panes: [{ id: 'p1', focused: false }, { id: 'p2', focused: true }],
});

test('Alt+Shift+W on a split tab does not close the focused pane while an overlay is open', () => {
    const f = fixture(splitTab());
    f.openOverlay();
    const ev = f.keydown({ ...CLOSE_PANE_KEY });
    assert.deepEqual(f.calls.closePane, [], 'the pane behind the overlay survives');
    assert.equal(ev.defaultPrevented, true, 'the combo is still consumed (sibling-guard parity)');
});

test('(guard) Alt+Shift+W on a split tab closes the focused pane with no overlay open', () => {
    const f = fixture(splitTab());
    f.keydown({ ...CLOSE_PANE_KEY });
    assert.deepEqual(f.calls.closePane, [['t_split', 'p2']]);
});

test('(guard) the non-split fallback keeps its existing overlay behavior', () => {
    const tab = { id: 't_single', type: 'local', term: {} };

    const guarded = fixture(tab);
    guarded.openOverlay();
    guarded.keydown({ ...CLOSE_PANE_KEY });
    assert.deepEqual(guarded.calls.closeTab, [], 'overlay open: tab close suppressed');

    const plain = fixture(tab);
    plain.keydown({ ...CLOSE_PANE_KEY });
    assert.deepEqual(plain.calls.closeTab, ['t_single'], 'no overlay: acts like closeTab');
});
