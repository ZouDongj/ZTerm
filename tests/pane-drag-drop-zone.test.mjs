// Pane drag: a drop zone naming a sub-container that collapses when the
// dragged pane detaches must be re-anchored to the surviving sibling.
// Driven through the REAL tabs.js _movePaneToZone / add / split-layout
// normalize in the shared renderer VM (tests/helpers/renderer-vm.mjs).
// Old code: detach + normalize removed the zone's relativeTo from the tree,
// add() then repacked the root with indexOf(relativeTo) === -1, and the pane
// landed on a root edge (possibly the opposite end) instead of beside the
// subtree the user dropped on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredSplitTab } from './helpers/renderer-vm.mjs';

// root(v)[p1, container(h)[p2, p3]] — the nested two-child container.
function nestedThree(ctx) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', 'a', 'local_2', 'b');
    ctx.TabManager._focusPane(tab, p2.id); // takes the tab OBJECT
    ctx.TabManager.addPaneRelativeTo(tab, 'r'); // splits p2 horizontally
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 3, 'three panes after the nested split');
    const p3 = panes.find(p => p !== p1 && p !== p2);
    const container = ctx.getParentOf(tab, p2);
    assert.ok(container && container.orientation === 'h' && container.children.length === 2,
        'precondition: p2/p3 share a two-child sub-container');
    return { tab, p1, p2, p3, container };
}

test('dropping onto a sub-container that collapses during detach lands beside the surviving sibling', () => {
    const ctx = loadVm();
    const { tab, p1, p2, p3, container } = nestedThree(ctx);
    ctx.TabManager._paneDragState = { sourceTab: tab, sourcePane: p2, zones: [], ghost: null };

    // Zone bar on the right of the [p2|p3] sub-container (a real drop zone:
    // spanner/child side bars name the container child directly).
    ctx.TabManager._movePaneToZone(tab, { side: 'r', relativeTo: container });

    // (ids reified into a test-realm array: VM-realm arrays fail deepStrictEqual's prototype check)
    assert.deepEqual([...ctx.getAllPanes(tab).map(p => p.id)], [p1.id, p3.id, p2.id],
        'the pane lands right of the surviving sibling, not on a root edge');
    assert.equal(ctx.getParentOf(tab, p2), ctx.getParentOf(tab, p3),
        'the dragged pane shares a container with the surviving sibling');
    assert.equal(ctx.TabManager._paneDragState, null, 'drag state cleaned up');
});

test('a root-edge drop (relativeTo null) is unaffected by the re-anchor', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = nestedThree(ctx);
    ctx.TabManager._paneDragState = { sourceTab: tab, sourcePane: p1, zones: [], ghost: null };

    ctx.TabManager._movePaneToZone(tab, { side: 't', relativeTo: null });

    const panes = ctx.getAllPanes(tab);
    assert.equal(panes[0], p1, 'root-edge repack still puts the pane at the zone side');
    assert.equal(panes.length, 3, 'no pane lost');
});
