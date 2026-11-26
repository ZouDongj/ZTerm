// Unit and vendored-parser integration tests for the post-parse,
// input-correlated software-caret recognizer (ADR-0007).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const unicodeWidth = require('../src/renderer/unicode-width.js');
const postParseApi = require('../src/renderer/post-parse-caret.js');
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');
const { SmoothCursorMotion } = require('../src/renderer/smooth-cursor-overlay.js');
const { createXtermWebglSmoothCursor } = require('../src/renderer/xterm-smooth-cursor.js');
const { createInkCaretObserver } = require('../src/renderer/ink-caret-observer.js');
const imeAnchor = require('../src/renderer/ime-caret-anchor.js');
require('../src/vendor/xterm.js');
const BundledTerminal = globalThis.TabbyXterm.Terminal;

const restoreContentSource = readFileSync(new URL('../src/renderer/restore-content.js', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');

function createHarness(t, {
  cols = 80,
  rows = 24,
  reduced = false,
  cursorStyle = 'block',
  renderScope = 'full',
  useConPtyFilter = false,
} = {}) {
  let now = 1000;
  const source = new BundledTerminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  unicodeWidth.installOn(source);
  t.after(() => source.dispose());

  const coreService = {
    get isCursorHidden() { return source._core.coreService.isCursorHidden; },
    set isCursorHidden(v) { source._core.coreService.isCursorHidden = v; },
    isCursorInitialized: true,
  };
  const coreBrowserService = { isFocused: true };
  const workCell = source._core.buffer.getNullCell();
  const gl = {
    SCISSOR_TEST: 0x0c11,
    enable() {},
    disable() {},
    scissor() {},
  };
  const drawnGlyphs = [];
  const baseRenderCalls = [];
  const rectangleRenderer = {
    _gl: gl,
    _verticesCursor: { attributes: new Float32Array(32), count: 0 },
    _cursorFloat: new Float32Array([1, 1, 1, 1]),
    _colorToFloat32Array() { return new Float32Array([0.1, 0.1, 0.1, 1]); },
    _addRectangleFloat(attrs, idx, x, y, w, h) {
      attrs[0] = x; attrs[1] = y; attrs[2] = w; attrs[3] = h;
    },
    renderCursor() {},
  };
  const glyphRenderer = {
    _gl: gl,
    _vertices: null,
    _activeBuffer: null,
    _updateCell(attrs, idx, offset, code, bg, fg, ext, chars) {
      drawnGlyphs.push({ code, bg, fg, chars });
    },
    render() {},
  };
  const renderer = {
    _gl: gl,
    _canvas: { width: cols * 9, height: rows * 20 },
    _devicePixelRatio: 1,
    _coreService: coreService,
    _coreBrowserService: coreBrowserService,
    _workCell: workCell,
    _rectangleRenderer: { value: rectangleRenderer },
    _glyphRenderer: { value: glyphRenderer },
    _themeService: {
      colors: {
        cursor: { rgba: 0xffffffff },
        cursorAccent: { rgba: 0x000000ff },
        background: { rgba: 0x1e2129ff },
        foreground: { rgba: 0xabb2bfff },
      },
    },
    dimensions: { device: { cell: { width: 9, height: 20 } }, css: { cell: { width: 9, height: 20 } } },
    renderRows(start, end) {
      baseRenderCalls.push({ start, end, hidden: coreService.isCursorHidden });
    },
    _requestRedrawViewport() {},
  };
  const terminal = {
    get cols() { return source.cols; },
    get rows() { return source.rows; },
    options: { cursorStyle, cursorWidth: 2, fontFamily: 'Mono', fontSize: 14 },
    get buffer() { return source.buffer; },
    element: null,
    onScroll: cb => source.onScroll(cb),
    onResize: cb => source.onResize(cb),
    _core: {
      get buffer() { return source._core.buffer; },
      coreService,
      _renderService: { _renderer: { value: renderer } },
      optionsService: { onSpecificOptionChange: () => ({ dispose() {} }) },
      get _compositionHelper() { return source._core._compositionHelper; },
      _syncTextArea() { return source._core._syncTextArea?.(); },
    },
  };
  const adapter = createXtermWebglSmoothCursor({
    terminal,
    addon: { _renderer: renderer },
    MotionClass: SmoothCursorMotion,
    now: () => now,
    cursorStyle,
    renderScope,
    reducedMotionQuery: { matches: reduced },
  });
  t.after(() => adapter.dispose());

  const conPtyFilter = useConPtyFilter ? createConPtyCaretFilter({ mode: 'fix' }) : null;
  const owner = {
    id: 'postparse',
    tabId: 'local_1',
    type: 'local',
    term: source,
    _smoothCursor: { _adapter: adapter },
  };
  const context = {
    ipcRenderer: { on() {} },
    TabManager: { tabs: [owner], activeId: owner.id },
    window: {},
    createInkCaretObserver,
  };
  vm.createContext(context);
  vm.runInContext(restoreContentSource, context);
  vm.runInContext(ipcSource, context);

  async function write(raw) {
    const ink = context._inkFeed(owner, owner, null, raw);
    const filtered = conPtyFilter ? conPtyFilter.push(raw) : raw;
    await new Promise(resolve => source.write(filtered, () => {
      context._outputParsed(owner, ink)();
      resolve();
    }));
    renderer.renderRows(0, source.rows - 1);
    return ink;
  }

  function render() {
    renderer.renderRows(0, source.rows - 1);
  }

  function setTime(tMs) { now = tMs; }
  function advance(ms) { now += ms; }

  return {
    source, terminal, renderer, coreService, coreBrowserService, adapter,
    owner, context, drawnGlyphs, baseRenderCalls, write, render, setTime, advance,
  };
}

test('renderer.html loads unicode-width.js before post-parse-caret.js and charWidth matches zterm6', () => {
  const uwIdx = rendererHtml.indexOf('renderer/unicode-width.js');
  const ppIdx = rendererHtml.indexOf('renderer/post-parse-caret.js');
  assert.ok(uwIdx > 0 && ppIdx > 0, 'both scripts must be present in renderer.html');
  assert.ok(uwIdx < ppIdx, 'unicode-width.js must load before post-parse-caret.js in WebView2');

  // Verify shared zterm6 width agreement (BMP-widened, U+303F width 1, combining 0, astral 2).
  assert.equal(postParseApi.charWidth('✅'), 2);
  assert.equal(postParseApi.charWidth('⭐'), 2);
  assert.equal(postParseApi.charWidth('🚀'), 2);
  assert.equal(postParseApi.charWidth('\u303f'), 1);
  assert.equal(postParseApi.charWidth('\u0301'), 0);
  assert.equal(postParseApi.charWidth('\u3099'), 0);
});

test('classifyInputData maps printable, editing, nav, short paste, mid-string ESC poisoning, and barriers', () => {
  assert.deepEqual(postParseApi.classifyInputData('a'), [{ kind: 'printable', char: 'a', width: 1 }]);
  assert.deepEqual(postParseApi.classifyInputData('你'), [{ kind: 'printable', char: '你', width: 2 }]);
  assert.deepEqual(postParseApi.classifyInputData('✅'), [{ kind: 'printable', char: '✅', width: 2 }]);
  assert.deepEqual(postParseApi.classifyInputData('🚀'), [{ kind: 'printable', char: '🚀', width: 2 }]);
  assert.deepEqual(postParseApi.classifyInputData('\x7f'), [{ kind: 'backspace' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x08'), [{ kind: 'backspace' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[3~'), [{ kind: 'delete' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[D'), [{ kind: 'nav', dir: 'left' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1bOC'), [{ kind: 'nav', dir: 'right' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[A'), [{ kind: 'nav', dir: 'up' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1bOB'), [{ kind: 'nav', dir: 'down' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[H'), [{ kind: 'nav', dir: 'home' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[F'), [{ kind: 'nav', dir: 'end' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x01'), [{ kind: 'nav', dir: 'home' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x05'), [{ kind: 'nav', dir: 'end' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x02'), [{ kind: 'nav', dir: 'left' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x06'), [{ kind: 'nav', dir: 'right' }]);
  assert.deepEqual(postParseApi.classifyInputData('\x1b[200~hi\x1b[201~'), [
    { kind: 'printable', char: 'h', width: 1 },
    { kind: 'printable', char: 'i', width: 1 },
  ]);
  // Mid-string ESC must poison trailing escape parameter bytes.
  assert.deepEqual(postParseApi.classifyInputData('a\x1b[D'), [
    { kind: 'printable', char: 'a', width: 1 },
    { kind: 'barrier' },
  ]);
  // Combining mark fails closed as barrier.
  assert.deepEqual(postParseApi.classifyInputData('\u0301'), [{ kind: 'barrier' }]);
  // Barriers: Enter, Tab, Esc, Ctrl+C, win32 Ctrl+J, multiline/unterminated paste.
  for (const seq of ['\r', '\n', '\t', '\x1b', '\x03', '\x1b[74;36;10;1;8;1_', '\x1b[200~a\nb\x1b[201~', '\x1b[200~abc']) {
    assert.deepEqual(postParseApi.classifyInputData(seq), [{ kind: 'barrier' }], `expected barrier for ${JSON.stringify(seq)}`);
  }
});

test('local ConPTY old-Claude rewrite (HOME+CR+CSI-C+CSI-B + reverse space + CUP) acquires smooth software caret and drives IME', async t => {
  for (const revSgr of ['\x1b[7m \x1b[27m', '\x1b[0;7m \x1b[0m', '\x1b[0;7;39;49m \x1b[0m']) {
    const h = createHarness(t, { cols: 276, rows: 56, reduced: false, cursorStyle: 'block', useConPtyFilter: true });
    const ta = { style: {}, value: '', scrollLeft: 0, selectionStart: 0, selectionEnd: 0 };
    const cv = { style: {}, textContent: '', classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    h.source._core.textarea = ta;
    h.source._core._compositionView = cv;
    h.source._core._renderService = {
      hasRenderer: () => true,
      dimensions: { css: { cell: { width: 9, height: 23 } } },
      onDimensionsChange: () => ({ dispose() {} }),
      refreshRows() {},
      clear() {},
    };
    h.source._core._compositionHelper = { isComposing: false, updateCompositionElements() {} };
    assert.equal(imeAnchor.patchTerminal(h.source, { perceivedCaret: () => h.adapter.perceivedCaretCell() }), true);

    await h.write('\x1b[?25l\x1b[53;1H\x1b[38;5;244m❯\x1b[0m \x1b[2mTry "refactor"\x1b[0m\x1b[56;3H⏸\x1b[53;3H');
    assert.equal(h.coreService.isCursorHidden, true);
    assert.equal(h.adapter.snapshot().caretOwnership.active, false);

    const word = 'abcdefghijkl';
    for (let i = 0; i < word.length; i += 1) {
      const ch = word[i];
      const cxBefore = 2 + i;
      const cxAfter = 3 + i;
      h.advance(80);
      h.adapter.noteInput(ch);
      const clearTail = i === 0 ? '\x1b[K' : '';
      const frame = `\x1b[?25l\x1b[H\r\x1b[${cxBefore}C\x1b[52B${ch}${revSgr}${clearTail}\x1b[53;${cxAfter + 1}H`;
      await h.write(frame);

      const snap = h.adapter.snapshot();
      if (i === 0) {
        assert.equal(snap.caretOwnership.trustRun, 1);
        assert.equal(snap.caretOwnership.active, false);
      } else if (i === 1) {
        assert.equal(snap.caretOwnership.active, true);
        assert.equal(snap.caretOwnership.customDrawSource, 'software');
        assert.deepEqual(snap.target, { x: cxAfter, y: 52 });
        assert.equal(snap.visual.x, cxAfter, 'activation frame snaps cleanly');
      } else {
        assert.equal(snap.caretOwnership.active, true);
        assert.equal(snap.caretOwnership.customDrawSource, 'software');
        assert.deepEqual(snap.target, { x: cxAfter, y: 52 });
        assert.equal(snap.drawPassStatus, 'base+rectangle', 'typing slide uses plain echo mode');
        h.advance(30);
        h.render();
        const mid = h.adapter.snapshot();
        assert.ok(mid.visual.x > cxBefore && mid.visual.x < cxAfter,
          `${revSgr}: expected smooth slide between ${cxBefore} and ${cxAfter}, got ${mid.visual.x}`);
      }
    }

    assert.deepEqual(h.adapter.perceivedCaretCell(), { x: 14, y: 52, width: 1 });
    assert.equal(ta.style.left, (14 * 9) + 'px');
    assert.equal(ta.style.top, (52 * 23) + 'px');
    // Active composition also anchors onto the perceived software caret cell.
    h.source._core._compositionHelper.isComposing = true;
    h.source._core._compositionHelper.updateCompositionElements(true);
    assert.equal(cv.style.left, (14 * 9) + 'px');
    assert.equal(cv.style.top, (52 * 23) + 'px');
    const cell = h.source.buffer.active.getLine(52).getCell(14);
    assert.equal(cell.getChars(), ' ');
    assert.ok(cell.isInverse() !== 0, 'buffer cell remains inverse');
  }
});

test('production bar + cursor-scope + conpty-caret pipeline repaints covered glyph via drawRestoreCell', async t => {
  const h = createHarness(t, {
    cols: 80, rows: 24, reduced: false, cursorStyle: 'bar', renderScope: 'cursor', useConPtyFilter: true,
  });
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m\x1b[10;3H');
  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);

  // Move left onto 'b' with bar cursor: drawRestoreCell must repaint 'b' cleanly.
  h.drawnGlyphs.length = 0;
  h.advance(150);
  h.adapter.noteInput('\x1b[D');
  await h.write('\x1b[10;4H\x1b[7mb\x1b[27m ');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });
  assert.ok(h.drawnGlyphs.some(g => g.chars === 'b'), 'bar cursor restore overlay must repaint covered glyph');
});

test('astral emoji prompt (column vs UTF-16 offset) and BMP-widened emoji typing work cleanly', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  // Prompt starts with astral emoji 🚀 (2 cols, 3 UTF-16 units with tail) and placeholder (no preCaret).
  await h.write('\x1b[?25l\x1b[10;1H🚀❯ Try "refactor"\x1b[10;5H');
  h.advance(50);
  h.adapter.noteInput('a');
  await h.write('\x1b[10;5Ha\x1b[7m \x1b[27m\x1b[K\x1b[10;6H');
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 1, 'astral prompt cold-start must align columns');

  h.advance(50);
  h.adapter.noteInput('✅');
  await h.write('\x1b[10;6H✅\x1b[7m \x1b[27m\x1b[10;8H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true, 'BMP-widened ✅ must match zterm6 width 2');
  assert.deepEqual(h.adapter.snapshot().target, { x: 7, y: 9 });

  h.advance(50);
  h.adapter.noteInput('🚀');
  await h.write('\x1b[10;8H🚀\x1b[7m \x1b[27m\x1b[10;10H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 9, y: 9 });
});

test('chunk-split invariance (1, 7, 64 bytes) preserves ownership AND smooth 90ms slide without snapping', async t => {
  for (const chunkSize of [1, 7, 64]) {
    const h = createHarness(t, { cols: 80, rows: 24, reduced: false, cursorStyle: 'block' });
    await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m\x1b[10;3H');
    const frames = [
      { ch: 'x', data: '\x1b[?25l\x1b[H\r\x1b[2C\x1b[9Bx\x1b[7m \x1b[27m\x1b[10;4H' },
      { ch: 'y', data: '\x1b[?25l\x1b[H\r\x1b[3C\x1b[9By\x1b[7m \x1b[27m\x1b[10;5H' },
      { ch: 'z', data: '\x1b[?25l\x1b[H\r\x1b[4C\x1b[9Bz\x1b[7m \x1b[27m\x1b[10;6H' },
    ];
    for (let fIdx = 0; fIdx < frames.length; fIdx += 1) {
      const f = frames[fIdx];
      h.advance(120);
      h.adapter.noteInput(f.ch);
      for (let i = 0; i < f.data.length; i += chunkSize) {
        await h.write(f.data.slice(i, i + chunkSize));
      }
      if (fIdx === 2) {
        h.advance(30);
        h.render();
        const mid = h.adapter.snapshot();
        assert.equal(mid.caretOwnership.active, true, `chunkSize=${chunkSize} must stay active`);
        assert.deepEqual(mid.target, { x: 5, y: 9 });
        assert.ok(mid.visual.x > 4 && mid.visual.x < 5,
          `chunkSize=${chunkSize}: split resume must slide smoothly (4..5), got ${mid.visual.x}`);
      }
    }
  }
});

test('coalesced fast-typing burst consumes multi-char printable run in one ConPTY frame', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m\x1b[10;3H');
  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m\x1b[10;4H');
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m\x1b[10;5H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);

  h.advance(20);
  h.adapter.noteInput('c');
  h.advance(10);
  h.adapter.noteInput('d');
  await h.write('\x1b[10;5Hcd\x1b[7m \x1b[27m\x1b[10;7H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 6, y: 9 });
});

test('CJK wide characters, end-of-row wrap, and wide pre-write wrap at cols - 1', async t => {
  const h = createHarness(t, { cols: 20, rows: 10 });
  await h.write('\x1b[?25l\x1b[5;1H❯ \x1b[7m \x1b[27m\x1b[5;3H');

  h.adapter.noteInput('你');
  await h.write('\x1b[5;3H你\x1b[7m \x1b[27m\x1b[5;5H');
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 1);

  h.advance(50);
  h.adapter.noteInput('好');
  await h.write('\x1b[5;5H好\x1b[7m \x1b[27m\x1b[5;7H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 6, y: 4 });

  // Move cursor onto wide CJK glyph (width 2 must NOT trigger multi-cell-run).
  h.advance(50);
  h.adapter.noteInput('\x1b[D');
  await h.write('\x1b[5;5H\x1b[7m好\x1b[27m \x1b[5;5H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 4 });
  assert.equal(h.adapter.instrumentation.lastSoftwareCursor.width, 2);

  // Backspace over CJK wide char moves left by 2.
  h.advance(50);
  h.adapter.noteInput('\x7f');
  await h.write('\x1b[5;3H\x1b[7m好\x1b[27m  ');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 4 });

  // End-of-row wrap: fill cols 0..17 with 'x', reverse caret at col 18;
  // type 'a' at col 18 (fresh warmup), then 'w' at col 19 wrapping caret to (0, 5).
  await h.write('\x1b[5;1H' + 'x'.repeat(18) + '\x1b[7m \x1b[27m ');
  h.advance(50);
  h.adapter.noteInput('a');
  await h.write('\x1b[5;19Ha\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('w');
  await h.write('\x1b[5;20Hw\x1b[6;1H\x1b[7m \x1b[27m\x1b[6;1H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 0, y: 5 });

  // Wide-glyph pre-write wrap from cols - 1: anchored at col 19, typing '你'
  // wraps glyph to (0..1, y+1) and caret to (2, y+1).
  await h.write('\x1b[6;1H' + 'z'.repeat(17) + '\x1b[7m \x1b[27m  ');
  h.advance(50);
  h.adapter.noteInput('m');
  await h.write('\x1b[6;18Hm\x1b[7m \x1b[27m ');
  h.advance(50);
  h.adapter.noteInput('n');
  await h.write('\x1b[6;19Hn\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 19, y: 5 });
  h.advance(50);
  h.adapter.noteInput('你');
  await h.write('\x1b[6;20H \x1b[7;1H你\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 6 });
});

test('editing & nav: space backspace, unwrap backspace, delete, indented multiline left/right/up/down, Ctrl+A/E/B/F', async t => {
  const h = createHarness(t, { cols: 80, rows: 24, reduced: false, cursorStyle: 'block' });
  await h.write('\x1b[?25l\x1b[10;1H❯ hello\x1b[7m \x1b[27m');

  // Cold-start arrow keys MUST NOT establish ownership.
  h.adapter.noteInput('\x1b[D');
  await h.write('\x1b[10;7H\x1b[7mo\x1b[27m ');
  h.advance(50);
  h.adapter.noteInput('\x1b[D');
  await h.write('\x1b[10;6H\x1b[7ml\x1b[27mo');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);

  // Establish trust via 2 typed chars + trailing space.
  await h.write('\x1b[10;1H❯ \x1b[K\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput(' ');
  await h.write('\x1b[10;4H \x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });

  // Backspace over trailing space using space-overwrite redraw (postCells === preCells!).
  h.advance(150);
  h.adapter.noteInput('\x7f');
  await h.write('\x1b[10;4H\x1b[7m \x1b[27m ');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true, 'space backspace must not revoke');
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });

  // Type 'b', then test Ctrl+B (left), Ctrl+F (right), Ctrl+A (home), Delete, Ctrl+E (end).
  h.advance(100);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });
  // Settle typing slide before starting navigation (mirroring real rAF).
  h.advance(150);
  h.render();

  h.advance(150);
  h.adapter.noteInput('\x02'); // Ctrl+B (left)
  await h.write('\x1b[10;4H\x1b[7mb\x1b[27m ');
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });
  assert.equal(h.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph', 'nav keeps scissored inversion');

  h.advance(150);
  h.adapter.noteInput('\x06'); // Ctrl+F (right)
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });

  h.advance(150);
  h.adapter.noteInput('\x01'); // Ctrl+A (home)
  await h.write('\x1b[10;3H\x1b[7ma\x1b[27mb ');
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 9 });

  h.advance(150);
  h.adapter.noteInput('\x1b[3~'); // Forward Delete removes 'a', 'b' shifts under caret.
  await h.write('\x1b[10;3H\x1b[7mb\x1b[27m ');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 9 });

  h.advance(150);
  h.adapter.noteInput('\x05'); // Ctrl+E (end)
  await h.write('\x1b[10;3Hb\x1b[7m \x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });

  // Multiline indented prompt (col 2): Down, Up, indented Left/Right wrap, and Backspace unwrap.
  await h.write('\x1b[11;1H  xy');
  h.advance(150);
  h.adapter.noteInput('\x1b[B'); // Down -> (2, 10)
  await h.write('\x1b[10;4H \x1b[11;3H\x1b[7mx\x1b[27my');
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 10 });

  h.advance(150);
  h.adapter.noteInput('\x1b[D'); // Indented Left from col 2 wraps back to (3, 9)
  await h.write('\x1b[11;3Hx\x1b[10;4H\x1b[7m \x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });

  h.advance(150);
  h.adapter.noteInput('\x1b[C'); // Indented Right wraps to (2, 10)
  await h.write('\x1b[10;4H \x1b[11;3H\x1b[7mx\x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 10 });

  h.advance(150);
  h.adapter.noteInput('\x1b[A'); // Up -> (2, 9)
  await h.write('\x1b[11;3Hx\x1b[10;3H\x1b[7mb\x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 2, y: 9 });

  // Backspace unwrap from col 0 of row 10 back to row 9.
  h.advance(150);
  h.adapter.noteInput('\x1b[B');
  await h.write('\x1b[10;3Hb\x1b[11;1H\x1b[7m \x1b[27m xy');
  assert.deepEqual(h.adapter.snapshot().target, { x: 0, y: 10 });
  h.advance(150);
  h.adapter.noteInput('\x7f');
  await h.write('\x1b[11;1H\x1b[K\x1b[10;4H\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });
});

test('ADR-0002 anti-hijack: static adjacent-row badge on Up/Down, spinner during Backspace, untrusted nav after barrier, no prompt-move deadlock', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  // Static single-cell reverse badge on row 10 below active prompt row 9.
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m\x1b[11;1H\x1b[7m?\x1b[27m for shortcuts');
  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });

  // Pressing Down at bottom of single-line prompt must NEVER hijack onto row 10's static `?` badge!
  h.advance(100);
  h.adapter.noteInput('\x1b[B');
  await h.write('\x1b[10;5H'); // harmless no-op chunk
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 }, 'static adjacent badge must not hijack caret');

  // Adjacent-row spinner ticking on row 8 while user presses Backspace at col 4 on row 9 must NOT hijack!
  await h.write('\x1b[9;1HWorking 12s \x1b[7m|\x1b[27m');
  h.advance(100);
  h.adapter.noteInput('\x7f');
  await h.write('\x1b[9;1HWorking 13s \x1b[7m/\x1b[27m');
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 }, 'adjacent spinner must not hijack Backspace unwrap');

  // Untrusted trustRun=1 + Enter barrier + Arrow key MUST NOT activate takeover.
  const h2 = createHarness(t, { cols: 80, rows: 24 });
  await h2.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m');
  h2.adapter.noteInput('a');
  await h2.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
  assert.equal(h2.adapter.snapshot().caretOwnership.trustRun, 1);
  assert.equal(h2.adapter.snapshot().caretOwnership.active, false);
  h2.advance(50);
  h2.adapter.noteInput('\r'); // barrier drops untrusted warmup
  h2.advance(50);
  h2.adapter.noteInput('\x1b[D');
  await h2.write('\x1b[10;3H\x1b[7ma\x1b[27m ');
  assert.equal(h2.adapter.snapshot().caretOwnership.active, false, 'barrier must prevent untrusted nav activation');

  // Prompt moves to a new row after Enter: must NOT deadlock — re-warms cleanly on the new row!
  await h2.write('\x1b[10;1H❯ a\x1b[K\x1b[14;1H❯ \x1b[7m \x1b[27m');
  h2.advance(50);
  h2.adapter.noteInput('x');
  await h2.write('\x1b[14;3Hx\x1b[7m \x1b[27m');
  assert.equal(h2.adapter.snapshot().caretOwnership.trustRun, 1);
  h2.advance(50);
  h2.adapter.noteInput('y');
  await h2.write('\x1b[14;4Hy\x1b[7m \x1b[27m');
  assert.equal(h2.adapter.snapshot().caretOwnership.active, true, 'must recover on relocated prompt without deadlock');
  assert.deepEqual(h2.adapter.snapshot().target, { x: 4, y: 13 });
});

test('ADR-0002 anti-spinner, anti-menu (including mixed-attribute bars), and multi-row ambiguity fail closed', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  await h.write('\x1b[?25l\x1b[10;1HWorking \x1b[7m|\x1b[27m');

  for (const glyph of ['/', '-', '\\', '|', '/']) {
    h.advance(100);
    await h.write(`\x1b[10;1HWorking \x1b[7m${glyph}\x1b[27m\x1b[24;1H`);
  }
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 0);

  // Mid-typing spinner fails char causal check.
  h.advance(100);
  h.adapter.noteInput('a');
  await h.write('\x1b[10;1HWorking \x1b[7m\\\x1b[27m\x1b[24;1H');
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;1HWorking \x1b[7m|\x1b[27m\x1b[24;1H');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);

  // Mixed-attribute highlight bar (\x1b[7;1mOption\x1b[0;7m \x1b[0m and reverse prefix).
  await h.write('\x1b[12;1H❯ \x1b[7;1mOption\x1b[0;7m \x1b[0m');
  h.advance(50);
  h.adapter.noteInput('n');
  await h.write('\x1b[12;1H❯ \x1b[7;1mOption\x1b[0;7m \x1b[0m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);
  await h.write('\x1b[13;1H❯ \x1b[7m \x1b[1;7mOption\x1b[0m');
  h.advance(50);
  h.adapter.noteInput('a');
  await h.write('\x1b[13;3Ha\x1b[7m \x1b[1;7mOption\x1b[0m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'mixed-attribute reverse bar must be rejected');

  // Two isolated single-cell reverse badges on same row -> rejected.
  await h.write('\x1b[14;1H\x1b[7m!\x1b[27m ❯ \x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('c');
  await h.write('\x1b[14;1H\x1b[7m!\x1b[27m ❯ c\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('d');
  await h.write('\x1b[14;1H\x1b[7m!\x1b[27m ❯ cd\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);

  // Multi-row ambiguity (2 distinct rows both echoing 'm' + reverse space in one chunk) -> fail closed.
  const h3 = createHarness(t, { cols: 80, rows: 24 });
  await h3.write('\x1b[?25l\x1b[5;1H❯ \x1b[7m \x1b[27m\x1b[8;1H❯ \x1b[7m \x1b[27m');
  h3.adapter.noteInput('m');
  await h3.write('\x1b[5;3Hm\x1b[7m \x1b[27m\x1b[8;3Hm\x1b[7m \x1b[27m');
  assert.equal(h3.adapter.snapshot().caretOwnership.trustRun, 0, 'ambiguous multi-row match must fail closed');
});

test('truecolor caret works over default-color text and fails closed on syntax-colored text (incl. cold-start Backspace)', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  const tcCaret = '\x1b[38;2;20;20;20;48;2;230;230;230m \x1b[0m';
  await h.write('\x1b[?25l\x1b[10;1H❯ ' + tcCaret);

  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha' + tcCaret);
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb' + tcCaret);
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });

  // Syntax-colored text on typing AND cold-start Backspace -> fail closed.
  const h2 = createHarness(t, { cols: 80, rows: 24 });
  await h2.write('\x1b[?25l\x1b[10;1H❯ \x1b[38;2;255;0;0m你好\x1b[0m' + tcCaret);
  h2.advance(50);
  h2.adapter.noteInput('\x7f');
  await h2.write('\x1b[10;5H' + tcCaret + '  ');
  assert.equal(h2.adapter.snapshot().caretOwnership.trustRun, 0, 'cold-start truecolor backspace over colored CJK must fail closed');
  h2.advance(50);
  h2.adapter.noteInput('a');
  await h2.write('\x1b[10;3H\x1b[38;2;255;0;0ma' + tcCaret);
  assert.equal(h2.adapter.snapshot().caretOwnership.active, false);
});

test('resilience to ConPTY CSI X (ECH), tmux CSI r (DECSTBM), and pre-parse-declined ?2026h sync units', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m');

  // Pre-parse-declined sync unit (carries a colored border so plainAttrOk/ambiguous
  // or no-plain-write declines pre-parse) must still warm and activate via post-parse.
  h.adapter.noteInput('a');
  await h.write('\x1b[?2026h\x1b[10;3Ha\x1b[7m \x1b[27m\x1b[1;1H\x1b[7m \x1b[27m\x1b[1;1H \x1b[?2026l');
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 1);
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[?2026h\x1b[10;4Hb\x1b[7m \x1b[27m\x1b[1;1H\x1b[7m \x1b[27m\x1b[1;1H \x1b[?2026l');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true, 'sync unit declined by pre-parse must not deadlock warmup');

  // ConPTY ECH (CSI 1 X) during Backspace and tmux DECSTBM (CSI 1;23r) during typing
  // trigger ink-caret-observer losePosition(), which must NOT kill post-parse intents or ownership.
  h.advance(50);
  h.adapter.noteInput('\x7f');
  await h.write('\x1b[10;4H\x1b[7m \x1b[27m\x1b[1X');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true, 'ConPTY CSI X erase must not break post-parse');
  assert.deepEqual(h.adapter.snapshot().target, { x: 3, y: 9 });

  h.advance(50);
  h.adapter.noteInput('c');
  await h.write('\x1b[1;23r\x1b[10;4Hc\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true, 'tmux CSI r must not break post-parse');
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 9 });
});

test('O(1) zero-row-scan budget during visible cursor, idle hidden streaming, and >6-row bulk output', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  let loadCellReads = 0;
  const origLinesGet = h.source._core.buffer.lines.get.bind(h.source._core.buffer.lines);
  h.source._core.buffer.lines.get = function (idx) {
    const line = origLinesGet(idx);
    if (!line || line.__spied) return line;
    const origLoad = line.loadCell.bind(line);
    line.loadCell = function () { loadCellReads += 1; return origLoad.apply(this, arguments); };
    line.__spied = true;
    return line;
  };

  // Helper that feeds _inkFeed -> xterm parse -> _outputParsed WITHOUT calling
  // renderer.renderRows(), isolating post-parse buffer reads from protocol-cursor
  // renderRows() bookkeeping (lastTargetRowText).
  async function writeWithoutRender(raw) {
    const ink = h.context._inkFeed(h.owner, h.owner, null, raw);
    await new Promise(resolve => h.source.write(raw, () => {
      h.context._outputParsed(h.owner, ink)();
      resolve();
    }));
  }

  // 1. Visible cursor streaming: zero post-parse cell reads.
  await writeWithoutRender('\x1b[?25h');
  loadCellReads = 0;
  h.adapter.noteInput('a');
  await writeWithoutRender('visible-output-line\r\n'.repeat(10));
  assert.equal(loadCellReads, 0, 'visible cursor must perform zero post-parse buffer scans');

  // 2. Hidden cursor with NO user input (idle streaming / AI output): zero reads.
  await writeWithoutRender('\x1b[?25l');
  h.advance(2000); // expire prior intent
  loadCellReads = 0;
  await writeWithoutRender('streaming-ai-output\r\n'.repeat(10));
  assert.equal(loadCellReads, 0, 'idle hidden streaming with no pending intent must perform zero scans');

  // 3. Hidden cursor with pending intent but bulk >6 dirty rows: disqualified in O(1) with zero reads.
  h.advance(50);
  h.adapter.noteInput('x');
  loadCellReads = 0;
  let bulk = '';
  for (let r = 1; r <= 10; r += 1) bulk += `\x1b[${r};1Hbulk-${r}x\x1b[7m \x1b[27m`;
  await writeWithoutRender(bulk);
  assert.equal(loadCellReads, 0, 'bulk >6 dirty rows must disqualify before scanning any row');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);
});

test('lifecycle & safety revokes: ?25h immediate, scroll, scrolled-up viewport, resize, unfocused, Enter, alt-buffer, and rebind', async t => {
  const h = createHarness(t, { cols: 80, rows: 24 });
  async function engage() {
    await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[K\x1b[7m \x1b[27m');
    h.advance(50);
    h.adapter.noteInput('a');
    await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
    h.advance(50);
    h.adapter.noteInput('b');
    await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
    assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  }

  // 1. ?25h revokes IMMEDIATELY in parsed() (even before renderRows).
  await engage();
  const inkVis = h.context._inkFeed(h.owner, h.owner, null, '\x1b[?25h\x1b[10;5H');
  await new Promise(resolve => h.source.write('\x1b[?25h\x1b[10;5H', () => {
    h.context._outputParsed(h.owner, inkVis)();
    resolve();
  }));
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, '?25h must revoke immediately in parsed()');
  assert.equal(h.adapter.snapshot().caretOwnership.reason, 'protocol-visible');
  h.render();
  assert.equal(h.adapter.snapshot().caretOwnership.customDrawSource, 'protocol');

  // 2. rebindObserver (split/drag migration) preserves active ownership across new observer seqs.
  await engage();
  h.adapter.softwareCaretPort.rebindObserver();
  h.owner._inkObserver = null;
  h.advance(50);
  h.adapter.noteInput('e');
  await h.write('\x1b[10;5He\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 5, y: 9 });

  // 3. Real scroll revokes active ownership; scrolled-up viewport (viewportY < baseY) blocks re-engagement.
  await h.write('\x1b[24;1H' + '\r\n'.repeat(30));
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'scroll must revoke ownership');
  h.source._core._bufferService.scrollLines(-5, false);
  assert.ok(h.source.buffer.active.viewportY < h.source.buffer.active.baseY);
  h.advance(50);
  h.adapter.noteInput('s');
  await h.write('\x1b[10;3Hs\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'scrolled-up viewport must not engage');
  h.source._core._bufferService.scrollLines(5, false);

  // 4. Resize revokes active ownership immediately.
  await engage();
  h.source.resize(90, 26);
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'resize must revoke ownership');

  // 5. Unfocused terminal must not acquire ownership.
  h.coreBrowserService.isFocused = false;
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[K\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('u');
  await h.write('\x1b[10;3Hu\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('v');
  await h.write('\x1b[10;4Hv\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'unfocused terminal must not engage');
  h.coreBrowserService.isFocused = true;

  // 6. Enter barrier + prompt cleared -> revokes cleanly.
  await engage();
  h.advance(50);
  h.adapter.noteInput('\r');
  await h.write('\x1b[10;1H\x1b[K');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false);

  // 7. Alternate buffer switch revokes IMMEDIATELY in parsed() (before renderRows)
  //    and drops normal-buffer intents even when cursor was visible before ?1049h?25l.
  await engage();
  h.advance(50);
  h.adapter.noteInput('z'); // pending normal-buffer intent
  const inkAlt = h.context._inkFeed(h.owner, h.owner, null, '\x1b[?1049h\x1b[?25l\x1b[10;3Hz\x1b[7m \x1b[27m');
  await new Promise(resolve => h.source.write('\x1b[?1049h\x1b[?25l\x1b[10;3Hz\x1b[7m \x1b[27m', () => {
    h.context._outputParsed(h.owner, inkAlt)();
    resolve();
  }));
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'alt-buffer switch must revoke immediately in parsed()');
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 0, 'normal-buffer intent must not leak into alternate buffer');
  await h.write('\x1b[?1049l\x1b[?25h');
  // Visible cursor -> normal-buffer intent -> ?1049h?25l in one chunk must ALSO drop intent.
  h.advance(50);
  h.adapter.noteInput('k');
  await h.write('\x1b[?1049h\x1b[?25l\x1b[10;3Hk\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.trustRun, 0, 'visible-cursor normal intent must not leak across ?1049h');
  await h.write('\x1b[?1049l');

  // 8. DECOM (?6h) revokes active post-parse ownership and resets cleanly.
  await engage();
  await h.write('\x1b[?6h');
  assert.equal(h.adapter.snapshot().caretOwnership.active, false, 'DECOM must revoke active post-parse caret');
  assert.equal(h.adapter.snapshot().caretOwnership.reason, 'invalidate:observer:decom');
  await h.write('\x1b[?6l');
});

test('active resetTrust relocation clears stale WebGL row & IME cleanly, and expired bulk cycle never leaks', async t => {
  // 1. Active cursor-scope software caret on row 9 relocates to row 13 in one chunk (resetTrust=true).
  const h = createHarness(t, { cols: 80, rows: 24, renderScope: 'cursor', cursorStyle: 'bar' });
  await h.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m');
  h.adapter.noteInput('a');
  await h.write('\x1b[10;3Ha\x1b[7m \x1b[27m');
  h.advance(50);
  h.adapter.noteInput('b');
  await h.write('\x1b[10;4Hb\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.equal(h.adapter.snapshot().caretOwnership.customDrawSource, 'software');

  h.baseRenderCalls.length = 0;
  h.advance(50);
  h.adapter.noteInput('x');
  // Relocate prompt from row 9 (cleared) to row 13 with 'x' + reverse caret in one chunk.
  const inkReloc = h.context._inkFeed(h.owner, h.owner, null, '\x1b[10;1H\x1b[K\x1b[14;1H❯ x\x1b[7m \x1b[27m');
  await new Promise(resolve => h.source.write('\x1b[10;1H\x1b[K\x1b[14;1H❯ x\x1b[7m \x1b[27m', () => {
    h.context._outputParsed(h.owner, inkReloc)();
    resolve();
  }));
  const afterReloc = h.adapter.snapshot();
  assert.equal(afterReloc.caretOwnership.active, false, 'relocation resets active to warmup');
  assert.equal(afterReloc.caretOwnership.trustRun, 1);
  assert.equal(afterReloc.caretOwnership.customDrawSource, 'none', 'stale software draw source cleared');
  assert.ok(h.baseRenderCalls.some(c => c.start === 9 && c.end === 9),
    'clearSoftwareVisual must repaint stale row 9 under cursor renderScope');

  // Second keystroke on row 13 cleanly re-activates takeover.
  h.advance(50);
  h.adapter.noteInput('y');
  await h.write('\x1b[14;4Hy\x1b[7m \x1b[27m');
  assert.equal(h.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h.adapter.snapshot().target, { x: 4, y: 13 });

  // 2. Expired intent between chunkWrites (bulk disqualified at t=1190) and parsed (t=1210)
  //    must NOT leak cycle.disqualified to the next valid keystroke!
  const h2 = createHarness(t, { cols: 80, rows: 24 });
  await h2.write('\x1b[?25l\x1b[10;1H❯ \x1b[7m \x1b[27m');
  h2.adapter.noteInput('p'); // t = 1000
  h2.advance(1190); // t = 2190 (still within 1200ms TTL during chunkWrites)
  let bulk = '';
  for (let r = 1; r <= 10; r += 1) bulk += `\x1b[${r};1Hbulk-${r}`;
  const inkBulk = h2.context._inkFeed(h2.owner, h2.owner, null, bulk);
  h2.advance(20); // t = 2210 -> intent expired before parsed()!
  await new Promise(resolve => h2.source.write(bulk, () => {
    h2.context._outputParsed(h2.owner, inkBulk)();
    resolve();
  }));
  // Next valid keystrokes must NOT be disqualified by a leaked cycle.
  await h2.write('\x1b[10;1H❯ \x1b[K\x1b[7m \x1b[27m');
  h2.advance(50);
  h2.adapter.noteInput('m');
  await h2.write('\x1b[10;3Hm\x1b[7m \x1b[27m');
  assert.equal(h2.adapter.snapshot().caretOwnership.trustRun, 1, 'next keystroke after expired bulk must not be disqualified');
  h2.advance(50);
  h2.adapter.noteInput('n');
  await h2.write('\x1b[10;4Hn\x1b[7m \x1b[27m');
  assert.equal(h2.adapter.snapshot().caretOwnership.active, true);
  assert.deepEqual(h2.adapter.snapshot().target, { x: 4, y: 9 });
});
