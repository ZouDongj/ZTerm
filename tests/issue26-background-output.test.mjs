// Issue #26: background-output unread indicator on the tab status dot.
//
// Contract under test (all driven through the REAL ipc.js pty-output router
// and the REAL tabs.js state/render paths in the shared renderer VM):
// - Parsed display-text changes on a NON-active tab set a runtime unread flag
//   (`tab._bgUnread`); same-text style/cursor redraws do not. In a split, ANY
//   pane's output aggregates to the owning tab; ACTIVE tab panes never mark.
// - The FIRST transition patches the live `.tab-icon` class in place;
//   streaming chunks after it are a plain flag read, so continuous background
//   output NEVER triggers a full strip render (render() rebuilds every strip
//   node — that is the high-frequency redraw issue #26 forbids).
// - switchTo the tab consumes the flag and restores the idle dot in place.
// - Later full renders regenerate the unread tint from the flag.
// - The tint rides ONLY the idle connected dot: connecting / error /
//   disconnected dots keep their own paint (priority), and showStatusDot=false
//   keeps the dot hidden (no substitute indicator).
// - The flag is runtime-only: saveConfig (main.js) persists a fixed field
//   whitelist (name/type/command/args/content/customName/splitRoot/ssh
//   identity), so `_bgUnread` never reaches disk — structural, no test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const source = f => readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8');
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const settled = term => write(term, '');

function installParser(owner, cols = 32, rows = 4) {
    owner.term?.dispose();
    const term = new globalThis.TabbyXterm.Terminal({ cols, rows, allowProposedApi: true });
    owner.term = term;
    return term;
}

function visibleText(term) {
    const buffer = term.buffer.active;
    return Array.from({ length: term.rows }, (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true) || '').join('\n');
}

// Stage what the pty-output router needs beyond the harness defaults: the
// real restore-content.js (appendContentTail) and a passthrough highlight
// (same convention as tests/session-migration-persistence.test.mjs).
function outputFixture(ctx) {
    vm.runInContext(source('restore-content.js'), ctx);
    vm.runInContext(source('ink-caret-observer.js'), ctx);
    ctx.applyHighlight = data => data;
}

function useHeadlessTerminalFactory(ctx) {
    ctx.FitAddon = class { activate() {} fit() {} dispose() {} };
    ctx.ClipboardAddon = class { activate() {} dispose() {} };
    ctx._createWebLinksAddon = () => ({ activate() {}, dispose() {} });
    ctx.Terminal = class extends globalThis.TabbyXterm.Terminal {
        open(element) { this._core.element = element; }
    };
}

// The harness paints tab markup as innerHTML text only; real DOM parses it
// into children. Materialize the status-dot span exactly where render() puts
// it (classes mirror the markup just painted) so in-place class patches can
// be observed like the browser would.
function stageDots(ctx) {
    for (const t of ctx.TabManager.tabs) {
        const el = ctx.document.querySelector(`.tab[data-tab="${t.id}"]`);
        if (!el || el.querySelector('.tab-icon')) continue;
        const m = /class="tab-icon ([a-z-]+)"/.exec(el.innerHTML || '');
        const dot = ctx.document.createElement('span');
        dot.className = 'tab-icon ' + (m ? m[1] : 'disconnected');
        el.appendChild(dot);
    }
}

// Count full strip renders (what streaming background output must never do).
function countRenders(ctx) {
    const real = ctx.TabManager.render.bind(ctx.TabManager);
    let n = 0;
    ctx.TabManager.render = () => { n++; return real(); };
    return () => n;
}

const dotOf = (ctx, id) => ctx.document.querySelector(`.tab[data-tab="${id}"]`).querySelector('.tab-icon');
const markupOf = (ctx, id) => ctx.document.querySelector(`.tab[data-tab="${id}"]`).innerHTML;

test('background pty-output marks the tab unread and patches only the live dot class', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    const active = wiredTab(ctx, 't_active', 'local_active', '');
    const bg = wiredTab(ctx, 't_bg', 'local_bg', '');
    ctx.TabManager.activeId = active.id;
    ctx.TabManager.render();
    stageDots(ctx);
    const activeEl = ctx.document.querySelector('.tab[data-tab="t_active"]');
    const bgEl = ctx.document.querySelector('.tab[data-tab="t_bg"]');
    const renders = countRenders(ctx);

    ctx.__emit('pty-output', { tabId: 'local_bg', data: '' });
    assert.equal(bg._bgUnread, undefined, 'empty data never marks');

    ctx.__emit('pty-output', { tabId: 'local_bg', data: 'background output\r\n' });

    assert.equal(bg._bgUnread, true, 'runtime unread flag is set');
    assert.equal(dotOf(ctx, 't_bg').className, 'tab-icon bg-unread', 'live dot recolored in place');
    assert.equal(dotOf(ctx, 't_active').className, 'tab-icon connected', 'active tab dot untouched');
    assert.equal(ctx.document.querySelector('.tab[data-tab="t_bg"]'), bgEl, 'background strip node not rebuilt');
    assert.equal(ctx.document.querySelector('.tab[data-tab="t_active"]'), activeEl, 'active strip node not rebuilt');
    assert.equal(renders(), 0, 'the first mark runs no full render');
});

test('continuous background output keeps the strip cold: zero full renders', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_stream', 'local_s', '');
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    stageDots(ctx);
    const bgEl = ctx.document.querySelector('.tab[data-tab="t_stream"]');
    const renders = countRenders(ctx);

    for (let i = 0; i < 60; i++) {
        ctx.__emit('pty-output', { tabId: 'local_s', data: 'stream chunk ' + i + '\r\n' });
    }

    assert.equal(renders(), 0, 'streaming output never calls render()');
    assert.equal(bg._bgUnread, true, 'flag set (once) by the stream');
    assert.equal(dotOf(ctx, 't_stream').className, 'tab-icon bg-unread');
    assert.equal(ctx.document.querySelector('.tab[data-tab="t_stream"]'), bgEl, 'node identity preserved across the whole stream');
});

test('switching to the unread tab clears the marker and restores the dot in place', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_bg', 'local_bg', '');
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    stageDots(ctx);
    ctx.__emit('pty-output', { tabId: 'local_bg', data: 'unread\r\n' });
    const bgEl = ctx.document.querySelector('.tab[data-tab="t_bg"]');
    const renders = countRenders(ctx);

    ctx.TabManager.switchTo(bg.id);

    assert.equal(bg._bgUnread, false, 'flag consumed by the switch');
    assert.equal(dotOf(ctx, 't_bg').className, 'tab-icon connected', 'idle dot restored in place');
    assert.equal(ctx.document.querySelector('.tab[data-tab="t_bg"]'), bgEl, 'the switch did not rebuild the strip node');
    assert.equal(renders(), 0, 'the clear runs no full render either');

    // Output on the now-active tab never re-marks.
    ctx.__emit('pty-output', { tabId: 'local_bg', data: 'visible now\r\n' });
    assert.equal(bg._bgUnread, false);
    assert.equal(dotOf(ctx, 't_bg').className, 'tab-icon connected');
});

test('later strip renders restore the unread tint from the runtime flag', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_bg', 'local_bg', '');
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    ctx.__emit('pty-output', { tabId: 'local_bg', data: 'unread\r\n' });
    assert.equal(bg._bgUnread, true);

    // What ssh lifecycle events do to any tab at any time: a full render.
    ctx.TabManager.render();
    const rebuilt = ctx.document.querySelector('.tab[data-tab="t_bg"]');
    assert.match(rebuilt.innerHTML, /class="tab-icon bg-unread"/, 'rebuild repaints the tint from the flag');

    ctx.TabManager.switchTo(bg.id);
    assert.equal(bg._bgUnread, false, 'switch consumed the flag');
    ctx.TabManager.render();
    assert.match(markupOf(ctx, 't_bg'), /class="tab-icon connected"/);
    assert.doesNotMatch(markupOf(ctx, 't_bg'), /bg-unread/);
});

test('split: output from any pane of a background split tab aggregates to the tab dot', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'sp_1', '', 'sp_2', '');
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    stageDots(ctx);
    const spEl = ctx.document.querySelector('.tab[data-tab="t_sp"]');
    const renders = countRenders(ctx);

    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'second pane background output\r\n' });
    assert.equal(tab._bgUnread, true, 'a pane marks the OWNING tab');
    assert.equal(dotOf(ctx, 't_sp').className, 'tab-icon bg-unread');

    ctx.__emit('pty-output', { tabId: 'sp_1', data: 'first pane background output\r\n' });
    assert.equal(renders(), 0, 'the sibling pane adds no render');

    ctx.TabManager.switchTo(tab.id);
    assert.equal(tab._bgUnread, false);
    assert.equal(dotOf(ctx, 't_sp').className, 'tab-icon connected', 'aggregated connected dot restored');
});

test('active split tab: output on a non-focused pane never marks the tab', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_plain', 'local_p', '');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'sp_1', '', 'sp_2', '');
    p1.focused = true;
    p2.focused = false;
    ctx.TabManager.activeId = tab.id;
    ctx.TabManager.render();
    stageDots(ctx);
    const renders = countRenders(ctx);

    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'non-focused pane of the ACTIVE tab\r\n' });

    assert.ok(!tab._bgUnread, 'the active tab never marks, focused pane or not');
    assert.equal(dotOf(ctx, 't_sp').className, 'tab-icon connected');
    assert.equal(renders(), 0);
});

test('connecting, error and disconnected dots keep priority over the unread tint', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    // Staged the way the ipc.js lifecycle transitions land these flags.
    const conn = wiredTab(ctx, 't_conn', 'ssh_c', '', { type: 'ssh', host: 'h', connected: false, _sshConnecting: true });
    const err = wiredTab(ctx, 't_err', 'ssh_e', '', { type: 'ssh', host: 'h', connected: false, _sshErrored: true });
    const dead = wiredTab(ctx, 't_dead', 'ssh_d', '', { type: 'ssh', host: 'h', connected: true });
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    stageDots(ctx);
    const renders = countRenders(ctx);

    ctx.__emit('pty-output', { tabId: 'ssh_c', data: 'late bytes\r\n' });
    ctx.__emit('pty-output', { tabId: 'ssh_e', data: 'late bytes\r\n' });
    ctx.__emit('pty-output', { tabId: 'ssh_d', data: 'output then drop\r\n' });

    // The runtime flag tracks the output on all three, but the LIVE dot only
    // changes when the idle state it may replace is 'connected'.
    assert.equal(conn._bgUnread, true);
    assert.equal(err._bgUnread, true);
    assert.equal(dead._bgUnread, true);
    assert.equal(dotOf(ctx, 't_conn').className, 'tab-icon connecting', 'busy dot untouched');
    assert.equal(dotOf(ctx, 't_err').className, 'tab-icon error', 'error dot untouched');
    assert.equal(dotOf(ctx, 't_dead').className, 'tab-icon bg-unread', 'connected dot tinted');

    // The session drops: the ssh-disconnected lifecycle render repaints the
    // aggregated gray dot — the unread tint must not survive it.
    ctx.__emit('ssh-disconnected', { tabId: 'ssh_d', reason: 'synthetic drop' });
    assert.ok(renders() >= 1, 'the lifecycle path rendered');
    assert.match(markupOf(ctx, 't_dead'), /class="tab-icon disconnected"/, 'disconnected wins over the tint');
    assert.doesNotMatch(markupOf(ctx, 't_dead'), /bg-unread/);
});

test('showStatusDot=false: no dot is painted and the marker stays inert', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    ctx._settingsConfig.showStatusDot = false;
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_bg', 'local_b', '');
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    assert.doesNotMatch(markupOf(ctx, 't_bg'), /tab-icon/, 'no dot in the markup');

    ctx.__emit('pty-output', { tabId: 'local_b', data: 'background\r\n' });
    assert.equal(bg._bgUnread, true, 'runtime state still tracked');
    assert.doesNotMatch(markupOf(ctx, 't_bg'), /tab-icon/, 'marking creates no dot and throws nothing');

    // Re-enabling the dot paints the tint from the still-live flag.
    ctx._settingsConfig.showStatusDot = true;
    ctx.TabManager.render();
    assert.match(markupOf(ctx, 't_bg'), /class="tab-icon bg-unread"/);
});

test('focus-loss redraw with identical styled text does not mark the background tab unread', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_focus', 'ssh_focus', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, '\x1b[31mAgent ready\x1b[0m');
    const before = visibleText(term);

    // ESC[O is the focus-loss report delivered to the application; this is its
    // same-text redraw coming back through the real backend-output route.
    ctx.__emit('pty-output', { tabId: 'ssh_focus',
        data: '\x1b[?25l\x1b[1;1H\x1b[31mAgent ready\x1b[0m\x1b[?25h' });
    await settled(term);

    assert.equal(visibleText(term), before, 'the fixture is a byte-different but text-identical redraw');
    assert.equal(bg._bgUnread, undefined, 'control bytes and identical printable text are not new output');
});

test('buffer switches compare visible text without importing the old buffer scroll offset', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_buffers', 'ssh_buffers', '', { type: 'ssh' });
    const term = installParser(bg, 16, 3);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'same\r\nsame\r\nsame\r\nsame');
    const before = visibleText(term);
    assert.equal(term.buffer.active.baseY, 1, 'the normal buffer has a non-zero scroll offset');

    ctx.__emit('pty-output', { tabId: 'ssh_buffers',
        data: '\x1b[?1049h\x1b[1;1Hsame\x1b[2;1Hsame\x1b[3;1Hsame' });
    await settled(term);
    assert.equal(term.buffer.active.type, 'alternate');
    assert.equal(visibleText(term), before);
    assert.equal(bg._bgUnread, undefined, 'entering an identical-text alternate buffer is not new text');

    ctx.__emit('pty-output', { tabId: 'ssh_buffers', data: '\x1b[?1049l' });
    await settled(term);
    assert.equal(term.buffer.active.type, 'normal');
    assert.equal(visibleText(term), before);
    assert.equal(bg._bgUnread, undefined, 'returning to identical normal text is not new text either');
});

test('same-buffer output advancing the scrollback marks even when repeated lines look identical', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_scroll', 'ssh_scroll', '', { type: 'ssh' });
    const term = installParser(bg, 16, 3);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'same\r\nsame\r\nsame\r\nsame');
    const before = visibleText(term);
    const baseY = term.buffer.active.baseY;

    ctx.__emit('pty-output', { tabId: 'ssh_scroll', data: '\r\nsame' });
    await settled(term);

    assert.equal(visibleText(term), before, 'the visible repeated lines are unchanged');
    assert.ok(term.buffer.active.baseY > baseY, 'new text advanced the normal buffer');
    assert.equal(bg._bgUnread, true, 'the appended line is real output despite the repeated screen text');
});

test('style, cursor and focus-mode controls without text changes never mark', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_controls', 'ssh_controls', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'Agent idle');

    for (const data of [
        '\x1b[31;1m\x1b[0m',
        '\x1b[1;1H\x1b[32mAgent idle\x1b[0m',
        '\x1b[?25l\x1b[3;4H\x1b[?25h',
        '\x1b[?1004h\x1b[?1004l',
    ]) {
        ctx.__emit('pty-output', { tabId: 'ssh_controls', data });
        await settled(term);
        assert.equal(bg._bgUnread, undefined, JSON.stringify(data));
    }
});

for (const [name, initial, update] of [
    ['new text', 'Agent idle', '\r\nAgent completed'],
    ['spinner', 'Working |', '\x1b[1;9H/'],
]) {
    test(`real parser: ${name} marks a background tab without a timing grace`, async t => {
        const ctx = loadVm();
        outputFixture(ctx);
        wiredTab(ctx, 't_a', 'local_a', '');
        const bg = wiredTab(ctx, 't_text', 'ssh_text', '', { type: 'ssh' });
        const term = installParser(bg);
        t.after(() => term.dispose());
        ctx.TabManager.activeId = 't_a';
        await write(term, initial);

        ctx.__emit('pty-output', { tabId: 'ssh_text', data: update });
        await settled(term);

        assert.equal(bg._bgUnread, true);
    });
}

test('real parser split: identical pane redraw is silent and a spinner update aggregates to its tab', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p2 } = wiredSplitTab(ctx, 't_split_parser', 'sp_idle', '', 'sp_agent', '');
    Object.assign(p2, { type: 'ssh' });
    const term = installParser(p2);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, '\x1b[32mAgent |\x1b[0m');

    ctx.__emit('pty-output', { tabId: 'sp_agent',
        data: '\x1b[?25l\x1b[1;1H\x1b[32mAgent |\x1b[0m\x1b[?25h' });
    await settled(term);
    assert.ok(!tab._bgUnread);

    ctx.__emit('pty-output', { tabId: 'sp_agent', data: '\x1b[1;7H/' });
    await settled(term);
    assert.equal(term.buffer.active.getLine(0).translateToString(true), 'Agent /');
    assert.equal(tab._bgUnread, true);
});

test('activating a tab before its asynchronous parse callback consumes the output without a late unread mark', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    ctx._attachWebglRenderer = () => {};
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_async', 'ssh_async', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'Agent running');

    ctx.__emit('pty-output', { tabId: 'ssh_async', data: '\r\nAgent completed' });
    assert.equal(bg._bgUnread, undefined, 'the real parser has not completed synchronously');
    ctx.TabManager.switchTo(bg.id);
    await settled(term);
    assert.ok(!bg._bgUnread, 'the parse callback re-checks the active tab');

    ctx.TabManager.activeId = 't_a';
    assert.ok(!bg._bgUnread, 'leaving again does not resurrect the consumed output');
});

test('a parsed output callback follows the same terminal to its current tab owner', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_before_move', 'ssh_moving', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'Agent running');

    ctx.__emit('pty-output', { tabId: 'ssh_moving', data: '\r\nAgent completed' });
    const moved = { ...bg, id: 't_after_move', term };
    ctx.TabManager.tabs.splice(ctx.TabManager.tabs.indexOf(bg), 1, moved);
    await settled(term);

    assert.equal(moved._bgUnread, true, 'terminal identity, not the stale wrapper, owns the callback');
});

test('real parser continuous output still performs zero full strip renders', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_parser_stream', 'ssh_stream', '', { type: 'ssh' });
    const term = installParser(bg, 40, 6);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    ctx.TabManager.render();
    stageDots(ctx);
    const renders = countRenders(ctx);

    for (let i = 0; i < 60; i++) {
        ctx.__emit('pty-output', { tabId: 'ssh_stream', data: 'completed chunk ' + i + '\r\n' });
    }
    await settled(term);

    assert.equal(bg._bgUnread, true);
    assert.equal(renders(), 0, 'asynchronous parse callbacks never trigger full strip renders');
    assert.equal(dotOf(ctx, 't_parser_stream').className, 'tab-icon bg-unread');
});


for (const [name, data, expected] of [
    ['control-only', '\x1b[31m\x1b[?25l\x1b[1;1H\x1b[?25h', undefined],
    ['text-bearing', '\x1b[31mAgent completed\x1b[0m', true],
]) {
    test(`pending ${name} output waits for the real terminal replay before marking`, async t => {
        const ctx = loadVm();
        outputFixture(ctx);
        wiredTab(ctx, 't_a', 'local_a', '');
        useHeadlessTerminalFactory(ctx);
        const bg = { id: 't_pending_' + name, name: name, type: 'ssh', connected: true,
            tabId: 'ssh_pending_' + name, term: null };
        ctx.TabManager.tabs.push(bg);
        ctx.TabManager.activeId = 't_a';

        ctx.__emit('pty-output', { tabId: bg.tabId, data });
        const markedBeforeReplay = bg._bgUnread;
        ctx.wireTerminal(bg, bg.tabId);
        const term = bg.term;
        t.after(() => term.dispose());
        await settled(term);

        assert.equal(markedBeforeReplay, undefined, 'raw pending bytes never mark');
        assert.equal(bg._bgUnread, expected, 'the replayed parse result owns the decision');
    });
}

test('extracting the only unread pane recomputes the collapsed source tab', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p2 } = wiredSplitTab(ctx, 't_source', 'sp_1', '', 'sp_2', '');
    ctx.TabManager.activeId = 't_a';
    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'moving unread\r\n' });
    assert.equal(tab._bgUnread, true);

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const extracted = ctx.TabManager.tabs.find(t => t.tabId === 'sp_2');
    assert.equal(tab._bgUnread, false, 'the source no longer owns the unread backend');
    assert.equal(extracted._bgUnread, false, 'activation consumes the moved unread marker');
});

test('extracting one unread pane retains a surviving sibling unread marker', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_source', 'sp_1', '', 'sp_2', '');
    ctx.TabManager.activeId = 't_a';
    ctx.__emit('pty-output', { tabId: 'sp_1', data: 'sibling unread\r\n' });
    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'moving unread\r\n' });

    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    assert.equal(tab._bgUnread, true, 'the remaining backend still owns unread output');
});

test('collapsing a split drops unread state owned by the removed pane', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p2 } = wiredSplitTab(ctx, 't_collapse', 'sp_1', '', 'sp_2', '');
    ctx.TabManager.activeId = 't_a';
    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'removed unread\r\n' });

    ctx.TabManager._exitSplit(tab);
    assert.equal(tab._bgUnread, false, 'only the surviving pane can contribute unread');
});

test('moving an unread pane to another tab recomputes both source and target ownership', () => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p2 } = wiredSplitTab(ctx, 't_drag_source', 'sp_1', '', 'sp_2', '');
    const target = wiredTab(ctx, 't_drag_target', 'local_target', '');
    ctx.TabManager.activeId = 't_a';
    ctx.__emit('pty-output', { tabId: 'sp_2', data: 'dragged unread\r\n' });

    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r');
    assert.equal(tab._bgUnread, false, 'the collapsed source no longer owns the moved backend');
    assert.equal(target._bgUnread, false, 'the activated target consumes the moved unread marker');
});

test('sixty identical control redraws never rescan full lines and stay within touched-row reads', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_perf', 'ssh_perf', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, '\x1b[31mAgent ready\x1b[0m');
    const buffer = term.buffer.active;
    const counts = { getLine: 0, translate: 0 };
    const originalGetLine = buffer.getLine.bind(buffer);
    const wrapped = new WeakSet();
    buffer.getLine = index => {
        counts.getLine++;
        const line = originalGetLine(index);
        if (line && !wrapped.has(line)) {
            wrapped.add(line);
            const translate = line.translateToString.bind(line);
            line.translateToString = (...args) => {
                counts.translate++;
                return translate(...args);
            };
        }
        return line;
    };

    for (let i = 0; i < 60; i++) {
        ctx.__emit('pty-output', { tabId: 'ssh_perf',
            data: '\x1b[?25l\x1b[1;1H\x1b[31mAgent ready\x1b[0m\x1b[?25h' });
    }
    await settled(term);

    assert.equal(bg._bgUnread, undefined);
    assert.equal(counts.translate, 0, 'same-cell comparison never reads whole lines');
    assert.ok(counts.getLine <= 120, `touched one row before/after each chunk, got ${counts.getLine}`);
});


test('split pending control output is decided by the pane replay, not raw bytes', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const { tab, p2 } = wiredSplitTab(ctx, 't_pending_split', 'sp_1', '', 'sp_2', '');
    p2.term.dispose();
    p2.term = null;
    p2.type = 'ssh';
    useHeadlessTerminalFactory(ctx);
    ctx.TabManager.activeId = 't_a';

    ctx.__emit('pty-output', { tabId: 'sp_2', data: '\x1b[31m\x1b[?25l\x1b[1;1H\x1b[?25h' });
    const markedBeforeReplay = tab._bgUnread;
    ctx.wireTerminalToPane(tab, p2);
    t.after(() => p2.term.dispose());
    await settled(p2.term);

    assert.ok(!markedBeforeReplay, 'raw pending pane bytes never mark');
    assert.ok(!tab._bgUnread, 'the control-only pane replay stays silent');
});

test('pending control output after display-only history does not mark the history as unread', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    useHeadlessTerminalFactory(ctx);
    ctx._settingsConfig.restoreLocalContent = true;
    const bg = { id: 't_pending_history', name: 'history', type: 'ssh', connected: true,
        tabId: 'ssh_pending_history', term: null, _contentBuffer: 'history\r\n' };
    ctx.TabManager.tabs.push(bg);
    ctx.TabManager.activeId = 't_a';

    ctx.__emit('pty-output', { tabId: bg.tabId, data: '\x1b[31m\x1b[?25l\x1b[?25h' });
    ctx.wireTerminal(bg, bg.tabId);
    t.after(() => bg.term.dispose());
    await settled(bg.term);

    assert.equal(bg.term.buffer.active.getLine(0).translateToString(true), 'history');
    assert.equal(bg._bgUnread, undefined, 'neither history nor control-only pending bytes mark');
});

test('active and already-unread tabs skip all terminal buffer reads', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_skip', 'ssh_skip', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    await write(term, 'Agent ready');
    const buffer = term.buffer.active;
    let reads = 0;
    const getLine = buffer.getLine.bind(buffer);
    buffer.getLine = index => { reads++; return getLine(index); };

    ctx.TabManager.activeId = bg.id;
    ctx.__emit('pty-output', { tabId: 'ssh_skip', data: 'active text' });
    await settled(term);
    assert.equal(reads, 0, 'active output needs no unread snapshot');

    ctx.TabManager.activeId = 't_a';
    ctx.__emit('pty-output', { tabId: 'ssh_skip', data: '\r\nfirst background text' });
    await settled(term);
    assert.equal(bg._bgUnread, true);
    reads = 0;
    for (let i = 0; i < 60; i++) ctx.__emit('pty-output', { tabId: 'ssh_skip', data: '\r\nmore ' + i });
    await settled(term);
    assert.equal(reads, 0, 'an aggregated unread tab needs no further snapshots');
});

test('missing observer fallback marks text after parse with zero buffer reads', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    ctx.createInkCaretObserver = undefined;
    ctx.window.createInkCaretObserver = undefined;
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_fallback', 'ssh_fallback', '', { type: 'ssh' });
    const term = installParser(bg);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'Agent ready');
    const buffer = term.buffer.active;
    let reads = 0;
    const getLine = buffer.getLine.bind(buffer);
    buffer.getLine = index => { reads++; return getLine(index); };

    ctx.__emit('pty-output', { tabId: 'ssh_fallback', data: '\r\nAgent completed' });
    await settled(term);

    assert.equal(bg._bgUnread, true, 'the bounded conservative path does not drop real completion text');
    assert.equal(reads, 0);
});

test('same-text erase redraw compares only its touched row', async t => {
    const ctx = loadVm();
    outputFixture(ctx);
    wiredTab(ctx, 't_a', 'local_a', '');
    const bg = wiredTab(ctx, 't_erase', 'ssh_erase', '', { type: 'ssh' });
    const term = installParser(bg, 32, 6);
    t.after(() => term.dispose());
    ctx.TabManager.activeId = 't_a';
    await write(term, 'Agent ready');
    const buffer = term.buffer.active;
    const reads = [];
    const getLine = buffer.getLine.bind(buffer);
    buffer.getLine = index => { reads.push(index); return getLine(index); };

    ctx.__emit('pty-output', { tabId: 'ssh_erase', data: '\x1b[1;1H\x1b[KAgent ready' });
    await settled(term);

    assert.equal(bg._bgUnread, undefined);
    assert.deepEqual(reads, [0, 0], 'one touched row is read before and after parse');
});


for (const [name, initial, update, expected] of [
    ['ECH 3X', 'abcdef', '\x1b[1;2H\x1b[3X', [[0, 'a   ef']]],
    ['DCH 2P', 'abcdef', '\x1b[1;2H\x1b[2P', [[0, 'adef']]],
    ['ICH 2@', 'abcdef', '\x1b[1;2H\x1b[2@', [[0, 'a  bcdef']]],
    ['IL 1L', 'one\r\ntwo\r\nthree', '\x1b[2;1H\x1b[1L', [[1, ''], [2, 'two']]],
    ['DL 1M', 'one\r\ntwo\r\nthree', '\x1b[2;1H\x1b[1M', [[1, 'three'], [2, '']]],
    ['REP 3b', 'ab', '\x1b[3b', [[0, 'abbbb']]],
    ['RI at top', 'one\r\ntwo', '\x1b[1;1H\x1bM', [[0, ''], [1, 'one'], [2, 'two']]],
    ['RIS', 'abcdef', '\x1bc', [[0, '']]],
]) {
    test(`real parser screen mutation ${name} marks unread`, async t => {
        const ctx = loadVm();
        outputFixture(ctx);
        wiredTab(ctx, 't_a', 'local_a', '');
        const bg = wiredTab(ctx, 't_mutation', 'ssh_mutation', '', { type: 'ssh' });
        const term = installParser(bg, 32, 5);
        t.after(() => term.dispose());
        ctx.TabManager.activeId = 't_a';
        await write(term, initial);

        ctx.__emit('pty-output', { tabId: 'ssh_mutation', data: update });
        await settled(term);

        for (const [row, text] of expected) {
            assert.equal(term.buffer.active.getLine(row).translateToString(true), text, `${name} changed real text`);
        }
        assert.equal(bg._bgUnread, true, `${name} must not be lost as a text:false/no-op chunk`);
    });
}
