// The manual tab-rename lock (_customName) must survive a restart.
// saveConfig persists entry.customName (main.js, "Persist the manual tab
// rename lock across restarts"); the restore side in tabs.js reads it back.
// Before this fix, restore rebuilt the tab with only tabData.name and then
// ran _updateTabName — whose guard reads tab._customName (undefined) — so
// resolveTabName immediately rejoined the pane names over the user's rename.
// The single-tab variant lost the lock silently too: the name survived the
// restart (nothing recomputed it yet), but the FIRST later split recomputed
// the name from the pane sessions and the rename was gone.
//
// REAL in this VM: tabs.js (_restoreSplitTab, the profiles restore callback
// driving createTabSilent, _updateTabName, addPaneRelativeTo), tab-title-
// utils.js (resolveTabName) and split-layout serialization, via
// tests/helpers/renderer-vm.mjs. Faked per the harness, plus: ipcRenderer
// gains a once() recorder and a resolving invoke so TabManager.init() and
// the real profiles-restore callback can run (the harness invoke never
// resolves, which would park the async callback before any restore work).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

// _restoreSplitTab deserializes its splitRoot through tab-serialize.js. The
// shared harness does not load that file (it is a pure dual-export module),
// so load it into the VM exactly the way the page's script tag does: in the
// VM `module` is undefined, the CJS branch is skipped and the two functions
// land as globals.
function loadVmWithSerialize() {
    const ctx = loadVm();
    const code = readFileSync(new URL('../src/renderer/tab-serialize.js', import.meta.url), 'utf8');
    vm.runInContext(code, ctx, { filename: 'tab-serialize.js' });
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

test('restored split tab with customName keeps the manual rename over pane joins', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData({ customName: true }));
    assert.equal(tab._customName, true, 'rename lock restored');
    assert.equal(tab.name, 'Deploy box', 'pane-name join must not overwrite the restored rename');

    // Later pane churn (the next _updateTabName trigger) still respects the lock.
    ctx.getAllPanes(tab)[0].name = 'renamed-pane';
    ctx.TabManager._updateTabName(tab);
    assert.equal(tab.name, 'Deploy box', 'the lock holds after restore-time churn');
});

test('restored split tab without customName still auto-joins pane names (guard)', () => {
    const ctx = loadVmWithSerialize();
    const tab = ctx.TabManager._restoreSplitTab(splitTabData());
    assert.ok(!tab._customName, 'no lock without a persisted customName');
    assert.equal(tab.name, 'alpha | beta', 'auto naming keeps working for unlocked tabs');
});

test('restored single tab with customName keeps the lock through a later split', async () => {
    const ctx = loadVmWithSerialize();
    let profilesFn = null;
    ctx.ipcRenderer.once = (ch, fn) => { if (ch === 'profiles') profilesFn = fn; };
    ctx.ipcRenderer.invoke = (cmd) => Promise.resolve(cmd === 'get-local-shells' ? [] : {});
    ctx.TabManager.init();
    assert.ok(profilesFn, 'profiles restore handler registered');

    // The single-tab restore path (createTabSilent branch of the profiles
    // callback), fed exactly what saveConfig persisted for a renamed tab.
    await profilesFn({}, {
        profiles: [], sshProfiles: [],
        lastTabs: [{ name: 'Work', type: 'local', command: 'powershell.exe', args: [], customName: true }],
    });
    const tab = ctx.TabManager.tabs[0];
    assert.ok(tab, 'tab restored');
    assert.equal(tab._customName, true, 'rename lock restored on the single-tab path');
    assert.equal(tab.name, 'Work');

    // The variant from the report: backend arrives, the tab is split, and a
    // pane gets its own session name — the rename must still win.
    ctx.wireTerminal(tab, 'local_1');
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const panes = ctx.getAllPanes(tab);
    assert.equal(panes.length, 2, 'split built');
    panes[1].name = 'pwsh-session'; // session naming arriving for the new pane
    ctx.TabManager._updateTabName(tab);
    assert.equal(tab.name, 'Work', 'the lock survives the later split');
});
