// ZTerm - pane → tab session-field adoption (pure logic, no DOM, dual export, node:test-able)
//
// Contract (ADR-0004 §3.2 migration field checklist): when a pane's terminal
// is promoted back onto a tab (split collapse, extract-to-tab, cross-tab move
// leaving one pane), the tab's session-identity fields must be adopted from
// THAT pane's session and never fall back to the old container's values — the
// container may belong to a different session (wrong host on reconnect, wrong
// shell on a later split).
//
// Fields handled here:
//   type                       → pane.type ('local' when unset)
//   host/port/user/sshProfileId → pane._ssh* for SSH; cleared to undefined for local
//   command/args               → '' / [] for SSH; pane._command / pane._args for local
//   _credId                    → pane._sshCredId wins, tab._credId kept when the pane has none
//   connected                  → paneConnectedState(pane) — the adopted session's state
//
// NOT handled here (each caller owns them): term/fitAddon, tabId,
// _ptyRequestId, _smoothCursor, name, _toolName, onData disposal/rebind, DOM
// mounts and resize observers.

// Connection state of a wrapper about to hand its terminal over. An explicit
// connected === false (a dropped session, or an SSH pane that is merely
// connecting) always wins; the `!!tabId` fallback only covers panes that
// never recorded a state (legacy local panes), so a backend id alone never
// reads as online.
function paneConnectedState(pane) {
    if (!pane) return false;
    return pane.connected !== false && (pane.connected || !!pane.tabId);
}

function adoptPaneFieldsIntoTab(tab, pane) {
    if (!tab || !pane) return;
    tab.type = pane.type || 'local';
    if (pane.type === 'ssh') {
        tab.host = pane._sshHost;
        tab.port = pane._sshPort;
        tab.user = pane._sshUser;
        tab.sshProfileId = pane._sshProfileId;
        tab.command = '';
        tab.args = [];
    } else {
        tab.host = undefined;
        tab.port = undefined;
        tab.user = undefined;
        tab.sshProfileId = undefined;
        tab.command = pane._command || '';
        tab.args = pane._args || [];
    }
    tab._credId = pane._sshCredId || tab._credId;
    // Status dot and reconnect entry must describe the ADOPTED session, not
    // the container it happened to live in.
    tab.connected = paneConnectedState(pane);
    // The known-failed/disconnected liveness marker (ipc.js sets it on ssh
    // error/drop and local process exit) is session state and migrates with
    // the terminal — a pending paste must stay cancelled after the move.
    tab._sessionFailed = pane._sessionFailed === true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { adoptPaneFieldsIntoTab, paneConnectedState };
}
