// The inline Electron clipboard stub in renderer.html must route writes
// through the Rust arboard command when running under Tauri. The old branch
// tested an undefined `isTauri` global (and called a bare `ipcRenderer` that
// is not a global either), so selection auto-copy silently fell back to
// navigator.clipboard.writeText, which rejects outside a user gesture.
//
// The stub is extracted from the real renderer.html and evaluated in a VM so
// the test exercises the shipped object literal, not a copy.
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

function makeClipboard({ tauri }) {
    const invokes = [];
    const writes = [];
    const window = {
        electron: {
            ipcRenderer: {
                invoke: (cmd, payload) => {
                    invokes.push({ cmd, payload });
                    return Promise.resolve();
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
    };
    const clipboard = vm.runInNewContext(`(${clipboardSrc})`, sandbox);
    return { clipboard, invokes, writes };
}

test('clipboard stub no longer tests the undefined isTauri global', () => {
    assert.ok(!/typeof\s+isTauri/.test(clipboardSrc), 'dead isTauri branch removed');
});

test('Tauri writeText goes through the Rust clipboard bridge', () => {
    const { clipboard, invokes, writes } = makeClipboard({ tauri: true });
    clipboard.writeText('auto-copied selection');
    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].cmd, 'clipboard-write-text');
    assert.equal(invokes[0].payload.text, 'auto-copied selection');
    assert.deepEqual(writes, [], 'navigator.writeText is not used under Tauri');
});

test('non-Tauri writeText keeps using the browser clipboard', () => {
    const { clipboard, invokes, writes } = makeClipboard({ tauri: false });
    clipboard.writeText('browser copy');
    assert.equal(invokes.length, 0, 'no backend command outside Tauri');
    assert.deepEqual(writes, ['browser copy']);
});
