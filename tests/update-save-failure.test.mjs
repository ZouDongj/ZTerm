import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');
const shortcuts = fs.readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../src/renderer/settings.js', import.meta.url), 'utf8');
const save = main.match(/function saveConfig\(\) \{[\s\S]*?\n\}/)?.[0];
const apply = shortcuts.match(/async function _doApplyUpdate\(\) \{[\s\S]*?\n\}/)?.[0];
const persist = settings.match(/function persistSettings\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(save && apply, 'exercise the production save and update functions');

function fixture(invoke) {
    const calls = [];
    const errors = [];
    const descriptions = [];
    const toasts = [];
    const button = { disabled: false, textContent: '重启并安装' };
    const context = vm.createContext({
        console: { error: (...args) => errors.push(args) },
        TabManager: { _restored: true, tabs: [{ id: 'local-1', type: 'local', name: 'Session' }] },
        _settingsConfig: {},
        serializeSplitNode: () => { throw new Error('unexpected split fixture'); },
        document: { getElementById: id => id === 'btn-update-apply' ? button : null },
        ipcRenderer: { invoke: (command, payload) => {
            calls.push(command);
            return invoke(command, payload);
        } },
        _setUpdateDesc: (text, color) => descriptions.push({ text, color }),
        showToast: (...args) => toasts.push(args),
    });
    vm.runInContext(`${save}\n${apply}`, context);
    return { context, calls, errors, descriptions, toasts, button };
}

test('saveConfig rejects to a waiting caller and logs the actual failure', async () => {
    const error = new Error('synthetic storage failure');
    const f = fixture(() => Promise.reject(error));
    await assert.rejects(f.context.saveConfig(), value => value === error);
    assert.equal(f.errors.length, 1);
});

test('failed final save stops installation and restores update controls', async () => {
    const f = fixture(command => command === 'save-last-tabs'
        ? Promise.reject(new Error('synthetic disk full')) : Promise.resolve());
    await f.context._doApplyUpdate();
    assert.deepEqual(f.calls, ['save-last-tabs']);
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.textContent, '重启并安装');
    assert.match(f.descriptions.at(-1).text, /保存/);
    assert.match(f.descriptions.at(-1).text, /synthetic disk full/);
    assert.ok(!f.toasts.some(([text]) => text.includes('正在退出并启动安装')));
});

test('installation waits for the final save and still starts after success', async () => {
    let release;
    const pendingSave = new Promise(resolve => { release = resolve; });
    const f = fixture(command => command === 'save-last-tabs' ? pendingSave : Promise.resolve());
    const updating = f.context._doApplyUpdate();
    assert.deepEqual(f.calls, ['save-last-tabs']);
    assert.equal(f.button.disabled, true);
    assert.ok(!f.toasts.some(([text]) => text.includes('正在退出并启动安装')));
    release();
    await updating;
    assert.deepEqual(f.calls, ['save-last-tabs', 'apply-update']);
    assert.equal(f.button.disabled, true, 'successful install owns process exit');
});

test('retry after save failure persists again before installing', async () => {
    let fails = true;
    const f = fixture(command => command === 'save-last-tabs' && fails
        ? Promise.reject(new Error('temporary write failure')) : Promise.resolve());
    await f.context._doApplyUpdate();
    fails = false;
    await f.context._doApplyUpdate();
    assert.deepEqual(f.calls, ['save-last-tabs', 'save-last-tabs', 'apply-update']);
});

test('installer failure after a successful save retains its distinct message', async () => {
    const f = fixture(command => command === 'apply-update'
        ? Promise.reject(new Error('elevation prompt declined')) : Promise.resolve());
    await f.context._doApplyUpdate();
    assert.deepEqual(f.calls, ['save-last-tabs', 'apply-update']);
    assert.equal(f.button.disabled, false);
    assert.equal(f.descriptions.at(-1).text, '已取消管理员授权，更新未安装');
});

test('fire-and-forget saves remain handled while preserving the rejection for awaiters', async () => {
    const f = fixture(() => Promise.reject(new Error('background save failure')));
    f.context.saveConfig();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.length, 1);
});

test('update waits for queued settings and saves the latest snapshot before exiting', async () => {
    let release;
    const pendingAppearance = new Promise(resolve => { release = resolve; });
    const terminalValues = [];
    const f = fixture((command, payload) => {
        if (command === 'save-appearance') return pendingAppearance;
        if (command === 'save-terminal-settings') terminalValues.push(payload.scrollback);
        return Promise.resolve();
    });
    assert.ok(persist);
    vm.runInContext(persist, f.context);
    f.context._settingsConfig.scrollback = 10000;
    const prior = f.context.persistSettings();
    f.context._settingsConfig.scrollback = 20000;
    const updating = f.context._doApplyUpdate();
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.calls, ['save-appearance'], 'installation must wait for the settings queue');
    } finally {
        release();
        await prior;
        await updating;
    }
    assert.deepEqual(terminalValues, [10000, 20000]);
    assert.deepEqual(f.calls.slice(-2), ['save-last-tabs', 'apply-update']);
});

test('a failed final settings snapshot blocks update before saving tabs or installing', async () => {
    const f = fixture(command => command === 'save-terminal-settings'
        ? Promise.reject(new Error('synthetic settings write failure')) : Promise.resolve());
    vm.runInContext(persist, f.context);
    await f.context._doApplyUpdate();
    assert.deepEqual(f.calls, ['save-appearance', 'save-terminal-settings']);
    assert.equal(f.button.disabled, false);
    assert.match(f.descriptions.at(-1).text, /synthetic settings write failure/);
});
