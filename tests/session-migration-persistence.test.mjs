// Real migration, output capture and serialization paths with synthetic sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
const { serializeSplitNode, deserializeSplitNode } = require('../src/renderer/tab-serialize.js');
const source = file => readFileSync(new URL('../src/renderer/' + file, import.meta.url), 'utf8');

test('a local pane moved through an SSH container restores as local', () => {
    const ctx = loadVm();
    const ssh = wiredTab(ctx, 'ssh-root', 'ssh_1', '', {
        type: 'ssh', host: 'synthetic.example', port: 2222, user: 'synthetic', sshProfileId: 'synthetic-profile',
    });
    const local = wiredTab(ctx, 'local-source', 'local_1', '', { command: 'bash.exe', args: ['--login'] });
    const target = wiredTab(ctx, 'local-target', 'local_2');
    ctx.TabManager._moveTerminalToTab(local.id, ssh.id, 'r', null);
    ctx.TabManager._moveTerminalToTab(ssh.id, target.id, 'r', null);
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'local_1');
    assert.equal(moved.type, 'local');
    const saved = serializeSplitNode(moved);
    assert.equal(saved.paneType, 'local');
    const restored = deserializeSplitNode(saved, { nextPaneId: () => 'restored' });
    assert.equal(restored.type, 'local');
    assert.equal(restored._command, 'bash.exe');
    assert.deepEqual(Array.from(restored._args), ['--login']);
    for (const key of ['_sshHost', '_sshPort', '_sshUser', '_sshProfileId', '_sshCredId']) {
        assert.equal(moved[key], undefined, 'local identity never adopts its SSH container metadata');
    }
});

test('an SSH pane keeps its own connection and credential through another SSH container', () => {
    const ctx = loadVm();
    const container = wiredTab(ctx, 'container', 'ssh_container', '', {
        type: 'ssh', host: 'container.example', port: 22, user: 'container-user',
        sshProfileId: 'container-profile', _credId: 'container-credential',
    });
    const sourceTab = wiredTab(ctx, 'source', 'ssh_source', '', {
        type: 'ssh', host: 'source.example', port: 2222, user: 'source-user',
        sshProfileId: 'source-profile', _credId: 'source-credential',
    });
    const target = wiredTab(ctx, 'target', 'local_target');
    ctx.TabManager._moveTerminalToTab(sourceTab.id, container.id, 'r', null);
    ctx.TabManager._moveTerminalToTab(container.id, target.id, 'r', null);
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'ssh_source');
    assert.equal(moved.type, 'ssh');
    assert.equal(moved._sshHost, 'source.example');
    assert.equal(moved._sshPort, 2222);
    assert.equal(moved._sshUser, 'source-user');
    assert.equal(moved._sshProfileId, 'source-profile');
    assert.equal(moved._sshCredId, 'source-credential');
    const restored = deserializeSplitNode(serializeSplitNode(moved), { nextPaneId: () => 'restored' });
    assert.equal(restored.type, 'ssh');
    assert.equal(restored._sshHost, 'source.example');
    assert.equal(restored._sshProfileId, 'source-profile');
});

test('a manually renamed source keeps priority after move, save, restore and extract', async () => {
    const ctx = loadVm();
    const sourceTab = wiredTab(ctx, 'source', 'local_1');
    sourceTab.name = 'Manual';
    sourceTab._customName = true;
    sourceTab._toolName = 'TOOL';
    const target = wiredTab(ctx, 'target', 'local_2');
    target.name = 'Target';
    ctx.TabManager._moveTerminalToTab(sourceTab.id, target.id, 'r', null);
    assert.equal(ctx.TabManager._tabDisplayName(target), 'Target | Manual');
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'local_1');
    assert.equal(moved._manualName, true);
    const saved = await saveTabs(ctx);
    const restoredTree = deserializeSplitNode(saved[0].splitRoot, { nextPaneId: () => 'restored' });
    const restored = restoredTree.children.find(pane => pane.name === 'Manual');
    assert.equal(restored._manualName, true);
    restored._toolName = 'NEW TOOL';
    assert.equal(ctx.resolveTabDisplayName({ splitRoot: restoredTree }, restoredTree.children), 'Target | Manual');
    ctx.TabManager._extractPaneToTab(target.id, moved.id);
    const extracted = ctx.TabManager.tabs.find(tab => tab.tabId === 'local_1');
    assert.equal(extracted._customName, true);
    assert.equal(ctx.TabManager._tabDisplayName(extracted), 'Manual');
});

test('a moved split pane carries its own manual name rather than a container rename', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 'source', 'local_1', '', 'local_2', '');
    tab.name = 'Container label';
    tab._customName = true;
    p2.name = 'Pane manual';
    p2._manualName = true;
    p2._toolName = 'TOOL';
    const target = wiredTab(ctx, 'target', 'local_target', '', { name: 'Target' });
    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'local_2');
    assert.equal(moved._manualName, true);
    assert.equal(ctx.TabManager._tabDisplayName(target), 'Target | Pane manual');
    assert.equal(tab._customName, true, 'the source container keeps its own manual label');
    assert.equal(tab.name, 'Container label');
});

test('an unrenamed pane does not inherit its source container name lock', () => {
    const ctx = loadVm();
    const { tab, p2 } = wiredSplitTab(ctx, 'source', 'local_1', '', 'local_2', '');
    tab.name = 'Container label';
    tab._customName = true;
    p2.name = 'Pane base';
    p2._toolName = 'TOOL';
    const target = wiredTab(ctx, 'target', 'local_target', '', { name: 'Target' });
    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'local_2');
    assert.equal(moved._manualName, undefined);
    assert.equal(ctx.TabManager._tabDisplayName(target), 'Target | TOOL');
});

async function capturedSplit(ctx, { firstAlternate = false } = {}) {
    vm.runInContext(source('restore-content.js'), ctx);
    ctx.applyHighlight = data => data;
    const tab = wiredTab(ctx, 'source', 'local_1');
    ctx.__emit('pty-output', { tabId: 'local_1', data: 'SYNTHETIC SESSION A HISTORY\r\n' });
    if (firstAlternate) ctx.__emit('pty-output', { tabId: 'local_1', data: '\x1b[?1049hA TUI' });
    ctx.TabManager.addPaneRelativeTo(tab, 'b');
    const [p1, p2] = ctx.getAllPanes(tab);
    p2.tabId = 'local_2';
    ctx.wireTerminalToPane(tab, p2);
    return { tab, p1, p2 };
}

async function saveTabs(ctx) {
    ctx.serializeSplitNode = serializeSplitNode;
    const main = source('main.js');
    vm.runInContext(main.slice(main.indexOf('function saveConfig()'), main.indexOf('setInterval(() => { saveConfig(); }')), ctx);
    ctx.TabManager._restored = true;
    ctx._settingsConfig.restoreLocalContent = true;
    let persisted;
    ctx.ipcRenderer.invoke = (command, tabs) => {
        if (command === 'save-last-tabs') persisted = tabs;
        return Promise.resolve();
    };
    await ctx.saveConfig();
    return persisted;
}

test('extract-collapse does not persist the extracted session history on the survivor', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = await capturedSplit(ctx);
    const liveTerm = p1.term;
    const liveLine = liveTerm.buffer.active.getLine(0).translateToString();
    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    assert.equal(tab.tabId, p2.tabId);
    assert.equal(tab.splitRoot, null);
    const saved = await saveTabs(ctx);
    assert.equal(ctx.TabManager.tabs[0], tab);
    assert.equal(saved[0].content, '',
        'session B must not persist session A history');
    assert.equal(liveTerm.buffer.active.getLine(0).translateToString(), liveLine, 'live scrollback is unchanged');
    ctx.__emit('pty-output', { tabId: 'local_2', data: 'SESSION B AFTER COLLAPSE\r\n' });
    const savedAfterOutput = await saveTabs(ctx);
    assert.equal(savedAfterOutput[0].content, 'SESSION B AFTER COLLAPSE\r\n');
});

test('move-collapse does not persist the moved session history on the survivor', async () => {
    const ctx = loadVm();
    const { tab, p1, p2 } = await capturedSplit(ctx);
    const liveTerm = p1.term;
    const liveLine = liveTerm.buffer.active.getLine(0).translateToString();
    const target = wiredTab(ctx, 'target', 'local_target');
    ctx.TabManager._focusPane(tab, p1.id);
    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);
    assert.equal(tab.tabId, p2.tabId);
    assert.equal(tab.splitRoot, null);
    const saved = await saveTabs(ctx);
    assert.equal(saved[0].content, '', 'session B must not persist session A history');
    assert.equal(liveTerm.buffer.active.getLine(0).translateToString(), liveLine, 'live scrollback is unchanged');
    ctx.__emit('pty-output', { tabId: 'local_2', data: 'SESSION B AFTER COLLAPSE\r\n' });
    const savedAfterOutput = await saveTabs(ctx);
    assert.equal(savedAfterOutput[0].content, 'SESSION B AFTER COLLAPSE\r\n');
});

for (const route of ['extract', 'move', 'close']) {
    const collapse = (ctx, tab, p1) => {
        if (route === 'extract') ctx.TabManager._extractPaneToTab(tab.id, p1.id);
        else if (route === 'close') {
            ctx.TabManager._closePane(tab.id, p1.id);
            ctx.__tq.advance(250);
        }
        else {
            const target = wiredTab(ctx, 'target', 'local_target');
            ctx.TabManager._focusPane(tab, p1.id);
            ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);
        }
    };

    test(`${route}-collapse resumes the normal survivor capture after the original session entered alternate screen`, async () => {
        const ctx = loadVm();
        const { tab, p1 } = await capturedSplit(ctx, { firstAlternate: true });
        collapse(ctx, tab, p1);
        ctx.__emit('pty-output', { tabId: 'local_2', data: 'B NORMAL OUTPUT\r\n' });
        const saved = await saveTabs(ctx);
        assert.equal(saved[0].content, 'B NORMAL OUTPUT\r\n');
    });

    test(`${route}-collapse does not capture a survivor TUI that entered alternate screen while split`, async () => {
        const ctx = loadVm();
        const { tab, p1 } = await capturedSplit(ctx);
        ctx.__emit('pty-output', { tabId: 'local_2', data: '\x1b[?1049hB TUI START' });
        collapse(ctx, tab, p1);
        ctx.__emit('pty-output', { tabId: 'local_2', data: 'B TUI NEXT FRAME' });
        const saved = await saveTabs(ctx);
        assert.equal(saved[0].content, '');
        ctx.__emit('pty-output', { tabId: 'local_2', data: '\x1b[?1049lB NORMAL AGAIN\r\n' });
        const afterExit = await saveTabs(ctx);
        assert.match(afterExit[0].content, /B NORMAL AGAIN/);
        assert.doesNotMatch(afterExit[0].content, /B TUI/);
    });
}

test('the extracted session keeps its alternate-screen gate until its own exit', async () => {
    const ctx = loadVm();
    const { tab, p1 } = await capturedSplit(ctx, { firstAlternate: true });
    ctx.TabManager._extractPaneToTab(tab.id, p1.id);
    const extracted = ctx.TabManager.tabs.find(candidate => candidate.tabId === 'local_1');
    ctx.__emit('pty-output', { tabId: 'local_1', data: 'A TUI NEXT FRAME' });
    assert.equal(extracted._contentBuffer, '');
    ctx.__emit('pty-output', { tabId: 'local_1', data: '\x1b[?1049lA NORMAL AGAIN\r\n' });
    assert.match(extracted._contentBuffer, /A NORMAL AGAIN/);
    assert.doesNotMatch(extracted._contentBuffer, /A TUI/);
});

test('a terminal moved into another split retains its alternate-screen gate on extraction', async () => {
    const ctx = loadVm();
    const { tab, p1 } = await capturedSplit(ctx, { firstAlternate: true });
    const target = wiredTab(ctx, 'target', 'local_target');
    ctx.TabManager._focusPane(tab, p1.id);
    ctx.TabManager._moveTerminalToTab(tab.id, target.id, 'r', null);
    const moved = ctx.getAllPanes(target).find(pane => pane.tabId === 'local_1');
    ctx.TabManager._extractPaneToTab(target.id, moved.id);
    const extracted = ctx.TabManager.tabs.find(candidate => candidate.tabId === 'local_1');
    ctx.__emit('pty-output', { tabId: 'local_1', data: 'A TUI NEXT FRAME' });
    assert.equal(extracted._contentBuffer, '');
});

async function reconnectCaptureFixture({ split, clearOnConnect, earlyAlternate = false, handshakeFailure = false }) {
    const ctx = loadVm();
    vm.runInContext(source('restore-content.js'), ctx);
    ctx.applyHighlight = data => data;
    ctx.TabManager.sshProfiles = [{ id: 'synthetic-profile', clearOnConnect }];
    const identity = { type: 'ssh', host: 'synthetic.example', user: 'synthetic', sshProfileId: 'synthetic-profile' };
    let tab, owner, sibling;
    if (split) {
        // Both initial sessions are already established fixtures. Only the
        // reconnect below runs the real asynchronous connect-attempt path.
        const spawnBackend = ctx.TabManager._spawnBackendForPane;
        ctx.TabManager._spawnBackendForPane = () => {};
        const wired = wiredSplitTab(ctx, 'reconnect', 'ssh_old', '', 'ssh_sibling', '', identity);
        ctx.TabManager._spawnBackendForPane = spawnBackend;
        tab = wired.tab; owner = wired.p1; sibling = wired.p2;
    } else {
        tab = wiredTab(ctx, 'reconnect', 'ssh_old', '', identity);
        owner = tab;
    }
    const connects = [];
    ctx.ipcRenderer.invoke = (command, payload) => new Promise(resolve => {
        if (command === 'ssh-connect') connects.push({ payload, resolve });
    });
    ctx.__emit('pty-output', { tabId: 'ssh_old', data: '\x1b[?1049hOLD TUI' });
    assert.equal(owner._altScreen, true);
    const oldTerm = owner.term;
    if (split) ctx.TabManager._reconnectPane(tab.id, owner.id);
    else ctx.TabManager.reconnectTab(tab.id);
    assert.equal(owner.term, clearOnConnect ? null : oldTerm);
    ctx.__tq.advance(500);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connects.length, 1);
    let attemptId = owner._pendingAttempt;
    assert.equal(connects[0].payload.attemptId, attemptId);
    let backendId = 'ssh_new';
    let connect = connects[0];
    ctx.__emit('ssh-connecting', { tabId: backendId, attemptId });
    if (handshakeFailure) {
        ctx.__emit('ssh-error', { tabId: backendId, attemptId, error: 'handshake timeout' });
        connect.resolve({ cancelled: true });
        await new Promise(resolve => setImmediate(resolve));
        ctx.__tq.advance(2000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(connects.length, 2);
        connect = connects[1];
        attemptId = owner._pendingAttempt;
        assert.equal(connect.payload.attemptId, attemptId);
        backendId = 'ssh_retry';
        ctx.__emit('ssh-connecting', { tabId: backendId, attemptId });
    }
    if (earlyAlternate) {
        ctx.__emit('pty-output', { tabId: backendId, data: '\x1b[?1049hNEW TUI' });
    }
    ctx.__emit('ssh-connected', { tabId: backendId, attemptId });
    connect.resolve({ tabId: backendId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(owner.tabId, backendId);
    if (clearOnConnect) assert.notEqual(owner.term, oldTerm);
    else assert.equal(owner.term, oldTerm);
    if (sibling) ctx.TabManager._extractPaneToTab(tab.id, sibling.id);
    assert.equal(tab.splitRoot ?? null, null);
    return { ctx, tab, backendId };
}

for (const split of [true, false]) {
    const label = split ? 'pane reconnect then collapse' : 'single-tab reconnect';
    test(`${label}: clearing the terminal resets the old screen capture gate`, async () => {
        const { ctx, tab } = await reconnectCaptureFixture({ split, clearOnConnect: true });
        ctx.__emit('pty-output', { tabId: 'ssh_new', data: 'NEW NORMAL OUTPUT\r\n' });
        assert.equal(tab._contentBuffer, 'NEW NORMAL OUTPUT\r\n');
    });

    test(`${label}: preserving the terminal retains its screen gate until exit`, async () => {
        const { ctx, tab } = await reconnectCaptureFixture({ split, clearOnConnect: false });
        ctx.__emit('pty-output', { tabId: 'ssh_new', data: 'CONTINUING TUI FRAME' });
        assert.equal(tab._contentBuffer, '');
        ctx.__emit('pty-output', { tabId: 'ssh_new', data: '\x1b[?1049lNEW NORMAL OUTPUT\r\n' });
        assert.match(tab._contentBuffer, /NEW NORMAL OUTPUT/);
        assert.doesNotMatch(tab._contentBuffer, /TUI FRAME/);
    });

    test(`${label}: connected and RPC completion preserve a new early alternate-screen entry`, async () => {
        const { ctx, tab } = await reconnectCaptureFixture({ split, clearOnConnect: true, earlyAlternate: true });
        ctx.__emit('pty-output', { tabId: 'ssh_new', data: 'NEW TUI FRAME' });
        assert.equal(tab._contentBuffer, '');
        ctx.__emit('pty-output', { tabId: 'ssh_new', data: '\x1b[?1049lNEW NORMAL OUTPUT\r\n' });
        assert.match(tab._contentBuffer, /NEW NORMAL OUTPUT/);
    });

    test(`${label}: automatic handshake retry preserves the retained terminal capture gate`, async () => {
        const { ctx, tab, backendId } = await reconnectCaptureFixture({ split, clearOnConnect: false, handshakeFailure: true });
        ctx.__emit('pty-output', { tabId: backendId, data: 'RETRIED TUI FRAME' });
        assert.equal(tab._contentBuffer, '');
        ctx.__emit('pty-output', { tabId: backendId, data: '\x1b[?1049lRETRIED NORMAL OUTPUT\r\n' });
        assert.match(tab._contentBuffer, /RETRIED NORMAL OUTPUT/);
        assert.doesNotMatch(tab._contentBuffer, /TUI FRAME/);
    });
}
