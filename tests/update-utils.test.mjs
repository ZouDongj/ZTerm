// ZTerm - in-app update pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countUpdateBlockers } = require('../src/renderer/update-utils.js');

const sshTab = (connected) => ({ id: 't1', type: 'ssh', connected });
const localTab = { id: 't2', type: 'local', connected: true };

test('无 tab 无传输：零阻断', () => {
    assert.deepEqual(countUpdateBlockers([], [], () => []), { ssh: 0, sftp: 0 });
});

test('单个已连接 SSH tab 计入；断开与本地 tab 不计', () => {
    const tabs = [sshTab(true), sshTab(false), localTab];
    assert.deepEqual(countUpdateBlockers(tabs, [], () => []), { ssh: 1, sftp: 0 });
});

test('connected 必须严格为 true（undefined 不算已连接）', () => {
    assert.deepEqual(countUpdateBlockers([{ id: 't', type: 'ssh' }], [], () => []), { ssh: 0, sftp: 0 });
});

test('分屏：pane.type=ssh 且已连接的 pane 逐个数', () => {
    const tab = { id: 't', splitRoot: {}, type: 'local' };
    const panes = [
        { id: 'p1', type: 'ssh', connected: true },
        { id: 'p2', type: 'ssh', connected: true },
        { id: 'p3', type: 'ssh', connected: false },
        { id: 'p4', type: 'local', connected: true },
    ];
    assert.deepEqual(countUpdateBlockers([tab], [], () => panes), { ssh: 2, sftp: 0 });
});

test('分屏：pane._sshHost 兜底识别 SSH pane', () => {
    const tab = { id: 't', splitRoot: {} };
    const panes = [{ id: 'p1', _sshHost: 'example.com', connected: true }];
    assert.deepEqual(countUpdateBlockers([tab], [], () => panes), { ssh: 1, sftp: 0 });
});

test('SFTP：仅未 done 且未 cancelled 的传输计入', () => {
    const transfers = [
        { id: 1, done: false, cancelled: false },
        { id: 2, done: true, cancelled: false },
        { id: 3, done: false, cancelled: true },
        { id: 4, done: false, cancelled: false },
    ];
    assert.deepEqual(countUpdateBlockers([], transfers, () => []), { ssh: 0, sftp: 2 });
});

test('混合：SSH + SFTP 同时计数', () => {
    const r = countUpdateBlockers([sshTab(true)], [{ done: false, cancelled: false }], () => []);
    assert.deepEqual(r, { ssh: 1, sftp: 1 });
});
