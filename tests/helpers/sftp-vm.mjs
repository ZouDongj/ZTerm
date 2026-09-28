// SFTP-specific VM harness for tests/sftp-ownership.test.mjs (batch 06).
// Loads the REAL renderer stack through the shared tests/helpers/renderer-vm.mjs
// seam, then runs the REAL src/renderer/sftp.js into the same context. Only the
// environment is faked:
// - DOM elements for the SFTP panel and transfer flyout (minimal mkEl shapes).
// - ipcRenderer.invoke replaced with a deferred controller: every invoke is
//   recorded ({cmd, args}) and settles ONLY when the test resolves/rejects it,
//   so async orderings are deterministic (no timers, no real IPC, no SSH).
// - showToast / formatSize / formatDate recorded stubs.
// - webUtils.getPathForFile shim so the REAL Electron drop handler reaches the
//   real _handleDroppedPaths with synthetic paths.
// Backend events are dispatched through the shared seam's __emit (the same
// channel/payload path ipc-polyfill delivers). Effects only ever name SYNTHETIC
// sessions (sessA/sessB) and synthetic paths — no real SSH, files, dialogs or
// clipboard.
//
// Fake-DOM modeling note (same as the shared seam): assigning .innerHTML only
// sets the string property; "rendered now" is asserted on rows APPENDED after a
// mark (children.slice(mark)), and error/empty states set via innerHTML on the
// string.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadVm } from './renderer-vm.mjs';

const sftpSrc = readFileSync(new URL('../../src/renderer/sftp.js', import.meta.url), 'utf8');

// Two macrotask hops; each lets the whole pending microtask queue drain first.
export function drain() {
    return new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));
}

export async function loadSftpVm() {
    const ctx = loadVm();

    // Recorded stubs sftp.js needs beyond the shared seam.
    const toasts = [];
    ctx.formatSize = (n) => `${n}B`;
    ctx.formatDate = () => 'D';
    ctx.showToast = (msg, isErr) => toasts.push({ msg: String(msg), isErr: !!isErr });

    // Static SFTP/transfer DOM ids the product code reaches.
    const mk = (id) => { const el = ctx.document.createElement('div'); el.id = id; ctx.document.body.appendChild(el); return el; };
    // INPUT elements the product code creates (breadcrumb path edit) call
    // setSelectionRange/select, which the seam's minimal elements lack.
    const origCreateElement = ctx.document.createElement;
    ctx.document.createElement = (tag) => {
        const el = origCreateElement.call(ctx.document, tag);
        if (String(tag || '').toLowerCase() === 'input') {
            el.setSelectionRange = () => {};
            el.select = () => {};
        }
        return el;
    };
    mk('sftp-conn');
    const breadcrumb = mk('sftp-breadcrumb');
    const body = mk('sftp-body');
    mk('sftp-pin-btn');
    const overlay = mk('overlay-sftp');
    const transferBtn = mk('transfer-btn');
    const count = ctx.document.createElement('span'); count.className = 'transfer-count'; transferBtn.appendChild(count);
    mk('transfer-panel');
    mk('transfer-window');
    mk('transfer-panel-body');
    mk('transfer-header-count');
    mk('transfer-header-actions');

    // The drag-and-drop IIFE resolves `#overlay-sftp .sftp-window` at load
    // time; the shared seam's querySelector only supports class-chain
    // selectors, so stage the window element and special-case that ONE
    // selector in this helper (the shared seam itself is untouched).
    const sftpWin = ctx.document.createElement('div');
    sftpWin.className = 'sftp-window';
    overlay.appendChild(sftpWin);
    const origQuerySelector = ctx.document.querySelector;
    ctx.document.querySelector = (sel) =>
        sel === '#overlay-sftp .sftp-window' ? sftpWin : origQuerySelector.call(ctx.document, sel);
    // Electron drop path: files carry a .path the shim maps through.
    ctx.webUtils = { getPathForFile: (f) => (f && f.path) || '' };

    // Controllable invoke bus: records every call, settles only on demand.
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, args) => new Promise((resolve, reject) => {
        calls.push({ cmd, args, resolve, reject, settled: false });
    });

    // Run the REAL sftp.js in the shared global lexical environment.
    vm.runInContext(sftpSrc, ctx, { filename: 'sftp.js' });
    const SFTP = vm.runInContext('SFTP', ctx);
    const TransferManager = vm.runInContext('TransferManager', ctx);

    // Synthetic SSH sessions in the real TabManager registry (labels only).
    ctx.TabManager.tabs.push({ id: 'tabA', tabId: 'sessA', name: 'Host A', type: 'ssh' });
    ctx.TabManager.tabs.push({ id: 'tabB', tabId: 'sessB', name: 'Host B', type: 'ssh' });
    ctx.TabManager.activeId = 'tabA';

    const pending = (cmd, filter) => calls.filter(c => c.cmd === cmd && !c.settled && (!filter || filter(c)));
    const settle = (call, value) => { call.settled = true; call.resolve(value); };
    const fail = (call, err) => { call.settled = true; call.reject(err instanceof Error ? err : new Error(String(err))); };
    const of = (cmd) => calls.filter(c => c.cmd === cmd);
    // Backend event through the REAL ipcRenderer.on handlers (ipc-polyfill shape).
    const emit = (ch, payload) => ctx.__emit(ch, payload);

    return {
        ctx, SFTP, TransferManager, toasts,
        els: { body, breadcrumb, overlay, sftpWin },
        calls, pending, settle, fail, of, emit, drain,
    };
}
