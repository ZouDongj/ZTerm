// Issue #28: a right-click paste used to reach the backend without scrolling
// the viewport to the bottom — keyboard input scrolls (xterm's
// scrollOnUserInput), the hand-rolled paste path bypassed xterm entirely.
// The fix routes the delivery through term.paste(): xterm fires onData as
// user input (scroll-on-input, bracketed-paste wrapping when mode 2004 is
// on) and the existing onData handler forwards it through the same
// event-time owner resolution as keystrokes.
//
// These tests pin (a) the delivery goes through term.paste and reaches the
// backend, and (b) the pre-delivery guards survive the reroute: a backend
// swap during the clipboard read and a known-failed session both still drop
// the paste.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const flushAsync = () => new Promise(r => setTimeout(r, 0));

const ptyInputs = (ctx) => ctx.__sends.filter(s => s.cmd === 'pty-input');

test('right-click paste delivers through term.paste into the backend', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_p', 'local_p');
    ctx.TabManager.switchTo(tab.id);
    const term = tab.term;
    ctx.require('electron').clipboard.text = 'echo pasted';

    ctx._pasteFromClipboardInto(term);
    await flushAsync();

    assert.deepEqual(term._pastes, ['echo pasted'],
        'delivery goes through xterm paste (scroll-on-input + bracketed wrapping live there)');
    const inputs = ptyInputs(ctx);
    assert.equal(inputs.length, 1, 'exactly one backend write');
    assert.equal(inputs[0].payload.tabId, 'local_p');
    assert.equal(inputs[0].payload.data, 'echo pasted');
});

test('(guard) a backend swap during the clipboard read still drops the paste', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_s', 'local_old');
    ctx.TabManager.switchTo(tab.id);
    const term = tab.term;

    // Clipboard read that the test resolves manually, so the backend id can
    // change while the read is in flight (reconnect swapped the session).
    let release;
    const clip = ctx.require('electron').clipboard;
    clip.readTextAsync = () => new Promise(r => { release = r; });

    ctx._pasteFromClipboardInto(term);
    await flushAsync();
    tab.tabId = 'local_new';
    release('echo stale');
    await flushAsync();

    assert.equal(term._pastes, undefined, 'no paste call');
    assert.equal(ptyInputs(ctx).length, 0, 'nothing reaches the new backend');
});

test('(guard) a session known to have failed still cancels the paste', async () => {
    const ctx = loadVm();
    const tab = wiredTab(ctx, 't_f', 'local_dead');
    ctx.TabManager.switchTo(tab.id);
    const term = tab.term;
    ctx.require('electron').clipboard.text = 'echo dropped';
    tab._sessionFailed = true;

    ctx._pasteFromClipboardInto(term);
    await flushAsync();

    assert.equal(term._pastes, undefined, 'no paste call');
    assert.equal(ptyInputs(ctx).length, 0, 'nothing is delivered');
});
