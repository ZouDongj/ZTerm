// ADR-0004 items 4/5 red cases + pending-marker transfer (review B1), driven
// through the REAL tabs.js migration methods in a VM. Only DOM/terminal
// helpers are stubbed; split-layout.js, pane-fields.js and tab-title-utils.js
// are the real modules. Old-code failure notes are stated per test: the
// pre-ADR code copied connection fields from the wrong owner (kept tab.host)
// and took the moved pane's shell from sourceTab.command, so these
// provenance assertions cannot pass against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');

function fakeEl() {
    return {
        style: {}, dataset: {}, children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.push(c); return c; },
        remove() {}, setAttribute() {}, getAttribute: () => null,
        addEventListener() {}, removeEventListener() {},
        querySelector: () => null, querySelectorAll: () => [], contains: () => false,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
        innerHTML: '', textContent: '',
    };
}

function fakeTerm() {
    return {
        element: fakeEl(), cols: 100, rows: 30,
        onData: () => ({ dispose() {} }),
        dispose() {}, focus() {}, write() {}, scrollToBottom() {},
    };
}

function loadTabsVm() {
    const sends = [];
    const ctx = {
        console, crypto: webcrypto, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
        document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], querySelector: () => null, body: fakeEl(), addEventListener() {} },
        window: {},
        ipcRenderer: { send: (cmd, payload) => sends.push({ cmd, payload }), on() {}, invoke: async () => ({}) },
        _settingsConfig: {},
        ptyBuffers: {},
        GAP_PX: 8,
        Icons: { iconSvg: () => 'svg' },
        MutationObserver: class { observe() {} disconnect() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        requestIdleCallback: undefined,
        escHtml: s => String(s),
        showToast() {},
        // terminal.js helpers: stubbed at the boundary the migration code calls them
        _sendInputForTerm() {}, _sendResizeForTerm() {}, _fitWithScroll() {},
        createTermWrap: () => ({ wrap: fakeEl(), inner: fakeEl() }),
        setupWrapResizeObserver() {}, _scheduleSettleResize() {},
        _sshConnectWithCredentials() {}, saveConfig() {},
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js', 'tabs.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    // Top-level `const TabManager` stays script-scoped in a VM context (only
    // function declarations attach to the global) — hoist it explicitly.
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    ctx.sshAttempts = vm.runInContext('sshAttempts', ctx);
    return { ctx, sends };
}

function sshPane(id, over) {
    return { id, requestId: id, tabId: 'ssh_' + id, term: fakeTerm(), fitAddon: {}, focused: false,
        name: id, type: 'ssh', connected: true, ...over };
}

test('extract-collapse adopts the SURVIVING pane connection fields (ADR item 4)', () => {
    const { ctx } = loadTabsVm();
    const T = ctx.TabManager;
    const paneA = sshPane('p_a', { _sshHost: '10.0.0.1', _sshPort: 2222, _sshUser: 'alice', _sshProfileId: 'profA', _sshCredId: 'credA' });
    const paneB = sshPane('p_b', { _sshHost: '10.9.9.9', _sshPort: 2200, _sshUser: 'bob', _sshProfileId: 'profB', _sshCredId: 'credB' });
    const tab = { id: 't_src', name: 'src', type: 'ssh', host: '10.0.0.1', port: 2222, user: 'alice', sshProfileId: 'profA', _credId: 'credA', command: '', args: [], splitRoot: { orientation: 'v', children: [paneA, paneB], ratios: [0.5, 0.5] } };
    T.tabs.push(tab);
    // ADR item 4's exact scenario: extract A, leave B behind.
    T._extractPaneToTab('t_src', 'p_a');

    // Old code kept the ORIGINAL tab's A metadata here (host 10.0.0.1/alice/profA).
    assert.equal(tab.host, '10.9.9.9', 'surviving tab must describe pane B');
    assert.equal(tab.port, 2200);
    assert.equal(tab.user, 'bob');
    assert.equal(tab.sshProfileId, 'profB');
    assert.equal(tab._credId, 'credB');
    assert.equal(tab.type, 'ssh');
    assert.equal(tab.splitRoot, null, 'source collapsed to single');
    assert.equal(tab.term, paneB.term, 'survivor term adopted');
    // The extracted tab carries A's own identity.
    const nt = T.tabs.find(t => t !== tab && t.tabId === 'ssh_p_a');
    assert.ok(nt, 'extracted tab exists');
    assert.equal(nt.host, '10.0.0.1');
    assert.equal(nt.user, 'alice');
});

test('moved local pane keeps its shell for later splits (ADR item 5)', () => {
    const { ctx, sends } = loadTabsVm();
    const T = ctx.TabManager;
    const bashPane = { id: 'p_bash', requestId: 'p_bash', tabId: 'local_9', term: fakeTerm(), fitAddon: {}, focused: true,
        name: 'bash', type: 'local', connected: true, _command: 'D:/git/bin/bash.exe', _args: ['--login', '-i'] };
    const srcTab = { id: 't_ssh', name: 'sshroot', type: 'ssh', host: 'h1', port: 22, user: 'u1', command: '', args: [],
        splitRoot: { orientation: 'h', children: [bashPane, sshPane('p_x', { _sshHost: 'h1', _sshPort: 22, _sshUser: 'u1' })], ratios: [0.5, 0.5] } };
    const tgtTab = { id: 't_pwsh', name: 'pwsh', type: 'local', command: 'powershell.exe', args: [], connected: true, term: fakeTerm(), fitAddon: {}, tabId: 'local_1' };
    T.tabs.push(srcTab, tgtTab);
    T._moveTerminalToTab('t_ssh', 't_pwsh', 'r', null);

    // The moved pane now lives on the target split tree; splitting from it
    // must spawn the MOVED session's shell.
    const moved = T.getAllPanes ? null : null;
    const np = ctx.getAllPanes(tgtTab).find(p => p.tabId === 'local_9');
    assert.ok(np, 'moved pane present on target');
    // Old code took sourceTab.command ('' for the ssh root) → default shell.
    assert.equal(np._command, 'D:/git/bin/bash.exe');
    assert.deepEqual(np._args, ['--login', '-i']);
    // And the spawn path uses those fields, not the target tab's command.
    sends.length = 0;
    T._spawnBackendForPane({ type: 'local', _command: np._command, _args: np._args }, tgtTab);
    const spawn = sends.find(s => s.cmd === 'pty-create');
    assert.ok(spawn, 'pty-create sent');
    assert.equal(spawn.payload.shell, 'D:/git/bin/bash.exe');
    assert.deepEqual(spawn.payload.args, ['--login', '-i']);
});

test('drag-in transfers the pending marker and the attempt off the target tab (review B1)', () => {
    const { ctx } = loadTabsVm();
    const T = ctx.TabManager;
    // Target collapsed to single while a creation was pending: local marker
    // and/or an in-flight SSH attempt, no term, no backend.
    const tgt = { id: 't_pending', name: 'pend', type: 'local', command: 'powershell.exe', args: [], connected: false, term: null, fitAddon: null, tabId: null, _ptyRequestId: 'p_77' };
    const src = { id: 't_donor', name: 'donor', type: 'local', command: 'cmd.exe', args: [], connected: true, term: fakeTerm(), fitAddon: {}, tabId: 'local_1' };
    T.tabs.push(tgt, src);
    const att = ctx.sshAttempts.createAttempt(tgt); // in-flight SSH attempt
    T._moveTerminalToTab('t_donor', 't_pending', 'l', null);
    assert.equal(tgt._ptyRequestId, undefined, 'tab marker consumed by the transfer');
    const carrier = ctx.getAllPanes(tgt).find(p => p.requestId === 'p_77');
    assert.ok(carrier, 'the wrapped fp pane carries the pending local request id');
    assert.equal(carrier.tabId, null, 'fp holds the (still pending) session slot');
    // The attempt identity (not a display address) follows the same move.
    assert.equal(ctx.sshAttempts.ownerOf(att), carrier, 'attempt owner moved onto fp');
    assert.equal(carrier._pendingAttempt, att);
    assert.equal(ctx.sshAttempts.ownerWants(att), true, 'the queue gate still wants it after the move');
});

test('attempt ownership gate drops the request once it settles (replaces _rendererIdAlive)', () => {
    const { ctx } = loadTabsVm();
    const T = ctx.TabManager;
    const tab = { id: 't_x', name: 'x', type: 'ssh', host: 'h', user: 'u', connected: false, term: null, tabId: null };
    T.tabs.push(tab);
    const att = ctx.sshAttempts.createAttempt(tab);
    assert.equal(ctx.sshAttempts.ownerWants(att), true, 'bound attempt is wanted (unsent queue gate)');
    // Claim + settle through the registry (what the shared transitions do):
    // once terminal on both sides the owner field is cleared and the record
    // retires — the equivalent of the old marker consumption.
    ctx.sshAttempts.beginClaim(att, 'ssh_5');
    ctx.sshAttempts.finishUi(att, 'ok');
    ctx.sshAttempts.onRpcTerminal(att, 'ok', 'ssh_5');
    assert.equal(tab._pendingAttempt, null, 'owner field cleared with the record');
    assert.equal(ctx.sshAttempts.ownerWants(att), false);
});
