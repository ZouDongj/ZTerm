// ZTerm - SSH display helper unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { effectivePort, formatEndpoint, sshDisplayModel, sshProfileMatches } =
    require('../src/renderer/ssh-display.js');

// ── primary/secondary line rules ──

test('空名称：主行 host（技术文本），次行 用户 · 端口', () => {
    const m = sshDisplayModel({ name: '', host: '192.0.2.88', username: 'root', port: 22 });
    assert.equal(m.primary, '192.0.2.88');
    assert.equal(m.primaryIsHost, true);
    assert.equal(m.user, 'root');
    assert.equal(m.port, 22);
    assert.equal(m.named, false);
});

test('名称与 host 完全相同：按未命名处理', () => {
    const m = sshDisplayModel({ name: '192.0.2.88', host: '192.0.2.88', username: 'root', port: 22 });
    assert.equal(m.primaryIsHost, true);
    assert.equal(m.named, false);
});

test('显式名称：主行完整名称，次行 endpoint · 用户', () => {
    const m = sshDisplayModel({ name: '生产入口', host: 'server.example', username: 'ops', port: 6000 });
    assert.equal(m.primary, '生产入口');
    assert.equal(m.primaryIsHost, false);
    assert.equal(m.endpoint, 'server.example:6000');
    assert.equal(m.user, 'ops');
});

test('含主机的复合名称完整保留（不拆解、不简化）', () => {
    const m = sshDisplayModel({ name: '203.0.113.10 - UVSS', host: '203.0.113.10', username: 'zou', port: 6000 });
    assert.equal(m.primary, '203.0.113.10 - UVSS');
    assert.equal(m.named, true);
});

test('缺省端口按 22 展示；非默认端口明确展示', () => {
    assert.equal(sshDisplayModel({ host: 'h', username: 'u' }).port, 22);
    assert.equal(sshDisplayModel({ host: 'h', username: 'u', port: 2222 }).endpoint, 'h:2222');
});

test('IPv6 端点加方括号；已带括号不重复包裹', () => {
    assert.equal(formatEndpoint('2001:db8::8', 2222), '[2001:db8::8]:2222');
    assert.equal(formatEndpoint('[2001:db8::8]', 22), '[2001:db8::8]:22');
    assert.equal(formatEndpoint('192.0.2.88', 22), '192.0.2.88:22');
    assert.equal(formatEndpoint('server.example', 22), 'server.example:22');
});

test('长 Unicode 名称/用户名原样通过（渲染层负责截断与 title）', () => {
    const long = '生产环境入口·华东节点·非常长的连接名称🚀'.repeat(3);
    const m = sshDisplayModel({ name: long, host: 'h', username: '操作员账号'.repeat(5), port: 22 });
    assert.equal(m.primary, long);
    assert.equal(m.user, '操作员账号'.repeat(5));
});

test('源 profile 不被修改，凭据字段不进入展示模型', () => {
    const p = Object.freeze({
        name: 'prod', host: 'h', username: 'u', port: 22,
        authType: 'key', encryptedPassword: 'DPAPI-BLOB', privateKeyPath: 'C:\\keys\\id',
    });
    const m = sshDisplayModel(p);
    assert.equal(m.keyAuth, true);
    assert.deepEqual(Object.keys(m).sort(),
        ['endpoint', 'keyAuth', 'named', 'port', 'primary', 'primaryIsHost', 'user'],
        '展示模型不得夹带模型之外的字段');
    assert.ok(!JSON.stringify(m).includes('DPAPI-BLOB'), '凭据内容不得出现在展示模型');
    assert.equal(p.encryptedPassword, 'DPAPI-BLOB');
});

test('authType 非 key 时 keyAuth 为 false', () => {
    assert.equal(sshDisplayModel({ host: 'h', authType: 'password' }).keyAuth, false);
    assert.equal(sshDisplayModel({ host: 'h' }).keyAuth, false);
});

// ── search matching ──

test('搜索覆盖名称/host/用户名/有效端口/分组，大小写不敏感', () => {
    const p = { name: 'Prod', host: 'server.EXAMPLE', username: 'Ops', port: 6000, group: '生产' };
    ['prod', 'PROD', 'example', 'OPS', '6000', '生产'].forEach(q =>
        assert.ok(sshProfileMatches(p, q), `应匹配 ${q}`));
    assert.ok(!sshProfileMatches(p, 'zzz'));
});

test('缺省端口可用 22 搜到；空查询匹配一切', () => {
    const p = { name: '', host: 'h', username: 'u' };
    assert.ok(sshProfileMatches(p, '22'));
    assert.ok(sshProfileMatches(p, ''));
    assert.ok(sshProfileMatches(p, '   '));
});

test('effectivePort 语义', () => {
    assert.equal(effectivePort({}), 22);
    assert.equal(effectivePort({ port: 0 }), 22);
    assert.equal(effectivePort({ port: 2200 }), 2200);
});

test('字符串端口收敛为数字；脏端口回退 22', () => {
    assert.equal(effectivePort({ port: '6000' }), 6000);
    assert.equal(effectivePort({ port: '22;rm -rf /' }), 22);
    assert.equal(effectivePort({ port: 'abc' }), 22);
});
