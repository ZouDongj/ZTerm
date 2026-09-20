// win32-input-mode key serialization (GH#4999 in Microsoft's terminal).
//
// Every ConPTY session opens with OpenConsole requesting win32-input-mode
// (CSI ? 9001 h, host/VtIo.cpp): an invitation for the terminal to deliver
// FULL INPUT_RECORDs as `CSI Vk;Sc;Uc;Kd;Cs;Rc _` instead of legacy bytes
// (parser/InputStateMachineEngine::_GenerateWin32Key deserializes them).
// Windows Terminal answers with exactly this encoding
// (terminal/input/terminalInput.cpp::_makeWin32Output); xterm.js has no
// support for it, so our keys go through the legacy byte path, where
// OpenConsole's lossy translation rewrites a lone LF into a Ctrl+Enter
// INPUT_RECORD (field-verified with a ConPTY input probe, not checked in:
// byte 0x0A in -> key event vk=0x0D char=0x0A ctrl=LEFT_CTRL out). Event-level stdin readers
// (crossterm, kimi) then see "Ctrl+Enter" — never "Ctrl+J" — and the key
// does nothing. Over SSH there is no ConPTY rewrite, which is why only the
// local path was broken.
//
// Encoding a key as its win32 sequence delivers the exact INPUT_RECORD
// Windows Terminal would produce: Ctrl+J arrives as vk=0x4A char=0x0A
// ctrl=LEFT_CTRL, which every reader interprets as Ctrl+J. This is NOT an
// LF->CR rewrite: the UnicodeChar field stays 0x0A (LF) end to end.
(function installWin32Input(root) {
    'use strict';

    // Wire format: CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
    //   Vk wVirtualKeyCode, Sc wVirtualScanCode, Uc UnicodeChar (decimal),
    //   Kd bKeyDown (1/0), Cs dwControlKeyState, Rc wRepeatCount.
    function encodeWin32Key(vk, sc, uc, kd, cs, rc) {
        return '\u001b[' + [vk, sc, uc, kd ? 1 : 0, cs, rc || 1].join(';') + '_';
    }

    // Windows console constants for Ctrl+J.
    const VK_J = 0x4a;
    const SC_J = 0x24; // US-layout scan code; conhost resolves via Vk anyway.
    const UC_LF = 0x0a;
    const LEFT_CTRL_PRESSED = 0x0008;

    // What Windows Terminal emits for one Ctrl+J press (down + up).
    function ctrlJSequence() {
        return encodeWin32Key(VK_J, SC_J, UC_LF, 1, LEFT_CTRL_PRESSED, 1)
            + encodeWin32Key(VK_J, SC_J, UC_LF, 0, LEFT_CTRL_PRESSED, 1);
    }

    // Bare Ctrl+J only: no Shift/Alt/Meta (those are distinct key events with
    // their own INPUT_RECORDs, and xterm maps plain 'j' through its own path).
    function isCtrlJ(e) {
        return !!e && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey
            && (e.key === 'j' || e.keyCode === 74);
    }

    // Session gate: backend tab ids whose ConPTY session requested
    // win32-input-mode. Keyed by backend id — not by a flag on the tab/pane
    // wrapper — because split/drag migration moves a terminal between wrapper
    // objects while the backend session id travels with it. Ids are
    // process-unique (zterm.rs `local_<AtomicU64>`), so a stale entry can
    // never collide with a future session and needs no cleanup.
    const gatedSessions = new Set();
    function markGated(tabId) { if (tabId) gatedSessions.add(tabId); }
    function isGated(tabId) { return gatedSessions.has(tabId); }

    const api = { encodeWin32Key, ctrlJSequence, isCtrlJ, markGated, isGated };
    root.__win32Input = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
