import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQcVm, runIn } from './helpers/manager-vm.mjs';

const read = name => readFileSync(new URL(`../src/renderer/${name}`, import.meta.url), 'utf8');
const complexId = 'legacy \' " < > \t\n 雪 😀 &';

function withRealEscapers(ctx) {
    const utilsSrc = read('utils.js');
    const definition = name => {
        const match = new RegExp('^function ' + name + '\\b.*$', 'm').exec(utilsSrc);
        assert.ok(match, `${name} definition found`);
        return match[0];
    };
    vm.runInContext(definition('escHtml') + '\n' + definition('escAttr'), ctx);
    return ctx;
}

function escapedAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

test('highlight rule actions keep special-character IDs out of inline handlers', () => {
    const ctx = withRealEscapers(loadQcVm());
    vm.runInContext(read('highlight.js'), ctx, { filename: 'highlight.js' });
    runIn(ctx, `_highlightRules = [{ id: ${JSON.stringify(complexId)}, text: 'rule', enabled: true }]`);

    ctx.renderHighlightRulesList();

    const html = ctx.document.getElementById('highlight-rules-list').innerHTML;
    assert.doesNotMatch(html, /on(?:click|input|change|mouseenter|mouseover)=/);
    assert.ok(html.includes(`data-highlight-id="${escapedAttribute(complexId)}"`));
});

test('quick-command panel actions keep special-character IDs out of inline handlers', () => {
    const ctx = withRealEscapers(loadQcVm());
    runIn(ctx, `_qcCommands = [{ id: ${JSON.stringify(complexId)}, name: 'command', command: 'echo safe', group: 'group' }]`);

    ctx.qcFilter();

    const html = ctx.document.getElementById('qc-list').innerHTML;
    assert.doesNotMatch(html, /on(?:click|input|change|mouseenter|mouseover)=/);
    assert.ok(html.includes(`data-quick-command-id="${escapedAttribute(complexId)}"`));
});

test('shell visibility toggles preserve exact IDs and clickable behavior without HTML interpolation', () => {
    const ctx = loadQcVm();
    vm.runInContext(read('settings.js'), ctx, { filename: 'settings.js' });
    ctx.getDefaultLocalProfile = () => ctx.TabManager.profiles[0];
    ctx._firstFontName = () => '';
    ctx._normalizeWordSeparators = value => value || '';
    ctx.setToggle = () => {};
    ctx.populateTerminalSchemeSelect = () => {};
    ctx.updateAccentDot = () => {};
    ctx.renderAccentSwatches = () => {};
    ctx.populateFontList = () => {};
    ctx.document.getElementById('set-font').options = [];
    ctx._settingsConfig = { hiddenProfiles: [] };
    ctx.TabManager.profiles = [{ id: complexId, name: complexId, command: 'powershell.exe', args: [] }];

    ctx.loadSettingsIntoForm();

    const toggle = ctx.document.getElementById('shell-visibility-list').querySelector('.toggle-switch');
    assert.ok(toggle, 'the visibility toggle is a real child element');
    assert.equal(toggle.id, 'toggle-shell-' + complexId);
    assert.equal(toggle.getAttribute('onclick'), null);
    let saves = 0;
    ctx.saveTerminal = () => { saves++; };
    toggle.click();
    assert.equal(toggle.classList.contains('on'), false);
    assert.equal(saves, 1);
});

test('existing delegated profile and settings rows retain their safe attribute boundary', () => {
    const ctx = withRealEscapers(loadQcVm());
    ctx.SshDisplay = {
        sshDisplayModel: profile => ({
            named: true, primary: profile.name, primaryIsHost: false,
            endpoint: profile.host, user: profile.username, port: 22, keyAuth: false,
        }),
    };
    vm.runInContext(read('ssh.js'), ctx, { filename: 'ssh.js' });
    const profile = { id: complexId, name: complexId, host: '127.0.0.1', username: 'user', group: complexId };
    const rows = [
        ctx._qcRowHtml({ ...profile, command: 'echo safe' }),
        ctx._sshRowHtml(profile),
        ctx._sessionRowHtml({
            id: 'local_' + complexId, type: 'local', name: complexId,
            detail: 'powershell.exe', badge: '', profile,
        }),
    ];

    for (const html of rows) {
        assert.doesNotMatch(html, /on(?:click|input|change|mouseenter|mouseover)=/);
        assert.ok(html.includes(escapedAttribute(complexId)));
    }
});


test('attribute escaping reversibly preserves CR, CRLF and LF', () => {
    const ctx = withRealEscapers(loadQcVm());
    assert.equal(ctx.escAttr('a\rb\r\nc\nd &#13;'), 'a&#13;b&#13;&#10;c&#10;d &amp;#13;');
});
