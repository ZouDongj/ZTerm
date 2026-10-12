// Predictive terminal re-grid at SFTP dock open/close (SFTP._predictiveTermResize
// + the switchTo fit gate). The dock's 180ms width transition suppresses the
// ResizeObserver fits (_sftpAnimating), so without the prediction the terminal
// re-gridded only in the post-animation settle (~540ms after the click) — the
// flicker this feature removes. These tests pin the geometry math:
//   delta = min(--sftp-width || 320, mainW - 240) + 8px gutter
//   cols' = cols ∓ round(delta / cellW)   (split panes absorb width*delta/rootW)
// and the suppression of the switchTo 10ms fit while the animation owns the
// wrap width. Everything runs against the REAL renderer stack through the
// shared VM seam; only the environment is faked (no real xterm, DOM or SSH).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';
import { wiredTab } from './helpers/renderer-vm.mjs';

// Terminal stub whose canvas CSS width always reads cols*cellW (the real
// canvas tracks exactly that after every resize, so cellW stays consistent
// across the predicted re-grid).
function fakeTerm(cols, rows, cellW) {
    const t = {
        cols, rows,
        resized: [],
        element: null,
        resize(c, r) { t.resized.push([c, r]); t.cols = c; t.rows = r; },
    };
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: t.cols * cellW, height: 100 }) };
    t.element = { querySelector: (sel) => (sel === 'canvas' ? canvas : null) };
    return t;
}

// Stage the main-area width and the CSSStyleDeclaration surface the
// prediction reads (the fake DOM styles are plain objects).
function stageMainArea(vm, width) {
    const main = vm.ctx.document.getElementById('main-area');
    main._cw = width;
    main.style.getPropertyValue = () => '';
    return main;
}

test('dock open resizes the active terminal to the predicted final grid up front', async () => {
    const vm = await loadSftpVm();
    stageMainArea(vm, 1076); // wrap animates 1076 → 748 (delta = 320 panel + 8 gutter)
    const term = fakeTerm(129, 40, 8);
    vm.ctx.TabManager.tabs[0].term = term; // tabA is the active tab

    vm.SFTP._setDockVisible(true);

    assert.deepEqual(term.resized, [[88, 40]], '129 cols − round(328/8) = 88 at animation start');
});

test('dock close resizes back to the wider grid up front', async () => {
    const vm = await loadSftpVm();
    stageMainArea(vm, 1076);
    const term = fakeTerm(129, 40, 8);
    vm.ctx.TabManager.tabs[0].term = term;

    vm.SFTP._setDockVisible(true);
    vm.SFTP._setDockVisible(false);

    assert.deepEqual(term.resized, [[88, 40], [129, 40]], 'the close restores 129 cols at animation start');
});

test('a terminal without a canvas (DOM fallback) is skipped silently', async () => {
    const vm = await loadSftpVm();
    stageMainArea(vm, 1076);
    const term = { cols: 100, rows: 24, element: null, resize() { throw new Error('must not resize'); } };
    vm.ctx.TabManager.tabs[0].term = term;

    vm.SFTP._setDockVisible(true); // must not throw

    assert.equal(term.cols, 100);
});

test('a settings tab is never predictively resized', async () => {
    const vm = await loadSftpVm();
    stageMainArea(vm, 1076);
    const term = fakeTerm(129, 40, 8);
    vm.ctx.TabManager.tabs.push({ id: 'tabSet', type: 'settings', term });
    vm.ctx.TabManager.activeId = 'tabSet';

    vm.SFTP._setDockVisible(true); // must not throw, must not resize

    assert.deepEqual(term.resized, []);
});

test('split panes absorb the dock delta in proportion to their widths', async () => {
    const vm = await loadSftpVm();
    const ctx = vm.ctx;
    const main = stageMainArea(vm, 1076);
    ctx.TabManager.tabs.length = 0;
    const p1 = { id: 'p_1', name: 'A', type: 'ssh', connected: true };
    const p2 = { id: 'p_2', name: 'B', type: 'ssh', connected: true };
    const tab = {
        id: 'tabS', name: 'S', type: 'ssh', connected: true,
        splitRoot: { orientation: 'h', children: [p1, p2], ratios: [0.75, 0.25] },
    };
    ctx.TabManager.tabs.push(tab);
    ctx.TabManager.activeId = 'tabS';
    const rootEl = ctx.document.createElement('div');
    rootEl.id = 'split_tabS';
    rootEl._cw = 1000;
    main.appendChild(rootEl);
    const paneEl = (id, w) => {
        const el = ctx.document.createElement('div');
        el.className = 'split-pane';
        el.setAttribute('data-pane', id);
        el._cw = w;
        rootEl.appendChild(el);
        return el;
    };
    paneEl('p_1', 750); // absorbs 750*328/1000 = 246px = 30.75 → 31 cols
    paneEl('p_2', 242); // absorbs 242*328/1000 ≈ 79.4px = 9.92 → 10 cols
    p1.term = fakeTerm(100, 40, 8);
    p2.term = fakeTerm(40, 40, 8);

    vm.SFTP._setDockVisible(true);

    assert.deepEqual(p1.term.resized, [[69, 40]], 'wide pane absorbs the proportional share');
    assert.deepEqual(p2.term.resized, [[30, 40]], 'narrow pane absorbs proportionally less');
});

test('the switchTo 10ms fit yields to a running dock animation', async () => {
    const vm = await loadSftpVm();
    const ctx = vm.ctx;
    wiredTab(ctx, 'tabL', 'bkL', null);
    const tab = ctx.TabManager.tabs.find(t => t.id === 'tabL');
    const fits = [];
    tab.fitAddon.fit = () => fits.push(1);
    // _fitWithScroll refuses zero-sized containers; the fake DOM defaults to
    // 0x0, so give the terminal's host a real size or the fit guard (not the
    // dock gate) would be what suppresses the call.
    const host = tab.term.element.parentElement;
    host._cw = 800; host._ch = 600;

    ctx._sftpAnimating = true;
    ctx.TabManager.switchTo('tabL');
    ctx.__tq.advance(10);
    assert.equal(fits.length, 0, 'mid-animation fit against the transitioning width is skipped');

    ctx._sftpAnimating = false;
    ctx.TabManager.switchTo('tabA');
    ctx.TabManager.switchTo('tabL');
    ctx.__tq.advance(10);
    assert.equal(fits.length, 1, 'the same fit runs once no dock animation owns the width');
});
