// Regression: an armed shortcut capture (settings → shortcuts → 修改) leaked
// its keydown listener when the user left without pressing a key (tab switch,
// settings close, any click). The next combo pressed anywhere — e.g. Ctrl+C in
// the terminal — was swallowed and silently persisted as the new binding.
// Fix: a capture-phase mousedown listener cancels the capture exactly like Esc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const utilsSrc = fs.readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');

// Loads the REAL shortcut-utils.js + shortcuts.js in one VM; faked is only the
// environment (document listener registry, ipcRenderer recording bus, toasts).
// document.getElementById resolves a bare shortcuts-table so the post-cancel
// re-render (which restores the 修改 button label) is observable.
function fixture() {
    const listeners = new Map(); // `${type}:${capture ? 'c' : 'b'}` -> [fn]
    const sends = [];
    const table = { innerHTML: '' };
    const document = {
        addEventListener(type, fn, capture) {
            const key = type + (capture ? ':c' : ':b');
            if (!listeners.has(key)) listeners.set(key, []);
            listeners.get(key).push(fn);
        },
        removeEventListener(type, fn, capture) {
            const key = type + (capture ? ':c' : ':b');
            const l = listeners.get(key) || [];
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
        getElementById: id => (id === 'shortcuts-table' ? table : null),
        querySelector: () => null, // no overlay open
    };
    const context = {
        document, console,
        _settingsConfig: {},
        ipcRenderer: { send: (cmd, payload) => sends.push({ cmd, payload }) },
        showToast() {},
        escHtml: s => String(s),
        Icons: { iconSvg: () => '' },
        TabManager: { tabs: [], getActive: () => null },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(utilsSrc, context);
    vm.runInContext(source, context);
    const dispatch = (type, ev, capture = true) => {
        const key = type + (capture ? ':c' : ':b');
        (listeners.get(key) || []).slice().forEach(fn => fn(ev));
    };
    // Same-target capture listeners run in registration order, exactly like
    // the page (browser-accelerator guard → dispatcher → capture listener).
    const keydown = (init) => {
        const ev = {
            isComposing: false, keyCode: 0,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...init,
        };
        dispatch('keydown', ev);
        return ev;
    };
    return {
        context, table, sends, dispatch, keydown,
        captureState: () => vm.runInContext('_shortcutCapture', context),
        arm: (actionId = 'closeTab') => {
            const btn = { textContent: '修改', classList: { add() {} } };
            context.startShortcutCapture(actionId, btn);
            return btn;
        },
    };
}

// xterm's helper textarea: passes the dispatcher's input guard, so a leaked
// capture listener is the only thing that can consume the key.
const XTERM_TARGET = { tagName: 'TEXTAREA', classList: { contains: c => c === 'xterm-helper-textarea' } };

test('clicking anywhere cancels an armed capture; a later Ctrl+C is neither swallowed nor recorded', () => {
    const f = fixture();
    f.arm('closeTab');
    assert.ok(f.captureState(), 'capture armed');

    // The user clicks a tab (or the settings close button) without pressing a key.
    f.dispatch('mousedown', {});
    assert.equal(f.captureState(), null, 'mousedown cancelled the capture');
    assert.match(f.table.innerHTML, /修改/, 'the re-rendered list restores the 修改 button label');
    assert.doesNotMatch(f.table.innerHTML, /按下快捷键/, 'no row stays in the capturing state');

    // The leaked-listener repro: Ctrl+C in the terminal must pass through
    // untouched and must NOT become a persisted binding.
    const ev = f.keydown({ key: 'c', ctrlKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, undefined, 'Ctrl+C is delivered to the terminal');
    assert.equal(f.context._settingsConfig.shortcuts, undefined, 'no binding was written');
    assert.equal(f.sends.length, 0, 'nothing was persisted');
});

test('(guard) a completed capture still records the combo and persists it', () => {
    const f = fixture();
    f.arm('closeTab');
    const ev = f.keydown({ key: 'k', ctrlKey: true, altKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the recording keydown is consumed');
    assert.equal(f.captureState(), null, 'capture finished');
    // VM-realm objects fail deepStrictEqual's prototype check; compare structurally.
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Ctrl+Alt+K' });
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cmd, 'save-shortcuts');
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: 'Ctrl+Alt+K' });

    // The mousedown listener was removed with the keydown one: further clicks
    // are inert and must not throw or cancel anything.
    f.dispatch('mousedown', {});
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Ctrl+Alt+K' });
});

test('(guard) Escape still cancels an armed capture without recording', () => {
    const f = fixture();
    f.arm('closeTab');
    const ev = f.keydown({ key: 'Escape', target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(f.captureState(), null);
    assert.equal(f.context._settingsConfig.shortcuts, undefined);
    assert.equal(f.sends.length, 0);
});
