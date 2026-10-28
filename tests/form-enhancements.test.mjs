// _disableFormEnhancements coverage (src/renderer/main.js): the
// autocomplete/autocorrect/spellcheck guard must reach an input that the
// MutationObserver hands over DIRECTLY (addedNodes can be the input node
// itself, not a container), as well as static markup and container children.
// Loads the REAL main.js into a light VM (fake DOM + recorded observer +
// stubbed startup globals) — the production function itself is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const MAIN_SRC = readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');

function mkEl(tag, over = {}) {
    const attrs = new Map();
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        nodeType: 1, // the production observer filters addedNodes on this
        children: [],
        parentElement: null,
        className: '',
        id: '',
        classList: {
            add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
        },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
        hasAttribute(k) { return attrs.has(k); },
        matches(sel) {
            const names = sel.split(',').map(s => s.trim().toUpperCase());
            return names.includes(el.tagName);
        },
        appendChild(c) {
            if (c.parentElement) {
                const i = c.parentElement.children.indexOf(c);
                if (i >= 0) c.parentElement.children.splice(i, 1);
            }
            c.parentElement = el;
            el.children.push(c);
            return c;
        },
        remove() {
            if (!el.parentElement) return;
            const i = el.parentElement.children.indexOf(el);
            if (i >= 0) el.parentElement.children.splice(i, 1);
            el.parentElement = null;
        },
        addEventListener() {}, removeEventListener() {},
        querySelectorAll(sel) {
            const names = sel.split(',').map(s => s.trim().toUpperCase());
            const out = [];
            const walk = (n) => {
                for (const c of n.children) {
                    if (names.includes(c.tagName)) out.push(c);
                    walk(c);
                }
            };
            walk(el);
            return out;
        },
        querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    };
    Object.assign(el, over);
    return el;
}

function loadMainVm(beforeLoad) {
    const observers = [];
    const root = mkEl('html');
    const body = mkEl('body');
    root.appendChild(body);
    const ctx = {
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
        MutationObserver: class {
            constructor(cb) { this._cb = cb; observers.push(this); }
            observe() {}
            disconnect() {}
        },
        document: {
            documentElement: root,
            body,
            querySelector: (sel) => body.querySelector(sel),
            querySelectorAll: (sel) => body.querySelectorAll(sel),
            getElementById: () => null,
            fonts: { load: () => Promise.resolve() },
            addEventListener() {},
        },
        window: { addEventListener() {} },
        ipcRenderer: {
            on() {},
            send() {},
            invoke: () => Promise.resolve(null),
        },
        // Startup globals main.js touches at the end of its load IIFE.
        _settingsConfig: {},
        TabManager: { init() {}, tabs: [] },
        loadSettings: () => {},
        loadQuickCommands: () => {},
        loadHighlightRules: () => {},
        applyAccentColor: () => {},
        applyTerminalScheme: () => {},
        applyUiFont: () => {},
        saveConfig: () => Promise.resolve(),
        showToast: () => {},
        CONFIG_FILE: null,
        BUNDLED_NF_MONO_FAMILY: undefined,
    };
    ctx.window.electronAPI = null; // main.js assigns it; presence of the key is enough
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    if (typeof beforeLoad === 'function') beforeLoad({ ctx, body, mkEl });
    vm.runInContext(MAIN_SRC, ctx, { filename: 'main.js' });
    return { ctx, observers, body };
}

function guarded(el) {
    return el.getAttribute('autocomplete') === 'off' &&
        el.getAttribute('autocorrect') === 'off' &&
        el.getAttribute('spellcheck') === 'false';
}

test('static inputs in the document at load time get the enhancement guard', () => {
    const vmx = loadMainVm(({ body, mkEl }) => {
        body.appendChild(mkEl('input'));
        body.appendChild(mkEl('textarea'));
    });
    // main.js runs _disableFormEnhancements(document) at load; the statics
    // staged before load must be guarded by that very call.
    const [input, area] = vmx.body.children;
    assert.equal(guarded(input), true, 'static input guarded by the load-time sweep');
    assert.equal(guarded(area), true, 'static textarea guarded by the load-time sweep');
});

test('an input handed DIRECTLY to the observer callback is guarded (the node itself)', () => {
    const vmx = loadMainVm();
    assert.ok(vmx.observers.length >= 1, 'main.js installed its MutationObserver');
    const input = mkEl('input');
    vmx.body.appendChild(input); // a MutationObserver record can carry the input node itself
    for (const mo of vmx.observers) mo._cb([{ addedNodes: [input] }]);
    assert.equal(guarded(input), true,
        'the directly-added input node must receive the guard itself, not only its descendants');
});

test('an input inside an added container is guarded', () => {
    const vmx = loadMainVm();
    const container = mkEl('div');
    const input = mkEl('input');
    container.appendChild(input);
    vmx.body.appendChild(container);
    for (const mo of vmx.observers) mo._cb([{ addedNodes: [container] }]);
    assert.equal(guarded(input), true, 'container child input guarded');
    assert.equal(guarded(container), false, 'non-input containers are untouched');
});

test('explicit attributes keep their author-provided values', () => {
    const vmx = loadMainVm();
    const input = mkEl('input');
    input.setAttribute('autocomplete', 'on');
    vmx.body.appendChild(input);
    for (const mo of vmx.observers) mo._cb([{ addedNodes: [input] }]);
    assert.equal(input.getAttribute('autocomplete'), 'on', 'explicit autocomplete not overwritten');
    assert.equal(input.getAttribute('autocorrect'), 'off', 'unset attributes still guarded');
    assert.equal(input.getAttribute('spellcheck'), 'false', 'unset attributes still guarded');
});
