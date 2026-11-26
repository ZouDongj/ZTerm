// Post-parse, input-correlated software-caret recognizer (ADR-0007).
//
// Operates AFTER xterm.js parses each PTY chunk instead of matching brittle
// pre-parse VT choreography (e.g. CR+CSI-C+CSI-A vs ConPTY's HOME+CR+CSI-C+CSI-B).
// Any transport or multiplexer rewrite (ConPTY, herdr, tmux, SSH) that hides
// the protocol cursor (?25l) and paints a single-glyph caret cell converges to
// the same post-parse buffer grid, so verifying causal agreement between recent
// user input and the parsed row delta is invariant to wire-level rewriting.
//
// Fail-closed guarantees (ADR-0002 / ADR-0007):
//   - Never runs row scans while the protocol cursor is visible, unfocused,
//     scrolled away from bottom, or when no fresh user input intent is pending.
//   - Never claims ownership on non-input output (spinners, clocks, counters).
//   - Rejects any row containing a multi-glyph styled run (including mixed-
//     attribute reverse/truecolor highlight bars) or multiple isolated carets.
//   - Compares column-indexed cell snapshots (never UTF-16 string slices) so
//     astral emoji and combining marks never misalign column coordinates.
//   - Navigation and forward delete require an actively trusted anchor, a
//     captured pre-parse baseline, disappearance of the old caret cell, and
//     appearance of the new caret cell (blocking static adjacent-row badges).
//   - Pure logic: zero DOM/WebGL references; consumes only bounded buffer reads.
(function installPostParseCaret(root) {
  'use strict';

  const RGB_COLOR_MODE = 0x03000000;
  const INVERSE_ATTR_FLAG = 0x04000000;
  const PASTE_BEGIN = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  const MAX_INTENTS = 16;
  const INTENT_TTL_MS = 1200;
  const MAX_PASTE_TEXT_LEN = 32;
  const MAX_DIRTY_ROWS = 6;
  const MAX_CHUNK_CELL_WRITES = 4096;

  const nodeUnicodeWidth = typeof module !== 'undefined' && module.exports
    ? require('./unicode-width.js')
    : null;

  function getUnicodeWidth() {
    return root.__unicodeWidth || nodeUnicodeWidth || null;
  }

  // Delegate directly to the shared zterm6 provider when loaded so BMP-widened
  // symbols (e.g. U+2705), U+303F (width 1), and combining marks (width 0)
  // match xterm.js cell widths identically. Hardcoded ranges apply only when
  // the provider is absent.
  function charWidth(ch) {
    const cp = ch.codePointAt(0);
    const provider = getUnicodeWidth();
    if (provider && typeof provider.wcwidth === 'function') {
      const w = provider.wcwidth(cp);
      if (w === 0 || w === 1 || w === 2) return w;
    }
    if (cp >= 0x1100 && (
      cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x1fa70 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )) return 2;
    return 1;
  }

  function isPrintableChar(ch) {
    const cp = ch.codePointAt(0);
    return cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f);
  }

  // Classify one outgoing PTY input chunk into ordered semantic intents without
  // mutating the bytes. Unknown escape sequences, Enter/newline, Tab, bare Esc,
  // Ctrl+C/D, combining marks, and multi-line/oversized pastes emit a 'barrier'
  // (and any mid-string ESC poisons the remainder of the chunk).
  function classifyInputData(data) {
    if (typeof data !== 'string' || data.length === 0) return [];
    if (data.startsWith(PASTE_BEGIN)) {
      const end = data.indexOf(PASTE_END, PASTE_BEGIN.length);
      if (end < 0 || end + PASTE_END.length !== data.length) return [{ kind: 'barrier' }];
      const body = data.slice(PASTE_BEGIN.length, end);
      const chars = Array.from(body);
      if (chars.length === 0 || chars.length > MAX_PASTE_TEXT_LEN) return [{ kind: 'barrier' }];
      const out = [];
      for (const ch of chars) {
        if (!isPrintableChar(ch)) return [{ kind: 'barrier' }];
        const w = charWidth(ch);
        if (w <= 0) return [{ kind: 'barrier' }];
        out.push({ kind: 'printable', char: ch, width: w });
      }
      return out;
    }

    // Exact single-key escape sequences (standard VT + application cursor mode).
    if (data.charCodeAt(0) === 0x1b) {
      if (data === '\x1b[D' || data === '\x1bOD') return [{ kind: 'nav', dir: 'left' }];
      if (data === '\x1b[C' || data === '\x1bOC') return [{ kind: 'nav', dir: 'right' }];
      if (data === '\x1b[A' || data === '\x1bOA') return [{ kind: 'nav', dir: 'up' }];
      if (data === '\x1b[B' || data === '\x1bOB') return [{ kind: 'nav', dir: 'down' }];
      if (data === '\x1b[H' || data === '\x1bOH' || data === '\x1b[1~' || data === '\x1b[7~') {
        return [{ kind: 'nav', dir: 'home' }];
      }
      if (data === '\x1b[F' || data === '\x1bOF' || data === '\x1b[4~' || data === '\x1b[8~') {
        return [{ kind: 'nav', dir: 'end' }];
      }
      if (data === '\x1b[3~') return [{ kind: 'delete' }];
      return [{ kind: 'barrier' }];
    }

    const intents = [];
    for (const ch of data) {
      const code = ch.codePointAt(0);
      if (code === 0x1b) {
        // Poison the rest of the chunk so CSI/OSC parameter bytes never turn
        // into synthetic printable intents.
        intents.push({ kind: 'barrier' });
        return intents;
      }
      if (code === 0x7f || code === 0x08) {
        intents.push({ kind: 'backspace' });
      } else if (code === 0x01) {
        intents.push({ kind: 'nav', dir: 'home' });
      } else if (code === 0x05) {
        intents.push({ kind: 'nav', dir: 'end' });
      } else if (code === 0x02) {
        intents.push({ kind: 'nav', dir: 'left' });
      } else if (code === 0x06) {
        intents.push({ kind: 'nav', dir: 'right' });
      } else if (isPrintableChar(ch)) {
        const w = charWidth(ch);
        if (w <= 0) intents.push({ kind: 'barrier' });
        else intents.push({ kind: 'printable', char: ch, width: w });
      } else {
        intents.push({ kind: 'barrier' });
      }
    }
    return intents;
  }

  function formatRgb(colorWord) {
    const r = (colorWord >>> 16) & 0xff;
    const g = (colorWord >>> 8) & 0xff;
    const b = colorWord & 0xff;
    return `${r};${g};${b}`;
  }

  function classifyCellCaretStyle(fg, bg) {
    // Pure reverse video with default fg/bg (covers ESC[7m, ESC[0;7m,
    // ESC[0;7;39;49m uniformly after xterm parses SGR).
    if (fg === INVERSE_ATTR_FLAG && bg === 0) {
      return { style: 'reverse', fg: null, bg: null, bgWord: 0, key: 'rev' };
    }
    // Explicit RGB foreground AND background (with no extra non-color flags on
    // fg/bg, matching softwareCellMatches's exact equality contract).
    const fgMode = fg & 0x03000000;
    const bgMode = bg & 0x03000000;
    if (fgMode === RGB_COLOR_MODE && bgMode === RGB_COLOR_MODE
      && (fg & ~0x03ffffff) === 0 && (bg & ~0x03ffffff) === 0
      && (fg & 0x00ffffff) !== (bg & 0x00ffffff)) {
      const fgStr = formatRgb(fg);
      const bgStr = formatRgb(bg);
      return { style: 'truecolor', fg: fgStr, bg: bgStr, bgWord: bg & 0x03ffffff, key: `rgb:${fgStr}/${bgStr}` };
    }
    return null;
  }

  function cellExtendsHighlight(cell, styled) {
    if (!cell) return false;
    if (styled.style === 'reverse') {
      return (cell.fg & INVERSE_ATTR_FLAG) !== 0;
    }
    return (cell.bg & 0x03000000) === RGB_COLOR_MODE
      && (cell.bg & 0x03ffffff) === styled.bgWord;
  }

  function readLeftLogicalCell(reader, row, x) {
    let lx = x - 1;
    while (lx >= 0) {
      const cell = reader.readCell(row, lx);
      if (!cell) return null;
      if (cell.width !== 0) return cell;
      lx -= 1;
    }
    return null;
  }

  // Scan one viewport row for a UNIQUE single-glyph styled caret cell.
  // Any multi-glyph styled run (including mixed-attribute reverse or shared-RGB-bg
  // highlight bars) or multiple isolated caret cells on the same row fails closed.
  function scanRowForCaret(reader, row) {
    const cols = reader.cols;
    if (!Number.isInteger(row) || row < 0 || row >= reader.rows || !Number.isInteger(cols) || cols <= 0) {
      return { valid: false, reason: 'out-of-range', caret: null };
    }
    let candidate = null;
    let x = 0;
    while (x < cols) {
      const cell = reader.readCell(row, x);
      if (!cell) return { valid: false, reason: 'unreadable', caret: null };
      const w = cell.width;
      if (w === 0) { x += 1; continue; }
      const step = Math.max(1, w);
      const styled = classifyCellCaretStyle(cell.fg, cell.bg);
      if (!styled) { x += step; continue; }

      // Preserve cell.chars verbatim ('' for erased cells, ' ' for explicit
      // spaces) so softwareCellMatches checks the exact parsed buffer char.
      const runStart = x;
      const runChar = cell.chars;
      const runWidth = step;
      let runGlyphs = 1;
      let nextX = x + step;
      while (nextX < cols) {
        const nextCell = reader.readCell(row, nextX);
        if (!nextCell) return { valid: false, reason: 'unreadable', caret: null };
        if (nextCell.width === 0) { nextX += 1; continue; }
        if (!cellExtendsHighlight(nextCell, styled)) break;
        runGlyphs += 1;
        nextX += Math.max(1, nextCell.width);
      }
      if (runGlyphs > 1) {
        return { valid: false, reason: 'multi-cell-run', caret: null };
      }
      // Also check the immediate left logical neighbor so a mixed-attribute
      // highlight bar ending in a 1-cell plain reverse/RGB cell is rejected.
      const leftNeighbor = readLeftLogicalCell(reader, row, runStart);
      if (leftNeighbor && cellExtendsHighlight(leftNeighbor, styled)) {
        return { valid: false, reason: 'multi-cell-run', caret: null };
      }
      if (candidate) {
        return { valid: false, reason: 'multiple-carets', caret: null };
      }
      candidate = {
        x: runStart,
        y: row,
        char: runChar,
        width: runWidth,
        style: styled.style,
        fg: styled.fg,
        bg: styled.bg,
        restoreSgr: styled.style === 'reverse' ? '0' : '0;39;49',
      };
      x = nextX;
    }
    if (!candidate) return { valid: false, reason: 'none', caret: null };
    return { valid: true, reason: null, caret: candidate };
  }

  function rowCellsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function spanCellsDiffer(preCells, postCells, startX, width) {
    if (!preCells || !postCells) return false;
    const end = Math.min(preCells.length, postCells.length, startX + width);
    for (let x = startX; x < end; x += 1) {
      if (preCells[x] !== postCells[x]) return true;
    }
    return false;
  }

  function isCellStillCaret(reader, x, y, style) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= reader.cols || y < 0 || y >= reader.rows) {
      return false;
    }
    const cell = reader.readCell(y, x);
    if (!cell) return false;
    const styled = classifyCellCaretStyle(cell.fg, cell.bg);
    return !!styled && styled.style === style;
  }

  function hasPlainLeftNeighbor(reader, row, x) {
    const left = readLeftLogicalCell(reader, row, x);
    if (!left || !left.chars) return true;
    return left.fg === 0 && left.bg === 0;
  }

  function createPostParseCaretRecognizer(options) {
    const clock = typeof options?.now === 'function' ? options.now : () => Date.now();
    const intentTtlMs = Number.isFinite(options?.intentTtlMs) && options.intentTtlMs > 0
      ? options.intentTtlMs : INTENT_TTL_MS;

    let intents = []; // [{ kind, char?, width?, dir?, at }]
    // Current known caret anchor (warmed or actively trusted), bound to bufferType & generation.
    let anchor = null; // { x, y, style, bufferType, generation, trusted }
    // When a transport splits a single echo frame between overwriting the old
    // caret cell and writing the new SGR 7 cell, a mid-split render revokes
    // sw.active ('cell-overwritten'). Keep the just-revoked active anchor for
    // the lifetime of the pending input intent so the completing half resumes
    // smoothly without losing trust or snapping on every split frame.
    let splitRevoked = null; // { x, y, style, bufferType, generation, at }
    // Intent-scoped baseline snapshots captured on the first chunk after an
    // intent arrives and kept until an intent matches, expires, or hits a
    // barrier/invalidation.
    let baseline = null; // { bufferType, generation, rows: Map<y, { cells, scan }> }
    // Per-parse-cycle dirty-row tracking. Cleared after every onParsed.
    let cycle = null; // { bufferType, generation, preCursorY, dirtyRows: Set, disqualified }

    function pruneIntents(now) {
      while (intents.length > 0 && now - intents[0].at > intentTtlMs) intents.shift();
      if (intents.length > MAX_INTENTS) intents.splice(0, intents.length - MAX_INTENTS);
      if (intents.length === 0) {
        baseline = null;
        splitRevoked = null;
        cycle = null;
      }
      if (splitRevoked && now - splitRevoked.at > intentTtlMs) splitRevoked = null;
    }

    function hasFreshIntents(now) {
      pruneIntents(now);
      return intents.length > 0;
    }

    function hasPendingIntents() {
      return hasFreshIntents(clock());
    }

    function intentsMayCrossRows(refAnchor, cols) {
      for (let i = 0; i < intents.length; i += 1) {
        const k = intents[i].kind;
        if (k === 'nav' || k === 'backspace') return true;
      }
      return !!refAnchor && Number.isInteger(cols) && refAnchor.x >= cols - 2;
    }

    function clearCycle() {
      cycle = null;
      baseline = null;
      splitRevoked = null;
    }

    function onPreParseHit() {
      cycle = null;
      baseline = null;
      splitRevoked = null;
      intents = [];
    }

    function onCursorVisible() {
      anchor = null;
      splitRevoked = null;
      baseline = null;
      cycle = null;
    }

    // Rebase coordinate generation without dropping pending intents or active
    // post-parse anchor when only the pre-parse observer lost its coordinate
    // model (e.g. CSI X / CSI r / ESC 7/8 in ConPTY or tmux).
    function rebaseGeneration(nextGeneration) {
      if (!Number.isInteger(nextGeneration)) return;
      if (anchor) anchor.generation = nextGeneration;
      if (splitRevoked) splitRevoked.generation = nextGeneration;
      if (baseline) baseline.generation = nextGeneration;
      if (cycle) cycle.generation = nextGeneration;
    }

    function reset(reason) {
      intents = [];
      anchor = null;
      splitRevoked = null;
      baseline = null;
      cycle = null;
      return reason;
    }

    function noteInput(data) {
      const now = clock();
      pruneIntents(now);
      const parsed = classifyInputData(data);
      let sawBarrier = false;
      for (const item of parsed) {
        if (item.kind === 'barrier') {
          sawBarrier = true;
          intents = [];
          splitRevoked = null;
          baseline = null;
          cycle = null;
          // Drop untrusted warmup anchors across barriers so Enter/Esc/Tab
          // followed by an arrow key can never activate takeover.
          if (anchor && !anchor.trusted) anchor = null;
        } else {
          intents.push({ ...item, at: now });
        }
      }
      pruneIntents(now);
      return { barrier: sawBarrier };
    }

    function syncExternalAnchor(desc, bufferType, generation, trusted) {
      if (!desc) {
        anchor = null;
        splitRevoked = null;
        return;
      }
      splitRevoked = null;
      anchor = {
        x: desc.x,
        y: desc.y,
        style: desc.style,
        bufferType,
        generation,
        trusted: trusted === true,
      };
    }

    function noteRevoke(reason, activeDesc, bufferType, generation) {
      const now = clock();
      if (reason === 'cell-overwritten' && activeDesc && hasFreshIntents(now)) {
        splitRevoked = {
          x: activeDesc.x,
          y: activeDesc.y,
          style: activeDesc.style,
          bufferType: bufferType || anchor?.bufferType || null,
          generation: Number.isInteger(generation) ? generation : (anchor?.generation ?? -1),
          trusted: true,
          at: now,
        };
        anchor = null;
        return;
      }
      anchor = null;
      splitRevoked = null;
    }

    function ensureRowSnapshot(reader, row) {
      if (!cycle || cycle.disqualified || !baseline) return;
      if (!Number.isInteger(row) || row < 0 || row >= reader.rows) return;
      if (baseline.rows.has(row)) return;
      if (baseline.rows.size >= MAX_DIRTY_ROWS + 4) return;
      baseline.rows.set(row, {
        cells: reader.readRowCells(row),
        scan: scanRowForCaret(reader, row),
      });
    }

    // Runs synchronously BEFORE xterm parses each incoming chunk.
    // O(1) immediate return whenever the cursor is visible or no user input is pending.
    function beforeChunkWrite(info, reader) {
      if (!reader || !reader.isCursorHidden() || !reader.isFocused() || !reader.isAtBottom()) {
        return;
      }
      const now = clock();
      if (!hasFreshIntents(now)) return;

      const bufferType = reader.bufferType;
      const generation = reader.generation;
      if (anchor && (anchor.bufferType !== bufferType || anchor.generation !== generation)) {
        anchor = null;
      }
      if (splitRevoked && (splitRevoked.bufferType !== bufferType || splitRevoked.generation !== generation)) {
        splitRevoked = null;
      }
      if (!baseline || baseline.bufferType !== bufferType || baseline.generation !== generation) {
        baseline = { bufferType, generation, rows: new Map() };
      }
      if (!cycle || cycle.bufferType !== bufferType || cycle.generation !== generation) {
        cycle = {
          bufferType,
          generation,
          preCursorY: reader.cursorY,
          dirtyRows: new Set(),
          disqualified: false,
        };
      }
      if (cycle.disqualified) return;
      if (info && (info.buffer || info.scroll)) {
        reset(info.buffer ? 'buffer-switch' : 'scroll');
        cycle = {
          bufferType,
          generation,
          preCursorY: reader.cursorY,
          dirtyRows: new Set(),
          disqualified: true,
        };
        return;
      }
      const touched = new Set();
      if (info && Array.isArray(info.cells)) {
        if (info.cells.length >= MAX_CHUNK_CELL_WRITES) {
          cycle.disqualified = true;
          baseline = null;
          return;
        }
        for (const c of info.cells) {
          if (Array.isArray(c) && Number.isInteger(c[0])) {
            touched.add(c[0]);
            if (touched.size > MAX_DIRTY_ROWS) {
              cycle.disqualified = true;
              baseline = null;
              return;
            }
          }
        }
      }
      if (info && Array.isArray(info.rows)) {
        for (const r of info.rows) {
          if (Number.isInteger(r)) {
            touched.add(r);
            if (touched.size > MAX_DIRTY_ROWS) {
              cycle.disqualified = true;
              baseline = null;
              return;
            }
          }
        }
      }
      for (const r of touched) {
        cycle.dirtyRows.add(r);
        if (cycle.dirtyRows.size > MAX_DIRTY_ROWS) {
          cycle.disqualified = true;
          baseline = null;
          return;
        }
        ensureRowSnapshot(reader, r);
      }
      // Snapshot the pre-parse hidden cursor row and current/split anchor row
      // so recovery works even if the pre-parse observer lost positionKnown.
      ensureRowSnapshot(reader, reader.cursorY);
      const refAnchor = anchor || splitRevoked;
      if (refAnchor) {
        ensureRowSnapshot(reader, refAnchor.y);
        if (intentsMayCrossRows(refAnchor, reader.cols)) {
          ensureRowSnapshot(reader, refAnchor.y - 1);
          ensureRowSnapshot(reader, refAnchor.y + 1);
        }
      }
    }

    // Verify that the cells immediately before `caret` equal `chars` (a
    // contiguous printable intent slice), supporting same-row and end-of-row wrap.
    function matchTypedRunBeforeCaret(reader, caret, chars, requireDefaultPlain) {
      let totalWidth = 0;
      for (const item of chars) totalWidth += item.width;
      if (totalWidth <= 0) return null;

      // Same-row match: [caret.x - totalWidth, caret.x) on caret.y.
      if (caret.x >= totalWidth) {
        let x = caret.x - totalWidth;
        const startX = x;
        for (const item of chars) {
          const cell = reader.readCell(caret.y, x);
          if (!cell || cell.chars !== item.char || Math.max(1, cell.width) !== item.width) return null;
          if (requireDefaultPlain && (cell.fg !== 0 || cell.bg !== 0)) return null;
          x += item.width;
        }
        if (x !== caret.x) return null;
        return { wrapped: false, row: caret.y, startX, width: totalWidth };
      }

      // End-of-row wrap match: single printable filled the end of caret.y - 1
      // and the caret wrapped to column 0 of caret.y.
      if (caret.x === 0 && caret.y > 0 && chars.length === 1) {
        const item = chars[0];
        const prevRow = caret.y - 1;
        const startX = reader.cols - item.width;
        if (startX < 0) return null;
        const cell = reader.readCell(prevRow, startX);
        if (!cell || cell.chars !== item.char || Math.max(1, cell.width) !== item.width) return null;
        if (requireDefaultPlain && (cell.fg !== 0 || cell.bg !== 0)) return null;
        return { wrapped: true, row: prevRow, startX, width: item.width };
      }
      return null;
    }

    function verifyColdStartPrintable(reader, caret, matched, preCells, postCells, preCaret) {
      const sourceCellsPre = matched.wrapped ? (baseline?.rows.get(matched.row)?.cells ?? null) : preCells;
      const sourceCellsPost = matched.wrapped ? reader.readRowCells(matched.row) : postCells;
      const sourceChanged = sourceCellsPre !== null && sourceCellsPost !== null
        && !rowCellsEqual(sourceCellsPre, sourceCellsPost);
      if (!sourceChanged) return false;
      const caretMoved = !preCaret || preCaret.x !== caret.x || preCaret.y !== caret.y;
      if (!caretMoved) return false;
      const spanDiffers = spanCellsDiffer(sourceCellsPre, sourceCellsPost, matched.startX, matched.width);
      if (spanDiffers) return true;
      return !matched.wrapped && preCaret !== null && caret.x === preCaret.x + matched.width
        && !isCellStillCaret(reader, preCaret.x, preCaret.y, preCaret.style);
    }

    function matchRowAgainstIntents(reader, row, caret, preSnap, prevAnchor) {
      const postCells = reader.readRowCells(row);
      if (!postCells) return null;
      const preCells = preSnap ? preSnap.cells : null;
      const preCaret = preSnap?.scan?.valid ? preSnap.scan.caret : null;
      const rowChanged = preCells !== null && !rowCellsEqual(preCells, postCells);
      const requireDefaultPlain = caret.style === 'truecolor';
      const oldAnchorGone = prevAnchor
        ? !isCellStillCaret(reader, prevAnchor.x, prevAnchor.y, prevAnchor.style)
        : false;
      let prevRowChangedCache = null;
      function isPrevRowChanged() {
        if (prevRowChangedCache !== null) return prevRowChangedCache;
        if (!prevAnchor) { prevRowChangedCache = false; return false; }
        if (row === prevAnchor.y) { prevRowChangedCache = rowChanged; return rowChanged; }
        const pPre = baseline?.rows.get(prevAnchor.y)?.cells ?? null;
        const pPost = reader.readRowCells(prevAnchor.y);
        prevRowChangedCache = pPre !== null && pPost !== null && !rowCellsEqual(pPre, pPost);
        return prevRowChangedCache;
      }

      // 1. Printable run match (single keystrokes and coalesced multi-char bursts).
      for (let start = 0; start < intents.length; start += 1) {
        if (intents[start].kind !== 'printable') continue;
        let end = start;
        while (end < intents.length && intents[end].kind === 'printable') end += 1;
        for (let len = end - start; len >= 1; len -= 1) {
          const slice = intents.slice(start, start + len);
          const matched = matchTypedRunBeforeCaret(reader, caret, slice, requireDefaultPlain);
          if (!matched) continue;

          if (prevAnchor) {
            const styleMatch = caret.style === prevAnchor.style;
            if (styleMatch && !matched.wrapped && caret.y === prevAnchor.y
              && caret.x === prevAnchor.x + matched.width) {
              const causalDelta = rowChanged
                || (preCaret !== null && preCaret.x === prevAnchor.x && oldAnchorGone);
              if (causalDelta) return { consumeThrough: start + len, kind: 'printable', caret, resetTrust: false };
            } else if (styleMatch && matched.wrapped && caret.y === prevAnchor.y + 1
              && caret.x === 0 && prevAnchor.x === matched.startX && oldAnchorGone) {
              if (isPrevRowChanged() || rowChanged) {
                return { consumeThrough: start + len, kind: 'printable', caret, resetTrust: false };
              }
            } else if (styleMatch && !matched.wrapped && caret.y === prevAnchor.y + 1
              && matched.startX === 0 && prevAnchor.x >= reader.cols - matched.width && oldAnchorGone) {
              // Wide-glyph pre-write wrap from the final column onto col 0 of row + 1.
              if (rowChanged) {
                return { consumeThrough: start + len, kind: 'printable', caret, resetTrust: false };
              }
            } else if (oldAnchorGone
              && verifyColdStartPrintable(reader, caret, matched, preCells, postCells, preCaret)) {
              // Old anchor disappeared (e.g. prompt moved to a new line after
              // Enter or Ctrl+U): fall back to fresh cold-start warmup instead
              // of deadlocking on the stale coordinate.
              return { consumeThrough: start + len, kind: 'printable', caret, resetTrust: true };
            }
          } else if (verifyColdStartPrintable(reader, caret, matched, preCells, postCells, preCaret)) {
            return { consumeThrough: start + len, kind: 'printable', caret, resetTrust: false };
          }
        }
      }

      // 2. Backspace match: row mutated (or space deleted) AND caret moved left / unwrapped.
      for (let i = 0; i < intents.length; i += 1) {
        if (intents[i].kind !== 'backspace') continue;
        if (requireDefaultPlain && !hasPlainLeftNeighbor(reader, row, caret.x)) continue;
        if (prevAnchor && caret.style === prevAnchor.style) {
          const movedLeftSameRow = caret.y === prevAnchor.y && caret.x < prevAnchor.x;
          if (movedLeftSameRow) {
            const spaceDeleted = preCaret !== null && preCaret.x === prevAnchor.x && oldAnchorGone;
            if (rowChanged || spaceDeleted) {
              return { consumeThrough: i + 1, kind: 'backspace', caret, resetTrust: false };
            }
          }
          const unwrappedPrevRow = caret.y === prevAnchor.y - 1 && oldAnchorGone;
          if (unwrappedPrevRow) {
            const targetAppeared = !preCaret || preCaret.x !== caret.x || preCaret.y !== caret.y;
            const prevChanged = isPrevRowChanged();
            if (targetAppeared && (rowChanged || prevChanged) && (prevAnchor.x === 0 || prevChanged)) {
              return { consumeThrough: i + 1, kind: 'backspace', caret, resetTrust: false };
            }
          }
        } else if (!prevAnchor && rowChanged && preCaret && preCaret.y === caret.y && caret.x < preCaret.x
          && !isCellStillCaret(reader, preCaret.x, preCaret.y, preCaret.style)) {
          return { consumeThrough: i + 1, kind: 'backspace', caret, resetTrust: false };
        }
      }

      // 3. Forward delete match: requires an actively TRUSTED anchor on the same row.
      if (prevAnchor && prevAnchor.trusted === true && caret.style === prevAnchor.style
        && row === prevAnchor.y && rowChanged && caret.x === prevAnchor.x) {
        if (!requireDefaultPlain || hasPlainLeftNeighbor(reader, row, caret.x)) {
          for (let i = 0; i < intents.length; i += 1) {
            if (intents[i].kind === 'delete') {
              return { consumeThrough: i + 1, kind: 'delete', caret, resetTrust: false };
            }
          }
        }
      }

      // 4. Navigation match: strictly requires an actively TRUSTED anchor,
      //    a captured pre-parse baseline (fail closed if missing), unchanged
      //    row text, disappearance of the old caret, and a newly positioned caret.
      if (prevAnchor && prevAnchor.trusted === true && caret.style === prevAnchor.style
        && preCells !== null && !rowChanged && oldAnchorGone) {
        const targetAppeared = !preCaret || preCaret.x !== caret.x || preCaret.y !== caret.y;
        if (targetAppeared && (!requireDefaultPlain || hasPlainLeftNeighbor(reader, row, caret.x))) {
          for (let i = 0; i < intents.length; i += 1) {
            const it = intents[i];
            if (it.kind !== 'nav') continue;
            let ok = false;
            if (it.dir === 'left') {
              ok = (caret.y === prevAnchor.y && caret.x < prevAnchor.x)
                || caret.y === prevAnchor.y - 1;
            } else if (it.dir === 'right') {
              ok = (caret.y === prevAnchor.y && caret.x > prevAnchor.x)
                || caret.y === prevAnchor.y + 1;
            } else if (it.dir === 'home') {
              ok = (caret.y === prevAnchor.y && caret.x < prevAnchor.x)
                || caret.y < prevAnchor.y;
            } else if (it.dir === 'end') {
              ok = (caret.y === prevAnchor.y && caret.x > prevAnchor.x)
                || caret.y > prevAnchor.y;
            } else if (it.dir === 'up') {
              ok = caret.y === prevAnchor.y - 1;
            } else if (it.dir === 'down') {
              ok = caret.y === prevAnchor.y + 1;
            }
            if (ok) return { consumeThrough: i + 1, kind: 'nav', caret, resetTrust: false };
          }
        }
      }

      return null;
    }

    // Runs inside softwareCaretPort.parsed(seq) once xterm has parsed through
    // the latest enqueued chunk. Returns a software-caret candidate descriptor
    // or null (fail-closed).
    function onParsed({ seq, hadPreParseCandidate, reader }) {
      const currentCycle = cycle;
      cycle = null;

      if (!reader) return null;
      if (hadPreParseCandidate) {
        onPreParseHit();
        return null;
      }
      if (!reader.isCursorHidden() || !reader.isFocused() || !reader.isAtBottom()) {
        if (!reader.isCursorHidden()) onCursorVisible();
        return null;
      }

      const now = clock();
      if (!hasFreshIntents(now)) return null;
      if (currentCycle && currentCycle.disqualified) return null;

      const bufferType = reader.bufferType;
      const generation = reader.generation;
      if (anchor && (anchor.bufferType !== bufferType || anchor.generation !== generation)) {
        anchor = null;
      }
      if (splitRevoked && (splitRevoked.bufferType !== bufferType || splitRevoked.generation !== generation)) {
        splitRevoked = null;
      }
      if (baseline && (baseline.bufferType !== bufferType || baseline.generation !== generation)) {
        baseline = null;
      }
      const resumedFromSplit = !anchor && !!splitRevoked;
      const revokedFrom = resumedFromSplit ? { x: splitRevoked.x, y: splitRevoked.y } : null;
      const prevAnchor = anchor || splitRevoked;

      // Build bounded set of candidate rows to inspect.
      const rowsToCheck = new Set();
      if (Number.isInteger(reader.cursorY) && reader.cursorY >= 0 && reader.cursorY < reader.rows) {
        rowsToCheck.add(reader.cursorY);
      }
      if (prevAnchor) {
        rowsToCheck.add(prevAnchor.y);
        if (intentsMayCrossRows(prevAnchor, reader.cols)) {
          if (prevAnchor.y > 0) rowsToCheck.add(prevAnchor.y - 1);
          if (prevAnchor.y + 1 < reader.rows) rowsToCheck.add(prevAnchor.y + 1);
        }
      }
      if (currentCycle) {
        if (Number.isInteger(currentCycle.preCursorY) && currentCycle.preCursorY >= 0 && currentCycle.preCursorY < reader.rows) {
          rowsToCheck.add(currentCycle.preCursorY);
        }
        for (const r of currentCycle.dirtyRows) {
          if (r >= 0 && r < reader.rows) rowsToCheck.add(r);
        }
      }

      const matches = [];
      for (const row of rowsToCheck) {
        const scan = scanRowForCaret(reader, row);
        if (!scan.valid || !scan.caret) continue;
        const preSnap = baseline ? baseline.rows.get(row) : null;
        const match = matchRowAgainstIntents(reader, row, scan.caret, preSnap, prevAnchor);
        if (match) matches.push(match);
      }

      // Ambiguous multi-row match fails closed.
      if (matches.length !== 1) return null;
      const winner = matches[0];
      intents.splice(0, winner.consumeThrough);
      baseline = null;
      splitRevoked = null;
      const isSplitResume = resumedFromSplit && !winner.resetTrust;
      anchor = {
        x: winner.caret.x,
        y: winner.caret.y,
        style: winner.caret.style,
        bufferType,
        generation,
        trusted: !winner.resetTrust && (isSplitResume || (prevAnchor !== null)),
      };
      return {
        chunkSeq: seq,
        x: winner.caret.x,
        y: winner.caret.y,
        char: winner.caret.char,
        width: winner.caret.width,
        fg: winner.caret.fg,
        bg: winner.caret.bg,
        style: winner.caret.style,
        restoreSgr: winner.caret.restoreSgr,
        source: 'post-parse',
        resumedFromSplit: isSplitResume,
        revokedFrom: isSplitResume ? revokedFrom : null,
        resetTrust: winner.resetTrust === true,
      };
    }

    return {
      noteInput,
      beforeChunkWrite,
      onParsed,
      hasPendingIntents,
      onPreParseHit,
      onCursorVisible,
      rebaseGeneration,
      syncExternalAnchor,
      noteRevoke,
      clearCycle,
      reset,
      state() {
        return {
          pendingIntents: intents.length,
          anchor: anchor ? { ...anchor } : null,
          cycleActive: cycle !== null,
        };
      },
    };
  }

  const api = {
    createPostParseCaretRecognizer,
    classifyInputData,
    scanRowForCaret,
    classifyCellCaretStyle,
    charWidth,
    MAX_DIRTY_ROWS,
    INTENT_TTL_MS,
  };
  root.createPostParseCaretRecognizer = createPostParseCaretRecognizer;
  root.__postParseCaretInternals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
