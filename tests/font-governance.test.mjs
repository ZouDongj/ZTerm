// ZTerm - font-stack governance unit tests (node --test)
// The pure resolver and hint predicate come from the REAL font-governance.js
// via CommonJS export (same pattern as color-utils.test.mjs); the settings
// hint wiring and the terminal-side enumeration-arrival propagation are
// exercised against the REAL settings.js / terminal.js in VM harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
const { governTerminalFontChain, suggestNfMonoCounterpart } = require('../src/renderer/font-governance.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fontGovernanceSrc = readFileSync(path.join(root, 'src/renderer/font-governance.js'), 'utf8');
const settingsSrc = readFileSync(path.join(root, 'src/renderer/settings.js'), 'utf8');

const INSTALLED = ['Cascadia Mono', 'HarmonyOS Sans SC', 'JetBrainsMonoNL NFM', 'JetBrainsMonoNL NF'];

// ── governTerminalFontChain: non-Mono NF → Mono swap ──

test('shorthand NF swaps to the installed NFM counterpart (NL variant)', () => {
    const governed = governTerminalFontChain('"JetBrainsMonoNL NF", "HarmonyOS Sans SC", monospace', INSTALLED);
    assert.equal(governed, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
});

test('shorthand NF swaps to a long-form Mono counterpart when only that is installed', () => {
    const governed = governTerminalFontChain("'Hack NF',monospace", ['Hack Nerd Font Mono']);
    assert.equal(governed, "'Hack Nerd Font Mono', monospace");
});

test('long-form Nerd Font swaps to the installed Nerd Font Mono counterpart', () => {
    const governed = governTerminalFontChain('"Hack Nerd Font", monospace', ['Hack Nerd Font Mono']);
    assert.equal(governed, '"Hack Nerd Font Mono", monospace');
});

test('long-form Nerd Font falls back to the installed NFM shorthand', () => {
    const governed = governTerminalFontChain('"Hack Nerd Font", monospace', ['Hack NFM']);
    assert.equal(governed, '"Hack NFM", monospace');
});

test('Propo variants are non-Mono too and swap to the Mono counterpart', () => {
    assert.equal(governTerminalFontChain('"Hack NFP", monospace', ['Hack NFM']), '"Hack NFM", monospace');
    assert.equal(governTerminalFontChain('"Hack Nerd Font Propo", monospace', ['Hack Nerd Font Mono']),
        '"Hack Nerd Font Mono", monospace');
});

test('installed-list matching is case-insensitive and returns the installed spelling', () => {
    const governed = governTerminalFontChain('"JetBrainsMonoNL NF", monospace', ['jetbrainsmononl nfm']);
    assert.equal(governed, '"jetbrainsmononl nfm", monospace');
});

// ── No-swap cases: the chain is returned verbatim (same string) ──

test('non-Mono NF without an installed Mono counterpart stays as-is', () => {
    const chain = '"JetBrainsMonoNL NF", monospace';
    assert.equal(governTerminalFontChain(chain, ['Cascadia Mono']), chain);
});

test('a chain that already references an NF Mono family is untouched', () => {
    const chain = '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace';
    assert.equal(governTerminalFontChain(chain, INSTALLED), chain);
});

test('missing or empty installed list leaves the chain unchanged', () => {
    const chain = '"JetBrainsMonoNL NF", monospace';
    assert.equal(governTerminalFontChain(chain, null), chain);
    assert.equal(governTerminalFontChain(chain, undefined), chain);
    assert.equal(governTerminalFontChain(chain, []), chain);
});

// ── Append rule: no NF family in the chain ──

test('no-NF chain gains the first installed NF Mono just before the monospace fallback', () => {
    const governed = governTerminalFontChain("'Cascadia Mono',monospace", INSTALLED);
    assert.equal(governed, "'Cascadia Mono', \"JetBrainsMonoNL NFM\", monospace");
});

test('the append lands before the FINAL generic fallback, keeping explicit fallbacks first', () => {
    const governed = governTerminalFontChain('"HarmonyOS Sans SC", monospace', INSTALLED);
    assert.equal(governed, '"HarmonyOS Sans SC", "JetBrainsMonoNL NFM", monospace');
});

test('no append without an installed NF Mono family', () => {
    const chain = "'Cascadia Mono',monospace";
    assert.equal(governTerminalFontChain(chain, ['Cascadia Mono', 'JetBrainsMonoNL NF']), chain);
});

test('no append when the chain already has an NF family without an installed counterpart', () => {
    const chain = '"JetBrainsMonoNL NF", monospace';
    assert.equal(governTerminalFontChain(chain, ['Hack NFM']), chain);
});

test('user non-NF family order is preserved around the appended entry', () => {
    const governed = governTerminalFontChain("'B Font', 'A Font', monospace", ['B Font', 'A Font', 'JetBrainsMonoNL NFM']);
    assert.equal(governed, "'B Font', 'A Font', \"JetBrainsMonoNL NFM\", monospace");
});

test('idempotence: resolving a governed chain returns it unchanged', () => {
    const once = governTerminalFontChain('"JetBrainsMonoNL NF", "HarmonyOS Sans SC", monospace', INSTALLED);
    assert.equal(governTerminalFontChain(once, INSTALLED), once);
    const appended = governTerminalFontChain("'Cascadia Mono',monospace", INSTALLED);
    assert.equal(governTerminalFontChain(appended, INSTALLED), appended);
});

// ── suggestNfMonoCounterpart (settings hint predicate) ──

test('the chosen terminal font as a non-Mono NF suggests its installed Mono counterpart', () => {
    // The field value is the select value form (quoted family + suffix).
    assert.equal(suggestNfMonoCounterpart("'JetBrainsMonoNL NF',monospace", INSTALLED), 'JetBrainsMonoNL NFM');
    assert.equal(suggestNfMonoCounterpart('JetBrainsMonoNL NF', INSTALLED), 'JetBrainsMonoNL NFM');
    assert.equal(suggestNfMonoCounterpart('Hack Nerd Font', ['Hack NFM']), 'Hack NFM');
});

test('no suggestion for Mono NF, non-NF fonts, a missing counterpart, or a cold cache', () => {
    assert.equal(suggestNfMonoCounterpart('JetBrainsMonoNL NFM', INSTALLED), null);
    assert.equal(suggestNfMonoCounterpart('Cascadia Mono', INSTALLED), null);
    assert.equal(suggestNfMonoCounterpart("'JetBrainsMonoNL NF',monospace", ['Cascadia Mono']), null);
    assert.equal(suggestNfMonoCounterpart("'JetBrainsMonoNL NF',monospace", null), null);
    assert.equal(suggestNfMonoCounterpart('', INSTALLED), null);
});

// ── Settings hint wiring (REAL settings.js + REAL font-governance.js) ──

function mkHintSelect() {
    return {
        tagName: 'SELECT', options: [], value: '', style: {},
        set innerHTML(v) { if (v === '') this.options.length = 0; },
        get innerHTML() { return ''; },
        appendChild(c) { this.options.push(c); return c; },
    };
}

function loadSettingsHintVm(fontFamily, installedFonts) {
    const els = new Map();
    for (const id of ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font']) {
        els.set(id, mkHintSelect());
    }
    const hint = { style: { display: 'none' }, textContent: '' };
    els.set('set-font-nf-hint', hint);
    const context = {
        console,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {} }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { style: {} },
        },
        ipcRenderer: {
            send() {},
            invoke: (cmd) => cmd === 'get-system-fonts' ? Promise.resolve(installedFonts) : new Promise(() => {}),
        },
        _settingsConfig: { fontFamily },
        TabManager: { profiles: [], tabs: [], render() {} },
        Icons: { iconSvg: () => 'svg' },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fontGovernanceSrc, context, { filename: 'font-governance.js' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });
    return { context, hint };
}

test('the terminal-font hint appears for a non-Mono NF whose Mono counterpart is installed', async () => {
    const { context, hint } = loadSettingsHintVm("'JetBrainsMonoNL NF',monospace", INSTALLED);
    context.populateFontList();
    // Enumeration + build are promise-chained; flush the microtask queue.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.notEqual(hint.style.display, 'none');
    assert.ok(hint.textContent.includes('JetBrainsMonoNL NFM'));
});

test('no hint when the terminal font is already the Mono variant or not a Nerd Font', async () => {
    for (const family of ["'JetBrainsMonoNL NFM',monospace", "'Cascadia Mono',monospace"]) {
        const { context, hint } = loadSettingsHintVm(family, INSTALLED);
        context.populateFontList();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.equal(hint.style.display, 'none', `family ${family} must not raise the hint`);
    }
});

// ── Terminal-side governance (REAL terminal.js via the shared renderer VM) ──

test('a terminal created before the enumeration completes is re-governed when the list arrives', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = '"JetBrainsMonoNL NF", monospace';
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    const tab = wiredTab(ctx, 't1', 'b1');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(tab.term.options.fontFamily, '"JetBrainsMonoNL NFM", monospace');
    // With the cache warm, the create path resolves the governed chain synchronously.
    const opts = ctx._buildTerminalOptions();
    assert.equal(opts.fontFamily, '"JetBrainsMonoNL NFM", monospace');
});

test('terminals keep the raw chain when enumeration yields no NF Mono counterpart', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = '"JetBrainsMonoNL NF", monospace';
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['Cascadia Mono'])
        : new Promise(() => {});
    const tab = wiredTab(ctx, 't1', 'b1');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // The arrival propagation assigns the (unchanged) chain — no swap happened.
    assert.equal(tab.term.options.fontFamily, '"JetBrainsMonoNL NF", monospace');
    const opts = ctx._buildTerminalOptions();
    assert.equal(opts.fontFamily, '"JetBrainsMonoNL NF", monospace');
});

// The kick's split branch: assigning through term.options re-measures and
// reflows the terminal in place, and the enumeration typically arrives AFTER
// the first terminals are wired, so every pane of an already-split tab must
// be reached by the arrival propagation — a pane missed here keeps rendering
// on the ungoverned (non-Mono NF) chain for the whole session.
test('the governance kick re-applies the governed chain to every pane of a split tab', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = '"JetBrainsMonoNL NF", monospace';
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'b1', null, 'b2', null);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const governed = '"JetBrainsMonoNL NFM", monospace';
    assert.equal(p1.term.options.fontFamily, governed, 'the original tab terminal (now pane 1) is re-governed');
    assert.equal(p2.term.options.fontFamily, governed, 'the later-wired pane is re-governed');
    assert.ok(tab.splitRoot, 'the tab is still split at fire time');
});
