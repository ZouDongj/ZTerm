// ZTerm - split tree pure-logic unit tests (node --test)
// the module under test, src/renderer/split-layout.js, is dual-exported as a browser global +
// CommonJS; it is imported via require here, and the browser loads the same file, so both sides share the logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getAllPanes, findPane, getParentOf, normalize, applyDragRatios } =
    require('../src/renderer/split-layout.js');

// ── tree traversal ──

test('getAllPanes 无分屏返回空', () => {
    assert.deepEqual(getAllPanes({}), []);
    assert.deepEqual(getAllPanes({ splitRoot: null }), []);
});

test('getAllPanes 扁平分屏返回全部叶子', () => {
    const tab = {
        splitRoot: { orientation: 'h', children: [{ id: 'p1' }, { id: 'p2' }], ratios: [0.5, 0.5] },
    };
    assert.deepEqual(getAllPanes(tab).map(p => p.id), ['p1', 'p2']);
});

test('getAllPanes 嵌套树深度优先返回叶子', () => {
    const tab = {
        splitRoot: {
            orientation: 'h',
            children: [
                { id: 'p1' },
                { orientation: 'v', children: [{ id: 'p2' }, { id: 'p3' }], ratios: [0.5, 0.5] },
            ],
            ratios: [0.5, 0.5],
        },
    };
    assert.deepEqual(getAllPanes(tab).map(p => p.id), ['p1', 'p2', 'p3']);
});

// ── node lookup ──

test('findPane 找到/找不到/无分屏', () => {
    const tab = {
        splitRoot: { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] },
    };
    assert.equal(findPane(tab, 'a').id, 'a');
    assert.equal(findPane(tab, 'nope'), null);
    assert.equal(findPane({}), null);
});

test('findPane 嵌套树按深度搜索', () => {
    const tab = {
        splitRoot: {
            orientation: 'h',
            children: [
                { id: 'a' },
                { orientation: 'v', children: [{ id: 'b' }, { id: 'c' }], ratios: [0.5, 0.5] },
            ],
            ratios: [0.5, 0.5],
        },
    };
    assert.equal(findPane(tab, 'c').id, 'c');
    assert.equal(findPane(tab, 'deep-nope'), null);
});

test('getParentOf 返回父节点，根与无分屏返回 null', () => {
    const root = { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] };
    const tab = { splitRoot: root };
    assert.equal(getParentOf(tab, root), null);
    assert.equal(getParentOf(tab, root.children[0]), root);
    assert.equal(getParentOf({ splitRoot: null }, { id: 'x' }), null);
});

test('getParentOf 嵌套树返回直接父容器', () => {
    const inner = { orientation: 'v', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] };
    const tab = {
        splitRoot: { orientation: 'h', children: [{ id: 'top' }, inner], ratios: [0.5, 0.5] },
    };
    assert.equal(getParentOf(tab, inner.children[0]), inner);
    assert.equal(getParentOf(tab, inner), tab.splitRoot);
});

// ── normalize: layout normalization ──

test('normalize 空容器与无 orientation 不做修改', () => {
    const empty = { orientation: 'h', children: [], ratios: [] };
    normalize(empty);
    assert.deepEqual(empty, { orientation: 'h', children: [], ratios: [] });

    const leaf = { id: 'a' };
    normalize(leaf);
    assert.deepEqual(leaf, { id: 'a' });
});

test('normalize 单子节点提升', () => {
    const c = {
        orientation: 'h',
        children: [{ orientation: 'v', children: [{ id: 'a' }], ratios: [1] }],
        ratios: [1],
    };
    normalize(c);
    assert.equal(c.children.length, 1);
    assert.equal(c.children[0].id, 'a');
    assert.ok(Math.abs(c.ratios[0] - 1) < 1e-9);
});

test('normalize 单子节点提升保留父级比率', () => {
    // the parent container does not fill its slot (ratio 0.4); the promoted child inherits that ratio
    const c = {
        orientation: 'h',
        children: [
            { id: 'x' },
            { orientation: 'v', children: [{ id: 'a' }], ratios: [1] },
        ],
        ratios: [0.6, 0.4],
    };
    normalize(c);
    assert.deepEqual(c.children.map(x => x.id), ['x', 'a']);
    assert.ok(Math.abs(c.ratios[1] - 0.4) < 1e-9);
    const sum = c.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('normalize 不同向嵌套保留结构', () => {
    // v nested in h (or vice versa) is a legal split structure; normalize only normalizes ratios, it does not flatten
    const c = {
        orientation: 'v',
        children: [
            { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] },
            { id: 'c' },
        ],
        ratios: [0.4, 0.6],
    };
    normalize(c);
    assert.equal(c.children.length, 2);
    assert.equal(c.children[0].orientation, 'h');
    assert.equal(c.children[0].children.length, 2);
    assert.equal(c.children[1].id, 'c');
    const sum = c.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('normalize 空子节点被删除', () => {
    const c = {
        orientation: 'h',
        children: [{ id: 'a' }, { orientation: 'v', children: [], ratios: [] }, { id: 'b' }],
        ratios: [0.3, 0.4, 0.3],
    };
    normalize(c);
    assert.deepEqual(c.children.map(x => x.id), ['a', 'b']);
    assert.equal(c.ratios.length, 2);
    assert.ok(Math.abs(c.ratios[0] + c.ratios[1] - 1) < 1e-9);
});

test('normalize 同向子容器被展开且比率按比例缩放', () => {
    const c = {
        orientation: 'h',
        children: [
            { id: 'a' },
            { orientation: 'h', children: [{ id: 'b' }, { id: 'c' }], ratios: [0.25, 0.75] },
        ],
        ratios: [0.5, 0.5],
    };
    normalize(c);
    assert.deepEqual(c.children.map(x => x.id), ['a', 'b', 'c']);
    // b's share = 0.5 (parent share) * 0.25 = 0.125, c = 0.375
    assert.ok(Math.abs(c.ratios[0] - 0.5) < 1e-9);
    assert.ok(Math.abs(c.ratios[1] - 0.125) < 1e-9);
    assert.ok(Math.abs(c.ratios[2] - 0.375) < 1e-9);
    // after normalization the sum is 1
    const sum = c.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('normalize 同向嵌套展开且比率按比例缩放', () => {
    const c = {
        orientation: 'h',
        children: [
            { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.25, 0.75] },
            { id: 'c' },
        ],
        ratios: [0.4, 0.6],
    };
    normalize(c);
    assert.deepEqual(c.children.map(x => x.id), ['a', 'b', 'c']);
    // a = 0.4 * 0.25 = 0.1, b = 0.4 * 0.75 = 0.3, c = 0.6
    assert.ok(Math.abs(c.ratios[0] - 0.1) < 1e-9);
    assert.ok(Math.abs(c.ratios[1] - 0.3) < 1e-9);
    assert.ok(Math.abs(c.ratios[2] - 0.6) < 1e-9);
});

test('normalize 相邻两个同向容器全部展开', () => {
    // regression: if the next sibling is skipped after merging the first container, h2 remains as a same-orientation nested child
    const c = {
        orientation: 'h',
        children: [
            { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] },
            { orientation: 'h', children: [{ id: 'c' }, { id: 'd' }], ratios: [0.5, 0.5] },
        ],
        ratios: [0.5, 0.5],
    };
    normalize(c);
    assert.deepEqual(c.children.map(x => x.id), ['a', 'b', 'c', 'd']);
    assert.ok(c.children.every(x => !x.orientation), 'normalize 后不应残留同向嵌套');
    const sum = c.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(Math.abs(c.ratios[0] - 0.25) < 1e-9);
    assert.ok(Math.abs(c.ratios[3] - 0.25) < 1e-9);
});

test('normalize 同向合并后继续处理后续不同向兄弟', () => {
    // siblings after the merged region (a different-orientation container) must not be skipped
    const c = {
        orientation: 'h',
        children: [
            { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] },
            { orientation: 'v', children: [{ id: 'c' }, { id: 'd' }], ratios: [0.5, 0.5] },
        ],
        ratios: [0.5, 0.5],
    };
    normalize(c);
    assert.equal(c.children.length, 3);
    assert.deepEqual(c.children.map(x => x.id ?? x.orientation), ['a', 'b', 'v']);
    const sum = c.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ── drag ratios ──

test('applyDragRatios 正常拖动', () => {
    const [a, b] = applyDragRatios(0.5, 0.5, 0.1, 0.05);
    assert.ok(Math.abs(a - 0.6) < 1e-9);
    assert.ok(Math.abs(b - 0.4) < 1e-9);
});

test('applyDragRatios 单边触底钳制', () => {
    const [a, b] = applyDragRatios(0.5, 0.5, 0.7, 0.05);
    assert.ok(Math.abs(a - 0.95) < 1e-9);
    assert.ok(Math.abs(b - 0.05) < 1e-9);
    // reverse direction
    const [a2, b2] = applyDragRatios(0.5, 0.5, -0.7, 0.05);
    assert.ok(Math.abs(a2 - 0.05) < 1e-9);
    assert.ok(Math.abs(b2 - 0.95) < 1e-9);
});

test('applyDragRatios 双方初始即触底时不产生负值', () => {
    // when the initial ratios sum to less than 2*minRatio, clamping both sides overshoots; fall back to clamping at 0 while preserving the sum
    const [a, b] = applyDragRatios(0.01, 0.01, 0, 0.05);
    assert.ok(a >= 0 && b >= 0, `got [${a}, ${b}]`);
    assert.ok(Math.abs(a + b - 0.02) < 1e-9);
});

test('applyDragRatios 极端拖动不产生负数', () => {
    const [a, b] = applyDragRatios(0.06, 0.94, 10, 0.05);
    assert.ok(a >= 0 && b >= 0);
    const [a2, b2] = applyDragRatios(0.06, 0.94, -10, 0.05);
    assert.ok(a2 >= 0 && b2 >= 0);
});
