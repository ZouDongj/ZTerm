// ZTerm - customizable double-click word separators unit tests (node --test)
// Covers the terminal.wordSeparators wiring (issue #8):
//   - _normalizeWordSeparators (utils.js): '' means "vendored default"; the
//     configured string is kept verbatim (spaces/quotes are literal chars).
//   - _buildTerminalOptions (terminal.js): the xterm wordSeparator option is
//     passed ONLY when the user configured a non-empty string, so an unset
//     config keeps following the vendored default (no hardcoded copy).
//   - saveTerminal (settings.js): persists the raw input string and
//     live-applies it to every open terminal (tab + split panes); assigning ''
//     resets to the vendored default (xterm's option sanitizer substitutes its
//     own default for falsy values -- verified in src/vendor/xterm.js).
// The renderer sources are browser global scripts (preload-injected globals)
// and cannot be imported in node, so node:vm loads the REAL sources with a
// minimal fake DOM; only unrelated collaborators are stubbed (same harness
// shape as settings-input-validation.test.mjs / save-config-payload.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const utilsSrc = read('src/renderer/utils.js');
const terminalSrc = read('src/renderer/terminal.js');
const colorUtilsSrc = read('src/renderer/color-utils.js');
const settingsSrc = read('src/renderer/settings.js');

const helperSrc = utilsSrc.match(/function _normalizeWordSeparators\(value\) \{[\s\S]*?\n\}/);
assert.ok(helperSrc, '_normalizeWordSeparators source found in utils.js');
const buildOptionsSrc = terminalSrc.match(/function _buildTerminalOptions\(\) \{[\s\S]*?\n\}/);
assert.ok(buildOptionsSrc, '_buildTerminalOptions source found in terminal.js');

// A sample non-empty separator set; tests must not depend on the vendored
// default's exact value (it may change in future vendor updates).
const ANY_NON_EMPTY = ' /:';

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

// Runs the REAL _normalizeWordSeparators + _buildTerminalOptions against a
// given settings config; unrelated collaborators (fonts, theme) are stubbed.
function buildOptions(config) {
    const context = {
        _settingsConfig: config,
        _normalizeFontFamily: (family) => family || '',
        _clampFontWeight: (v, dflt) => parseInt(v, 10) || parseInt(dflt, 10),
        _getAccentColor: () => '#61afef',
        getTerminalTheme: () => ({}),
        // Font governance (font-governance.js) is out of scope here: the
        // chain passes through ungoverned and no enumeration is kicked.
        _governTerminalFontChain: (family) => family,
        _ensureFontGovernanceKick() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(helperSrc[0], context, { filename: 'utils.js#_normalizeWordSeparators' });
    vm.runInContext(buildOptionsSrc[0], context, { filename: 'terminal.js#_buildTerminalOptions' });
    return vm.runInContext('_buildTerminalOptions()', context);
}

// Loads the REAL settings.js (plus the real color-utils.js and the real
// _normalizeWordSeparators helper it calls) with a minimal fake DOM. `tabs`
// carry fake xterm terminals whose options object records live assignments.
function loadSettingsVm({ tabs = [], panesByTab = new Map() } = {}) {
    const els = new Map();
    const sends = [];
    const toasts = [];
    // Appearance-page inputs saveAppearance reads (not under test, but
    // loadSettingsIntoForm/saveTerminal walk them on every call).
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
    // Terminal-page inputs saveTerminal reads.
    els.set('set-scrollback', mkInput('10000'));
    els.set('set-word-separators', mkInput(''));

    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {} }),
            addEventListener() {},
            removeEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { style: {}, classList: { toggle() {} } },
            documentElement: { style: { setProperty() {} } },
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            invoke: (cmd, payload) => {
                if (cmd.startsWith('save-')) { sends.push({ cmd, payload }); return Promise.resolve(); }
                return new Promise(() => {});
            },
        },
        _settingsConfig: {},
        TabManager: { tabs, render() {} },
        getAllPanes: (t) => panesByTab.get(t) || [],
        getToggle: () => true,
        setToggle() {},
        updateAccentDot() {},
        applyTerminalScheme() {},
        populateTerminalSchemeSelect() {},
        _normalizeFontFamily: (family) => family || '',
        _clampFontWeight: (v, dflt) => parseInt(v, 10) || parseInt(dflt, 10),
        _firstFontName: (family) => family || '',
        getDefaultLocalProfile: () => null,
        showToast: (msg, isError) => toasts.push({ msg, isError }),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(colorUtilsSrc, context, { filename: 'color-utils.js' });
    vm.runInContext(helperSrc[0], context, { filename: 'utils.js#_normalizeWordSeparators' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });
    return {
        context, els, sends, toasts,
        run: (code) => vm.runInContext(code, context),
        terminalPayload: () => sends.filter(s => s.cmd === 'save-terminal-settings').pop()?.payload,
    };
}

// A fake xterm terminal: plain options object, so live assignments are
// recorded verbatim (including the '' reset value).
function mkTerm() {
    return { options: {} };
}

// -- _normalizeWordSeparators ----------------------------------------------

test('_normalizeWordSeparators：未设置、空串或非字符串返回空串（表示跟随内置默认）', () => {
    const ctx = vm.createContext({});
    vm.runInContext(helperSrc[0], ctx);
    for (const v of [undefined, null, '', 42, {}, true]) {
        const arg = v === undefined ? 'undefined' : JSON.stringify(v);
        assert.equal(vm.runInContext(`_normalizeWordSeparators(${arg})`, ctx), '', `value ${JSON.stringify(v)}`);
    }
});

test('_normalizeWordSeparators：非空字符串按原样返回（含空格、引号、反引号）', () => {
    const ctx = vm.createContext({});
    vm.runInContext(helperSrc[0], ctx);
    for (const v of ['/', ' /:', ' ()[]{}\',"`', '  ', '\t']) {
        assert.equal(vm.runInContext(`_normalizeWordSeparators(${JSON.stringify(v)})`, ctx), v, `value ${JSON.stringify(v)} must survive verbatim`);
    }
});

// -- _buildTerminalOptions passes wordSeparator only when configured ------

test('_buildTerminalOptions：未配置时不包含 wordSeparator 键（跟随内置默认）', () => {
    for (const config of [{}, { wordSeparators: '' }, { wordSeparators: undefined }, { wordSeparators: null }, { wordSeparators: 42 }]) {
        const options = buildOptions(config);
        assert.equal('wordSeparator' in options, false, `config ${JSON.stringify(config)} must not pin a separator copy`);
    }
});

test('_buildTerminalOptions：配置非空字符串时按原样传递 wordSeparator', () => {
    assert.equal(buildOptions({ wordSeparators: '/' }).wordSeparator, '/');
    assert.equal(buildOptions({ wordSeparators: ANY_NON_EMPTY }).wordSeparator, ANY_NON_EMPTY);
});

// -- saveTerminal persists and live-applies to open terminals -------------

test('saveTerminal：输入分隔符落盘并热应用到标签页与分栏终端', async () => {
    const tabTerm = mkTerm(), paneTerm = mkTerm();
    const tab = { term: tabTerm, splitRoot: null };
    const splitTab = { term: null, splitRoot: {} };
    const vm1 = loadSettingsVm({ tabs: [tab, splitTab], panesByTab: new Map([[splitTab, [{ term: paneTerm }]]]) });
    vm1.els.get('set-word-separators').value = ' /:';
    await vm1.run('saveTerminal()');
    // Persisted payload carries the raw string.
    assert.equal(vm1.terminalPayload().wordSeparators, ' /:');
    assert.equal(vm1.context._settingsConfig.wordSeparators, ' /:');
    // Live terminals received the option (effective on the next double-click:
    // the vendored selection model reads rawOptions.wordSeparator at click time).
    assert.equal(tabTerm.options.wordSeparator, ' /:');
    assert.equal(paneTerm.options.wordSeparator, ' /:');
});

test('saveTerminal：清空输入落盘空串并向终端赋空串（由 xterm 清洗回内置默认）', async () => {
    const tabTerm = mkTerm();
    const vm1 = loadSettingsVm({ tabs: [{ term: tabTerm, splitRoot: null }] });
    vm1.context._settingsConfig = { wordSeparators: ' /:' };
    vm1.els.get('set-word-separators').value = '';
    await vm1.run('saveTerminal()');
    assert.equal(vm1.terminalPayload().wordSeparators, '');
    // The reset relies on the vendored option sanitizer: a falsy
    // wordSeparator is replaced by xterm's own DEFAULT_OPTIONS value, so the
    // app never hardcodes a copy of the default.
    assert.equal(tabTerm.options.wordSeparator, '');
});

test('saveTerminal：设置页输入缺失时不报错（与其他文本输入一致回退空串）', async () => {
    // saveTerminal only runs from the settings page, where the input exists;
    // this guards the defensive ?. path. Like set-startup-dir and friends,
    // a missing element falls back to '' rather than throwing.
    const vm1 = loadSettingsVm({ tabs: [] });
    vm1.els.delete('set-word-separators');
    await vm1.run('saveTerminal()');
    assert.equal(vm1.terminalPayload().wordSeparators, '');
    assert.equal(vm1.toasts.length, 0);
});

test('persistSettings：已配置的分隔符键随 save-terminal-settings 载荷下发', async () => {
    const vm1 = loadSettingsVm({ tabs: [] });
    vm1.context._settingsConfig = { wordSeparators: '/' };
    await vm1.run('persistSettings()');
    assert.equal(vm1.terminalPayload().wordSeparators, '/');
});

// -- loadSettingsIntoForm reflects the config into the input --------------

test('loadSettingsIntoForm：已配置分隔符回显到输入框', () => {
    const vm1 = loadSettingsVm({ tabs: [] });
    vm1.context._settingsConfig = { wordSeparators: ' /:' };
    vm1.run('loadSettingsIntoForm()');
    assert.equal(vm1.els.get('set-word-separators').value, ' /:');
});

test('loadSettingsIntoForm：未配置或空串回显为空（表示使用默认）', () => {
    const vm1 = loadSettingsVm({ tabs: [] });
    vm1.context._settingsConfig = {};
    vm1.run('loadSettingsIntoForm()');
    assert.equal(vm1.els.get('set-word-separators').value, '');
    vm1.context._settingsConfig = { wordSeparators: '' };
    vm1.run('loadSettingsIntoForm()');
    assert.equal(vm1.els.get('set-word-separators').value, '');
});
