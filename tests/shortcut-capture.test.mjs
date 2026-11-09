// Regression: an armed shortcut capture (settings → shortcuts → edit) leaked
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
// re-render (which restores the edit button label) is observable.
function fixture() {
    const listeners = new Map(); // `${type}:${capture ? 'c' : 'b'}` -> [fn]
    const sends = [];
    const toasts = [];
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
        showToast: msg => toasts.push(String(msg)),
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
        context, table, sends, toasts, dispatch, keydown,
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
    assert.doesNotMatch(f.table.innerHTML, /Esc 取消/, 'no row stays in the capturing state');

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

// ── Clear-binding capture (bare Backspace/Delete) ──
// '' is an explicit "no combo bound" override, distinct from an absent key
// (= default): it must persist through the save-shortcuts funnel, survive a
// settings reload merge, render as an em dash with the ↺ reset available,
// and free the combo for the terminal.

test('bare Backspace during capture clears the binding and persists an empty override', () => {
    const f = fixture();
    f.arm('closeTab');
    const ev = f.keydown({ key: 'Backspace', target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the clearing keydown is consumed');
    assert.equal(f.captureState(), null, 'capture finished');
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: '' });
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cmd, 'save-shortcuts');
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: '' });
    assert.match(f.table.innerHTML, /<kbd>—<\/kbd>/, 'the cleared row renders an em dash');
    assert.match(f.table.innerHTML, /shortcut-reset-btn/, 'the ↺ reset button still appears (override present)');
});

test('bare Delete clears the binding the same way', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Delete', target: XTERM_TARGET });
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: '' });
    assert.equal(f.sends.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: '' });
});

test('Backspace/Delete WITH modifiers record as normal combos instead of clearing', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Backspace', ctrlKey: true, target: XTERM_TARGET });
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Ctrl+Backspace' },
        'Ctrl+Backspace is a valid recorded combo');
    assert.equal(f.sends.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: 'Ctrl+Backspace' });
});

test('a cleared binding survives a settings reload (persist → merge → still empty)', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Backspace', target: XTERM_TARGET });

    // What loadSettings does on restart: a brand-new config built from what
    // was persisted. The merge spread must keep the '' override instead of
    // falling back to the default.
    f.context._settingsConfig = { shortcuts: JSON.parse(JSON.stringify(f.sends[0].payload)) };
    const merged = f.context._getShortcutBindings();
    assert.equal(merged.closeTab, '', 'the empty override survives the reload merge');
    assert.equal(merged.newTab, 'Ctrl+Shift+N', 'untouched defaults stay');
});

test('after clearing, the dispatcher no longer consumes the freed default combo', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Backspace', target: XTERM_TARGET });
    assert.equal(f.captureState(), null);

    // closeTab's default combo (Ctrl+Shift+W) is no longer bound: the capture
    // dispatcher must let it reach the terminal instead of consuming it.
    const ev = f.keydown({ key: 'W', ctrlKey: true, shiftKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, undefined, 'the freed combo is delivered to the terminal');
    assert.equal(ev.propagationStopped, undefined);
});

test('resetShortcut after a clear restores the default binding', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Backspace', target: XTERM_TARGET });
    assert.equal(f.context._getShortcutBindings().closeTab, '');

    f.context.resetShortcut('closeTab');
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), {},
        'the empty override was removed');
    assert.equal(f.context._getShortcutBindings().closeTab, 'Ctrl+Shift+W', 'default binding restored');
    assert.match(f.table.innerHTML, /Ctrl\+Shift\+W/, 'the list shows the default combo again');
});

// ── Reset-vs-conflict guard (issue #33) ──
// Repro: clear quickCommands (Alt+Q), rebind SFTP onto the freed Alt+Q, then
// press the row's reset button. resetShortcut used to delete the '' override
// unconditionally, silently binding Alt+Q to BOTH actions. A reset must go
// through the same conflict check a fresh capture does: name the holder,
// keep the binding.

// Builds the issue #33 repro state through the REAL capture flow:
// overrides { quickCommands: '', sftp: 'Alt+Q' } (Alt+Q held by SFTP).
function issue33State() {
    const f = fixture();
    f.arm('quickCommands');
    f.keydown({ key: 'Backspace', target: XTERM_TARGET });       // clear → ''
    f.arm('sftp');
    f.keydown({ key: 'q', altKey: true, target: XTERM_TARGET }); // SFTP takes Alt+Q
    return f;
}

test('resetShortcut refuses when the default combo is held by another action (issue #33)', () => {
    const f = issue33State();
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { quickCommands: '', sftp: 'Alt+Q' });

    f.context.resetShortcut('quickCommands');

    assert.equal(f.context._getShortcutBindings().quickCommands, '', 'the cleared binding is kept');
    assert.equal(f.context._getShortcutBindings().sftp, 'Alt+Q', 'the holder is untouched');
    const holders = Object.values(f.context._getShortcutBindings()).filter(c => c === 'Alt+Q');
    assert.equal(holders.length, 1, 'no duplicate Alt+Q binding was created');
    assert.equal(f.sends.length, 2, 'the refused reset persists nothing');
    assert.ok(f.toasts.some(t => t.includes('SFTP 文件面板')), 'toast names the conflicting operation');
    assert.ok(f.toasts.every(t => !t.includes('快捷命令')), 'the toast does not blame the action being reset');
});

test('resetShortcut on a conflict-free override still restores the default', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'k', ctrlKey: true, metaKey: true, target: XTERM_TARGET }); // Ctrl+Win+K, unclaimed

    f.context.resetShortcut('closeTab');

    assert.equal(f.context._getShortcutBindings().closeTab, 'Ctrl+Shift+W', 'default restored');
    assert.equal(f.toasts.length, 0, 'no conflict toast on a clean reset');
});

test('resetAllShortcuts in the repro state lands on unique defaults', () => {
    const f = issue33State();

    f.context.resetAllShortcuts();

    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), {}, 'all overrides wiped');
    const merged = f.context._getShortcutBindings();
    assert.equal(merged.quickCommands, 'Alt+Q', 'quickCommands back on its default');
    assert.equal(merged.sftp, 'Ctrl+Shift+F', 'sftp back on its default');
    const combos = Object.values(merged);
    assert.equal(new Set(combos).size, combos.length, 'no combo is bound twice after the reset');
});

test('resetAllShortcuts refuses when two defaults collide and keeps current bindings (issue #33)', () => {
    const f = fixture();
    f.context._settingsConfig.shortcuts = { quickCommands: 'Ctrl+Alt+Q' };
    // A full reset lands exactly on DEFAULT_SHORTCUTS, so the only duplicate
    // it could create is one baked into the defaults themselves. Simulate a
    // future defaults edit that claims sftp's combo for perfCapture.
    vm.runInContext("DEFAULT_SHORTCUTS.perfCapture = 'Ctrl+Shift+F'", f.context);

    f.context.resetAllShortcuts();

    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { quickCommands: 'Ctrl+Alt+Q' },
        'the current bindings are kept');
    assert.equal(f.sends.length, 0, 'nothing was persisted');
    const toast = f.toasts[f.toasts.length - 1];
    assert.ok(toast && toast.includes('SFTP 文件面板') && toast.includes('性能采样'),
        'toast names both colliding operations: ' + toast);
});

test('a capture re-claiming a default held by another action is still refused (shared conflict rule)', () => {
    // The reset guard must not weaken the capture guard: re-recording the
    // default combo onto a second action stays impossible.
    const f = fixture();
    f.arm('sftp');
    const ev = f.keydown({ key: 'q', altKey: true, target: XTERM_TARGET }); // Alt+Q = quickCommands default
    assert.equal(ev.defaultPrevented, true);
    assert.equal(f.context._settingsConfig.shortcuts, undefined, 'nothing recorded');
    assert.ok(f.toasts.some(t => t.includes('快捷命令')), 'toast names the default holder');
});

// ── Win as a first-class modifier (issue #23) ──
// comboFromEvent no longer folds metaKey into Ctrl: Ctrl+Win+X records as
// its own combo, and the capture validation accepts Win-qualified combos
// (bare Win alone can never be recorded — the modifier wait holds the
// capture open, the OS owns the key).

test('capture records Ctrl+Win+X as a distinct combo and persists it', () => {
    const f = fixture();
    f.arm('closeTab');
    const ev = f.keydown({ key: 'x', ctrlKey: true, metaKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the recording keydown is consumed');
    assert.equal(f.captureState(), null, 'capture finished');
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Ctrl+Win+X' });
    assert.equal(f.sends.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: 'Ctrl+Win+X' });
    assert.match(f.table.innerHTML, /Ctrl\+Win\+X/, 'the list renders the Win combo');
});

test('capture accepts Win without Ctrl/Alt (e.g. Win+X, when the OS delivers it)', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'x', metaKey: true, target: XTERM_TARGET });
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Win+X' });
    assert.equal(f.sends.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].payload)), { closeTab: 'Win+X' });
});

test('bare Win (Meta keydown alone) keeps the capture waiting', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'Meta', metaKey: true, target: XTERM_TARGET });
    assert.ok(f.captureState(), 'capture is still armed — Win alone is not a binding');
    assert.equal(f.context._settingsConfig.shortcuts, undefined, 'nothing was recorded');
    // the next real key completes the combo with the Win modifier
    f.keydown({ key: 'k', metaKey: true, target: XTERM_TARGET });
    assert.deepEqual(JSON.parse(JSON.stringify(f.context._settingsConfig.shortcuts)), { closeTab: 'Win+K' });
});

test('dispatcher separation: a Ctrl+X binding does not fire on Ctrl+Win+X and vice versa', () => {
    // Record closeTab = Ctrl+X through the real capture flow.
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'x', ctrlKey: true, target: XTERM_TARGET });

    const pressed = f.keydown({ key: 'x', ctrlKey: true, metaKey: true, target: XTERM_TARGET });
    assert.equal(pressed.defaultPrevented, undefined, 'Ctrl+Win+X is delivered to the terminal, not the Ctrl+X action');
    assert.equal(pressed.propagationStopped, undefined);

    const plain = f.keydown({ key: 'x', ctrlKey: true, target: XTERM_TARGET });
    assert.equal(plain.defaultPrevented, true, 'plain Ctrl+X still fires the recorded binding');
});

test('dispatcher separation: a Win combo binding ignores the same combo without Win', () => {
    const f = fixture();
    f.arm('closeTab');
    f.keydown({ key: 'x', ctrlKey: true, metaKey: true, target: XTERM_TARGET }); // records Ctrl+Win+X

    const plain = f.keydown({ key: 'x', ctrlKey: true, target: XTERM_TARGET });
    assert.equal(plain.defaultPrevented, undefined, 'plain Ctrl+X does not fire the Ctrl+Win+X binding');

    const withWin = f.keydown({ key: 'x', ctrlKey: true, metaKey: true, target: XTERM_TARGET });
    assert.equal(withWin.defaultPrevented, true, 'Ctrl+Win+X fires its own binding');
});

test('legacy stored bindings (recorded before Win existed) keep firing unchanged', () => {
    const f = fixture();
    // A config persisted by an older build: overrides never contain Win.
    f.context._settingsConfig.shortcuts = { renameTab: 'Ctrl+W' };

    const fires = f.keydown({ key: 'w', ctrlKey: true, target: XTERM_TARGET });
    assert.equal(fires.defaultPrevented, true, 'the stored Ctrl+W override still matches');

    const withWin = f.keydown({ key: 'w', ctrlKey: true, metaKey: true, target: XTERM_TARGET });
    assert.equal(withWin.defaultPrevented, undefined, 'Ctrl+Win+W is a different combo and falls through');
});

// ── reconnectTab action (issue #19) ──
// Default Ctrl+Shift+R reconnects the ACTIVE tab when it is an SSH tab;
// local/settings tabs and open overlays no-op (the key is still consumed —
// same dispatcher idiom as closeTab on a settings tab).

function reconnectFixture(activeTab) {
    const f = fixture();
    const calls = [];
    f.context.TabManager = {
        tabs: activeTab ? [activeTab] : [],
        getActive: () => activeTab || null,
        reconnectTab: id => calls.push(id),
    };
    return { f, calls };
}

test('reconnectTab default Ctrl+Shift+R reconnects the active SSH tab', () => {
    const { f, calls } = reconnectFixture({ id: 'ssh1', type: 'ssh' });
    assert.equal(f.context._getShortcutBindings().reconnectTab, 'Ctrl+Shift+R', 'registry default');

    const ev = f.keydown({ key: 'r', ctrlKey: true, shiftKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the combo is consumed');
    assert.deepEqual(calls, ['ssh1'], 'TabManager.reconnectTab ran for the active tab');
});

test('reconnectTab no-ops on local and settings tabs (key stays consumed)', () => {
    for (const type of ['local', 'settings']) {
        const { f, calls } = reconnectFixture({ id: 't1', type });
        const ev = f.keydown({ key: 'r', ctrlKey: true, shiftKey: true, target: XTERM_TARGET });
        assert.equal(ev.defaultPrevented, true, `${type}: dispatcher still consumes the combo`);
        assert.deepEqual(calls, [], `${type}: no reconnect was started`);
    }
});

test('reconnectTab no-ops while an overlay is open', () => {
    const { f, calls } = reconnectFixture({ id: 'ssh1', type: 'ssh' });
    f.context.document.querySelector = sel => (sel === '.overlay.open' ? {} : null);
    f.keydown({ key: 'r', ctrlKey: true, shiftKey: true, target: XTERM_TARGET });
    assert.deepEqual(calls, [], 'the open overlay owns the keyboard');
});

test('reconnectTab does not fire on Ctrl+Win+R (Win is a distinct modifier)', () => {
    const { f, calls } = reconnectFixture({ id: 'ssh1', type: 'ssh' });
    const ev = f.keydown({ key: 'r', ctrlKey: true, shiftKey: true, metaKey: true, target: XTERM_TARGET });
    assert.equal(ev.defaultPrevented, undefined, 'Ctrl+Shift+Win+R reaches the terminal');
    assert.deepEqual(calls, []);
});

test('settings table lists the reconnect row with its default combo', () => {
    const f = fixture();
    f.context.renderShortcutsList();
    assert.match(f.table.innerHTML, /重新连接 SSH 会话/);
    assert.match(f.table.innerHTML, /Ctrl\+Shift\+R/);
});
