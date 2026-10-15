// ZTerm - tab strip layout classification (pure logic; browser global + CommonJS dual export, node:test-able)
//
// Three states, mirroring Windows Terminal's tab row (MUX TabView Equal mode,
// ported earlier by zterm-flutter's TabRowMetrics). The pinned width is a
// single continuous clamp(avail/count, TAB_MIN_WIDTH, TAB_MAX_WIDTH) curve:
//   sparse   - few tabs: every tab pinned at TAB_MAX_WIDTH (share >= max).
//   sharing  - tabs share the strip equally at floor(share) px each while
//              min <= share < max (equal widths, shrink to fit).
//   overflow - share fell below TAB_MIN_WIDTH: pin every tab to
//              TAB_MIN_WIDTH and let the strip scroll (arrow buttons + wheel)
//              instead of shrinking further. Without this the flex line
//              overflows its hidden-clip parent and trailing tabs (then the
//              add button) become unreachable.
// The clamp keeps the curve continuous: adding a tab can only ever shrink
// the pinned width, never grow it, and the state boundaries are invisible
// (240 -> 239 -> ... -> 101 -> 100 + arrows).
//
// The caller measures the strip with the scroll arrows HIDDEN and decides
// from that single availability, so toggling the arrows can never oscillate
// the state (arrows only shrink the viewport, which an overflow decision
// already accounts for).

const TAB_MIN_WIDTH = 100;
const TAB_MAX_WIDTH = 240;

// count: visible .tab nodes (closing tabs still hold their slot during the
// exit fade, so they count); availableWidth: px the tab viewport would get
// with the arrows hidden; gap: CSS gap between tabs.
// Returns { state, tabWidth } — tabWidth is the px width to pin on every tab
// (max in sparse, floor(share) in sharing, min in overflow), or null for
// degenerate inputs (no measurement: leave tabs to CSS content sizing).
function computeTabStripPlan(count, availableWidth, gap, minWidth, maxWidth) {
    const min = minWidth ?? TAB_MIN_WIDTH;
    const max = maxWidth ?? TAB_MAX_WIDTH;
    const g = Number.isFinite(gap) ? gap : 0;
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(availableWidth) || availableWidth <= 0) {
        return { state: 'sparse', tabWidth: null };
    }
    const share = (availableWidth - g * (count - 1)) / count;
    if (share >= max) return { state: 'sparse', tabWidth: max };
    if (share >= min) return { state: 'sharing', tabWidth: Math.max(min, Math.floor(share)) };
    return { state: 'overflow', tabWidth: min };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeTabStripPlan, TAB_MIN_WIDTH, TAB_MAX_WIDTH };
}
