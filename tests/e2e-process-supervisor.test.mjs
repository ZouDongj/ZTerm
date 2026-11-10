import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { E2E_TMP_ROOT, registerExitCleanup } from '../scripts/e2e-isolation.mjs';
import { readOwnProcessStartMs } from '../scripts/e2e-process-supervisor.mjs';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 30000 };
const supervisorUrl = new URL('../scripts/e2e-process-supervisor.mjs', import.meta.url).href;
const policyUrl = new URL('../scripts/e2e-background-policy.mjs', import.meta.url).href;
const retryUrl = new URL('../scripts/e2e-desktop-retry.mjs', import.meta.url).href;
mkdirSync(E2E_TMP_ROOT, { recursive: true });
const root = registerExitCleanup(mkdtempSync(join(E2E_TMP_ROOT, 'real-process-supervisor-')));
const worker = join(root, 'worker.mjs');
const tree = join(root, 'tree.mjs');
const outer = join(root, 'outer.mjs');
const retry = join(root, 'retry.mjs');
const exit = join(root, 'exit.mjs');
let sequence = 0;

writeFileSync(worker, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.env.RENDERER_FILE) {
  const child = spawn(process.execPath, [process.env.WORKER_FILE], {
    stdio: 'ignore', windowsHide: true,
    env: { ...process.env, RENDERER_FILE: '', WORKER_READY: '' },
  });
  writeFileSync(process.env.RENDERER_FILE, JSON.stringify({ pid: child.pid }));
}
if (process.env.WORKER_READY) writeFileSync(process.env.WORKER_READY, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
`);
writeFileSync(tree, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const treeFile = process.argv[2];
const host = spawn(process.execPath, [process.env.WORKER_FILE], { stdio: 'ignore', windowsHide: true });
const browser = spawn(process.execPath, [process.env.WORKER_FILE], {
  stdio: 'ignore', windowsHide: true,
  env: { ...process.env, RENDERER_FILE: treeFile + '.renderer.json' },
});
writeFileSync(treeFile, JSON.stringify({ ownerPid: process.pid, hostPid: host.pid, browserPid: browser.pid }));
`);
writeFileSync(exit, `process.exit(Number(process.env.FIXTURE_EXIT_CODE || '0'));\n`);
writeFileSync(outer, `import { writeFileSync } from 'node:fs';
import { runSupervisedScript } from ${JSON.stringify(supervisorUrl)};
const [statusFile, innerScript, treeFile, resultFile] = process.argv.slice(2);
const code = await runSupervisedScript({
  script: innerScript,
  args: innerScript.endsWith('tree.mjs') ? [treeFile] : [],
  main: async () => { throw new Error('outer fixture unexpectedly bypassed supervision'); },
  env: { ...process.env, ZTERM_E2E_PROCESS_SUPERVISOR: '', TREE_FILE: treeFile, WORKER_FILE: ${JSON.stringify(worker)} },
  tempRoot: ${JSON.stringify(root)},
  onSpawn: ({ pid }) => writeFileSync(statusFile, JSON.stringify({ outerPid: process.pid, watchdogPid: pid })),
});
writeFileSync(resultFile, JSON.stringify({ code }));
process.exit(code);
`);
writeFileSync(retry, `import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopObserverTransientError } from ${JSON.stringify(policyUrl)};
import { respawnDesktopProcess, runWithDesktopRetry } from ${JSON.stringify(retryUrl)};
const treeFile = process.env.TREE_FILE;
const old = spawn(process.execPath, [process.env.WORKER_FILE], { stdio: 'ignore', windowsHide: true });
writeFileSync(treeFile + '.old.json', JSON.stringify({ pid: old.pid }));
const code = await runWithDesktopRetry({
  main: async () => { throw new DesktopObserverTransientError(); },
  cleanup: async () => {
    await sleep(2000);
    if (old.exitCode === null && old.signalCode === null) {
      const exited = once(old, 'exit');
      if (!old.kill()) return { ok: false, reasons: ['fixture old child kill failed'] };
      await exited;
    }
    return true;
  },
  respawn: () => respawnDesktopProcess({
    script: ${JSON.stringify(tree)}, args: [treeFile], env: process.env,
  }),
});
writeFileSync(treeFile + '.retry-result.json', JSON.stringify({ code, oldExitCode: old.exitCode }));
process.exit(code);
`);

async function waitFor(predicate, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch {}
    await sleep(25);
  }
  throw new Error('Timed out waiting for ' + description);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pin(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  return { pid, startedAt: readOwnProcessStartMs(pid) };
}

function isCurrent({ pid, startedAt }) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  return readOwnProcessStartMs(pid) === startedAt;
}

async function waitIdentityGone(identity, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(identity.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await sleep(25);
  }
  assert.equal(isCurrent(identity), false, `pid ${identity.pid} survived or its identity became unreadable`);
}

async function killCurrent(identity) {
  if (!isCurrent(identity)) return;
  process.kill(identity.pid, 'SIGKILL');
  await waitIdentityGone(identity);
}

async function launch(inner, { withTree = true, pinOld = false, env = {} } = {}) {
  const id = sequence++;
  const prefix = join(root, `run-${id}-`);
  const treeFile = prefix + 'tree.json';
  const statusFile = prefix + 'outer.json';
  const resultFile = prefix + 'result.json';
  const child = spawn(process.execPath, [outer, statusFile, inner, treeFile, resultFile], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, TREE_FILE: treeFile, WORKER_FILE: worker, ...env },
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.on('data', () => {});
  const closed = once(child, 'close');
  const context = { child, closed, treeFile, statusFile, resultFile, identities: [], stderr: () => stderr };
  try {
    await waitFor(() => existsSync(statusFile) && readJson(statusFile), 'outer/watchdog identity');
    const status = readJson(statusFile);
    context.watchdogPid = status.watchdogPid;
    if (pinOld) {
      const old = await waitFor(() => existsSync(treeFile + '.old.json') && readJson(treeFile + '.old.json'), 'old child');
      context.identities.push(pin(old.pid));
    }
    if (withTree) context.identities.push(pin(status.watchdogPid));
    if (withTree) {
      await waitFor(() => existsSync(treeFile) && readJson(treeFile), 'process tree');
      await waitFor(() => existsSync(treeFile + '.renderer.json') && readJson(treeFile + '.renderer.json'), 'grandchild');
      const value = readJson(treeFile);
      const renderer = readJson(treeFile + '.renderer.json');
      for (const pid of [status.outerPid, value.ownerPid, value.hostPid, value.browserPid, renderer.pid]) {
        context.identities.push(pin(pid));
      }
      context.ownerPid = value.ownerPid;
    }
    return context;
  } catch (error) {
    error.message += `\nfixture stderr: ${stderr}`;
    await dispose(context);
    throw error;
  }
}

async function dispose(context) {
  for (const identity of context.identities) {
    try { await killCurrent(identity); } catch {}
  }
  if (context.child.exitCode === null && context.child.signalCode === null) context.child.kill('SIGKILL');
  await context.closed;
  await Promise.all(context.identities.map(identity => waitIdentityGone(identity).catch(() => {})));
}

async function launchForeign() {
  // This is a direct child of the test runner and is never assigned to the per-run job.
  const child = spawn(process.execPath, [worker], { stdio: 'ignore', windowsHide: true });
  return { child, closed: once(child, 'close'), identity: pin(child.pid) };
}

async function disposeForeign(foreign) {
  await killCurrent(foreign.identity);
  await foreign.closed;
}

test('supervisor propagates normal and nonzero child exits', windowsOnly, async () => {
  for (const expected of [0, 7]) {
    const context = await launch(exit, { withTree: false, env: { FIXTURE_EXIT_CODE: String(expected) } });
    try {
      const [code, signal] = await context.closed;
      assert.equal(code, expected, context.stderr());
      assert.equal(signal, null);
      assert.equal(readJson(context.resultFile).code, expected);
    } finally { await dispose(context); }
  }
});

test('SIGKILL of the outer parent reaps only the supervised tree', windowsOnly, async () => {
  const context = await launch(tree);
  const foreign = await launchForeign();
  try {
    assert.equal(context.child.kill('SIGKILL'), true);
    const [, signal] = await context.closed;
    assert.equal(signal, 'SIGKILL');
    await Promise.all(context.identities.map(identity => waitIdentityGone(identity)));
    assert.equal(isCurrent(foreign.identity), true, 'the foreign process must remain alive');
  } finally { await Promise.all([dispose(context), disposeForeign(foreign)]); }
});

test('SIGKILL of the supervised child propagates failure and spares a foreign process', windowsOnly, async () => {
  const context = await launch(tree);
  const foreign = await launchForeign();
  try {
    process.kill(context.ownerPid, 'SIGKILL');
    const [code] = await context.closed;
    assert.notEqual(code, 0, context.stderr());
    await Promise.all(context.identities.map(identity => waitIdentityGone(identity)));
    assert.equal(isCurrent(foreign.identity), true, 'the foreign process must remain alive');
  } finally { await Promise.all([dispose(context), disposeForeign(foreign)]); }
});

test('SIGKILL of the watchdog itself closes the job and spares a foreign process', windowsOnly, async () => {
  const context = await launch(tree);
  const foreign = await launchForeign();
  try {
    process.kill(context.watchdogPid, 'SIGKILL');
    const [code] = await context.closed;
    assert.notEqual(code, 0, context.stderr());
    await Promise.all(context.identities.map(identity => waitIdentityGone(identity)));
    assert.equal(isCurrent(foreign.identity), true, 'the foreign process must remain alive');
  } finally { await Promise.all([dispose(context), disposeForeign(foreign)]); }
});

test('SIGKILL of the direct retry child propagates failure and reaps its new tree', windowsOnly, async () => {
  const context = await launch(retry, { pinOld: true });
  try {
    process.kill(context.ownerPid, 'SIGKILL');
    const [code] = await context.closed;
    assert.notEqual(code, 0, context.stderr());
    assert.equal(readJson(context.treeFile + '.retry-result.json').code, code);
    await Promise.all(context.identities.map(identity => waitIdentityGone(identity)));
  } finally { await dispose(context); }
});

test.after(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});
