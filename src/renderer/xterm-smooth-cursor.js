(function installXtermWebglSmoothCursor(root) {
  'use strict';

  const DEFAULT_DURATION = 90;
  const DEFAULT_JUMP_DISTANCE = 8;
  // A block-caret slide starting within this window after a printable local
  // keystroke is typing echo: draw it as a plain block (no in-place glyph
  // inversion), so just-typed characters are covered, never flashed. This
  // time signal serves the protocol-cursor path (shell echo is prompt).
  const ECHO_PLAIN_WINDOW_MS = 200;
  // Stale-credit bound for the software-caret echo classification (see the
  // echoInputCredits declaration): covers the tail frames of a burst in the
  // measured multiplexer latency band, caps misclassification of later
  // app-initiated slides when an echo frame never arrives.
  const ECHO_CREDIT_CAP = 4;
  const MAX_TIMESTAMPS = 128;
  const MAX_CAPTURE_FRAMES = 12;
  const RGB_COLOR_MODE = 0x03000000;
  // xterm AttributeData/FgFlags.INVERSE, verified against the bundled parser.
  const INVERSE_ATTR_FLAG = 0x04000000;
  const EXTENDED_ATTR_FLAG = 0x10000000;
  // Style bits carried from the cell onto the redraw color words, so a
  // redrawn glyph is pixel-identical to the base pass. Bit values verified
  // against the vendored AttributeData predicates in addon-webgl.js
  // (isBold/isItalic/isUnderline/isInvisible/isStrikethrough/isOverline/
  // hasExtendedAttrs): fg carries BOLD, legacy UNDERLINE, INVISIBLE and
  // STRIKETHROUGH; bg carries ITALIC, EXTENDED (gates the ext underline
  // style) and OVERLINE. INVERSE (fg) is deliberately excluded — the
  // inversion IS the cursor — while DIM/BLINK only modulate color/alpha and
  // blink timing, and the redraw replaces the colors with the cursor pair
  // anyway.
  const FG_STYLE_MASK = 0x08000000 | 0x10000000 | 0x40000000 | 0x80000000;
  const BG_STYLE_MASK = 0x04000000 | EXTENDED_ATTR_FLAG | 0x40000000;

  function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  const PASTE_BEGIN = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  // Source-ordered segmentation of one input event into printable text runs
  // and NONPRINTABLE BARRIERS, in original order. Complete bracketed-paste
  // wrappers are transparent — the payload joins the text stream exactly
  // where it was sent; an unterminated wrapper fails closed as a barrier
  // (half a paste is not a typing unit), and so does every nonprintable
  // codepoint (newlines included: they never join two printable runs). An
  // ESC/DEL poisons the rest of the event — the parameter bytes of an escape
  // sequence are not typed characters. Input bytes themselves are never
  // altered here; noteInput only observes what was sent.
  function segmentInputEvent(data) {
    const segments = [];
    let text = '';
    let index = 0;
    let unterminated = false;
    while (index < data.length) {
      const begin = data.indexOf(PASTE_BEGIN, index);
      if (begin < 0) { text += data.slice(index); break; }
      const end = data.indexOf(PASTE_END, begin + PASTE_BEGIN.length);
      if (end < 0) { text += data.slice(index, begin); unterminated = true; break; }
      text += data.slice(index, begin) + data.slice(begin + PASTE_BEGIN.length, end);
      index = end + PASTE_END.length;
    }
    let run = '';
    const flush = () => { if (run) { segments.push({ kind: 'text', text: run }); run = ''; } };
    for (const ch of text) {
      if (ch === '\x1b' || ch === '\x7f') {
        flush();
        segments.push({ kind: 'barrier' });
        return segments; // poisoned: the rest of the event is not typed text
      }
      if (isPrintableChar(ch)) run += ch;
      else { flush(); segments.push({ kind: 'barrier' }); }
    }
    flush();
    if (unterminated) segments.push({ kind: 'barrier' });
    return segments;
  }

  function isPrintableChar(ch) {
    // Codepoint-level printable test (C0, DEL and C1 controls excluded; every
    // other codepoint, beyond-BMP included, is printable text input).
    const cp = ch.codePointAt(0);
    return cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f);
  }

  function createXtermWebglSmoothCursor(options) {
    const terminal = options?.terminal;
    const addon = options?.addon;
    const renderer = addon?._renderer;
    const renderService = terminal?._core?._renderService;
    const Motion = options?.MotionClass || root.SmoothCursorMotion;
    const clock = typeof options?.now === 'function'
      ? options.now
      : function () { return root.performance?.now?.() ?? Date.now(); };

    if (!terminal || !renderer || renderService?._renderer?.value !== renderer) {
      throw new Error('Smooth cursor requires the active xterm WebGL renderer');
    }
    if (typeof Motion !== 'function') throw new Error('SmoothCursorMotion is unavailable');
    if (!renderer._gl || !renderer._canvas || !renderer._rectangleRenderer?.value || !renderer._glyphRenderer?.value) {
      throw new Error('Required xterm WebGL renderer hooks are unavailable');
    }

    const duration = Math.max(0, finite(options?.duration, DEFAULT_DURATION));
    const jumpDistance = Math.max(0, finite(options?.jumpDistance, DEFAULT_JUMP_DISTANCE));
    // All three xterm caret styles (bar/block/underline) have an adapter-drawn
    // form; refuse to bind on anything unexpected so the caller keeps the
    // native caret.
    const terminalCursorStyle = terminal.options.cursorStyle;
    if (terminalCursorStyle !== 'bar' && terminalCursorStyle !== 'block' && terminalCursorStyle !== 'underline') {
      throw new Error(`Smooth cursor cannot draw the '${terminalCursorStyle}' cursor style`);
    }
    const motion = new Motion({ duration, jumpDistance, now: clock });
    const mediaQuery = options?.reducedMotionQuery || root.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    const originalRenderRows = renderer.renderRows;
    const subscriptions = [];
    const instrumentation = {
      baseDrawPasses: 0,
      cursorDrawPasses: 0,
      rectangleDrawPasses: 0,
      glyphDrawPasses: 0,
      stockSuppressedPasses: 0,
      continuationRequests: 0,
      frameId: 0,
      target: null,
      visual: null,
      lastRectangle: null,
      lastGlyph: null,
      echoSlides: 0,
      retargets: [],
      drawTimestamps: [],
      drawPassStatus: 'idle',
      customDrawSource: 'none',
      scheduler: 'xterm-render-service',
      presentationSemantics: 'WebGL draw submission timestamps, not presented FPS',
    };
    const diagnostic = { remaining: 0, held: false, heldAt: 0, records: [] };
    let disposed = false;
    let enabled = options?.enabled !== false;
    let smoothEnabled = options?.smooth !== false;
    let cursorStyle = options?.cursorStyle === 'block' ? 'block'
      : options?.cursorStyle === 'underline' ? 'underline' : 'bar';
    let continuationQueued = false;
    // Continuation render scope. 'full' re-renders the whole viewport on
    // every animation frame; 'cursor' re-renders only the rows the caret
    // spans, which is 1-2 rows instead of ~30.
    let renderScope = options?.renderScope === 'cursor' ? 'cursor' : 'full';
    let lastDrawnRow = null;
    let snapBeforeNextDraw = true;
    let lastTarget = null;
    // Timestamp of the last printable local keystroke, set via noteInput().
    // A block-caret slide starting inside the echo window is typing echo:
    // the caret may cover the just-typed characters but must not flash them
    // inverted, so the glyph pass is skipped for the slide's duration.
    let lastPrintableInputAt = -Infinity;
    // Pending-echo credits for the software-caret path. The time window
    // alone cannot classify echo there: an agent TUI behind a multiplexer
    // renders asynchronously, and the measured keystroke→frame latency in
    // the herdr chain is 194-375ms — outside ANY window that would still
    // spare navigation. A printable keystroke banks one credit per printed
    // character (capped); when a slide starts with the window cold, a credit
    // pays for it (once, at the latch transition). While the window is warm
    // it pays instead, so mid-burst frames never drain credits; a burst's
    // TAIL frames land in the cold zone — L-200ms of frame time, up to ~3
    // frames in the measured band — and each consumes one credit, which is
    // why a boolean flag is insufficient for fast typing (T ≤ L-200ms).
    // Non-printable input clears the balance; echo frames that never come
    // leave stale credits, so up to CAP later app-initiated slides may
    // inherit a plain classification — bounded, transient artifacts.
    let echoInputCredits = 0;
    // Write-evidenced echo for the PROTOCOL cursor path on the alternate
    // buffer — the multiplexer shell pane case. The multiplexer holds
    // ?1049h for its entire UI; per herdr's docs, host_cursor=auto presents
    // the pane shell's caret as the outer terminal's NATIVE protocol cursor
    // on non-Windows hosts (our local Windows herdr 0.9.0 probe showed the
    // opposite — hidden protocol cursor, no painted caret — so this branch
    // is inert in that configuration; the remote-shell symptom it targets
    // matches the documented non-Windows behavior). Relay latency (measured
    // 194-375ms in the herdr chain) defeats ANY time window, and credits
    // cannot extend here: on the alternate buffer printable keys like hjkl
    // are navigation, so input-side evidence alone would classify them as
    // typing. Echo is mechanical instead: the frame that moves the cursor
    // also WROTE the cell the cursor vacates (the echoed character lands at
    // the caret's previous cell); navigation never writes. The observer
    // already reports per-unit written cells (unit.wrote); keep the newest
    // few chunk batches and match the vacated cell at retarget time.
    // Batches expire by age so leftovers from an idle prompt never classify
    // a later app-initiated slide. Known limit: a chunk boundary cutting
    // through a write unit loses that unit's cells (only complete units are
    // reported), so a split echo frame can miss its classification.
    const ECHO_WRITE_BATCH_KEEP = 4;
    const ECHO_WRITE_BATCH_MS = 1500;
    let echoWriteBatches = []; // [{ seq, at, cells: Set<'row:col'> }], arrival order
    let pendingWriteEcho = false; // evidence for the latest retarget's run
    let echoWriteBufferType = null; // batches are coordinate-bound to their buffer

    // Chunk-level rich write evidence for the same protocol-cursor echo path.
    // Editors (vim/nvim insert mode) emit plain unsynchronized writes with no
    // completed unit at all, and a split sync block can retarget before its
    // unit closes — the unit batches above never see those frames. The
    // observer reports every chunk's printable cell writes ([y, x, char,
    // width], outside and inside units); the adapter keeps the newest state
    // per cell, bound to the buffer it was observed on and to the "frame
    // epoch" (writes recorded since the last retarget — an echo frame's
    // write always precedes its own retarget; a write from before the
    // previous retarget belongs to an older frame and must not classify).
    const ECHO_CHUNK_CELLS_MAX = 8192;
    let echoChunkCells = new Map(); // 'y:x' -> { at, char, width, epoch }
    let echoChunkBufferType = null;
    let echoChunkEpoch = 0;
    let pendingChunkEcho = false; // rich echo classification for the latest retarget's run
    // Bounded ordered queue of recent printable input codepoints, oldest
    // first, with PER-ENTRY timestamps: entries expire individually and a
    // newer keystroke never refreshes older ones. The exact merged-input
    // match consumes from the OLDEST UNCONSUMED entry; single-cell/wrap
    // positives retire a matching head entry so a later identical repaint
    // cannot reuse old evidence. Never exposed through diagnostics.
    const ECHO_INPUT_QUEUE_MAX = 64;
    const ECHO_INPUT_QUEUE_MS = 1500; // same freshness horizon as write evidence
    let echoInputQueue = []; // [{ ch, at }]

    function pruneInputQueue() {
      const now = clock();
      while (echoInputQueue.length && now - echoInputQueue[0].at > ECHO_INPUT_QUEUE_MS) echoInputQueue.shift();
      if (echoInputQueue.length > ECHO_INPUT_QUEUE_MAX) {
        echoInputQueue.splice(0, echoInputQueue.length - ECHO_INPUT_QUEUE_MAX);
      }
    }

    function enqueueInputChars(chars) {
      const at = clock();
      for (const ch of chars) echoInputQueue.push({ ch, at });
      pruneInputQueue();
    }

    // Exact ordered match at the oldest matching run, consumed once. Older
    // printable commands that produced no echo are retired with the match,
    // so a mode-change key cannot block a later coalesced frame.
    function consumeInputRun(chars) {
      pruneInputQueue();
      for (let start = 0; start + chars.length <= echoInputQueue.length; start++) {
        let matches = true;
        for (let i = 0; i < chars.length; i++) {
          if (echoInputQueue[start + i].ch !== chars[i]) { matches = false; break; }
        }
        if (matches) {
          echoInputQueue.splice(0, start + chars.length);
          return true;
        }
      }
      return false;
    }

    // A single-cell/wrap echo positive retires its input and any older
    // non-echo commands — bookkeeping only, never a precondition.
    function retireInputChar(ch) {
      pruneInputQueue();
      const index = echoInputQueue.findIndex(entry => entry.ch === ch);
      if (index !== -1) echoInputQueue.splice(0, index + 1);
    }

    // A nonprintable input barrier, session reset or coordinate-space
    // invalidation voids every input-side echo asset at once.
    function clearInputEchoState() {
      echoInputCredits = 0;
      echoWriteBatches = [];
      pendingWriteEcho = false;
      echoChunkCells = new Map();
      pendingChunkEcho = false;
      echoChunkEpoch += 1;
      echoInputQueue = [];
    }
    // Text of the vacated row as of the previous drawable pass, captured
    // after EVERY drawable pass (never at retarget time, after new parsing).
    // Kept PRIVATE next to lastTarget (the public snapshot target stays
    // {x,y}): the rich echo decision compares it with the row's text at
    // retarget time — typing inserts or shifts the row, a same-char
    // navigation rewrite leaves the row text unchanged.
    let lastTargetRowText = null;
    function noteUnitWrites(info) {
      if (!info || !info.wrote || !info.wrote.length) return;
      const bufferType = terminal.buffer.active.type;
      if (bufferType !== echoWriteBufferType) {
        echoWriteBufferType = bufferType;
        echoWriteBatches = [];
        pendingWriteEcho = false;
      }
      const at = clock();
      const last = echoWriteBatches[echoWriteBatches.length - 1];
      const batch = last && last.seq === info.chunkSeq ? last : null;
      const target = batch || { seq: info.chunkSeq, at, cells: new Set() };
      for (const w of info.wrote) target.cells.add(w[0] + ':' + w[1]);
      target.at = at;
      if (!batch) {
        echoWriteBatches.push(target);
        if (echoWriteBatches.length > ECHO_WRITE_BATCH_KEEP) echoWriteBatches.shift();
      }
    }
    function echoWriteCovers(y, x) {
      // Batches are coordinate-bound to the buffer they were observed on;
      // the observer parses pre-write, so a mid-chunk buffer switch can
      // leave one stale-tagged batch alive until the next write unit.
      if (echoWriteBufferType !== terminal.buffer.active.type) return false;
      const at = clock();
      const key = y + ':' + x;
      for (let i = echoWriteBatches.length - 1; i >= 0; i--) {
        const batch = echoWriteBatches[i];
        if (at - batch.at > ECHO_WRITE_BATCH_MS) break; // arrival order: older batches are all stale
        if (batch.cells.has(key)) return true;
      }
      return false;
    }

    function noteChunkWrites(info) {
      if (!info || !Array.isArray(info.cells)) return;
      const bufferType = terminal.buffer.active.type;
      if (bufferType !== echoChunkBufferType) {
        // Coordinate space changed: drop cell evidence of the other buffer.
        echoChunkBufferType = bufferType;
        echoChunkCells = new Map();
      }
      const at = clock();
      for (const cell of info.cells) {
        if (!Array.isArray(cell) || cell.length < 4) continue;
        const key = cell[0] + ':' + cell[1];
        // delete+set refreshes insertion order so the bounded-eviction drop
        // below always removes the OLDEST evidence, not a rewritten cell.
        echoChunkCells.delete(key);
        echoChunkCells.set(key, { at, char: cell[2], width: cell[3], epoch: echoChunkEpoch });
        if (echoChunkCells.size > ECHO_CHUNK_CELLS_MAX) {
          echoChunkCells.delete(echoChunkCells.keys().next().value);
        }
      }
    }

    // Char and width currently stored in a viewport-relative protocol cell,
    // or null when the buffer is unreadable. Same access discipline as
    // softwareCellMatches (shared workCell, guarded loads).
    function protocolCell(y, x) {
      try {
        const active = terminal.buffer.active;
        const viewportY = finite(active.viewportY, terminal._core?.buffer?.ydisp);
        const line = terminal._core?.buffer?.lines?.get(viewportY + y);
        const cell = renderer._workCell;
        if (!line || !cell || typeof line.loadCell !== 'function') return null;
        line.loadCell(x, cell);
        return { chars: cell.getChars(), width: cell.getWidth() };
      } catch (error) { return null; }
    }

    // Lossless text fingerprint of a viewport-relative protocol row, or null
    // when the buffer is unreadable. Every column is kept (no trailing trim)
    // and an empty cell encodes as NUL — a sentinel no parsed cell can
    // contain — so an explicit space stays distinguishable from an unwritten
    // cell and trailing-column writes survive the comparison.
    function protocolRowText(y) {
      try {
        const active = terminal.buffer.active;
        const viewportY = finite(active.viewportY, terminal._core?.buffer?.ydisp);
        const line = terminal._core?.buffer?.lines?.get(viewportY + y);
        const cell = renderer._workCell;
        if (!line || !cell || typeof line.loadCell !== 'function' || !terminal.cols) return null;
        let text = '';
        for (let x = 0; x < terminal.cols; x += 1) {
          line.loadCell(x, cell);
          text += cell.getChars() || '\u0000';
        }
        return text;
      } catch (error) { return null; }
    }

    // Exact merged-input echo: a coalesced frame typed several characters in
    // ONE run on one row (the native `_sendPaneInput('fa')` case: vim redraws
    // the inserted run plus the shifted tail in a single frame). Requires
    // current-epoch, time-fresh observer coverage of EVERY cell in
    // [vacated, target) — the walk is width-weighted, so a wide lead covers
    // its own tail and the coverage must end exactly at the caret — with
    // per-cell char+width agreement with the parser, plus an EXACT ordered
    // match of the oldest unconsumed fresh input codepoints, consumed once
    // on success. Cells at/after the target (the shifted tail of an insert)
    // are NOT required to match the input. Missing coverage, model
    // divergence or an input mismatch all fail closed — never legacy.
    function classifyMergedRunEcho(target) {
      if (echoChunkBufferType !== terminal.buffer.active.type) return false;
      const run = [];
      let x = lastTarget.x;
      while (x < target.x) {
        const entry = echoChunkCells.get(lastTarget.y + ':' + x);
        if (!entry || entry.epoch !== echoChunkEpoch) return false;
        if (clock() - entry.at > ECHO_WRITE_BATCH_MS) return false;
        const parsed = protocolCell(lastTarget.y, x);
        if (!parsed || entry.char !== parsed.chars || entry.width !== parsed.width) return false;
        run.push(entry.char);
        x += Math.max(1, parsed.width);
      }
      if (x !== target.x) return false; // the sum of widths must equal the advance
      return consumeInputRun(run);
    }

    // Rich chunk-evidence decision for the retarget that is starting
    // (lastTarget is still the vacated cell). Returns a TRI-STATE:
    //   'echo' — the frame has the mechanical echo signature;
    //   'nav'  — rich evidence IS applicable and the frame is NOT echo: this
    //            VETOES the legacy unit evidence for the same retarget (a
    //            completed sync unit whose writes cover the vacated cell is
    //            not echo just because the unit exists), and a changed row
    //            with a non-echo cursor shape fails closed here too — a
    //            rich-classifiable retarget never leaks back to legacy;
    //   null   — rich evidence does not apply at all (no current-epoch fresh
    //            write at the vacated cell): the legacy unit batches decide
    //            on their own (the verified no-hide multiplexer positives).
    // Once a current-epoch, time-fresh, same-buffer write exists at the
    // vacated cell, evaluation order is fixed:
    //  1. Observer agreement: the observer's char AND width are what the
    //     parser stored in that cell (divergent grapheme models — combining
    //     marks, ZWJ sequences, astral widths — fail closed).
    //  2. Lossless row delta: the vacated row's full fingerprint versus the
    //     previous drawable pass. UNCHANGED means navigation (vim `l`
    //     rewrites the cell byte-identically), whatever column or row the
    //     caret parked on.
    //  3. Changed row: echo only for the exact echo shapes — the caret one
    //     char past the vacated cell on the same row, the ordinary
    //     end-of-row wrap (the written char filled the final column and the
    //     caret landed on column zero of the next row), or an exact
    //     merged-input run (classifyMergedRunEcho). Both simple shapes stay
    //     independent of the input queue (they only RETIRE a matching head
    //     entry); every other shape fails closed as 'nav'.
    function classifyRichEcho(target) {
      if (lastTarget === null || echoChunkBufferType !== terminal.buffer.active.type) return null;
      const entry = echoChunkCells.get(lastTarget.y + ':' + lastTarget.x);
      if (!entry || entry.epoch !== echoChunkEpoch) return null;
      if (clock() - entry.at > ECHO_WRITE_BATCH_MS) return null;
      const vacated = protocolCell(lastTarget.y, lastTarget.x);
      if (!vacated) return 'nav'; // entry exists but the cell is unreadable: fail closed
      if (entry.char !== vacated.chars || entry.width !== vacated.width) return 'nav'; // model divergence
      const row = protocolRowText(lastTarget.y);
      if (row === null || lastTargetRowText === null) return 'nav';
      if (row === lastTargetRowText) return 'nav'; // unchanged row: navigation, any cursor delta
      const advance = Math.max(1, vacated.width);
      const parkedAfterChar = target.y === lastTarget.y && target.x === lastTarget.x + advance;
      const wrappedEndOfRow = lastTarget.x + advance === terminal.cols
        && target.y === lastTarget.y + 1 && target.x === 0;
      if (parkedAfterChar || wrappedEndOfRow) {
        retireInputChar(vacated.chars);
        return 'echo';
      }
      if (target.y === lastTarget.y && target.x > lastTarget.x + advance
        && classifyMergedRunEcho(target)) return 'echo';
      return 'nav';
    }
    // Once a slide starts inside the echo window it stays plain for the whole
    // animation run, even when app retargets or blink freezes stretch it past
    // the window — no mid-slide plain/inversion flip.
    let echoSlideLatched = false;
    // Hidden-freeze state: elapsed time of the in-flight animation at the
    // last drawable (painted) frame, latched while the cursor is not drawable
    // so the hidden period never ages the animation anchor.
    let lastDrawElapsedMs = null;
    let frozenElapsedMs = null;

    // ── Software-caret takeover ──
    // A bypass observer on the raw stream produces per-unit caret candidates
    // (write position + covering char + truecolor evidence). They become the
    // SINGLE animated cursor only after: two consecutive candidate units
    // (trust), the candidate's chunk has been fully parsed by xterm (write
    // callback watermark), and the session generation still matches (scroll/
    // resize/buffer switch bumps it). The protocol cursor's DECTCEM state is
    // deliberately ignored in this mode — the app hides it and paints its own
    // caret — while the buffer is never modified: the caret cell is visually
    // restored (theme-background rectangle) during the same draw pass that
    // draws our cursor, so recognition + restore + cursor are one atomic
    // presentation.
    const sw = {
      pending: null,            // candidate awaiting its parse watermark
      published: null,          // active descriptor
      runStreak: 0,             // consecutive candidate-bearing units
      watermark: 0,             // highest chunkSeq xterm has parsed
      enqueued: 0,              // newest raw chunk awaiting its write callback
      generation: 0,            // coordinate-space epoch
      candidateGeneration: 0,
      bufferType: null,
      active: false,
      lastRestoreRow: null,
    };

    function clearSoftwareVisual() {
      if (sw.lastRestoreRow === null) return;
      const staleRows = new Set([sw.lastRestoreRow, lastDrawnRow]);
      sw.lastRestoreRow = null;
      lastDrawnRow = null;
      instrumentation.customDrawSource = 'none';
      for (const stale of staleRows) {
        if (stale !== null) {
          try { originalRenderRows.call(renderer, stale, stale); } catch (error) { /* mid-dispose */ }
        }
      }
    }

    function revokeSoftware(reason) {
      const hadDescriptor = sw.active || sw.pending || sw.published;
      sw.active = false;
      sw.runStreak = 0;
      sw.pending = null;
      sw.published = null;
      if (!hadDescriptor) return;
      snapBeforeNextDraw = true;
      instrumentation.softwareCaret = { active: false, reason };
      clearSoftwareVisual();
      scheduleContinuation();
    }

    function rgbAttribute(value) {
      if (typeof value !== 'string' || !/^\d{1,3};\d{1,3};\d{1,3}$/.test(value)) return null;
      const channels = value.split(';').map(Number);
      if (channels.some(channel => channel > 255)) return null;
      return RGB_COLOR_MODE | channels[0] << 16 | channels[1] << 8 | channels[2];
    }

    function softwareCellMatches(descriptor) {
      if (!descriptor || !Number.isInteger(descriptor.x) || !Number.isInteger(descriptor.y)
        || descriptor.x < 0 || descriptor.x >= terminal.cols || descriptor.y < 0 || descriptor.y >= terminal.rows
        || sw.bufferType !== terminal.buffer.active.type) return false;
      try {
        const active = terminal.buffer.active;
        const absoluteY = finite(active.viewportY, terminal._core?.buffer?.ydisp) + descriptor.y;
        const line = terminal._core?.buffer?.lines?.get(absoluteY);
        const cell = renderer._workCell;
        if (!line || !cell || typeof line.loadCell !== 'function') return false;
        line.loadCell(descriptor.x, cell);
        if (cell.getChars() !== descriptor.char || cell.getWidth() !== descriptor.width) return false;
        // Validate the observed convention, never latch whatever happens to
        // occupy this coordinate. Reverse lives in fg, not bg. Decorations
        // and palette colors have no verified default-color restore here.
        if (descriptor.style === 'reverse') return cell.fg === INVERSE_ATTR_FLAG && cell.bg === 0;
        if (descriptor.style !== 'truecolor') return false;
        const fg = rgbAttribute(descriptor.fg);
        const bg = rgbAttribute(descriptor.bg);
        return fg !== null && bg !== null && cell.fg === fg && cell.bg === bg;
      } catch (error) { return false; }
    }

    const softwareCaretPort = {
      generation() { return sw.generation; },
      isParsed(seq) { return !disposed && seq === sw.enqueued && seq === sw.watermark; },
      // Raw-stream candidate (pre-parse): queue until its watermark.
      candidate(cand) {
        if (disposed || !cand) return;
        sw.enqueued = Math.max(sw.enqueued, cand.chunkSeq);
        sw.runStreak += 1;
        sw.pending = { ...cand };
        sw.candidateGeneration = sw.generation;
        sw.bufferType = terminal.buffer.active.type;
      },
      // IPC calls this for every chunk, including chunks with no candidate.
      // Suspend drawing before parsing, but retain the trusted source and
      // motion anchor so an ordinary matching completion keeps smoothing.
      enqueued(seq) {
        if (disposed || !Number.isFinite(seq)) return;
        sw.enqueued = Math.max(sw.enqueued, seq);
        if (sw.enqueued > sw.watermark) clearSoftwareVisual();
      },
      // Completed unit without a candidate: NEUTRAL unless it wrote to the
      // candidate cell (contradiction → revoke + reset trust). Interleaved
      // outer-TUI frames (herdr chrome, complete with its own SHOWs) are
      // the normal case inside an ink input session — protocol-cursor
      // gestures and software-caret existence are separate concerns, so
      // only cell-level contradiction breaks the run.
      unit(info) {
        if (disposed) return;
        noteUnitWrites(info);
        if (!info.hadCandidate) {
          const cell = sw.published || sw.pending;
          if (cell) {
            const hit = (info.wrote || []).some(w => w[0] === cell.y && w[1] === cell.x);
            if (hit) {
              if (sw.active) revokeSoftware('cell-overwritten');
              sw.runStreak = 0;
              sw.pending = null;
            }
          }
        }
      },
      // Bounded chunk-level write report from the raw-stream observer (see
      // noteChunkWrites): cells written by this chunk anywhere on screen,
      // including outside units and inside still-open units.
      chunkWrites(info) {
        if (disposed) return;
        noteChunkWrites(info);
      },
      // xterm parsed through chunk `seq` (term.write callback): publish the
      // pending candidate if its unit completed inside the parsed range.
      parsed(seq) {
        if (disposed) return;
        // Advance only through a chunk the live observer actually enqueued:
        // _inkFeed always enqueues a chunk before writing it, so a seq above
        // enqueued can only be a stale write callback from a previous
        // observer's numbering (wrapper migration kept the old owner's
        // fields alive) — accepting it would push the watermark ahead of the
        // real parse front and break the checkpoint binding.
        if (typeof seq === 'number' && seq > sw.watermark && seq <= sw.enqueued) sw.watermark = seq;
        if (sw.enqueued > sw.watermark) return;
        if (sw.pending && sw.pending.chunkSeq <= sw.watermark && sw.candidateGeneration === sw.generation) {
          if (!softwareCellMatches(sw.pending)) {
            revokeSoftware('candidate-cell-mismatch');
            return;
          }
          sw.published = sw.pending;
          sw.pending = null;
          if (sw.runStreak >= 2 && !sw.active) {
            sw.active = true;
            snapBeforeNextDraw = true; // source switch never flies from the protocol anchor
            instrumentation.softwareCaret = { active: true, since: clock() };
          }
        }
        if (sw.active) scheduleContinuation();
      },
      invalidate(reason) {
        sw.generation += 1;
        // Coordinate space changed: write evidence from before the boundary
        // would classify against cells that no longer mean the same thing.
        echoWriteBatches = [];
        pendingWriteEcho = false;
        echoChunkCells = new Map();
        pendingChunkEcho = false;
        echoChunkEpoch += 1;
        echoInputQueue = [];
        revokeSoftware('invalidate:' + (reason || 'unknown'));
        if (reason === 'session-reset') {
          sw.watermark = 0;
          sw.enqueued = 0;
        }
      },
      // Wrapper migration (split/extract/collapse/drag) keeps this adapter and
      // its terminal alive but moves them onto a new owner, and _inkFeed then
      // builds a fresh observer whose chunkSeq restarts at 1. The counters
      // below still number the dead observer's chunks: enqueued's Math.max
      // pins it above every new seq, and the dropped owner's in-flight write
      // callbacks can never raise the watermark again, so the suspend gate
      // (enqueued > watermark) disables the cursor chain until a reconnect.
      // Rebase both counters to the new observer's numbering and drop the
      // dead observer's pending candidate and trust run; the published
      // descriptor, the coordinate generation and every animation parameter
      // stay untouched — the buffer and the app's painted caret are unchanged
      // by the move, so this is bookkeeping, not a session boundary.
      rebindObserver() {
        if (disposed) return;
        sw.enqueued = 0;
        sw.watermark = 0;
        sw.pending = null;
        sw.runStreak = 0;
      },
    };

    renderer.renderRows = function smoothCursorRenderRows(start, end) {
      if (disposed) return originalRenderRows.call(renderer, start, end);
      instrumentation.frameId += 1;
      instrumentation.drawTimestamps.push(clock());
      trim(instrumentation.drawTimestamps, MAX_TIMESTAMPS);

      const cursorBeforeBase = readCursor();
      const ownsCursor = enabled && cursorBeforeBase.drawable;
      const coreService = renderer._coreService;
      const previousHidden = coreService.isCursorHidden;
      if (ownsCursor) coreService.isCursorHidden = true;
      instrumentation.drawPassStatus = 'base';
      instrumentation.customDrawSource = 'none';
      try {
        originalRenderRows.call(renderer, start, end);
        instrumentation.baseDrawPasses += 1;
        if (ownsCursor) instrumentation.stockSuppressedPasses += 1;
      } finally {
        coreService.isCursorHidden = previousHidden;
      }

      if (!ownsCursor) {
        // While the cursor is not drawable (hidden, unfocused, disabled...)
        // the animation anchor is frozen at the last visible position.
        // Neither the motion state nor the tracked target moves, so a later
        // re-show slides from the frozen position toward the new cursor cell
        // instead of landing there.
        if (frozenElapsedMs === null) frozenElapsedMs = lastDrawElapsedMs;
        instrumentation.drawPassStatus = 'base-only';
        return;
      }

      const at = clock();
      if (frozenElapsedMs !== null) {
        // Re-show: remove the hidden period from the animation clock so the
        // motion resumes exactly from the last painted anchor, then let the
        // normal snap/slide logic below take over.
        if (motion.animating) motion.startedAt = at - frozenElapsedMs;
        frozenElapsedMs = null;
      }
      const targetChanged = !lastTarget || cursorBeforeBase.x !== lastTarget.x || cursorBeforeBase.y !== lastTarget.y;
      motion.duration = smoothEnabled && !isReducedMotion() ? duration : 0;
      if (snapBeforeNextDraw) {
        // Correctness snaps (initial frame, resize, scroll, focus, reduced
        // motion change, smooth toggle) still land immediately.
        motion.reposition(cursorBeforeBase.x, cursorBeforeBase.y, at);
        snapBeforeNextDraw = false;
        pendingWriteEcho = false;
        pendingChunkEcho = false;
      } else if (targetChanged) {
        // Echo evidence binds to the cell the cursor VACATES: a typing-echo
        // frame writes the character at the caret's previous cell, then
        // moves the caret past it. Navigation retargets never write there.
        // The rich tri-state decision runs first (protocol cursor only; the
        // software caret keeps its credit path): a rich NAV verdict vetoes
        // the legacy unit evidence — the unit batches cannot see whether
        // the row actually changed — while a non-applicable rich decision
        // leaves the verified legacy positives (multiplexer grammars)
        // intact. Computed before the frame-epoch bump below so entries
        // recorded since the previous retarget count as this frame's writes.
        const richDecision = lastTarget !== null && cursorBeforeBase.software !== true
          ? classifyRichEcho(cursorBeforeBase) : null;
        pendingWriteEcho = lastTarget !== null && echoWriteCovers(lastTarget.y, lastTarget.x)
          && richDecision !== 'nav';
        pendingChunkEcho = richDecision === 'echo';
        // This retarget closes the current frame: later writes belong to the
        // next frame.
        echoChunkEpoch += 1;
        motion.setTarget(cursorBeforeBase.x, cursorBeforeBase.y, at);
        instrumentation.retargets.push({
          at,
          from: { ...motion.from },
          target: { x: cursorBeforeBase.x, y: cursorBeforeBase.y },
        });
        trim(instrumentation.retargets, MAX_TIMESTAMPS);
      }
      lastTarget = { x: cursorBeforeBase.x, y: cursorBeforeBase.y };
      // Vacated-row baseline for the NEXT retarget's row-delta check: the
      // row text as drawn under the target now, captured after every
      // drawable pass — never at retarget time, which would already include
      // the new frame's parsing (kept private; the public snapshot target
      // stays {x,y}).
      lastTargetRowText = protocolRowText(lastTarget.y);
      const visual = motion.tick(at);
      lastDrawElapsedMs = motion.animating ? Math.max(0, at - motion.startedAt) : null;
      // Narrow scope: the caret may have been painted on a row that xterm did
      // not mark dirty this frame, so clear that row first — otherwise a ghost
      // caret is left behind whenever the caret changes row. The painted span
      // is floor(y)..floor(y)+1 because the caret rectangle crosses into the
      // next row mid-slide. The software-caret restore overlay needs the same
      // treatment for its previous row.
      if (renderScope === 'cursor' && lastDrawnRow !== null) {
        const currentRow = Math.floor(finite(visual?.y, lastDrawnRow));
        for (const stale of [Math.floor(lastDrawnRow), Math.floor(lastDrawnRow) + 1]) {
          if (stale !== currentRow && stale !== currentRow + 1) {
            try {
              originalRenderRows.call(renderer, stale, stale);
            } catch (error) {
              /* mid-dispose: nothing to clear */
            }
          }
        }
      }
      if (sw.active && cursorBeforeBase.software) {
        const restoreRow = cursorBeforeBase.y;
        if (sw.lastRestoreRow !== null && Math.floor(sw.lastRestoreRow) !== Math.floor(restoreRow)) {
          try {
            originalRenderRows.call(renderer, Math.floor(sw.lastRestoreRow), Math.floor(sw.lastRestoreRow));
          } catch (error) { /* mid-dispose */ }
        }
        drawRestoreCell(cursorBeforeBase);
        sw.lastRestoreRow = restoreRow;
      } else if (sw.lastRestoreRow !== null) {
        const stale = Math.floor(sw.lastRestoreRow);
        sw.lastRestoreRow = null;
        try { originalRenderRows.call(renderer, stale, stale); } catch (error) { /* mid-dispose */ }
      }
      drawCursor(cursorBeforeBase, visual);
      lastDrawnRow = Math.floor(finite(visual?.y, 0));
      instrumentation.target = { ...lastTarget };
      instrumentation.visual = { ...visual };
      instrumentation.cursorDrawPasses += 1;
      instrumentation.customDrawSource = cursorBeforeBase.software ? 'software' : 'protocol';
      // drawPassStatus is set inside drawCursor (it knows the echo mode).

      if (diagnostic.remaining > 0 && motion.animating && !diagnostic.held) {
        diagnostic.remaining -= 1;
        diagnostic.held = true;
        diagnostic.heldAt = clock();
        diagnostic.records.push({
          frameId: instrumentation.frameId,
          target: { ...lastTarget },
          visual: { ...visual },
          style: cursorStyle,
          canvasWidth: renderer._canvas.width,
          canvasHeight: renderer._canvas.height,
        });
      }
      if (motion.animating && !diagnostic.held) scheduleContinuation();
    };

    addSubscription(terminal.onScroll?.(function () { softwareCaretPort.invalidate('scroll'); requestSnap(); }));
    addSubscription(terminal.onResize?.(function () { softwareCaretPort.invalidate('resize'); requestSnap(); }));
    addDomSubscription(terminal.element, 'focusin', requestSnap);
    addDomSubscription(terminal.element, 'focusout', requestSnap);
    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener('change', requestSnap);
      subscriptions.push({ dispose: function () { mediaQuery.removeEventListener('change', requestSnap); } });
    } else if (mediaQuery?.addListener) {
      mediaQuery.addListener(requestSnap);
      subscriptions.push({ dispose: function () { mediaQuery.removeListener(requestSnap); } });
    }

    function addSubscription(subscription) {
      if (subscription?.dispose) subscriptions.push(subscription);
    }

    function addDomSubscription(element, event, callback) {
      if (!element?.addEventListener) return;
      element.addEventListener(event, callback);
      subscriptions.push({ dispose: function () { element.removeEventListener(event, callback); } });
    }

    function requestSnap() {
      if (disposed) return;
      snapBeforeNextDraw = true;
      diagnostic.held = false;
      motion.animating = false;
      scheduleContinuation();
    }

    function scheduleContinuation() {
      if (disposed || continuationQueued || diagnostic.held) return;
      continuationQueued = true;
      // Drive animation frames directly — one rAF, one synchronous
      // renderRows. The alternative (rAF → _requestRedrawViewport → the
      // render debouncer's own rAF) lands a draw only every other display
      // frame (~7 draws per 90ms slide at 144Hz); a direct per-vsync render
      // restores the full ~13, one draw per vsync. Fallbacks keep
      // non-browser (test) environments on a microtask path, where synthetic
      // clocks cannot pump real timers.
      const raf = typeof root.requestAnimationFrame === 'function'
        ? root.requestAnimationFrame.bind(root)
        : typeof root.queueMicrotask === 'function'
          ? function (callback) { root.queueMicrotask(callback); }
          : function (callback) { root.setTimeout(callback, 16); };
      raf(function () {
        continuationQueued = false;
        if (disposed || diagnostic.held) return;
        instrumentation.continuationRequests += 1;
        if (typeof root.requestAnimationFrame === 'function') {
          try {
            if (renderScope === 'cursor') {
              // The painted caret spans floor(y)..floor(y)+1 (the rectangle
              // crosses into the next row mid vertical slide); re-render the
              // union of the previous and current spans.
              const posY = finite(motion.position?.y, 0);
              const currentFrom = Math.floor(posY);
              const currentTo = Math.min(terminal.rows - 1, Math.ceil(posY + 1) - 1);
              const previousFrom = lastDrawnRow === null ? currentFrom : Math.floor(lastDrawnRow);
              const previousTo = lastDrawnRow === null ? currentTo : Math.min(terminal.rows - 1, previousFrom + 1);
              const from = Math.max(0, Math.min(previousFrom, currentFrom));
              const to = Math.min(terminal.rows - 1, Math.max(previousTo, currentTo));
              renderer.renderRows(from, to);
            } else {
              renderer.renderRows(0, terminal.rows - 1);
            }
            return;
          } catch (error) {
            // Fall through to the redraw request if the direct render path
            // throws (e.g. mid-dispose).
          }
        }
        renderer._requestRedrawViewport();
      });
    }

    function readCursor() {
      // The stock blink state manager (cursorBlink option) keeps toggling
      // underneath the takeover and re-renders the cursor rows on every
      // phase flip. Its off phase makes the caret not drawable here, which
      // routes through the same freeze/base-only path as any other hidden
      // period — without it the adapter repaints a lit cursor every pass.
      if (renderer._cursorBlinkStateManager?.value?.isCursorVisible === false) {
        return { drawable: false };
      }
      if (sw.enqueued > sw.watermark) {
        clearSoftwareVisual();
        // The base renderer alone owns the uncommitted display. In
        // particular, a visible protocol cursor must not become a second
        // animated source while a software descriptor is suspended.
        return { drawable: false };
      }
      // A proven visible-sync painted cell must not acquire a second,
      // smoothed protocol cursor while its first descriptor earns trust.
      // Keep the untouched base display until the normal two-unit takeover.
      if (!sw.active && sw.runStreak === 1 && sw.published?.confirmedVisibleSync === true
        && sw.candidateGeneration === sw.generation && softwareCellMatches(sw.published)) {
        const active = terminal.buffer.active;
        const viewportY = finite(active.viewportY, terminal._core?.buffer?.ydisp);
        const protocolX = Math.max(0, Math.min(terminal.cols - 1, active.cursorX));
        const protocolY = active.baseY + active.cursorY - viewportY;
        if (protocolX === sw.published.x && protocolY === sw.published.y) return { drawable: false };
      }
      // Software-caret source: when a trusted, watermark-matched descriptor
      // exists, IT defines the drawn cursor. DECTCEM is
      // ignored here on purpose (the app hides the protocol cursor and
      // paints its own); eligibility is re-checked on every draw entry
      // through this function.
      if (sw.active && sw.published) {
        const active = terminal.buffer.active;
        const y = sw.published.y;
        const focused = renderer._coreBrowserService.isFocused === true;
        const inRange = y >= 0 && y < terminal.rows && sw.published.x >= 0 && sw.published.x < terminal.cols;
        const viewportY = finite(active.viewportY, terminal._core?.buffer?.ydisp);
        const absoluteY = viewportY + y;
        const cellIntact = inRange && softwareCellMatches(sw.published);
        const bufferOk = sw.bufferType === null || sw.bufferType === active.type;
        if (inRange && bufferOk && cellIntact) {
          instrumentation.lastSoftwareCursor = { x: sw.published.x, y, char: sw.published.char, width: sw.published.width, focused, drawable: focused };
          return {
            x: sw.published.x,
            y,
            absoluteY,
            width: Math.max(1, sw.published.width),
            initialized: true,
            hidden: false,
            focused,
            drawable: focused,
            software: true,
          };
        }
        revokeSoftware(!inRange ? 'out-of-range' : !bufferOk ? 'buffer-switch' : 'cell-overwritten');
        // fall through to the protocol cursor
      }
      const active = terminal.buffer.active;
      const absoluteY = active.baseY + active.cursorY;
      const viewportY = finite(active.viewportY, terminal._core?.buffer?.ydisp);
      const y = absoluteY - viewportY;
      let x = Math.max(0, Math.min(terminal.cols - 1, active.cursorX));
      const publicLine = active.getLine?.(absoluteY);
      let publicCell = publicLine?.getCell?.(x);
      while (x > 0 && publicCell?.getWidth?.() === 0) {
        x -= 1;
        publicCell = publicLine.getCell(x);
      }
      const width = Math.max(1, finite(publicCell?.getWidth?.(), 1));
      const initialized = renderer._coreService.isCursorInitialized !== false;
      const hidden = renderer._coreService.isCursorHidden === true;
      const focused = renderer._coreBrowserService.isFocused === true;
      return {
        x,
        y,
        absoluteY,
        width,
        initialized,
        hidden,
        focused,
        drawable: initialized && !hidden && focused && y >= 0 && y < terminal.rows,
      };
    }

    function drawCursor(cursor, visual) {
      const rectangle = renderer._rectangleRenderer.value;
      const glyph = renderer._glyphRenderer.value;
      if (!rectangle || !glyph || rectangle._gl !== renderer._gl || glyph._gl !== renderer._gl) {
        throw new Error('Cursor renderer lost the shared WebGL context');
      }
      const dimensions = renderer.dimensions.device;
      const cellWidth = dimensions.cell.width;
      const cellHeight = dimensions.cell.height;
      const widthCells = cursorStyle === 'bar' ? 1 : cursor.width;
      // Geometry mirrors the stock WebGL caret (addon-webgl cursor pass): bar
      // is cursorWidth device px at the cell's left edge, underline is 1 dpr
      // high at the cell bottom, block fills the cursor cells. Only the
      // rectangle interpolates; block glyphs are redrawn on their own cells.
      let x = visual.x * cellWidth;
      let y = visual.y * cellHeight;
      let widthPx;
      let heightPx = cellHeight;
      if (cursorStyle === 'block') {
        widthPx = widthCells * cellWidth;
      } else if (cursorStyle === 'underline') {
        widthPx = cursor.width * cellWidth;
        heightPx = renderer._devicePixelRatio;
        y = (visual.y + 1) * cellHeight - renderer._devicePixelRatio;
      } else {
        widthPx = renderer._devicePixelRatio * terminal.options.cursorWidth;
      }
      const temporaryVertices = { attributes: new Float32Array(32), count: 1 };
      const previousVertices = rectangle._verticesCursor;
      rectangle._verticesCursor = temporaryVertices;
      try {
        rectangle._addRectangleFloat(
          temporaryVertices.attributes,
          0,
          x,
          y,
          widthPx,
          heightPx,
          rectangle._cursorFloat,
        );
        rectangle.renderCursor();
        instrumentation.rectangleDrawPasses += 1;
        instrumentation.lastRectangle = {
          x: visual.x,
          y: visual.y,
          widthCells,
          widthPx,
          attributes: Array.from(temporaryVertices.attributes.slice(0, 8)),
        };
      } finally {
        rectangle._verticesCursor = previousVertices;
      }
      // Typing-echo slides draw as a plain block: the trailing caret may
      // cover just-typed characters, but it must not flash them inverted.
      // Navigation slides (arrows, clicks, TUI redraws) keep the scissored
      // in-place inversion. Settled frames always invert as usual.
      // The classification is a text-input affordance with three evidences:
      //  1. Time window — the normal-buffer shell echo (prompt is prompt).
      //  2. Pending-echo credits — the software-caret path, where a trusted
      //     app-painted caret means an agent TUI input box (kimi, claude);
      //     its frames may land hundreds of ms late through a multiplexer,
      //     past any window. Printable keystrokes bank credits, navigation
      //     input clears them.
      //  3. Write evidence — the protocol cursor on the alternate buffer
      //     (a multiplexer's shell pane, or an editor like vim: no software
      //     caret owns it there, and the same relay latency defeats the
      //     window). The retarget counts as echo only when the frame WROTE
      //     the vacated cell. Two layers feed it: completed-unit batches
      //     (multiplexer shells, verified herdr grammar) and the richer
      //     chunk-level tri-state (see classifyRichEcho: editor frames with
      //     no completed unit classify by observer agreement plus the
      //     vacated row's text delta — typing shifts the row, a same-char
      //     navigation rewrite does not — and a rich NAV verdict vetoes the
      //     unit batches). hjkl and other navigation never shift the row at
      //     the vacated cell, so they keep the inversion.
      // The window pays first: during a fast burst the latest keystroke
      // keeps it warm, so mid-burst frames classify echo without touching
      // the balance, and credits are spent only on frames that arrive after
      // the window has gone cold (a burst's tail).
      const onAlternateBuffer = terminal.buffer.active.type === 'alternate';
      const withinEchoWindow = clock() - lastPrintableInputAt < ECHO_PLAIN_WINDOW_MS;
      const echoCreditUsable = cursor.software === true && echoInputCredits > 0 && !withinEchoWindow;
      const protocolWriteEcho = onAlternateBuffer && cursor.software !== true
        && (pendingWriteEcho || pendingChunkEcho);
      const echoNow = cursorStyle === 'block'
        && motion.animating
        && (!onAlternateBuffer || cursor.software === true || protocolWriteEcho)
        && (withinEchoWindow || echoCreditUsable || protocolWriteEcho);
      if (echoNow && !echoSlideLatched) {
        echoSlideLatched = true;
        instrumentation.echoSlides += 1;
        // Consume only when a credit actually paid for this run, and only at
        // the latch transition — not on every animating draw — so earlier
        // frames of the same burst cannot drain the tail's credits.
        // Retargets inside the run stay echo via the latch itself.
        if (echoCreditUsable) echoInputCredits -= 1;
      }
      if (!motion.animating) echoSlideLatched = false;
      const echoSlide = cursorStyle === 'block' && echoSlideLatched;
      if (cursorStyle === 'block' && !echoSlide) {
        drawBlockGlyph(cursor, visual, glyph);
      }
      instrumentation.drawPassStatus = cursorStyle === 'block' && !echoSlide
        ? 'base+rectangle+glyph' : 'base+rectangle';
    }

    // Block caret glyph pass. The sliding rectangle is the only moving part:
    // every glyph under the caret is repainted in reverse colors AT ITS OWN
    // CELL, clipped by a scissor rectangle to the caret's current pixel
    // coverage. Characters never travel with the caret — the inverted region
    // slides underneath them, so a passing caret inverts the left character's
    // right half and the right character's left half in lockstep.
    function drawBlockGlyph(cursor, visual, glyph) {
      const lines = terminal._core?.buffer?.lines;
      const cell = renderer._workCell;
      if (!lines || typeof lines.get !== 'function' || !cell || typeof cell.getWidth !== 'function') return;
      const dimensions = renderer.dimensions.device;
      const cellWidth = dimensions.cell.width;
      const cellHeight = dimensions.cell.height;
      const gl = renderer._gl;
      const colors = renderer._themeService.colors;
      const cursorBackground = RGB_COLOR_MODE | (colors.cursor.rgba >>> 8 & 0x00ffffff);
      const cursorForeground = RGB_COLOR_MODE | (colors.cursorAccent.rgba >>> 8 & 0x00ffffff);

      const firstCol = Math.max(0, Math.floor(visual.x));
      const lastCol = Math.min(terminal.cols - 1, Math.ceil(visual.x + cursor.width) - 1);
      const firstRow = Math.max(0, Math.floor(visual.y));
      const lastRow = Math.min(terminal.rows - 1, Math.ceil(visual.y + 1) - 1);
      // Clip rect in device pixels, expanded outward so rounding never cuts a
      // covered cell short. WebGL scissor counts y upward from the bottom.
      const px0 = Math.floor(visual.x * cellWidth);
      const px1 = Math.ceil((visual.x + cursor.width) * cellWidth);
      const py0 = Math.floor(visual.y * cellHeight);
      const py1 = Math.ceil((visual.y + 1) * cellHeight);
      const scissor = [px0, renderer._canvas.height - py1, px1 - px0, py1 - py0];

      const temporaryVertices = {
        count: 11,
        attributes: new Float32Array(11),
        attributesBuffers: [new Float32Array(11), new Float32Array(11)],
      };
      const previousVertices = glyph._vertices;
      const previousActiveBuffer = glyph._activeBuffer;
      glyph._vertices = temporaryVertices;
      const drawnChars = [];
      try {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3]);
        for (let row = firstRow; row <= lastRow; row += 1) {
          const line = lines.get(cursor.absoluteY + (row - cursor.y));
          if (!line || typeof line.loadCell !== 'function') continue;
          // When the caret covers only the tail of a wide glyph, that glyph's
          // lead cell sits one column left of the covered range; the scissor
          // clips whatever falls outside the caret.
          let col = firstCol;
          if (col > 0) {
            line.loadCell(col, cell);
            if (cell.getWidth() === 0) col -= 1;
          }
          for (; col <= lastCol; col += 1) {
            line.loadCell(col, cell);
            if (cell.getWidth() === 0) continue; // wide-glyph tail: drawn by its lead
            const code = cell.getCode();
            const chars = cell.getChars();
            if (!code || !chars) continue;
            const ext = cell.bg & EXTENDED_ATTR_FLAG ? cell.extended.ext : 0;
            // The redraw must be pixel-identical to the base pass, or glyphs
            // visibly morph as the caret slides across them: keep the cell's
            // style bits (shape and decorations) on the inverted colors, and
            // pass our own bg word as lastBg so _updateCell's differential
            // left-clip (bg !== lastBg) stays off — the scissor already clips
            // the redraw to the caret's pixel coverage.
            const invertedBg = cursorBackground | (cell.bg & BG_STYLE_MASK);
            const invertedFg = cursorForeground | (cell.fg & FG_STYLE_MASK);
            glyph._updateCell(
              temporaryVertices.attributes,
              0,
              0,
              code,
              invertedBg,
              invertedFg,
              ext,
              chars,
              invertedBg,
            );
            temporaryVertices.attributes[9] = col / terminal.cols;
            temporaryVertices.attributes[10] = row / terminal.rows;
            glyph.render({ lineLengths: [1] });
            instrumentation.glyphDrawPasses += 1;
            drawnChars.push(chars);
          }
        }
      } finally {
        gl.disable(gl.SCISSOR_TEST);
        glyph._vertices = previousVertices;
        glyph._activeBuffer = previousActiveBuffer;
      }
      instrumentation.lastGlyph = {
        drawn: drawnChars.length > 0,
        x: visual.x,
        y: visual.y,
        chars: drawnChars.join(''),
        cells: drawnChars.length,
        scissor,
      };
    }

    // Paint the software-caret cell's non-caret appearance: the app's own
    // verified convention for the same cell is the covering character with
    // DEFAULT colors (SGR 0;39;49) — expressed here as a draw-time overlay
    // (theme-background rectangle + theme-foreground glyph, the same two
    // passes the base render uses for a normal cell). The buffer keeps the
    // app's bytes untouched. With the default 'bar' style no block glyph
    // redraws this cell afterwards, so the covering character MUST be part
    // of the restore itself — a background-only rect would blank the letter
    // under the caret during navigation.
    function drawRestoreCell(cursor) {
      const rectangle = renderer._rectangleRenderer.value;
      const glyph = renderer._glyphRenderer.value;
      if (!rectangle || rectangle._gl !== renderer._gl || !glyph || glyph._gl !== renderer._gl) return;
      const dimensions = renderer.dimensions.device;
      const colors = renderer._themeService.colors;
      const line = terminal._core?.buffer?.lines?.get(cursor.absoluteY);
      const cell = renderer._workCell;
      const code = line && cell && typeof line.loadCell === 'function' ? (line.loadCell(cursor.x, cell), cell.getCode()) : 0;
      const chars = cell ? cell.getChars() : '';
      const ext = cell && cell.bg & EXTENDED_ATTR_FLAG ? cell.extended.ext : 0;
      const restoreBg = RGB_COLOR_MODE | (colors.background.rgba >>> 8 & 0x00ffffff);
      const restoreFg = RGB_COLOR_MODE | (colors.foreground.rgba >>> 8 & 0x00ffffff);

      const temporaryVertices = { attributes: new Float32Array(32), count: 1 };
      const previousVertices = rectangle._verticesCursor;
      const previousColor = rectangle._cursorFloat;
      rectangle._verticesCursor = temporaryVertices;
      try {
        rectangle._cursorFloat = rectangle._colorToFloat32Array(colors.background);
        rectangle._addRectangleFloat(
          temporaryVertices.attributes,
          0,
          cursor.x * dimensions.cell.width,
          cursor.y * dimensions.cell.height,
          Math.max(1, cursor.width) * dimensions.cell.width,
          dimensions.cell.height,
          rectangle._cursorFloat,
        );
        rectangle.renderCursor();
      } finally {
        rectangle._verticesCursor = previousVertices;
        rectangle._cursorFloat = previousColor;
      }
      if (!code || !chars) return;
      // Same pixel-identity rule as drawBlockGlyph: keep the cell's style
      // bits on the restore colors and neutralize the differential clip.
      const restoreBgWord = restoreBg | (cell.bg & BG_STYLE_MASK);
      const restoreFgWord = restoreFg | (cell.fg & FG_STYLE_MASK);
      const prevGlyphVertices = glyph._vertices;
      const prevGlyphBuffer = glyph._activeBuffer;
      const glyphVertices = {
        count: 11,
        attributes: new Float32Array(11),
        attributesBuffers: [new Float32Array(11), new Float32Array(11)],
      };
      glyph._vertices = glyphVertices;
      try {
        glyph._updateCell(
          glyphVertices.attributes,
          0,
          0,
          code,
          restoreBgWord,
          restoreFgWord,
          ext,
          chars,
          restoreBgWord,
        );
        glyphVertices.attributes[9] = cursor.x / terminal.cols;
        glyphVertices.attributes[10] = cursor.y / terminal.rows;
        glyph.render({ lineLengths: [1] });
      } finally {
        glyph._vertices = prevGlyphVertices;
        glyph._activeBuffer = prevGlyphBuffer;
      }
    }

    function isReducedMotion() {
      return mediaQuery?.matches === true;
    }

    function surfaceState() {
      const rectangle = renderer._rectangleRenderer?.value;
      const glyph = renderer._glyphRenderer?.value;
      const screen = terminal.element?.querySelector?.('.xterm-screen');
      const canvases = Array.from(screen?.querySelectorAll?.('canvas') || []);
      return {
        rendererMatchesService: renderService._renderer.value === renderer,
        hookInstalled: renderer.renderRows !== originalRenderRows,
        baseCanvasIsCursorCanvas: renderer._canvas === rectangle?._gl?.canvas && renderer._canvas === glyph?._gl?.canvas,
        baseGlIsCursorGl: renderer._gl === rectangle?._gl && renderer._gl === glyph?._gl,
        canvasOwnedByTerminal: Boolean(screen?.contains?.(renderer._canvas)),
        mainCanvasCount: canvases.filter(function (canvas) { return canvas === renderer._canvas; }).length,
        cursorOverlayCount: terminal.element?.querySelectorAll?.('[data-smooth-cursor-overlay]')?.length || 0,
        terminalFocused: renderer._coreBrowserService.isFocused === true,
      };
    }

    const adapter = {
      // Software-caret port: the raw-stream observer (wired in ipc.js) reports
      // candidates, unit completions and xterm parse watermarks here.
      softwareCaretPort,
      // Echo classification for typing slides. Printable text counts (IME
      // commits and complete bracketed-paste payloads included — segmented
      // in source order, so mixed plain/paste events keep their original
      // sequence); arrows and function keys arrive as ESC sequences, control
      // combos and newlines as nonprintable barriers — their cursor echoes
      // are navigation, they keep the inversion slide, and they VOID every
      // input-side echo asset. Wired from the PTY input path, so this sees
      // local keystrokes even when the echo is remote.
      // A printable keystroke banks one echo credit per codepoint for the
      // software-caret path, warms the time window, and appends its
      // codepoints to the bounded ordered input queue that the exact
      // merged-input match consumes (see classifyMergedRunEcho).
      noteInput(data) {
        if (disposed || typeof data !== 'string') return;
        let enqueued = 0;
        for (const segment of segmentInputEvent(data)) {
          if (segment.kind === 'barrier') {
            clearInputEchoState();
            enqueued = 0;
            continue;
          }
          const chars = [];
          for (const ch of segment.text) if (isPrintableChar(ch)) chars.push(ch);
          if (chars.length) {
            enqueueInputChars(chars);
            enqueued += chars.length;
          }
        }
        if (enqueued > 0) {
          lastPrintableInputAt = clock();
          echoInputCredits = Math.min(ECHO_CREDIT_CAP, echoInputCredits + enqueued);
        }
      },
      setEnabled(value) {
        enabled = value !== false;
        snapBeforeNextDraw = true;
        diagnostic.held = false;
        scheduleContinuation();
      },
      setRenderScope(value) {
        renderScope = value === 'cursor' ? 'cursor' : 'full';
        snapBeforeNextDraw = true;
        scheduleContinuation();
      },
      setSmooth(value) {
        smoothEnabled = value !== false;
        if (!smoothEnabled) snapBeforeNextDraw = true;
        scheduleContinuation();
      },
      setCursorStyle(value) {
        if (value !== 'bar' && value !== 'block' && value !== 'underline') {
          throw new TypeError("cursor style must be 'bar', 'block' or 'underline'");
        }
        cursorStyle = value;
        terminal.options.cursorStyle = value;
        snapBeforeNextDraw = true;
        scheduleContinuation();
      },
      armFrameCapture(count) {
        const frames = Math.max(1, Math.min(MAX_CAPTURE_FRAMES, Math.floor(finite(count, 1))));
        diagnostic.remaining = frames;
        diagnostic.held = false;
        diagnostic.heldAt = 0;
        diagnostic.records = [];
        return frames;
      },
      releaseCapturedFrame() {
        if (!diagnostic.held) return false;
        const pausedFor = Math.max(0, clock() - diagnostic.heldAt);
        if (motion.animating) motion.startedAt += pausedFor;
        diagnostic.held = false;
        diagnostic.heldAt = 0;
        scheduleContinuation();
        return true;
      },
      cancelFrameCapture() {
        diagnostic.remaining = 0;
        diagnostic.held = false;
        diagnostic.heldAt = 0;
        scheduleContinuation();
      },
      // The viewport-relative 0-based cell the user currently perceives as
      // the caret: the trusted software descriptor when the adapter owns the
      // cursor, else null (a visible protocol cursor is stock-anchored by
      // xterm itself). Consumed by the IME caret anchor (ime-caret-anchor.js):
      // agent TUIs hide the protocol cursor for whole sessions, so the IME
      // candidate window must follow THIS position, not the hidden park.
      perceivedCaretCell() {
        if (disposed || !sw.active || !sw.published) return null;
        const x = sw.published.x;
        const y = sw.published.y;
        if (!(x >= 0 && x < terminal.cols && y >= 0 && y < terminal.rows)) return null;
        return { x, y, width: Math.max(1, finite(sw.published.width, 1)) };
      },
      snapshot() {
        return {
          enabled,
          smoothEnabled,
          reducedMotion: isReducedMotion(),
          cursorStyle,
          duration,
          jumpDistance,
          renderScope,
          target: instrumentation.target ? { ...instrumentation.target } : null,
          visual: instrumentation.visual ? { ...instrumentation.visual } : null,
          animationActive: motion.animating,
          frameId: instrumentation.frameId,
          // Frame-pacing evidence: ms gaps between the most recent cursor
          // draw passes. Sustained gaps > ~16ms during typing = dropped
          // animation frames — the difference between "animating" and
          // "animating smoothly" on the user's display.
          recentDrawGapMs: (() => {
            const ts = instrumentation.drawTimestamps;
            const gaps = [];
            for (let i = Math.max(1, ts.length - 30); i < ts.length; i += 1) {
              gaps.push(+(ts[i] - ts[i - 1]).toFixed(1));
            }
            return gaps;
          })(),
          counters: {
            baseDrawPasses: instrumentation.baseDrawPasses,
            cursorDrawPasses: instrumentation.cursorDrawPasses,
            rectangleDrawPasses: instrumentation.rectangleDrawPasses,
            glyphDrawPasses: instrumentation.glyphDrawPasses,
            stockSuppressedPasses: instrumentation.stockSuppressedPasses,
            continuationRequests: instrumentation.continuationRequests,
            echoSlides: instrumentation.echoSlides,
          },
          lastRectangle: instrumentation.lastRectangle,
          lastGlyph: instrumentation.lastGlyph,
          drawPassStatus: instrumentation.drawPassStatus,
          caretOwnership: {
            customDrawSource: instrumentation.customDrawSource,
            active: sw.active,
            queued: sw.enqueued,
            parsed: sw.watermark,
            generation: sw.generation,
            trustRun: sw.runStreak,
            reason: [
              'cell-overwritten', 'candidate-cell-mismatch', 'out-of-range', 'buffer-switch',
              'invalidate:scroll', 'invalidate:resize', 'invalidate:session-reset',
              'invalidate:observer:resize', 'invalidate:observer:unmodeled-coordinate-change',
            ].includes(instrumentation.softwareCaret?.reason) ? instrumentation.softwareCaret.reason : null,
          },
          scheduler: instrumentation.scheduler,
          presentationSemantics: instrumentation.presentationSemantics,
          retargets: instrumentation.retargets.map(function (record) {
            return { at: record.at, from: { ...record.from }, target: { ...record.target } };
          }),
          surface: surfaceState(),
          capture: {
            remaining: diagnostic.remaining,
            held: diagnostic.held,
            records: diagnostic.records.map(function (record) { return { ...record, target: { ...record.target }, visual: { ...record.visual } }; }),
          },
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        diagnostic.held = false;
        diagnostic.remaining = 0;
        renderer.renderRows = originalRenderRows;
        // terminal.options.cursorStyle is always the user's current style —
        // written by setCursorStyle or by the caller before retiring the
        // adapter (context loss) — so disposal must not roll it back.
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
        motion.dispose();
        renderer._requestRedrawViewport();
      },
      instrumentation,
      motion,
    };
    return adapter;
  }

  function trim(items, maximum) {
    if (items.length > maximum) items.splice(0, items.length - maximum);
  }

  root.createXtermWebglSmoothCursor = createXtermWebglSmoothCursor;
  root.__xtermSmoothCursorInternals = { createXtermWebglSmoothCursor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createXtermWebglSmoothCursor };
}(typeof globalThis !== 'undefined' ? globalThis : this));
