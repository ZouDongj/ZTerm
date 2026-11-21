// ZTerm - tab strip layout classification unit tests (node --test)
// The three states mirror zterm-flutter's TabRowMetrics: the sparse->sharing
// flip is driven by the measured per-tab CONTENT total (not a fixed count*max
// budget), sparse leaves widths unpinned (tabWidth null) so the add/menu
// buttons hug the last tab, sharing pins floor(equal share), overflow pins
// the 100px floor + scrolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeTabStripPlan, TAB_MIN_WIDTH, TAB_MAX_WIDTH, TAB_CONTENT_MIN, TAB_ADAPTIVE_MIN, TAB_STRIP_RIGHT_RESERVE } = require('../src/renderer/tabstrip-layout.js');

test('内容总和放得下：sparse，不钉宽度（按钮紧跟最后的 tab）', () => {
    assert.deepEqual(computeTabStripPlan([110, 140, 200], 1200, 2, 100), { state: 'sparse', tabWidth: null });
    assert.deepEqual(computeTabStripPlan([240, 240, 240], 1200, 2, 100), { state: 'sparse', tabWidth: null });
});

test('内容总和恰好等于可用宽度仍是 sparse（贴边边界）', () => {
    // [110, 130] + gap 2 → sum = 242
    assert.deepEqual(computeTabStripPlan([110, 130], 242, 2, 100), { state: 'sparse', tabWidth: null });
});

test('内容塞不下才翻转 sharing：等分取整且不低于下限', () => {
    // 5 tabs desired 140 → sum 708 > 700; share = (700-8)/5 = 138.4
    const plan = computeTabStripPlan([140, 140, 140, 140, 140], 700, 2, 100);
    assert.equal(plan.state, 'sharing');
    assert.equal(plan.tabWidth, 138);
});

test('翻转点由内容总和驱动，不是 tab 数量', () => {
    // 2 个 240 满宽 tab：sum 482 > 480 → 立即 sharing（239），数量少也挤
    assert.deepEqual(computeTabStripPlan([240, 240], 480, 2, 100), { state: 'sharing', tabWidth: 239 });
    // 3 个短标题 tab：sum 334 <= 480 → sparse，数量多也不挤
    assert.deepEqual(computeTabStripPlan([110, 110, 110], 480, 2, 100), { state: 'sparse', tabWidth: null });
});

test('sharing 下边界：share >= 100 仍 sharing，< 100 转 overflow', () => {
    // 10 tabs, gap 2: share = (avail - 18) / 10
    assert.deepEqual(computeTabStripPlan(Array(10).fill(110), 1018, 2, 100), { state: 'sharing', tabWidth: 100 });  // share = 100.0
    assert.deepEqual(computeTabStripPlan(Array(10).fill(110), 1017, 2, 100), { state: 'overflow', tabWidth: 100 }); // share = 99.9
});

test('overflow：钉死下限宽度', () => {
    assert.deepEqual(computeTabStripPlan(Array(20).fill(150), 1200, 2, 100), { state: 'overflow', tabWidth: 100 });
});

test('退化输入一律 sparse（不钉宽度、不出箭头）', () => {
    assert.deepEqual(computeTabStripPlan([], 1200, 2, 100), { state: 'sparse', tabWidth: null });
    assert.deepEqual(computeTabStripPlan(undefined, 1200, 2, 100), { state: 'sparse', tabWidth: null });
    for (const w of [0, -5, NaN, Infinity]) {
        assert.deepEqual(computeTabStripPlan([110, 130], w, 2, 100), { state: 'sparse', tabWidth: null }, `width=${w}`);
    }
});

test('无效 desired 条目回退内容地板 110', () => {
    // [NaN, -1, 0] → [110, 110, 110]：sum = 334
    assert.deepEqual(computeTabStripPlan([NaN, -1, 0], 334, 2, 100), { state: 'sparse', tabWidth: null });
    // avail 333 → share = (333-4)/3 = 109.67 → sharing 109
    assert.deepEqual(computeTabStripPlan([NaN, -1, 0], 333, 2, 100), { state: 'sharing', tabWidth: 109 });
});

test('默认常量即 WT/MUX 的 100/240 + 内容地板 110', () => {
    assert.equal(TAB_MIN_WIDTH, 100);
    assert.equal(TAB_MAX_WIDTH, 240);
    assert.equal(TAB_CONTENT_MIN, 110);
    assert.equal(computeTabStripPlan(Array(10).fill(110), 1017, 2).state, 'overflow'); // 缺省 minWidth 走默认常量
});

test('右侧呼吸留白常量与 CSS #tabbar padding-right 同步', () => {
    assert.equal(TAB_STRIP_RIGHT_RESERVE, 48);
});

// ── Adaptive tab width mode (issue #45) ──

test('adaptive mode constant TAB_ADAPTIVE_MIN matches the 72px compact floor', () => {
    assert.equal(TAB_ADAPTIVE_MIN, 72);
    assert.ok(TAB_ADAPTIVE_MIN < TAB_MIN_WIDTH && TAB_ADAPTIVE_MIN < TAB_CONTENT_MIN);
});

test('adaptive mode: fitting tabs stay sparse with tabWidth null', () => {
    // Mixed short and long titles: 72 + 87 + 240 + 2*2 = 403 <= 600
    assert.deepEqual(
        computeTabStripPlan([72, 87, 240], 600, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'sparse', tabWidth: null },
    );
});

test('adaptive mode: exact boundary stays sparse and 1px over jumps directly to overflow with tabWidth null', () => {
    // [72, 87, 240] + 2*2 = 403
    assert.deepEqual(
        computeTabStripPlan([72, 87, 240], 403, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'sparse', tabWidth: null },
    );
    // 1px narrower: skips equal-width sharing and never pins tabWidth
    assert.deepEqual(
        computeTabStripPlan([72, 87, 240], 402, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'overflow', tabWidth: null },
    );
    // Default mode at the exact same width enters sharing with equal width instead
    assert.deepEqual(
        computeTabStripPlan([72, 87, 240], 402, 2, TAB_MIN_WIDTH, { adaptive: false }),
        { state: 'sharing', tabWidth: 132 },
    );
});

test('adaptive mode: crowded strips stay overflow with tabWidth null (never pinned to 100px)', () => {
    const mixed = [72, 80, 240, 75, 220, 88, 240, 72, 190, 240];
    assert.deepEqual(
        computeTabStripPlan(mixed, 800, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'overflow', tabWidth: null },
    );
    // Default mode pins every tab to 100px
    assert.deepEqual(
        computeTabStripPlan(mixed, 800, 2, TAB_MIN_WIDTH, { adaptive: false }),
        { state: 'overflow', tabWidth: 100 },
    );
});

test('adaptive mode: single tab fits in sparse and overflows with tabWidth null when wider than strip', () => {
    assert.deepEqual(
        computeTabStripPlan([72], 200, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'sparse', tabWidth: null },
    );
    assert.deepEqual(
        computeTabStripPlan([240], 240, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'sparse', tabWidth: null },
    );
    assert.deepEqual(
        computeTabStripPlan([240], 200, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'overflow', tabWidth: null },
    );
});

test('adaptive mode: empty and degenerate inputs stay sparse with tabWidth null', () => {
    assert.deepEqual(computeTabStripPlan([], 800, 2, TAB_MIN_WIDTH, { adaptive: true }), { state: 'sparse', tabWidth: null });
    assert.deepEqual(computeTabStripPlan(undefined, 800, 2, TAB_MIN_WIDTH, { adaptive: true }), { state: 'sparse', tabWidth: null });
    for (const w of [0, -10, NaN, Infinity, -Infinity]) {
        assert.deepEqual(
            computeTabStripPlan([72, 240], w, 2, TAB_MIN_WIDTH, { adaptive: true }),
            { state: 'sparse', tabWidth: null },
            `width=${w}`,
        );
    }
});

test('adaptive mode: invalid desired entries fall back to TAB_ADAPTIVE_MIN (72)', () => {
    // [NaN, -1, 0] -> [72, 72, 72] + 2*2 = 220
    assert.deepEqual(
        computeTabStripPlan([NaN, -1, 0], 220, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'sparse', tabWidth: null },
    );
    assert.deepEqual(
        computeTabStripPlan([NaN, -1, 0], 219, 2, TAB_MIN_WIDTH, { adaptive: true }),
        { state: 'overflow', tabWidth: null },
    );
});

test('adaptive mode: zero-oscillation invariant on arrows-hidden availableWidth', () => {
    // Even if toggling scroll arrows shrinks the live viewport by 52px,
    // recomputing against the invariant arrows-hidden availability yields the
    // exact same overflow verdict on every pass.
    const tabs = [72, 240, 90, 240]; // sum = 648
    const arrowsHiddenAvail = 640;
    const first = computeTabStripPlan(tabs, arrowsHiddenAvail, 2, TAB_MIN_WIDTH, { adaptive: true });
    const second = computeTabStripPlan(tabs, arrowsHiddenAvail, 2, TAB_MIN_WIDTH, { adaptive: true });
    assert.deepEqual(first, { state: 'overflow', tabWidth: null });
    assert.deepEqual(second, first);
});
