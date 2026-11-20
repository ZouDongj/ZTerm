// DECSCUSR/RIS/DECSTR cursor defaults against the real vendored parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/vendor/xterm.js');
const { installCursorStyleDefaults } = require('../src/renderer/cursor-style-defaults.js');

const Terminal = globalThis.TabbyXterm.Terminal;

function fixture(options = {}) {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true, ...options });
    const defaults = installCursorStyleDefaults(term, {
        cursorStyle: term.options.cursorStyle,
        cursorBlink: term.options.cursorBlink,
    });
    return { term, defaults };
}

function write(term, data) {
    return new Promise(resolve => term.write(data, resolve));
}

function settle() {
    return new Promise(resolve => setImmediate(resolve));
}

test('explicit DECSCUSR 1-6 keeps shape and blink app-owned', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[2 q');
    assert.equal(f.term.options.cursorStyle, 'block');
    assert.equal(f.term.options.cursorBlink, false);

    await write(f.term, '\x1b[3 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);

    await write(f.term, '\x1b[6 q');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);
});

test('DECSCUSR 0 and an omitted parameter restore the user values', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    await write(f.term, '\x1b[0 q');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);

    await write(f.term, '\x1b[5 q');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, true);
    await write(f.term, '\x1b[ q');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);
});

test('RIS and DECSTR restore user values after the vendored reset', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1bc');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1b[!p');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);
});

test('an explicit shape after a reset in the same chunk stays authoritative', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1bc\x1b[3 q');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});

test('DECSCUSR sub-parameters use the primary shape parameter', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3:1 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});

test('unknown DECSCUSR parameters pass through without changing the cursor', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1b[7 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});

test('a later write wins over a deferred RIS restore', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1bc');
    await write(f.term, '\x1b[5 q');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, true);
});

test('dispose unregisters the default-restoring handlers', async t => {
    const f = fixture({ cursorStyle: 'underline', cursorBlink: true });
    t.after(() => f.term.dispose());

    f.defaults.dispose();
    await write(f.term, '\x1b[0 q');
    assert.equal(f.term.options.cursorStyle, 'block',
        'after dispose the vendored DECSCUSR 0 fallback applies');
    assert.equal(f.term.options.cursorBlink, true);
});

test('settings updates replace the remembered defaults and win immediately', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    f.defaults.setUserOptions({ cursorStyle: 'underline', cursorBlink: true });
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);

    await write(f.term, '\x1b[2 q');
    assert.equal(f.term.options.cursorStyle, 'block');
    assert.equal(f.term.options.cursorBlink, false);
    await write(f.term, '\x1b[0 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);

    await write(f.term, '\x1bc');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});
