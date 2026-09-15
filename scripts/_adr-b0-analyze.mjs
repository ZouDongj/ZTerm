// ADR-0001 B0 analysis: dissect the captured nav/delete samples and test
// them against the CURRENT filter to classify the double-caret mechanism.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

const files = {
  'dsh-tui': 'tests/fixtures/dshtui-b0-nav-delete.txt',
  'kimi': 'tests/fixtures/kimi-b0-nav-delete.txt',
};

for (const [label, path] of Object.entries(files)) {
  const raw = readFileSync(path, 'utf8');
  console.log('=====', label, raw.length, 'bytes');
  const blocks = raw.match(/\u001b\[\?2026h[\s\S]*?\u001b\[\?2026l/g) || [];
  console.log('sync blocks:', blocks.length);

  // Painted-glyph candidates: any truecolor fg+bg styled cell write followed
  // by a cursor move. Report BOTH the space variant (current regex) and any
  // non-space variant.
  const spaceGlyph = /\u001b\[0;38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d;m \u001b\[0m(?=\u001b\[\d+;\d+[Hf])/g;
  const anyStyledCell = /\u001b\[0?;?38;2;(\d+;\d+;\d+);48;2;(\d+;\d+;\d+)m(.)\u001b\[0m(?=\u001b\[\d+;\d+[Hf])/g;
  const spaceCount = (raw.match(spaceGlyph) || []).length;
  const allCells = [...raw.matchAll(anyStyledCell)];
  const nonSpace = allCells.filter(m => m[3] !== ' ');
  console.log('space-caret writes:', spaceCount, '| non-space styled writes followed by CUP:', nonSpace.length);
  const nonSpaceChars = [...new Set(nonSpace.map(m => m[3]))].slice(0, 10);
  console.log('non-space caret chars:', JSON.stringify(nonSpaceChars));

  // Run the CURRENT filter in fix mode at realistic chunking and measure:
  // engagement timeline, surviving painted glyphs in the OUTPUT, forced SHOWs.
  const f = createConPtyCaretFilter({ mode: 'fix' });
  let out = '';
  let engagedAt = -1, blockIdx = 0;
  const survivors = [];
  for (let i = 0; i < raw.length; i += 4096) {
    out += f.push(raw.slice(i, i + 4096));
  }
  const outCells = [...out.matchAll(anyStyledCell)];
  const outSpace = (out.match(spaceGlyph) || []).length;
  const outNonSpace = outCells.filter(m => m[3] !== ' ');
  console.log('filter engaged:', f.state().paintedCaret, '| OUT space-carets:', outSpace, '| OUT non-space styled:', outNonSpace.length,
    '| OUT shows:', (out.match(/\u001b\[\?25h/g) || []).length, '| OUT hides:', (out.match(/\u001b\[\?25l/g) || []).length);

  // Mechanism classification: in the OUTPUT (what xterm would display),
  // frames where BOTH a painted caret cell survives AND the real cursor is
  // forced visible = double-caret frames.
  console.log('=> classification:', f.state().paintedCaret
    ? (outNonSpace.length > 0
        ? `DOUBLE-CARET: engagement kept + ${outNonSpace.length} non-space app carets survive removal + forced SHOW`
        : (outSpace > 2 ? `DOUBLE-CARET: ${outSpace} space carets survived` : 'single-source (removal kept up)'))
    : 'NEVER ENGAGED on this stream');
}
