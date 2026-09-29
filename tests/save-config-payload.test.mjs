// Regression: the saveConfig lastTabs payload must carry the manual-rename
// lock (`customName`). tabs.js sets tab._customName on rename so pane changes
// stop overwriting the name, but the flag used to live only in memory — after
// a restart the restore-side recompute overwrote the user's rename with the
// pane-derived name. The REAL saveConfig (main.js) is extracted so the test
// tracks the implementation instead of a copied stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSrc = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');

const saveSrc = mainSrc.match(/function saveConfig\(\) \{[\s\S]*?\n\}/);
assert.ok(saveSrc, 'saveConfig source found in main.js');

function fixture(tabs, settingsConfig = {}) {
    const invokes = [];
    const context = {
        console,
        TabManager: { tabs },
        _settingsConfig: settingsConfig,
        serializeSplitNode: () => ({ serialized: true }),
        ipcRenderer: { invoke: async (cmd, payload) => { invokes.push({ cmd, payload }); } },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(saveSrc[0], context);
    return { context, invokes };
}

async function savedEntries(tabs, settingsConfig) {
    const f = fixture(tabs, settingsConfig);
    await f.context.saveConfig();
    assert.equal(f.invokes.length, 1, 'saveConfig issues exactly one invoke');
    assert.equal(f.invokes[0].cmd, 'save-last-tabs');
    return f.invokes[0].payload;
}

test('a manually renamed tab persists customName: true', async () => {
    const tabs = [{ id: 't1', name: 'My Deploy', type: 'local', command: 'powershell.exe', args: [], _customName: true }];
    const entries = await savedEntries(tabs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'My Deploy');
    assert.equal(entries[0].customName, true, 'the rename lock must reach the persisted payload');
});

test('a tab without a manual rename persists customName: false', async () => {
    const tabs = [{ id: 't1', name: 'powershell', type: 'local', command: 'powershell.exe', args: [] }];
    const entries = await savedEntries(tabs);
    assert.equal(entries[0].customName, false);
});

test('a renamed split tab persists customName: true', async () => {
    const tabs = [{
        id: 't1', name: 'pair-prog', type: 'local', command: 'powershell.exe', args: [],
        _customName: true,
        splitRoot: { orientation: 'h', children: [{ id: 'p1' }, { id: 'p2' }], ratios: [0.5, 0.5] },
    }];
    const entries = await savedEntries(tabs);
    assert.equal(entries[0].customName, true);
    assert.deepEqual(entries[0].splitRoot, { serialized: true }, 'split tree still serialized');
});

test('(guard) settings tabs are still excluded from the payload', async () => {
    const tabs = [
        { id: 't1', name: 'shell', type: 'local', command: 'powershell.exe', args: [] },
        { id: 't2', name: 'Settings', type: 'settings' },
    ];
    const entries = await savedEntries(tabs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'shell');
});
