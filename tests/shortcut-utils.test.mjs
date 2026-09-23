// ZTerm - keyboard shortcut pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { comboFromEvent, comboDisplay, mergeShortcutBindings, BROWSER_ACCELERATOR_DENYLIST, browserAcceleratorDenied } =
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
    // Dead (IME composition keys) and Unidentified: extract the character from the code's Key/Digit prefix
    assert.equal(comboFromEvent(ev({ key: 'Dead', code: 'KeyQ' })), 'Q');
    assert.equal(comboFromEvent(ev({ key: 'Unidentified', code: 'Digit3' })), '3');
    // when code has no Key/Digit prefix, use it as-is
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
    // returns a new object; arguments are not mutated
    const merged = mergeShortcutBindings(defaults, {});
    assert.notEqual(merged, defaults);
});

// ── browserAcceleratorDenied (Edge-OOUI accelerator interception) ──

test('browserAcceleratorDenied Ctrl+J 命中拦截名单', () => {
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'j' })), true);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'J' })), true);
});

test('browserAcceleratorDenied 非名单组合放行', () => {
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'h' })), false);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'p' })), false);
    assert.equal(browserAcceleratorDenied(ev({ key: 'j' })), false);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, shiftKey: true, key: 'j' })), false);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, altKey: true, key: 'j' })), false);
});

test('browserAcceleratorDenied IME 合成中放行', () => {
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'j', isComposing: true })), false);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'j', keyCode: 229 })), false);
});

test('BROWSER_ACCELERATOR_DENYLIST 当前仅含 ctrl+j（扩项需证据）', () => {
    assert.deepEqual([...BROWSER_ACCELERATOR_DENYLIST], ['ctrl+j']);
});
