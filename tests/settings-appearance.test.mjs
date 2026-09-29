// ZTerm - appearance settings persistence unit tests (node --test)
// settings.js is a browser global script (relies on preload-injected globals)
// and cannot be imported in node, so node:vm loads the REAL settings.js (plus
// the real color-utils.js it calls) with a minimal fake DOM; only unrelated
// collaborators (TabManager, toggles, accent dot) are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const colorUtilsSrc = read('src/renderer/color-utils.js');
const settingsSrc = read('src/renderer/settings.js');

// ── Fake DOM elements ───────────────────────────────────────────────────────
// The font <select> mocks model two real-DOM behaviors the product code
// relies on: innerHTML='' drops all options, and a select with options but no
// explicit selection auto-selects the first option (selectedIndex = 0).
function mkInput(value = '') {
    return { tagName: 'INPUT', value, style: {} };
}

function mkSelect() {
    const el = {
        tagName: 'SELECT', options: [], style: {},
        _innerHTML: '', _value: '', _valueTouched: false,
        appendChild(c) {
            this.options.push(c);
            if (this.options.length === 1 && !this._valueTouched) this._value = c.value;
            return c;
        },
    };
    Object.defineProperty(el, 'value', {
        get() { return this._value; },
        set(v) { this._value = v; this._valueTouched = true; },
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return this._innerHTML; },
        set(v) {
            this._innerHTML = v;
            if (v === '') { this.options.length = 0; this._value = ''; this._valueTouched = false; }
        },
    });
    return el;
}

function loadSettingsVm() {
    const els = new Map();
    const sends = [];
    const toasts = [];
    // Appearance-page inputs saveAppearance reads.
    els.set('set-font', mkSelect());
    els.set('set-ui-font', mkSelect());
    els.set('set-ui-fallback-font', mkSelect());
    els.set('set-fallback-font', mkSelect());
    els.set('set-font-size', mkInput('16'));
    els.set('set-line-height', mkInput('1.125'));
    els.set('set-font-weight', mkInput('400'));
    els.set('set-font-weight-bold', mkInput('600'));
    els.set('set-accent', mkInput('#61afef'));
    els.set('set-terminal-scheme', mkInput('onedark'));
    els.set('set-contrast', mkInput('4'));
    // Color-picker overlay elements openColorPicker/updateColorPickerUI touch.
    const mkBox = () => ({
        tagName: 'DIV', value: '', style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    });
    els.set('cp-r', mkInput('0'));
    els.set('cp-g', mkInput('0'));
    els.set('cp-b', mkInput('0'));
    els.set('cp-hex', mkInput('#000000'));
    els.set('cp-canvas', mkBox());
    els.set('cp-canvas-dot', mkBox());
    els.set('cp-hue', mkBox());
    els.set('cp-hue-dot', mkBox());
    els.set('color-picker-overlay', mkBox());

    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {} }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { style: {}, classList: { toggle() {} } },
            documentElement: { style: { setProperty() {} } },
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            invoke: () => new Promise(() => {}),
        },
        _settingsConfig: {},
        TabManager: { tabs: [], render() {} },
        getToggle: () => true,
        updateAccentDot() {},
        applyTerminalScheme() {},
        getAllPanes: () => [],
        _normalizeFontFamily: (family) => family || '',
        _clampFontWeight: (v, dflt) => parseInt(v, 10) || parseInt(dflt, 10),
        showToast: (msg, isError) => toasts.push({ msg, isError }),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(colorUtilsSrc, context, { filename: 'color-utils.js' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });
    return {
        context, els, sends, toasts,
        run: (code) => vm.runInContext(code, context),
        appearancePayload: () => sends.filter(s => s.cmd === 'save-appearance').pop()?.payload,
    };
}

// ── 字体枚举竞态（首次打开设置，select 尚无 option）──

test('saveAppearance：字体 select 未填充时保留已配置的终端字体与备选字体', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = {
        fontFamily: "'Cascadia Mono',monospace",
        fallbackFont: 'Microsoft YaHei UI',
        accentColor: '#61afef',
    };
    // First settings visit: enumeration is still in flight, selects have no options.
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    assert.equal(payload.fontFamily, "'Cascadia Mono',monospace");
    assert.equal(payload.fallbackFont, 'Microsoft YaHei UI');
});

test('saveAppearance：select 已填充后采用 select 当前值（含显式选择的空值）', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = {
        fontFamily: "'Cascadia Mono',monospace",
        fallbackFont: 'Microsoft YaHei UI',
        accentColor: '#61afef',
    };
    const fontEl = vm1.els.get('set-font');
    fontEl.appendChild({ value: "'FontA',monospace", textContent: 'FontA' });
    fontEl.value = "'FontA',monospace";
    const fbEl = vm1.els.get('set-fallback-font');
    fbEl.appendChild({ value: 'FbA', textContent: 'FbA' });
    fbEl.appendChild({ value: '', textContent: '无' });
    fbEl.value = 'FbA';
    vm1.run('saveAppearance()');
    let payload = vm1.appearancePayload();
    assert.equal(payload.fontFamily, "'FontA',monospace");
    assert.equal(payload.fallbackFont, 'FbA');
    // An explicit '无' choice ('') must survive once options exist.
    fbEl.value = '';
    vm1.run('saveAppearance()');
    payload = vm1.appearancePayload();
    assert.equal(payload.fallbackFont, '');
});

// ── 界面字体空值选择（'系统默认' / '无'，option value=''）──

test('saveAppearance：显式选择"系统默认"/"无"（空值）必须落盘为空而非旧配置', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = {
        uiFont: "'FontA',sans-serif",
        uiFallbackFont: 'FbA',
        accentColor: '#61afef',
    };
    const uiFontEl = vm1.els.get('set-ui-font');
    uiFontEl.appendChild({ value: "'FontA',sans-serif", textContent: 'FontA' });
    uiFontEl.appendChild({ value: '', textContent: '系统默认' });
    uiFontEl.value = ''; // user picked '系统默认'
    const uiFbEl = vm1.els.get('set-ui-fallback-font');
    uiFbEl.appendChild({ value: 'FbA', textContent: 'FbA' });
    uiFbEl.appendChild({ value: '', textContent: '无' });
    uiFbEl.value = ''; // user picked '无'
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    assert.equal(payload.uiFont, '');
    assert.equal(payload.uiFallbackFont, '');
});

test('saveAppearance：界面字体 select 未填充时仍回退已配置值（竞态兜底不被误伤）', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = {
        uiFont: "'FontA',sans-serif",
        uiFallbackFont: 'FbA',
        accentColor: '#61afef',
    };
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    assert.equal(payload.uiFont, "'FontA',sans-serif");
    assert.equal(payload.uiFallbackFont, 'FbA');
});

test('_buildFontSelects：已保存"系统默认"（uiFont 为空）重建后正确回显而非首字体', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { uiFont: '', uiFallbackFont: '' };
    vm1.run("_buildFontSelects(['FontA','FontB'])");
    // '系统默认' is the trailing value='' option; the rebuilt select must
    // select it, not leave the alphabetically first font auto-selected.
    assert.equal(vm1.els.get('set-ui-font').value, '');
    assert.equal(vm1.els.get('set-ui-fallback-font').value, '');
});

// ── 强调色 hex 校验 ──

test('颜色选择器：RGB 输入超范围被钳制到 0-255', () => {
    const vm1 = loadSettingsVm();
    vm1.run("openColorPicker('#61afef')");
    vm1.els.get('cp-r').value = '999';
    vm1.els.get('cp-g').value = '254';
    vm1.els.get('cp-b').value = '254';
    vm1.run('document.getElementById("cp-r").onchange()');
    const cpVal = vm1.run('_cpVal');
    assert.ok(cpVal <= 1, `_cpVal ${cpVal} must stay within HSV bounds`);
    assert.match(vm1.els.get('cp-hex').value, /^#[0-9a-f]{6}$/i);
});

test('saveAppearance：非法强调色不落盘，回退上次合法值并提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { accentColor: '#9CA3FF' };
    vm1.els.get('set-accent').value = '#fff'; // valid CSS but not 6-digit hex
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    assert.equal(payload.accentColor, '#9CA3FF');
    assert.equal(vm1.els.get('set-accent').value, '#9CA3FF'); // input reverted
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true);
});

test('saveAppearance：输入与旧配置均非法时回退默认强调色', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { accentColor: 'garbage' };
    vm1.els.get('set-accent').value = '#3e7fefe';
    vm1.run('saveAppearance()');
    assert.equal(vm1.appearancePayload().accentColor, '#61afef');
});

test('saveAppearance：合法强调色（含无 # 前缀）照常落盘且无提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { accentColor: '#61afef' };
    vm1.els.get('set-accent').value = '#9CA3FF';
    vm1.run('saveAppearance()');
    assert.equal(vm1.appearancePayload().accentColor, '#9CA3FF');
    vm1.els.get('set-accent').value = '8bc4ff'; // applyAccentColor accepts missing '#'
    vm1.run('saveAppearance()');
    assert.equal(vm1.appearancePayload().accentColor, '8bc4ff');
    assert.equal(vm1.toasts.length, 0);
});

test('颜色选择器：RGB 超范围输入最终确认的强调色仍是合法 hex', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { accentColor: '#61afef' };
    vm1.run("openColorPicker('#61afef')");
    vm1.els.get('cp-r').value = '999';
    vm1.run('document.getElementById("cp-r").onchange()');
    vm1.run('confirmColorPicker()');
    assert.match(vm1.appearancePayload().accentColor, /^#[0-9a-f]{6}$/i);
    assert.equal(vm1.toasts.length, 0);
});
