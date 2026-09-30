// scroll-1: the search input ran doSearch on EVERY input event — each a
// synchronous full-buffer scan plus a rebuild of up to 1000 match decorations
// in the vendored addon, so typing a query letter by letter over a large
// scrollback blocked the renderer per keystroke. The fix rebinds the DOM
// input path (terminal.js takes over renderer.html's inline oninput) to a
// 200ms debounce; doSearch itself stays synchronous for its programmatic
// callers (Enter navigation, active-terminal refresh, the e2e contract), and
// a navigation key drops the pending scan so a just-navigated match is never
// re-found and bumped a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const TEXT = 'needle one\nplain\nneedle two\nplain\nneedle three';

function openSearchOn(ctx, id, backend, content) {
    wiredTab(ctx, id, backend, content);
    ctx.TabManager.switchTo(id);
    ctx.openSearch();
    ctx.__tq.advance(60); // openSearch input-focus timer
    return ctx.__searchInput;
}

function type(ctx, q) {
    ctx.__searchInput.value = q;
    ctx.__searchInput.dispatch('input'); // the real DOM input event path
}

test('the typed path scans once after the pause, not once per keystroke', () => {
    const ctx = loadVm();
    openSearchOn(ctx, 't_a', 'local_a', TEXT);

    type(ctx, 'n');
    type(ctx, 'ne');
    type(ctx, 'nee');
    assert.equal(ctx.__searchCount.textContent, '', 'no scan ran mid-typing');

    ctx.__tq.advance(199);
    assert.equal(ctx.__searchCount.textContent, '', 'still nothing before the 200ms pause');

    ctx.__tq.advance(1);
    assert.equal(ctx.__searchCount.textContent, '1/3', 'exactly one scan after the pause');
});

test('each new keystroke restarts the debounce window', () => {
    const ctx = loadVm();
    openSearchOn(ctx, 't_a', 'local_a', TEXT);

    type(ctx, 'nee');
    ctx.__tq.advance(150);
    type(ctx, 'need'); // typing continues: the window restarts
    ctx.__tq.advance(150);
    assert.equal(ctx.__searchCount.textContent, '', 'the first window expired unused');

    ctx.__tq.advance(50);
    assert.equal(ctx.__searchCount.textContent, '1/3', 'the scan fires on the final query only');
});

test('Enter navigation stays immediate and drops the pending typed scan', () => {
    const ctx = loadVm();
    openSearchOn(ctx, 't_a', 'local_a', TEXT);

    type(ctx, 'needle');
    ctx.onSearchKey({ key: 'Enter', preventDefault() {} }); // within the debounce window
    assert.equal(ctx.__searchCount.textContent, '1/3', 'navigation does not wait for the debounce');

    ctx.__tq.advance(300);
    assert.equal(ctx.__searchCount.textContent, '1/3',
        'the pending typed scan was cancelled (no second bump to 2/3)');
});

test('closeSearch cancels a pending scan; doSearch direct calls stay synchronous', () => {
    const ctx = loadVm();
    openSearchOn(ctx, 't_a', 'local_a', TEXT);

    type(ctx, 'needle');
    ctx.closeSearch();
    ctx.__tq.advance(300);
    assert.equal(ctx.__searchCount.textContent, '', 'a closed bar never runs the scan');

    ctx.openSearch();
    ctx.__tq.advance(60);
    ctx.__searchInput.value = 'needle';
    ctx.doSearch(); // programmatic contract (e2e, refresh paths): synchronous
    assert.equal(ctx.__searchCount.textContent, '1/3', 'direct doSearch runs immediately');
});
