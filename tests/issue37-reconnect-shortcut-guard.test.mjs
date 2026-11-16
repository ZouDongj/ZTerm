// Issue #37: the reconnect shortcut (default Ctrl+Shift+R) acted as a
// force-reconnect. Pressed on a LIVE session it tore the target — the tab, or
// the FOCUSED pane of a split — into the reconnect window: ssh-disconnect
// went out for a healthy backend id and the terminal was disposed. The
// gesture a shortcut can offer is only "bring an ALREADY-DISCONNECTED
// session back"; the pane-header button gates exactly that way
// (_paneReconnectWanted in tabs.js). The fix gates
// SHORTCUT_ACTIONS.reconnectTab on that same predicate, resolved to the same
// target TabManager.reconnectTab routes to (the focused pane in a split, the
// tab itself otherwise). The mouse force-reconnect paths — the tab-strip
// button calling TabManager.reconnectTab directly — stay ungated on purpose.
//
// These tests run the REAL dispatch paths: the shared renderer-vm harness
// (real tabs.js / ipc.js / terminal.js / ssh-attempts.js) with the REAL
// shortcut-utils.js + shortcuts.js layered on top in page order, then a
// real-shaped Ctrl+Shift+R keydown through the registered document capture
// listeners, and — for the palette dimension of issue #37 — the REAL
// command-palette.js click path. Only the environment (DOM / ipc bus /
// timers) is faked, per the harness convention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// Layer the real shortcut stack (page order: shortcut-utils.js runs before
// shortcuts.js) onto the harness VM and hand back a press() that fires the
// keydown listeners shortcuts.js registered on the harness document.
function loadVmWithShortcutDispatcher() {
    const ctx = loadVm();
    vm.runInContext(readFileSync(new URL('../src/renderer/shortcut-utils.js', import.meta.url), 'utf8'), ctx, { filename: 'shortcut-utils.js' });
    const before = (ctx.__docListeners.get('keydown') || []).length;
    vm.runInContext(readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8'), ctx, { filename: 'shortcuts.js' });
    const dispatchers = (ctx.__docListeners.get('keydown') || []).slice(before);
    // The REAL command palette script (it registers no document listeners, so
    // the dispatcher slice above is unaffected) plus the overlay element its
    // close path reaches for.
    const paletteEl = ctx.document.createElement('div');
    paletteEl.id = 'overlay-palette';
    ctx.__body.appendChild(paletteEl);
    vm.runInContext(readFileSync(new URL('../src/renderer/command-palette.js', import.meta.url), 'utf8'), ctx, { filename: 'command-palette.js' });
    const press = (init = {}) => {
        const ev = {
            isComposing: false, keyCode: 0,
            defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            // The default reconnectTab binding; comboFromEvent resolves the
            // action through the merged bindings like a real keydown.
            ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
            key: 'R', code: 'KeyR', target: ctx.document.body,
            ...init,
        };
        dispatchers.forEach(fn => fn(ev));
        return ev;
    };
    return { ctx, press };
}

// Single live SSH tab: backend id bound, terminal wired, session up.
function connectedSshTab(ctx) {
    const tab = wiredTab(ctx, 't_ssh', 'ssh_1', 'live session', {
        type: 'ssh', host: 'hst', user: 'u', connected: true,
    });
    ctx.TabManager.activeId = tab.id;
    return tab;
}

// Split SSH tab with two wired panes. Per-pane connection flags are staged
// per case the way the ipc.js lifecycle transitions land them
// (_updatePaneDot(pane, bool) writes pane.connected; _sshConnecting covers
// the in-flight window).
function sshSplit(ctx) {
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'ssh_1', 'p1 out', 'ssh_2', 'p2 out', {
        type: 'ssh', host: 'hst', user: 'u', connected: true,
    });
    ctx.TabManager.activeId = tab.id;
    p1.connected = true;
    p2.connected = true;
    return { tab, p1, p2 };
}

const disconnectSent = (ctx, backendId) =>
    ctx.__sends.some(s => s.cmd === 'ssh-disconnect' && s.payload && s.payload.tabId === backendId);

test('issue #37: the shortcut must not interrupt a CONNECTED single SSH tab', () => {
    const { ctx, press } = loadVmWithShortcutDispatcher();
    const tab = connectedSshTab(ctx);
    const termBefore = tab.term;
    const sendsBefore = ctx.__sends.length;

    const ev = press();

    assert.ok(ev.defaultPrevented, 'the bound combo is still consumed');
    assert.equal(tab._reconnectPending, undefined, 'no reconnect window opened');
    assert.equal(tab.term, termBefore, 'terminal kept in place');
    assert.equal(tab.term.disposed, false, 'terminal not disposed');
    assert.equal(tab.tabId, 'ssh_1', 'backend binding kept');
    assert.equal(tab.connected, true, 'session still connected');
    assert.equal(ctx.__sends.length - sendsBefore, 0, 'no disconnect / teardown traffic for the live session');
});

test('issue #37: the shortcut ignores a session still inside its connect attempt', () => {
    const { ctx, press } = loadVmWithShortcutDispatcher();
    const tab = connectedSshTab(ctx);
    // Shape of a connect in flight (reconnectTab's own pre-attempt window,
    // or the connecting applier on a re-attempted tab): explicitly down is not
    // yet established — the busy state, not a reconnectable one.
    tab.connected = false;
    tab._sshConnecting = true;
    const termBefore = tab.term;

    press();

    assert.equal(tab._reconnectPending, undefined, 'no second connect stacked on the in-flight one');
    assert.equal(tab.term, termBefore, 'terminal kept');
    assert.equal(disconnectSent(ctx, 'ssh_1'), false, 'no ssh-disconnect for the pending session');
});

test('issue #37: the shortcut must not interrupt the CONNECTED focused pane of a split', () => {
    const { ctx, press } = loadVmWithShortcutDispatcher();
    const { tab, p1, p2 } = sshSplit(ctx);
    ctx.TabManager._focusPane(tab, p2.id); // focused pane is live
    const termBefore = p2.term;
    const sendsBefore = ctx.__sends.length;

    const ev = press();

    assert.ok(ev.defaultPrevented, 'the bound combo is still consumed');
    assert.equal(p2._reconnectPending, undefined, 'focused pane entered no reconnect window');
    assert.equal(p2.term, termBefore, 'focused pane terminal kept');
    assert.equal(p2.tabId, 'ssh_2', 'focused pane backend binding kept');
    assert.equal(p1._reconnectPending, undefined, 'sibling pane untouched too');
    assert.equal(ctx.__sends.length - sendsBefore, 0, 'no disconnect / teardown traffic for either pane');
});

test('(gesture kept) the shortcut still reconnects a DISCONNECTED single SSH tab', () => {
    const { ctx, press } = loadVmWithShortcutDispatcher();
    const tab = connectedSshTab(ctx);
    // Shape after ssh-disconnected / terminal ssh-error: explicitly down,
    // not connecting — the state the tab-strip button reconnects.
    tab.connected = false;
    tab._sshConnecting = false;

    press();

    assert.equal(tab._reconnectPending, true, 'the reconnect window opened');
    assert.ok(disconnectSent(ctx, 'ssh_1'), 'the dead session was discarded through ssh-disconnect');
});

test('(pane focus) a disconnected FOCUSED pane reconnects while its live sibling keeps the tab aggregated connected', () => {
    const { ctx, press } = loadVmWithShortcutDispatcher();
    const { tab, p1, p2 } = sshSplit(ctx);
    // p1 live, p2 dropped: tab.connected aggregates TRUE (a guard reading the
    // tab-level flag would wrongly dead-lock the focused pane's reconnect).
    p2.connected = false;
    p2._sshConnecting = false;
    assert.equal(tab.connected, true, 'fixture: tab-level state is aggregated true');
    ctx.TabManager._focusPane(tab, p2.id);

    press();

    assert.equal(p2._reconnectPending, true, 'the focused disconnected pane entered its reconnect window');
    assert.equal(p1._reconnectPending, undefined, 'the live sibling did not reconnect');
    assert.equal(p1.tabId, 'ssh_1', 'live sibling backend binding kept');
    assert.equal(disconnectSent(ctx, 'ssh_2'), true, 'the dropped session was discarded');
    assert.equal(disconnectSent(ctx, 'ssh_1'), false, 'the live sibling session was NOT disconnected');
});

test('(palette kept, issue #37 scope) the REAL palette click path still force-reconnects a CONNECTED tab', () => {
    const { ctx } = loadVmWithShortcutDispatcher();
    const tab = connectedSshTab(ctx);

    // paletteClickItem is the palette's real invocation: closePalette() then
    // SHORTCUT_ACTIONS.reconnectTab() with NO keyboard-origin flag — an
    // explicit command from a picked list entry, not a bound key.
    ctx.paletteClickItem('reconnectTab');

    assert.equal(tab._reconnectPending, true, 'the palette entry still force-reconnects the live session');
    assert.ok(disconnectSent(ctx, 'ssh_1'), 'the live session was discarded through ssh-disconnect');
});

test('(mouse force-reconnect kept) TabManager.reconnectTab directly called still interrupts a connected tab', () => {
    const { ctx } = loadVmWithShortcutDispatcher();
    const tab = connectedSshTab(ctx);

    // The tab-strip button path (tabs.js render): a direct call, bypassing
    // the shortcut action — issue #37 restricts only the shortcut.
    ctx.TabManager.reconnectTab(tab.id);

    assert.equal(tab._reconnectPending, true, 'the explicit force-reconnect still opens the window');
    assert.ok(disconnectSent(ctx, 'ssh_1'), 'force-reconnect still discards the live session');
});
