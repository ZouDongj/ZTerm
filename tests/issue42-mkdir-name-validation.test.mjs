// Issue #42: the mkdir inline editor must apply the SAME single-entry name
// rule as rename — "."/".."/slash/NUL shapes are refused before any dispatch
// — while the name travels RAW (no trimming: `dir`, ` dir` and `dir ` are
// three different remote directories, and a pure-space name is a legal
// component). The dispatch carries the listed base and the raw name
// separately; the backend validates the name and only then joins, so no
// name can smuggle an absolute, nested or parent-escaping target. Only a
// truly empty input keeps its silent close. Driven through the REAL
// src/renderer/sftp.js in the shared VM seam; no real SSH, files, dialogs
// or clipboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const F = (name) => ({ name, isDir: false, size: 1, mtime: 0 });

async function openOn(vm, tabId, path, files) {
    const p = vm.SFTP.open(tabId);
    await vm.drain();
    vm.settle(vm.pending('sftp-open', k => k.args.tabId === tabId)[0], { path, files: files || [] });
    await vm.drain();
    await p;
}

function mkdirRow(vm) {
    const row = vm.ctx.document.getElementById('sftp-mkdir-row');
    assert.ok(row, 'mkdir row mounted');
    const input = row.querySelector('input');
    assert.ok(input, 'mkdir input materialized');
    return { row, input };
}

function pressEnter(input) {
    input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
}

function pressEscape(input) {
    input.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
}

function lastMkdirCall(vm) {
    const calls = vm.of('sftp-mkdir');
    assert.ok(calls.length, 'an sftp-mkdir call was dispatched');
    return calls[calls.length - 1];
}

test('mkdir refuses dot/dotdot/slash/NUL names without dispatching, keeping the row open', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', [F('a.txt')]);

    vm.SFTP.mkdir();
    const { input } = mkdirRow(vm);
    // "a/b" is a nested target MKDIR cannot create; "/abs" and "../x" would
    // leave the listed directory entirely; "."/".." are not named entries;
    // NUL is not a legal filename byte. No trimming happens first, so the
    // padded slash cases prove padding cannot smuggle a slash through.
    const bad = ['..', '.', '../x', 'a/b', '/abs', 'x\0y', ' /abs ', ' ../x '];
    for (const value of bad) {
        input.value = value;
        pressEnter(input);
        await vm.drain();
        assert.equal(vm.of('sftp-mkdir').length, 0,
            `mkdir name ${JSON.stringify(value)} must not reach the backend`);
        assert.ok(vm.ctx.document.getElementById('sftp-mkdir-row'),
            `row stays open for a fix after refusing ${JSON.stringify(value)}`);
        assert.ok(vm.toasts.some(t => t.isErr),
            `refusal of ${JSON.stringify(value)} explains itself`);
        vm.toasts.length = 0;
    }
    pressEscape(input);
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null, 'Escape still closes the row');
});

test('mkdir sends the RAW name with the listed base — no trimming, no composed path', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    // Leading/trailing/pure spaces are legal single components and must
    // travel byte-for-byte (a trimming client silently retargets the mkdir
    // at a DIFFERENT directory name); the dispatch carries base + name, and
    // the backend — not the renderer — joins them after validation.
    const cases = ['  padded  ', '   ', ' dir', 'dir ', 'my dir', '数据 夹', '.hidden'];
    for (const typed of cases) {
        vm.SFTP.mkdir();
        const { input } = mkdirRow(vm);
        input.value = typed;
        pressEnter(input);
        await vm.drain();
        const mk = lastMkdirCall(vm);
        assert.equal(mk.args.tabId, 'sessA');
        assert.equal(mk.args.base, '/srv/app', `base travels separately for ${JSON.stringify(typed)}`);
        assert.equal(mk.args.name, typed, `name is RAW for ${JSON.stringify(typed)}`);
        assert.equal(mk.args.path, undefined,
            `no composed path is sent for ${JSON.stringify(typed)} (the backend joins)`);
        vm.settle(mk, { ok: true });
        await vm.drain();
        const rd = vm.pending('sftp-readdir')[0];
        if (rd) { vm.settle(rd, { files: [] }); await vm.drain(); }
        vm.toasts.length = 0;
    }
});

test('mkdir keeps only the truly empty input as a silent close', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    vm.SFTP.mkdir();
    const { input } = mkdirRow(vm);
    input.value = '';
    pressEnter(input);
    await vm.drain();
    assert.equal(vm.of('sftp-mkdir').length, 0, 'empty input dispatches nothing');
    assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null, 'row closed silently');
    assert.equal(vm.toasts.filter(t => t.isErr).length, 0, 'the silent close is not an error');

    // The root listing composes to "/<name>" on the backend side; the panel
    // just passes base "/" through (a fresh session rebind, same as the
    // dead-state recovery tests).
    await openOn(vm, 'sessB', '/', []);
    vm.SFTP.mkdir();
    const { input: rootInput } = mkdirRow(vm);
    rootInput.value = 'early';
    pressEnter(rootInput);
    await vm.drain();
    const mk = lastMkdirCall(vm);
    assert.equal(mk.args.tabId, 'sessB');
    assert.equal(mk.args.base, '/', 'root base travels as "/"');
    assert.equal(mk.args.name, 'early');
});
