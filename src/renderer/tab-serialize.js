// ZTerm - split tree persistence serialize/deserialize pure logic (no DOM dependency, dual export, node:test-able)
// Serialize: split tree → saved format (lastTabs written to disk)
// Deserialize: saved format → runtime tree (with depth-limit defense)

const MAX_TREE_DEPTH = 50;

function serializeSplitNode(node) {
    if (!node) return null;
    if (node.orientation) {
        // Panes inside their close window (_closing) are being removed: their
        // backend is already destroyed, so persisting them would resurrect a
        // dead pane (and reconnect its SSH session) on the next start. A
        // pruned child takes its ratio with it; a container left empty
        // collapses to null and is pruned by its own parent the same way.
        const children = [];
        const ratios = [];
        node.children.forEach((c, i) => {
            const s = serializeSplitNode(c);
            if (!s) return;
            children.push(s);
            ratios.push(node.ratios ? node.ratios[i] : undefined);
        });
        if (children.length === 0) return null;
        return {
            orientation: node.orientation,
            children,
            ratios,
        };
    }
    if (node._closing) return null;
    // Host inference is only for legacy nodes without an explicit type.
    const isSSH = node.type === 'ssh' || (!node.type && !!node._sshHost);
    return {
        type: 'leaf',
        name: node.name,
        paneType: isSSH ? 'ssh' : (node.type || 'local'),
        // A demoted manual rename rides the pane across restarts: without the
        // marker the tool-name overlay would outrank the user's name on the
        // restored split (resolveTabDisplayName).
        ...(node._manualName ? { manualName: true } : {}),
        sshHost: isSSH ? node._sshHost : undefined,
        sshPort: isSSH ? node._sshPort : undefined,
        sshUser: isSSH ? node._sshUser : undefined,
        sshProfileId: isSSH ? node._sshProfileId : undefined,
        command: isSSH ? '' : (node._command || ''),
        args: isSSH ? [] : (node._args || []),
    };
}

// opts: { defaultName: string, nextPaneId: () => string, depth?: number }
function deserializeSplitNode(saved, opts) {
    if (!saved) return null;
    const depth = opts.depth ?? 0;
    // Depth limit: a malicious/corrupt config nested too deeply would overflow the stack; 50 levels far exceeds any normal use
    if (depth > MAX_TREE_DEPTH) return null;
    if (saved.orientation) {
        return {
            orientation: saved.orientation,
            // Over-limit children return null and get filtered out — otherwise normalize would crash on null
            children: saved.children
                .map(c => deserializeSplitNode(c, { ...opts, depth: depth + 1 }))
                .filter(Boolean),
            ratios: saved.ratios,
        };
    }
    const id = opts.nextPaneId();
    const isSSH = saved.paneType === 'ssh' || (!saved.paneType && !!saved.sshHost);
    return {
        id, requestId: id,
        tabId: null, term: null, fitAddon: null, focused: false,
        name: saved.name || opts.defaultName,
        type: isSSH ? 'ssh' : (saved.paneType || 'local'),
        connected: !isSSH, // local starts online immediately; SSH waits for the handshake
        ...(saved.manualName === true ? { _manualName: true } : {}),
        _sshHost: isSSH ? saved.sshHost : undefined,
        _sshPort: isSSH ? saved.sshPort : undefined,
        _sshUser: isSSH ? saved.sshUser : undefined,
        _sshProfileId: isSSH ? saved.sshProfileId : undefined,
        _command: isSSH ? '' : (saved.command || ''),
        _args: isSSH ? [] : (saved.args || []),
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { serializeSplitNode, deserializeSplitNode, MAX_TREE_DEPTH };
}
