// ZTerm - highlight rule pure logic (no DOM dependency; browser global + CommonJS dual export, node:test-able)

// Compile a rule's regex: isRegExp uses the text verbatim, otherwise the keyword is escaped; invalid regexes return null (never throw)
function buildHighlightRegex(text, isRegExp, isCaseSensitive) {
    try {
        const src = isRegExp ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(src, isCaseSensitive ? 'gd' : 'gid');
    } catch (e) {
        return null;
    }
}

// ── SGR rendition state ──
// The end sequence of a highlighted keyword must RESTORE the rendition that
// was active at the match position — the pre-fix code reset to the DEFAULT
// (39/49/22/23/24), which washed the original colors of everything after the
// keyword on the same line (issue #9). The line-start baseline is supplied by
// the caller: highlight.js threads a state carried across write() calls, so a
// color set in an earlier chunk/line is restored as well. With no carried
// state the line starts from defaults — the plain-reset fallback is then no
// worse than the pre-fix behavior.

function createSgrState() {
    return { fg: null, bg: null, bold: false, italic: false, underline: false };
}

// Apply one SGR parameter list (e.g. "38;2;224;108;117" or "1;31") to state.
// Only the attribute groups highlight rules can touch are tracked; anything
// else (dim/inverse/blink/strike/...) is never modified by the begin/end
// sequences, so it passes through untouched and needs no restore handling.
function applySgrParams(state, paramStr) {
    const raw = paramStr === '' ? [0] : paramStr.split(';').map(p => (p === '' ? 0 : parseInt(p, 10)));
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (Number.isNaN(p)) continue;
        if (p === 0) { state.fg = null; state.bg = null; state.bold = false; state.italic = false; state.underline = false; }
        else if (p === 1) state.bold = true;
        else if (p === 3) state.italic = true;
        else if (p === 4) state.underline = true;
        else if (p === 22) state.bold = false;
        else if (p === 23) state.italic = false;
        else if (p === 24) state.underline = false;
        else if (p === 39) state.fg = null;
        else if (p === 49) state.bg = null;
        else if (p >= 30 && p <= 37) state.fg = String(p);
        else if (p >= 90 && p <= 97) state.fg = String(p);
        else if (p >= 40 && p <= 47) state.bg = String(p);
        else if (p >= 100 && p <= 107) state.bg = String(p);
        else if (p === 38 || p === 48) {
            const key = p === 38 ? 'fg' : 'bg';
            if (raw[i + 1] === 5 && typeof raw[i + 2] === 'number' && !Number.isNaN(raw[i + 2])) {
                state[key] = `${p};5;${raw[i + 2]}`;
                i += 2;
            } else if (raw[i + 1] === 2 && raw.length >= i + 5 &&
                       [raw[i + 2], raw[i + 3], raw[i + 4]].every(v => typeof v === 'number' && !Number.isNaN(v))) {
                state[key] = `${p};2;${raw[i + 2]};${raw[i + 3]};${raw[i + 4]}`;
                i += 4;
            }
            // Malformed extended color: leave the state unchanged.
        }
    }
}

// Rendition state at each of `positions` (ascending), tracking the line's own
// SGR sequences from an optional `initialState` (the line-start baseline
// carried in by the caller). Returns one CLONE per position so callers can
// keep them; `initialState` itself is never mutated.
function sgrStatesAt(line, positions, initialState) {
    const result = [];
    const state = initialState ? { ...initialState } : createSgrState();
    let pi = 0;
    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(line)) !== null && pi < positions.length) {
        while (pi < positions.length && positions[pi] <= m.index) {
            result.push({ ...state });
            pi++;
        }
        applySgrParams(state, m[1]);
    }
    while (pi < positions.length) {
        result.push({ ...state });
        pi++;
    }
    return result;
}

// Advance `state` in place past every SGR sequence in `line`: the line-end
// rendition, i.e. the line-start baseline for the next line/chunk. Callers
// thread one state object through the stream (issue #9 cross-chunk residual).
function advanceSgrState(state, line) {
    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(line)) !== null) applySgrParams(state, m[1]);
    return state;
}

// End sequence for one highlighted match: re-emit the rendition active at the
// match position for every attribute the rule set; fall back to the plain
// reset only when that attribute was NOT active there (pre-fix behavior).
function buildHighlightEndSeq(rule, state) {
    const s = state || createSgrState();
    let seq = '';
    if (rule.underline) seq += s.underline ? '\x1b[4m' : '\x1b[24m';
    if (rule.italic) seq += s.italic ? '\x1b[3m' : '\x1b[23m';
    if (rule.bold) seq += s.bold ? '\x1b[1m' : '\x1b[22m';
    if (rule.background && rule.backgroundColor) seq += s.bg ? `\x1b[${s.bg}m` : '\x1b[49m';
    if (rule.foreground && rule.foregroundColor) seq += s.fg ? `\x1b[${s.fg}m` : '\x1b[39m';
    return seq;
}

const MAX_HIGHLIGHT_CSI_PARAMS = 1024;

function createHighlightStreamState(sgr) {
    return { mode: 'ground', params: '', overflow: false, intermediate: false,
        sgr: sgr || createSgrState(), sgrKnown: true, alternate: false };
}

// A lexer, not a terminal emulator: identify bytes unsafe for decoration and
// track only the rendition/modes highlighting needs. String payloads are never
// retained. CSI collection has a fixed cap, even for an unterminated sequence.
function scanHighlightLine(line, state, disableAlternate = false) {
    const ranges = [];
    const changes = [];
    const enter = mode => {
        state.mode = mode;
        state.params = '';
        state.overflow = false;
        state.intermediate = false;
    };
    const snapshot = end => changes.push({ end, sgr: { ...state.sgr } });
    for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        const ch = line[i];
        const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
        if (state.mode !== 'ground' || control || !state.sgrKnown || (disableAlternate && state.alternate)) {
            const last = ranges[ranges.length - 1];
            if (last && last.end === i) last.end++;
            else ranges.push({ start: i, end: i + 1 });
        }
        // These transitions apply in every state. ESC also begins the
        // two-byte ST terminator, including when its backslash arrives later.
        if (code === 0x1b) { enter('escape'); continue; }
        if (code === 0x18 || code === 0x1a || code === 0x9c) { enter('ground'); continue; }
        if (code >= 0x80 && code <= 0x9f) {
            enter(code === 0x9b ? 'csi' : code === 0x9d ? 'osc' :
                (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) ? 'string' : 'ground');
            continue;
        }
        if (state.mode === 'osc' && code === 0x07) { enter('ground'); continue; }
        if (code < 0x20 || code === 0x7f) continue;
        if (state.mode === 'osc' || state.mode === 'string') continue;
        if (state.mode === 'escape' || state.mode === 'escape-intermediate') {
            if (code >= 0x20 && code <= 0x2f) { state.mode = 'escape-intermediate'; continue; }
            if (code < 0x30 || code > 0x7e) continue;
            if (state.mode === 'escape') {
                if (ch === '[') { enter('csi'); continue; }
                if (ch === ']') { enter('osc'); continue; }
                if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { enter('string'); continue; }
                if (ch === 'c') {
                    Object.assign(state.sgr, createSgrState());
                    state.sgrKnown = true;
                    state.alternate = false;
                    snapshot(i + 1);
                }
            }
            enter('ground');
            continue;
        }
        if (state.mode !== 'csi') continue;
        if (code >= 0x40 && code <= 0x7e) {
            if (!state.intermediate && ch === 'm' && !/^[<=>?]/.test(state.params)) {
                const values = state.params.split(';');
                // Match the bundled parser's 32 signed-31-bit parameter
                // slots. Truncated/clamped values are not a safe baseline.
                if (!state.overflow && /^[0-9;]*$/.test(state.params) &&
                    values.length <= 32 && values.every(value => Number(value) <= 0x7fffffff)) {
                    // An unambiguous leading reset recovers after an SGR we
                    // could not track; color components containing zero do not.
                    const first = values[0];
                    if (first === '' || Number(first) === 0) state.sgrKnown = true;
                    applySgrParams(state.sgr, state.params);
                } else {
                    // Keep output untouched until a known reset rather than
                    // restoring a guessed rendition after an unsupported SGR.
                    state.sgrKnown = false;
                }
                snapshot(i + 1);
            }
            if (!state.overflow && !state.intermediate && (ch === 'h' || ch === 'l') && /^\?[0-9;]*$/.test(state.params)) {
                const modes = state.params.slice(1).split(';').slice(0, 32).map(Number);
                if (modes.some(mode => mode === 47 || mode === 1047 || mode === 1049)) state.alternate = ch === 'h';
            }
            enter('ground');
        } else if (code >= 0x20 && code <= 0x2f) {
            state.intermediate = true;
        } else if (code >= 0x30 && code <= 0x3f && !state.intermediate) {
            if (state.params.length < MAX_HIGHLIGHT_CSI_PARAMS) state.params += ch;
            else state.overflow = true;
        } else {
            // Invalid CSI input remains protected through its final byte.
            state.intermediate = true;
        }
    }
    return { ranges, changes };
}

function _getEscapeRanges(s) {
    return scanHighlightLine(s, createHighlightStreamState()).ranges;
}

function _getHighlightBeginSeq(rule) {
    let seq = '';
    if (rule.foreground && rule.foregroundColor) {
        const rgb = _hexToRgb(rule.foregroundColor);
        if (rgb) seq += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
    }
    if (rule.background && rule.backgroundColor) {
        const rgb = _hexToRgb(rule.backgroundColor);
        if (rgb) seq += `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
    }
    if (rule.bold) seq += '\x1b[1m';
    if (rule.italic) seq += '\x1b[3m';
    if (rule.underline) seq += '\x1b[4m';
    return seq;
}

function _hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const int = parseInt(m[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

// Normalize a rule color to the #rrggbb form the terminal path (_hexToRgb)
// accepts: the 3-digit shorthand is expanded, anything else (4/5/7/8 digits,
// non-hex, missing #) returns null. An empty value stays empty (no color).
// CSS renders 3/4/8-digit values in the settings preview while the terminal
// silently dropped them, so the two paths must agree on one stored form.
function normalizeHighlightColor(hex) {
    if (!hex) return hex;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
}

function applyHighlightToLine(line, rules, carriedState, streamState, disableAlternate = false) {
    if (!line) return line;
    const stream = streamState || createHighlightStreamState(carriedState);
    const startState = { ...stream.sgr };
    const { ranges, changes } = scanHighlightLine(line, stream, disableAlternate);
    // Collect all matches from each rule
    const matches = [];
    for (const rule of rules) {
        const regex = buildHighlightRegex(rule.text, rule.isRegExp, rule.isCaseSensitive);
        if (!regex) continue; // invalid regex: skip this rule
        let match;
        while ((match = regex.exec(line)) !== null) {
            matches.push({ start: match.index, end: match.index + match[0].length, rule });
            if (match[0].length === 0) regex.lastIndex++; // zero-width match: advance past it or exec loops forever
        }
    }
    if (matches.length === 0) return line;
    // Regexes still see the original whole line, preserving anchors and
    // overlap semantics. Only matches wholly outside protected spans may paint.
    const validMatches = matches.filter(m => {
        if (m.start === m.end) {
            if (m.start === line.length && (stream.mode !== 'ground' || !stream.sgrKnown || (disableAlternate && stream.alternate))) return false;
            return !ranges.some(r => m.start >= r.start && m.start < r.end);
        }
        return !ranges.some(r => m.start < r.end && m.end > r.start);
    });
    if (validMatches.length === 0) return line;
    // Sort by start position, first match wins on overlap
    validMatches.sort((a, b) => a.start - b.start);
    // SGR state at each match start drives the restore sequence (issue #9).
    let stateAtMatch = startState;
    let nextChange = 0;
    const states = validMatches.map(m => {
        while (nextChange < changes.length && changes[nextChange].end <= m.start) stateAtMatch = changes[nextChange++].sgr;
        return stateAtMatch;
    });
    // Build result with ANSI color injection
    let result = '';
    let last = 0;
    validMatches.forEach((m, idx) => {
        if (m.start < last) return; // overlaps the previous match — first match wins
        result += line.slice(last, m.start);
        result += _getHighlightBeginSeq(m.rule);
        result += line.slice(m.start, m.end);
        result += buildHighlightEndSeq(m.rule, states[idx]);
        last = m.end;
    });
    result += line.slice(last);
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildHighlightRegex,
        createSgrState,
        applySgrParams,
        sgrStatesAt,
        advanceSgrState,
        buildHighlightEndSeq,
        applyHighlightToLine,
        normalizeHighlightColor,
        createHighlightStreamState,
        scanHighlightLine,
        MAX_HIGHLIGHT_CSI_PARAMS,
        _getEscapeRanges,
        _getHighlightBeginSeq,
        _hexToRgb,
    };
}
