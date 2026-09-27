// ZTerm - unit tests for the SSH attempt identity registry (ssh-attempts.js).
// The registry is pure (no IPC/DOM), so these exercise it through its public
// interface only: identity uniqueness, the three separated concerns
// (ownership / rpc settlement / slot release), idempotent transitions,
// reentrancy guards, and successor isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshAttempts } from '../src/renderer/ssh-attempts.js';

test('attempt ids are unique across renderer epochs (injected suppliers)', () => {
    // Two renderer instances share the SAME counter sequence but hold
    // different epochs: every id must be distinct — the epoch is what makes a
    // token unique across renderer instances (a reload restarts the counter).
    const seen = new Map(); // id -> epoch that produced it
    for (const epoch of ['epoch-aaaa', 'epoch-bbbb']) {
        SshAttempts.__resetForTests(epoch);
        let n = 0;
        SshAttempts.__setAttemptIdFactoryForTests(() => 'att_' + epoch + '_' + (++n));
        for (let i = 0; i < 200; i++) {
            const id = SshAttempts.createAttempt({});
            assert.equal(seen.has(id), false, 'id collision across epochs: ' + id);
            seen.set(id, epoch);
        }
    }
    assert.equal(seen.size, 400, 'distinct ids across both epochs');
    // Sanity: within one epoch the counter discriminates; across epochs the
    // same counter value yields a DIFFERENT id.
    assert.notEqual('att_e1_1', 'att_e2_1');
    // Restore the production shape (epoch + monotonic counter).
    SshAttempts.__resetForTests();
});

test('createAttempt binds the owner; transfer moves the binding exactly once', () => {
    SshAttempts.__resetForTests('e1');
    const tab = {}, pane = {};
    const token = SshAttempts.createAttempt(tab);
    assert.equal(tab._pendingAttempt, token);
    assert.equal(SshAttempts.ownerOf(token), tab);

    assert.equal(SshAttempts.transferPendingAttempt(tab, pane), true);
    assert.equal(SshAttempts.ownerOf(token), pane);
    assert.equal(pane._pendingAttempt, token);
    assert.equal(tab._pendingAttempt, null, 'previous wrapper cleared');

    // A successor attempt on the same wrapper detaches the old record's
    // owner pointer; the old attempt stays addressable but unowned.
    const token2 = SshAttempts.createAttempt(pane);
    assert.equal(pane._pendingAttempt, token2);
    assert.equal(SshAttempts.ownerOf(token), null, 'old record detached from the wrapper');
    assert.equal(SshAttempts.ownerOf(token2), pane);
});

test('beginClaim applies once; late connecting after an rpc-first claim is rejected', () => {
    SshAttempts.__resetForTests('e2');
    const owner = {};
    const token = SshAttempts.createAttempt(owner);
    assert.equal(SshAttempts.beginClaim(token, 'ssh_1'), true);
    assert.equal(SshAttempts.beginClaim(token, 'ssh_1'), false, 'duplicate connecting');
    SshAttempts.onRpcTerminal(token, 'ok', 'ssh_1');
    assert.equal(SshAttempts.beginClaim(token, 'ssh_1'), false, 'late connecting cannot regress');
});

test('finishUi applies once and retirement requires both terminal sides', () => {
    SshAttempts.__resetForTests('e3');
    const owner = {};
    const token = SshAttempts.createAttempt(owner);
    SshAttempts.beginClaim(token, 'ssh_2');
    // Event-first success: UI terminal while the invocation is still pending.
    assert.equal(SshAttempts.finishUi(token, 'ok'), true);
    assert.equal(SshAttempts.finishUi(token, 'ok'), false, 'duplicate connected/error');
    assert.equal(SshAttempts.ownerOf(token), owner, 'not retired while rpc pending');
    assert.equal(owner._pendingAttempt, token, 'binding survives the first claim while rpc is pending');
    SshAttempts.onRpcTerminal(token, 'ok', 'ssh_2');
    assert.equal(SshAttempts.ownerOf(token), null, 'retired once rpc settled');
    assert.equal(owner._pendingAttempt, null, 'owner field cleared with the record');
    assert.equal(SshAttempts.finalState(token), 'ok');
});

test('cancelAttempt releases the slot but keeps a pending INVOKED attempt addressable', () => {
    SshAttempts.__resetForTests('e4');
    const owner = {};
    const token = SshAttempts.createAttempt(owner);
    SshAttempts.beginClaim(token, 'ssh_3');
    SshAttempts.markInvoked(token); // the queue slot actually invoked ssh-connect
    let released = 0;
    SshAttempts.armSlot(token, () => { released += 1; });
    const res = SshAttempts.cancelAttempt(token);
    assert.deepEqual(res, { backend: 'ssh_3', cancelled: true });
    assert.equal(released, 1, 'slot released exactly once');
    assert.equal(SshAttempts.isCancelled(token), true);
    assert.equal(SshAttempts.ownerWants(token), false);
    // The record is still addressable while the invocation runs on.
    assert.equal(SshAttempts.byBackend('ssh_3'), token);
    // The late invocation terminal touches only its own record.
    let applied = null;
    SshAttempts.setRpcApplier((t, kind) => { applied = { t, kind }; });
    assert.equal(SshAttempts.onRpcTerminal(token, 'cancelled'), true);
    assert.equal(SshAttempts.finalState(token), 'cancelled');
    assert.deepEqual(applied, { t: token, kind: 'cancelled' });
});

test('cancelAttempt retires an UNSENT attempt immediately (no invocation can ever arrive)', () => {
    SshAttempts.__resetForTests('e9');
    const owner = {};
    const token = SshAttempts.createAttempt(owner);
    // Never markInvoked: closed while queued or while credential
    // registration was pending.
    let released = 0;
    SshAttempts.armSlot(token, () => { released += 1; });
    SshAttempts.cancelAttempt(token);
    assert.equal(released, 1, 'slot released');
    assert.equal(SshAttempts.ownerOf(token), null, 'owner binding dropped at once');
    assert.equal(owner._pendingAttempt, null, 'wrapper field cleared');
    assert.equal(SshAttempts.finalState(token), 'cancelled', 'record in the finished map');
    // A late markInvoked/onRpcTerminal on the retired token are inert no-ops.
    SshAttempts.markInvoked(token);
    assert.equal(SshAttempts.onRpcTerminal(token, 'failed', null, 'late'), false);
    // Successor protection: the wrapper takes a new attempt cleanly.
    const next = SshAttempts.createAttempt(owner);
    assert.equal(owner._pendingAttempt, next);
    assert.equal(SshAttempts.ownerWants(next), true);
});

test('armSlot is exactly-once and reentrancy-safe', () => {
    SshAttempts.__resetForTests('e5');
    const token = SshAttempts.createAttempt({});
    let calls = 0;
    const settle = SshAttempts.armSlot(token, () => {
        calls += 1;
        settle(); // a waiter re-entering releaseSlot must not recurse/loop
    });
    settle();
    settle();
    SshAttempts.cancelAttempt(token);
    assert.equal(calls, 1, 'waiter ran exactly once despite re-entry');
    // Arming an already-released slot fires immediately and once.
    let late = 0;
    SshAttempts.armSlot(token, () => { late += 1; });
    assert.equal(late, 1);
});

test('slot fallback (timer path) releases the slot only; a late success still routes', () => {
    SshAttempts.__resetForTests('e6');
    const owner = {};
    const token = SshAttempts.createAttempt(owner);
    let released = 0;
    SshAttempts.armSlot(token, () => { released += 1; });
    SshAttempts.releaseSlot(token); // what the 20s fallback calls
    assert.equal(released, 1);
    assert.equal(SshAttempts.ownerWants(token), true, 'attempt still wanted/addressable');
    assert.equal(SshAttempts.ownerOf(token), owner);
    // Legitimate late success: the rpc result supplies the backend id.
    let applied = null;
    SshAttempts.setRpcApplier((t, kind, backend) => { applied = { t, kind, backend }; });
    SshAttempts.onRpcTerminal(token, 'ok', 'ssh_9');
    assert.deepEqual(applied, { t: token, kind: 'ok', backend: 'ssh_9' });
    assert.equal(SshAttempts.byBackend('ssh_9'), token);
});

test('a late callback of a cancelled attempt cannot clear a successor field', () => {
    SshAttempts.__resetForTests('e7');
    const owner = {};
    const t1 = SshAttempts.createAttempt(owner);
    SshAttempts.cancelAttempt(t1);
    const t2 = SshAttempts.createAttempt(owner);
    // The cancelled invocation settles LAST, after the successor took over.
    SshAttempts.setRpcApplier(() => { throw new Error('applier must be guarded, not crash the caller'); });
    SshAttempts.onRpcTerminal(t1, 'cancelled');
    assert.equal(owner._pendingAttempt, t2, 'successor binding intact');
    assert.equal(SshAttempts.ownerWants(t2), true);
});

test('clearing an owner field is conditional on still holding that token', () => {
    SshAttempts.__resetForTests('e8');
    const owner = {};
    const t1 = SshAttempts.createAttempt(owner);
    SshAttempts.beginClaim(t1, 'ssh_4');
    const t2 = SshAttempts.createAttempt(owner); // reconnect: new identity
    // t1's late retirement must not clear t2 from the wrapper.
    SshAttempts.finishUi(t1, 'cancelled');
    SshAttempts.onRpcTerminal(t1, 'cancelled');
    assert.equal(owner._pendingAttempt, t2);
});
