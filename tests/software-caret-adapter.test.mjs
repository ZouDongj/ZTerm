// Software-caret adapter state-machine tests: trust/watermark/generation
// gating, neutral vs contradictory units, cell style evidence, DECTCEM
// independence, and the restore-overlay regression (the restore overlay must
// draw the covering GLYPH, not just a background rect — with the default
// bar style nothing else repaints it).
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
const { Terminal } = globalThis.TabbyXterm;
const BundledTerminal = globalThis.TabbyXterm.Terminal;

const restoreContentSource = readFileSync(new URL('../src/renderer/restore-content.js', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');

function ipcParserFixture(t, geometry = { cols: 80, rows: 24 }) {
  const f = parserFixture(t, { ...geometry, TerminalClass: BundledTerminal });
  Object.defineProperty(f.terminal._core, 'buffer', { get: () => f.source._core.buffer });
  const scroll = f.source.onScroll(() => f.adapter.softwareCaretPort.invalidate('scroll'));
  t.after(() => scroll.dispose());
  const owner = { id: 'lifecycle', tabId: 'offline', type: 'ssh', term: f.source, _smoothCursor: { _adapter: f.adapter } };
  const context = { ipcRenderer: { on() {} }, TabManager: { tabs: [owner] }, window: {}, createInkCaretObserver };
  vm.createContext(context);
  vm.runInContext(restoreContentSource, context); // appendContentTail for the restore capture
  vm.runInContext(ipcSource, context);
  async function write(raw) {
    const ink = context._inkFeed(owner, owner, null, raw);
    await new Promise(resolve => f.source.write(raw, () => { context._outputParsed(owner, ink)(); resolve(); }));
    render(f);
    return ink;
  }
  return { ...f, owner, context, write };
}

test('captured visible sync chunks acquire software ownership through actual bundled parser and IPC callbacks', async t => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/visible-sync-caret-chunks.json', import.meta.url)));
  const f = ipcParserFixture(t, raw);
  Object.defineProperty(f.coreService, 'isCursorHidden', { get: () => f.source._core.coreService.isCursorHidden, set: value => { f.source._core.coreService.isCursorHidden = value; } });
  await f.write('\x1b[?1049h\x1b[?7l');
  const active = [];
  for (const chunk of raw.chunks) { await f.write(chunk); active.push(f.adapter.snapshot().caretOwnership.active); }
  assert.deepEqual(active, [false, false, true, true], 'neutral SHOW-only units must preserve trust and ownership');
  assert.equal(f.source._core.coreService.decPrivateModes.wraparound, false);
  assert.equal(f.source._core.coreService.isCursorHidden, false);
  assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'software');
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor.x, 32);
  assert.equal(f.source.buffer.active.getLine(52).getCell(32).getChars(), ' ');
});

test('visible sync first candidate stays raw, second snaps and third moves without changing real cells', async t => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/visible-sync-native-chunks.json', import.meta.url)));
  const f = ipcParserFixture(t, { ...raw, reduced: false });
  Object.defineProperty(f.coreService, 'isCursorHidden', { get: () => f.source._core.coreService.isCursorHidden, set: value => { f.source._core.coreService.isCursorHidden = value; } });
  await f.write('\x1b[?1049h\x1b[?7l');
  const before = f.adapter.snapshot().counters.cursorDrawPasses;
  await f.write(raw.chunks[0]);
  assert.equal(f.adapter.snapshot().caretOwnership.trustRun, 1);
  assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'none');
  assert.equal(f.adapter.snapshot().counters.cursorDrawPasses, before);
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor, undefined, 'no restore before trust');
  await f.write(raw.chunks[1]);
  assert.equal(f.adapter.snapshot().counters.cursorDrawPasses, before, 'neutral unit preserves raw warmup');
  f.setTime(300); await f.write(raw.chunks[2]);
  assert.equal(f.adapter.snapshot().caretOwnership.active, true);
  assert.equal(f.adapter.snapshot().visual.x, f.adapter.snapshot().target.x, 'second candidate snaps on source switch');
  await f.write(raw.chunks[3]);
  f.setTime(600); await f.write(raw.chunks[4]);
  const b = f.source.buffer.active, cell = b.getLine(52).getCell(33);
  const attrs = [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor()];
  f.setTime(620); render(f);
  assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'software');
  assert.ok(f.adapter.snapshot().visual.x > 32 && f.adapter.snapshot().visual.x < 33);
  const after = b.getLine(52).getCell(33);
  assert.deepEqual([after.getChars(), after.getWidth(), after.getFgColorMode(), after.getFgColor(), after.getBgColorMode(), after.getBgColor()], attrs);
  assert.deepEqual(attrs, [' ', 1, 50331648, 2632756, 50331648, 14475236]);
});

for (const reason of ['no-proof', 'invalid-cell', 'overwritten', 'generation', 'buffer-switch']) {
  test('first-candidate raw fallback does not suppress ordinary protocol after ' + reason, () => {
    const f = fixture(); f.coreService.isCursorHidden = false;
    const p = f.adapter.softwareCaretPort;
    p.candidate(f.cand({ confirmedVisibleSync: reason !== 'no-proof', ...(reason === 'invalid-cell' ? { fg: '1;2;3' } : {}) })); p.parsed(1);
    if (reason === 'overwritten') f.cellState.bg = 0;
    if (reason === 'generation') p.invalidate('resize');
    if (reason === 'buffer-switch') f.terminal.buffer.active.type = 'alternate';
    render(f);
    assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'protocol');
  });
}

for (const kind of ['alternate', 'normal-scrollback']) {
  test('movement-only IPC output releases visible-sync warmup in ' + kind, async t => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/visible-sync-native-chunks.json', import.meta.url)));
    const f = ipcParserFixture(t, { ...raw, reduced: false });
    Object.defineProperty(f.coreService, 'isCursorHidden', { get: () => f.source._core.coreService.isCursorHidden, set: value => { f.source._core.coreService.isCursorHidden = value; } });
    await f.write(kind === 'alternate' ? '\x1b[?1049h\x1b[?7l' : '\n'.repeat(60) + '\x1b[?7l');
    await f.write(raw.chunks[0]);
    const buffer = f.source.buffer.active;
    assert.equal(buffer.type, kind === 'alternate' ? 'alternate' : 'normal');
    if (kind === 'normal-scrollback') { assert.ok(buffer.baseY > 0); assert.equal(buffer.baseY, buffer.viewportY); }
    assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'none');
    const cellAttrs = () => { const c = buffer.getLine(buffer.baseY + 52).getCell(31); return [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor()]; };
    const before = cellAttrs();
    await f.write('\x1b[50;10H');
    assert.equal(f.adapter.snapshot().caretOwnership.trustRun, 1);
    assert.equal(f.adapter.snapshot().caretOwnership.active, false);
    assert.equal(f.adapter.snapshot().caretOwnership.customDrawSource, 'protocol');
    assert.deepEqual(f.adapter.snapshot().target, { x: 9, y: 49 });
    assert.deepEqual(cellAttrs(), before, 'movement does not overwrite the original RGB cell');
  });
}

if (process.env.ZTERM_PRIVATE_CARET_CAPTURE) {
  test('private selected-owner stream preserves actual chunks through bundled parser, observer, adapter and IPC', async t => {
    const capture = JSON.parse(readFileSync(process.env.ZTERM_PRIVATE_CARET_CAPTURE));
    const f = ipcParserFixture(t, { rows: 57, cols: 277, reduced: false });
    Object.defineProperty(f.coreService, 'isCursorHidden', { get: () => f.source._core.coreService.isCursorHidden, set: value => { f.source._core.coreService.isCursorHidden = value; } });
    await f.write('\x1b[?1049h\x1b[?7l');
    let candidates = 0, units = 0, rejected = 0;
    const port = f.adapter.softwareCaretPort, candidate = port.candidate, unit = port.unit;
    port.candidate = c => { candidates++; candidate(c); };
    port.unit = u => { units++; if (!u.hadCandidate) rejected++; unit(u); };
    const states = [];
    for (const [index, chunk] of capture.export.raw.chunks.entries()) {
      f.setTime(chunk.at); await f.write(chunk.data);
      const s = f.adapter.snapshot().caretOwnership;
      states.push({ index, at: chunk.at, active: s.active, source: s.customDrawSource, trust: s.trustRun, reason: s.reason, candidates, units, rejected });
    }
    assert.equal(candidates, 15); assert.equal(units, 47); assert.equal(rejected, 32);
    assert.equal(states[1].active, false, 'first candidate remains in warmup');
    assert.equal(states[1].source, 'none', 'verified first candidate uses raw base display');
    assert.equal(states[2].source, 'none', 'neutral unit does not add a smoothed protocol cursor during warmup');
    assert.equal(states[3].active, true, 'second candidate engages despite neutral updates');
    assert.ok(states.slice(3).every(s => s.active), 'actual later neutral and ambiguous chrome updates must not revoke the untouched caret');
    assert.equal(f.source._core.coreService.decPrivateModes.wraparound, false);
    console.log('PRIVATE_CONTENT_FREE_REPLAY ' + JSON.stringify({ chunks: states.length, candidates, units, rejected, firstActiveChunk: states.find(s => s.active)?.index, states }));
  });
}

test('real IPC parsed callback recovers relative Claude takeover after an alternate-buffer roundtrip', async t => {
  const f = ipcParserFixture(t);
  const raw = readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8');
  await f.write('\x1b[?1049h\x1b[?1049l');
  await f.write(raw);
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, true, 'latest parser checkpoint must permit subsequent relative-only candidates');
});

test('unknown movement revokes an existing descriptor even while its old cell still matches', async t => {
  const f = ipcParserFixture(t);
  const raw = readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8');
  await f.write(raw);
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, true);
  await f.write('\x1b[1E');
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, false, 'coordinate discontinuity cannot retain an old matching descriptor');
});

for (const size of [1, 7, 64, 4096]) {
  test(`latest IPC checkpoint recovers relative fixture with ${size}-unit splits`, async t => {
    const f = ipcParserFixture(t);
    const raw = '\x1b[?1049h\x1b[?1049l\x1b[1E' + readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8');
    for (let i = 0; i < raw.length; i += size) await f.write(raw.slice(i, i + size));
    // A whole poisoned chunk is intentionally not retroactively certified.
    if (size === 4096) assert.notEqual(f.adapter.instrumentation.softwareCaret?.active, true);
    await f.write(readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8'));
    assert.equal(f.adapter.instrumentation.softwareCaret?.active, true);
    assert.equal(f.owner._inkObserver.state().positionKnown, true);
    assert.ok(f.owner._inkObserver.state().recoveries >= 1);
  });
}

test('a callback behind observed input cannot checkpoint or certify its later unknown candidates', async t => {
  const f = ipcParserFixture(t), raw = readFileSync(new URL('./fixtures/claude-rig-bare-rev.txt', import.meta.url), 'utf8');
  const first = f.context._inkFeed(f.owner, f.owner, null, '\x1b[1E');
  const later = f.context._inkFeed(f.owner, f.owner, null, raw);
  await new Promise(resolve => f.source.write('\x1b[1E', () => {
    f.context._outputParsed(f.owner, first)();
    assert.equal(f.owner._inkObserver.state().positionKnown, false);
    assert.equal(f.owner._inkObserver.state().recoveries, 0);
    resolve();
  }));
  await new Promise(resolve => f.source.write(raw, () => { f.context._outputParsed(f.owner, later)(); resolve(); }));
  assert.equal(f.owner._inkObserver.state().positionKnown, true);
  assert.notEqual(f.adapter.instrumentation.softwareCaret?.active, true);
  await f.write(raw);
  assert.equal(f.adapter.instrumentation.softwareCaret?.active, true);
});

for (const stale of ['observer', 'term', 'adapter', 'session', 'generation']) {
  test(`parsed recovery rejects a stale ${stale} identity`, async t => {
    const f = ipcParserFixture(t), raw = '\x1b[1E';
    const ink = f.context._inkFeed(f.owner, f.owner, null, raw);
    const observer = f.owner._inkObserver;
    if (stale === 'observer') f.owner._inkObserver = createInkCaretObserver({ rows: 24, cols: 80 });
    if (stale === 'term') f.owner.term = {};
    if (stale === 'adapter') f.owner._smoothCursor._adapter = {};
    if (stale === 'session') f.owner._inkSessionEpoch = 1;
    if (stale === 'generation') f.adapter.softwareCaretPort.invalidate('resize');
    await new Promise(resolve => f.source.write(raw, () => { f.context._outputParsed(f.owner, ink)(); resolve(); }));
    assert.equal(observer.state().positionKnown, false);
    assert.equal(observer.state().recoveries, 0);
    assert.equal(f.adapter.softwareCaretPort.isParsed(ink.seq), stale === 'generation');
  });
}

test('real parser scroll during the final write acknowledges parsing without applying a stale checkpoint', async t => {
  const f = ipcParserFixture(t, { cols: 10, rows: 3 });
  let scrolls = 0;
  const listener = f.source.onScroll(() => scrolls++); t.after(() => listener.dispose());
  const ink = await f.write('\x1b[3;1H\n');
  assert.equal(scrolls, 1);
  assert.notEqual(f.adapter.softwareCaretPort.generation(), ink.generation);
  assert.equal(f.adapter.softwareCaretPort.isParsed(ink.seq), true);
  assert.equal(f.owner._inkObserver.state().recoveries, 0);
  assert.equal(f.adapter.snapshot().caretOwnership.queued, f.adapter.snapshot().caretOwnership.parsed);
});

for (const [name, suffix] of [
  ['origin', '\x1b[?6h'], ['no-wrap', '\x1b[?7l'], ['reverse-wrap', '\x1b[?45h'],
  ['scroll-margins', '\x1b[2;20r'], ['insert-mode', '\x1b[4h'], ['styled', '\x1b[1m'],
  ['partial-CSI', '\x1b['], ['partial-OSC', '\x1b]8;'], ['open-unit', '\x1b[?2026h'],
  ['open-reverse', '\x1b[7m'],
]) {
  test(`parsed checkpoint declines ${name} state`, async t => {
    const f = ipcParserFixture(t);
    await f.write('\x1b[1E' + suffix);
    assert.equal(f.owner._inkObserver.state().positionKnown, false);
    assert.equal(f.owner._inkObserver.state().recoveries, 0);
  });
}

test('partial escape recovery waits for completion and preserves non-default SGR until reset', async t => {
  const f = ipcParserFixture(t);
  await f.write('\x1b[1E\x1b[');
  assert.equal(f.owner._inkObserver.state().checkpointReason, 'open-lexical-unit');
  await f.write('1m');
  assert.equal(f.owner._inkObserver.state().positionKnown, false);
  await f.write('\x1b[0m');
  assert.equal(f.owner._inkObserver.state().positionKnown, true);
});

test('parser checkpoint preserves pending autowrap and bottom-row scrolling', async t => {
  const f = ipcParserFixture(t), candidates = [];
  const original = f.adapter.softwareCaretPort.candidate;
  f.adapter.softwareCaretPort.candidate = c => { candidates.push(c); original(c); };
  await f.write('\x1b[24;1H' + 'x'.repeat(80) + '\x1b[s');
  assert.equal(f.source.buffer.active.cursorX, 80);
  assert.equal(f.owner._inkObserver.state().positionKnown, true);
  await f.write('\x1b[?2026hX\x1b[7m \x1b[27m\x1b[?2026l');
  assert.deepEqual([candidates[0].x, candidates[0].y], [1, 23]);
  const c = candidates[0], cell = f.source.buffer.active.getLine(f.source.buffer.active.baseY + c.y).getCell(c.x);
  assert.equal(cell.getChars(), c.char);
  assert.ok(cell.isInverse());
});

test('resize invalidates observer coordinates before the next relative chunk and recovers afterward', async t => {
  const f = ipcParserFixture(t);
  await f.write('\x1b[0m');
  f.source.resize(70, 20); f.terminal.cols = 70; f.terminal.rows = 20;
  const ink = f.context._inkFeed(f.owner, f.owner, null, '\r');
  assert.equal(f.owner._inkObserver.state().positionKnown, false);
  await new Promise(resolve => f.source.write('\r', () => { f.context._outputParsed(f.owner, ink)(); resolve(); }));
  assert.equal(f.owner._inkObserver.state().positionKnown, true);
});

function fixture({ reduced = true } = {}) {
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
  const gl = {
    canvas,
    SCISSOR_TEST: 0x0C11,
    enable() {},
    disable() {},
    scissor() {},
  };
  const rectangleDraws = [];
  const glyphDraws = [];
  const glyphCellCalls = [];
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
    _updateCell(attributes, x, y, code, bg, fg, ext, chars, lastBg) {
      glyphCellCalls.push({ code, bg, fg, ext, chars, lastBg });
      attributes[0] = code;
    },
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
    adapter, terminal, renderer, cellState, rectangleDraws, glyphDraws, glyphCellCalls, baseRenders,
    coreService, coreBrowserService,
    cand: (over) => ({ x: 4, y: 1, char: 'd', width: 1, style: 'truecolor', fg: '40;44;52', bg: '220;223;228', unitSeq: 1, chunkSeq: 1, ...over }),
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

test('perceivedCaretCell: null until the adapter owns the caret, then the published viewport cell', () => {
  const f = fixture();
  const p = f.adapter.softwareCaretPort;
  assert.equal(f.adapter.perceivedCaretCell(), null, 'no descriptor -> null (stock anchoring applies)');
  p.candidate(f.cand({ chunkSeq: 1, x: 4 }));
  p.parsed(1);
  assert.equal(f.adapter.perceivedCaretCell(), null, 'a single candidate has not engaged yet');
  p.candidate(f.cand({ chunkSeq: 2, x: 5, y: 2 }));
  p.parsed(2);
  assert.deepEqual(f.adapter.perceivedCaretCell(), { x: 5, y: 2, width: 1 },
    'the IME anchor must follow the caret the user sees');
  p.invalidate('scroll');
  assert.equal(f.adapter.perceivedCaretCell(), null, 'invalidation revokes the perceived cell');
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
  // The restore redraw follows the same pixel-identity rule as the block
  // caret: theme bg/fg words (background 0x1a1b26ff -> 0x031a1b26,
  // foreground 0xc0caf5ff -> 0x03c0caf5), the cell's style bits OR'ed in
  // (this truecolor cell has none), and lastBg === bg so the differential
  // left-clip stays off.
  const restore = f.glyphCellCalls.at(-1);
  assert.equal(restore.bg >>> 0, (0x03000000 | 0x1a1b26) >>> 0);
  assert.equal(restore.fg >>> 0, (0x03000000 | 0xc0caf5) >>> 0);
  assert.equal(restore.lastBg, restore.bg);
});

test('alternate buffer keeps the echo slide when the software caret owns the cursor (agent TUI in a multiplexer)', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  // herdr and kimi both enter ?1049h: their input boxes live on the
  // alternate buffer, so the buffer type alone must not gate typing echo.
  f.terminal.buffer.active.type = 'alternate';
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1, x: 4 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2, x: 5 })); p.parsed(2);
  render(f); // activation snap: settled at x=5
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);

  f.adapter.noteInput('d'); // typing at t=0
  p.candidate(f.cand({ chunkSeq: 3, x: 6 })); p.parsed(3);
  render(f);

  // The app-painted caret sliding over an agent input box is typing echo:
  // plain block, no inversion flash — even on the alternate buffer.
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1);
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');
});

test('multiplexer render latency beyond the echo window still classifies as typing echo', () => {
  // Measured keystroke→frame latency through herdr relaying kimi is
  // 194-375ms: outside any time window that would still spare navigation.
  // The software-caret path classifies by the pending-echo flag instead.
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1, x: 4 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2, x: 5 })); p.parsed(2);
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);

  f.adapter.noteInput('d'); // keystroke at t=0
  f.setTime(150); render(f); // an unrelated status-line repaint must not consume the flag
  f.setTime(320);            // the echo frame lands past the 200ms window
  p.candidate(f.cand({ chunkSeq: 3, x: 6 })); p.parsed(3);
  render(f);

  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1, 'late echo frame keeps the plain slide');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');

  // The flag paid for exactly one slide: a later caret move with no new
  // printable input (app-initiated redraw) keeps the inversion.
  f.setTime(500); render(f); // settle
  f.setTime(700);
  p.candidate(f.cand({ chunkSeq: 4, x: 7 })); p.parsed(4);
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1, 'stale flag must not reclassify later moves');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('fast burst: echo credits cover every tail frame after the window goes cold', () => {
  // Five keystrokes 100ms apart, echo frames 300ms behind (the measured
  // herdr band): the burst keeps the time window warm through the third
  // frame, but the frames for keys 4 and 5 land 200ms/300ms after the last
  // keystroke — the cold zone. A boolean flag pays for only ONE of them and
  // re-exposes the burst tail to the inversion flash; per-keystroke credits
  // cover both.
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1, x: 3 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2, x: 4 })); p.parsed(2);
  render(f);

  const keys = ['a', 'b', 'c', 'd', 'e'];
  keys.forEach((ch, i) => { f.setTime(i * 100); f.adapter.noteInput(ch); });
  let seq = 2;
  const frame = (t, x) => {
    f.setTime(t);
    p.candidate(f.cand({ chunkSeq: ++seq, x })); p.parsed(seq);
    render(f);
  };
  const settle = (t) => { f.setTime(t); render(f); };

  frame(300, 5);  // window warm (key 4 at t=300)
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1);
  settle(395);
  frame(400, 6);  // window warm (key 5 at t=400)
  settle(495);
  frame(500, 7);  // window warm (100ms since key 5)
  settle(595);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 3, 'warm window pays mid-burst, credits untouched');
  frame(600, 8);  // cold: 200ms since key 5 — first credit
  assert.equal(f.adapter.snapshot().counters.echoSlides, 4, 'first cold frame paid by a credit');
  settle(695);
  frame(700, 9);  // cold: 300ms since key 5 — second credit (a boolean flag runs out here)
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 5, 'the burst tail stays plain');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');
});

test('navigation input drops the pending echo classification', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ chunkSeq: 1, x: 4 })); p.parsed(1);
  p.candidate(f.cand({ chunkSeq: 2, x: 5 })); p.parsed(2);
  render(f);

  f.adapter.noteInput('d');        // typing at t=0...
  f.setTime(50);
  f.adapter.noteInput('\x1b[D');   // ...then an arrow key before the echo frame lands
  f.setTime(300);
  p.candidate(f.cand({ chunkSeq: 3, x: 4 })); p.parsed(3); // caret moves left (navigation)
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'an arrow key must not inherit the typed echo classification');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('protocol-cursor echo keeps the time window: the pending flag never leaks across sources', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.coreService.isCursorHidden = false; // visible protocol cursor on the normal buffer
  render(f); // initial snap at cursorX=1
  f.adapter.noteInput('d'); // keystroke at t=0 (sets the flag too)
  f.setTime(300);           // shell echo lands past the window
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'the software-only pending flag must not classify protocol slides');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');

  // Control: inside the window the protocol path still classifies echo.
  f.adapter.noteInput('e');
  f.terminal.buffer.active.cursorX = 3;
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1);
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');
});

test('multiplexer shell pane (alternate buffer, protocol cursor) classifies echo by write evidence', () => {
  // Multiplexer shell panes live on the alternate buffer; per herdr's docs,
  // host_cursor=auto presents the pane's shell caret as the native cursor on
  // non-Windows hosts. The measured relay latency (194-375ms) defeats the
  // 200ms window. Echo is mechanical there: the frame moving the cursor also
  // wrote the cell the cursor vacates.
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  f.coreService.isCursorHidden = false; // native protocol cursor visible
  render(f); // initial snap at cursorX=1
  const p = f.adapter.softwareCaretPort;
  f.adapter.noteInput('e');
  f.setTime(320); // the echo frame lands past the window (herdr relay band)
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [[0, 1]] }); // echo wrote the vacated cell
  p.parsed(1);
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1);
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');
});

test('alternate-buffer navigation never writes the vacated cell and keeps the inversion slide', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  f.coreService.isCursorHidden = false;
  render(f);
  const p = f.adapter.softwareCaretPort;
  f.adapter.noteInput('j'); // hjkl ARE printable — input-side evidence must not matter here
  f.setTime(320);
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [] }); // a pure cursor-move frame writes nothing
  p.parsed(1);
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'navigation without a written vacated cell must keep the inversion');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('real native-mode multiplexer echo frame classifies echo end-to-end (observer wrote cells through the real parser)', async t => {
  // Synthetic remote-herdr native grammar: on the alternate buffer the echo
  // frame writes the character at the caret cell inside a sync unit and the
  // visible protocol caret ends one cell further. The observer's per-unit
  // write evidence must reach the classification through the real IPC wiring.
  const f = ipcParserFixture(t, { cols: 80, rows: 24, reduced: false });
  Object.defineProperty(f.coreService, 'isCursorHidden', {
    get: () => f.source._core.coreService.isCursorHidden,
    set: value => { f.source._core.coreService.isCursorHidden = value; },
  });
  f.adapter.setCursorStyle('block');
  await f.write('\x1b[?1049h\x1b[?7l'); // herdr enters the alternate buffer
  await f.write('\x1b[1;1HPS> '); // prompt, caret ends at col 5 (0-based x=4)
  render(f); // settle snap
  f.adapter.noteInput('e'); // keystroke at t=0
  f.setTime(320); // the frame lands in the measured herdr relay band
  await f.write('\x1b[?2026h\x1b]8;;\x1b\\\x1b[1;5H\x1b[0;2;38;5;11;49me\x1b[0m\x1b[?2026l');
  assert.equal(f.source.buffer.active.cursorX, 5, 'the echoed print advances the real caret');
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1,
    'the frame wrote the vacated cell — the slide is typing echo');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle');
});

test('real native-mode multiplexer cursor move without writes keeps the inversion end-to-end', async t => {
  const f = ipcParserFixture(t, { cols: 80, rows: 24, reduced: false });
  Object.defineProperty(f.coreService, 'isCursorHidden', {
    get: () => f.source._core.coreService.isCursorHidden,
    set: value => { f.source._core.coreService.isCursorHidden = value; },
  });
  f.adapter.setCursorStyle('block');
  await f.write('\x1b[?1049h\x1b[?7l');
  await f.write('\x1b[1;1HPS> ');
  render(f);
  f.setTime(320);
  await f.write('\x1b[?2026h\x1b[1;6H\x1b[?2026l'); // pure CUP: navigation, no writes
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'a write-less move on the alternate buffer keeps the inversion');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('write evidence binds to the vacated cell, not to any recent write', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  f.coreService.isCursorHidden = false;
  render(f);
  const p = f.adapter.softwareCaretPort;
  f.setTime(320);
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [[2, 9]] }); // a status-line repaint far away
  p.parsed(1);
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'writes elsewhere on the screen must not classify the slide as echo');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('write evidence expires: an idle-batch leftover never classifies a later slide', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  f.coreService.isCursorHidden = false;
  render(f);
  const p = f.adapter.softwareCaretPort;
  f.setTime(320);
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [[0, 1]] });
  p.parsed(1);
  // No retarget follows the write; the cursor moves only 2s later (app-initiated).
  f.setTime(1900);
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'evidence older than the freshness bound must not classify');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('navigation input clears pending write evidence', () => {
  // Type, then walk back with arrows: the second Left vacates a cell the
  // echo wrote moments ago (still inside the batch TTL). noteInput must void
  // the write evidence along with the credits, or that hop is misclassified
  // as typing echo.
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.terminal.buffer.active.type = 'alternate';
  f.coreService.isCursorHidden = false;
  render(f); // initial snap at cursorX=1
  const p = f.adapter.softwareCaretPort;
  f.adapter.noteInput('a');
  f.setTime(320);
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [[0, 1]] });
  p.parsed(1);
  f.terminal.buffer.active.cursorX = 2;
  render(f); // echo slide 1
  assert.equal(f.adapter.snapshot().counters.echoSlides, 1);
  f.setTime(500);
  render(f); // settle: the echo latch clears
  f.adapter.noteInput('b');
  f.setTime(560);
  p.unit({ hadCandidate: false, chunkSeq: 2, wrote: [[0, 2]] });
  p.parsed(2);
  f.terminal.buffer.active.cursorX = 3;
  render(f); // echo slide 2
  assert.equal(f.adapter.snapshot().counters.echoSlides, 2);
  f.setTime(760);
  render(f); // settle: the latch clears before navigation
  f.adapter.noteInput('\x1b[D'); // Left: pure CUP, no writes — voids evidence
  f.setTime(790);
  p.unit({ hadCandidate: false, chunkSeq: 3, wrote: [] });
  p.parsed(3);
  f.terminal.buffer.active.cursorX = 2;
  render(f); // navigation hop 1: vacated cell 3 was never written
  assert.equal(f.adapter.snapshot().counters.echoSlides, 2);
  f.setTime(970);
  render(f); // settle
  f.adapter.noteInput('\x1b[D');
  f.setTime(1000);
  p.unit({ hadCandidate: false, chunkSeq: 4, wrote: [] });
  p.parsed(4);
  f.terminal.buffer.active.cursorX = 1;
  render(f); // navigation hop 2: vacated cell 2 WAS written by echo 2
  assert.equal(f.adapter.motion.animating, true);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 2,
    'stale echo writes must not classify a navigation hop as typing echo');
  assert.equal(f.adapter.snapshot().drawPassStatus, 'base+rectangle+glyph');
});

test('write evidence stays scoped to the alternate buffer and its buffer of origin', () => {
  const f = fixture({ reduced: false });
  f.adapter.setCursorStyle('block');
  f.coreService.isCursorHidden = false;
  render(f); // normal buffer, snap at cursorX=1
  const p = f.adapter.softwareCaretPort;
  f.setTime(320);
  p.unit({ hadCandidate: false, chunkSeq: 1, wrote: [[0, 1]] });
  p.parsed(1);
  f.terminal.buffer.active.cursorX = 2;
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'the normal-buffer protocol path keeps the time window only');
  // A batch observed on the normal buffer must not classify after a switch.
  f.setTime(1900);
  f.terminal.buffer.active.type = 'alternate';
  f.terminal.buffer.active.cursorX = 3;
  render(f);
  assert.equal(f.adapter.snapshot().counters.echoSlides, 0,
    'a stale batch from the other buffer must not classify');
});

function parserFixture(t, { cols = 10, rows = 3, TerminalClass = Terminal, reduced = true } = {}) {
  const f = fixture({ reduced });
  const source = new TerminalClass({ cols, rows });
  f.terminal.cols = cols;
  f.terminal.rows = rows;
  f.terminal.buffer = source.buffer;
  f.terminal._core.buffer = source._core.buffer;
  f.renderer._workCell = source._core._inputHandler._workCell;
  t.after(() => { f.adapter.dispose(); source.dispose(); });
  return { ...f, source, parse: raw => source._core._inputHandler.parse(raw) };
}

function publishPair(f, over = {}) {
  const p = f.adapter.softwareCaretPort;
  p.candidate(f.cand({ ...over, chunkSeq: 1 })); p.parsed(1);
  p.candidate(f.cand({ ...over, chunkSeq: 2 })); p.parsed(2);
}

test('real reverse cell removal changes fg, not bg, and revokes the drawn descriptor', t => {
  const f = parserFixture(t);
  f.parse('\x1b[2;5H\x1b[7md\x1b[27m');
  const before = f.source.buffer.active.getLine(1).getCell(4);
  const beforeBg = before.bg;
  assert.ok(before.isInverse());
  publishPair(f, { style: 'reverse', fg: null, bg: null });
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
  f.parse('\x1b[2;5Hd');
  assert.equal(f.source.buffer.active.getLine(1).getCell(4).bg, beforeBg);
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, false);
});

for (const [name, sgr, style] of [
  ['plain same-character cell', '0', 'reverse'],
  ['palette-colored reverse cell', '38;5;145;7', 'reverse'],
  ['wrong truecolor foreground', '38;2;1;2;3;48;2;220;223;228', 'truecolor'],
  ['wrong truecolor background', '38;2;40;44;52;48;2;1;2;3', 'truecolor'],
]) {
  test(`publication rejects ${name} before the first takeover draw`, t => {
    const f = parserFixture(t);
    f.parse(`\x1b[2;5H\x1b[${sgr}md\x1b[0m`);
    publishPair(f, { style });
    assert.notEqual(f.adapter.instrumentation.softwareCaret?.active, true);
    render(f);
    assert.equal(f.adapter.instrumentation.cursorDrawPasses, 0);
  });
}

test('a real matching truecolor candidate remains eligible', t => {
  const f = parserFixture(t);
  f.parse('\x1b[2;5H\x1b[38;2;40;44;52;48;2;220;223;228md\x1b[0m');
  publishPair(f);
  render(f);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
});

test('queued parsing suppresses stale ownership then resumes the same smooth motion', t => {
  const f = fixture({ reduced: false });
  t.after(() => f.adapter.dispose());
  publishPair(f);
  render(f);
  const p = f.adapter.softwareCaretPort;
  const draws = f.adapter.instrumentation.cursorDrawPasses;
  p.candidate(f.cand({ x: 6, chunkSeq: 3 }));
  p.enqueued?.(3);
  render(f);
  assert.equal(f.adapter.instrumentation.cursorDrawPasses, draws, 'no old descriptor while newer parsing is outstanding');
  p.parsed(3);
  f.setTime(5);
  render(f);
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor.x, 6);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
  assert.equal(f.adapter.motion.animating, true, 'matching completion preserves animation rather than forcing a snap');
  p.enqueued(4);
  render(f);
  p.parsed(4); // An unrelated/empty write must release the parse barrier too.
  f.setTime(15);
  render(f);
  assert.equal(f.adapter.instrumentation.lastSoftwareCursor.x, 6);
  assert.equal(f.adapter.instrumentation.softwareCaret.active, true);
});

for (const [name, rows] of [
  ['dshtui-herdr-rev-caret.txt', 24],
  ['claude-rig-bare-rev.txt', 24],
  ['kimi-local-conpty.txt', 28],
]) {
  test(`captured ${name} keeps validated takeover through the real parser`, t => {
    const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const f = parserFixture(t, { cols: 80, rows });
    const p = f.adapter.softwareCaretPort;
    // Split at observed gesture completions, not at guessed network frames.
    const ends = [];
    let offset = 0;
    const boundaries = createInkCaretObserver({ rows, cols: 80, onCandidate: () => ends.push(offset) });
    for (const ch of raw) { offset += ch.length; boundaries.push(ch); }
    const observer = createInkCaretObserver({ rows, cols: 80, onCandidate: c => p.candidate(c), onUnit: u => p.unit(u) });
    let start = 0;
    let takeovers = 0;
    for (const end of ends) {
      const chunk = raw.slice(start, end);
      const { chunkSeq } = observer.push(chunk);
      p.enqueued(chunkSeq);
      f.parse(chunk);
      p.parsed(chunkSeq);
      const line = f.source.buffer.active.getLine(f.source.buffer.active.viewportY);
      const textBefore = line.translateToString();
      render(f);
      assert.equal(line.translateToString(), textBefore, 'drawing must never rewrite terminal content');
      if (f.adapter.instrumentation.softwareCaret?.active) takeovers += 1;
      start = end;
    }
    assert.ok(takeovers >= ends.length - 3, `recognized ${ends.length} gestures, validated ${takeovers}`);
    assert.ok(takeovers >= 4, 'supported fixture must retain actual takeover, not only recognition');
  });
}
