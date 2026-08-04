// ZTerm - 快捷命令纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterQuickCommands, stripTrailingNewline } = require('../src/renderer/qc-utils.js');

const COMMANDS = [
    { id: '1', name: '查看系统信息', command: 'htop', group: '常用' },
    { id: '2', name: '查看磁盘使用', command: 'df -h', group: '常用' },
    { id: '3', name: 'Git Status', command: 'git status', group: 'Git' },
];

test('filterQuickCommands 空查询返回全量副本', () => {
    const out = filterQuickCommands(COMMANDS, '');
    assert.equal(out.length, 3);
    assert.notEqual(out, COMMANDS, '不应返回原数组引用');
});

test('filterQuickCommands 按名称匹配（大小写不敏感）', () => {
    assert.deepEqual(filterQuickCommands(COMMANDS, 'git').map(c => c.id), ['3']);
    assert.deepEqual(filterQuickCommands(COMMANDS, 'GIT').map(c => c.id), ['3']);
});

test('filterQuickCommands 按分组匹配', () => {
    assert.deepEqual(filterQuickCommands(COMMANDS, '常用').map(c => c.id), ['1', '2']);
});

test('filterQuickCommands 按命令内容匹配', () => {
    assert.deepEqual(filterQuickCommands(COMMANDS, 'df -h').map(c => c.id), ['2']);
});

test('filterQuickCommands 无匹配返回空', () => {
    assert.deepEqual(filterQuickCommands(COMMANDS, 'zzz不存在'), []);
});

test('filterQuickCommands 缺字段命令不崩溃', () => {
    const dirty = [{ id: 'x' }, { id: 'y', name: 'ok' }];
    assert.equal(filterQuickCommands(dirty, 'ok').length, 1);
    assert.equal(filterQuickCommands(dirty, 'x').length, 0); // 无 name/group/command 字段不匹配
});

// ── stripTrailingNewline（末尾回车自动执行开关）──

test('stripTrailingNewline 剥掉末尾一个换行', () => {
    assert.equal(stripTrailingNewline('tail -f /var/log/a.log\n'), 'tail -f /var/log/a.log');
    // 多行命令：只剥最后一个，中间换行保留
    assert.equal(stripTrailingNewline('cd /app\nnpm run dev\n'), 'cd /app\nnpm run dev');
});

test('stripTrailingNewline 多个末尾换行只剥一个', () => {
    assert.equal(stripTrailingNewline('a\n\n'), 'a\n');
    assert.equal(stripTrailingNewline('a\n\n\n'), 'a\n\n');
});

test('stripTrailingNewline 无末尾换行原样返回', () => {
    assert.equal(stripTrailingNewline('ls -la'), 'ls -la');
    assert.equal(stripTrailingNewline(''), '');
    assert.equal(stripTrailingNewline('\n'), '');
    // 末尾空格不受影响
    assert.equal(stripTrailingNewline('ls  '), 'ls  ');
});

test('stripTrailingNewline 中间换行不受影响', () => {
    assert.equal(stripTrailingNewline('a\nb'), 'a\nb');
});
