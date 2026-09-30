// tabs-3: a tab inside its close window (backend destroyed at initiation, DOM
// entry still fading for 200ms+) and panes inside their own close window used
// to be persisted by the periodic/quit-time saveConfig — restarting resurrected
// the just-closed tab and auto-reconnected its SSH panes. Two guards: the
// tab filter drops _closingTabs members, and serializeSplitNode prunes
// _closing panes (with their ratios; an emptied container collapses to null).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serializeSplitNode } = require('../src/renderer/tab-serialize.js');

// Same extraction pattern as tests/save-config-payload.test.mjs: run the REAL
// saveConfig from main.js so the test tracks the implementation.
const mainSrc = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');
const saveSrc = mainSrc.match(/function saveConfig\(\) \{[\s\S]*?\n\}/);
assert.ok(saveSrc, 'saveConfig source found in main.js');

async function savedTabs(tabs, closingTabs) {
    const invokes = [];
    const context = {
        console,
        TabManager: { tabs, _closingTabs: closingTabs },
        _settingsConfig: {},
        serializeSplitNode: () => ({ serialized: true }),
        ipcRenderer: { invoke: async (cmd, payload) => { invokes.push({ cmd, payload }); } },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(saveSrc[0], context);
    await context.saveConfig();
    return invokes[0].payload;
}

test('saveConfig skips a tab inside its close window (quit-time save cannot resurrect it)', async () => {
    const tabs = [
        { id: 't_alive', name: 'alive', type: 'local', command: 'powershell.exe', args: [] },
        { id: 't_dying', name: 'dying ssh', type: 'ssh', host: 'h', args: [] },
    ];
    const entries = await savedTabs(tabs, new Set(['t_dying']));
    assert.equal(entries.length, 1, 'only the alive tab is persisted');
    assert.equal(entries[0].name, 'alive');
});

test('(control) with an empty closing set every non-settings tab persists as before', async () => {
    const tabs = [
        { id: 't1', name: 'a', type: 'local', command: 'powershell.exe', args: [] },
        { id: 't2', name: 'b', type: 'ssh', host: 'h', args: [] },
    ];
    const entries = await savedTabs(tabs, new Set());
    assert.equal(entries.length, 2, 'nothing is filtered without a close window');
});

// ── serializeSplitNode: _closing panes never reach the persisted tree ──────

const leaf = (over = {}) => ({
    type: 'leaf', name: 'p', paneType: 'local', command: '', args: [], ...over,
});

test('a _closing pane is pruned from the serialized tree', () => {
    const tree = {
        orientation: 'h', ratios: [0.5, 0.5],
        children: [
            { id: 'p1', name: 'survivor', type: 'local' },
            { id: 'p2', name: 'dying', type: 'local', _closing: true },
        ],
    };
    const out = serializeSplitNode(tree);
    assert.equal(out.children.length, 1, 'only the survivor persists');
    assert.equal(out.children[0].name, 'survivor');
    assert.deepEqual(out.ratios, [0.5], 'the pruned pane takes its ratio with it');
});

test('a container whose panes are all closing collapses to null', () => {
    const tree = {
        orientation: 'v', ratios: [0.5, 0.5],
        children: [
            { id: 'p1', name: 'a', type: 'local', _closing: true },
            { id: 'p2', name: 'b', type: 'local', _closing: true },
        ],
    };
    assert.equal(serializeSplitNode(tree), null, 'an emptied container prunes itself from its parent');
});

test('(control) a live tree serializes unchanged', () => {
    const tree = {
        orientation: 'h', ratios: [0.5, 0.5],
        children: [
            { id: 'p1', name: 'a', type: 'local' },
            { id: 'p2', name: 'b', type: 'local' },
        ],
    };
    const out = serializeSplitNode(tree);
    assert.equal(out.children.length, 2, 'live panes all persist');
    assert.deepEqual(out.ratios, [0.5, 0.5]);
    assert.deepEqual(
        JSON.stringify(out.children[0]), JSON.stringify(leaf({ name: 'a' })),
        'leaf payload shape is unchanged');
});
