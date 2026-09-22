import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const widths = require('../src/renderer/unicode-width.js');
const { snapshot } = require('../src/renderer/glyph-diagnostics.js');
const write = (term, text) => new Promise(resolve => term.write(text, resolve));

test('actual bundled buffer yields only symbol metadata, never normal text or session data', async () => {
    const term = new globalThis.TabbyXterm.Terminal({ cols: 80, rows: 4, allowProposedApi: true,
        fontFamily: 'Fixture NF', fontSize: 16, fontWeight: '400', fontWeightBold: '600', lineHeight: 1.125 });
    widths.installOn(term);
    try {
        await write(term, 'CANARY_SECRET ssh private-user@private-host https://private.invalid/path\r\nA\u{F024B} B\u26A1C\uF07B\uFE0F\u0301');
        term.sessionName = 'CANARY_SESSION';
        term.command = 'CANARY_COMMAND';
        const before = term.buffer.active.getLine(1).translateToString();
        const result = snapshot(term);
        assert.equal(result.provider, 'zterm6');
        assert.equal(result.font.family, 'Fixture NF');
        assert.equal(result.renderer.type, 'missing');
        const folder = result.samples.find(s => s.codepoints[0] === 'U+F024B');
        assert.equal(folder.width, 1);
        assert.deepEqual(folder.next, ['blank', 'occupied']);
        const lightning = result.samples.find(s => s.codepoints[0] === 'U+26A1');
        assert.equal(lightning.width, 2);
        assert.deepEqual(lightning.next, ['continuation', 'occupied']);
        assert.deepEqual(result.samples.find(s => s.codepoints[0] === 'U+F07B').codepoints, ['U+F07B', 'U+FE0F']);
        assert.doesNotMatch(JSON.stringify(result), /CANARY|private|https|U\+0301|U\+0041/);
        assert.equal(term.buffer.active.getLine(1).translateToString(), before);
    } finally { term.dispose(); }
});

test('actual scrollback uses viewportY and samples are capped', async () => {
    const term = new globalThis.TabbyXterm.Terminal({ cols: 80, rows: 2, allowProposedApi: true });
    widths.installOn(term);
    try {
        await write(term, '\uF07B\r\n\uF120\r\n\uF024\r\n' + Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0xE100 + i)).join(''));
        const bottom = snapshot(term);
        assert.ok(bottom.viewport.startRow > 0);
        assert.equal(bottom.samples.length, 32);
        assert.equal(bottom.truncated, true);
        assert.ok(bottom.cellReads <= 100000);
        // A headless Terminal has no DOM viewport; use its real buffer service
        // to perform the same scrollback transition before the public read.
        term._core._bufferService.scrollLines(-term.buffer.active.viewportY);
        const top = snapshot(term);
        assert.equal(top.viewport.startRow, 0);
        assert.ok(top.samples.some(s => s.codepoints[0] === 'U+F07B'));
        assert.ok(!top.samples.some(s => s.codepoints[0] === 'U+E100'));
    } finally { term.dispose(); }
});

test('fixed read budget also counts neighbor reads and never encodes trailing letters', () => {
    let reads = 0;
    const cell = { getWidth: () => 1, getChars: () => '\uF07BPRIVATE123\uFE0F\u0301', isBold: () => false, isItalic: () => false };
    const line = { getCell() { reads += 1; return cell; } };
    const term = { cols: 200000, rows: 1, buffer: { active: { viewportY: 7, getLine: () => line } } };
    const result = snapshot(term);
    assert.equal(reads, 100000);
    assert.equal(result.cellReads, 100000);
    assert.equal(result.truncated, true);
    assert.ok(result.samples.every(s => s.codepoints.every(cp => cp === 'U+F07B' || cp === 'U+FE0F')));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|U\+0050|U\+0031|U\+0301/);
});

test('missing or partial internals are safe and font availability is only an explicit signal', () => {
    assert.deepEqual(snapshot(null), { version: 1, available: false });
    assert.deepEqual(snapshot({}).samples, []);
    let checked;
    const term = { options: { fontFamily: 'Fixture NF', fontSize: 16 },
        element: { ownerDocument: { fonts: { status: 'loaded', check(font, text) { checked = [font, text]; return true; } }, defaultView: { devicePixelRatio: 1.5 } } },
        _core: { _charSizeService: { width: 9.6, height: 18 }, _renderService: { _renderer: { value: {
            _gl: {}, dimensions: { device: { char: { width: 14, height: 27 }, cell: { width: 14, height: 30 } }, css: { cell: { width: 9.333, height: 20 } } },
        } } } },
    };
    const result = snapshot(term);
    assert.equal(result.renderer.type, 'webgl');
    assert.equal(result.renderer.measuredCharCss.width, 9.6);
    assert.equal(result.renderer.device.cell.width, 14);
    assert.equal(result.dpr, 1.5);
    assert.deepEqual(checked, ['16px Fixture NF', 'M']);
    assert.equal(result.fontAvailability.check, true);
    assert.match(result.fontAvailability.meaning, /not-resolved-glyph-font/);
    term.element.ownerDocument.fonts.check = () => { throw new Error('unavailable'); };
    assert.equal(snapshot(term).fontAvailability.check, null);
});
