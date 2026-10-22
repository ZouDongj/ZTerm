// Regressions around the search bar, Esc ownership and the modal layer stack:
//
// P2-06  Enter pressed within the 200ms typing debounce must search the NEW
//        term from the top — _navigateSearch bypassed the debounce and never
//        compared _searchLastQuery, so the find anchored on the previous
//        query's selection and skipped every match above it.
// P2-15  The color picker (not an .overlay — it stacks ABOVE the highlight
//        edit overlay) had no Esc handling and global shortcuts fired behind
//        it. It now registers in the shared modal layer stack (utils.js).
// P3-03  The search next/previous buttons took focus on click (no mousedown
//        preventDefault), so Esc stopped reaching the input and typed keys
//        fell out of the search bar.
// P3-04  The tab context menu closed only on document click; Esc left it
//        open. It now registers in the same modal layer stack.
// P3-14  With a maximized pane, the capture-phase Esc dispatcher restored the
//        pane even when the event target was the search input, swallowing the
//        search bar's own Esc (its inline keydown never ran).
//
// Fixture K drives the REAL shortcuts.js dispatcher + REAL utils.js stack +
// REAL settings.js color picker (page load order) over a fake DOM. Fixture R
// drives the shared renderer VM (REAL terminal.js + tabs.js + vendored
// addon-search.js) with the REAL utils.js/shortcut-utils.js/shortcuts.js
// injected in page order. Faked in both: only DOM, timers, ipc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mkEvt, mkDoc } from './helpers/manager-vm.mjs';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const src = f => fs.readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');

// ── Fixture K: Esc dispatcher + modal stack + color picker ──────────────────
function keyboardFixture(over = {}) {
    const listeners = new Map();
    const doc = mkDoc();
    // The manager seam's document swallows addEventListener; the capture-phase
    // dispatcher needs a real registry (same convention as
    // shortcut-esc-menu-close.test.mjs).
    doc.addEventListener = (type, fn, capture) => {
        const key = type + (capture ? ':c' : ':b');
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
    };
    doc.removeEventListener = () => {};
    const timers = new Map();
    let seq = 0;
    const ipc = { send() {}, once() {}, on() {}, removeListener() {}, invoke: () => new Promise(() => {}) };
    const ctx = {
        console,
        document: doc,
        addEventListener() {}, // utils.js hooks window error/unhandledrejection
        setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
        // utils.js destructures electron/xterm modules at load time.
        require: name => (name === 'electron' ? { ipcRenderer: ipc, webUtils: {} } : {}),
        ipcRenderer: ipc,
        TabManager: over.TabManager || { tabs: [], getActive: () => null },
        openSessionSelector: () => { ctx.__sessionSelectorCalls++; },
        _refocusActiveTerminal() {},
        _settingsConfig: {},
        __sessionSelectorCalls: 0,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // Page load order (renderer.html): utils < shortcut-utils < color-utils <
    // settings < shortcuts. settings.js's capture listener therefore runs
    // before the dispatcher, exactly as in the page.
    for (const f of ['utils.js', 'shortcut-utils.js', 'color-utils.js', 'settings.js', 'shortcuts.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    const keydown = (init = {}) => {
        const ev = mkEvt({ isComposing: false, keyCode: 0, ...init });
        (listeners.get('keydown:c') || []).slice().forEach(fn => fn(ev));
        return ev;
    };
    return { ctx, doc, keydown, picker: () => doc.getElementById('color-picker-overlay') };
}

// Esc from the terminal arrives with xterm's helper textarea as the target.
const TERM_TARGET = { tagName: 'TEXTAREA', classList: { contains: c => c === 'xterm-helper-textarea' } };
const SEARCH_INPUT_TARGET = { tagName: 'INPUT', id: 'search-input', classList: { contains: () => false } };
const CTRL_SHIFT_N = { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, target: TERM_TARGET };

test('P2-15: Esc closes the color picker; global shortcuts stay blocked while it is open', () => {
    const f = keyboardFixture();
    f.ctx.openColorPicker('#ff0000', () => {});
    assert.ok(f.picker().classList.contains('open'), 'staged: picker open');

    const blocked = f.keydown(CTRL_SHIFT_N);
    assert.equal(f.ctx.__sessionSelectorCalls, 0, 'Ctrl+Shift+N does not fire behind the picker');
    assert.equal(blocked.defaultPrevented, false, 'the key itself is left to the focus owner');

    const esc = f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.ok(esc.defaultPrevented && esc.propagationStopped, 'Esc is consumed by the layer');
    assert.ok(!f.picker().classList.contains('open'), 'picker closed');

    f.keydown(CTRL_SHIFT_N);
    assert.equal(f.ctx.__sessionSelectorCalls, 1, 'shortcuts work again once the picker is closed');
});

test('P2-15: picker stacked over the highlight edit overlay — Esc peels only the top layer', () => {
    const f = keyboardFixture();
    const edit = f.doc.createElement('div');
    edit.className = 'overlay open';
    edit.id = 'overlay-highlight-edit';
    f.doc.body.appendChild(edit);
    f.ctx.openColorPicker('#e06c75', () => {});

    const esc1 = f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.ok(esc1.defaultPrevented, 'first Esc consumed by the picker layer');
    assert.ok(!f.picker().classList.contains('open'), 'picker closed');
    assert.ok(edit.classList.contains('open'), 'the overlay underneath survives the first Esc');

    const esc2 = f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.ok(esc2.defaultPrevented, 'second Esc reaches the overlay branch');
    assert.ok(!edit.classList.contains('open'), 'overlay closed by the second Esc');
});

test('P2-15/P3-04: the shared layer stack peels strictly topmost-first (LIFO)', () => {
    const f = keyboardFixture();
    f.ctx.openColorPicker('#61afef', () => {});
    let menuClosed = 0;
    f.ctx.pushModalLayer('tab-context-menu', () => { menuClosed++; });

    f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.equal(menuClosed, 1, 'the later (topmost) layer closed first');
    assert.ok(f.picker().classList.contains('open'), 'the picker underneath is untouched');

    f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.ok(!f.picker().classList.contains('open'), 'second Esc closes the picker');
});

test('P2-15: closeAllOverlays also drains registered layers (no modal opens underneath them)', () => {
    const f = keyboardFixture();
    f.ctx.openColorPicker('#61afef', () => {});
    f.ctx.openOverlay('overlay-confirm');
    assert.ok(!f.picker().classList.contains('open'), 'picker closed by the overlay teardown');
    assert.ok(!f.ctx.hasModalLayer(), 'layer stack drained');
    assert.ok(f.doc.getElementById('overlay-confirm').classList.contains('open'), 'the new overlay opened');
});

test('P3-14: Esc targeting the search input does NOT restore the maximized pane', () => {
    const maximizeCalls = [];
    const tab = { id: 't_sp', splitRoot: {}, _maximizedPaneId: 'p2' };
    const f = keyboardFixture({
        TabManager: { tabs: [tab], getActive: () => tab, _maximizePane: (...a) => maximizeCalls.push(a) },
    });
    const ev = f.keydown({ key: 'Escape', target: SEARCH_INPUT_TARGET });
    assert.equal(maximizeCalls.length, 0, 'the pane is not restored while a form field owns Esc');
    assert.equal(ev.defaultPrevented, false, 'the keydown is left for the input handler (closeSearch)');
    assert.equal(ev.propagationStopped, false, 'capture does not stop the descent to the input');
});

test('P3-14 (control): Esc from the terminal still restores the maximized pane', () => {
    const maximizeCalls = [];
    const tab = { id: 't_sp', splitRoot: {}, _maximizedPaneId: 'p2' };
    const f = keyboardFixture({
        TabManager: { tabs: [tab], getActive: () => tab, _maximizePane: (...a) => maximizeCalls.push(a) },
    });
    const ev = f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.deepEqual(maximizeCalls, [['t_sp', 'p2']], 'restore fired with the maximized pane');
    assert.ok(ev.defaultPrevented && ev.propagationStopped, 'the Esc is consumed');
});

test('(control) nothing open, terminal focused: Esc still passes through to xterm', () => {
    const f = keyboardFixture();
    const ev = f.keydown({ key: 'Escape', target: TERM_TARGET });
    assert.equal(ev.defaultPrevented, false, 'plain Esc reaches the terminal (vim etc.)');
    assert.equal(ev.propagationStopped, false);
});

// ── Fixture R: real terminal.js/tabs.js/addon-search + injected stack ───────
// loadVm() already ran the terminal stack; the REAL utils.js (modal layer
// stack) and shortcut-utils.js + shortcuts.js (Esc dispatcher) are injected
// afterwards in page order. The require bag hands utils.js the SAME ipc/xterm
// objects the context already holds: its top-level `const { Terminal } = …`
// declarations are lexical globals that would otherwise shadow (and break)
// the context properties for code running after the injection.
function injectEscStack(ctx) {
    ctx.window.addEventListener = () => {};
    // utils.js's real _getAccentColor/_getAccentColorAlpha (function
    // declarations overwrite the harness stubs) read the accent through
    // getComputedStyle; the value matches the harness stub exactly.
    ctx.getComputedStyle = () => ({ getPropertyValue: () => '97,175,239' });
    const bag = {
        ipcRenderer: ctx.ipcRenderer, webUtils: {},
        Terminal: ctx.Terminal, FitAddon: ctx.FitAddon, WebglAddon: ctx.WebglAddon,
        SearchAddon: ctx.SearchAddon, ClipboardAddon: ctx.ClipboardAddon,
        WebLinksAddon: function () {},
    };
    const prevRequire = ctx.require;
    ctx.require = name => (name === 'electron' ? { ipcRenderer: ctx.ipcRenderer, webUtils: {} } : bag);
    vm.runInContext(src('utils.js'), ctx, { filename: 'utils.js' });
    ctx.require = prevRequire;
    // Keep the harness toast stub: utils.js's real one needs a #toast element.
    vm.runInContext('showToast = function () {};', ctx);
    vm.runInContext(src('shortcut-utils.js'), ctx, { filename: 'shortcut-utils.js' });
    const kd = ctx.__docListeners.get('keydown') || [];
    const before = kd.length;
    vm.runInContext(src('shortcuts.js'), ctx, { filename: 'shortcuts.js' });
    const fresh = (ctx.__docListeners.get('keydown') || []).slice(before);
    return (init = {}) => {
        const ev = {
            isComposing: false, keyCode: 0, defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...init,
        };
        fresh.forEach(fn => fn(ev));
        return ev;
    };
}

function type(ctx, q) {
    ctx.__searchInput.value = q;
    ctx.__searchInput.dispatch('input'); // the real DOM input event path
}

// bar matches lines 0 and 2; foo matches lines 1 and 3 — a stale foo anchor
// has a bar match BELOW it, so old code lands on the second bar match.
const TEXT_A = 'bar first\nfoo x\nbar second\nfoo y';
// bar matches lines 1 and 2; foo matches lines 0 and 3 — findPrevious from the
// stale foo anchor wraps to the LAST bar match.
const TEXT_B = 'foo x\nbar first\nbar second\nfoo y';

function openSearchedFoo(ctx, content) {
    wiredTab(ctx, 't_a', 'local_a', content);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    ctx.__tq.advance(60); // openSearch input-focus timer
    type(ctx, 'foo');
    ctx.__tq.advance(250); // the typed scan settled: doSearch ran for 'foo'
    assert.equal(ctx.__searchCount.textContent, '1/2', 'staged: first foo match selected');
}

test('P2-06: Enter before the debounce fires searches the NEW term from the top', () => {
    const ctx = loadVm();
    openSearchedFoo(ctx, TEXT_A);
    type(ctx, 'bar');
    ctx.__tq.advance(50); // still inside the 200ms debounce window
    ctx.onSearchKey({ key: 'Enter', preventDefault() {} });
    assert.equal(ctx.__searchCount.textContent, '1/2',
        'the first bar match is selected, not the one below the stale foo anchor');
    assert.equal(ctx.TabManager.getActive().term.getSelection(), 'bar');
    ctx.__tq.advance(300);
    assert.equal(ctx.__searchCount.textContent, '1/2', 'the cancelled typed scan never bumps the match');
});

test('P2-06: Shift+Enter after an edit also restarts from the top', () => {
    const ctx = loadVm();
    openSearchedFoo(ctx, TEXT_B);
    type(ctx, 'bar');
    ctx.__tq.advance(50);
    ctx.onSearchKey({ key: 'Enter', shiftKey: true, preventDefault() {} });
    assert.equal(ctx.__searchCount.textContent, '1/2',
        'an edited query starts at the first match even for Shift+Enter');
});

test('P2-06 (control): an unchanged query keeps Enter navigation advancing', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', TEXT_A);
    ctx.TabManager.switchTo('t_a');
    ctx.openSearch();
    ctx.__tq.advance(60);
    type(ctx, 'bar');
    ctx.__tq.advance(250); // debounce settled: bar searched, first match selected
    assert.equal(ctx.__searchCount.textContent, '1/2', 'staged: first bar match');
    ctx.onSearchKey({ key: 'Enter', preventDefault() {} });
    assert.equal(ctx.__searchCount.textContent, '2/2', 'Enter still advances to the next match');
});

test('P3-14: maximized pane — Esc in the search input closes the bar, keeps the pane maximized', () => {
    const ctx = loadVm();
    const esc = injectEscStack(ctx);
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', TEXT_A, 'local_2', TEXT_B);
    ctx.TabManager.switchTo('t_sp');
    ctx.TabManager._maximizePane('t_sp', p2.id);
    assert.equal(tab._maximizedPaneId, p2.id, 'staged: pane maximized');
    ctx.openSearch();
    ctx.__tq.advance(60); // focus lands in the search input

    const ev = esc({ key: 'Escape', target: ctx.__searchInput });
    assert.equal(ev.defaultPrevented, false, 'the capture dispatcher leaves Esc to the search input');
    assert.equal(ev.propagationStopped, false);
    assert.equal(tab._maximizedPaneId, p2.id, 'the pane is NOT restored');
    // Page contract: the input's inline onkeydown="onSearchKey(event)" runs
    // only because capture did not consume the key.
    ctx.onSearchKey(ev);
    assert.ok(!ctx.document.getElementById('search-bar').classList.contains('open'), 'the search bar closed');
});

test('P3-14 (control): maximized pane — Esc from the terminal restores the pane', () => {
    const ctx = loadVm();
    const esc = injectEscStack(ctx);
    const { tab, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', TEXT_A, 'local_2', TEXT_B);
    ctx.TabManager.switchTo('t_sp');
    ctx.TabManager._maximizePane('t_sp', p2.id);

    const ev = esc({
        key: 'Escape',
        target: { tagName: 'TEXTAREA', classList: { contains: c => c === 'xterm-helper-textarea' } },
    });
    assert.ok(ev.defaultPrevented && ev.propagationStopped, 'Esc consumed by the maximized branch');
    assert.equal(tab._maximizedPaneId, null, 'the pane is restored');
});

test('P3-04: Esc closes the tab context menu through the shared layer stack', () => {
    const ctx = loadVm();
    const esc = injectEscStack(ctx);
    wiredTab(ctx, 't_a', 'local_a', TEXT_A);
    ctx.TabManager.switchTo('t_a');
    ctx.TabManager.showTabContextMenu({ clientX: 10, clientY: 10, preventDefault() {} }, 't_a');
    assert.ok(ctx.document.getElementById('tab-context-menu'), 'staged: menu open');
    assert.ok(ctx.hasModalLayer(), 'the menu registered in the modal layer stack');

    const ev = esc({ key: 'Escape', target: ctx.document.body });
    assert.ok(ev.defaultPrevented && ev.propagationStopped, 'Esc consumed by the layer branch');
    assert.equal(ctx.document.getElementById('tab-context-menu'), null, 'menu removed');
    assert.ok(!ctx.hasModalLayer(), 'stack empty again');
});

test('P3-03: the search nav buttons never move focus off the input (mousedown preventDefault)', () => {
    const html = fs.readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');
    for (const onclick of ['searchPrev()', 'searchNext()']) {
        const tag = html.match(new RegExp(`<button[^>]*onclick="${onclick.replace(/[()]/g, '\\$&')}"[^>]*>`));
        assert.ok(tag, `the ${onclick} button exists`);
        assert.ok(tag[0].includes('onmousedown="event.preventDefault()"'),
            `${onclick} prevents the default mousedown focus move, so focus stays in the input`);
    }
});

// P3-03 behavioral counterpart of the attribute pin above: build the buttons
// from the REAL page markup (inline attribute handlers compiled in the VM, as
// the page's parser compiles them), then run a full press — mousedown plus
// the platform's default focus move (suppressed only when the handler
// prevents it), then click — and assert focus NEVER leaves the search input
// while the click still navigates.
function realNavButton(ctx, html, onclickCode) {
    const tag = html.match(new RegExp(`<button[^>]*onclick="${onclickCode.replace(/[()]/g, '\\$&')}"[^>]*>`));
    assert.ok(tag, `the ${onclickCode} button exists in renderer.html`);
    const attr = (name) => {
        const m = tag[0].match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : null;
    };
    const btn = ctx.document.createElement('button');
    const md = attr('onmousedown');
    if (md) btn.addEventListener('mousedown', vm.runInContext(`(function (event) { ${md} })`, ctx));
    btn.addEventListener('click', vm.runInContext(`(function (event) { ${attr('onclick')} })`, ctx));
    ctx.document.getElementById('search-bar').appendChild(btn);
    return btn;
}

// Full press sequence with the platform default action modeled: mousedown on
// a button moves focus to it unless a handler prevents the default.
function pressWithPlatformDefault(btn) {
    const md = mkEvt();
    btn.dispatch('mousedown', md);
    if (!md.defaultPrevented) btn.focus();
    btn.dispatch('click', mkEvt());
    return md;
}

test('P3-03 (behavior): clicking a nav button keeps focus in the search input and still navigates', () => {
    const ctx = loadVm();
    const html = fs.readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');
    openSearchedFoo(ctx, TEXT_A);
    const input = ctx.__searchInput;
    assert.equal(ctx.document.activeElement, input, 'staged: focus in the search input');

    const next = realNavButton(ctx, html, 'searchNext()');
    const md = pressWithPlatformDefault(next);
    assert.equal(md.defaultPrevented, true, 'the guard from the page markup ran');
    assert.equal(ctx.document.activeElement, input,
        'focus stayed in the search input — Esc and typed keys keep reaching it after the click');
    assert.equal(ctx.__searchCount.textContent, '2/2', 'the click still navigated to the next match');

    const prev = realNavButton(ctx, html, 'searchPrev()');
    pressWithPlatformDefault(prev);
    assert.equal(ctx.document.activeElement, input, 'searchPrev() click also keeps focus');
    assert.equal(ctx.__searchCount.textContent, '1/2', 'navigation moved back');
});

test('P3-03 (control): without the guard the platform default moves focus to the button', () => {
    const ctx = loadVm();
    openSearchedFoo(ctx, TEXT_A);
    const input = ctx.__searchInput;
    assert.equal(ctx.document.activeElement, input, 'staged: focus in the search input');

    const bare = ctx.document.createElement('button'); // no onmousedown guard
    ctx.document.getElementById('search-bar').appendChild(bare);
    pressWithPlatformDefault(bare);
    assert.equal(ctx.document.activeElement, bare,
        'the harness models the platform mousedown focus move — the behavioral pin above is not vacuous');
});
