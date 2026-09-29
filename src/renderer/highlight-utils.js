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

// Find the ranges of all ANSI escape sequences in a string:
// CSI (\x1b[ through final byte 0x40–0x7E), OSC (\x1b] through BEL or ST), other (ESC + 1 char)
function _getEscapeRanges(s) {
    const ranges = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '\x1b') continue;
        const next = s[i + 1];
        if (next === '[') {
            // CSI: through the final byte
            let j = i + 2;
            while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7E)) j++;
            ranges.push({ start: i, end: Math.min(j + 1, s.length) });
            i = j;
        } else if (next === ']') {
            // OSC: through BEL(\x07) or ST(\x1b\\)
            let j = i + 2;
            while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
            const end = s[j] === '\x07' ? j + 1 : (j < s.length ? j + 2 : s.length);
            ranges.push({ start: i, end });
            i = end - 1;
        } else {
            // Other ESC sequences (charset switches etc.): skip ESC + 1 char
            ranges.push({ start: i, end: Math.min(i + 2, s.length) });
            i += 1;
        }
    }
    return ranges;
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

function applyHighlightToLine(line, rules, carriedState) {
    if (!line) return line;
    // Cross-chunk baseline (issue #9 residual): snapshot the rendition carried
    // into this line — it drives the restore sequences below — then advance
    // the caller's baseline past this line. Advancing happens on lines with no
    // match too, so the next line/chunk starts from the correct state. The
    // injection is restore-neutral for the tracked attributes (a match never
    // contains an escape sequence and the end sequence re-emits the
    // match-start rendition), so scanning the ORIGINAL line keeps the baseline
    // identical to what the terminal holds after the injected output.
    let startState = null;
    if (carriedState) {
        startState = { ...carriedState };
        advanceSgrState(carriedState, line);
    }
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
    // Drop all matches inside ANSI sequences (CSI/OSC/other) — injecting color codes into an OSC would break the sequence and the matched text would leak into visible output
    const escapeRanges = _getEscapeRanges(line);
    const validMatches = matches.filter(m => !escapeRanges.some(r => m.start < r.end && m.end > r.start));
    if (validMatches.length === 0) return line;
    // Sort by start position, first match wins on overlap
    validMatches.sort((a, b) => a.start - b.start);
    // SGR state at each match start drives the restore sequence (issue #9).
    const states = sgrStatesAt(line, validMatches.map(m => m.start), startState);
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
        _getEscapeRanges,
        _getHighlightBeginSeq,
        _hexToRgb,
    };
}
