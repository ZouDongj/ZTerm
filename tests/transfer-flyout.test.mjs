// Transfer flyout semantics (accepted-prototype alignment):
// - Bar-button retention: records OR an open flyout keep #transfer-btn
//   visible; clearing the last record while the flyout is open no longer
//   closes the flyout or hides the button (the old _hideButton did both).
// -「清除已完成」bulk action: done/cancelled entries and the history go,
//   active transfers stay; the affordance only renders when something
//   finished is listed.
// - Non-modality: #transfer-panel is no longer an .overlay — a click outside
//   closes the flyout WITHOUT preventing the click (it still reaches the
//   pane underneath), and Esc closes it through the REAL shortcuts.js
//   dispatcher (real modal overlays keep their Esc priority).
//
// Coverage boundary: the Esc cases run the REAL shortcut-utils.js +
// shortcuts.js keydown dispatcher in a dedicated mini-VM (the shared sftp VM
// does not load shortcuts.js); the click cases fire the REAL document click
// listener sftp.js registered (renderer-vm records document listeners).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadSftpVm } from './helpers/sftp-vm.mjs';
import { mkDoc } from './helpers/manager-vm.mjs';

const el = (ctx, id) => ctx.document.getElementById(id);
const visible = (ctx) => el(ctx, 'transfer-btn').classList.contains('visible');
const flyoutOpen = (ctx) => el(ctx, 'transfer-panel').classList.contains('open');

// ── Button retention ─────────────────────────────────────────────────────────

test('clearing every record while the flyout is open keeps button AND flyout', async () => {
    const vm = await loadSftpVm();
    const id = vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();
    assert.equal(flyoutOpen(vm.ctx), true, 'staging: flyout open');

    vm.TransferManager.remove(id); // last record goes while the flyout is open

    assert.equal(visible(vm.ctx), true, 'the button stays visible while the flyout is open');
    assert.equal(flyoutOpen(vm.ctx), true, 'the flyout itself stays open');
});

test('history removal follows the same rule', async () => {
    const vm = await loadSftpVm();
    const id = vm.TransferManager.add('a.txt', 'download', 'sessA');
    vm.TransferManager.complete(id); // done entry + history record
    vm.TransferManager.remove(id); // in-flight entry goes, history keeps the button
    assert.equal(visible(vm.ctx), true, 'history alone keeps the button');

    vm.TransferManager.openPanel();
    vm.TransferManager.removeHistory(0);
    assert.equal(visible(vm.ctx), true, 'still visible: the flyout is open');
    assert.equal(flyoutOpen(vm.ctx), true);
});

test('closing the flyout with nothing left hides the button', async () => {
    const vm = await loadSftpVm();
    const id = vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();
    vm.TransferManager.remove(id);
    vm.TransferManager.closePanel();
    assert.equal(visible(vm.ctx), false, 'empty + closed → hidden');
    assert.equal(flyoutOpen(vm.ctx), false);
});

test('closing the flyout with records left keeps the button', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();
    vm.TransferManager.closePanel();
    assert.equal(visible(vm.ctx), true, 'records keep the button mounted');
});

// ── 清除已完成 ────────────────────────────────────────────────────────────────

test('clearDone removes done/cancelled/history, keeps active, and toggles its own affordance', async () => {
    const vm = await loadSftpVm();
    const active = vm.TransferManager.add('active.txt', 'upload', 'sessA');
    const done = vm.TransferManager.add('done.txt', 'upload', 'sessA');
    vm.TransferManager.complete(done);
    const cancelled = vm.TransferManager.add('cancelled.txt', 'upload', 'sessA');
    vm.TransferManager.cancel(cancelled);
    vm.TransferManager.add('hist.txt', 'download', 'sessB');
    // give the history-only entry a record too (second session group)
    vm.TransferManager._transfers[3].done = true;
    vm.TransferManager._history.unshift({ name: 'old.txt', type: 'download', total: 5, tabId: 'sessB', sessionLabel: 'Host B', completedAt: Date.now() });

    vm.TransferManager.openPanel();
    const actions = () => el(vm.ctx, 'transfer-header-actions').innerHTML;
    assert.ok(actions().includes('清除已完成'), 'the affordance renders while finished records exist');

    vm.TransferManager.clearDone();

    assert.equal(vm.TransferManager._transfers.length, 1, 'only the active transfer survives');
    assert.equal(vm.TransferManager._transfers[0].id, active);
    assert.equal(vm.TransferManager._transfers[0].name, 'active.txt');
    assert.equal(vm.TransferManager._transfers[0].done, false);
    assert.equal(vm.TransferManager._history.length, 0, 'the history is wiped');
    assert.ok(vm.toasts.some(t => t.msg.includes('已清除已完成的传输记录')), 'confirmation toast');
    assert.ok(!actions().includes('清除已完成'), 'the affordance disappears once nothing finished is listed');
    assert.equal(visible(vm.ctx), true, 'an active transfer keeps the button');
});

test('the clear-done affordance stays hidden while nothing has finished', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('active.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();
    assert.ok(!el(vm.ctx, 'transfer-header-actions').innerHTML.includes('清除已完成'));
});

// ── Non-modal: click-outside closer (real registered listener) ──────────────

function fireDocClick(ctx, target) {
    const handlers = ctx.__docListeners.get('click') || [];
    assert.ok(handlers.length >= 1, 'the click-outside closer is registered at load');
    const ev = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    handlers.slice().forEach(fn => fn(ev));
    return ev;
}

test('an outside click closes the flyout and the click still falls through', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();

    const outside = vm.ctx.document.createElement('div');
    vm.ctx.document.body.appendChild(outside);
    const ev = fireDocClick(vm.ctx, outside);

    assert.equal(flyoutOpen(vm.ctx), false, 'flyout closed');
    assert.equal(ev.defaultPrevented, false, 'the click is NOT consumed — it reaches the pane below');
});

test('clicks inside the window and on the titlebar button do not close it', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.openPanel();
    const win = el(vm.ctx, 'transfer-window');
    const inside = vm.ctx.document.createElement('button');
    win.appendChild(inside);

    fireDocClick(vm.ctx, inside);
    assert.equal(flyoutOpen(vm.ctx), true, 'a click inside the flyout keeps it open');

    fireDocClick(vm.ctx, el(vm.ctx, 'transfer-btn'));
    assert.equal(flyoutOpen(vm.ctx), true, 'the opening click on the button does not close it again');
});

// ── Non-modal: Esc through the REAL shortcuts dispatcher ────────────────────

function loadShortcutsVm() {
    const src = (f) => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
    const doc = mkDoc(); // auto-vivifying ids + class-chain selectors
    const listeners = new Map();
    doc.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    };
    const ctx = {
        console,
        document: doc,
        // Timers run IMMEDIATELY: the Esc branch refocuses through a 50ms
        // setTimeout (page convention); firing it inline makes the refocus
        // observable without a timer wheel.
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout: () => {},
        ipcRenderer: { invoke: () => new Promise(() => {}), send() {} },
        _settingsConfig: {},
        TabManager: { tabs: [], getActive: () => null },
        showToast() {},
        closeAllOverlays() { ctx.__closeAllCalls++; },
        _refocusActiveTerminal() { ctx.__refocusCalls++; },
        __closeAllCalls: 0,
        __refocusCalls: 0,
        __listeners: listeners,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src('shortcut-utils.js'), ctx, { filename: 'shortcut-utils.js' });
    vm.runInContext(src('shortcuts.js'), ctx, { filename: 'shortcuts.js' });
    return ctx;
}

function pressEscape(ctx) {
    const ev = {
        key: 'Escape',
        target: ctx.document.body,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
    };
    (ctx.__listeners.get('keydown') || []).slice().forEach(fn => fn(ev));
    return ev;
}

test('Esc closes the open flyout and consumes the key (real dispatcher)', () => {
    const ctx = loadShortcutsVm();
    let closes = 0;
    ctx.TransferManager = { closePanel() { closes++; } };
    ctx.document.getElementById('transfer-panel').classList.add('open');

    const ev = pressEscape(ctx);

    assert.equal(closes, 1, 'closePanel ran once');
    assert.equal(ev.defaultPrevented, true, 'the Escape never reaches the terminal');
    assert.equal(ev.propagationStopped, true);
    assert.equal(ctx.__closeAllCalls, 0, 'no overlay sweep ran (none was open)');
});

test('a real modal overlay keeps Esc priority over the flyout', () => {
    const ctx = loadShortcutsVm();
    let closes = 0;
    ctx.TransferManager = { closePanel() { closes++; } };
    ctx.document.getElementById('transfer-panel').classList.add('open');
    const modal = ctx.document.getElementById('overlay-qc');
    modal.className = 'overlay open'; // a genuine modal is open too

    const ev = pressEscape(ctx);

    assert.equal(ctx.__closeAllCalls, 1, 'the modal sweep owns this Escape');
    assert.equal(closes, 0, 'the flyout is untouched by the modal-priority Escape');
    assert.equal(ev.defaultPrevented, true);
});

test('Esc with the flyout closed falls through to the terminal', () => {
    const ctx = loadShortcutsVm();
    let closes = 0;
    ctx.TransferManager = { closePanel() { closes++; } };

    const ev = pressEscape(ctx);

    assert.equal(closes, 0);
    assert.equal(ev.defaultPrevented, false, 'the terminal receives the Escape (vim etc.)');
    assert.equal(ctx.__closeAllCalls, 0);
});

test('Esc hands focus back to the terminal when the flyout subtree held it', () => {
    const ctx = loadShortcutsVm();
    let closes = 0;
    ctx.TransferManager = { closePanel() { closes++; } };
    const panel = ctx.document.getElementById('transfer-panel');
    const win = ctx.document.getElementById('transfer-window');
    panel.classList.add('open');
    // A flyout button held the keyboard focus when Esc was pressed.
    const btn = ctx.document.createElement('button');
    win.appendChild(btn);
    ctx.document.activeElement = btn;

    pressEscape(ctx);

    assert.equal(closes, 1);
    assert.equal(ctx.__refocusCalls, 1, 'the terminal regains focus after the flyout closed');
});

test('Esc leaves focus alone when the flyout never had it', () => {
    const ctx = loadShortcutsVm();
    ctx.TransferManager = { closePanel() {} };
    ctx.document.getElementById('transfer-panel').classList.add('open');
    ctx.document.activeElement = ctx.document.body; // terminal focus lives outside the flyout

    pressEscape(ctx);

    assert.equal(ctx.__refocusCalls, 0, 'no forced refocus — the terminal keeps its focus');
});

// ── Titlebar button toggle ───────────────────────────────────────────────────

test('togglePanel flips the flyout both ways', async () => {
    const vm = await loadSftpVm();
    vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.togglePanel();
    assert.equal(flyoutOpen(vm.ctx), true, 'closed → open');
    vm.TransferManager.togglePanel();
    assert.equal(flyoutOpen(vm.ctx), false, 'open → closed');
    assert.equal(visible(vm.ctx), true, 'the record keeps the button mounted after the toggle-close');
});

// ── Actions row is not rebuilt when its markup is unchanged ─────────────────

test('a throttled re-render with identical actions does not reassign innerHTML', async () => {
    const vm = await loadSftpVm();
    // Two sessions -> expand/collapse pair renders; no finished records.
    vm.TransferManager.add('a.txt', 'upload', 'sessA');
    vm.TransferManager.add('b.txt', 'upload', 'sessB');
    vm.TransferManager.openPanel();
    // The seam's innerHTML setter does not model child replacement, so count
    // ASSIGNMENTS directly — the contract is "no write when markup is
    // unchanged" (a mid-press rebuild swallows the click, a per-tick rebuild
    // kills hover).
    const actions = el(vm.ctx, 'transfer-header-actions');
    let sets = 0;
    let htmlVal = actions.innerHTML;
    Object.defineProperty(actions, 'innerHTML', {
        get() { return htmlVal; },
        set(v) { htmlVal = String(v); sets++; },
    });

    vm.TransferManager._render(); // same state, as the 300ms throttle would

    assert.equal(sets, 0, 'unchanged actions markup → no innerHTML write');
    assert.ok(htmlVal.includes('全部展开'), 'staging check: the row did render initially');
    assert.equal(actions._lastActionsHtml, htmlVal);

    // A state change (finished record appears) must still rebuild the row.
    const id = vm.TransferManager.add('c.txt', 'upload', 'sessA');
    vm.TransferManager.complete(id);
    assert.equal(sets, 1, 'changed markup → exactly one innerHTML write');
    assert.ok(htmlVal.includes('清除已完成'));
});

// ── clearDone prunes collapse state of emptied groups ────────────────────────

test('clearDone drops collapsed-group keys whose records are all gone', async () => {
    const vm = await loadSftpVm();
    const active = vm.TransferManager.add('active.txt', 'upload', 'sessA');
    const done = vm.TransferManager.add('done.txt', 'upload', 'sessB');
    vm.TransferManager.complete(done);
    vm.TransferManager.collapseAll();
    assert.ok(vm.TransferManager._collapsedGroups.has('sessA'));
    assert.ok(vm.TransferManager._collapsedGroups.has('sessB'));

    vm.TransferManager.clearDone();

    assert.ok(vm.TransferManager._collapsedGroups.has('sessA'),
        'a group with a surviving active transfer keeps its collapse state');
    assert.ok(!vm.TransferManager._collapsedGroups.has('sessB'),
        'a group emptied by the wipe loses its stale key');
    assert.equal(vm.TransferManager._transfers.length, 1);
    assert.equal(vm.TransferManager._transfers[0].id, active);
});

// ── openOverlay dismisses the flyout (real utils.js) ────────────────────────

function loadUtilsVm() {
    const src = (f) => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
    const doc = mkDoc();
    const ctx = {
        console,
        document: doc,
        addEventListener() {}, // window-level error hooks at utils.js load
        // require shim: utils.js destructures electron/xterm modules at load;
        // only the utilities are exercised here, the imports stay unused.
        require: () => ({}),
        setTimeout: () => 0,
        clearTimeout: () => {},
        ipcRenderer: { invoke: () => new Promise(() => {}), send() {} },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src('utils.js'), ctx, { filename: 'utils.js' });
    return ctx;
}

test('openOverlay closes the flyout before opening a real modal', () => {
    const ctx = loadUtilsVm();
    let closes = 0;
    ctx.TransferManager = { closePanel() { closes++; } };
    ctx.document.getElementById('transfer-panel').classList.add('open');

    ctx.openOverlay('overlay-ssh-manager');

    assert.equal(closes, 1, 'the non-modal flyout is dismissed by a modal open');
    assert.equal(ctx.document.getElementById('overlay-ssh-manager').classList.contains('open'), true,
        'the requested overlay opened');
});
