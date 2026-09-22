// Parser-only differential checks. These do not measure font ink, atlas pixels,
// GPU output, or the appearance of an actual terminal application.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const { installOn } = require('../src/renderer/unicode-width.js');
const { Terminal } = globalThis.TabbyXterm;

const COLS = 32;
const CUP_START = '\x1b[1;1H';
const CLEAR_TAIL = '\x1b[K';
const icons = [
    { name: 'moon', char: '\u{1F311}', width: 2 },
    { name: 'BMP Nerd folder', char: '\uF07B', width: 1 },
    { name: 'astral Nerd folder', char: '\u{F024B}', width: 1 },
];

function terminal(version = 'zterm6') {
    const term = new Terminal({ cols: COLS, rows: 3, allowProposedApi: true });
    assert.equal(installOn(term), true);
    term.unicode.activeVersion = version;
    return term;
}

async function write(term, chunks) {
    for (const chunk of chunks) await new Promise(resolve => term.write(chunk, resolve));
}

function snapshot(term) {
    const buffer = term.buffer.active;
    return {
        cursor: [buffer.cursorX, buffer.cursorY],
        rows: Array.from({ length: term.rows }, (_, y) => {
            const line = buffer.getLine(buffer.baseY + y);
            return Array.from({ length: COLS }, (_, x) => {
                const cell = line.getCell(x);
                return { chars: cell.getChars(), width: cell.getWidth() };
            });
        }),
    };
}

async function compare(cleanChunks, overwrittenChunks, label, version = 'zterm6') {
    const clean = terminal(version), overwritten = terminal(version);
    try {
        await write(clean, cleanChunks);
        await write(overwritten, overwrittenChunks);
        assert.deepEqual(snapshot(overwritten), snapshot(clean), label);
        return snapshot(clean);
    } finally {
        clean.dispose(); overwritten.dispose();
    }
}

test('explicit CUP overwrite and EL produce the clean buffer for moon and Nerd glyphs', async () => {
    for (const icon of icons) for (const spaces of [0, 1, 2]) {
        const text = 'A' + icon.char + ' '.repeat(spaces) + 'B';
        const result = await compare([text], [
            'A0123456789ABCDEFGHIJ', '\x1b[1;2H', icon.char,
            ' '.repeat(spaces) + 'B', CLEAR_TAIL,
        ], `${icon.name}, ${spaces} spaces`);
        assert.equal(result.rows[0][1].width, icon.width);
        assert.equal(result.rows[0][1 + icon.width + spaces].chars, 'B');
        assert.deepEqual(result.cursor, [2 + icon.width + spaces, 0]);
    }
});

test('separate absolute icon and text writes match clean output when all gaps are erased', async () => {
    for (const icon of icons) for (const spaces of [0, 1, 2]) {
        const text = 'A' + icon.char + ' '.repeat(spaces) + 'B';
        await compare([text], [
            'A0123456789ABCDEFGHIJ', '\x1b[1;2H', icon.char,
            `\x1b[1;${2 + icon.width}H`, ' '.repeat(spaces),
            `\x1b[1;${2 + icon.width + spaces}H`, 'B', CLEAR_TAIL,
        ], `${icon.name}, absolute writes, ${spaces} spaces`);
    }
});

test('wide-to-narrow and narrow-to-wide rewrites leave no stale continuation cells', async () => {
    const transitions = [
        [icons[0], icons[1]], [icons[1], icons[0]],
        [icons[0], icons[2]], [icons[2], icons[0]],
    ];
    for (const [before, after] of transitions) for (const spaces of [0, 1, 2]) {
        const final = 'A' + after.char + ' '.repeat(spaces) + 'B';
        await compare([final], [
            'A' + before.char + ' '.repeat(spaces) + 'B old tail',
            CUP_START, final, CLEAR_TAIL,
        ], `${before.name} to ${after.name}, ${spaces} spaces`);
    }
});

test('surrogate-pair chunk boundaries do not change overwrite semantics', async () => {
    for (const icon of [icons[0], icons[2]]) for (const spaces of [0, 1, 2]) {
        const text = 'A' + icon.char + ' '.repeat(spaces) + 'B';
        await compare([text], [
            'A0123456789ABCDEFGHIJ', CUP_START, 'A',
            icon.char[0], icon.char[1], ' '.repeat(spaces), 'B', CLEAR_TAIL,
        ], `${icon.name}, split surrogate, ${spaces} spaces`);
    }
});

test('changing provider affects later writes, not existing cells; explicit repaint matches clean state', async () => {
    for (const [from, to, beforeWidth] of [['6', 'zterm6', 1], ['zterm6', '6', 2]]) {
        const changing = terminal(from), clean = terminal(to);
        try {
            const text = 'A' + icons[0].char + 'B';
            await write(changing, [text]);
            changing.unicode.activeVersion = to;
            assert.equal(changing.buffer.active.getLine(0).getCell(1).getWidth(), beforeWidth,
                'a provider switch does not retroactively reflow buffered content');
            await write(changing, [CUP_START, text, CLEAR_TAIL]);
            await write(clean, [text]);
            assert.deepEqual(snapshot(changing), snapshot(clean), `${from} to ${to}`);
        } finally {
            changing.dispose(); clean.dispose();
        }
    }
});

test('CUP without erasing a skipped cell preserves it by design', async () => {
    for (const icon of icons) {
        const term = terminal();
        try {
            await write(term, ['A0123456789', '\x1b[1;2H', icon.char,
                `\x1b[1;${3 + icon.width}H`, 'B', CLEAR_TAIL]);
            const line = term.buffer.active.getLine(0);
            assert.equal(line.getCell(1 + icon.width).getChars(), String(icon.width),
                'the skipped old cell was never written or erased');
            assert.equal(line.getCell(2 + icon.width).getChars(), 'B');
        } finally {
            term.dispose();
        }
    }
});
