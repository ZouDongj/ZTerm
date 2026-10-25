import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const rule = { text: 'ERROR', enabled: true, foreground: true, foregroundColor: '#e06c75', bold: true };
const { createHighlightStreamState, scanHighlightLine, MAX_HIGHLIGHT_CSI_PARAMS } = require('../src/renderer/highlight-utils.js');
const source = file => readFileSync(new URL('../src/renderer/' + file, import.meta.url), 'utf8');

function highlightVm() {
    const ctx = vm.createContext({ console });
    vm.runInContext(source('highlight-utils.js'), ctx);
    vm.runInContext(source('highlight.js'), ctx);
    vm.runInContext('_highlightRules = ' + JSON.stringify([rule]), ctx);
    return ctx;
}

async function parse(chunks, transform = value => value) {
    const term = new globalThis.TabbyXterm.Terminal({ allowProposedApi: true, cols: 120, rows: 4 });
    const names = [];
    const dcs = [];
    term.parser.registerOscHandler(1337, payload => { names.push(payload); return true; });
    term.parser.registerDcsHandler({ final: 'q' }, payload => { dcs.push(payload); return true; });
    try {
        const output = [];
        for (const chunk of chunks) {
            const transformed = transform(chunk);
            output.push(transformed);
            await new Promise(resolve => term.write(transformed, resolve));
        }
        const text = Array.from({ length: 4 }, (_, row) => term.buffer.active.getLine(row).translateToString(true));
        const cellsAt = row => Array.from({ length: 20 }, (_, col) => {
            const cell = term.buffer.active.getLine(row).getCell(col);
            return { text: cell.getChars(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), bold: cell.isBold() };
        });
        const currentRow = term.buffer.active.baseY + term.buffer.active.cursorY;
        return { names, dcs, text, cells: cellsAt(0), currentCells: cellsAt(currentRow), output };
    } finally { term.dispose(); }
}

test('split OSC tab-name payload reaches the bundled parser unchanged', async () => {
    const chunks = ['\x1b]1337;ZTermTabName=', 'ERROR-job\x07visible'];
    const control = await parse(chunks);
    const ctx = highlightVm();
    const highlighted = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'synthetic'));
    assert.deepEqual(highlighted.names, control.names);
    assert.deepEqual(highlighted.text, control.text);
    assert.deepEqual(control.names, ['ZTermTabName=ERROR-job']);
    assert.equal(control.text[0], 'visible');
});

const controlCases = [
    ['OSC with split ST', ['\x1b', ']1337;ZTermTabName=', 'ERROR', '\x1b', '\\visible']],
    ['OSC with BEL and newline', ['\x1b]1337;ZTermTabName=', 'ERROR\njob', '\x07visible']],
    ['DCS with split ST', ['\x1bP', 'qERROR', '\x1b', '\\visible']],
    ['DCS does not end on BEL', ['\x1bPq', '\x07ERROR', '\x1b\\visible']],
    ['SOS', ['\x1bX', 'ERROR', '\x1b\\visible']],
    ['PM', ['\x1b^', 'ERROR', '\x1b\\visible']],
    ['APC', ['\x1b_', 'ERROR', '\x1b\\visible']],
    ['C1 OSC and ST', ['\x9d1337;ZTermTabName=', 'ERROR', '\x9cvisible']],
    ['C1 DCS and ST', ['\x90q', 'ERROR', '\x9cvisible']],
    ['C1 SOS', ['\x98', 'ERROR', '\x9cvisible']],
    ['C1 PM', ['\x9e', 'ERROR', '\x9cvisible']],
    ['C1 APC', ['\x9f', 'ERROR', '\x9cvisible']],
    ['CSI final at keyword start', ['\x1b[2;', 'ERRORvisible']],
    ['C1 CSI final at keyword start', ['\x9b2;', 'ERRORvisible']],
    ['ESC intermediate', ['\x1b(', 'ERRORvisible']],
];

for (const [label, chunks] of controlCases) {
    test(`${label}: control payloads remain byte-for-byte unchanged`, async () => {
        const control = await parse(chunks);
        const ctx = highlightVm();
        const decorated = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'synthetic'));
        assert.deepEqual(decorated.output, chunks);
        assert.deepEqual({ ...decorated, output: null }, { ...control, output: null });
    });
}

test('every split point of an OSC payload has the same bundled-parser result', async () => {
    const sequence = '\x1b]1337;ZTermTabName=ERROR-job\x1b\\visible';
    const control = await parse([sequence]);
    for (let at = 1; at < sequence.length; at++) {
        const chunks = [sequence.slice(0, at), sequence.slice(at)];
        const ctx = highlightVm();
        const decorated = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'synthetic'));
        assert.deepEqual(decorated.names, control.names, `split at ${at}`);
        assert.deepEqual(decorated.text, control.text, `split at ${at}`);
        assert.equal(decorated.output.join(''), sequence, `split at ${at}`);
    }
});

for (const cancellation of ['\x18', '\x1a', '\x1b[32m']) {
    test(`cancelled string resumes decoration without changing parser output (${JSON.stringify(cancellation)})`, async () => {
        const chunks = ['\x1b]1337;ZTermTabName=', 'ERROR' + cancellation, 'ERROR visible'];
        const control = await parse(chunks);
        const ctx = highlightVm();
        const decorated = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'synthetic'));
        assert.equal(decorated.output[0], chunks[0]);
        assert.equal(decorated.output[1], chunks[1]);
        assert.match(decorated.output[2], /\x1b\[38;2;224;108;117m/);
        assert.deepEqual(decorated.names, control.names);
        assert.deepEqual(decorated.text, control.text);
        assert.deepEqual(decorated.cells.slice(5), control.cells.slice(5), 'text after the keyword keeps its rendition');
    });
}

test('split SGR parameters restore the exact carried color and weight', async () => {
    const chunks = ['\x1b[1;38;2;9', '7;175;', '239m', 'ERROR tail'];
    const control = await parse(chunks);
    const ctx = highlightVm();
    const decorated = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'synthetic'));
    assert.match(decorated.output[3], /ERROR\x1b\[1m\x1b\[38;2;97;175;239m/);
    assert.deepEqual(decorated.text, control.text);
    assert.deepEqual(decorated.cells.slice(5), control.cells.slice(5));
});

test('C1 SGR is carried into the keyword restore sequence', () => {
    const ctx = highlightVm();
    ctx.applyHighlight('\x9b3', 'one');
    ctx.applyHighlight('2m', 'one');
    assert.match(ctx.applyHighlight('ERROR tail', 'one'), /ERROR\x1b\[22m\x1b\[32m/);
});

test('disabled and no-rule chunks continue the control stream before re-enabling', () => {
    for (const disabled of ['_highlightSettings.highlightEnabled = false', '_highlightRules = []', '_highlightRules[0].enabled = false']) {
        const ctx = highlightVm();
        vm.runInContext(disabled, ctx);
        assert.equal(ctx.applyHighlight('\x1b]1337;ZTermTabName=', 'one'), '\x1b]1337;ZTermTabName=');
        vm.runInContext('_highlightSettings.highlightEnabled = true; _highlightRules = ' + JSON.stringify([rule]), ctx);
        assert.equal(ctx.applyHighlight('ERROR-job\x07', 'one'), 'ERROR-job\x07');
        assert.match(ctx.applyHighlight('ERROR visible', 'one'), /\x1b\[38;2/);
    }
});

test('alternate screen modes track split CSI and disabled decoration', () => {
    const ctx = highlightVm();
    vm.runInContext('_highlightSettings.highlightEnabled = false', ctx);
    ctx.applyHighlight('\x1b[?10', 'one');
    ctx.applyHighlight('49h', 'one');
    vm.runInContext('_highlightSettings.highlightEnabled = true', ctx);
    assert.equal(ctx.applyHighlight('ERROR TUI', 'one'), 'ERROR TUI');
    ctx.applyHighlight('\x9b?104', 'one');
    ctx.applyHighlight('9l', 'one');
    assert.match(ctx.applyHighlight('ERROR normal', 'one'), /\x1b\[38;2/);
});

test('session state is isolated and teardown clears an incomplete sequence', () => {
    const ctx = highlightVm();
    ctx.applyHighlight('\x1b]1337;ZTermTabName=', 'old');
    assert.match(ctx.applyHighlight('ERROR normal', 'new'), /\x1b\[38;2/);
    assert.equal(ctx.applyHighlight('ERROR payload', 'old'), 'ERROR payload');
    ctx.clearAlternateScreen('old');
    assert.match(ctx.applyHighlight('ERROR normal', 'old'), /\x1b\[38;2/);
});

test('zero-width regex matches cannot inject into an unfinished control sequence', () => {
    const ctx = highlightVm();
    vm.runInContext('_highlightRules = ' + JSON.stringify([{ ...rule, text: '(?=)|$', isRegExp: true }]), ctx);
    assert.equal(ctx.applyHighlight('\x1b]1337;', 'one'), '\x1b]1337;');
    assert.equal(ctx.applyHighlight('ERROR', 'one'), 'ERROR');
});

test('regex anchors still apply to the complete original line', () => {
    const ctx = highlightVm();
    vm.runInContext('_highlightRules = ' + JSON.stringify([{ ...rule, text: '^ERROR', isRegExp: true }]), ctx);
    assert.equal(ctx.applyHighlight('\x1b[32mERROR', 'one'), '\x1b[32mERROR');
    assert.match(ctx.applyHighlight('ERROR', 'one'), /\x1b\[38;2/);
});

test('control state memory is bounded and overlong SGR safely recovers at reset', () => {
    const state = createHighlightStreamState();
    scanHighlightLine('\x1b]1337;', state);
    for (let i = 0; i < 8; i++) scanHighlightLine('ERROR'.repeat(4096), state);
    assert.ok(JSON.stringify(state).length < 256, 'string payload is not retained');
    scanHighlightLine('\x07\x1b[', state);
    scanHighlightLine('1;'.repeat(8192), state);
    assert.equal(state.params.length, MAX_HIGHLIGHT_CSI_PARAMS);
    assert.equal(state.overflow, true);
    const ctx = highlightVm();
    const prefix = '\x1b[' + '1;'.repeat(8192);
    assert.equal(ctx.applyHighlight(prefix, 'one'), prefix);
    assert.equal(ctx.applyHighlight('mERROR', 'one'), 'mERROR');
    assert.match(ctx.applyHighlight('\x1b[0mERROR', 'one'), /\x1b\[38;2/);
});

test('SGR outside the tracked parameter limits stays transparent until reset', async () => {
    const parameters = [Array(32).fill('0').concat('31').join(';'), '38;2;999999999999999999999999;0;0'];
    for (const params of parameters) {
        const chunks = ['\x1b[' + params + 'm', 'ERROR tail'];
        const control = await parse(chunks);
        const ctx = highlightVm();
        const decorated = await parse(chunks, chunk => ctx.applyHighlight(chunk, 'one'));
        assert.deepEqual(decorated.text, control.text);
        assert.deepEqual(decorated.cells.slice(5), control.cells.slice(5));
        assert.equal(decorated.output[1], chunks[1]);
        assert.match(ctx.applyHighlight('\x1b[0mERROR', 'one'), /\x1b\[38;2/);
    }
});

function rendererHighlightVm() {
    const ctx = loadVm();
    for (const file of ['restore-content.js', 'highlight-utils.js', 'highlight.js']) vm.runInContext(source(file), ctx);
    vm.runInContext('_highlightRules = ' + JSON.stringify([rule]), ctx);
    return ctx;
}

function recordWrites(term) {
    const writes = [];
    const original = term.write.bind(term);
    term.write = (data, ...rest) => { writes.push(data); return original(data, ...rest); };
    return writes;
}

test('actual IPC highlighting follows one backend through split and extraction', () => {
    const ctx = rendererHighlightVm();
    const tab = wiredTab(ctx, 'source', 'local_stream');
    const writes = recordWrites(tab.term);
    ctx.__emit('pty-output', { tabId: 'local_stream', data: '\x1b]1337;ZTermTabName=' });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const original = ctx.getAllPanes(tab).find(pane => pane.tabId === 'local_stream');
    ctx.__emit('pty-output', { tabId: 'local_stream', data: 'ERROR-' });
    ctx.TabManager._extractPaneToTab(tab.id, original.id);
    ctx.__emit('pty-output', { tabId: 'local_stream', data: 'job\x07visible' });
    assert.deepEqual(writes, ['\x1b]1337;ZTermTabName=', 'ERROR-', 'job\x07visible']);
});

for (const split of [false, true]) {
    test(`actual IPC advances a ${split ? 'pane' : 'tab'} stream while its terminal is not mounted`, () => {
        const ctx = rendererHighlightVm();
        let tab, pane;
        if (split) {
            tab = wiredTab(ctx, 'source', 'local_existing');
            ctx.TabManager.addPaneRelativeTo(tab, 'b');
            pane = ctx.getAllPanes(tab).find(candidate => !candidate.term);
            pane.tabId = 'local_pending';
        } else {
            tab = { id: 'source', name: 'source', type: 'local', tabId: 'local_pending', term: null };
            ctx.TabManager.tabs.push(tab);
        }
        ctx.__emit('pty-output', { tabId: 'local_pending', data: '\x1b]1337;ZTermTabName=' });
        if (pane) ctx.wireTerminalToPane(tab, pane);
        else ctx.wireTerminal(tab, 'local_pending');
        const writes = recordWrites((pane || tab).term);
        ctx.__emit('pty-output', { tabId: 'local_pending', data: 'ERROR-job\x07visible' });
        assert.deepEqual(writes, ['ERROR-job\x07visible']);
    });
}

function bufferedStreamFixture(split) {
    const ctx = rendererHighlightVm();
    let tab, pane;
    if (split) {
        tab = wiredTab(ctx, 'source', 'local_existing');
        ctx.TabManager.addPaneRelativeTo(tab, 'b');
        pane = ctx.getAllPanes(tab).find(candidate => !candidate.term);
        pane.tabId = 'local_pending';
    } else {
        tab = { id: 'source', name: 'source', type: 'local', tabId: 'local_pending', term: null };
        ctx.TabManager.tabs.push(tab);
    }
    const writes = [];
    const BaseTerminal = ctx.Terminal;
    ctx.Terminal = class extends BaseTerminal {
        write(data, ...rest) { writes.push(data); return super.write(data, ...rest); }
    };
    return {
        ctx, writes,
        emit: data => ctx.__emit('pty-output', { tabId: 'local_pending', data }),
        mount() {
            if (pane) ctx.wireTerminalToPane(tab, pane);
            else ctx.wireTerminal(tab, 'local_pending');
        },
    };
}

for (const split of [false, true]) {
    const owner = split ? 'pane' : 'tab';
    test(`${owner} buffer truncation drops rendition that the new terminal will never receive`, async () => {
        const fixture = bufferedStreamFixture(split);
        fixture.emit('\x1b[32m' + 'x'.repeat(1048576) + '\r\n');
        const retained = fixture.ctx.ptyBuffers.local_pending;
        assert.equal(retained.length, 524288);
        assert.equal(retained.includes('\x1b[32m'), false);
        fixture.mount();
        assert.deepEqual(fixture.writes, [retained], 'mount replays the actual retained raw buffer');
        fixture.emit('ERROR tail');
        const control = await parse([retained, 'ERROR tail']);
        const decorated = await parse(fixture.writes);
        assert.equal(control.currentCells[6].fg, -1, 'the raw retained buffer starts with default color');
        assert.deepEqual(decorated.currentCells.slice(5, 10), control.currentCells.slice(5, 10));
    });

    test(`${owner} buffer truncation discards an OSC state when its prefix was dropped`, async () => {
        const fixture = bufferedStreamFixture(split);
        fixture.emit('\x1b]1337;ZTermTabName=' + 'x'.repeat(1048576) + '\r\n');
        const retained = fixture.ctx.ptyBuffers.local_pending;
        assert.equal(retained.length, 524288);
        assert.equal(retained.includes('\x1b]'), false);
        fixture.mount();
        fixture.emit('ERROR tail');
        assert.match(fixture.writes[1], /\x1b\[38;2/, 'the retained bytes are visible text, not an OSC continuation');
        const control = await parse([retained, 'ERROR tail']);
        const decorated = await parse(fixture.writes);
        assert.deepEqual(decorated.currentCells.slice(5, 10), control.currentCells.slice(5, 10));
        assert.deepEqual(decorated.names, control.names);
    });

    test(`${owner} buffer truncation rescans a retained OSC prefix rather than clearing state blindly`, async () => {
        const fixture = bufferedStreamFixture(split);
        fixture.emit('x'.repeat(1048576) + '\r\n\x1b]1337;ZTermTabName=');
        const retained = fixture.ctx.ptyBuffers.local_pending;
        assert.equal(retained.length, 524288);
        assert.equal(retained.endsWith('\x1b]1337;ZTermTabName='), true);
        fixture.mount();
        fixture.emit('ERROR-job\x07visible');
        assert.equal(fixture.writes[1], 'ERROR-job\x07visible');
        const control = await parse([retained, 'ERROR-job\x07visible']);
        const decorated = await parse(fixture.writes);
        assert.deepEqual(decorated.names, ['ZTermTabName=ERROR-job']);
        assert.deepEqual(decorated.currentCells, control.currentCells);
    });
}
