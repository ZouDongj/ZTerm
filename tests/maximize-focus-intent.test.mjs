// Regression: the maximize/restore button's delayed terminal refocus had no
// user-intent guard — a bare 200ms timer + rAF chain called
// _refocusActiveTerminal() unconditionally, so a user who opened search
// (Ctrl+F) or rename (F2) within the window had focus yanked back to the
// terminal and the next keystrokes went into the shell. Fix: the delay goes
// through _scheduleTerminalFocus (terminal.js) in passive mode with a
// fire-time owner resolver, so live form focus survives. The REAL main.js
// pieces (maximize handler, _refocusActiveTerminal, _activeTerminalTerm when
// present) are extracted and run in the shared renderer VM against the REAL
// terminal.js focus scheduler — pre-fix code fails test 2 behaviorally (the
// old handler steals the staged form focus).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab, armFocusWindow } from './helpers/renderer-vm.mjs';

const mainSrc = fs.readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8');

const refocusSrc = mainSrc.match(/function _refocusActiveTerminal\(\) \{[\s\S]*?\n\}/);
assert.ok(refocusSrc, '_refocusActiveTerminal source found in main.js');
const resolverSrc = mainSrc.match(/function _activeTerminalTerm\(\) \{[\s\S]*?\n\}/);
const maximizeSrc = mainSrc.match(/maximize: (\(\) => \{[\s\S]*?\n    \}),/);
assert.ok(maximizeSrc, 'maximize handler source found in main.js');

// A ctx with the REAL terminal.js scheduler plus the extracted main.js pieces.
function fixture() {
    const ctx = loadVm();
    vm.runInContext(refocusSrc[0], ctx);
    if (resolverSrc) vm.runInContext(resolverSrc[0], ctx);
    const maximize = vm.runInContext('(' + maximizeSrc[1] + ')', ctx);
    return { ctx, maximize };
}

test('maximize refocuses the active terminal when the user has no competing focus', () => {
    const { ctx, maximize } = fixture();
    const tab = wiredTab(ctx, 't_a', 'local_a', 'alpha line');
    ctx.TabManager.switchTo('t_a');
    ctx.__tq.advance(2000); // drain setup timers
    armFocusWindow(ctx);

    maximize();
    assert.ok(ctx.__sends.some(s => s.cmd === 'window-maximize'), 'the maximize command is sent');
    assert.equal(tab.term.focused, false, 'the refocus keeps its delay');

    ctx.__tq.advance(250);
    assert.equal(tab.term.focused, true, 'the active terminal is refocused after the delay');
});

test('maximize refocus yields to a form focus taken inside the window (RED old code: steals)', () => {
    const { ctx, maximize } = fixture();
    const tab = wiredTab(ctx, 't_a', 'local_a', 'alpha line');
    ctx.TabManager.switchTo('t_a');
    ctx.__tq.advance(2000);
    armFocusWindow(ctx);

    maximize();
    // Stage the user intent the real DOM would show: Ctrl+F/F2 moved focus
    // into a form field inside the 200ms window.
    const input = ctx.document.createElement('input');
    ctx.document.activeElement = input;

    ctx.__tq.advance(250);
    assert.equal(tab.term.focused, false, 'a live form focus must survive the delayed refocus');
    assert.equal(ctx.document.activeElement, input, 'the form field keeps focus');
});

test('maximize refocuses the focused pane of a split tab', () => {
    const { ctx, maximize } = fixture();
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't_sp', 'local_1', 'alpha line', 'local_2', 'bravo line');
    ctx.TabManager.switchTo('t_sp');
    ctx.__tq.advance(2000);
    p1.focused = false; p2.focused = true; // stage pane 2 as the focus owner
    armFocusWindow(ctx);
    p1.focused = false; p2.focused = true; // armFocusWindow only resets term flags and activeElement

    maximize();
    ctx.__tq.advance(250);
    assert.equal(p2.term.focused, true, 'the focused pane terminal is refocused');
    assert.equal(p1.term.focused, false, 'the unfocused pane is left alone');
});

test('(guard) maximize on the settings tab focuses nothing', () => {
    const { ctx, maximize } = fixture();
    ctx.TabManager.tabs.push({ id: 't_set', name: 'Settings', type: 'settings' });
    ctx.TabManager.activeId = 't_set';

    maximize();
    assert.doesNotThrow(() => ctx.__tq.advance(250));
    assert.equal(ctx.document.activeElement, ctx.document.body);
});
