// A reference comparison, not a claim that all Unicode11 differences are bugs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const current = require('../src/renderer/unicode-width.js');
const fixtureSource = readFileSync(new URL('../scripts/fixtures/tabby-unicode11.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(fixtureSource, context, { filename: 'tabby-unicode11.js' });
const { Unicode11Addon } = context.__tabbyUnicode11;
const requireExactParity = process.env.ZTERM_ASSERT_EXACT_TABBY_PARITY === '1';
let reference;
new Unicode11Addon().activate({ unicode: { register(provider) { reference = provider; } } });

const expectedDifferences = {
    bmp: { '1->0': 438, '0->1': 1, '2->1': 162, '0->2': 2 },
    astral: { '1->0': 537, '1->2': 7674, '2->1': 405 },
};

test('the VM reference is the pinned actual Tabby UMD and exports a Unicode11 addon', () => {
    const normalized = fixtureSource.replace(/\r\n/g, '\n');
    const body = normalized.split('    // BEGIN EXTRACTED TABBY UNICODE11\n')[1]
        .split('\n    // END EXTRACTED TABBY UNICODE11')[0];
    assert.equal(createHash('sha256').update(body).digest('hex'),
        '7c63300470f07c9f9cb35c76725529114fc3fe150825dd11973c151c5b403cd2');
    assert.equal(reference.version, '11');
    assert.equal(reference.wcwidth(0x26A1), 2);
    assert.equal(reference.wcwidth(0xF024B), 1);
    assert.equal(reference.charProperties(0x0301, reference.charProperties(0x41, 0)), 3);
});

test('full Unicode comparison records retained differences; exact parity is an opt-in red gate', t => {
    const differences = { bmp: {}, astral: {} };
    let total = 0;
    for (let cp = 0; cp <= 0x10FFFF; cp++) {
        const before = current.wcwidth(cp), after = reference.wcwidth(cp);
        if (before === after) continue;
        total += 1;
        const group = cp < 0x10000 ? differences.bmp : differences.astral;
        const key = `${before}->${after}`;
        group[key] = (group[key] || 0) + 1;
    }
    t.diagnostic(JSON.stringify({ current: current.VERSION, reference: reference.version,
        codepointsCompared: 0x110000, widthDifferences: total, differences }));
    if (requireExactParity) {
        assert.equal(total, 0, 'production intentionally retains semantics beyond the exact Tabby Unicode11 reference');
    } else {
        assert.deepEqual(differences, expectedDifferences);
        assert.equal(total, 9219);
    }
});

function makeTerminal(useReference) {
    const terminal = new globalThis.TabbyXterm.Terminal({ cols: 32, rows: 6, allowProposedApi: true });
    if (useReference) {
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = '11';
    } else {
        current.installOn(terminal);
    }
    return terminal;
}

function snapshot(terminal) {
    const buffer = terminal.buffer.active;
    return {
        cursor: [buffer.cursorX, buffer.cursorY],
        cells: Array.from({ length: terminal.rows }, (_, row) => {
            const line = buffer.getLine(buffer.baseY + row);
            return Array.from({ length: terminal.cols }, (_, col) => {
                const cell = line.getCell(col);
                return [cell.getChars(), cell.getWidth()];
            });
        }),
    };
}

async function parse(chunks, useReference) {
    const terminal = makeTerminal(useReference);
    try {
        for (const chunk of chunks) await new Promise(resolve => terminal.write(chunk, resolve));
        return snapshot(terminal);
    } finally { terminal.dispose(); }
}

test('the same bundled parser compares symbols, PUA spacing, selectors, combining and dynamic tables', async t => {
    const cases = [];
    for (const cp of [0xF024B, 0xF07B, 0xF120, 0xE0B0, 0x23FA, 0x2726, 0x26A1, 0x1F311]) {
        for (const spaces of [0, 1]) cases.push({ name: `U+${cp.toString(16).toUpperCase()} spaces=${spaces}`,
            chunks: ['A' + String.fromCodePoint(cp) + ' '.repeat(spaces) + 'B'], equal: true });
    }
    cases.push(
        { name: 'variation selector after lightning', chunks: ['A\u26A1\uFE0FB'], equal: true },
        { name: 'variation selector after text heart', chunks: ['A\u2764\uFE0FB'], equal: true },
        { name: 'existing combining acute', chunks: ['A\u0301B'], equal: true },
        { name: 'newer combining U+1AB0', chunks: ['A\u1AB0B'], equal: false },
        { name: 'newer emoji U+1FAE0', chunks: ['A\u{1FAE0}B'], equal: false },
        { name: 'astral PUA split surrogate', chunks: ['A\uDB80', '\uDE4BB'], equal: true },
        { name: 'ASCII and CJK table', chunks: ['┌──────┐\r\n│ AB中 │\r\n└──────┘'], equal: true },
        { name: 'symbol table with absolute placement', chunks: ['┌────┐\r\n│    │\r\n└────┘', '\x1b[2;2H\u26A1', '\x1b[2;5H│'], equal: true },
        { name: 'CUP moon overwrite', chunks: ['Apq stale tail', '\x1b[1;2H\u{1F311}', '\x1b[1;4HB\x1b[K'], equal: true },
        { name: 'CUP lightning overwrite', chunks: ['Apq stale tail', '\x1b[1;2H\u26A1', '\x1b[1;4HB\x1b[K'], equal: true },
        { name: 'CUP PUA overwrite with erased gap', chunks: ['Apq stale tail', '\x1b[1;2H\u{F024B} ', '\x1b[1;4HB\x1b[K'], equal: true },
        { name: 'CUP deliberately un-erased gap', chunks: ['Apq stale tail', '\x1b[1;2H\u{F024B}', '\x1b[1;4HB\x1b[K'], equal: true },
    );
    let matching = 0;
    const differing = [];
    for (const scenario of cases) {
        const a = await parse(scenario.chunks, false), b = await parse(scenario.chunks, true);
        if (scenario.equal || requireExactParity) {
            assert.deepEqual(a, b, scenario.name);
            matching += 1;
        } else {
            assert.notDeepEqual(a, b, scenario.name);
            differing.push({ name: scenario.name, currentCursor: a.cursor, tabbyCursor: b.cursor,
                currentCells: a.cells[0].slice(0, 5), tabbyCells: b.cells[0].slice(0, 5) });
        }
    }
    t.diagnostic(JSON.stringify({ parserCases: cases.length, matching, differing }));
});
