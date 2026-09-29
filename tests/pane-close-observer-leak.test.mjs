// Closing a pane must disconnect the dying pane-body's ResizeObserver at
// initiation: every path the deferred removal fans into (survivors re-render,
// collapse via _exitSplit, whole-tab closeTab) iterates only SURVIVING panes,
// so the closed pane's observer was never disconnected and Blink kept its
// observed node (and the whole DOM subtree, canvases included) alive. Covers
// all teardown funnels into _closePane: the pane-header × button, the
// Ctrl+Shift+W close shortcut, and the merge/collapse absorption.
// Driven through the REAL tabs.js _closePane in the shared renderer VM
// (tests/helpers/renderer-vm.mjs) with a tracking ResizeObserver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

function trackObservers(ctx) {
    class TrackRO {
        constructor() { this.disconnected = false; }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    ctx.ResizeObserver = TrackRO;
}

function bodyOf(ctx, pane) {
    const b = ctx.document.getElementById('pane-body_' + pane.id);
    assert.ok(b, 'precondition: pane has a body element');
    return b;
}

test('closing a pane with surviving siblings disconnects its body observer, survivors stay live', () => {
    const ctx = loadVm();
    trackObservers(ctx);
    wiredTab(ctx, 't_keep', 'local_k', 'keep');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', 'a', 'local_2', 'b');
    ctx.TabManager.addPaneRelativeTo(tab, 'b'); // third pane (pending backend is fine)
    assert.equal(ctx.getAllPanes(tab).length, 3, 'three panes before the close');
    ctx.__tq.advance(2000); // drain setup timers

    const p1Body = bodyOf(ctx, p1);
    const p2Body = bodyOf(ctx, p2);
    assert.ok(p1Body._resizeObserver, 'precondition: the wired pane body is observed');

    ctx.TabManager._closePane('t_sp', p2.id);
    assert.equal(p2Body._resizeObserver.disconnected, true,
        'the dying pane observer is disconnected at initiation, before the fade');

    ctx.__tq.advance(1000); // removal + survivor re-render
    assert.equal(ctx.getAllPanes(tab).length, 2, 'the two survivors remain');
    assert.equal(p2Body._resizeObserver.disconnected, true,
        'still disconnected after the deferred removal');
    assert.equal(bodyOf(ctx, p1)._resizeObserver.disconnected, false,
        'the surviving pane observer stays live');
});

test('closing a pane that collapses the split disconnects its body observer (merge absorption)', () => {
    const ctx = loadVm();
    trackObservers(ctx);
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', 'a', 'local_2', 'b');
    ctx.__tq.advance(2000);
    const p2Body = bodyOf(ctx, p2);

    ctx.TabManager._closePane('t_sp', p2.id);
    ctx.__tq.advance(1000); // removal + _exitSplit collapse

    assert.equal(tab.splitRoot, null, 'the split collapsed back onto the tab');
    assert.equal(p2Body._resizeObserver.disconnected, true,
        'the closed pane observer is disconnected (the collapse path only touches the survivor)');
    assert.equal(tab.tabId, 'local_1', 'the surviving session owns the tab slot');
});
