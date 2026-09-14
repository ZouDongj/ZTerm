// Regression guard for conpty-caret.js, ported from the v4 prototype selftest.
// The filter sits on the live PTY stream: every case here maps to a bug that
// once froze or corrupted the whole terminal. Run via `npm run test:frontend`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

const here = dirname(fileURLToPath(import.meta.url));
const bytes = arr => new Uint8Array(arr);
const enc = s => new TextEncoder().encode(s);
const asText = out => (typeof out === 'string' ? out : new TextDecoder().decode(out));

const HERDR_FRAME =
    '\u001b[?2026h\u001b[?25l\u001b[30;70H\u001b[0;39;49ma\u001b[0;7;39;49m \u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';

test('off mode is bit-exact and type-preserving', () => {
    const f = createConPtyCaretFilter({ mode: 'off' });
    const input = bytes([27, 91, 49, 116]);
    assert.equal(f.push(input), input, 'must return the very same Uint8Array object');
    assert.equal(f.push('hello'), 'hello');
});

test('no mode ever emits comma-joined byte values', () => {
    // The PTY path feeds Uint8Array; a String() coercion prints the whole
    // stream as "27,91,49,...". This once broke every keystroke.
    for (const mode of ['off', 'repair', 'fix']) {
        const out = asText(createConPtyCaretFilter({ mode }).push(enc(HERDR_FRAME)));
        assert.ok(!/\d+,\d+,\d+/.test(out), `${mode}: ${out.slice(0, 80)}`);
    }
});

test('Uint8Array input and string input agree (non-off)', () => {
    for (const mode of ['repair', 'fix']) {
        const fromBytes = createConPtyCaretFilter({ mode }).push(enc(HERDR_FRAME));
        const fromString = createConPtyCaretFilter({ mode }).push(HERDR_FRAME);
        assert.equal(fromBytes, fromString, mode);
    }
});

test('chunked feeding equals one big write, multi-byte text survives', () => {
    const sample = enc(
        '\u001b[?2026h\u001b[?25l\u001b[30;70H\u001b[0;39;49m\u4f60\u597d\u001b[0;7;39;49m \u001b[0m\u001b[30;72H\u001b[?25l\u001b[?2026l'
    );
    const whole = createConPtyCaretFilter({ mode: 'fix' }).push(sample);
    const f = createConPtyCaretFilter({ mode: 'fix' });
    let chunked = '';
    for (let i = 0; i < sample.length; i += 3) chunked += f.push(sample.slice(i, i + 3));
    assert.equal(chunked, whole);
    assert.ok(chunked.includes('\u4f60\u597d'));
});

test('captured herdr stream: painted caret removed, ?25h re-asserted at every chunk size', () => {
    const lines = readFileSync(join(here, 'fixtures', 'herdr-local.jsonl'), 'utf8')
        .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const firstKey = lines.findIndex(l => l.kind === 'key');
    const waves = lines.slice(firstKey).filter(l => !l.kind || l.kind === 'read');
    const fix = createConPtyCaretFilter({ mode: 'fix' });
    let out = '';
    for (const w of waves) out += fix.push(enc(w.s));
    assert.ok(!out.includes('\u001b[0;7;39;49m'), 'ConPTY painted caret SGR must be removed');
    assert.ok(out.includes('\u001b[?25h'), '?25h must be re-asserted');

    const stream = enc(waves.map(w => w.s).join(''));
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
        const f = createConPtyCaretFilter({ mode: 'fix' });
        let acc = '';
        for (let i = 0; i < stream.length; i += size) acc += f.push(stream.slice(i, i + size));
        assert.equal(acc, out, `chunk size ${size}`);
    }
});

test('liveness: nothing wedges the filter (DECSCUSR once froze the terminal)', () => {
    const poison = [
        ['DECSCUSR cursor shape', '\u001b[0 q'],
        ['DECSCUSR blinking block', '\u001b[1 q'],
        ['CSI with intermediates', '\u001b[1 p'],
        ['lone ESC', '\u001b'],
        ['ESC then text', '\u001bhello'],
        ['truncated CSI', '\u001b[38;2;'],
        ['control byte in CSI', '\u001b[0\rq'],
    ];
    for (const mode of ['off', 'repair', 'fix']) {
        for (const [name, chunk] of poison) {
            const f = createConPtyCaretFilter({ mode });
            f.push(chunk);
            const tail = asText(f.push('TAIL-MARKER'));
            assert.ok(tail.includes('TAIL-MARKER'), `${mode}: wedged after ${name}`);
        }
    }
});

test('real detach stream passes through intact (alt-screen exit never freezes)', () => {
    const lines = readFileSync(join(here, 'fixtures', 'herdr-detach.jsonl'), 'utf8')
        .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const reads = lines.filter(l => !l.kind || l.kind === 'read');
    const bytesAll = enc(reads.map(l => l.s).join(''));
    const filter = createConPtyCaretFilter({ mode: 'fix' });
    let out = '';
    for (let i = 0; i < bytesAll.length; i += 17) out += filter.push(bytesAll.slice(i, i + 17));
    assert.ok(out.includes('\u001b[?1049l'), 'leaves alt screen');
    assert.ok(out.includes('\u001b[?25h'), 'restores caret');
    assert.ok(out.includes('\u001b[0 q'), 'DECSCUSR survives intact');
    // fix mode intentionally swallows TRANSIENT ?25l inside repaired frames
    // (anti-churn); nothing else may shrink the stream. Compare in string
    // units — byte length differs on multi-byte content.
    const inStr = reads.map(l => l.s).join('');
    const hidesIn = (inStr.match(/\x1b\[\?25l/g) || []).length;
    assert.ok(out.length >= inStr.length - 6 * hidesIn,
        `nothing swallowed beyond transient hides (out=${out.length}, in=${inStr.length}, hides=${hidesIn})`);
});

test('dsh-tui capture: hide churn eliminated, caret continuously visible (real bytes)', () => {
    // Real pre-filter capture of typing 5 keys into dsh-tui inside herdr
    // (local PTY). The TUI redraws in ~10 sync blocks per keystroke and only
    // ever hides the caret (?25h count 0 in the raw stream — ConPTY rewrote
    // every app show to hide). Old filter behavior: 96 hide/show flickers ->
    // animation cancelled on every key = the reported "choppy caret".
    const s = readFileSync(join(here, 'fixtures', 'dshtui-input.txt'), 'latin1');
    const count = (re, t) => (t.match(re) || []).length;
    const blocks = count(/\x1b\[\?2026h/g, s);
    assert.ok(blocks > 0, 'fixture has sync blocks');

    for (const size of [1, 3, 17, 64, 1 << 20]) {
        const f = createConPtyCaretFilter({ mode: 'fix' });
        let out = '';
        for (let i = 0; i < s.length; i += size) out += f.push(s.slice(i, i + size));
        assert.equal(count(/\x1b\[\?25l/g, out), 0, `size ${size}: no transient hides forwarded`);
        assert.equal(count(/\x1b\[\?25h/g, out), blocks, `size ${size}: one SHOW per repaired frame`);
        assert.ok(out.includes('\u001b[52;'), `size ${size}: caret park position preserved`);
    }
    // off mode stays bit-exact on the same fixture
    const fo = createConPtyCaretFilter({ mode: 'off' });
    assert.equal(fo.push(s), s, 'off mode bit-exact');
    // repair mode still forwards hides (minimal semantics; only fix anti-churns)
    const fr = createConPtyCaretFilter({ mode: 'repair' });
    let outr = '';
    for (let i = 0; i < s.length; i += 64) outr += fr.push(s.slice(i, i + 64));
    assert.equal(count(/\x1b\[\?25l/g, outr), count(/\x1b\[\?25l/g, s), 'repair forwards hides');
});

test('host_cursor=native stream is enhanced, not corrupted', () => {
    // Native mode already ends sync blocks with CUP + ?25h; the filter must
    // stay additive (extra SHOW after each block, no reverse grids created).
    const nativeFrame = '\u001b[?2026h\u001b[?25l\u001b[30;33H\u001b[0;39;49m\u001b[0m\u001b[30;34H\u001b[?25h\u001b[?2026l';
    const f = createConPtyCaretFilter({ mode: 'fix' });
    const out = f.push(nativeFrame);
    assert.ok(out.includes('\u001b[?25h'));
    assert.ok(!out.includes('\u001b[0;7;39;49m'));
    assert.ok(out.includes('\u001b[30;34H'), 'cursor position preserved');
});
