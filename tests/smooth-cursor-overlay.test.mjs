import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SmoothCursorMotion, _smoothEaseOutCubic } =
    require('../src/renderer/smooth-cursor-overlay.js');

test('easeOutCubic starts at zero and ends at one', () => {
    assert.equal(_smoothEaseOutCubic(0), 0);
    assert.equal(_smoothEaseOutCubic(1), 1);
    assert.ok(_smoothEaseOutCubic(0.5) > 0.5);
});

test('first target is positioned immediately', () => {
    const motion = new SmoothCursorMotion({ now: () => 0 });
    assert.deepEqual(motion.setTarget(2, 3, 0), { x: 2, y: 3 });
    assert.equal(motion.animating, false);
});

test('adjacent movement interpolates and reaches target in 90ms', () => {
    const motion = new SmoothCursorMotion({ duration: 90 });
    motion.reposition(0, 0, 0);
    motion.setTarget(1, 0, 0);
    const mid = motion.tick(45);
    assert.ok(mid.x > 0.5 && mid.x < 1);
    assert.deepEqual(motion.tick(90), { x: 1, y: 0 });
    assert.equal(motion.animating, false);
});

test('large cursor jumps are immediate', () => {
    const motion = new SmoothCursorMotion({ jumpDistance: 8 });
    motion.reposition(0, 0, 0);
    assert.deepEqual(motion.setTarget(9, 0, 0), { x: 9, y: 0 });
    assert.equal(motion.animating, false);
});

test('new target continues from current visual position', () => {
    const motion = new SmoothCursorMotion({ duration: 90 });
    motion.reposition(0, 0, 0);
    motion.setTarget(1, 0, 0);
    const current = { ...motion.tick(30) };
    motion.setTarget(2, 0, 30);
    assert.deepEqual(motion.from, current);
    assert.ok(motion.tick(75).x > current.x);
});

test('reposition cancels animation and synchronizes state', () => {
    const motion = new SmoothCursorMotion({ duration: 90 });
    motion.reposition(0, 0, 0);
    motion.setTarget(1, 0, 0);
    motion.reposition(5, 6, 20);
    assert.deepEqual(motion.position, { x: 5, y: 6 });
    assert.deepEqual(motion.tick(80), { x: 5, y: 6 });
    assert.equal(motion.animating, false);
});

test('disposed motion no longer changes', () => {
    const motion = new SmoothCursorMotion({ duration: 90 });
    motion.reposition(0, 0, 0);
    motion.setTarget(1, 0, 0);
    motion.dispose();
    assert.deepEqual(motion.tick(45), { x: 0, y: 0 });
    assert.deepEqual(motion.setTarget(2, 0, 45), { x: 0, y: 0 });
});

test('invalid coordinates are normalized safely', () => {
    const motion = new SmoothCursorMotion();
    assert.deepEqual(motion.setTarget('bad', Infinity, 0), { x: 0, y: 0 });
    motion.setTarget(1, 2, 0);
    assert.deepEqual(motion.tick(90), { x: 1, y: 2 });
});

test('canvas adapter contracts are represented by the renderer module', () => {
    const source = require('node:fs').readFileSync(
        new URL('../src/renderer/smooth-cursor-overlay.js', import.meta.url), 'utf8');
    assert.match(source, /createElement\(['"]canvas['"]\)/);
    assert.match(source, /devicePixelRatio/);
    assert.match(source, /setTransform\(dpr/);
    assert.match(source, /clearRect/);
});
