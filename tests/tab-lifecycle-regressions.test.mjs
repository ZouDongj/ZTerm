// Tab lifecycle regressions (fix batch A), all driven through the REAL
// tabs.js / tab-serialize.js / terminal.js / ipc.js in the shared renderer
// VM (tests/helpers/renderer-vm.mjs):
//
// T06 — a restored split tab landed with NO focused pane: every focus-gated
// path (switchTo's refocus, reconnectTab's pane pick, wireTerminalToPane's
// arrival focus, the active-pane highlight) reads p.focused, so typing after
// a restart went nowhere and clicking a disconnected split SSH tab never
// reconnected (the reconnect entry found no pane and silently idled).
//
// T17 — closing the LAST remaining settings tab hit the dead-shell fallback
// of closeTab's aliveCount<=1 guard: the settings tab was converted in place
// into an invisible local terminal (a pty was spawned for it) while the
// settings layer stayed mounted as an orphan over whatever came next.
//
// T35 — a first split (keep-content mode) inside reconnectTab's 500ms delay
// window migrated the kept terminal onto a pane, but the scheduled request
// still connected "the tab": the new attempt bound to a split root that
// _findSessionOwner (ipc.js pass 2) can never match, so the backend's answer
// was orphan-disposed (ssh-disconnect) and the pane's reconnect was silently
// lost. The request now resolves the wrapper holding the kept terminal at
// fire time (terminal identity is the session identity, ADR-0004).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab, armFocusWindow } from './helpers/renderer-vm.mjs';

// _restoreSplitTab deserializes its splitRoot through tab-serialize.js. The
// shared harness does not load that file (it is a pure dual-export module),
// so load it into the VM exactly the way the page's script tag does (same
// pattern as custom-name-restore.test.mjs): in the VM `module` is undefined,
// the CJS branch is skipped and the two functions land as globals.
function loadVmWithSerialize() {
    const ctx = loadVm();
    const code = readFileSync(new URL('../src/renderer/tab-serialize.js', import.meta.url), 'utf8');
    vm.runInContext(code, ctx, { filename: 'tab-serialize.js' });
    return ctx;
}

// settings.js is not loaded in the harness; switchTo's settings branch calls
// loadSettingsIntoForm unconditionally — stub the global the page has.
function stubSettingsGlobals(ctx) {
    vm.runInContext('function loadSettingsIntoForm() {}', ctx);
}

function splitTabData(over = {}) {
    return {
        name: 'Deploy box', type: 'local', command: 'powershell.exe', args: [],
        splitRoot: {
            orientation: 'h',
            ratios: [0.5, 0.5],
            children: [
                { type: 'leaf', name: 'alpha', paneType: 'local', command: 'powershell.exe', args: [] },
                { type: 'leaf', name: 'beta', paneType: 'local', command: 'powershell.exe', args: [] },
            ],
        },
        ...over,
    };
}

function sshSplitTabData(over = {}) {
    return {
        name: 'Prod', type: 'ssh', host: 'h1', port: 22, user: 'u1',
        splitRoot: {
            orientation: 'h',
            ratios: [0.5, 0.5],
            children: [
                { type: 'leaf', name: 'alpha', paneType: 'ssh', sshHost: 'h1', sshPort: 22, sshUser: 'u1' },
                { type: 'leaf', name: 'beta', paneType: 'ssh', sshHost: 'h1', sshPort: 22, sshUser: 'u1' },
            ],
        },
        ...over,
    };
}

// ── T06: restored split focus ownership ─────────────────────────────────────

test('T06: a restored split tab lands with exactly one focused pane (the first)', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData());
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'two panes restored');
    assert.equal(panes.filter(p => p.focused).length, 1, 'exactly one focus owner');
    assert.equal(panes[0].focused, true, 'the first pane holds the marker');

    // The marker is visible at once: the rendered pane element carries the
    // active highlight (buildPane / _layoutSplit both read p.focused).
    const rootEl = ctx.document.getElementById('split_' + tab.id);
    const el0 = rootEl.querySelector('.split-pane[data-pane="' + panes[0].id + '"]');
    const el1 = rootEl.querySelector('.split-pane[data-pane="' + panes[1].id + '"]');
    assert.ok(el0.classList.contains('active'), 'first pane rendered as the active pane');
    assert.ok(!el1.classList.contains('active'), 'second pane is not active');
});

test('T06: the restored focused pane receives terminal focus when its backend arrives (typing works)', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData());
    const panes = ctx.getAllPanes(tab);
    ctx.TabManager.switchTo(tab.id); // the restore flow activates the first tab
    armFocusWindow(ctx);

    // Both local backends answer (the restore spawned them via pty-create).
    ctx.__emit('pty-created', { tabId: 'local_1', requestId: panes[0].requestId });
    ctx.__emit('pty-created', { tabId: 'local_2', requestId: panes[1].requestId });

    ctx.__tq.advance(400); // wiring fits + the 150ms arrival focus
    assert.equal(panes[0].term.focused, true, 'the focused pane got terminal focus');
    assert.equal(panes[1].term.focused, false, 'the other pane did not');
});

test('T06: clicking an active disconnected restored split SSH tab reconnects the focused pane', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(sshSplitTabData());
    const panes = ctx.getAllPanes(tab);
    assert.equal(tab.connected, false, 'SSH restore starts disconnected (handshake pending)');
    const before = panes.map(p => p._pendingAttempt);
    assert.ok(before[0] && before[1], 'restore spawned both pane attempts');

    ctx.TabManager.switchTo(tab.id); // user opens the restored tab
    ctx.TabManager.switchTo(tab.id); // clicks the ALREADY-ACTIVE tab → reconnect entry
    ctx.__tq.advance(600);           // the 500ms reconnect delay

    assert.ok(panes[0]._pendingAttempt && panes[0]._pendingAttempt !== before[0],
        'the focused pane owns a NEW reconnect attempt');
    assert.equal(panes[1]._pendingAttempt, before[1],
        'the unfocused pane keeps its own restore attempt untouched');
});

// ── T17: closing the last remaining settings tab ────────────────────────────

test('T17: closing the last remaining settings tab closes the layer and the tab for real', () => {
    const ctx = loadVm();
    stubSettingsGlobals(ctx);
    const tab = { id: 't_s', name: '设置', type: 'settings', connected: true, command: '' };
    ctx.TabManager.tabs.push(tab);
    ctx.TabManager.switchTo('t_s');
    const layer = ctx.document.getElementById('settings-pane');
    assert.ok(layer.classList.contains('active'), 'layer mounted while the settings tab is active');

    ctx.TabManager.closeTab('t_s');

    assert.equal(ctx.TabManager.tabs.length, 0, 'the settings tab is really gone');
    assert.ok(!layer.classList.contains('active'), 'no orphan settings layer');
    assert.equal(ctx.TabManager.activeId, null, 'no dangling active tab');
    assert.equal(ctx.__sends.filter(s => s.cmd === 'pty-create').length, 0,
        'no invisible local shell was spawned for the settings tab');

    // The + button path: creating the next tab must not resurrect/flash the
    // settings layer.
    ctx.TabManager.createTab({ name: 'Work', type: 'local', command: 'powershell.exe', args: [] });
    assert.ok(!layer.classList.contains('active'), 'the new tab shows no settings flash');
    assert.equal(ctx.TabManager.tabs[0].type, 'local');
    assert.equal(ctx.TabManager.activeId, ctx.TabManager.tabs[0].id, 'the new tab activated normally');
});

test('T17 guard: closing a settings tab with another tab alive keeps the normal fade path', () => {
    const ctx = loadVm();
    stubSettingsGlobals(ctx);
    const keep = wiredTab(ctx, 't_keep', 'local_9', 'keep');
    const tab = { id: 't_s', name: '设置', type: 'settings', connected: true, command: '' };
    ctx.TabManager.tabs.push(tab);
    ctx.TabManager.render(); // a rendered strip: the fade path only defers removal for a live tab element
    ctx.TabManager.switchTo('t_s');

    ctx.TabManager.closeTab('t_s');
    assert.ok(ctx.TabManager._closingTabs.has('t_s'), 'normal fade path entered');
    assert.equal(ctx.TabManager.tabs.length, 2, 'removal stays deferred during the fade');

    ctx.__tq.advance(400); // 200ms fade + margin
    assert.equal(ctx.TabManager.tabs.length, 1, 'settings tab removed after the fade');
    assert.ok(ctx.TabManager.tabs.includes(keep), 'the survivor is untouched');
    assert.ok(keep.term && !keep.term.disposed, 'survivor terminal intact');
    assert.ok(!ctx.document.getElementById('settings-pane').classList.contains('active'),
        'layer deactivated by the normal path');
});

// ── T35: reconnect during the first-split window ────────────────────────────

test('T35: a first split inside reconnectTab\'s 500ms window does not silently lose the pane\'s reconnect', () => {
    const ctx = loadVm();
    // clearOnConnect=false → keep-content mode: the kept terminal survives the
    // reconnect and can be migrated by a split inside the delay window.
    ctx.TabManager.sshProfiles = [{ id: 'prof1', clearOnConnect: false }];
    const tab = wiredTab(ctx, 't_ssh', 'ssh_1', 'old session output', {
        type: 'ssh', host: 'h1', user: 'u1', sshProfileId: 'prof1', connected: true,
    });
    const keptTerm = tab.term;

    ctx.TabManager.reconnectTab('t_ssh');
    assert.ok(tab.term === keptTerm && !keptTerm.disposed, 'keep-content: the terminal survives');
    assert.equal(tab.tabId, null, 'the old generation was released');

    // The first split lands INSIDE the 500ms window: the kept terminal is
    // promoted onto a pane (addPaneRelativeTo first-split branch).
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'split built');
    assert.ok(panes[0].term === keptTerm, 'the kept terminal was promoted onto the first pane');

    ctx.__tq.advance(600); // fire the scheduled reconnect
    const token = panes[0]._pendingAttempt || tab._pendingAttempt;
    assert.ok(token, 'a reconnect attempt exists');

    // The backend answers. The claim must reach the pane that now owns the
    // kept terminal — a request still aimed at the tab binds to a split root
    // no owner resolution matches, and the session is orphan-disposed.
    ctx.__emit('ssh-connecting', { tabId: 'ssh_9', attemptId: token });
    assert.equal(panes[0].tabId, 'ssh_9', 'the migrated pane claimed the new session');
    assert.equal(ctx.__sends.filter(s => s.cmd === 'ssh-disconnect' && s.payload && s.payload.tabId === 'ssh_9').length, 0,
        'the new session was not orphan-disposed');
    const lines = panes[0].term.buffer.active.lines.map(l => l.text);
    assert.ok(lines.some(l => l.includes('Connecting to h1')),
        'the kept terminal (not a rebuilt one) shows the connecting banner');
});

test('T35 guard: without a split in the window, the reconnect still connects the tab itself', () => {
    const ctx = loadVm();
    ctx.TabManager.sshProfiles = [{ id: 'prof1', clearOnConnect: false }];
    const tab = wiredTab(ctx, 't_ssh', 'ssh_1', 'old session output', {
        type: 'ssh', host: 'h1', user: 'u1', sshProfileId: 'prof1', connected: true,
    });

    ctx.TabManager.reconnectTab('t_ssh');
    ctx.__tq.advance(600); // fire the scheduled reconnect — no split happened
    const token = tab._pendingAttempt;
    assert.ok(token, 'reconnect attempt created for the tab');

    ctx.__emit('ssh-connecting', { tabId: 'ssh_9', attemptId: token });
    assert.equal(tab.tabId, 'ssh_9', 'the single tab claimed the new session as before');
    assert.equal(ctx.__sends.filter(s => s.cmd === 'ssh-disconnect' && s.payload && s.payload.tabId === 'ssh_9').length, 0,
        'no orphan disposal on the unchanged path');
});
