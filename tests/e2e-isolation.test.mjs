import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createE2eSandbox, ownsProcess, restartOwnedApp, seedIsolatedConfig } from '../scripts/e2e-isolation.mjs';

test('E2E copies only the executable into a fresh profile, leaving source config intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-isolation-test-'));
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'zterm.exe'), 'test executable');
    writeFileSync(join(source, 'data', 'config.json'), 'user config sentinel');
    const box = createE2eSandbox(join(source, 'zterm.exe'), root);
    assert.equal(readFileSync(box.exe, 'utf8'), 'test executable');
    assert.equal(existsSync(join(box.directory, 'data', 'config.json')), false);
    assert.equal(existsSync(join(box.appData, 'ZTerm', 'config.json')), false);
    assert.equal(readFileSync(join(source, 'data', 'config.json'), 'utf8'), 'user config sentinel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup requires live owned PID and exact sandbox executable identity', () => {
  const executable = join(tmpdir(), 'owned-zterm', 'zterm.exe');
  const child = { pid: 123, exitCode: null, signalCode: null };
  const actual = { ProcessId: 123, ExecutablePath: executable };
  assert.equal(ownsProcess(child, executable, actual), true);
  assert.equal(ownsProcess(null, executable, actual), false);
  assert.equal(ownsProcess(child, executable, null), false);
  assert.equal(ownsProcess(child, executable, { ...actual, ProcessId: 999 }), false);
  assert.equal(ownsProcess(child, executable, { ...actual, ExecutablePath: join(tmpdir(), 'user', 'zterm.exe') }), false);
  assert.equal(ownsProcess({ ...child, exitCode: 0 }, executable, actual), false);
});

test('restart never replaces ownership when cleanup or port teardown failed', async () => {
  const calls = [];
  await assert.rejects(restartOwnedApp({ stop: () => false,
    waitUntilQuiet: async () => calls.push('quiet'), start: () => calls.push('start') }), /refusing restart/);
  assert.deepEqual(calls, []);
  await assert.rejects(restartOwnedApp({ stop: () => true,
    waitUntilQuiet: async () => { throw new Error('port occupied'); }, start: () => calls.push('start') }), /port occupied/);
  assert.deepEqual(calls, []);
  await restartOwnedApp({ stop: () => { calls.push('stop'); return true; },
    waitUntilQuiet: async () => calls.push('quiet'), start: () => calls.push('start') });
  assert.deepEqual(calls, ['stop', 'quiet', 'start']);
});

test('seedIsolatedConfig aborts before seeding when the anchor sets a custom dataDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-seed-test-'));
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'zterm.exe'), 'test executable');
    const box = createE2eSandbox(join(source, 'zterm.exe'), root);
    const appData = join(root, 'fake-appdata');
    mkdirSync(join(appData, 'ZTerm'), { recursive: true });
    writeFileSync(join(appData, 'ZTerm', 'config.json'), JSON.stringify({ dataDir: join(root, 'real-data') }));
    assert.throws(() => seedIsolatedConfig(box, appData), /dataDir/);
    assert.equal(existsSync(join(box.directory, 'data', 'config.json')), false, 'aborted before seeding');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seedIsolatedConfig seeds an empty config and never overwrites an existing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-seed-test-'));
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'zterm.exe'), 'test executable');
    const box = createE2eSandbox(join(source, 'zterm.exe'), root);
    const appData = join(root, 'fake-appdata'); // no anchor at all
    const target = seedIsolatedConfig(box, appData);
    assert.equal(readFileSync(target, 'utf8').trim(), '{}');
    writeFileSync(target, 'sentinel');
    seedIsolatedConfig(box, appData);
    assert.equal(readFileSync(target, 'utf8'), 'sentinel', 'existing config untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
