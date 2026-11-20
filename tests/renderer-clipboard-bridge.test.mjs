// The inline Electron clipboard stub in renderer.html must route plain-text
// writes through the Rust arboard command when running under Tauri. The old
// branch tested an undefined `isTauri` global, so selection auto-copy silently
// fell back to navigator.clipboard.writeText, which rejects outside a user
// gesture.
//
// The stub receives window.electron from ipc-polyfill.js, which loads before
// the inline script (renderer.html:1043); only __TAURI__ may be injected
// later, so the stub checks it at call time. The extracted object literal is
// evaluated in a VM with fake timers so the trailing debounce is exercised.
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

function makeClipboard({ tauri, rejectInvoke = false }) {
    const invokes = [];
    const writes = [];
    const timers = new Map();
    let nextTimer = 1;
    const window = {
        electron: {
            ipcRenderer: {
                invoke: (cmd, payload) => {
                    invokes.push({ cmd, payload });
                    return rejectInvoke ? Promise.reject(new Error('bridge down')) : Promise.resolve();
                },
            },
        },
    };
    if (tauri) window.__TAURI__ = { event: {} };
    const sandbox = {
        window,
        navigator: { clipboard: { writeText: (text) => { writes.push(text); return Promise.resolve(); } } },
        ClipboardItem: class {},
        Blob,
        console,
        setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearTimeout: (id) => { timers.delete(id); },
    };
    const clipboard = vm.runInNewContext(`const electronClipboard = ${clipboardSrc};\nelectronClipboard;`, sandbox);
    return {
        clipboard,
        invokes,
        writes,
        flushTimers: () => {
            const pending = Array.from(timers.values());
            timers.clear();
            for (const fn of pending) fn();
        },
    };
}

const drain = () => new Promise(resolve => setImmediate(resolve));

test('clipboard stub no longer tests the undefined isTauri global', () => {
    assert.ok(!/typeof\s+isTauri/.test(clipboardSrc), 'dead isTauri branch removed');
});

test('Tauri writeText debounces selection updates into one backend write', () => {
    const { clipboard, invokes, writes, flushTimers } = makeClipboard({ tauri: true });
    clipboard.writeText('a');
    clipboard.writeText('ab');
    clipboard.writeText('abc');
    assert.equal(invokes.length, 0, 'no write while a drag is still updating the selection');

    flushTimers();
    assert.equal(invokes.length, 1, 'one trailing write for the whole drag');
    assert.equal(invokes[0].cmd, 'clipboard-write-text');
    assert.equal(invokes[0].payload.text, 'abc', 'the latest selection wins');
    assert.deepEqual(writes, [], 'navigator.writeText is not used while the bridge works');
});

test('a rejected bridge write falls back to the browser clipboard', async () => {
    const { clipboard, invokes, writes, flushTimers } = makeClipboard({ tauri: true, rejectInvoke: true });
    clipboard.writeText('fallback text');
    flushTimers();
    await drain();

    assert.equal(invokes.length, 1);
    assert.deepEqual(writes, ['fallback text'], 'a failed backend write is not silent');
});

test('cancelPendingWriteText drops a queued selection write before a direct write', () => {
    const { clipboard, invokes, writes, flushTimers } = makeClipboard({ tauri: true });
    clipboard.writeText('stale selection');
    clipboard.cancelPendingWriteText();
    flushTimers();

    assert.equal(invokes.length, 0, 'the superseded selection is never written');
    assert.deepEqual(writes, [], 'no browser write either');

    // A later direct write still works normally.
    clipboard.writeText('new selection');
    flushTimers();
    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].payload.text, 'new selection');
});

test('non-Tauri writeText keeps using the browser clipboard immediately', () => {
    const { clipboard, invokes, writes, flushTimers } = makeClipboard({ tauri: false });
    clipboard.writeText('browser copy');
    assert.equal(invokes.length, 0, 'no backend command outside Tauri');
    assert.deepEqual(writes, ['browser copy']);
    assert.equal(flushTimers(), undefined);
});
