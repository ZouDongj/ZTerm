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

function renamed(ctx, tabId, opts) {
    const tab = wiredTab(ctx, tabId, 'local_1', 'content');
    stageRenameDom(ctx, tabId);
    // noEntryBlur: skip the legacy entry-level blur model. The real trace
    // (artifacts/e2e-tmp/06-tab-focus-state.log) proved the blur of a
    // SURVIVING rename fires at the reseat appendChild inside render, not at
    // render entry; tests that model the reseat must not double-model.
    const blink = (opts && opts.noEntryBlur)
        ? { setInput() {}, renders: () => 0 }
        : modelBlinkBlur(ctx);
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

// An unchanged commit must not engage the rename lock: double-click selects
// the current name and clicking away blurs, so without the changed-check an
// accidental rename would pin the tab to its current name forever (persisted
// as customName — later drag-splits then never re-join the pane names).
test('blur with an unchanged name does NOT lock the tab', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn');
    // startRenameTab pre-fills the input with the current name; the user edits nothing.
    ctx.document.activeElement = ctx.document.body;
    input.onblur();

    assert.equal(tab.name, 't_rn', 'name untouched');
    assert.equal(tab._customName, undefined, 'no custom-name lock on an unchanged blur commit');
});

test('Enter with an unchanged name does NOT lock the tab', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn');
    input.onkeydown({ key: 'Enter', stopPropagation() {} });

    assert.equal(tab.name, 't_rn');
    assert.equal(tab._customName, undefined, 'no custom-name lock on an unchanged Enter commit');
});

// Clearing the name is the unlock gesture — it must work on single tabs too,
// not only split tabs, otherwise an accidentally locked tab can never recover.
test('clearing the name on a locked single tab releases the lock', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn');
    tab.name = 'My Server';
    tab._customName = true; // pre-existing lock (e.g. persisted across a restart)
    input.value = '';

    input.onkeydown({ key: 'Enter', stopPropagation() {} });

    assert.equal(tab._customName, undefined, 'lock released');
    assert.equal(tab.name, 'My Server', 'the last name stays until auto-naming moves it');
});

// IME composition owns the keyboard while composing: the Enter that confirms
// a composition candidate (keyCode 229 / isComposing) must neither commit nor
// cancel the rename — the same guard sftp.js _editPath uses.
test('IME composition Enter/Escape never commit or cancel the rename', () => {
    const ctx = loadVm();
    const { tab, input, blink } = renamed(ctx, 't_rn');
    input.value = ' composing name';

    const base = blink.renders();
    input.onkeydown({ key: 'Enter', isComposing: true, keyCode: 229, stopPropagation() {} });
    assert.equal(tab.name, 't_rn', 'composing Enter must not commit');
    assert.equal(blink.renders(), base, 'composing Enter must not finish the editor at all');
    assert.ok(ctx.document.querySelector('.tab-rename-input') || input.parentElement, 'editor still open');

    input.onkeydown({ key: 'Escape', isComposing: true, keyCode: 229, stopPropagation() {} });
    assert.equal(tab.name, 't_rn', 'composing Escape must not cancel');
    assert.equal(blink.renders(), base, 'composing Escape must not finish the editor either');

    // A real (non-composing) Enter still commits afterwards. (Local tab
    // names keep their pre-existing trim — the no-trim contract covers
    // REMOTE paths only.)
    input.onkeydown({ key: 'Enter', stopPropagation() {} });
    assert.equal(tab.name, 'composing name', 'plain Enter commits after composition ends');
});

// Background renders RE-SEAT the kept rename node (render() re-appends it at
// its order position). Re-inserting an in-document node is a remove+insert,
// and in WebView2 that removal fires ONE synchronous blur on the focused
// input — the real trace (artifacts/e2e-tmp/06-tab-focus-state.log) shows
// doRemove → render → the reseat appendChild → blur → finish(true) committing
// the half-typed name. The internal move must not read as the user leaving
// the field; focus and selection must be restored after it. A REAL external
// blur keeps the original commit semantics.
test('a background render reseat never commits the half-typed rename (focus/selection restored)', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn', { noEntryBlur: true });
    input.value = 'HALF';
    input.selectionStart = 1; input.selectionEnd = 3; // a real caret/selection state
    ctx.document.activeElement = input;

    // Model Chromium's reseat blur: re-appending an in-document node removes
    // it first, and that removal blurs the focused element synchronously
    // (focus falls back to <body> exactly as Blink moves it).
    const vp = ctx.TabManager._ensureStripChrome() || ctx.document.getElementById('tabbar');
    const origAppend = vp.appendChild.bind(vp);
    vp.appendChild = (node) => {
        if (node && node.parentElement === vp) {
            const focused = node.querySelector && node.querySelector('.tab-rename-input');
            if (focused && ctx.document.activeElement === focused) {
                ctx.document.activeElement = ctx.document.body;
                if (typeof focused.onblur === 'function') focused.onblur();
            }
        }
        return origAppend(node);
    };

    ctx.TabManager.render(); // the doRemove-style background render
    assert.equal(tab.name, 't_rn', 'the reseat blur must not commit the half-typed name');
    assert.equal(tab._customName, undefined, 'no custom-name lock from the reseat');
    assert.ok(ctx.document.querySelector('.tab-rename-input'), 'the editor survived the reseat');
    assert.equal(ctx.document.activeElement, input, 'focus restored onto the editor after the reseat');

    // The editor stays usable afterwards: a plain Enter still commits.
    input.onkeydown({ key: 'Enter', stopPropagation() {} });
    assert.equal(tab.name, 'HALF', 'plain Enter commits after the reseat');
});

// A REAL external blur (the user genuinely clicking away) keeps the original
// commit semantics — the internal-move guard must not swallow it.
test('a real external blur after a reseat still commits', () => {
    const ctx = loadVm();
    const { tab, input } = renamed(ctx, 't_rn', { noEntryBlur: true });
    input.value = 'TYPED';
    ctx.document.activeElement = input;
    ctx.TabManager.render(); // reseat first (guard exercised)
    assert.ok(ctx.document.querySelector('.tab-rename-input'), 'editor survived the reseat');
    ctx.document.activeElement = ctx.document.body;
    input.onblur(); // a genuine external blur
    assert.equal(tab.name, 'TYPED', 'external blur commits as before');
});
