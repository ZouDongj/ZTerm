// Reopening the settings tab while its close animation is still pending must
// not resurrect the closing tab: settings.js openSettings used to find ANY
// settings tab and switchTo it — including one already committed to close —
// so the deferred doRemove then spliced that very tab out and the user fell
// back to a terminal (the e2e cross-focus probe right-clicked the terminal
// instead of the settings inputs; root-caused in
// artifacts/e2e-tmp/12-edit-trace.log).
//
// Loads the REAL TabManager (render/switchTo/closeTab/doRemove + the shared
// TimerQueue from tests/helpers/renderer-vm.mjs) and the REAL settings.js
// (openSettings/closeSettingsTab) on top. Environment notes: the shared fake
// DOM supplies the tab strip, settings pane and body; settings.js's
// loadSettingsIntoForm null-guards every missing input, so the open/close
// path needs no further stubs. The close animation's deferred removal runs
// only when the recorded timer queue advances — that is the race window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const settingsSrc = readFileSync(new URL('../src/renderer/settings.js', import.meta.url), 'utf8');

function loadSettingsTabsVm() {
    const ctx = loadVm();
    // One real local tab so there is a non-settings surface to fall back to.
    wiredTab(ctx, 't_local', 'local_1', 'content');
    ctx.TabManager.render();
    // Environment stubs (documented): the form-loading branch of switchTo
    // reaches helpers defined in later scripts (split.js's setToggle) and
    // unrelated settings UI builders; their bodies are irrelevant to the
    // open/close lifecycle under test.
    ctx.setToggle = () => {};
    ctx.populateFontList = ctx.populateFontList || (() => {});
    ctx.populateTerminalSchemeSelect = ctx.populateTerminalSchemeSelect || (() => {});
    ctx.renderAccentSwatches = ctx.renderAccentSwatches || (() => {});
    ctx.updateAccentDot = ctx.updateAccentDot || (() => {});
    ctx.escHtml = ctx.escHtml || (x => String(x));
    vm.runInContext(settingsSrc, ctx, { filename: 'settings.js' });
    return ctx;
}

function activeSettings(ctx) {
    return ctx.TabManager.tabs.find(t => t.type === 'settings' && t.id === ctx.TabManager.activeId) || null;
}

test('reopening settings during the close animation creates a fresh tab that survives doRemove', () => {
    const ctx = loadSettingsTabsVm();
    const openSettings = () => vm.runInContext('openSettings()', ctx);
    const closeSettingsTab = () => vm.runInContext('closeSettingsTab()', ctx);

    openSettings();
    const first = activeSettings(ctx);
    assert.ok(first, 'settings tab opened and active');

    closeSettingsTab(); // close committed; removal deferred by the 200ms exit window
    assert.ok(ctx.TabManager._closingTabs.has(first.id), 'close animation pending');
    assert.ok(ctx.TabManager.tabs.some(t => t.id === first.id), 'the closing tab is still in the strip');

    openSettings(); // REOPEN inside the animation window — the proven race
    const reopened = activeSettings(ctx);
    assert.ok(reopened, 'a settings tab is active right after reopening');
    assert.ok(!ctx.TabManager._closingTabs.has(reopened.id),
        'the reopened settings tab must be a FRESH tab, not the one already committed to close');

    // Let the deferred removal of the first tab settle.
    ctx.__tq.advance(400);

    const settled = activeSettings(ctx);
    assert.ok(settled, 'after the old tab\'s doRemove settles, a settings tab is still active');
    assert.notEqual(settled.id, first.id, 'the active settings tab is the fresh one, not the removed id');
    assert.equal(ctx.TabManager.tabs.filter(t => t.type === 'settings').length, 1,
        'exactly one settings tab remains (the fresh one)');
    assert.ok(!ctx.TabManager._closingTabs.has(settled.id), 'the survivor is not closing');
});

test('a settled (non-closing) settings tab is still reused by a plain reopen', () => {
    const ctx = loadSettingsTabsVm();
    vm.runInContext('openSettings()', ctx);
    const first = activeSettings(ctx);
    assert.ok(first, 'settings opened');
    // No close in flight: the same tab must be reused, no duplicate created.
    vm.runInContext('openSettings()', ctx);
    const second = activeSettings(ctx);
    assert.equal(second.id, first.id, 'existing live settings tab is reused via switchTo');
    assert.equal(ctx.TabManager.tabs.filter(t => t.type === 'settings').length, 1, 'no duplicate tab');
});
