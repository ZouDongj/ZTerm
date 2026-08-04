// ZTerm - 快捷命令纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// 按名称/分组/命令内容过滤快捷命令（大小写不敏感）
function filterQuickCommands(commands, query) {
    const q = (query || '').toLowerCase();
    if (!q) return commands.slice();
    return commands.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.group || '').toLowerCase().includes(q) ||
        (c.command || '').toLowerCase().includes(q)
    );
}

// “末尾回车自动执行”开关关闭时：注入前剥掉末尾一个换行（只剥一个，
// 多行命令中间的换行保留；命令无末尾换行时原样返回）
function stripTrailingNewline(text) {
    return text.replace(/\n$/, '');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterQuickCommands, stripTrailingNewline };
}
