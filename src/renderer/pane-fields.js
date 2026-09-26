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
//
// NOT handled here (each caller owns them): term/fitAddon, tabId,
// _ptyRequestId, _smoothCursor, name, _toolName, onData disposal/rebind, DOM
// mounts and resize observers.

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
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { adoptPaneFieldsIntoTab };
}
