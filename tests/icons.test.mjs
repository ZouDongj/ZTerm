// ZTerm - inline SVG icon registry tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { iconSvg, ICONS } = require('../src/renderer/icons.js');

// Names the UI depends on (see src/renderer/icons.js and its call sites)
const REQUIRED = [
    'terminal', 'zap', 'settings', 'folder', 'folder-plus', 'upload',
    'arrow-up', 'arrow-down', 'arrow-up-down', 'key', 'lock', 'plus',
    'bell', 'rotate-ccw', 'eye', 'check', 'x',
];

test('ICONS 包含全部所需图标名', () => {
    REQUIRED.forEach(name => {
        assert.ok(ICONS[name] !== undefined, `missing icon: ${name}`);
    });
});

test('ICONS 每个值都是非空 path 数据', () => {
    Object.keys(ICONS).forEach(name => {
        assert.equal(typeof ICONS[name], 'string', `not a string: ${name}`);
        assert.ok(ICONS[name].length > 0, `empty path data: ${name}`);
        assert.ok(/[/>]/.test(ICONS[name]), `no path markup: ${name}`);
    });
});

test('iconSvg 输出与既有内联 SVG 同格式', () => {
    const svg = iconSvg('zap', 14);
    assert.ok(svg.startsWith('<svg'), 'must start with <svg');
    assert.ok(svg.includes('stroke="currentColor"'), 'must inherit text color');
    assert.ok(svg.includes('width="14"') && svg.includes('height="14"'), 'size applied');
    assert.ok(svg.includes('viewBox="0 0 24 24"'), '24x24 viewBox');
    assert.ok(svg.endsWith('</svg>'), 'closed svg tag');
});

test('iconSvg 默认尺寸 14，未知图标返回空串', () => {
    assert.ok(iconSvg('folder').includes('width="14"'));
    assert.equal(iconSvg('no-such-icon', 14), '');
});
