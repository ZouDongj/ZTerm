// ZTerm - highlight rule pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHighlightRegex, applySgrParams, sgrStatesAt, buildHighlightEndSeq, applyHighlightToLine, createSgrState, normalizeHighlightColor, _hexToRgb } =
    require('../src/renderer/highlight-utils.js');

test('buildHighlightRegex 普通关键字被转义（正则元字符无效）', () => {
    // keyword "a.b" must match the literal a.b, not any character
    const re = buildHighlightRegex('a.b', false, false);
    assert.ok(re, 'regex should compile');
    assert.ok(re.test('a.b'));
    assert.ok(!re.test('axb'), 'dot must be escaped for literal keywords');
});

test('buildHighlightRegex 正则模式按原文编译', () => {
    const re = buildHighlightRegex('^err\\d+', true, false);
    assert.ok(re.test('err42'));
    assert.ok(!re.test('xerr42'), '^ anchor must apply');
});

test('buildHighlightRegex 大小写敏感 flag', () => {
    const sensitive = buildHighlightRegex('ERROR', false, true);
    assert.ok(!sensitive.test('error'), 'case-sensitive must not match lowercase');
    const insensitive = buildHighlightRegex('ERROR', false, false);
    assert.ok(insensitive.test('error'), 'case-insensitive must match lowercase');
});

test('buildHighlightRegex 非法正则返回 null 不抛异常', () => {
    assert.equal(buildHighlightRegex('([unclosed', true, false), null);
    assert.equal(buildHighlightRegex('a{2,1}', true, false), null);
});

test('buildHighlightRegex 空文本编译为永不匹配（空串匹配）', () => {
    const re = buildHighlightRegex('', false, false);
    assert.ok(re, 'empty keyword compiles');
    assert.equal(re.exec('abc').index, 0, 'empty regex matches at position 0');
});

// ── issue #9: the highlight end sequence must restore the SGR state active at the match position ──

const fgRule = { text: 'ERROR', enabled: true, foreground: true, foregroundColor: '#e06c75',
                 background: false, backgroundColor: '', bold: false, italic: false, underline: false };

test('applySgrParams 跟踪标准色/亮色/重置', () => {
    const s = createSgrState();
    applySgrParams(s, '31');
    assert.equal(s.fg, '31');
    applySgrParams(s, '1;42');
    assert.equal(s.bold, true);
    assert.equal(s.bg, '42');
    applySgrParams(s, '39');
    assert.equal(s.fg, null);
    applySgrParams(s, '0');
    assert.deepEqual(s, createSgrState());
    applySgrParams(s, '96;105');
    assert.equal(s.fg, '96');
    assert.equal(s.bg, '105');
});

test('applySgrParams 跟踪 256 色与真彩（含多参数序列）', () => {
    const s = createSgrState();
    applySgrParams(s, '38;5;203');
    assert.equal(s.fg, '38;5;203');
    applySgrParams(s, '1;38;2;224;108;117');
    assert.equal(s.bold, true);
    assert.equal(s.fg, '38;2;224;108;117');
    applySgrParams(s, '48;2;10;20;30');
    assert.equal(s.bg, '48;2;10;20;30');
});

test('buildHighlightEndSeq 恢复匹配位置的原色而非默认色', () => {
    const s = createSgrState();
    applySgrParams(s, '38;2;97;175;239');
    const seq = buildHighlightEndSeq(fgRule, s);
    assert.equal(seq, '\x1b[38;2;97;175;239m', 'must re-emit the active fg, not 39m');
});

test('buildHighlightEndSeq 无原状态时保持旧行为（默认重置）', () => {
    const seq = buildHighlightEndSeq(fgRule, createSgrState());
    assert.equal(seq, '\x1b[39m');
});

test('buildHighlightEndSeq 原行加粗时不再误关粗体', () => {
    const s = createSgrState();
    applySgrParams(s, '1');
    const seq = buildHighlightEndSeq({ ...fgRule, bold: true }, s);
    assert.ok(seq.includes('\x1b[1m'), 'bold must be re-enabled, not turned off');
    assert.ok(!seq.includes('\x1b[22m'));
});

test('sgrStatesAt 按位置给出当时的渲染状态', () => {
    const line = 'a\x1b[31mbc\x1b[1mde';
    // printable character offsets: 'a'=0, 'b'=6, 'd'=12
    const [s1, s2, s3] = sgrStatesAt(line, [0, 6, 12]);
    assert.equal(s1.fg, null);           // no SGR before 'a'
    assert.equal(s2.fg, '31');           // 31 already seen at 'b'
    assert.equal(s2.bold, false);
    assert.equal(s3.fg, '31');
    assert.equal(s3.bold, true);         // 1 already seen at 'd'
});

test('applyHighlightToLine 关键字后文本恢复原行颜色（issue #9 现场形态）', () => {
    // a line carrying its own color: once a word in the middle is highlighted, the trailing text gets washed to default white
    const line = '\x1b[38;2;97;175;239minfo: build \x1b[1mERROR\x1b[22m happened\x1b[39m';
    const out = applyHighlightToLine(line, [fgRule]);
    const kw = out.indexOf('ERROR');
    const after = out.slice(kw + 'ERROR'.length);
    // after the match ends, 38;2;97;175;239 must be restored first, then the original line's \x1b[22m follows, not a direct \x1b[39m
    assert.ok(after.startsWith('\x1b[38;2;97;175;239m'),
        'original fg must be restored right after the keyword, got: ' + JSON.stringify(after.slice(0, 30)));
    assert.ok(!after.startsWith('\x1b[39m'), 'default reset must not wipe the original color');
});

test('applyHighlightToLine 关键字本身带上规则颜色（回归）', () => {
    const line = 'plain ERROR plain';
    const out = applyHighlightToLine(line, [fgRule]);
    assert.ok(out.includes('\x1b[38;2;224;108;117mERROR\x1b[39m'));
});

test('applyHighlightToLine 多个匹配各自恢复当时状态', () => {
    const rules = [
        { ...fgRule, text: 'foo' },
        { ...fgRule, text: 'bar' },
    ];
    const line = '\x1b[31mfoo x \x1b[32mbar y';
    const out = applyHighlightToLine(line, rules);
    const fooEnd = out.indexOf('foo') + 3;
    const barEnd = out.indexOf('bar') + 3;
    assert.ok(out.slice(fooEnd).startsWith('\x1b[31m'), 'foo 后恢复红色');
    assert.ok(out.slice(barEnd).startsWith('\x1b[32m'), 'bar 后恢复绿色');
});

test('applyHighlightToLine 转义序列区间内的匹配仍被丢弃（回归）', () => {
    const line = '\x1b]8;;http://ERROR.example\x07text';
    const out = applyHighlightToLine(line, [fgRule]);
    assert.equal(out, line, 'OSC 内的关键字不可注入');
});

test('applyHighlightToLine 同一行内同一关键字的每次出现都被高亮', () => {
    const line = 'ERROR first ERROR second';
    const out = applyHighlightToLine(line, [fgRule]);
    const painted = out.match(/\x1b\[38;2;224;108;117mERROR\x1b\[39m/g) || [];
    assert.equal(painted.length, 2, 'both occurrences must be painted, got: ' + JSON.stringify(out));
});

test('applyHighlightToLine 正则规则的多个匹配全部高亮', () => {
    const rule = { ...fgRule, text: '\\d+', isRegExp: true };
    const out = applyHighlightToLine('a1 b22 ccc', [rule]);
    assert.ok(out.includes('\x1b[38;2;224;108;117m1\x1b[39m'), 'first number painted');
    assert.ok(out.includes('\x1b[38;2;224;108;117m22\x1b[39m'), 'second number painted');
});

test('applyHighlightToLine 相邻不重叠的匹配都保留', () => {
    const rule = { ...fgRule, text: 'aa' };
    const out = applyHighlightToLine('aaaa', [rule]);
    const painted = out.match(/\x1b\[38;2;224;108;117maa\x1b\[39m/g) || [];
    assert.equal(painted.length, 2, 'both non-overlapping matches must be painted');
});

test('applyHighlightToLine 零宽匹配不死循环且不改变可见文本', () => {
    const rule = { ...fgRule, text: '(?=b)', isRegExp: true };
    const out = applyHighlightToLine('ab ab', [rule]);
    assert.equal(out.replace(/\x1b\[[0-9;]*m/g, ''), 'ab ab', 'visible text unchanged');
});

test('normalizeHighlightColor 三位 hex 展开为六位且终端可渲染', () => {
    assert.equal(normalizeHighlightColor('#abc'), '#aabbcc');
    assert.equal(normalizeHighlightColor('#Ab3'), '#AAbb33');
    assert.deepEqual(_hexToRgb(normalizeHighlightColor('#abc')), { r: 0xaa, g: 0xbb, b: 0xcc },
        'the expanded form must be accepted by the terminal color path');
});

test('normalizeHighlightColor 六位 hex 原样保留', () => {
    assert.equal(normalizeHighlightColor('#e06c75'), '#e06c75');
    assert.equal(normalizeHighlightColor('#E06C75'), '#E06C75');
});

test('normalizeHighlightColor 4/5/7/8 位及其他非法值返回 null', () => {
    for (const bad of ['#abcd', '#abcde', '#abcdef1', '#abcdef12', 'aabbcc', '#xyzabc', 'red', '#']) {
        assert.equal(normalizeHighlightColor(bad), null, JSON.stringify(bad) + ' must be rejected');
    }
});

test('normalizeHighlightColor 空值原样保留（不渲染颜色）', () => {
    assert.equal(normalizeHighlightColor(''), '');
});
