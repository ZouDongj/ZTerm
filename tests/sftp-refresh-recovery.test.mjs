// Drive the real renderer through a synthetic service that changes from a
// refused SFTP subsystem to an available one. The Rust loopback fixture covers
// the real SSH channel reopen; this seam asserts renderer state and IPC choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

const HOME = '/home/fixture';
const RECOVERED_FILE = { name: 'recovered.txt', isDir: false, size: 1, mtime: 0 };

class RecoverableSftpService {
    constructor() {
        this.enabled = false;
        this.channel = null;
        this.channelOpens = 0;
    }

    ensureChannel() {
        if (!this.enabled) throw new Error('SFTP subsystem not enabled on the fixture server');
        if (!this.channel) {
            this.channelOpens++;
            this.channel = { generation: this.channelOpens };
        }
        return this.channel;
    }

    settle(vm, call) {
        try {
            this.ensureChannel();
        } catch (error) {
            vm.fail(call, error);
            return;
        }
        if (call.cmd === 'sftp-open') {
            vm.settle(call, { path: HOME, files: [RECOVERED_FILE] });
            return;
        }
        if (call.cmd === 'sftp-readdir' && call.args.path === '/') {
            vm.settle(call, { error: 'the fixture does not expose its placeholder root' });
            return;
        }
        if (call.cmd === 'sftp-readdir' && call.args.path === HOME) {
            vm.settle(call, { files: [RECOVERED_FILE] });
            return;
        }
        throw new Error(`unexpected fixture call: ${call.cmd} ${JSON.stringify(call.args)}`);
    }
}

async function runInitialRecovery(vm, service, initialFailure) {
    const opening = vm.SFTP.open('sessA');
    await vm.drain();
    const firstOpen = vm.pending('sftp-open')[0];
    assert.ok(firstOpen, 'initial open dispatched');
    if (initialFailure === 'reject') {
        service.settle(vm, firstOpen);
    } else {
        service.enabled = true;
        service.ensureChannel();
        vm.settle(firstOpen, { error: 'the fixture home is temporarily unreadable' });
    }
    await vm.drain();
    await opening;

    assert.equal(vm.SFTP._sessionDead, false, 'a failed SFTP open is not a dead SSH session');
    assert.equal(vm.SFTP._listed, false, 'the failed initial open has no valid listing');
    assert.equal(service.channelOpens, initialFailure === 'reject' ? 0 : 1,
        'only a subsystem refusal leaves the channel cache empty');

    service.enabled = true;
    const refreshing = vm.SFTP.refresh();
    await vm.drain();
    const retry = [
        ...vm.pending('sftp-open'),
        ...vm.pending('sftp-readdir'),
    ];
    assert.equal(retry.length, 1, 'refresh issues exactly one recovery request');
    service.settle(vm, retry[0]);
    await vm.drain();
    await refreshing;
}

for (const initialFailure of ['reject', 'payload']) {
    const title = initialFailure === 'reject'
        ? 'refresh recovers after the subsystem becomes available'
        : 'refresh retries an initial directory error payload';
    test(title, async () => {
        const vm = await loadSftpVm();
        const service = new RecoverableSftpService();
        await runInitialRecovery(vm, service, initialFailure);

        assert.equal(service.channelOpens, 1, initialFailure === 'reject'
            ? 'the same SSH session builds one replacement channel'
            : 'a directory retry reuses the established channel');
        assert.equal(vm.SFTP._sessionDead, false, 'recovery never marks the live SSH session dead');
        assert.equal(vm.SFTP._listed, true,
            `retry must recover; calls=${JSON.stringify(vm.calls.map(c => ({ cmd: c.cmd, args: c.args })))} toasts=${JSON.stringify(vm.toasts)}`);
        assert.equal(vm.SFTP._path, HOME, 'recovery uses the server-provided initial directory');
        assert.ok(vm.els.body.children.some(row => row.innerHTML.includes(RECOVERED_FILE.name)),
            `recovered listing is rendered: ${vm.els.body.innerHTML}`);
    });
}

test('refresh after a successful listing keeps using readdir on the current path', async () => {
    const vm = await loadSftpVm();
    const service = new RecoverableSftpService();
    service.enabled = true;

    const opening = vm.SFTP.open('sessA');
    await vm.drain();
    service.settle(vm, vm.pending('sftp-open')[0]);
    await vm.drain();
    await opening;
    assert.equal(vm.SFTP._listed, true);

    const refreshing = vm.SFTP.refresh();
    await vm.drain();
    const retry = vm.pending('sftp-readdir')[0];
    assert.ok(retry, 'an established listing refreshes through readdir');
    assert.equal(retry.args.path, HOME);
    service.settle(vm, retry);
    await vm.drain();
    await refreshing;

    assert.equal(vm.of('sftp-open').length, 1, 'ordinary refresh does not rebind the panel');
    assert.equal(service.channelOpens, 1, 'ordinary refresh reuses the cached channel');
    assert.equal(vm.SFTP._path, HOME);
    assert.equal(vm.SFTP._listed, true);
});

test('refresh does not reopen an explicitly dead SSH session', async () => {
    const vm = await loadSftpVm();
    const service = new RecoverableSftpService();
    service.enabled = true;

    const opening = vm.SFTP.open('sessA');
    await vm.drain();
    service.settle(vm, vm.pending('sftp-open')[0]);
    await vm.drain();
    await opening;
    vm.emit('ssh-disconnect-reason', {
        tabId: 'sessA', kind: 'error', reason: 'fixture disconnect', at: 0,
    });
    await vm.drain();
    assert.equal(vm.SFTP._sessionDead, true);
    assert.equal(vm.SFTP._listed, false);

    const callsBefore = vm.calls.length;
    await vm.SFTP.refresh();
    assert.equal(vm.calls.length, callsBefore, 'dead-session refresh sends no IPC');
    assert.equal(vm.SFTP._sessionDead, true, 'the explicit dead state is preserved');
    assert.ok(vm.els.body.innerHTML.includes('会话已断开'));
});

test('recovery refresh does not resurrect a suspended panel', async () => {
    const vm = await loadSftpVm();
    const service = new RecoverableSftpService();
    const opening = vm.SFTP.open('sessA');
    await vm.drain();
    vm.fail(vm.pending('sftp-open')[0], 'SFTP subsystem not enabled on the fixture server');
    await vm.drain();
    await opening;
    vm.SFTP._suspend();
    assert.equal(vm.SFTP.isOpen, false);

    service.enabled = true;
    const refreshing = vm.SFTP.refresh();
    await vm.drain();
    const retry = [
        ...vm.pending('sftp-open'),
        ...vm.pending('sftp-readdir'),
    ];
    assert.equal(retry.length, 1);
    service.settle(vm, retry[0]);
    await vm.drain();
    await refreshing;

    assert.equal(vm.SFTP.isOpen, false, 'the background retry keeps the dock suspended');
    assert.equal(vm.of('sftp-open').length, 1, 'a hidden panel does not rebind');
    assert.equal(vm.SFTP._listed, false, 'a hidden response cannot claim a rendered listing');
});
