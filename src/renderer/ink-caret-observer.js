// Ink software-caret observer (ADR-0001 B2). A bounded, observe-only
// streaming recognizer that runs on the RAW terminal stream (before any
// rewriting) and produces per-presentation-unit caret CANDIDATES. It never
// modifies bytes and never touches the xterm buffer; candidates only become
// a drawn cursor after the adapter's watermark/generation checks pass.
//
// Verified client grammar (real pre-filter captures, herdr+dsh-tui and
// herdr+kimi on 41.88, tests/fixtures/*b0*): inside a synchronized-output
// unit the app writes the input line as
//   CUP(row;col) SGR(0;39;49) <plain char(s)> SGR(0;38;2;FG;48;2;BG) <char> SGR(0) CUP(...) ?25l
// The caret cell is the truecolor fg+bg styled single character written at
// the CURRENT cursor position (a space at end-of-line, the underlying
// character during navigation/deletion); the app's own non-caret convention
// for the same cells is SGR(0;39;49) — that verified convention is the only
// "recoverable appearance" evidence used. The trailing CUP may point at the
// caret cell or past it and is deliberately NOT used for coordinates
// (ADR C5: never fake the software position from the protocol park).
//
// Decidability limits: any unit containing a genuine SHOW, an unmodeled
// cursor-movement sequence, multiple caret cells, or plain writes whose
// attributes do not match the verified convention produces NO candidate —
// the adapter then shows raw display. Per ADR 4.4 this module is the ONLY
// place pattern knowledge lives; it gates nothing by process name.
(function installInkCaretObserver(root) {
  'use strict';

  const ESC = '\u001b';
  const SYNC_BEGIN = '\u001b[?2026h';
  const SYNC_END = '\u001b[?2026l';
  const SHOW = '\u001b[?25h';
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

    let buffer = '';
    let inSync = false;
    let unitSeq = 0;        // completed units
    let chunkSeq = 0;       // chunks fed (watermark binding granularity)
    // Cursor model inside the current unit (1-based row/col like CUP).
    let row = 1, col = 1;
    // Per-unit recognition state.
    let unit = null;

    function resetUnit() {
      unit = null;
    }

    function beginUnit() {
      inSync = true;
      row = 1; col = 1;
      unit = {
        sawShow: false,
        ambiguous: false,
        plainAttrOk: true,
        sawPlain: false,
        caret: null,          // {row, col, ch, width, fg, bg}
        writes: [],           // [row, col] per printable cell (bounded)
        bytes: 0,
      };
    }

    function finishUnit(text) {
      inSync = false;
      unitSeq += 1;
      const info = {
        unitSeq,
        chunkSeq,           // the chunk the unit COMPLETED in (watermark)
        hadCandidate: false,
        sawShow: unit ? unit.sawShow : false,
        wrote: unit ? unit.writes : [], // cells this unit wrote (keep/revoke evidence)
      };
      if (unit && !unit.ambiguous && !unit.sawShow && unit.caret && unit.sawPlain && unit.plainAttrOk) {
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
          restoreSgr: '0;39;49', // verified app convention (same-unit evidence)
        };
        if (onCandidate) onCandidate(cand);
      }
      if (onUnit) onUnit(info);
      resetUnit();
      return text;
    }

    // Minimal SGR tracker: we only need "truecolor fg AND bg both set" for
    // the caret signature and "default colors" for the plain convention.
    let sgr = { fg: null, bg: null, isDefault: true, any: false };

    function applySgr(params) {
      const ps = params === '' ? [] : params.split(';').map(p => parseInt(p, 10) || 0);
      let i = 0;
      const next = { fg: sgr.fg, bg: sgr.bg, isDefault: sgr.isDefault, any: true };
      while (i < ps.length) {
        const p = ps[i];
        if (p === 0) { next.fg = null; next.bg = null; next.isDefault = true; }
        else if (p === 38 && ps[i + 1] === 2) {
          next.fg = `${ps[i + 2]};${ps[i + 3]};${ps[i + 4]}`; next.isDefault = false; i += 4;
        } else if (p === 48 && ps[i + 1] === 2) {
          next.bg = `${ps[i + 2]};${ps[i + 3]};${ps[i + 4]}`; next.isDefault = false; i += 4;
        } else if (p === 39) { next.fg = null; }           // default fg selector
        else if (p === 49) { next.bg = null; }             // default bg selector
        else { next.isDefault = false; }                    // any other attribute
        i += 1;
      }
      sgr = next;
    }

    function handleSequence(seq) {
      // seq is the full escape sequence text starting with ESC.
      if (seq === SYNC_BEGIN) { beginUnit(); return; }
      if (seq === SYNC_END) { finishUnit(seq); return; }
      if (seq === SHOW) { if (unit) unit.sawShow = true; return; }
      // String sequences (OSC/DCS/etc., e.g. the OSC8 hyperlinks every ink
      // frame carries) do not move the cursor — ignore them. ESC 7/8
      // (save/restore cursor) DO move it and are not modeled — ambiguous.
      const second = seq.charAt(1);
      if (second !== '[') {
        if (seq === '\u001b7' || seq === '\u001b8') {
          if (inSync && unit) unit.ambiguous = true;
        }
        return;
      }
      if (!inSync || !unit) return; // between units: not modeled, fine
      // CSI params may include private markers (0x3C-0x3F: ? < = >), e.g.
      // the ?25l inside every ink unit — excluding them marked all real
      // units ambiguous. Private 'h'/'l' modes never move the cursor.
      const m = /^\u001b\[([0-9;?<=>]*)([A-Za-z])$/.exec(seq);
      if (!m) { unit.ambiguous = true; return; }
      const params = m[1];
      const fin = m[2];
      const priv = params.indexOf('?') >= 0 || params.indexOf('<') >= 0 || params.indexOf('=') >= 0 || params.indexOf('>') >= 0;
      if (priv) {
        if (fin === 'h' || fin === 'l') return; // DEC private modes: no movement
        unit.ambiguous = true;
        return;
      }
      const n = params === '' ? 1 : (parseInt(params.split(';')[0], 10) || 1);
      switch (fin) {
        case 'H': case 'f': {
          const parts = params.split(';');
          row = parts[0] === '' ? 1 : (parseInt(parts[0], 10) || 1);
          col = parts[1] === '' ? 1 : (parseInt(parts[1], 10) || 1);
          return;
        }
        case 'A': row = Math.max(1, row - n); return;
        case 'B': row += n; return;
        case 'C': col += n; return;
        case 'D': col = Math.max(1, col - n); return;
        case 'G': col = params === '' ? 1 : (parseInt(params, 10) || 1); return;
        case 'd': row = params === '' ? 1 : (parseInt(params, 10) || 1); return;
        case 'J': case 'K': return; // erases do not move the cursor
        case 'm': applySgr(params); return;
        case 'h': case 'l': return; // mode set/reset (e.g. ?25l) — no movement
        default:
          unit.ambiguous = true; // any other CSI: conservative
      }
    }

    function handlePrintable(text) {
      if (!inSync || !unit) return;
      // Feed characters one at a time: the caret signature is a SINGLE
      // styled character; runs of text just advance the cursor.
      for (const ch of text) {
        if (ch === '\r') { col = 1; continue; }
        if (ch === '\n') { row += 1; continue; }
        if (ch === '\b') { col = Math.max(1, col - 1); continue; }
        if (ch === '\t' || ch === '\v' || ch === '\f') {
          // HT/VT/FF move the cursor in xterm; not modeled → ambiguous
          // (a wrong-position candidate is worse than none).
          unit.ambiguous = true;
          continue;
        }
        if (ch === '\u007f') continue; // DEL: xterm ignores it, no column advance
        if (ch < ' ') continue; // other C0 inside a unit: ignore
        const w = charWidth(ch);
        if (unit.writes.length < 16384) unit.writes.push([row - 1, col - 1]); // 0-based, matches descriptor coords
        if (sgr.fg !== null && sgr.bg !== null && !sgr.isDefault) {
          // Caret-signature styled single char at the current position.
          if (unit.caret) unit.ambiguous = true; // multiple carets in one unit
          else unit.caret = { row, col, ch, width: w, fg: sgr.fg, bg: sgr.bg };
        } else {
          unit.sawPlain = true;
          if (!sgr.isDefault) unit.plainAttrOk = false; // plain writes must use the default convention
        }
        col += w;
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
      state: function () {
        return {
          unitSeq, chunkSeq, inSync,
          pendingCandidate: !!(unit && unit.caret && !unit.ambiguous),
        };
      },
    };
  }

  const api = { createInkCaretObserver, charWidth };
  root.createInkCaretObserver = createInkCaretObserver;
  root.__inkCaretObserverInternals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
