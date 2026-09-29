// Search-placed selections must never reach the system clipboard (autoCopy).
// A Ctrl+F find makes the vendored SearchAddon call terminal.select(), which
// fires onSelectionChange SYNCHRONOUSLY (verified in the vendored sources:
// select() → SelectionService.setSelection → _onSelectionChange.fire(),
// xterm.js; _selectResult → select() runs before _fireResults,
// addon-search.js). The two auto-copy handlers (wireTerminal /
// wireTerminalToPane) used to copy any non-empty selection, so with the
// default autoCopy every typed search character replaced the clipboard with
// the latest match, and a later right-click paste injected the search text
// into the shell.
//
// REAL in this VM: terminal.js (both copy handlers, the search owner/
// snapshot machinery, doSearch/searchNext), the vendored addon-search.js,
// tabs.js and friends via tests/helpers/renderer-vm.mjs. The only
// test-side modeling is SelTerm: the harness RealTerm does not emit
// onSelectionChange from select()/clearSelection(), while the real xterm
// fires it synchronously — SelTerm reproduces exactly that timing.
// _settingsConfig.smartCopy is disabled so the handler skips _stripSoftWrap
// (utils.js is not loaded in this VM); that setting is orthogonal to the
// copy/no-copy decision under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab, wiredSplitTab, RealTerm } from './helpers/renderer-vm.mjs';

const A_TEXT = 'alpha needle one\nplain line\nalpha needle two\nplain line\nalpha needle three';

// VM whose Terminal model fires onSelectionChange synchronously from
// select()/clearSelection(), plus a recording clipboard.
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

test('tab path: searching does not clobber the clipboard; manual selection still copies', () => {
    const { ctx, writes } = loadCopyVm();
    wiredTab(ctx, 't_a', 'local_a', A_TEXT);
    ctx.TabManager.switchTo('t_a');
    const term = ctx.TabManager.getActive().term;

    // The user copies something first (a genuine mouse-drag selection).
    term.select(0, 0, 5);
    assert.deepEqual(writes, ['alpha'], 'manual selection auto-copies');

    // The bug: with default autoCopy, every find overwrote the clipboard
    // with the current search match.
    ctx.openSearch();
    ctx.__tq.advance(60); // openSearch input-focus timer
    typeQuery(ctx, 'needle');
    assert.ok(term.hasSelection(), 'the find selected its first match');
    assert.deepEqual(writes, ['alpha'], 'the search match is not copied');
    ctx.searchNext();
    assert.deepEqual(writes, ['alpha'], 'navigation matches are not copied either');
    ctx.searchPrev();
    assert.deepEqual(writes, ['alpha'], 'backward navigation is search-owned too');

    // A manual selection at a DIFFERENT range than the search match is the
    // user's and must copy normally even while the search bar is open.
    term.select(0, 1, 5);
    assert.deepEqual(writes, ['alpha', 'plain'], 'manual selection after searching still copies');
});

test('pane path: searching a split pane does not clobber the clipboard', () => {
    const { ctx, writes } = loadCopyVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_s', 'local_1', A_TEXT, 'local_2', 'bravo line\nbravo needle here');
    ctx.TabManager.switchTo(tab.id);
    p1.focused = false; p2.focused = true;

    p2.term.select(0, 0, 5);
    assert.deepEqual(writes, ['bravo'], 'manual pane selection auto-copies');

    ctx.openSearch();
    ctx.__tq.advance(60);
    typeQuery(ctx, 'needle');
    assert.ok(p2.term.hasSelection(), 'the find selected the pane match');
    assert.deepEqual(writes, ['bravo'], 'the pane search match is not copied');

    // The other pane's manual selection is unaffected by p2's search state.
    p1.term.select(0, 0, 5);
    assert.deepEqual(writes, ['bravo', 'alpha'], 'manual selection on the sibling pane still copies');
});

test('closing the search leaves auto-copy fully functional', () => {
    const { ctx, writes } = loadCopyVm();
    wiredTab(ctx, 't_c', 'local_c', A_TEXT);
    ctx.TabManager.switchTo('t_c');
    const term = ctx.TabManager.getActive().term;

    ctx.openSearch();
    ctx.__tq.advance(60);
    typeQuery(ctx, 'needle');
    assert.deepEqual(writes, [], 'search placed no clipboard write');
    ctx.closeSearch();
    // The search-owned selection is dropped on close; a fresh manual
    // selection copies as usual (no stale suppression leaks out).
    term.select(0, 2, 5);
    assert.deepEqual(writes, ['alpha'], 'auto-copy works after the search is closed');
});
