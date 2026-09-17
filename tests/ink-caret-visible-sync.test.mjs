import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/visible-sync-caret.json', import.meta.url)));
const raw = fixture.chunks[0];
function observe(chunks) {
  const candidates = [];
  const observer = createInkCaretObserver({ rows: fixture.rows, cols: fixture.cols, onCandidate: c => candidates.push(c) });
  observer.push('\x1b[?7l');
  chunks.forEach(c => observer.push(c));
  return candidates.map(({ chunkSeq, ...c }) => c);
}
test('captured sync truecolor cell with explicit matching visible-protocol tail yields its write-time descriptor', () => {
  const candidates = observe([raw]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confirmedVisibleSync, true);
  assert.deepEqual([candidates[0].x, candidates[0].y, candidates[0].char, candidates[0].width, candidates[0].restoreSgr], [31, 52, ' ', 1, '0;39;49']);
});

test('legacy hidden sync candidate carries no visible-sync proof', () => {
  const candidate = observe([raw.replace('\x1b[?25h', '\x1b[?25l')])[0];
  assert.ok(candidate);
  assert.notEqual(candidate.confirmedVisibleSync, true);
});

test('confirmation is invariant under bytewise and seeded random chunk boundaries', () => {
  const expected = observe([raw]);
  assert.deepEqual(observe([...raw]), expected);
  for (let seed = 1; seed <= 32; seed++) {
    let state = seed, offset = 0; const chunks = [];
    while (offset < raw.length) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const size = 1 + state % 17; chunks.push(raw.slice(offset, offset + size)); offset += size; }
    assert.deepEqual(observe(chunks), expected);
  }
});

test('explicit HVP matching the write position confirms the same descriptor', () => {
  assert.equal(observe([raw.replace('[53;32H', '[53;32f')]).length, 1);
});

for (const [name, change] of [
  ['mismatched park', s => s.replace('[53;32H', '[53;33H')],
  ['no explicit anchor', s => s.replace('\x1b[53;32H', '')],
  ['relative anchor', s => s.replace('\x1b[53;32H', '\x1b[1D')],
  ['no hide', s => s.replace('\x1b[?25l', '')],
  ['hide only after cell', s => s.replace('\x1b[?25l', '').replace('\x1b[0m', '\x1b[?25l\x1b[0m')],
  ['early show', s => s.replace('\x1b[?25l', '\x1b[?25h\x1b[?25l')],
  ['reverse cell', s => s.replace('0;38;2;40;44;52;48;2;220;223;228m', '7m')],
  ['multiple styled cells', s => s.replace('223;228m ', '223;228m  ')],
  ['wide styled cell', s => s.replace('223;228m ', '223;228m中')],
  ['nondefault plain', s => s.replace('0;39;49m', '0;1m')],
  ['no plain writes', s => s.replace('0;39;49mx', '0;39;49m').replace('[53;32H', '[53;31H')],
  ['open unit', s => s.replace('\x1b[?2026l', '')],
  ['nested begin termination', s => s.replace('\x1b[?2026l', '\x1b[?2026h')],
  ['text after confirmation', s => s.replace('\x1b[?25h', 'x\x1b[?25h')],
  ['motion after confirmation', s => s.replace('\x1b[?25h', '\x1b[1D\x1b[?25h')],
  ['reanchor after confirmation', s => s.replace('\x1b[?25h', '\x1b[53;32H\x1b[?25h')],
  ['SGR after confirmation', s => s.replace('\x1b[?25h', '\x1b[0m\x1b[?25h')],
  ['text after show', s => s.replace('\x1b[?2026l', 'x\x1b[?2026l')],
  ['second show', s => s.replace('\x1b[?25h', '\x1b[?25h\x1b[?25h')],
]) {
  test('visible-protocol exception rejects ' + name, () => {
    assert.equal(observe([change(raw)]).length, 0);
    assert.equal(observe([...change(raw)]).length, 0);
  });
}
