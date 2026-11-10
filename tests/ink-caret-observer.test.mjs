// Ink caret observer tests: real fixtures plus the decidability rules for
// when a styled cell counts as an app-painted caret.
// The observer is pure (no DOM): feed raw chunks, collect candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');
require('../src/vendor/xterm.js');

const dsh = readFileSync(join(here, 'fixtures/dshtui-b0-nav-delete.txt'), 'utf8');
const kimi = readFileSync(join(here, 'fixtures/kimi-b0-nav-delete.txt'), 'utf8');

function observe(raw, chunkSize = 4096) {
  const candidates = [];
  const units = [];
  const o = createInkCaretObserver({
    onCandidate: c => candidates.push(c),
    onUnit: u => units.push(u),
  });
  for (let i = 0; i < raw.length; i += chunkSize) o.push(raw.slice(i, i + chunkSize));
  return { candidates, units, state: o.state() };
}

test('real dsh-tui nav/delete capture yields caret candidates over chars and spaces', () => {
  const { candidates } = observe(dsh);
  assert.ok(candidates.length >= 5, `expected several candidates, got ${candidates.length}`);
  const chars = candidates.map(c => c.char);
  // navigation/deletion paint carets over the underlying characters
  for (const ch of ['b', 'c', 'd']) assert.ok(chars.includes(ch), `missing char caret ${ch}`);
  // and end-of-line typing paints at least one space caret
  assert.ok(chars.includes(' '), 'missing space caret');
  // coordinates and colors are populated from the write position
  for (const c of candidates) {
    assert.ok(c.x >= 0 && c.y >= 0, 'coords are 0-based');
    assert.ok(/^\d+;\d+;\d+$/.test(c.fg) && /^\d+;\d+;\d+$/.test(c.bg), 'truecolor evidence present');
    assert.equal(c.restoreSgr, '0;39;49', 'restore uses the verified convention');
  }
});

test('real kimi capture yields char carets too (both clients, not just one)', () => {
  const { candidates } = observe(kimi);
  const chars = candidates.map(c => c.char);
  assert.ok(chars.some(ch => ch !== ' '), `kimi char carets expected, got ${JSON.stringify(chars)}`);
});

test('chunk-size invariance: candidates identical at every split', () => {
  const whole = observe(dsh, 1 << 22).candidates;
  for (const size of [1, 7, 64, 4096]) {
    const c = observe(dsh, size).candidates;
    assert.equal(c.length, whole.length, `size ${size}: candidate count differs`);
    for (let i = 0; i < c.length; i++) {
      assert.equal(c[i].x, whole[i].x, `size ${size}: x differs at ${i}`);
      assert.equal(c[i].y, whole[i].y, `size ${size}: y differs at ${i}`);
      assert.equal(c[i].char, whole[i].char, `size ${size}: char differs at ${i}`);
    }
  }
});

test('candidate coordinates match the exact write position, not the trailing CUP', () => {
  // Synthetic minimal unit built from the verified grammar:
  // CUP(20;31) 'a'(plain) caret('b') RESET CUP(20;33) — the caret was
  // WRITTEN at col 32 (1-based), the trailing CUP points at 33. The
  // descriptor must use 32-1 = 31 (0-based x).
  const unit = '\u001b[?2026h\u001b[?25l\u001b[20;31H\u001b[0;39;49ma\u001b[0;38;2;40;44;52;48;2;220;223;228mb\u001b[0m\u001b[20;33H\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].x, 31, 'x from the write position');
  assert.equal(candidates[0].y, 19, 'y from the CUP row, 0-based');
  assert.equal(candidates[0].char, 'b');
});

test('ADR: ordinary highlighted spaces followed by CUP are NOT candidates', () => {
  // Two plain background-highlight spaces then a CUP — weak features must
  // not trigger (bg-only truecolor, no fg; no caret).
  const weak = '\u001b[?2026h\u001b[0;48;2;10;20;30m  \u001b[0m\u001b[5;5H\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(weak);
  assert.equal(candidates.length, 0, 'bg-only spaces must not be carets');
});

test('ADR: a unit containing a genuine SHOW produces no candidate', () => {
  const unit = '\u001b[?2026h\u001b[20;31H\u001b[0;39;49ma\u001b[0;38;2;40;44;52;48;2;220;223;228mb\u001b[0m\u001b[20;33H\u001b[?25h\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 0, 'apps managing their cursor are left alone');
});

test('ADR: multiple caret cells in one unit are ambiguous, not guessed', () => {
  const unit = '\u001b[?2026h\u001b[20;31H\u001b[0;38;2;1;2;3;48;2;4;5;6ma\u001b[0m\u001b[20;32H\u001b[0;38;2;1;2;3;48;2;4;5;6mb\u001b[0m\u001b[20;33H\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 0);
});

test('ADR: plain writes with non-default attributes void the unit (restore evidence insufficient)', () => {
  const unit = '\u001b[?2026h\u001b[20;31H\u001b[0;31ma\u001b[0;38;2;40;44;52;48;2;220;223;228mb\u001b[0m\u001b[20;33H\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 0, 'no verified restore convention -> raw display');
});

test('unmodeled cursor movement inside a unit voids the candidate (conservative)', () => {
  const unit = '\u001b[?2026h\u001b[20;31H\u001b[0;38;2;1;2;3;48;2;4;5;6ma\u001b[0m\u001bM\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 0);
});

test('no sync blocks at all: no candidates, no crash, bounded buffer', () => {
  const plain = 'just a shell prompt $ \u001b[?25l';
  const { candidates } = observe(plain);
  assert.equal(candidates.length, 0);
});

test('CJK wide caret cell reports width 2', () => {
  const unit = '\u001b[?2026h\u001b[20;31H\u001b[0;39;49mx\u001b[0;38;2;40;44;52;48;2;220;223;228m中\u001b[0m\u001b[20;33H\u001b[?25l\u001b[?2026l';
  const { candidates } = observe(unit);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].width, 2);
});

// ── chunk-level write reporting (issue #31) ──

function observeChunks(chunks) {
  const reports = [];
  const o = createInkCaretObserver({ onChunkWrites: w => reports.push(w) });
  for (const chunk of chunks) o.push(chunk);
  return { reports, state: o.state() };
}

test('chunk write report carries coords/char/width for writes outside and inside open units, plus the hide flag', () => {
  const { reports } = observeChunks(['\u001b[2;3Hab', '\u001b[?25l', '\u001b[?2026h中', '\u001b[?2026l']);
  assert.deepEqual(reports[0].cells, [[1, 2, 'a', 1], [1, 3, 'b', 1]], '0-based write cells with char and width');
  assert.equal(reports[0].hid, false);
  assert.equal(reports[1].hid, true, 'a cursor-hide chunk reports the envelope flag');
  assert.deepEqual(reports[2].cells, [[1, 4, '中', 2]], 'writes inside a still-open unit are reported before it closes');
  assert.equal(reports[2].hid, false, 'the hide flag is per chunk, not sticky');
  assert.deepEqual(reports[3].cells, [], 'a write-less chunk still reports (envelope carrier)');
  for (const report of reports) assert.ok(Number.isInteger(report.chunkSeq));
});

test('chunk write report is bounded per chunk and stops at the bound', () => {
  const bulk = '\u001b[1;1H' + 'x'.repeat(5000);
  const { reports } = observeChunks([bulk]);
  assert.equal(reports[0].cells.length, 4096, 'bulk output stops being reported at the bound');
  assert.ok(reports[0].cells.every(cell => Array.isArray(cell) && cell.length === 4));
});

test('chunk write report stays silent without coordinates it can trust', () => {
  // ?1049h voids the position model; the following write must not report a
  // guessed coordinate until an absolute anchor restores the model.
  const { reports } = observeChunks(['\u001b[?1049hx', '\u001b[3;4Hy']);
  assert.deepEqual(reports[0].cells, [], 'unknown position reports nothing');
  assert.deepEqual(reports[1].cells, [[2, 3, 'y', 1]], 'a CUP anchor restores trustworthy reporting');
});

test('DECSCUSR preserves command-line write evidence and cursor coordinates', () => {
  const { reports, state } = observeChunks(['\u001b[24;1H:w\u001b[2 q']);
  assert.deepEqual(reports[0].cells, [[23, 0, ':', 1], [23, 1, 'w', 1]]);
  assert.equal(state.positionKnown, true, 'cursor shape changes do not move the protocol cursor');
  assert.equal(state.positionReason, null);
});


test('chunk report scopes text effects to written cells, erased rows, buffer switches and scrolling', () => {
  const { reports } = observeChunks([
    '\u001b[2;3Hab\u001b[K',
    '\u001b[?25l',
    '\u001b[24;1H\n',
    '\u001b[?1049hx',
    '\u001b[3;4Hy',
  ]);
  assert.deepEqual(reports[0].cells, [[1, 2, 'a', 1], [1, 3, 'b', 1]]);
  assert.deepEqual(reports[0].rows, [1]);
  assert.equal(reports[0].text, true);
  assert.equal(reports[0].complete, true);
  assert.equal(reports[0].buffer, false);
  assert.equal(reports[1].text, false);
  assert.deepEqual(reports[1].rows, []);
  assert.equal(reports[1].buffer, false);
  assert.equal(reports[2].scroll, 'full');
  assert.equal(reports[3].buffer, true);
  assert.equal(reports[3].text, true);
  assert.equal(reports[3].complete, false, 'printable output at unknown coordinates is incomplete evidence');
  assert.deepEqual(reports[4].cells, [[2, 3, 'y', 1]]);
  assert.equal(reports[4].complete, true);
});

test('chunk report marks cell truncation as incomplete text evidence', () => {
  const { reports } = observeChunks(['x'.repeat(5000)]);
  assert.equal(reports[0].cells.length, 4096);
  assert.equal(reports[0].text, true);
  assert.equal(reports[0].complete, false);
});


test('every directly screen-mutating final takes the bounded conservative text path', () => {
  for (const sequence of ['\u001b[3X', '\u001b[2P', '\u001b[2@', '\u001b[1L', '\u001b[1M',
    '\u001b[1S', '\u001b[1T', '\u001b[3b', '\u001bc']) {
    const { reports } = observeChunks([sequence]);
    assert.equal(reports[0].text, true, JSON.stringify(sequence));
    assert.equal(reports[0].complete, false, JSON.stringify(sequence));
    assert.deepEqual(reports[0].cells, [], JSON.stringify(sequence));
  }
});

test('RI is conservative only at the top where it can scroll text', () => {
  const top = observeChunks(['\u001b[1;1H\u001bM']).reports[0];
  assert.equal(top.text, true);
  assert.equal(top.complete, false);
  const movementOnly = observeChunks(['\u001b[2;1H\u001bM']).reports[0];
  assert.equal(movementOnly.text, false);
  assert.equal(movementOnly.complete, true);
});


test('chunk scroll evidence distinguishes full, partial and non-scrolling regions', () => {
  const { reports } = observeChunks([
    '\u001b[1;2r\u001b[2;1H\n',
    '\u001b[24;1H\n',
    '\u001b[r\u001b[24;1H\n',
  ]);
  assert.equal(reports[0].scroll, 'partial');
  assert.equal(reports[1].scroll, null);
  assert.equal(reports[2].scroll, 'full');
});


test('DECOM home and relative CUP produce partial-region LF/RI evidence', () => {
  const lf = observeChunks(['\u001b[2;4r\u001b[?6h\u001b[3;1H\n']);
  assert.equal(lf.reports[0].scroll, 'partial');
  const ri = observeChunks(['\u001b[2;4r\u001b[?6h\u001bM']);
  assert.equal(ri.reports[0].scroll, 'partial');
  assert.equal(ri.reports[0].text, true);
  assert.equal(ri.reports[0].complete, false);
  assert.equal(ri.state.positionKnown, false, 'DECOM/DECSTBM keep caret recovery conservative');
  const outside = observeChunks(['\u001b[2;4r\u001b[?6l\u001b[1;1H\u001bM']);
  assert.equal(outside.reports[0].scroll, null);
  assert.equal(outside.reports[0].text, false);
});

test('RIS and resize restore full-region scroll evidence', () => {
  const ris = observeChunks(['\u001b[2;4r\u001b[?6h', '\u001bc\u001b[24;1H\n']);
  assert.equal(ris.reports[1].scroll, 'full');
  const reports = [];
  const observer = createInkCaretObserver({ onChunkWrites: w => reports.push(w) });
  observer.push('\u001b[2;4r\u001b[?6h');
  observer.setSize(30, 80);
  observer.push('\u001b[30;1H\n');
  assert.equal(reports[1].scroll, 'full');
});


async function differential(chunks) {
  const terminal = new globalThis.TabbyXterm.Terminal({ cols: 8, rows: 24, scrollback: 0, allowProposedApi: true });
  const reports = [];
  const observer = createInkCaretObserver({ rows: 24, cols: 8, onChunkWrites: w => reports.push(w) });
  for (const chunk of chunks) {
    observer.push(chunk);
    await new Promise(resolve => terminal.write(chunk, resolve));
  }
  return { terminal, reports, state: observer.state() };
}

function xLocations(terminal) {
  const cells = [];
  for (let row = 0; row < terminal.rows; row++) {
    const cell = terminal.buffer.active.getLine(row)?.getCell(0);
    if (cell?.getChars() === 'X') cells.push([row, 0, 'X', 1]);
  }
  return cells;
}

for (const [name, chunks, expectedScroll] of [
  ['1049l discards the alternate region', [
    '\u001b[?1049h', '\u001b[1;23r', '\u001b[?1049l', '\u001b[23;1H\nX',
  ], null],
  ['1049l restores the saved normal region', [
    '\u001b[1;22r', '\u001b[?1049h', '\u001b[1;23r', '\u001b[?1049l', '\u001b[22;1H\nX',
  ], 'partial'],
  ['DECSTR resets region and origin', [
    '\u001b[1;23r\u001b[?6h', '\u001b[!p', '\u001b[23;1H\nX',
  ], null],
]) {
  test(`real xterm differential: ${name}`, async t => {
    const { terminal, reports, state } = await differential(chunks);
    t.after(() => terminal.dispose());
    const actual = xLocations(terminal);
    assert.equal(actual.length, 1, 'the real xterm fixture writes exactly one X');
    assert.deepEqual(reports.at(-1).cells, actual, 'observer and xterm write X at the same cell');
    assert.equal(reports.at(-1).scroll, expectedScroll);
    assert.equal(state.positionKnown, true, 'CUP restores known coordinates after the buffer/reset transition');
  });
}
