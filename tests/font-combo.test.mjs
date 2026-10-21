// ZTerm - font combobox commit-rule unit tests (node --test)
// _resolveFontCommit is the DOM-free decision function behind the settings
// font combos (match an enumerated option / create an extra option for free
// text / fall back to the sentinel on empty input). Loaded from the REAL
// settings.js via node:vm, same pattern as settings-appearance.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const settingsSrc = readFileSync(path.join(root, 'src/renderer/settings.js'), 'utf8');
const colorUtilsSrc = readFileSync(path.join(root, 'src/renderer/color-utils.js'), 'utf8');

function loadCtx() {
    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: () => null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {} }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { style: {}, classList: { toggle() {} } },
            documentElement: { style: { setProperty() {} } },
        },
        ipcRenderer: { send() {}, invoke: () => new Promise(() => {}) },
        _settingsConfig: {},
        TabManager: { profiles: [], tabs: [], render() {} },
        Icons: { iconSvg: () => 'svg' },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(colorUtilsSrc, context, { filename: 'color-utils.js' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });
    return context;
}

// deepStrictEqual fails across vm realms (prototype identity differs), so
// compare the result field by field.
function assertCommit(actual, expected) {
    assert.equal(actual.action, expected.action);
    if (expected.index !== undefined) assert.equal(actual.index, expected.index);
    if (expected.value !== undefined) assert.equal(actual.value, expected.value);
    if (expected.label !== undefined) assert.equal(actual.label, expected.label);
}

// Mirror of a populated set-font option list (enumerated fonts + sentinel).
const FONT_OPTS = [
    { value: "'Cascadia Mono',monospace", label: 'Cascadia Mono' },
    { value: "'Consolas',monospace", label: 'Consolas' },
    { value: "'JetBrainsMonoNL NF',monospace", label: 'JetBrainsMonoNL NF' },
    { value: 'monospace', label: 'Monospace' },
];
// set-ui-font list: enumerated + '' sentinel ('系统默认').
const UI_OPTS = [
    { value: "'Segoe UI',sans-serif", label: 'Segoe UI' },
    { value: '', label: '系统默认' },
];

test('exact label match selects that option', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'Consolas', 'set-font'),
        { action: 'select', index: 1 });
});

test('case-insensitive match selects the enumerated option, not an extra', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'consolas', 'set-font'),
        { action: 'select', index: 1 });
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'CASCADIA MONO', 'set-font'),
        { action: 'select', index: 0 });
});

test('surrounding whitespace is trimmed before matching', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, '  Consolas  ', 'set-font'),
        { action: 'select', index: 1 });
});

test('empty input selects the empty-value sentinel (系统默认 / 无)', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(UI_OPTS, '', 'set-ui-font'),
        { action: 'select', index: 1 });
    assertCommit(ctx._resolveFontCommit(UI_OPTS, '   ', 'set-ui-fallback-font'),
        { action: 'select', index: 1 });
});

test('empty input on the terminal font selects the monospace sentinel', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, '', 'set-font'),
        { action: 'select', index: 3 });
});

test('empty input without any sentinel is a no-op', () => {
    const ctx = loadCtx();
    const noSentinel = [{ value: "'A',monospace", label: 'A' }];
    assertCommit(ctx._resolveFontCommit(noSentinel, '', 'set-font'), { action: 'none' });
});

test('free text on set-font creates an extra option with the ,monospace suffix', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'My Custom Font', 'set-font'),
        { action: 'extra', value: "'My Custom Font',monospace", label: 'My Custom Font' });
});

test('free text on set-ui-font creates an extra option with the ,sans-serif suffix', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(UI_OPTS, 'My UI Font', 'set-ui-font'),
        { action: 'extra', value: "'My UI Font',sans-serif", label: 'My UI Font' });
});

test('free text on the fallback selects stays a bare family name', () => {
    const ctx = loadCtx();
    assertCommit(ctx._resolveFontCommit(UI_OPTS, 'Raw Fallback', 'set-fallback-font'),
        { action: 'extra', value: 'Raw Fallback', label: 'Raw Fallback' });
    assertCommit(ctx._resolveFontCommit(UI_OPTS, 'Raw Fallback', 'set-ui-fallback-font'),
        { action: 'extra', value: 'Raw Fallback', label: 'Raw Fallback' });
});

test('the sentinel labels themselves match as ordinary options', () => {
    const ctx = loadCtx();
    // Typing the sentinel text must not create a '系统默认' extra option.
    assertCommit(ctx._resolveFontCommit(UI_OPTS, '系统默认', 'set-ui-font'),
        { action: 'select', index: 1 });
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'Monospace', 'set-font'),
        { action: 'select', index: 3 });
});

test('lowercase sentinel text still hits the sentinel, never an extra', () => {
    const ctx = loadCtx();
    // 'monospace' must resolve to the sentinel option, not a malformed
    // 'monospace',monospace extra entry.
    assertCommit(ctx._resolveFontCommit(FONT_OPTS, 'monospace', 'set-font'),
        { action: 'select', index: 3 });
});
