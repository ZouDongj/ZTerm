// ZTerm - SSH attempt identity registry (batch 02 approved design).
//
// One connection attempt has an immutable identity independent of the UI
// tab/pane address that happens to display it:
//   token     `att_<epoch>_<n>`, created by the renderer at the single point
//             a connect is initiated; unique across renderer instances (the
//             epoch is cryptographically random per instance), never reused,
//             never derived from a display id.
//   backendId `ssh_N`, assigned by the main process before the connecting
//             event is emitted; authoritative once known.
// Migrations transfer ownership; reconnect/retry/clone/new sessions create a
// NEW attempt and explicitly cancel the old one.
//
// The registry separates three concerns that must not be conflated:
//   ownership    which wrapper awaits the attempt (survives the first backend
//                claim while the invocation is pending, transfers with the
//                session through promotions/extracts/collapses)
//   rpc state    whether the OWN `ipcRenderer.invoke('ssh-connect')` promise
//                settled (ok/failed/cancelled) — settles only its queue slot
//   ui state     whether the lifecycle UI (claim, connected banner, failure)
//                has been applied — idempotently, by whichever of the event
//                channel or the invocation result arrives FIRST
// A record retires (owner cleared, moved to the finished map) only when BOTH
// the rpc and ui sides reached a terminal state. The 20s slot fallback
// releases the queue slot ONLY: the record stays addressable, cancellable
// and able to route a legitimate late success.
//
// Pure registry: no IPC, no DOM. The UI application of an rpc terminal state
// is injected by ipc.js through setRpcApplier so both channels share ONE
// idempotent transition. Dual export for node:test.

const SshAttempts = (() => {
    // Cryptographically random per-renderer-instance epoch: a WebView reload
    // restarts the counter, but a fresh epoch keeps tokens unique across
    // renderer instances sharing one backend process. No time/random-weak
    // fallback is presented as guaranteed uniqueness; the test seam can
    // inject a deterministic factory instead.
    function _epoch() {
        const c = (typeof crypto !== 'undefined') ? crypto : null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        if (c && typeof c.getRandomValues === 'function') {
            const b = new Uint8Array(16);
            c.getRandomValues(b);
            return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('ssh-attempts: no cryptographic randomness available');
    }
    let _epochId = null; // computed lazily on first use (load order safety)
    let _counter = 0;
    let _idFactory = null;
    function _defaultIdFactory() {
        if (_epochId == null) _epochId = _epoch();
        return 'att_' + _epochId + '_' + (++_counter);
    }

    // Test seam: every token ever created (live + finished), in creation
    // order. Production code must not use this.
    function __tokensForTests() {
        const out = [];
        for (const t of live.keys()) out.push(t);
        for (const t of finished.keys()) out.push(t);
        return out;
    }

    // Not-yet-invoked vs actually-in-flight lifetime: an attempt is UNSENT
    // from creation until its queue slot actually invokes ssh-connect. An
    // unsent attempt has NO native counterpart, so no RPC terminal state can
    // ever arrive for it — cancelling it retires the record immediately
    // (drops the owner binding and resources). An invoked attempt stays
    // addressable after cancellation until its own invocation settles, so a
    // late result is disposed safely. No expiry heuristics.
    function markInvoked(token) {
        const r = record(token);
        if (r) r.invoked = true;
    }

    // live: token -> { owner, backend|null, cancelled, rpcState, rpcKind,
    //                  uiState, uiKind, slotReleased, slotWaiters[] }
    const live = new Map();
    // finished: token -> final kind ('ok'|'failed'|'cancelled'). Owner and
    // backend references are cleared at retirement, so nothing large leaks;
    // the map is bounded by attempts started in this renderer process.
    const finished = new Map();

    let _rpcApplier = null;

    function record(token) { return live.get(token) || null; }

    function _clearOwnerField(rec, token) {
        if (rec.owner && rec.owner._pendingAttempt === token) rec.owner._pendingAttempt = null;
        rec.owner = null;
    }

    function _retireIfDone(rec, token) {
        if (rec.rpcState === 'pending' || rec.uiState !== 'done') return;
        // Clearing the owner's field is conditional on STILL holding this
        // token — a successor attempt may already own the wrapper.
        _clearOwnerField(rec, token);
        if (!finished.has(token)) finished.set(token, rec.uiKind || rec.rpcKind);
        live.delete(token);
    }

    function _detachOwners(token, owner) {
        // Rebinding an owner to a new token detaches the old record's owner
        // pointer first, so a late callback of the old attempt can never
        // reach the successor through the wrapper.
        const prev = owner != null ? owner._pendingAttempt : null;
        if (prev && prev !== token) {
            const old = live.get(prev);
            if (old && old.owner === owner) old.owner = null;
        }
        if (owner != null) owner._pendingAttempt = token;
    }

    function createAttempt(owner) {
        const token = (_idFactory || _defaultIdFactory)();
        const rec = { owner: owner || null, backend: null, cancelled: false, invoked: false,
            rpcState: 'pending', rpcKind: null, uiState: 'inflight', uiKind: null,
            slotReleased: false, slotWaiters: [] };
        live.set(token, rec);
        _detachOwners(token, rec.owner);
        return token;
    }

    function bindOwner(token, owner) {
        const rec = record(token);
        if (!rec || owner == null) return false;
        // Transfer: release the previous wrapper's field only if it still
        // names this token (conditional clear, never a successor's).
        if (rec.owner && rec.owner !== owner && rec.owner._pendingAttempt === token) {
            rec.owner._pendingAttempt = null;
        }
        rec.owner = owner;
        _detachOwners(token, owner);
        return true;
    }

    function transferPendingAttempt(fromOwner, toOwner) {
        if (!fromOwner || fromOwner._pendingAttempt == null) return false;
        return bindOwner(fromOwner._pendingAttempt, toOwner);
    }

    function ownerOf(token) { const r = record(token); return r ? r.owner : null; }
    function ownerAttempt(owner) { return owner ? (owner._pendingAttempt || null) : null; }
    function isCancelled(token) { const r = record(token); return !!r && r.cancelled; }
    function ownerWants(token) {
        const r = record(token);
        return !!r && !r.cancelled && r.owner != null;
    }
    function byBackend(backendId) {
        if (backendId == null) return null;
        for (const [token, r] of live) if (r.backend === backendId) return token;
        return null;
    }

    function noteBackend(token, backendId) {
        const r = record(token);
        if (r && backendId != null && r.backend == null) r.backend = backendId;
    }

    // First connecting-application wins. False for duplicates, for events
    // after an rpc-first success already claimed, and for attempts that are
    // no longer wanted (a late connecting must not regress a connected
    // state or resurrect a cancelled one).
    function beginClaim(token, backendId) {
        const r = record(token);
        if (!r || r.cancelled || r.uiState !== 'inflight') return false;
        noteBackend(token, backendId);
        r.uiState = 'claimed';
        return true;
    }

    // First terminal UI application wins ('ok'|'failed'|'cancelled'); drives
    // retirement when the rpc side is terminal too.
    function finishUi(token, kind) {
        const r = record(token);
        if (!r || r.uiState === 'done') return false;
        r.uiState = 'done';
        r.uiKind = kind;
        _retireIfDone(r, token);
        return true;
    }

    function releaseSlot(token) {
        const r = record(token);
        if (!r || r.slotReleased) return;
        r.slotReleased = true;
        // Copy and clear FIRST: a waiter synchronously calling back into
        // releaseSlot (or the queue's own settle) must not recurse.
        const ws = r.slotWaiters.slice();
        r.slotWaiters.length = 0;
        for (const w of ws) { try { w(); } catch (e) { console.error('[ssh-attempts] slot waiter', e); } }
    }

    // Queue integration: armSlot registers the slot's release fn and returns
    // an idempotent settle(). Release happens exactly once, from whichever
    // comes first: the invocation terminal, a matched cancelAttempt, or the
    // 20s fallback timer. Releasing the slot never retires the attempt.
    function armSlot(token, releaseFn) {
        const r = record(token);
        const settle = () => releaseSlot(token);
        if (!r) { try { releaseFn(); } catch (e) { /* record gone */ } return settle; }
        if (!r.slotReleased) r.slotWaiters.push(releaseFn);
        else { try { releaseFn(); } catch (e) { /* already released */ } }
        return settle;
    }

    // Cancel THE attempt named by token: mark cancelled (our intent), finish
    // its UI side (a cancelled attempt applies no further lifecycle UI) and
    // release its slot. For an UNSENT attempt (never invoked — closed while
    // queued or while credential registration was pending) no RPC terminal
    // state can ever arrive, so the record settles and retires HERE, dropping
    // the owner binding immediately. An invoked attempt stays addressable:
    // its invocation may still settle later, and that callback touches only
    // this record. Never touches any other attempt or a successor's field.
    function cancelAttempt(token) {
        const r = record(token);
        if (!r) return { backend: null, cancelled: false };
        r.cancelled = true;
        if (r.uiState !== 'done') { r.uiState = 'done'; r.uiKind = 'cancelled'; }
        if (!r.invoked && r.rpcState === 'pending') {
            r.rpcState = 'terminal';
            r.rpcKind = 'cancelled';
        }
        releaseSlot(token);
        _retireIfDone(r, token);
        return { backend: r.backend, cancelled: true };
    }

    // Invocation terminal state ('ok'|'failed'|'cancelled'). Idempotent per
    // record; onRpcTerminal itself applies no UI — the registered applier
    // (ipc.js) shares the beginClaim/finishUi guards so either channel may
    // arrive first exactly once.
    function onRpcTerminal(token, kind, backendId, errText) {
        const r = record(token);
        if (!r || r.rpcState !== 'pending') return false;
        r.rpcState = 'terminal';
        r.rpcKind = kind;
        if (kind === 'ok') noteBackend(token, backendId);
        releaseSlot(token);
        _retireIfDone(r, token);
        if (_rpcApplier) { try { _rpcApplier(token, kind, r.backend, errText); } catch (e) { console.error('[ssh-attempts] rpc applier', e); } }
        return true;
    }

    function finalState(token) {
        if (finished.has(token)) return finished.get(token);
        const r = record(token);
        if (r && r.cancelled) return 'cancelled';
        return null;
    }

    function setRpcApplier(fn) { _rpcApplier = fn; }

    function __setAttemptIdFactoryForTests(fn) {
        _idFactory = fn;
    }
    function __resetForTests(epoch) {
        _epochId = epoch || null;
        _counter = 0;
        _idFactory = null;
        live.clear();
        finished.clear();
        _rpcApplier = null;
    }

    return {
        createAttempt, bindOwner, transferPendingAttempt,
        ownerOf, ownerAttempt, byBackend, noteBackend, markInvoked,
        beginClaim, finishUi, cancelAttempt, isCancelled, ownerWants,
        armSlot, releaseSlot, onRpcTerminal, finalState,
        setRpcApplier,
        __setAttemptIdFactoryForTests, __resetForTests, __tokensForTests,
    };
})();

// Global alias for script-scope consumers (renderer.html loads this before
// tabs.js/ipc.js; the const above is module-scoped for the node:test export).
var sshAttempts = SshAttempts;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SshAttempts };
}
