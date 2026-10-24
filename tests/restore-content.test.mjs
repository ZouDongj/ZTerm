// ZTerm - restart-restore content capture/replay pure-logic unit tests (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    appendContentTail, normalizeRestoredContent, truncateAtLastAltBalance,
    displayOnlyReplay, replayPayload, REPLAY_EPILOGUE, MAX_CONTENT_TAIL,
} = require('../src/renderer/restore-content.js');

// ── appendContentTail: chunk boundaries are not line boundaries ──

test('append: a line split across chunks survives intact (issue #14 regression)', () => {
    let tail = appendContentTail('', 'ec');
    tail = appendContentTail(tail, 'ho te');
    tail = appendContentTail(tail, 'st\r\n');
    assert.equal(tail, 'echo test\r\n');
});

test('append: per-keystroke echo chunks never become one line per character', () => {
    let tail = '';
    for (const ch of ['e', 'c', 'h', 'o', ' ', 't', 'e', 'st']) {
        tail = appendContentTail(tail, ch);
    }
    assert.equal(tail, 'echo test');
});

test('append: empty or invalid chunks leave the tail untouched', () => {
    assert.equal(appendContentTail('ab', ''), 'ab');
    assert.equal(appendContentTail('ab', null), 'ab');
    assert.equal(appendContentTail('ab', undefined), 'ab');
    assert.equal(appendContentTail(undefined, 'x'), 'x');
    assert.equal(appendContentTail(null, 'y'), 'y');
});

test('append: over-cap trim keeps length bounded and starts after a newline', () => {
    const maxTail = 40;
    let tail = appendContentTail('x'.repeat(30) + '\n', 'y'.repeat(30), maxTail);
    assert.ok(tail.length <= maxTail, `length ${tail.length} <= ${maxTail}`);
    assert.equal(tail, 'y'.repeat(30));
});

test('append: over-cap window without any newline keeps the raw slice', () => {
    const maxTail = 40;
    const tail = appendContentTail('', 'a'.repeat(100), maxTail);
    assert.equal(tail.length, maxTail);
    assert.equal(tail, 'a'.repeat(maxTail));
});

// ── normalizeRestoredContent: legacy array saves ──

test('normalize: legacy line array joins exactly like the old replay', () => {
    assert.equal(normalizeRestoredContent(['a', 'b']), 'a\r\nb');
    assert.equal(normalizeRestoredContent(['a', 42, null, 'b']), 'a\r\nb');
    assert.equal(normalizeRestoredContent([]), '');
    assert.equal(normalizeRestoredContent('raw tail'), 'raw tail');
    assert.equal(normalizeRestoredContent(null), '');
    assert.equal(normalizeRestoredContent(42), '');
});

// ── replayPayload: replay bytes composition ──

test('replay: non-empty content ends with the exact state-reset epilogue', () => {
    const payload = replayPayload('some output\r\n');
    assert.equal(payload, 'some output\r\n' + REPLAY_EPILOGUE);
    assert.ok(payload.endsWith('\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x0f\x1b[0m\x1b[?25h\r\n'));
});

test('replay: empty content replays nothing (no lone epilogue)', () => {
    assert.equal(replayPayload(''), '');
    assert.equal(replayPayload([]), '');
    assert.equal(replayPayload(null), '');
});

test('replay: content ending with cursor-hide is followed by cursor-show', () => {
    const payload = replayPayload('prompt> \x1b[?25l');
    const hide = payload.indexOf('\x1b[?25l');
    const show = payload.indexOf('\x1b[?25h');
    assert.ok(hide >= 0);
    assert.ok(show > hide);
});

// ── truncateAtLastAltBalance: alternate-screen safety ──

test('alt-balance: balanced enter/exit pair inside the text is kept unchanged', () => {
    const text = 'pre\r\n\x1b[?1049hTUI frame\x1b[?1049lpost\r\n';
    assert.equal(truncateAtLastAltBalance(text), text);
});

test('alt-balance: trailing unmatched enter truncates at the last balanced point', () => {
    assert.equal(truncateAtLastAltBalance('pre\r\n\x1b[?1049hTUI junk'), 'pre\r\n');
    assert.equal(truncateAtLastAltBalance('\x1b[?1049h'), '');
});

test('alt-balance: stray exit (uncaptured enter) is stripped, content survives', () => {
    // A stray exit must NOT be replayed: this xterm build's DECRST 1049
    // unconditionally restores the saved cursor, teleporting it to (0,0) and
    // letting post-exit output overwrite the restored history from the top.
    const text = '\x1b[?1049lrestored text\r\n';
    assert.equal(truncateAtLastAltBalance(text), 'restored text\r\n');
    // Stray exit between balanced segments must not poison later balance, and
    // the balanced pair itself stays verbatim.
    const mixed = 'a\x1b[?1049l\r\nb\x1b[?1049hx\x1b[?1049lc\r\n';
    assert.equal(truncateAtLastAltBalance(mixed), 'a\r\nb\x1b[?1049hx\x1b[?1049lc\r\n');
});

test('replay: post-TUI output no longer overwrites pre-TUI history (stray exit)', () => {
    // The empirical review scenario: enter chunk not captured, exit chunk
    // captured (the common vim/less shape). The stray token must be gone.
    const tail = 'PS C:\\> vim file\r\n' + '\r\n\x1b[?1049l' + 'PS C:\\> echo done\r\n';
    const payload = replayPayload(tail);
    assert.ok(!payload.includes('\x1b[?1049l'), 'stray exit must be stripped');
    assert.ok(payload.startsWith('PS C:\\> vim file\r\n\r\nPS C:\\> echo done\r\n'));
});

// ── default cap sanity ──

test('append: default cap bounds the tail at MAX_CONTENT_TAIL', () => {
    let tail = '';
    // 3 oversized lines: the trim must drop whole leading lines, never land mid-line.
    const line = 'z'.repeat(MAX_CONTENT_TAIL / 2) + '\n';
    tail = appendContentTail(tail, line);
    tail = appendContentTail(tail, line);
    tail = appendContentTail(tail, line);
    assert.ok(tail.length <= MAX_CONTENT_TAIL);
    // The window starts 2 chars into line 2; the newline advance lands exactly at line 3.
    assert.equal(tail, line);
});

test('display replay retains ANSI rendering while removing requests and input modes', () => {
    const display = '\x1b[31mred\x1b[0m\r\n\x1b[2D\x1b[K\x1b7\x1b8\x1b(0line\x1b(B';
    assert.equal(displayOnlyReplay(display), display);
    const requests = '\x1b[6n\x1b[c\x1b[>0c\x1b[?25$p\x1b[18t\x1b[?2004h\x1b[>1u';
    assert.equal(displayOnlyReplay('before' + requests + 'after'), 'beforeafter');
});

test('display replay handles C1 strings, controls, cancellation and printable payload tails safely', () => {
    assert.equal(displayOnlyReplay('a\x9d52;c;?\x9cb\x90$qm\x9cc'), 'abc');
    assert.equal(displayOnlyReplay('a\x98ignored\x9cb\x9eignored\x9cc\x9fignored\x9cd'), 'abcd');
    assert.equal(displayOnlyReplay('\x9b31mred\x9b0m\x9b6n'), '\x1b[31mred\x1b[0m');
    assert.equal(displayOnlyReplay('a\x1b]2;old\x18b\x1bP$qm\x1ac'), 'abc');
    // Capture may start midway through a discarded control payload. It may
    // display as literal text, but its later controls still cannot execute.
    assert.equal(displayOnlyReplay('52;c;?\x07\x1b[6nvisible'), '52;c;?visible');
});

test('incomplete control tails cannot consume the epilogue or the next live output', () => {
    for (const tail of ['\x1b', '\x1b[', '\x1b[31;', '\x1b(', '\x1b]52;c;', '\x1bP$q', '\x9d52;c;', '\x9b31;']) {
        assert.equal(replayPayload('visible' + tail), 'visible' + REPLAY_EPILOGUE, JSON.stringify(tail));
    }
    assert.equal(displayOnlyReplay('a\x1b[12\x1b]52;c;?\x07b'), 'ab');
});
