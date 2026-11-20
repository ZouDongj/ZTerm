// Syntax gate for every first-party script. The CI frontend job used to
// hard-code a `node --check` line per renderer file, so a newly added module
// could silently escape the check. This test discovers the files instead:
// scripts loaded by src/renderer.html (including src/ipc-polyfill.js), every
// src/renderer/*.js, and every scripts/*.mjs. One test per file keeps a
// failure attributable to its exact path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this module, never from cwd: `node --test` may run from any
// working directory.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function filesIn(directory, extension) {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => `${directory}/${entry.name}`);
}

// Scripts the renderer page actually loads. Vendor bundles are excluded:
// third-party distributions are not ours to syntax-check.
const pageScripts = [...readFileSync(join(repoRoot, 'src', 'renderer.html'), 'utf8').matchAll(/<script[^>]*\bsrc="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((src) => !src.startsWith('vendor/'))
  .map((src) => `src/${src}`);

const files = [...new Set([
  'src/ipc-polyfill.js',
  ...pageScripts,
  ...filesIn('src/renderer', '.js'),
  ...filesIn('scripts', '.mjs'),
])].sort();

test('syntax gate discovers the frontend scripts and Node scripts', () => {
  assert.ok(files.includes('src/ipc-polyfill.js'));
  assert.ok(files.includes('src/renderer/main.js'));
  assert.ok(files.includes('scripts/e2e-check.mjs'));
  assert.ok(files.every((file) => file.endsWith('.js') || file.endsWith('.mjs')));
});

for (const file of files) {
  test(`node --check ${file}`, () => {
    execFileSync(process.execPath, ['--check', join(repoRoot, file)], { stdio: 'pipe' });
  });
}
