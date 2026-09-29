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

test('panel header names the split-pane session being browsed', async () => {
    const vm = await loadSftpVm();
    pushSplitTab(vm.ctx);
    const connEl = vm.ctx.document.getElementById('sftp-conn');

    await openOn(vm, 'sessA', '/home/a', []);
    assert.equal(connEl.textContent, 'Host A', 'non-split header (control)');

    await openOn(vm, 'sessL', '/home/l', []);
    assert.equal(connEl.textContent, 'Left Pane',
        `header must switch to the split pane session, not keep the stale name (saw: ${connEl.textContent})`);

    await openOn(vm, 'sessR', '/home/r', []);
    assert.equal(connEl.textContent, 'Right Pane', 'header follows the other pane');
});

test('panel header falls back to the split tab name for a nameless pane', async () => {
    const vm = await loadSftpVm();
    vm.ctx.TabManager.tabs.push({
        id: 'tabSplit2', tabId: null, name: 'Unnamed Panes Host', type: 'ssh',
        splitRoot: { id: 'paneOnly', tabId: 'sessSolo', type: 'ssh' },
    });
    const connEl = vm.ctx.document.getElementById('sftp-conn');
    await openOn(vm, 'sessSolo', '/home/solo', []);
    assert.equal(connEl.textContent, 'Unnamed Panes Host');
});

// mkdir drives its inline row through markup-authored innerHTML; the helper
// materializes that input, so this reaches the REAL keydown handler.
function startMkdir(vm, name) {
    vm.SFTP.mkdir();
    const row = vm.ctx.document.getElementById('sftp-mkdir-row');
    assert.ok(row, 'mkdir row mounted');
    const input = row.children.find(c => c.tagName === 'INPUT');
    assert.ok(input, 'mkdir input materialized');
    input.value = name;
    input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
}

test('mkdir completion refresh does not supersede a newer in-flight navigation', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    startMkdir(vm, 'newdir');
    await vm.drain();
    const mk = vm.pending('sftp-mkdir')[0];
    assert.ok(mk && mk.args.tabId === 'sessA' && mk.args.path === '/srv/app/newdir',
        `mkdir dispatched to the current directory: ${mk && JSON.stringify(mk.args)}`);

    const nav = vm.SFTP.navigate('/srv/sub'); // user navigates while mkdir is in flight
    await vm.drain();
    vm.settle(mk, {}); // mkdir succeeds; its completion must NOT refresh over the navigation
    await vm.drain();

    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 0,
        `no stale /srv/app refresh issued by the mkdir completion: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    const navRd = vm.pending('sftp-readdir', k => k.args.path === '/srv/sub')[0];
    assert.ok(navRd, 'user navigation still pending');
    vm.settle(navRd, { files: [{ name: 'sub.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await nav;
    assert.equal(vm.SFTP._path, '/srv/sub', 'newer user navigation wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('sub.txt')), 'newer navigation rendered');
    assert.ok(vm.toasts.some(t => t.msg === '目录已创建'), 'mkdir success still reported');
});

test('mkdir completion with a quiet view refreshes the current directory (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    startMkdir(vm, 'newdir');
    await vm.drain();
    const mk = vm.pending('sftp-mkdir')[0];
    vm.settle(mk, {});
    await vm.drain();

    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessA' && rd.args.path === '/srv/app',
        `mkdir completion re-lists the current directory: ${rd && JSON.stringify(rd.args)}`);
    vm.settle(rd, { files: [{ name: 'newdir', isDir: true, size: 0, mtime: 0 }] });
    await vm.drain();
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('newdir')), 'created directory visible after refresh');
});
