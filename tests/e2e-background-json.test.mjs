import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { E2E_TMP_ROOT, registerExitCleanup } from '../scripts/e2e-isolation.mjs';
import { writeBackgroundJson } from '../scripts/e2e-background-json.mjs';
import { BACKGROUND_CLOCK_DOMAIN, createBackgroundLease, validateFreshDesktopSnapshot,
  validateNativeHostHealth } from '../scripts/e2e-background-policy.mjs';

let directory;
let readerExe;
let fixtureCount = 0;
function fixture() {
  if (!directory) {
    fs.mkdirSync(E2E_TMP_ROOT, { recursive: true });
    directory = registerExitCleanup(fs.mkdtempSync(join(E2E_TMP_ROOT, 'inert-background-json-')));
  }
  const path = join(directory, `background-fixture-${fixtureCount++}.lease.json`);
  writeBackgroundJson(path, { renewedAt: 1 });
  return path;
}

async function reader(path) {
  if (!readerExe) {
    const source = join(directory, 'reader.rs');
    readerExe = join(directory, 'reader.exe');
    fs.writeFileSync(source, `use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(!std::fs::read_to_string(&args[1]).unwrap().is_empty());
    // Force contention independently of default Windows reader sharing.
    let mut file = std::fs::OpenOptions::new().read(true).share_mode(3).open(&args[1]).unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    println!("ready");
    std::io::stdout().flush().unwrap();
    let mut release = [0];
    std::io::stdin().read_exact(&mut release).unwrap();
    drop(file);
}
`);
    execFileSync('rustc', ['--edition=2021', source, '-o', readerExe], { windowsHide: true, timeout: 30000,
      cwd: directory, env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory } });
  }
  const child = spawn(readerExe, [path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inert file reader did not become ready')), 3000);
      child.stdout.once('data', bytes => {
        clearTimeout(timer);
        if (String(bytes).trim() === 'ready') resolve();
        else reject(new Error('Unexpected inert file reader output'));
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Inert file reader exited ${code}: ${stderr}`)); });
    });
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
  return child;
}

test('a persistent replacement lock stays fail-closed and preserves the previous lease',
  { skip: process.platform !== 'win32' }, async () => {
    const path = fixture();
    const child = await reader(path);
    try {
      const started = performance.now();
      assert.throws(() => writeBackgroundJson(path, { renewedAt: 2 }, () => {}), { code: 'EPERM' });
      assert.ok(performance.now() - started < 250, 'Contention handling must have a short fixed bound');
      assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { renewedAt: 1 });
    } finally { await releaseReader(child); }
  });

for (const stale of ['observer', 'native']) test(`stale ${stale} proof during contention cannot publish the prepared lease`,
  { skip: process.platform !== 'win32' }, async () => {
    const path = fixture();
    const child = await reader(path);
    const originalRename = fs.renameSync;
    let now = 10000;
    const desktop = { ok: true, clockDomain: BACKGROUND_CLOCK_DOMAIN,
      currentDesktopId: '11111111-1111-1111-1111-111111111111',
      targetDesktopId: '22222222-2222-2222-2222-222222222222',
      foregroundHwnd: '0x1234', foregroundPid: 10, foregroundOwnerPids: [10], observedAt: now };
    const binding = { token: 'fixture-token', pid: 20, hwnd: '0x5678', targetDesktopId: desktop.targetDesktopId };
    const status = { ...binding, clockDomain: BACKGROUND_CLOCK_DOMAIN, phase: 'shown', disabled: true,
      noActivate: true, visible: true, minimized: false, onCurrentDesktop: false, onTargetDesktop: true, checkedAt: now };
    let checks = 0;
    try {
      fs.renameSync = (from, to) => {
        try { return originalRename(from, to); }
        catch (error) {
          assert.equal(error.code, 'EPERM');
          now += 1501;
          if (stale === 'observer') status.checkedAt = now;
          else desktop.observedAt = now;
          if (!child.stdin.writableEnded) child.stdin.end('x');
          throw error;
        }
      };
      syncBuiltinESMExports();
      assert.throws(() => writeBackgroundJson(path, createBackgroundLease(binding, now), () => {
        checks++;
        validateFreshDesktopSnapshot(desktop, now);
        validateNativeHostHealth(status, binding, now);
      }), stale === 'observer' ? /Fresh background observer proof/ : /Fresh owned native guard proof/);
      assert.equal(checks, 2);
      assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { renewedAt: 1 });
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
      await releaseReader(child);
    }
  });
async function releaseReader(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  if (!child.stdin.writableEnded) child.stdin.end('x');
  await exited;
}

test('a transient Windows replacement lock does not abort a healthy atomic lease renewal',
  { skip: process.platform !== 'win32' }, async () => {
    const path = fixture();
    const child = await reader(path);
    const originalRename = fs.renameSync;
    const lease = createBackgroundLease({ token: 'fixture-token', pid: 20, hwnd: '0x5678' }, 10000);
    let contentions = 0;
    try {
      fs.renameSync = (from, to) => {
        try { return originalRename(from, to); }
        catch (error) {
          assert.equal(error.code, 'EPERM');
          contentions++;
          if (!child.stdin.writableEnded) child.stdin.end('x');
          throw error;
        }
      };
      syncBuiltinESMExports();
      writeBackgroundJson(path, lease, () => {});
      assert.ok(contentions > 0, 'The real Windows rename must encounter the held file lock');
      assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), lease);
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
      await releaseReader(child);
    }
  });

test('non-sharing errors are not retried', () => {
  const path = fixture();
  const originalRename = fs.renameSync;
  let attempts = 0;
  try {
    fs.renameSync = () => { attempts++; throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    assert.throws(() => writeBackgroundJson(path, { renewedAt: 2 }, () => {}), { code: 'EIO' });
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { renewedAt: 1 });
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});
