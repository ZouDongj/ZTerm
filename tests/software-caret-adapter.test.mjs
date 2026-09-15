// ADR-0001 B2 adapter state-machine tests (§4.5 reverse tests + the
// reviewer findings): trust/watermark/generation gating, neutral vs
// contradictory units, cell style evidence, DECTCEM independence, and the
// B1 regression (the restore overlay must draw the covering GLYPH, not just
// a background rect — with the default bar style nothing else repaints it).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SmoothCursorMotion } = require('../src/renderer/smooth-cursor-overlay.js');
const { createXtermWebglSmoothCursor } = require('../src/renderer/xterm-smooth-cursor.js');

function fixture({ reduced = true } = {}) {
  let time = 0;
  const EXT = 0x10000000;
  const cellState = { bg: EXT | 0x03000000 | 0xdcdfe4, fg: 0, ext: 0x03000000 | 0xdcdfe4, code: 100, chars: 'd', width: 1 };
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
  const rectangleDraws = [];
  const glyphDraws = [];
  const baseRenders = [];
  const rectangle = {
    _gl: gl,
    _verticesCursor: { attributes: new Float32Array(32), count: 0 },
    _cursorFloat: new Float32Array([1, 1, 1, 1]),
    _colorToFloat32Array(c) { return new Float32Array([(c.rgba >>> 24 & 255) / 255, (c.rgba >>> 16 & 255) / 255, (c.rgba >>> 8 & 255) / 255, (c.rgba & 255) / 255]); },
    _addRectangleFloat(attributes, offset, x, y, width, height, color) {
      attributes.set([x, y, width, height, ...color], offset);
    },
    renderCursor() { rectangleDraws.push(Array.from(this._verticesCursor.attributes.slice(0, 8))); },
  };
  const glyph = {
    _gl: gl,
    _activeBuffer: 0,
    _vertices: { attributes: new Float32Array(11), attributesBuffers: [new Float32Array(11), new Float32Array(11)], count: 11 },
    _updateCell(attributes, x, y, code) { attributes[0] = code; },
    render(opts) { this._activeBuffer = (this._activeBuffer + 1) % 2; glyphDraws.push(opts); },
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
    renderRows(start, end) { baseRenders.push([start, end]); },
    _requestRedrawViewport() {},
  };
  const active = {
    baseY: 0, cursorY: 0, cursorX: 1, viewportY: 0, type: 'normal',
    getLine() { return { getCell() { return { getWidth() { return cellState.width; } }; } }; },
  };
  const linesGet = () => ({ loadCell(x, c) { /* cell is the shared workCell */ } });
  const terminal = {
    cols: 10, rows: 3,
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
  return {
    adapter, terminal, renderer, cellState, rectangleDraws, glyphDraws, baseRenders,
    coreService, coreBrowserService,
    cand: (over) => ({ x: 4, y: 1, char: 'd', width: 1, fg: '40;44;52', bg: '220;223;228', unitSeq: 1, chunkSeq: 1, ...over }),
    setTime(t) { time = t; },
  };
}

function render(f) { f.renderer.renderRows(0, f.terminal.rows - 1); }

test('engagement: two candidates + watermark publish; draws from the descriptor', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1, x: 4 }));
  p.parsed(1);
  assert.equal(f.adapter.instrumentation.softwareCaret, undefined, 'one candidate must not engage');
  p.candidate(f.cand({ chunkSeq: 2, x: 5 }));
  p.parsed(2);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true, 'two candidates engage');
  render(f);
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor.x, 5);
  assert.ok(f.adapter.instrumentation.cursorDrawPasses >= 1, 'the cursor is drawn from the descriptor');
});

test('watermark gating: a candidate publishes only after its chunk is parsed', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 5 }));
  p.parsed(3);
  assert.equal(f.adapter.instrumentation.softwareCaret, undefined, 'not parsed yet');
  p.parsed(5);
  p.candidate(f.cand({ chunkSeq: 6 }));
  p.parsed(6);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
});

test('§4.5 reverse: an unrelated unit keeps the descriptor', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  p.unit({ hadCandidate: false, wrote: [[0, 0], [2, 9]] }); // far away
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
  render(f);
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor.x, 4, 'descriptor kept');
});

test('§4.5 reverse: overwriting the candidate cell revokes and cleans', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  render(f);
  const rendersBefore = f.baseRenders.length;
  p.unit({ hadCandidate: false, wrote: [[1, 4]] }); // the candidate cell
  assert.equal(f.adapter.instrumentation.softwareCaret.active, false, 'cell overwrite revokes');
  assert.ok(f.baseRenders.length > rendersBefore, 'stale restore row re-rendered from the buffer');
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, false, 'still revoked after the fallback render');
});

test('generation: invalidate kills the active takeover and stale-generation candidates never publish', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  p.invalidate('resize');
  assert.equal(f.adapter.instrumentation.softwareCaret.active, false);
  // candidate observed BEFORE the invalidation, parsed after: must not publish
  p.candidate(f.cand({ chunkSeq: 3 }));
  p.invalidate('scroll');
  p.parsed(3);
  assert.notEqual(f.adapter.instrumentation.softwareCaret && f.adapter.instrumentation.softwareCaret.active, true, 'stale generation never publishes');
});

test('cell style evidence (N2): a plain same-char rewrite revokes', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
  f.cellState.bg = 0; f.cellState.ext = 0; // app rewrote the cell without caret styling
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, false, 'char-only match must not survive');
});

test('DECTCEM independence: a hidden protocol cursor does not gate the software cursor', () => {
  const f = fixture();
  f.coreService.isCursorHidden = true; // the ink app hides the protocol cursor
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  render(f);
  assert.equal(f.adapter.instrumentation.cursorDrawPasses >= 1, true,
    'software caret draws even while DECTCEM-hidden');
});

test('B1 regression: the restore overlay draws the covering GLYPH (bar style)', () => {
  const f = fixture(); // default cursorStyle 'bar' — drawCursor draws no glyph
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2 })); p.parsed(2);
  const glyphsBefore = f.glyphDraws.length;
  render(f);
  assert.equal(f.glyphDraws.length, glyphsBefore + 1,
    'restore must repaint the covering character (bg rect alone would blank it)');
  assert.equal(f.adapter.instrumentation.cursorDrawPasses >= 1, true);
});
