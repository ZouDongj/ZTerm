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
