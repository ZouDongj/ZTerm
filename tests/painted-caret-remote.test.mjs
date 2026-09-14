// Test the painted-caret engagement against the REAL remote (SSH) stream
// shape captured from dsh-tui inside herdr on 41.88: sync blocks whose frames
// hide the cursor, PLUS stray park+hide sequences OUTSIDE the blocks, and
// zero ?25h anywhere. Locally the same app works because ConPTY consolidates
// the hides inside blocks; over SSH the stray hides defeat the repair chain.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

// Reconstructed from the user's 2026-09-14 sample streamTail (patterns
// repeated per keystroke): frame block with typed char + painted caret space,
// park+hide inside the block, then an extra park+hide AFTER the block.
const ESC = '\u001b';
const blockFor = (col, ch) =>
  `${ESC}[?2026h${ESC}[?25l${ESC}]8;;${ESC}\\${ESC}[53;${col}H${ESC}[0;39;49m${ch}` +
  `${ESC}[0;38;2;40;44;52;48;2;220;223;228m ${ESC}[0m${ESC}[53;${col + 1}H${ESC}[?25l${ESC}[?2026l`;
const strayPark = (col) => `${ESC}[53;${col}H${ESC}[?25l`;

const stream = blockFor(36, 'a') + strayPark(37) + blockFor(37, 's') + strayPark(38) +
  blockFor(38, 'n') + strayPark(39) + blockFor(39, 'h') + strayPark(40) +
  blockFor(40, 'e') + strayPark(41) + blockFor(41, 'l');

const count = (re, t) => (t.match(re) || []).length;

// fix mode must swallow every hide after engagement and keep the real cursor
// visible: zero ?25l in the output, one SHOW per block, typed text intact.
for (const size of [1, 7, 64, 1 << 20]) {
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  for (let i = 0; i < stream.length; i += size) out += f.push(stream.slice(i, i + size));
  const blocks = count(/\x1b\[\?2026h/g, stream);
  const shows = count(/\x1b\[\?25h/g, out);
  if (count(/\x1b\[\?25l/g, out) !== 0) throw new Error(`size ${size}: hides leaked through`);
  if (shows < blocks) throw new Error(`size ${size}: expected >=${blocks} SHOWs, got ${shows}`);
  for (const ch of ['a', 's', 'n', 'h', 'e', 'l']) {
    if (!out.includes(`39;49m${ch}`)) throw new Error(`size ${size}: typed char ${ch} lost`);
  }
  if (!f.state().paintedCaret) throw new Error(`size ${size}: painted-caret mode never engaged`);
  console.log(`size ${String(size).padStart(7)}: ok (${blocks} blocks, ${shows} SHOWs, 0 hides)`);
}

// A real SHOW ends painted-caret mode (nvim/opencode-like apps manage their
// own cursor and must not be forced).
const f2 = createConPtyCaretFilter({ mode: 'fix' });
let out2 = '';
for (let i = 0; i < stream.length; i += 64) out2 += f2.push(stream.slice(i, i + 64));
out2 += f2.push(`${strayPark(41)}\u001b[?25h`);
const afterShow = f2.push(blockFor(42, 'x') + `${ESC}[?25l`);
if (f2.state().paintedCaret) throw new Error('SHOW must end painted-caret mode');
if (!afterShow.includes(`${ESC}[?25l`)) throw new Error('after a real show, hides pass through again');
console.log('show-ends-mode: ok');

// No sync blocks at all (htop-like): nothing changes.
const f3 = createConPtyCaretFilter({ mode: 'fix' });
const htopish = `${ESC}[?25lframe frame frame${ESC}[?25l`;
const out3 = f3.push(htopish);
if (out3 !== htopish) throw new Error('non-sync-block streams must pass through');
console.log('no-sync passthrough: ok');

// off mode stays bit-exact on the remote stream.
const f4 = createConPtyCaretFilter({ mode: 'off' });
if (f4.push(stream) !== stream) throw new Error('off mode bit-exact');
console.log('off bit-exact: ok');
