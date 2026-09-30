// input-3: _shortcutPassthrough hardcoded Ctrl+P / Ctrl+Shift+P as "panel
// shortcuts" (return false → xterm drops the key). With the default bindings
// the document-level capture dispatcher consumes those combos first, so the
// passthrough only mattered AFTER the user rebound commandPalette /
// quickCommands — exactly the case where the freed combo must reach the
// terminal (bash history, vim completion). The fix reads the CURRENT
// bindings: only the live combos are withheld.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

// shortcut-utils.js + shortcuts.js are not part of the shared seam; load the
// real comboFromEvent and stage a controllable _getShortcutBindings, exactly
// like the page resolves them (both plain-script globals).
function loadVmWithBindings(defaults, overrides) {
    const ctx = loadVm();
    vm.runInContext(readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8'), ctx, { filename: 'shortcut-utils.js' });
    const merged = JSON.stringify({ ...defaults, ...(overrides || {}) });
    vm.runInContext(`_getShortcutBindings = () => (${merged});`, ctx);
    return ctx;
}

const key = (init) => ({
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'p', ...init,
});

// The default bindings: both combos stay withheld from the terminal.
const DEFAULTS = { commandPalette: 'Ctrl+P', quickCommands: 'Ctrl+Shift+P' };

test('default bindings: Ctrl+P and Ctrl+Shift+P are still handed to the dispatcher', () => {
    const ctx = loadVmWithBindings(DEFAULTS);
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), false,
        'live Ctrl+P is consumed (dispatcher owns it)');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, shiftKey: true })), false,
        'live Ctrl+Shift+P is consumed');
});

test('rebound commandPalette: the freed Ctrl+P falls through to the terminal', () => {
    const ctx = loadVmWithBindings(DEFAULTS, { commandPalette: 'Ctrl+Alt+P' });
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), true,
        'freed Ctrl+P reaches the shell (^P, no longer a dead key)');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, altKey: true })), false,
        'the NEW combo is the withheld one now');
});

test('rebound quickCommands: the freed Ctrl+Shift+P falls through to the terminal', () => {
    const ctx = loadVmWithBindings(DEFAULTS, { quickCommands: 'Ctrl+K' });
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, shiftKey: true })), true,
        'freed Ctrl+Shift+P reaches the shell');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, key: 'k' })), false,
        'the NEW combo is the withheld one now');
});

test('unrelated combos and plain keys always pass through', () => {
    const ctx = loadVmWithBindings(DEFAULTS);
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({})), true, 'plain p');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, key: 'c' })), true, 'Ctrl+C');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, altKey: true })), true,
        'Ctrl+Alt+P was never a panel combo');
});

test('cleared binding: the freed panel combo falls through to the terminal', () => {
    // '' = explicit "no combo bound" override; it must never match a real
    // combo, so the action's old combo reaches the shell while the sibling
    // panel combo stays withheld.
    const ctx = loadVmWithBindings(DEFAULTS, { commandPalette: '' });
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), true,
        'the cleared commandPalette frees Ctrl+P for the shell');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, shiftKey: true })), false,
        'the still-bound quickCommands combo is still withheld');
});
