// ZTerm - 快捷键纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// 从 KeyboardEvent 构造规范组合键字符串（Ctrl+Shift+N 形式）。
// e.code 比 e.key 更可靠——不受键盘布局、Alt 键系统拦截、输入法等影响。
function comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (!key || key === 'Dead' || key === 'Unidentified') {
        const m = e.code && e.code.match(/^(?:Key|Digit)(\w)$/);
        key = m ? m[1] : (e.code || '');
    }
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join('+');
}

// 快捷键显示文本：方向键转箭头符号
function comboDisplay(combo) {
    return combo.replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓')
        .replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→');
}

// 用户自定义覆盖默认绑定（未覆盖的保持默认）
function mergeShortcutBindings(defaults, userOverrides) {
    return { ...defaults, ...(userOverrides || {}) };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { comboFromEvent, comboDisplay, mergeShortcutBindings };
}
