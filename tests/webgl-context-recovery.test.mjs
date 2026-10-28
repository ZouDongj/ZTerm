// WebGL context-loss recovery (bounded auto re-attach of the smooth cursor).
//
// REAL in this VM: terminal.js's _attachWebglRenderer / _detachWebglRenderer /
// _releaseWebglForTerm / _wireSmoothCursorWebgl record+wrapper bookkeeping and
// the tabs.js TabManager wiring via tests/helpers/renderer-vm.mjs (loaded with
// wireSmoothCursorStub:false so the REAL wrapper wiring runs).
//
// FAKED per the harness conventions: WebglAddon (controllable context loss,
// dispose recording, the vendored _renderer._gl.isContextLost shape verified
// against src/vendor/addon-webgl.js and scripts/e2e-webgl-atlas.mjs) and
// createXtermWebglSmoothCursor (records which addon each adapter binds and
// mirrors the real guard: it refuses an addon whose renderer is no longer
// active, i.e. a disposed addon).
//
// The vendor addon fires onContextLoss only after a 3s restore window passes
// without webglcontextrestored; loseContextUnrecovered() simulates that
// elapsed window synchronously. Marking `lost = true` alone models the state
// INSIDE the window (gl.isContextLost() true, onContextLoss not yet fired).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

function installWebglFakes(ctx) {
    const instances = [];
    const creations = [];
    class FakeWebglAddon {
        constructor() {
            this.disposed = false;
            this.lost = false;
            this.lossHandlers = [];
            this.everRegistered = []; // retained across dispose for stale-fire tests
            this._renderer = { _gl: { isContextLost: () => this.lost } };
            instances.push(this);
        }
        onContextLoss(cb) { this.lossHandlers.push(cb); this.everRegistered.push(cb); }
        loseContextUnrecovered() {
            this.lost = true;
            for (const cb of this.lossHandlers.slice()) cb({ preventDefault() {} });
        }
        dispose() { this.disposed = true; this.lossHandlers.length = 0; }
    }
    ctx.WebglAddon = FakeWebglAddon;
    ctx.createXtermWebglSmoothCursor = (opts) => {
        const addon = opts?.addon;
        creations.push(addon);
        if (!addon || addon.disposed) {
            throw new Error('Smooth cursor requires the active xterm WebGL renderer');
        }
        return {
            disposed: false,
            setSmooth() {}, setCursorStyle() {}, noteInput() {},
            dispose() { this.disposed = true; },
        };
    };
    return { instances, creations };
}

function attachActive(ctx, tab) {
    ctx.TabManager.activeId = tab.id;
    ctx._attachWebglRenderer(tab, tab.term);
}

test('unrecovered context loss on the active tab auto-reattaches a fresh context once', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, creations } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_loss', 'local_loss', 'x');
    attachActive(ctx, tab);
    assert.equal(instances.length, 1, 'one context after the initial attach');
    const firstWrapper = tab._smoothCursor;
    assert.ok(firstWrapper?._adapter, 'adapter wired on the initial attach');

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // deferred release + bounded recovery both scheduled at +0ms

    assert.equal(instances.length, 2, 'a replacement context was created for the active tab');
    assert.equal(instances[0].disposed, true, 'the dead addon was disposed');
    assert.equal(instances[1].disposed, false, 'the replacement stays live');
    assert.notEqual(tab._smoothCursor, firstWrapper, 'the holder got a fresh wrapper');
    assert.ok(tab._smoothCursor?._adapter, 'smooth cursor recovered on the replacement');
    assert.equal(creations[creations.length - 1], instances[1], 'the new adapter binds the new addon');
});

test('context loss on a hidden tab falls back to DOM rendering without creating a context', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const other = wiredTab(ctx, 't_other', 'local_other');
    ctx.TabManager.activeId = other.id;
    const tab = wiredTab(ctx, 't_hidden', 'local_hidden');
    ctx._attachWebglRenderer(tab, tab.term); // budget-enforcer style attach while hidden

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);

    assert.equal(instances.length, 1, 'no context was created for a hidden tab');
    assert.equal(instances[0].disposed, true, 'the dead addon was disposed');
    assert.equal(tab._smoothCursor?._adapter, null, 'the retired wrapper exposes no adapter');

    // Later manual activation attaches fresh (pre-existing behavior).
    attachActive(ctx, tab);
    assert.equal(instances.length, 2);
    assert.ok(tab._smoothCursor?._adapter);
});

test('a second unrecovered loss after the automatic recovery stays on the DOM renderer', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_bound', 'local_bound', 'x');
    attachActive(ctx, tab);
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2, 'first recovery consumed the bounded retry');

    instances[1].loseContextUnrecovered();
    ctx.__tq.advance(0);

    assert.equal(instances.length, 2, 'no third context: the automatic retry is bounded');
    assert.equal(instances[1].disposed, true, 'the second dead addon was disposed');
    assert.equal(tab._smoothCursor?._adapter, null, 'the terminal stays on the DOM renderer');

    // A manual attach (user-driven tab switch) re-arms the bounded recovery.
    ctx._attachWebglRenderer(tab, tab.term);
    assert.equal(instances.length, 3);
    assert.ok(tab._smoothCursor?._adapter);
});

test('reusing a healthy addon re-arms recovery after an earlier automatic recovery', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_reuse_rearm', 'local_reuse_rearm', 'x');
    attachActive(ctx, tab);
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2);

    attachActive(ctx, tab);
    assert.equal(instances.length, 2, 'the healthy addon is reused');
    instances[1].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 3, 'the reused record still has one automatic recovery');
    assert.ok(tab._smoothCursor?._adapter);
});

test('re-attach during the 3s restore window replaces the known-lost context instead of reusing it', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, creations } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_win', 'local_win', 'x');
    attachActive(ctx, tab);

    instances[0].lost = true; // gl.isContextLost() true, onContextLoss not yet fired
    ctx._attachWebglRenderer(tab, tab.term); // e.g. the user switched back to this tab

    assert.equal(instances.length, 2, 'the dead context was replaced immediately');
    assert.equal(instances[0].disposed, true, 'the dead addon was disposed');
    assert.ok(tab._smoothCursor?._adapter, 'the fresh wrapper carries a live adapter');
    assert.equal(creations[creations.length - 1], instances[1]);

    // The dead addon's late 3s timer must be inert against the replacement.
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].disposed, false);
    assert.ok(tab._smoothCursor?._adapter);
});

test('a context-loss wrapper never rebuilds its adapter from the dead addon', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { creations } = installWebglFakes(ctx);
    const other = wiredTab(ctx, 't_other2', 'local_other2');
    ctx.TabManager.activeId = other.id;
    const tab = wiredTab(ctx, 't_tomb', 'local_tomb');
    ctx._attachWebglRenderer(tab, tab.term);

    const addon = (tab.term._addons || []).find(a => a && a._renderer);
    assert.ok(addon, 'fake addon was loaded onto the terminal');
    addon.loseContextUnrecovered();
    ctx.__tq.advance(0);

    const retired = tab._smoothCursor;
    assert.equal(retired?._adapter, null, 'the wrapper retired with the context');
    const creationsBefore = creations.length;
    retired.setOptions({ cursorStyle: 'block' });
    assert.equal(creations.length, creationsBefore, 'no adapter rebuild from the dead addon');
    assert.equal(retired._adapter, null, 'the tombstone stays adapter-less');
    assert.equal(tab.term.options.cursorStyle, 'block', 'the cursor option still hot-applies');
});

test('stale loss callbacks from a replaced addon cannot disturb the replacement', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const other = wiredTab(ctx, 't_other3', 'local_other3');
    ctx.TabManager.activeId = other.id;
    const tab = wiredTab(ctx, 't_stale', 'local_stale');
    ctx._attachWebglRenderer(tab, tab.term);
    const dead = instances[0];

    dead.loseContextUnrecovered();
    ctx.__tq.advance(0); // release only: hidden tab, no auto re-attach
    attachActive(ctx, tab); // manual attach creates the replacement
    assert.equal(instances.length, 2);
    assert.ok(tab._smoothCursor?._adapter);

    // Defensive replay of the dead addon's handlers (the vendor clears its
    // emitter listeners on dispose; this pins the record's identity guard).
    for (const cb of dead.everRegistered) cb({ preventDefault() {} });
    ctx.__tq.advance(0);

    assert.equal(instances.length, 2, 'no extra context from stale callbacks');
    assert.equal(instances[1].disposed, false, 'the replacement addon survives');
    assert.ok(tab._smoothCursor?._adapter, 'the replacement wrapper survives');
});

test('a context restored inside the vendor window is reused, not replaced', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_restore', 'local_restore', 'x');
    attachActive(ctx, tab);
    const wrapper = tab._smoothCursor;

    instances[0].lost = true;  // webglcontextlost fired...
    instances[0].lost = false; // ...then webglcontextrestored arrived in time
    ctx._attachWebglRenderer(tab, tab.term);

    assert.equal(instances.length, 1, 'a healthy/restored context is reused');
    assert.equal(instances[0].disposed, false);
    assert.equal(tab._smoothCursor, wrapper, 'the live wrapper is re-pointed, not replaced');
    assert.ok(tab._smoothCursor?._adapter);
});
