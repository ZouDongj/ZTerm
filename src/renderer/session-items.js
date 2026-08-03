// ZTerm - 会话选择器纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// 从本地 profile 与 SSH profile 构造会话列表项
function buildSessionItems(localProfiles, sshProfiles, hiddenIds) {
    const items = [];
    (localProfiles || []).forEach(p => {
        if ((hiddenIds || []).includes(p.id)) return;
        const cmdShort = (p.command || '').split('\\').pop();
        const detail = (p.args && p.args.length) ? cmdShort + ' ' + p.args.join(' ') : p.command;
        items.push({
            id: 'local_' + p.id, name: p.name, detail,
            type: 'local', badge: '', icon: p.icon === 'local' ? '⊞' : '>_',
            profile: p,
        });
    });
    (sshProfiles || []).forEach(p => {
        const detail = `${p.username}@${p.host}:${p.port || 22}`;
        items.push({
            id: 'ssh_' + p.id, name: p.name, detail,
            type: 'ssh', badge: p.group || '', icon: '⚡',
            sshProfile: p,
        });
    });
    return items;
}

// 按名称/详情/分组过滤（大小写不敏感）；空查询返回原数组
function filterSessionItems(items, query) {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.detail.toLowerCase().includes(q) ||
        i.badge.toLowerCase().includes(q)
    );
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSessionItems, filterSessionItems };
}
