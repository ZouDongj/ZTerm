// Regression tests for wrapper migrations (split/extract/collapse/drag)
// that keep an adapter and its terminal alive on a NEW owner: _inkFeed then
// creates a fresh ink observer whose chunkSeq restarts at 1, while the
// adapter's software-caret watermark counters still number the dead
// observer's chunks. The enqueued Math.max pins the counter above every new
// seq and the dropped in-flight write callbacks can never raise the
// watermark again, so the suspend gate (enqueued > watermark) disables the
// software caret and the smooth cursor until a reconnect. The adapter must
// rebase its counters to the new observer's numbering at the migration
// point (additive bookkeeping only — the published descriptor, the
// coordinate generation and all animation behavior stay untouched).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { SmoothCursorMotion } = require('../src/renderer/smooth-cursor-overlay.js');
const { createXtermWebglSmoothCursor } = require('../src/renderer/xterm-smooth-cursor.js');
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');
require('../src/vendor/xterm.js');
const BundledTerminal = globalThis.TabbyXterm.Terminal;

const restoreContentSource = readFileSync(new URL('../src/renderer/restore-content.js', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
const raw = readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8');

// Same shape as the tab owner used by software-caret-adapter.test.mjs, so
// the real _inkFeed/_outputParsed from ipc.js drive the adapter.
function newOwner(id) {
  return { id, tabId: 'offline', type: 'ssh', term: null, _smoothCursor: null };
}

async function buildFixture(t) {
  const f = stubFixture();
  const source = new BundledTerminal({ cols: 80, rows: 24 });
  f.terminal.cols = 80;
  f.terminal.rows = 24;
  f.terminal.buffer = source.buffer;
  f.terminal._core.buffer = source._core.buffer;
  f.renderer._workCell = source._core._inputHandler._workCell;
  t.after(() => { f.adapter.dispose(); source.dispose(); });
  const owner = newOwner('source');
  owner.term = source;
  owner._smoothCursor = { _adapter: f.adapter };
  const context = { ipcRenderer: { on() {} }, TabManager: { tabs: [owner] }, window: {}, createInkCaretObserver };
  vm.createContext(context);
  vm.runInContext(restoreContentSource, context);
  vm.runInContext(ipcSource, context);
  const feedAs = (ownerArg, data) => context._inkFeed(ownerArg, ownerArg, null, data);
  const settleAs = (ownerArg, ink, data) => new Promise(resolve =>
    source.write(data, () => { context._outputParsed(ownerArg, ink)(); resolve(); }));
  const writeAs = async (ownerArg, data) => {
    const ink = feedAs(ownerArg, data);
    await settleAs(ownerArg, ink, data);
    render(f);
    return ink;
  };
  return { ...f, source, owner, context, feedAs, settleAs, writeAs };
}

test('extract-style migration rebases the frozen watermark and restores the cursor chain', async t => {
  const f = await buildFixture(t);
  const A = f.owner;
  // Pre-migration session: the software caret is active and every chunk is
  // parsed (queued === parsed).
  await f.writeAs(A, raw);
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, true, 'baseline: chain active before migration');
  // Fillers move a row down first: plain text onto the caret cell is a
  // legitimate cell-overwrite revoke, not part of this regression.
  for (const filler of ['\na', '\nb', '\nc', '\nd']) await f.writeAs(A, filler);
  let own = f.adapter.snapshot().caretOwnership;
  assert.equal(own.queued, own.parsed);

  // One more chunk is fed but its xterm write callback is still in flight
  // when the wrapper migration happens (extract flavor: the old owner loses
  // both handles, so the callback is dropped — tabs.js nulls them).
  const inkOld = f.feedAs(A, 'x');
  const B = newOwner('migrated');
  B.term = A.term;
  B._smoothCursor = A._smoothCursor;
  A._smoothCursor = null;
  A.term = null;
  await f.settleAs(A, inkOld, 'x'); // dropped: the watermark can never advance
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, true,
    'the migration itself must keep the live descriptor (no revoke flash)');

  // Post-migration output arrives through the new owner. Without the rebase
  // the pinned counters suspend the chain; with it the checkpoint binding
  // (isParsed) works immediately and the takeover re-arms from real output.
  const roundtrip = await f.writeAs(B, '\x1b[?1049h\x1b[?1049l');
  const fresh = await f.writeAs(B, raw);
  own = f.adapter.snapshot().caretOwnership;
  assert.equal(own.queued, own.parsed, 'watermark must track the new observer numbering');
  assert.equal(own.queued, fresh.seq);
  assert.equal(f.adapter.softwareCaretPort.isParsed(fresh.seq), true,
    'the latest chunk must satisfy the parse watermark (checkpoint binding)');
  assert.ok(roundtrip.seq < own.queued);
  render(f);
  assert.equal(own.active, true, 'trust re-arms from post-migration candidates');
  assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'software',
    'the cursor chain draws again instead of staying suspended');
});

test('collapse-style migration: a late write callback from the dead numbering cannot leapfrog the rebased watermark', async t => {
  const f = await buildFixture(t);
  const A = f.owner;
  // The old numbering reaches chunk 3, all parsed.
  for (const filler of ['a', 'b', 'c']) await f.writeAs(A, filler);
  let own = f.adapter.snapshot().caretOwnership;
  assert.equal(own.queued, 3);
  assert.equal(own.parsed, 3);
  // Chunk 4 is fed and in flight when the collapse migration adopts the
  // term/adapter onto the tab; the old pane KEEPS its fields (tabs.js does
  // not null them on collapse), so its write callback still fires later.
  const inkOld = f.feedAs(A, 'x');
  const B = newOwner('collapsed-into');
  B.term = A.term;
  B._smoothCursor = A._smoothCursor;
  // Post-migration output through the new owner rebases the counters.
  const inkNew = await f.writeAs(B, 'y');
  assert.equal(inkNew.seq, 1);
  assert.equal(f.adapter.softwareCaretPort.isParsed(1), true);
  // Now the old owner's callback finally lands with seq 4.
  f.context._outputParsed(A, inkOld)();
  own = f.adapter.snapshot().caretOwnership;
  assert.equal(own.parsed, 1, 'a stale seq above enqueued must be ignored');
  assert.equal(own.queued, 1);
  assert.equal(f.adapter.softwareCaretPort.isParsed(1), true,
    'the checkpoint binding stays on the live numbering');
});

test('rebindObserver drops the dead observer pending candidate but keeps the published descriptor and generation', t => {
  const f = stubFixture();
  t.after(() => f.adapter.dispose());
  const p = f.adapter.softwareCaretPort;
  const generationBefore = p.generation();
  // Stub-fixture verified convention (see software-caret-adapter.test.mjs).
  const cand = over => ({ x: 1, y: 1, char: 'd', width: 1, style: 'truecolor', fg: '40;44;52', bg: '220;223;228', unitSeq: 1, chunkSeq: 1, ...over });
  p.candidate(cand({ chunkSeq: 7 }));
  p.enqueued(7);
  p.candidate(cand({ chunkSeq: 8 }));
  p.enqueued(8);
  p.parsed(8);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
  assert.equal(p.isParsed(8), true);
  // Migration point: the pending candidate from the dead numbering and the
  // counters rebase; the published descriptor and the generation survive.
  p.rebindObserver();
  assert.equal(p.generation(), generationBefore, 'rebase is not a session boundary');
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true, 'published descriptor is kept');
  const own = f.adapter.snapshot().caretOwnership;
  assert.equal(own.queued, 0);
  assert.equal(own.parsed, 0);
  // The new numbering binds immediately: chunk 1 suspends, then publishes.
  p.candidate(cand({ chunkSeq: 1 }));
  p.enqueued(1);
  assert.equal(p.isParsed(1), false, 'unparsed chunk still suspends the binding');
  p.parsed(1);
  assert.equal(p.isParsed(1), true);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
});

// ── harness (same renderer stub shape as software-caret-adapter.test.mjs) ──

function stubFixture({ reduced = true } = {}) {
  let time = 0;
  const cellState = { bg: 0x03000000 | 0xdcdfe4, fg: 0x03000000 | 0x282c34, ext: 0, code: 100, chars: 'd', width: 1 };
  const cell = {
    get bg() { return cellState.bg; },
    get fg() { return cellState.fg; },
    get extended() { return { get ext() { return cellState.ext; } }; },
    getCode() { return cellState.code; },
    getChars() { return cellState.chars; },
    getWidth() { return cellState.width; },
  };
  const canvas = { width: 100, height: 60 };
  const gl = { canvas };
  const rectangle = {
    _gl: gl,
    _verticesCursor: { attributes: new Float32Array(32), count: 0 },
    _cursorFloat: new Float32Array([1, 1, 1, 1]),
    _colorToFloat32Array(c) { return new Float32Array([(c.rgba >>> 24 & 255) / 255, (c.rgba >>> 16 & 255) / 255, (c.rgba >>> 8 & 255) / 255, (c.rgba & 255) / 255]); },
    _addRectangleFloat(attributes, offset, x, y, width, height, color) {
      attributes.set([x, y, width, height, ...color], offset);
    },
    renderCursor() {},
  };
  const glyph = {
    _gl: gl,
    _activeBuffer: 0,
    _vertices: { attributes: new Float32Array(11), attributesBuffers: [new Float32Array(11), new Float32Array(11)], count: 11 },
    _updateCell(attributes, x, y, code) { attributes[0] = code; },
    render() { this._activeBuffer = (this._activeBuffer + 1) % 2; },
  };
  const coreService = { isCursorInitialized: true, isCursorHidden: true };
  const coreBrowserService = { isFocused: true };
  const renderer = {
    _gl: gl,
    _canvas: canvas,
    _rectangleRenderer: { value: rectangle },
    _glyphRenderer: { value: glyph },
    _coreService: coreService,
    _coreBrowserService: coreBrowserService,
    _themeService: { colors: { cursor: { rgba: 0xffffffff }, cursorAccent: { rgba: 0x1e1e1eff }, background: { rgba: 0x1a1b26ff }, foreground: { rgba: 0xc0caf5ff } } },
    _workCell: cell,
    _devicePixelRatio: 1,
    dimensions: { device: { cell: { width: 10, height: 20 }, canvas: { width: 100, height: 60 } } },
    renderRows(start, end) {},
    _requestRedrawViewport() {},
  };
  const active = {
    baseY: 0, cursorY: 0, cursorX: 1, viewportY: 0, type: 'normal',
    getLine() { return { getCell() { return { getWidth() { return cellState.width; } }; } }; },
  };
  const linesGet = () => ({ loadCell(x, c) { /* cell is the shared workCell */ } });
  const terminal = {
    cols: 80, rows: 24,
    options: { cursorWidth: 1, cursorStyle: 'bar' },
    buffer: { active },
    element: { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
    _core: {
      _renderService: { _renderer: { value: renderer } },
      buffer: { ydisp: 0, lines: { get: linesGet } },
      coreService, coreBrowserService,
    },
    onScroll() { return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
  };
  const adapter = createXtermWebglSmoothCursor({
    terminal, addon: { _renderer: renderer }, MotionClass: SmoothCursorMotion,
    reducedMotionQuery: { matches: reduced, addEventListener() {}, removeEventListener() {} },
    now: () => time, root: { performance: { now: () => time }, queueMicrotask },
  });
  return { adapter, terminal, renderer, cellState, coreService, coreBrowserService, setTime(t2) { time = t2; } };
}

function render(f) { f.renderer.renderRows(0, f.terminal.rows - 1); }
