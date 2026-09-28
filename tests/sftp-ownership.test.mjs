// SFTP ownership regressions (batch 06): operation target stability, error
// paths obeying the ownership check, listings never crossing sessions, and
// cwd-follow behavior. All driven through the REAL src/renderer/sftp.js (plus
// the real renderer stack) in the shared VM seam — only the environment is
// faked (deferred ipcRenderer.invoke controller, recorded toasts, synthetic
// sessions sessA/sessB, synthetic paths; no real SSH, files, dialogs or
// clipboard). Async orderings are driven by explicit promise settlement.
//
// The fake backend mirrors zterm.rs find_sftp -> Err("SFTP not available"):
// sftp-upload addressed to a null/unknown session rejects; a correctly
// captured live session succeeds — a correct fix passes, only wrong-target
// dispatches fail. A correct fix may also legitimately SKIP an obsolete
// refresh; assertions protect the user invariant instead of forcing an
// unnecessary request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nodeVm from 'node:vm';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const LIVE_SESSIONS = new Set(['sessA', 'sessB']);

// Settle an sftp-upload the way the real backend would: wrong/null session
// rejects with the Err string the Rust side returns; a live session succeeds.
function fakeBackendSettleUpload(vm, call) {
    if (!LIVE_SESSIONS.has(call?.args?.tabId)) vm.fail(call, 'SFTP not available');
    else vm.settle(call, {});
}

async function openOn(vm, tabId, path, files) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === tabId)[0], { path, files: files || [] });
    await vm.drain();
    await p;
}

// Unwind every still-pending invoke with a benign settlement (bounded rounds:
// each settlement can chain at most one follow-up request). Used AFTER the
// assertions so awaited product promises (upload loops, refreshes) can settle
// without inventing backend semantics the test no longer cares about.
async function flush(vm) {
    for (let i = 0; i < 10; i++) {
        const open = vm.calls.filter(c => !c.settled);
        if (!open.length) break;
        for (const c of open) vm.settle(c, c.cmd === 'sftp-upload' ? {} : { files: [] });
        await vm.drain();
    }
}

// ── D1: upload batch operation target is stable ─────────────────────────────

test('upload batch keeps the session/path captured at start across a panel rebind (A -> B)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    assert.equal(vm.SFTP._tabId, 'sessA');

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['C:/tmp/f1.txt', 'C:/tmp/f2.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];
    assert.ok(u1 && u1.args.tabId === 'sessA' && u1.args.remotePath === '/srv/app/f1.txt',
        `file 1 dispatched to owning session A at /srv/app: ${u1 && JSON.stringify(u1.args)}`);

    vm.SFTP.close();
    await openOn(vm, 'sessB', '/home/bob', []);
    assert.equal(vm.SFTP._tabId, 'sessB');

    vm.settle(u1, {}); // file 1 finishes while the panel shows B
    await vm.drain();
    // Valid fixes may refresh A or skip the refresh; mutating B through A's
    // stale completion callback is not allowed.
    const staleRefreshOfB = vm.pending('sftp-readdir', k => k.args.tabId === 'sessB');
    assert.equal(staleRefreshOfB.length, 0, `no sessB readdir from A's completion: ${JSON.stringify(staleRefreshOfB.map(r => r.args))}`);
    for (const r of vm.pending('sftp-readdir')) vm.settle(r, { files: [] });
    await vm.drain();

    const u2 = vm.pending('sftp-upload')[0];
    assert.ok(u2 && u2.args.tabId === 'sessA' && u2.args.remotePath === '/srv/app/f2.txt',
        `queued file 2 uploads to the session captured at batch start: ${u2 && JSON.stringify(u2.args)}`);
    fakeBackendSettleUpload(vm, u2);
    await vm.drain();
    await flush(vm);
    await up;
    assert.ok(!vm.toasts.some(t => t.msg.includes('上传失败')), `no upload failure: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('upload batch survives panel close without rebind (owner session still alive)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['C:/tmp/f1.txt', 'C:/tmp/f2.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];
    assert.equal(u1.args.tabId, 'sessA');

    vm.SFTP.close(); // panel closed, session A alive, transfers are background work
    vm.settle(u1, {});
    await vm.drain();

    const u2 = vm.pending('sftp-upload')[0];
    assert.ok(u2 && u2.args.tabId === 'sessA', `queued file 2 still targets its owning session: ${u2 && JSON.stringify(u2.args)}`);
    fakeBackendSettleUpload(vm, u2);
    await vm.drain();
    await up;
    assert.ok(!vm.toasts.some(t => t.msg.includes('上传失败')), `no upload failure toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    assert.ok(!vm.ctx.__sends.some(s => s.cmd === 'sftp-cancel-transfer'),
        `queued transfer not cancelled behind the user's back: ${JSON.stringify(vm.ctx.__sends.map(s => s.cmd))}`);
});

test('undisturbed multi-file upload stays on the owner and refreshes its listing (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['C:/tmp/f1.txt', 'C:/tmp/f2.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];
    vm.settle(u1, {});
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessA' && rd.args.path === '/srv/app',
        `undisturbed completion refresh re-lists sessA /srv/app: ${rd && JSON.stringify(rd.args)}`);
    vm.settle(rd, { files: [{ name: 'f1.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('f1.txt')), 'completed upload visible after refresh');

    const u2 = vm.pending('sftp-upload')[0];
    assert.ok(u2 && u2.args.tabId === 'sessA' && u2.args.remotePath === '/srv/app/f2.txt',
        `file 2 uploads to sessA /srv/app/f2.txt: ${u2 && JSON.stringify(u2.args)}`);
    fakeBackendSettleUpload(vm, u2);
    await vm.drain();
    await flush(vm);
    await up;
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.tabId === 'sessA' && r.args.path === '/srv/app').length, 2,
        'per-file completion refresh preserved for the undisturbed batch');
});

test('dropped-path uploads carry the same owner snapshot; completion never refreshes the rebound panel', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    // Real drop handler -> real _handleDroppedPaths with synthetic local paths
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {},
        dataTransfer: { files: [{ path: 'C:/tmp/d1.txt' }, { path: 'C:/tmp/d2.txt' }] },
    });
    await vm.drain();
    const dropped = vm.pending('sftp-upload');
    assert.equal(dropped.length, 2, 'both dropped files upload');
    for (const d of dropped) {
        assert.ok(d.args.tabId === 'sessA' && d.args.remotePath === '/srv/app/' + d.args.localPath.split('/').pop(),
            `dropped upload addressed to the panel owner: ${JSON.stringify(d.args)}`);
    }

    vm.SFTP.close();
    await openOn(vm, 'sessB', '/home/bob', []);
    for (const d of dropped) { vm.settle(d, {}); await vm.drain(); }
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.tabId === 'sessB').length, 0,
        `no sessB readdir from dropped-upload completions: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    assert.ok(!vm.toasts.some(t => t.msg.includes('上传失败')), `no upload failure: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('upload completion refresh does not supersede a newer in-flight manual navigation', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['C:/tmp/f1.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];

    const nav = vm.SFTP.navigate('/srv/sub'); // user navigates; readdir in flight
    await vm.drain();
    vm.settle(u1, {}); // upload completes while the navigation is pending
    await vm.drain();

    // A valid fix skips the obsolete refresh: the only readdir is the user's.
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 0,
        `no stale /srv/app refresh issued by the completion: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    const navRd = vm.pending('sftp-readdir', k => k.args.path === '/srv/sub')[0];
    assert.ok(navRd, 'user navigation still pending');
    vm.settle(navRd, { files: [{ name: 'sub.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await flush(vm);
    await up; await nav;
    assert.equal(vm.SFTP._path, '/srv/sub', 'newer user navigation wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('sub.txt')), 'newer navigation rendered');
});

test('upload completion refresh does not supersede a newer in-flight cwd follow', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['C:/tmp/f1.txt'] });
    await vm.drain();
    const u1 = vm.pending('sftp-upload')[0];

    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' }); // shell cd'd; follow in flight
    await vm.drain();
    vm.settle(u1, {}); // upload completes while the follow readdir is pending
    await vm.drain();

    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 0,
        `no stale /srv/app refresh issued by the completion: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    const followRd = vm.pending('sftp-readdir', k => k.args.path === '/tmp')[0];
    assert.ok(followRd, 'cwd follow still pending');
    vm.settle(followRd, { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await flush(vm);
    await up;
    assert.equal(vm.SFTP._path, '/tmp', 'newer cwd follow wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('tmpfile.txt')), 'cwd follow rendered');
});

// ── D2: error paths obey the same ownership check as success paths ─────────

test('late rejection of a superseded open leaves the newer panel intact (A -> B)', async () => {
    const vm = await loadSftpVm();
    const pa = vm.SFTP.open('sessA');
    await vm.drain();
    vm.SFTP.close();
    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0],
        { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] });
    await vm.drain();
    await pb;
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('readme.md')), 'B listing rendered');

    vm.fail(vm.pending('sftp-open', k => k.args.tabId === 'sessA')[0], 'SFTP not available');
    await vm.drain();
    await pa;
    assert.ok(!vm.els.body.innerHTML.includes('加载失败') && vm.els.body.children.some(r => r.innerHTML.includes('readme.md')),
        `late rejection leaves B's listing on screen: ${JSON.stringify(vm.els.body.innerHTML)}`);
    assert.ok(!vm.toasts.some(t => t.msg.includes('无法打开 SFTP')),
        `no stale toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('late rejection of a superseded open is silent for the same backend (close/reopen A)', async () => {
    const vm = await loadSftpVm();
    const pa = vm.SFTP.open('sessA');
    await vm.drain();
    vm.SFTP.close();
    const pb = vm.SFTP.open('sessA'); // reopen on the same backend
    await vm.drain();
    const [firstOpen, secondOpen] = vm.of('sftp-open');
    vm.settle(secondOpen, { path: '/home/a', files: [{ name: 'afile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await pb;

    vm.fail(firstOpen, 'SFTP not available'); // the superseded request rejects late
    await vm.drain();
    await pa;
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('afile.txt')),
        `current listing intact: ${vm.els.body.children.map(r => r.innerHTML).join('|')}`);
    assert.ok(!vm.els.body.innerHTML.includes('加载失败'), 'no stale failure state');
    assert.ok(!vm.toasts.some(t => t.msg.includes('无法打开 SFTP')),
        `no stale toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('late SUCCESS of a superseded open renders nothing (existing guard, control)', async () => {
    const vm = await loadSftpVm();
    const pa = vm.SFTP.open('sessA');
    await vm.drain();
    vm.SFTP.close();
    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0],
        { path: '/home/bob', files: [{ name: 'readme.md', isDir: false, size: 3, mtime: 0 }] });
    await vm.drain();
    await pb;
    const mark = vm.els.body.children.length;

    vm.settle(vm.pending('sftp-open', k => k.args.tabId === 'sessA')[0],
        { path: '/home/alice', files: [{ name: 'afile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await pa;
    const fresh = vm.els.body.children.slice(mark);
    assert.equal(fresh.length, 0, `nothing rendered: ${JSON.stringify(fresh.map(r => r.innerHTML))}`);
    assert.ok(!vm.els.body.innerHTML.includes('home/alice') && vm.toasts.length === 0);
});

test('current-owner open rejection still reports the error (control)', async () => {
    const vm = await loadSftpVm();
    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    vm.fail(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], 'SFTP not available');
    await vm.drain();
    await pb;
    assert.ok(vm.toasts.some(t => t.msg.includes('无法打开 SFTP')), 'error still toasted');
    assert.ok(vm.els.body.innerHTML.includes('加载失败'), 'failure state shown');
});

test('superseded navigation rejection is silent; the current navigation still renders', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);

    const p1 = vm.SFTP.navigate('/srv/app/deep');
    await vm.drain();
    const p2 = vm.SFTP.navigate('/');
    await vm.drain();
    vm.fail(vm.pending('sftp-readdir', k => k.args.path === '/srv/app/deep')[0], 'connection reset');
    await vm.drain();
    assert.ok(!vm.toasts.some(t => t.msg.includes('无法访问')),
        `no stale navigation toast: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);

    vm.settle(vm.pending('sftp-readdir')[0], { files: [{ name: 'root.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await p1; await p2;
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('root.txt')), 'current navigation rendered');
});

// ── D3: listings never cross sessions ───────────────────────────────────────

test('failed pinned reopen (rejection) shows an honest failure state, never the previous session\'s rows', async () => {
    const vm = await loadSftpVm();
    // Pin B at /var/log through the normal control flow (healthy session).
    await openOn(vm, 'sessB', '/var/log', [{ name: 'syslog', isDir: false, size: 5, mtime: 0 }]);
    vm.SFTP.togglePin();
    assert.ok(vm.SFTP._pinned['sessB'] && vm.SFTP._pinnedPath['sessB'] === '/var/log');
    vm.SFTP.close();

    await openOn(vm, 'sessA', '/home/alice', [
        { name: 'report.txt', isDir: false, size: 9, mtime: 0 },
        { name: 'notes.txt', isDir: false, size: 4, mtime: 0 },
    ]);
    vm.SFTP.close();

    // Reopen B (pinned) while B's channel rejects.
    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessB' && rd.args.path === '/var/log',
        `pinned reopen navigates to the pinned path on B: ${rd && JSON.stringify(rd.args)}`);
    const mark = vm.els.body.children.length;

    vm.fail(rd, 'connection lost');
    await vm.drain();
    await pb;
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问')), 'failure still reported');
    const fresh = vm.els.body.children.slice(mark);
    assert.equal(fresh.length, 0, `no rows rendered into B's panel: ${JSON.stringify(fresh.map(r => r.innerHTML))}`);
    assert.ok(vm.els.body.innerHTML.includes('加载失败'), `honest failure state: ${JSON.stringify(vm.els.body.innerHTML)}`);

    // Consequence probe: no download attributed to sessB from any stale row.
    const staleRow = fresh.find(r => r.innerHTML.includes('report.txt'));
    let wrongDispatch = null;
    if (staleRow) {
        staleRow.dispatch('click', {});
        await vm.drain();
        const dlg = vm.pending('show-save-dialog')[0];
        if (dlg) {
            vm.settle(dlg, { canceled: false, filePath: 'C:/tmp/out.bin' });
            await vm.drain();
            const dl = vm.pending('sftp-download')[0];
            if (dl) { wrongDispatch = dl.args; vm.settle(dl, {}); await vm.drain(); }
        }
    }
    assert.ok(!(wrongDispatch && wrongDispatch.tabId === 'sessB'),
        `stale row cannot dispatch a download on session B: ${wrongDispatch && JSON.stringify(wrongDispatch)}`);
});

test('failed pinned reopen (live session, invalid directory -> {error}) shows the failure, not A\'s filenames', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessB', '/var/log', [{ name: 'syslog', isDir: false, size: 5, mtime: 0 }]);
    vm.SFTP.togglePin();
    vm.SFTP.close();
    await openOn(vm, 'sessA', '/home/alice', [{ name: 'report.txt', isDir: false, size: 9, mtime: 0 }]);
    vm.SFTP.close();

    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    const mark = vm.els.body.children.length;
    vm.settle(rd, { error: 'No such file' }); // structured error from a live backend
    await vm.drain();
    await pb;
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问') && t.msg.includes('No such file')),
        `structured error reported: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    assert.equal(vm.els.body.children.slice(mark).length, 0, 'no rows rendered after the reopen');
    assert.ok(vm.els.body.innerHTML.includes('加载失败'), 'honest failure state');
    // Fake-DOM modeling note: assigning innerHTML does not clear children in the
    // seam, so "what the panel shows" is the innerHTML string plus post-mark rows.
    assert.ok(!vm.els.body.innerHTML.includes('report.txt'), 'no cross-session filename in the shown state');
});

test('successful pinned reopen renders only the pinned session\'s rows (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessB', '/var/log', [{ name: 'syslog', isDir: false, size: 5, mtime: 0 }]);
    vm.SFTP.togglePin();
    vm.SFTP.close();
    await openOn(vm, 'sessA', '/home/alice', [{ name: 'report.txt', isDir: false, size: 9, mtime: 0 }]);
    vm.SFTP.close();

    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    const mark = vm.els.body.children.length;
    vm.settle(rd, { files: [{ name: 'syslog', isDir: false, size: 5, mtime: 0 }] });
    await vm.drain();
    await pb;
    const fresh = vm.els.body.children.slice(mark);
    assert.ok(fresh.some(r => r.innerHTML.includes('syslog')) && !fresh.some(r => r.innerHTML.includes('report.txt')),
        `only B's rows: ${JSON.stringify(fresh.map(r => r.innerHTML))}`);
});

test('non-pinned failed reopen shows a clean error state (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/home/alice', [{ name: 'report.txt', isDir: false, size: 9, mtime: 0 }]);
    vm.SFTP.close();
    const mark = vm.els.body.children.length;
    const pb = vm.SFTP.open('sessB');
    await vm.drain();
    vm.fail(vm.pending('sftp-open', k => k.args.tabId === 'sessB')[0], 'SFTP not available');
    await vm.drain();
    await pb;
    assert.ok(vm.els.body.innerHTML.includes('加载失败'));
    assert.equal(vm.els.body.children.length, mark, 'no stale rows');
});

test('ordinary failed navigation in a live panel retains its last valid listing (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);
    const p = vm.SFTP.navigate('/gone');
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir')[0], { error: 'No such file' });
    await vm.drain();
    await p;
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问')), 'error reported');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('app.log')), 'previous listing retained');
    assert.equal(vm.SFTP._path, '/srv/app', 'previous path retained');
});

// ── cwd follow: gating, ordering, pin and edit interplay ────────────────────

test('cwd follow navigates the matching open panel (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessA' && rd.args.path === '/tmp',
        `follow readdir addressed to the owning session: ${rd && JSON.stringify(rd.args)}`);
    vm.settle(rd, { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/tmp');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('tmpfile.txt')));
});

test('background other-session cwd events do not navigate the open panel (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessB', cwd: '/elsewhere' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 0, `no navigation dispatched: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    assert.equal(vm.SFTP._path, '/srv/app');
});

test('rapid cd A -> B -> A with reversed completions: latest desired cwd wins (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/a', [{ name: 'a-file', isDir: false, size: 1, mtime: 0 }]);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/b' });
    await vm.drain();
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/a' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 2, 'one readdir per follow');
    const [rd1, rd2] = vm.of('sftp-readdir');
    // Reversed completion: the LATER-issued request settles first and renders;
    // the earlier-issued response arrives last and must be dropped.
    vm.settle(rd2, { files: [{ name: 'latest-a', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    vm.settle(rd1, { files: [{ name: 'stale-b', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/a', 'latest desired cwd wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('latest-a')), 'latest listing rendered');
    assert.ok(!vm.els.body.children.some(r => r.innerHTML.includes('stale-b')), 'stale listing dropped');
});

test('cwd event while the panel is closed dispatches nothing (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.SFTP.close();
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 0, 'no navigation while closed');
});

test('events from a retired backend id do not steer the rebound panel (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.SFTP.close();
    // Simulated reconnect: same host, NEW backend session id.
    vm.ctx.TabManager.tabs.push({ id: 'tabA2', tabId: 'sessA2', name: 'Host A', type: 'ssh' });
    await openOn(vm, 'sessA2', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/old-session-dir' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 0, 'retired identity cannot navigate');
    vm.emit('sftp-cwd-changed', { tabId: 'sessA2', cwd: '/new-session-dir' });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessA2', 'current identity navigates');
    vm.settle(rd, { files: [] });
});

test('pinned session does not follow cwd; unpin resumes following (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.SFTP.togglePin();
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 0, 'pinned: no follow');
    vm.SFTP.togglePin(); // unpin
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.path === '/tmp', 'unpinned: follow resumes');
    vm.settle(rd, { files: [] });
});

test('pin during an in-flight follow keeps the pinned directory fixed (success variant)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.ok(vm.pending('sftp-readdir').length === 1, 'follow in flight');

    vm.SFTP.togglePin(); // user pins while the follow readdir is pending
    assert.equal(vm.SFTP._pinnedPath['sessA'], '/srv/app');
    const rd = vm.pending('sftp-readdir')[0];
    vm.settle(rd, { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();

    assert.equal(vm.SFTP._path, '/srv/app', 'pinned directory stays fixed');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('app.log')), 'pinned listing still shown');
    assert.ok(!vm.els.body.children.some(r => r.innerHTML.includes('tmpfile.txt')), 'stale follow result not rendered');
    assert.ok(!vm.els.body.innerHTML.includes('加载中'), 'not stuck on the loading state');
});

test('pin during an in-flight follow keeps the pin intact when the follow rejects', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    vm.SFTP.togglePin();
    const toastsBefore = vm.toasts.length;
    vm.fail(vm.pending('sftp-readdir')[0], 'connection reset');
    await vm.drain();
    assert.equal(vm.toasts.length, toastsBefore, `no error toast for the dropped follow: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    assert.equal(vm.SFTP._path, '/srv/app', 'pinned directory stays fixed');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('app.log')), 'pinned listing still shown');
});

test('a follow does not destroy an in-progress breadcrumb path edit', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.SFTP._editPath(); // double-click the breadcrumb: input focused, user typing
    const input = vm.els.breadcrumb.children[vm.els.breadcrumb.children.length - 1];
    assert.equal(input.className, 'sftp-path-input inline-edit', 'edit input mounted');

    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').length, 0, `no follow navigation while editing: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    assert.ok(vm.els.breadcrumb.children.includes(input), 'edit input still mounted');
});

test('follow failure in a live panel retains the last valid listing and reports the error (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/gone' });
    await vm.drain();
    vm.fail(vm.pending('sftp-readdir')[0], 'connection reset');
    await vm.drain();
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问')), 'genuine error reported');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('app.log')), 'last valid listing retained');
    assert.equal(vm.SFTP._path, '/srv/app');
});

test('follow failure before any listing shows an honest failure state, not a fake empty directory', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA'); // initial listing still in flight
    await vm.drain();
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/just-cd' });
    await vm.drain();
    const followRd = vm.pending('sftp-readdir', k => k.args.path === '/just-cd')[0];
    assert.ok(followRd, 'follow issued while the open is pending');
    vm.fail(followRd, 'connection reset');
    await vm.drain();
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问')), 'genuine error reported');
    assert.ok(vm.els.body.innerHTML.includes('加载失败'),
        `honest failure state instead of a misleading empty directory: ${JSON.stringify(vm.els.body.innerHTML)}`);
    assert.ok(!vm.els.body.innerHTML.includes('空目录'), 'no fake successful empty listing');
    // The superseded open response must not overwrite the failure state.
    vm.settle(vm.pending('sftp-open')[0], { path: '/home/a', files: [{ name: 'homefile', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await p;
    assert.ok(!vm.els.body.children.some(r => r.innerHTML.includes('homefile')), 'superseded open response dropped');
});

test('initial open while a cwd arrives: the follow result renders, the stale open response is dropped (control)', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    await vm.drain();
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const followRd = vm.pending('sftp-readdir', k => k.args.path === '/tmp')[0];
    assert.ok(followRd);
    vm.settle(followRd, { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    vm.settle(vm.pending('sftp-open')[0], { path: '/home/a', files: [{ name: 'homefile', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await p;
    assert.equal(vm.SFTP._path, '/tmp', 'newest cwd wins over the in-flight open');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('tmpfile.txt')));
});

test('cwd paths with spaces round-trip through the real navigate (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/opt/my app/logs' });
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.path === '/opt/my app/logs', `path preserved verbatim: ${rd && JSON.stringify(rd.args)}`);
    vm.settle(rd, { files: [{ name: 'a log.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._path, '/opt/my app/logs');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('a log.txt')));
});

// ── batch 06 correction 1: main's ported actual-method counterexamples ──────
// Four acceptance failures found by main against the first implementation,
// ported verbatim in method (REAL product code paths, same settlement
// orderings), plus the positive controls the correction asks for. The REAL
// closeOverlay of utils.js is executed in the VM because the shared seam does
// not load utils.js — the extraction mirrors the global close routes' actual
// class-removal behavior instead of modeling it.

test('the real overlay-close route suppresses the late open failure of the hidden panel', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    await vm.drain();
    const utilsSrc = readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8');
    const start = utilsSrc.indexOf('function closeOverlay(id)');
    const end = utilsSrc.indexOf('function openOverlay(id)', start);
    assert.ok(start >= 0 && end > start, 'real closeOverlay located in utils.js');
    nodeVm.runInContext(utilsSrc.slice(start, end) + '; closeOverlay("overlay-sftp");', vm.ctx);
    assert.equal(vm.SFTP.isOpen, false, 'overlay closed through the real route');

    vm.fail(vm.pending('sftp-open')[0], 'connection lost');
    await vm.drain();
    await p;
    assert.equal(vm.toasts.length, 0, `closed panel must not emit its obsolete error: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
    assert.ok(!vm.els.body.innerHTML.includes('加载失败'), 'closed panel must not render its obsolete failure state');

    // Control: the suppression is ownership-based, not a broken error path —
    // a visible panel's own failure keeps its real feedback.
    const p2 = vm.SFTP.open('sessA');
    await vm.drain();
    vm.fail(vm.pending('sftp-open')[0], 'connection lost');
    await vm.drain();
    await p2;
    assert.ok(vm.toasts.some(t => t.msg.includes('无法打开 SFTP')), 'visible-owner failure still toasts');
    assert.ok(vm.els.body.innerHTML.includes('加载失败'), 'visible-owner failure state shown');
});

test('a follow already in flight preserves an editor opened afterwards', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const follow = vm.pending('sftp-readdir')[0];
    assert.ok(follow, 'follow in flight');
    vm.SFTP._editPath(); // the user opens the editor AFTER the follow started
    assert.equal(vm.SFTP._editingPath, true);
    const input = vm.els.breadcrumb.children[vm.els.breadcrumb.children.length - 1];
    input.value = '/typed/path';

    vm.settle(follow, { files: [{ name: 'tmpfile.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._editingPath, true, 'completion must preserve the active editor');
    assert.ok(vm.els.breadcrumb.children.includes(input), 'editor input still mounted');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('tmpfile.txt')), 'followed listing rendered behind the editor');
    assert.ok(!vm.els.body.innerHTML.includes('加载中'), 'body not stuck on the loading state');

    // Control: normal editing completion still works on the preserved editor.
    input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await vm.drain();
    const nav = vm.pending('sftp-readdir', k => k.args.path === '/typed/path')[0];
    assert.ok(nav, 'typed path navigation dispatched');
    vm.settle(nav, { files: [] });
    await vm.drain();
    assert.equal(vm.SFTP._editingPath, false, 'the edit ends when its navigation completes');
    assert.equal(vm.SFTP._path, '/typed/path', 'typed path rendered');
    assert.equal(vm.els.breadcrumb.children[vm.els.breadcrumb.children.length - 1].textContent, 'path',
        'breadcrumb re-rendered from the navigated path');
});

test('escape after a preserved edit restores the breadcrumb of the followed directory (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/tmp' });
    await vm.drain();
    const follow = vm.pending('sftp-readdir')[0];
    vm.SFTP._editPath();
    const input = vm.els.breadcrumb.children[vm.els.breadcrumb.children.length - 1];
    input.value = '/typed/path';
    vm.settle(follow, { files: [] });
    await vm.drain();

    input.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await vm.drain();
    assert.equal(vm.SFTP._editingPath, false, 'escape ends the edit');
    assert.equal(vm.SFTP._path, '/tmp', 'panel state followed the cwd while the edit was protected');
    // Fake-DOM modeling note: assigning innerHTML does not clear children, so
    // "the editor is gone" is asserted on the freshly rendered breadcrumb spans
    // (the last children after the restore), not on absence of the old input.
    const restored = vm.els.breadcrumb.children.slice(-1)[0];
    assert.ok(restored && restored.tagName === 'SPAN' && restored.textContent === 'tmp',
        `breadcrumb restored to the followed directory: ${JSON.stringify(vm.els.breadcrumb.children.map(s => s.textContent))}`);
});

test('a follow rejection while editing preserves the editor and the last valid listing', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [{ name: 'app.log', isDir: false, size: 2, mtime: 0 }]);
    vm.emit('sftp-cwd-changed', { tabId: 'sessA', cwd: '/gone' });
    await vm.drain();
    const follow = vm.pending('sftp-readdir')[0];
    vm.SFTP._editPath();

    vm.fail(follow, 'connection reset');
    await vm.drain();
    assert.equal(vm.SFTP._editingPath, true, 'a failed follow must not destroy the editor either');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('app.log')), 'last valid listing retained');
    assert.ok(!vm.els.body.innerHTML.includes('加载中'), 'body not stuck on the loading state');
    assert.ok(vm.toasts.some(t => t.msg.includes('无法访问')), 'visible-owner follow failure still reports');
});

test("a superseded session's stale open does not suppress the current view's upload refresh", async () => {
    const vm = await loadSftpVm();
    const oldOpen = vm.SFTP.open('sessA'); // A's open stays slow
    await vm.drain();
    const old = vm.pending('sftp-open')[0];
    vm.SFTP.close();
    await openOn(vm, 'sessB', '/home/bob', []);

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/new.txt'] });
    await vm.drain();
    const upload = vm.pending('sftp-upload')[0];
    assert.equal(upload.args.tabId, 'sessB');
    vm.settle(upload, {});
    await vm.drain();
    const refresh = vm.pending('sftp-readdir', k => k.args.tabId === 'sessB')[0];
    assert.ok(refresh, 'a current view with no current load must refresh after upload');
    vm.settle(refresh, { files: [{ name: 'new.txt', isDir: false, size: 1, mtime: 0 }] });

    vm.settle(old, { path: '/old', files: [] }); // A's request resolves only now
    await vm.drain();
    await Promise.all([up, oldOpen]);
    assert.equal(vm.SFTP._viewReq, null, `stale finally blocks must not corrupt the loading identity: ${JSON.stringify(vm.SFTP._viewReq)}`);
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('new.txt')), 'refresh rendered');

    // Control: the counter stays healthy after the stale finally — a second
    // quiet-view upload on B still refreshes.
    const up2 = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/newer.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    assert.ok(vm.pending('sftp-readdir', k => k.args.tabId === 'sessB').length > 0, 'next upload refresh still fires');
    await flush(vm);
    await up2;
    assert.ok(!vm.toasts.some(t => t.msg.includes('上传失败')), `no upload failure: ${JSON.stringify(vm.toasts.map(t => t.msg))}`);
});

test('overlapping dropped uploads eventually list every completed file', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }, { path: 'D:/synthetic/two.txt' }] },
    });
    await vm.drain();
    const [one, two] = vm.pending('sftp-upload');
    assert.ok(one && two, 'real drop handler starts both uploads');
    vm.settle(one, {});
    await vm.drain();
    const firstListing = vm.pending('sftp-readdir')[0];
    assert.ok(firstListing, 'first completion starts a listing request');
    vm.settle(two, {});
    await vm.drain();
    vm.settle(firstListing, { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    for (const request of vm.pending('sftp-readdir')) {
        vm.settle(request, { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }, { name: 'two.txt', isDir: false, size: 2, mtime: 0 }] });
    }
    await vm.drain();
    assert.deepEqual(Array.from(vm.SFTP._files, f => f.name).sort(), ['one.txt', 'two.txt'],
        'final listing contains every completed upload');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('two.txt')), 'second completed file visible');
});

test('a single dropped upload refreshes the unchanged view directly (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }] },
    });
    await vm.drain();
    const one = vm.pending('sftp-upload')[0];
    assert.ok(one, 'drop starts the upload');
    vm.settle(one, {});
    await vm.drain();
    const rd = vm.pending('sftp-readdir')[0];
    assert.ok(rd && rd.args.tabId === 'sessA' && rd.args.path === '/srv/app',
        `completion refresh re-lists the owner view: ${rd && JSON.stringify(rd.args)}`);
    vm.settle(rd, { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('one.txt')), 'uploaded file visible');
});

test('the coalesced upload refresh never supersedes a newer user navigation (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }, { path: 'D:/synthetic/two.txt' }] },
    });
    await vm.drain();
    const [one, two] = vm.pending('sftp-upload');

    const nav = vm.SFTP.navigate('/srv/sub'); // the user leaves the view while uploads run
    await vm.drain();
    vm.settle(one, {});
    await vm.drain();
    vm.settle(two, {});
    await vm.drain();
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 0,
        `no upload refresh of the abandoned view: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
    const navRd = vm.pending('sftp-readdir', k => k.args.path === '/srv/sub')[0];
    assert.ok(navRd, 'user navigation still pending');
    vm.settle(navRd, { files: [{ name: 'sub.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await flush(vm);
    await nav;
    assert.equal(vm.SFTP._path, '/srv/sub', 'newer user navigation wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('sub.txt')), 'newer navigation rendered');
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 0,
        'no cleanup readdir of the abandoned view ever fired');
});

// ── batch 06 correction 2: main's residual actual-method counterexamples ─────
// Two acceptance failures main observed against correction 1, ported in method
// (REAL product code paths, same settlement orderings), plus the stale-finally
// control this correction asks for. Contract under correction: the view's
// loading state follows the LATEST view request of the current binding (an
// obsolete same-binding request no longer counts), and each upload refresh run
// may only clear/drain its own in-flight slot — never a successor view's.

test('an obsolete navigation in the same binding cannot permanently suppress an upload refresh', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/initial', []);
    const slow = vm.SFTP.navigate('/slow');
    await vm.drain();
    const old = vm.pending('sftp-readdir', k => k.args.path === '/slow')[0];
    const fast = vm.SFTP.navigate('/fast');
    await vm.drain();
    vm.settle(vm.pending('sftp-readdir', k => k.args.path === '/fast')[0], { files: [] });
    await vm.drain();
    await fast;
    assert.equal(vm.SFTP._path, '/fast');

    const up = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/new.txt'] });
    await vm.drain();
    assert.equal(vm.pending('sftp-upload')[0].args.remotePath, '/fast/new.txt');
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await up;

    vm.settle(old, { files: [] }); // the superseded /slow request resolves only now
    await vm.drain();
    await slow;
    await vm.drain();
    assert.ok(vm.pending('sftp-readdir', k => k.args.path === '/fast').length,
        'new file needs a refresh after all navigations settle; the old request is obsolete');
    await flush(vm);
});

test('an old binding upload-refresh does not delay a healthy new binding refresh', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/a', []);
    const upA = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/old.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await upA;
    const oldRefresh = vm.pending('sftp-readdir', k => k.args.tabId === 'sessA')[0];
    assert.ok(oldRefresh, 'A owns a slow upload-refresh');

    vm.SFTP.close();
    await openOn(vm, 'sessB', '/b', []);
    const upB = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/new.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await upB;
    assert.equal(vm.of('sftp-upload').at(-1).args.tabId, 'sessB');
    const newRefresh = vm.pending('sftp-readdir', k => k.args.tabId === 'sessB')[0];

    vm.settle(oldRefresh, { files: [] });
    await vm.drain();
    assert.ok(newRefresh, 'B must not depend on unrelated A refresh completion');
    await flush(vm);
});

test("a stale refresh finally cannot clear a newer binding's active refresh (control)", async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/a', []);
    const upA = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/a.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await upA;
    const aRefresh = vm.pending('sftp-readdir', k => k.args.tabId === 'sessA')[0];
    assert.ok(aRefresh, 'A owns a slow upload-refresh');

    vm.SFTP.close();
    await openOn(vm, 'sessB', '/b', []);
    const upB = vm.SFTP.upload();
    await vm.drain();
    vm.settle(vm.pending('show-open-dialog')[0], { canceled: false, filePaths: ['D:/synthetic/b.txt'] });
    await vm.drain();
    vm.settle(vm.pending('sftp-upload')[0], {});
    await vm.drain();
    await upB;
    const bRefresh = vm.pending('sftp-readdir', k => k.args.tabId === 'sessB')[0];
    assert.ok(bRefresh, 'B started its own refresh immediately');

    vm.settle(aRefresh, { files: [] }); // A's stale finally runs while B refreshes
    await vm.drain();
    assert.ok(vm.SFTP._refreshInFlight, `the stale finally must not clear the newer binding's refresh slot: ${JSON.stringify(vm.SFTP._refreshInFlight)}`);
    assert.ok(vm.pending('sftp-readdir', k => k.args.tabId === 'sessB').length, 'B refresh still in flight');

    vm.settle(bRefresh, { files: [{ name: 'b.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    assert.equal(vm.SFTP._refreshInFlight, null, "B's own finally clears its own slot");
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('b.txt')), 'B refresh rendered');
    await flush(vm);
});

test('a queued upload refresh is dropped when the user navigates away first (control)', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    vm.els.sftpWin.dispatch('drop', {
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ path: 'D:/synthetic/one.txt' }, { path: 'D:/synthetic/two.txt' }] },
    });
    await vm.drain();
    const [one, two] = vm.pending('sftp-upload');
    vm.settle(one, {});
    await vm.drain();
    const firstListing = vm.pending('sftp-readdir')[0];
    assert.ok(firstListing, 'first completion starts a listing request');
    vm.settle(two, {}); // second completion coalesces behind the in-flight listing
    await vm.drain();

    const nav = vm.SFTP.navigate('/srv/sub'); // the user leaves before the follow-up fires
    await vm.drain();
    vm.settle(firstListing, { files: [{ name: 'one.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    const navRd = vm.pending('sftp-readdir', k => k.args.path === '/srv/sub')[0];
    assert.ok(navRd, 'user navigation pending');
    vm.settle(navRd, { files: [{ name: 'sub.txt', isDir: false, size: 1, mtime: 0 }] });
    await vm.drain();
    await flush(vm);
    await nav;
    assert.equal(vm.SFTP._path, '/srv/sub', 'user navigation wins');
    assert.ok(vm.els.body.children.some(r => r.innerHTML.includes('sub.txt')), 'user navigation rendered');
    assert.equal(vm.of('sftp-readdir').filter(r => r.args.path === '/srv/app').length, 1,
        `the queued cleanup was dropped for the abandoned view: ${JSON.stringify(vm.of('sftp-readdir').map(r => r.args))}`);
});
