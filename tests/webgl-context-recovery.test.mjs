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
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
// Move only the user-probe clock backwards: the tests run synchronously, so the
// 30s/60s probe thresholds (and their rate limits) are exercised without real
// waiting. The timed automatic retries use the fake TimerQueue instead.
function ageUserProbe(ctx, tab, ms) {
    recOf(ctx, tab).lastUserRetryAt = Date.now() - ms;
}
function pendingSetHas(ctx, tab) {
    return ctx.__eval('(term) => _webglRecoveryPending.has(term)')(tab.term);
}
// Window-focus signals only discover episodes registered in the pending set.
// Tests that exercise that path from a state the production code leaves
// unregistered (e.g. a budget-enforced release) stage that discoverability.
function markRecoveryPending(ctx, tab) {
    ctx.__eval('(term) => _webglRecoveryPending.add(term)')(tab.term);
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

    // An exhausted episode keeps a bounded user-return probe path, and every
    // probe is one context attempt per minute at most. The real clock advanced
    // past the 60s cooldown while the 122s schedule drained; the fake timer
    // queue does not move Date.now, so age the probe clock explicitly.
    assert.equal(pendingSetHas(ctx, tab), true, 'the exhausted terminal stays discoverable');
    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus'); // one bounded probe runs
    assert.equal(state.createAttempts, 9, 'one bounded probe attempt ran');
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, 9, 'no timer re-arms an exhausted episode');
    assert.equal(rec.retryAttempts, 7, 'the probe never changes the automatic budget');
    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, 10, 'the next bounded probe runs a minute later');
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

test('a failed user-driven attach backs off instead of building twice', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_switch', 'local_switch', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1 fails
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);
    assert.equal(pendingSetHas(ctx, tab), true);
    const beforeAttach = state.createAttempts;

    // The user switches back to the tab while the GPU is still down: exactly
    // one create attempt runs, the failed attach counts as the episode's first
    // attempt, and the next one waits for the 2s backoff instead of rebuilding
    // a second context at 0ms.
    attachActive(ctx, tab);
    assert.equal(state.createAttempts, beforeAttach + 1, 'the user attach built exactly once');
    assert.equal(rec.retryAttempts, 1, 'the failed attach counts as the first episode attempt');
    assert.ok(rec.retryTimer);
    assert.equal(pendingSetHas(ctx, tab), true, 'the episode stays discoverable for user probes');
    ctx.__tq.advance(1999);
    assert.equal(state.createAttempts, beforeAttach + 1, 'no immediate rebuild');
    ctx.__tq.advance(1);
    assert.equal(state.createAttempts, beforeAttach + 2, 'the next attempt waits for the 2s backoff');
    assert.equal(rec.retryAttempts, 2);

    // Window focus can still reach the pending episode with a bounded probe:
    // the probe fails against the outage but must leave the automatic deadline
    // exactly where it was.
    const beforeProbe = state.createAttempts;
    const dueAt = rec.nextRetryAt;
    ageUserProbe(ctx, tab, 32000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'a user probe reaches the pending episode');
    assert.equal(rec.retryAttempts, 2, 'the probe does not consume an automatic attempt');
    assert.equal(rec.nextRetryAt, dueAt, 'the failed probe keeps the automatic deadline');
    assert.equal(rec.lastRetrySource, 'user:window-focus', 'the probe source survives diagnostics');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');

    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.ok(tab._smoothCursor?._adapter, 'the episode heals without another user action');
    assert.equal(instances.length, 2);
});

test('a failed user attach is not followed by an immediate probe from the focus handler', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_focus_guard', 'local_focus_guard', 'x');
    tab.term.textarea = ctx.document.createElement('textarea'); // xterm's helper textarea
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1 fails
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);
    const beforeAttach = state.createAttempts;

    // A user-driven attach fails; the episode restarts with the first attempt
    // already spent and the 2s backoff armed.
    attachActive(ctx, tab);
    assert.equal(state.createAttempts, beforeAttach + 1, 'the failed attach built once');
    assert.equal(rec.retryAttempts, 1);
    assert.ok(rec.lastUserRetryAt > 0, 'the reset starts the probe throttle window');

    // tabs.js focuses a terminal right after activation; that delayed focus
    // must not immediately build a second context.
    tab.term.textarea.dispatch('focus');
    assert.equal(state.createAttempts, beforeAttach + 1, 'the focus probe is throttled after reset');

    ctx.__tq.advance(2000); // the automatic 2s slot still runs
    assert.equal(state.createAttempts, beforeAttach + 2, 'the automatic backoff attempt still fires');
    assert.equal(rec.retryAttempts, 2);
    assert.equal(pendingSetHas(ctx, tab), true);
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

test('typing during a GPU outage cannot drain the automatic retry budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_typing', 'local_typing', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1 fails; the first backoff waits 2s
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);
    assert.ok(rec.retryTimer, 'the automatic schedule is armed');
    const dueAt = rec.nextRetryAt;
    const beforeProbe = state.createAttempts;
    // The terminal has been open longer than the probe threshold (the fake
    // timer queue does not move Date.now, so model that explicitly).
    rec.lastUserRetryAt = Date.now() - 32000;

    // The FIRST user action may probe (the automatic slot is not imminent):
    // it fails against the outage, but the episode and its deadline survive.
    tab.term.paste('x');
    assert.equal(state.createAttempts, beforeProbe + 1, 'the first user action probed once');
    assert.equal(rec.retryAttempts, 1, 'the probe never consumes an automatic attempt');
    assert.equal(rec.nextRetryAt, dueAt, 'the probe never moves the automatic deadline');
    assert.equal(rec.lastRetrySource, 'user:terminal-input');

    // The following keystrokes are inside the 30s probe threshold: they must
    // not create anything and must not touch the automatic schedule.
    for (let i = 0; i < 5; i += 1) {
        rec.lastUserRetryAt = Date.now() - 1100;
        tab.term.paste('x');
    }
    assert.equal(rec.retryAttempts, 1, 'user input never consumes automatic attempts');
    assert.equal(rec.nextRetryAt, dueAt, 'the automatic deadline is untouched');
    assert.ok(rec.retryTimer, 'the automatic retry timer is untouched');
    assert.equal(state.createAttempts, beforeProbe + 1, 'no context was built by the keystrokes');

    // GPU returns: the untouched automatic schedule heals the terminal with no
    // explicit attach (tab switch) at all.
    state.outage = 'none';
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(ctx.TabManager.activeId, tab.id, 'no tab switch was needed');
    assert.ok(tab._smoothCursor?._adapter, 'smooth cursor recovers through the automatic schedule');
    assert.equal(instances.length, 2);
});

test('window focus probes a pending recovery without consuming the automatic budget', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_focus', 'local_focus', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    const focusHandlers = ctx.__windowListeners.get('focus') || [];
    assert.ok(focusHandlers.length > 0, 'the global window focus listener is registered');

    // A signal inside the 30s probe threshold must not try.
    rec.lastUserRetryAt = Date.now() - 1000;
    const beforeProbe = state.createAttempts;
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe, 'the probe is rate limited to once per 30s');

    ageUserProbe(ctx, tab, 32000);
    const dueAt = rec.nextRetryAt;
    fireWindow(ctx, 'focus'); // outage still active: the probe fails
    assert.equal(state.createAttempts, beforeProbe + 1, 'one probe attempt ran');
    assert.equal(rec.retryAttempts, 1, 'a failed probe does not consume an automatic attempt');
    assert.ok(rec.retryTimer, 'the automatic retry timer is untouched');
    assert.equal(rec.nextRetryAt, dueAt, 'a failed probe does not move the automatic deadline');
    assert.equal(rec.lastRetrySource, 'user:window-focus', 'the probe source is not overwritten');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');
    assert.equal(pendingSetHas(ctx, tab), true);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'the 30s probe rate limit holds');

    // GPU returns: the next allowed probe heals without any tab switch.
    state.outage = 'none';
    ageUserProbe(ctx, tab, 32000);
    fireWindow(ctx, 'focus');
    assert.ok(tab._smoothCursor?._adapter, 'the user-return probe restores the adapter');
    assert.equal(rec.retryAttempts, 1, 'a successful probe does not rewrite the automatic budget');
    assert.equal(rec.lastRetrySource, 'user:window-focus');
    assert.equal(rec.lastRetryResult, 'attached');
    assert.ok(rec.healthTimer, 'a probe recovery still needs the health window to re-arm');
});

test('visibilitychange probes only when visible and inside the probe threshold', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_visible', 'local_visible', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);
    assert.ok((ctx.__docListeners.get('visibilitychange') || []).length > 0,
        'the document visibilitychange listener is registered');

    ctx.document.visibilityState = 'hidden';
    rec.lastUserRetryAt = Date.now() - 1000;
    const beforeProbe = state.createAttempts;
    fireDocument(ctx, 'visibilitychange');
    assert.equal(state.createAttempts, beforeProbe, 'a hidden document never probes');

    ctx.document.visibilityState = 'visible';
    fireDocument(ctx, 'visibilitychange');
    assert.equal(state.createAttempts, beforeProbe, 'the 30s probe threshold holds');

    state.outage = 'none';
    ageUserProbe(ctx, tab, 32000);
    fireDocument(ctx, 'visibilitychange');
    assert.ok(tab._smoothCursor?._adapter, 'returning to visible probes the pending recovery');
    assert.equal(rec.retryAttempts, 1, 'the probe does not consume an automatic attempt');
    assert.equal(rec.lastRetrySource, 'user:visibility-visible');
});

test('terminal input probes a pending recovery instead of spending automatic attempts', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_input', 'local_input', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);

    rec.lastUserRetryAt = Date.now() - 1000;
    const beforeProbe = state.createAttempts;
    tab.term.paste('x'); // the real onData -> _sendInputForTerm path
    assert.equal(state.createAttempts, beforeProbe, 'input inside the probe threshold does not try');

    state.outage = 'none';
    ageUserProbe(ctx, tab, 32000);
    tab.term.paste('x');
    assert.ok(tab._smoothCursor?._adapter, 'terminal input probes the pending recovery');
    assert.equal(rec.retryAttempts, 1, 'the probe does not consume an automatic attempt');
    assert.equal(rec.lastRetrySource, 'user:terminal-input');
});

test('terminal textarea focus probes a pending recovery', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_taf', 'local_taf', 'x');
    tab.term.textarea = ctx.document.createElement('textarea'); // xterm's helper textarea
    const rec = armPendingRetry(ctx, tab, state, instances);

    assert.ok((tab.term.textarea._listeners.get('focus') || []).length > 0,
        'the terminal textarea focus listener is registered');
    state.outage = 'none';
    ageUserProbe(ctx, tab, 32000);
    tab.term.textarea.dispatch('focus');
    assert.ok(tab._smoothCursor?._adapter, 'terminal focus probes the pending recovery');
    assert.equal(rec.retryAttempts, 1, 'the probe does not consume an automatic attempt');
    assert.equal(rec.lastRetrySource, 'user:terminal-focus');
});

test('an exhausted episode keeps a bounded user-return probe to heal', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_exhausted', 'local_exhausted', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    ctx.__tq.advance(10 * 60 * 1000); // drain the full automatic schedule
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 7);
    assert.equal(rec.retryTimer, null, 'no automatic timer survives exhaustion');
    assert.equal(rec.nextRetryAt, 0);
    assert.equal(pendingSetHas(ctx, tab), true, 'an exhausted terminal stays discoverable');

    // Inside the 60s exhausted-probe threshold nothing happens.
    rec.lastUserRetryAt = Date.now() - 58000;
    const beforeProbe = state.createAttempts;
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe, 'the exhausted probe is rate limited to 60s');

    state.outage = 'none';
    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus');
    assert.ok(tab._smoothCursor?._adapter, 'a bounded probe heals an exhausted episode');
    assert.equal(rec.retryAttempts, 7, 'the probe does not rewrite the automatic budget');
    assert.equal(rec.lastRetrySource, 'user:window-focus');
    assert.equal(rec.lastRetryResult, 'attached');
    assert.ok(rec.healthTimer, 'the probe recovery still earns the health window');

    ctx.__tq.advance(60000); // health window re-arms the automatic budget
    assert.equal(rec.retryAttempts, 0);
    assert.equal(pendingSetHas(ctx, tab), false);
});

test('exhausted probes are bounded to one context attempt per minute', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_probe_limit', 'local_probe_limit', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    ctx.__tq.advance(10 * 60 * 1000);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 7);
    assert.equal(pendingSetHas(ctx, tab), true);
    const beforeProbe = state.createAttempts;

    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus'); // outage still active: the probe fails
    assert.equal(state.createAttempts, beforeProbe + 1, 'one bounded probe attempt ran');
    assert.equal(rec.retryAttempts, 7, 'the failed probe never spends automatic attempts');
    assert.equal(rec.retryTimer, null, 'the exhausted episode never re-arms a timer');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');
    assert.ok(rec.lastRetrySource.startsWith('user:'), 'the exhausted probe source survives');
    assert.equal(pendingSetHas(ctx, tab), true);

    fireWindow(ctx, 'focus');
    rec.lastUserRetryAt = Date.now() - 58000;
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'one probe per 60s at most');

    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 2, 'the next bounded probe runs');
});

test('a probe never races an automatic retry that is due within 1.5s', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_guard', 'local_guard', 'x');
    const rec = armPendingRetry(ctx, tab, state, instances);
    const beforeProbe = state.createAttempts;

    // The scheduled automatic attempt is due inside the guard window: the
    // probe must not build a second context.
    rec.nextRetryAt = Date.now() + 1000;
    ageUserProbe(ctx, tab, 32000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe, 'the due automatic attempt owns the window');
    assert.equal(rec.retryAttempts, 1);

    // Once the automatic retry is not imminent, the same signal probes.
    const dueAt = Date.now() + 5000;
    rec.nextRetryAt = dueAt;
    ageUserProbe(ctx, tab, 32000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'the probe runs outside the guard window');
    assert.equal(rec.retryAttempts, 1, 'the probe does not consume an automatic attempt');
    assert.equal(rec.nextRetryAt, dueAt, 'the probe restores the original automatic deadline');
});

test('a failed probe does not move the scheduled automatic deadline', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_deadline', 'local_deadline', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1 fails
    // Walk the automatic schedule to the 32s slot (attempts = 5).
    for (const delay of [2000, 4000, 8000, 16000]) ctx.__tq.advance(delay);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 5);
    assert.ok(rec.retryTimer);
    const dueAt = rec.nextRetryAt;
    const beforeProbe = state.createAttempts;

    ageUserProbe(ctx, tab, 32000);
    fireWindow(ctx, 'focus'); // outage still active: the probe fails
    assert.equal(state.createAttempts, beforeProbe + 1, 'the probe attempted one context');
    assert.equal(rec.retryAttempts, 5, 'the probe does not consume an automatic attempt');
    assert.equal(rec.nextRetryAt, dueAt, 'the automatic deadline is unchanged');
    assert.ok(rec.retryTimer, 'the automatic timer is still armed');
    assert.equal(rec.lastRetrySource, 'user:window-focus', 'the probe source is not overwritten');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');

    // The automatic attempt still fires at its original deadline and advances
    // the episode normally.
    ctx.__tq.advance(40000);
    assert.equal(rec.retryAttempts, 6, 'the scheduled attempt fired and advanced the episode');
    assert.equal(state.createAttempts, beforeProbe + 2);
});

test('sustained probes cannot stall the automatic episode', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_sustained', 'local_sustained', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 1);

    // One failed probe per backoff slot (the way a user keeps returning during
    // a long GPU outage). The automatic episode must still walk the full
    // schedule and reach the bounded exhausted state.
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000]) {
        ageUserProbe(ctx, tab, 32000);
        const deadline = rec.nextRetryAt;
        const beforeProbe = state.createAttempts;
        fireWindow(ctx, 'focus');
        assert.equal(state.createAttempts, beforeProbe + 1, 'one probe per slot');
        assert.equal(rec.nextRetryAt, deadline, 'the probe keeps the automatic deadline');
        const attemptsBefore = rec.retryAttempts;
        ctx.__tq.advance(delay);
        assert.equal(rec.retryAttempts, attemptsBefore + 1,
            'the automatic attempt still advances the schedule');
    }
    assert.equal(rec.retryAttempts, 7, 'the automatic episode still reaches exhausted');
    assert.equal(rec.retryTimer, null, 'exhaustion leaves no automatic timer');
    assert.equal(rec.nextRetryAt, 0);
    assert.equal(pendingSetHas(ctx, tab), true);
    // One initial attach + seven automatic attempts + six in-slot probes:
    // probes are bounded by their own rate limit, not by the episode budget.
    assert.equal(state.createAttempts, 14);

    // Even after exhaustion a user return probes once per minute and never
    // re-arms an automatic timer.
    const beforeExhaustedProbe = state.createAttempts;
    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeExhaustedProbe + 1);
    assert.equal(state.createAttempts, 15);
    assert.equal(rec.retryAttempts, 7);
    assert.equal(rec.retryTimer, null);
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(state.createAttempts, beforeExhaustedProbe + 1, 'no timer was re-armed');
});

test('a failed probe restores the automatic schedule after an LRU release', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_lru', 'local_lru', 'x');
    attachActive(ctx, tab);
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic recovery
    assert.ok(tab._smoothCursor?._adapter);
    ctx.__tq.advance(60000); // the health window re-arms the episode budget
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 0);

    // LRU force-release (WEBGL_CONTEXT_BUDGET enforcement): the context is
    // gone with no timer and attempts < max — a legitimate episode state.
    ctx._releaseWebglForTerm(tab.term);
    assert.equal(rec.addon, null);
    assert.equal(rec.retryTimer, null);
    assert.equal(rec.nextRetryAt, 0);
    assert.equal(rec.retryAttempts, 0);
    assert.equal(rec.lossCount, 1);
    assert.equal(pendingSetHas(ctx, tab), false);
    // This case covers the window-focus/pending-set discovery path: only
    // pending episodes are discoverable by window focus, so the active
    // terminal's discoverability is staged here. The terminal-input variant
    // below covers the production-reachable per-terminal path without staging.
    // The bug under test is the missing automatic timer, not set membership.
    markRecoveryPending(ctx, tab);

    // The GPU is down again: the user-return probe fails.
    state.outage = 'fail-create';
    ageUserProbe(ctx, tab, 32000);
    const beforeProbe = state.createAttempts;
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'the probe attempted one context');
    assert.equal(rec.retryAttempts, 0, 'the probe does not consume an automatic attempt');
    assert.ok(rec.retryTimer, 'the failed probe re-arms the bounded schedule');
    // Re-arming after a failed probe backs off to the 2s slot rather than
    // double-building at 0ms and immediately overwriting probe diagnostics.
    const lruDelayMs = rec.nextRetryAt - Date.now();
    assert.ok(lruDelayMs >= 1500 && lruDelayMs <= 2500,
        `the 2s backoff slot is selected after failed probe (delay=${lruDelayMs}ms)`);
    assert.equal(pendingSetHas(ctx, tab), true);
    assert.ok(rec.lastRetrySource.startsWith('user:'), 'diagnostics keep the probe source');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');

    // No duplicate build happens on the same tick; the 2s slot advances cleanly.
    ctx.__tq.advance(0);
    assert.equal(state.createAttempts, beforeProbe + 1, 'no 0ms double build after failed probe');
    assert.ok(rec.lastRetrySource.startsWith('user:'), 'probe source survives tick 0');
    ctx.__tq.advance(2000);
    assert.equal(rec.retryAttempts, 1, 'the re-armed automatic attempt ran at 2s');
    assert.ok(rec.retryTimer, 'the next backoff step is armed');
    ctx.__tq.advance(2000);
    assert.equal(rec.retryAttempts, 2);
});

test('a failed probe on an exhausted episode never re-arms a timer', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_exhausted_probe', 'local_exhausted_probe', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    ctx.__tq.advance(10 * 60 * 1000); // drain the automatic schedule
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 7);
    assert.equal(rec.retryTimer, null);
    assert.ok(pendingSetHas(ctx, tab));

    ageUserProbe(ctx, tab, 62000);
    const beforeProbe = state.createAttempts;
    fireWindow(ctx, 'focus');
    assert.equal(state.createAttempts, beforeProbe + 1, 'one bounded exhausted probe ran');
    assert.equal(rec.retryAttempts, 7);
    assert.equal(rec.retryTimer, null, 'an exhausted episode never re-arms an automatic timer');
    assert.equal(rec.nextRetryAt, 0);
    assert.equal(pendingSetHas(ctx, tab), true);
    assert.ok(rec.lastRetrySource.startsWith('user:'));
});

test('terminal input restores the automatic schedule after an LRU release', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_lru_input', 'local_lru_input', 'x');
    attachActive(ctx, tab);
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic recovery
    assert.ok(tab._smoothCursor?._adapter);
    ctx.__tq.advance(60000); // the health window re-arms the episode budget
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 0);

    // LRU force-release leaves the legitimate no-timer, non-exhausted state.
    ctx._releaseWebglForTerm(tab.term);
    assert.equal(rec.addon, null);
    assert.equal(rec.retryTimer, null);
    assert.equal(rec.retryAttempts, 0);
    assert.equal(rec.lossCount, 1);
    // No pending staging here: terminal input reaches the terminal through its
    // own listener, so this is the production-reachable per-terminal probe
    // path (the window-focus variant above covers the pending-set path).
    assert.equal(pendingSetHas(ctx, tab), false);

    // The GPU is down again: the user's next keystroke probes and fails.
    state.outage = 'fail-create';
    ageUserProbe(ctx, tab, 32000);
    const beforeProbe = state.createAttempts;
    tab.term.paste('x'); // real onData -> _sendInputForTerm -> probe
    assert.equal(state.createAttempts, beforeProbe + 1, 'the input probe attempted one context');
    assert.equal(rec.retryAttempts, 0, 'the probe does not consume an automatic attempt');
    assert.ok(rec.retryTimer, 'the failed probe re-arms the bounded schedule');
    assert.equal(pendingSetHas(ctx, tab), true, 'the re-armed episode is discoverable');
    assert.ok(rec.lastRetrySource.startsWith('user:terminal-input'), 'the probe source is preserved');
    assert.equal(rec.lastRetryResult, 'probe-load-failed');
    // Re-arming after a failed probe backs off to the 2s slot rather than
    // double-building at 0ms and clobbering the user:terminal-input source.
    const inputDelayMs = rec.nextRetryAt - Date.now();
    assert.ok(inputDelayMs >= 1500 && inputDelayMs <= 2500,
        `the 2s backoff slot is selected after failed input probe (delay=${inputDelayMs}ms)`);

    // Same tick performs zero builds; attempt 1 lands at 2s, then GPU returns and heals at +2s.
    ctx.__tq.advance(0);
    assert.equal(state.createAttempts, beforeProbe + 1, 'no 0ms double build after failed probe');
    assert.ok(rec.lastRetrySource.startsWith('user:terminal-input'), 'the probe source survives tick 0');
    ctx.__tq.advance(2000);
    assert.equal(rec.retryAttempts, 1, 'the re-armed automatic attempt ran at 2s');
    state.outage = 'none';
    ctx.__tq.advance(2000);
    assert.equal(rec.retryAttempts, 2);
    assert.ok(tab._smoothCursor?._adapter, 'the re-armed schedule heals the terminal');
});

test('a failed probe re-arms the next backoff slot by its real delay', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_slot', 'local_slot', 'x');
    attachActive(ctx, tab);
    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // automatic attempt 1
    // Walk the automatic schedule to attempts=6 (the 60s slot is armed).
    for (const delay of [2000, 4000, 8000, 16000, 32000]) ctx.__tq.advance(delay);
    const rec = recOf(ctx, tab);
    assert.equal(rec.retryAttempts, 6);
    assert.ok(rec.retryTimer);

    // LRU force-release cancels the armed timer: attempts=6, no timer/addon.
    ctx._releaseWebglForTerm(tab.term);
    assert.equal(rec.retryAttempts, 6);
    assert.equal(rec.retryTimer, null);
    assert.equal(rec.nextRetryAt, 0);
    assert.equal(pendingSetHas(ctx, tab), false);

    // A failed per-terminal probe must select the next backoff slot for
    // attempts=6, i.e. the 60s delay — not an immediate or earlier slot.
    ageUserProbe(ctx, tab, 32000);
    tab.term.paste('x');
    assert.ok(rec.retryTimer, 'the failed probe re-arms the bounded schedule');
    assert.equal(rec.retryAttempts, 6, 'the probe does not consume an automatic attempt');
    const delayMs = rec.nextRetryAt - Date.now();
    assert.ok(delayMs >= 59000 && delayMs <= 61000,
        `the 60s backoff slot is selected (delay=${delayMs}ms)`);
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

test('real vendored WebglAddon + AddonManager disposal leaks zero layers, listeners, or blink timers on getContext outage or mid-constructor error', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const addonWebglSrc = readFileSync(new URL('../src/vendor/addon-webgl.js', import.meta.url), 'utf8');
    const blinkTimeouts = [];
    const intervals = [];
    let roObserveCount = 0;
    let roDisconnectCount = 0;
    let appendThrows = 0;
    let nextTimer = 0;
    const screenChildren = [];
    const themeListeners = [];
    const optionListeners = [];
    const showLinkListeners = [];
    const hideLinkListeners = [];
    const makeDisposable = (arr, fn) => {
        arr.push(fn);
        return { dispose() { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); } };
    };

    let glMode = 'null'; // 'null' | 'throw-mid-init'
    const fakeDoc = {
        body: { contains: () => true },
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(),
                style: {},
                classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
                parentElement: null,
                width: 0,
                height: 0,
                addEventListener() {},
                removeEventListener() {},
                remove() {
                    if (this.parentElement) {
                        const i = this.parentElement.children.indexOf(this);
                        if (i >= 0) this.parentElement.children.splice(i, 1);
                        this.parentElement = null;
                    }
                },
                getContext(type) {
                    if (type === '2d') {
                        return {
                            fillStyle: '',
                            clearRect() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {}, fillText() {},
                            createLinearGradient: () => ({ addColorStop() {} }),
                            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
                        };
                    }
                    if ((type === 'webgl2' || type === 'webgl') && glMode === 'throw-mid-init') {
                        return { getParameter: () => 2048 };
                    }
                    return null;
                },
            };
        },
    };
    const fakeWin = {
        document: fakeDoc,
        devicePixelRatio: 1,
        ResizeObserver: class {
            observe() { roObserveCount += 1; }
            disconnect() { roDisconnectCount += 1; }
        },
        addEventListener() {},
        removeEventListener() {},
        setInterval(fn, ms) { const id = ++nextTimer; intervals.push({ id, fn, ms, cleared: false }); return id; },
        clearInterval(id) { const item = intervals.find(x => x.id === id); if (item) item.cleared = true; },
        setTimeout(fn, ms) { const id = ++nextTimer; blinkTimeouts.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout(id) { const item = blinkTimeouts.find(x => x.id === id); if (item) item.cleared = true; },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
    };
    const sandbox = {
        self: null,
        window: fakeWin,
        document: fakeDoc,
        navigator: { userAgent: 'Chrome/120', platform: 'Win32' },
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        setInterval: fakeWin.setInterval,
        clearInterval: fakeWin.clearInterval,
        queueMicrotask,
        Float32Array, Uint8Array, Int32Array, Uint16Array, Uint32Array,
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(addonWebglSrc, sandbox, { filename: 'addon-webgl.js' });
    ctx.WebglAddon = sandbox.TabbyWebgl.WebglAddon;

    const tab = wiredTab(ctx, 't_real_vendor_leak', 'local_real_vendor', 'x');
    tab.term.options.cursorBlink = true;
    const screenElement = {
        style: {},
        children: screenChildren,
        appendChild(c) {
            // In mid-init mode, allow LinkRenderLayer's canvas append, then throw when
            // WebglRenderer appends its own WebGL canvas after blink/listener setup ran.
            if (glMode === 'throw-mid-init' && !c.classList.contains('xterm-link-layer')) {
                appendThrows += 1;
                throw new Error('simulated mid-constructor canvas append failure');
            }
            c.parentElement = this;
            screenChildren.push(c);
            return c;
        },
        removeChild(c) {
            const i = screenChildren.indexOf(c);
            if (i >= 0) screenChildren.splice(i, 1);
            c.parentElement = null;
        },
    };
    tab.term.element = screenElement;
    // Mirror real xterm.js AddonManager.loadAddon (src/vendor/xterm.js:6540-6557):
    // registers the addon metadata and wraps dispose() BEFORE calling addon.activate(term).
    const addonManager = {
        _addons: [],
        loadAddon(term, addon) {
            const meta = { instance: addon, dispose: addon.dispose, isDisposed: false };
            this._addons.push(meta);
            addon.dispose = () => {
                if (meta.isDisposed) return;
                const i = this._addons.indexOf(meta);
                if (i === -1) throw new Error('Could not dispose an addon that has not been loaded');
                meta.isDisposed = true;
                meta.dispose.apply(meta.instance);
                this._addons.splice(i, 1);
            };
            addon.activate(term);
        },
    };
    tab.term._addonManager = addonManager;
    tab.term.loadAddon = (addon) => addonManager.loadAddon(tab.term, addon);
    tab.term._core = {
        screenElement,
        coreService: { isCursorHidden: false, isCursorInitialized: true },
        optionsService: {
            rawOptions: { fontSize: 16, fontFamily: 'monospace', cursorBlink: true, lineHeight: 1, letterSpacing: 0 },
            options: { fontSize: 16, fontFamily: 'monospace', cursorBlink: true, letterSpacing: 0, lineHeight: 1 },
            onOptionChange: (fn) => makeDisposable(optionListeners, fn),
            onSpecificOptionChange: () => ({ dispose() {} }),
        },
        _themeService: {
            colors: {
                background: { css: '#000', rgba: 0x000000ff },
                foreground: { css: '#fff', rgba: 0xffffffff },
                cursor: { css: '#fff', rgba: 0xffffffff },
                ansi: Array.from({ length: 16 }, () => ({ css: '#fff', rgba: 0xffffffff })),
            },
            onChangeColors: (fn) => makeDisposable(themeListeners, fn),
        },
        _renderService: { setRenderer() {}, handleResize() {}, dimensions: {} },
        _characterJoinerService: {},
        _charSizeService: { width: 9, height: 18 },
        _coreBrowserService: { dpr: 1, isFocused: true, mainDocument: fakeDoc, window: fakeWin, onWindowChange: () => ({ dispose() {} }) },
        _decorationService: {},
        _logService: { logLevel: 5 },
        linkifier: {
            onShowLinkUnderline: (fn) => makeDisposable(showLinkListeners, fn),
            onHideLinkUnderline: (fn) => makeDisposable(hideLinkListeners, fn),
        },
    };

    ctx.TabManager.activeId = tab.id;
    // Drain initial attach + all bounded retries during WebGL2 context outage.
    // Early getContext check must abort before LinkRenderLayer or blink timers allocate.
    ctx._attachWebglRenderer(tab, tab.term);
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(blinkTimeouts.length, 0, 'getContext outage must fail before scheduling any blink timers');
    assert.equal(intervals.length, 0, 'getContext outage must never start blink intervals');
    assert.equal(addonManager._addons.length, 0, 'getContext outage leaves zero _addonManager entries');

    // Also exercise mid-constructor throw AFTER LinkRenderLayer, ResizeObserver,
    // and CursorBlinkStateManager start.
    glMode = 'throw-mid-init';
    ctx._attachWebglRenderer(tab, tab.term);
    ctx.__tq.advance(10 * 60 * 1000);
    assert.ok(appendThrows >= 1, 'mid-init test reached the screenElement.appendChild throw hook');
    assert.ok(roObserveCount >= 1, 'mid-init test installed ResizeObserver before throwing');
    assert.equal(roDisconnectCount, roObserveCount, 'every ResizeObserver installed before throw was disconnected');

    for (const t of blinkTimeouts.filter(x => !x.cleared)) t.fn();
    assert.equal(addonManager._addons.length, 0, 'failed attaches must leave zero entries in _addonManager._addons');
    assert.equal(screenChildren.filter(c => c.classList.contains('xterm-link-layer')).length, 0, 'zero leaked .xterm-link-layer canvases');
    assert.equal(themeListeners.length, 0, 'zero leaked theme listeners');
    assert.equal(optionListeners.length, 0, 'zero leaked option listeners');
    assert.equal(showLinkListeners.length + hideLinkListeners.length, 0, 'zero leaked linkifier listeners');
    assert.equal(blinkTimeouts.filter(x => !x.cleared).length, 0, 'zero leaked blink timeouts');
    assert.equal(intervals.filter(x => !x.cleared).length, 0, 'zero leaked blink intervals');
});

test('initial attach born-lost (lossCount === 0) starts bounded recovery and heals when GPU returns', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_init_born', 'local_init_born', 'x');
    state.outage = 'born-lost';
    attachActive(ctx, tab);

    const rec = recOf(ctx, tab);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].disposed, true);
    assert.equal(rec.lossCount, 1, 'initial born-lost records first loss');
    assert.equal(rec.retryAttempts, 1, 'initial failed attach counts as first attempt');
    assert.equal(rec.lastRetryResult, 'context-lost');
    assert.ok(rec.retryTimer, 'bounded backoff timer is armed');
    assert.equal(pendingSetHas(ctx, tab), true, 'terminal is discoverable by user probes');

    // Bounded recovery heals automatically when GPU returns without a tab switch.
    state.outage = 'none';
    ctx.__tq.advance(2000);
    assert.equal(instances.length, 2);
    assert.ok(tab._smoothCursor?._adapter, 'smooth cursor recovers from initial born-lost outage');
});

test('initial attach load-failed (lossCount === 0) starts bounded recovery and supports user probes after exhaustion', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_init_fail', 'local_init_fail', 'x');
    state.outage = 'fail-create';
    attachActive(ctx, tab);

    const rec = recOf(ctx, tab);
    assert.equal(rec.lossCount, 1);
    assert.equal(rec.retryAttempts, 1);
    assert.equal(rec.lastRetryResult, 'load-failed');
    assert.ok(rec.retryTimer);
    assert.equal(pendingSetHas(ctx, tab), true);

    // Exhaust the remaining backoff slots, then recover via a user probe.
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(rec.retryAttempts, 7);
    assert.equal(rec.retryTimer, null);

    state.outage = 'none';
    ageUserProbe(ctx, tab, 62000);
    fireWindow(ctx, 'focus');
    assert.equal(instances.length, 1);
    assert.ok(tab._smoothCursor?._adapter, 'user probe heals initial attach failure after GPU returns');
});

test('diagnostics snapshot reports webgl-lost inside the 3s restore window on real browser renderer shape', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances } = installWebglFakes(ctx);
    const tab = wiredTab(ctx, 't_diag_win', 'local_diag_win', 'x');
    attachActive(ctx, tab);
    // Simulate real xterm.js WebglRenderer attached on _core._renderService._renderer.value._gl.
    tab.term._core = { _renderService: { _renderer: { value: { _gl: instances[0]._renderer._gl } } } };

    assert.equal(ctx._webglDiagnosticsSnapshot().panes[0].renderer, 'webgl');
    instances[0].lost = true; // inside 3s vendor restore window (onContextLoss not fired yet)
    assert.equal(ctx._webglDiagnosticsSnapshot().panes[0].renderer, 'webgl-lost');
});

test('user-driven attach clears stale lastRetryResult and lastRetryError across switchback and 3s-window replacement', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tabA = wiredTab(ctx, 't_clear_a', 'local_clear_a', 'x');
    const tabB = wiredTab(ctx, 't_clear_b', 'local_clear_b', 'y');
    attachActive(ctx, tabA);

    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0); // attempt 1 -> load-failed + WebGL2 error
    ctx.TabManager.activeId = tabB.id;
    ctx._detachWebglRenderer(tabA, tabA.term); // deferred-inactive while error lingers

    state.outage = 'none';
    attachActive(ctx, tabA);
    const snapA = ctx._webglDiagnosticsSnapshot().panes[0];
    assert.equal(snapA.renderer, 'webgl');
    assert.equal(snapA.lastResult, 'attached');
    assert.equal(snapA.lastError, null);

    // Trigger 3s-window replacement when rec.addon is already marked lost.
    instances[1].lost = true;
    attachActive(ctx, tabA);
    const snapReplace = ctx._webglDiagnosticsSnapshot().panes[0];
    assert.equal(snapReplace.renderer, 'webgl');
    assert.equal(snapReplace.lastResult, 'attached');
    assert.equal(snapReplace.lastError, null);
});

test('switching away from an exhausted tab removes it from _webglRecoveryPending and re-attaches cleanly on return', () => {
    const ctx = loadVm({ wireSmoothCursorStub: false });
    const { instances, state } = installWebglFakes(ctx);
    const tabA = wiredTab(ctx, 't_exh_a', 'local_exh_a', 'x');
    const tabB = wiredTab(ctx, 't_exh_b', 'local_exh_b', 'y');
    attachActive(ctx, tabA);

    state.outage = 'fail-create';
    instances[0].loseContextUnrecovered();
    ctx.__tq.advance(0);
    ctx.__tq.advance(10 * 60 * 1000);
    assert.equal(pendingSetHas(ctx, tabA), true);

    ctx.TabManager.activeId = tabB.id;
    ctx._detachWebglRenderer(tabA, tabA.term);
    assert.equal(pendingSetHas(ctx, tabA), false, 'hidden exhausted tab leaves pending set');
    assert.equal(recOf(ctx, tabA).lastRetryResult, 'deferred-inactive');
    assert.equal(ctx._webglDiagnosticsSnapshot().recoveryPending, 0);

    state.outage = 'none';
    attachActive(ctx, tabA);
    assert.ok(tabA._smoothCursor?._adapter, 'tab heals immediately when user switches back');
    assert.equal(ctx._webglDiagnosticsSnapshot().panes[0].lastResult, 'attached');
});

test('newly wired active tab and newly split active pane arm bounded recovery when initial attach fails during outage', () => {
    for (const outage of ['fail-create', 'born-lost']) {
        const ctx = loadVm({ wireSmoothCursorStub: false });
        const { state } = installWebglFakes(ctx);

        // Set activeId BEFORE wireTerminal so createTermWrap creates wrap.active and
        // wireTerminal invokes _attachWebglRenderer directly during wiring.
        state.outage = outage;
        ctx.TabManager.activeId = 't_new_active';
        const tab = wiredTab(ctx, 't_new_active', 'local_new_active', 'x');
        const tabRec = recOf(ctx, tab);
        assert.equal(tabRec.lossCount, 1, `${outage}: new active tab records loss`);
        assert.equal(tabRec.retryAttempts, 1, `${outage}: new active tab arms attempt 1`);
        assert.notEqual(tabRec.lastRetryResult, 'deferred-inactive',
            `${outage}: wireTerminal assigns tab.term before _attachWebglRenderer so _resolveTermOwner succeeds`);
        assert.ok(tabRec.retryTimer, `${outage}: new active tab arms backoff timer`);
        assert.equal(pendingSetHas(ctx, tab), true, `${outage}: new active tab enters pending set`);

        // Split the active tab and wire a new active pane during the same outage.
        ctx.TabManager.addPaneRelativeTo(tab, 'b');
        const panes = ctx.getAllPanes(tab);
        assert.equal(panes.length, 2);
        const p2 = panes[1];
        p2.tabId = 'local_new_pane';
        ctx.wireTerminalToPane(tab, p2);
        const paneRec = ctx.__eval('(term) => _webglByTerm.get(term)')(p2.term);
        assert.equal(paneRec.lossCount, 1, `${outage}: new active split pane records loss`);
        assert.equal(paneRec.retryAttempts, 1, `${outage}: new active split pane arms attempt 1`);
        assert.notEqual(paneRec.lastRetryResult, 'deferred-inactive',
            `${outage}: wireTerminalToPane assigns pane.term before _attachWebglRenderer`);
        assert.ok(paneRec.retryTimer, `${outage}: new active split pane arms backoff timer`);
        assert.equal(ctx.__eval('(term) => _webglRecoveryPending.has(term)')(p2.term), true);

        // GPU recovers: both newly created holders self-heal automatically without tab switch.
        state.outage = 'none';
        ctx.__tq.advance(2000);
        assert.ok(panes[0]._smoothCursor?._adapter, `${outage}: primary pane heals automatically`);
        assert.ok(p2._smoothCursor?._adapter, `${outage}: split pane heals automatically`);
    }
});
