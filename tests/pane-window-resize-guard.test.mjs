// The pane ResizeObserver installed by wireTerminalToPane must suppress fit
// while the window is being drag-resized (_windowResizing), same as the
// single-tab observer (setupWrapResizeObserver) and the observer _renderSplit
// installs for fresh pane bodies. wireTerminalToPane disconnects that guarded
// observer and, before this fix, replaced it with an unguarded one: every
// window-drag frame ran a full fit plus an immediate pty-resize report, so an
// SSH pane hammered the remote with resize events (nvim/htop re-laid out
// every frame, visible jitter). The final size still settles through
// split.js's resize-settlement pass after the drag stops.
//
// REAL in this VM: terminal.js wireTerminalToPane (observer install, applyFit
// guard, resize report) and the tabs.js split construction it replaces the
// observer of, via tests/helpers/renderer-vm.mjs. Faked per the harness,
// plus: ResizeObserver is recorded so tests can fire its callback by hand
// (the harness rAF runs synchronously, so one callback tick == one observer
// frame), and _windowResizing is driven directly (it is a split.js global in
// the page, predeclared in the VM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredSplitTab } from './helpers/renderer-vm.mjs';

function loadObserverVm() {
    const ctx = loadVm();
    const observers = [];
    ctx.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.dead = false; this.el = null; observers.push(this); }
        observe(el) { this.el = el; }
        disconnect() { this.dead = true; }
    };
    return { ctx, observers };
}

// The live observer of a pane body: the _renderSplit one is disconnected by
// wireTerminalToPane, so filter to the connected observer of that element.
function liveBodyObserver(observers, pane) {
    const id = 'pane-body_' + pane.id;
    return observers.filter(o => !o.dead && o.el && o.el.id === id).pop() || null;
}

test('pane observer suppresses fit and resize report during window drag, resumes after', () => {
    const { ctx, observers } = loadObserverVm();
    const { p2 } = wiredSplitTab(ctx, 't_w', 'local_1', null, 'local_2', null);
    const fits = [];
    p2.fitAddon.fit = () => fits.push('p2');
    const obs = liveBodyObserver(observers, p2);
    assert.ok(obs, 'wireTerminalToPane installed its own body observer');
    // Give the fake body a measurable size: _fitWithScroll no-ops on a
    // zero-area element (as it does for a hidden tab's pane).
    obs.el._cw = 200; obs.el._ch = 100;
    // Outside the split-layout suppression window so the immediate resize
    // report is reachable at all.
    ctx.TabManager._layoutTime = 0;

    ctx._windowResizing = true;
    const sendsBefore = ctx.__sends.length;
    obs.cb();
    assert.deepEqual(fits, [], 'no fit while the window is being dragged');
    assert.equal(ctx.__sends.length, sendsBefore, 'no immediate pty-resize report during the drag');

    obs.cb();
    assert.deepEqual(fits, [], 'every drag frame stays suppressed');

    ctx._windowResizing = false;
    obs.cb();
    assert.deepEqual(fits, ['p2'], 'fit resumes once the drag is over');
    const resize = ctx.__sends.slice(sendsBefore).find(s => s.cmd === 'pty-resize' && s.payload.tabId === 'local_2');
    assert.ok(resize, 'the settled size is reported to the pane backend after the drag');
});

test('spanner drags keep their existing suppression (guard untouched)', () => {
    const { ctx, observers } = loadObserverVm();
    const { p2 } = wiredSplitTab(ctx, 't_w2', 'local_1', null, 'local_2', null);
    const fits = [];
    p2.fitAddon.fit = () => fits.push('p2');
    const obs = liveBodyObserver(observers, p2);
    assert.ok(obs);
    obs.el._cw = 200; obs.el._ch = 100;

    ctx._spannerDrag = { tab: null }; // truthy marker, as split.js sets during a spanner drag
    obs.cb();
    assert.deepEqual(fits, [], 'spanner drag still suppresses pane fit');
    ctx._spannerDrag = false;
    obs.cb();
    assert.deepEqual(fits, ['p2'], 'fit resumes after the spanner drag');
});
