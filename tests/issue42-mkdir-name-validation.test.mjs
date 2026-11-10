// Issue #42: the mkdir inline editor applies rename's single-entry name
// rule AFTER trimming the typed value (the product decision for NEW names:
// surrounding whitespace is dropped, inner spaces/Unicode/dotfiles stay) —
// "."/".."/slash/NUL shapes are refused before any dispatch, and a value
// that is empty or all-whitespace after the trim closes the row silently.
// The dispatch carries the listed base and the trimmed name separately; the
// backend validates the name (refusing blanks too) and only then joins, so
// no name can smuggle an absolute, nested or parent-escaping target. The
// shared rule itself never trims — rename names stay byte-for-byte. Driven
// through the REAL src/renderer/sftp.js in the shared VM seam; no real SSH,
// files, dialogs or clipboard.
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
    // NUL is not a legal filename byte. The trim happens first, so the
    // padded cases must still land on the refusal after it.
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

test('mkdir trims surrounding whitespace, then sends base + the trimmed name', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);
    // Product decision for NEW names: leading/trailing whitespace drops
    // before validation and dispatch, while inner spaces, Unicode and
    // dotfiles travel verbatim. The dispatch carries base + name, and the
    // backend — not the renderer — joins them after validation.
    const cases = [
        ['  padded  ', 'padded'],
        [' dir', 'dir'],
        ['dir ', 'dir'],
        ['my dir', 'my dir'],
        ['数据 夹', '数据 夹'],
        ['.hidden', '.hidden'],
    ];
    for (const [typed, expected] of cases) {
        vm.SFTP.mkdir();
        const { input } = mkdirRow(vm);
        input.value = typed;
        pressEnter(input);
        await vm.drain();
        const mk = lastMkdirCall(vm);
        assert.equal(mk.args.tabId, 'sessA');
        assert.equal(mk.args.base, '/srv/app', `base travels separately for ${JSON.stringify(typed)}`);
        assert.equal(mk.args.name, expected,
            `name is trimmed-then-verbatim for ${JSON.stringify(typed)}`);
        assert.equal(mk.args.path, undefined,
            `no composed path is sent for ${JSON.stringify(typed)} (the backend joins)`);
        vm.settle(mk, { ok: true });
        await vm.drain();
        const rd = vm.pending('sftp-readdir')[0];
        if (rd) { vm.settle(rd, { files: [] }); await vm.drain(); }
        vm.toasts.length = 0;
    }
});

test('an input that is empty or all-whitespace after the trim closes silently', async () => {
    const vm = await loadSftpVm();
    await openOn(vm, 'sessA', '/srv/app', []);

    for (const typed of ['', '   ', ' ', '\t']) {
        vm.SFTP.mkdir();
        const { input } = mkdirRow(vm);
        input.value = typed;
        pressEnter(input);
        await vm.drain();
        assert.equal(vm.of('sftp-mkdir').length, 0,
            `input ${JSON.stringify(typed)} dispatches nothing`);
        assert.equal(vm.ctx.document.getElementById('sftp-mkdir-row'), null,
            `row closed silently for ${JSON.stringify(typed)}`);
        assert.equal(vm.toasts.filter(t => t.isErr).length, 0,
            `the silent close of ${JSON.stringify(typed)} is not an error`);
    }

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
