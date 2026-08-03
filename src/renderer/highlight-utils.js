// ZTerm - 高亮规则纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// 编译高亮规则的正则：isRegExp 用原文，否则转义关键字；非法正则返回 null（不抛异常）
function buildHighlightRegex(text, isRegExp, isCaseSensitive) {
    try {
        const src = isRegExp ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(src, isCaseSensitive ? 'gd' : 'gid');
    } catch (e) {
        return null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildHighlightRegex };
}
