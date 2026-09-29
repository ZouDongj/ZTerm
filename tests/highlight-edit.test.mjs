// ZTerm - highlight rule edit-dialog validation tests (node --test)
// highlight.js is a browser global script and cannot be imported in node, so
// node:vm loads the REAL highlight.js (plus the real highlight-utils.js it
// calls) with a minimal fake DOM; unrelated collaborators (overlays, the
// rules list, toasts) are stubbed or recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const highlightUtilsSrc = read('src/renderer/highlight-utils.js');
const highlightSrc = read('src/renderer/highlight.js');

function mkEl(value = '') {
    const classes = new Set();
    return {
        tagName: 'DIV', value, style: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                on ? classes.add(c) : classes.delete(c);
                return on;
            },
            contains: (c) => classes.has(c),
        },
    };
}

function loadHighlightVm() {
    const els = new Map();
    const sends = [];
    const toasts = [];
    for (const id of ['hl-edit-text', 'hl-edit-fgcolor', 'hl-edit-bgcolor',
                      'hl-edit-regexp', 'hl-edit-case', 'hl-edit-fg', 'hl-edit-bg',
                      'hl-edit-bold', 'hl-edit-italic', 'hl-edit-underline']) {
        els.set(id, mkEl());
    }
    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null, // no 'highlight-rules-list': the list render early-returns
            createElement: (tag) => mkEl(),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: mkEl(),
        },
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            invoke: () => new Promise(() => {}),
            once() {},
        },
        showToast: (msg, isError) => toasts.push({ msg, isError }),
        openOverlay() {},
        closeOverlay() {},
        showConfirm() {},
        escHtml: (s) => String(s),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(highlightUtilsSrc, context, { filename: 'highlight-utils.js' });
    vm.runInContext(highlightSrc, context, { filename: 'highlight.js' });
    return {
        context, els, sends, toasts,
        run: (code) => vm.runInContext(code, context),
        savedRules: () => sends.filter(s => s.cmd === 'save-highlight-rules').pop()?.payload.rules,
    };
}

// Stage the edit dialog the way openHighlightEdit + user input leaves it.
function stage(els, { text, isRegExp = false, isCaseSensitive = false,
                      foreground = true, foregroundColor = '#e06c75',
                      background = false, backgroundColor = '' } = {}) {
    els.get('hl-edit-text').value = text;
    els.get('hl-edit-fgcolor').value = foregroundColor;
    els.get('hl-edit-bgcolor').value = backgroundColor;
    const toggles = {
        'hl-edit-regexp': isRegExp, 'hl-edit-case': isCaseSensitive,
        'hl-edit-fg': foreground, 'hl-edit-bg': background,
        'hl-edit-bold': false, 'hl-edit-italic': false, 'hl-edit-underline': false,
    };
    for (const [id, on] of Object.entries(toggles)) els.get(id).classList.toggle('on', on);
}

test('saveHighlightEdit 非法正则拒绝保存并报错', () => {
    const vm1 = loadHighlightVm();
    stage(vm1.els, { text: '(ERROR', isRegExp: true });
    vm1.run('saveHighlightEdit()');
    assert.equal(vm1.sends.filter(s => s.cmd === 'save-highlight-rules').length, 0, 'invalid regex must not persist');
    assert.equal(vm1.toasts.length, 1);
    assert.equal(vm1.toasts[0].isError, true, 'rejection must be surfaced as an error toast');
});

test('saveHighlightEdit 合法正则正常保存', () => {
    const vm1 = loadHighlightVm();
    stage(vm1.els, { text: '(ERROR|WARN)', isRegExp: true });
    vm1.run('saveHighlightEdit()');
    const rules = vm1.savedRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].text, '(ERROR|WARN)');
    assert.equal(rules[0].isRegExp, true);
    assert.deepEqual(vm1.toasts.map(t => t.msg), ['规则已保存']);
});

test('saveHighlightEdit 非正则关键字含元字符照常保存（回归：关键字模式按字面转义）', () => {
    const vm1 = loadHighlightVm();
    stage(vm1.els, { text: '(ERROR', isRegExp: false });
    vm1.run('saveHighlightEdit()');
    const rules = vm1.savedRules();
    assert.equal(rules.length, 1, 'literal keywords with regex metacharacters must still save');
    assert.equal(rules[0].text, '(ERROR');
});
