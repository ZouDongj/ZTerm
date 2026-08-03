// ZTerm - 快捷键纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { comboFromEvent, comboDisplay, mergeShortcutBindings } =
    require('../src/renderer/shortcut-utils.js');

// ── comboFromEvent ──

function ev(overrides = {}) {
    return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...overrides };
}

test('comboFromEvent 无修饰键单字符大写', () => {
    assert.equal(comboFromEvent(ev({ key: 'n' })), 'N');
});

test('comboFromEvent Ctrl+Shift 组合', () => {
    assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: 'N' })), 'Ctrl+Shift+N');
});

test('comboFromEvent Ctrl+Meta 都归为 Ctrl', () => {
    assert.equal(comboFromEvent(ev({ metaKey: true, key: 'W' })), 'Ctrl+W');
    assert.equal(comboFromEvent(ev({ ctrlKey: true, metaKey: true, key: 'W' })), 'Ctrl+W');
});

test('comboFromEvent 空格转为 Space', () => {
    assert.equal(comboFromEvent(ev({ ctrlKey: true, key: ' ' })), 'Ctrl+Space');
});

test('comboFromEvent 方向键保留 Arrow 前缀', () => {
    assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: 'ArrowUp' })), 'Ctrl+Shift+ArrowUp');
});

test('comboFromEvent Dead/Unidentified 回退到 e.code', () => {
    // Dead（输入法组合键）与 Unidentified：用 code 的 Key/Digit 提取字母
    assert.equal(comboFromEvent(ev({ key: 'Dead', code: 'KeyQ' })), 'Q');
    assert.equal(comboFromEvent(ev({ key: 'Unidentified', code: 'Digit3' })), '3');
    // code 无 Key/Digit 前缀时原样使用
    assert.equal(comboFromEvent(ev({ key: 'Unidentified', code: 'F2' })), 'F2');
});

test('comboFromEvent 空 key 且无 code', () => {
    assert.equal(comboFromEvent(ev({ key: '' })), '');
});

// ── comboDisplay ──

test('comboDisplay 方向键转箭头符号', () => {
    assert.equal(comboDisplay('Ctrl+Shift+ArrowUp'), 'Ctrl+Shift+↑');
    assert.equal(comboDisplay('ArrowLeft+ArrowRight'), '←+→');
    assert.equal(comboDisplay('Ctrl+F'), 'Ctrl+F');
});

// ── mergeShortcutBindings ──

test('mergeShortcutBindings 用户覆盖默认且保留未覆盖项', () => {
    const defaults = { a: 'Ctrl+A', b: 'Ctrl+B' };
    const merged = mergeShortcutBindings(defaults, { b: 'Ctrl+Shift+B' });
    assert.deepEqual(merged, { a: 'Ctrl+A', b: 'Ctrl+Shift+B' });
});

test('mergeShortcutBindings 无覆盖/空覆盖时保持默认', () => {
    const defaults = { a: 'Ctrl+A' };
    assert.deepEqual(mergeShortcutBindings(defaults, undefined), defaults);
    assert.deepEqual(mergeShortcutBindings(defaults, {}), defaults);
    // 返回新对象，不修改入参
    const merged = mergeShortcutBindings(defaults, {});
    assert.notEqual(merged, defaults);
});
