// One-shot patcher: insert a process.on('exit') tree-kill guard right after
// the `const child = spawn(` statement in the probe scripts, so ANY exit path
// (crash, unhandled rejection, normal exit) kills the zterm process tree.
// Without it, crashed probes orphan PTY bash/OpenConsole children which hold
// cygwin console slots (128 max) and break new Git Bash sessions.
import { readFileSync, writeFileSync } from 'node:fs';

const GUARD = [
  '',
  '// Tree-kill on every exit path (normal exit, process.exit, crash): a leaked',
  '// zterm process tree orphans PTY bash/OpenConsole children, and orphaned',
  '// MSYS2 processes hold cygwin console slots until new Git Bash sessions die',
  '// with "console device allocation failure" (128-console cygwin limit).',
  'process.on(\'exit\', () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: \'ignore\' }); } catch {} });',
].join('\n');

const files = process.argv.slice(2);
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  if (src.includes("process.on('exit'")) { console.log(`skip (already patched): ${f}`); continue; }
  const at = src.indexOf('const child = spawn(');
  if (at < 0) { console.error(`no spawn anchor: ${f}`); process.exitCode = 1; continue; }
  const close = src.indexOf('});', at);
  if (close < 0) { console.error(`no spawn close: ${f}`); process.exitCode = 1; continue; }
  const insertAt = close + 3;
  src = src.slice(0, insertAt) + '\n' + GUARD + src.slice(insertAt);
  writeFileSync(f, src);
  console.log(`patched: ${f}`);
}
