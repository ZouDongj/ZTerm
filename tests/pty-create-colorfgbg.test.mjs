// COLORFGBG seeding of local pty-create payloads (issue #12). ConPTY does
// not forward the shell's OSC 10/11 color queries, so TUI apps fall back to
// the COLORFGBG env var; every local pty-create send site in tabs.js must
// carry a colorFgbg derived from the rendered scheme background (real
// colorFgbgForBackground from color-utils.js; getTerminalTheme is stubbed at
// the cross-script boundary with a controllable background). SSH isolation is
// pinned too: an SSH tab must not produce any pty-create.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { colorFgbgForBackground } = require('../src/renderer/color-utils.js');

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

// Modeled on tests/split-field-migration.test.mjs loadTabsVm: the REAL
// tabs.js migration methods in a VM; only the environment and the two
// cross-script globals the payload helper reads are stubbed.
function loadTabsVm(background) {
    const sends = [];
    let themeBackground = background;
    const ctx = {
        console, crypto: webcrypto,
        // Timers are queued but never auto-run: the REAL SSH queue chain
        // (createTab on an ssh tab — tabs.js's internal _sshConnectWithCredentials
        // shadows any ctx-level stub) arms a 20s fallback timer whose body must
        // not fire synchronously inside the TDZ window of its own clearTimeout.
        // The connect chain itself settles normally via the invoke() promise.
        setTimeout: () => 0, clearTimeout() {},
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
        _sendInputForTerm() {}, _sendResizeForTerm() {}, _fitWithScroll() {},
        _scheduleTerminalFocus() {}, _focusTerminalIfCurrent() {},
        createTermWrap: () => ({ wrap: fakeEl(), inner: fakeEl() }),
        setupWrapResizeObserver() {}, _scheduleSettleResize() {},
        _sshConnectWithCredentials() {}, saveConfig() {},
        // The two globals _ptyCreatePayload reads (state.js/color-utils.js in
        // the page): theme background controllable per test, luminance REAL.
        getTerminalTheme: () => ({ background: themeBackground }),
        colorFgbgForBackground,
    };
    ctx.setThemeBackground = (bg) => { themeBackground = bg; };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['split-layout.js', 'pane-fields.js', 'ssh-attempts.js', 'tab-title-utils.js', 'tabs.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    ctx.TabManager = vm.runInContext('TabManager', ctx);
    ctx.sshAttempts = vm.runInContext('sshAttempts', ctx);
    return { ctx, sends };
}

test('local createTab seeds colorFgbg from the dark scheme background', () => {
    const { ctx, sends } = loadTabsVm('#1e1e1e');
    ctx.TabManager.createTab({ type: 'local', command: 'powershell.exe', args: [] });
    const created = sends.filter(s => s.cmd === 'pty-create');
    assert.equal(created.length, 1, 'exactly one pty-create for a local tab');
    assert.equal(created[0].payload.colorFgbg, '15;0');
    // Existing payload field semantics are unchanged.
    assert.equal(created[0].payload.shell, 'powershell.exe');
    assert.equal(created[0].payload.requestId, ctx.TabManager.tabs[0].id);
});

test('local createTab on a light scheme background reports 0;15', () => {
    const { ctx, sends } = loadTabsVm('#ffffff');
    ctx.TabManager.createTab({ type: 'local', command: 'powershell.exe', args: [] });
    assert.equal(sends.find(s => s.cmd === 'pty-create').payload.colorFgbg, '0;15');
});

test('SSH tabs never produce a pty-create (COLORFGBG stays a local-shell concern)', () => {
    const { ctx, sends } = loadTabsVm('#1e1e1e');
    ctx.TabManager.createTab({ type: 'ssh', host: 'h1', port: 22, user: 'u1' });
    assert.equal(sends.filter(s => s.cmd === 'pty-create').length, 0);
});

test('closeTab dead-shell fallback send site also carries colorFgbg', () => {
    const { ctx, sends } = loadTabsVm('#282c34');
    const T = ctx.TabManager;
    // Sole tab, no terminal, no backend session, nothing pending: the last-tab
    // guard resets it to a fresh local shell (the second pty-create site).
    T.tabs.push({ id: 't_dead', name: 'dead', type: 'local', command: 'cmd.exe', args: [], term: null, fitAddon: null, tabId: null });
    T.closeTab('t_dead');
    const created = sends.filter(s => s.cmd === 'pty-create');
    assert.equal(created.length, 1, 'dead-shell reset spawns one local shell');
    assert.equal(created[0].payload.colorFgbg, '15;0');
    assert.equal(created[0].payload.shell, 'cmd.exe');
    assert.equal(created[0].payload.cwd, undefined, 'this site historically sends no cwd');
});

test('pane spawn send site carries colorFgbg too', () => {
    const { ctx, sends } = loadTabsVm('#1e1e1e');
    const T = ctx.TabManager;
    sends.length = 0;
    T._spawnBackendForPane({ type: 'local', _command: 'bash.exe', _args: [], requestId: 'p_1' }, { command: 'powershell.exe', args: [] });
    const spawn = sends.find(s => s.cmd === 'pty-create');
    assert.ok(spawn, 'pty-create sent');
    assert.equal(spawn.payload.colorFgbg, '15;0');
});

test('unparsable theme background degrades to null colorFgbg without throwing', () => {
    const { ctx, sends } = loadTabsVm('#xyz');
    ctx.TabManager.createTab({ type: 'local', command: 'powershell.exe', args: [] });
    const created = sends.find(s => s.cmd === 'pty-create');
    assert.ok(created, 'pty-create still sent');
    assert.equal(created.payload.colorFgbg, null, 'invalid hex must not crash the create path');
});
