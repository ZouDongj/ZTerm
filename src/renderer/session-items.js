// ZTerm - session selector pure logic (no DOM dependency; browser global + CommonJS dual export, node:test-able)

// Build session list items from local profiles and SSH profiles
function buildSessionItems(localProfiles, sshProfiles, hiddenIds) {
    const items = [];
    (localProfiles || []).forEach(p => {
        if ((hiddenIds || []).includes(p.id)) return;
        const cmdShort = (p.command || '').split('\\').pop();
        const detail = (p.args && p.args.length) ? cmdShort + ' ' + p.args.join(' ') : p.command;
        items.push({
            id: 'local_' + p.id, name: p.name, detail,
            // The icon field holds an Icons.iconSvg name (terminal/zap);
            // the render layer turns it into an inline SVG.
            type: 'local', badge: '', icon: 'terminal',
            profile: p,
        });
    });
    (sshProfiles || []).forEach(p => {
        const detail = `${p.username}@${p.host}:${p.port || 22}`;
        items.push({
            id: 'ssh_' + p.id, name: p.name, detail,
            type: 'ssh', badge: p.group || '', icon: 'zap',
            sshProfile: p,
        });
    });
    return items;
}

// Filter by name/detail/group (case-insensitive); empty query returns the original array
function filterSessionItems(items, query) {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter(i =>
        String(i.name || '').toLowerCase().includes(q) ||
        String(i.detail || '').toLowerCase().includes(q) ||
        String(i.badge || '').toLowerCase().includes(q)
    );
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSessionItems, filterSessionItems };
}
