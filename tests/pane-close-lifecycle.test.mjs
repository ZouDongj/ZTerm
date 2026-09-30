// Pane-close lifecycle: the exit-animation window must be re-entry safe.
// Driven through the REAL tabs.js _closePane / closeTab / _exitSplit in the
// shared renderer VM (tests/helpers/renderer-vm.mjs); timers are queued and
// fired by advancing the virtual clock, so the 200ms fade window is real.
//
// Defects pinned here (old-code failure notes per test):
// - a second _closePane for the SAME pane inside the fade window scheduled a
//   second doRemove; after the first one collapsed the tree, the late one saw
//   0 panes and closed the whole tab, destroying the SURVIVOR's live session;
// - closing both panes of the LAST tab inside one window promoted the
//   already-dead sibling back onto the tab (terminal-less shell that still
//   read connected), and the surviving closeTab call then hit the last-tab
//   guard, which only knew the "empty split tree" shape — a permanent zombie
//   tab with no terminal and a live green dot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const A_TEXT = 'alpha line\nalpha two';
const B_TEXT = 'bravo line\nbravo two';

const sendsFor = (ctx, cmd, tabId) =>
    ctx.__sends.filter(s => s.cmd === cmd && s.payload && s.payload.tabId === tabId);

test('double close of the same pane inside the fade window is a no-op; the survivor session lives', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.__tq.advance(2000); // drain setup timers (wiring fits/focuses)

    const mark = ctx.__tq.mark();
    ctx.TabManager._closePane('t_sp', p2.id);
    assert.equal(p2._closing, true, 'close initiation marks the pane dying');
    assert.equal(p1.focused, true, 'the focus marker moved to the sibling at initiation');

    // The re-fire paths (focused close button + Enter, repeated Alt+Shift+W)
    // must not schedule a second removal.
    ctx.TabManager._closePane('t_sp', p2.id);
    assert.equal(ctx.__tq.createdAfter(mark).length, 1,
        'the second close scheduled no second removal timer');
    assert.equal(sendsFor(ctx, 'pty-destroy', 'local_2').length, 1,
        'the dying pane backend is destroyed exactly once');

    ctx.__tq.advance(1000); // removal + collapse (+ any wrongly stacked removal)
    assert.ok(ctx.TabManager.tabs.includes(tab),
        'the tab survives: the late second removal must not close it');
    assert.equal(tab.splitRoot, null, 'collapsed back to a single terminal');
    assert.equal(tab.tabId, 'local_1', 'the surviving session owns the tab slot');
    assert.ok(tab.term === p1.term && !p1.term.disposed, 'surviving terminal intact');
    assert.equal(sendsFor(ctx, 'pty-destroy', 'local_1').length, 0,
        'the surviving backend is never destroyed');
});

test('closing both panes of the LAST tab in one window resets the tab instead of zombifying it', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.__tq.advance(2000);

    ctx.TabManager._closePane('t_sp', p1.id);
    ctx.TabManager._closePane('t_sp', p2.id); // distinct pane: a legitimate second close
    ctx.__tq.advance(1000);

    assert.ok(ctx.TabManager.tabs.includes(tab), 'the last tab is never closed');
    assert.equal(tab.splitRoot, null, 'no empty split tree left behind');
    assert.equal(tab.type, 'local', 'reset to the default local terminal');
    assert.ok(ctx.__sends.some(s => s.cmd === 'pty-create' && s.payload && s.payload.requestId === 't_sp'),
        'a fresh default backend was spawned for the reset tab (no terminal-less zombie)');
});
