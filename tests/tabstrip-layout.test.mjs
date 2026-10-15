// ZTerm - tab strip layout classification unit tests (node --test)
// The three states mirror Windows Terminal's tab row as one continuous clamp
// curve: sparse pins the 240 cap, sharing pins floor(equal share) down to the
// 100 floor, overflow pins 100 + scrolls. Boundary correctness here is what
// keeps the width jumps monotone and trailing tabs reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeTabStripPlan, TAB_MIN_WIDTH, TAB_MAX_WIDTH } = require('../src/renderer/tabstrip-layout.js');

test('少 tab：sparse，钉上限宽度（WT 等宽语义）', () => {
    assert.deepEqual(computeTabStripPlan(3, 1200, 2, 100, 240), { state: 'sparse', tabWidth: 240 });
});

test('share 恰好等于上限仍是 sparse（240 边界）', () => {
    assert.deepEqual(computeTabStripPlan(5, 1210, 2, 100, 240), { state: 'sparse', tabWidth: 240 }); // share = 240.4
    assert.deepEqual(computeTabStripPlan(5, 1208, 2, 100, 240), { state: 'sparse', tabWidth: 240 }); // share = 240.0
});

test('中等数量：sharing，等分取整且不低于下限', () => {
    const plan = computeTabStripPlan(5, 1200, 2, 100, 240); // share = (1200-8)/5 = 238.4
    assert.equal(plan.state, 'sharing');
    assert.equal(plan.tabWidth, 238);
});

test('sharing 下边界：share == 100 仍 sharing，< 100 转 overflow', () => {
    // count=10, gap=2: share = (avail - 18) / 10
    assert.deepEqual(computeTabStripPlan(10, 1018, 2, 100, 240), { state: 'sharing', tabWidth: 100 });  // share = 100.0
    assert.deepEqual(computeTabStripPlan(10, 1017, 2, 100, 240), { state: 'overflow', tabWidth: 100 }); // share = 99.9
});

test('overflow：钉死下限宽度', () => {
    assert.deepEqual(computeTabStripPlan(20, 1200, 2, 100, 240), { state: 'overflow', tabWidth: 100 });
});

test('退化输入一律 sparse（不钉宽度、不出箭头）', () => {
    for (const [c, w] of [[0, 1200], [-1, 1200], [3, 0], [3, -5], [NaN, 1200], [3, NaN], [Infinity, 1200]]) {
        assert.deepEqual(computeTabStripPlan(c, w, 2, 100, 240), { state: 'sparse', tabWidth: null }, `count=${c} width=${w}`);
    }
});

test('gap 计入份额：紧邻上限的 gap 会改变分档', () => {
    // count=2: gap=0 → share=240 → sparse; gap=2 → share=239 → sharing
    assert.equal(computeTabStripPlan(2, 480, 0, 100, 240).state, 'sparse');
    assert.equal(computeTabStripPlan(2, 480, 2, 100, 240).state, 'sharing');
});

test('默认常量即 WT/MUX 的 100/240', () => {
    assert.equal(TAB_MIN_WIDTH, 100);
    assert.equal(TAB_MAX_WIDTH, 240);
    assert.equal(computeTabStripPlan(10, 1017, 2).state, 'overflow'); // 缺省参数走默认常量
});
