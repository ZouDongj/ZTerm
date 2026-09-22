// Unit tests for the zterm6 unicode width provider (ADR-0002 item 2 rework:
// kimi's tip line writes U+1F311 assuming 2 cells — field capture — while
// the vendored UnicodeV6 returns 1 for every astral emoji; the 2-cell glyph
// then overflows into the un-erased neighbor cell and shows stale text).
// The provider retains V6 combining behavior, widens selected BMP characters
// to the installed Tabby's Unicode11 widths, and keeps the existing astral rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const api = require('../src/renderer/unicode-width.js');
require('../src/vendor/xterm.js');

// Captured from installed Tabby 1.0.231-nightly.0's UnicodeV11 provider:
// D:/Program Files/Tabby/resources/builtin-plugins/tabby-terminal/dist/index.js
// module 433, lines 19183-19220. Extracted body SHA256:
// 0e6c69394e77592117c642eaddcb50499e03f763266b6cd297015071b62905ad.
// This is precisely its 89 BMP width-1 -> width-2 differences from bundled V6.
// Tests use this pinned fixture and bundled V6, never a local Tabby installation.
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

const WIDTHS = [
    // Preserved BMP behavior and Unicode11 widening
    [0x00, 0, 'NUL'], [0x1F, 0, 'control'], [0x41, 1, 'ASCII'], [0x7F, 0, 'DEL'],
    [0x4E2D, 2, 'CJK'], [0x1100, 2, 'Hangul jamo'], [0x0300, 0, 'combining grave'],
    [0x20D0, 0, 'combining 8400s'], [0xFE0F, 0, 'VS16'], [0x2329, 2, '9001 override'],
    [0x232A, 2, '9002 override'], [0x303F, 1, '12351 override'], [0x2728, 2, 'sparkles Unicode11 parity'],
    [0x26A1, 2, 'lightning Unicode11 parity'], [0x231A, 2, 'watch Unicode11 parity'],
    [0xA960, 2, 'Hangul Jamo extended-A Unicode11 parity'],
    [0x302E, 0, 'existing combining width retained'], [0x302F, 0, 'existing combining width retained'],
    [0xF07B, 1, 'BMP Nerd PUA stays narrow'], [0xF120, 1, 'terminal PUA stays narrow'],
    [0xE0B0, 1, 'Powerline stays narrow'], [0x23FA, 1, 'record symbol stays narrow'],
    [0x2726, 1, 'star symbol stays narrow'],
    // Astral V6 parity
    [0x10000, 1, 'Linear B stays 1'], [0x1D167, 0, 'astral combining'],
    [0x20000, 2, 'CJK ext B'], [0x2FFFD, 2, 'CJK ext edge'], [0x30000, 2, 'CJK ext G'],
    // The widened plane-1 pictographic blocks
    [0x1F311, 2, 'new moon (field case)'], [0x1F318, 2, 'waning crescent'],
    [0x1F300, 2, 'block edge low'], [0x1F64F, 2, 'block edge high'],
    [0x1F680, 2, 'rocket'], [0x1F6FF, 2, 'transport edge'],
    [0x1F900, 2, 'supplemental edge'], [0x1F9FF, 2, 'supplemental high'],
    [0x1FA70, 2, 'extended-A edge'], [0x1FAFF, 2, 'extended-A high'],
    [0x1FAE0, 2, 'newer emoji is not narrowed to Unicode11'], [0xF024B, 1, 'astral Nerd PUA stays narrow'],
    // Neighbors that must NOT be widened
    [0x1F650, 1, 'ornamental dingbats stay 1'], [0x1F67F, 1, 'below transport stays 1'],
    [0x1F700, 1, 'alchemical stays 1'], [0x1FB00, 1, 'above extended-A stays 1'],
];

test('wcwidth: selected Unicode11 BMP widening preserves existing unrelated semantics', () => {
    for (const [cp, want, name] of WIDTHS) {
        assert.equal(api.wcwidth(cp), want, `${name} (U+${cp.toString(16).toUpperCase()})`);
    }
});

test('all BMP changes are exactly the 89 pinned Unicode11 widenings', () => {
    const baseline = new globalThis.TabbyXterm.Terminal({ allowProposedApi: true });
    const expected = new Set(BMP_WIDENING.flatMap(([first, last]) =>
        Array.from({ length: last - first + 1 }, (_, offset) => first + offset)));
    assert.equal(expected.size, 89);
    let changed = 0;
    try {
        for (let cp = 0; cp < 0x10000; cp++) {
            const previous = baseline._core.unicodeService.wcwidth(cp);
            const current = api.wcwidth(cp);
            assert.equal(current, expected.has(cp) ? 2 : previous, `U+${cp.toString(16)}`);
            if (current !== previous) changed += 1;
        }
        assert.equal(changed, 89);
    } finally { baseline.dispose(); }
});

test('charProperties packs (kind<<3)|(width<<1)|join like xterm UnicodeService', () => {
    const packedA = api.charProperties(0x61, 0);
    assert.equal(packedA, 2, 'plain a: width 1, no join');
    assert.equal(api.charProperties(0x0300, packedA), 3, 'combining after a: joins, takes width 1');
    assert.equal(api.charProperties(0x0300, 0), 0, 'combining after nothing: width 0, no join');
    assert.equal(api.charProperties(0x1F311, 0), 4, 'moon: width 2, no join');
    assert.equal(api.charProperties(0x26A1, 0), 4, 'lightning: width 2, no join');
    assert.equal(api.charProperties(0xFE0F, api.charProperties(0x26A1, 0)), 5,
        'combining selector preserves the preceding width');
    // combining after a wide char takes width 2 and joins
    const packedMoon = api.charProperties(0x1F311, 0);
    assert.equal(api.charProperties(0x0300, packedMoon), 5, 'combining after moon: width 2 + join');
});

test('provider exposes the xterm IUnicodeVersionProvider shape', () => {
    const p = new api.ZtermUnicodeProvider();
    assert.equal(p.version, api.VERSION);
    assert.equal(typeof p.wcwidth, 'function');
    assert.equal(typeof p.charProperties, 'function');
    assert.equal(p.wcwidth(0x1F311), 2);
});

test('installOn registers and activates the provider, warns on missing API', () => {
    const registered = [];
    const term = {
        unicode: {
            register: p => registered.push(p),
            set activeVersion(v) { this._v = v; },
            get activeVersion() { return this._v; },
        },
    };
    assert.equal(api.installOn(term), true);
    assert.equal(registered.length, 1);
    assert.equal(term.unicode.activeVersion, api.VERSION);
    // missing API -> loud false, no throw
    assert.equal(api.installOn({}), false);
    assert.equal(api.installOn(null), false);
});

test('the legacy generator refuses to overwrite the extended provider', () => {
    const script = new URL('../scripts/_gen-unicode-width.mjs', import.meta.url);
    const provider = new URL('../src/renderer/unicode-width.js', import.meta.url);
    // Never execute the old destructive generator to obtain a failing test.
    assert.match(readFileSync(script, 'utf8'), /^throw new Error\('Legacy Unicode V6 generator/m);
    const before = readFileSync(provider, 'utf8');
    const result = spawnSync(process.execPath, [fileURLToPath(script)], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Legacy Unicode V6 generator is disabled/);
    assert.equal(readFileSync(provider, 'utf8'), before);
});
