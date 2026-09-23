// ZTerm - tab display-name resolution pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveTabName } = require('../src/renderer/tab-title-utils.js');

test('单终端 tab：无 OSC 标题时保持当前名称', () => {
    const tab = { name: 'Git Bash' };
    assert.equal(resolveTabName(tab, []), 'Git Bash');
});

test('单终端 tab：OSC 标题覆盖默认名称', () => {
    const tab = { name: 'Git Bash', _oscTitle: 'root@host: ~/src' };
    assert.equal(resolveTabName(tab, []), 'root@host: ~/src');
});

test('单终端 tab：空/纯空白 OSC 标题视为未设置', () => {
    assert.equal(resolveTabName({ name: 'SSH', _oscTitle: '' }, []), 'SSH');
    assert.equal(resolveTabName({ name: 'SSH', _oscTitle: '   ' }, []), 'SSH');
});

test('单终端 tab：OSC 标题去掉首尾空白', () => {
    const tab = { name: 'SSH', _oscTitle: '  build server  ' };
    assert.equal(resolveTabName(tab, []), 'build server');
});

test('手动重命名（_customName）锁定后返回 null', () => {
    const tab = { name: '我的服务器', _customName: true, _oscTitle: 'root@host' };
    assert.equal(resolveTabName(tab, []), null);
    const splitTab = { name: '我的分屏', _customName: true, splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(splitTab, [{ name: 'a' }]), null);
});

test('分屏单 pane：OSC 标题优先于 pane 名', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, [{ name: 'profile', _oscTitle: 'remote:~' }]), 'remote:~');
    assert.equal(resolveTabName(tab, [{ name: 'profile' }]), 'profile');
});

test('分屏单 pane：pane 无名时回退 tab 当前名', () => {
    const tab = { name: 'fallback', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, [{ name: '' }]), 'fallback');
    assert.equal(resolveTabName(tab, []), 'fallback');
});

test('分屏多 pane：名称拼接前去重', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    const panes = [{ name: 'ssh-a' }, { name: 'ssh-a' }, { name: 'local' }];
    assert.equal(resolveTabName(tab, panes), 'ssh-a | local');
});

test('分屏多 pane：OSC 标题参与拼接与去重', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    const panes = [
        { name: 'ssh-a', _oscTitle: 'root@a:~' },
        { name: 'ssh-b', _oscTitle: 'root@b:~' },
        { name: 'ssh-c' }, // no OSC title → use the pane name
    ];
    assert.equal(resolveTabName(tab, panes), 'root@a:~ | root@b:~ | ssh-c');
});

test('分屏多 pane：全部无名时得到空串（保持既有语义）', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, [{ name: '' }, { name: '' }]), '');
});

test('异常输入不抛异常', () => {
    assert.equal(resolveTabName(null, []), null);
    const tab = { name: 'x', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, null), 'x');
    assert.equal(resolveTabName(tab, [null, undefined]), '');
});
