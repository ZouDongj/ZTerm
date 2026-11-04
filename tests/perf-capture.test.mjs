import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createInteractionDiagnostics } = createRequire(import.meta.url)('../src/renderer/interaction-diagnostics.js');
const source = fs.readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');

function fixture() {
    let now = 0, next = 0, copied;
    const timers = new Map(), intervals = new Map(), frames = new Map();
    const setTimeout = (fn, ms) => { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; };
    const clearTimeout = id => timers.delete(id);
    const tab = { id: 'tab-1', tabId: 'backend-1', name: 'private-name', type: 'local', term: {
        write(data, callback) { callback?.(); },
    } };
    const diagnostics = createInteractionDiagnostics({ now: () => now, setTimeout, clearTimeout,
        resolveSource: () => ({ owner: tab }) });
    const context = { performance: { now: () => now }, setTimeout, clearTimeout,
        setInterval(fn) { const id = ++next; intervals.set(id, fn); return id; },
        clearInterval: id => intervals.delete(id),
        requestAnimationFrame(fn) { const id = ++next; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        document: { addEventListener() {} }, showToast() {}, console: { log() {} },
        navigator: { clipboard: { writeText(text) { copied = text; return Promise.resolve(); } } },
        TabManager: { tabs: [tab], getActive: () => tab, activeId: tab.id },
        ZTermDiagnostics: diagnostics,
    };
    context.window = context;
    vm.createContext(context); vm.runInContext(source, context);
    return { tab, diagnostics, context, timers, intervals, frames,
        start: () => vm.runInContext('SHORTCUT_ACTIONS.perfCapture()', context),
        report: () => JSON.parse(copied),
        advance(ms) { now += ms; for (const [id, timer] of [...timers]) {
            if (timers.has(id) && timer.at <= now) { timers.delete(id); timer.fn(); }
        } },
    };
}

test('actual capture leaves write identity and completion callback intact; default report is metadata only', () => {
    const f = fixture(), write = f.tab.term.write;
    f.start();
    assert.equal(f.tab.term.write, write);
    let parsed = false;
    f.tab.term.write('private-output', () => { parsed = true; });
    assert.equal(parsed, true);
    const token = f.diagnostics.receive(f.tab.tabId, 'private-output');
    f.diagnostics.routed(token, f.tab, 'private-output');
    f.diagnostics.inputSent(f.tab.tabId, 'private-input');
    f.advance(4000);
    assert.equal(f.tab.term.write, write);
    assert.doesNotMatch(JSON.stringify(f.report()), /private-|streamTail/);
    assert.ok(f.report().interaction.records.some(r => r.type === 'receive'));
    assert.equal(f.context.__perfCapturing, false);
    assert.equal(f.diagnostics.enabled, false);
    assert.equal(f.timers.size + f.intervals.size + f.frames.size, 0);
});

test('existing explicitly armed raw session survives capture and is never copied', () => {
    const f = fixture();
    f.diagnostics.start({ durationMs: 15000, raw: { tabId: f.tab.tabId, durationMs: 10000 } });
    const session = f.diagnostics.sessionId;
    const token = f.diagnostics.receive(f.tab.tabId, 'private-raw');
    f.diagnostics.routed(token, f.tab, 'private-raw');
    f.start(); f.advance(4000);
    assert.equal(f.diagnostics.sessionId, session);
    assert.equal(f.diagnostics.enabled, true);
    assert.equal(f.diagnostics.snapshot({ includeRaw: true }).raw.chunks[0].data, 'private-raw');
    assert.doesNotMatch(JSON.stringify(f.report()), /private-|chunks/);
    f.diagnostics.clear();
});

test('capture cannot stop a diagnostic session restarted during its window', () => {
    const f = fixture(); f.start();
    f.diagnostics.start({ durationMs: 15000 });
    const session = f.diagnostics.sessionId;
    f.advance(4000);
    assert.equal(f.diagnostics.enabled, true);
    assert.equal(f.diagnostics.sessionId, session);
    f.diagnostics.clear();
});

test('background rAF starvation and disposed adapter still finish once and clean resources', () => {
    const f = fixture();
    f.tab._smoothCursor = { _adapter: { snapshot() { throw new Error('disposed'); } } };
    f.start(); f.start(); f.advance(4000);
    assert.equal(f.report().raf.count, 0);
    assert.equal(f.report().cursor, 'no-adapter');
    assert.equal(f.timers.size + f.intervals.size + f.frames.size, 0);
    assert.equal(f.context.__perfCapturing, false);
});

test('setup failure cleans its diagnostics, timers and capture flag', () => {
    const f = fixture(); f.context.TabManager.getActive = () => { throw new Error('disposed'); };
    f.start();
    assert.equal(f.context.__perfCapturing, false);
    assert.equal(f.diagnostics.enabled, false);
    assert.equal(f.timers.size + f.intervals.size + f.frames.size, 0);
});

test('cursor gate, configuredAnimations and pre-sampling gate history are copied; ring keeps 32; private fields stay out', () => {
    const f = fixture();
    f.context._settingsConfig = { animations: true };
    f.tab._smoothCursor = { _adapter: { snapshot: () => ({
        enabled: true, smoothEnabled: true, reducedMotion: false, duration: 90, jumpDistance: 8, motionDuration: 90,
        motionGateChanges: [
            { at: -900, smoothEnabled: true, reducedMotion: false, motionDuration: 90, char: 'private-gate' },
            { at: -100, smoothEnabled: true, reducedMotion: true, motionDuration: 0, session: 'private-name' },
            { at: 250, smoothEnabled: true, reducedMotion: false, motionDuration: 90 },
        ],
        counters: { cursorDrawPasses: 1, baseDrawPasses: 2 }, retargets: [], drawPassStatus: 'base-only',
    }) } };
    f.start(); f.advance(4000);
    const report = f.report();
    assert.deepEqual(report.cursor.gate, { enabled: true, smoothEnabled: true, reducedMotion: false, duration: 90, jumpDistance: 8, motionDuration: 90 });
    assert.equal(report.cursor.configuredAnimations, true);
    // Negative dt is the point: a gate transition BEFORE the sample window is
    // the evidence this report exists for.
    assert.deepEqual(report.cursor.motionGateChanges, [
        { dt: -900, smoothEnabled: true, reducedMotion: false, motionDuration: 90 },
        { dt: -100, smoothEnabled: true, reducedMotion: true, motionDuration: 0 },
        { dt: 250, smoothEnabled: true, reducedMotion: false, motionDuration: 90 },
    ]);
    assert.doesNotMatch(JSON.stringify(report), /private-/);

    // Only the newest 32 gate changes survive, and a context without
    // _settingsConfig (or gate fields) reports nulls instead of throwing.
    const g = fixture();
    g.tab._smoothCursor = { _adapter: { snapshot: () => ({
        motionGateChanges: Array.from({ length: 34 }, (_, i) => ({ at: i * 10 - 330, smoothEnabled: true, reducedMotion: false, motionDuration: 90 })),
        counters: { cursorDrawPasses: 1, baseDrawPasses: 2 }, retargets: [], drawPassStatus: 'base-only',
    }) } };
    g.start(); g.advance(4000);
    const ring = g.report().cursor.motionGateChanges;
    assert.equal(ring.length, 32);
    assert.equal(ring[0].dt, -310, 'the two oldest entries were dropped');
    assert.equal(g.report().cursor.configuredAnimations, null);
    assert.deepEqual(g.report().cursor.gate, { enabled: null, smoothEnabled: null, reducedMotion: null, duration: null, jumpDistance: null, motionDuration: null });

    // Only a real boolean passes through (false = animations disabled is a
    // legitimate setting); abnormal string/object values never enter the
    // clipboard report.
    const animationCases = [
        { animations: false, expected: false },
        { animations: 'private-animations', expected: null },
        { animations: { smooth: 'private-object' }, expected: null },
    ];
    for (const { animations, expected } of animationCases) {
        const h = fixture();
        h.context._settingsConfig = { animations };
        h.tab._smoothCursor = { _adapter: { snapshot: () => ({
            counters: { cursorDrawPasses: 1, baseDrawPasses: 2 }, retargets: [], drawPassStatus: 'base-only',
        }) } };
        h.start(); h.advance(4000);
        assert.equal(h.report().cursor.configuredAnimations, expected);
        assert.doesNotMatch(JSON.stringify(h.report()), /private-/);
    }
});

test('caret report explicitly whitelists metadata and excludes descriptor characters and injected reasons', () => {
    const f = fixture();
    f.tab._inkObserver = { state: () => ({ positionKnown: false, positionReason: 'private-reason', checkpointReason: 'open-lexical-unit', recoveries: 2, char: 'private-observer' }) };
    f.tab._smoothCursor = { _adapter: { snapshot: () => ({
        counters: { cursorDrawPasses: 1, baseDrawPasses: 2 }, retargets: [], drawPassStatus: 'base-only',
        lastSoftwareCursor: { char: 'private-caret' }, lastGlyph: { chars: 'private-glyph' },
        caretOwnership: { customDrawSource: 'protocol', active: false, queued: 4, parsed: 3, generation: 1, trustRun: 0, reason: 'private-adapter', char: 'private-extra' },
    }) } };
    f.start(); for (const interval of f.intervals.values()) interval(); f.advance(4000);
    const report = f.report();
    // Metadata may name glyph diagnostics; raw cursor text fields must remain absent.
    assert.doesNotMatch(JSON.stringify(report), /private-|"(?:char|chars|glyph|lastGlyph|lastSoftwareCursor)"\s*:/);
    assert.equal(report.cursor.caret.customDrawSource, 'protocol');
    assert.equal(report.cursor.caret.positionKnown, false);
    assert.equal(report.cursor.caret.checkpointReason, 'open-lexical-unit');
    assert.equal(report.cursor.caret.reason, null);
    assert.equal(report.cursor.caret.positionReason, null);
    assert.equal(report.cursor.timeline[0].caret.queued, 4);
});
