// ZTerm - 分屏树持久化序列化/反序列化纯逻辑（无 DOM 依赖，双导出，node:test 可测）
// 序列化：split tree → 保存格式（lastTabs 落盘）
// 反序列化：保存格式 → 运行期树（含深度上限防御）

const MAX_TREE_DEPTH = 50;

function serializeSplitNode(node) {
    if (!node) return null;
    if (node.orientation) {
        return {
            orientation: node.orientation,
            children: node.children.map(serializeSplitNode),
            ratios: node.ratios,
        };
    }
    const isSSH = node.type === 'ssh' || !!node._sshHost;
    return {
        type: 'leaf',
        name: node.name,
        paneType: isSSH ? 'ssh' : (node.type || 'local'),
        sshHost: node._sshHost,
        sshPort: node._sshPort,
        sshUser: node._sshUser,
        sshProfileId: node._sshProfileId,
        command: isSSH ? '' : (node._command || ''),
        args: isSSH ? [] : (node._args || []),
    };
}

// opts: { defaultName: string, nextPaneId: () => string, depth?: number }
function deserializeSplitNode(saved, opts) {
    if (!saved) return null;
    const depth = opts.depth ?? 0;
    // 深度上限：恶意/损坏的 config 嵌套过深会栈溢出；50 层远超任何正常使用
    if (depth > MAX_TREE_DEPTH) return null;
    if (saved.orientation) {
        return {
            orientation: saved.orientation,
            // 超限子节点返回 null，过滤掉——否则 normalize 会在 null 上崩溃
            children: saved.children
                .map(c => deserializeSplitNode(c, { ...opts, depth: depth + 1 }))
                .filter(Boolean),
            ratios: saved.ratios,
        };
    }
    const id = opts.nextPaneId();
    const isSSH = saved.paneType === 'ssh' || !!saved.sshHost;
    return {
        id, requestId: id,
        tabId: null, term: null, fitAddon: null, focused: false,
        name: saved.name || opts.defaultName,
        type: isSSH ? 'ssh' : (saved.paneType || 'local'),
        connected: !isSSH, // local 直接在线，SSH 等握手
        _sshHost: saved.sshHost, _sshPort: saved.sshPort, _sshUser: saved.sshUser,
        _sshProfileId: saved.sshProfileId,
        _command: isSSH ? '' : (saved.command || ''),
        _args: isSSH ? [] : (saved.args || []),
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { serializeSplitNode, deserializeSplitNode, MAX_TREE_DEPTH };
}
