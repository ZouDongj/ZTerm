// Guards for remote-shaped streams: the heuristic painted-caret takeover was
// removed, so nothing is deleted and no second cursor is forced. These byte
// shapes mirror a dsh-tui session running inside herdr; apps that manage
// their own cursor (nvim-style SHOWs) are untouched. The transport-level
// guarantee (SSH streams never enter the repair at all) lives in
// caret-takeover-policy.test.mjs; this file pins the filter's own behavior
// on the same shapes for LOCAL sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

const ESC = '\u001b';
const blockFor = (col, ch) =>
  `${ESC}[?2026h${ESC}[?25l${ESC}]8;;${ESC}\\${ESC}[53;${col}H${ESC}[0;39;49m${ch}` +
  `${ESC}[0;38;2;40;44;52;48;2;220;223;228m ${ESC}[0m${ESC}[53;${col + 1}H${ESC}[?25l${ESC}[?2026l`;
const strayPark = (col) => `${ESC}[53;${col}H${ESC}[?25l`;

const stream = blockFor(36, 'a') + strayPark(37) + blockFor(37, 's') + strayPark(38) +
  blockFor(38, 'n') + strayPark(39) + blockFor(39, 'h') + strayPark(40) +
  blockFor(40, 'e') + strayPark(41) + blockFor(41, 'l');
const withShellShow = '\u001b[?25h' + stream;

const count = (re, t) => (t.match(re) || []).length;

test('remote-shaped ink stream: every typed char and painted caret survives', () => {
  for (const size of [1, 7, 64, 1 << 20]) {
    const f = createConPtyCaretFilter({ mode: 'fix' });
    let out = '';
    for (let i = 0; i < withShellShow.length; i += size) out += f.push(withShellShow.slice(i, i + size));
    for (const ch of ['a', 's', 'n', 'h', 'e', 'l']) {
      assert.ok(out.includes(`39;49m${ch}`), `size ${size}: typed char ${ch} lost`);
    }
    // Content-first: the styled caret-cell writes must ALL survive.
    const paintedIn = count(/48;2;220;223;228/g, withShellShow);
    const paintedOut = count(/48;2;220;223;228/g, out);
    assert.equal(paintedOut, paintedIn, `size ${size}: painted cells deleted (${paintedIn} -> ${paintedOut})`);
  }
});

test('nvim-style apps (shows between strays) keep their shows', () => {
  const f = createConPtyCaretFilter({ mode: 'fix' });
  const nvimish = `${ESC}[?25h${blockFor(36, 'x')}${strayPark(37)}${ESC}[?25h${blockFor(37, 'y')}${strayPark(38)}${ESC}[?25h${blockFor(38, 'z')}${strayPark(39)}`;
  let out = '';
  for (let i = 0; i < nvimish.length; i += 64) out += f.push(nvimish.slice(i, i + 64));
  const shows = count(/\u001b\[\?25h/g, out);
  const inShows = count(/\u001b\[\?25h/g, nvimish);
  assert.ok(shows >= inShows, `app shows must pass through (${inShows} -> ${shows})`);
});

test('no sync blocks at all (htop-like): bit-exact passthrough in fix mode', () => {
  const f = createConPtyCaretFilter({ mode: 'fix' });
  const htopish = `${ESC}[?25lframe frame frame${ESC}[?25l`;
  const out = f.push(htopish);
  assert.equal(out, htopish, 'non-sync-block streams must pass through');
});

test('a genuine out-of-block hide sticks — later frames stay hidden', () => {
  // After the app parks+hide OUTSIDE a block (remote ink between frames,
  // nvim mode switch), every following frame starts hidden: no churn strip,
  // no forced SHOW — a forced show would paint a second cursor beside an
  // app-painted caret.
  const f = createConPtyCaretFilter({ mode: 'fix' });
  f.push(withShellShow); // shell show + ink stream with strays
  const hiddenFrame = `${ESC}[?2026h${ESC}[?25l${ESC}[54;10Hq${ESC}[0m${ESC}[54;11H${ESC}[?25l${ESC}[?2026l`;
  let out = '';
  out += f.push(hiddenFrame);
  out += f.push(hiddenFrame);
  assert.ok(!out.includes(`${ESC}[?25h`), 'hidden-start frames must not be force-shown');
  assert.ok(out.includes('q'), 'content preserved');
});
