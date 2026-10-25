import { createServer } from 'node:net';

export function consentCancellationPassed(waitResult, state, connections) {
  return waitResult === true && state.tabPresent === true && state.dialogClosed === true
    && state.ownerWants === false && state.ownerBound === false && state.ownerPending === false
    && state.finalState != null && state.errors === 0 && connections === 0;
}

export function executionConsent(document, endpoint, action) {
  const overlay = document.getElementById('overlay-confirm');
  const message = document.getElementById('confirm-msg');
  const allow = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  const remember = document.querySelector('.execution-remember input[type="checkbox"]');
  const lines = String(message?.textContent || '').split('\n');
  const state = {
    shown: !!overlay?.classList.contains('open') && !!message?.classList.contains('execution-review')
      && lines.includes('地址：' + JSON.stringify(endpoint.host) + ':' + endpoint.port)
      && lines.includes('用户："e2e"') && lines.includes('登录脚本：0') && lines.includes('密钥路径："无"')
      && lines.includes('目录跟随：关闭'),
    rememberPresent: !!remember, rememberChecked: remember?.checked === true,
    allowLabel: allow?.textContent || '',
  };
  if (action) {
    if (!state.shown || !state.rememberPresent || state.rememberChecked || state.allowLabel !== '仅本次允许') {
      throw new Error('Expected the exact native SSH consent dialog with remember unchecked');
    }
    if (action === 'cancel') cancel.click();
    else if (action === 'allow-once') allow.click();
    else throw new Error('Unknown execution consent fixture action');
  }
  return state;
}

// Browser-side factories are serialized into the owned CDP page. They must
// stay self-contained and never replace the product broker or native gate.
export function createSshFailureApproval(previousInvoke, endpoint) {
  endpoint = Object.freeze({ host: endpoint.host, port: endpoint.port });
  if (endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error('SSH failure fixture requires its owned loopback endpoint');
  }
  const owners = new Set();
  const state = { prepares: 0, approvals: 0 };
  state.cancelAll = async () => {
    const current = [...owners];
    owners.clear();
    for (const owner of current) await previousInvoke('cancel-execution', { owner });
  };
  state.invoke = async (command, args) => {
    if (command === 'cancel-execution' && owners.has(args?.owner)) owners.delete(args.owner);
    const profile = args?.payload;
    if (command !== 'prepare-execution' || profile?.host !== endpoint.host || profile?.port !== endpoint.port) {
      return previousInvoke(command, args);
    }
    const allowed = ['host', 'port', 'username', 'credentialId', 'followCwd', 'loginScripts'];
    if (args.kind !== 'ssh' || !args.owner?.startsWith('ssh:') || args.owner.length <= 4
        || profile.username !== 'e2e' || profile.credentialId || profile.followCwd !== false
        || !Array.isArray(profile.loginScripts) || profile.loginScripts.length !== 0
        || Object.keys(profile).some(key => !allowed.includes(key))) {
      throw new Error('SSH failure fixture startup definition changed');
    }
    const snapshot = JSON.parse(JSON.stringify(args));
    owners.add(snapshot.owner);
    state.prepares++;
    const challenge = await previousInvoke(command, snapshot);
    if (!owners.has(snapshot.owner) || !challenge?.challengeId || challenge.ticket) {
      await previousInvoke('cancel-execution', { owner: snapshot.owner });
      throw new Error('SSH failure fixture requires a live native confirmation');
    }
    const decision = await previousInvoke('decide-execution', {
      challengeId: challenge.challengeId, allow: true, remember: false,
    });
    if (!decision?.ticket) throw new Error('SSH failure fixture received no native ticket');
    state.approvals++;
    return decision;
  };
  return state;
}

export function createUiSshFixture(previousInvoke) {
  const prefix = 'e2e-ui-only-ticket:';
  const owners = new Map();
  const state = { calls: 0, prepares: 0, cancellations: 0 };
  state.invoke = (command, args) => {
    const profile = command === 'prepare-execution' ? args?.payload : args?.profile;
    if (command === 'prepare-execution' && profile?.host === 'stub.invalid') {
      if (args.kind !== 'ssh' || !args.owner?.startsWith('ssh:') || args.owner.length <= 4
          || profile.port !== 22 || profile.username !== 'e2e') {
        return Promise.reject(new Error('UI SSH fixture startup definition changed'));
      }
      const ticket = prefix + args.owner + ':' + (++state.prepares);
      owners.set(args.owner, { ticket, payload: JSON.stringify(profile), used: false });
      return Promise.resolve({ ticket });
    }
    if (command === 'cancel-execution' && owners.has(args?.owner)) {
      owners.get(args.owner).used = true;
      state.cancellations++;
      return Promise.resolve({ cancelled: true });
    }
    const fixtureTicket = typeof args?.executionTicket === 'string' && args.executionTicket.startsWith(prefix);
    if ((command === 'ssh-connect' && profile?.host === 'stub.invalid') || fixtureTicket) {
      const owner = owners.get(args?.executionOwner);
      if (command !== 'ssh-connect' || !owner || owner.used || owner.ticket !== args.executionTicket
          || args.executionOwner !== 'ssh:' + args.attemptId || owner.payload !== JSON.stringify(profile)) {
        return Promise.reject(new Error('UI SSH fixture ticket cannot reach a native command'));
      }
      owner.used = true;
      return Promise.resolve({ tabId: 'e2e-ssh-stub-' + (++state.calls) });
    }
    return previousInvoke(command, args);
  };
  return state;
}

export async function createSshFailureEndpoint() {
  const sockets = new Set();
  const state = { connections: 0, error: null };
  const server = createServer(socket => {
    state.connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    // No SSH banner, host key, or authentication handler is ever provided.
    socket.destroy();
  });
  server.on('error', error => { state.error = error.message; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  let closing;
  return {
    host: '127.0.0.1', port: address.port, state,
    close() {
      return closing ||= new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
