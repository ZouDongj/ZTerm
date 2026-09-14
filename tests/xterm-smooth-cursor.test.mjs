import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SmoothCursorMotion } = require("../src/renderer/smooth-cursor-overlay.js");
const { createXtermWebglSmoothCursor } = require("../src/renderer/xterm-smooth-cursor.js");

function fixture({ reduced = false } = {}) {
  let time = 0;
  let widthByColumn = new Map();
  const rawCell = {
    bg: 0,
    fg: 0,
    extended: { ext: 0 },
    getCode() { return 65; },
    getChars() { return 'A'; },
  };
  const canvas = { width: 100, height: 60 };
  const gl = { canvas };
  const originalRectangleVertices = { attributes: new Float32Array(160), count: 0 };
  const originalGlyphVertices = { attributes: new Float32Array(330), attributesBuffers: [new Float32Array(330), new Float32Array(330)], count: 330 };
  const rectangleDraws = [];
  const glyphDraws = [];
  const baseHiddenStates = [];
  let redraws = 0;
  let stockRecolors = 0;
  const rectangle = {
    _gl: gl,
    _verticesCursor: originalRectangleVertices,
    _cursorFloat: new Float32Array([1, 1, 1, 1]),
    _addRectangleFloat(attributes, offset, x, y, width, height, color) {
      attributes.set([x / canvas.width, y / canvas.height, width / canvas.width, height / canvas.height, ...color], offset);
    },
    renderCursor() { rectangleDraws.push(Array.from(this._verticesCursor.attributes.slice(0, 8))); },
  };
  const glyph = {
    _gl: gl,
    _activeBuffer: 0,
    _vertices: originalGlyphVertices,
    _updateCell(attributes, x, y, code) { attributes.set([code, 2, 0.1, 0.2, 0, 0.2, 0.3, 0.1, 0.2], 0); },
    render() {
      this._activeBuffer = (this._activeBuffer + 1) % 2;
      glyphDraws.push(Array.from(this._vertices.attributes));
    },
  };
  const coreService = { isCursorInitialized: true, isCursorHidden: false };
  const renderer = {
    _gl: gl,
    _canvas: canvas,
    _rectangleRenderer: { value: rectangle },
    _glyphRenderer: { value: glyph },
    _coreService: coreService,
    _coreBrowserService: { isFocused: true },
    _themeService: { colors: { cursor: { rgba: 0xffffffff }, cursorAccent: { rgba: 0x1e1e1eff } } },
    _workCell: rawCell,
    _devicePixelRatio: 1,
    dimensions: { device: { cell: { width: 10, height: 20 }, canvas: { width: 100, height: 60 } } },
    renderRows() {
      baseHiddenStates.push(coreService.isCursorHidden);
      if (!coreService.isCursorHidden) stockRecolors += 1;
    },
    _requestRedrawViewport() { redraws += 1; },
  };
  const listeners = [];
  const active = {
    baseY: 0,
    cursorY: 0,
    cursorX: 1,
    viewportY: 0,
    getLine() {
      return { getCell(column) { return { getWidth() { return widthByColumn.get(column) ?? 1; } }; } };
    },
  };
  const screen = {
    contains(value) { return value === canvas; },
    querySelectorAll() { return [canvas]; },
  };
  const element = {
    addEventListener(event, callback) { listeners.push({ event, callback }); },
    removeEventListener() {},
    querySelector(selector) { return selector === '.xterm-screen' ? screen : null; },
    querySelectorAll() { return []; },
  };
  const terminal = {
    cols: 10,
    rows: 3,
    options: { cursorWidth: 1, cursorStyle: 'bar' },
    buffer: { active },
    element,
    _core: {
      _renderService: { _renderer: { value: renderer } },
      buffer: { ydisp: 0, lines: { get() { return { loadCell() {} }; } } },
    },
    onScroll() { return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
  };
  const media = {
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  };
  const root = { performance: { now: () => time }, queueMicrotask };
  const adapter = createXtermWebglSmoothCursor({
    terminal,
    addon: { _renderer: renderer },
    MotionClass: SmoothCursorMotion,
    reducedMotionQuery: media,
    now: () => time,
  });
  return {
    adapter,
    terminal,
    active,
    coreService,
    renderer,
    rectangle,
    glyph,
    rectangleDraws,
    glyphDraws,
    baseHiddenStates,
    originalRectangleVertices,
    originalGlyphVertices,
    media,
    rawCell,
    setTime(value) { time = value; },
    setWidths(entries) { widthByColumn = new Map(entries); },
    counts() { return { redraws, stockRecolors }; },
  };
}

test('wraps the actual render hook, restores stock visibility, and draws a fractional bar in the same pass', async () => {
  const f = fixture();
  f.renderer.renderRows(0, 2);
  f.active.cursorX = 3;
  f.renderer.renderRows(0, 2);
  f.setTime(45);
  f.renderer.renderRows(0, 2);

  assert.deepEqual(f.baseHiddenStates, [true, true, true]);
  assert.equal(f.coreService.isCursorHidden, false);
  assert.equal(f.counts().stockRecolors, 0);
  assert.ok(Math.abs(f.rectangleDraws.at(-1)[0] - 0.275) < 1e-6);
  assert.equal(f.adapter.snapshot().visual.x, 2.75);
  assert.equal(f.adapter.snapshot().surface.baseGlIsCursorGl, true);
  assert.equal(f.adapter.snapshot().surface.baseCanvasIsCursorCanvas, true);
  assert.equal(f.rectangle._verticesCursor, f.originalRectangleVertices);
  await Promise.resolve();
  assert.ok(f.counts().redraws >= 1);
});

test('normalizes a wide tail to its lead and uses temporary native glyph vertices for a block cursor', () => {
  const f = fixture();
  f.setWidths([[1, 2], [2, 0]]);
  f.active.cursorX = 2;
  f.rawCell.getCode = () => 0x4e2d;
  f.rawCell.getChars = () => '中';
  f.adapter.setCursorStyle('block');
  f.renderer.renderRows(0, 2);

  const snapshot = f.adapter.snapshot();
  assert.deepEqual(snapshot.target, { x: 1, y: 0 });
  assert.equal(snapshot.lastRectangle.widthCells, 2);
  assert.equal(snapshot.lastRectangle.widthPx, 20);
  assert.equal(snapshot.lastGlyph.chars, '中');
  assert.equal(f.glyphDraws.length, 1);
  assert.ok(Math.abs(f.glyphDraws[0][9] - 0.1) < 1e-6);
  assert.equal(f.glyph._vertices, f.originalGlyphVertices);
  assert.equal(f.glyph._activeBuffer, 0);
});

test('hidden, reduced-motion, disabled, and disposal paths restore native behavior without lingering animation', () => {
  const f = fixture({ reduced: true });
  f.renderer.renderRows(0, 2);
  f.active.cursorX = 4;
  f.renderer.renderRows(0, 2);
  assert.deepEqual(f.adapter.snapshot().visual, { x: 4, y: 0 });
  assert.equal(f.adapter.snapshot().animationActive, false);

  const customDraws = f.rectangleDraws.length;
  f.coreService.isCursorHidden = true;
  f.renderer.renderRows(0, 2);
  assert.equal(f.rectangleDraws.length, customDraws);
  assert.equal(f.coreService.isCursorHidden, true);

  f.coreService.isCursorHidden = false;
  f.adapter.setEnabled(false);
  f.renderer.renderRows(0, 2);
  assert.ok(f.counts().stockRecolors >= 1);
  const wrapped = f.renderer.renderRows;
  f.adapter.setCursorStyle('block');
  f.adapter.dispose();
  assert.notEqual(f.renderer.renderRows, wrapped);
  assert.equal(f.terminal.options.cursorStyle, 'bar');
  f.renderer.renderRows(0, 2);
  assert.ok(f.counts().stockRecolors >= 2);
});

test('rapid target changes retarget from the current visual and long jumps land immediately', () => {
  const f = fixture();
  f.renderer.renderRows(0, 2);
  f.active.cursorX = 5;
  f.renderer.renderRows(0, 2);
  f.setTime(30);
  f.renderer.renderRows(0, 2);
  const before = f.adapter.snapshot().visual.x;
  f.active.cursorX = 7;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.motion.from.x, before);

  // v3.1 (flterm parity): a jump beyond jumpDistance lands immediately.
  f.adapter.motion.jumpDistance = 1;
  f.active.cursorY = 2;
  f.active.cursorX = 9;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.motion.animating, false);
  assert.deepEqual(f.adapter.snapshot().visual, { x: 9, y: 2 });

  // A short move (exactly 1 cell) still slides from the current position.
  f.active.cursorX = 8;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.motion.animating, true);
  assert.deepEqual(f.adapter.motion.from, { x: 9, y: 2 });

  f.setTime(200);
  f.renderer.renderRows(0, 2);
  assert.deepEqual(f.adapter.snapshot().visual, { x: 8, y: 2 });
  assert.equal(f.adapter.snapshot().animationActive, false);
});

test('hidden frames freeze the animation anchor and re-show slides from the frozen position', () => {
  const f = fixture();
  f.renderer.renderRows(0, 2);
  f.active.cursorX = 4;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.motion.animating, true);
  assert.deepEqual(f.adapter.snapshot().visual, { x: 1, y: 0 });

  // Hidden mid-flight: the anchor and the tracked target stay frozen, and the
  // hidden period must not age the animation.
  f.setTime(45);
  f.coreService.isCursorHidden = true;
  f.active.cursorX = 8;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base-only');
  assert.deepEqual(f.adapter.snapshot().visual, { x: 1, y: 0 });
  assert.deepEqual(f.adapter.snapshot().target, { x: 4, y: 0 });
  assert.equal(f.adapter.snapshot().animationActive, true);
  assert.equal(f.rectangleDraws.length, 2, 'no cursor draw while hidden');

  // Re-show at a new cell: slide starts exactly at the frozen anchor.
  f.setTime(60);
  f.coreService.isCursorHidden = false;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.motion.from.x, 1);
  assert.equal(f.adapter.motion.target.x, 8);
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().visual.x, 1);

  f.setTime(150);
  f.renderer.renderRows(0, 2);
  assert.deepEqual(f.adapter.snapshot().visual, { x: 8, y: 0 });
  assert.equal(f.adapter.snapshot().animationActive, false);
});

test('finite diagnostic capture holds only requested animation frames and excludes hold time', async () => {
  const f = fixture();
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.armFrameCapture(2), 2);
  f.active.cursorX = 4;
  f.renderer.renderRows(0, 2);
  assert.equal(f.adapter.snapshot().capture.held, true);
  f.setTime(500);
  assert.equal(f.adapter.releaseCapturedFrame(), true);
  await Promise.resolve();
  f.setTime(516);
  f.renderer.renderRows(0, 2);
  const capture = f.adapter.snapshot().capture;
  assert.equal(capture.held, true);
  assert.equal(capture.records.length, 2);
  assert.ok(capture.records[1].visual.x > capture.records[0].visual.x);
  assert.ok(capture.records[1].visual.x < 4);
});
