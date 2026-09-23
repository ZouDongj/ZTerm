// ZTerm - 高亮规则纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHighlightRegex, applySgrParams, sgrStatesAt, buildHighlightEndSeq, applyHighlightToLine, createSgrState } =
    require('../src/renderer/highlight-utils.js');

test('buildHighlightRegex 普通关键字被转义（正则元字符无效）', () => {
    // 关键字 "a.b" 应匹配字面量 a.b，而不是任意字符
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

// ── issue #9：高亮结束序列必须恢复匹配位置原有的 SGR 状态 ──

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
    // 可打印字符位置：'a'=0、'b'=6、'd'=12
    const [s1, s2, s3] = sgrStatesAt(line, [0, 6, 12]);
    assert.equal(s1.fg, null);           // 'a' 之前无 SGR
    assert.equal(s2.fg, '31');           // 'b' 处已见 31
    assert.equal(s2.bold, false);
    assert.equal(s3.fg, '31');
    assert.equal(s3.bold, true);         // 'd' 处已见 1
});

test('applyHighlightToLine 关键字后文本恢复原行颜色（issue #9 现场形态）', () => {
    // 现场：一行自带颜色，中间单词命中高亮后，后面的字被洗成默认白
    const line = '\x1b[38;2;97;175;239minfo: build \x1b[1mERROR\x1b[22m happened\x1b[39m';
    const out = applyHighlightToLine(line, [fgRule]);
    const kw = out.indexOf('ERROR');
    const after = out.slice(kw + 'ERROR'.length);
    // 匹配结束后必须先恢复 38;2;97;175;239，再跟原行的 \x1b[22m，而不是直接 \x1b[39m
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
