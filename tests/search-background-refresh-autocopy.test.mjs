// Background search-refresh re-selections must never reach the clipboard.
//
// The vendored SearchAddon re-runs finds on its own: activate() registers
// onWriteParsed/onResize → _updateMatches, which 200ms later calls
// findPrevious(query, {incremental}) (src/vendor/addon-search.js). That find
// re-selects a match at coordinates that may have MOVED since the last
// explicit find (resize reflow, scrollback trim), and terminal.select() fires
// onSelectionChange BEFORE the addon's onDidChangeResults refreshes the
// search-selection snapshot — so at event time the snapshot still describes
// the previous position, _isSearchOwnedSelection misses, and the auto-copy
// handler silently overwrites the system clipboard with the match text.
//
// The fix pins the event order instead of guessing coordinates: the placing
// window (_searchPlacingSelection) is opened around the addon's find methods
// themselves in _wireSearchAddon, so an addon-placed selection is search-owned
// on every path, explicit or background. User-made selections keep copying.
//
// REAL here: terminal.js (both auto-copy handlers, doSearch/searchNext, the
// addon wiring), the vendored addon-search.js and the real background-refresh
// timer path (resize trigger → 200ms findPrevious), tabs.js and friends via
// tests/helpers/renderer-vm.mjs. Modeled is only the environment: the shared
// VM harness plus the SelTerm extension of search-selection-autocopy.test.mjs
// — RealTerm does not emit onSelectionChange from select()/
// clearSelection(), while the real xterm fires it synchronously; SelTerm
// reproduces exactly that timing. The scrollback trim is staged by hand
// (splice the oldest line + shift the model's selection row, what xterm's
// marker shift does natively) and labeled at the use site, like every other
// harness staging in this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab, RealTerm } from './helpers/renderer-vm.mjs';

const A_TEXT = 'scroll fill line\nalpha needle one\nplain line\nalpha needle two';
const B_TEXT = 'scroll fill line\nbravo needle here\nplain line\nbravo needle again';

// VM whose Terminal model fires onSelectionChange synchronously from
// select()/clearSelection(), plus a recording clipboard (same model as
// search-selection-autocopy.test.mjs).
function loadCopyVm() {
    const ctx = loadVm();
    ctx.Terminal = class extends RealTerm {
        constructor() {
            super();
            this._selSubs = [];
        }
        onSelectionChange(cb) { this._selSubs.push(cb); return { dispose() {} }; }
        select(col, row, len) { super.select(col, row, len); this._selSubs.slice().forEach(cb => cb()); }
        clearSelection() { super.clearSelection(); this._selSubs.slice().forEach(cb => cb()); }
    };
    ctx._settingsConfig = { smartCopy: false };
    const clip = ctx.require('electron').clipboard;
    const writes = [];
    clip.writeText = (t) => writes.push(t);
    clip.write = (o) => writes.push(o && o.text);
    return { ctx, writes };
}

function typeQuery(ctx, q) {
    ctx.__searchInput.value = q;
    ctx.doSearch();
}

// Stage what a scrollback trim does to the buffer and the selection: the
// oldest line is discarded and xterm shifts the selection markers with the
// content (the selected row index decreases by the trimmed amount).
function stageTrim(term, lines) {
    term.buffer.active.lines.splice(0, lines);
    if (term._selection) term._selection.row -= lines;
}

test('tab path: trim + addon background refresh does not clobber the clipboard', () => {
    const { ctx, writes } = loadCopyVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    const term = ctx.TabManager.getActive().term;

    // Baseline: a genuine user selection auto-copies.
    term.select(0, 0, 6);
    assert.deepEqual(writes, ['scroll'], 'manual selection auto-copies');

    ctx.openSearch();
    ctx.__tq.advance(60); // openSearch input-focus timer
    typeQuery(ctx, 'needle');
    assert.ok(term.hasSelection(), 'the find selected its first match (row 1)');
    assert.deepEqual(writes, ['scroll'], 'explicit find does not copy');

    // Scrollback trim moves the match up one row, then the addon's own
    // refresh runs: resize is one of its triggers (activate registers
    // onResize → _updateMatches) and also drops its line cache, so the
    // 200ms findPrevious re-selects the match at the SHIFTED row.
    stageTrim(term, 1);
    term.resize(80, 25);
    ctx.__tq.advance(300); // 200ms background refresh + resize debounce

    // The refresh did its real job: the (moved) match is still selected.
    assert.match(term.getSelection(), /needle/, 'background refresh re-selected the match');
    assert.deepEqual(term.getSelectionPosition(), { start: { x: 6, y: 0 }, end: { x: 12, y: 0 } },
        'the re-selection landed on the shifted row 0');
    // The bug: that re-selection reached the clipboard.
    assert.deepEqual(writes, ['scroll'], 'background re-selection is not copied');

    // The snapshot followed the refresh: a later manual selection still
    // copies normally (row 1 = 'plain line' after the trim), and the search
    // still navigates without copying.
    term.select(0, 1, 5);
    assert.deepEqual(writes, ['scroll', 'plain'], 'manual selection after the refresh still copies');
    ctx.searchNext();
    assert.deepEqual(writes, ['scroll', 'plain'], 'navigation after the refresh still does not copy');
});

test('event order pin: the selection event fires inside the search-placing window', () => {
    const { ctx, writes } = loadCopyVm();
    wiredTab(ctx, 't_o', 'local_o', A_TEXT);
    ctx.TabManager.switchTo('t_o');
    const term = ctx.TabManager.getActive().term;

    // Observe what the guard answers AT EVENT TIME, on every selection event:
    // the auto-copy handler (wired first) runs before this recorder, so a
    // false here means the copy handler saw a non-search-owned selection.
    const observed = [];
    term.onSelectionChange(() => observed.push(ctx._isSearchOwnedSelection(term)));

    term.select(0, 0, 6); // user selection: search-owned=false is correct here
    assert.deepEqual(observed.slice(), [false], 'a manual selection is not search-owned');

    ctx.openSearch();
    ctx.__tq.advance(60);
    typeQuery(ctx, 'needle');
    assert.deepEqual(writes, ['scroll'], 'no copy during the explicit find');
    // The explicit find's select() must already be inside the placing window.
    assert.ok(observed.slice(1).length > 0 && observed.slice(1).every(v => v === true),
        'explicit find events are search-owned at event time');

    stageTrim(term, 1);
    term.resize(80, 25);
    ctx.__tq.advance(300);
    // The pinned order: select() during the background findPrevious fires
    // onSelectionChange BEFORE onDidChangeResults refreshes the snapshot, so
    // ONLY the placing window can answer true here. Old code: false + copy.
    assert.ok(observed.every((v, i) => i === 0 ? v === false : v === true),
        'every selection event placed by a find (explicit or background) is search-owned at event time');
    assert.deepEqual(writes, ['scroll'], 'nothing but the manual baseline reached the clipboard');
});

test('pane path: trim + background refresh on a split pane does not clobber the clipboard', () => {
    const { ctx, writes } = loadCopyVm();
    const { tab, p2 } = wiredSplitTab(ctx, 't_s', 'local_1', A_TEXT, 'local_2', B_TEXT);
    ctx.TabManager.switchTo(tab.id);
    const panes = ctx.getAllPanes(tab);
    panes[0].focused = false; panes[1].focused = true;

    ctx.openSearch();
    ctx.__tq.advance(60);
    typeQuery(ctx, 'needle');
    assert.ok(p2.term.hasSelection(), 'the pane find selected its first match');
    assert.deepEqual(writes, [], 'pane search match is not copied');

    stageTrim(p2.term, 1);
    p2.term.resize(80, 25);
    ctx.__tq.advance(300);
    assert.match(p2.term.getSelection(), /needle/, 'pane background refresh re-selected its match');
    assert.deepEqual(writes, [], 'pane background re-selection is not copied');
    p2.term.select(0, 1, 5); // row 1 = 'plain line' after the trim
    assert.deepEqual(writes, ['plain'], 'manual pane selection still copies');
});
