// ZTerm - settings input validation + dropdown Escape unit tests (node --test)
// Covers two regressions in src/renderer/settings.js:
//   T08: saveAppearance/saveTerminal must reject values xterm.js would throw
//        on at runtime (lineHeight < 1, negative scrollback) instead of
//        persisting them: toast, revert the input to the last valid value,
//        never write the bad value to disk.
//   T11: Escape while a custom dropdown (.cust-dropdown) menu is open must
//        close only that dropdown and consume the key, not let the global
//        overlay-close chain (shortcuts.js) close the whole dialog.
// settings.js is a browser global script (relies on preload-injected globals)
// and cannot be imported in node, so node:vm loads the REAL settings.js (plus
// the real color-utils.js it calls) with a minimal fake DOM; only unrelated
// collaborators are stubbed (same harness shape as settings-appearance.test.mjs).
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

// A fake .cust-dropdown element for the Escape tests: records classList
// removals and reports itself visible (or hidden) via getClientRects.
function mkDropdown({ visible = true } = {}) {
    const removed = [];
    return {
        tagName: 'DIV', className: 'cust-dropdown open',
        removed,
        classList: { remove(c) { removed.push(c); } },
        getClientRects: () => (visible ? [{ top: 0, left: 0 }] : []),
    };
}

function loadSettingsVm({ openDropdowns = [] } = {}) {
    const els = new Map();
    const sends = [];
    const toasts = [];
    const docListeners = []; // { type, fn, capture }
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
    // Terminal-page input saveTerminal validates.
    els.set('set-scrollback', mkInput('10000'));

    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {} }),
            addEventListener(type, fn, opts) { docListeners.push({ type, fn, capture: opts === true || !!(opts && opts.capture) }); },
            removeEventListener() {},
            querySelector: () => null,
            querySelectorAll: (sel) => (sel === '.cust-dropdown.open' ? [...openDropdowns] : []),
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
        context, els, sends, toasts, docListeners,
        run: (code) => vm.runInContext(code, context),
        appearancePayload: () => sends.filter(s => s.cmd === 'save-appearance').pop()?.payload,
        terminalPayload: () => sends.filter(s => s.cmd === 'save-terminal-settings').pop()?.payload,
        escHandler: () => docListeners.find(l => l.type === 'keydown' && l.capture)?.fn,
    };
}

// ── T08: saveAppearance line-height validation ──────────────────────────────

test('saveAppearance：行高 0.9 不落盘，回退上次合法值并提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { lineHeight: 1.2, accentColor: '#61afef' };
    vm1.els.get('set-line-height').value = '0.9';
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    // The invalid value must never reach the persisted payload.
    assert.notEqual(payload.lineHeight, 0.9);
    assert.equal(payload.lineHeight, 1.2);
    // Input reverted to the last valid config value.
    assert.equal(vm1.els.get('set-line-height').value, '1.2');
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true);
});

test('saveAppearance：行高非数值（空输入）回退默认并提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { accentColor: '#61afef' }; // no lineHeight yet
    vm1.els.get('set-line-height').value = '';
    vm1.run('saveAppearance()');
    assert.equal(vm1.appearancePayload().lineHeight, 1.125);
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true);
});

test('saveAppearance：行高边界值 1 照常落盘且无提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { lineHeight: 1.2, accentColor: '#61afef' };
    vm1.els.get('set-line-height').value = '1';
    vm1.run('saveAppearance()');
    assert.equal(vm1.appearancePayload().lineHeight, 1);
    assert.equal(vm1.toasts.length, 0);
});

test('saveAppearance：非法行高连同其余字段照常保存（仅非法值回退）', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { lineHeight: 1.2, accentColor: '#61afef' };
    vm1.els.get('set-line-height').value = '0.5';
    vm1.els.get('set-font-size').value = '18';
    vm1.run('saveAppearance()');
    const payload = vm1.appearancePayload();
    assert.equal(payload.lineHeight, 1.2);
    assert.equal(payload.fontSize, 18); // other fields still persist
});

// ── T08: saveTerminal scrollback validation ─────────────────────────────────

test('saveTerminal：回滚行数 -1 不落盘，回退上次合法值并提示', () => {
    const vm1 = loadSettingsVm();
    vm1.context._settingsConfig = { scrollback: 5000 };
    vm1.els.get('set-scrollback').value = '-1';
    vm1.run('saveTerminal()');
    const payload = vm1.terminalPayload();
    assert.notEqual(payload.scrollback, -1);
    assert.equal(payload.scrollback, 5000);
    assert.equal(vm1.els.get('set-scrollback').value, '5000');
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true);
});

test('saveTerminal：回滚行数非数值（空输入）回退默认并提示', () => {
    const vm1 = loadSettingsVm();
    vm1.els.get('set-scrollback').value = 'abc';
    vm1.run('saveTerminal()');
    assert.equal(vm1.terminalPayload().scrollback, 10000);
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true);
});

test('saveTerminal：回滚行数 0 与正常值照常落盘且无提示', () => {
    const vm1 = loadSettingsVm();
    vm1.els.get('set-scrollback').value = '0';
    vm1.run('saveTerminal()');
    assert.equal(vm1.terminalPayload().scrollback, 0);
    vm1.els.get('set-scrollback').value = '2000';
    vm1.run('saveTerminal()');
    assert.equal(vm1.terminalPayload().scrollback, 2000);
    assert.equal(vm1.toasts.length, 0);
});

// ── T11: Escape closes only an open custom dropdown ─────────────────────────

test('Esc 处理器在捕获阶段注册（先于 shortcuts.js 全局链）', () => {
    const vm1 = loadSettingsVm();
    const esc = vm1.escHandler();
    assert.ok(typeof esc === 'function', 'settings.js must register a capture-phase keydown listener');
});

test('Esc：cust-dropdown 打开时只关下拉并终止事件', () => {
    const dd = mkDropdown({ visible: true });
    const vm1 = loadSettingsVm({ openDropdowns: [dd] });
    let prevented = false, immediateStopped = false;
    vm1.escHandler()({
        key: 'Escape',
        preventDefault() { prevented = true; },
        stopImmediatePropagation() { immediateStopped = true; },
    });
    assert.deepEqual(dd.removed, ['open']);
    assert.equal(prevented, true);
    assert.equal(immediateStopped, true);
});

test('Esc：无打开下拉时不消费事件（维持现有关闭链）', () => {
    const vm1 = loadSettingsVm({ openDropdowns: [] });
    let prevented = false, immediateStopped = false;
    vm1.escHandler()({
        key: 'Escape',
        preventDefault() { prevented = true; },
        stopImmediatePropagation() { immediateStopped = true; },
    });
    assert.equal(prevented, false);
    assert.equal(immediateStopped, false);
});

test('Esc：隐藏 overlay 内残留 open 的下拉不拦截 Esc（不吞终端 Esc）', () => {
    // A dropdown left 'open' inside an already closed overlay (display:none)
    // has no client rects and must not consume Escape.
    const dd = mkDropdown({ visible: false });
    const vm1 = loadSettingsVm({ openDropdowns: [dd] });
    let prevented = false;
    vm1.escHandler()({
        key: 'Escape',
        preventDefault() { prevented = true; },
        stopImmediatePropagation() {},
    });
    assert.deepEqual(dd.removed, []);
    assert.equal(prevented, false);
});

test('非 Esc 按键不触发下拉关闭', () => {
    const dd = mkDropdown({ visible: true });
    const vm1 = loadSettingsVm({ openDropdowns: [dd] });
    let prevented = false;
    vm1.escHandler()({
        key: 'Enter',
        preventDefault() { prevented = true; },
        stopImmediatePropagation() {},
    });
    assert.deepEqual(dd.removed, []);
    assert.equal(prevented, false);
});
