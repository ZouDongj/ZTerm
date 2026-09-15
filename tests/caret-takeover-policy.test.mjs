// ADR-0001 B1 regression tests: the heuristic painted-caret takeover must
// not delete caret-cell writes (content correctness first) and must not
// force a second cursor. Fixtures are REAL pre-filter captures from isolated
// self-created sessions (herdr+dsh-tui / herdr+kimi on 41.88, 2026-09-15):
// forward typing paints carets over SPACES (5 in dsh), but deletion and pure
// left/right navigation paint carets over CHARACTERS ('b','c','d','y') —
// the old space-only removal missed those while engagement kept forcing
// SHOW, producing the user-visible double caret ("一份跳动、一份平滑追赶").
// These tests are RED against a1083a2 and must be GREEN after B1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

const dsh = readFileSync(join(here, 'fixtures/dshtui-b0-nav-delete.txt'), 'utf8');
const kimi = readFileSync(join(here, 'fixtures/kimi-b0-nav-delete.txt'), 'utf8');
const samples = [['dsh-tui', dsh], ['kimi', kimi]];

// A styled caret-cell write: truecolor fg+bg SGR, any single non-ESC char,
// reset, followed by a cursor move. Space variant = end-of-line caret;
// non-space = caret parked ON text during navigation/deletion.
const styledCell = (ch) =>
  new RegExp(`\\u001b\\[0;38;2;\\d+;\\d+;\\d+;48;2;\\d+;\\d+;\\d+m${ch === ' ' ? ' ' : '[^\\u001b]'}\\u001b\\[0m(?=\\u001b\\[\\d+;\\d+[Hf])`, 'g');

function replay(raw, chunk = 4096) {
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  for (let i = 0; i < raw.length; i += chunk) out += f.push(raw.slice(i, i + chunk));
  return { out, state: f.state() };
}

test('B1: real nav/delete samples keep every styled caret cell (content first)', () => {
  for (const [name, raw] of samples) {
    const { out } = replay(raw);
    for (const label of ['space', 'char']) {
      const re = styledCell(label === 'space' ? ' ' : 'x');
      const inCount = (raw.match(re) || []).length;
      const outCount = (out.match(re) || []).length;
      assert.equal(outCount, inCount,
        `${name}: ${label}-caret writes must survive untouched (${inCount} -> ${outCount})`);
    }
  }
});

test('B1: the painted-caret takeover mode never engages', () => {
  for (const [name, raw] of samples) {
    const { state } = replay(raw);
    assert.notEqual(state.paintedCaret, true, `${name}: paintedCaret must never engage`);
  }
});

test('B1: transport policy — SSH streams never enter the caret repair', () => {
  const mod = require('../src/renderer/conpty-caret.js');
  assert.equal(typeof mod.caretRepairAllowed, 'function', 'policy helper must be exported');
  assert.equal(mod.caretRepairAllowed('ssh'), false, 'ssh sessions must pass through raw');
  assert.equal(mod.caretRepairAllowed('local'), true, 'local ConPTY keeps its visibility repair');
});

test('B1: local visibility repair still consolidates transient hides (regression guard)', () => {
  // The independently verified 2026-09-13 local ConPTY repair: after the app
  // has genuinely shown the cursor (a shell prompt always does before a TUI
  // launches), a visible frame's in-block ?25l churn is dropped and a
  // block-end SHOW re-asserts visibility. This must survive the takeover
  // removal.
  const frame = '\u001b[?2026h\u001b[?25l\u001b[30;70H\u001b[0;39;49ma\u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  out += f.push('\u001b[?25h'); // genuine app SHOW (shell prompt)
  out += f.push(frame);
  out += f.push(frame);
  assert.ok(out.includes('\u001b[?25h'), 'block-end SHOW must re-assert visibility');
  const churn = (out.match(/\u001b\[\?25l/g) || []).length;
  assert.ok(churn <= 2, `transient hides should be consolidated (got ${churn})`);
  assert.ok(out.includes('a'), 'content preserved');
});

test('B1: local ink stream keeps the verified churn repair (consolidated hides)', () => {
  // LOCAL captures (dshtui-input.txt) have every hide consolidated INSIDE
  // sync blocks by ConPTY — no out-of-block strays — so every frame starts
  // visible and the 2026-09-13 user-verified repair re-asserts SHOW per
  // frame: typing stays smooth with the real cursor riding the painted
  // cell. Known B1 residual until B2: navigation/deletion diverges the two
  // positions (double caret) locally.
  const frame = '\u001b[?2026h\u001b[?25l\u001b[30;70Hhi\u001b[0m\u001b[0;38;2;40;44;52;48;2;220;223;228md\u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  for (let i = 0; i < 6; i++) out += f.push(frame);
  const shows = (out.match(/\u001b\[\?25h/g) || []).length;
  assert.ok(shows >= 5, `consolidated-hide frames must keep the SHOW repair (got ${shows})`);
  assert.ok(out.includes('hi') && out.includes('d'), 'content preserved');
});

test('B1: an out-of-block hide sticks — hidden-start frames never force-shown', () => {
  // A genuine hide OUTSIDE any sync block (remote ink park, nvim mode
  // switch) makes every following frame hidden-start: no churn strip, no
  // SHOW. Forcing one would draw a second cursor beside an app-painted
  // caret. This is the state SSH streams live in permanently via the
  // transport gate; the filter must behave the same when handed such bytes.
  const parkHide = '\u001b[53;41H\u001b[?25l';
  const frame = '\u001b[?2026h\u001b[?25l\u001b[30;70Hhi\u001b[0m\u001b[0;38;2;40;44;52;48;2;220;223;228md\u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';
  const f = createConPtyCaretFilter({ mode: 'fix' });
  f.push('\u001b[?25h'); // shell showed once
  f.push(frame);          // repaired frame (fine)
  let out = f.push(parkHide); // genuine out-of-block park+hide
  for (let i = 0; i < 3; i++) out += f.push(frame);
  const shows = (out.match(/\u001b\[\?25h/g) || []).length;
  assert.equal(shows, 0, `hidden-start frames must never be force-shown (got ${shows})`);
  assert.ok(out.includes('hi'), 'content preserved');
});
