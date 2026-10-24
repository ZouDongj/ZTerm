// ZTerm - font-stack governance unit tests (node --test)
// The pure resolver and hint predicate come from the REAL font-governance.js
// via CommonJS export (same pattern as color-utils.test.mjs); the settings
// hint wiring and the terminal-side enumeration-arrival propagation are
// exercised against the REAL settings.js / terminal.js in VM harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { loadVm, wiredTab, wiredSplitTab } from './helpers/renderer-vm.mjs';

const require = createRequire(import.meta.url);
const { governTerminalFontChain, suggestNfMonoCounterpart, BUNDLED_NF_MONO_FAMILY, DEFAULT_TERMINAL_FONT_FAMILY, BACKEND_DEFAULT_FONT_FAMILY, isDefaultTerminalFontFamily } = require('../src/renderer/font-governance.js');

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

// ── isDefaultTerminalFontFamily: the governance scope gate ──
// saveAppearance persists the font select's current value on any appearance
// save, and the select round-trips the configured chain unchanged — so after a
// settings visit that never touched the font field the config holds the
// default chain as an explicit-looking value. "Unset" therefore cannot
// distinguish "never chose a font" from "chose the default"; only equality
// with a built-in default can.

test('an unset or blank fontFamily counts as not-explicit (governance applies)', () => {
    for (const v of [undefined, null, '', '   ']) {
        assert.equal(isDefaultTerminalFontFamily(v), true, `value ${JSON.stringify(v)}`);
    }
});

test('both built-in default chains count as not-explicit (governance applies)', () => {
    assert.equal(isDefaultTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY), true);
    // The backend merges its default_config under the user config, so a clean
    // machine loads this chain; it is no more a user choice than an unset key.
    assert.equal(isDefaultTerminalFontFamily(BACKEND_DEFAULT_FONT_FAMILY), true);
});

test('any other configured chain is explicit (governance must not touch it)', () => {
    // The settings combo persists single-family picks in this exact shape.
    assert.equal(isDefaultTerminalFontFamily("'JetBrainsMonoNL NF',monospace"), false);
    assert.equal(isDefaultTerminalFontFamily("'Cascadia Mono',monospace"), false);
    assert.equal(isDefaultTerminalFontFamily('monospace'), false);
});

test('the backend default chain is governed: clean machines keep the NF Mono append', () => {
    const governed = governTerminalFontChain(BACKEND_DEFAULT_FONT_FAMILY, [BUNDLED_NF_MONO_FAMILY]);
    assert.equal(governed, '"JetBrains Mono", "Cascadia Code", Consolas, "' + BUNDLED_NF_MONO_FAMILY + '", monospace');
});

// The default chains are restated outside font-governance.js (terminal.js's
// create-path and kick fallbacks, the settings.js load-failure default, and
// src-tauri default_config). A drift between a restated literal and the
// exported constant would silently take that chain out of governance scope.
test('the restated default-chain literals stay in sync with the exported constants', () => {
    const terminalSrc = readFileSync(path.join(root, 'src/renderer/terminal.js'), 'utf8');
    assert.equal(terminalSrc.split(`c.fontFamily || '${DEFAULT_TERMINAL_FONT_FAMILY}'`).length - 1, 2,
        'terminal.js names the renderer default chain in both the create path and the kick');
    assert.ok(settingsSrc.includes(`fontFamily: '${DEFAULT_TERMINAL_FONT_FAMILY}'`),
        'settings.js loadSettings fallback names the renderer default chain');
    const ztermSrc = readFileSync(path.join(root, 'src-tauri/src/zterm.rs'), 'utf8');
    assert.ok(ztermSrc.includes(`"fontFamily": "${BACKEND_DEFAULT_FONT_FAMILY.replace(/"/g, '\\"')}"`),
        'src-tauri default_config names the backend default chain');
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
    // fontFamily unset: the built-in default chain applies and stays governed.
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    const tab = wiredTab(ctx, 't1', 'b1');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(tab.term.options.fontFamily, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
    // With the cache warm, the create path resolves the governed chain synchronously.
    const opts = ctx._buildTerminalOptions();
    assert.equal(opts.fontFamily, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
});

test('a machine without an installed NF Mono is governed onto the bundled family', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = DEFAULT_TERMINAL_FONT_FAMILY;
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['Cascadia Mono'])
        : new Promise(() => {});
    const tab = wiredTab(ctx, 't1', 'b1');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // The vendored JetBrainsMonoNL NFM faces (registered as document fonts at
    // startup) are reported alongside the OS enumeration, so the resolver
    // always has an NF Mono counterpart to swap to.
    assert.equal(tab.term.options.fontFamily, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
    const opts = ctx._buildTerminalOptions();
    assert.equal(opts.fontFamily, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
});

test('getSystemFonts appends the bundled NF Mono family exactly once', async () => {
    const ctx = loadVm();
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['Cascadia Mono'])
        : new Promise(() => {});
    const fonts = await ctx.getSystemFonts();
    assert.ok(fonts.includes('JetBrainsMonoNL NFM'), 'bundled family reported when the OS lacks it');
    assert.equal(fonts[0], 'Cascadia Mono', 'OS families keep their order up front');

    const ctx2 = loadVm();
    ctx2.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM', 'Cascadia Mono'])
        : new Promise(() => {});
    const fonts2 = await ctx2.getSystemFonts();
    assert.equal(fonts2.filter(f => f === 'JetBrainsMonoNL NFM').length, 1,
        'no duplicate when the OS already has the family installed');
});

// The @font-face registration in main.js and the enumeration injection here
// must agree on one family spelling, or the governed chain would name a
// family no document font provides. main.js references the exported constant
// rather than restating the string; this test pins both ends.
test('the bundled @font-face family matches the governance chain', () => {
    assert.equal(BUNDLED_NF_MONO_FAMILY, 'JetBrainsMonoNL NFM');
    // The resolver's first Mono candidate for the default chain family.
    const governed = governTerminalFontChain('"JetBrainsMonoNL NF", monospace', [BUNDLED_NF_MONO_FAMILY]);
    assert.equal(governed, '"' + BUNDLED_NF_MONO_FAMILY + '", monospace');
    const mainSrc = readFileSync(path.join(root, 'src/renderer/main.js'), 'utf8');
    assert.ok(/new FontFace\(BUNDLED_NF_MONO_FAMILY,/.test(mainSrc),
        'main.js registers the vendored faces under the shared constant');
    // Every registered weight file must exist under src/assets/fonts/.
    for (const m of mainSrc.matchAll(/assets\/fonts\/(JetBrainsMonoNLNerdFontMono-[A-Za-z]+\.ttf)/g)) {
        assert.ok(existsSync(path.join(root, 'src/assets/fonts', m[1])), m[1] + ' is vendored');
    }
});

// The kick's split branch: assigning through term.options re-measures and
// reflows the terminal in place, and the enumeration typically arrives AFTER
// the first terminals are wired, so every pane of an already-split tab must
// be reached by the arrival propagation — a pane missed here keeps rendering
// on the ungoverned (non-Mono NF) chain for the whole session.
test('the governance kick re-applies the governed chain to every pane of a split tab', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = DEFAULT_TERMINAL_FONT_FAMILY;
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'b1', null, 'b2', null);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const governed = '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace';
    assert.equal(p1.term.options.fontFamily, governed, 'the original tab terminal (now pane 1) is re-governed');
    assert.equal(p2.term.options.fontFamily, governed, 'the later-wired pane is re-governed');
    assert.ok(tab.splitRoot, 'the tab is still split at fire time');
});

// ── Explicit chains render verbatim (the other side of the scope gate) ──

test('an explicitly configured non-Mono NF chain passes the create path ungoverned', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = "'JetBrainsMonoNL NF',monospace";
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    // Warm the enumeration cache first: even with the Mono counterpart known,
    // the explicit chain must not be rewritten.
    await ctx.getSystemFonts();
    assert.ok(ctx.peekSystemFonts(), 'enumeration cache warm');
    assert.equal(ctx._buildTerminalOptions().fontFamily, "'JetBrainsMonoNL NF',monospace");
});

test('the governance kick leaves explicitly configured chains untouched (single + split)', async () => {
    const ctx = loadVm();
    ctx._settingsConfig.fontFamily = "'JetBrainsMonoNL NF',monospace";
    ctx.ipcRenderer.invoke = (cmd) => cmd === 'get-system-fonts'
        ? Promise.resolve(['JetBrainsMonoNL NFM'])
        : new Promise(() => {});
    const { tab, p1, p2 } = wiredSplitTab(ctx, 't1', 'b1', null, 'b2', null);
    const tab2 = wiredTab(ctx, 't2', 'b3');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // The enumeration resolved and the kick's then ran (it shares the same
    // getSystemFonts promise), so a rewrite would have landed by now.
    assert.ok(ctx.peekSystemFonts(), 'enumeration cache warm: the kick fired');
    // The harness RealTerm keeps only LATER options assignments, so an
    // untouched fontFamily is exactly what "the kick never wrote" looks like.
    assert.equal(tab2.term.options.fontFamily, undefined, 'single-tab terminal never rewritten');
    assert.equal(p1.term.options.fontFamily, undefined, 'split pane 1 never rewritten');
    assert.equal(p2.term.options.fontFamily, undefined, 'split pane 2 never rewritten');
    assert.ok(tab.splitRoot, 'the tab is still split at fire time');
});

// ── saveAppearance hot-apply (REAL settings.js + REAL font-governance.js) ──
// The settings save path must share the create path's scope: governed while a
// built-in default chain is configured, verbatim for an explicit pick. The
// harness below covers saveAppearance's full element set (the hint VM above
// only wires the font selects).

function loadSaveVm(fontFamily, installedFonts, tabs) {
    const els = new Map();
    for (const id of ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font']) {
        els.set(id, mkHintSelect());
    }
    const mkInput = (value) => ({ tagName: 'INPUT', value, style: {} });
    els.set('set-font-size', mkInput('16'));
    els.set('set-line-height', mkInput('1.125'));
    els.set('set-font-weight', mkInput('400'));
    els.set('set-font-weight-bold', mkInput('600'));
    els.set('set-accent', mkInput('#61afef'));
    els.set('set-terminal-scheme', mkInput('onedark'));
    els.set('set-contrast', mkInput('1'));
    const sends = [];
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
            send: (cmd, payload) => sends.push({ cmd, payload }),
            invoke: (cmd, payload) => {
                if (cmd.startsWith('save-')) { sends.push({ cmd, payload }); return Promise.resolve(); }
                return cmd === 'get-system-fonts' ? Promise.resolve(installedFonts) : new Promise(() => {});
            },
        },
        _settingsConfig: { fontFamily },
        TabManager: { tabs, render() {} },
        getAllPanes: (t) => t._panes || [],
        Icons: { iconSvg: () => 'svg' },
        getToggle: () => true,
        updateAccentDot() {},
        applyTerminalScheme() {},
        // Already-normalized chains in; the stub keeps saveAppearance's own
        // plumbing out of scope (covered by settings-appearance.test.mjs).
        _normalizeFontFamily: (f) => f || '',
        _clampFontWeight: (v, d) => d,
        showToast() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fontGovernanceSrc, context, { filename: 'font-governance.js' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });
    return {
        context, sends,
        appearancePayload: () => sends.filter(s => s.cmd === 'save-appearance').pop()?.payload,
    };
}

test('saveAppearance hot-applies the governed chain while a default chain is configured', async () => {
    const tab = { term: { options: {} }, splitRoot: null };
    const vm1 = loadSaveVm(DEFAULT_TERMINAL_FONT_FAMILY, ['JetBrainsMonoNL NFM'], [tab]);
    await vm1.context.getSystemFonts(); // warm the enumeration cache
    vm1.context.saveAppearance();
    // The font selects hold no options, so the configured value round-trips.
    assert.equal(tab.term.options.fontFamily, '"JetBrainsMonoNL NFM", "HarmonyOS Sans SC", monospace');
    // Governance is render-time only: the persisted payload keeps the
    // configured chain verbatim, never the rewritten form.
    assert.equal(vm1.appearancePayload().fontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
});

test('saveAppearance hot-applies an explicitly configured non-Mono NF chain verbatim', async () => {
    const tab = { term: { options: {} }, splitRoot: null };
    const explicit = "'JetBrainsMonoNL NF',monospace";
    const vm1 = loadSaveVm(explicit, ['JetBrainsMonoNL NFM'], [tab]);
    await vm1.context.getSystemFonts();
    vm1.context.saveAppearance();
    assert.equal(tab.term.options.fontFamily, explicit, 'no swap onto the installed Mono counterpart');
    assert.equal(vm1.appearancePayload().fontFamily, explicit);
});
