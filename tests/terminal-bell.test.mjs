import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm, RealTerm, TimerQueue, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);

function bellVm() {
    const ctx = loadVm();
    const toasts = [];
    ctx.Terminal = class extends RealTerm {
        onBell(callback) {
            this._bellCallbacks = this._bellCallbacks || [];
            this._bellCallbacks.push(callback);
            return { dispose: () => this._bellCallbacks.splice(this._bellCallbacks.indexOf(callback), 1) };
        }
        emitBell() { this._bellCallbacks.forEach(callback => callback()); }
    };
    ctx.showToast = (...args) => toasts.push(args);
    ctx.document.hasFocus = () => true;
    ctx._settingsConfig.bell = 'notification';
    return { ctx, toasts };
}

test('the bundled parser reports BEL without a reason and ignores ordinary backspace', async () => {
    require('../src/vendor/xterm.js');
    const term = new globalThis.TabbyXterm.Terminal();
    const events = [];
    term.onBell(event => events.push(event));
    try {
        await new Promise(resolve => term.write('\b\b', resolve));
        assert.equal(events.length, 0);
        await new Promise(resolve => term.write('\x07', resolve));
        assert.equal(events.length, 1);
        assert.equal(events[0], undefined, 'BEL does not report the shell action that caused it');
    } finally { term.dispose(); }
});

test('foreground terminal BEL does not interrupt editing with a toast', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'foreground', 'local_fg', '');
    ctx.TabManager.activeId = tab.id;
    tab.term.focus();
    tab.term.emitBell();
    tab.term.emitBell();
    assert.deepEqual(toasts, []);
});

test('background BEL explains its source without presenting success', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'background', 'local_bg', '', { name: 'Build' });
    ctx.TabManager.activeId = 'other';
    tab.term.emitBell();
    assert.equal(toasts.length, 1);
    assert.match(toasts[0][0], /Build/);
    assert.match(toasts[0][0], /终端.*(提示|关注)/);
    assert.equal(toasts[0][2], 'info');
});

test('window-unfocused BEL remains available with notification mode', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'unfocused', 'local_unfocused', '');
    ctx.TabManager.activeId = tab.id;
    ctx.document.hasFocus = () => false;
    tab.term.emitBell();
    assert.equal(toasts.length, 1);
});

test('notification bursts coalesce per terminal', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'background', 'local_bg', '');
    for (let i = 0; i < 10; i++) tab.term.emitBell();
    assert.equal(toasts.length, 1);
    const other = wiredTab(ctx, 'other', 'local_other', '');
    other.term.emitBell();
    assert.equal(toasts.length, 2, 'one terminal does not silence another');
    ctx.__tq.advance(2500);
    tab.term.emitBell();
    assert.equal(toasts.length, 3, 'a later signal can notify again');
});

test('disabled BEL has neither notification nor tab flash', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'disabled', 'local_disabled', '');
    ctx.TabManager.render();
    ctx._settingsConfig.bell = 'off';
    tab.term.emitBell();
    assert.deepEqual(toasts, []);
    const el = ctx.document.querySelector('.tab[data-tab="disabled"]');
    assert.ok(el);
    assert.equal(el.classList.contains('bell-flash'), false);
});

test('focused split pane is quiet while its background sibling can notify', () => {
    const { ctx, toasts } = bellVm();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 'split', 'local_1', '', 'local_2', '');
    ctx.TabManager.activeId = tab.id;
    ctx.TabManager._focusPane(tab, p2.id);
    p2.term.emitBell();
    assert.equal(toasts.length, 0);
    p1.term.emitBell();
    assert.equal(toasts.length, 1);
});

test('a migrated terminal resolves the current notification owner', () => {
    const { ctx, toasts } = bellVm();
    const { tab, p2 } = wiredSplitTab(ctx, 'source', 'local_1', '', 'local_2', '');
    const term = p2.term;
    ctx.TabManager._extractPaneToTab(tab.id, p2.id);
    const current = ctx.TabManager.tabs.find(candidate => candidate.term === term);
    assert.ok(current);
    current.name = 'Moved session';
    ctx.TabManager.activeId = tab.id;
    term.emitBell();
    assert.match(toasts[0][0], /^Moved session/);
});

test('a closing terminal does not create a stale notification', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'closing', 'local_closing', '');
    ctx.TabManager._closingTabs.add(tab.id);
    tab.term.emitBell();
    assert.deepEqual(toasts, []);
});

test('explicit flash mode remains available for the foreground tab', () => {
    const { ctx, toasts } = bellVm();
    const tab = wiredTab(ctx, 'flash', 'local_flash', '');
    ctx.TabManager.activeId = tab.id;
    ctx.TabManager.render();
    ctx._settingsConfig.bell = 'flash';
    tab.term.emitBell();
    const el = ctx.document.querySelector('.tab[data-tab="flash"]');
    assert.equal(el.classList.contains('bell-flash'), true);
    assert.deepEqual(toasts, []);
    ctx.__tq.advance(2000);
    assert.equal(el.classList.contains('bell-flash'), false);
});

test('informational toast does not change existing success and error callers', () => {
    const timers = new TimerQueue();
    const el = { textContent: '', className: '', classList: {
        add(name) { el.className += ' ' + name; },
        remove(name) { el.className = el.className.split(' ').filter(value => value !== name).join(' '); },
    } };
    const ctx = {
        require: () => ({}),
        window: { addEventListener() {} },
        document: { getElementById: () => el },
        setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
        clearTimeout: id => timers.clearTimeout(id),
    };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(new URL('../src/renderer/utils.js', import.meta.url), 'utf8'), ctx);
    ctx.showToast('Attention', false, 'info');
    assert.equal(el.className, 'toast info show');
    ctx.showToast('Saved');
    assert.equal(el.className, 'toast show');
    ctx.showToast('Failed', true);
    assert.equal(el.className, 'toast error show');
    timers.advance(2500);
    assert.equal(el.className, 'toast error');
});
