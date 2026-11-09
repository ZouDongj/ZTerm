// Issue #26: background-output unread indicator on the tab status dot.
//
// Contract under test (all driven through the REAL ipc.js pty-output router
// and the REAL tabs.js state/render paths in the shared renderer VM):
// - Non-empty output landing on a NON-active tab sets a runtime unread flag
//   (`tab._bgUnread`). In a split, ANY pane's output aggregates to the owning
//   tab; the ACTIVE tab's panes (focused or not) never mark.
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
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const source = f => readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8');

// Stage what the pty-output router needs beyond the harness defaults: the
// real restore-content.js (appendContentTail) and a passthrough highlight
// (same convention as tests/session-migration-persistence.test.mjs).
function outputFixture(ctx) {
    vm.runInContext(source('restore-content.js'), ctx);
    ctx.applyHighlight = data => data;
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

    assert.equal(tab._bgUnread, undefined, 'the active tab never marks, focused pane or not');
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
