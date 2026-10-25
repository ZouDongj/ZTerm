import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_TMP_ROOT, registerExitCleanup } from '../scripts/e2e-isolation.mjs';
import { BACKGROUND_PROTOCOL_MARKER, requireBackgroundCapability } from '../scripts/e2e-background-capability.mjs';

function fixture(bytes) {
  mkdirSync(E2E_TMP_ROOT, { recursive: true });
  const directory = registerExitCleanup(mkdtempSync(join(E2E_TMP_ROOT, 'inert-capability-')));
  const executable = join(directory, 'fixture.exe');
  writeFileSync(executable, bytes);
  return executable;
}

test('capability scanning finds the versioned marker across stream chunk boundaries', async () => {
  const marker = Buffer.from(BACKGROUND_PROTOCOL_MARKER);
  const executable = fixture(Buffer.concat([Buffer.alloc(64 * 1024 - 7), marker, Buffer.alloc(64)]));
  await assert.doesNotReject(requireBackgroundCapability(executable));
});

test('old, empty, and differently versioned artifacts require a rebuild', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('inert legacy executable'),
    Buffer.from(BACKGROUND_PROTOCOL_MARKER.replace('_V1_', '_V0_'))]) {
    await assert.rejects(requireBackgroundCapability(fixture(bytes)), /Rebuild with npm run build:release/);
  }
});

test('the real harness rejects an unsupported artifact before launching any child', async () => {
  const executable = fixture(Buffer.from('inert unsupported executable'));
  const saved = Object.fromEntries(['spawn', 'execFile', 'execFileSync', 'execSync'].map(name => [name, childProcess[name]]));
  const argv = process.argv;
  const exit = process.exit;
  const consoleError = console.error;
  const desktop = process.env.ZTERM_E2E_DESKTOP;
  const exitListeners = new Set(process.listeners('exit'));
  const calls = [], errors = [];
  let finish, timer;
  const stopped = new Promise(resolve => { finish = resolve; });
  try {
    for (const name of Object.keys(saved)) childProcess[name] = (...args) => {
      calls.push({ name, executable: args[0] });
      throw new Error('Inert test forbids every child process');
    };
    syncBuiltinESMExports();
    process.argv = [argv[0], 'scripts/e2e-check.mjs', executable];
    process.env.ZTERM_E2E_DESKTOP = '2';
    process.exit = code => { finish(code); };
    console.error = (...values) => errors.push(values.join(' '));
    await import('../scripts/e2e-check.mjs');
    const code = await Promise.race([stopped, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Harness did not reject the unsupported artifact')), 3000);
    })]);
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /Rebuild with npm run build:release/);
    assert.deepEqual(calls, []);
  } finally {
    clearTimeout(timer);
    Object.assign(childProcess, saved);
    syncBuiltinESMExports();
    process.argv = argv;
    process.exit = exit;
    console.error = consoleError;
    if (desktop === undefined) delete process.env.ZTERM_E2E_DESKTOP;
    else process.env.ZTERM_E2E_DESKTOP = desktop;
    for (const listener of process.listeners('exit')) if (!exitListeners.has(listener)) process.removeListener('exit', listener);
  }
});
