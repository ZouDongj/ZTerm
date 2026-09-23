// ZTerm - tab display name resolution (pure logic, no DOM; dual-exported as
// browser global + CommonJS so node:test can import it).

// Compute the tab's persisted name. Only base naming feeds persistence: a
// manual rename (`_customName`) locks the tab to `tab.name` (returns null), a
// single-terminal tab keeps `tab.name`, and a split tab joins its pane names
// (deduped). Tool-provided names (`_toolName`) and OSC 0/2 window titles
// never land here — they are display-only overlays, see resolveTabDisplayName.
// Returns the resolved name, or null when the tab is name-locked.
function resolveTabName(tab, panes) {
    if (!tab || tab._customName) return null;
    if (!tab.splitRoot) return tab.name || '';
    const nameOf = (p) => ((p && p.name) || '');
    const list = Array.isArray(panes) ? panes : [];
    if (list.length <= 1) return nameOf(list[0]) || tab.name || '';
    // Same dedup semantics as before: one connection split into several panes
    // shows its name once, not once per pane.
    const names = list.map(nameOf).filter(n => n);
    return [...new Set(names)].join(' | ');
}

// Compute the tab's VISIBLE name. Priority: a manual rename (`_customName`)
// sticks to `tab.name`; otherwise a trimmed tool-provided `_toolName` (set
// via the OSC 1337 rename channel, kept on the tab for single-terminal tabs
// and on each pane for split tabs) outranks the persisted base name. This is
// a pure display overlay — the result must never be written back to
// `tab.name` or persisted.
function resolveTabDisplayName(tab, panes) {
    if (!tab) return '';
    if (tab._customName) return tab.name || '';
    if (!tab.splitRoot) {
        const t = (tab._toolName || '').trim();
        return t ? t : (tab.name || '');
    }
    const nameOf = (p) => {
        const t = ((p && p._toolName) || '').trim();
        return t || ((p && p.name) || '');
    };
    const list = Array.isArray(panes) ? panes : [];
    if (list.length <= 1) return nameOf(list[0]) || tab.name || '';
    const names = list.map(nameOf).filter(n => n);
    return [...new Set(names)].join(' | ');
}

// Parse an OSC 1337 payload (`data` as delivered to the registered handler,
// i.e. everything after `1337;`). Returns the tool-provided name when the
// payload starts with `ZTermTabName=`, '' (a clear request) when the value is
// empty or whitespace-only, and null for any other 1337 payload — iTerm2 and
// WezTerm 1337 sequences never use this prefix, so those stay available to
// other handlers. Interior whitespace is preserved.
function parseTabRenamePayload(payload) {
    if (typeof payload !== 'string' || !payload.startsWith('ZTermTabName=')) return null;
    const value = payload.slice('ZTermTabName='.length);
    // A whitespace-only value carries no name — treat it as a clear request.
    return /^\s*$/.test(value) ? '' : value;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveTabName, resolveTabDisplayName, parseTabRenamePayload };
}
