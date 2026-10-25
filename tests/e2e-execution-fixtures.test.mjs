import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { consentCancellationPassed, executionConsent, createSshFailureApproval, createUiSshFixture, createSshFailureEndpoint } from '../scripts/e2e-execution-fixtures.mjs';

const endpoint = { host: '127.0.0.1', port: 32123 };
const profile = () => ({ ...endpoint, username: 'e2e', credentialId: null, followCwd: false, loginScripts: [] });

test('a no-op Cancel cannot be accepted or repaired by later cleanup', () => {
  const retired = { tabPresent: true, dialogClosed: true, ownerWants: false, ownerBound: false, ownerPending: false, finalState: 'failed', errors: 0 };
  const stalled = { ...retired, dialogClosed: false, ownerWants: true, ownerBound: true, ownerPending: true, finalState: null };
  let cleanups = 0;
  const run = (waitResult, beforeCleanup, connections) => {
    if (!consentCancellationPassed(waitResult, beforeCleanup, connections)) throw new Error('Cancel did not settle');
    cleanups++;
    return retired;
  };
  assert.throws(() => run(false, stalled, 0));
  assert.throws(() => run(false, retired, 0), 'a timeout must fail even if a later read looks retired');
  for (const change of [{ tabPresent: false }, { dialogClosed: false }, { ownerWants: true }, { ownerBound: true },
    { ownerPending: true }, { finalState: null }, { errors: 1 }]) {
    assert.throws(() => run(true, { ...retired, ...change }, 0));
  }
  assert.throws(() => run(true, retired, 1));
  assert.equal(cleanups, 0, 'programmatic cleanup must never repair failed pre-cleanup evidence');
  assert.equal(run(true, retired, 0), retired);
  assert.equal(cleanups, 1);
  const source = readFileSync(new URL('../scripts/e2e-check.mjs', import.meta.url), 'utf8');
  const evidence = source.indexOf('const consentCancellationReady = await waitForValue');
  const guard = source.indexOf('if (!consentCancellationOk)');
  const cleanup = source.indexOf("await ZTermExecutionTrust.cancel('ssh:' + token)");
  assert.ok(evidence > 0 && guard > evidence && cleanup > guard, 'the real E2E runner must reject pre-cleanup evidence before programmatic cancellation');
});

test('consent UI guard clicks only the exact product dialog with remember unchecked', () => {
  const clicks = [];
  const elements = {
    'overlay-confirm': { classList: { contains: name => name === 'open' } },
    'confirm-msg': { classList: { contains: name => name === 'execution-review' },
      textContent: '共享连接配置需要本账户确认。\n地址："127.0.0.1":32123\n用户："e2e"\n密钥路径："无"\n目录跟随：关闭\n登录脚本：0' },
    'confirm-ok': { textContent: '仅本次允许', click: () => clicks.push('allow-once') },
    'confirm-cancel': { click: () => clicks.push('cancel') },
  };
  const checkbox = { checked: false };
  const document = { getElementById: id => elements[id], querySelector: () => checkbox };
  assert.equal(executionConsent(document, endpoint).rememberChecked, false);
  executionConsent(document, endpoint, 'cancel');
  executionConsent(document, endpoint, 'allow-once');
  assert.deepEqual(clicks, ['cancel', 'allow-once']);
  checkbox.checked = true;
  assert.throws(() => executionConsent(document, endpoint, 'allow-once'));
  checkbox.checked = false;
  assert.throws(() => executionConsent(document, { ...endpoint, port: 32124 }, 'cancel'));
  elements['confirm-ok'].textContent = '删除';
  assert.throws(() => executionConsent(document, endpoint, 'allow-once'));
  elements['confirm-ok'].textContent = '仅本次允许';
  assert.throws(() => executionConsent({ ...document, querySelector: () => null }, endpoint, 'allow-once'));
  assert.deepEqual(clicks, ['cancel', 'allow-once'], 'guard failures must not click any dialog');
  const context = vm.createContext({ document, endpoint });
  assert.equal(vm.runInContext(`(${executionConsent.toString()})(document, endpoint).shown`, context), true);
});

test('native failure approval keeps prepare and one-use decision on the native transport', async () => {
  const native = [];
  const fixture = createSshFailureApproval(async (command, args) => {
    native.push({ command, args });
    if (command === 'prepare-execution') return { challengeId: 'immutable-native-challenge' };
    if (command === 'decide-execution') return { ticket: 'native-one-use-ticket' };
    return { native: true };
  }, endpoint);
  const request = { kind: 'ssh', owner: 'ssh:fixture', payload: profile() };
  const result = await fixture.invoke('prepare-execution', request);
  assert.equal(result.ticket, 'native-one-use-ticket');
  assert.deepEqual(native.map(call => call.command), ['prepare-execution', 'decide-execution']);
  assert.deepEqual(native[1].args, { challengeId: 'immutable-native-challenge', allow: true, remember: false });
  assert.equal(fixture.approvals, 1);
  for (const change of [{ username: 'other' }, { loginScripts: [{ send: 'unexpected' }] }, { credentialId: 'fake' }, { followCwd: true }]) {
    await assert.rejects(fixture.invoke('prepare-execution', { ...request, payload: { ...profile(), ...change } }));
  }
  assert.equal(native.length, 2, 'changed definitions never reach native prepare or decision');
  assert.deepEqual(await fixture.invoke('get-profiles', {}), { native: true });
  await fixture.cancelAll();
  assert.deepEqual(native.at(-1), { command: 'cancel-execution', args: { owner: 'ssh:fixture' } });
});

test('cancelled or already-trusted native fixture preparation is never approved', async () => {
  let reply;
  const native = [];
  const fixture = createSshFailureApproval((command, args) => {
    native.push({ command, args });
    return command === 'prepare-execution' ? new Promise(resolve => { reply = resolve; }) : Promise.resolve({});
  }, endpoint);
  const waiting = fixture.invoke('prepare-execution', { kind: 'ssh', owner: 'ssh:cancelled', payload: profile() });
  await fixture.invoke('cancel-execution', { owner: 'ssh:cancelled' });
  reply({ challengeId: 'late' });
  await assert.rejects(waiting);
  assert.equal(native.some(call => call.command === 'decide-execution'), false);
  const trusted = createSshFailureApproval(async () => ({ ticket: 'unexpected-remembered-grant' }), endpoint);
  await assert.rejects(trusted.invoke('prepare-execution', { kind: 'ssh', owner: 'ssh:trusted', payload: profile() }));
});

test('UI fixture tickets are owner-bound, immutable, one-use, and never forwarded to native', async () => {
  const native = [];
  const fixture = createUiSshFixture((command, args) => { native.push({ command, args }); return Promise.resolve('native'); });
  const payload = { ...profile(), host: 'stub.invalid', port: 22, credentialId: 'synthetic-ui-handle' };
  const { ticket } = await fixture.invoke('prepare-execution', { kind: 'ssh', owner: 'ssh:ui', payload });
  const launch = { profile: payload, attemptId: 'ui', executionOwner: 'ssh:ui', executionTicket: ticket };
  await assert.rejects(fixture.invoke('ssh-connect', { ...launch, profile: { ...payload, host: 'other.invalid' } }));
  await assert.rejects(fixture.invoke('pty-create', { ...launch }));
  assert.equal(native.length, 0);
  assert.equal((await fixture.invoke('ssh-connect', launch)).tabId, 'e2e-ssh-stub-1');
  await assert.rejects(fixture.invoke('ssh-connect', launch));
  await fixture.invoke('cancel-execution', { owner: 'ssh:ui' });
  assert.equal(native.length, 0);
  assert.equal(await fixture.invoke('get-profiles', {}), 'native');
  assert.equal(native.length, 1);
  assert.equal(fixture.calls, 1);
});

test('UI fixture cancellation invalidates its ticket before connection', async () => {
  const fixture = createUiSshFixture(() => assert.fail('no fixture command may reach native'));
  const payload = { ...profile(), host: 'stub.invalid', port: 22 };
  const { ticket } = await fixture.invoke('prepare-execution', { kind: 'ssh', owner: 'ssh:closed', payload });
  await fixture.invoke('cancel-execution', { owner: 'ssh:closed' });
  await assert.rejects(fixture.invoke('ssh-connect', { profile: payload, attemptId: 'closed', executionOwner: 'ssh:closed', executionTicket: ticket }));
});

test('browser fixture factories serialize without Node dependencies', () => {
  const context = vm.createContext({ previous: () => Promise.resolve({}), endpoint });
  for (const factory of [createSshFailureApproval, createUiSshFixture]) {
    assert.equal(vm.runInContext(`typeof (${factory.toString()})(previous, endpoint).invoke`, context), 'function');
  }
});

test('real SSH broker and queue use UI fixture authorization without native traffic', async () => {
  const native = [];
  const terminal = [];
  const fixture = createUiSshFixture((command, args) => { native.push({ command, args }); return Promise.resolve(); });
  const context = vm.createContext({
    window: {}, ipcRenderer: { invoke: fixture.invoke }, console,
    setTimeout: () => 1, clearTimeout() {}, showToast: () => assert.fail('a granted UI fixture needs no dialog'),
    sshAttempts: { ownerWants: () => true, armSlot() {}, releaseSlot() {}, markInvoked() {},
      onRpcTerminal: (...args) => terminal.push(args) },
  });
  const read = file => readFileSync(new URL('../src/renderer/' + file, import.meta.url), 'utf8');
  vm.runInContext(read('execution-trust.js'), context);
  const enqueue = read('tabs.js').match(/function _enqueueSshConnect\([^)]*\) \{[\s\S]*?\n\}/)[0];
  vm.runInContext('let _sshConnectChain=Promise.resolve();const SSH_CONNECT_SLOT_FALLBACK_MS=75000;\n' + enqueue, context);
  context._enqueueSshConnect({ ...profile(), host: 'stub.invalid', port: 22 }, 'ui');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.prepares, 1);
  assert.equal(fixture.calls, 1);
  assert.deepEqual(terminal, [['ui', 'ok', 'e2e-ssh-stub-1']]);
  assert.deepEqual(native, []);
});

test('owned loopback failure endpoint closes before any SSH protocol or authentication', { timeout: 5000 }, async () => {
  const fixture = await createSshFailureEndpoint();
  try {
    let received = 0;
    await new Promise((resolve, reject) => {
      const socket = connect({ host: fixture.host, port: fixture.port });
      socket.on('data', data => { received += data.length; });
      socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      socket.on('close', resolve);
    });
    assert.equal(fixture.state.connections, 1);
    assert.equal(received, 0);
    assert.equal(fixture.state.error, null);
  } finally {
    await fixture.close();
    await fixture.close();
  }
});

test('full E2E retains native failure and DOM checks with scoped fixture authorization', () => {
  const source = readFileSync(new URL('../scripts/e2e-check.mjs', import.meta.url), 'utf8');
  for (const pattern of [/createSshFailureEndpoint\(\)/, /createSshFailureApproval\.toString\(\)/, /createUiSshFixture\.toString\(\)/,
    /sshTabAlive && appAlive && sshErrCount > 0/, /hdrCleanup\.stubCalls >= 2/, /hdrCleanup\.stubPrepares >= hdrCleanup\.stubCalls/]) {
    assert.ok(pattern.test(source), `the E2E runner must retain ${pattern}`);
  }
  const cancel = source.indexOf('const cancelledConsent =');
  const reconnect = source.indexOf('TabManager.reconnectTab(${JSON.stringify(consentAttempt.tabId)})');
  const allow = source.indexOf('const allowedConsent =');
  const automatic = source.indexOf('createSshFailureApproval.toString()');
  assert.ok(cancel > 0 && reconnect > cancel && allow > reconnect && automatic > allow,
    'native dialog cancellation and manual one-time allowance must precede automatic retry approvals');
  assert.ok(source.includes('sshFailureEndpoint.state.connections !== 0'), 'cancellation must fail on any loopback connection');
  assert.ok(source.includes('sshAttempts.finalState(token) != null'), 'cancellation must wait for owner retirement');
  assert.ok(source.includes("join(sandbox.directory, 'execution-trust.v1.bin')") && source.includes('!existsSync(consentGrantPath)'),
    'one-time consent must check grant-file absence only inside the owned Node sandbox');
});
