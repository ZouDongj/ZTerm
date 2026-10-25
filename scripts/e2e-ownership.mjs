import { Worker } from 'node:worker_threads';
import { acquireVerifiedPage } from './e2e-isolation.mjs';
import { Cdp } from './e2e-cdp.mjs';

export function createOwnedHostGuard({ child, signal, isCurrent = () => true, assertHealthy = () => {} }) {
  const pid = child?.pid;
  return () => {
    if (signal?.aborted) throw signal.reason || new Error('Owned endpoint verification cancelled');
    if (!isCurrent() || !child || !Number.isInteger(pid) || pid <= 0 || child.pid !== pid
        || child.exitCode !== null || child.signalCode != null) {
      throw new Error('Owned endpoint verification belongs to an obsolete or exited host');
    }
    assertHealthy();
  };
}

export function verifyEndpointOffThread({ port, child, executable, sandboxDirectory, signal,
  isCurrent, assertHealthy, timeoutMs = 30000,
  createWorker = data => new Worker(new URL('./e2e-ownership-worker.mjs', import.meta.url), { workerData: data }) }) {
  const guard = createOwnedHostGuard({ child, signal, isCurrent, assertHealthy });
  return new Promise((resolve, reject) => {
    let worker, timer;
    let settled = false;
    function finish(error, verdict) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A late result from a cancelled worker can never revive this decision.
      worker?.unref?.();
      try { Promise.resolve(worker?.terminate()).catch(() => {}); } catch {}
      error ? reject(error) : resolve(verdict);
    }
    function onAbort() { finish(signal.reason || new Error('Owned endpoint verification cancelled')); }
    try {
      guard();
      worker = createWorker({ port, child: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode },
        executable, sandboxDirectory });
      worker.on('message', message => {
        if (settled) return;
        try {
          guard();
          if (message?.kind === 'error') {
            const error = new Error(message.message || 'Owned endpoint worker failed');
            if (message.stack) error.stack += '\nWorker: ' + message.stack;
            throw error;
          }
          if (message?.kind !== 'ownership') throw new Error('Owned endpoint worker returned incomplete proof');
          finish(null, message.verdict);
        } catch (error) { finish(error); }
      });
      worker.on('error', error => finish(error));
      worker.on('exit', code => finish(new Error('Owned endpoint worker exited without proof: ' + code)));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish(new Error('Owned endpoint verification timed out')), timeoutMs);
    } catch (error) { finish(error); }
  });
}

export async function connectVerifiedEndpoint({ discover, port, child, executable, sandboxDirectory,
  signal, isCurrent, assertHealthy, createWorker, WebSocketImpl, onDuration = () => {} }) {
  const context = { child, signal, isCurrent, assertHealthy };
  const guard = createOwnedHostGuard(context);
  guard();
  const wsUrl = await acquireVerifiedPage({
    discover, expectedPort: port,
    verify: async verifiedPort => {
      const started = performance.now();
      let outcome = 'error';
      try {
        const verdict = await verifyEndpointOffThread({ ...context, port: verifiedPort,
          executable, sandboxDirectory, createWorker });
        outcome = verdict === true ? 'owned' : 'refused';
        return verdict;
      } finally {
        onDuration({ pid: child.pid, port, elapsedMs: Math.round(performance.now() - started), outcome });
      }
    },
  });
  // Recheck the original handle and generation at the actual socket boundary.
  guard();
  const cdp = new Cdp(wsUrl, { assertHealthy: guard, signal, WebSocketImpl });
  await cdp.connect();
  return cdp;
}
