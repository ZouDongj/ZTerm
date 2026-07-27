// ZTerm - 高亮规则（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Highlight Rules ──
let _highlightRules = [];
let _highlightSettings = { highlightEnabled: true, highlightAlternateDisable: true };
let _editingHLId = null;
let _hlAlternate = false;

function loadHighlightRules() {
    ipcRenderer.once('highlight-rules', (event, { rules, settings }) => {
        _highlightRules = rules || [];
        _highlightSettings = settings || { highlightEnabled: true, highlightAlternateDisable: true };
        // First launch: create default rules
        if (_highlightRules.length === 0) {
            _highlightRules = [
                { id: 'hl_1', text: 'ERROR', enabled: true, isRegExp: false, isCaseSensitive: false, foreground: true, foregroundColor: '#e06c75', background: false, backgroundColor: '', bold: true, italic: false, underline: false },
                { id: 'hl_2', text: 'WARN', enabled: true, isRegExp: false, isCaseSensitive: false, foreground: true, foregroundColor: '#e5c07b', background: false, backgroundColor: '', bold: false, italic: false, underline: false },
                { id: 'hl_3', text: 'INFO', enabled: true, isRegExp: false, isCaseSensitive: false, foreground: true, foregroundColor: '#61afef', background: false, backgroundColor: '', bold: false, italic: false, underline: false },
            ];
            saveHighlightRules();
        }
        updateHighlightToggles();
        renderHighlightRulesList();
    });
    ipcRenderer.send('get-highlight-rules');
}

function saveHighlightRules() {
    ipcRenderer.send('save-highlight-rules', { rules: _highlightRules, settings: _highlightSettings });
}

function updateHighlightToggles() {
    const toggle1 = document.getElementById('toggle-highlight');
    const toggle2 = document.getElementById('toggle-highlight-alt');
    if (toggle1) toggle1.classList.toggle('on', _highlightSettings.highlightEnabled);
    if (toggle2) toggle2.classList.toggle('on', _highlightSettings.highlightAlternateDisable);
}

function toggleHighlightEnabled() {
    _highlightSettings.highlightEnabled = !_highlightSettings.highlightEnabled;
    updateHighlightToggles();
    saveHighlightRules();
}

function toggleHighlightAlternate() {
    _highlightSettings.highlightAlternateDisable = !_highlightSettings.highlightAlternateDisable;
    updateHighlightToggles();
    saveHighlightRules();
}

function renderHighlightRulesList() {
    const container = document.getElementById('highlight-rules-list');
    if (!container) return;
    if (_highlightRules.length === 0) {
        container.innerHTML = '<div style="padding:30px;text-align:center;color:rgba(171,178,191,0.25);font-size:13px">暂无高亮规则</div>';
        return;
    }
    container.innerHTML = _highlightRules.map(r => {
        // 颜色值白名单校验：只允许 #hex 格式，防止通过颜色值注入 style 属性
        const colorRe = /^#[0-9a-f]{3,8}$/i;
        const fgColor = (r.foreground && r.foregroundColor && colorRe.test(r.foregroundColor)) ? r.foregroundColor : '';
        const bgColor = (r.background && r.backgroundColor && colorRe.test(r.backgroundColor)) ? r.backgroundColor : '';
        const fgStyle = fgColor ? 'color:' + fgColor + ';' : '';
        const bgStyle = bgColor ? 'background:' + bgColor + ';' : '';
        const truncateStyle = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;display:inline-block;vertical-align:middle';
        const style = 'style="' + fgStyle + bgStyle + truncateStyle + '"';
        return `<div class="ssh-item">
            <div class="ssh-item-icon" style="background:rgba(var(--accent-rgb),0.08);color:rgb(var(--accent-rgb))">Aa</div>
            <div class="ssh-item-info" style="cursor:pointer" onclick="openHighlightEdit(false,'${r.id}')">
                <div class="ssh-item-name" ${style}>${escHtml(r.text)}</div>
                <div class="ssh-item-detail">${r.isRegExp ? '正则' : '关键字'}${r.bold ? ' · 粗体' : ''}${r.italic ? ' · 斜体' : ''}${r.underline ? ' · 下划线' : ''}</div>
            </div>
            <div class="toggle-switch small ${r.enabled ? 'on' : ''}" style="flex-shrink:0" onclick="toggleHighlightRule('${r.id}')"></div>
            <button class="ssh-item-btn" title="编辑" onclick="openHighlightEdit(false,'${r.id}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
            <button class="ssh-item-btn danger" title="删除" onclick="deleteHighlightRule('${r.id}')">×</button>
        </div>`;
    }).join('');
}

function toggleHighlightRule(id) {
    const r = _highlightRules.find(x => x.id === id);
    if (r) { r.enabled = !r.enabled; saveHighlightRules(); renderHighlightRulesList(); }
}

function deleteHighlightRule(id) {
    showConfirm('确定删除此高亮规则？', () => {
        _highlightRules = _highlightRules.filter(x => x.id !== id);
        saveHighlightRules();
        renderHighlightRulesList();
        showToast('规则已删除');
    });
}

function openHighlightEdit(isNew, id) {
    _editingHLId = isNew ? null : id;
    document.getElementById('highlight-edit-title').textContent = isNew ? '添加高亮规则' : '编辑高亮规则';
    document.getElementById('hl-edit-text').value = '';
    document.getElementById('hl-edit-fgcolor').value = '';
    document.getElementById('hl-edit-bgcolor').value = '';
    document.getElementById('hl-fg-dot').style.background = '#e06c75';
    document.getElementById('hl-bg-dot').style.background = '#282c34';
    ['hl-edit-regexp','hl-edit-case','hl-edit-fg','hl-edit-bg','hl-edit-bold','hl-edit-italic','hl-edit-underline'].forEach(tid => {
        document.getElementById(tid).classList.remove('on');
    });
    if (!isNew && id) {
        const r = _highlightRules.find(x => x.id === id);
        if (r) {
            document.getElementById('hl-edit-text').value = r.text || '';
            document.getElementById('hl-edit-fgcolor').value = r.foregroundColor || '';
            document.getElementById('hl-edit-bgcolor').value = r.backgroundColor || '';
            document.getElementById('hl-fg-dot').style.background = r.foregroundColor || '#e06c75';
            document.getElementById('hl-bg-dot').style.background = r.backgroundColor || '#282c34';
            document.getElementById('hl-edit-regexp').classList.toggle('on', !!r.isRegExp);
            document.getElementById('hl-edit-case').classList.toggle('on', !!r.isCaseSensitive);
            document.getElementById('hl-edit-fg').classList.toggle('on', !!r.foreground);
            document.getElementById('hl-edit-bg').classList.toggle('on', !!r.background);
            document.getElementById('hl-edit-bold').classList.toggle('on', !!r.bold);
            document.getElementById('hl-edit-italic').classList.toggle('on', !!r.italic);
            document.getElementById('hl-edit-underline').classList.toggle('on', !!r.underline);
        }
    }
    openOverlay('overlay-highlight-edit');
    setTimeout(() => document.getElementById('hl-edit-text').focus(), 50);
}

function closeHighlightEdit() {
    closeOverlay('overlay-highlight-edit');
}

function saveHighlightEdit() {
    const text = document.getElementById('hl-edit-text').value.trim();
    if (!text) { showToast('关键字不能为空', true); return; }
    const rule = {
        text,
        isRegExp: document.getElementById('hl-edit-regexp').classList.contains('on'),
        isCaseSensitive: document.getElementById('hl-edit-case').classList.contains('on'),
        foreground: document.getElementById('hl-edit-fg').classList.contains('on'),
        foregroundColor: document.getElementById('hl-edit-fgcolor').value.trim(),
        background: document.getElementById('hl-edit-bg').classList.contains('on'),
        backgroundColor: document.getElementById('hl-edit-bgcolor').value.trim(),
        bold: document.getElementById('hl-edit-bold').classList.contains('on'),
        italic: document.getElementById('hl-edit-italic').classList.contains('on'),
        underline: document.getElementById('hl-edit-underline').classList.contains('on'),
    };
    if (_editingHLId) {
        const r = _highlightRules.find(x => x.id === _editingHLId);
        if (r) Object.assign(r, rule);
    } else {
        _highlightRules.push({ id: 'hl_' + Date.now(), enabled: true, ...rule });
    }
    saveHighlightRules();
    closeHighlightEdit();
    renderHighlightRulesList();
    showToast('规则已保存');
}

// ── Highlight application (pty-output interception) ──
function applyHighlight(data) {
    if (!_highlightSettings.highlightEnabled || _highlightRules.length === 0) return data;
    // Check alternate screen (vim/htop) — simplified check for alternate screen enter/exit sequences
    if (_highlightSettings.highlightAlternateDisable) {
        if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) _hlAlternate = true;
        if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) _hlAlternate = false;
        if (_hlAlternate) return data;
    }
    const enabledRules = _highlightRules.filter(r => r.enabled);
    if (enabledRules.length === 0) return data;
    // Split by \n and process each line
    const lines = data.split('\n');
    const result = lines.map(line => applyHighlightToLine(line, enabledRules));
    return result.join('\n');
}

function applyHighlightToLine(line, rules) {
    if (!line) return line;
    // Collect first match from each rule
    const matches = [];
    for (const rule of rules) {
        try {
            let regex;
            if (rule.isRegExp) {
                regex = new RegExp(rule.text, rule.isCaseSensitive ? 'gd' : 'gid');
            } else {
                const escaped = rule.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escaped, rule.isCaseSensitive ? 'gd' : 'gid');
            }
            const match = regex.exec(line);
            if (match) {
                matches.push({ start: match.index, end: match.index + match[0].length, rule });
            }
        } catch(e) {}
    }
    if (matches.length === 0) return line;
    // ANSI 序列（CSI/OSC/其他）区间内的匹配全部丢弃——向 OSC 注入颜色码会打断序列，匹配文本会泄漏成可见输出
    const escapeRanges = _getEscapeRanges(line);
    const validMatches = matches.filter(m => !escapeRanges.some(r => m.start < r.end && m.end > r.start));
    if (validMatches.length === 0) return line;
    // Sort by start position, first match wins on overlap
    validMatches.sort((a, b) => a.start - b.start);
    // Build result with ANSI color injection
    let result = '';
    let last = 0;
    for (const m of validMatches) {
        if (m.start < last) continue; // 与前一个 match 重叠，先来先得
        result += line.slice(last, m.start);
        result += _getHighlightBeginSeq(m.rule);
        result += line.slice(m.start, m.end);
        result += _getHighlightEndSeq(m.rule);
        last = m.end;
    }
    result += line.slice(last);
    return result;
}

// 找出字符串中所有 ANSI 转义序列的区间：
// CSI（\x1b[ 到 final byte 0x40–0x7E）、OSC（\x1b] 到 BEL 或 ST）、其他（ESC + 1 字符）
function _getEscapeRanges(s) {
    const ranges = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '\x1b') continue;
        const next = s[i + 1];
        if (next === '[') {
            // CSI: 直到 final byte
            let j = i + 2;
            while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7E)) j++;
            ranges.push({ start: i, end: Math.min(j + 1, s.length) });
            i = j;
        } else if (next === ']') {
            // OSC: 直到 BEL(\x07) 或 ST(\x1b\\)
            let j = i + 2;
            while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
            const end = s[j] === '\x07' ? j + 1 : (j < s.length ? j + 2 : s.length);
            ranges.push({ start: i, end });
            i = end - 1;
        } else {
            // 其他 ESC 序列（字符集切换等），跳过 ESC + 1 个字符
            ranges.push({ start: i, end: Math.min(i + 2, s.length) });
            i += 1;
        }
    }
    return ranges;
}

function _getHighlightBeginSeq(rule) {
    let seq = '';
    if (rule.foreground && rule.foregroundColor) {
        const rgb = _hexToRgb(rule.foregroundColor);
        if (rgb) seq += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
    }
    if (rule.background && rule.backgroundColor) {
        const rgb = _hexToRgb(rule.backgroundColor);
        if (rgb) seq += `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
    }
    if (rule.bold) seq += '\x1b[1m';
    if (rule.italic) seq += '\x1b[3m';
    if (rule.underline) seq += '\x1b[4m';
    return seq;
}

function _getHighlightEndSeq(rule) {
    let seq = '';
    if (rule.underline) seq += '\x1b[24m';
    if (rule.italic) seq += '\x1b[23m';
    if (rule.bold) seq += '\x1b[22m';
    if (rule.background && rule.backgroundColor) seq += '\x1b[49m';
    if (rule.foreground && rule.foregroundColor) seq += '\x1b[39m';
    return seq;
}

function _hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const int = parseInt(m[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

// ── Menu popup ──
