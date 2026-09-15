(function installXtermWebglSmoothCursor(root) {
  'use strict';

  const DEFAULT_DURATION = 90;
  const DEFAULT_JUMP_DISTANCE = 8;
  const MAX_TIMESTAMPS = 128;
  const MAX_CAPTURE_FRAMES = 12;
  const RGB_COLOR_MODE = 0x03000000;
  const EXTENDED_ATTR_FLAG = 0x10000000;

  function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
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
    const originalCursorStyle = terminal.options.cursorStyle;
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
      retargets: [],
      drawTimestamps: [],
      drawPassStatus: 'idle',
      scheduler: 'xterm-render-service',
      presentationSemantics: 'WebGL draw submission timestamps, not presented FPS',
    };
    const diagnostic = { remaining: 0, held: false, heldAt: 0, records: [] };
    let disposed = false;
    let enabled = options?.enabled !== false;
    let smoothEnabled = options?.smooth !== false;
    let cursorStyle = options?.cursorStyle === 'block' ? 'block' : 'bar';
    let continuationQueued = false;
    // Continuation render scope. 'full' = v3.2 behavior (re-render the whole
    // viewport on every animation frame). 'cursor' = re-render only the rows
    // the caret spans, which is 1-2 rows instead of ~30.
    let renderScope = options?.renderScope === 'cursor' ? 'cursor' : 'full';
    let lastDrawnRow = null;
    let snapBeforeNextDraw = true;
    let lastTarget = null;
    // v3 hidden-freeze state: elapsed time of the in-flight animation at the
    // last drawable (painted) frame, latched while the cursor is not drawable
    // so the hidden period never ages the animation anchor.
    let lastDrawElapsedMs = null;
    let frozenElapsedMs = null;

    // ── Software-caret takeover (ADR-0001 B2) ──
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
      generation: 0,            // coordinate-space epoch
      candidateGeneration: 0,
      bufferType: null,
      active: false,
      lastRestoreRow: null,
    };

    function revokeSoftware(reason) {
      if (!sw.active) return;
      sw.active = false;
      sw.runStreak = 0;
      sw.published = null;
      snapBeforeNextDraw = true;
      instrumentation.softwareCaret = { active: false, reason };
      // Clean the pure-visual restore overlay: re-render the row from the
      // (unmodified) buffer so the app's own caret cell shows again.
      const stale = sw.lastRestoreRow;
      sw.lastRestoreRow = null;
      if (stale !== null) {
        try { originalRenderRows.call(renderer, stale, stale); } catch (error) { /* mid-dispose */ }
      }
      scheduleContinuation();
    }

    const softwareCaretPort = {
      // Raw-stream candidate (pre-parse): queue until its watermark.
      candidate(cand) {
        if (disposed || !cand) return;
        sw.runStreak += 1;
        sw.pending = { ...cand };
        sw.candidateGeneration = sw.generation;
        sw.bufferType = terminal.buffer.active.type;
      },
      // Completed unit without a candidate: NEUTRAL unless it wrote to the
      // candidate cell (contradiction → revoke + reset trust). Interleaved
      // outer-TUI frames (herdr chrome, complete with its own SHOWs) are
      // the normal case inside an ink input session — protocol-cursor
      // gestures and software-caret existence are separate concerns
      // (ADR 4.4), so only cell-level contradiction breaks the run.
      unit(info) {
        if (disposed) return;
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
      // xterm parsed through chunk `seq` (term.write callback): publish the
      // pending candidate if its unit completed inside the parsed range.
      parsed(seq) {
        if (disposed) return;
        if (typeof seq === 'number' && seq > sw.watermark) sw.watermark = seq;
        if (sw.pending && sw.pending.chunkSeq <= sw.watermark && sw.candidateGeneration === sw.generation) {
          sw.published = sw.pending;
          sw.pending = null;
          if (sw.runStreak >= 2 && !sw.active) {
            sw.active = true;
            snapBeforeNextDraw = true; // source switch never flies from the protocol anchor
            instrumentation.softwareCaret = { active: true, since: clock() };
          }
          scheduleContinuation();
        }
      },
      invalidate(reason) {
        sw.generation += 1;
        revokeSoftware('invalidate:' + (reason || 'unknown'));
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
      try {
        originalRenderRows.call(renderer, start, end);
        instrumentation.baseDrawPasses += 1;
        if (ownsCursor) instrumentation.stockSuppressedPasses += 1;
      } finally {
        coreService.isCursorHidden = previousHidden;
      }

      if (!ownsCursor) {
        // v3 semantics (Ghostty/MaidKit alignment): while the cursor is not
        // drawable (hidden, unfocused, disabled...) the animation anchor is
        // frozen at the last visible position. Neither the motion state nor
        // the tracked target moves, so a later re-show slides from the frozen
        // position toward the new cursor cell instead of landing there.
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
      } else if (targetChanged) {
        motion.setTarget(cursorBeforeBase.x, cursorBeforeBase.y, at);
        instrumentation.retargets.push({
          at,
          from: { ...motion.from },
          target: { x: cursorBeforeBase.x, y: cursorBeforeBase.y },
        });
        trim(instrumentation.retargets, MAX_TIMESTAMPS);
      }
      lastTarget = { x: cursorBeforeBase.x, y: cursorBeforeBase.y };
      const visual = motion.tick(at);
      lastDrawElapsedMs = motion.animating ? Math.max(0, at - motion.startedAt) : null;
      // Narrow scope: the caret may have been painted on a row that xterm did
      // not mark dirty this frame, so clear that row first — otherwise a ghost
      // caret is left behind whenever the caret changes row. The software-
      // caret restore overlay needs the same treatment for its previous row.
      if (renderScope === 'cursor' && lastDrawnRow !== null) {
        const stale = Math.floor(lastDrawnRow);
        if (stale !== Math.floor(finite(visual?.y, stale))) {
          try {
            originalRenderRows.call(renderer, stale, stale);
          } catch (error) {
            /* mid-dispose: nothing to clear */
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
      instrumentation.drawPassStatus = cursorStyle === 'block' ? 'base+rectangle+glyph' : 'base+rectangle';

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
      // v3.2: drive animation frames directly — one rAF, one synchronous
      // renderRows. The previous path (rAF → _requestRedrawViewport → the
      // render debouncer's own rAF) landed a draw only every other display
      // frame (~7 draws per 90ms slide at 144Hz); a direct per-vsync render
      // restores the full ~13, matching MaidKit's Flutter Ticker pacing.
      // Fallbacks keep non-browser (test) environments on the old microtask
      // path, where synthetic clocks cannot pump real timers.
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
              const current = Math.floor(finite(motion.position?.y, 0));
              const previous = lastDrawnRow === null ? current : Math.floor(lastDrawnRow);
              const from = Math.max(0, Math.min(previous, current));
              const to = Math.min(terminal.rows - 1, Math.max(previous, current));
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
      // Software-caret source (ADR-0001 B2): when a trusted, watermark-
      // matched descriptor exists, IT defines the drawn cursor. DECTCEM is
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
        let cellIntact = false;
        if (inRange) {
          try {
            const line = terminal._core?.buffer?.lines?.get(absoluteY);
            const cell = renderer._workCell;
            if (line && cell && typeof line.loadCell === 'function') {
              line.loadCell(sw.published.x, cell);
              cellIntact = cell.getChars() === sw.published.char;
            }
          } catch (error) { cellIntact = false; }
        }
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
      const widthCells = cursorStyle === 'block' ? cursor.width : 1;
      const widthPx = cursorStyle === 'block'
        ? widthCells * dimensions.cell.width
        : renderer._devicePixelRatio * terminal.options.cursorWidth;
      const temporaryVertices = { attributes: new Float32Array(32), count: 1 };
      const previousVertices = rectangle._verticesCursor;
      rectangle._verticesCursor = temporaryVertices;
      try {
        rectangle._addRectangleFloat(
          temporaryVertices.attributes,
          0,
          visual.x * dimensions.cell.width,
          visual.y * dimensions.cell.height,
          widthPx,
          dimensions.cell.height,
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
      if (cursorStyle === 'block') drawBlockGlyph(cursor, visual, glyph);
    }

    function drawBlockGlyph(cursor, visual, glyph) {
      const line = terminal._core?.buffer?.lines?.get(cursor.absoluteY);
      const cell = renderer._workCell;
      if (!line || !cell || typeof line.loadCell !== 'function') return;
      line.loadCell(cursor.x, cell);
      const code = cell.getCode();
      const chars = cell.getChars();
      if (!code || !chars) {
        instrumentation.lastGlyph = { drawn: false, x: visual.x, y: visual.y, chars: '' };
        return;
      }

      const colors = renderer._themeService.colors;
      const cursorBackground = RGB_COLOR_MODE | (colors.cursor.rgba >>> 8 & 0x00ffffff);
      const cursorForeground = RGB_COLOR_MODE | (colors.cursorAccent.rgba >>> 8 & 0x00ffffff);
      const ext = cell.bg & EXTENDED_ATTR_FLAG ? cell.extended.ext : 0;
      const previousVertices = glyph._vertices;
      const previousActiveBuffer = glyph._activeBuffer;
      const temporaryVertices = {
        count: 11,
        attributes: new Float32Array(11),
        attributesBuffers: [new Float32Array(11), new Float32Array(11)],
      };
      glyph._vertices = temporaryVertices;
      try {
        glyph._updateCell(
          temporaryVertices.attributes,
          0,
          0,
          code,
          cursorBackground,
          cursorForeground,
          ext,
          chars,
          cell.bg,
        );
        temporaryVertices.attributes[9] = visual.x / terminal.cols;
        temporaryVertices.attributes[10] = visual.y / terminal.rows;
        glyph.render({ lineLengths: [1] });
        instrumentation.glyphDrawPasses += 1;
        instrumentation.lastGlyph = {
          drawn: true,
          x: visual.x,
          y: visual.y,
          chars,
          code,
          attributes: Array.from(temporaryVertices.attributes),
        };
      } finally {
        glyph._vertices = previousVertices;
        glyph._activeBuffer = previousActiveBuffer;
      }
    }

    // Paint the software-caret cell's non-caret appearance: a theme-
    // background rectangle over the app's truecolor-styled caret cell. This
    // is the verified restore convention (the app writes the same cell with
    // default colors when its caret is elsewhere) expressed as draw-time
    // overlay — the buffer keeps the app's bytes untouched.
    function drawRestoreCell(cursor) {
      const rectangle = renderer._rectangleRenderer.value;
      if (!rectangle || rectangle._gl !== renderer._gl) return;
      const dimensions = renderer.dimensions.device;
      const colors = renderer._themeService.colors;
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
      // ADR-0001 B2 port: the raw-stream observer (wired in ipc.js) reports
      // candidates, unit completions and xterm parse watermarks here.
      softwareCaretPort,
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
        if (value !== 'bar' && value !== 'block') throw new TypeError("cursor style must be 'bar' or 'block'");
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
          },
          lastRectangle: instrumentation.lastRectangle,
          lastGlyph: instrumentation.lastGlyph,
          drawPassStatus: instrumentation.drawPassStatus,
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
        if (terminal.options.cursorStyle !== originalCursorStyle) terminal.options.cursorStyle = originalCursorStyle;
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
