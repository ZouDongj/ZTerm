// ZTerm - tab display-name resolution pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveTabName, resolveTabDisplayName, parseTabRenamePayload } = require('../src/renderer/tab-title-utils.js');

// ── resolveTabName: persisted base naming (no tool/OSC overlay) ──

test('resolveTabName: single-terminal tab keeps its current name', () => {
    assert.equal(resolveTabName({ name: 'Git Bash' }, []), 'Git Bash');
});

test('resolveTabName: manual rename (_customName) locks the name (null)', () => {
    assert.equal(resolveTabName({ name: '我的服务器', _customName: true }, []), null);
    const splitTab = { name: '我的分屏', _customName: true, splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(splitTab, [{ name: 'a' }]), null);
});

test('resolveTabName: _oscTitle/_toolName data on the tab is ignored', () => {
    const tab = { name: 'SSH', _oscTitle: 'root@host: ~', _toolName: 'ai-task' };
    assert.equal(resolveTabName(tab, []), 'SSH');
});

test('resolveTabName: split joins pane names with dedup', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    const panes = [{ name: 'ssh-a' }, { name: 'ssh-a' }, { name: 'local' }];
    assert.equal(resolveTabName(tab, panes), 'ssh-a | local');
});

test('resolveTabName: split ignores pane _oscTitle/_toolName', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    const panes = [
        { name: 'ssh-a', _oscTitle: 'root@a:~', _toolName: 'ai-a' },
        { name: 'ssh-b', _oscTitle: 'root@b:~', _toolName: 'ai-b' },
    ];
    assert.equal(resolveTabName(tab, panes), 'ssh-a | ssh-b');
});

test('resolveTabName: split single pane falls back through pane name to tab name', () => {
    const tab = { name: 'fallback', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, [{ name: 'profile' }]), 'profile');
    assert.equal(resolveTabName(tab, [{ name: '' }]), 'fallback');
    assert.equal(resolveTabName(tab, []), 'fallback');
});

test('resolveTabName: all-nameless split yields empty string (existing semantics)', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, [{ name: '' }, { name: '' }]), '');
});

test('resolveTabName: bad input does not throw', () => {
    assert.equal(resolveTabName(null, []), null);
    const tab = { name: 'x', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabName(tab, null), 'x');
    assert.equal(resolveTabName(tab, [null, undefined]), '');
});

// ── resolveTabDisplayName: ephemeral tool-name display overlay ──

test('display: single tab without a tool name shows the base name', () => {
    assert.equal(resolveTabDisplayName({ name: 'Git Bash' }, []), 'Git Bash');
});

test('display: tool name overrides the base name on a single tab', () => {
    const tab = { name: 'SSH', _toolName: 'my-ai-task' };
    assert.equal(resolveTabDisplayName(tab, []), 'my-ai-task');
});

test('display: tool name is trimmed', () => {
    assert.equal(resolveTabDisplayName({ name: 'SSH', _toolName: '  build  ' }, []), 'build');
});

test('display: empty/whitespace tool name falls back to the base name', () => {
    assert.equal(resolveTabDisplayName({ name: 'SSH', _toolName: '' }, []), 'SSH');
    assert.equal(resolveTabDisplayName({ name: 'SSH', _toolName: '   ' }, []), 'SSH');
});

test('display: manual rename (_customName) wins over the tool name', () => {
    const tab = { name: '我的服务器', _customName: true, _toolName: 'ai-task' };
    assert.equal(resolveTabDisplayName(tab, []), '我的服务器');
    const splitTab = { name: 'locked', _customName: true, splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabDisplayName(splitTab, [{ name: 'p', _toolName: 'ai' }]), 'locked');
});

test('display: split joins per-pane tool names with dedup', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    const panes = [
        { name: 'ssh-a', _toolName: 'agent' },
        { name: 'ssh-b', _toolName: 'agent' },
        { name: 'ssh-c' }, // no tool name → pane base name
    ];
    assert.equal(resolveTabDisplayName(tab, panes), 'agent | ssh-c');
});

test('display: split pane with empty tool name falls back to its pane name', () => {
    const tab = { name: 'old', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabDisplayName(tab, [{ name: 'p1', _toolName: '  ' }]), 'p1');
    assert.equal(resolveTabDisplayName(tab, [{ name: '' }]), 'old');
});

test('display: bad input does not throw', () => {
    assert.equal(resolveTabDisplayName(null, []), '');
    const tab = { name: 'x', splitRoot: { orientation: 'h' } };
    assert.equal(resolveTabDisplayName(tab, null), 'x');
});

// ── parseTabRenamePayload: OSC 1337 ZTermTabName= channel ──

test('parse: matching prefix returns the name verbatim (interior space kept)', () => {
    assert.equal(parseTabRenamePayload('ZTermTabName=my-ai-task'), 'my-ai-task');
    assert.equal(parseTabRenamePayload('ZTermTabName=my task v2'), 'my task v2');
});

test('parse: value may itself contain = (slice-after-prefix semantics)', () => {
    assert.equal(parseTabRenamePayload('ZTermTabName=a=b'), 'a=b');
});

test('parse: empty value means clear', () => {
    assert.equal(parseTabRenamePayload('ZTermTabName='), '');
});

test('parse: whitespace-only value means clear', () => {
    assert.equal(parseTabRenamePayload('ZTermTabName=   '), '');
});

test('parse: other 1337 payloads are not consumed (null)', () => {
    assert.equal(parseTabRenamePayload('SetUserVar=foo'), null);
    assert.equal(parseTabRenamePayload('File=name:aGV4'), null);
    assert.equal(parseTabRenamePayload('ZTermTabNameX=nope'), null);
    assert.equal(parseTabRenamePayload(''), null);
});

test('parse: non-string input is not consumed', () => {
    assert.equal(parseTabRenamePayload(undefined), null);
    assert.equal(parseTabRenamePayload(null), null);
});
