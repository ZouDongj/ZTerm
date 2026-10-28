// Real-path link detection regression: CJK/full-width punctuation boundaries.
//
// REAL: the production factory src/renderer/utils.js (_createWebLinksAddon)
// loaded through the same require-shim contract as src/renderer.html, the
// REAL vendored WebLinksAddon (src/vendor/addon-web-links.js) and the REAL
// vendored xterm Terminal (src/vendor/xterm.js). term.write feeds the real
// parser/buffer; the addon's LinkComputer scans the real buffer line and maps
// matches to real cell ranges. Assertions check the recognized text AND the
// reported cell range -- never the on-screen URL text or underline rendering.
//
// FAKED (environment only): a minimal DOM/document/window for the vm plus the
// tuned measure-span cell size (10x20px) so pixel->cell mapping is
// deterministic; LinkOpen is a recorder so the hover/leave/activate wiring
// through the real addon callbacks can be asserted. Same harness shape as
// tests/link-activation.test.mjs in the main tree.
//
// Known vendor boundary (unchanged by the app regex): the vendored validator
// inside LinkComputer runs `new URL(text)` and requires the text to start
// with protocol//host; raw CJK hostnames get punycoded by the URL parser, so
// they fail the prefix check and are not linkified at all. Punycode (xn--)
// hosts and CJK path segments pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const XTERM_SRC = read('src/vendor/xterm.js');
const WEB_LINKS_SRC = read('src/vendor/addon-web-links.js');
const UTILS_SRC = read('src/renderer/utils.js');

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
        // pixel->cell mapping is deterministic.
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
        navigator: { userAgent: 'zterm-link-detection-tests', platform: 'Win32', language: 'en-US' },
        // The vendored addon's validator constructs `new URL(text)` (inside a
        // try/catch); without the global it would silently reject every link.
        URL,
    };
    const win = context;
    context.self = context;
    context.window = context;
    context.devicePixelRatio = 1;
    context.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
        defaultView: win,
    };
    doc.body = mkEl(doc, { tagName: 'BODY' });
    doc.documentElement = mkEl(doc, { tagName: 'HTML', _rootMark: true });
    doc.body.parentElement = doc.documentElement;
    context.document = doc;

    vm.createContext(context);
    vm.runInContext(XTERM_SRC, context, { filename: 'xterm.js' });
    // Same UMD path as the browser: no exports/define in this context, so the
    // bundle attaches the namespace global.
    vm.runInContext(WEB_LINKS_SRC, context, { filename: 'addon-web-links.js' });
    assert.ok(context.TabbyXterm?.Terminal, 'vendored xterm bundle loaded');
    assert.ok(context.WebLinksAddon?.WebLinksAddon, 'vendored web-links addon loaded');
    return context;
}

// Loads the REAL utils.js through the same contract as src/renderer.html's
// require shim: '@xterm/addon-web-links' must resolve to the REAL vendored
// class. Unused xterm addons are inert stubs (utils.js destructures them but
// never instantiates them in this flow); LinkOpen is a recorder.
function loadRenderer() {
    buildContext();
    context.LinkOpen = {
        activated: [], hovers: [], leaves: 0,
        handleLinkActivate(ev, uri, opts) { this.activated.push({ uri, opts }); },
        showLinkTip(ev, text) { this.hovers.push(text); },
        hideLinkTip() { this.leaves++; },
    };
    const pathShim = {
        join: (...a) => a.join('/'), basename: (p) => p.split(/[\\/]/).pop(),
        dirname: (p) => p.split(/[\\/]/).slice(0, -1).join('/') || '.', extname: (p) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i); },
    };
    context.require = (name) => {
        if (name === 'electron') return { ipcRenderer: { send() {}, invoke: () => Promise.resolve({}) } };
        if (name === 'fs') return { existsSync: () => false, readFileSync: () => '', writeFileSync() {} };
        if (name === 'path') return pathShim;
        if (name === '@xterm/xterm') return { Terminal: context.TabbyXterm.Terminal };
        if (name === '@xterm/addon-fit') return { FitAddon: class FitAddonStub {} };
        if (name === '@xterm/addon-webgl') return { WebglAddon: class WebglAddonStub {} };
        if (name === '@xterm/addon-search') return { SearchAddon: class SearchAddonStub {} };
        if (name === '@xterm/addon-clipboard') return { ClipboardAddon: class ClipboardAddonStub {} };
        if (name === '@xterm/addon-web-links') return { WebLinksAddon: context.WebLinksAddon.WebLinksAddon };
        throw new Error('require-shim: unexpected module ' + name);
    };
    vm.runInContext(UTILS_SRC, context, { filename: 'renderer/utils.js' });
    assert.equal(typeof context._createWebLinksAddon, 'function', 'production factory _createWebLinksAddon is global after loading utils.js');
    return context;
}

// Opens a real terminal, loads the REAL addon built by the production
// factory, writes one line through the real parser, and returns everything
// the assertions need. The provider capture wraps the PUBLIC
// term.registerLinkProvider (no vendor internals).
async function openWithLine(line, { cols = 120, rows = 6 } = {}) {
    const parent = mkEl(doc);
    doc.body.appendChild(parent);
    const term = new context.TabbyXterm.Terminal({ cols, rows, allowProposedApi: true });
    term.open(parent);
    let provider = null;
    const origRegister = term.registerLinkProvider.bind(term);
    term.registerLinkProvider = (p) => { provider = p; return origRegister(p); };
    term.loadAddon(context._createWebLinksAddon(term));
    assert.ok(provider, 'the vendored addon registered its WebLinkProvider');
    await new Promise((res) => term.write(line, res));
    return { term, provider };
}

function collectLinks(provider, y = 1) {
    return new Promise((resolve) => provider.provideLinks(y, (links) => resolve(links || [])));
}

// Independently derives the expected cell range for `needle` on buffer row
// y0 by walking the REAL buffer cells: each width>0 cell contributes
// chars.length string units, continuation (width 0) cells contribute none
// but belong to the glyph. Mirrors how LinkComputer maps string indices to
// cells, so a range mismatch means the addon pointed at the wrong cells.
function expectedRange(term, y0, needle) {
    const buf = term.buffer.active;
    const line = buf.getLine(y0);
    assert.ok(line, 'buffer line exists');
    const cell = buf.getNullCell();
    let text = '';
    const unitCells = [];
    for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell);
        const chars = cell.getChars();
        if (cell.getWidth() > 0 && chars) {
            for (let i = 0; i < chars.length; i++) unitCells.push(x);
            text += chars;
        }
    }
    const idx = text.indexOf(needle);
    assert.ok(idx >= 0, `needle ${JSON.stringify(needle)} found in buffer line text`);
    const first = unitCells[idx];
    const lastUnit = unitCells[idx + needle.length - 1];
    let end = lastUnit + 1;
    while (end < line.length) {
        line.getCell(end, cell);
        if (cell.getWidth() === 0) end++; else break;
    }
    return { start: { x: first + 1, y: y0 + 1 }, end: { x: end, y: y0 + 1 } };
}

function assertLink(term, link, expectedText) {
    assert.equal(link.text, expectedText, 'recognized link text');
    // Field-wise compare: link.range is a vm-realm object, so strict deepEqual
    // would reject it on prototypes even with identical coordinates.
    const exp = expectedRange(term, 0, expectedText);
    assert.equal(link.range.start.x, exp.start.x, 'range.start.x');
    assert.equal(link.range.start.y, exp.start.y, 'range.start.y');
    assert.equal(link.range.end.x, exp.end.x, 'range.end.x');
    assert.equal(link.range.end.y, exp.end.y, 'range.end.y');
}

// -- Baseline: plain ASCII detection unchanged --------------------------------

test('plain ASCII URL keeps exact text and cell range', async () => {
    loadRenderer();
    const line = 'see https://example.com/a?b=c&d=e#f here';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://example.com/a?b=c&d=e#f');
});

// -- The reported screenshot line ----------------------------------------------

test('screenshot line: match stops at the full-width comma, port kept', async () => {
    loadRenderer();
    const line = '进展栏目已经上线，地址是 https://47.98.220.139:3000/progress/，用原来的私人站账号登录。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1, 'exactly one link on the line');
    assertLink(term, links[0], 'https://47.98.220.139:3000/progress/');
});

// -- CJK sentence punctuation boundaries ---------------------------------------

test('ideographic period terminates the URL', async () => {
    loadRenderer();
    const line = '文档在 https://docs.example.com/guide/。请查收。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://docs.example.com/guide/');
});

test('book title marks and curly quotes wrap the URL without being swallowed', async () => {
    loadRenderer();
    const line = '参见《https://example.com/specs/v2》与“https://example.com/faq”两处。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'https://example.com/specs/v2');
    assertLink(term, links[1], 'https://example.com/faq');
});

test('full-width question/exclamation marks terminate the URL', async () => {
    loadRenderer();
    const line = '快看 https://example.com/hot？还有 https://example.com/deal！都行。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'https://example.com/hot');
    assertLink(term, links[1], 'https://example.com/deal');
});

// -- Multiple URLs on one line --------------------------------------------------

test('multiple URLs separated by CJK punctuation each keep their own range', async () => {
    loadRenderer();
    const line = '先开 https://a.example/x 再开 https://b.example/y，都要登录。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'https://a.example/x');
    assertLink(term, links[1], 'https://b.example/y');
});

test('ideographic comma separates consecutive URLs', async () => {
    loadRenderer();
    const line = '列表：https://a.example/i1、https://a.example/i2、https://a.example/i3。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 3);
    assertLink(term, links[0], 'https://a.example/i1');
    assertLink(term, links[1], 'https://a.example/i2');
    assertLink(term, links[2], 'https://a.example/i3');
});

// -- Legal Unicode targets stay matchable ---------------------------------------

test('CJK path segments stay inside the match (ideographs are not punctuation)', async () => {
    loadRenderer();
    const line = '面板地址 https://example.com/wiki/进度面板 请收藏。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://example.com/wiki/进度面板');
});

test('punycode IDN host with CJK path stays fully matchable', async () => {
    loadRenderer();
    const line = '新域名 https://xn--fiq228c.com/首页 已上线。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://xn--fiq228c.com/首页');
});

test('IPv6 host, non-default port and Unicode path remain intact', async () => {
    loadRenderer();
    const { term, provider } = await openWithLine('内部 https://[2001:db8::1]:8443/进度');
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://[2001:db8::1]:8443/进度');
});

test('CJK iteration marks and Japanese halfwidth middle dot stay in URL paths', async () => {
    loadRenderer();
    const { term, provider } = await openWithLine('参考 https://example.com/々〆〇･/次');
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    assertLink(term, links[0], 'https://example.com/々〆〇･/次');
});

test('small comma punctuation separates URLs without merging their ranges', async () => {
    loadRenderer();
    const { term, provider } = await openWithLine('地址https://example.com/a︐https://example.com/b');
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'https://example.com/a');
    assertLink(term, links[1], 'https://example.com/b');
});

test('raw CJK hostname stays unlinked: vendored validator punycodes the host (documented vendor boundary)', async () => {
    loadRenderer();
    // The app regex leaves CJK ideographs matchable, but the vendored
    // LinkComputer validator (`new URL` + protocol//host prefix check)
    // converts a raw CJK host to punycode, so the prefix check fails and no
    // link is produced. Pre-existing vendor behavior, unchanged here; the
    // punycode form above is the working spelling.
    const line = '备用 https://例子.测试/ 暂不可点。';
    const { provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 0);
});

// -- Mixed-case schemes -----------------------------------------------------------

test('mixed-case http(s) schemes are linkified and bounded by CJK punctuation', async () => {
    loadRenderer();
    const line = '看 Https://Example.com/MIXED/Path 与 HTTPS://47.98.220.139:3000/A，都行。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'Https://Example.com/MIXED/Path');
    assertLink(term, links[1], 'HTTPS://47.98.220.139:3000/A');
});

// -- Vendor trailing trims preserved ---------------------------------------------

test('trailing ASCII period/comma are still trimmed', async () => {
    loadRenderer();
    const line = 'goto https://example.com/a. and https://example.com/b, ok.';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 2);
    assertLink(term, links[0], 'https://example.com/a');
    assertLink(term, links[1], 'https://example.com/b');
});

// -- Wiring: the addon's callbacks route through LinkOpen --------------------------

test('real addon link routes hover/leave/activate into LinkOpen with the bounded text', async () => {
    const ctx = loadRenderer();
    const line = '进展栏目已经上线，地址是 https://47.98.220.139:3000/progress/，用原来的私人站账号登录。';
    const { term, provider } = await openWithLine(line);
    const links = await collectLinks(provider);
    assert.equal(links.length, 1);
    const link = links[0];
    assert.equal(link.text, 'https://47.98.220.139:3000/progress/');

    const ev = { button: 0, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };
    link.hover(ev, link.text);
    assert.deepEqual(ctx.LinkOpen.hovers, ['https://47.98.220.139:3000/progress/'],
        'hover tip shows the bounded URL, not the swallowed text');
    link.leave();
    assert.equal(ctx.LinkOpen.leaves, 1);
    // This is the bare-Ctrl+click entry: utils.js wires the addon handler to
    // LinkOpen.handleLinkActivate, which owns the gesture gate.
    link.activate(ev, link.text);
    assert.equal(ctx.LinkOpen.activated.length, 1);
    assert.equal(ctx.LinkOpen.activated[0].uri, 'https://47.98.220.139:3000/progress/');
    assert.equal(ctx.LinkOpen.activated[0].opts.term, term, 'activation context carries the terminal');
});

// -- Real mouse path: hover through the linkifier finds the bounded link ----------

test('mousemove over the URL makes the real linkifier hover the bounded link only', async () => {
    loadRenderer();
    const line = '进展栏目已经上线，地址是 https://47.98.220.139:3000/progress/，用原来的私人站账号登录。';
    const { term } = await openWithLine(line);
    const expected = 'https://47.98.220.139:3000/progress/';
    const range = expectedRange(term, 0, expected);

    const screenEl = term._core.screenElement;
    assert.ok(screenEl, 'terminal opened its screen element');
    const at = (col, row) => ({
        clientX: col * CELL_W, clientY: row * CELL_H - CELL_H / 2,
        button: 0, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
        composedPath() { return [screenEl, term.element]; },
        preventDefault() {}, stopPropagation() {},
    });
    screenEl.dispatch('mousemove', at(range.start.x + 1, 1));
    const current = term._core.linkifier?.currentLink?.link?.text;
    assert.equal(current, expected, 'linkifier hover resolves to the bounded URL');
    // Hovering the Chinese tail after the URL must NOT keep the link hovered.
    screenEl.dispatch('mousemove', at(range.end.x + 3, 1));
    assert.notEqual(term._core.linkifier?.currentLink?.link?.text, expected,
        'hover past the boundary drops the link');
});
