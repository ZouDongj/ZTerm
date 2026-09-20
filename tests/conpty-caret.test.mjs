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

test('dsh-tui-era capture without painted evidence passes through untouched (real bytes)', () => {
    // 2026-09 capture of typing 5 keys into dsh-tui inside herdr: 12 sync
    // blocks, 24 in-block hides, ZERO painted-caret cells. The pre-gate
    // filter manufactured one SHOW per block anyway (visibleBefore self-
    // sustained) and parked a protocol caret at each frame's final CUP —
    // correct-looking only while the park happened to be the input box.
    // Current herdr (verified 2026-09-18 sandbox, 0.9.0) hides its console
    // cursor and draws pane carets as content, so a manufactured SHOW is a
    // phantom caret (the far-right blinking one in kimi working frames).
    const s = readFileSync(join(here, 'fixtures', 'dshtui-input.txt'), 'latin1');
    const count = (re, t) => (t.match(re) || []).length;
    const blocks = count(/\x1b\[\?2026h/g, s);
    assert.ok(blocks > 0, 'fixture has sync blocks');

    for (const size of [1, 3, 17, 64, 1 << 20]) {
        const f = createConPtyCaretFilter({ mode: 'fix' });
        let out = '';
        for (let i = 0; i < s.length; i += size) out += f.push(s.slice(i, i + size));
        assert.equal(count(/\x1b\[\?25h/g, out), 0, `size ${size}: no SHOW manufactured without painted evidence`);
        assert.equal(count(/\x1b\[\?25l/g, out), count(/\x1b\[\?25l/g, s), `size ${size}: genuine hides forwarded`);
        assert.equal(out, s, `size ${size}: stream passes through bit-exact`);
        assert.equal(f.state().visible, false, `size ${size}: caret state stays hidden`);
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

// Distilled from the real 2026-09-18 kimi-working capture (sandbox ztprobe;
// field-observed, raw capture not checked in): spinner frame idiom — sync
// block, OSC8-end, styled braille, park CUP, two in-block hides, no painted
// caret. Byte-pattern verified equivalent to the live stream (0 shows /
// 94 hides all in-block / 0 painted in 48KB).
const HERDR_KIMI_FRAME =
    '\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\\u001b[24;28H\u001b[0;38;2;136;136;136;49m⠴\u001b[0m\u001b[27;32H\u001b[?25l\u001b[?2026l';

test('genuine-hide herdr working frames: no phantom SHOW at the frame park', () => {
    const count = (re, t) => (t.match(re) || []).length;
    const input = HERDR_KIMI_FRAME.repeat(8);
    for (const size of [1, 3, 17, 64, 1 << 20]) {
        const f = createConPtyCaretFilter({ mode: 'fix' });
        let out = '';
        for (let i = 0; i < input.length; i += size) out += f.push(input.slice(i, i + size));
        assert.equal(count(/\x1b\[\?25h/g, out), 0, `size ${size}: no SHOW manufactured`);
        assert.equal(count(/\x1b\[\?25l/g, out), count(/\x1b\[\?25l/g, input), `size ${size}: genuine hides preserved`);
        assert.equal(out, input, `size ${size}: bit-exact`);
        assert.equal(f.state().visible, false, `size ${size}: hidden`);
    }
});

test('painted-caret evidence still triggers the visibility repair', () => {
    // Conhost draws the console caret into the frame as SGR 0;7;39;49 only
    // when the console cursor is visible — that is the positive evidence the
    // in-block hides are ConPTY's rewrite of an app-intended show.
    const f = createConPtyCaretFilter({ mode: 'fix' });
    const out = f.push(HERDR_FRAME);
    assert.ok(!out.includes('\u001b[0;7;39;49m'), 'painted cell de-reversed');
    assert.ok(!out.includes('\u001b[?25l'), 'rewritten hides stripped');
    assert.ok(out.includes('\u001b[?25h'), 'SHOW re-asserted on painted evidence');
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

// ── ConPTY DA1 handshake ──
// OpenConsole opens every pseudoconsole with a DA1 probe (ESC[c) and blocks
// the client shell's output until a VT220-class reply arrives (~3.3s stall
// measured when unsatisfied, conpty_probe A/B 2026-09-17). xterm.js answers
// DA1 with ESC[?1;2c (VT100 class), which OpenConsole ignores — so the filter
// swallows the FIRST DA1 and reports it via onDa1Query for ipc.js to answer
// with CONPTY_DA1_RESPONSE. Later DA1 probes (apps querying the terminal)
// must pass through to xterm untouched.

test('first DA1 query is swallowed, reported once, stream survives', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { calls += 1; } });
    const out = f.push('\u001b[1t\u001b[c\u001b[?1004h\u001b[?9001h');
    assert.equal(calls, 1);
    assert.ok(!out.includes('\u001b[c'), 'query must not reach xterm');
    assert.ok(out.includes('\u001b[1t') && out.includes('\u001b[?1004h') && out.includes('\u001b[?9001h'),
        'neighbouring init sequences pass through: ' + JSON.stringify(out));
    assert.equal(f.state().da1Seen, 1);
});

test('DA1 split across chunks is still swallowed exactly once', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { calls += 1; } });
    assert.equal(f.push('\u001b'), '');
    assert.equal(f.push('[c'), '');
    assert.equal(calls, 1);
});

test('DA1 with explicit zero param (ESC[0c) is the same probe', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { calls += 1; } });
    assert.equal(f.push('\u001b[0c'), '');
    assert.equal(calls, 1);
});

test('later DA1 queries pass through unanswered (app-driven probes)', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { calls += 1; } });
    f.push('\u001b[c');
    const out = f.push('\u001b[c');
    assert.equal(calls, 1, 'only the first probe is answered by us');
    assert.equal(out, '\u001b[c', 'the second probe reaches xterm (its reply is dropped by conhost, same as the WT baseline)');
    assert.equal(f.state().da1Seen, 2);
});

test('DA1 replies and DA2 are not mistaken for the probe', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { calls += 1; } });
    assert.equal(f.push('\u001b[?1;2c'), '\u001b[?1;2c');
    assert.equal(f.push('\u001b[>c'), '\u001b[>c');
    assert.equal(f.push('\u001b[1;2c'), '\u001b[1;2c');
    assert.equal(calls, 0);
});

test('a throwing onDa1Query callback cannot kill the stream', () => {
    const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { throw new Error('boom'); } });
    assert.equal(f.push('\u001b[c'), '');
    assert.equal(f.push('ok'), 'ok');
    assert.equal(f.state().da1Seen, 1);
});

test('off mode leaves the DA1 probe untouched and silent', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'off', onDa1Query: () => { calls += 1; } });
    const input = enc('\u001b[c');
    assert.equal(f.push(input), input);
    assert.equal(calls, 0);
});

test('repair mode also answers the handshake', () => {
    let calls = 0;
    const f = createConPtyCaretFilter({ mode: 'repair', onDa1Query: () => { calls += 1; } });
    assert.equal(f.push('\u001b[c'), '');
    assert.equal(calls, 1);
});
