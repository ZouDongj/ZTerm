export function createOwnedCleanupCoordinator({ stopBackgroundObserver, cleanOwnedRuntime }) {
  let cleanupPromise = null;

  function killExisting() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const observerStopping = stopBackgroundObserver();
      let runtimeResult;
      let runtimeError = null;
      try { runtimeResult = cleanOwnedRuntime(); } catch (error) { runtimeError = error; }
      const observerResult = await observerStopping;
      if (runtimeError) throw runtimeError;
      if (runtimeResult === true) return observerResult;
      if (observerResult !== true) {
        return {
          ok: false,
          reasons: [...runtimeResult.reasons, ...observerResult.reasons],
          hostDisposition: runtimeResult.hostDisposition,
        };
      }
      return runtimeResult;
    })();
    return cleanupPromise;
  }

  async function beginNextRun() {
    if (cleanupPromise) {
      const result = await cleanupPromise;
      if (result !== true) return result;
    }
    cleanupPromise = null;
    return true;
  }

  return { killExisting, beginNextRun };
}
