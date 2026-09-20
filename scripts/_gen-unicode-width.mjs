// Generator: build src/renderer/unicode-width.js from the vendored xterm.js
// UnicodeV6 data (module 225), transcribing the combining-range tables
// verbatim to avoid transcription errors. Diagnostic tool, not shipped.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/vendor/xterm.js', import.meta.url), 'utf8');
const lines = src.split('\n');

const rLine = lines.find(l => /^\s*r = \[\[768, 879\]/.test(l));
const nLine = lines.find(l => /^\s*n = \[\[68097, 68099\]/.test(l));
const fillLine = lines.find(l => l.includes('o.fill(2, 4352, 4448)'));
if (!rLine || !nLine || !fillLine) throw new Error('anchor lines not found — bundle layout changed');

const bmpRanges = rLine.trim().replace(/^r = /, '').replace(/,\s*$/, '');
const astralRanges = nLine.trim().replace(/^n = /, '').replace(/;\s*$/, '');
JSON.parse(bmpRanges.replace(/\s/g, '')); // sanity: valid array literal
JSON.parse(astralRanges.replace(/\s/g, ''));

// The V6 BMP table init is one comma chain: o = new Uint8Array(...), o.fill(1),
// o[0] = 0, o.fill(2, ...), o[9001] = 2, ... — transcribe every call after the
// allocator verbatim (bracket assignments included; they are NOT optional:
// they override neighbors of the fills around them).
const chainStart = fillLine.indexOf('o.fill(1)');
if (chainStart < 0) throw new Error('table init chain not found');
const chain = fillLine.slice(chainStart, fillLine.indexOf(';', chainStart));
const fillCalls = [...chain.matchAll(/o\.fill\([^)]*\)|o\[\d+] = \d+/g)]
    .map(m => m[0].replace(/^o\./, 't.').replace(/^o\[/, 't[') + ';').join(' ');
for (const probe of ['t[9001] = 2;', 't[9002] = 2;', 't[12351] = 1;', 't.fill(2, 4352, 4448);']) {
    if (!fillCalls.includes(probe)) throw new Error('missing init call: ' + probe);
}

const out = `// Unicode width provider for xterm.js's proposed unicode API
// (term.unicode.register / activeVersion; Terminal is built with
// allowProposedApi). The vendored bundle ships only UnicodeV6, whose astral
// branch returns width 1 for every non-CJK codepoint above U+FFFF — including
// all plane-1 emoji. Modern TUIs (kimi via string-width, ratatui apps, WT,
// wezterm) lay out emoji-presentation codepoints as 2 cells, so their
// absolute CUP writes leave the cell right of the glyph un-erased while the
// 2-cell glyph overflows into it (field capture: kimi's tip line writes
// U+1F311 at col 28 then jumps to col 31; stale 'p' / '─' showed inside the
// moon glyph). This provider keeps V6 semantics for the BMP (tables
// transcribed verbatim from the vendored bundle by scripts/_gen-unicode-width.mjs)
// and widens the four plane-1 pictographic blocks that every modern width
// library treats as 2: 1F300-1F64F, 1F680-1F6FF, 1F900-1F9FF, 1FA70-1FAFF.
(function installUnicodeWidth(root) {
    'use strict';

    const COMBINING_BMP = ${bmpRanges};
    const COMBINING_ASTRAL = ${astralRanges};

    function bisect(e, t) {
        let i, s = 0, r = t.length - 1;
        if (e < t[0][0] || e > t[r][1]) return false;
        for (; r >= s;) {
            i = s + r >> 1;
            if (e > t[i][1]) s = i + 1;
            else { if (!(e < t[i][0])) return true; r = i - 1; }
        }
        return false;
    }

    let table = null;
    function bmp() {
        if (table) return table;
        const t = new Uint8Array(65536);
        ${fillCalls}
        for (let e = 0; e < COMBINING_BMP.length; ++e) t.fill(0, COMBINING_BMP[e][0], COMBINING_BMP[e][1] + 1);
        table = t;
        return t;
    }

    // Plane-1 emoji-presentation blocks: modern wcwidth/string-width/
    // unicode-width all return 2 here; V6's 1 is the stale outlier.
    function isEmojiWide(e) {
        return e >= 0x1F300 && e <= 0x1F64F || e >= 0x1F680 && e <= 0x1F6FF
            || e >= 0x1F900 && e <= 0x1F9FF || e >= 0x1FA70 && e <= 0x1FAFF;
    }

    function wcwidth(e) {
        return e < 32 ? 0 : e < 127 ? 1 : e < 65536 ? bmp()[e]
            : bisect(e, COMBINING_ASTRAL) ? 0
            : e >= 131072 && e <= 196605 || e >= 196608 && e <= 262141 || isEmojiWide(e) ? 2 : 1;
    }

    // xterm packs char properties as (kind << 3) | (width << 1) | join
    // (UnicodeService.createPropertyValue / extractWidth). 'preceding' is the
    // packed value of the previous char, as the parser hands it to us.
    function charProperties(e, t) {
        let i = wcwidth(e), r = 0 === i && 0 !== t;
        if (r) {
            const w = t >> 1 & 3;
            0 === w ? r = false : w > i && (i = w);
        }
        return (0 << 3) | (3 & i) << 1 | (r ? 1 : 0);
    }

    const VERSION = 'zterm6';
    class ZtermUnicodeProvider {
        constructor() { this.version = VERSION; bmp(); }
        wcwidth(e) { return wcwidth(e); }
        charProperties(e, t) { return charProperties(e, t); }
    }

    // Register on a Terminal and activate. Returns false (with a warning) when
    // the proposed unicode API surface is not there, so a future vendor
    // refresh that changes the API fails loud instead of silently reverting
    // emoji width to 1.
    function installOn(term) {
        if (!term || !term.unicode || typeof term.unicode.register !== 'function') {
            (root.console || console).warn('[unicode-width] term.unicode API missing; provider not installed');
            return false;
        }
        term.unicode.register(new ZtermUnicodeProvider());
        term.unicode.activeVersion = VERSION;
        return true;
    }

    const api = { VERSION, ZtermUnicodeProvider, installOn, wcwidth, charProperties };
    root.__unicodeWidth = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
`;

writeFileSync(new URL('../src/renderer/unicode-width.js', import.meta.url), out);
console.log('written src/renderer/unicode-width.js', out.length, 'chars');
