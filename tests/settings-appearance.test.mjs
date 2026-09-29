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
