// Regression tests for the painted-caret takeover heuristic: it must
// not delete caret-cell writes (content correctness first) and must not
// force a second cursor. Fixtures are real pre-filter captures from isolated
// self-created sessions (herdr+dsh-tui / herdr+kimi):
// forward typing paints carets over SPACES (5 in dsh), but deletion and pure
// left/right navigation paint carets over CHARACTERS ('b','c','d','y') —
// the old space-only removal missed those while engagement kept forcing
// SHOW, producing a user-visible double caret.
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

test('B1: the painted-caret takeover mode is gone from the state surface', () => {
  // The takeover (glyph-evidence engagement) was removed; this guard pins
  // the absence of its state field so a silent reintroduction trips red.
  for (const [name, raw] of samples) {
    const { state } = replay(raw);
    assert.equal('paintedCaret' in state, false,
      `${name}: state() must not carry a paintedCaret engagement flag`);
  }
});

test('B1: transport policy — SSH streams never enter the caret repair', () => {
  const mod = require('../src/renderer/conpty-caret.js');
  assert.equal(typeof mod.caretRepairAllowed, 'function', 'policy helper must be exported');
  assert.equal(mod.caretRepairAllowed('ssh'), false, 'ssh sessions must pass through raw');
  assert.equal(mod.caretRepairAllowed('local'), true, 'local ConPTY keeps its visibility repair');
});

test('B1: a genuine SHOW does not unlock SHOW manufacturing for evidence-free frames', () => {
  // Captured herdr 0.9.0 sessions (kimi/dsh-tui/bash panes): herdr hides
  // its console cursor once and paints pane carets as
  // content, so frames arrive with in-block ?25l and NO painted-caret SGR —
  // even though the shell showed the caret before the TUI launched. The old
  // "shown once => every later hide is ConPTY's rewrite" premise manufactured
  // a block-end SHOW per frame, parking a phantom protocol caret at each
  // frame's final CUP (a far-right blinking caret while an agent works).
  // Evidence-free frames must pass through raw.
  const frame = '\u001b[?2026h\u001b[?25l\u001b[30;70H\u001b[0;39;49ma\u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  out += f.push('\u001b[?25h'); // genuine app SHOW (shell prompt)
  out += f.push(frame);
  out += f.push(frame);
  const shows = (out.match(/\u001b\[\?25h/g) || []).length;
  assert.equal(shows, 1, `only the genuine SHOW may survive (got ${shows})`);
  const hides = (out.match(/\u001b\[\?25l/g) || []).length;
  assert.equal(hides, 4, `evidence-free hides must forward untouched (got ${hides})`);
  assert.ok(out.includes('a'), 'content preserved');
});

test('B1: ink painted-caret frames get no manufactured SHOW (B2 owns the caret)', () => {
  // Live dsh-tui/kimi frames paint the caret as a styled CELL (truecolor
  // fg+bg, one glyph) — the software-caret candidate — inside sync blocks
  // with NO conhost painted-caret SGR. The visibility repair must not fire
  // here: every manufactured SHOW draws the protocol caret at the frame's
  // final CUP on top of the app-painted caret, a visible double caret.
  // The software caret (ink-caret-observer → xterm-smooth-cursor)
  // renders this cursor instead.
  const frame = '\u001b[?2026h\u001b[?25l\u001b[30;70Hhi\u001b[0m\u001b[0;38;2;40;44;52;48;2;220;223;228md\u001b[0m\u001b[30;71H\u001b[?25l\u001b[?2026l';
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  for (let i = 0; i < 6; i++) out += f.push(frame);
  const shows = (out.match(/\u001b\[\?25h/g) || []).length;
  assert.equal(shows, 0, `no SHOW may be manufactured without painted-caret evidence (got ${shows})`);
  assert.ok(out.includes('hi') && out.includes('d'), 'content preserved');
  assert.ok(out.includes('\u001b[0;38;2;40;44;52;48;2;220;223;228md\u001b[0m'), 'styled caret cell preserved');
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
  f.push(frame);          // no painted evidence -> passthrough, still no SHOW
  let out = f.push(parkHide); // genuine out-of-block park+hide
  for (let i = 0; i < 3; i++) out += f.push(frame);
  const shows = (out.match(/\u001b\[\?25h/g) || []).length;
  assert.equal(shows, 0, `hidden-start frames must never be force-shown (got ${shows})`);
  assert.ok(out.includes('hi'), 'content preserved');
});
