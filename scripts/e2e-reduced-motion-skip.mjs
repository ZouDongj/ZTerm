// Fail-closed skip classifier and report formatting for animation-dependent
// phases (Phases E and F) of scripts/e2e-webgl-context-recovery.mjs.
//
// Only an authoritative native snapshot from ZTermReducedMotion
// (source === 'native', backed by Win32 SPI_GETCLIENTAREAANIMATION and
// SM_REMOTESESSION) may authorize skipping Phases E and F. Any missing,
// malformed, inconsistent, or fallback snapshot (such as 'page-match-media'
// or 'default') fails closed and returns { skip: false, reason: null } so a
// broken native IPC gate fails loudly instead of being masked as SKIPPED.
export function classifyAnimationPhaseSkip(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { skip: false, reason: null };
  }
  if (snapshot.source !== 'native') {
    return { skip: false, reason: null };
  }
  const { nativeAnimationsEnabled, remoteSession, reducedMotion } = snapshot;
  if (typeof nativeAnimationsEnabled !== 'boolean' || typeof remoteSession !== 'boolean') {
    return { skip: false, reason: null };
  }
  // When ZTermReducedMotion reports source === 'native', reducedMotion is
  // strictly !nativeAnimationsEnabled. Fail closed if a snapshot contradicts
  // that invariant instead of trusting corrupted state.
  if (reducedMotion !== undefined && reducedMotion !== !nativeAnimationsEnabled) {
    return { skip: false, reason: null };
  }
  if (nativeAnimationsEnabled === true && remoteSession === false) {
    return { skip: false, reason: null };
  }

  let condition;
  if (remoteSession === true && nativeAnimationsEnabled === false) {
    condition = 'remote desktop session with Windows client-area animations disabled';
  } else if (remoteSession === true) {
    condition = 'remote desktop session';
  } else {
    condition = 'Windows client-area animations disabled';
  }

  const reason = `${condition} (nativeAnimationsEnabled=${nativeAnimationsEnabled}, remoteSession=${remoteSession}); run from a local console session with Windows animation effects enabled`;
  return { skip: true, reason };
}

export function formatSkipLine(name, reason) {
  return `↷ ${name} — SKIPPED: ${reason}`;
}

export function formatSummaryLine(passedCount, totalCount, skippedGroups = 0) {
  return `${passedCount}/${totalCount} 项通过${skippedGroups > 0 ? `，${skippedGroups} 组跳过` : ''}`;
}
