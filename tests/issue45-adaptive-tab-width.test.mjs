// Issue #45: opt-in adaptive tab width (adaptiveTabWidth, default false).
// Verifies CSS contract, renderer.html toggle markup, state.js chrome flag,
// real tabs.js layout/live-toggle/re-measurement/close-deferral/scroll behavior,
// and real settings.js form/save/persist/fallback round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const require = createRequire(import.meta.url);
const { TAB_ADAPTIVE_MIN, TAB_CONTENT_MIN, TAB_MAX_WIDTH, TAB_MIN_WIDTH, TAB_STRIP_RIGHT_RESERVE } = require('../src/renderer/tabstrip-layout.js');

const css = read('src/renderer/app.css');
const html = read('src/renderer.html');
const stateSrc = read('src/renderer/state.js');
const settingsSrc = read('src/renderer/settings.js');
const colorUtilsSrc = read('src/renderer/color-utils.js');

const ruleBody = (selector) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, `CSS rule not found: ${selector}`);
    return m[1];
};

// ── CSS & HTML contracts ────────────────────────────────────────────────────

test('CSS contract: adaptive rules enforce [72px, 240px], keep flex 0 0 auto, and override overflow 100px without layout transitions', () => {
    const baseTab = ruleBody('.tab');
    assert.ok(baseTab.includes(`min-width:${TAB_CONTENT_MIN}px`), 'default .tab keeps 110px content floor');
    assert.ok(baseTab.includes(`max-width:${TAB_MAX_WIDTH}px`), 'default .tab keeps 240px max width');
    assert.ok(!/transition[^;]*\b(width|flex|min-width|max-width)\b/.test(baseTab), '.tab must never transition layout properties');

    const adaptiveSel = '#tabbar.tabbar-adaptive .tab,#tabbar.tabbar-adaptive.tabbar-overflow .tab';
    const adaptiveBody = ruleBody(adaptiveSel);
    assert.ok(adaptiveBody.includes('flex:0 0 auto'), 'adaptive tabs never shrink in overflow');
    assert.ok(adaptiveBody.includes('width:auto'), 'adaptive overflow resets default overflow width:100px');
    assert.ok(adaptiveBody.includes(`min-width:${TAB_ADAPTIVE_MIN}px`), 'adaptive min-width mirrors TAB_ADAPTIVE_MIN');
    assert.ok(adaptiveBody.includes(`max-width:${TAB_MAX_WIDTH}px`), 'adaptive max-width mirrors TAB_MAX_WIDTH');
    assert.ok(!adaptiveBody.includes('transition'), 'adaptive rule adds zero transitions');

    const overflowIdx = css.indexOf('#tabbar.tabbar-overflow .tab{width:100px}');
    const adaptiveIdx = css.indexOf(adaptiveSel + '{');
    assert.ok(overflowIdx > 0 && adaptiveIdx > overflowIdx,
        'adaptive rule must follow #tabbar.tabbar-overflow .tab so adaptive overflow never pins 100px');
});

test('HTML contract: Appearance settings ships toggle-adaptive-tab-width default OFF wired to saveAppearance', () => {
    const m = html.match(/<div class="toggle-switch" id="toggle-adaptive-tab-width" onclick="toggleSwitch\(this\);saveAppearance\(\)"><\/div>/);
    assert.ok(m, 'toggle-adaptive-tab-width must ship without .on (default false) and call saveAppearance()');
    assert.ok(html.includes('标签页自适应宽度'), 'Chinese label present in Appearance settings');
});

// ── state.js applyChromeFlags ───────────────────────────────────────────────

test('state.js applyChromeFlags toggles tabbar-adaptive only for explicit adaptiveTabWidth === true', () => {
    const barClasses = new Set();
    const winClasses = new Set();
    const bodyClasses = new Set();
    const mkClassList = (set) => ({
        toggle(cls, force) {
            const on = force === undefined ? !set.has(cls) : !!force;
            if (on) set.add(cls); else set.delete(cls);
        },
        contains: (cls) => set.has(cls),
    });
    const ctx = {
        path, process, console,
        document: {
            body: { classList: mkClassList(bodyClasses) },
            documentElement: { style: { setProperty() {} } },
            querySelector: (sel) => sel === '.window' ? { classList: mkClassList(winClasses) } : null,
            querySelectorAll: () => [],
            getElementById: (id) => id === 'tabbar' ? { classList: mkClassList(barClasses) } : null,
        },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(stateSrc, ctx, { filename: 'state.js' });

    // Missing field (legacy config) -> off
    vm.runInContext('applyChromeFlags()', ctx);
    assert.equal(barClasses.has('tabbar-adaptive'), false);

    // Explicit false -> off
    vm.runInContext('_settingsConfig.adaptiveTabWidth = false; applyChromeFlags()', ctx);
    assert.equal(barClasses.has('tabbar-adaptive'), false);

    // Explicit true -> on
    vm.runInContext('_settingsConfig.adaptiveTabWidth = true; applyChromeFlags()', ctx);
    assert.equal(barClasses.has('tabbar-adaptive'), true);
});

// ── Real tabs.js strip behavior via renderer-vm.mjs ─────────────────────────

// Install CSS-aware offsetWidth measurement on tab elements in the VM:
// models the real CSS rules:
// - when inline el.style.width is set, offsetWidth returns that pinned width;
// - otherwise, when #tabbar has .tabbar-adaptive, natural width is clamped to
//   [TAB_ADAPTIVE_MIN, TAB_MAX_WIDTH];
// - otherwise, natural width is clamped to [TAB_CONTENT_MIN, TAB_MAX_WIDTH].
function installCssTabMetrics(ctx, naturalWidthById, barClientWidth) {
    const bar = ctx.document.getElementById('tabbar');
    bar._cw = barClientWidth;
    const addBtn = ctx.document.getElementById('btn-add-tab');
    addBtn.offsetWidth = 26;
    const origCreate = ctx.document.createElement;
    const attachOffsetWidth = (el) => {
        Object.defineProperty(el, 'offsetWidth', {
            configurable: true,
            get() {
                if (this._fixedOffsetWidth !== undefined) return this._fixedOffsetWidth;
                if (this.classList.contains('tab-scroll-btn')) return 24;
                if (!this.classList.contains('tab')) return 0;
                const pinned = parseFloat(this.style.width);
                if (Number.isFinite(pinned) && pinned > 0) return pinned;
                const raw = naturalWidthById.get(this.getAttribute('data-tab')) ?? 72;
                const floor = bar.classList.contains('tabbar-adaptive') ? TAB_ADAPTIVE_MIN : TAB_CONTENT_MIN;
                return Math.min(TAB_MAX_WIDTH, Math.max(floor, raw));
            },
            set(v) { this._fixedOffsetWidth = v; },
        });
        return el;
    };
    ctx.document.createElement = (tag) => attachOffsetWidth(origCreate(tag));
    return { bar };
}

test('default mode (adaptiveTabWidth false/missing) preserves equal-width sharing, overflow 100px, and priority expansion', () => {
    const ctx = loadVm();
    const widths = new Map([['t1', 72], ['t2', 85], ['t3', 240], ['t4', 240]]);
    // bar clientWidth = 600 -> avail = 600 - 48 (reserve) - 26 (addBtn) - 2 (gap) = 524
    // Default floor 110 -> measured [110, 110, 240, 240], sum = 706 > 524 -> sharing!
    const { bar } = installCssTabMetrics(ctx, widths, 600);
    for (const id of ['t1', 't2', 't3', 't4']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('t3');
    ctx.TabManager.render();

    assert.equal(bar.classList.contains('tabbar-adaptive'), false);
    assert.equal(bar.classList.contains('tabbar-sharing'), true);
    assert.equal(bar.classList.contains('tabbar-overflow'), false);
    assert.equal(ctx.TabManager._lastStripPlan.state, 'sharing');
    assert.ok(ctx.TabManager._lastStripPlan.tabWidth >= TAB_MIN_WIDTH);
    const expanded = ctx.TabManager._lastStripPlan.widths;
    assert.ok(expanded && typeof expanded.get === 'function', 'priority expansion active in default sharing');
    assert.ok(expanded.get('t3') > expanded.get('t1'), 'active long tab expands wider than sibling in default sharing');

    // Narrow to trigger default overflow -> pinned 100px
    bar._cw = 400; // avail = 324; share = (324 - 6)/4 = 79.5 < 100 -> overflow
    ctx.TabManager._relayout(true);
    assert.equal(bar.classList.contains('tabbar-overflow'), true);
    assert.equal(ctx.TabManager._lastStripPlan.tabWidth, TAB_MIN_WIDTH);
});

test('adaptive mode: keeps variable content widths in both sparse and overflow, skips sharing and hover/active expansion', () => {
    const ctx = loadVm();
    ctx._settingsConfig.adaptiveTabWidth = true;
    const widths = new Map([['short1', 66], ['cmd', 87], ['long1', 240], ['long2', 240]]);
    // bar clientWidth = 800 -> avail = 800 - 48 - 26 - 2 = 724
    // Adaptive measured: [72, 87, 240, 240], sum = 645 <= 724 -> sparse
    const { bar } = installCssTabMetrics(ctx, widths, 800);
    for (const id of ['short1', 'cmd', 'long1', 'long2']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('long1');
    ctx.TabManager.render();

    const vp = ctx.document.getElementById('tab-viewport');
    assert.equal(bar.classList.contains('tabbar-adaptive'), true);
    assert.equal(bar.classList.contains('tabbar-sharing'), false);
    assert.equal(bar.classList.contains('tabbar-overflow'), false);
    assert.equal(ctx.TabManager._lastStripPlan.state, 'sparse');
    assert.equal(ctx.TabManager._lastStripPlan.tabWidth, null);
    assert.equal(ctx.TabManager._lastStripPlan.widths, null);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 72);
    assert.equal(ctx.TabManager.tabs[1]._desiredW, 87);
    assert.equal(ctx.TabManager.tabs[2]._desiredW, 240);
    for (const el of vp.querySelectorAll('.tab')) {
        assert.equal(el.style.width, '', 'no inline width pinned in adaptive sparse');
    }

    // Shrink bar so sum 645 > avail (avail = 600 - 48 - 26 - 2 = 524) -> DIRECT to overflow!
    bar._cw = 600;
    ctx.TabManager._relayout(true);
    assert.equal(bar.classList.contains('tabbar-adaptive'), true);
    assert.equal(bar.classList.contains('tabbar-sharing'), false, 'adaptive mode never enters sharing');
    assert.equal(bar.classList.contains('tabbar-overflow'), true, 'adaptive mode jumps straight to overflow');
    assert.equal(ctx.TabManager._lastStripPlan.state, 'overflow');
    assert.equal(ctx.TabManager._lastStripPlan.tabWidth, null, 'overflow never equal-pins tabWidth');
    assert.equal(ctx.TabManager._lastStripPlan.widths, null, '_expandedStripWidths is a no-op');
    for (const el of vp.querySelectorAll('.tab')) {
        assert.equal(el.style.width, '', 'every tab keeps CSS content width (never pinned to 100px)');
    }
    // Verify variable widths remain genuinely distinct in overflow
    const renderedWidths = [...vp.querySelectorAll('.tab')].map(el => el.offsetWidth);
    assert.deepEqual(renderedWidths, [72, 87, 240, 240]);

    // Zero-oscillation: repeating _relayout(true) while scroll arrows (24px each) are mounted stays overflow
    ctx.TabManager._relayout(true);
    assert.equal(ctx.TabManager._lastStripPlan.state, 'overflow');
    assert.equal(bar.classList.contains('tabbar-overflow'), true);
});

test('live toggle adaptiveTabWidth via _relayout(true) invalidates _desiredW, clears hoverExpandId and inline widths immediately', () => {
    const ctx = loadVm();
    const widths = new Map([['t1', 66], ['t2', 80], ['t3', 240], ['t4', 240]]);
    // bar clientWidth = 730 -> avail = 730 - 48 - 26 - 2 = 654
    // Default floor 110 -> measured [110, 110, 240, 240], sum = 706 > 654 -> sharing!
    // Adaptive floor 72 -> measured [72, 80, 240, 240], sum = 638 <= 654 -> sparse!
    const { bar } = installCssTabMetrics(ctx, widths, 730);
    for (const id of ['t1', 't2', 't3', 't4']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('t3');
    ctx.TabManager.render();

    const vp = ctx.document.getElementById('tab-viewport');
    assert.equal(bar.classList.contains('tabbar-sharing'), true);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 110);
    assert.equal(ctx.TabManager.tabs[1]._desiredW, 110);
    ctx.TabManager._hoverExpandId = 't4';

    // Flip ON live and call _relayout(true) without calling render()
    ctx._settingsConfig.adaptiveTabWidth = true;
    ctx.TabManager._relayout(true);

    assert.equal(bar.classList.contains('tabbar-adaptive'), true);
    assert.equal(bar.classList.contains('tabbar-sharing'), false);
    assert.equal(bar.classList.contains('tabbar-overflow'), false);
    assert.equal(ctx.TabManager._hoverExpandId, null, 'stale hoverExpandId cleared on mode switch');
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 72, 'short tab re-measured to adaptive floor 72');
    assert.equal(ctx.TabManager.tabs[1]._desiredW, 80, 'short tab re-measured to 80');
    for (const el of vp.querySelectorAll('.tab')) {
        assert.equal(el.style.width, '', 'inline sharing width cleared immediately');
    }

    // Flip OFF live and call _relayout(true): re-measures back to default 110 floor and re-enters sharing
    ctx._settingsConfig.adaptiveTabWidth = false;
    ctx.TabManager._relayout(true);

    assert.equal(bar.classList.contains('tabbar-adaptive'), false);
    assert.equal(bar.classList.contains('tabbar-sharing'), true);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 110, 'short tab re-measured back to default floor 110');
    assert.equal(ctx.TabManager.tabs[1]._desiredW, 110);
    for (const el of vp.querySelectorAll('.tab')) {
        assert.notEqual(el.style.width, '', 'default sharing pins inline widths again');
    }
});

test('adaptive mode: close deferral holds overflow while pointer is in strip and settles on pointerleave', () => {
    const ctx = loadVm();
    ctx._settingsConfig.adaptiveTabWidth = true;
    // avail = 524; 3 tabs [240, 240, 80] -> sum 564 > 524 (overflow); closing t3 leaves 482 <= 524 (sparse)
    const widths = new Map([['t1', 240], ['t2', 240], ['t3', 80]]);
    const { bar } = installCssTabMetrics(ctx, widths, 600);
    ctx.TabManager._wireStripInteraction(bar);
    for (const id of ['t1', 't2', 't3']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('t1');
    ctx.TabManager.render();
    assert.equal(bar.classList.contains('tabbar-overflow'), true);

    // Pointer inside strip -> closeTab arms deferral
    bar.dispatch('pointerenter');
    ctx.TabManager.closeTab('t3');
    ctx.__tq.advance(200); // doRemove splices t3 and calls render()
    assert.equal(ctx.TabManager.tabs.length, 2);
    assert.equal(bar.classList.contains('tabbar-overflow'), true, 'overflow held while pointer stays in strip');

    // Pointer leaves strip -> settles to sparse
    bar.dispatch('pointerleave');
    assert.equal(bar.classList.contains('tabbar-overflow'), false, 'settles to sparse on pointerleave');
    assert.equal(ctx.TabManager._lastStripPlan.state, 'sparse');
});

test('adaptive mode: _scrollTabIntoView and render() scrollLeft preservation work for variable-width tabs', () => {
    const ctx = loadVm();
    ctx._settingsConfig.adaptiveTabWidth = true;
    const widths = new Map([['t1', 72], ['t2', 240], ['t3', 85], ['t4', 220]]);
    const { bar } = installCssTabMetrics(ctx, widths, 450); // avail = 374, sum = 623 -> overflow
    for (const id of ['t1', 't2', 't3', 't4']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.render();

    const vp = ctx.document.getElementById('tab-viewport');
    vp._cw = 300;
    vp.scrollWidth = 623;
    vp.scrollLeft = 0;

    // Assign realistic cumulative offsetLeft values for the variable-width tabs
    const tabEls = [...vp.querySelectorAll('.tab')];
    let x = 0;
    for (const el of tabEls) {
        el.offsetLeft = x;
        x += el.offsetWidth + 2;
    }

    // Bring t4 (left=403, width=220, right=623) into 300px viewport -> scrollLeft = 323
    ctx.TabManager._scrollTabIntoView('t4');
    assert.equal(vp.scrollLeft, 323);

    // Background render in overflow preserves scrollLeft
    ctx.TabManager.render();
    assert.equal(vp.scrollLeft, 323, 'render preserves scrollLeft in adaptive overflow');

    // Bringing t1 (left=0, width=72) back into view scrolls left to 0
    const tabEls2 = [...vp.querySelectorAll('.tab')];
    tabEls2[0].offsetLeft = 0;
    ctx.TabManager._scrollTabIntoView('t1');
    assert.equal(vp.scrollLeft, 0);

    // Expanding bar back to sparse resets scrollLeft to 0
    vp.scrollLeft = 180;
    bar._cw = 800; // avail = 724 >= 623 -> sparse
    ctx.TabManager._relayout(true);
    assert.equal(vp.scrollLeft, 0, 'returning to sparse resets scrollLeft');
});

// ── Real settings.js wiring & live apply ────────────────────────────────────

function loadSettingsIntegrationVm() {
    const els = new Map();
    const mkInput = (value = '') => ({ tagName: 'INPUT', value, style: {} });
    const mkSelect = () => ({
        tagName: 'SELECT', options: [], value: '', style: {},
        set innerHTML(v) { if (v === '') this.options.length = 0; },
        get innerHTML() { return ''; },
        appendChild(c) { this.options.push(c); return c; },
    });
    const mkToggle = (on = false) => {
        const classes = new Set(['toggle-switch']);
        if (on) classes.add('on');
        return {
            tagName: 'DIV',
            classList: {
                toggle(cls, force) {
                    const next = force === undefined ? !classes.has(cls) : !!force;
                    if (next) classes.add(cls); else classes.delete(cls);
                },
                contains: (cls) => classes.has(cls),
            },
        };
    };

    for (const id of ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font']) els.set(id, mkSelect());
    els.set('set-font-size', mkInput('16'));
    els.set('set-line-height', mkInput('1.125'));
    els.set('set-font-weight', mkInput('400'));
    els.set('set-font-weight-bold', mkInput('600'));
    els.set('set-accent', mkInput('#61afef'));
    const schemeSel = mkSelect();
    schemeSel.value = 'onedark';
    els.set('set-terminal-scheme', schemeSel);
    els.set('set-contrast', mkInput('1'));
    els.set('toggle-animations', mkToggle(true));
    els.set('toggle-statusdot', mkToggle(true));
    els.set('toggle-adaptive-tab-width', mkToggle(false));
    els.set('toggle-pane-ring', mkToggle(false));
    els.set('toggle-panel-edge', mkToggle(true));
    els.set('toggle-sftp-material', mkToggle(false));

    const tabbarClasses = new Set();
    const tabbar = {
        id: 'tabbar',
        classList: {
            toggle(cls, force) {
                const next = force === undefined ? !tabbarClasses.has(cls) : !!force;
                if (next) tabbarClasses.add(cls); else tabbarClasses.delete(cls);
            },
            contains: (cls) => tabbarClasses.has(cls),
        },
    };
    els.set('tabbar', tabbar);

    const calls = [];
    const tabs = [
        { id: 't1', _desiredW: 110 },
        { id: 't2', _desiredW: 240 },
    ];
    let renderCalls = 0;

    const context = {
        console: { ...console, error() {} },
        path,
        process,
        setTimeout: () => 0,
        document: {
            getElementById: (id) => els.get(id) || null,
            createElement: (tag) => ({ tagName: String(tag || 'div').toUpperCase(), value: '', textContent: '', style: {}, setAttribute() {}, classList: { add() {}, toggle() {} } }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { style: {}, classList: { toggle() {} } },
            documentElement: { style: { setProperty() {} } },
        },
        ipcRenderer: {
            invoke: async (command, payload) => {
                calls.push({ command, payload });
                if (command === 'load-settings') throw new Error('fallback-path');
                return undefined;
            },
        },
        TabManager: {
            profiles: [],
            tabs,
            render() {
                renderCalls += 1;
            },
        },
        Icons: { iconSvg: () => 'svg' },
        setToggle(id, on) { const el = els.get(id); if (el) el.classList.toggle('on', on); },
        getToggle(id) { const el = els.get(id); return el ? el.classList.contains('on') : true; },
        getDefaultLocalProfile: () => ({ id: 'powershell' }),
        getAllPanes: () => [],
        _firstFontName: (f) => String(f || '').split(',')[0].trim(),
        _getAccentColorAlpha: (a) => `rgba(97,175,239,${a})`,
        _normalizeFontFamily: (f) => f || '',
        _normalizeWordSeparators: (v) => v || '',
        _clampFontWeight: (v, d) => parseInt(v, 10) || parseInt(d, 10),
        showToast() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(colorUtilsSrc, context, { filename: 'color-utils.js' });
    vm.runInContext(stateSrc, context, { filename: 'state.js' });
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });

    const getConfig = () => vm.runInContext('_settingsConfig', context);
    const setConfigField = (key, val) => vm.runInContext(`_settingsConfig[${JSON.stringify(key)}] = ${JSON.stringify(val)}`, context);

    return {
        context, els, calls, tabs, tabbarClasses, getConfig, setConfigField,
        getRenderCalls: () => renderCalls,
    };
}

test('settings.js: loadSettingsIntoForm, saveAppearance, persistSettings, and loadSettings fallback handle adaptiveTabWidth end to end', async () => {
    const env = loadSettingsIntegrationVm();

    // loadSettings fallback defaults adaptiveTabWidth to false and leaves #tabbar without tabbar-adaptive
    await env.context.loadSettings();
    assert.equal(env.getConfig().adaptiveTabWidth, false);
    assert.equal(env.tabbarClasses.has('tabbar-adaptive'), false);

    // loadSettingsIntoForm syncs toggle OFF for default/false, ON for true
    env.context.loadSettingsIntoForm();
    assert.equal(env.els.get('toggle-adaptive-tab-width').classList.contains('on'), false);
    env.setConfigField('adaptiveTabWidth', true);
    env.context.loadSettingsIntoForm();
    assert.equal(env.els.get('toggle-adaptive-tab-width').classList.contains('on'), true);

    // Unrelated appearance save (adaptiveTabWidth stays false) must not wipe cached _desiredW on tabs
    env.setConfigField('adaptiveTabWidth', false);
    env.els.get('toggle-adaptive-tab-width').classList.toggle('on', false);
    env.tabs[0]._desiredW = 110;
    env.tabs[1]._desiredW = 240;
    await env.context.saveAppearance();
    assert.equal(env.tabs[0]._desiredW, 110, 'unrelated appearance save leaves cached _desiredW intact for render()');
    assert.equal(env.getRenderCalls(), 1);

    // Turn ON via saveAppearance: verifies live chrome flag, TabManager.render(), and save-appearance payload
    env.els.get('toggle-adaptive-tab-width').classList.toggle('on', true);
    await env.context.saveAppearance();

    assert.equal(env.getConfig().adaptiveTabWidth, true);
    assert.equal(env.tabbarClasses.has('tabbar-adaptive'), true, 'applyChromeFlags adds tabbar-adaptive immediately');
    assert.equal(env.getRenderCalls(), 2);
    const savedOn = env.calls.filter(c => c.command === 'save-appearance').pop();
    assert.equal(savedOn?.payload?.adaptiveTabWidth, true);

    // Turn OFF via saveAppearance
    env.els.get('toggle-adaptive-tab-width').classList.toggle('on', false);
    await env.context.saveAppearance();
    assert.equal(env.getConfig().adaptiveTabWidth, false);
    assert.equal(env.tabbarClasses.has('tabbar-adaptive'), false);
    const savedOff = env.calls.filter(c => c.command === 'save-appearance').pop();
    assert.equal(savedOff?.payload?.adaptiveTabWidth, false);
});

test('real settings.js + tabs.js live toggle: saveAppearance re-measures _desiredW and updates strip layout immediately without restart', async () => {
    const ctx = loadVm();
    ctx._wireSmoothCursorWebgl = () => ({ _adapter: null, setOptions() {}, dispose() {} });
    const widths = new Map([['t1', 66], ['t2', 80], ['t3', 240], ['t4', 240]]);
    // bar clientWidth = 730 -> avail = 654
    // Default floor 110 -> [110, 110, 240, 240], sum = 706 > 654 -> sharing
    // Adaptive floor 72 -> [72, 80, 240, 240], sum = 638 <= 654 -> sparse
    const { bar } = installCssTabMetrics(ctx, widths, 730);
    for (const id of ['t1', 't2', 't3', 't4']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('t3');
    ctx.TabManager.render();
    assert.equal(bar.classList.contains('tabbar-sharing'), true);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 110);

    // Mount minimal appearance controls + real settings.js in the same VM
    const extraEls = new Map();
    const mkInput = (v) => ({ tagName: 'INPUT', value: v, style: {} });
    const mkSelect = () => ({ tagName: 'SELECT', options: [], value: '', style: {} });
    for (const id of ['set-font', 'set-ui-font', 'set-ui-fallback-font', 'set-fallback-font']) extraEls.set(id, mkSelect());
    extraEls.set('set-font-size', mkInput('16'));
    extraEls.set('set-line-height', mkInput('1.125'));
    extraEls.set('set-font-weight', mkInput('400'));
    extraEls.set('set-font-weight-bold', mkInput('600'));
    extraEls.set('set-accent', mkInput('#61afef'));
    extraEls.set('set-terminal-scheme', mkInput('onedark'));
    extraEls.set('set-contrast', mkInput('1'));
    const mkToggle = (on) => {
        const el = ctx.document.createElement('div');
        el.classList.add('toggle-switch');
        if (on) el.classList.add('on');
        return el;
    };
    extraEls.set('toggle-animations', mkToggle(true));
    extraEls.set('toggle-statusdot', mkToggle(true));
    extraEls.set('toggle-adaptive-tab-width', mkToggle(false));
    extraEls.set('toggle-pane-ring', mkToggle(false));
    extraEls.set('toggle-panel-edge', mkToggle(true));
    extraEls.set('toggle-sftp-material', mkToggle(false));

    const origGetById = ctx.document.getElementById;
    ctx.document.getElementById = (id) => extraEls.get(id) || origGetById(id);
    const savedPayloads = [];
    ctx.ipcRenderer.invoke = async (cmd, payload) => {
        if (cmd === 'save-appearance') savedPayloads.push(payload);
        return undefined;
    };
    ctx.getToggle = (id) => {
        const el = ctx.document.getElementById(id);
        return el ? el.classList.contains('on') : true;
    };
    ctx.setToggle = (id, on) => {
        const el = ctx.document.getElementById(id);
        if (el) el.classList.toggle('on', on);
    };
    ctx.updateAccentDot = () => {};
    ctx.applyTerminalScheme = () => {};
    ctx.applyChromeFlags = () => {
        bar.classList.toggle('tabbar-adaptive', ctx._settingsConfig.adaptiveTabWidth === true);
    };
    vm.runInContext(settingsSrc, ctx, { filename: 'settings.js' });

    // Flip toggle ON and call real saveAppearance()
    extraEls.get('toggle-adaptive-tab-width').classList.toggle('on', true);
    await ctx.saveAppearance();

    const vp = ctx.document.getElementById('tab-viewport');
    assert.equal(bar.classList.contains('tabbar-adaptive'), true);
    assert.equal(bar.classList.contains('tabbar-sharing'), false);
    assert.equal(bar.classList.contains('tabbar-overflow'), false);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 72, 'saveAppearance -> render() re-measured short tab to 72');
    assert.equal(ctx.TabManager.tabs[1]._desiredW, 80);
    for (const el of vp.querySelectorAll('.tab')) {
        assert.equal(el.style.width, '', 'inline widths cleared live by saveAppearance -> render()');
    }
    assert.equal(savedPayloads.at(-1)?.adaptiveTabWidth, true);

    // Flip toggle OFF and call real saveAppearance()
    extraEls.get('toggle-adaptive-tab-width').classList.toggle('on', false);
    await ctx.saveAppearance();

    assert.equal(bar.classList.contains('tabbar-adaptive'), false);
    assert.equal(bar.classList.contains('tabbar-sharing'), true);
    assert.equal(ctx.TabManager.tabs[0]._desiredW, 110, 'saveAppearance -> render() re-measured back to 110');
    assert.equal(savedPayloads.at(-1)?.adaptiveTabWidth, false);
});

test('settings.js: loadSettings success path restores adaptiveTabWidth: true and applies tabbar-adaptive immediately', async () => {
    const env = loadSettingsIntegrationVm();
    env.context.ipcRenderer.invoke = async (command) => {
        if (command === 'load-settings') {
            return { terminal: {}, appearance: { adaptiveTabWidth: true }, shortcuts: {} };
        }
        return undefined;
    };
    await env.context.loadSettings();
    assert.equal(env.getConfig().adaptiveTabWidth, true);
    assert.equal(env.tabbarClasses.has('tabbar-adaptive'), true, 'loadSettings applies tabbar-adaptive on startup');
});

test('adaptive mode: render() mode flip breaks stale close deferral and pointerover hover-expand stays a no-op', () => {
    const ctx = loadVm();
    const widths = new Map([['t1', 66], ['t2', 80], ['t3', 240], ['t4', 240]]);
    // bar clientWidth = 600 -> avail = 524; default enters sharing, adaptive enters overflow
    const { bar } = installCssTabMetrics(ctx, widths, 600);
    ctx.TabManager._wireStripInteraction(bar);
    for (const id of ['t1', 't2', 't3', 't4']) wiredTab(ctx, id, 'b_' + id, null);
    ctx.TabManager.switchTo('t1');
    ctx.TabManager.render();
    assert.equal(ctx.TabManager._lastStripPlan.state, 'sharing');

    // Arm close deferral under default mode, then flip adaptive ON and call render()
    ctx.TabManager._pointerInStrip = true;
    ctx.TabManager._deferStripRelayout = true;
    ctx._settingsConfig.adaptiveTabWidth = true;
    ctx.TabManager.render();

    assert.equal(bar.classList.contains('tabbar-adaptive'), true);
    assert.equal(bar.classList.contains('tabbar-sharing'), false, 'mode flip discards stale deferred sharing plan');
    assert.equal(bar.classList.contains('tabbar-overflow'), true);
    assert.equal(ctx.TabManager._lastStripPlan.tabWidth, null);

    // Pointerover on a non-active tab in adaptive overflow must never arm hover expansion
    const vp = ctx.document.getElementById('tab-viewport');
    const t3El = vp.querySelector('.tab[data-tab="t3"]');
    vp.dispatch('pointerover', { target: t3El });
    ctx.__tq.advance(300);
    assert.equal(ctx.TabManager._hoverExpandId, null, 'hover-expand is a no-op in adaptive overflow');
});
