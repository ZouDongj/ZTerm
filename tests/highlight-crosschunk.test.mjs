// ZTerm - cross-chunk SGR baseline for keyword highlight (node --test)
// Issue #9 residual: a color set in one write() (e.g. printf '\e[38;2;..m')
// and carried into later chunks/lines used to be washed back to default at
// the highlight end sequence. These tests pin the carried baseline: pure
// logic is imported directly; the applyHighlight-level flow loads the REAL
// highlight-utils.js + highlight.js in a vm with stub collaborators, the same
// harness pattern as highlight-edit.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSgrState, applySgrParams, sgrStatesAt, applyHighlightToLine } =
    require('../src/renderer/highlight-utils.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const fgRule = { id: 'hl_t', text: 'ERROR', enabled: true, isRegExp: false, isCaseSensitive: false,
                 foreground: true, foregroundColor: '#e06c75', background: false, backgroundColor: '',
                 bold: false, italic: false, underline: false };

// highlight.js is a browser-global script: load it with highlight-utils.js
// into a vm context. Only declarations run at load; applyHighlight touches
// no DOM/ipc collaborator.
function loadHighlightVm() {
    const context = {
        console,
        setTimeout: () => 0,
        document: { getElementById: () => null, createElement: () => ({}), addEventListener() {},
                    querySelector: () => null, querySelectorAll: () => [] },
        ipcRenderer: { send() {}, invoke: () => new Promise(() => {}), once() {} },
        showToast() {}, openOverlay() {}, closeOverlay() {}, showConfirm() {}, escHtml: (s) => String(s),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/highlight-utils.js'), context, { filename: 'highlight-utils.js' });
    vm.runInContext(read('src/renderer/highlight.js'), context, { filename: 'highlight.js' });
    const v = { run: (code) => vm.runInContext(code, context) };
    v.run('_highlightRules = ' + JSON.stringify([fgRule]) + ';');
    return v;
}

// Feed one write() chunk through the real applyHighlight for `tab`.
const feed = (v, chunk, tab) => v.run('applyHighlight(' + JSON.stringify(chunk) + ', ' + JSON.stringify(tab) + ')');

// ── pure logic: highlight-utils.js ──

test('sgrStatesAt 以传入初始状态为行首基线（跨块携带色可见）', () => {
    const carried = createSgrState();
    applySgrParams(carried, '38;2;97;175;239');
    const [s] = sgrStatesAt('ERROR here', [0], carried);
    assert.equal(s.fg, '38;2;97;175;239', 'carried fg must be the baseline at position 0');
});

test('sgrStatesAt 不修改调用方传入的初始状态', () => {
    const carried = createSgrState();
    applySgrParams(carried, '31');
    sgrStatesAt('\x1b[32mx\x1b[1my', [0, 6], carried);
    assert.equal(carried.fg, '31', 'caller state must stay untouched');
    assert.equal(carried.bold, false);
});

test('applyHighlightToLine 结束序列恢复携带色而非默认色', () => {
    const carried = createSgrState();
    applySgrParams(carried, '31');
    const out = applyHighlightToLine('ERROR msg', [fgRule], carried);
    assert.ok(out.includes('ERROR\x1b[31m'),
        'end sequence must restore the carried red, got: ' + JSON.stringify(out));
});

test('applyHighlightToLine 就地推进携带状态（无匹配行同样推进）', () => {
    const carried = createSgrState();
    applyHighlightToLine('\x1b[1mplain line', [fgRule], carried);
    assert.equal(carried.bold, true, 'SGR on a non-matching line must still advance the baseline');
    applyHighlightToLine('\x1b[32mcolor ERROR tail', [fgRule], carried);
    assert.equal(carried.fg, '32');
    const out = applyHighlightToLine('next ERROR', [fgRule], carried);
    assert.ok(out.includes('ERROR\x1b[32m'), 'advanced baseline must drive the restore');
});

test('applyHighlightToLine 无携带状态时保持旧兜底（默认重置，不劣化）', () => {
    const out = applyHighlightToLine('ERROR msg', [fgRule]);
    assert.ok(out.includes('ERROR\x1b[39m'), 'two-arg call keeps the pre-fix default reset');
});

// ── stream flow: real applyHighlight across write() chunks ──

test('applyHighlight 分块输出：前块设色后块关键字恢复携带色（printf 场景）', () => {
    const v = loadHighlightVm();
    const out1 = feed(v, '\x1b[38;2;97;175;239m', 't1');
    assert.equal(out1, '\x1b[38;2;97;175;239m', 'non-matching chunk passes through unchanged');
    const out2 = feed(v, 'build ERROR here\r\n', 't1');
    assert.ok(out2.includes('ERROR\x1b[38;2;97;175;239m'),
        'carried truecolor must be restored after the keyword, got: ' + JSON.stringify(out2));
    assert.ok(!out2.includes('ERROR\x1b[39m'), 'default reset must not wash the carried color');
});

test('applyHighlight 跨行携带：上一行设色，下一行关键字恢复该色', () => {
    const v = loadHighlightVm();
    const out = feed(v, '\x1b[32mok line\nsee ERROR now\n', 't1');
    assert.ok(out.includes('ERROR\x1b[32m'),
        'line-2 keyword must restore the color set on line 1, got: ' + JSON.stringify(out));
});

test('applyHighlight 无跨块信息时保持默认重置兜底（不劣化）', () => {
    const v = loadHighlightVm();
    const out = feed(v, 'plain ERROR plain\n', 't1');
    assert.ok(out.includes('ERROR\x1b[39m'), 'fresh tab keeps the pre-fix fallback');
});

test('applyHighlight 各 tabId 携带基线相互隔离', () => {
    const v = loadHighlightVm();
    feed(v, '\x1b[31mred', 't1');
    const out2 = feed(v, 'ERROR here\n', 't2');
    assert.ok(out2.includes('ERROR\x1b[39m'), "t2 must not see t1's carried color");
    const out1 = feed(v, 'ERROR here\n', 't1');
    assert.ok(out1.includes('ERROR\x1b[31m'), 't1 keeps its own carried color');
});

test('applyHighlight 高亮停用期间基线继续随流推进', () => {
    const v = loadHighlightVm();
    v.run('_highlightSettings.highlightEnabled = false;');
    feed(v, '\x1b[35m', 't1');
    v.run('_highlightSettings.highlightEnabled = true;');
    const out = feed(v, 'ERROR x\n', 't1');
    assert.ok(out.includes('ERROR\x1b[35m'),
        'baseline must track the stream even while highlighting is off, got: ' + JSON.stringify(out));
});

test('applyHighlight 会话结束清理：clearAlternateScreen 复位携带基线', () => {
    const v = loadHighlightVm();
    feed(v, '\x1b[31m', 't1');
    v.run('clearAlternateScreen("t1")');
    const out = feed(v, 'ERROR here\n', 't1');
    assert.ok(out.includes('ERROR\x1b[39m'), 'cleared tab falls back to the default reset');
});
