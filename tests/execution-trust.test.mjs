import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(handler = () => Promise.resolve({ challengeId: 'challenge', description: 'fixture command', canRemember: true })) {
    const calls = [], toasts = [], confirms = [], intervals = new Map();
    let timerId = 0, nonce = 0;
    const elements = new Map();
    function element() {
        const classes = new Set();
        return { textContent: '', checked: false, children: [],
            classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
            append(...children) { this.children.push(...children); },
            insertAdjacentElement(_where, child) { this.after = child; },
            addEventListener(name, callback) { this[name] = callback; },
            remove() { this.removed = true; },
        };
    }
    for (const id of ['confirm-msg', 'confirm-ok']) elements.set(id, element());
    const context = vm.createContext({
        window: {}, console: { log() {}, warn() {}, error() {} },
        crypto: { randomUUID: () => `nonce-${++nonce}` },
        _activeConfirmCleanup: null, _activeHostkeyCleanup: null,
        document: { getElementById: id => elements.get(id) || null,
            createElement: element, createTextNode: text => ({ textContent: text }) },
        TabManager: { tabs: [{ id: 'local-owner', type: 'local' }], _closingTabs: new Set() },
        getAllPanes: tab => tab.splitRoot?.children || [],
        setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
        clearInterval: id => intervals.delete(id),
        setTimeout: () => ++timerId, clearTimeout() {},
        showToast: (...args) => toasts.push(args),
        ipcRenderer: { invoke: (name, payload) => { calls.push({ name, payload }); return handler(name, payload); } },
        sshAttempts: { ownerWants: () => true, ownerAttempt: () => null },
    });
    context.showConfirm = (message, onOk, label) => {
        const cleanup = () => { if (context._activeConfirmCleanup === cleanup) context._activeConfirmCleanup = null; };
        context._activeConfirmCleanup = cleanup;
        const confirm = { message, label, cleanup,
            approve: () => { cleanup(); onOk(); }, cancel: cleanup };
        confirms.push(confirm);
        return cleanup;
    };
    vm.runInContext(read('renderer/execution-trust.js'), context);
    return { context, broker: context.window.ZTermExecutionTrust, calls, toasts, confirms, elements,
        pulse: () => [...intervals.values()].forEach(callback => callback()) };
}

function localResults(f) {
    let listener;
    const disposed = [];
    f.context.ipcRenderer.on = (name, callback) => {
        assert.equal(name, 'pty-created');
        listener = callback;
    };
    f.context.ipcRenderer.send = (name, payload) => {
        assert.equal(name, 'pty-destroy');
        disposed.push(payload.tabId);
    };
    f.context._resetCaretState = () => {};
    f.context._syncFitAndReportSize = () => {};
    f.context._aggregateSplitConnected = () => {};
    f.context.TabManager.render = () => {};
    const wire = (wrapper, tabId) => {
        wrapper.tabId = tabId;
        wrapper.term = { text: '', write(text) { this.text += text; } };
    };
    f.context.wireTerminal = wire;
    f.context.wireTerminalToPane = (_tab, pane) => wire(pane, pane.tabId);
    const source = read('renderer/ipc.js').match(/ipcRenderer.on\('pty-created',[\s\S]*?\n\}\);/);
    assert.ok(source, 'the real PTY creation handler is loaded');
    vm.runInContext(source[0], f.context);
    return { emit: payload => listener({}, payload), disposed };
}

test('unapproved local startup sends no launch before explicit confirmation', async () => {
    const f = fixture((name) => Promise.resolve(name === 'prepare-execution'
        ? { challengeId: 'one', description: '<script>fixture</script>', canRemember: true } : { ticket: 'approved' }));
    const launches = [];
    const request = { requestId: 'local-owner', shell: 'fixture.exe', args: ['original'], cwd: 'D:/fixture' };
    const running = f.broker.startLocal(request, payload => { launches.push(payload); return Promise.resolve(); });
    await tick();
    assert.equal(launches.length, 0);
    assert.equal(f.confirms[0].message, '<script>fixture</script>', 'the existing confirm renderer receives plain text');
    request.args[0] = 'mutated';
    f.confirms[0].approve();
    await running;
    assert.equal(launches.length, 1);
    assert.equal(launches[0].args[0], 'original');
    assert.equal(launches[0].executionTicket, 'approved');
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call => call.name === 'decide-execution').payload)),
        { challengeId: 'one', allow: true, remember: false });
});

test('remember is explicit and the decision carries no mutable execution payload', async () => {
    const f = fixture(name => Promise.resolve(name === 'prepare-execution'
        ? { challengeId: 'one', description: 'fixture', canRemember: true } : { ticket: 'approved' }));
    const running = f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, () => Promise.resolve());
    await tick();
    const label = f.elements.get('confirm-msg').after;
    label.children[0].checked = true;
    label.children[0].change();
    assert.equal(f.elements.get('confirm-ok').textContent, '允许并记住');
    f.confirms[0].approve();
    await running;
    assert.equal(f.calls.find(call => call.name === 'decide-execution').payload.remember, true);
    assert.equal(label.removed, true);
});

test('closing a local owner cancels its challenge and stale approval cannot launch', async () => {
    const f = fixture(name => Promise.resolve(name === 'prepare-execution'
        ? { challengeId: 'one', description: 'fixture', canRemember: true } : { ticket: 'approved' }));
    let launches = 0;
    const running = f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, () => { launches++; });
    await tick();
    f.context.TabManager._closingTabs.add('local-owner');
    f.broker.cancelOwner(f.context.TabManager.tabs[0]);
    f.confirms[0].approve();
    await running;
    assert.equal(launches, 0);
    assert.equal(f.calls.some(call => call.name === 'decide-execution'), false);
    assert.ok(f.calls.some(call => call.name === 'cancel-execution' && call.payload.requestId === 'local-owner'));
});

test('a close before preparation replies cannot create a late launch', async () => {
    let reply;
    const f = fixture(name => name === 'prepare-execution'
        ? new Promise(resolve => { reply = resolve; }) : Promise.resolve());
    let launches = 0;
    const running = f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, () => { launches++; });
    const owner = f.context.TabManager.tabs[0];
    f.context.TabManager._closingTabs.add(owner.id);
    f.broker.cancelOwner(owner);
    reply({ ticket: 'late-ticket' });
    await running;
    assert.equal(launches, 0);
    assert.equal(f.confirms.length, 0);
});

test('late preparation failure cannot replace a successor using the same request id', async () => {
    let rejectFirst;
    let preparations = 0;
    const f = fixture(name => name === 'prepare-execution' && ++preparations === 1
        ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve({ ticket: 'current' }));
    const results = localResults(f);
    const launches = [];
    const request = { requestId: 'local-owner', shell: 'fixture.exe' };
    const first = f.broker.startLocal(request, payload => { launches.push(payload); });
    const firstOwner = f.calls[0].payload.owner;
    const next = f.broker.startLocal(request, payload => { launches.push(payload); });
    await next;
    rejectFirst(new Error('old preparation failed'));
    await first;
    results.emit({ requestId: request.requestId, executionOwner: firstOwner, tabId: '', spawnError: 'old failure' });
    assert.equal(launches.length, 1);
    assert.equal(f.context.TabManager.tabs[0].term, undefined);
    assert.equal(f.context.TabManager.tabs[0]._sessionFailed, undefined);
    assert.equal(f.toasts.length, 0);
    results.emit({ requestId: request.requestId, executionOwner: launches[0].executionOwner, tabId: 'current-backend' });
    assert.equal(f.context.TabManager.tabs[0].tabId, 'current-backend');
    assert.deepEqual(results.disposed, []);
});

test('late approved decision and cancellation result stay bound to the canceled generation', async () => {
    let approveFirst;
    let preparations = 0;
    const f = fixture(name => {
        if (name === 'prepare-execution') return Promise.resolve(++preparations === 1
            ? { challengeId: 'first', description: 'fixture' } : { ticket: 'current' });
        if (name === 'decide-execution') return new Promise(resolve => { approveFirst = resolve; });
        return Promise.resolve();
    });
    const results = localResults(f);
    const launches = [];
    const request = { requestId: 'local-owner', shell: 'fixture.exe' };
    const first = f.broker.startLocal(request, payload => { launches.push(payload); });
    const firstOwner = f.calls[0].payload.owner;
    await tick();
    f.confirms[0].approve();
    await tick();
    const next = f.broker.startLocal(request, payload => { launches.push(payload); });
    await next;
    approveFirst({ ticket: 'stale-approved' });
    await first;
    results.emit({ requestId: request.requestId, executionOwner: firstOwner, tabId: '', spawnError: 'old cancellation' });
    results.emit({ requestId: request.requestId, executionOwner: firstOwner, tabId: 'stale-backend' });
    assert.equal(launches.length, 1);
    assert.equal(launches[0].executionTicket, 'current');
    assert.equal(f.context.TabManager.tabs[0].term, undefined);
    assert.equal(f.toasts.length, 0);
    assert.deepEqual(results.disposed, ['stale-backend']);
    results.emit({ requestId: request.requestId, executionOwner: launches[0].executionOwner, tabId: 'current-backend' });
    assert.equal(f.context.TabManager.tabs[0].tabId, 'current-backend');
});

test('closing after the create RPC settles cancels its still-unclaimed native result', async () => {
    const f = fixture(() => Promise.resolve({ ticket: 'approved' }));
    const results = localResults(f);
    let launched;
    await f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, payload => { launched = payload; });
    const previous = f.context.TabManager.tabs[0];
    f.broker.cancelOwner(previous);
    const successor = { id: previous.id, type: 'local' };
    f.context.TabManager.tabs = [successor];
    results.emit({ requestId: previous.id, executionOwner: launched.executionOwner, tabId: 'late-backend' });
    assert.equal(successor.term, undefined);
    assert.equal(successor.tabId, undefined);
    assert.deepEqual(results.disposed, ['late-backend']);
    assert.ok(f.calls.some(call => call.name === 'cancel-execution' && call.payload.owner === launched.executionOwner));
});

test('native results without the current generation cannot consume a waiting claim', async () => {
    const f = fixture(() => Promise.resolve({ ticket: 'approved' }));
    const results = localResults(f);
    let launched;
    await f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, payload => { launched = payload; });
    results.emit({ requestId: 'local-owner', tabId: '', spawnError: 'unbound failure' });
    assert.equal(f.context.TabManager.tabs[0].term, undefined);
    assert.equal(f.context.TabManager.tabs[0]._sessionFailed, undefined);
    results.emit({ requestId: 'local-owner', executionOwner: launched.executionOwner, tabId: 'current-backend' });
    assert.equal(f.context.TabManager.tabs[0].tabId, 'current-backend');
});

test('a current startup error is claimed once and a duplicate success is disposed', async () => {
    const f = fixture(() => Promise.resolve({ ticket: 'approved' }));
    const results = localResults(f);
    let launched;
    await f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, payload => { launched = payload; });
    const result = { requestId: 'local-owner', executionOwner: launched.executionOwner };
    results.emit({ ...result, tabId: '', spawnError: 'current failure' });
    const wrapper = f.context.TabManager.tabs[0];
    const terminal = wrapper.term;
    assert.equal(wrapper._sessionFailed, true);
    assert.ok(terminal.text.includes('current failure'));
    results.emit({ ...result, tabId: 'duplicate-backend' });
    assert.equal(wrapper.term, terminal);
    assert.equal(wrapper._sessionFailed, true);
    assert.deepEqual(results.disposed, ['duplicate-backend']);
});

test('same pending local request follows a pane migration', async () => {
    let reply;
    const f = fixture(name => name === 'prepare-execution'
        ? new Promise(resolve => { reply = resolve; }) : Promise.resolve());
    const results = localResults(f);
    const launches = [];
    const running = f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, payload => { launches.push(payload); });
    f.context.TabManager.tabs = [{ id: 'destination', splitRoot: { children: [{ id: 'pane', requestId: 'local-owner' }] } }];
    reply({ ticket: 'same-owner-ticket' });
    await running;
    assert.equal(launches.length, 1);
    assert.equal(launches[0].requestId, 'local-owner');
    results.emit({ requestId: 'local-owner', executionOwner: launches[0].executionOwner, tabId: 'migrated-backend' });
    assert.equal(f.context.TabManager.tabs[0].splitRoot.children[0].tabId, 'migrated-backend');
    assert.deepEqual(results.disposed, []);
});

test('authorization waits behind an unrelated modal without replacing it', async () => {
    const f = fixture(name => Promise.resolve(name === 'prepare-execution'
        ? { challengeId: 'one', description: 'fixture' } : { ticket: 'approved' }));
    const previous = () => {};
    f.context._activeConfirmCleanup = previous;
    const running = f.broker.startLocal({ requestId: 'local-owner', shell: 'fixture.exe' }, () => Promise.resolve());
    await tick();
    assert.equal(f.context._activeConfirmCleanup, previous);
    assert.equal(f.confirms.length, 0);
    f.context._activeConfirmCleanup = null;
    f.pulse();
    f.confirms[0].cancel();
    f.pulse();
    await running;
    assert.equal(f.calls.some(call => call.name === 'decide-execution'), false);
});

test('actual shared-default restore crosses the polyfill authorization boundary', async () => {
    const native = [];
    const f = fixture();
    f.context.window.__TAURI__ = {
        core: { invoke: (command, { args }) => {
            native.push({ command, payload: args[0] });
            if (command === 'prepare_execution') return Promise.resolve({ challengeId: 'shared', description: 'fixture launch' });
            return Promise.resolve();
        } }, event: { listen: () => Promise.resolve(() => {}) },
    };
    vm.runInContext(read('ipc-polyfill.js'), f.context);
    f.context.ipcRenderer = f.context.window.electron.ipcRenderer;
    const tabs = read('renderer/tabs.js'), ssh = read('renderer/ssh.js');
    const getDefault = ssh.match(/function getDefaultLocalProfile\(\) \{[\s\S]*?\n\}/)[0];
    const payload = tabs.match(/function _ptyCreatePayload\([^)]*\) \{[\s\S]*?\n\}/)[0];
    const create = tabs.match(/    createTabSilent\([^)]*\) \{[\s\S]*?\n    \},/)[0].trim();
    f.context._settingsConfig = { defaultShell: 'shared-custom', startupDir: 'D:/fixture' };
    Object.assign(f.context.TabManager, { _counter: 0, profiles: [{ id: 'shared-custom', name: 'Fixture', type: 'local', command: 'fixture.exe', args: ['--inert'] }] });
    f.context.colorFgbgForBackground = () => '0;15';
    f.context.getTerminalTheme = () => ({ background: '#000' });
    vm.runInContext(getDefault + '\n' + payload + '\nfunction ' + create.slice(0, -1), f.context);
    f.context.TabManager.createTabSilent = f.context.createTabSilent;
    vm.runInContext('const selected=getDefaultLocalProfile();TabManager.createTabSilent(selected.name,selected.command,selected.type,null,selected.args);', f.context);
    await tick();
    assert.deepEqual(native.map(call => call.command), ['prepare_execution']);
    assert.equal(native[0].payload.payload.shell, 'fixture.exe');
    assert.equal(native[0].payload.payload.cwd, 'D:/fixture');
    f.confirms[0].cancel(); f.pulse(); await tick();
    assert.equal(native.some(call => call.command === 'pty_create'), false);
});

test('SSH confirmation precedes handshake-slot acquisition and cancellation stays attempt-bound', async () => {
    const f = fixture(name => Promise.resolve(name === 'prepare-execution'
        ? { challengeId: 'ssh', description: 'SSH fixture' } : { ticket: 'approved' }));
    const attempts = new Set(['attempt']);
    const invoked = [];
    f.context.sshAttempts = {
        ownerWants: token => attempts.has(token), armSlot: () => invoked.push('slot'),
        markInvoked: () => invoked.push('invoked'), releaseSlot() {}, onRpcTerminal: () => invoked.push('settled'),
    };
    const enqueue = read('renderer/tabs.js').match(/function _enqueueSshConnect\([^)]*\) \{[\s\S]*?\n\}/)[0];
    vm.runInContext('let _sshConnectChain=Promise.resolve();const SSH_CONNECT_SLOT_FALLBACK_MS=75000;\n' + enqueue, f.context);
    f.context._enqueueSshConnect({ host: '192.0.2.10', username: 'fixture', loginScripts: [] }, 'attempt');
    await tick();
    assert.deepEqual(invoked, []);
    assert.equal(f.calls.some(call => call.name === 'ssh-connect'), false);
    attempts.delete('attempt');
    f.broker.cancel('ssh:attempt');
    f.confirms[0].approve();
    await tick();
    assert.equal(f.calls.some(call => call.name === 'ssh-connect'), false);
    assert.equal(invoked.includes('slot'), false);
});
