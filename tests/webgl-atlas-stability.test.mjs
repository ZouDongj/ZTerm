// Structural Node tests for the WebGL addon atlas-stability patch
// (src/vendor/addon-webgl.js).
//
// REAL: the actual vendored bundle source loaded into an isolated vm context,
// and the real TextureAtlas, GlyphRenderer atlas-tracking and texture-binding
// methods, WebglRenderer renderRows/_clearModel and RenderModel classes from
// it. Page merges and texture clears run the real code paths, including the
// glyph texturePage/texturePositionClipSpace rewrites and the render()
// page-version upload comparison.
//
// FAKED (browser environment only): TextureAtlas gets a stub
// document/canvas/2d-context — no pixels are rasterized, getRasterizedGlyph is
// never called. GlyphRenderer instances are built with Object.create because
// its constructor needs a WebGL2 context; a recording no-op GL lets the real
// render() run. WebglRenderer.renderRows is driven through a harness whose
// _updateModel is an instrumented stand-in, because the real _updateModel
// requires the full xterm core. The stand-in mirrors the real method's
// contract with renderRows: it may restructure the atlas mid-pass and it ends
// every call with updateCursor, calling updateBackgrounds only when cells
// changed. _updateModel itself is unchanged by the patch.
//
// These tests make no GPU, pixel, or visual claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── Fake browser environment ────────────────────────────────────────────────
// One fake document serves both the vm context (a load-time module initializer
// creates a 1x1 canvas when not running under Node's `process` global, as in
// the real page) and the TextureAtlas constructor, which takes it as a
// parameter. No pixels are rasterized; getRasterizedGlyph is never called.
const fake2dCtx = () => ({
    drawImage() {}, clearRect() {}, putImageData() {},
    createLinearGradient: () => ({}),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
});
const fakeDocument = {
    createElement: () => ({ width: 0, height: 0, remove() {}, getContext: () => fake2dCtx() }),
};

// ── Real-bundle loader ──────────────────────────────────────────────────────
// The product bundle ships no test hooks. The webpack-internal classes are
// exposed by loading the REAL source into a throwaway vm context with minimal
// anchored instrumentation: each anchor must occur exactly once in the bundle
// or the loader throws — a drifted anchor can never silently fake a pass.
// Nothing is written to this process's globals (the vm provides `self`,
// `navigator` and `document`).
const EXPOSURES = [
    ['t.GlyphRenderer = g;', 'globalThis.__ztermTestInternals.GlyphRenderer = g;'],
    ['t.WebglRenderer = C;', 'globalThis.__ztermTestInternals.WebglRenderer = C; globalThis.__ztermTestInternals.RenderModel = f.RenderModel;'],
    ['t.TextureAtlas = g;', 'globalThis.__ztermTestInternals.TextureAtlas = g;'],
];
function loadBundleInternals() {
    const raw = readFileSync(new URL('../src/vendor/addon-webgl.js', import.meta.url), 'utf8');
    let source = raw;
    for (const [anchor, exposure] of EXPOSURES) {
        const hits = raw.split(anchor).length - 1;
        if (hits !== 1) throw new Error(`instrumentation anchor matched ${hits} times, expected 1: ${anchor}`);
        source = source.replace(anchor, `${anchor}${exposure}`);
    }
    const context = { console, document: fakeDocument };
    vm.createContext(context);
    // Without a `process` global (as in a real page) a load-time module
    // initializer reads navigator.userAgent / navigator.platform; Node's own
    // navigator exists in the host process but not inside a bare vm context.
    vm.runInContext('var self = globalThis; var window = globalThis; var __ztermTestInternals = {};' +
        'var navigator = { userAgent: "zterm-node-structural-tests", platform: "Win32" };', context, { filename: 'webgl-test-prelude.js' });
    vm.runInContext(source, context, { filename: 'addon-webgl.js' });
    const internals = context.__ztermTestInternals;
    for (const key of ['TextureAtlas', 'GlyphRenderer', 'WebglRenderer', 'RenderModel']) {
        if (typeof internals[key] !== 'function') throw new Error(`bundle instrumentation failed to expose ${key}`);
    }
    return internals;
}
const { TextureAtlas, GlyphRenderer, WebglRenderer, RenderModel } = loadBundleInternals();

const unicodeService = { wcwidth: () => 1, getStringCellWidth: (s) => s.length };
const atlasConfig = () => ({
    deviceCellWidth: 10, deviceCellHeight: 20, deviceCharWidth: 10, deviceCharHeight: 20,
    devicePixelRatio: 1, fontSize: 12, allowTransparency: false,
});
const makeAtlas = () => new TextureAtlas(fakeDocument, atlasConfig(), unicodeService);

// Real layout bump: mark the first page used, then run the real clearTexture.
// Repeated calls work because clearTexture resets currentRow to (0, 0).
const bumpViaRealClear = (atlas) => {
    atlas.pages[0].currentRow.y = 1;
    atlas.clearTexture();
};

const fakeGlyph = (page) => ({
    texturePage: page,
    texturePosition: { x: 1, y: 1 },
    texturePositionClipSpace: { x: 0, y: 0 },
    size: { x: 2, y: 2 },
    sizeClipSpace: { x: 0, y: 0 },
    offset: { x: 0, y: 0 },
});

// Builds the real merge preconditions: 4 same-size pages (the cap set below),
// each seeded with one glyph, then one _createNewPage call.
const withAtlasStatics = (fn) => {
    const pages = TextureAtlas.maxAtlasPages, size = TextureAtlas.maxTextureSize;
    try {
        TextureAtlas.maxAtlasPages = 4;
        TextureAtlas.maxTextureSize = 4096;
        fn();
    } finally {
        TextureAtlas.maxAtlasPages = pages;
        TextureAtlas.maxTextureSize = size;
    }
};

// GlyphRenderer's constructor needs a WebGL2 context; the atlas-tracking
// surface under test does not. Seed only the GL-side field setAtlas and the
// draw path read, and establish state through the real setAtlas.
const makeRenderer = (atlas) => {
    const gr = Object.create(GlyphRenderer.prototype);
    gr._atlasTextures = [{ version: 3 }];
    gr.setAtlas(atlas);
    return gr;
};

// Recording no-op GL: every method call appends its name; enough surface for
// the real GlyphRenderer.render/_bindAtlasPageTexture to run to completion.
const noopGl = () => {
    const calls = [];
    return new Proxy({ calls }, {
        get(target, key) {
            if (key === 'calls') return target.calls;
            if (typeof key !== 'string') return undefined;
            return () => { target.calls.push(key); return 4; };
        },
    });
};

// Minimal GL-side fields the real render() touches on a makeRenderer instance.
const equipDrawSurface = (gr, gl) => {
    gr._gl = gl;
    gr._program = {};
    gr._vertexArrayObject = {};
    gr._attributesBuffer = {};
    gr._terminal = { cols: 4 };
    gr._activeBuffer = 0;
    gr._vertices = {
        count: 0,
        attributes: new Float32Array(11),
        attributesBuffers: [new Float32Array(11), new Float32Array(11)],
    };
};

// ── TextureAtlas layout version ─────────────────────────────────────────────
test('page merge bumps the layout version exactly once and rewrites existing glyphs', () => {
    const atlas = makeAtlas();
    assert.equal(atlas.pageLayoutVersion, 0);
    assert.equal(typeof atlas.beginFrame, 'undefined'); // shared flag removed
    // Grow to the cap while the merge statics are unset, so these stay plain.
    while (atlas.pages.length < 4) atlas._createNewPage();
    const seeded = atlas.pages.map((page, i) => {
        const glyph = fakeGlyph(i);
        page.addGlyph(glyph);
        return glyph;
    });
    withAtlasStatics(() => {
        atlas._createNewPage(); // cap reached: merge 4 pages, then add a plain page
        assert.equal(atlas.pageLayoutVersion, 1); // exactly one bump for the whole merge
        assert.equal(atlas.pages.length, 2);
        assert.equal(atlas.pages[0].canvas.width, 1024); // merged 2x page
        assert.equal(atlas.pages[0].glyphs.length, 4);
        // The root-cause mechanism itself: existing glyphs are renumbered and
        // repositioned onto the merged page.
        seeded.forEach((glyph, r) => {
            assert.equal(glyph.texturePage, 0);
            assert.equal(glyph.texturePosition.x, 1 + (r % 2) * 512);
            assert.equal(glyph.texturePosition.y, 1 + Math.floor(r / 2) * 512);
            assert.equal(glyph.texturePositionClipSpace.x, glyph.texturePosition.x / 1024);
            assert.equal(glyph.sizeClipSpace.x, 2 / 1024);
        });
        // Upstream #6238: clearTexture on a page whose currentRow is (0,0) —
        // e.g. a freshly merged page — silently no-ops. Out of scope here by
        // design; pin that the no-op is NOT counted as a layout change.
        atlas.clearTexture();
        assert.equal(atlas.pageLayoutVersion, 1);
    });
});

test('a plain new page never bumps the layout version', () => {
    const atlas = makeAtlas();
    atlas._createNewPage(); // statics unset: no cap, no merge
    assert.equal(atlas.pageLayoutVersion, 0);
    assert.equal(atlas.pages.length, 2);
    withAtlasStatics(() => {
        atlas._createNewPage(); // 3 pages, cap is 4: below cap, still plain
        assert.equal(atlas.pageLayoutVersion, 0);
        assert.equal(atlas.pages.length, 3);
    });
});

test('clearTexture bumps once only when pages and cache are actually cleared', () => {
    const atlas = makeAtlas();
    atlas.clearTexture(); // fresh page, currentRow (0,0): no-op
    assert.equal(atlas.pageLayoutVersion, 0);
    bumpViaRealClear(atlas);
    assert.equal(atlas.pageLayoutVersion, 1);
    assert.deepEqual({ x: atlas.pages[0].currentRow.x, y: atlas.pages[0].currentRow.y, height: atlas.pages[0].currentRow.height },
        { x: 0, y: 0, height: 0 });
    atlas.clearTexture(); // rows were reset: no-op again, not another bump
    assert.equal(atlas.pageLayoutVersion, 1);
});

// ── GlyphRenderer per-renderer tracking ─────────────────────────────────────
test('each renderer confirms layout versions independently; the delta query never consumes', () => {
    const atlas = makeAtlas();
    const a = makeRenderer(atlas), b = makeRenderer(atlas);
    assert.equal(a.atlasLayoutVersionDelta(), 1); // initial observation pending after setAtlas
    assert.equal(a.beginFrame(), true);  // first frame after setAtlas invalidation
    assert.equal(b.beginFrame(), true);
    assert.equal(a.beginFrame(), false); // stable atlas: no full rebuild
    assert.equal(b.beginFrame(), false);
    bumpViaRealClear(atlas);             // shared atlas restructured: V0 -> V1
    assert.equal(a.atlasLayoutVersionDelta(), 1);
    assert.equal(a.atlasLayoutVersionDelta(), 1); // non-consuming on repeat
    assert.equal(b.atlasLayoutVersionDelta(), 1);
    assert.equal(a.beginFrame(), true);  // a confirms the change...
    assert.equal(a.atlasLayoutVersionDelta(), 0);
    assert.equal(b.atlasLayoutVersionDelta(), 1); // ...b still has it pending
    assert.equal(b.beginFrame(), true);
    assert.equal(b.atlasLayoutVersionDelta(), 0);
});

test('setAtlas invalidates the observed version, including atlas instance replacement', () => {
    const atlasA = makeAtlas(), atlasB = makeAtlas();
    const gr = makeRenderer(atlasA);
    assert.equal(gr._atlas, atlasA);
    assert.equal(gr._atlasTextures[0].version, -1); // setAtlas reused invalidateAtlasTextures
    assert.equal(gr.beginFrame(), true);
    assert.equal(gr.beginFrame(), false);           // confirmed atlasA at V0
    gr.setAtlas(atlasA);                            // same instance re-set
    assert.equal(gr.atlasLayoutVersionDelta() > 0, true);
    assert.equal(gr.beginFrame(), true);
    gr.setAtlas(atlasB);                            // different instance, same V0
    assert.equal(gr.atlasLayoutVersionDelta() > 0, true);
    assert.equal(gr.beginFrame(), true);            // replacement forces a full pass
});

test('a renderer with no atlas reports a needed rebuild but no pending delta', () => {
    // Constructor-equivalent state: _lastAtlasLayoutVersion mirrors the
    // constructor's -1 init (the constructor itself needs WebGL2).
    const gr = Object.create(GlyphRenderer.prototype);
    gr._atlasTextures = [];
    gr._lastAtlasLayoutVersion = -1;
    assert.equal(gr.beginFrame(), true);            // full pass without an atlas
    assert.equal(gr.atlasLayoutVersionDelta(), 0);  // the stability loop cannot spin
    gr.invalidateAtlasTextures();                   // no-op over the empty set
});

// ── GlyphRenderer texture rebinding ─────────────────────────────────────────
test('invalidateAtlasTextures forces a texImage2D re-upload even when the page version collides with the bound one', () => {
    const atlas = makeAtlas();
    const gr = makeRenderer(atlas); // setAtlas -> invalidateAtlasTextures: bound version -1
    const gl = noopGl();
    equipDrawSurface(gr, gl);
    const uploads = () => gl.calls.filter(c => c === 'texImage2D').length;
    gr.render({ lineLengths: [1] });
    assert.equal(uploads(), 1);            // page 0 uploaded, bound version now 0
    assert.equal(gr._atlasTextures[0].version, 0);
    gr.beginFrame(); // stable layout: isolate explicit invalidation from the direct-draw guard
    // Replace pages[0] with a fresh REAL page object whose per-page counter
    // also sits at 0 — what a merge or clear+refill leaves behind when the
    // numbers collide.
    const fresh = atlas._createNewPage(); // real page object, version 0
    atlas._pages.splice(0, atlas._pages.length, fresh);
    assert.equal(atlas.pages.length, 1);
    assert.equal(atlas.pages[0].version, 0);
    assert.equal(gr._atlasTextures[0].version, 0); // the collision
    gl.calls.length = 0;
    gr.render({ lineLengths: [1] });
    assert.equal(uploads(), 0);            // real render() skips the upload: the stale-texture mechanism
    gr.invalidateAtlasTextures();          // real method
    assert.equal(gr._atlasTextures[0].version, -1);
    gr.render({ lineLengths: [1] });
    assert.equal(uploads(), 1);            // forced re-upload despite equal versions
    assert.equal(gr._atlasTextures[0].version, 0);  // bound updated again
});

// ── WebglRenderer.renderRows orchestration ──────────────────────────────────
// Script steps drive the instrumented _updateModel: `bump` restructures the
// atlas mid-pass (real clearTexture), `changed` mirrors whether cells changed
// (the real method calls updateBackgrounds only then, updateCursor always).
const makeHarness = ({ rows = 4, script }) => {
    const events = [];
    const seen = {};
    const atlas = makeAtlas();
    const glyph = makeRenderer(atlas);
    const realBeginFrame = glyph.beginFrame.bind(glyph);
    glyph.beginFrame = () => { events.push(['beginFrame']); return realBeginFrame(); };
    const realDelta = glyph.atlasLayoutVersionDelta.bind(glyph);
    glyph.atlasLayoutVersionDelta = () => {
        const delta = realDelta();
        events.push(['checkStable', delta]);
        return delta;
    };
    const realInvalidate = glyph.invalidateAtlasTextures.bind(glyph);
    glyph.invalidateAtlasTextures = () => { events.push(['invalidateAtlasTextures']); return realInvalidate(); };
    glyph.updateCell = (...args) => events.push(['updateCell', ...args]);
    glyph.clear = () => events.push(['glyphClear']);
    glyph.render = (model) => { seen.glyphRenderModel = model; events.push(['glyphRender']); };
    const rect = {
        updateBackgrounds(model) { seen.backgroundsModel = model; events.push(['updateBackgrounds']); },
        renderBackgrounds() { events.push(['renderBackgrounds']); },
        renderCursor() { events.push(['renderCursor']); },
        updateCursor(model) { events.push(['updateCursor']); },
    };
    const model = new RenderModel();
    model.resize(4, rows);
    const renderer = Object.create(WebglRenderer.prototype);
    Object.assign(renderer, {
        _isAttached: true,
        _renderLayers: [],
        _terminal: { rows },
        _model: model,
        _glyphRenderer: { value: glyph },
        _rectangleRenderer: { value: rect },
        _cursorBlinkStateManager: { value: null },
    });
    let callIndex = 0;
    renderer._updateModel = function (start, end) {
        const step = script[Math.min(callIndex++, script.length - 1)];
        events.push(['updateModel', start, end]);
        if (step.bump) bumpViaRealClear(atlas);
        if (step.changed) rect.updateBackgrounds(this._model);
        rect.updateCursor(this._model);
    };
    return { events, seen, atlas, glyph, rect, model, renderer };
};

test('stable atlas: the dirty-row range passes through untouched with no clear and no rebind', () => {
    const h = makeHarness({ rows: 4, script: [{ bump: false, changed: true }] });
    h.renderer.renderRows(1, 2); // first frame: full clear+rebuild via setAtlas invalidation
    h.events.length = 0;
    h.renderer.renderRows(1, 2); // frame under test: stable, dirty path
    assert.deepEqual(h.events, [
        ['beginFrame'],
        ['updateModel', 1, 2],   // exact dirty range, single pass
        ['updateBackgrounds'],   // from _updateModel (cells changed)
        ['updateCursor'],
        ['checkStable', 0],      // stability verified before any draw
        ['renderBackgrounds'],
        ['glyphRender'],
        ['renderCursor'],
    ]);
    assert.equal(h.seen.backgroundsModel, h.model);
    assert.equal(h.seen.glyphRenderModel, h.model);
});

test('layout change during a dirty update: clear, full-viewport rebuild, stability check, texture invalidation, then draw', () => {
    const h = makeHarness({ rows: 4, script: [
        { bump: false, changed: true }, // priming frame
        { bump: true, changed: true },  // dirty pass restructures the atlas mid-pass
        { bump: false, changed: true }, // full retry runs against a stable layout
    ] });
    h.renderer.renderRows(1, 3);
    h.events.length = 0;
    h.renderer.renderRows(1, 3);
    assert.deepEqual(h.events, [
        ['beginFrame'],
        ['updateModel', 1, 3],      // stale pass (layout changed inside it)
        ['updateBackgrounds'],
        ['updateCursor'],
        ['checkStable', 1],         // change detected before any draw
        ['beginFrame'],             // observation re-armed for the retry pass
        ['glyphClear'],             // _clearModel(true)
        ['updateModel', 0, 3],      // full-viewport rebuild
        ['updateBackgrounds'],
        ['updateCursor'],
        ['checkStable', 0],         // stable now
        ['updateBackgrounds'],      // explicit, from the final stable model
        ['invalidateAtlasTextures'], // forced rebind: page objects were replaced
        ['renderBackgrounds'],      // draws start only here
        ['glyphRender'],
        ['renderCursor'],
    ]);
    assert.equal(h.seen.backgroundsModel, h.model);
    assert.equal(h.seen.glyphRenderModel, h.model);
});

test('a layout change during the first full retry keeps retrying; no single-retry assumption', () => {
    const h = makeHarness({ rows: 4, script: [
        { bump: false, changed: true }, // priming frame
        { bump: true, changed: true },  // dirty pass
        { bump: true, changed: true },  // first full retry changes layout again
        { bump: false, changed: true }, // second full retry stable
    ] });
    h.renderer.renderRows(2, 2);
    h.events.length = 0;
    h.renderer.renderRows(2, 2);
    const ranges = h.events.filter(e => e[0] === 'updateModel').map(e => e.slice(1));
    assert.deepEqual(ranges, [[2, 2], [0, 3], [0, 3]]); // dirty, full, full again
    assert.equal(h.events.filter(e => e[0] === 'glyphClear').length, 2);
    const labels = h.events.map(e => e[0]);
    assert.ok(labels.lastIndexOf('updateModel') < labels.indexOf('renderBackgrounds'),
        'every pass completes before the first draw');
    const lastUpdate = labels.lastIndexOf('updateModel');
    const invalidate = labels.indexOf('invalidateAtlasTextures');
    assert.ok(lastUpdate < invalidate && invalidate < labels.indexOf('renderBackgrounds'),
        'textures are invalidated after the final pass and before any draw');
    assert.deepEqual(labels.slice(labels.indexOf('renderBackgrounds')),
        ['renderBackgrounds', 'glyphRender', 'renderCursor']); // exactly one draw set
});

test('all-zero model after clear still rebuilds backgrounds and cursor from the final stable model', () => {
    // changed=false models the empty screen: after _clearModel(true) the model
    // is all zeros, the real _updateModel sees no cell change and skips
    // updateBackgrounds — without the explicit rebuild, stale background
    // rectangles from before the clear would survive into the draw.
    const h = makeHarness({ rows: 4, script: [{ bump: false, changed: false }] });
    h.renderer.renderRows(0, 3);
    assert.deepEqual(h.events, [
        ['beginFrame'],
        ['glyphClear'],
        ['updateModel', 0, 3],
        ['updateCursor'],          // cursor rebuilt by the final full update
        ['checkStable', 0],
        ['updateBackgrounds'],     // explicit: from the final stable model
        ['invalidateAtlasTextures'],
        ['renderBackgrounds'],
        ['glyphRender'],
        ['renderCursor'],
    ]);
    assert.equal(h.seen.backgroundsModel, h.model);
    assert.equal(h.seen.glyphRenderModel, h.model);
});

test('adapter self-draw rebinds a colliding atlas layout without consuming it', () => {
    const atlas = makeAtlas();
    const gr = makeRenderer(atlas);
    const gl = noopGl();
    equipDrawSurface(gr, gl);
    gr.beginFrame();
    while (atlas.pages.length < 4) atlas._createNewPage();
    for (const [index, page] of atlas.pages.entries()) page.addGlyph(fakeGlyph(index));
    gr._atlasTextures = [{ version: 1 }, { version: 1 }];
    withAtlasStatics(() => atlas._createNewPage());
    assert.equal(atlas.pageLayoutVersion, 1);
    assert.equal(atlas.pages[0].version, 1); // replacement collides with the stale binding
    assert.equal(gr.atlasLayoutVersionDelta(), 1);
    gl.calls.length = 0;
    gr.render({ lineLengths: [1] });
    assert.equal(gl.calls.filter(c => c === 'texImage2D').length, atlas.pages.length,
        'a direct adapter draw must rebind even when a replacement page version collides');
    assert.equal(gr.atlasLayoutVersionDelta(), 1, 'the draw must not consume the next base rebuild');
    assert.equal(gr.beginFrame(), true);
});

// ── Adapter self-draw isolation ─────────────────────────────────────────────
test('adapter-style self-draw does not consume a pending layout change', () => {
    const atlas = makeAtlas();
    const gr = makeRenderer(atlas);
    gr.beginFrame();          // confirmed V0
    bumpViaRealClear(atlas);  // shared atlas restructured elsewhere
    assert.equal(gr.atlasLayoutVersionDelta(), 1);
    // Run the REAL GlyphRenderer.render over a recording no-op GL — the exact
    // primitive the smooth-cursor adapter uses for its own cursor drawing.
    const gl = noopGl();
    equipDrawSurface(gr, gl);
    gr.render({ lineLengths: [1] });
    assert.equal(gl.calls.filter(c => c === 'drawElementsInstanced').length, 1); // a draw happened
    assert.equal(gr.atlasLayoutVersionDelta(), 1); // still pending after the draw
    assert.equal(gr.beginFrame(), true);           // next real frame still rebuilds fully
});

test('canvas observer preserves the integer terminal grid at fractional DPR', () => {
    const renderer = Object.create(WebglRenderer.prototype);
    renderer._canvas = { width: 839, height: 61 };
    renderer.dimensions = { device: { canvas: { width: 840, height: 62 } } };
    let redraws = 0;
    renderer._requestRedrawViewport = () => { redraws++; };

    renderer._setCanvasDevicePixelDimensions(839, 61);
    assert.equal(renderer._canvas.width, 840);
    assert.equal(renderer._canvas.height, 62);
    assert.equal(redraws, 1);

    renderer._setCanvasDevicePixelDimensions(839, 61);
    assert.equal(redraws, 1);
});
