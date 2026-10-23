// A manual rename on a SINGLE tab names that session, not the future split
// container: on the first split (keyboard split or drag-in) the custom name
// demotes onto the original pane (which _newPaneData already seeds from
// tab.name) and the tab-level _customName lock drops, so the tab joins its
// pane names again ("MyServer | Git Bash"). Renaming a tab AFTER it split
// still locks the container name explicitly — that lock is untouched here.
//
// REAL in this VM: tabs.js (addPaneRelativeTo first-split branch,
// _moveTerminalToTab target promotion, _updateTabName) and tab-title-utils.js
// (resolveTabName) via tests/helpers/renderer-vm.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

test('dragging a terminal into a renamed single tab demotes the rename and joins', () => {
    const ctx = loadVm();
    const target = wiredTab(ctx, 't_tgt', 'local_1');
    target.name = 'MyServer';
    target._customName = true; // renamed while single
    const source = wiredTab(ctx, 't_src', 'local_9');
    source.name = 'Git Bash';

    ctx.TabManager._moveTerminalToTab(source.id, target.id, 'r', null);

    assert.ok(target.splitRoot, 'target became a split tab');
    assert.equal(target._customName, undefined, 'the tab-level lock demoted');
    const panes = ctx.getAllPanes(target);
    assert.equal(panes.length, 2, 'two panes after the drag-in');
    assert.equal(panes[0].name, 'MyServer', 'the custom name rides the original pane');
    assert.equal(panes[1].name, 'Git Bash', 'the dragged pane keeps its name');
    assert.equal(target.name, 'MyServer | Git Bash', 'the tab re-joins its pane names');
});

test('keyboard-splitting a renamed single tab demotes the rename', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't1', 'local_1');
    tab.name = 'MyServer';
    tab._customName = true;

    ctx.TabManager.addPaneRelativeTo(tab, 'r');

    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'split built');
    assert.equal(tab._customName, undefined, 'lock demoted');
    assert.equal(panes[0].name, 'MyServer', 'custom name on the original pane');
    // Both panes still carry the demoted name → the deduped join shows it once.
    assert.equal(tab.name, 'MyServer');
    // Once the new pane's own session name arrives, the join reflects it.
    panes[1].name = 'pwsh-session';
    ctx.TabManager._updateTabName(tab);
    assert.equal(tab.name, 'MyServer | pwsh-session');
});

test('(control) a tab renamed AFTER the split keeps its container lock on drag-in', () => {
    const ctx = loadVm();
    const { tab } = wiredSplitTab(ctx, 't_tgt', 'local_1', 'a', 'local_2', 'b');
    tab.name = 'Deploy window';
    tab._customName = true; // explicit rename of the split container
    const source = wiredTab(ctx, 't_src', 'local_9');

    ctx.TabManager._moveTerminalToTab(source.id, tab.id, 'r', null);

    assert.equal(ctx.getAllPanes(tab).length, 3, 'pane joined the existing split');
    assert.equal(tab._customName, true, 'container rename stays locked');
    assert.equal(tab.name, 'Deploy window', 'container rename wins over pane joins');
});

test('a demoted rename still outranks the pane tool-name overlay', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't1', 'local_1');
    tab.name = 'MyServer';
    tab._customName = true;
    tab._toolName = 'ai-task'; // the tool label was active before the split

    ctx.TabManager.addPaneRelativeTo(tab, 'r');

    const panes = ctx.getAllPanes(tab);
    assert.equal(panes[0]._manualName, true, 'demote marked the original pane');
    assert.equal(panes[0]._toolName, 'ai-task', 'the tool overlay moved onto the pane');
    panes[1].name = 'pwsh-session';
    ctx.TabManager._updateTabName(tab);
    // Display: the demoted manual name wins over the tool name on its pane —
    // the same priority the tab-level lock gave it before the split.
    assert.equal(ctx.TabManager._tabDisplayName(tab), 'MyServer | pwsh-session');
    // The persisted base name never carries the tool overlay either.
    assert.equal(tab.name, 'MyServer | pwsh-session');
});

test('closing the other pane after a demote restores the tab-level rename lock', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't1', 'local_1');
    tab.name = 'MyServer';
    tab._customName = true;
    ctx.TabManager.addPaneRelativeTo(tab, 'r');
    const panes = ctx.getAllPanes(tab);
    assert.equal(tab._customName, undefined, 'demoted');
    const p2 = panes[1];
    p2.tabId = 'local_2';
    ctx.wireTerminalToPane(tab, p2);

    ctx.TabManager._closePane(tab.id, p2.id);
    ctx.__tq.advance(250); // pane exit fade → doRemove → collapse

    assert.equal(tab.splitRoot, null, 'collapsed to a single terminal');
    assert.equal(tab.name, 'MyServer', 'the surviving pane name adopted');
    assert.equal(tab._customName, true, 'the manual rename locks the single tab again');
});

test('extracting a pane that carries a demoted rename re-locks it as a single tab', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't1', 'local_1');
    tab.name = 'MyServer';
    tab._customName = true;
    ctx.TabManager.addPaneRelativeTo(tab, 'r');
    const panes = ctx.getAllPanes(tab);
    const p2 = panes[1];
    p2.tabId = 'local_2';
    ctx.wireTerminalToPane(tab, p2);

    const before = ctx.TabManager.tabs.length;
    ctx.TabManager._extractPaneToTab(tab.id, panes[0].id);

    assert.equal(ctx.TabManager.tabs.length, before + 1, 'extracted pane became its own tab');
    const nt = ctx.TabManager.tabs[ctx.TabManager.tabs.length - 1];
    assert.equal(nt.name, 'MyServer');
    assert.equal(nt._customName, true, 'the demoted rename locks the extracted tab again');
});
