// Dock-era focus contract (the panel is a non-modal side dock, no overlay):
// opening the SFTP dock must NOT move the keyboard focus — the terminal keeps
// it so typing and shortcuts keep flowing while the file panel is open (the
// old modal panel grabbed focus 50ms after open; that grab is gone). Closing
// the dock still hands focus back to the active tab's terminal (unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

test('SFTP.open leaves the terminal keyboard focus untouched', async () => {
    const vm = await loadSftpVm();
    // Stage a focused terminal behind the dock (the old steal scenario).
    const termEl = vm.ctx.document.createElement('div');
    vm.ctx.document.body.appendChild(termEl);
    termEl.focus();
    assert.equal(vm.ctx.document.activeElement, termEl, 'staging: terminal focused before open');

    const p = vm.SFTP.open('sessA');
    await vm.drain();
    // Long past the old 50ms focus-grab window: no timer may move focus now.
    vm.ctx.__tq.advance(300);

    assert.equal(vm.ctx.document.activeElement, termEl,
        'the terminal keeps the keyboard focus while the dock is open');
    assert.equal(vm.els.sftpWin.getAttribute('tabindex'), null,
        'the dock window never becomes a focus target');
    void p; // the sftp-open invoke stays pending; the focus path already ran
});

test('SFTP.open does not schedule any focus-stealing timer', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    await vm.drain();
    // Direct observable: firing every pending open-time timer moves nothing.
    vm.ctx.__tq.advance(400);
    assert.equal(vm.ctx.document.activeElement, vm.ctx.document.body,
        'firing all open-time timers leaves the focus where it was (body)');
    void p;
});

test('SFTP.close still refocuses the active tab terminal', async () => {
    const vm = await loadSftpVm();
    const tab = vm.ctx.TabManager.tabs.find(t => t.tabId === 'sessA');
    let focused = 0;
    tab.term = { focus() { focused++; } };
    vm.SFTP.open('sessA');
    await vm.drain();
    vm.SFTP.close();
    vm.ctx.__tq.advance(50);
    assert.equal(focused, 1, 'close hands the keyboard back to the terminal');
});
