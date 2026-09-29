// Tab rename vs background redraws: lifecycle events (ssh state flips,
// pty-exit, reconnects in other tabs) call TabManager.render() at any time.
// The redraw used to rebuild the whole strip and remove the focused rename
// input, and Blink's synchronous blur-on-removal committed the half-typed
// value as the locked custom name (persisted by the next save). Contract:
// - the rename-active tab keeps its DOM node across redraws (typing is
//   never interrupted, nothing is committed by the redraw itself);
// - an automatic collapse (the renamed tab closed mid-edit) never commits
//   the half-typed value;
// - Enter / blur / Esc semantics are unchanged.
// Driven through the REAL tabs.js startRenameTab / render in the shared
// renderer VM (tests/helpers/renderer-vm.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

// Stage what startRenameTab needs on the minimal shared DOM: a real
// .tab-name child (the harness paints names as innerHTML text only), the
// input affordances, and Blink's blur-on-removal — removing a subtree that
// holds the focused element dispatches one synchronous blur and focus falls
// back to <body>.
function stageRename(ctx) {
    let renameInput = null;
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
        const realRemove = el.remove;
        el.remove = function () {
            if (renameInput && ctx.document.activeElement === renameInput && this.contains(renameInput)) {
                ctx.document.activeElement = ctx.document.body;
                const h = renameInput.onblur;
                if (typeof h === 'function') h();
            }
            return realRemove.apply(this, arguments);
        };
        return el;
    };
    // Resolve the descendant selector startRenameTab uses
    // ('.tab[data-tab="X"] .tab-name') in two steps.
    const realQS = ctx.document.querySelector;
    ctx.document.querySelector = (sel) => {
        const m = /^(\.tab\[data-tab="[^"]+"\]) (\.tab-name)$/.exec(sel);
        if (m) { const t = realQS(m[1]); return t ? t.querySelector(m[2]) : null; }
        return realQS(sel);
    };
    return { setInput: (el) => { renameInput = el; } };
}

function renaming(ctx, tabId) {
    const tab = wiredTab(ctx, tabId, tabId.replace(/^t_/, 'local_'), 'content');
    stageRename(ctx);
    ctx.TabManager.render();
    const tabEl = ctx.document.querySelector('.tab[data-tab="' + tabId + '"]');
    const span = ctx.document.createElement('span');
    span.className = 'tab-name';
    span.textContent = tab.name;
    tabEl.appendChild(span);
    ctx.TabManager.startRenameTab(tabId);
    const input = ctx.document.querySelector('.tab-rename-input');
    assert.ok(input, 'rename input staged');
    assert.equal(ctx.document.activeElement, input, 'rename input focused');
    return { tab, input };
}

test('a background redraw during rename keeps the input and commits nothing', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_other', 'local_o', 'other');
    const { tab, input } = renaming(ctx, 't_rn');
    input.value = 'hal'; // half-typed

    const otherBefore = ctx.document.querySelector('.tab[data-tab="t_other"]');
    // What ipc.js does on ssh-connecting / ssh-error / pty-exit in ANY tab.
    ctx.TabManager.render();

    assert.equal(ctx.document.querySelector('.tab-rename-input'), input, 'the rename input survived the redraw');
    assert.equal(input.parentElement, ctx.document.querySelector('.tab[data-tab="t_rn"]'), 'still inside its own tab element');
    assert.equal(ctx.document.activeElement, input, 'focus never left the input');
    assert.equal(tab.name, 't_rn', 'the half-typed value was not committed');
    assert.equal(tab._customName, undefined, 'no custom-name lock');
    assert.notEqual(ctx.document.querySelector('.tab[data-tab="t_other"]'), otherBefore, 'other tabs still rebuild');

    // Typing continues; a real Enter still commits exactly once.
    input.value = 'final name';
    input.onkeydown({ key: 'Enter', stopPropagation() {} });
    assert.equal(tab.name, 'final name', 'Enter commits the full value');
    assert.equal(tab._customName, true, 'custom name locked on commit');
});

test('repeated redraws and a tab reorder re-seat the kept node at its position', () => {
    const ctx = loadVm();
    const { input } = renaming(ctx, 't_rn'); // array order: [t_rn]
    wiredTab(ctx, 't_other2', 'local_o2', 'x');
    // Order change while the rename is live (drag reorder lands the same way).
    const tab = ctx.TabManager.tabs.find(t => t.id === 't_rn');
    ctx.TabManager.tabs.splice(ctx.TabManager.tabs.indexOf(tab), 1);
    ctx.TabManager.tabs.unshift(tab);
    ctx.TabManager.render();
    ctx.TabManager.render();

    const bar = ctx.document.getElementById('tabbar');
    assert.deepEqual(bar.children.map(el => el.getAttribute('data-tab') || el.id), ['t_rn', 't_other2', 'btn-add-tab'],
        'the kept node sits at its order position, add-button last');
    assert.equal(ctx.document.querySelector('.tab-rename-input'), input, 'the input is still the live one');
});

test('closing the renamed tab mid-edit never commits the half-typed value', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_keep', 'local_k', 'keep');
    const { tab, input } = renaming(ctx, 't_rn');
    input.value = 'hal';

    // The renamed tab left this.tabs (closeTab's deferred removal splices it
    // out before its final render): the input's removal is an AUTOMATIC
    // collapse — under Blink the synchronous blur must not commit anything.
    ctx.TabManager.tabs.splice(ctx.TabManager.tabs.indexOf(tab), 1);
    ctx.TabManager.render();

    assert.equal(tab.name, 't_rn', 'no half-typed commit on the dying tab');
    assert.equal(tab._customName, undefined, 'no custom-name lock');
    assert.equal(ctx.document.querySelector('.tab-rename-input'), null, 'the dead input is gone');
    assert.equal(ctx.TabManager._renamingTabId, null, 'the rename marker is released');
});
