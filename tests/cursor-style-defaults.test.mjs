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

test('RIS and DECSTR restore user values synchronously before the write callback', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1bc');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1b[!p');
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, false);
});

test('an explicit shape after a reset in the same chunk stays authoritative', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1bc\x1b[3 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});

test('same-chunk CSI ?12h/l, DECRQSS, and DECSCUSR > 6 after RIS/DECSTR stay intact', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    // tput reset + tput cvvis: ?12h enables blink right after RIS.
    await write(f.term, '\x1bc\x1b[?12h');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, true);

    // DECSTR followed by ?12l disables blink when user default blinks.
    f.defaults.setUserOptions({ cursorStyle: 'underline', cursorBlink: true });
    await write(f.term, '\x1b[!p\x1b[?12l');
    await settle();
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, false);

    // DECRQSS in the same chunk observes the restored defaults immediately.
    f.defaults.setUserOptions({ cursorStyle: 'bar', cursorBlink: false });
    const replies = [];
    const sub = f.term.onData(data => replies.push(data));
    t.after(() => sub.dispose());
    await write(f.term, '\x1b[1 q');
    await write(f.term, '\x1bc\x1bP$q q\x1b\\');
    assert.equal(replies.join(''), '\x1bP1$r6 q\x1b\\');

    // DECSCUSR > 6 fallthrough after RIS keeps xterm's result.
    await write(f.term, '\x1bc\x1b[7 q');
    await settle();
    assert.equal(f.term.options.cursorBlink, true);
});

test('dispose inside a RIS write callback leaves subsequent mutations untouched', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    await new Promise(resolve => {
        f.term.write('\x1bc', () => {
            assert.equal(f.term.options.cursorStyle, 'bar');
            f.defaults.dispose();
            f.term.options.cursorStyle = 'block';
            f.term.options.cursorBlink = true;
            f.defaults.setUserOptions({ cursorStyle: 'underline', cursorBlink: false });
            resolve();
        });
    });
    await settle();
    assert.equal(f.term.options.cursorStyle, 'block');
    assert.equal(f.term.options.cursorBlink, true);
});

test('missing registerEscHandler refuses installation cleanly', () => {
    let csiCalls = 0;
    const term = {
        parser: { registerCsiHandler() { csiCalls += 1; return { dispose() {} }; } },
        options: { cursorStyle: 'bar', cursorBlink: false },
    };
    assert.equal(installCursorStyleDefaults(term, {}), null);
    assert.equal(csiCalls, 0);
});

test('DECSCUSR sub-parameters use the primary shape parameter', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3:1 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, true);
});

test('values above 6 fall through to the vendored handler', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await write(f.term, '\x1b[3 q');
    await write(f.term, '\x1b[8 q');
    assert.equal(f.term.options.cursorStyle, 'underline');
    assert.equal(f.term.options.cursorBlink, false);
});

test('a later chunk wins over a deferred RIS restore', async t => {
    const f = fixture({ cursorStyle: 'bar', cursorBlink: false });
    t.after(() => f.term.dispose());

    await Promise.all([write(f.term, '\x1bc'), write(f.term, '\x1b[5 q')]);
    await settle();
    assert.equal(f.term.options.cursorStyle, 'bar');
    assert.equal(f.term.options.cursorBlink, true);
});

test('a partial registration failure disposes the handlers already installed', () => {
    const disposed = [];
    let registrations = 0;
    const register = () => {
        registrations += 1;
        const id = registrations;
        if (id === 2) throw new Error('registration failed');
        return { dispose() { disposed.push(id); } };
    };
    const parser = { registerCsiHandler: register, registerEscHandler: register };
    const term = { parser, options: { cursorStyle: 'bar', cursorBlink: false } };
    assert.throws(() => installCursorStyleDefaults(term, {}), /registration failed/);
    assert.deepEqual(disposed, [1], 'the installed DECSCUSR handler must be disposed');
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
