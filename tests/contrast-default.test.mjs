// ZTerm - minimumContrastRatio default (N1 Phase 1) unit tests (node --test)
// The default aligns with upstream xterm/Tabby: 1 (off). A stored user value —
// including an explicit 4 — must keep working; only the unset-config fallback
// moves 4 → 1. Pins the create path (REAL terminal.js _buildTerminalOptions
// via the shared renderer VM), the save-parse path (REAL settings.js
// saveAppearance in a minimal VM) and the settings HTML's shipped default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { loadVm } from './helpers/renderer-vm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

// ── Create path: _buildTerminalOptions ──

test('an unset config yields minimumContrastRatio 1 for new terminals', () => {
    const ctx = loadVm();
    ctx._settingsConfig = {};
    assert.equal(ctx._buildTerminalOptions().minimumContrastRatio, 1);
});

test('a stored explicit 4 survives into new terminals', () => {
    const ctx = loadVm();
    ctx._settingsConfig = { minimumContrastRatio: 4 };
    assert.equal(ctx._buildTerminalOptions().minimumContrastRatio, 4);
});

// ── Save path: saveAppearance parse ──

function mkInput(value = '') {
    return { tagName: 'INPUT', value, style: {} };
}

function mkSelect() {
    return {
        tagName: 'SELECT', options: [], value: '', style: {},
        set innerHTML(v) { if (v === '') this.options.length = 0; },
        get innerHTML() { return ''; },
        appendChild(c) { this.options.push(c); return c; },
    };
}

function loadSettingsVm(contrastValue) {
    const els = new Map();
    for (const id of ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font']) els.set(id, mkSelect());
    els.set('set-font-size', mkInput('16'));
    els.set('set-line-height', mkInput('1.125'));
    els.set('set-font-weight', mkInput('400'));
    els.set('set-font-weight-bold', mkInput('600'));
    els.set('set-accent', mkInput('#61afef'));
    els.set('set-terminal-scheme', mkInput('onedark'));
    els.set('set-contrast', mkInput(contrastValue));
    const sends = [];
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
        TabManager: { profiles: [], tabs: [], render() {} },
        Icons: { iconSvg: () => 'svg' },
        getToggle: () => true,
        updateAccentDot() {},
        applyTerminalScheme() {},
        getAllPanes: () => [],
        _normalizeFontFamily: (family) => family || '',
        _clampFontWeight: (v, dflt) => parseInt(v, 10) || parseInt(dflt, 10),
        showToast() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/color-utils.js'), context, { filename: 'color-utils.js' });
    vm.runInContext(read('src/renderer/settings.js'), context, { filename: 'settings.js' });
    return {
        context,
        contrast: () => sends.filter(s => s.cmd === 'save-appearance').pop()?.payload?.minimumContrastRatio,
    };
}

test('saveAppearance persists an explicit 4 from the input unchanged', () => {
    const s = loadSettingsVm('4');
    s.context.saveAppearance();
    assert.equal(s.contrast(), 4);
});

test('saveAppearance persists the new default 1 shown on a fresh install', () => {
    const s = loadSettingsVm('1');
    s.context.saveAppearance();
    assert.equal(s.contrast(), 1);
});

test('saveAppearance falls back to 1 (not 4) when the input is empty/unparseable', () => {
    const s = loadSettingsVm('');
    s.context.saveAppearance();
    assert.equal(s.contrast(), 1);
});

// ── Shipped markup: the settings input's unset-display value ──

test('the settings HTML contrast input ships value="1" as its unset display', () => {
    assert.match(read('src/renderer.html'), /<input type="number" id="set-contrast" value="1"/);
});
