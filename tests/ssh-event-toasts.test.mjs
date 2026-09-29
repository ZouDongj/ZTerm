// Release builds hide stderr (windows_subsystem = "windows"), so the backend's
// login-script retirement (T21: required steps never matched) and followCwd
// history-cleanup failure (T18: original file untouched) notifications are
// only visible through renderer toasts. Drives the REAL ipc.js listeners
// through the shared renderer VM seam (tests/helpers/renderer-vm.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm } from './helpers/renderer-vm.mjs';

function spyToasts(ctx) {
    const toasts = [];
    ctx.showToast = (msg, isError) => toasts.push({ msg: String(msg), isError: !!isError });
    return toasts;
}

test('ssh-login-script-timeout surfaces the unmatched required steps as an error toast', () => {
    const ctx = loadVm();
    const toasts = spyToasts(ctx);

    ctx.__emit('ssh-login-script-timeout', { tabId: 'b1', rendererId: 't1', expects: ['step1', 'step2'] });

    assert.equal(toasts.length, 1, 'exactly one toast');
    assert.equal(toasts[0].isError, true, 'surfaced as an error');
    assert.match(toasts[0].msg, /登录脚本步骤未匹配/);
    assert.match(toasts[0].msg, /step1 \| step2/);
});

test('ssh-login-script-timeout with no missed steps still names the retirement', () => {
    const ctx = loadVm();
    const toasts = spyToasts(ctx);

    ctx.__emit('ssh-login-script-timeout', { tabId: 'b1', rendererId: 't1', expects: [] });

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].isError, true);
    assert.ok(!toasts[0].msg.endsWith(': '), 'no dangling separator with an empty step list');
});

test('ssh-history-clean-failed reports the failure and the untouched original', () => {
    const ctx = loadVm();
    const toasts = spyToasts(ctx);

    ctx.__emit('ssh-history-clean-failed', { tabId: 'b1', rendererId: 't1', error: 'clean ~/.bash_history: stat failed' });

    assert.equal(toasts.length, 1, 'exactly one toast');
    assert.equal(toasts[0].isError, true);
    assert.match(toasts[0].msg, /历史记录清理失败/);
    assert.match(toasts[0].msg, /原文件未改动/);
    assert.match(toasts[0].msg, /stat failed/);
});
