// Ink software-caret observer (ADR-0001 B2). A bounded, observe-only
// streaming recognizer that runs on the RAW terminal stream (before any
// rewriting) and produces per-presentation-unit caret CANDIDATES. It never
// modifies bytes and never touches the xterm buffer; candidates only become
// a drawn cursor after the adapter's watermark/generation checks pass.
//
// Two verified client grammars (real pre-filter captures on 41.88):
//
// 1. Sync-unit form (2026-09-15 B0 fixtures, older dsh-tui/kimi builds via
//    herdr): inside a synchronized-output unit (?2026h … ?2026l) the app
//    writes the input line as
//      CUP(row;col) SGR(0;39;49) <plain char(s)> SGR(0;38;2;FG;48;2;BG) <char> SGR(0) CUP(...) ?25l
//    The caret cell is the truecolor fg+bg styled single character written
//    at the CURRENT cursor position. The trailing CUP may point at the
//    caret cell or past it and is deliberately NOT used for coordinates
//    (ADR C5: never fake the software position from the protocol park).
//
// 2. Frame form (2026-09-15 gap captures — the CURRENT dsh-tui/kimi builds,
//    SSH-direct, local and herdr-relayed alike): the app emits one minimal
//    frame per keystroke:
//      SGR(0) OSC8-end HOME <relative moves> SGR(7) <char> SGR(27) [plain] CUP(24;1) CUP(row;col)
//    The caret is the REVERSE-VIDEO single character (SGR 7 … 27) written at
//    its exact write position. The frame is delimited by the literal prefix
//    SGR(0)+OSC8-end+HOME and completes at the first absolute CUP AFTER the
//    caret write (the app's park); the park position itself is never used
//    for coordinates. Mouse/DA/DECRQM query bursts (incl. ?1049$p, ESC[c)
//    appear between/after frames and are tolerated as non-movement queries.
//
// A visible-protocol sync variant additionally proves HIDE before the cell
// and a final explicit CUP/HVP back to that cell, then SHOW and SYNC_END.
// Decidability limits: any other unit containing SHOW, an unmodeled
// cursor-movement sequence, MULTIPLE styled caret candidates, or plain
// writes whose attributes contradict the verified convention produces NO
// candidate — the adapter then shows raw display. Per ADR 4.4 this module
// is the ONLY place pattern knowledge lives; it gates nothing by name.
(function installInkCaretObserver(root) {
  'use strict';

  const ESC = '\u001b';
  const SYNC_BEGIN = '\u001b[?2026h';
  const SYNC_END = '\u001b[?2026l';
  const SHOW = '\u001b[?25h';
  const SGR_RESET = '\u001b[0m';
  const HOME = '\u001b[H';
  const OSC8_END_BEL = '\u001b]8;;\u0007';
  const OSC8_END_ST = '\u001b]8;;\u001b\\';
  // Captured keyboard-protocol controls/queries do not position the cursor.
  const NON_POSITIONING_CONTROLS = new Set(['\u001b[>7u', '\u001b[?u', '\u001b[?996n', '\u001b[>4;2m']);
  // Bounded state: a unit longer than this is not an input-line update.
  const MAX_UNIT_BYTES = 262144;

  // Width of a character in cells (best-effort, consistent for the verified
  // clients: ASCII and common CJK ranges).
  function charWidth(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1100 && (
      cp <= 0x115f || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )) return 2;
    return 1;
  }

  function createInkCaretObserver(options) {
    const onCandidate = typeof options?.onCandidate === 'function' ? options.onCandidate : null;
    const onUnit = typeof options?.onUnit === 'function' ? options.onUnit : null;
    const onInvalidate = typeof options?.onInvalidate === 'function' ? options.onInvalidate : null;

    let buffer = '';
    let inSync = false;
    let unitMode = null;    // 'sync' | 'frame' while a unit is open
    let unitSeq = 0;        // completed units
    let chunkSeq = 0;       // chunks fed (watermark binding granularity)
    let frameUnits = 0;     // completed frame-form units (diagnostics)
    // Cursor model inside the current unit (1-based row/col like CUP).
    let row = 1, col = 1;
    // Screen geometry for VT scroll/wrap semantics (the ConPTY sync form
    // addresses units RELATIVELY, so its rows depend on bottom-stick
    // scrolling and autowrap actually being modeled). Defaults are replaced
    // by the live terminal size at wiring time (ipc.js).
    let rows = Math.max(2, Math.floor(options?.rows) || 24);
    let cols = Math.max(2, Math.floor(options?.cols) || 80);
    let pendingWrap = false;
    let positionKnown = true;
    let positionReason = null;
    let checkpointReason = null;
    let recoveries = 0;
    // The captured bare repaint returns from a lower parked row with
    // CR, horizontal positioning, then CUU. A lone reverse highlight is
    // insufficient evidence, regardless of how often it is repeated.
    let barePositionStep = 0;
    // Per-unit recognition state.
    let unit = null;
    // Last two escape sequences, for the frame-form prefix pattern
    // (SGR0 + OSC8-end + HOME must be adjacent; printables break it).
    let seqBack1 = '';
    let seqBack2 = '';

    function lineFeed() {
      // LF at the bottom row scrolls the viewport: the cursor STICKS to the
      // bottom instead of moving past it.
      row = row >= rows ? rows : row + 1;
      pendingWrap = false;
    }

    function clampMove() {
      if (row > rows) row = rows;
      if (row < 1) row = 1;
      if (col > cols) col = cols;
      if (col < 1) col = 1;
      pendingWrap = false;
    }

    function losePosition(reason = 'unmodeled-coordinate-change') {
      positionKnown = false;
      positionReason = reason;
      barePositionStep = 0;
      bareRev.valid = false;
      if (unit) unit.ambiguous = true;
      if (onInvalidate) onInvalidate(reason);
    }

    function resetUnit() {
      unit = null;
      unitMode = null;
    }

    function beginUnit(mode) {
      inSync = mode === 'sync';
      unitMode = mode;
      // NOTE: row/col are NOT reset here — cursor position is continuous
      // stream state. Absolute anchors (CUP/HOME) realign it; the ConPTY
      // sync form (verified 2026-09-15 local kimi capture) addresses its
      // units purely relatively (\r + EL + writes).
      unit = {
        sawShow: false,
        showCount: 0,
        hidden: false,
        hiddenAtCaret: false,
        visibleTail: 0,       // 1: matching explicit anchor, 2: final SHOW
        visibleTailInvalid: false,
        ambiguous: false,
        plainAttrOk: true,
        sawPlain: false,
        caret: null,          // {row, col, ch, width, fg, bg, rev}
        writes: [],           // [row, col] per printable cell (bounded)
        bytes: 0,
      };
    }

    function finishUnit(text) {
      const mode = unitMode;
      if (mode === 'frame') frameUnits += 1;
      inSync = false;
      unitSeq += 1;
      const info = {
        unitSeq,
        chunkSeq,           // the chunk the unit COMPLETED in (watermark)
        hadCandidate: false,
        sawShow: unit ? unit.sawShow : false,
        wrote: unit ? unit.writes : [], // cells this unit wrote (keep/revoke evidence)
      };
      const confirmedVisible = unit && mode === 'sync' && text === SYNC_END
        && unit.visibleTail === 2 && !unit.visibleTailInvalid && unit.showCount === 1
        && unit.hiddenAtCaret && unit.caret && !unit.caret.rev && unit.caret.width === 1;
      if (unit && positionKnown && !unit.ambiguous && (!unit.sawShow || confirmedVisible) && unit.caret && unit.sawPlain
        // The plain-attr convention gate applies to the TRUECOLOR grammar
        // only (its restore evidence is the default-attr convention). The
        // reverse-caret grammars (SSH frame form, ConPTY sync form) carry
        // verified fg-only decorations (borders, hints) in the same unit;
        // those never masquerade as carets, so they do not void the unit.
        && (unit.caret.rev || unit.plainAttrOk)) {
        info.hadCandidate = true;
        const c = unit.caret;
        const cand = {
          unitSeq,
          chunkSeq,
          x: c.col - 1,     // 0-based screen cell
          y: c.row - 1,
          char: c.ch,
          width: c.width,
          fg: c.fg,
          bg: c.bg,
          style: c.rev ? 'reverse' : 'truecolor',
          restoreSgr: c.rev ? '0' : '0;39;49', // verified app convention (same-unit evidence)
        };
        if (confirmedVisible) cand.confirmedVisibleSync = true;
        if (onCandidate) onCandidate(cand);
      }
      if (onUnit) onUnit(info);
      resetUnit();
      return text;
    }

    // Minimal SGR tracker: we only need "truecolor fg AND bg both set" for
    // the sync-form caret signature, SGR 7/27 reverse for the frame-form
    // signature, and "default colors" for the plain convention.
    let sgr = { fg: null, bg: null, isDefault: true, rev: false };

    // Bare reverse-caret gesture (claude code form, verified 2026-09-15 rig
    // capture): NO sync blocks and NO frame prefix — the app just emits
    //   <relative moves> SGR(7) <char> SGR(27) <CR/LF tail>
    // per keystroke, addressed purely relatively. The self-terminating
    // signature is rev-ON, EXACTLY ONE printable, rev-OFF: multi-char rev
    // runs (menu selection, highlights) never qualify. The candidate binds
    // to the chunk containing the gesture (that chunk parsing implies the
    // caret cell exists in the buffer); keep/revoke evidence comes from the
    // adapter's per-draw cell-intact check, not from unit bookkeeping.
    let bareRev = { on: false, valid: false, count: 0, char: null };

    function bareRevTurnOn() {
      bareRev = {
        on: true,
        valid: positionKnown && barePositionStep === 3 && sgr.isDefault && sgr.fg === null && sgr.bg === null,
        count: 0,
        char: null,
      };
      barePositionStep = 0;
    }

    function bareRevTurnOff() {
      if (bareRev.on && bareRev.valid && positionKnown && !unit && bareRev.count === 1 && bareRev.char) {
        unitSeq += 1; // pseudo-unit ordinal for this gesture
        const c = bareRev.char;
        if (onCandidate) onCandidate({
          unitSeq,
          chunkSeq,
          x: c.col - 1,
          y: c.row - 1,
          char: c.ch,
          width: c.width,
          fg: null,
          bg: null,
          style: 'reverse',
          restoreSgr: '0',
        });
      }
      bareRev = { on: false, valid: false, count: 0, char: null };
    }

    function applySgr(params) {
      const ps = params === '' ? [] : params.split(';').map(p => parseInt(p, 10) || 0);
      let i = 0;
      const next = { fg: sgr.fg, bg: sgr.bg, isDefault: sgr.isDefault, rev: sgr.rev };
      while (i < ps.length) {
        const p = ps[i];
        if (p === 0) {
          if (sgr.rev) bareRevTurnOff();
          next.fg = null; next.bg = null; next.isDefault = true; next.rev = false;
        }
        else if (p === 38 && ps[i + 1] === 2) {
          next.fg = `${ps[i + 2]};${ps[i + 3]};${ps[i + 4]}`; next.isDefault = false; i += 4;
        } else if (p === 48 && ps[i + 1] === 2) {
          next.bg = `${ps[i + 2]};${ps[i + 3]};${ps[i + 4]}`; next.isDefault = false; i += 4;
        } else if (p === 39) { next.fg = null; }           // default fg selector
        else if (p === 49) { next.bg = null; }             // default bg selector
        else if (p === 7) { bareRevTurnOn(); next.rev = true; }  // reverse video: tracked separately
        else if (p === 27) { bareRevTurnOff(); next.rev = false; } // reverse off restores the plain convention
        else { next.isDefault = false; }                    // any other attribute
        i += 1;
      }
      sgr = next;
    }

    function handleSequence(seq) {
      // Once the explicit confirmation tail starts, only SHOW then normal
      // SYNC_END may follow. Later writes, movement or controls invalidate it.
      if (unit && unit.visibleTail) {
        if (unit.visibleTail === 1 && seq === SHOW) unit.visibleTail = 2;
        else if (!(unit.visibleTail === 2 && seq === SYNC_END)) unit.visibleTailInvalid = true;
      }
      // Frame-form prefix detection first: HOME directly after an OSC8-end
      // that directly follows SGR0 opens a new frame unit (closing whatever
      // unit was still open — a boundary is a boundary).
      const frameStart = seq === HOME
        && (seqBack1 === OSC8_END_BEL || seqBack1 === OSC8_END_ST)
        && seqBack2 === SGR_RESET;
      seqBack2 = seqBack1;
      seqBack1 = seq;
      if (frameStart) {
        if (unit) finishUnit(seq);
        // The HOME of the frame prefix also POSITIONS the cursor (its
        // assignment is skipped by this early return, and units no longer
        // reset coordinates).
        row = 1; col = 1;
        clampMove();
        positionKnown = true;
        positionReason = null;
        checkpointReason = null;
        barePositionStep = 0;
        beginUnit('frame');
        return;
      }
      if (seq === SYNC_BEGIN) {
        if (unit) finishUnit(seq);
        beginUnit('sync');
        return;
      }
      if (seq === SYNC_END) { finishUnit(seq); return; }
      if (seq === SHOW) {
        if (unit) { unit.sawShow = true; unit.showCount += 1; unit.hidden = false; }
        return;
      }
      if (seq === '\u001b[?25l') { if (unit) unit.hidden = true; return; }
      if (seq === '\u001b(B' || NON_POSITIONING_CONTROLS.has(seq)) return;
      // String sequences (OSC/DCS/etc., e.g. the OSC8 hyperlinks every ink
      // frame carries) do not move the cursor — ignore them. ESC 7/8
      // (save/restore cursor) DO move it and are not modeled — ambiguous.
      const second = seq.charAt(1);
      if (second !== '[') {
        if (seq === '\u001b7' || seq === '\u001b8') {
          losePosition();
        } else if (seq === '\u001bM') {
          // RI: one row up, clamped at the top (no scroll) — modeled because
          // position is continuous state; a stray unmodeled move would skew
          // every later candidate row.
          row = Math.max(1, row - 1); pendingWrap = false;
        } else if (seq === '\u001bD') {
          lineFeed(); // IND: one row down with bottom-stick scroll
        } else if (seq === '\u001bE') {
          lineFeed(); col = 1; // NEL: next line
        } else if (!(']P^_'.includes(second))) {
          losePosition();
        }
        return;
      }
      // SGR is STREAM-GLOBAL state (a real terminal's attributes persist
      // across frames): track it even between units. Without this, the
      // frame-form prefix's SGR(0) — which arrives BEFORE the unit opens —
      // never clears a previous frame's attribute pollution, and the next
      // caret frame's plain restore writes then fail the plain convention.
      const mEarly = /^\u001b\[([0-9;]*)(m)$/.exec(seq);
      if (mEarly) { applySgr(mEarly[1]); return; }
      // CSI params may include private markers (0x3C-0x3F: ? < = >) and the
      // DECRQM intermediate '$' — e.g. ?25l, ?1000h or the ?1049$p query the
      // frame form emits per keystroke. Private h/l/p never move the cursor.
      const m = /^\u001b\[([0-9;?<=>$]*)([A-Za-z])$/.exec(seq);
      if (!m) { losePosition(); return; }
      const params = m[1];
      const fin = m[2];
      const priv = params.indexOf('?') >= 0 || params.indexOf('<') >= 0 || params.indexOf('=') >= 0 || params.indexOf('>') >= 0 || params.indexOf('$') >= 0;
      if (priv) {
        if (fin === 'p') return; // DECRQM queries do not change the screen.
        if (fin === 'h' || fin === 'l') {
          if (params.split(';').some(p => /^(?:\?)?(?:6|7|47|1047|1048|1049)$/.test(p))) losePosition();
          return;
        }
        losePosition();
        return;
      }
      const n = params === '' ? 1 : (parseInt(params.split(';')[0], 10) || 1);
      // Cursor-affecting finals move the cursor REGARDLESS of unit state —
      // position is continuous stream state, and the ConPTY sync form
      // addresses its units purely relatively. Erases/modes/queries below
      // this block never move the cursor.
      if (fin === 'H' || fin === 'f') {
        const parts = params.split(';');
        row = parts[0] === '' ? 1 : (parseInt(parts[0], 10) || 1);
        col = parts[1] === '' ? 1 : (parseInt(parts[1], 10) || 1);
        clampMove();
        positionKnown = true;
        positionReason = null;
        checkpointReason = null;
        barePositionStep = 0;
        if (unitMode === 'sync' && unit && unit.caret && !unit.visibleTail
          && /^[1-9]\d*;[1-9]\d*$/.test(params)
          && row === unit.caret.row && col === unit.caret.col
          && sgr.isDefault && !sgr.rev && sgr.fg === null && sgr.bg === null) {
          unit.visibleTail = 1;
        }
        // Frame-form completion: the first absolute park AFTER a caret
        // write closes the frame (the app's park pair 24;1 → row;col).
        // Positions were latched at write time; the park is a terminator,
        // never a coordinate source (ADR C5).
        if (unitMode === 'frame' && unit && unit.caret) finishUnit(seq);
        return;
      }
      if (fin === 'A') { row = Math.max(1, row - n); clampMove(); if (barePositionStep === 2) barePositionStep = 3; return; }
      if (fin === 'B') { row += n; clampMove(); return; }
      if (fin === 'C') { col += n; clampMove(); if (barePositionStep === 1) barePositionStep = 2; return; }
      if (fin === 'D') { col = Math.max(1, col - n); clampMove(); return; }
      if (fin === 'G') { col = params === '' ? 1 : (parseInt(params, 10) || 1); clampMove(); return; }
      if (fin === 'd') { row = params === '' ? 1 : (parseInt(params, 10) || 1); clampMove(); return; }
      if (fin === 'J' || fin === 'K') return; // erases do not move the cursor
      if (fin === 'h' || fin === 'l') return; // mode set/reset (e.g. ?25l) — no movement
      if (fin === 'c') return; // DA1 query — no movement
      losePosition(); // Unmodeled movement also invalidates bare gestures.
    }

    function handlePrintable(text) {
      if (unit && unit.visibleTail && text.length) unit.visibleTailInvalid = true;
      // Printables break the frame-prefix adjacency window.
      seqBack1 = '';
      seqBack2 = '';
      for (const ch of text) {
        // Cursor-affecting control characters are stream-global (same
        // continuity rule as the movement finals above).
        if (ch === '\r') { col = 1; pendingWrap = false; barePositionStep = 1; continue; }
        if (ch === '\n') { lineFeed(); continue; }
        if (ch === '\b') { col = Math.max(1, col - 1); pendingWrap = false; continue; }
        if (ch === '\t' || ch === '\v' || ch === '\f') {
          // HT/VT/FF move the cursor in xterm; not modeled → ambiguous
          // (a wrong-position candidate is worse than none).
          losePosition();
          pendingWrap = false;
          continue;
        }
        if (ch === '\u007f') continue; // DEL: xterm ignores it, no column advance
        if (ch < ' ') continue; // other C0 inside a unit: ignore
        // DECAWM: a char written in the pending-wrap state wraps to the next
        // line first (with bottom-stick scrolling).
        if (pendingWrap) { lineFeed(); col = 1; }
        if (!unit) { // printable outside a unit still advances the cursor
          const w0 = charWidth(ch);
          if (bareRev.on) {
            bareRev.count += 1;
            if (bareRev.count === 1) bareRev.char = { row, col, ch, width: w0 };
          }
          col += w0;
          if (col > cols) { col = cols; pendingWrap = true; }
          continue;
        }
        // The caret signature is a SINGLE styled character; runs of text
        // just advance the cursor.
        const w = charWidth(ch);
        if (unit.writes.length < 16384) unit.writes.push([row - 1, col - 1]); // 0-based, matches descriptor coords
        const truecolorCaret = sgr.fg !== null && sgr.bg !== null && !sgr.isDefault;
        const reverseCaret = sgr.rev;
        if (truecolorCaret || reverseCaret) {
          // Caret-signature styled single char at the current position.
          if (unit.caret) unit.ambiguous = true; // multiple carets in one unit
          else {
            unit.hiddenAtCaret = unit.hidden;
            unit.caret = { row, col, ch, width: w, fg: sgr.fg, bg: sgr.bg, rev: reverseCaret && !truecolorCaret };
          }
        } else {
          unit.sawPlain = true;
          if (!sgr.isDefault) unit.plainAttrOk = false; // plain writes must use the default convention
        }
        col += w;
        if (col > cols) { col = cols; pendingWrap = true; }
      }
    }

    // Sequence scanner (CSI grammar, same shape as conpty-caret's readSequence).
    function readSequence(text, from) {
      const next = text.charAt(from + 1);
      if (next === '[') {
        let j = from + 2;
        while (j < text.length) {
          const code = text.charCodeAt(j);
          if (code >= 0x30 && code <= 0x3f) { j += 1; continue; }
          break;
        }
        while (j < text.length) {
          const code = text.charCodeAt(j);
          if (code >= 0x20 && code <= 0x2f) { j += 1; continue; }
          break;
        }
        if (j >= text.length) return null;
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) return { end: j + 1 };
        return { end: -1 };
      }
      if (next === ']' || next === 'P' || next === '^' || next === '_') {
        for (let j = from + 2; j < text.length; j += 1) {
          if (text.charCodeAt(j) === 0x07) return { end: j + 1 };
          if (text.charAt(j) === ESC && text.charAt(j + 1) === '\\') return { end: j + 2 };
        }
        return null;
      }
      // SCS includes a designator after ESC (, e.g. ESC ( B for ASCII.
      // Consuming just ESC ( would incorrectly advance for the final B.
      if (next === '(' || next === ')') {
        return text.length - from < 3 ? null : { end: from + 3 };
      }
      if (text.length - from < 2) return null;
      return { end: from + 2 };
    }

    function push(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return { unitSeq, chunkSeq };
      chunkSeq += 1;
      buffer += chunk;
      let index = 0;
      while (index < buffer.length) {
        const esc = buffer.indexOf(ESC, index);
        if (esc < 0) {
          handlePrintable(buffer.slice(index));
          index = buffer.length;
          break;
        }
        if (esc > index) handlePrintable(buffer.slice(index, esc));
        const seq = readSequence(buffer, esc);
        if (!seq) { index = esc; break; }             // incomplete: wait
        if (seq.end === -1) {                          // malformed: skip ESC
          handlePrintable(buffer.charAt(esc));
          index = esc + 1;
          continue;
        }
        handleSequence(buffer.slice(esc, seq.end));
        index = seq.end;
        if (unit && (unit.bytes += seq.end - esc) > MAX_UNIT_BYTES) unit.ambiguous = true;
      }
      buffer = buffer.slice(index);
      if (buffer.length > MAX_UNIT_BYTES) { buffer = ''; } // liveness valve
      return { unitSeq, chunkSeq };
    }

    return {
      push,
      checkpoint(point) {
        // A parsed checkpoint repairs only future gestures. Never certify a
        // candidate whose prefix was observed with an unknown origin.
        if (positionKnown) return false;
        checkpointReason = null;
        if (!point || point.seq !== chunkSeq) { checkpointReason = 'stale-watermark'; return false; }
        if (buffer || unit || inSync || bareRev.on) { checkpointReason = 'open-lexical-unit'; return false; }
        if (point.safe !== true) { checkpointReason = 'unsupported-parser-state'; return false; }
        if (!sgr.isDefault || sgr.fg !== null || sgr.bg !== null || sgr.rev) { checkpointReason = 'non-default-style'; return false; }
        if (point.rows !== rows || point.cols !== cols || !Number.isInteger(point.x) || !Number.isInteger(point.y)
          || point.x < 0 || point.x > cols || point.y < 0 || point.y >= rows) {
          checkpointReason = 'invalid-geometry'; return false;
        }
        row = point.y + 1;
        col = Math.min(point.x + 1, cols);
        pendingWrap = point.x === cols;
        barePositionStep = 0;
        positionKnown = true;
        positionReason = null;
        recoveries += 1;
        return true;
      },
      // Keep the scroll/wrap model in sync with the live terminal geometry
      // (resize also bumps the adapter generation, so stale candidates die).
      setSize: function (nextRows, nextCols) {
        if ((Number.isFinite(nextRows) && nextRows >= 2 && nextRows !== rows)
          || (Number.isFinite(nextCols) && nextCols >= 2 && nextCols !== cols)) losePosition('resize');
        if (Number.isFinite(nextRows) && nextRows >= 2) rows = Math.floor(nextRows);
        if (Number.isFinite(nextCols) && nextCols >= 2) cols = Math.floor(nextCols);
      },
      state: function () {
        return {
          unitSeq, chunkSeq, inSync, frameUnits,
          pendingCandidate: !!(unit && unit.caret && !unit.ambiguous),
          positionKnown, positionReason, checkpointReason, recoveries,
        };
      },
    };
  }

  const api = { createInkCaretObserver, charWidth };
  root.createInkCaretObserver = createInkCaretObserver;
  root.__inkCaretObserverInternals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
