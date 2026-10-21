// ZTerm - shortcut pure logic (no DOM; dual export as browser global + CommonJS, node:test-able)

// Build a canonical combo string (Ctrl+Shift+N form) from a KeyboardEvent.
// e.code is more reliable than e.key — immune to keyboard layout, Alt-key
// system interception, and IME states.
// Win (e.metaKey) is a first-class modifier, NOT folded into Ctrl (issue #23):
// folding made Ctrl+Win+X record as Ctrl+X, so the two were indistinguishable
// in matching and display. Caveat: Windows owns some Win chords (Win+L,
// Win+Ctrl+Left/Right, the Start menu) and never delivers them to WebView2 —
// such combos simply cannot be recorded, only ones that arrive as keydowns.
function comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Win');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    // Physical letter keys are layout-independent: on a Cyrillic/Greek layout
    // the physical C key reports e.key='с', which never matches the Latin
    // default bindings — and a combo recorded under one layout breaks after a
    // layout switch. Prefer e.code for KeyA-KeyZ (B-P2-14). Latin-layout
    // recordings are byte-identical to the old e.key path, so existing
    // bindings keep matching; digits stay on e.key because their Shift layer
    // differs per layout (AZERTY) and e.key carries the real character.
    const codeLetter = e.code && e.code.match(/^Key([A-Z])$/);
    let key;
    if (codeLetter) {
        key = codeLetter[1];
    } else {
        key = e.key;
        if (!key || key === 'Dead' || key === 'Unidentified') {
            const m = e.code && e.code.match(/^(?:Key|Digit)(\w)$/);
            key = m ? m[1] : (e.code || '');
        }
        if (key === ' ') key = 'Space';
        else if (key.length === 1) key = key.toUpperCase();
    }
    parts.push(key);
    return parts.join('+');
}

// Display text for a combo: arrow keys render as arrow glyphs. Modifier parts
// are already canonical ('Win' renders literally as Win).
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
    // Same layout-independence rule as comboFromEvent: the physical J key
    // reports e.key='й' on a Cyrillic layout, and the denylist is Latin.
    const codeLetter = e.code && e.code.match(/^Key([A-Z])$/);
    const key = codeLetter ? codeLetter[1].toLowerCase() : (e.key || '').toLowerCase();
    const combo = (e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') +
        (e.shiftKey ? 'shift+' : '') + (e.metaKey ? 'meta+' : '') + key;
    return BROWSER_ACCELERATOR_DENYLIST.has(combo);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { comboFromEvent, comboDisplay, mergeShortcutBindings, BROWSER_ACCELERATOR_DENYLIST, browserAcceleratorDenied };
}
