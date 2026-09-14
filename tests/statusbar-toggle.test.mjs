// ZTerm - 状态栏显示/隐藏切换（toggle-statusbar）单测（node --test）
// shortcuts.js / settings.js 是浏览器全局脚本（依赖 preload 注入的 ipcRenderer 等），
// 无法在 node 里 import，按契约用源码正则校验接线；state.js 顶层只依赖
// path + process，用 node:vm 加载真实源码做行为级测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const shortcutsSrc = read('src/renderer/shortcuts.js');
const stateSrc = read('src/renderer/state.js');
const settingsSrc = read('src/renderer/settings.js');

// 解析 DEFAULT_SHORTCUTS 表为 { id: combo }（含带引号的 key）
function parseDefaultShortcuts(src) {
    const block = src.match(/const DEFAULT_SHORTCUTS = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'DEFAULT_SHORTCUTS table not found');
    const out = {};
    for (const line of block[1].split('\n')) {
        const m = line.match(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']+)'/);
        if (m) out[m[1] || m[2]] = m[3];
    }
    assert.ok(Object.keys(out).length >= 15, `parsed too few DEFAULT_SHORTCUTS entries: ${Object.keys(out).length}`);
    return out;
}

// ── 快捷键注册与冲突 ──

test('DEFAULT_SHORTCUTS 含 toggle-statusbar 且组合键在候选集内', () => {
    const defaults = parseDefaultShortcuts(shortcutsSrc);
    assert.ok('toggle-statusbar' in defaults, 'toggle-statusbar entry missing');
    // 候选链：Ctrl+Shift+S（被 sshPanel 占用则顺延）→ Ctrl+Shift+B → Ctrl+Alt+B
    assert.match(defaults['toggle-statusbar'], /^Ctrl\+(?:Shift\+B|Alt\+B|Shift\+S)$/);
});

test('toggle-statusbar 组合键与其它默认快捷键无冲突', () => {
    const defaults = parseDefaultShortcuts(shortcutsSrc);
    const combos = Object.values(defaults);
    assert.equal(new Set(combos).size, combos.length, 'duplicate combo in DEFAULT_SHORTCUTS');
    // Ctrl+Shift+S 已被 SSH 面板占用：新条目不得使用它
    if (defaults['toggle-statusbar'] === 'Ctrl+Shift+S') {
        assert.notEqual(defaults.sshPanel, 'Ctrl+Shift+S');
    }
});

test('toggle-statusbar 组合键未被 renderer.html 硬编码占用', () => {
    const html = read('src/renderer.html');
    const defaults = parseDefaultShortcuts(shortcutsSrc);
    assert.ok(!html.includes(`'${defaults['toggle-statusbar']}'`), 'renderer.html hardcodes the same combo');
});

test('SHORTCUT_ACTIONS 提供 toggle-statusbar 处理器（翻转 + toast）', () => {
    const m = shortcutsSrc.match(/'toggle-statusbar'\s*:\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \},/);
    assert.ok(m, 'toggle-statusbar action handler not found');
    assert.match(m[1], /toggleStatusbar\(\)/, 'handler must call toggleStatusbar()');
    assert.match(m[1], /showToast\(/, 'handler must show feedback toast');
});

test('SHORTCUT_LABELS 含 toggle-statusbar（设置页快捷键表格可自定义）', () => {
    const block = shortcutsSrc.match(/const SHORTCUT_LABELS = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'SHORTCUT_LABELS table not found');
    assert.match(block[1], /'toggle-statusbar'\s*:\s*'[^']+'/);
});

// ── state.js 行为（vm 加载真实源码）──

// 加载 state.js 到 vm：document 用极简 stub（只实现 body.classList.toggle），
// persistSettings（真实定义在 settings.js）用计数 stub 注入
function loadStateModule() {
    const classes = new Set();
    let persistCalls = 0;
    const context = {
        path,
        process,
        console,
        document: {
            body: {
                classList: {
                    toggle(cls, force) {
                        const next = force === undefined ? !classes.has(cls) : !!force;
                        if (next) classes.add(cls); else classes.delete(cls);
                    },
                    contains: (cls) => classes.has(cls),
                },
            },
            documentElement: { style: { setProperty() {} } },
            querySelectorAll: () => [],
            getElementById: () => null,
        },
        persistSettings: () => { persistCalls++; },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(stateSrc, context, { filename: 'state.js' });
    return { context, classes, getPersistCalls: () => persistCalls };
}

test('applyStatusbarVisibility：字段缺失（旧配置）默认显示', () => {
    const mod = loadStateModule();
    vm.runInContext('applyStatusbarVisibility()', mod.context);
    assert.equal(mod.classes.has('hide-statusbar'), false);
});

test('applyStatusbarVisibility：显式 false 才隐藏，true 显示', () => {
    const mod = loadStateModule();
    vm.runInContext('_settingsConfig.showStatusbar = false; applyStatusbarVisibility()', mod.context);
    assert.equal(mod.classes.has('hide-statusbar'), true);
    vm.runInContext('_settingsConfig.showStatusbar = true; applyStatusbarVisibility()', mod.context);
    assert.equal(mod.classes.has('hide-statusbar'), false);
});

test('toggleStatusbar：翻转可见性、写回配置并持久化', () => {
    const mod = loadStateModule();
    // 第一次：默认显示 → 隐藏，返回 false
    const r1 = vm.runInContext('toggleStatusbar()', mod.context);
    assert.equal(r1, false);
    assert.equal(mod.classes.has('hide-statusbar'), true);
    assert.equal(vm.runInContext('_settingsConfig.showStatusbar', mod.context), false);
    assert.equal(mod.getPersistCalls(), 1);
    // 第二次：隐藏 → 显示，返回 true
    const r2 = vm.runInContext('toggleStatusbar()', mod.context);
    assert.equal(r2, true);
    assert.equal(mod.classes.has('hide-statusbar'), false);
    assert.equal(vm.runInContext('_settingsConfig.showStatusbar', mod.context), true);
    assert.equal(mod.getPersistCalls(), 2);
});

// ── settings.js 持久化接线 ──

test('persistSettings 的 save-appearance 载荷包含 showStatusbar', () => {
    const fn = settingsSrc.match(/function persistSettings\(\) \{([\s\S]*?)\n\}/);
    assert.ok(fn, 'persistSettings not found');
    const payload = fn[1].match(/ipcRenderer\.send\('save-appearance', \{([\s\S]*?)\n    \}\);/);
    assert.ok(payload, 'save-appearance send not found');
    assert.match(payload[1], /showStatusbar:\s*config\.showStatusbar/, 'showStatusbar must round-trip via save-appearance');
});

test('loadSettings 启动时调用 applyStatusbarVisibility（成功与回退两条路径）', () => {
    const fn = settingsSrc.match(/async function loadSettings\(\) \{([\s\S]*?)\n\}/);
    assert.ok(fn, 'loadSettings not found');
    const calls = fn[1].match(/applyStatusbarVisibility\(\)/g) || [];
    assert.equal(calls.length, 2, 'expected applyStatusbarVisibility() on both load paths');
});
