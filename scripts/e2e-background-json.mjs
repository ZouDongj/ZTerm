import { renameSync, writeFileSync } from 'node:fs';

const RENAME_RETRY_LIMIT_MS = 100;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function writeBackgroundJson(path, value, assertHealthy) {
  const deadline = performance.now() + RENAME_RETRY_LIMIT_MS;
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), 'utf8');
  let failure;
  for (;;) {
    assertHealthy?.();
    if (failure && performance.now() >= deadline) throw failure;
    try { renameSync(temporary, path); return; }
    catch (error) {
      // Windows can reject replacement while a default read handle is open.
      // Only a lease with rechecked health may retry its unchanged timestamp.
      if (!assertHealthy || process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      failure = error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      Atomics.wait(retryWait, 0, 0, Math.min(5, remaining));
    }
  }
}
