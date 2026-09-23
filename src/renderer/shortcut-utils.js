// ZTerm - shortcut pure logic (no DOM; dual export as browser global + CommonJS, node:test-able)

// Build a canonical combo string (Ctrl+Shift+N form) from a KeyboardEvent.
// e.code is more reliable than e.key — immune to keyboard layout, Alt-key
// system interception, and IME states.
function comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (!key || key === 'Dead' || key === 'Unidentified') {
        const m = e.code && e.code.match(/^(?:Key|Digit)(\w)$/);
        key = m ? m[1] : (e.code || '');
    }
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join('+');
}

// Display text for a combo: arrow keys render as arrow glyphs
function comboDisplay(combo) {
    return combo.replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓')
        .replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→');
}

// User customizations override the default bindings (untouched defaults stay)
function mergeShortcutBindings(defaults, userOverrides) {
    return { ...defaults, ...(userOverrides || {}) };
}

// Edge-OOUI accelerator combos that WebView2's
// AreBrowserAcceleratorKeysEnabled=false does NOT cover (the downloads hub
// still pops edge://downloads-hub on an unconsumed Ctrl+J, runtime
// 153.0.4234.48). A trusted key only reaches browser accelerators when the
// page returns it unconsumed, so shortcuts.js preventDefaults matches.
// Terminal delivery is unaffected: neither xterm nor the win32-input hook
// checks defaultPrevented.
const BROWSER_ACCELERATOR_DENYLIST = new Set(['ctrl+j']);

function browserAcceleratorDenied(e) {
    if (!e || e.isComposing || e.keyCode === 229) return false;
    const combo = (e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') +
        (e.shiftKey ? 'shift+' : '') + (e.metaKey ? 'meta+' : '') + (e.key || '').toLowerCase();
    return BROWSER_ACCELERATOR_DENYLIST.has(combo);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { comboFromEvent, comboDisplay, mergeShortcutBindings, BROWSER_ACCELERATOR_DENYLIST, browserAcceleratorDenied };
}
