// Batch 04: delayed terminal focus lifetime/ownership across tab and pane
// operations, driven through the REAL tabs.js / terminal.js methods in the
// shared renderer VM (tests/helpers/renderer-vm.mjs). Every sequence uses
// normal chronological queued timers: an operation schedules its delayed
// focus, a real second operation runs inside the window, then the clock
// advances and the timer fires AFTER it — no reversed or forced timer order.
//
// Contract under test (one test per path, first assertion = the named
// defect, so an unrelated earlier failure cannot mask it):
// - a closed/disposed terminal receives no focus and no null dereference;
// - an inactive tab/pane receives no stale focus;
// - the latest explicit focus target wins when timers run;
// - a newer search/overlay/form focus is not stolen by stale work;
// - a still-active valid terminal IS focused normally, including right
//   after a migration (extract/move must not disable activation);
// - skipping stale focus never suppresses still-required resize work.
//
// Focus observation: RealTerm.focused is sticky, so armFocusWindow() clears
// every flag (and resets document.activeElement to <body>) right before the
// timed window; a "focused" assertion inside the window is then exactly one
// focus() landing on that terminal. Focus-owner staging that the real DOM
// would provide natively (a click moving focus) is set by hand on
// document.activeElement and labeled at each site. RealTerm.focus() throws
// once disposed as a STRICT forbidden-call sentinel — the bundled xterm's
// focus() no-ops there, so tests tripping the sentinel say so explicitly
// and do not claim a native crash; the null term-slot dereference is the
// genuine native crash class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab, armFocusWindow, TimerQueue } from './helpers/renderer-vm.mjs';

const A_TEXT = 'alpha needle one\nplain line\nalpha needle two';
const B_TEXT = 'bravo line\nbravo two\nbravo three';

// All terms of a ctx (tab slot + pane slots) for sweep-style assertions.
function allTerms(ctx) {
    const out = [];
    for (const t of ctx.TabManager.tabs) {
        if (t.term) out.push(t.term);
        if (t.splitRoot) for (const p of ctx.getAllPanes(t)) if (p.term) out.push(p.term);
    }
    return out;
}
const sendsFor = (ctx, cmd, tabId) => ctx.__sends.filter(s => s.cmd === cmd && s.payload && s.payload.tabId === tabId);

// ═══ 1. _focusPane + _closePane inside the 50ms window (primary repro) ═══
// Click pane 2, close pane 2 within 50ms: the close nulls pane.term and
// disposes the terminal synchronously at initiation; the delayed callback
// must not dereference the dead slot, and the collapse still focuses the
// survivor normally.

test('_focusPane delayed focus survives _closePane clearing the pane slot (RED old code: null deref)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000); // drain setup timers (wiring fits/focuses)
    armFocusWindow(ctx);

    const dyingTerm = p2.term;
    ctx.TabManager._focusPane(tab, p2.id);        // schedules term.focus() at +50ms
    ctx.TabManager._closePane('t_sp', p2.id);     // real second op inside the window
    assert.equal(p2.term, null, 'close nulls the pane slot synchronously (initiation commit)');
    assert.equal(dyingTerm.disposed, true, 'close disposes the terminal synchronously');

    // Old code: the captured pane's term is null → the 50ms callback throws.
    assert.doesNotThrow(() => ctx.__tq.advance(60), 'the delayed _focusPane callback must not throw');
    assert.equal(dyingTerm.focused, false, 'the disposed terminal receives no focus');

    // Deferred removal collapses the split; the survivor is focused normally.
    ctx.__tq.advance(600);
    ctx.__tq.advance(300);
    assert.equal(tab.term, p1.term, 'collapse handed the tab slot to the survivor');
    assert.equal(p1.term.focused, true, 'survivor focused after the collapse (ordinary activation)');
});

// ═══ 2. Latest pane focus wins (rapid pane clicks) ═══

test('a stale pane-focus timer cannot steal focus from a newer pane focus (RED old code: steals)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    ctx.TabManager._focusPane(tab, p2.id);   // timer A (+50ms): p2
    ctx.TabManager._focusPane(tab, p1.id);   // timer B (+50ms): p1 — the user moved on
    ctx.__tq.advance(100);
    assert.equal(p1.term.focused, true, 'the newest explicit target is focused');
    assert.equal(p2.term.focused, false, 'the superseded pane timer must not focus p2');
});

// ═══ 3. Latest tab wins (rapid tab switches) ═══

test('a stale switchTo focus timer cannot steal focus from a newer active tab (RED old code: steals)', () => {
    const ctx = loadVm();
    const ta = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    const tb = wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    ctx.TabManager.switchTo('t_a');   // timer (+100ms): t_a's terminal
    ctx.TabManager.switchTo('t_b');   // newer intent: t_b is active now
    ctx.__tq.advance(300);
    assert.equal(tb.term.focused, true, 'the active tab\'s terminal is focused');
    assert.equal(ta.term.focused, false, 'the deactivated tab\'s timer must not steal focus');
});

// ═══ 4. switchTo(split) + closeTab inside the 250ms window ═══
// The split branch's 250ms callback captured the focused pane; closeTab
// disposes the panes during the window. The old callback's focus on the
// disposed terminal trips the harness SENTINEL (forbidden call; the bundled
// xterm would silently no-op there) — the genuinely native crash class is
// the null-slot dereference of tests 1 and 8.

test('switchTo split focus timer is inert after closeTab (RED old code: forbidden focus on a disposed terminal)', () => {
    const ctx = loadVm();
    const { p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    const tb = wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    p1.focused = true; p2.focused = false; // make p1 the focused pane (disposed FIRST by the stagger)
    ctx.TabManager.switchTo('t_sp');       // schedules fit + focus at +250ms on p1
    ctx.TabManager.closeTab('t_sp');       // inside the window: switches to t_b, deferred disposal at +200ms
    armFocusWindow(ctx);
    assert.doesNotThrow(() => ctx.__tq.advance(600), 'the delayed split focus callback must not throw');
    assert.equal(p1.term.disposed, true, 'pane terminals disposed by the deferred removal');
    assert.equal(p1.term.focused, false, 'the dying tab\'s pane receives no stale focus');
    assert.equal(tb.term.focused, true, 'the successor tab keeps ordinary focus');
});

// ═══ 5. switchTo(single) + closeTab inside the 100ms window ═══

test('switchTo single focus timer is inert after closeTab (RED old code: steals into a dying tab)', () => {
    const ctx = loadVm();
    const ta = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    const tb = wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.TabManager.switchTo('t_a');   // timer (+100ms): t_a's terminal
    ctx.TabManager.closeTab('t_a');   // inside the window: switches to t_b
    armFocusWindow(ctx);
    ctx.__tq.advance(400);
    assert.equal(ta.term.focused, false, 'a closing tab\'s terminal receives no focus');
    assert.equal(tb.term.focused, true, 'the successor tab is focused normally');
});

// ═══ 6. Search input opened inside the window keeps its focus ═══

test('a stale switchTo timer does not steal focus from the opened search input (RED old code: steals)', () => {
    const ctx = loadVm();
    const ta = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    const tb = wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    ctx.TabManager.switchTo('t_a');   // timer (+100ms): t_a's terminal
    ctx.openSearch();                 // inside the window: Ctrl+F opens the bar
    ctx.__tq.advance(200);            // openSearch focuses the input at +50ms, switchTo fires at +100ms
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'the search input keeps focus');
    assert.equal(ta.term.focused, false, 'the terminal must not reclaim focus from the input');
});

// ═══ 7. Overlay policy: an open overlay owns keyboard intent ═══

test('a stale switchTo timer does not steal focus while an overlay is open (RED old code: steals)', () => {
    const ctx = loadVm();
    const ta = wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    const tb = wiredTab(ctx, 't_b', 'local_b', B_TEXT);
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    // Stage a palette-style overlay exactly as renderer.html declares them.
    const ov = ctx.document.createElement('div');
    ov.className = 'overlay'; ov.id = 'overlay-palette';
    ctx.document.body.appendChild(ov);
    ctx.TabManager.switchTo('t_a');       // timer (+100ms): t_a's terminal
    ov.classList.add('open');             // inside the window: the user opened the overlay
    ctx.__tq.advance(200);
    assert.equal(ta.term.focused, false, 'an open overlay must not lose keyboard focus to a stale timer');

    // The policy must not disable ordinary activation afterwards.
    ov.classList.remove('open'); ov.remove();
    ctx.TabManager.switchTo('t_b');
    ctx.__tq.advance(200);
    assert.equal(tb.term.focused, true, 'after the overlay closes, switching focuses normally');
});

// ═══ 8. _exitSplit + reconnect (clear) inside the 100ms window ═══
// reconnectTab with clearOnConnect disposes the survivor and nulls tab.term
// synchronously; the exit-split refocus must resolve the slot at fire time.

test('_exitSplit delayed focus survives a reconnect clearing tab.term (RED old code: null deref)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT, { type: 'ssh' });
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    const survivor = p1.term;
    ctx.TabManager._exitSplit(tab);       // schedules tab.term.focus() at +100ms
    ctx.TabManager.reconnectTab('t_sp');  // inside the window: clear-on-connect (profile default)
    assert.equal(tab.term, null, 'reconnect cleared the tab slot synchronously');
    assert.equal(survivor.disposed, true, 'the survivor terminal was disposed');

    // Old code: the callback dereferenced the nulled tab.term and threw.
    assert.doesNotThrow(() => ctx.__tq.advance(600), 'the exit-split refocus must not throw');
    assert.equal(survivor.focused, false, 'the disposed survivor receives no focus');
});

// ═══ 9. wireTerminal + reconnect (clear) inside the 150ms window ═══
// The old callback focused the captured terminal after the reconnect
// disposed it. The harness sentinel throws on that forbidden call — in the
// bundled xterm it would silently no-op, so this pins the STALE CALL policy
// (no focus attempt on a disposed terminal), not an additional native
// crash; the native crash class is the null-slot deref (tests 1 and 8).

test('wireTerminal delayed focus makes no disposed-terminal call after a reconnect (RED old code: forbidden disposed focus)', () => {
    const ctx = loadVm();
    const tab = { id: 't_ssh', name: 't_ssh', type: 'ssh', command: '', args: [], connected: false };
    ctx.TabManager.tabs.push(tab);
    ctx.TabManager.switchTo('t_ssh');   // wireTerminal only schedules when the tab is active
    ctx.wireTerminal(tab, 'ssh_b1');    // schedules term.focus() at +150ms
    armFocusWindow(ctx);
    const term = tab.term;

    ctx.TabManager.reconnectTab('t_ssh'); // inside the window: dispose + slot clear
    assert.equal(term.disposed, true, 'the wired terminal was disposed by the reconnect');

    // Old code: the sentinel throws on the disposed-terminal focus attempt.
    assert.doesNotThrow(() => ctx.__tq.advance(400), 'the wiring focus callback must not target a disposed terminal');
    assert.equal(term.focused, false, 'the disposed terminal receives no focus');
});

// ═══ 10. _moveTerminalToTab + tab switch inside the 150ms window ═══

test('cross-tab move delayed focus is inert after switching away (RED old code: steals)', () => {
    const ctx = loadVm();
    const { p2 } = wiredSplitTab(ctx, 't_src', 'local_1', A_TEXT, 'local_2', B_TEXT);
    const tgt = wiredTab(ctx, 't_tgt', 'local_t', B_TEXT);
    const other = wiredTab(ctx, 't_other', 'local_o', A_TEXT);
    ctx.TabManager.switchTo('t_src');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    const movedTerm = p2.term;
    ctx.TabManager._moveTerminalToTab('t_src', 't_tgt', 'r', null); // auto-switches to t_tgt; mt.focus() at +150ms
    ctx.TabManager.switchTo('t_other');                             // inside the window: the user left
    ctx.__tq.advance(500);
    assert.equal(movedTerm.focused, false, 'a pane of an inactive tab receives no stale focus');
    assert.equal(other.term.focused, true, 'the active tab keeps ordinary focus');
});

// ═══ 11. _closePane leaving two panes + tab switch inside the 150ms window ═══

test('pane-close survivor refocus is inert after switching away (RED old code: steals)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.addPaneRelativeTo(tab, 'b'); // third (pending) pane, becomes focused
    const other = wiredTab(ctx, 't_other', 'local_o', A_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    const panes = ctx.getAllPanes(tab);
    ctx.TabManager._closePane('t_sp', panes[2].id); // leaves p1+p2; survivor refocus at +150ms
    ctx.TabManager.switchTo('t_other');             // inside the window
    // The survivor timer is scheduled inside the deferred removal (200ms) and
    // fires at 350ms under the chronological queue (nested timers run at
    // their own deadlines); the second flush is belt-and-braces.
    ctx.__tq.advance(600);
    ctx.__tq.advance(600);
    assert.equal(p1.term.focused, false, 'the background tab\'s survivor receives no stale focus');
    assert.equal(other.term.focused, true, 'the active tab keeps ordinary focus');
});

// ═══ 12. _maximizePane + tab switch inside the 220ms window ═══
// The 220ms callback shares fit, the explicit pty-resize and focus: skipping
// the stale focus must not suppress the still-required resize work.

test('maximize focus is inert after switching away, but its pty-resize still lands (RED old code: steals)', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    const other = wiredTab(ctx, 't_other', 'local_o', A_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    ctx.TabManager._maximizePane('t_sp', p2.id); // fit + explicit resize + focus at +220ms
    ctx.TabManager.switchTo('t_other');          // inside the window
    ctx.__tq.advance(400);
    assert.equal(p2.term.focused, false, 'the maximized pane of an inactive tab receives no stale focus');
    const resizes = sendsFor(ctx, 'pty-resize', 'local_2');
    assert.ok(resizes.length >= 1, 'the maximize final-size resize still reached the backend');
    assert.equal(other.term.focused, true, 'the active tab keeps ordinary focus');
});

// ═══ 13. Guards: activation still works when nothing is stale ═══

test('(guard) ordinary switch and extract auto-switch focus their terminals normally', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    ctx.TabManager.switchTo('t_sp');   // split branch: +250ms focus of the focused pane
    ctx.__tq.advance(300);
    assert.equal(p2.term.focused, true, 'switching to a split tab focuses the focused pane');

    armFocusWindow(ctx);
    ctx.TabManager._extractPaneToTab(tab.id, p2.id); // auto-switchTo(nt): migration must not disable activation
    ctx.__tq.advance(300);
    assert.equal(p2.term.focused, true, 'the extracted terminal is focused on its new tab');

    armFocusWindow(ctx);
    ctx.TabManager.switchTo('t_sp');   // collapsed survivor, ordinary activation
    ctx.__tq.advance(300);
    assert.equal(p1.term.focused, true, 'switching back focuses the survivor');
});

// ═══ 14. Guard: a pane click while the search input holds focus still
// focuses the terminal (the click's mousedown owns the newer intent; in the
// real DOM the browser moves focus into .xterm at mousedown, which the
// harness stages by leaving activeElement unchanged through the window). ═══

test('(guard) pane click with the search bar open still focuses the clicked terminal', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.openSearch();
    ctx.__tq.advance(2000);   // the search input now holds focus
    armFocusWindow(ctx);
    ctx.document.activeElement = ctx.__searchInput; // stage the input as focus owner
    assert.equal(ctx.document.activeElement, ctx.__searchInput);

    ctx.TabManager._focusPane(tab, p1.id); // the user's pane click (+50ms)
    ctx.__tq.advance(100);
    assert.equal(p1.term.focused, true, 'the clicked pane is focused (input focus was not newer than the click)');
    assert.equal(p2.term.focused, false);
});

// ═══ 14b. Passive completion must not steal a held form focus ═══
// Main's counterexample (correction 1): the intent snapshot is captured when
// the DELAYED COMPLETION schedules its timer, which is too late — the user's
// search entry happened after their original split action but before the
// backend arrived. Backend-ready wiring is a PASSIVE completion: any form
// field holding focus at fire time survives it, while the fresh terminal is
// still focused normally when nothing holds a form focus.

test('late pane readiness does not steal the focused search input (RED: passive completion steals)', () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_async', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_async');
    ctx.__tq.advance(2000);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const fresh = ctx.getAllPanes(tab).find(p => !p.term);
    ctx.openSearch();
    ctx.__tq.advance(60);
    // The search input holds focus BEFORE the backend-ready event arrives.
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'search input focused before backend-ready');

    // Real claim path: ipc.js's pty-created handler wires the pending pane.
    ctx.ptyBuffers.local_fresh = 'alpha needle fresh';
    ctx.__emit('pty-created', { tabId: 'local_fresh', requestId: fresh.requestId });
    assert.ok(fresh.term && !fresh.term.disposed, 'the real pty-created handler wired the pane');

    ctx.__tq.advance(600);
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'the search input retains focus after the late terminal arrives');
    assert.equal(fresh.term.focused, false, 'the passively-arrived terminal must not steal focus');
});

test('late tab readiness does not steal the focused search input (RED: passive completion steals)', () => {
    const ctx = loadVm();
    const tab = { id: 't_pend', name: 't_pend', type: 'local', command: 'powershell.exe', args: [] };
    ctx.TabManager.tabs.push(tab);
    ctx.TabManager.switchTo('t_pend');
    ctx.openSearch();
    ctx.__tq.advance(60);
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'search input focused before backend-ready');

    // Real claim path for a pending single tab (createTabSilent sends
    // requestId = tab.id; ipc.js claims it and wires the terminal).
    ctx.ptyBuffers.local_tab = 'alpha needle tab';
    ctx.__emit('pty-created', { tabId: 'local_tab', requestId: 't_pend' });
    assert.ok(tab.term && !tab.term.disposed, 'the real pty-created handler wired the tab');

    ctx.__tq.advance(600);
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'the search input retains focus after the late terminal arrives');
    assert.equal(tab.term.focused, false, 'the passively-arrived terminal must not steal focus');
});

test('(guard) late readiness still focuses the fresh terminal when no form field holds focus', () => {
    const ctx = loadVm();
    // Pane readiness, nothing focused: the fresh pane (the split's focus
    // target) is focused normally once its terminal exists.
    const tab = wiredTab(ctx, 't_async', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_async');
    ctx.__tq.advance(2000);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const fresh = ctx.getAllPanes(tab).find(p => !p.term);
    armFocusWindow(ctx);
    ctx.ptyBuffers.local_fresh = 'alpha needle fresh';
    ctx.__emit('pty-created', { tabId: 'local_fresh', requestId: fresh.requestId });
    ctx.__tq.advance(600);
    assert.equal(fresh.term.focused, true, 'the ready pane is focused when the user holds no form focus');

    // Tab readiness, nothing focused: the fresh tab terminal is focused too.
    const tab2 = { id: 't_pend2', name: 't_pend2', type: 'local', command: 'powershell.exe', args: [] };
    ctx.TabManager.tabs.push(tab2);
    ctx.TabManager.switchTo('t_pend2');
    armFocusWindow(ctx);
    ctx.ptyBuffers.local_tab2 = 'alpha needle two';
    ctx.__emit('pty-created', { tabId: 'local_tab2', requestId: 't_pend2' });
    ctx.__tq.advance(600);
    assert.equal(tab2.term.focused, true, 'the ready tab is focused when the user holds no form focus');
});

// ═══ 14c. Deferred close/collapse completions are PASSIVE ═══
// Round-2 counterexamples: the deferred removal (200ms after the user's
// close) schedules the collapse refocuses — _exitSplit for a two-pane split,
// _renderSplit + survivor timer when more panes remain. Those completions
// capture the search input as 'prior' focus AFTER the user's new intent and
// must not steal it. Both sequences are main's repros verbatim (no extra
// doSearch/focus calls).

test('two-pane collapse completion keeps the focused search input (RED: deferred close steals)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    ctx.TabManager._closePane('t_sp', p2.id); // p2 is the focused pane
    ctx.openSearch();
    ctx.__tq.advance(60);
    const before = ctx.document.activeElement === ctx.__searchInput;
    assert.equal(before, true, 'search input focused before the deferred removal');
    ctx.__tq.advance(600);
    assert.equal(tab.splitRoot, null, 'the split collapsed');
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'search input keeps focus after the collapse');
    assert.equal(p1.term.focused, false, 'the surviving terminal must not steal the dismissed-close completion');
});

test('multi-pane close completion keeps the focused search input (RED: deferred close steals)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    // Third pane, wired the way ipc.js wires it when its backend arrives.
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const fresh = ctx.getAllPanes(tab).find(p => !p.term);
    ctx.ptyBuffers.local_fresh = 'alpha needle fresh';
    ctx.__emit('pty-created', { tabId: 'local_fresh', requestId: fresh.requestId });
    ctx.__tq.advance(800); // settle the third pane's wiring
    ctx.TabManager._focusPane(tab, p2.id); // focus B and settle before closing it
    ctx.__tq.advance(100);
    ctx.TabManager._closePane('t_sp', p2.id);
    ctx.openSearch();
    ctx.__tq.advance(60);
    const before = ctx.document.activeElement === ctx.__searchInput;
    assert.equal(before, true, 'search input focused before the deferred removal');
    ctx.__tq.advance(600);
    assert.equal(ctx.getAllPanes(tab).length, 2, 'two-pane split remains');
    assert.equal(ctx.document.activeElement, ctx.__searchInput, 'search input keeps focus after the deferred survivor refocus');
    assert.equal(p1.term.focused, false, 'the survivor refocus must not steal');
});

// ═══ 15. Harness self-test: TimerQueue chronology (correction 2) ═══
// Main's counterexample: an outer timer at 100ms scheduling a nested +50ms
// timer, plus an independent timer at 200ms, advanced by 250ms. The queue
// must run each callback AT its scheduled time — outer@100, nested@150,
// later@200 — not stamp everything with the sweep target. Every focus and
// search regression above depends on this nested-timer chronology.

test('TimerQueue runs nested timers at their own deadlines in clock order', () => {
    const tq = new TimerQueue();
    const order = [];
    tq.setTimeout(() => { order.push(['outer', tq.now]); tq.setTimeout(() => { order.push(['nested', tq.now]); }, 50); }, 100);
    tq.setTimeout(() => { order.push(['later', tq.now]); }, 200);
    tq.advance(250);
    assert.deepEqual(order, [['outer', 100], ['nested', 150], ['later', 200]],
        'each callback observes the clock at its own deadline, nested before later');
    assert.equal(tq.now, 250, 'the sweep finishes at the target time');
    assert.equal(tq.timers.size, 0, 'nothing left pending');

    // A nested timer scheduled beyond the target stays pending (it must not
    // be dragged to the target or dropped).
    const tq2 = new TimerQueue();
    const seen = [];
    tq2.setTimeout(() => { tq2.setTimeout(() => { seen.push(tq2.now); }, 50); }, 100); // nested due at 150
    tq2.setTimeout(() => { tq2.setTimeout(() => { seen.push('late-nested'); }, 200); }, 120); // due at 320 > target
    tq2.advance(200);
    assert.deepEqual(seen, [150], 'due nested timers run; not-yet-due ones stay queued');
    assert.equal(tq2.timers.size, 1, 'the beyond-target nested timer is still pending');
});
