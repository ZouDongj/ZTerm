// ZTerm - restart-restore content capture/replay pure logic (no DOM
// dependency, dual-exported as browser global + CommonJS so node:test can
// import it).

// UTF-16 code units per tab; bounds the lastTabs payload written every 15s.
const MAX_CONTENT_TAIL = 131072;

// Append a raw output chunk to the captured tail. Chunk boundaries are NOT
// content boundaries: a line (or escape sequence) split across chunks must
// survive intact, so no per-chunk splitting is allowed — only a size-capped
// tail trim, advanced to the next line boundary so replay never starts
// mid-line. If the kept window contains no newline (one oversized line) the
// raw slice is kept as a liveness valve.
function appendContentTail(current, chunk, maxTail = MAX_CONTENT_TAIL) {
    const base = typeof current === 'string' ? current : '';
    if (typeof chunk !== 'string' || !chunk) return base;
    let next = base + chunk;
    if (next.length > maxTail) {
        next = next.slice(next.length - maxTail);
        // A raw cut can split a surrogate pair: a leading lone low surrogate
        // would render as one replacement glyph on replay. Chunks themselves
        // never split pairs (streaming TextDecoder), so only the cut edge
        // needs this guard.
        const first = next.charCodeAt(0);
        if (first >= 0xDC00 && first <= 0xDFFF) next = next.slice(1);
        const nl = next.indexOf('\n');
        if (nl >= 0 && nl < next.length - 1) next = next.slice(nl + 1);
    }
    return next;
}

// Legacy configs (pre-fix) stored content as an ARRAY of lines; join them
// exactly the way the old replay did, so old saves restore no worse than
// before. New saves store the raw string tail.
function normalizeRestoredContent(saved) {
    if (Array.isArray(saved)) return saved.filter(l => typeof l === 'string').join('\r\n');
    return typeof saved === 'string' ? saved : '';
}

// Alternate-screen balance: capture stops while the alt screen is active, so
// the tail can only contain a 1049h...1049l pair that arrived inside a single
// chunk — but the tail TRIM can cut between them, leaving an unmatched enter.
// Truncate at the last point where the forward balance sat at zero, so replay
// always ends on the normal screen. A stray EXIT whose enter was never
// captured (the common case: a vim/less session whose enter chunk was not
// captured while its exit chunk was) is REMOVED from the replay text: this
// xterm build's DECRST 1049 unconditionally restores the saved cursor, so
// replaying it would teleport the cursor to (0,0) and post-exit output would
// overwrite the restored history from the top. Balanced pairs are kept
// verbatim (their own DECSC makes the exit's cursor restore self-consistent).
// Cut offsets are tracked in the REBUILT string because removals shift them.
function truncateAtLastAltBalance(text) {
    if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
    const ENTER = '\x1b[?1049h';
    const EXIT = '\x1b[?1049l';
    let balance = 0;
    let out = '';
    let segStart = 0;
    let lastZeroOut = -1;
    let i = 0;
    while (i <= text.length) {
        const h = text.indexOf(ENTER, i);
        const l = text.indexOf(EXIT, i);
        if (h < 0 && l < 0) break;
        const useEnter = h >= 0 && (l < 0 || h < l);
        const pos = useEnter ? h : l;
        const tokenEnd = pos + (useEnter ? ENTER.length : EXIT.length);
        if (useEnter) {
            // Entering the alt screen from the normal one: everything before
            // this token is normal-screen content and is the fallback cut
            // point if the pair never closes.
            if (balance === 0) lastZeroOut = out.length + (pos - segStart);
            balance += 1;
        } else if (balance > 0) {
            balance -= 1;
            if (balance === 0) lastZeroOut = out.length + (tokenEnd - segStart);
        } else {
            // Stray exit with no captured enter: drop the token, keep both
            // sides of the text around it.
            out += text.slice(segStart, pos);
            segStart = tokenEnd;
        }
        i = tokenEnd;
    }
    out += text.slice(segStart);
    return balance > 0 && lastZeroOut >= 0 ? out.slice(0, lastZeroOut) : out;
}

// State-reset epilogue: the tail can end mid-SGR (color leak), after a HIDE
// (invisible cursor), with mouse/bracketed-paste modes left on by a killed
// TUI, or in the alternate charset. Every sequence below is verified safe on
// the vendored xterm build when already in the reset state (no-ops). DECRST
// 1049 is deliberately absent (see truncateAtLastAltBalance). ?2026l is
// unimplemented in this build (parsed, ignored) and kept for future vendor
// refreshes.
const REPLAY_EPILOGUE = '\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x0f\x1b[0m\x1b[?25h\r\n';

// Build the bytes written into the fresh terminal on restore. Empty content
// replays nothing (no lone epilogue polluting a clean shell banner).
function replayPayload(saved) {
    const text = truncateAtLastAltBalance(normalizeRestoredContent(saved));
    return text ? text + REPLAY_EPILOGUE : '';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { appendContentTail, normalizeRestoredContent, truncateAtLastAltBalance, replayPayload, REPLAY_EPILOGUE, MAX_CONTENT_TAIL };
}
