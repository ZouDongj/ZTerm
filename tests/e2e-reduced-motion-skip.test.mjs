// Fail-closed skip classifier and E2E wiring for animation-dependent phases
// (Phases E and F of scripts/e2e-webgl-context-recovery.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  classifyAnimationPhaseSkip,
  formatSkipLine,
  formatSummaryLine,
} from '../scripts/e2e-reduced-motion-skip.mjs';

const require = createRequire(import.meta.url);
const { createReducedMotionController } = require('../src/renderer/reduced-motion.js');

test('native local console with Windows animations enabled runs even when pageReducedMotion is true', () => {
  for (const snapshot of [
    {
      source: 'native',
      nativeAnimationsEnabled: true,
      remoteSession: false,
      reducedMotion: false,
      pageReducedMotion: false,
    },
    {
      // Exact PR #56 scenario: frozen WebView2 page media query says reduce,
      // while live Win32 SPI_GETCLIENTAREAANIMATION says enabled on local console.
      source: 'native',
      nativeAnimationsEnabled: true,
      remoteSession: false,
      reducedMotion: false,
      pageReducedMotion: true,
    },
    {
      source: 'native',
      nativeAnimationsEnabled: true,
      remoteSession: false,
      reducedMotion: false,
      pageReducedMotion: null,
    },
    {
      source: 'native',
      nativeAnimationsEnabled: true,
      remoteSession: false,
    },
  ]) {
    assert.deepEqual(classifyAnimationPhaseSkip(snapshot), { skip: false, reason: null });
  }
});

test('native Remote Desktop session with animations disabled skips with exact reason', () => {
  const expectedReason =
    'remote desktop session with Windows client-area animations disabled '
    + '(nativeAnimationsEnabled=false, remoteSession=true); '
    + 'run from a local console session with Windows animation effects enabled';
  for (const pageReducedMotion of [true, false, null]) {
    assert.deepEqual(
      classifyAnimationPhaseSkip({
        source: 'native',
        nativeAnimationsEnabled: false,
        remoteSession: true,
        reducedMotion: true,
        pageReducedMotion,
      }),
      { skip: true, reason: expectedReason },
    );
  }
});

test('native local session with Windows animation effects disabled skips with exact reason', () => {
  const expectedReason =
    'Windows client-area animations disabled '
    + '(nativeAnimationsEnabled=false, remoteSession=false); '
    + 'run from a local console session with Windows animation effects enabled';
  for (const pageReducedMotion of [true, false, null]) {
    assert.deepEqual(
      classifyAnimationPhaseSkip({
        source: 'native',
        nativeAnimationsEnabled: false,
        remoteSession: false,
        reducedMotion: true,
        pageReducedMotion,
      }),
      { skip: true, reason: expectedReason },
    );
  }
});

test('native Remote Desktop session with animations enabled still skips with exact reason', () => {
  const expectedReason =
    'remote desktop session '
    + '(nativeAnimationsEnabled=true, remoteSession=true); '
    + 'run from a local console session with Windows animation effects enabled';
  assert.deepEqual(
    classifyAnimationPhaseSkip({
      source: 'native',
      nativeAnimationsEnabled: true,
      remoteSession: true,
      reducedMotion: false,
      pageReducedMotion: false,
    }),
    { skip: true, reason: expectedReason },
  );
});

test('non-native fallback sources fail closed and never skip', () => {
  for (const snapshot of [
    {
      source: 'page-match-media',
      nativeAnimationsEnabled: null,
      remoteSession: null,
      reducedMotion: true,
      pageReducedMotion: true,
    },
    {
      source: 'page-match-media',
      nativeAnimationsEnabled: false,
      remoteSession: true,
      reducedMotion: true,
      pageReducedMotion: true,
    },
    {
      source: 'matchMedia',
      nativeAnimationsEnabled: false,
      remoteSession: true,
      reducedMotion: true,
      pageReducedMotion: true,
    },
    {
      source: 'default',
      nativeAnimationsEnabled: null,
      remoteSession: null,
      reducedMotion: false,
      pageReducedMotion: null,
    },
    {
      source: 'default',
      nativeAnimationsEnabled: false,
      remoteSession: true,
      reducedMotion: true,
      pageReducedMotion: true,
    },
    {
      source: '',
      nativeAnimationsEnabled: false,
      remoteSession: true,
    },
    {
      source: null,
      nativeAnimationsEnabled: false,
      remoteSession: true,
    },
    {
      source: undefined,
      nativeAnimationsEnabled: false,
      remoteSession: true,
    },
  ]) {
    assert.deepEqual(classifyAnimationPhaseSkip(snapshot), { skip: false, reason: null });
  }
});

test('null, error, and malformed or inconsistent native snapshots fail closed and never skip', () => {
  for (const snapshot of [
    null,
    undefined,
    false,
    true,
    0,
    'native',
    [],
    {},
    new Error('ipc failed'),
    { source: 'native', nativeAnimationsEnabled: null, remoteSession: true },
    { source: 'native', nativeAnimationsEnabled: undefined, remoteSession: true },
    { source: 'native', nativeAnimationsEnabled: 'false', remoteSession: true },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: null },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: undefined },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: 'true' },
    // Contradictory reducedMotion disagrees with !nativeAnimationsEnabled.
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: true, reducedMotion: false },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: false, reducedMotion: false },
    { source: 'native', nativeAnimationsEnabled: true, remoteSession: true, reducedMotion: true },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: true, reducedMotion: null },
    { source: 'native', nativeAnimationsEnabled: false, remoteSession: true, reducedMotion: 'true' },
  ]) {
    assert.deepEqual(classifyAnimationPhaseSkip(snapshot), { skip: false, reason: null });
  }
});

test('real ZTermReducedMotion controller snapshots integrate with classifyAnimationPhaseSkip', async () => {
  function makeController(invokeImpl, pageMatches = true) {
    return createReducedMotionController({
      invoke: invokeImpl,
      on() {},
      removeListener() {},
      matchMedia: () => ({ matches: pageMatches, addEventListener() {}, removeEventListener() {} }),
      win: null,
      doc: null,
    });
  }

  // Local console with animations enabled + frozen page matchMedia=true -> run.
  const localEnabled = makeController(() => Promise.resolve({ animationsEnabled: true, remoteSession: false }), true);
  assert.deepEqual(classifyAnimationPhaseSkip(await localEnabled.refresh()), { skip: false, reason: null });

  // RDP session with animations disabled -> skip.
  const rdpDisabled = makeController(() => Promise.resolve({ animationsEnabled: false, remoteSession: true }), false);
  assert.deepEqual(classifyAnimationPhaseSkip(await rdpDisabled.refresh()), {
    skip: true,
    reason: 'remote desktop session with Windows client-area animations disabled (nativeAnimationsEnabled=false, remoteSession=true); run from a local console session with Windows animation effects enabled',
  });

  // Local console with Windows animation effects turned off -> skip.
  const localDisabled = makeController(() => Promise.resolve({ animationsEnabled: false, remoteSession: false }), false);
  assert.deepEqual(classifyAnimationPhaseSkip(await localDisabled.refresh()), {
    skip: true,
    reason: 'Windows client-area animations disabled (nativeAnimationsEnabled=false, remoteSession=false); run from a local console session with Windows animation effects enabled',
  });

  // RDP session with animations enabled -> skip.
  const rdpEnabled = makeController(() => Promise.resolve({ animationsEnabled: true, remoteSession: true }), false);
  assert.deepEqual(classifyAnimationPhaseSkip(await rdpEnabled.refresh()), {
    skip: true,
    reason: 'remote desktop session (nativeAnimationsEnabled=true, remoteSession=true); run from a local console session with Windows animation effects enabled',
  });

  // Broken IPC (rejects) falls back to page-match-media -> fail closed (DO NOT skip).
  const ipcBroken = makeController(() => Promise.reject(new Error('ipc unavailable')), true);
  const brokenSnap = await ipcBroken.refresh();
  assert.equal(brokenSnap.source, 'page-match-media');
  assert.equal(brokenSnap.reducedMotion, true);
  assert.deepEqual(classifyAnimationPhaseSkip(brokenSnap), { skip: false, reason: null });

  // Win32 SPI_GETCLIENTAREAANIMATION failure returns animationsEnabled=null -> fail closed.
  const win32Partial = makeController(() => Promise.resolve({ animationsEnabled: null, remoteSession: true }), true);
  const partialSnap = await win32Partial.refresh();
  assert.equal(partialSnap.source, 'page-match-media');
  assert.deepEqual(classifyAnimationPhaseSkip(partialSnap), { skip: false, reason: null });
});

test('skip and summary formatters keep skipped groups distinct from passed counts', () => {
  assert.equal(
    formatSkipLine('E: nvim/WebGL animation evidence (issue #31)', 'remote desktop session (nativeAnimationsEnabled=true, remoteSession=true)'),
    '↷ E: nvim/WebGL animation evidence (issue #31) — SKIPPED: remote desktop session (nativeAnimationsEnabled=true, remoteSession=true)',
  );
  assert.equal(formatSummaryLine(24, 24, 0), '24/24 项通过');
  assert.equal(formatSummaryLine(14, 14, 2), '14/14 项通过，2 组跳过');
  assert.equal(formatSummaryLine(13, 14, 2), '13/14 项通过，2 组跳过');
});

test('e2e-webgl-context-recovery wires native ZTermReducedMotion skip checks for Phases E and F', () => {
  const src = readFileSync(new URL('../scripts/e2e-webgl-context-recovery.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/e2e-reduced-motion-skip\.mjs'/);
  assert.match(src, /const startupReducedMotion = await readReducedMotionSnapshot\(cdp\);/);
  assert.match(src, /const phaseEMotion = await readNativeReducedMotion\(cdp\);/);
  assert.match(src, /const phaseESkip = classifyAnimationPhaseSkip\(phaseEMotion\);/);
  assert.match(src, /const phaseFMotion = await readNativeReducedMotion\(cdp\);/);
  assert.match(src, /const phaseFSkip = classifyAnimationPhaseSkip\(phaseFMotion\);/);
  assert.match(src, /ZTermReducedMotion\.refresh\(\)/);
  assert.match(src, /startupReducedMotion\?\.source === 'native'/);
  assert.match(src, /if \(emulatedMediaSet\)/);
  assert.match(src, /formatSummaryLine\(results\.length - failed\.length, results\.length, skippedGroups\)/);
  // Ensure the Phase E/F skip gate never falls back to raw matchMedia.
  const phaseEMatch = src.slice(src.indexOf('const startupReducedMotion'), src.indexOf('// ── Phase F:'));
  assert.doesNotMatch(phaseEMatch, /matchMedia\(/);
});
