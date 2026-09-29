// Quick-command PANEL regressions (quick-commands.js): overlay mutual
// exclusion, grouped-render selection identity, and the filter reset.
// Driven through the REAL script in the manager VM
// (tests/helpers/manager-vm.mjs), same harness as qc-regressions.test.mjs.
//
// The fake DOM resolves only simple selectors, so '#qc-list .v3-item' (what
// qcSelect queries) returns [] there and the harness elements have no
// removeAttribute. The selection tests below stage their own row objects —
// carrying exactly the API qcSelect touches — and patch querySelectorAll for
// that one selector, delegating everything else to the harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQcVm, runIn, mkEvt } from './helpers/manager-vm.mjs';

// Two groups, interleaved in the flat list: grouped rendering emits
// Ops[a(0), c(2)] then Git[b(1)], so the row at DOM position 1 carries flat
// index 2 — the exact divergence that used to desync highlight and dispatch.
const COMMANDS = [
    { id: 'a', name: 'alpha', command: 'cmd-a', group: 'Ops' },
    { id: 'b', name: 'beta', command: 'cmd-b', group: 'Git' },
    { id: 'c', name: 'gamma', command: 'cmd-c', group: 'Ops' },
];

function setCommands(ctx, cmds) {
    runIn(ctx, '_qcCommands = ' + JSON.stringify(cmds));
}

// Minimal row: only what qcSelect touches (dataset.index, attributes,
// scrollIntoView). The harness element lacks removeAttribute, hence the
// purpose-built stub instead of a staged harness node.
function mkRow(flatIndex) {
    return {
        dataset: { index: String(flatIndex) },
        _attrs: new Map(),
        setAttribute(k, v) { this._attrs.set(k, String(v)); },
        getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; },
        removeAttribute(k) { this._attrs.delete(k); },
        scrollIntoView() {},
    };
}
const isSelected = row => row._attrs.has('data-selected');

// Rows in RENDERED (grouped) DOM order with the qcSelect selector patched in.
function stageRows(ctx, flatIndexesInDomOrder) {
    const rows = flatIndexesInDomOrder.map(mkRow);
    const realQsa = ctx.document.querySelectorAll;
    ctx.document.querySelectorAll = sel => sel === '#qc-list .v3-item'
        ? rows
        : realQsa.call(ctx.document, sel);
    return rows;
}

function stageTerminal(ctx) {
    ctx.TabManager.getActive = () => ({ tabId: 't1', splitRoot: null, term: { focus() {} } });
}
const ptySend = ctx => ctx.__sends.find(s => s.cmd === 'pty-input');

// ── Grouped rendering: highlight, hover and Enter share one index space ──

test('grouped render emits rows in group order with their flat data-index', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    ctx.qcFilter();
    const html = ctx.document.getElementById('qc-list').innerHTML;
    // Premise of the desync: DOM order is a(0), c(2), b(1), not flat order.
    const pos = i => html.indexOf(`data-index="${i}"`);
    assert.ok(pos(0) !== -1 && pos(1) !== -1 && pos(2) !== -1, 'all rows rendered');
    assert.ok(pos(0) < pos(2) && pos(2) < pos(1), 'rows follow group order, not flat order');
    assert.ok(html.includes('aria-selected="true" data-index="0"'), 'flat 0 highlighted on open');
});

test('qcSelect highlights the row carrying the hovered flat index, not DOM position', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const rows = stageRows(ctx, [0, 2, 1]); // DOM order: a, c, b

    ctx.qcSelect(1); // hover/keyboard target = flat index 1 = beta

    assert.equal(isSelected(rows[2]), true, 'flat 1 (beta) is highlighted');
    assert.equal(rows[2].getAttribute('aria-selected'), 'true');
    assert.equal(isSelected(rows[0]), false, 'flat 0 unhighlighted');
    assert.equal(isSelected(rows[1]), false, 'flat 2 unhighlighted');
});

test('Enter executes exactly the command whose row the keyboard highlight shows', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    stageTerminal(ctx);
    const rows = stageRows(ctx, [0, 2, 1]);

    ctx.qcKeydown(mkEvt({ key: 'ArrowDown' })); // flat 0 -> 1
    const highlighted = rows.find(isSelected);
    assert.equal(highlighted.dataset.index, '1', 'the highlight sits on flat 1 (beta)');

    ctx.qcKeydown(mkEvt({ key: 'Enter' }));
    const send = ptySend(ctx);
    assert.ok(send, 'Enter dispatched the highlighted command');
    assert.equal(send.payload.data, 'cmd-b', 'Enter ran beta — the row the user saw highlighted');
});

// ── Filter reset (paletteFilter precedent) ──

test('filtering resets the selection so Enter always acts on a visible row', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    stageTerminal(ctx);
    const input = ctx.document.getElementById('qc-input');

    ctx.qcKeydown(mkEvt({ key: 'ArrowDown' }));
    ctx.qcKeydown(mkEvt({ key: 'ArrowDown' }));
    assert.equal(runIn(ctx, '_qcSelected'), 2, 'selection walked to flat 2 first');

    input.value = 'alpha';
    ctx.qcFilter();
    assert.equal(runIn(ctx, '_qcSelected'), 0, 'filter resets the selection');
    assert.ok(
        ctx.document.getElementById('qc-list').innerHTML.includes('aria-selected="true" data-index="0"'),
        'the rendered row carries the highlight');

    ctx.qcKeydown(mkEvt({ key: 'Enter' }));
    const send = ptySend(ctx);
    assert.ok(send, 'Enter acts after filtering');
    assert.equal(send.payload.data, 'cmd-a', 'Enter ran the sole visible match');
});

test('clearing the filter also re-highlights from the top', () => {
    const ctx = loadQcVm();
    setCommands(ctx, COMMANDS);
    const input = ctx.document.getElementById('qc-input');

    input.value = 'gamma';
    ctx.qcFilter();
    ctx.qcKeydown(mkEvt({ key: 'ArrowDown' })); // clamp at the single match
    assert.equal(runIn(ctx, '_qcSelected'), 0);

    input.value = '';
    ctx.qcFilter();
    assert.equal(runIn(ctx, '_qcSelected'), 0, 'back to the full list, selection restarts at 0');
    assert.ok(
        ctx.document.getElementById('qc-list').innerHTML.includes('aria-selected="true" data-index="0"'),
        'first row of the full list is highlighted');
});

// ── openQC single-overlay policy ──
// The baseCtx overlay helpers are no-op stubs; wire the canonical utils.js
// semantics onto the fake DOM ('.overlay.open' resolves in the harness).
function wireOverlayHelpers(ctx) {
    ctx.closeAllOverlays = () => {
        ctx.document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
    };
    ctx.openOverlay = id => {
        ctx.closeAllOverlays();
        ctx.document.getElementById(id).classList.add('open');
    };
}

test('openQC closes an already-open overlay (SFTP panel) instead of stacking', () => {
    const ctx = loadQcVm();
    wireOverlayHelpers(ctx);
    const sftp = ctx.document.getElementById('overlay-sftp');
    sftp.className = 'overlay open';

    ctx.openQC();

    assert.equal(ctx.document.getElementById('overlay-qc').classList.contains('open'), true, 'QC overlay opened');
    assert.equal(sftp.classList.contains('open'), false, 'the SFTP panel was closed first — Esc can only close QC now');
});

test('reopening QC while it is open leaves a single open overlay', () => {
    const ctx = loadQcVm();
    wireOverlayHelpers(ctx);
    // Auto-vivified elements start with an empty className; give overlay-qc
    // its real base class so the '.overlay.open' sweep can see it.
    ctx.document.getElementById('overlay-qc').className = 'overlay';
    ctx.openQC();
    ctx.openQC(); // the shortcut fires again while QC is already open

    const open = ctx.document.querySelectorAll('.overlay.open');
    assert.equal(open.length, 1, 'exactly one overlay open');
    assert.equal(open[0].id, 'overlay-qc');
});
