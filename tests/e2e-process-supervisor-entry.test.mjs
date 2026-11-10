import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESS_SUPERVISOR_ENV, runSupervisedScript } from '../scripts/e2e-process-supervisor.mjs';

test('only the marked supervised child executes the main entry', async () => {
  let preflights = 0;
  const code = await runSupervisedScript({
    main: async () => 7,
    preflight: async () => { preflights++; },
    env: { [PROCESS_SUPERVISOR_ENV]: '1' },
    spawnProcess: () => { throw new Error('supervised child must not spawn another watchdog'); },
  });
  assert.equal(code, 7);
  assert.equal(preflights, 0);
});

test('preflight failure prevents supervisor and main startup', async () => {
  let mainCalls = 0;
  const reports = [];
  const code = await runSupervisedScript({
    main: async () => { mainCalls++; },
    preflight: async () => { throw new Error('fixture preflight failure'); },
    env: {},
    report: message => reports.push(message),
  });
  assert.equal(code, 1);
  assert.equal(mainCalls, 0);
  assert.match(reports.join('\n'), /fixture preflight failure/);
});

test('supervised main errors propagate as failure with their real reason', async () => {
  const reports = [];
  const code = await runSupervisedScript({
    main: async () => { throw new Error('fixture main failure'); },
    env: { [PROCESS_SUPERVISOR_ENV]: '1' },
    report: message => reports.push(message),
  });
  assert.equal(code, 1);
  assert.match(reports.join('\n'), /fixture main failure/);
});
