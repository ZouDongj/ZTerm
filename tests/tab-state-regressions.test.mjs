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



