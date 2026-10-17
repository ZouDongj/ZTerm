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

test('comboFromEvent Meta(Win) 记录为独立 Win 修饰键（不再并入 Ctrl）', () => {
    assert.equal(comboFromEvent(ev({ metaKey: true, key: 'W' })), 'Win+W');
    assert.equal(comboFromEvent(ev({ ctrlKey: true, metaKey: true, key: 'X' })), 'Ctrl+Win+X');
    assert.equal(comboFromEvent(ev({ metaKey: true, shiftKey: true, key: 'ArrowUp' })), 'Win+Shift+ArrowUp');
    // Ctrl alone stays Ctrl: the recorded strings for Ctrl+X and Ctrl+Win+X differ
    assert.notEqual(comboFromEvent(ev({ ctrlKey: true, key: 'X' })), comboFromEvent(ev({ ctrlKey: true, metaKey: true, key: 'X' })));
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

test('comboDisplay Win 修饰键按字面渲染为 Win', () => {
    assert.equal(comboDisplay('Ctrl+Win+X'), 'Ctrl+Win+X');
    assert.equal(comboDisplay('Win+ArrowLeft'), 'Win+←');
    assert.equal(comboDisplay('Win+Shift+ArrowUp'), 'Win+Shift+↑');
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

test('mergeShortcutBindings 遗留存储绑定（不含 Win）原样合并', () => {
    // Stored configs written before Win became a modifier never contain Win;
    // they must keep merging (and therefore matching) unchanged.
    const defaults = { a: 'Ctrl+A', b: 'Ctrl+B', reconnectTab: 'Ctrl+Shift+R' };
    const stored = { b: 'Ctrl+W' }; // legacy override, recorded when Meta folded into Ctrl
    const merged = mergeShortcutBindings(defaults, stored);
    assert.equal(merged.b, 'Ctrl+W');
    assert.equal(merged.a, 'Ctrl+A');
    // a Win binding recorded now overrides the same way any combo does
    assert.equal(mergeShortcutBindings(defaults, { a: 'Ctrl+Win+A' }).a, 'Ctrl+Win+A');
    // round-trip through JSON (the persisted-config shape) keeps Win intact
    assert.equal(JSON.parse(JSON.stringify(merged)).b, 'Ctrl+W');
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
