// ADR-0001 B2 adapter state-machine tests (§4.5 reverse tests + the
// reviewer findings): trust/watermark/generation gating, neutral vs
// contradictory units, cell style evidence, DECTCEM independence, and the
// B1 regression (the restore overlay must draw the covering GLYPH, not just
// a background rect — with the default bar style nothing else repaints it).
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

const ipcSource = readFileSync(new URL('../src/renderer/ipc.js', import.meta.url), 'utf8');

function ipcParserFixture(t, geometry = { cols: 80, rows: 24 }) {
  const f = parserFixture(t, { ...geometry, TerminalClass: BundledTerminal });
  Object.defineProperty(f.terminal._core, 'buffer', { get: () => f.source._core.buffer });
  const scroll = f.source.onScroll(() => f.adapter.softwareCaretPort.invalidate('scroll'));
  t.after(() => scroll.dispose());
  const owner = { id: 'lifecycle', tabId: 'offline', type: 'ssh', term: f.source, _smoothCursor: { _adapter: f.adapter } };
  const context = { ipcRenderer: { on() {} }, TabManager: { tabs: [owner] }, window: {}, createInkCaretObserver };
  vm.createContext(context); vm.runInContext(ipcSource, context);
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
