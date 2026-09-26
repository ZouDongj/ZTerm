// ZTerm - pane→tab session-field adoption unit tests (ADR-0004 §3.2).
// ADR item 4 red case: collapsing a split must adopt the surviving pane's
// session identity (host/user/profile/credential/command); the old code kept
// the container's fields, so a reconnect went to the WRONG host and a later
// split spawned the WRONG shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { adoptPaneFieldsIntoTab } = require('../src/renderer/pane-fields.js');

const sshPane = (over = {}) => ({
    type: 'ssh',
    _sshHost: '10.1.1.20', _sshPort: 2222, _sshUser: 'deploy',
    _sshProfileId: 'prof-b', _sshCredId: 'cred-b',
    _command: '', _args: [],
    ...over,
});
const localPane = (over = {}) => ({
    type: 'local',
    _sshHost: undefined, _sshPort: undefined, _sshUser: undefined,
    _sshProfileId: undefined, _sshCredId: undefined,
    _command: 'bash.exe', _args: ['--login', '-i'],
    ...over,
});

test('SSH pane → tab adopts host/port/user/profile/credential, clears command', () => {
    const tab = { id: 't_1', type: 'ssh', host: '10.1.1.10', port: 22, user: 'old', sshProfileId: 'prof-a', _credId: 'cred-a', command: 'x', args: ['y'] };
    adoptPaneFieldsIntoTab(tab, sshPane());
    assert.equal(tab.type, 'ssh');
    assert.equal(tab.host, '10.1.1.20');
    assert.equal(tab.port, 2222);
    assert.equal(tab.user, 'deploy');
    assert.equal(tab.sshProfileId, 'prof-b');
    assert.equal(tab._credId, 'cred-b');
    assert.equal(tab.command, '', 'ssh tab carries no shell command');
    assert.deepEqual(tab.args, []);
});

test('SSH pane without its own credential keeps the tab credential handle', () => {
    const tab = { id: 't_1', type: 'ssh', host: 'h', _credId: 'cred-a' };
    adoptPaneFieldsIntoTab(tab, sshPane({ _sshCredId: undefined }));
    assert.equal(tab._credId, 'cred-a', 'shared handle must not be revoked by the adoption');
});

test('local pane in an SSH tab clears the ssh fields and adopts command/args', () => {
    const tab = { id: 't_1', type: 'ssh', host: '10.9.9.9', port: 22, user: 'ops', sshProfileId: 'prof-a', _credId: 'cred-a', command: '', args: [] };
    adoptPaneFieldsIntoTab(tab, localPane());
    assert.equal(tab.type, 'local');
    assert.equal(tab.host, undefined);
    assert.equal(tab.port, undefined);
    assert.equal(tab.user, undefined);
    assert.equal(tab.sshProfileId, undefined);
    assert.equal(tab.command, 'bash.exe');
    assert.deepEqual(tab.args, ['--login', '-i']);
});

test('local pane with an empty args array is not overridden by the tab args', () => {
    // ADR item 5: an empty args array is meaningful; another owner's args must not leak in
    const tab = { id: 't_1', type: 'local', command: 'powershell.exe', args: ['-NoLogo'] };
    adoptPaneFieldsIntoTab(tab, localPane({ _command: 'wsl.exe', _args: [] }));
    assert.equal(tab.command, 'wsl.exe');
    assert.deepEqual(tab.args, [], 'empty array must survive verbatim');
});

test('local pane with empty _command adopts empty string, not the tab command', () => {
    const tab = { id: 't_1', type: 'local', command: 'powershell.exe', args: ['-NoLogo'] };
    adoptPaneFieldsIntoTab(tab, localPane({ _command: '' }));
    assert.equal(tab.command, '');
    assert.deepEqual(tab.args, ['--login', '-i']);
});

test('pane without type defaults the tab to local', () => {
    const tab = { id: 't_1', type: 'ssh', host: 'h' };
    adoptPaneFieldsIntoTab(tab, localPane({ type: undefined }));
    assert.equal(tab.type, 'local');
});

test('adopted identity never falls back to the container (extract-to-new-tab path)', () => {
    // _extractPaneToTab used `pane._sshHost || st.host`; the fallback is the bug
    const stLike = { host: 'host-a', port: 22, user: 'a', sshProfileId: 'prof-a', _credId: 'cred-a' };
    const nt = { id: 't_new' };
    adoptPaneFieldsIntoTab(nt, sshPane({ _sshHost: undefined, _sshPort: undefined, _sshUser: undefined, _sshCredId: undefined }));
    assert.equal(nt.host, undefined, 'must NOT fall back to the source tab host');
    assert.equal(nt.port, undefined);
    assert.equal(nt.user, undefined);
    assert.equal(nt._credId, undefined, 'no credential of the source tab leaks onto the new tab');
});

test('missing tab or pane is a no-op', () => {
    const tab = { id: 't_1', type: 'ssh', host: 'h' };
    adoptPaneFieldsIntoTab(null, sshPane());
    adoptPaneFieldsIntoTab(tab, null);
    adoptPaneFieldsIntoTab(undefined, undefined);
    assert.equal(tab.host, 'h');
    assert.equal(tab.type, 'ssh');
});
