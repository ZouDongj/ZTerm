// Actual bundled parser regressions for the narrow BMP width correction.
// No DOM, font, WebGL, PTY or external application is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const { installOn } = require('../src/renderer/unicode-width.js');

function terminal(cols = 16) {
    const term = new globalThis.TabbyXterm.Terminal({ cols, rows: 3, allowProposedApi: true });
    installOn(term);
    return term;
}

const write = (term, data) => new Promise(resolve => term.write(data, resolve));

test('Unicode11 BMP symbols reserve a continuation cell before adjacent text', async () => {
    for (const char of ['\u26A1', '\u2728', '\u231A', '\uA960']) {
        const term = terminal();
        try {
            await write(term, 'A' + char + 'B');
            const line = term.buffer.active.getLine(0);
            assert.equal(line.getCell(1).getWidth(), 2, `U+${char.codePointAt(0).toString(16)}`);
            assert.equal(line.getCell(2).getWidth(), 0);
            assert.equal(line.getCell(3).getChars(), 'B');
            assert.equal(term.buffer.active.cursorX, 4);
        } finally { term.dispose(); }
    }
});

test('absolute CUP writes replace both old cells occupied by a lightning symbol', async () => {
    const term = terminal();
    try {
        await write(term, 'Apq old tail');
        await write(term, '\x1b[1;2H\u26A1\x1b[1;4HB\x1b[K');
        const line = term.buffer.active.getLine(0);
        assert.equal(line.getCell(1).getChars(), '\u26A1');
        assert.equal(line.getCell(2).getWidth(), 0, 'the old q must become the wide continuation cell');
        assert.equal(line.getCell(2).getChars(), '');
        assert.equal(line.getCell(3).getChars(), 'B');
        assert.equal(term.buffer.active.cursorX, 4);
    } finally { term.dispose(); }
});

test('a BMP wide symbol wraps before the last column instead of splitting its cell pair', async () => {
    const term = terminal(3);
    try {
        await write(term, 'AA\u26A1B');
        const next = term.buffer.active.getLine(1);
        assert.equal(next.getCell(0).getChars(), '\u26A1');
        assert.equal(next.getCell(0).getWidth(), 2);
        assert.equal(next.getCell(1).getWidth(), 0);
        assert.equal(next.getCell(2).getChars(), 'B');
        assert.equal(term.buffer.active.cursorY, 1);
    } finally { term.dispose(); }
});

test('PUA remains one cell while moon, newer emoji and CJK retain two cells', async () => {
    for (const [char, width] of [['\uF07B', 1], ['\u{F024B}', 1], ['\uE0B0', 1],
        ['\u23FA', 1], ['\u2726', 1], ['\u{1F311}', 2], ['\u{1FAE0}', 2], ['中', 2], ['X', 1]]) {
        const term = terminal();
        try {
            await write(term, 'A' + char + 'B');
            const line = term.buffer.active.getLine(0);
            assert.equal(line.getCell(1).getWidth(), width);
            assert.equal(line.getCell(1 + width).getChars(), 'B');
            assert.equal(term.buffer.active.cursorX, 2 + width);
        } finally { term.dispose(); }
    }
});
