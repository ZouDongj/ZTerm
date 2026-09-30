// input-1: the command palette, the quick-commands panel and the terminal
// search bar handle their keydown WITHOUT an IME composition guard, unlike
// the session selector (ssh.js: "IME composition: never select, connect or
// close; confirming a candidate is not 'open session'"). Confirming a
// candidate with Enter fired the highlighted palette action (close tab, split
// layout...) or injected the selected quick command into the terminal. The
// fix mirrors ssh.js: return early while e.isComposing / keyCode 229.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadQcVm, mkEvt } from './helpers/manager-vm.mjs';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const composing = { isComposing: true };
const keyCode229 = { keyCode: 229 };

// ── Command palette: real command-palette.js in a standalone VM ─────────────

function paletteVm() {
    const source = fs.readFileSync(new URL('../src/renderer/command-palette.js', import.meta.url), 'utf8');
    const el = () => {
        const classes = new Set();
        return {
            value: '',
            classList: {
                add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
            },
        };
    };
    const paletteEl = el();
    paletteEl.classList.add('open'); // palette is open while its input composes
    const inputEl = el();
    inputEl.value = '关闭'; // composition text already in the field
    const executed = [];
    const context = {
        document: { getElementById: id => ({ 'overlay-palette': paletteEl, 'palette-input': inputEl, 'palette-list': el(), 'palette-empty': el() }[id] || null) },
        console,
        setTimeout: () => 0, clearTimeout: () => {},
        escHtml: s => String(s),
        SHORTCUT_LABELS: { closeTab: '关闭标签页' },
        SHORTCUT_ACTIONS: { closeTab: () => executed.push('closeTab') },
        _getShortcutBindings: () => ({ commandPalette: 'Ctrl+P', closeTab: 'Ctrl+W' }),
        _comboDisplay: c => c,
        comboFromEvent: () => '',
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'command-palette.js' });
    return { context, paletteEl, executed };
}

test('palette: Enter during composition does not run the highlighted action', () => {
    const f = paletteVm();
    f.context.paletteKeyDown(mkEvt({ key: 'Enter', ...composing }));
    assert.deepEqual(f.executed, [], 'no action ran');
    assert.equal(f.paletteEl.classList.contains('open'), true, 'palette stays open (Enter confirmed the IME candidate)');

    f.context.paletteKeyDown(mkEvt({ key: 'Enter', ...keyCode229 }));
    assert.deepEqual(f.executed, [], 'keyCode 229 is guarded the same way');

    // Control: a plain Enter still executes the filtered selection.
    f.context.paletteKeyDown(mkEvt({ key: 'Enter' }));
    assert.deepEqual(f.executed, ['closeTab'], 'plain Enter still dispatches');
});

test('palette: Escape during composition does not close the palette', () => {
    const f = paletteVm();
    f.context.paletteKeyDown(mkEvt({ key: 'Escape', ...composing }));
    assert.equal(f.paletteEl.classList.contains('open'), true, 'Escape belongs to the IME, not the panel');
});

// ── Quick commands: real quick-commands.js + qc-utils.js via manager VM ────

function qcWithCommand(ctx) {
    vm.runInContext('_qcCommands = [{ id: "qc_1", name: "常用", command: "htop", group: "常用" }]', ctx);
    ctx.document.getElementById('qc-input').value = '常用';
    ctx.TabManager.getActive = () => ({ tabId: 't1', splitRoot: null, term: { focus() {} } });
}

test('quick commands: Enter during composition does not inject the command into the terminal', async () => {
    const ctx = loadQcVm();
    qcWithCommand(ctx);

    ctx.qcKeydown(mkEvt({ key: 'Enter', ...composing }));
    assert.ok(!ctx.__sends.some(s => s.cmd === 'pty-input'), 'no pty-input while composing');

    ctx.qcKeydown(mkEvt({ key: 'Enter', ...keyCode229 }));
    assert.ok(!ctx.__sends.some(s => s.cmd === 'pty-input'), 'keyCode 229 guarded too');

    // Control: a plain Enter still injects the selected command.
    ctx.qcKeydown(mkEvt({ key: 'Enter' }));
    const send = ctx.__sends.find(s => s.cmd === 'pty-input');
    assert.ok(send, 'plain Enter still dispatches the command');
    assert.equal(send.payload.data, 'htop');
});

// ── Terminal search bar: real terminal.js through the renderer VM ──────────

test('search bar: Enter/Escape during composition do not navigate or close', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_a', 'local_a', 'needle line\nother\nneedle again');
    ctx.TabManager.switchTo('t_a');
    ctx.document.getElementById('search-bar').classList.add('open');
    const input = ctx.__searchInput;
    input.value = 'needle';
    ctx.doSearch(); // synchronous programmatic contract: count is live
    assert.equal(ctx.__searchCount.textContent, '1/2');

    ctx.onSearchKey(mkEvt({ key: 'Enter', ...composing }));
    assert.equal(ctx.__searchCount.textContent, '1/2', 'composition Enter did not advance the match');

    ctx.onSearchKey(mkEvt({ key: 'Enter', ...keyCode229 }));
    assert.equal(ctx.__searchCount.textContent, '1/2', 'keyCode 229 guarded too');

    ctx.onSearchKey(mkEvt({ key: 'Escape', ...composing }));
    assert.equal(ctx.document.getElementById('search-bar').classList.contains('open'), true,
        'composition Escape did not close the search bar');

    // Control: a plain Enter still navigates.
    ctx.onSearchKey(mkEvt({ key: 'Enter' }));
    assert.equal(ctx.__searchCount.textContent, '2/2', 'plain Enter still advances');
});
