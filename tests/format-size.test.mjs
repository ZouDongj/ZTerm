// ZTerm - formatSize unit tests (node --test)
// utils.js is a browser global script (requires electron/xterm at top level),
// so node:vm loads the real source with the require/window surface stubbed;
// formatSize itself is a pure function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsSrc = readFileSync(path.resolve(__dirname, '../src/renderer/utils.js'), 'utf8');

function loadFormatSize() {
    const context = {
        console,
        window: { addEventListener() {} },
        require: () => ({}),
    };
    vm.createContext(context);
    vm.runInContext(utilsSrc, context, { filename: 'utils.js' });
    return vm.runInContext('formatSize', context);
}

const formatSize = loadFormatSize();

test('formatSize 既有单位区间不回归', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(2048), '2 KB');
    assert.equal(formatSize(3 * 1024 * 1024), '3 MB');
    assert.equal(formatSize(5 * 1024 ** 3), '5 GB');
    assert.equal(formatSize(1.5 * 1024 ** 3), '1.5 GB');
});

test('formatSize TB/PB 区间不再显示 undefined', () => {
    assert.equal(formatSize(1024 ** 4), '1 TB');
    assert.equal(formatSize(2 * 1024 ** 4), '2 TB');
    assert.equal(formatSize(3 * 1024 ** 5), '3 PB');
});

test('formatSize 超出 PB 钳制在最大单位', () => {
    assert.equal(formatSize(1024 ** 6), '1024 PB');
    assert.equal(formatSize(5 * 1024 ** 6), '5120 PB');
});
