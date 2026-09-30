// input-2: SFTP.open() never moved the keyboard focus, so a panel opened via
// Ctrl+Shift+F (or the menu) showed a modal overlay while every keystroke —
// including Enter — kept flowing into the xterm textarea BEHIND it (the
// global dispatcher's input guard exempts xterm-helper-textarea). Every other
// keyboard-openable overlay takes focus on open (openQC / openPalette /
// openSSHManager / openSearch); the fix gives the SFTP window container the
// focus on the same 50ms-delay convention (tabindex=-1 dialog target, no
// default Enter action).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

test('SFTP.open takes the keyboard focus off the terminal behind the panel', async () => {
    const vm = await loadSftpVm();
    // Stage a focused terminal behind the panel (the exact leak scenario).
    const termEl = vm.ctx.document.createElement('div');
    vm.ctx.document.body.appendChild(termEl);
    termEl.focus();
    assert.equal(vm.ctx.document.activeElement, termEl, 'staging: terminal focused before open');

    const p = vm.SFTP.open('sessA');
    await vm.drain();
    vm.ctx.__tq.advance(50); // the focus timer (same delay convention as openQC)

    assert.equal(vm.ctx.document.activeElement, vm.els.sftpWin,
        'the panel window now owns the keyboard focus');
    assert.equal(vm.els.sftpWin.getAttribute('tabindex'), '-1',
        'focus target is the neutral dialog container, not an actionable control');
    void p; // the sftp-open invoke stays pending; the focus path already ran
});

test('the focus hand-off is skipped when the panel closed/rebound inside the delay', async () => {
    const vm = await loadSftpVm();
    const p = vm.SFTP.open('sessA');
    vm.SFTP.close(); // user closes the panel inside the 50ms window
    await vm.drain();
    vm.ctx.__tq.advance(50);
    assert.notEqual(vm.ctx.document.activeElement, vm.els.sftpWin,
        'a closed panel does not steal the focus at fire time');
    void p;
});
