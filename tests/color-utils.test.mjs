// ZTerm - 颜色转换纯逻辑单测（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } =
    require('../src/renderer/color-utils.js');

// ── hexToRgb ──

test('hexToRgb 标准格式（带/不带 #，大小写）', () => {
    assert.deepEqual(hexToRgb('#61afef'), { r: 0x61, g: 0xaf, b: 0xef });
    assert.deepEqual(hexToRgb('61afef'), { r: 0x61, g: 0xaf, b: 0xef });
    assert.deepEqual(hexToRgb('#ABCDEF'), { r: 0xab, g: 0xcd, b: 0xef });
    assert.deepEqual(hexToRgb('#000000'), { r: 0, g: 0, b: 0 });
    assert.deepEqual(hexToRgb('#ffffff'), { r: 255, g: 255, b: 255 });
});

test('hexToRgb 无效输入返回 null', () => {
    assert.equal(hexToRgb(null), null);
    assert.equal(hexToRgb(''), null);
    assert.equal(hexToRgb('#abc'), null); // 短格式不支持
    assert.equal(hexToRgb('red'), null);
    assert.equal(hexToRgb('#12345'), null);
    assert.equal(hexToRgb('#1234567'), null);
    assert.equal(hexToRgb('#gggggg'), null); // 非十六进制
});

// ── rgbToHex ──

test('rgbToHex 补零与格式', () => {
    assert.equal(rgbToHex(0x61, 0xaf, 0xef), '#61afef');
    assert.equal(rgbToHex(0, 0, 0), '#000000');
    assert.equal(rgbToHex(255, 255, 255), '#ffffff');
    assert.equal(rgbToHex(10, 1, 0), '#0a0100');
});

test('hex → rgb → hex roundtrip 保真', () => {
    for (const hex of ['#61afef', '#0a0b0c', '#ffffff', '#000000']) {
        const rgb = hexToRgb(hex);
        assert.equal(rgbToHex(rgb.r, rgb.g, rgb.b), hex);
    }
});

// ── rgbToHsv / hsvToRgb ──

test('rgbToHsv 边界：黑/白/纯红', () => {
    assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 });
    assert.deepEqual(rgbToHsv(255, 255, 255), { h: 0, s: 0, v: 1 });
    const red = rgbToHsv(255, 0, 0);
    assert.equal(red.h, 0);
    assert.equal(red.s, 1);
    assert.equal(red.v, 1);
});

test('rgbToHsv 绿色与蓝色色相', () => {
    const green = rgbToHsv(0, 255, 0);
    assert.ok(Math.abs(green.h - 120) < 1e-9, `green h=${green.h}`);
    const blue = rgbToHsv(0, 0, 255);
    assert.ok(Math.abs(blue.h - 240) < 1e-9, `blue h=${blue.h}`);
});

test('hsvToRgb 基色', () => {
    assert.deepEqual(hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
    assert.deepEqual(hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
    assert.deepEqual(hsvToRgb(0, 0, 1), { r: 255, g: 255, b: 255 });
    assert.deepEqual(hsvToRgb(0, 0, 0), { r: 0, g: 0, b: 0 });
});

test('rgb → hsv → rgb roundtrip 近似保真', () => {
    for (const [r, g, b] of [[0x61, 0xaf, 0xef], [0x12, 0x34, 0x56], [200, 30, 90], [255, 255, 0]]) {
        const { h, s, v } = rgbToHsv(r, g, b);
        const back = hsvToRgb(h, s, v);
        // 取整误差允许 ±2
        assert.ok(Math.abs(back.r - r) <= 2, `r ${back.r} vs ${r}`);
        assert.ok(Math.abs(back.g - g) <= 2, `g ${back.g} vs ${g}`);
        assert.ok(Math.abs(back.b - b) <= 2, `b ${back.b} vs ${b}`);
    }
});
