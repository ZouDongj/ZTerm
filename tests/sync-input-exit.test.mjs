// Sync input must end when a split collapses, and clicking a terminal that
// was extracted into its own tab must not touch the SOURCE tab's sync state.
//
// Two coupled defects:
// 1. No code reset tab.syncInput when the split tree went away (extract of
//    the second-to-last pane, pane-close merge via _exitSplit, drag-out
//    merge via _moveTerminalToTab). The stale flag silently resumed
//    broadcasting on the next re-split, and the click-to-exit handler could
//    still flip it — showing a "sync input off" toast on a tab with no split.
// 2. _bindSyncExitOnClick's mousedown handler fell back to the tab captured
//    at wiring time when the terminal had no .split-pane ancestor. After
//    _extractPaneToTab moved term.element into a fresh single-tab wrap, a
//    click there flipped the SOURCE tab's syncInput off (and toasted), even
//    though the user was looking at a different tab. The handler now
//    re-resolves the terminal's CURRENT owner in that fallback branch.
//
// REAL in this VM: terminal.js (_bindSyncExitOnClick, _resolveTermOwner) and
// tabs.js (_extractPaneToTab, _exitSplit, _moveTerminalToTab, _renderSplit)
// via tests/helpers/renderer-vm.mjs; showToast is recorded, everything else
// follows the shared harness contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// What the syncInput shortcut toggle does (shortcuts.js), minus the toast.
function enableSync(ctx, tab) {
    tab.syncInput = true;
    const rootEl = ctx.document.getElementById('split_' + tab.id);
    if (rootEl) rootEl.classList.add('sync-input');
}

test('extract collapsing the source split resets its sync input', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_s', 'local_1', null, 'local_2', null);
    enableSync(ctx, tab);

    ctx.TabManager._extractPaneToTab(tab.id, p2.id); // one pane left → collapse
    assert.equal(tab.splitRoot, null, 'source collapsed back to a single tab');
    assert.equal(tab.syncInput, false, 'sync input ends with the split');
    assert.equal(ctx.document.getElementById('split_' + tab.id), null, 'split DOM is gone');
});

test('click in the extracted tab does not flip the source split sync state or toast', () => {
    const ctx = loadVm();
    const toasts = [];
    ctx.showToast = (m) => toasts.push(m);
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_s', 'local_1', null, 'local_2', null);
    // A third pane keeps the source split alive across the extraction.
    p1.focused = false; p2.focused = true;
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const p3 = ctx.getAllPanes(tab).find(p => p !== p1 && p !== p2);
    p3.tabId = 'local_3';
    ctx.wireTerminalToPane(tab, p3);
    enableSync(ctx, tab);

    ctx.TabManager._extractPaneToTab(tab.id, p3.id);
    assert.equal(ctx.getAllPanes(tab).length, 2, 'source split survives');
    assert.equal(tab.syncInput, true, 'surviving split keeps sync input');
    const nt = ctx.TabManager.tabs.find(t => t !== tab && t.term === p3.term);
    assert.ok(nt, 'extracted tab owns the terminal');
    assert.equal(p3.term.element.closest('.split-pane'), null, 'moved terminal has no split-pane ancestor');

    toasts.length = 0;
    p3.term.element.dispatch('mousedown', {});
    assert.equal(tab.syncInput, true, 'source split broadcast state untouched');
    assert.deepEqual(toasts, [], 'no phantom "sync input off" toast');
    assert.equal(ctx.document.getElementById('split_' + tab.id).classList.contains('sync-input'), true,
        'sync-input marker class kept on the surviving split');
});

test('click inside a live split still exits sync input (feature guard)', () => {
    const ctx = loadVm();
    const toasts = [];
    ctx.showToast = (m) => toasts.push(m);
    const { tab, p1 } = wiredSplitTab(ctx, 't_s', 'local_1', null, 'local_2', null);
    enableSync(ctx, tab);

    p1.term.element.dispatch('mousedown', {});
    assert.equal(tab.syncInput, false, 'click exits sync input');
    assert.deepEqual(toasts, ['同步输入已关闭']);
    assert.equal(ctx.document.getElementById('split_' + tab.id).classList.contains('sync-input'), false,
        'marker class removed');
});

test('pane-close merge (_exitSplit) resets sync input', () => {
    const ctx = loadVm();
    const { tab } = wiredSplitTab(ctx, 't_s2', 'local_1', null, 'local_2', null);
    enableSync(ctx, tab);

    ctx.TabManager._exitSplit(tab);
    assert.equal(tab.splitRoot, null);
    assert.equal(tab.syncInput, false, 'sync input ends with the merge');
});

test('drag-out merge (_moveTerminalToTab) resets the source tab sync input', () => {
    const ctx = loadVm();
    const { tab: src, p2 } = wiredSplitTab(ctx, 't_src', 'local_1', null, 'local_2', null);
    enableSync(ctx, src);
    const tgt = wiredTab(ctx, 't_tgt', 'local_3', null);

    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 't', null);
    assert.equal(src.splitRoot, null, 'source collapsed after its focused pane was dragged out');
    assert.equal(src.syncInput, false, 'sync input ends with the drag-out merge');
    assert.ok(ctx.getAllPanes(tgt).some(p => p.term === p2.term), 'pane landed on the target split');
});
