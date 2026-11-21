// The inline Electron clipboard stub in renderer.html must route plain-text
// writes through the Rust arboard command when running under Tauri. The old
// branch tested an undefined `isTauri` global, so selection auto-copy silently
// fell back to navigator.clipboard.writeText, which rejects outside a user
// gesture.
//
// The stub receives window.electron from ipc-polyfill.js, which loads before
// the inline script (renderer.html:1043); only __TAURI__ may be injected
// later, so the stub checks it at call time. Writes are immediate: xterm only
// fires selectionchange on mouseup, so deferring the write would let a paste
// in the gap read the previous clipboard. The stub also tracks a write
// generation so a failed bridge write cannot fall back over a newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');

function extractObjectLiteral(source, name) {
    const marker = `const ${name} = `;
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${name} definition found in renderer.html`);
    const start = source.indexOf('{', at);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated ${name} object literal`);
}

const clipboardSrc = extractObjectLiteral(html, 'electronClipboard');

// defer: the returned invoke promise stays pending and records its resolve and
// reject handles, so a test can settle the bridge write out of order.
function makeClipboard({ tauri = false, defer = false } = {}) {
    const invokes = [];
    const writes = [];
    const richWrites = [];
    const warnings = [];
    const timers = [];
    const window = {
        electron: {
            ipcRenderer: {
                invoke: (cmd, payload) => {
                    const call = { cmd, payload };
                    invokes.push(call);
                    if (!defer) return Promise.resolve();
                    return new Promise((resolve, reject) => {
                        call.resolve = resolve;
                        call.reject = reject;
                    });
                },
            },
        },
    };
    if (tauri) window.__TAURI__ = { event: {} };
    const sandbox = {
        window,
        navigator: {
            clipboard: {
                writeText: (text) => { writes.push(text); return Promise.resolve(); },
                write: (items) => { richWrites.push(items); return Promise.resolve(); },
            },
        },
        ClipboardItem: class { constructor(items) { this.items = items; } },
        Blob,
        console: {
            log() {},
            warn: (...args) => warnings.push(args),
            error: (...args) => warnings.push(args),
        },
        setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
        clearTimeout: (id) => { timers[id - 1] = null; },
    };
    const clipboard = vm.runInNewContext(`const electronClipboard = ${clipboardSrc};\nelectronClipboard;`, sandbox);
    return { clipboard, window, invokes, writes, richWrites, warnings, timers };
}

const drain = () => new Promise(resolve => setImmediate(resolve));

test('clipboard stub no longer tests the undefined isTauri global', () => {
    assert.ok(!/typeof\s+isTauri/.test(clipboardSrc), 'dead isTauri branch removed');
});

test('writeText detects __TAURI__ at call time, not at load time', () => {
    const { clipboard, window, invokes, writes } = makeClipboard();
    // The stub is evaluated while __TAURI__ is still undefined, exactly as in
    // the page before Tauri's initialization script lands.
    window.__TAURI__ = { event: {} };
    clipboard.writeText('selection');

    assert.equal(invokes.length, 1, 'the late-injected Tauri bridge is used');
    assert.equal(invokes[0].cmd, 'clipboard-write-text');
    assert.equal(invokes[0].payload.text, 'selection');
    assert.deepEqual(writes, [], 'navigator.writeText is not used under Tauri');
});

test('writeText invokes the bridge synchronously, without a debounce', () => {
    const { clipboard, invokes, writes, timers } = makeClipboard({ tauri: true });
    clipboard.writeText('a');

    assert.equal(invokes.length, 1, 'the backend write starts inside the call');
    assert.equal(invokes[0].cmd, 'clipboard-write-text');
    assert.equal(invokes[0].payload.text, 'a');
    assert.equal(timers.length, 0, 'no deferred write is scheduled');
    assert.deepEqual(writes, [], 'navigator.writeText is not used while the bridge works');

    // A second selection must not be coalesced into a later trailing write.
    clipboard.writeText('ab');
    assert.equal(invokes.length, 2, 'every selection writes immediately');
    assert.equal(invokes[1].payload.text, 'ab');
});

test('a rejection of an older bridge write does not overwrite a newer one', async () => {
    const { clipboard, invokes, writes, warnings } = makeClipboard({ tauri: true, defer: true });
    clipboard.writeText('old selection');
    clipboard.writeText('new selection');
    assert.equal(invokes.length, 2);

    invokes[0].reject(new Error('ClipboardOccupied'));
    await drain();

    assert.deepEqual(writes, [], 'the superseded text never reaches the browser clipboard');
    assert.equal(warnings.length, 1, 'the bridge failure is observable in the console');
    assert.match(String(warnings[0][0]), /clipboard bridge write failed/);
});

test('a rejection of the latest bridge write falls back to the browser clipboard', async () => {
    const { clipboard, invokes, writes } = makeClipboard({ tauri: true, defer: true });
    clipboard.writeText('fallback text');

    invokes[0].reject(new Error('ClipboardOccupied'));
    await drain();

    assert.deepEqual(writes, ['fallback text'], 'a failed backend write is not silent');
});

test('a direct bridge write supersedes an in-flight failure fallback', async () => {
    const { clipboard, invokes, writes } = makeClipboard({ tauri: true, defer: true });
    clipboard.writeText('old selection');
    // The context menu and OSC 52 write the bridge directly and announce it.
    clipboard.noteDirectWrite();

    invokes[0].reject(new Error('ClipboardOccupied'));
    await drain();

    assert.deepEqual(writes, [], 'the older selection must not overwrite the direct write');
});

test('a rich-text write supersedes an in-flight failure fallback', async () => {
    const { clipboard, invokes, writes } = makeClipboard({ tauri: true, defer: true });
    clipboard.writeText('old selection');
    clipboard.write({ text: 'rich', html: '<b>rich</b>' });
    assert.equal(clipboard._writeSeq, 2, 'the rich-text write advanced the generation');

    invokes[0].reject(new Error('ClipboardOccupied'));
    await drain();

    assert.deepEqual(writes, [], 'the older selection must not overwrite the rich-text write');
});

test('non-Tauri writeText goes straight to the browser clipboard without IPC', () => {
    const { clipboard, invokes, writes, timers } = makeClipboard();
    clipboard.writeText('browser copy');

    assert.deepEqual(invokes, [], 'no backend command outside Tauri');
    assert.deepEqual(writes, ['browser copy'], 'the browser clipboard is written synchronously');
    assert.equal(timers.length, 0, 'no deferred write is scheduled');
});
