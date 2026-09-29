// Tab rename must finish exactly once: Esc cancels, Enter/blur commits.
// Driven through the REAL tabs.js startRenameTab in the shared renderer VM
// (tests/helpers/renderer-vm.mjs).
//
// The defect: finish() renders, and render() wipes the .tab subtree holding
// the still-focused input — Blink dispatches blur SYNCHRONOUSLY when a DOM
// removal unloads the focused element, so the Esc path (finish(false))
// re-entered as finish(true) and still committed the typed name. The repo's
// own guard precedent is sftp.js _editPath (let done = false).
//
// Harness staging (test-local, labelled): the shared mkEl is intentionally
// minimal — the rename span only exists as innerHTML text there, so the test
// mounts a real .tab-name child; Blink's synchronous blur-on-removal is
// modelled by the render() wrapper below (blur fires once, then focus falls
// back to the body, exactly as Blink moves it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

function stageRenameDom(ctx, tabId) {
    const realCreate = ctx.document.createElement;
    ctx.document.createElement = (tag) => {
        const el = realCreate(tag);
        if (!el.select) el.select = () => {};
        if (!el.replaceWith) {
            el.replaceWith = function (node) {
                const p = this.parentElement;
                if (!p) return;
                const i = p.children.indexOf(this);
                if (i >= 0) p.children.splice(i, 1, node); else p.children.push(node);
                node.parentElement = p;
                this.parentElement = null;
            };
        }
        return el;
    };
    // Resolve the one descendant selector startRenameTab uses
    // ('.tab[data-tab="X"] .tab-name') in two steps.
    const realQS = ctx.document.querySelector;
    ctx.document.querySelector = (sel) => {
        const m = /^(\.tab\[data-tab="[^"]+"\]) (\.tab-name)$/.exec(sel);
        if (m) { const t = realQS(m[1]); return t ? t.querySelector(m[2]) : null; }
        return realQS(sel);
    };
}

// Blink: removing the focused element's subtree dispatches one synchronous
// blur, then focus falls back to <body>. Modelled on top of render() (which
// performs that removal); counts renders so re-entrant finishes are visible.
function modelBlinkBlur(ctx) {
    let input = null;
    let renders = 0;
    const realRender = ctx.TabManager.render.bind(ctx.TabManager);
    ctx.TabManager.render = function (...a) {
        if (input && ctx.document.activeElement === input) {
            const h = input.onblur;
            ctx.document.activeElement = ctx.document.body;
            if (typeof h === 'function') h();
        }
        renders++;
        return realRender(...a);
    };
    return { setInput: (el) => { input = el; }, renders: () => renders };
}

function renamed(ctx, tabId) {
    const tab = wiredTab(ctx, tabId, 'local_1', 'content');
    stageRenameDom(ctx, tabId);
    const blink = modelBlinkBlur(ctx);
    ctx.TabManager.render();
    // The span render() only paints as innerHTML text in the harness — mount
    // it as a real child so the production selector resolves.
    const tabEl = ctx.document.querySelector('.tab[data-tab="' + tabId + '"]');
    const span = ctx.document.createElement('span');
    span.className = 'tab-name';
    span.textContent = tab.name;
    tabEl.appendChild(span);
    ctx.TabManager.startRenameTab(tabId);
    const input = ctx.document.querySelector('.tab-rename-input');
    assert.ok(input, 'rename input staged');
    blink.setInput(input);
    return { tab, input, blink };
}

test('Escape cancels the rename even though the render-drop blur re-enters finish', () => {
    const ctx = loadVm();
    const { tab, input, blink } = renamed(ctx, 't_rn');
    input.value = 'Renamed';

    const base = blink.renders();
    input.onkeydown({ key: 'Escape', stopPropagation() {} });

    assert.equal(tab.name, 't_rn', 'Escape must not commit the typed name');
    assert.equal(tab._customName, undefined, 'no custom-name lock on Escape');
    assert.equal(blink.renders(), base + 1, 'finish ran exactly once (the nested blur was a no-op)');
});

test('Enter commits the typed name exactly once', () => {
    const ctx = loadVm();
    const { tab, input, blink } = renamed(ctx, 't_rn');
    input.value = 'Renamed';

    const base = blink.renders();
    input.onkeydown({ key: 'Enter', stopPropagation() {} });

    assert.equal(tab.name, 'Renamed', 'Enter commits');
    assert.equal(tab._customName, true, 'custom name locked');
    assert.equal(blink.renders(), base + 1, 'a single finish — the removal blur must not re-commit');
});

test('a real blur (clicking away) still commits', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn');
    input.value = 'Renamed';

    // The click moves focus first; the input's blur is the ONLY finish trigger.
    ctx.document.activeElement = ctx.document.body;
    input.onblur();

    assert.equal(tab.name, 'Renamed', 'blur commits');
    assert.equal(tab._customName, true);
});
