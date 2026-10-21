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

// ── B-P2-14: physical letter keys are layout-independent ──

test('comboFromEvent 非拉丁布局：物理字母键以 e.code 命中拉丁绑定', () => {
    // Cyrillic layout: the physical C key reports e.key='с' (U+0441).
    assert.equal(comboFromEvent(ev({ ctrlKey: true, key: 'с', code: 'KeyC' })), 'Ctrl+C');
    // Greek layout: physical V reports 'ω'.
    assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: 'ω', code: 'KeyV' })), 'Ctrl+Shift+V');
});

test('comboFromEvent 拉丁布局录制逐字节不变（存量绑定兼容）', () => {
    // Same physical key on a Latin layout: the produced combo must be
    // identical to the pre-fix e.key path so existing bindings keep matching.
    assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: 'n', code: 'KeyN' })), 'Ctrl+Shift+N');
    assert.equal(comboFromEvent(ev({ ctrlKey: true, key: 'N', code: 'KeyN', shiftKey: true })), 'Ctrl+Shift+N');
    // No code (synthetic/legacy events): unchanged fallback to e.key.
    assert.equal(comboFromEvent(ev({ ctrlKey: true, key: 't' })), 'Ctrl+T');
});

test('comboFromEvent Shift 层字符与数字保持 e.key（布局表达真实字符）', () => {
    // AZERTY: Shift+Digit2 would report a different e.key; digits must not be
    // remapped through e.code.
    assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: '@', code: 'Digit2' })), 'Ctrl+Shift+@');
    // Punctuation likewise (Ctrl+, is a default binding).
    assert.equal(comboFromEvent(ev({ ctrlKey: true, key: ',', code: 'Comma' })), 'Ctrl+,');
});

test('browserAcceleratorDenied 非拉丁布局物理 J 键仍命中 ctrl+j', () => {
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'й', code: 'KeyJ' })), true);
    // Latin layout unchanged.
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'j', code: 'KeyJ' })), true);
    assert.equal(browserAcceleratorDenied(ev({ ctrlKey: true, key: 'h', code: 'KeyH' })), false);
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
