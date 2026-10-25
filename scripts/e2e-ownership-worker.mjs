import { parentPort, workerData } from 'node:worker_threads';
import { verifyCdpEndpointOwnership } from './e2e-isolation.mjs';

// Reuse the existing identity rules verbatim; only their blocking OS queries
// move off the supervisor that consumes observer samples and renews leases.
try {
  const verdict = verifyCdpEndpointOwnership(workerData.port, workerData.child,
    workerData.executable, workerData.sandboxDirectory);
  parentPort.postMessage({ kind: 'ownership', verdict });
} catch (error) {
  parentPort.postMessage({ kind: 'error', message: error.message, stack: error.stack });
}
