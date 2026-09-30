// perf: _shortcutPassthrough (terminal.js) runs _getShortcutBindings() on
// every terminal key event — xterm calls customKeyEventHandler once per
// keydown/keypress/keyup — and each call re-ran the {...defaults,
// ...overrides} merge and allocated a fresh object. The fix caches the
// merged bindings keyed on the overrides object identity (whole-config
// replacements re-key implicitly, loadSettings reload included) and drops
// the cache in persistShortcuts(), the funnel every customization write
// passes through. These tests load the REAL shortcut-utils.js +
// shortcuts.js + terminal.js (via the shared renderer-vm harness) and pin:
// cache hits (same reference, zero re-merges), invalidation on the real
// save paths, and the untouched default path (control group — same
// expectations as wf2-frontend-core-shortcut-passthrough-bindings, which
// stages a stubbed merge instead of the real one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

// Same loading seam as wf2-frontend-core-shortcut-passthrough-bindings:
// shortcut-utils.js + shortcuts.js are plain-script globals layered on the
// shared harness VM (which already loaded the REAL terminal.js). The real
// mergeShortcutBindings is wrapped with a counter AFTER shortcut-utils.js
// loads and BEFORE shortcuts.js runs, so every product merge is observable.
function loadVmWithShortcuts(overrides) {
    const ctx = loadVm();
    if (overrides) ctx._settingsConfig.shortcuts = { ...overrides };
    vm.runInContext(readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8'), ctx, { filename: 'shortcut-utils.js' });
    const merges = { count: 0 };
    const realMerge = ctx.mergeShortcutBindings;
    ctx.mergeShortcutBindings = (defaults, user) => {
        merges.count++;
        return realMerge(defaults, user);
    };
    vm.runInContext(readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8'), ctx, { filename: 'shortcuts.js' });
    return { ctx, merges };
}

const key = (init) => ({
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'p', ...init,
});

test('cache: repeated calls return the same object with a single merge', () => {
    const { ctx, merges } = loadVmWithShortcuts({ commandPalette: 'Ctrl+Alt+P' });
    const first = ctx._getShortcutBindings();
    for (let i = 0; i < 10; i++) assert.equal(ctx._getShortcutBindings(), first, `call #${i} reuses the cached object`);
    assert.equal(merges.count, 1, 'ten lookups, one merge');
    // Merge semantics unchanged: the override wins, untouched defaults stay.
    assert.equal(first.commandPalette, 'Ctrl+Alt+P');
    assert.equal(first.quickCommands, 'Ctrl+Shift+P');
    assert.equal(first.closeTab, 'Ctrl+W');
});

test('default path unchanged: passthrough withholds the live panel combos and passes everything else', () => {
    const { ctx } = loadVmWithShortcuts();
    const bindings = ctx._getShortcutBindings();
    assert.equal(bindings.commandPalette, 'Ctrl+P');
    assert.equal(bindings.quickCommands, 'Ctrl+Shift+P');
    const tab = wiredTab(ctx, 't1', 'local_1');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), false,
        'live Ctrl+P is consumed (dispatcher owns it)');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, shiftKey: true })), false,
        'live Ctrl+Shift+P is consumed');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, key: 'c' })), true, 'unrelated combo passes');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({})), true, 'plain key passes');
});

test('saving a new binding through the REAL capture flow invalidates the cache; passthrough follows immediately', () => {
    const { ctx, merges } = loadVmWithShortcuts();
    const tab = wiredTab(ctx, 't1', 'local_1');
    // Record the capture listeners the harness document would otherwise drop
    // (its addEventListener is a no-op and it has no removeEventListener).
    const listeners = [];
    ctx.document.addEventListener = (type, fn) => listeners.push([type, fn]);
    ctx.document.removeEventListener = () => {};
    ctx.startShortcutCapture('commandPalette', { textContent: '修改', classList: { add() {} } });
    const onKey = listeners.find(([type]) => type === 'keydown')[1];
    onKey({ key: 'k', ctrlKey: true, preventDefault() {}, stopPropagation() {} });

    // The write went through the real persistShortcuts funnel.
    const save = ctx.__sends.find(s => s.cmd === 'save-shortcuts');
    assert.ok(save, 'save-shortcuts was sent');
    assert.deepEqual(JSON.parse(JSON.stringify(save.payload)), { commandPalette: 'Ctrl+K' });

    // Conflict-check merge (#1) → invalidation → exactly one re-merge (#2)
    // serving both passthrough probes.
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), true,
        'freed Ctrl+P falls through to the terminal right after the save');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, key: 'k' })), false,
        'the NEW combo is the withheld one now');
    assert.equal(merges.count, 2, 'cache was dropped once and rebuilt once');
});

test('resetShortcut (in-place delete) invalidates the cache: defaults are live again', () => {
    const { ctx, merges } = loadVmWithShortcuts({ commandPalette: 'Ctrl+Alt+P' });
    const warm = ctx._getShortcutBindings();
    assert.equal(warm.commandPalette, 'Ctrl+Alt+P');

    ctx.resetShortcut('commandPalette');

    const fresh = ctx._getShortcutBindings();
    assert.notEqual(fresh, warm, 'stale cache object was not served');
    assert.equal(fresh.commandPalette, 'Ctrl+P', 'default binding restored');
    assert.equal(merges.count, 2);
});

test('config reload (whole _settingsConfig replacement, loadSettings shape) re-keys without any persist call', () => {
    const { ctx, merges } = loadVmWithShortcuts();
    const tab = wiredTab(ctx, 't1', 'local_1');
    ctx._getShortcutBindings(); // warm the cache (merge #1)

    // What loadSettings does: builds a brand-new config object, so .shortcuts
    // is a new reference — no persistShortcuts() is involved on this path.
    ctx._settingsConfig = { ...ctx._settingsConfig, shortcuts: { commandPalette: 'Ctrl+Alt+P' } };

    assert.equal(ctx._getShortcutBindings().commandPalette, 'Ctrl+Alt+P', 'reload is reflected');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true })), true,
        'freed Ctrl+P falls through after the reload');
    assert.equal(ctx._shortcutPassthrough(tab.term, key({ ctrlKey: true, altKey: true })), false,
        'the reloaded combo is the withheld one now');
    assert.equal(merges.count, 2, 're-merged exactly once for the new overrides');
});

test('ordinary settings saves (spread that keeps the shortcuts reference) do NOT re-merge', () => {
    const { ctx, merges } = loadVmWithShortcuts({ quickCommands: 'Ctrl+K' });
    const warm = ctx._getShortcutBindings();

    // saveAppearance / saveTerminal shape: the spread copies the .shortcuts
    // reference into the new config — bindings are unchanged, so the cache
    // must survive (no pointless re-merge per settings save).
    ctx._settingsConfig = { ...ctx._settingsConfig, fontSize: 18 };

    assert.equal(ctx._getShortcutBindings(), warm, 'cache object is reused');
    assert.equal(merges.count, 1, 'no re-merge while the overrides reference is unchanged');
    assert.equal(warm.quickCommands, 'Ctrl+K');
});
