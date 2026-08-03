// ZTerm - 分屏树持久化序列化/反序列化单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serializeSplitNode, deserializeSplitNode, MAX_TREE_DEPTH } =
    require('../src/renderer/tab-serialize.js');

let paneSeq = 0;
function nextPaneId() { return 'p_' + (++paneSeq); }
function deser(saved, defaultName = 'Tab') {
    return deserializeSplitNode(saved, { defaultName, nextPaneId });
}

// ── serializeSplitNode ──

test('serializeSplitNode null/空输入', () => {
    assert.equal(serializeSplitNode(null), null);
    assert.equal(serializeSplitNode(undefined), null);
});

test('serializeSplitNode local 叶子', () => {
    const out = serializeSplitNode({ id: 'p1', type: 'local', name: 'Git Bash', _command: 'bash.exe', _args: ['--login'] });
    assert.equal(out.type, 'leaf');
    assert.equal(out.paneType, 'local');
    assert.equal(out.name, 'Git Bash');
    assert.equal(out.command, 'bash.exe');
    assert.deepEqual(out.args, ['--login']);
    assert.equal(out.sshHost, undefined);
});

test('serializeSplitNode ssh 叶子（type 与 _sshHost 两种标记）', () => {
    const byType = serializeSplitNode({ id: 'p1', type: 'ssh', name: 'prod', _sshHost: 'h', _sshPort: 22, _sshUser: 'u', _sshProfileId: 's1', _command: 'x' });
    assert.equal(byType.paneType, 'ssh');
    assert.equal(byType.command, '', 'ssh 叶子不保存 command');
    assert.deepEqual(byType.args, []);
    const byHost = serializeSplitNode({ id: 'p2', type: 'local', name: 'x', _sshHost: 'h2' });
    assert.equal(byHost.paneType, 'ssh', '_sshHost 存在时视为 ssh');
});

test('serializeSplitNode 容器递归', () => {
    const tree = {
        orientation: 'h',
        children: [
            { id: 'a', type: 'local', name: 'A', _command: 'a' },
            { orientation: 'v', children: [{ id: 'b', type: 'local', name: 'B' }], ratios: [1] },
        ],
        ratios: [0.5, 0.5],
    };
    const out = serializeSplitNode(tree);
    assert.equal(out.orientation, 'h');
    assert.equal(out.children.length, 2);
    assert.equal(out.children[0].paneType, 'local');
    assert.equal(out.children[1].orientation, 'v');
    assert.equal(out.children[1].children[0].paneType, 'local');
    assert.deepEqual(out.ratios, [0.5, 0.5]);
});

// ── deserializeSplitNode ──

test('deserializeSplitNode null/损坏输入返回 null', () => {
    assert.equal(deser(null), null);
    assert.equal(deser(undefined), null);
});

test('deserializeSplitNode 深度超限截断且不产生 null 子节点', () => {
    let deep = { orientation: 'h', children: [], ratios: [] };
    for (let i = 0; i < MAX_TREE_DEPTH + 5; i++) {
        deep = { orientation: 'h', children: [deep], ratios: [1] };
    }
    const out = deserializeSplitNode(deep, { defaultName: 'Tab', nextPaneId });
    assert.ok(out, '根节点（depth 0）应正常返回');
    // 遍历整棵树：不得有 null 子节点（否则 normalize 会崩溃），不得崩溃
    const stack = [out];
    while (stack.length) {
        const n = stack.pop();
        if (n.orientation) {
            n.children.forEach(c => assert.ok(c, 'children 不应含 null'));
            stack.push(...n.children);
        }
    }
});

test('deserializeSplitNode local 叶子字段', () => {
    const p = deser({ paneType: 'local', name: 'Git Bash', command: 'bash.exe', args: ['--login'] }, 'Fallback');
    assert.ok(p.id.startsWith('p_'));
    assert.equal(p.type, 'local');
    assert.equal(p.connected, true, 'local 直接在线');
    assert.equal(p.name, 'Git Bash');
    assert.equal(p._command, 'bash.exe');
    assert.deepEqual(p._args, ['--login']);
    assert.equal(p.term, null);
});

test('deserializeSplitNode ssh 叶子字段', () => {
    const p = deser({ paneType: 'ssh', name: 'prod', sshHost: 'h', sshPort: 2222, sshUser: 'u', sshProfileId: 's1' });
    assert.equal(p.type, 'ssh');
    assert.equal(p.connected, false, 'ssh 等待握手');
    assert.equal(p._sshHost, 'h');
    assert.equal(p._sshPort, 2222);
    assert.equal(p._sshUser, 'u');
    assert.equal(p._sshProfileId, 's1');
    assert.equal(p._command, '');
});

test('deserializeSplitNode 缺 name 回退到 defaultName', () => {
    const p = deser({ paneType: 'local' }, 'Fallback Name');
    assert.equal(p.name, 'Fallback Name');
});

test('deserializeSplitNode 容器递归 + 叶子数量', () => {
    const saved = {
        orientation: 'h',
        children: [
            { paneType: 'local', name: 'A' },
            { orientation: 'v', children: [{ paneType: 'local', name: 'B' }, { paneType: 'local', name: 'C' }], ratios: [0.4, 0.6] },
        ],
        ratios: [0.5, 0.5],
    };
    const tree = deser(saved);
    assert.equal(tree.orientation, 'h');
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[1].orientation, 'v');
    assert.equal(tree.children[1].children.length, 2);
});

// ── roundtrip ──

test('序列化 → 反序列化 → 序列化 等价（roundtrip 保真）', () => {
    const original = {
        orientation: 'v',
        children: [
            { id: 'a', type: 'local', name: 'Git Bash', _command: 'bash.exe', _args: ['-i'] },
            {
                orientation: 'h',
                children: [
                    { id: 'b', type: 'ssh', name: 'prod', _sshHost: 'example.com', _sshPort: 2222, _sshUser: 'root', _sshProfileId: 's1' },
                    { id: 'c', type: 'local', name: 'PS', _command: 'powershell.exe' },
                ],
                ratios: [0.6, 0.4],
            },
        ],
        ratios: [0.3, 0.7],
    };
    const saved = serializeSplitNode(original);
    const restored = deser(saved, 'Tab');
    const resaved = serializeSplitNode(restored);
    // 序列化结果应完全一致（paneType/command/args/ratios/结构）
    assert.deepEqual(resaved, saved);
});

test('roundtrip 后叶子数量与比率保持一致', () => {
    const tree = {
        orientation: 'h',
        children: [
            { id: 'a', type: 'local', name: 'A' },
            { id: 'b', type: 'local', name: 'B' },
            { id: 'c', type: 'local', name: 'C' },
        ],
        ratios: [0.2, 0.3, 0.5],
    };
    const restored = deser(serializeSplitNode(tree));
    assert.equal(restored.children.length, 3);
    assert.deepEqual(restored.ratios, [0.2, 0.3, 0.5]);
    assert.ok(restored.children.every(c => c.id && c.id.startsWith('p_')));
});
