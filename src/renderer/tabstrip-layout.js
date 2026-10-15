// ZTerm - tab strip layout classification (pure logic; browser global + CommonJS dual export, node:test-able)
//
// Three states, mirroring zterm-flutter's TabRowMetrics (itself a port of
// Windows Terminal's MUX TabView Equal mode):
//   sparse   - the per-tab CONTENT widths (measured off the live DOM,
//              floored at TAB_CONTENT_MIN and capped at TAB_MAX_WIDTH by CSS)
//              still fit the strip: tabs keep their natural content width
//              (tabWidth null = no inline pinning) and the add/menu buttons
//              sit right after the last tab.
//   sharing  - the content total no longer fits: every tab is pinned to
//              floor(equal share) px while share >= TAB_MIN_WIDTH.
//   overflow - share fell below TAB_MIN_WIDTH: pin every tab to
//              TAB_MIN_WIDTH and let the strip scroll (arrow buttons + wheel)
//              instead of shrinking further. Without this the flex line
//              overflows its hidden-clip parent and trailing tabs (then the
//              add button) become unreachable.
// Deciding the sparse->sharing flip on the CONTENT total (not count*max)
// keeps the transition continuous: widths shrink only once the strip is
// actually full, and the add button never jumps away from the last tab.
//
// The caller measures the strip with the scroll arrows HIDDEN and decides
// from that single availability, so toggling the arrows can never oscillate
// the state (arrows only shrink the viewport, which an overflow decision
// already accounts for).

const TAB_MIN_WIDTH = 100;
const TAB_MAX_WIDTH = 240;
const TAB_CONTENT_MIN = 110; // mirrors Flutter's kTabRowContentMin; CSS .tab min-width enforces it at measure time

// desiredWidths: per-tab content px measured with no state classes applied
// (unmeasurable entries fall back to TAB_CONTENT_MIN); availableWidth: px the
// tab viewport would get with the arrows hidden; gap: CSS gap between tabs.
// Returns { state, tabWidth } — tabWidth is the px width to pin on every tab
// (floor(share) in sharing, min in overflow) or null in sparse/degenerate
// inputs (leave tabs to CSS content sizing).
function computeTabStripPlan(desiredWidths, availableWidth, gap, minWidth) {
    const min = minWidth ?? TAB_MIN_WIDTH;
    const g = Number.isFinite(gap) ? gap : 0;
    if (!Array.isArray(desiredWidths) || desiredWidths.length === 0 || !Number.isFinite(availableWidth) || availableWidth <= 0) {
        return { state: 'sparse', tabWidth: null };
    }
    const count = desiredWidths.length;
    const sum = desiredWidths.reduce((acc, w) => acc + ((Number.isFinite(w) && w > 0) ? w : TAB_CONTENT_MIN), 0) + g * (count - 1);
    if (sum <= availableWidth) return { state: 'sparse', tabWidth: null };
    const share = (availableWidth - g * (count - 1)) / count;
    if (share >= min) return { state: 'sharing', tabWidth: Math.max(min, Math.floor(share)) };
    return { state: 'overflow', tabWidth: min };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeTabStripPlan, TAB_MIN_WIDTH, TAB_MAX_WIDTH, TAB_CONTENT_MIN };
}
