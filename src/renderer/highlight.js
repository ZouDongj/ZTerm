// ZTerm - highlight rules (extracted from renderer.html unchanged)
// ── Highlight Rules ──
let _highlightRules = [];
let _highlightSettings = { highlightEnabled: true, highlightAlternateDisable: true };
let _editingHLId = null;
// Backend identity survives pane moves and changes on session replacement.
// Each stream owns a bounded lexer, its SGR baseline and alternate-screen gate.
const _hlStreams = new Map();

// Called on backend session death (ssh-disconnected / pty-exit): those paths
// write a banner ending at SGR 0, so neither rendition nor an unfinished
// control sequence may leak into a later generation using this id.
function clearAlternateScreen(tabId) {
    if (tabId != null) _hlStreams.delete(tabId);
}

// A pending terminal starts from defaults and will receive only its retained
// raw buffer. Rebuild after truncation so discarded prefixes cannot influence
// the next highlight. Rescanning is capped by the pending-buffer tail limit.
function resetHighlightStateFromBuffer(data, tabId) {
    if (tabId == null) return;
    const stream = createHighlightStreamState();
    if (typeof data === 'string' && data) scanHighlightLine(data, stream);
    _hlStreams.set(tabId, stream);
}

function loadHighlightRules() {
    ipcRenderer.once('highlight-rules', (event, { rules, settings }) => {
        _highlightSettings = settings || { highlightEnabled: true, highlightAlternateDisable: true };
        // Contract with get_highlight_rules (zterm.rs): a config WITHOUT the
        // highlightRules key delivers a null/absent rules field (true first
        // launch), while an explicitly saved list — including an EMPTY one —
        // arrives as an array. The empty array is authoritative: the user
        // deleted every rule, and that choice must survive a restart (P2-04).
        if (Array.isArray(rules)) {
            _highlightRules = rules;
        } else {
            // First launch: create default rules
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
        // Whitelist-validate color values: only #hex is allowed, preventing style-attribute injection via a color value
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
            <button class="ssh-item-btn" title="编辑" onclick="openHighlightEdit(false,'${r.id}')">${Icons.iconSvg('pencil', 11)}</button>
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
    const isRegExp = document.getElementById('hl-edit-regexp').classList.contains('on');
    const isCaseSensitive = document.getElementById('hl-edit-case').classList.contains('on');
    // Compile now so an invalid regex is rejected with feedback instead of being saved and then silently skipped at apply time
    if (isRegExp && !buildHighlightRegex(text, true, isCaseSensitive)) { showToast('正则表达式无效', true); return; }
    // Normalize colors to the #rrggbb the terminal renders: the 3-digit shorthand expands, anything else is rejected
    const foregroundColor = normalizeHighlightColor(document.getElementById('hl-edit-fgcolor').value.trim());
    if (foregroundColor === null) { showToast('前景色格式无效，支持 #RGB 或 #RRGGBB', true); return; }
    const backgroundColor = normalizeHighlightColor(document.getElementById('hl-edit-bgcolor').value.trim());
    if (backgroundColor === null) { showToast('背景色格式无效，支持 #RGB 或 #RRGGBB', true); return; }
    const rule = {
        text,
        isRegExp,
        isCaseSensitive,
        foreground: document.getElementById('hl-edit-fg').classList.contains('on'),
        foregroundColor,
        background: document.getElementById('hl-edit-bg').classList.contains('on'),
        backgroundColor,
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
function applyHighlight(data, tabId) {
    if (typeof data !== 'string' || !data) return data;
    const stream = tabId != null ? (_hlStreams.get(tabId) || createHighlightStreamState()) : createHighlightStreamState();
    const rules = _highlightSettings.highlightEnabled ? _highlightRules.filter(r => r.enabled) : [];
    // Scanning continues when decoration is disabled: re-enabling must not
    // mistake a continued control payload for text or forget its rendition.
    const result = data.split('\n').map(line =>
        applyHighlightToLine(line, rules, stream.sgr, stream, _highlightSettings.highlightAlternateDisable));
    if (tabId != null) _hlStreams.set(tabId, stream);
    return result.join('\n');
}

// ── Menu popup ──
