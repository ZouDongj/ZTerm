// ZTerm - 高亮规则纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHighlightRegex } = require('../src/renderer/highlight-utils.js');

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
