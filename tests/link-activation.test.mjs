// Real-vendor regression for the link activation race (upstream
// xtermjs/xterm.js@f764c0ac "Fix links sometimes not activating") and the
// linkifier lifecycle on re-open.
//
// REAL: the actual vendored xterm.js bundle — public Terminal.open() builds
// the real CoreBrowserTerminal, Linkifier, RenderService, DomRenderer,
// SelectionService and MouseService; link activation runs through the real
// DOM event handlers the Linkifier registers (mousemove/mousedown/mouseup)
// and the real render refresh path (term.refresh -> RenderDebouncer ->
// onRenderedViewportChange), not a hand-written reimplementation.
//
// FAKED (environment only): a minimal DOM/document/window for the vm. The
// only tuned value is the measure span size (offsetWidth 320 / 32 chars =
// 10px cell width, 20px height) so MouseService.getCoords maps viewport
// pixels to cells deterministically. The link provider supplies fresh link
// objects per query, exactly like the real web-links addon which re-parses
// the buffer on every request — that per-call freshness is what makes the
// post-refresh currentLink a NEW object with identical text/range.
//
// These tests make no native WebView2, GPU or visual claims; the boundaries
// are listed in the delivery report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = readFileSync(new URL('../src/vendor/xterm.js', import.meta.url), 'utf8');
const CELL_W = 10, CELL_H = 20;

function classSet(str) { return new Set(String(str || '').split(/\s+/).filter(Boolean)); }

function mkEl(doc, over = {}) {
    const el = {
        tagName: 'DIV', style: {}, dataset: {}, children: [], _listeners: new Map(),
        className: '', id: '', textContent: '', value: '', disabled: false, tabIndex: 0,
        scrollTop: 0, scrollLeft: 0, _w: 0, _h: 0, parentElement: null, ownerDocument: doc,
        setAttribute(k, v) { this['$' + k] = v; if (k === 'id') this.id = v; },
        getAttribute(k) { const v = this['$' + k]; return v === undefined ? null : v; },
        appendChild(c) {
            if (c._fragment) { for (const fc of [...c.children]) this.appendChild(fc); c.children.length = 0; return c; }
            if (c.parentElement) { const i = c.parentElement.children.indexOf(c); if (i >= 0) c.parentElement.children.splice(i, 1); }
            c.parentElement = this; this.children.push(c); return c;
        },
        insertBefore(c, ref) {
            if (c.parentElement) { const i = c.parentElement.children.indexOf(c); if (i >= 0) c.parentElement.children.splice(i, 1); }
            c.parentElement = this;
            const at = ref ? this.children.indexOf(ref) : -1;
            if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c);
            return c;
        },
        insertAdjacentElement(pos, c) { return this.appendChild(c); },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentElement = null; return c; },
        remove() { if (this.parentElement) this.parentElement.removeChild(this); },
        replaceChildren(...cs) { this.children.length = 0; for (const c of cs) this.appendChild(c); },
        addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); },
        removeEventListener(type, fn) {
            const l = this._listeners.get(type) || [];
            let i;
            while ((i = l.indexOf(fn)) >= 0) l.splice(i, 1);
        },
        dispatch(type, ev = {}) { ev.type = type; (this._listeners.get(type) || []).slice().forEach(fn => fn(ev)); },
        listenerCount(type) { return (this._listeners.get(type) || []).length; },
        contains(n) { let cur = n; while (cur) { if (cur === this) return true; cur = cur.parentElement; } return false; },
        getBoundingClientRect() { return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight }; },
        // The only tuned value: measure spans (CharSizeService and the DOM
        // renderer's WidthCache) report a fixed 10x20px monospace cell so
        // getCoords has a deterministic pixel->cell mapping.
        get offsetWidth() { return classSet(el.className).has('xterm-char-measure-element') ? 32 * CELL_W : this._w; },
        get offsetHeight() { return classSet(el.className).has('xterm-char-measure-element') ? CELL_H : this._h; },
        get clientWidth() { return this.offsetWidth; },
        get clientHeight() { return this.offsetHeight; },
        get scrollHeight() { return this.offsetHeight; },
        get isConnected() { let cur = this; while (cur) { if (cur._rootMark) return true; cur = cur.parentElement; } return false; },
        focus() { context._activeElement = this; },
        blur() {},
        select() {},
        getRootNode() { return doc; },
    };
    el.classList = {
        add: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
        remove: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
        toggle: (c, force) => { const s = classSet(el.className); const on = force === undefined ? !s.has(c) : !!force; on ? s.add(c) : s.delete(c); el.className = [...s].join(' '); return on; },
        contains: (c) => classSet(el.className).has(c),
    };
    Object.assign(el, over);
    return el;
}

const fake2dCtx = () => ({
    globalCompositeOperation: '', fillStyle: '',
    createLinearGradient: () => ({}),
    fillRect() {},
    measureText: () => ({ width: CELL_W, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
});

let context, doc;

function buildContext() {
    const windowListeners = new Map();
    context = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        performance: { now: () => Date.now() },
        navigator: { userAgent: 'zterm-link-activation-tests', platform: 'Win32', language: 'en-US' },
    };
    const win = context;
    context.self = context;
    context.window = context;
    context.devicePixelRatio = 1;
    context.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    // Synchronous rAF keeps the render debouncer deterministic in tests.
    context.requestAnimationFrame = (fn) => { fn(); return 0; };
    context.cancelAnimationFrame = () => {};
    context.addEventListener = (t, fn) => { if (!windowListeners.has(t)) windowListeners.set(t, []); windowListeners.get(t).push(fn); };
    context.removeEventListener = (t, fn) => { const l = windowListeners.get(t) || []; let i; while ((i = l.indexOf(fn)) >= 0) l.splice(i, 1); };
    context.getComputedStyle = () => ({ getPropertyValue: () => '0px' });
    context.dispatchEvent = () => true;

    doc = {
        createElement: (tag) => {
            const el = mkEl(doc, { tagName: String(tag || 'div').toUpperCase() });
            if (el.tagName === 'CANVAS') {
                el.width = 0; el.height = 0;
                el.getContext = (kind) => kind === '2d' ? fake2dCtx() : null;
            }
            return el;
        },
        createTextNode: (text) => mkEl(doc, { tagName: '#text', _text: text, get textContent() { return this._text; }, set textContent(v) { this._text = v; } }),
        createDocumentFragment: () => mkEl(doc, { _fragment: true }),
        body: null,
        documentElement: null,
        addEventListener: context.addEventListener,
        removeEventListener: context.removeEventListener,
        get activeElement() { return context._activeElement || doc.body; },
        // Writable on purpose: the re-open test models a dead previous window
        // (the escape hatch through Terminal.open's already-opened guard).
        defaultView: win,
    };
    doc.body = mkEl(doc, { tagName: 'BODY' });
    doc.documentElement = mkEl(doc, { tagName: 'HTML', _rootMark: true });
    doc.body.parentElement = doc.documentElement;
    context.document = doc;

    vm.createContext(context);
    vm.runInContext(BUNDLE, context, { filename: 'xterm.js' });
    return context;
}

// The URL line the provider serves; tests may swap it between the refresh
// and the mouseup to model buffer changes.
const DEFAULT_LINE = 'see https://example.com/a?b=c here';

function openTerminal() {
    const parent = mkEl(doc);
    doc.body.appendChild(parent);
    const term = new context.TabbyXterm.Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    term.open(parent);

    const state = { lineText: DEFAULT_LINE };
    const activated = [];
    term.registerLinkProvider({
        // Fresh link objects per query, like the real web-links addon which
        // re-parses the buffer on every provideLinks call.
        provideLinks(y, cb) {
            const text = state.lineText;
            const m = /https?:\/\/\S+/.exec(text);
            if (y !== 1 || !m) return cb(undefined);
            cb([{
                text: m[0],
                range: { start: { x: m.index + 1, y: 1 }, end: { x: m.index + m[0].length, y: 1 } },
                activate: (ev, linkText) => activated.push(linkText),
                hover() {}, leave() {},
            }]);
        },
    });
    return { term, state, activated };
}

// Viewport pixel coords for a 1-based (col, row); the fake screen element's
// bounding rect is (0,0) and getComputedStyle padding is 0, so getCoords
// maps (px, py) -> (ceil(px/10), ceil(py/20)).
const at = (col, row, extra = {}) => ({
    clientX: col * CELL_W, clientY: row * CELL_H - CELL_H / 2,
    button: 0, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
    composedPath() { return [screenEl(), termEl()]; },
    preventDefault() {}, stopPropagation() {},
    ...extra,
});
function screenEl() { return current.term._core.screenElement; }
function termEl() { return current.term.element; }
function linkifier() { return current.term._core.linkifier; }

let current;
function setup() { buildContext(); current = openTerminal(); return current; }

test('refresh between mousedown and mouseup re-evaluates currentLink; same-content link still activates', () => {
    const { activated } = setup();
    // Hover the link (cols 5..30 on row 1).
    screenEl().dispatch('mousemove', at(6, 1));
    assert.equal(linkifier().currentLink?.link.text, 'https://example.com/a?b=c');
    screenEl().dispatch('mousedown', at(6, 1));
    const downLink = linkifier()._mouseDownLink;
    assert.ok(downLink, 'mousedown captured the hovered link');

    // The reported failure chain: term.refresh of the hovered row makes the
    // Linkifier clear and re-evaluate currentLink. The provider answers with
    // a NEW object carrying identical text and range.
    current.term.refresh(0, 4);
    assert.ok(linkifier().currentLink, 'link re-evaluated after refresh');
    assert.notEqual(linkifier().currentLink, downLink, 'post-refresh currentLink is a new object');
    assert.equal(linkifier().currentLink.link.text, downLink.link.text);

    screenEl().dispatch('mouseup', at(6, 1));
    assert.deepEqual(activated, ['https://example.com/a?b=c'],
        'same-text same-range link must activate on mouseup despite the object swap');
});

test('plain click with no interleaving refresh activates once', () => {
    const { activated } = setup();
    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    screenEl().dispatch('mouseup', at(6, 1));
    assert.deepEqual(activated, ['https://example.com/a?b=c']);
});

test('refresh that changed the link text must not activate', () => {
    const { activated, state } = setup();
    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    // Same columns, different URL: the refreshed link is a different target.
    state.lineText = 'see https://evil.example/x here';
    current.term.refresh(0, 4);
    assert.equal(linkifier().currentLink?.link.text, 'https://evil.example/x');
    screenEl().dispatch('mouseup', at(6, 1));
    assert.deepEqual(activated, [], 'content equality must include the text');
});

test('refresh that moved the link range must not activate', () => {
    const { activated, state } = setup();
    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    // Same URL shifted right by 10 columns (now cols 15..40). The release
    // lands inside BOTH ranges, so only the range comparison can block it.
    state.lineText = '          see https://example.com/a?b=c';
    current.term.refresh(0, 4);
    screenEl().dispatch('mouseup', at(20, 1));
    assert.deepEqual(activated, [], 'content equality must include all four range coordinates');
});

test('mouseup outside the link never activates, with or without a refresh', () => {
    const { activated } = setup();
    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    current.term.refresh(0, 4);
    screenEl().dispatch('mouseup', at(39, 1));
    assert.deepEqual(activated, [], 'the position gate must keep blocking release outside the link');

    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    screenEl().dispatch('mouseup', at(39, 1));
    assert.deepEqual(activated, [], 'no-refresh drag-off-release must not activate either');
});

test('mousedown without a hovered link never activates', () => {
    const { activated } = setup();
    // No mousemove first: currentLink stays unset at mouseup.
    screenEl().dispatch('mousedown', at(6, 1));
    screenEl().dispatch('mouseup', at(6, 1));
    assert.deepEqual(activated, []);
});

test('DOM renderer fallback is constructed with the initialized linkifier', () => {
    const { term } = setup();
    assert.ok(term._core._linkifier, 'the disposable linkifier container precedes renderer setup');
    assert.ok(term._core.linkifier, 'open installs the linkifier before the initial renderer');
    const fallback = term._core._createRenderer();
    assert.equal(typeof fallback.renderRows, 'function');
    fallback.dispose();
});

test('standalone addon disposal constructs DOM fallback with a live linkifier', () => {
    const { term } = setup();
    const original = term._core.linkifier;
    term._addonManager.loadAddon(term, {
        activate() {},
        dispose() {
            assert.equal(original._isDisposed, false, 'the terminal is still alive during addon fallback');
            const fallback = term._core._createRenderer();
            assert.equal(fallback._linkifier2, original);
            fallback.dispose();
        },
    });
    const addon = term._addonManager._addons.find(entry => entry.instance.dispose).instance;
    addon.dispose();
    assert.equal(original._isDisposed, false, 'standalone addon disposal does not dispose the terminal linkifier');
    term.dispose();
});

test('full terminal disposal does not clear the holder before addon fallback', () => {
    const { term } = setup();
    const original = term._core.linkifier;
    let fallbackCreated = false;
    term._addonManager.loadAddon(term, {
        activate() {},
        dispose() {
            const fallback = term._core._createRenderer();
            fallbackCreated = true;
            fallback.dispose();
        },
    });
    term.dispose();
    assert.equal(fallbackCreated, true, 'the addon disposal path constructs the DOM fallback');
    assert.equal(original._isDisposed, true, 'the separately registered linkifier is disposed by the terminal');
});

test('re-open replaces the linkifier and disposes the previous one', () => {
    const { activated } = setup();
    const oldLinkifier = linkifier();
    const oldScreen = screenEl();
    assert.ok(oldLinkifier, 'first open created a linkifier');
    assert.equal(oldScreen.listenerCount('mouseup'), 1, 'linkifier mouseup handler registered');
    assert.equal(oldScreen.listenerCount('mousemove'), 2, 'linkifier + cursor-style mousemove handlers');

    // Model the upstream leak precondition: the previous element's window is
    // gone, so Terminal.open's already-opened guard does not trigger and the
    // full DOM path (including a NEW linkifier) runs again.
    doc.defaultView = null;
    const parent2 = mkEl(doc);
    doc.body.appendChild(parent2);
    current.term.open(parent2);

    const newLinkifier = linkifier();
    assert.notEqual(newLinkifier, oldLinkifier, 're-open created a fresh linkifier');
    assert.equal(oldLinkifier._isDisposed, true, 'the previous linkifier must be disposed, not leaked');
    assert.equal(oldScreen.listenerCount('mouseup'), 0, 'disposed linkifier removed its mouseup listener');
    assert.equal(oldScreen.listenerCount('mousemove'), 1, 'only the cursor-style listener remains on the old screen');
    assert.notEqual(screenEl(), oldScreen, 'terminal renders into the new screen element');

    // The new linkifier is fully wired: a click still activates.
    screenEl().dispatch('mousemove', at(6, 1));
    screenEl().dispatch('mousedown', at(6, 1));
    screenEl().dispatch('mouseup', at(6, 1));
    assert.deepEqual(activated, ['https://example.com/a?b=c']);
});
