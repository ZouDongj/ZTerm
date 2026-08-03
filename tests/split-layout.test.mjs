// ZTerm - 分屏树纯逻辑单测（node --test）
// 被测模块 src/renderer/split-layout.js 是浏览器全局 + CommonJS 双导出，
// 此处通过 require 导入，浏览器端加载同一份文件，保证两端逻辑一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getAllPanes, findPane, getParentOf, normalize, getOffsetRatio, applyDragRatios } =
    require('../src/renderer/split-layout.js');

// ── 树遍历 ──

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

// ── 节点查找 ──

test('findPane 找到/找不到/无分屏', () => {
    const tab = {
        splitRoot: { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] },
    };
    assert.equal(findPane(tab, 'a').id, 'a');
    assert.equal(findPane(tab, 'nope'), null);
    assert.equal(findPane({}), null);
});

test('getParentOf 返回父节点，根与无分屏返回 null', () => {
    const root = { orientation: 'h', children: [{ id: 'a' }, { id: 'b' }], ratios: [0.5, 0.5] };
    const tab = { splitRoot: root };
    assert.equal(getParentOf(tab, root), null);
    assert.equal(getParentOf(tab, root.children[0]), root);
    assert.equal(getParentOf({ splitRoot: null }, { id: 'x' }), null);
});

// ── normalize 布局归一化 ──

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

test('normalize 不同向嵌套保留结构', () => {
    // v 嵌 h（或反之）是合法分屏结构，normalize 只归一化比率，不展开
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
    // b 的占比 = 0.5（父占比）* 0.25 = 0.125，c = 0.375
    assert.ok(Math.abs(c.ratios[0] - 0.5) < 1e-9);
    assert.ok(Math.abs(c.ratios[1] - 0.125) < 1e-9);
    assert.ok(Math.abs(c.ratios[2] - 0.375) < 1e-9);
    // 归一化后和为 1
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

// ── 拖拽比例 ──

test('applyDragRatios 正常拖动', () => {
    const [a, b] = applyDragRatios(0.5, 0.5, 0.1, 0.05);
    assert.ok(Math.abs(a - 0.6) < 1e-9);
    assert.ok(Math.abs(b - 0.4) < 1e-9);
});

test('applyDragRatios 单边触底钳制', () => {
    const [a, b] = applyDragRatios(0.5, 0.5, 0.7, 0.05);
    assert.ok(Math.abs(a - 0.95) < 1e-9);
    assert.ok(Math.abs(b - 0.05) < 1e-9);
    // 反向
    const [a2, b2] = applyDragRatios(0.5, 0.5, -0.7, 0.05);
    assert.ok(Math.abs(a2 - 0.05) < 1e-9);
    assert.ok(Math.abs(b2 - 0.95) < 1e-9);
});

test('applyDragRatios 双方都触底时保底', () => {
    // 极小初始值 + 极端拖动，两边都不低于 minRatio
    const [a, b] = applyDragRatios(0.06, 0.94, 10, 0.05);
    assert.ok(a >= 0.05 && b >= 0.05);
});

// ── 偏移比例 ──

test('getOffsetRatio 前 n 项之和', () => {
    const c = { ratios: [0.3, 0.4, 0.3] };
    assert.equal(getOffsetRatio(c, 0), 0);
    assert.ok(Math.abs(getOffsetRatio(c, 1) - 0.3) < 1e-9);
    assert.ok(Math.abs(getOffsetRatio(c, 2) - 0.7) < 1e-9);
});
