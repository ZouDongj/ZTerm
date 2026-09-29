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

test('breadcrumb path edit is refused while a user navigation or open is loading', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    const nav = vm.SFTP.navigate('/srv/sub'); // user navigation in flight
    await vm.drain();
    vm.SFTP._editPath(); // double-click during the load
    assert.equal(vm.SFTP._editingPath, false, 'editor entry refused while a user navigation owns the view');
    assert.ok(!vm.els.breadcrumb.children.some(c => c.tagName === 'INPUT'), 'no editor input mounted');

    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    await nav;

    vm.SFTP._editPath(); // after the load the address bar is editable again
    assert.equal(vm.SFTP._editingPath, true, 'editor opens once the navigation settled');
    assert.ok(vm.els.breadcrumb.children.some(c => c.tagName === 'INPUT'), 'editor input mounted');
    // End the edit. Fake-DOM modeling note: _renderBreadcrumb's innerHTML=''
    // clears the input in a real DOM but not in the seam, so model the
    // removal before the re-render (as existing tests do with slice marks).
    vm.els.breadcrumb.children.length = 0;
    vm.SFTP._renderBreadcrumb();

    const p = vm.SFTP.open('sessB'); // panel rebound; open load in flight
    await vm.drain();
    vm.SFTP._editPath();
    assert.equal(vm.SFTP._editingPath, false, 'editor entry refused during the open load');
    vm.settle(vm.pending('sftp-open')[0], { path: '/home/b', files: [] });
    await vm.drain();
    await p;
    vm.SFTP._editPath();
    assert.equal(vm.SFTP._editingPath, true, 'editor opens after the open load settled');
});

test('breadcrumb path edit still opens during a background cwd follow (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.equal(vm.pending('sftp-readdir').length, 1, 'follow in flight');
    vm.SFTP._editPath();
    assert.equal(vm.SFTP._editingPath, true, 'a background follow does not block the editor');
    vm.settle(vm.pending('sftp-readdir')[0], { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._editingPath, true, 'follow completion preserves the editor');
});

test('dropping a folder is rejected up front: no transfer entry, no start toast', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.statAnswers.push({ isDir: true, isFile: false });
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/dir' }] },
    });
    await vm.drain();
    assert.equal(vm.of('sftp-upload').length, 0, 'a folder never reaches the upload command');
    assert.equal(vm.TransferManager._transfers.length, 0, 'no transfer entry created for the folder');
    assert.ok(!vm.toasts.some(t => t.msg.includes('开始上传')),
        `no start toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    assert.equal(vm.toasts.filter(t => t.msg.includes('暂不支持上传文件夹') && t.isErr).length, 1,
        `exactly one folder rejection toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('dropping a regular file passes the stat guard and uploads (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.statAnswers.push({ isDir: false, isFile: true });
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }] },
    });
    await vm.drain();
    const up = vm.pending('sftp-upload')[0];
    assert.ok(up && up.args.localPath === 'D:/synthetic/one.txt', 'file proceeds to upload');
    assert.ok(vm.toasts.some(t => t.msg.includes('开始上传')), 'start toast for a real file');
    vm.settle(up, {});
    await vm.drain();
});

test('a mixed drop rejects the folder and uploads the file', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.statAnswers.push({ isDir: true, isFile: false }, { isDir: false, isFile: true });
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/dir' }, { path: 'D:/synthetic/one.txt' }] },
    });
    await vm.drain();
    const uploads = vm.pending('sftp-upload');
    assert.equal(uploads.length, 1, 'only the file reaches the upload command');
    assert.equal(uploads[0].args.localPath, 'D:/synthetic/one.txt');
    assert.equal(vm.TransferManager._transfers.length, 1, 'one transfer entry (the file)');
    assert.ok(vm.toasts.some(t => t.msg.includes('暂不支持上传文件夹')), 'folder rejected with its toast');
    vm.settle(uploads[0], {});
    await vm.drain();
});

test('a failed stat falls through to the backend init guard (fail-open)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.statAnswers.push({ error: 'access denied' });
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/gone.txt' }] },
    });
    await vm.drain();
    const up = vm.pending('sftp-upload')[0];
    assert.ok(up, 'upload still dispatched; the backend init guard remains the backstop');
    vm.settle(up, { error: 'stat: access denied' });
    await vm.drain();
    assert.ok(vm.toasts.some(t => t.msg.includes('上传失败')), 'backend rejection reported');
});
