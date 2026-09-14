// ConPTY caret repair filter (experiment, default off).
//
// WHY THIS EXISTS
// ---------------
// Captured with src/bin/pty-capture.rs (artifacts/vt-capture/):
//
//   herdr over SSH    ?2026h ?25l OSC8 CUP(19;30) SGR(0;39;49) a SGR(0) CUP(19;31) ?25h ?2026l
//   herdr local       ?2026h ?25l OSC8 CUP(30;70) SGR(0;39;49) a SGR(0;7;39;49) ' ' SGR(0) CUP(30;71) ?25l ?2026l
//
// Two ConPTY-specific mutations of the same frame:
//   1. the trailing `ESC[?25h` (show caret) is re-emitted as `ESC[?25l`, so
//      xterm.js parks `isCursorHidden = true` forever and every caret
//      animation in this app is switched off inside herdr;
//   2. ConPTY paints the caret itself as a reverse-video cell (SGR `0;7;..`),
//      which no animation can smooth — it can only teleport.
//
// `repair` re-asserts `?25h` at the end of every synchronized-output block,
// restoring the visibility the app asked for. `fix` additionally removes the
// reverse-video caret cell ConPTY painted, so the animated caret is the only
// one on screen.
(function installConPtyCaretFilter(root) {
  'use strict';

  const ESC = '\u001b';
  const SYNC_BEGIN = '\u001b[?2026h';
  const SYNC_END = '\u001b[?2026l';
  const HIDE = '\u001b[?25l';
  const SHOW = '\u001b[?25h';
  // The exact SGR ConPTY emits when it paints the console caret into a cell.
  const PAINTED_CARET_SGR = '\u001b[0;7;39;49m';
  const PLAIN_CARET_SGR = '\u001b[0;39;49m';
  const CUP = /^\u001b\[\d+;\d+[Hf]$/;
  // A sync block is only post-processed while it is small; an app that leaves
  // one open must never make us buffer unboundedly.
  const MAX_BLOCK_TOKENS = 20000;
  // Cap on unparsed bytes held back waiting for the rest of a sequence. Long
  // OSC strings (hyperlinks) are legitimate, so this is a generous safety net.
  const MAX_PENDING_BYTES = 65536;

  function createConPtyCaretFilter(options) {
    let mode = normalizeMode(options?.mode);
    // The PTY path feeds Uint8Array, never a string (pty.js: decodeBase64).
    // Decoding has to be streaming: a multi-byte character can be split across
    // two IPC messages.
    let decoder = null;
    let buffer = '';
    let visible = true;
    let inSync = false;
    let visibleBefore = true;
    let block = null;
    // Painted-caret detection: some TUI frameworks (ink-style diffs) NEVER
    // issue a cursor-show and park+hide the real cursor between frames,
    // drawing their own caret as a styled cell instead. Over SSH (no ConPTY
    // consolidation) those between-frame hides sit OUTSIDE sync blocks and
    // permanently defeat the block-end repair, so the real cursor stays
    // hidden and the painted caret can only teleport. Signature: a
    // synchronized-output TUI that has hidden repeatedly but never once
    // shown. Apps that emit ?25h (nvim, shells, opencode) and apps without
    // sync blocks (htop) never trigger this.
    let hidesSeen = 0;
    let showsSeen = 0;
    let blocksSeen = 0;
    let glyphRun = 0;
    let paintedCaret = false;

    // Plain text is buffered too, so the trailing-cell rewrite can see it.
    function emit(text) {
      if (!text) return '';
      if (inSync && block) {
        if (block.length < MAX_BLOCK_TOKENS) {
          block.push(text);
          return '';
        }
        return text; // oversized block: give up on post-processing
      }
      return text;
    }

    function token(text) {
      if (text === SYNC_BEGIN) {
        inSync = true;
        visibleBefore = visible;
        block = [];
        return text;
      }
      if (text === SYNC_END) {
        const buffered = block || [];
        block = null;
        inSync = false;
        blocksSeen += 1;

        let out = buffered.join('');
        if (mode === 'fix') {
          // Order matters: the painted-caret signature ENDS with the block's
          // trailing ?25l, so strip it before dropping transient hides.
          out = removePaintedCaret(out);
          // Engagement by DIRECT evidence: two consecutive frames carrying
          // the painted-glyph pattern (truecolor fg+bg styled space parked
          // before a CUP). Works identically over SSH (stray out-of-block
          // hides) and locally where ConPTY consolidates the hides inside
          // blocks — glyph presence is the common fingerprint of ink-style
          // painted carets. nvim/opencode never paint such a glyph, so they
          // cannot engage; a real SHOW resets the run.
          if (hasPaintedGlyph(out)) glyphRun += 1; else glyphRun = 0;
          if (!paintedCaret && glyphRun >= 2) {
            paintedCaret = true;
            visible = true;
            out = out.split(HIDE).join('');
          }
          // Transient-hide churn: a frame that started from the visible state
          // is one we repair with a block-end SHOW anyway; forwarding the
          // in-frame ?25l toggles the caret hide->show once per sync block.
          // TUI input boxes redraw in ~10 sync blocks per keystroke, so that
          // churn cancels the cursor animation on every key (the "choppy
          // caret" in dsh-tui/kimi-style agents). Frames that started hidden
          // (nvim normal mode) keep their hides untouched.
          if (visibleBefore || paintedCaret) out = out.split(HIDE).join('');
          // In painted-caret mode the app draws its own caret as a
          // truecolor-fg+bg styled SPACE parked right where it then moves the
          // real cursor — with the real cursor now visible and animating, the
          // painted one shows up as a second, teleporting caret. Drop the
          // LAST styled-space-before-a-CUP write in the frame; the app
          // rewrites the vacated cell with real content on the next edit.
          if (paintedCaret) out = removePaintedGlyph(out);
        }
        out += text;
        visible = paintedCaret ? true : visibleBefore;
        if (visible) out += SHOW; // ConPTY dropped the app's own `?25h`
        return out;
      }
      if (text === HIDE) {
        hidesSeen += 1;
        // In painted-caret mode every hide is swallowed — the real cursor
        // must stay visible exactly on the painted cell so the adapter can
        // animate it (engagement itself is glyph-evidence based, see SYNC_END).
        if (paintedCaret) return '';
        visible = false;
        return emit(text);
      }
      if (text === SHOW) {
        showsSeen += 1;
        glyphRun = 0;
        // A real show ends painted-caret mode: the app does manage cursor
        // visibility after all.
        paintedCaret = false;
        visible = true;
        return emit(text);
      }
      return emit(text);
    }

    // Uint8Array -> string without ever falling back to String(bytes), which
    // would join the byte values with commas.
    function toString(data) {
      if (typeof data === 'string') return data;
      if (data == null) return '';
      if (typeof root.TextDecoder === 'function') {
        if (!decoder) decoder = new root.TextDecoder('utf-8');
        return decoder.decode(data, { stream: true });
      }
      // No TextDecoder (very old host): ASCII-only fallback, still no commas.
      let out = '';
      for (let i = 0; i < data.length; i += 1) out += String.fromCharCode(data[i]);
      return out;
    }

    function setMode(value) {
      mode = normalizeMode(value);
      buffer = '';
      inSync = false;
      block = null;
      // A mode switch must not leave a half-decoded character behind.
      if (decoder) decoder.decode();
      return mode;
    }

    // Splits the stream into escape sequences and plain runs; escape sequences
    // go through `token` so the sync-block state stays accurate, plain runs go
    // through `emit` so they can be buffered with the rest of the block.
    function push(data) {
      // 'off' must be bit-exact: hand back exactly what came in, same type and
      // same object. Coercing a Uint8Array with String() turns it into
      // "27,91,49,..." and prints the whole stream as digits.
      if (mode === 'off') return data;
      const text = toString(data);
      if (!text) return '';
      buffer += text;
      let out = '';
      let index = 0;
      while (index < buffer.length) {
        const esc = buffer.indexOf(ESC, index);
        if (esc < 0) {
          out += emit(buffer.slice(index));
          index = buffer.length;
          break;
        }
        if (esc > index) out += emit(buffer.slice(index, esc));
        const sequence = readSequence(buffer, esc);
        if (!sequence) {
          // Incomplete sequence: leave it (starting at ESC) for the next chunk.
          // Dropping it here loses the ESC and prints the rest as plain text.
          index = esc;
          break;
        }
        if (sequence.reject) {
          // Malformed: hand the lone ESC on and rescan from the next byte.
          out += emit(ESC);
          index = esc + 1;
          continue;
        }
        out += token(buffer.slice(esc, sequence.end));
        index = sequence.end;
      }
      // Keep exactly what was not consumed, and nothing else.
      buffer = buffer.slice(index);
      // Last-resort liveness valve: a stream filter must never be able to
      // swallow output indefinitely, whatever the application sends.
      if (buffer.length > MAX_PENDING_BYTES) {
        out += emit(buffer);
        buffer = '';
      }
      return out;
    };

    return {
      push,
      setMode,
      mode: function () { return mode; },
      state: function () { return { mode, inSync, visible, buffered: block ? block.length : 0, paintedCaret, hidesSeen, showsSeen, blocksSeen, glyphRun }; },
    };
  }

  function normalizeMode(value) {
    return value === 'repair' || value === 'fix' ? value : 'off';
  }

  // ConPTY renders the console caret into a cell as
  //   SGR(0;7;39;49) <cell> SGR(0) CUP(r;c) ESC[?25l
  // right before it hides the terminal caret. Drop the reverse-video flag so
  // only our animated caret is left at that position.
  //
  // This matches the TAIL OF THE JOINED BLOCK TEXT, not a token index: the PTY
  // hands us arbitrarily sized chunks, so plain text can be split anywhere and
  // a positional match would fire only for lucky chunk boundaries.
  const PAINTED_CARET_TAIL =
    /\u001b\[0;7;39;49m([\s\S]{0,4}?)\u001b\[0m(\u001b\[\d+;\d+[Hf])\u001b\[\?25l$/;

  function removePaintedCaret(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(
      PAINTED_CARET_TAIL,
      PLAIN_CARET_SGR + '$1\u001b[0m$2\u001b[?25l'
    );
  }

  // The ink-style painted caret glyph: a single space carrying both a
  // truecolor foreground and background (fg = text color, bg = caret fill),
  // immediately followed by a cursor-position move. Only the LAST occurrence
  // in a frame is removed — engagement already proved the app paints its
  // caret right where it parks the real cursor, and the vacated cell gets
  // rewritten with real content on the next edit.
  const PAINTED_GLYPH_RE =
    /\u001b\[0;38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m \u001b\[0m(?=\u001b\[\d+;\d+[Hf])/g;

  function hasPaintedGlyph(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    PAINTED_GLYPH_RE.lastIndex = 0;
    return PAINTED_GLYPH_RE.test(text);
  }

  function removePaintedGlyph(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    // matchAll clones the regex but COPIES its lastIndex — hasPaintedGlyph's
    // test() advanced it past the match, which made every later matchAll scan
    // start too late and find nothing. Reset before scanning.
    PAINTED_GLYPH_RE.lastIndex = 0;
    const matches = [...text.matchAll(PAINTED_GLYPH_RE)];
    if (matches.length === 0) return text;
    const last = matches[matches.length - 1];
    return text.slice(0, last.index) + text.slice(last.index + last[0].length);
  }

  // Not an escape sequence at all: emit the ESC by itself so the stream keeps
  // moving instead of waiting forever for a sequence that can never complete.
  const REJECT = { reject: true };

  // Returns { end, kind } for one complete escape sequence starting at `from`,
  // REJECT when those bytes cannot form one, or null when it may simply be
  // incomplete so far.
  //
  // CSI grammar: ESC [ <params 0x30-0x3F>* <intermediates 0x20-0x2F>* <final 0x40-0x7E>
  // The intermediate range matters: `CSI 0 SP q` (DECSCUSR, cursor shape) is
  // legal and very common, and missing it made this filter wedge the whole
  // terminal the first time an app changed the cursor shape.
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
      if (code >= 0x40 && code <= 0x7e) return { end: j + 1, kind: 'csi' };
      return REJECT;
    }
    if (next === ']' || next === 'P' || next === '^' || next === '_') {
      for (let j = from + 2; j < text.length; j += 1) {
        if (text.charCodeAt(j) === 0x07) return { end: j + 1, kind: 'str' };
        if (text.charAt(j) === ESC && text.charAt(j + 1) === '\\') return { end: j + 2, kind: 'str' };
      }
      return null;
    }
    if (text.length - from < 2) return null;
    if ('()#*+'.indexOf(next) >= 0) {
      if (text.length - from < 3) return null;
      return { end: from + 3, kind: 'esc' };
    }
    return { end: from + 2, kind: 'esc' };
  }

  const api = { createConPtyCaretFilter, removePaintedCaret, readSequence };
  root.createConPtyCaretFilter = createConPtyCaretFilter;
  root.__conPtyCaretInternals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
