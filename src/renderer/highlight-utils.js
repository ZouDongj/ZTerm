// ZTerm - 高亮规则纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// 编译高亮规则的正则：isRegExp 用原文，否则转义关键字；非法正则返回 null（不抛异常）
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
// keyword on the same line (issue #9). State is line-local: a color carried
// over from a previous line/chunk is invisible here, and the end sequence
// then still emits a plain reset — no worse than the pre-fix behavior, while
// in-line colors (the reported case) are restored correctly.

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
// SGR sequences. Returns one CLONE per position so callers can keep them.
function sgrStatesAt(line, positions) {
    const result = [];
    const state = createSgrState();
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

// 找出字符串中所有 ANSI 转义序列的区间：
// CSI（\x1b[ 到 final byte 0x40–0x7E）、OSC（\x1b] 到 BEL 或 ST）、其他（ESC + 1 字符）
function _getEscapeRanges(s) {
    const ranges = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '\x1b') continue;
        const next = s[i + 1];
        if (next === '[') {
            // CSI: 直到 final byte
            let j = i + 2;
            while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7E)) j++;
            ranges.push({ start: i, end: Math.min(j + 1, s.length) });
            i = j;
        } else if (next === ']') {
            // OSC: 直到 BEL(\x07) 或 ST(\x1b\\)
            let j = i + 2;
            while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
            const end = s[j] === '\x07' ? j + 1 : (j < s.length ? j + 2 : s.length);
            ranges.push({ start: i, end });
            i = end - 1;
        } else {
            // 其他 ESC 序列（字符集切换等），跳过 ESC + 1 个字符
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

function applyHighlightToLine(line, rules) {
    if (!line) return line;
    // Collect first match from each rule
    const matches = [];
    for (const rule of rules) {
        const regex = buildHighlightRegex(rule.text, rule.isRegExp, rule.isCaseSensitive);
        if (!regex) continue; // 非法正则跳过该规则
        const match = regex.exec(line);
        if (match) {
            matches.push({ start: match.index, end: match.index + match[0].length, rule });
        }
    }
    if (matches.length === 0) return line;
    // ANSI 序列（CSI/OSC/其他）区间内的匹配全部丢弃——向 OSC 注入颜色码会打断序列，匹配文本会泄漏成可见输出
    const escapeRanges = _getEscapeRanges(line);
    const validMatches = matches.filter(m => !escapeRanges.some(r => m.start < r.end && m.end > r.start));
    if (validMatches.length === 0) return line;
    // Sort by start position, first match wins on overlap
    validMatches.sort((a, b) => a.start - b.start);
    // SGR state at each match start drives the restore sequence (issue #9).
    const states = sgrStatesAt(line, validMatches.map(m => m.start));
    // Build result with ANSI color injection
    let result = '';
    let last = 0;
    validMatches.forEach((m, idx) => {
        if (m.start < last) return; // 与前一个 match 重叠，先来先得
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
        buildHighlightEndSeq,
        applyHighlightToLine,
        _getEscapeRanges,
        _getHighlightBeginSeq,
        _hexToRgb,
    };
}
