// tabs-2: the three split-collapse paths (_closePane's doRemove,
// _extractPaneToTab's lone-survivor branch, _moveTerminalToTab's source
// collapse) wrote tab.name = <surviving pane's name> UNCONDITIONALLY. The
// survivor's name froze at split time, so a manual rename (which sets the
// _customName lock) was overwritten with the stale pre-rename name — and the
// lock then kept _updateTabName from ever recomputing it, persisting the loss
// via saveConfig. The fix: the collapse adoption is guarded by !_customName.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// Rename AFTER the split (the reported order): the panes keep the split-time
// names, the tab carries the user's name plus the lock.
function renamedSplit(ctx, id, b1, b2) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, id, b1, 'a', b2, 'b');
    const stale = tab.name; // what both pane names still carry
    tab.name = 'work';
    tab._customName = true;
    return { tab, p1, p2, stale };
}

test('pane close collapsing the split keeps the manual rename', () => {
    const ctx = loadVm();
    const { tab, p2, stale } = renamedSplit(ctx, 't1', 'local_1', 'local_2');

    ctx.TabManager._closePane(tab.id, p2.id);
    ctx.__tq.advance(250); // pane exit fade → doRemove → collapse

    assert.equal(tab.splitRoot, null, 'split collapsed onto the survivor');
    assert.equal(tab.name, 'work', 'the manual rename survives the collapse');
    assert.notEqual(stale, 'work');
});

test('extracting a pane (source collapses) keeps the manual rename', () => {
    const ctx = loadVm();
    const { tab, p2 } = renamedSplit(ctx, 't1', 'local_1', 'local_2');

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);

    assert.equal(tab.splitRoot, null, 'source collapsed to a single terminal');
    assert.equal(tab.name, 'work', 'the manual rename survives the collapse');
    assert.equal(ctx.TabManager.tabs.length, 2, 'the extracted pane became its own tab');
});

test('dragging a pane into another tab (source collapses) keeps the manual rename', () => {
    const ctx = loadVm();
    const { tab, p2 } = renamedSplit(ctx, 't_src', 'local_1', 'local_2');
    const target = wiredTab(ctx, 't_tgt', 'local_9');

    // Move the focused pane (p2) out; the source collapse runs synchronously.
    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);

    assert.equal(tab.splitRoot, null, 'source collapsed after the pane moved out');
    assert.equal(tab.name, 'work', 'the manual rename survives the collapse');
});

test('(control) an unlocked tab still adopts the surviving pane name on collapse', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't1', 'local_1', 'a', 'local_2', 'b');
    ctx.getAllPanes(tab)[0].name = 'survivor-name';

    ctx.TabManager._closePane(tab.id, p2.id);
    ctx.__tq.advance(250);

    assert.equal(tab.splitRoot, null, 'split collapsed');
    assert.equal(tab.name, 'survivor-name', 'auto naming still follows the survivor');
});
