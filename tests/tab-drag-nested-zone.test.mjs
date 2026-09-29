// Tab→split drop on a NESTED container's edge bar: the zone names the
// container child (split containers carry no pane id), and the id-only
// transport degraded every such hit to a whole-split root-edge insert — the
// pane landed on the outermost edge while the bar promised the container's
// edge. The hit must anchor on the node that owns the bar; top-level
// (root-edge) and pane-anchored drops keep their exact previous semantics.
// Driven through the REAL tabs.js _tabResolveZoneHit / _moveTerminalToTab /
// add / split-layout normalize in the shared renderer VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// root(v)[p1, C(h)[p2, p3]] — the nested container under test.
function nestedTarget(ctx) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_tgt', 'local_1', 'a', 'local_2', 'b');
    ctx.TabManager._focusPane(tab, p2.id);
    ctx.TabManager.addPaneRelativeTo(tab, 'r'); // splits p2 horizontally
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 3, 'three panes after the nested split');
    const p3 = panes.find(p => p !== p1 && p !== p2);
    const C = ctx.getParentOf(tab, p2);
    assert.ok(C && C.orientation === 'h' && C.children.length === 2,
        'precondition: p2/p3 share a nested h container');
    assert.notEqual(ctx.getParentOf(tab, C), null, 'precondition: the container is not the root');
    return { tab, p1, p2, p3, C };
}

test('_tabResolveZoneHit maps root, pane and nested-container bars to their anchors', () => {
    const ctx = loadVm();
    const paneNode = { id: 'p_42' };
    const contNode = { orientation: 'h', children: [], ratios: [] };

    assert.deepEqual({ ...ctx.TabManager._tabResolveZoneHit({ side: 'l', relativeTo: null }) },
        { side: 'l', targetPaneId: null, anchor: null }, 'root bar → root insert');

    const paneHit = ctx.TabManager._tabResolveZoneHit({ side: 'b', relativeTo: paneNode });
    assert.deepEqual({ ...paneHit }, { side: 'b', targetPaneId: 'p_42', anchor: paneNode },
        'pane bar → pane id, exactly as before');

    const contHit = ctx.TabManager._tabResolveZoneHit({ side: 'l', relativeTo: contNode });
    assert.deepEqual({ ...contHit }, { side: 'l', targetPaneId: null, anchor: contNode },
        'container bar → the container node itself (no pane id to lose)');
});

test('dropping on a nested container edge bar inserts at that container, not the whole split edge', () => {
    const ctx = loadVm();
    const { tab, p1, p2, p3, C } = nestedTarget(ctx);
    const src = wiredTab(ctx, 't_src', 'local_S', 's');
    ctx.__tq.advance(2000);

    // C's left-edge bar (a real zone: children of a v container get l/r bars).
    ctx.TabManager._moveTerminalToTab('t_src', 't_tgt', 'l', null, C);

    assert.equal(ctx.TabManager.tabs.includes(src), false, 'source tab consumed');
    const np = ctx.getAllPanes(tab).find(p => p.tabId === 'local_S');
    assert.ok(np, 'the dragged terminal arrived as a pane');
    // add() wraps C for the orientation change; normalize then flattens the
    // same-orientation C into the wrap — the VISUAL contract is what matters:
    // np sits directly LEFT of C's whole subtree, inside C's former slot.
    const wrap = ctx.getParentOf(tab, np);
    assert.ok(wrap && wrap.orientation === 'h', 'inserted through the orientation wrap beside the container');
    assert.equal(wrap.children[0], np, 'new pane on the bar side (left of the container subtree)');
    assert.equal(ctx.getParentOf(tab, p2), wrap, 'the container content sits beside np, not above/below it');
    assert.equal(ctx.getParentOf(tab, p3), wrap, 'the whole container subtree stayed on np\'s right');
    assert.equal(ctx.getParentOf(tab, p1), tab.splitRoot, 'the sibling pane stays directly in the root');
    assert.equal(tab.splitRoot.orientation, 'v',
        'the ROOT layout is not repacked (the old id-only transport wrapped the whole split)');
    assert.equal(tab.splitRoot.children.length, 2, 'root keeps [p1, wrap] — the wrap holds C\'s former slot');
});

test('pane-id anchored drops keep their exact previous semantics', () => {
    const ctx = loadVm();
    const { tab, p1, p2, C } = nestedTarget(ctx);
    const src = wiredTab(ctx, 't_src', 'local_S', 's');
    ctx.__tq.advance(2000);

    ctx.TabManager._moveTerminalToTab('t_src', 't_tgt', 'b', p1.id);

    const np = ctx.getAllPanes(tab).find(p => p.tabId === 'local_S');
    assert.ok(np, 'arrived');
    assert.equal(ctx.getParentOf(tab, np), tab.splitRoot, 'inserted directly in the root');
    assert.deepEqual([...tab.splitRoot.children.map(c => c === np ? 'np' : c === p1 ? 'p1' : c === C ? 'C' : '?')],
        ['p1', 'np', 'C'], 'below p1, before the nested container');
});

test('root-edge drops (no anchor) keep their exact previous semantics', () => {
    const ctx = loadVm();
    const { tab, p1, C } = nestedTarget(ctx);
    const src = wiredTab(ctx, 't_src', 'local_S', 's');
    ctx.__tq.advance(2000);

    ctx.TabManager._moveTerminalToTab('t_src', 't_tgt', 't', null);

    const np = ctx.getAllPanes(tab).find(p => p.tabId === 'local_S');
    assert.ok(np, 'arrived');
    assert.equal(ctx.getParentOf(tab, np), tab.splitRoot, 'inserted at the root level');
    assert.equal(tab.splitRoot.children[0], np, 'on top of the whole split');
    assert.equal(tab.splitRoot.children[1], p1, 'the previous root follows (normalize merges the repack)');
    assert.equal(ctx.getParentOf(tab, C), tab.splitRoot, 'the nested container is still a root child');
});

test('a stale container anchor (tree changed mid-drag) drops the drop', () => {
    const ctx = loadVm();
    const { tab } = nestedTarget(ctx);
    const src = wiredTab(ctx, 't_src', 'local_S', 's');
    ctx.__tq.advance(2000);

    const stray = { orientation: 'h', children: [], ratios: [] }; // not in any tree
    ctx.TabManager._moveTerminalToTab('t_src', 't_tgt', 'l', null, stray);

    assert.equal(ctx.TabManager.tabs.includes(src), true, 'drop refused, source untouched');
    assert.equal(ctx.getAllPanes(tab).some(p => p.tabId === 'local_S'), false, 'nothing moved into the target');
    assert.equal(src.term && !src.term.disposed, true, 'the source terminal is intact');
});
