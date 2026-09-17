// Frame-form ink caret observer tests (ADR-0001 B2 gap rework).
// Fixtures are REAL pre-filter captures from the CURRENT dsh-tui / kimi
// builds on the 41.88 rig (2026-09-15): SSH-direct and herdr-relayed. The
// apps switched from the B0-era truecolor+sync grammar to per-keystroke
// minimal frames with a REVERSE-VIDEO caret char:
//   SGR0 OSC8-end HOME <relative moves> SGR(7) char SGR(27) [plain] CUP CUP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');
require('../src/vendor/xterm.js');
const { Terminal } = globalThis.TabbyXterm;

const FIX = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');

function collect(stream, chunkSize, opts) {
  const cands = [];
  const units = [];
  const obs = createInkCaretObserver({
    ...(opts || {}),
    onCandidate: c => cands.push(c),
    onUnit: u => units.push(u),
  });
  const s = typeof stream === 'string' ? stream : stream.join('');
  if (!chunkSize) obs.push(s);
  else for (let i = 0; i < s.length; i += chunkSize) obs.push(s.slice(i, i + chunkSize));
  return { cands, units, state: obs.state() };
}

test('SSH-direct dsh-tui capture produces caret candidates', () => {
  const { cands, state } = collect(FIX('dshtui-direct-rev-caret.txt'));
  assert.ok(state.frameUnits > 10, `frame units recognized (got ${state.frameUnits})`);
  assert.ok(cands.length >= 10, `candidates produced (got ${cands.length})`);
  assert.ok(cands.every(c => c.style === 'reverse' && c.fg === null && c.bg === null));
  assert.ok(cands.every(c => c.x >= 0 && c.y >= 0));
});

test('SSH-direct kimi capture produces caret candidates', () => {
  const { cands } = collect(FIX('kimi-direct-rev-caret.txt'));
  assert.ok(cands.length >= 10, `candidates produced (got ${cands.length})`);
});

test('herdr-relayed dsh-tui capture produces caret candidates (same grammar passes through)', () => {
  const { cands } = collect(FIX('dshtui-herdr-rev-caret.txt'));
  assert.ok(cands.length >= 8, `candidates produced (got ${cands.length})`);
});

test('left-navigation candidates walk leftward across the input line', () => {
  // Full walk per fixture: typing (5→9), nav-left onto d/c/space/b (8→5),
  // then the first backspace lands the caret on the shifted 'b' (4).
  const { cands } = collect(FIX('dshtui-direct-rev-caret.txt'));
  assert.deepEqual(cands.map(c => c.x), [5, 6, 7, 8, 9, 8, 7, 6, 5, 4]);
  assert.deepEqual(cands.slice(5).map(c => c.char), ['d', 'c', ' ', 'b', 'b']);
});

test('chunk invariance: identical candidates across 1B/7B/64B/4KB splits', () => {
  const raw = FIX('dshtui-direct-rev-caret.txt');
  const ref = collect(raw).cands.map(c => `${c.unitSeq}:${c.x},${c.y}:${c.char}`);
  for (const size of [1, 7, 64, 4096]) {
    const got = collect(raw, size).cands.map(c => `${c.unitSeq}:${c.x},${c.y}:${c.char}`);
    assert.deepEqual(got, ref, `split ${size} diverges`);
  }
});

test('synthetic minimal frame yields the exact write-position candidate', () => {
  // ESH HOME, LF(+1 row), CUF(8) → col 9, CUD(19) → row 21; caret 'd' at
  // 0-based (20, 8); park terminates.
  const frame = '\u001b[0m\u001b]8;;\u0007\u001b[H\n\u001b[8C\u001b[19B\u001b[7md\u001b[27m \u001b[24;1H\u001b[20;10H';
  const { cands } = collect(frame);
  assert.equal(cands.length, 1);
  assert.deepEqual(
    { x: cands[0].x, y: cands[0].y, char: cands[0].char, style: cands[0].style },
    { x: 8, y: 20, char: 'd', style: 'reverse' },
  );
});

test('two reverse chars in one frame are ambiguous — no candidate', () => {
  const frame = '\u001b[0m\u001b]8;;\u0007\u001b[H\u001b[10;10H\u001b[7ma\u001b[27m \u001b[7mb\u001b[27m\u001b[24;1H';
  const { cands } = collect(frame);
  assert.equal(cands.length, 0);
});

test('query bursts (mouse modes, ?1049$p DECRQM, DA1) do not poison the unit', () => {
  const frame = '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1049$p\u001b[c'
    + '\u001b[0m\u001b]8;;\x07\u001b[H\n\u001b[4C\u001b[19Ba\u001b[7m \u001b[27m\u001b[24;1H\u001b[20;6H'
    + '\u001b[?1000h\u001b[?1049$p\u001b[c'
    + '\u001b[0m\u001b]8;;\x07\u001b[H\n\u001b[5C\u001b[19Bb\u001b[7m \u001b[27m\u001b[24;1H\u001b[20;7H';
  const { cands } = collect(frame);
  assert.equal(cands.length, 2);
});

test('neutral frame that overwrites the candidate cell reports its writes', () => {
  // Frame 1 publishes the caret at (21,6); frame 2 has no caret but writes
  // the same cell → adapter keep/revoke evidence must see the write. Frame 3
  // exists only to CLOSE frame 2 (neutral frames complete at the next
  // frame-form prefix).
  const f1 = '\u001b[0m\u001b]8;;\u0007\u001b[H\n\u001b[4C\u001b[19Ba\u001b[7m \u001b[27m\u001b[24;1H';
  const f2 = '\u001b[0m\u001b]8;;\u0007\u001b[H\n\u001b[4C\u001b[19Bxy\u001b[24;1H';
  const f3 = '\u001b[0m\u001b]8;;\u0007\u001b[H\n\u001b[4C\u001b[19Bz\u001b[7m \u001b[27m\u001b[24;1H';
  const { units } = collect(f1 + f2 + f3);
  const neutral = units[units.length - 2];
  assert.equal(neutral.hadCandidate, false);
  assert.ok(neutral.wrote.some(w => w[0] === 20 && w[1] === 5), `wrote covers the caret cell: ${JSON.stringify(neutral.wrote)}`);
});

test('attribute pollution from a styled frame does not poison the next caret frame', () => {
  // Real dsh-tui case (2026-09-15 gap4 capture): a truecolor logo-animation
  // frame ends with non-default SGR state; the next frame's prefix SGR(0)
  // arrives BEFORE its unit opens. The observer must apply that reset as
  // stream-global state or the caret frame's plain restore write is
  // wrongly rejected (plainAttrOk).
  const logo = '\u001b[0m\u001b]8;;\x07\u001b[H\r\u001b[27C\u001b[6B'
    + '\u001b[38;2;78;111;255m\u001b[48;2;20;38;96m\u2580\u001b[48;2;78;111;255m\u2580\u2580'
    + '\u001b[49m\u001b[38;2;20;38;96m\u2580\u001b[39m \u001b[24;1H\u001b[20;8H';
  const caret = '\u001b[0m\u001b]8;;\x07\u001b[H\r\u001b[6C\u001b[19B\u001b[7m \u001b[27mc\u001b[24;1H\u001b[20;7H';
  const { cands } = collect(logo + caret);
  assert.equal(cands.length, 1);
  assert.deepEqual({ x: cands[0].x, y: cands[0].y, char: cands[0].char }, { x: 6, y: 19, char: ' ' });
});

test('local ConPTY kimi capture (sync blocks pass through, relative units) produces candidates', () => {
  // ConPTY rewrites the app output but KEEPS synchronized-output blocks.
  // Units are addressed purely relatively (\r + EL + writes); the caret is
  // reverse-video terminated by SGR(0); borders carry fg-only truecolor.
  // The capture session was 28 rows — scroll/wrap modeling must land the
  // input caret at the bottom-anchored box (y=24), not raw \n counts.
  const { cands, state } = collect(FIX('kimi-local-conpty.txt'), null, { rows: 28, cols: 80 });
  assert.ok(cands.length >= 10, `candidates produced (got ${cands.length})`);
  assert.ok(cands.every(c => c.style === 'reverse'));
  const xs = cands.map(c => c.x);
  assert.deepEqual(xs.slice(-6), [10, 9, 8, 7, 6, 5], `tail walk: ${xs}`);
  assert.ok(cands.slice(2).every(c => c.y === 24), `bottom-anchored row: ${cands.map(c => c.y)}`);
  assert.equal(state.frameUnits, 0, 'sync form, not frame form');
});

test('bottom-stick scrolling: LF past the last row keeps coordinates viewport-relative', () => {
  // Relative-only addressing over a stream that pushes 40 lines through a
  // 10-row screen: the caret must stay on the screen (y <= 9), proving the
  // scroll model — an unbounded row counter would report y up to 39.
  let stream = '\u001b[?2026h';
  for (let i = 0; i < 40; i += 1) stream += `line ${i}\r\n`;
  stream += '\u001b[7mx\u001b[0m\u001b[?2026l';
  const { cands } = collect(stream, null, { rows: 10, cols: 40 });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].y, 9, `clamped to bottom row: ${cands[0].y}`);
});

test('ESC M/D/E (RI/IND/NEL) are modeled as cursor moves', () => {
  // Position is continuous stream state — an unmodeled move would skew every
  // later candidate row (reviewer finding). RI clamps at the top; IND/NEL
  // bottom-stick like LF.
  const base = '\u001b[?2026h\u001b[5;10H';
  const mk = (move) => base + move + '\u001b[7mx\u001b[0m \u001b[?2026l';
  const ri = collect(mk('\u001bM')).cands;   // up from (5,10) → (4,10)
  assert.deepEqual([ri[0]?.x, ri[0]?.y], [9, 3]);
  const ind = collect(mk('\u001bD')).cands;  // down → (6,10)
  assert.deepEqual([ind[0]?.x, ind[0]?.y], [9, 5]);
  const nel = collect(mk('\u001bE')).cands;  // CR+down → (6,1)
  assert.deepEqual([nel[0]?.x, nel[0]?.y], [0, 5]);
});

test('claude bare reverse-caret gestures (no sync, no frame prefix) are recognized', () => {
  // Real rig capture: per keystroke the app emits relative moves + SGR(7)
  // single char SGR(27) with no enclosing unit at all. The gesture is
  // self-terminating: rev-ON, exactly ONE printable, rev-OFF.
  const { cands } = collect(FIX('claude-rig-bare-rev.txt'), null, { rows: 24, cols: 80 });
  assert.ok(cands.length >= 6, `candidates produced (got ${cands.length})`);
  assert.ok(cands.every(c => c.style === 'reverse'));
  // typing walks right 3..7 then nav walks left over text cells
  const xs = cands.map(c => c.x);
  assert.deepEqual(xs.slice(0, 5), [3, 4, 5, 6, 7]);
  assert.deepEqual(xs.slice(-2), [6, 5]);
});

test('claude bare reverse-caret gestures survive arbitrary chunk splits', () => {
  // SSH IPC chunking is arbitrary: the SAME capture must produce the SAME
  // candidates whether fed whole, byte-wise, or at a stride that cuts
  // escape sequences mid-flight.
  const raw = FIX('claude-rig-bare-rev.txt');
  const expected = collect(raw).cands.map(c => [c.x, c.y, c.char]);
  assert.equal(expected.length, 7, 'baseline candidate count');
  for (const chunkSize of [1, 3, 47]) {
    const { cands } = collect(raw, chunkSize);
    assert.deepEqual(cands.map(c => [c.x, c.y, c.char]), expected, `chunk size ${chunkSize}`);
  }
});

test('claude derived native chunks (mid-sequence cuts) preserve candidates', () => {
  // The native acceptance fixture cuts mid-SGR and mid-CSI; the observer
  // must buffer across those cuts and emit identical candidates.
  const fx = JSON.parse(FIX('claude-direct-native-chunks.json'));
  const cands = [];
  const obs = createInkCaretObserver({ rows: fx.rows, cols: fx.cols, onCandidate: c => cands.push(c) });
  for (const chunk of fx.chunks) obs.push(chunk);
  const expected = collect(FIX('claude-rig-bare-rev.txt')).cands.map(c => [c.x, c.y, c.char]);
  assert.deepEqual(cands.map(c => [c.x, c.y, c.char]), expected);
});

test('a multi-character reverse run is NOT a bare caret gesture', () => {
  // Menu selection / highlighted word: rev spans several printables before
  // turning off — must not produce a candidate (decidability: only the
  // single-char gesture is verified as a caret).
  const stream = '\u001b[5;10H\u001b[7mword\u001b[27m \u001b[5;12H\u001b[7mx\u001b[27m';
  const { cands } = collect(stream, null, { rows: 24, cols: 80 });
  assert.equal(cands.length, 0, 'neither highlight has the verified bare repaint context');
});

test('HOME frame prefix cancels pending autowrap exactly as xterm does', t => {
  const term = new Terminal({ cols: 80, rows: 24 });
  t.after(() => term.dispose());
  const stream = '\x1b[2;2H \x1b[H' + 'x'.repeat(80)
    + '\x1b[0m\x1b]8;;\x07\x1b[Ha\x1b[7m \x1b[27m\x1b[24;1H';
  term._core._inputHandler.parse(stream);
  const { cands } = collect(stream);
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.deepEqual([c.x, c.y], [1, 0]);
  assert.ok(term.buffer.active.getLine(c.y).getCell(c.x).isInverse());
});

test('bare one-character decorations do not establish caret ownership by repetition', () => {
  const stream = '\x1b[5;10H\x1b[7m \x1b[27m\x1b[5;12H\x1b[7m \x1b[27m';
  assert.equal(collect(stream).cands.length, 0);
});

for (const move of ['\t', '\x1b7\x1b[10;20H\x1b8', '\x1b[2E']) {
  test(`unmodeled bare movement ${JSON.stringify(move)} needs an absolute anchor before recognition resumes`, () => {
    const gesture = '\r\x1b[3C\x1b[1A\x1b[7m \x1b[27m';
    const unknown = '\x1b[5;10H' + move + gesture;
    assert.equal(collect(unknown).cands.length, 0);
    const { cands } = collect(unknown + '\x1b[5;10H' + gesture);
    assert.equal(cands.length, 1);
    assert.deepEqual([cands[0].x, cands[0].y], [3, 3]);
  });
}

test('legacy sync form still recognized (old builds)', () => {
  const { cands, state } = collect(FIX('dshtui-b0-nav-delete.txt'));
  assert.ok(cands.length >= 2, `sync candidates still produced (got ${cands.length})`);
  assert.ok(cands.every(c => c.style === 'truecolor'));
});
