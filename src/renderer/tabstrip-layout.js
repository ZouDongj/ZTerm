// ZTerm - tab strip layout classification (pure logic; browser global + CommonJS dual export, node:test-able)
//
// Default (equal-width) mode — three states, mirroring zterm-flutter's
// TabRowMetrics (itself a port of Windows Terminal's MUX TabView Equal mode):
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
//
// Adaptive mode (options.adaptive === true) — two states (sparse / overflow):
//   Tabs always keep their own content-based width (floored at
//   TAB_ADAPTIVE_MIN and capped at TAB_MAX_WIDTH by CSS, tabWidth always null)
//   so short titles stay visibly narrower than long ones. Once the content
//   total exceeds availableWidth, the strip jumps straight to overflow (scroll
//   arrows + horizontal wheel) without equal-width compression.
//
// Deciding the flip on the CONTENT total (not count*max) keeps the transition
// continuous: widths change only once the strip is actually full, and the add
// button never jumps away from the last tab.
//
// The caller measures the strip with the scroll arrows HIDDEN and decides
// from that single availability, so toggling the arrows can never oscillate
// the state (arrows only shrink the viewport, which an overflow decision
// already accounts for).

const TAB_MIN_WIDTH = 100;
const TAB_MAX_WIDTH = 240;
const TAB_CONTENT_MIN = 110; // mirrors Flutter's kTabRowContentMin; CSS .tab min-width enforces it at measure time
const TAB_ADAPTIVE_MIN = 72; // mirrors CSS #tabbar.tabbar-adaptive .tab min-width; keeps short titles compact without clipping chrome
// Permanent breathing room between the strip's right end (menu button) and
// the titlebar's SFTP/transfer/window-control cluster. Mirrored by the
// #tabbar padding-right in app.css; the caller subtracts it from the
// availability so the sharing/overflow flips happen while a visible gap
// remains — the buttons never jam against the window controls.
const TAB_STRIP_RIGHT_RESERVE = 48;

// desiredWidths: per-tab content px measured with no state classes applied
// (unmeasurable entries fall back to TAB_ADAPTIVE_MIN in adaptive mode, else
// TAB_CONTENT_MIN); availableWidth: px the tab viewport would get with the
// arrows hidden; gap: CSS gap between tabs; minWidth: equal-width overflow
// floor (default TAB_MIN_WIDTH); options: { adaptive?: boolean }.
// Returns { state, tabWidth } — tabWidth is the px width to pin on every tab
// (floor(share) in sharing, min in default overflow) or null in sparse,
// adaptive overflow, and degenerate inputs (leave tabs to CSS content sizing).
function computeTabStripPlan(desiredWidths, availableWidth, gap, minWidth, options) {
    const min = minWidth ?? TAB_MIN_WIDTH;
    const adaptive = !!(options && options.adaptive);
    const contentFloor = adaptive ? TAB_ADAPTIVE_MIN : TAB_CONTENT_MIN;
    const g = Number.isFinite(gap) ? gap : 0;
    if (!Array.isArray(desiredWidths) || desiredWidths.length === 0 || !Number.isFinite(availableWidth) || availableWidth <= 0) {
        return { state: 'sparse', tabWidth: null };
    }
    const count = desiredWidths.length;
    const sum = desiredWidths.reduce((acc, w) => acc + ((Number.isFinite(w) && w > 0) ? w : contentFloor), 0) + g * (count - 1);
    if (sum <= availableWidth) return { state: 'sparse', tabWidth: null };
    if (adaptive) return { state: 'overflow', tabWidth: null };
    const share = (availableWidth - g * (count - 1)) / count;
    if (share >= min) return { state: 'sharing', tabWidth: Math.max(min, Math.floor(share)) };
    return { state: 'overflow', tabWidth: min };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeTabStripPlan, TAB_MIN_WIDTH, TAB_MAX_WIDTH, TAB_CONTENT_MIN, TAB_ADAPTIVE_MIN, TAB_STRIP_RIGHT_RESERVE };
}
