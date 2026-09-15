// One-off trace: feed the minimal unit token by token to the real observer
// internals to find why no candidate is produced.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');

const ESC = '\u001b';
const unit = `${ESC}[?2026h${ESC}[?25l${ESC}]8;;${ESC}\\${ESC}[20;31H${ESC}[0;39;49ma${ESC}[0;38;2;40;44;52;48;2;220;223;228mb${ESC}[0m${ESC}[20;32H${ESC}[?25l${ESC}[?2026l`;

const cands = [];
const units = [];
const o = createInkCaretObserver({ onCandidate: c => cands.push(c), onUnit: u => units.push(u) });

// Feed one token at a time so we can print state transitions.
let i = 0;
const tokens = [];
while (i < unit.length) {
  const esc = unit.indexOf(ESC, i);
  if (esc < 0) { tokens.push(unit.slice(i)); break; }
  if (esc > i) tokens.push(unit.slice(i, esc));
  let j = esc + 1;
  if (unit[j] === '[') {
    j += 1;
    while (j < unit.length && !/[A-Za-z]/.test(unit[j])) j += 1;
    j += 1;
  } else {
    while (j < unit.length && !(unit[j] === ESC && unit[j + 1] === '\\')) j += 1;
    j += 2;
  }
  tokens.push(unit.slice(esc, j));
  i = j;
}
for (const t of tokens) {
  o.push(t);
  console.log(JSON.stringify(t).slice(0, 60), '->', JSON.stringify(o.state()));
}
console.log('candidates:', JSON.stringify(cands));
