// U-01 + U-06: pane header state refresh is unified. The reconnect button's
// visibility used to be evaluated exactly once — in buildPane, i.e. only when
// a pane DOM node was CREATED — while the node-reuse branch of _renderSplit
// repainted only the dot, and the ipc.js SSH lifecycle paths never repainted
// the pane header at all (_applySshConnecting) or only the dot
// (_updatePaneDot). User-visible fallout:
//   (A) a split SSH pane that dropped mid-session never showed its reconnect
//       button again (its header node was never rebuilt);
//   (B) a header built while disconnected kept the button after the session
//       went live — clicking it recycled the healthy connection;
//   (C) a restored split SSH tab (tab-serialize.js rebuilds panes with
//       connected:false) carried the button for the whole session after the
//       handshake succeeded;
//   (U-06) the connecting phase never repainted the pane dot: stale gray on a
//       restored tab, stale red across automatic retries.
// Every pane-header state write now funnels through _refreshPaneHeaderState
// (tabs.js), which syncs the dot class AND the reconnect button from the
// pane's flags. The tests below assert BUTTON EXISTENCE on the live header
// DOM, not just dot classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

// tab-serialize.js is not loaded by the shared harness (custom-name-restore
// convention): load it the way the page's script tag does so _restoreSplitTab
// can deserialize a saved split tree.
function loadVmWithSerialize() {
    const ctx = loadVm();
    vm.runInContext(readFileSync(new URL('../src/renderer/tab-serialize.js', import.meta.url), 'utf8'), ctx, { filename: 'tab-serialize.js' });
    return ctx;
}

function paneHeader(ctx, pane) {
    const paneEl = ctx.document.querySelector(`.split-pane[data-pane="${pane.id}"]`);
    const hdr = paneEl && paneEl.querySelector('.pane-header');
    assert.ok(hdr, 'pane header DOM exists for ' + pane.id);
    return hdr;
}

const reconnectBtn = (hdr) => hdr.querySelector('.pane-reconnect');

// The harness never parses innerHTML into child elements, so the dot/label
// baked by buildPane are invisible to queries. Stage REAL elements inside the
// LIVE header so dot-class assertions observe the actual _refreshPaneHeaderState
// writes. Buttons need no staging: the helper itself creates them as elements.
// Clearing the children drops any button staged earlier — callers re-run the
// refresh to rebuild a consistent header before asserting on it.
function stageHeaderElements(ctx, pane) {
    const hdr = paneHeader(ctx, pane);
    hdr.children.length = 0;
    const dot = ctx.document.createElement('span');
    dot.className = 'dot disconnected';
    const label = ctx.document.createElement('span');
    label.className = 'label';
    hdr.appendChild(dot);
    hdr.appendChild(label);
    return { hdr, dot };
}

// First split of an SSH tab: pane 1 is the promoted tab session (backend
// ssh_0), pane 2 a fresh SSH pane whose backend _spawnBackendForPane already
// initiated (its attempt token is live in the registry).
function sshSplit(ctx, id, connected) {
    const tab = wiredTab(ctx, id, 'ssh_0', 'boot', {
        type: 'ssh', host: 'hst', user: 'u', connected,
    });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    return { tab, p1: panes[0], p2: panes[1] };
}

test('_refreshPaneHeaderState paints the dot class and toggles the button from the pane flags', () => {
    const ctx = loadVm();
    const { p1 } = sshSplit(ctx, 't1', false);
    const { hdr, dot } = stageHeaderElements(ctx, p1);

    // Disconnected SSH pane: gray dot + reconnect button.
    ctx._refreshPaneHeaderState(p1);
    assert.equal(dot.className, 'dot disconnected');
    assert.ok(reconnectBtn(hdr), 'a disconnected SSH pane offers reconnect');

    // Connecting: spinner dot, button withdrawn.
    p1._sshConnecting = true;
    ctx._refreshPaneHeaderState(p1);
    assert.equal(dot.className, 'dot connecting');
    assert.equal(reconnectBtn(hdr), null, 'no reconnect entry while connecting');

    // Failed attempt: red dot, button back.
    p1._sshConnecting = false; p1._sshErrored = true;
    ctx._refreshPaneHeaderState(p1);
    assert.equal(dot.className, 'dot error');
    assert.ok(reconnectBtn(hdr), 'a failed pane offers reconnect');

    // Live session: green dot, no button (the U-01 scenario-B regression).
    p1._sshErrored = false; p1.connected = true;
    ctx._refreshPaneHeaderState(p1);
    assert.equal(dot.className, 'dot connected');
    assert.equal(reconnectBtn(hdr), null, 'a live session carries no reconnect entry');

    // Idempotent: repeated syncs never duplicate the button.
    p1.connected = false;
    ctx._refreshPaneHeaderState(p1);
    ctx._refreshPaneHeaderState(p1);
    assert.equal(hdr.querySelectorAll('.pane-reconnect').length, 1, 'exactly one reconnect button');

    // A disconnected LOCAL pane never gets the button (type guard).
    p1.type = 'local';
    ctx._refreshPaneHeaderState(p1);
    assert.equal(dot.className, 'dot disconnected');
    assert.equal(reconnectBtn(hdr), null, 'a local pane has no reconnect entry');
});

test('ssh-disconnected on a live split pane surfaces the reconnect button (U-01 A)', () => {
    const ctx = loadVm();
    const { p1, p2 } = sshSplit(ctx, 't2', true);

    ctx.__emit('ssh-connected', { tabId: 'ssh_0' });
    assert.equal(reconnectBtn(paneHeader(ctx, p1)), null, 'live pane carries no button');
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'never-connected sibling spawns none either');

    // The pane drops mid-session: the header node is REUSED (no rebuild), so
    // only the unified refresh can surface the button (old code: never).
    ctx.__emit('ssh-disconnected', { tabId: 'ssh_0' });
    assert.equal(p1.connected, false);
    assert.ok(reconnectBtn(paneHeader(ctx, p1)), 'the dropped pane now offers reconnect');
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'the sibling is untouched');
});

test('a header built while disconnected drops the button once the session lives (U-01 B)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = sshSplit(ctx, 't3', false);

    // Split created while the tab was down: both SSH pane headers are built
    // disconnected — the button is legitimately present at build time.
    assert.ok(reconnectBtn(paneHeader(ctx, p1)), 'the promoted pane builds with the button');
    assert.ok(reconnectBtn(paneHeader(ctx, p2)), 'the fresh SSH pane builds with the button');

    // The fresh pane's spawned handshake proceeds: connecting withdraws the
    // button, and success must not bring it back (old code left it on the
    // live session, where a click recycled the healthy connection).
    const tok = ctx.sshAttempts.ownerAttempt(p2);
    ctx.__emit('ssh-connecting', { tabId: 'ssh_2', attemptId: tok });
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'the connecting window shows no button');
    ctx.__emit('ssh-connected', { tabId: 'ssh_2' });
    assert.equal(p2.connected, true);
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'the live session keeps no reconnect entry');

    // Manual reconnect of the still-down promoted pane: same withdrawal for
    // its own reconnect window (its header node is reused, not rebuilt).
    ctx.TabManager._reconnectPane(tab.id, p1.id);
    assert.equal(p1._sshConnecting, true);
    assert.equal(reconnectBtn(paneHeader(ctx, p1)), null, 'the reconnect window shows no button');
});

test('a restored split SSH tab withdraws the button through the handshake (U-01 C + U-06)', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab({
        name: 'srv', type: 'ssh', host: 'hst',
        splitRoot: {
            orientation: 'h', ratios: [0.5, 0.5],
            children: [
                { type: 'leaf', name: 'a', paneType: 'ssh', sshHost: 'hst', sshUser: 'u' },
                { type: 'leaf', name: 'b', paneType: 'ssh', sshHost: 'hst', sshUser: 'u' },
            ],
        },
    });
    const [pa, pb] = ctx.getAllPanes(tab);
    assert.equal(pa.connected, false, 'restored SSH panes rebuild disconnected');
    assert.ok(reconnectBtn(paneHeader(ctx, pa)), 'restore builds the header with the button');
    assert.ok(reconnectBtn(paneHeader(ctx, pb)));

    // The auto-reconnect handshake begins. U-06: the pane dot used to stay
    // gray through the whole connecting phase while the tab strip span.
    const { dot } = stageHeaderElements(ctx, pa);
    ctx._refreshPaneHeaderState(pa); // restage a consistent header (disconnected → button back)
    assert.ok(reconnectBtn(paneHeader(ctx, pa)), 'the staged header carries the button again');
    const tok = ctx.sshAttempts.ownerAttempt(pa);
    ctx.__emit('ssh-connecting', { tabId: 'ssh_r', attemptId: tok });
    assert.equal(dot.className, 'dot connecting', 'the pane dot tracks the connecting phase');
    assert.equal(reconnectBtn(paneHeader(ctx, pa)), null, 'connecting withdraws the button');

    // Success ends the story for the whole session (old code: the button
    // built at restore lingered on the live session until the tab closed).
    ctx.__emit('ssh-connected', { tabId: 'ssh_r' });
    assert.equal(pa.connected, true);
    assert.equal(dot.className, 'dot connected');
    assert.equal(reconnectBtn(paneHeader(ctx, pa)), null, 'success leaves no button on the live session');
});

test('the pane dot follows the automatic-retry cycle (U-06: stale red during retry)', () => {
    const ctx = loadVm();
    const { p2 } = sshSplit(ctx, 't4', true);
    const { dot } = stageHeaderElements(ctx, p2);
    const tok = ctx.sshAttempts.ownerAttempt(p2);

    // Handshake starts, then a transient (handshake-class) failure schedules
    // the automatic retry: the pane shows the error dot + button for the
    // backoff window.
    ctx.__emit('ssh-connecting', { tabId: 'ssh_9', attemptId: tok });
    assert.equal(dot.className, 'dot connecting');
    ctx.__emit('ssh-error', { tabId: 'ssh_9', attemptId: tok, error: 'Connection timed out' });
    assert.equal(p2._sshErrored, true);
    assert.equal(dot.className, 'dot error', 'backoff window shows the error dot');
    assert.ok(reconnectBtn(paneHeader(ctx, p2)), 'backoff window offers manual reconnect');

    // The retry fires after the backoff and its ssh-connecting must repaint
    // the pane dot (old code: it stayed red through the whole retry attempt).
    ctx.__tq.advance(2100);
    const tok2 = ctx.sshAttempts.ownerAttempt(p2);
    assert.notEqual(tok2, tok, 'the retry is a fresh attempt identity');
    ctx.__emit('ssh-connecting', { tabId: 'ssh_10', attemptId: tok2 });
    assert.equal(dot.className, 'dot connecting', 'the pane dot tracks the retry handshake');
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'the retry handshake withdraws the button');
});

test('an ordinary local split never grows reconnect buttons (no regression)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't5', 'b1', 'x', 'b2', 'y');
    assert.equal(reconnectBtn(paneHeader(ctx, p1)), null);
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null);

    // A tree re-render (third pane added → node REUSE for the first two)
    // keeps it that way.
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 3);
    for (const p of panes) assert.equal(reconnectBtn(paneHeader(ctx, p)), null, 'no button on ' + p.id);

    // A local process exit marks its pane disconnected — still no button.
    ctx.__emit('pty-exit', { tabId: 'b2' });
    assert.equal(p2.connected, false);
    assert.equal(reconnectBtn(paneHeader(ctx, p2)), null, 'an exited local pane offers no reconnect');
});
