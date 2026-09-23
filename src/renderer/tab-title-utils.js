// ZTerm - tab display name resolution (pure logic, no DOM; dual-exported as
// browser global + CommonJS so node:test can import it).

// Compute the tab's display name. An OSC 0/2 window title reported by the
// terminal (`_oscTitle`, kept on the tab for single-terminal tabs and on each
// pane for split tabs) outranks the profile/default name; a manual rename
// (`_customName`) outranks everything and makes the tab stick to `tab.name`.
// Returns the resolved name, or null when the tab is name-locked.
function resolveTabName(tab, panes) {
    if (!tab || tab._customName) return null;
    if (!tab.splitRoot) {
        const t = (tab._oscTitle || '').trim();
        return t ? t : (tab.name || '');
    }
    const nameOf = (p) => {
        const t = ((p && p._oscTitle) || '').trim();
        return t || ((p && p.name) || '');
    };
    const list = Array.isArray(panes) ? panes : [];
    if (list.length <= 1) return nameOf(list[0]) || tab.name || '';
    // Same dedup semantics as before: one connection split into several panes
    // shows its name once, not once per pane.
    const names = list.map(nameOf).filter(n => n);
    return [...new Set(names)].join(' | ');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveTabName };
}
