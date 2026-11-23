// ZTerm - in-app update pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    countUpdateBlockers,
    updateReleasePageUrl,
    isPrereleaseVersion,
    isUpdatePrerelease,
    formatUpdateTagLabel,
    formatUpdateFoundDesc,
    formatUpdateDownloadButton,
} = require('../src/renderer/update-utils.js');

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

test('发行页链接：接受本项目 releases 页面', () => {
    assert.equal(
        updateReleasePageUrl('https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4'),
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4'
    );
    assert.equal(
        updateReleasePageUrl('https://github.com/ZouDongj/ZTerm/releases/latest'),
        'https://github.com/ZouDongj/ZTerm/releases/latest'
    );
});

test('发行页链接：空值、畸形值与非本仓库地址回退到 latest', () => {
    const fallback = 'https://github.com/ZouDongj/ZTerm/releases/latest';
    for (const value of [
        undefined,
        null,
        '',
        '   ',
        'http://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4',
        'https://evil.example/ZouDongj/ZTerm/releases/tag/v1.2.4',
        'https://github.com/ZouDongj/ZTerm.evil/releases/tag/v1.2.4',
        'https://github.com/ZouDongj/ZTerm/releases/../../Other/ZTerm',
        'https://github.com/ZouDongj/ZTerm/releases/%2e%2e/%2e%2e/%2e%2e/attacker/ZTerm/releases',
        'https://github.com/ZouDongj/ZTerm/releases/.%2e/issues',
        'https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4?foo=1',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4?',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4#frag',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4#',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4 extra',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4\\..\\evil',
        'javascript:alert(1)',
    ]) {
        assert.equal(updateReleasePageUrl(value), fallback, String(value));
    }
});

test('发行页链接：接受本仓库预发布 tag 页面并拒绝畸形预发布地址', () => {
    const fallback = 'https://github.com/ZouDongj/ZTerm/releases/latest';
    assert.equal(
        updateReleasePageUrl('https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4'),
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4'
    );
    assert.equal(
        updateReleasePageUrl('https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.6-rc.1+build.2'),
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.6-rc.1+build.2'
    );
    for (const bad of [
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4?foo=1',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4#top',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.%34',
        'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev..4',
        'https://github.com/Other/ZTerm/releases/tag/v1.2.5-dev.4',
    ]) {
        assert.equal(updateReleasePageUrl(bad), fallback, bad);
    }
});

test('预发布版本识别：区分 SemVer 预发布后缀与构建元数据', () => {
    for (const pre of ['1.2.5-dev.4', 'v1.2.5-dev.4', 'V1.2.6-rc.1', '1.2.5-alpha.1+sha.abc']) {
        assert.equal(isPrereleaseVersion(pre), true, pre);
    }
    for (const stable of ['1.2.5', 'v1.2.5', '1.2.5+build-1', '', null, undefined, '1.2.5-', '1.2.5-.1']) {
        assert.equal(isPrereleaseVersion(stable), false, String(stable));
    }
});

test('更新文案：开发版显式标注「开发版」，稳定版保持既有文案不变', () => {
    const devResult = {
        current: '1.2.5-dev.3',
        latest: '1.2.5-dev.4',
        tag: 'v1.2.5-dev.4',
        newer: true,
        isPrerelease: true,
    };
    assert.equal(isUpdatePrerelease(devResult), true);
    assert.equal(formatUpdateFoundDesc(devResult), '发现新版本 开发版 1.2.5-dev.4（当前 1.2.5-dev.3）');
    assert.equal(formatUpdateDownloadButton(devResult), '下载开发版');
    assert.equal(formatUpdateTagLabel('v1.2.5-dev.4', true), '开发版 v1.2.5-dev.4');
    assert.equal(formatUpdateTagLabel('v1.2.5-dev.4'), '开发版 v1.2.5-dev.4');

    // Prerelease version string is still labeled even if isPrerelease is omitted.
    const devInferred = { current: '1.2.5-dev.3', latest: '1.2.6-dev.1', tag: 'v1.2.6-dev.1', newer: true };
    assert.equal(isUpdatePrerelease(devInferred), true);
    assert.equal(formatUpdateFoundDesc(devInferred), '发现新版本 开发版 1.2.6-dev.1（当前 1.2.5-dev.3）');
    assert.equal(formatUpdateDownloadButton(devInferred), '下载开发版');

    // Graduating from a dev build to a stable release uses stable wording.
    const graduateResult = {
        current: '1.2.5-dev.3',
        latest: '1.2.5',
        tag: 'v1.2.5',
        newer: true,
        isPrerelease: false,
    };
    assert.equal(isUpdatePrerelease(graduateResult), false);
    assert.equal(formatUpdateFoundDesc(graduateResult), '发现新版本 1.2.5（当前 1.2.5-dev.3）');
    assert.equal(formatUpdateDownloadButton(graduateResult), '下载更新');
    assert.equal(formatUpdateTagLabel('v1.2.5', false), 'v1.2.5');

    // Existing stable update wording remains completely unchanged.
    const stableResult = { current: '1.0.0', latest: '9.9.9', tag: 'v9.9.9', newer: true };
    assert.equal(isUpdatePrerelease(stableResult), false);
    assert.equal(formatUpdateFoundDesc(stableResult), '发现新版本 9.9.9（当前 1.0.0）');
    assert.equal(formatUpdateDownloadButton(stableResult), '下载更新');
    assert.equal(formatUpdateTagLabel('v9.9.9'), 'v9.9.9');
});
