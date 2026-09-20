// Unit tests for the zterm6 unicode width provider (ADR-0002 item 2 rework:
// kimi's tip line writes U+1F311 assuming 2 cells — field capture — while
// the vendored UnicodeV6 returns 1 for every astral emoji; the 2-cell glyph
// then overflows into the un-erased neighbor cell and shows stale text).
// The provider must keep exact V6 semantics for the BMP and widen only the
// four plane-1 pictographic blocks modern width libraries treat as 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../src/renderer/unicode-width.js');

const WIDTHS = [
    // V6 parity (BMP)
    [0x00, 0, 'NUL'], [0x1F, 0, 'control'], [0x41, 1, 'ASCII'], [0x7F, 0, 'DEL'],
    [0x4E2D, 2, 'CJK'], [0x1100, 2, 'Hangul jamo'], [0x0300, 0, 'combining grave'],
    [0x20D0, 0, 'combining 8400s'], [0xFE0F, 0, 'VS16'], [0x2329, 2, '9001 override'],
    [0x232A, 2, '9002 override'], [0x303F, 1, '12351 override'], [0x2728, 1, 'sparkles BMP stays 1'],
    // Astral V6 parity
    [0x10000, 1, 'Linear B stays 1'], [0x1D167, 0, 'astral combining'],
    [0x20000, 2, 'CJK ext B'], [0x2FFFD, 2, 'CJK ext edge'], [0x30000, 2, 'CJK ext G'],
    // The widened plane-1 pictographic blocks
    [0x1F311, 2, 'new moon (field case)'], [0x1F318, 2, 'waning crescent'],
    [0x1F300, 2, 'block edge low'], [0x1F64F, 2, 'block edge high'],
    [0x1F680, 2, 'rocket'], [0x1F6FF, 2, 'transport edge'],
    [0x1F900, 2, 'supplemental edge'], [0x1F9FF, 2, 'supplemental high'],
    [0x1FA70, 2, 'extended-A edge'], [0x1FAFF, 2, 'extended-A high'],
    // Neighbors that must NOT be widened
    [0x1F650, 1, 'ornamental dingbats stay 1'], [0x1F67F, 1, 'below transport stays 1'],
    [0x1F700, 1, 'alchemical stays 1'], [0x1FB00, 1, 'above extended-A stays 1'],
];

test('wcwidth: V6 parity plus plane-1 pictographic widening', () => {
    for (const [cp, want, name] of WIDTHS) {
        assert.equal(api.wcwidth(cp), want, `${name} (U+${cp.toString(16).toUpperCase()})`);
    }
});

test('charProperties packs (kind<<3)|(width<<1)|join like xterm UnicodeService', () => {
    const packedA = api.charProperties(0x61, 0);
    assert.equal(packedA, 2, 'plain a: width 1, no join');
    assert.equal(api.charProperties(0x0300, packedA), 3, 'combining after a: joins, takes width 1');
    assert.equal(api.charProperties(0x0300, 0), 0, 'combining after nothing: width 0, no join');
    assert.equal(api.charProperties(0x1F311, 0), 4, 'moon: width 2, no join');
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
