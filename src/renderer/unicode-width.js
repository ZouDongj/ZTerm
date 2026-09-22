// Unicode width provider for xterm.js's proposed unicode API
// (term.unicode.register / activeVersion; Terminal is built with
// allowProposedApi). The vendored bundle ships only UnicodeV6, whose astral
// branch returns width 1 for every non-CJK codepoint above U+FFFF — including
// all plane-1 emoji. Modern TUIs (kimi via string-width, ratatui apps, WT,
// wezterm) lay out emoji-presentation codepoints as 2 cells, so their
// absolute CUP writes leave the cell right of the glyph un-erased while the
// 2-cell glyph overflows into it (field capture: kimi's tip line writes
// U+1F311 at col 28 then jumps to col 31; stale 'p' / '─' showed inside the
// moon glyph). The base tables were transcribed from the vendored bundle.
// BMP width-1 characters classified as wide by the installed Tabby's Unicode11
// provider are also widened. Existing combining/control widths, PUA widths,
// and astral semantics remain intact; this is not a full Unicode11 upgrade.
// The existing plane-1 wide blocks remain 1F300-1F64F, 1F680-1F6FF,
// 1F900-1F9FF and 1FA70-1FAFF, including newer emoji absent from Unicode11.
(function installUnicodeWidth(root) {
    'use strict';

    const COMBINING_BMP = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395], [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769], [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607], [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238], [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046], [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]];
    const COMBINING_ASTRAL = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];

    // UnicodeV11 module 433 in Tabby 1.0.231-nightly.0, dist/index.js.
    // Exactly the 89 BMP width-1 -> width-2 additions compared with bundled V6.
    // Deliberately exclude its combining changes and existing-wide narrowing.
    const BMP_WIDENING = [
        [0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3],
        [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F],
        [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE],
        [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA],
        [0x26F2, 0x26F3], [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD],
        [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C],
        [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
        [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50],
        [0x2B55, 0x2B55], [0xA960, 0xA97C],
    ];

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
        t.fill(1); t[0] = 0; t.fill(0, 1, 32); t.fill(0, 127, 160); t.fill(2, 4352, 4448); t[9001] = 2; t[9002] = 2; t.fill(2, 11904, 42192); t[12351] = 1; t.fill(2, 44032, 55204); t.fill(2, 63744, 64256); t.fill(2, 65040, 65050); t.fill(2, 65072, 65136); t.fill(2, 65280, 65377); t.fill(2, 65504, 65511);
        for (let e = 0; e < COMBINING_BMP.length; ++e) t.fill(0, COMBINING_BMP[e][0], COMBINING_BMP[e][1] + 1);
        for (const [first, last] of BMP_WIDENING) {
            for (let cp = first; cp <= last; cp++) if (t[cp] === 1) t[cp] = 2;
        }
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

    // Retain the established provider ID for settings and diagnostic compatibility.
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
