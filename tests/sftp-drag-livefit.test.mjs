// SFTP dock width-drag live-fit (the drag's rAF path in sftp.js +
// _fitActiveTabSync/_fitTermSync/_flushTermRender in terminal.js).
// Previously every pointer move only rewrote --sftp-width with all fits
// suppressed, and one settle fit ran 320ms after release: fit() clears the
// canvas synchronously but repaints through the debouncer's rAF, so the
// release produced a full-grid jump plus a blank composited frame — the
// user-visible flash. These tests pin the new contract against the REAL
// renderer stack through the shared VM seam (environment faked only):
//   - every dragged frame fits the active tab's terminal(s) immediately
//   - a grid change is repainted in the SAME frame (debouncer flushed, its
//     pending rAF canceled); unchanged dimensions never flush
//   - observer-fit suppression is held for exactly the drag's duration
//   - pointerup lands a final same-frame fit AND still schedules the
//     authoritative settle pass
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSftpVm } from './helpers/sftp-vm.mjs';

// Fake terminal whose render debouncer records flush/cancel calls; the
// fitAddon stub shrinks the grid by one column per fit, mimicking a real
// fit against a narrowing wrap.
function stageTerm(vm, host) {
    const calls = { fits: 0, flushes: 0, cancels: [] };
    const term = {
        cols: 100, rows: 40,
        element: { parentElement: host },
        scrollToBottom() {},
        _core: {
            _renderService: {
                _renderDebouncer: {
                    _animationFrame: 7,
                    _coreBrowserService: { window: { cancelAnimationFrame: (id) => calls.cancels.push(id) } },
                    _innerRefresh() { calls.flushes++; },
                },
            },
        },
    };
    const fitAddon = { fit() { calls.fits++; term.cols -= 1; } };
    return { term, fitAddon, calls };
}

function stageActiveTab(vm, term, fitAddon) {
    const tab = vm.ctx.TabManager.tabs[0]; // tabA, active by default
    tab.term = term;
    tab.fitAddon = fitAddon;
    return tab;
}

// main-area with a recording style surface; the drag handler reads
// getBoundingClientRect (sized via _cw) and writes --sftp-width.
function stageMain(vm, width) {
    const main = vm.ctx.document.getElementById('main-area');
    main._cw = width;
    const writes = [];
    main.style = {
        setProperty: (k, v) => writes.push([k, v]),
        getPropertyValue: () => '',
    };
    return { main, writes };
}

const down = { preventDefault() {}, pointerId: 1, clientX: 700 };
const move = (x) => ({ pointerId: 1, clientX: x });
const up = { pointerId: 1 };

test('each dragged frame live-fits with a same-frame flush; release fits once more and still settles', async () => {
    const vm = await loadSftpVm();
    const { writes } = stageMain(vm, 1076);
    const host = vm.ctx.document.createElement('div');
    host._cw = 800; host._ch = 600;
    vm.ctx.document.getElementById('main-area').appendChild(host);
    const { term, fitAddon, calls } = stageTerm(vm, host);
    const tab = stageActiveTab(vm, term, fitAddon);
    const handle = vm.ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    assert.equal(vm.ctx._sftpAnimating, true, 'observer fits stay suppressed during the drag');
    handle.dispatch('pointermove', move(690));
    handle.dispatch('pointermove', move(680));
    handle.dispatch('pointermove', move(670));
    assert.equal(calls.fits, 3, 'every moved frame fits immediately (rAF is synchronous in this harness)');
    assert.equal(calls.flushes, 3, 'each grid change repaints in the same frame');
    assert.equal(calls.cancels.length >= 1, true, 'the pending debounced frame is canceled, not double-painted');
    assert.equal(term._core._renderService._renderDebouncer._animationFrame, undefined);
    assert.equal(writes.length, 3, 'the CSS var still tracks the pointer once per frame');

    const timerMark = vm.ctx.__tq.mark();
    handle.dispatch('pointerup', up);
    assert.equal(vm.ctx._sftpAnimating, false, 'suppression ends with the drag');
    assert.equal(calls.fits, 4, 'pointerup lands the final position in the same frame');
    assert.equal(vm.ctx.__tq.createdAfter(timerMark).length, 1, 'the 320ms settle pass is still scheduled');

    vm.ctx.__tq.advance(320);
    assert.equal(calls.fits, 5, 'the settle fit runs as the authoritative net');
    const resizeSend = vm.ctx.__sends.find(s => s.cmd === 'pty-resize');
    assert.ok(resizeSend, 'the settle still reports the final grid to the backend');
    assert.equal(resizeSend.payload.tabId, tab.tabId);
});

test('a fit that leaves the grid unchanged never flushes a repaint', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const host = vm.ctx.document.createElement('div');
    host._cw = 800; host._ch = 600;
    vm.ctx.document.getElementById('main-area').appendChild(host);
    const { term, calls } = stageTerm(vm, host);
    const fitAddon = { fit() { calls.fits++; /* dimensions unchanged */ } };
    stageActiveTab(vm, term, fitAddon);
    const handle = vm.ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    handle.dispatch('pointermove', move(690));
    handle.dispatch('pointerup', up);

    assert.equal(calls.fits, 2, 'move + release both fit');
    assert.equal(calls.flushes, 0, 'no grid change → no canvas clear → no flush');
    assert.equal(calls.cancels.length, 0);
});

test('keyboard resize live-fits immediately', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const host = vm.ctx.document.createElement('div');
    host._cw = 800; host._ch = 600;
    vm.ctx.document.getElementById('main-area').appendChild(host);
    const { term, fitAddon, calls } = stageTerm(vm, host);
    stageActiveTab(vm, term, fitAddon);
    const handle = vm.ctx.document.getElementById('sftp-resize');

    handle.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });

    assert.equal(calls.fits, 1, 'the arrow key fits in the same turn');
    assert.equal(calls.flushes, 1);
});

test('a dock animation scheduled mid-drag keeps ownership of the final settle', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const host = vm.ctx.document.createElement('div');
    host._cw = 800; host._ch = 600;
    vm.ctx.document.getElementById('main-area').appendChild(host);
    const { term, fitAddon, calls } = stageTerm(vm, host);
    stageActiveTab(vm, term, fitAddon);
    const handle = vm.ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    handle.dispatch('pointermove', move(690));
    vm.SFTP._dockAnimTimer = 999; // an open/close animation timer pending at release
    const timerMark = vm.ctx.__tq.mark();
    handle.dispatch('pointerup', up);

    assert.equal(vm.ctx._sftpAnimating, true, 'the drag does not lift the animation-owned suppression');
    assert.equal(calls.fits, 1, 'no extra release fit while the animation owns the width');
    assert.equal(vm.ctx.__tq.createdAfter(timerMark).length, 0, 'no duplicate settle is scheduled');
    vm.SFTP._dockAnimTimer = null;
});

test('a split tab live-fits every pane per dragged frame', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const ctx = vm.ctx;
    const tab = ctx.TabManager.tabs[0];
    const mkPane = (id) => {
        const host = ctx.document.createElement('div');
        host.id = 'pane-body_' + id;
        host._cw = 400; host._ch = 600;
        ctx.document.getElementById('main-area').appendChild(host);
        const staged = stageTerm(vm, host);
        return { id, name: id, type: 'ssh', term: staged.term, fitAddon: staged.fitAddon, calls: staged.calls };
    };
    const p1 = mkPane('p_1');
    const p2 = mkPane('p_2');
    tab.splitRoot = { orientation: 'h', children: [{ id: 'p_1' }, { id: 'p_2' }], ratios: [0.5, 0.5] };
    // Panes carry the terminals (split contract); the tab-level slots stay empty.
    delete tab.term; delete tab.fitAddon;
    ctx.getAllPanes(tab).find(p => p.id === 'p_1').term = p1.term;
    ctx.getAllPanes(tab).find(p => p.id === 'p_1').fitAddon = p1.fitAddon;
    ctx.getAllPanes(tab).find(p => p.id === 'p_2').term = p2.term;
    ctx.getAllPanes(tab).find(p => p.id === 'p_2').fitAddon = p2.fitAddon;
    const handle = ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    handle.dispatch('pointermove', move(690));
    handle.dispatch('pointerup', up);

    assert.equal(p1.calls.fits, 2, 'pane 1 fits on move + release');
    assert.equal(p2.calls.fits, 2, 'pane 2 fits on move + release');
    assert.equal(p1.calls.flushes, 2);
    assert.equal(p2.calls.flushes, 2);
});

test('a settings tab is never live-fitted', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const ctx = vm.ctx;
    const term = { cols: 80, rows: 24, element: null };
    ctx.TabManager.tabs.push({ id: 'tabSet', type: 'settings', term, fitAddon: { fit() { throw new Error('must not fit'); } } });
    ctx.TabManager.activeId = 'tabSet';
    const handle = ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    handle.dispatch('pointermove', move(690)); // must not throw
    handle.dispatch('pointerup', up);

    assert.equal(term.cols, 80);
});

test('pointercancel ends the drag like pointerup (flags cleared, settle scheduled)', async () => {
    const vm = await loadSftpVm();
    stageMain(vm, 1076);
    const host = vm.ctx.document.createElement('div');
    host._cw = 800; host._ch = 600;
    vm.ctx.document.getElementById('main-area').appendChild(host);
    const { term, fitAddon, calls } = stageTerm(vm, host);
    stageActiveTab(vm, term, fitAddon);
    const handle = vm.ctx.document.getElementById('sftp-resize');

    handle.dispatch('pointerdown', down);
    handle.dispatch('pointermove', move(690));
    const timerMark = vm.ctx.__tq.mark();
    handle.dispatch('pointercancel', up);

    assert.equal(vm.ctx._sftpAnimating, false);
    assert.equal(calls.fits, 2);
    assert.equal(vm.ctx.__tq.createdAfter(timerMark).length, 1, 'the settle pass survives a canceled pointer');
});
