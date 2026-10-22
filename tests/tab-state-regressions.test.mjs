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

// ── P3-06: a completed transfer never appears in both lists ────────────────

test('P3-06: a completed transfer moves to history at once — listed and counted exactly once', async () => {
    const vmh = await loadSftpVm();
    const id = vmh.TransferManager.add('a.txt', 'download', 'sessA');
    vmh.TransferManager.openPanel();
    // Old code: the done entry stayed in the active list for 3s while the
    // history record already existed — the group listed it twice and the
    // header count read +2.
    vmh.TransferManager.complete(id);

    assert.equal(vmh.TransferManager._transfers.length, 0, 'the active list releases the finished record at completion');
    assert.equal(vmh.TransferManager._history.length, 1, 'the history record exists');
    const groups = vmh.TransferManager._groups();
    assert.equal(groups.length, 1, 'one session group');
    assert.equal(groups[0].active.length + groups[0].history.length, 1, 'listed once, not in both sections');
    const m = el(vmh.ctx, 'transfer-panel-body').innerHTML.match(/transfer-group-count">(\d+)</);
    assert.ok(m, 'the group header rendered');
    assert.equal(m[1], '1', 'the group count never reads +2');
    const badge = el(vmh.ctx, 'transfer-btn').querySelector('.transfer-count');
    assert.equal(badge.textContent, '', 'the top-bar badge counts only running transfers');

    // The old 3s removal timer is gone: nothing disappears or reappears later.
    vmh.ctx.__tq.advance(5000);
    assert.equal(vmh.TransferManager._history.length, 1, 'the history record survives');
    assert.equal(vmh.TransferManager._groups()[0].active.length + vmh.TransferManager._groups()[0].history.length, 1,
        'still listed exactly once after the old removal window');
});

test('P3-06: a later completion never double-counts alongside earlier history', async () => {
    const vmh = await loadSftpVm();
    const first = vmh.TransferManager.add('a.txt', 'upload', 'sessA');
    vmh.TransferManager.complete(first);
    const second = vmh.TransferManager.add('b.txt', 'upload', 'sessA');
    vmh.TransferManager.openPanel();
    vmh.TransferManager.complete(second);

    const groups = vmh.TransferManager._groups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].active.length, 0, 'no done entries linger in the active section');
    assert.equal(groups[0].history.length, 2, 'both records live in history');
    assert.equal(groups[0].active.length + groups[0].history.length, 2, 'the group count matches the listed rows');
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

// ── P3-15: the caret follows the scheme, never a hardcoded white ───────────

const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// state.js is a browser global script; load the REAL file (plus the real
// color-utils.js luminance it derives the caret from) in a mini VM.
function loadThemeVm() {
    const ctx = {
        console,
        path: { join: (...a) => a.join('/') },
        process: { env: {} },
        _getAccentColorAlpha: (a) => `rgba(97,175,239,${a})`,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('src/renderer/color-utils.js'), ctx, { filename: 'color-utils.js' });
    vm.runInContext(read('src/renderer/state.js'), ctx, { filename: 'state.js' });
    return ctx;
}

test('P3-15: light schemes derive the caret from the scheme foreground', () => {
    const ctx = loadThemeVm();
    for (const key of ['solarizedLight', 'tangoLight', 'oneHalfLight', 'vscodeLightModern']) {
        vm.runInContext(`_settingsConfig.terminalScheme = '${key}'`, ctx);
        // Old code hardcoded cursor: '#ffffff' — nearly invisible on a light canvas.
        const theme = vm.runInContext('getTerminalTheme()', ctx);
        const scheme = vm.runInContext(`TERMINAL_SCHEMES['${key}']`, ctx);
        assert.equal(theme.cursor, scheme.foreground, `${key}: the caret is the scheme foreground, not white`);
        assert.ok(contrast(theme.cursor, theme.background) >= 3,
            `${key}: caret contrast ${contrast(theme.cursor, theme.background).toFixed(2)} >= 3`);
    }
});

test('P3-15: dark schemes keep the historical white caret', () => {
    const ctx = loadThemeVm();
    for (const key of ['onedark', 'inkFamily', 'obsidian', 'solarized', 'campbellPowershell']) {
        vm.runInContext(`_settingsConfig.terminalScheme = '${key}'`, ctx);
        assert.equal(vm.runInContext('getTerminalTheme()', ctx).cursor, '#ffffff',
            `${key}: dark-canvas caret unchanged`);
    }
});

test('P3-15: every scheme yields a caret with >= 3:1 contrast on its own canvas', () => {
    const ctx = loadThemeVm();
    const keys = vm.runInContext('Object.keys(TERMINAL_SCHEMES)', ctx);
    for (const key of keys) {
        vm.runInContext(`_settingsConfig.terminalScheme = '${key}'`, ctx);
        const theme = vm.runInContext('getTerminalTheme()', ctx);
        assert.ok(contrast(theme.cursor, theme.background) >= 3,
            `${key}: caret contrast ${contrast(theme.cursor, theme.background).toFixed(2)} < 3`);
    }
});

test('P3-15: _buildTerminalOptions falls back to the scheme foreground, never to white-on-white', () => {
    const ctx = loadVm(); // REAL terminal.js; getTerminalTheme staged per case
    ctx.getTerminalTheme = () => ({ foreground: '#111111', background: '#eeeeee' }); // no cursor key
    // Old code: cursor: terminalTheme.cursor || '#ffffff' — white on a light canvas.
    assert.equal(ctx._buildTerminalOptions().theme.cursor, '#111111',
        'a theme without a caret color falls back to its foreground');
    ctx.getTerminalTheme = () => ({ cursor: '#123456', foreground: '#111111', background: '#eeeeee' });
    assert.equal(ctx._buildTerminalOptions().theme.cursor, '#123456', 'an explicit caret color wins');
});

test('P3-15: applyTerminalScheme hot-apply keeps the same caret fallback chain', () => {
    const ctx = loadThemeVm(); // REAL state.js; getTerminalTheme staged per case
    // Hot-apply fakes: a style sink, no .window (the scheme-light toggle is
    // guarded), and tabs whose term.options capture the theme write — one
    // plain tab plus one split pane, covering both write sites in state.js.
    ctx.document = {
        documentElement: { style: { setProperty() {} } },
        querySelector: () => null,
    };
    const mkTerm = () => ({ options: {} });
    const tab = { term: mkTerm() };
    const paneTerm = mkTerm();
    const split = { term: null, splitRoot: {}, _panes: [{ term: paneTerm }] };
    ctx.TabManager = { tabs: [tab, split] };
    ctx.getAllPanes = (t) => t._panes || [];
    const apply = (theme) => {
        ctx.getTerminalTheme = () => theme;
        vm.runInContext('applyTerminalScheme()', ctx);
    };
    // Old state.js chain: theme.cursor || '#ffffff' — a cursor-less hot-apply
    // painted a white caret onto the light canvas it had just applied, while
    // new terminals built by _buildTerminalOptions fell back to foreground.
    apply({ foreground: '#111111', background: '#eeeeee' }); // no cursor key
    assert.equal(tab.term.options.theme.cursor, '#111111', 'tab path falls back to the foreground');
    assert.equal(paneTerm.options.theme.cursor, '#111111', 'pane path falls back to the foreground');
    apply({ background: '#eeeeee' }); // no cursor, no foreground
    assert.equal(tab.term.options.theme.cursor, '#ffffff', 'the final fallback stays white');
    apply({ cursor: '#123456', foreground: '#111111', background: '#eeeeee' });
    assert.equal(tab.term.options.theme.cursor, '#123456', 'an explicit caret color wins');
});
