// On-demand, read-only glyph metadata. Never includes terminal text or sessions.
(function (root) {
    'use strict';
    const MAX_READS = 100000;
    const MAX_SAMPLES = 32;
    const MAX_CODEPOINTS = 8;
    const attempt = (read, fallback = null) => { try { return read(); } catch (_) { return fallback; } };
    const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const string = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null;
    const size = value => value ? { width: number(value.width), height: number(value.height) } : null;
    const eligible = cp => cp >= 0xE000 && cp <= 0xF8FF
        || cp >= 0xF0000 && cp <= 0xFFFFD || cp >= 0x100000 && cp <= 0x10FFFD
        || cp >= 0x2190 && cp <= 0x2BFF || cp >= 0x1F000 && cp <= 0x1FAFF;
    const selector = cp => cp >= 0xFE00 && cp <= 0xFE0F || cp >= 0xE0100 && cp <= 0xE01EF;

    function symbolCodes(text) {
        if (typeof text !== 'string') return null;
        let codes = null, offset = 0, inspected = 0, truncated = false;
        while (offset < text.length && inspected < 16) {
            const cp = text.codePointAt(offset);
            offset += cp > 0xFFFF ? 2 : 1;
            inspected += 1;
            // Never encode ordinary letters, digits or combining text as hex.
            // Selectors are included only after an eligible symbol in this cell.
            if (!eligible(cp) && !(codes && selector(cp))) continue;
            if (!codes) codes = [];
            if (codes.length === MAX_CODEPOINTS) { truncated = true; break; }
            codes.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
        }
        return codes ? { codepoints: codes, codepointsTruncated: truncated || offset < text.length } : null;
    }

    function snapshot(term) {
        if (!term) return { version: 1, available: false };
        const options = attempt(() => term.options, {}) || {};
        const core = attempt(() => term._core);
        const renderer = attempt(() => core._renderService._renderer.value);
        const dimensions = attempt(() => renderer.dimensions);
        const dimensionGroup = group => group ? {
            char: size(group.char), cell: size(group.cell), canvas: size(group.canvas),
        } : null;
        const weight = value => typeof value === 'number' ? number(value)
            : typeof value === 'string' && /^(normal|bold|[1-9]\d{0,3})$/.test(value) ? value : null;
        const font = {
            family: string(attempt(() => options.fontFamily), 256),
            size: number(attempt(() => options.fontSize)),
            weight: weight(attempt(() => options.fontWeight)),
            weightBold: weight(attempt(() => options.fontWeightBold)),
            lineHeight: number(attempt(() => options.lineHeight)),
            letterSpacing: number(attempt(() => options.letterSpacing)),
        };
        const doc = attempt(() => term.element?.ownerDocument) || root.document;
        const fonts = attempt(() => doc.fonts);
        const status = attempt(() => fonts.status);
        const fontCheck = font.family && font.size > 0
            ? attempt(() => fonts.check(font.size + 'px ' + font.family, 'M')) : null;
        const cols = attempt(() => term.cols, 0), rows = attempt(() => term.rows, 0);
        const buffer = attempt(() => term.buffer.active);
        const viewportY = attempt(() => buffer.viewportY, 0);
        const samples = [], seen = new Set();
        let cellReads = 0, scannedCells = 0, truncated = false;
        const scratch = attempt(() => buffer.getNullCell());
        const readCell = (line, col) => {
            if (!line || col < 0 || col >= cols || cellReads >= MAX_READS) return null;
            cellReads += 1;
            return attempt(() => scratch ? line.getCell(col, scratch) : line.getCell(col));
        };
        const category = cell => {
            if (!cell) return null;
            if (attempt(() => cell.getWidth()) === 0) return 'continuation';
            const chars = attempt(() => cell.getChars());
            return chars === '' || chars === ' ' ? 'blank' : 'occupied';
        };
        if (Number.isSafeInteger(cols) && cols > 0 && Number.isSafeInteger(rows) && rows > 0
            && Number.isSafeInteger(viewportY) && viewportY >= 0) {
            scan: for (let row = 0; row < rows; row++) {
                if (cellReads >= MAX_READS || samples.length >= MAX_SAMPLES) { truncated = true; break; }
                const line = attempt(() => buffer.getLine(viewportY + row));
                if (!line) break;
                for (let col = 0; col < cols; col++) {
                    if (cellReads >= MAX_READS || samples.length >= MAX_SAMPLES) { truncated = true; break scan; }
                    const cell = readCell(line, col);
                    scannedCells += 1;
                    const width = number(attempt(() => cell.getWidth()));
                    if (!cell || width === 0) continue;
                    const codes = symbolCodes(attempt(() => cell.getChars()));
                    if (!codes) continue;
                    const bold = !!attempt(() => cell.isBold(), false);
                    const italic = !!attempt(() => cell.isItalic(), false);
                    const next = [category(readCell(line, col + 1)), category(readCell(line, col + 2))];
                    const key = codes.codepoints.join(',') + '|' + width + '|' + bold + '|' + italic + '|' + next.join(',');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    samples.push({ ...codes, width, row, col, bold, italic, next });
                }
            }
        }
        return {
            version: 1, available: true,
            provider: string(attempt(() => term.unicode.activeVersion)
                || attempt(() => core.unicodeService.activeVersion), 32),
            font,
            fontAvailability: { status: status === 'loaded' || status === 'loading' ? status : null,
                check: typeof fontCheck === 'boolean' ? fontCheck : null,
                meaning: 'availability-signal-not-resolved-glyph-font' },
            renderer: { type: !renderer ? 'missing' : renderer._gl ? 'webgl' : renderer._rowElements ? 'dom' : 'unknown',
                device: attempt(() => dimensionGroup(dimensions.device)),
                css: attempt(() => dimensionGroup(dimensions.css)),
                measuredCharCss: attempt(() => size(core._charSizeService)) },
            dpr: number(attempt(() => doc.defaultView.devicePixelRatio) ?? root.devicePixelRatio),
            viewport: { cols: number(cols), rows: number(rows), startRow: number(viewportY) },
            limits: { cellReads: MAX_READS, samples: MAX_SAMPLES, codepointsPerSample: MAX_CODEPOINTS },
            scannedCells, cellReads, truncated, samples,
        };
    }

    const api = { snapshot };
    root.__glyphDiagnostics = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
