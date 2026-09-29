// Cross-tab pane drag: dropping a pane out of a split source (≥2 panes
// remain) discards the source split DOM subtree and rebuilds it — the OLD
// pane-body ResizeObservers must be disconnected before the drop, because
// Blink keeps observed nodes (and their DOM subtrees + closures) alive.
// The codebase's own contract, applied at tabs.js closeTab / _extractPaneToTab
// / _moveTerminalToTab collapse paths, was missed on this rebuild path.
// Driven through the REAL tabs.js _moveTerminalToTab + _renderSplit in the
// shared renderer VM with a tracking ResizeObserver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

test('cross-tab drag out of a split source disconnects every discarded pane-body observer', () => {
    const ctx = loadVm();
    class TrackRO {
        constructor() { this.disconnected = false; }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    ctx.ResizeObserver = TrackRO;

    // Source split with THREE wired panes (moving one out leaves two).
    const { tab: src, p1 } = wiredSplitTab(ctx, 't_src', 'local_1', 'a', 'local_2', 'b');
    ctx.TabManager.addPaneRelativeTo(src, 'b'); // third pane (pending backend is fine)
    assert.equal(ctx.getAllPanes(src).length, 3, 'three panes in the source');
    const tgt = wiredTab(ctx, 't_tgt', 'local_T', 't');
    ctx.__tq.advance(2000); // drain setup timers

    // The dragged pane must be backend-ready (term + tabId): use p1.
    ctx.TabManager._focusPane(src, p1.id);
    const oldBodies = new Map();
    for (const p of ctx.getAllPanes(src)) {
        const b = ctx.document.getElementById('pane-body_' + p.id);
        assert.ok(b, 'precondition: each pane has a body element');
        // Only panes with a terminal are observed (a pending pane has none).
        if (p.term) assert.ok(b._resizeObserver, 'precondition: each terminal pane body is observed');
        oldBodies.set(p.id, b);
    }

    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 't', null);

    assert.equal(ctx.getAllPanes(src).length, 2, 'source keeps its two survivors');
    for (const [pid, body] of oldBodies) {
        if (!body._resizeObserver) continue; // the pending pane's body was never observed
        assert.equal(body._resizeObserver.disconnected, true,
            `old pane-body observer of ${pid} disconnected before the subtree drop`);
    }
    // The survivors were rebuilt with fresh bodies AND fresh live observers.
    for (const p of ctx.getAllPanes(src)) {
        const nb = ctx.document.getElementById('pane-body_' + p.id);
        assert.ok(nb && nb !== oldBodies.get(p.id), 'survivor body rebuilt');
        if (p.term) {
            assert.ok(nb._resizeObserver && !nb._resizeObserver.disconnected,
                'survivor rebuilt with a live observer');
        }
    }
    assert.ok(ctx.getAllPanes(tgt).some(p => p.tabId === 'local_1'), 'the moved pane arrived');
});
