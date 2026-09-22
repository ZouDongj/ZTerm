import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const shortcuts = readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');
const start = shortcuts.indexOf('// Opt-in capture only: no terminal text');
const end = shortcuts.indexOf('            const report = {', start);
assert.ok(start >= 0 && end > start);
const capture = shortcuts.slice(start, end);

function run(active, snapshot) {
    const context = vm.createContext({
        TabManager: { getActive: () => active },
        getAllPanes: tab => tab.panes,
        __glyphDiagnostics: snapshot ? { snapshot } : undefined,
    });
    return JSON.parse(JSON.stringify(vm.runInContext(`(() => { ${capture}; return glyphs; })()`, context)));
}

test('glyph diagnostic module loads before the explicit performance shortcut', () => {
    const html = readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');
    const module = html.indexOf('renderer/glyph-diagnostics.js');
    assert.ok(module >= 0 && module < html.indexOf('renderer/shortcuts.js'));
    assert.match(shortcuts.slice(end, end + 1200), /\n\s+glyphs,/);
});

test('capture reads the current tab, bounds split panes, and tolerates missing diagnostics', () => {
    assert.deepEqual(run({ term: 3 }, term => ({ measured: term })), {
        scope: 'active-tab-at-capture-end', panes: [{ measured: 3 }], truncatedPanes: false,
    });
    const split = { splitRoot: {}, panes: Array.from({ length: 20 }, (_, term) => ({ term })) };
    let calls = 0;
    const result = run(split, term => { calls++; return { measured: term }; });
    assert.equal(calls, 8);
    assert.equal(result.panes.length, 8);
    assert.equal(result.truncatedPanes, true);
    assert.deepEqual(run(null), { scope: 'active-tab-at-capture-end', panes: [], truncatedPanes: false });
    assert.deepEqual(run({ term: 3 }).panes, [null]);
    assert.deepEqual(run({ term: 3 }, () => { throw Error('disposed'); }), { unavailable: true });
});
