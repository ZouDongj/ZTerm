// ZTerm - 快捷命令（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Quick Commands ──
let _qcCommands = [];
let _qcSelected = 0;
let _editingQCId = null;

// Load quick commands on init
function loadQuickCommands() {
    ipcRenderer.once('quick-commands', (event, commands) => {
        _qcCommands = commands || [];
        if (_qcCommands.length === 0) {
            _qcCommands = [
                { id: 'qc_1', name: '查看系统信息', command: 'htop', group: '常用' },
                { id: 'qc_2', name: '查看磁盘使用', command: 'df -h', group: '常用' },
                { id: 'qc_3', name: '查看内存使用', command: 'free -h', group: '常用' },
            ];
            saveQuickCommands();
        }
    });
    ipcRenderer.send('get-quick-commands');
}

function saveQuickCommands() {
    ipcRenderer.send('save-quick-commands', _qcCommands);
}

function openQC() {
    document.getElementById('overlay-qc').classList.add('open');
    document.getElementById('qc-input').value = '';
    _qcSelected = 0;
    qcFilter();
    setTimeout(() => document.getElementById('qc-input').focus(), 50);
}

function closeQC() {
    document.getElementById('overlay-qc').classList.remove('open');
}

function qcFilter() {
    const query = document.getElementById('qc-input').value.toLowerCase();
    const filtered = filterQuickCommands(_qcCommands, query);
    const list = document.getElementById('qc-list');
    if (filtered.length === 0) {
        list.innerHTML = '<div style="padding:30px;text-align:center;color:rgba(171,178,191,0.25);font-size:13px">没有匹配的命令<br><span style="font-size:11px;cursor:pointer;color:rgba(var(--accent-rgb),0.5);margin-top:8px;display:inline-block" onclick="closeQC();openSettings(\'quickcommands\')">+ 添加第一个命令</span></div>';
        return;
    }
    list.innerHTML = filtered.map((c, i) => `
        <div class="qc-item" data-index="${i}" ${i === _qcSelected ? 'data-selected' : ''} onclick="qcRun('${c.id}')" onmouseenter="qcSelect(${i})">
            <span class="qc-item-name">${escHtml(c.name)}</span>
            <span class="qc-item-cmd">${escHtml(c.command)}</span>
            ${c.group ? `<span class="qc-item-group">${escHtml(c.group)}</span>` : ''}
        </div>
    `).join('');
}

function qcSelect(i) {
    _qcSelected = i;
    document.querySelectorAll('#qc-list .qc-item').forEach((el, idx) => {
        if (idx === i) el.setAttribute('data-selected', '');
        else el.removeAttribute('data-selected');
    });
}

function qcKeydown(e) {
    const query = document.getElementById('qc-input').value.toLowerCase();
    const filtered = filterQuickCommands(_qcCommands, query);
    if (e.key === 'ArrowDown') { e.preventDefault(); qcSelect(Math.min(_qcSelected + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qcSelect(Math.max(_qcSelected - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[_qcSelected]) qcRun(filtered[_qcSelected].id); }
    else if (e.key === 'Escape') { closeQC(); }
}

function qcRun(id) {
    const cmd = _qcCommands.find(c => c.id === id);
    if (!cmd) return;
    closeQC();
    executeQuickCommand(cmd);
}

function executeQuickCommand(cmd) {
    const tab = TabManager.getActive();
    if (!tab) return;
    // Insert command text into terminal (user can edit before pressing Enter)
    // “末尾回车自动执行”开关：关闭时剥掉末尾一个换行（只注入命令文本，不自动执行）
    let text = cmd.command;
    if (!_settingsConfig.qcAutoEnter) {
        text = stripTrailingNewline(text);
    }
    if (tab.splitRoot) {
        const focused = getAllPanes(tab).find(p => p.focused);
        if (focused && focused.tabId) {
            ipcRenderer.send('pty-input', { tabId: focused.tabId, data: text });
            setTimeout(() => focused.term && focused.term.focus(), 50);
        }
    } else if (tab.tabId) {
        ipcRenderer.send('pty-input', { tabId: tab.tabId, data: text });
        setTimeout(() => tab.term && tab.term.focus(), 50);
    }
}

// “末尾回车自动执行”全局开关（设置 → 快捷命令页顶部）
function toggleQCAutoEnter() {
    _settingsConfig.qcAutoEnter = !_settingsConfig.qcAutoEnter;
    const el = document.getElementById('qc-auto-enter');
    if (el) el.classList.toggle('on', !!_settingsConfig.qcAutoEnter);
    persistSettings();
}

function renderQCCommandsList() {
    const container = document.getElementById('qc-commands-list');
    if (!container) return;
    // 同步“末尾回车自动执行”开关状态
    const qcToggle = document.getElementById('qc-auto-enter');
    if (qcToggle) qcToggle.classList.toggle('on', !!_settingsConfig.qcAutoEnter);
    if (_qcCommands.length === 0) {
        container.innerHTML = '<div style="padding:30px;text-align:center;color:rgba(171,178,191,0.25);font-size:13px">暂无命令</div>';
        return;
    }
    // Group by group name (collapsible, like SSH manager)
    const groups = {};
    _qcCommands.forEach(c => {
        const g = c.group || '未分组';
        if (!groups[g]) groups[g] = [];
        groups[g].push(c);
    });
    let html = '';
    Object.keys(groups).sort().forEach(g => {
        html += `<div class="ssh-group">
          <div class="ssh-group-header" onclick="toggleSSHGroup(this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            <span class="group-name-text">${escHtml(g)}</span>
            <button class="group-rename" title="重命名分组" onclick="event.stopPropagation();startRenameQCGroup(this,'${escJsString(g)}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
            <span class="ssh-group-count">${groups[g].length}</span>
          </div>
          <div class="ssh-group-items">`;
        groups[g].forEach(c => {
            html += `<div class="ssh-item">
              <div class="ssh-item-icon" style="background:rgba(var(--accent-rgb),0.08);color:rgb(var(--accent-rgb))">⌘</div>
              <div class="ssh-item-info" style="cursor:pointer" onclick="openQCEdit(false,'${c.id}')">
                <div class="ssh-item-name">${escHtml(c.name)}</div>
                <div class="ssh-item-detail" style="font-family:'JetBrains Mono',monospace">${escHtml(c.command)}</div>
              </div>
              <button class="ssh-item-btn" title="编辑" onclick="openQCEdit(false,'${c.id}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
              <button class="ssh-item-btn danger" title="删除" onclick="deleteQC('${c.id}')">×</button>
            </div>`;
        });
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function startRenameQCGroup(btn, oldName) {
    const header = btn.closest('.ssh-group-header');
    const nameSpan = header.querySelector('.group-name-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-input inline-edit';
    input.value = oldName;
    nameSpan.replaceWith(input);
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>';
    btn.style.color = '';
    input.focus();
    input.select();
    // 保留原始 onclick（HTML 属性），Esc 时还原——
    // 否则 finish(false) 后残留的 btn.onclick 闭包会在下次点击时执行 finish(true) 完成路径，
    // 而非重新进入重命名
    const originalOnClick = btn.getAttribute('onclick');

    const finish = (save) => {
        const newName = save ? input.value.trim() : oldName;
        const span = document.createElement('span');
        span.className = 'group-name-text';
        span.textContent = newName || oldName;
        input.replaceWith(span);
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        btn.style.color = '';
        // 还原原始 onclick（被 startRenameQCGroup 覆盖的 HTML 属性）
        btn.onclick = null;
        if (originalOnClick) btn.setAttribute('onclick', originalOnClick);

        if (save && newName && newName !== oldName) {
            _qcCommands.forEach(c => {
                if (c.group === oldName) c.group = newName;
            });
            saveQuickCommands();
            renderQCCommandsList();
            showToast('分组已重命名');
        }
    };

    btn.onclick = (e) => { e.stopPropagation(); finish(true); };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
}

function collapseAllQC() {
    document.querySelectorAll('#qc-commands-list .ssh-group-header').forEach(h => h.classList.add('collapsed'));
    document.querySelectorAll('#qc-commands-list .ssh-group-items').forEach(i => i.classList.add('collapsed'));
}

function expandAllQC() {
    document.querySelectorAll('#qc-commands-list .ssh-group-header').forEach(h => h.classList.remove('collapsed'));
    document.querySelectorAll('#qc-commands-list .ssh-group-items').forEach(i => i.classList.remove('collapsed'));
}

function deleteQC(id) {
    showConfirm('确定删除此命令？', () => {
        _qcCommands = _qcCommands.filter(c => c.id !== id);
        saveQuickCommands();
        renderQCCommandsList();
        showToast('命令已删除');
    });
}

// QC 分组下拉（照抄 SSH 配置的分组 combo）
function initQCGroupCombo() {
    const input = document.getElementById('qc-edit-group');
    const menu = document.getElementById('qc-group-menu');
    const groups = [...new Set(_qcCommands.map(c => c.group).filter(Boolean))];
    let activeIdx = -1;

    function renderOptions(filter) {
        const q = (filter || '').toLowerCase();
        const matched = groups.filter(g => g.toLowerCase().includes(q));
        menu.innerHTML = '';
        matched.forEach((g, i) => {
            const div = document.createElement('div');
            div.className = 'dd-option';
            div.textContent = g;
            div.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = g;
                menu.classList.remove('open');
            });
            menu.appendChild(div);
        });
        if (q && !groups.some(g => g.toLowerCase() === q)) {
            const div = document.createElement('div');
            div.className = 'dd-option create';
            div.textContent = '创建分组 "' + filter + '"';
            div.addEventListener('mousedown', (e) => {
                e.preventDefault();
                menu.classList.remove('open');
            });
            menu.appendChild(div);
        }
        if (matched.length > 0 || q) menu.classList.add('open');
        else menu.classList.remove('open');
        activeIdx = -1;
    }

    input.addEventListener('focus', () => renderOptions(input.value));
    input.addEventListener('input', () => renderOptions(input.value));
    // mousedown 触发 renderOptions：用户 Esc 关掉 menu 后再点 input 时
    // （input 没失焦，focus/input 事件不触发）能重新弹出下拉框
    input.addEventListener('mousedown', () => renderOptions(input.value));
    input.addEventListener('blur', () => setTimeout(() => menu.classList.remove('open'), 150));
    input.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('.dd-option')];
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            items[activeIdx].click();
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            menu.classList.remove('open');
        }
    });
}

function openQCEdit(isNew, id) {
    _editingQCId = isNew ? null : id;
    document.getElementById('qc-edit-title').textContent = isNew ? '添加命令' : '编辑命令';
    document.getElementById('qc-edit-name').value = '';
    document.getElementById('qc-edit-command').value = '';
    document.getElementById('qc-edit-group').value = '';
    if (!isNew && id) {
        const c = _qcCommands.find(x => x.id === id);
        if (c) {
            document.getElementById('qc-edit-name').value = c.name || '';
            document.getElementById('qc-edit-command').value = c.command || '';
            document.getElementById('qc-edit-group').value = c.group || '';
        }
    }
    openOverlay('overlay-qc-edit');
    initQCGroupCombo();
    setTimeout(() => document.getElementById('qc-edit-name').focus(), 100);
}

function closeQCEdit() {
    closeOverlay('overlay-qc-edit');
}

function saveQCEdit() {
    const name = document.getElementById('qc-edit-name').value.trim();
    // command 保存原文（保留用户输入的末尾回车）：编辑栏显示什么就存什么，
    // 末尾回车是否注入由“末尾回车自动执行”开关在注入时决定
    const commandRaw = document.getElementById('qc-edit-command').value;
    const group = document.getElementById('qc-edit-group').value.trim();
    if (!name || !commandRaw.trim()) {
        showToast('名称和命令不能为空', true);
        return;
    }
    if (_editingQCId) {
        const c = _qcCommands.find(x => x.id === _editingQCId);
        if (c) { c.name = name; c.command = commandRaw; c.group = group; }
    } else {
        _qcCommands.push({ id: 'qc_' + Date.now(), name, command: commandRaw, group });
    }
    saveQuickCommands();
    closeQCEdit();
    renderQCCommandsList();
    showToast('命令已保存');
}

