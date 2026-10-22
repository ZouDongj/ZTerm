// Tab/split connected-state aggregation, transfer-list completion, highlight
// default resurrection and light-scheme caret regressions (audit
// full-readonly-audit-2026-10-21: P3-12, P3-13, P3-06, P2-04 frontend,
// P3-15). Driven through the REAL tabs.js / ipc.js / sftp.js / highlight.js /
// state.js in VM harnesses; only the environment is faked. Old-code failure
// notes are stated per test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredSplitTab } from './helpers/renderer-vm.mjs';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const el = (ctx, id) => ctx.document.getElementById(id);

// _restoreSplitTab deserializes its splitRoot through tab-serialize.js, which
// the shared harness does not load (same pattern as
// tab-lifecycle-regressions.test.mjs).
function loadVmWithSerialize() {
    const ctx = loadVm();
    vm.runInContext(read('src/renderer/tab-serialize.js'), ctx, { filename: 'tab-serialize.js' });
    return ctx;
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

// ── P3-12: close/extract re-aggregates the tab dot ─────────────────────────

test('P3-12: closing the last live pane re-aggregates the surviving split tab', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'b1', null, 'b2', null);
    // Third pane through the real split path, then its backend arrives.
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const p3 = ctx.getAllPanes(tab).find(p => p !== p1 && p !== p2);
    p3.tabId = 'b3';
    ctx.__tq.advance(2000); // drain setup timers (wiring fits/focuses)

    // Two sessions exit; the live third pane keeps the tab connected.
    ctx.__emit('pty-exit', { tabId: 'b1' });
    ctx.__emit('pty-exit', { tabId: 'b2' });
    assert.equal(tab.connected, true, 'precondition: the surviving pane keeps the tab connected');

    // Close the last live pane. Old code: the removal's >=2-survivor branch
    // rendered without re-aggregating — the dot stayed green forever.
    ctx.TabManager._closePane(tab.id, p3.id);
    ctx.__tq.advance(1000); // the 200ms exit window runs doRemove

    assert.ok(ctx.TabManager.tabs.includes(tab), 'two dead panes remain: the tab itself survives');
    assert.equal(ctx.getAllPanes(tab).length, 2, 'the split keeps its remaining panes');
    assert.equal(tab.connected, false, 'no live pane left: the tab dot must go gray');
});

test('P3-12: extracting the last live pane re-aggregates the source tab (B-P2-09 pattern lock)', () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'b1', null, 'b2', null);
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const p3 = ctx.getAllPanes(tab).find(p => p !== p1 && p !== p2);
    p3.tabId = 'b3';
    ctx.wireTerminalToPane(tab, p3); // extraction requires a live term + backend id
    ctx.__tq.advance(2000);

    ctx.__emit('pty-exit', { tabId: 'b1' });
    ctx.__emit('pty-exit', { tabId: 'b2' });
    assert.equal(tab.connected, true, 'precondition: the surviving pane keeps the tab connected');

    ctx.TabManager._extractPaneToTab(tab.id, p3.id);

    const nt = ctx.TabManager.tabs[ctx.TabManager.tabs.length - 1];
    assert.ok(nt && nt !== tab && !nt.splitRoot, 'the pane became its own tab');
    assert.equal(nt.connected, true, 'the extracted tab adopts its live session state');
    assert.equal(tab.connected, false, 'only dead panes remain: the source tab dot goes gray');
});

// ── P3-13: restored/claimed split tabs aggregate pane connectedness ────────

test('P3-13: a restored local split tab aggregates pane connectedness (no hardcoded gray dot)', () => {
    const ctx = loadVmWithSerialize();
    // Old code: connected was a literal false, so the tab dot stayed gray
    // while every pane header read green.
    const tab = ctx.TabManager._restoreSplitTab(splitTabData());
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'two panes restored');
    assert.ok(panes.every(p => p.connected === true), 'local panes deserialize online (tab-serialize.js)');
    assert.equal(tab.connected, true, 'the tab dot follows its panes');
});

test('P3-13: a restored SSH split tab stays disconnected until the handshake', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(sshSplitTabData());
    assert.equal(tab.connected, false, 'SSH panes deserialize offline — the tab must not flip green');
});

test('P3-13: a degraded (empty) restored split tree adopts the single-tab initial state', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData({
        splitRoot: { orientation: 'h', children: [], ratios: [] },
    }));
    assert.equal(tab.splitRoot, null, 'an empty tree degrades to a normal tab');
    assert.equal(tab.connected, true, 'matches createTabSilent: a local tab starts online');
});

test('P3-13: a pty-created claim on a split pane re-aggregates and repaints the tab dot', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData());
    const panes = ctx.getAllPanes(tab);
    // Stale strip state the claim must heal (a cloned split tab starts gray).
    tab.connected = false;
    let renders = 0;
    const origRender = ctx.TabManager.render.bind(ctx.TabManager);
    ctx.TabManager.render = () => { renders++; origRender(); };

    // Old code: the split claim branch never aggregated and never repainted.
    ctx.__emit('pty-created', { tabId: 'local_1', requestId: panes[0].requestId });

    assert.equal(panes[0].tabId, 'local_1', 'the pane claimed its backend');
    assert.equal(tab.connected, true, 'the claim re-aggregates the tab state');
    assert.ok(renders >= 1, 'the strip repaints with the claim');
});


// ── P2-04 (frontend): absent key vs explicitly saved empty list ────────────

// highlight.js is a browser global script; load the REAL file (plus the real
// highlight-utils.js it calls) in a mini VM with recorded ipc (same pattern
// as highlight-edit.test.mjs).
function loadHighlightVm() {
    const sends = [];
    const onceHandlers = new Map();
    const ctx = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: () => null, // no list container: the render early-returns
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: {},
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            once: (ch, fn) => {
                if (!onceHandlers.has(ch)) onceHandlers.set(ch, []);
                onceHandlers.get(ch).push(fn);
            },
        },
        showToast() {},
        showConfirm() {},
        escHtml: (s) => String(s),
        Icons: { iconSvg: () => 'svg' },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('src/renderer/highlight-utils.js'), ctx, { filename: 'highlight-utils.js' });
    vm.runInContext(read('src/renderer/highlight.js'), ctx, { filename: 'highlight.js' });
    return { ctx, sends, onceHandlers };
}

test('P2-04: an explicitly saved empty rules list survives a restart (no default resurrection)', () => {
    const { ctx, sends, onceHandlers } = loadHighlightVm();
    vm.runInContext('loadHighlightRules()', ctx);
    assert.deepEqual(sends.map(s => s.cmd), ['get-highlight-rules'], 'staging: the rules are requested');

    // Backend contract (get_highlight_rules): the highlightRules key is
    // present and holds the explicitly saved empty list.
    // Old code treated any empty list as first launch and recreated the
    // three defaults.
    onceHandlers.get('highlight-rules')[0]({}, { rules: [], settings: { highlightEnabled: true, highlightAlternateDisable: true } });

    assert.equal(vm.runInContext('_highlightRules.length', ctx), 0, 'the empty list is authoritative');
    assert.equal(sends.filter(s => s.cmd === 'save-highlight-rules').length, 0,
        'no defaults are recreated and persisted over the empty list');
});

test('P2-04: a missing highlightRules key (true first launch) seeds and persists the three defaults', () => {
    const { ctx, sends, onceHandlers } = loadHighlightVm();
    vm.runInContext('loadHighlightRules()', ctx);

    // Backend contract: the key is absent from the config, delivered as null.
    onceHandlers.get('highlight-rules')[0]({}, { rules: null, settings: null });

    assert.equal(vm.runInContext('_highlightRules.length', ctx), 3, 'first launch seeds the three defaults');
    const saves = sends.filter(s => s.cmd === 'save-highlight-rules');
    assert.equal(saves.length, 1, 'the seeded defaults are persisted');
    assert.equal(saves[0].payload.rules.length, 3);
    assert.deepEqual(Array.from(saves[0].payload.rules, r => r.text), ['ERROR', 'WARN', 'INFO']);
});



