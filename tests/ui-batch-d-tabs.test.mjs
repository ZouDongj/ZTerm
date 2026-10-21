// Batch D independent-review fixes (U-05 / U-07 / U-15 / U-16), driven through
// the REAL tabs.js / ipc.js / terminal.js in the shared renderer VM
// (tests/helpers/renderer-vm.mjs); only the DOM, timers and the ipc invoke
// bridge are faked.
//
// U-05: the busy reconnect spinner swallowed tab activation — the plainer
//   .tab:hover/.tab.active .tab-reconnect rule re-enabled pointer-events at a
//   higher specificity than the lone .tab-reconnect-busy rule, and the button
//   had no ondblclick guard, so a double click bubbled into the rename gesture.
// U-07: tab→pane promotion and cross-tab terminal moves copied _sessionFailed
//   but not _sshConnecting/_sshErrored — a still-connecting or errored session
//   lost its busy ring / error dot on arrival (pane-fields.js
//   adoptPaneFieldsIntoTab already covers the reverse, collapse direction).
// U-15: the ssh-error auto-retry branch cleared _sshReconnectNotice, so a
//   manual reconnect that recovered through handshake retries toasted
//   "SSH 已连接" instead of "SSH 已重新连接" on the eventual success.
// U-16: _showDropHint wrote geometry with the .drop-hint transition live, so
//   a fresh hint flew in from the previous drag's rect instead of appearing
//   in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));

// Recording, never-settling invoke bridge (same shape as
// ssh-reconnect-dedupe.test.mjs): every ssh-connect stays observable.
function patchInvoke(ctx) {
    const invokes = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => {
        const rec = { cmd, payload };
        rec.promise = new Promise(() => {});
        invokes.push(rec);
        return rec.promise;
    };
    return invokes;
}
const connects = (invokes) => invokes.filter(i => i.cmd === 'ssh-connect');

function captureToasts(ctx) {
    const toasts = [];
    ctx.showToast = (m, isErr) => toasts.push({ m: String(m), isErr: !!isErr });
    return toasts;
}

// ── U-05 ────────────────────────────────────────────────────────────────────

test('U-05: the busy reconnect button stops double-click propagation (no rename)', () => {
    const ctx = loadVm();
    wiredTab(ctx, 't_busy', 'ssh_1', null, { type: 'ssh', host: 'h', user: 'u', connected: false, _sshConnecting: true });
    ctx.TabManager.render();
    const el = ctx.document.querySelector('.tab[data-tab="t_busy"]');
    assert.ok(el, 'tab element rendered');
    const html = el.innerHTML;
    const bi = html.indexOf('class="tab-reconnect tab-reconnect-busy"');
    assert.ok(bi > 0, 'busy spinner rendered while _sshConnecting');
    const btn = html.slice(html.lastIndexOf('<button', bi), html.indexOf('</button>', bi));
    assert.ok(btn.includes('onclick="event.stopPropagation()"'), 'click stays off the tab');
    assert.ok(btn.includes('ondblclick="event.stopPropagation()"'),
        'dblclick must not bubble into the rename gesture (old code lacked the guard)');
});

test('U-05: the busy rule beats the hover/active reveal (pointer-events stay none)', () => {
    const css = readFileSync(new URL('../src/renderer/app.css', import.meta.url), 'utf8');
    // Rules are brace-terminated; the fix's comment block carries no braces.
    const rule = css.split('}').map(r => r.trim()).find(r => r.includes('.tab-reconnect-busy'));
    assert.ok(rule, 'busy rule present');
    assert.ok(rule.includes('pointer-events:none'), 'busy spinner stays inert');
    assert.ok(rule.includes('.tab:hover .tab-reconnect-busy') && rule.includes('.tab.active .tab-reconnect-busy'),
        'the plainer .tab:hover/.tab.active .tab-reconnect rule must not re-enable pointer events on the busy variant');
});

