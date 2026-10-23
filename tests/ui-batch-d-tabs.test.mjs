// Batch D independent-review fixes (U-05 / U-07 / U-15 / U-16), driven through
// the REAL tabs.js / ipc.js / terminal.js in the shared renderer VM
// (tests/helpers/renderer-vm.mjs); only the DOM, timers and the ipc invoke
// bridge are faked.
//
// U-05: the busy reconnect spinner swallowed tab activation — the plainer
//   .tab:hover/.tab.active .tab-reconnect rule re-enabled pointer-events at a
//   higher specificity than the lone .tab-reconnect-busy rule, and the button
//   had no ondblclick guard, so a double click bubbled into the rename
//   gesture. Follow-up: the busy spinner now also auto-hides (opacity:0)
//   unless the tab is hovered or the button is keyboard-focused — the
//   connecting dot already carries the state — while staying inert everywhere.
// U-07: tab→pane promotion and cross-tab terminal moves copied _sessionFailed
//   but not _sshConnecting/_sshErrored — a still-connecting or errored session
//   lost its busy ring / error dot on arrival (pane-fields.js
//   adoptPaneFieldsIntoTab already covers the reverse, collapse direction).
// U-15: the ssh-error auto-retry branch cleared _sshReconnectNotice, so a
//   manual reconnect that recovered through handshake retries toasted
//   "SSH 已连接" instead of "SSH 已重新连接" on the eventual success.
// U-16: _showDropHint wrote geometry with the .drop-hint transition live, so
//   a fresh hint flew in from the previous drag's rect instead of appearing
//   in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));

// Recording, never-settling invoke bridge (same shape as
// ssh-reconnect-dedupe.test.mjs): every ssh-connect stays observable.
function patchInvoke(ctx) {
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        const rec = { cmd, payload };
        rec.promise = new Promise(() => {});
        invokes.push(rec);
        return rec.promise;
    };
    return invokes;
}
const connects = (invokes) => invokes.filter(i => i.cmd === 'ssh-connect');

function captureToasts(ctx) {
    const toasts = [];
    ctx.showToast = (m, isErr) => toasts.push({ m: String(m), isErr: !!isErr });
    return toasts;
}

// ── U-05 ────────────────────────────────────────────────────────────────────

test('U-05: the busy reconnect button stops double-click propagation (no rename)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_busy', 'ssh_1', null, { type: 'ssh', host: 'h', user: 'u', connected: false, _sshConnecting: true });
    ctx.TabManager.render();
    const el = ctx.document.querySelector('.tab[data-tab="t_busy"]');
    assert.ok(el, 'tab element rendered');
    const html = el.innerHTML;
    const bi = html.indexOf('class="tab-reconnect tab-reconnect-busy"');
    assert.ok(bi > 0, 'busy spinner rendered while _sshConnecting');
    const btn = html.slice(html.lastIndexOf('<button', bi), html.indexOf('</button>', bi));
    assert.ok(btn.includes('onclick="event.stopPropagation()"'), 'click stays off the tab');
    assert.ok(btn.includes('ondblclick="event.stopPropagation()"'),
        'dblclick must not bubble into the rename gesture (old code lacked the guard)');
});

test('U-05: the busy spinner hides unless hovered/focused (pointer-events stay none)', () => {
    const css = readFileSync(new URL('../src/renderer/app.css', import.meta.url), 'utf8');
    // Rules are brace-terminated; the busy comment block carries no braces.
    const rules = css.split('}').map(r => r.trim())
        .filter(r => r.includes('.tab-reconnect-busy') && r.includes('{'));
    assert.equal(rules.length, 2, 'exactly one hide rule and one reveal rule');
    const hide = rules.find(r => /opacity:0!important/.test(r));
    const reveal = rules.find(r => /opacity:0\.72!important/.test(r));
    assert.ok(hide, 'a hide rule pins opacity 0');
    assert.ok(reveal, 'a reveal rule keeps the reduced hover opacity');
    // Hidden + inert in the base state AND on the active tab — .tab.active
    // alone must not reveal it (the connecting dot carries the state), and
    // .tab.active .tab-reconnect would otherwise re-enable pointer-events at
    // equal specificity.
    assert.ok(hide.includes('.tab-reconnect-busy') && hide.includes('.tab.active .tab-reconnect-busy'),
        'base and .tab.active keep the spinner hidden and inert');
    // Revealed ONLY by tab hover and keyboard focus, still at reduced opacity.
    assert.ok(reveal.includes('.tab:hover .tab-reconnect-busy') && reveal.includes('.tab-reconnect-busy:focus-visible'),
        'only hover/focus reveal the busy spinner');
    for (const r of rules) {
        assert.ok(r.includes('pointer-events:none'),
            'pointer-events never becomes auto on the busy variant');
        assert.ok(!r.includes('pointer-events:auto'), 'no busy rule re-enables pointer events');
    }
    // The busy button still carries the .tab-reconnect class, so keyboard focus
    // matches .tab-reconnect:focus-visible (0,2,0 — same specificity as
    // .tab-reconnect-busy:focus-visible, which therefore must come later in
    // the sheet to win the tie). Brace-anchored literals so comment mentions
    // cannot satisfy the ordering check.
    const revealFocusIdx = css.indexOf('.tab-reconnect:focus-visible{');
    const busyFocusIdx = css.indexOf('.tab-reconnect-busy:focus-visible{');
    assert.ok(revealFocusIdx > 0 && busyFocusIdx > revealFocusIdx,
        'the busy :focus-visible selector must come after the reveal rule to win the equal-specificity tie');
    // The reveal rule must follow the hide rule: on a hovered ACTIVE tab both
    // match at 0,3,0 with !important, so sheet order decides (0.72 must win).
    assert.ok(css.indexOf('.tab-reconnect-busy,') < css.indexOf('.tab:hover .tab-reconnect-busy'),
        'the hide rule precedes the reveal rule so hover wins the equal-specificity opacity tie');
});

// ── U-07 ────────────────────────────────────────────────────────────────────

test('U-07: first-split promotion carries the connecting/errored flags onto the pane', () => {
    const ctx = loadVm();
    const { p1 } = wiredSplitTab(ctx, 't_fs', 'ssh_1', null, 'ssh_2', null,
        { type: 'ssh', host: 'h', user: 'u', connected: false, _sshConnecting: true });
    assert.equal(p1._sshConnecting, true, 'busy ring survives the tab→pane promotion');
    assert.equal(p1._sshErrored, false, 'booleanized like _sessionFailed / adoptPaneFieldsIntoTab');
});

test('U-07: a single tab dragged onto another tab carries the flags onto the new pane', () => {
    const ctx = loadVm();
    const src = wiredTab(ctx, 't_mv', 'ssh_7', null, { type: 'ssh', host: 'h', user: 'u', connected: false, _sshErrored: true });
    const tgt = wiredTab(ctx, 't_tg', 'local_9');
    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'r', null);
    const np = ctx.getAllPanes(tgt).find(p => p.tabId === 'ssh_7');
    assert.ok(np, 'moved session present on the target split');
    assert.equal(np._sshErrored, true, 'error dot survives the move');
    assert.equal(np._sshConnecting, false);
});

test('U-07: the target tab\'s own session keeps its flags on the promoted fp pane', () => {
    const ctx = loadVm();
    const tgt = wiredTab(ctx, 't_tp', 'ssh_8', null, { type: 'ssh', host: 'h', user: 'u', connected: false, _sshConnecting: true });
    const src = wiredTab(ctx, 't_ds', 'local_5');
    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 'r', null);
    const fp = ctx.getAllPanes(tgt).find(p => p.tabId === 'ssh_8');
    assert.ok(fp, 'target session promoted onto fp');
    assert.equal(fp._sshConnecting, true, 'busy ring survives the target-side promotion');
    assert.equal(fp._sshErrored, false);
});

test('U-07: a pane dragged out of a split carries its flags onto the moved pane', () => {
    const ctx = loadVm();
    const { tab: src, p2 } = wiredSplitTab(ctx, 't_ms', 'ssh_A', null, 'ssh_B', null,
        { type: 'ssh', host: 'h', user: 'u', connected: true });
    p2._sshErrored = true; // the focused (dragged) pane's session failed earlier
    const tgt = wiredTab(ctx, 't_dt', 'local_6');
    ctx.TabManager._moveTerminalToTab(src.id, tgt.id, 't', null);
    const np = ctx.getAllPanes(tgt).find(p => p.tabId === 'ssh_B');
    assert.ok(np, 'dragged pane present on the target split');
    assert.equal(np._sshErrored, true, 'error dot follows the dragged session');
    assert.equal(np._sshConnecting, false);
});

// ── U-15 ────────────────────────────────────────────────────────────────────

test('U-15: a retried manual reconnect still toasts "reconnected" on success', async () => {
    const ctx = loadVm();
    patchInvoke(ctx);
    const toasts = captureToasts(ctx);
    const keep = { id: 't_keep', name: 'keep', type: 'local', command: 'powershell.exe', args: [], connected: true };
    const tab = { id: 't_rn', name: 'rn', type: 'ssh', host: 'h1', user: 'u1', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(keep, tab);

    ctx.TabManager.reconnectTab(tab.id);
    assert.equal(tab._sshReconnectNotice, true, 'manual reconnect arms the notice');
    ctx.__tq.advance(500); // pre-attempt window ends: attempt created + invoked
    await flush();
    const att1 = tab._pendingAttempt;
    assert.ok(att1, 'first attempt in flight');

    // Transient handshake failure → the auto-retry branch (ipc.js).
    ctx.__emit('ssh-error', { tabId: null, attemptId: att1, error: 'connection reset by peer' });
    assert.equal(tab._sshRetried, 1, 'retry budget spent');
    assert.equal(tab._sshReconnectNotice, true,
        'the notice must survive the whole retry chain (old code cleared it here)');

    ctx.__tq.advance(2000); // first backoff elapses: replacement attempt
    await flush();
    const att2 = tab._pendingAttempt;
    assert.ok(att2 && att2 !== att1, 'retry created a new attempt identity');

    ctx.__emit('ssh-connecting', { tabId: 'ssh_2', attemptId: att2 });
    ctx.__emit('ssh-connected', { tabId: 'ssh_2', attemptId: att2 });
    assert.equal(tab.connected, true);
    assert.equal(tab._sshReconnectNotice, false, 'the success consumed the notice');
    assert.ok(toasts.some(t => t.m.startsWith('SSH 已重新连接')),
        'eventual success toasts as a REconnect (old code: plain "SSH 已连接")');
    assert.ok(!toasts.some(t => t.m.startsWith('SSH 已连接:')),
        'no plain-connected toast for a reconnect cycle');
});

test('U-15 (guard): a terminal failure still clears the notice and never retries', async () => {
    const ctx = loadVm();
    const invokes = patchInvoke(ctx);
    const toasts = captureToasts(ctx);
    const tab = { id: 't_rg', name: 'rg', type: 'ssh', host: 'h1', user: 'u1', connected: false, tabId: null, term: null, fitAddon: null };
    ctx.TabManager.tabs.push(tab);

    ctx.TabManager.reconnectTab(tab.id);
    ctx.__tq.advance(500);
    await flush();
    const att1 = tab._pendingAttempt;
    assert.ok(att1);

    // Deterministic failure (auth): no retry, the shared failure applier runs.
    ctx.__emit('ssh-error', { tabId: null, attemptId: att1, error: 'authentication failed' });
    assert.equal(tab._sshRetried || 0, 0, 'no retry budget spent on a deterministic error');
    assert.equal(tab._sshReconnectNotice, false, 'terminal failure clears the notice');
    assert.ok(toasts.some(t => t.isErr && t.m.startsWith('SSH 连接失败')), 'failure toast shown');

    ctx.__tq.advance(15000); // well past every backoff step
    await flush();
    assert.equal(connects(invokes).length, 1, 'a deterministic failure never schedules a retry');
});

// ── U-16 ────────────────────────────────────────────────────────────────────

test('U-16: a fresh drop hint appears in place; re-targeting still slides', () => {
    const ctx = loadVm();
    const T = ctx.TabManager;
    // Pre-build #drop-hint with the inner nodes _showDropHint updates (the
    // fake DOM never parses innerHTML, so the creation branch cannot run).
    const dh = ctx.document.createElement('div');
    dh.id = 'drop-hint';
    dh.className = 'drop-hint';
    const dhInner = ctx.document.createElement('div'); dhInner.className = 'dh';
    const nameEl = ctx.document.createElement('span'); nameEl.className = 'dh-name';
    const actEl = ctx.document.createElement('b'); actEl.className = 'dh-action';
    dhInner.appendChild(nameEl); dhInner.appendChild(actEl); dh.appendChild(dhInner);
    ctx.document.body.appendChild(dh);
    // Record every style write so the transition value in effect at each
    // geometry write is observable.
    const writes = [];
    dh.style = new Proxy({}, { set(t, k, v) { writes.push([k, v]); t[k] = v; return true; } });

    T._showDropHint({ left: 10, top: 20, width: 100, height: 50 }, 'alpha', '左侧分屏');
    assert.ok(dh.classList.contains('show'), 'hint shown');
    const ti = writes.findIndex(w => w[0] === 'transition' && w[1] === 'none');
    const li = writes.findIndex(w => w[0] === 'left');
    assert.ok(ti !== -1 && li !== -1 && ti < li,
        'geometry is written with transitions suppressed on a fresh show (old code animated the fly-in)');
    assert.equal(dh.style.transition, '', 'inline suppression removed; stylesheet transition live again');

    // Re-targeting inside the SAME drag (hint already shown) keeps the slide.
    writes.length = 0;
    T._showDropHint({ left: 400, top: 20, width: 100, height: 50 }, 'alpha', '左侧分屏');
    assert.equal(dh.style.left, '400px', 're-target applied');
    assert.ok(!writes.some(w => w[0] === 'transition'),
        'no suppression while already visible — the 0.18s slide still animates');
});
