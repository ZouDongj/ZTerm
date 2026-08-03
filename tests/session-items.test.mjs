// ZTerm - 会话选择器纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSessionItems, filterSessionItems } =
    require('../src/renderer/session-items.js');

const LOCAL = [
    { id: 'powershell', name: 'PowerShell', command: 'powershell.exe', icon: 'local' },
    { id: 'bash', name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], icon: 'bash' },
];
const SSH = [
    { id: 's1', name: 'prod', username: 'root', host: 'example.com', port: 22, group: '生产' },
    { id: 's2', name: 'dev', username: 'dev', host: 'dev.example.com' },
];

// ── buildSessionItems ──

test('buildSessionItems 本地 profile 构造', () => {
    const items = buildSessionItems(LOCAL, [], []);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        id: 'local_powershell', name: 'PowerShell', detail: 'powershell.exe',
        type: 'local', badge: '', icon: '⊞', profile: LOCAL[0],
    });
    // 带 args 的 profile：detail 用短路径 + args
    assert.equal(items[1].detail, 'bash.exe --login -i');
    assert.equal(items[1].icon, '>_');
});

test('buildSessionItems hidden 过滤', () => {
    const items = buildSessionItems(LOCAL, [], ['powershell']);
    assert.deepEqual(items.map(i => i.id), ['local_bash']);
});

test('buildSessionItems SSH profile 构造与默认端口', () => {
    const items = buildSessionItems([], SSH, []);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'ssh_s1');
    assert.equal(items[0].type, 'ssh');
    assert.equal(items[0].detail, 'root@example.com:22');
    assert.equal(items[0].badge, '生产');
    assert.equal(items[1].detail, 'dev@dev.example.com:22', '缺端口默认 22');
    assert.equal(items[1].badge, '');
});

test('buildSessionItems 空输入与顺序（本地在前）', () => {
    assert.deepEqual(buildSessionItems(null, null, null), []);
    const items = buildSessionItems(LOCAL.slice(0, 1), SSH.slice(0, 1), []);
    assert.deepEqual(items.map(i => i.type), ['local', 'ssh']);
});

// ── filterSessionItems ──

test('filterSessionItems 空查询返回原数组', () => {
    const items = buildSessionItems(LOCAL, SSH, []);
    assert.equal(filterSessionItems(items, ''), items);
    assert.equal(filterSessionItems(items, null), items);
});

test('filterSessionItems 名称/详情/分组匹配（大小写不敏感）', () => {
    const items = buildSessionItems(LOCAL, SSH, []);
    assert.deepEqual(filterSessionItems(items, 'prod').map(i => i.id), ['ssh_s1']);
    assert.deepEqual(filterSessionItems(items, 'PROD').map(i => i.id), ['ssh_s1']);
    assert.deepEqual(filterSessionItems(items, 'example.com').map(i => i.id), ['ssh_s1', 'ssh_s2']);
    assert.deepEqual(filterSessionItems(items, '生产').map(i => i.id), ['ssh_s1']);
    assert.deepEqual(filterSessionItems(items, 'powershell').map(i => i.id), ['local_powershell']);
});

test('filterSessionItems 无匹配返回空', () => {
    const items = buildSessionItems(LOCAL, SSH, []);
    assert.deepEqual(filterSessionItems(items, 'zzz'), []);
});
