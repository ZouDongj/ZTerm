import { spawn } from 'node:child_process';
import { processExitCode } from './e2e-process-supervisor.mjs';

export const DESKTOP_RETRY_ENV = 'ZTERM_E2E_DESKTOP_RETRY';
const TRANSIENT_CODE = 'ZTERM_E2E_DESKTOP_OBSERVER_TRANSIENT';

function failureText(error) {
  return error?.stack || error?.message || String(error);
}

export async function runWithDesktopRetry({ main, cleanup, respawn, env = process.env,
  report = message => console.error(message) }) {
  let failure;
  try {
    await main();
    return 0;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  let stopped;
  try {
    stopped = await cleanup();
  } catch (error) {
    report(`E2E 失败: ${failureText(failure)}`);
    report(`[e2e] owned cleanup failed: ${failureText(error)}`);
    return 1;
  }
  if (stopped !== true) {
    report(`E2E 失败: ${failureText(failure)}`);
    const reasons = Array.isArray(stopped?.reasons) ? stopped.reasons.join('; ') : 'unknown cleanup result';
    report(`[e2e] owned cleanup incomplete; refusing a fresh-process retry: ${reasons}`);
    return 1;
  }

  if (failure.code !== TRANSIENT_CODE || env[DESKTOP_RETRY_ENV] === '1') {
    report(`E2E 失败: ${failureText(failure)}`);
    return 1;
  }

  report(`[e2e] ${failure.message}; retrying once in a fresh process and sandbox after owned cleanup`);
  try {
    const code = await respawn();
    return Number.isInteger(code) ? code : 1;
  } catch (error) {
    report(`[e2e] fresh-process retry failed to start: ${failureText(error)}`);
    return 1;
  }
}

export function respawnDesktopProcess({ script, args = [], env = process.env, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [script, ...args], {
      stdio: 'inherit', windowsHide: true, env: { ...env, [DESKTOP_RETRY_ENV]: '1' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(processExitCode(code, signal)));
  });
}
