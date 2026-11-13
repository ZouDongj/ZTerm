// WebGL context-loss recovery (bounded self-heal of the smooth cursor).
//
// REAL in this VM: terminal.js's _attachWebglRenderer / _detachWebglRenderer /
// _releaseWebglForTerm / _wireSmoothCursorWebgl record+wrapper bookkeeping and
// the tabs.js TabManager wiring via tests/helpers/renderer-vm.mjs (loaded with
// wireSmoothCursorStub:false so the REAL wrapper wiring runs).
//
// FAKED per the harness conventions: WebglAddon (controllable context loss,
// creation-outage modes, dispose recording, the vendored _renderer._gl.
// isContextLost shape verified against src/vendor/addon-webgl.js and
// scripts/e2e-webgl-atlas.mjs) and createXtermWebglSmoothCursor (records which
// addon each adapter binds and mirrors the real guard: it refuses an addon
// whose renderer is no longer active, i.e. a disposed addon).
//
// Two GPU-outage modes are modelled, both from issue #44:
//   - 'fail-create': every new addon constructor throws the vendored
//     "WebGL2 not supported" error (canvas.getContext('webgl2') returned null);
//   - 'born-lost': the addon is created but its GL context is already lost.
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
    // Outage model: 'none' creates a healthy context; 'fail-create' throws from
    // the constructor (the WebGL2-not-supported path); 'born-lost' creates the
    // addon with a dead context (the created-lost path).
    const state = { outage: 'none', createAttempts: 0, createTimes: [] };
    class FakeWebglAddon {
        constructor() {
            state.createAttempts += 1;
            state.createTimes.push(ctx.__tq.now);
            if (state.outage === 'fail-create') throw new Error('WebGL2 not supported');
            this.disposed = false;
            this.lost = state.outage === 'born-lost';
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
    return { instances, creations, state };
}

function attachActive(ctx, tab) {
    ctx.TabManager.activeId = tab.id;
    ctx._attachWebglRenderer(tab, tab.term);
}

// Module-private record access: _webglByTerm is a top-level const in the VM,
// so each context needs its own accessor (a VM-realm closure cannot be shared
// across contexts).
function recOf(ctx, tab) {
    return ctx.__eval('(term) => _webglByTerm.get(term)')(tab.term);
}
function fireWindow(ctx, type) {
    for (const fn of (ctx.__windowListeners.get(type) || []).slice()) fn({});
}
function fireDocument(ctx, type) {
    for (const fn of (ctx.__docListeners.get(type) || []).slice()) fn({});
}

// Drive the terminal into a pending backoff retry: the initial context dies
// during a create-outage, so the immediate automatic attempt is swallowed.
function armPendingRetry(ctx, tab, state, instances) {
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // release + immediate automatic attempt (throws)
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1, 'the immediate automatic attempt consumed one retry');
    assert.ok(rec.retryTimer, 'the next bounded retry is scheduled');
    return rec;
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
    const rec = recOf(ctx, tab);
    assert.equal(rec.lossCount, 1);
    assert.equal(rec.retryAttempts, 1, 'the automatic recovery consumed one attempt');
    assert.ok(rec.healthTimer, 'a recovered context must survive a health window before re-arming');
});

test('context loss on a hidden tab falls back to DOM rendering without creating a context', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const other = wiredTab(ctx, 't_other', 'local_other');
    ctx.TabManager.activeId = other.id;
    const tab = wiredTab(ctx, 't_hidden', 'local_hidden');
    ctx._attachWebglRenderer(tab, tab.term); // budget-enforcer style attach while hidden

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);

    assert.equal(instances.length, 1, 'no context was created for a hidden tab');
    assert.equal(instances[0].disposed, true, 'the dead addon was disposed');
    assert.equal(tab._smoothCursor?._adapter, null, 'the retired wrapper exposes no adapter');
    assert.equal(state.createAttempts, 1, 'no automatic retry ran off-screen');

    // Later manual activation attaches fresh (pre-existing behavior).
    attachActive(ctx, tab);
    assert.equal(instances.length, 2);
    assert.ok(tab._smoothCursor?._adapter);
});

test('a transient GPU outage that swallows the automatic retry heals once the GPU is back', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_outage', 'local_outage', 'x');
    attachActive(ctx, tab);

    // The outage starts with the loss: the immediate automatic retry lands
    // while the GPU is still down, and its freshly created context dies too.
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2, 'the immediate automatic retry ran');
    instances[1].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2, 'a second loss does not spawn an immediate context');
    assert.equal(tab._smoothCursor?._adapter, null, 'DOM fallback while the GPU is down');

    // GPU recovered. No tab switch, no user input: only the bounded backoff
    // timer can bring the adapter back.
    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);

    assert.equal(ctx.TabManager.activeId, tab.id, 'no tab switch was needed');
    assert.ok(tab._smoothCursor?._adapter, 'smooth cursor must come back without a tab switch');
    assert.equal(instances.length, 3, 'exactly one healing context was created');
    assert.equal(instances[2].disposed, false, 'the healing context stays live');
});

test('a replacement context that is dead at creation is released and the retry continues', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_born', 'local_born', 'x');
    attachActive(ctx, tab);

    state.outage = 'born-lost';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // immediate retry creates a context that is already lost
    const rec = recOf(ctx, tab);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].lost, true);
    assert.equal(instances[1].disposed, true, 'a dead-at-creation context is never kept');
    assert.equal(tab._smoothCursor?._adapter, null);
    assert.equal(rec.retryAttempts, 1);
    assert.ok(rec.retryTimer, 'the failure advanced to the next bounded retry');

    state.outage = 'none';
    ctx.__tq.advance(2000); // first backoff step
    assert.equal(instances.length, 3);
    assert.ok(tab._smoothCursor?._adapter, 'the retry after the dead context heals');
});

test('a persistent GPU failure drains the bounded schedule and stops creating contexts', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_bound', 'local_bound', 'x');
    attachActive(ctx, tab);

    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // immediate attempt fails
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);
    const lossAt = ctx.__tq.now;

    ctx.__tq.advance(10 * 60 * 1000);

    assert.equal(rec.retryAttempts, 7, 'immediate attempt plus six bounded backoff retries');
    assert.equal(rec.retryTimer, null, 'the retry timer stopped');
    assert.equal(rec.nextRetryAt, 0, 'no next retry is advertised');
    assert.equal(instances.length, 1, 'no context survived the outage');
    assert.equal(tab._smoothCursor?._adapter, null, 'the terminal stays on the DOM renderer');
    assert.equal(state.createAttempts, 8, 'one initial attach + seven failed recovery attempts');
    assert.deepEqual(state.createTimes.slice(1).map(t => t - lossAt),
        [0, 2000, 6000, 14000, 30000, 62000, 122000],
        'retries follow the bounded 0/2s/4s/8s/16s/32s/60s schedule');

    // User-return signals consume the same budget: an exhausted episode is
    // not restarted by focus alone (an explicit tab activation re-arms it).
    fireWindow(ctx, 'focus');
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, 8, 'no unbounded context churn after exhaustion');
});

test('a quick re-loss after an automatic recovery keeps the remaining bounded budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_flap', 'local_flap', 'x');
    attachActive(ctx, tab);

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // immediate recovery succeeds
    assert.equal(instances.length, 2);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);
    assert.ok(rec.healthTimer, 'healthy reset window is pending');

    // The replacement dies immediately: a broken GPU must not restart the
    // budget just because an attach briefly succeeded.
    instances[1].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 2, 'no unbounded immediate retry after a quick re-loss');
    assert.equal(rec.healthTimer, null, 'the quick re-loss cancelled the healthy reset');
    assert.equal(rec.retryAttempts, 1, 'the attempt budget was not reset');

    state.outage = 'fail-create';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(rec.retryAttempts, 7, 'the remaining budget is consumed, not reset');
    assert.equal(rec.lastRetryResult, 'exhausted');
    assert.equal(instances.length, 2);
});

test('a user-driven re-attach that fails during an outage continues the bounded retry', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_switch', 'local_switch', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);

    // The user switches back to the tab while the GPU is still down: the
    // normal attach path replaces the dead context, fails, and must keep the
    // bounded episode alive instead of stranding the terminal on the DOM
    // renderer until the next manual activation.
    attachActive(ctx, tab);
    ctx.__tq.advance(0); // the attach-failed retry is scheduled immediately
    assert.equal(rec.retryAttempts, 1, 'the failed user attach restarted a bounded attempt');
    assert.ok(rec.retryTimer);

    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.ok(tab._smoothCursor?._adapter, 'the episode heals without another user action');
    assert.equal(instances.length, 2);
});

test('a context that stays healthy for the reset window re-arms the bounded budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_health', 'local_health', 'x');
    attachActive(ctx, tab);

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);

    ctx.__tq.advance(60000); // healthy reset window
    assert.equal(rec.retryAttempts, 0, 'a healthy context re-arms the budget');
    assert.equal(rec.healthTimer, null);

    instances[1].loseContextUnrecovered();
    ctx.__tq.advance(0);
    assert.equal(instances.length, 3, 'the re-armed budget pays for a fresh automatic recovery');
    assert.ok(tab._smoothCursor?._adapter);
});

test('hiding the terminal cancels a pending backoff retry (no hidden context)', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const other = wiredTab(ctx, 't_other2', 'local_other2');
    const tab = wiredTab(ctx, 't_hide', 'local_hide', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    // switchTo() detaches the outgoing tab before activating the new one.
    ctx.TabManager.activeId = other.id;
    ctx._detachWebglRenderer(tab, tab.term);
    assert.equal(rec.retryTimer, null, 'the pending retry was cancelled on hide');

    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, 2, 'no context was created for the hidden tab');
    assert.equal(tab._smoothCursor?._adapter, null);

    // The next user activation attaches through the normal path.
    attachActive(ctx, tab);
    assert.equal(state.createAttempts, 3);
    assert.ok(tab._smoothCursor?._adapter);
});

test('a loss on a closing tab never re-attaches', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_closing', 'local_closing', 'x');
    attachActive(ctx, tab);
    ctx.TabManager._closingTabs.add(tab.id);

    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 0, 'no automatic attempt was made for a closing tab');
    assert.equal(rec.retryTimer, null);
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, 1);
    assert.equal(tab._smoothCursor?._adapter, null);
});

test('releasing the terminal cancels the pending backoff retry', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_release', 'local_release', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    ctx._releaseWebglForTerm(tab.term);
    assert.equal(rec.retryTimer, null, 'teardown cleared the retry timer');
    assert.equal(rec.healthTimer, null);

    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, 2, 'the released terminal never creates another context');
});

test('window focus retries a pending recovery immediately, throttled, consuming the same budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_focus', 'local_focus', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    const focusHandlers = ctx.__windowListeners.get('focus') || [];
    assert.ok(focusHandlers.length > 0, 'the global window focus listener is registered');

    fireWindow(ctx, 'focus');
    assert.equal(rec.retryAttempts, 2, 'window focus triggered an immediate retry');
    fireWindow(ctx, 'focus');
    assert.equal(rec.retryAttempts, 2, 'repeat signals inside the throttle window are ignored');

    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.ok(tab._smoothCursor?._adapter, 'the terminal heals without user activation');
});

test('visibilitychange to visible retries a pending recovery; hidden does not', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_visible', 'local_visible', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);
    assert.ok((ctx.__docListeners.get('visibilitychange') || []).length > 0,
        'the document visibilitychange listener is registered');

    ctx.document.visibilityState = 'hidden';
    fireDocument(ctx, 'visibilitychange');
    assert.equal(rec.retryAttempts, 1, 'a hidden document does not trigger a retry');

    ctx.document.visibilityState = 'visible';
    fireDocument(ctx, 'visibilitychange');
    assert.equal(rec.retryAttempts, 2, 'returning to visible triggers a retry');
});

test('terminal input retries a pending recovery through the same bounded budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_input', 'local_input', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    tab.term.paste('x'); // the real onData -> _sendInputForTerm path
    assert.equal(rec.retryAttempts, 2, 'terminal input triggered a retry');
    tab.term.paste('y');
    assert.equal(rec.retryAttempts, 2, 'input inside the throttle window does not retry again');
});

test('terminal textarea focus retries a pending recovery', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_taf', 'local_taf', 'x');
    tab.term.textarea = ctx.document.createElement('textarea'); // xterm's helper textarea
    const rec = armPendingRetry(ctx, tab, state, instances);

    assert.ok((tab.term.textarea._listeners.get('focus') || []).length > 0,
        'the terminal textarea focus listener is registered');
    tab.term.textarea.dispatch('focus');
    assert.equal(rec.retryAttempts, 2, 'terminal focus triggered a retry');
});

test('the Ctrl+Shift+D webgl segment is read-only metadata without terminal content', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_diag', 'local_diag', 'TOP-SECRET-OUTPUT');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);

    const timersBefore = ctx.__tq.timers.size;
    const snap = ctx._webglDiagnosticsSnapshot();
    assert.equal(ctx.__tq.timers.size, timersBefore, 'the snapshot is read-only');

    assert.equal(snap.liveContexts, 0);
    assert.equal(snap.budget, 8);
    assert.equal(snap.panes.length, 1);
    const pane = snap.panes[0];
    assert.equal(pane.renderer, 'dom');
    assert.equal(pane.lossCount, 1);
    assert.equal(typeof pane.lastLossAgoMs, 'number');
    assert.equal(pane.reattachAttempts, 1);
    assert.equal(pane.reattachLimit, 7);
    assert.equal(pane.lastResult, 'load-failed');
    assert.match(pane.lastError, /WebGL2 not supported/);
    assert.ok(pane.nextRetryDelayMs > 0, 'the next bounded retry is advertised');
    // Metadata only: no terminal text, key data or session identifiers.
    const text = JSON.stringify(snap);
    assert.doesNotMatch(text, /TOP-SECRET-OUTPUT|local_diag/);
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
    const other = wiredTab(ctx, 't_other3', 'local_other3');
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
    const other = wiredTab(ctx, 't_other4', 'local_other4');
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
