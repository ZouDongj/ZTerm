// SFTP panel regressions: transfer-flyout session labels and the panel header
// must resolve SPLIT-pane sessions (a split tab's own tabId is structurally
// null; the session lives on its panes). Driven through the REAL
// src/renderer/sftp.js in the shared VM seam — only the environment is faked
// (synthetic sessions and split trees; no real SSH or files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

// Register a split tab with two SSH panes in the REAL TabManager registry
// (leaf nodes carry the backend session ids; the tab itself carries none).
function pushSplitTab(ctx) {
    ctx.TabManager.tabs.push({
        id: 'tabSplit', tabId: null, name: 'Split Host', type: 'ssh',
        splitRoot: {
            orientation: 'row',
            ratios: [0.5, 0.5],
            children: [
                { id: 'paneL', tabId: 'sessL', name: 'Left Pane', type: 'ssh', focused: true },
                { id: 'paneR', tabId: 'sessR', name: 'Right Pane', type: 'ssh', focused: false },
            ],
        },
    });
}

async function openOn(vm, tabId, path, files) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === tabId)[0], { path, files: files || [] });
    await vm.drain();
    await p;
}

test('transfer session labels resolve split-pane sessions to their pane names', async () => {
    const vm = await loadSftpVm();
    pushSplitTab(vm.ctx);

    const idL = vm.TransferManager.add('a.txt', 'upload', 'sessL');
    const idR = vm.TransferManager.add('b.txt', 'upload', 'sessR');
    const byId = (id) => vm.TransferManager._transfers.find(t => t.id === id);
    assert.equal(byId(idL).sessionLabel, 'Left Pane', 'left pane transfer labeled with its pane name');
    assert.equal(byId(idR).sessionLabel, 'Right Pane', 'right pane transfer labeled with its pane name');
    assert.notEqual(byId(idL).sessionLabel, byId(idR).sessionLabel,
        'two split sessions must not collapse into one identical label');

    const groups = vm.TransferManager._groups();
    // The VM realm's Array prototype differs from the test realm's: compare
    // through a realm-local copy instead of deepEqual on the raw array.
    assert.deepEqual(Array.from(groups, g => g.label).sort(), ['Left Pane', 'Right Pane'],
        `flyout groups show the pane names: ${JSON.stringify(groups.map(g => g.label))}`);
});

test('transfer session label keeps non-split and closed-session behavior (control)', async () => {
    const vm = await loadSftpVm();
    pushSplitTab(vm.ctx);

    const plain = vm.TransferManager.add('a.txt', 'upload', 'sessA');
    assert.equal(vm.TransferManager._transfers.find(t => t.id === plain).sessionLabel, 'Host A',
        'non-split session still labeled with its tab name');

    const gone = vm.TransferManager.add('b.txt', 'upload', 'sessGone');
    assert.equal(vm.TransferManager._transfers.find(t => t.id === gone).sessionLabel, '已关闭会话',
        'unknown session still falls back to the closed-session label');

    // A split pane without its own name falls back to the tab's name.
    vm.ctx.TabManager.tabs.push({
        id: 'tabSplit2', tabId: null, name: 'Unnamed Panes Host', type: 'ssh',
        splitRoot: { id: 'paneOnly', tabId: 'sessSolo', type: 'ssh' },
    });
    const solo = vm.TransferManager.add('c.txt', 'upload', 'sessSolo');
    assert.equal(vm.TransferManager._transfers.find(t => t.id === solo).sessionLabel, 'Unnamed Panes Host',
        'nameless pane labeled with its split tab name');
});
