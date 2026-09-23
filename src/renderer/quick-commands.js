// ZTerm - Quick commands
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
        list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">没有匹配的命令<br><span style="font-size:11px;cursor:pointer;color:#8fc1ee;margin-top:8px;display:inline-block" onclick="closeQC();openSettings(\'quickcommands\')">+ 添加第一个命令</span></div>';
        return;
    }
    // V3 section-header layout: render a section header per group plus items (name + command + Enter badge)
    const groups = {};
    filtered.forEach((c, i) => {
        const k = c.group || '未分组';
        (groups[k] = groups[k] || []).push({ c, i });
    });
    let html = '';
    Object.entries(groups).forEach(([g, arr]) => {
        html += `<div class="v3-section">${escHtml(g)}</div>`;
        arr.forEach(({ c, i }) => {
            html += `
        <div class="v3-item" role="option" aria-selected="${i === _qcSelected}" data-index="${i}" ${i === _qcSelected ? 'data-selected' : ''} onclick="qcRun('${c.id}')" onmouseenter="qcSelect(${i})">
            <span class="v3-name">${escHtml(c.name)}</span>
            <span class="v3-cmd">${escHtml(c.command)}</span>
            <span class="v3-kbd">Enter</span>
        </div>`;
        });
    });
    list.innerHTML = html;
}

function qcSelect(i) {
    _qcSelected = i;
    document.querySelectorAll('#qc-list .v3-item').forEach((el, idx) => {
        if (idx === i) {
            el.setAttribute('data-selected', '');
            el.setAttribute('aria-selected', 'true');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.removeAttribute('data-selected');
            el.setAttribute('aria-selected', 'false');
        }
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
    // "Auto-execute trailing Enter" toggle: when off, strip one trailing newline (inject the command text only, no auto-execute)
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

// Global "auto-execute trailing Enter" toggle (top of Settings -> Quick Commands page)
function toggleQCAutoEnter() {
    _settingsConfig.qcAutoEnter = !_settingsConfig.qcAutoEnter;
    const el = document.getElementById('qc-auto-enter');
    if (el) el.classList.toggle('on', !!_settingsConfig.qcAutoEnter);
    persistSettings();
}

// ── Settings-page quick command list (aligned with the SSH settings page: section headers + one settings card per group) ──
// View state survives redraws: query text and the collapsed-group set.
const _qcSettingsView = { query: '', collapsed: new Set() };

// Focus continuity across a redraw: remember the focused control, re-focus
// the same logical control afterwards; a vanished control falls back to the
// page's stable search field (never strands focus on a removed node).
function _qcFocusSnapshot(listEl) {
    const el = document.activeElement;
    if (!el || !listEl || !listEl.contains(el)) return null;
    const row = el.closest('.ssh-mgr-row');
    if (row) {
        // Identity (row body) and icon buttons both carry data-action; record
        // which kind held focus so the restore lands on the same control.
        if (el.closest('.ssh-mgr-identity') && row.contains(el)) {
            return { qcId: row.dataset.qcId, action: '' };
        }
        const btn = el.closest('.ssh-mgr-btn');
        if (btn && row.contains(btn)) {
            return { qcId: row.dataset.qcId, action: btn.dataset.action || '' };
        }
        return { qcId: row.dataset.qcId, action: '' };
    }
    const group = el.closest('.ssh-mgr-group-title');
    if (group) return { group: group.dataset.group || '' };
    return null;
}
function _qcFocusRestore(listEl, snap) {
    if (!snap) return;
    let target = null;
    if (snap.qcId) {
        const row = [...listEl.querySelectorAll('.ssh-mgr-row')]
            .find(r => r.dataset.qcId === snap.qcId);
        if (row) {
            const known = ['edit', 'delete'].includes(snap.action);
            target = snap.action === '' || !known
                ? row.querySelector('.ssh-mgr-identity')
                : row.querySelector(`.ssh-mgr-btn[data-action="${snap.action}"]`);
        }
    } else if (snap.group) {
        target = [...listEl.querySelectorAll('.ssh-mgr-group-title')]
            .find(h => h.dataset.group === snap.group);
    }
    if (target) { target.focus({ preventScroll: true }); return; }
    const search = document.querySelector('[data-qc-search]');
    if (search) search.focus({ preventScroll: true });
}

// No command values in inline JS: clicks resolve the action and command id
// from data attributes via the container delegation below. No title tooltip
// on the identity: it would just repeat the visible text.
function _qcRowHtml(c) {
    const name = c.name || '';
    return `<article class="ssh-mgr-row" data-qc-id="${escAttr(c.id)}">
      <span class="ssh-mgr-server" aria-hidden="true">${Icons.iconSvg('command', 21)}</span>
      <div class="ssh-mgr-identity" role="button" tabindex="0" data-action="edit" aria-label="编辑 ${escAttr(name)}">
        <span class="ssh-mgr-primary">${escHtml(name)}</span>
        <span class="ssh-mgr-meta"><span class="mono">${escHtml(c.command || '')}</span></span>
      </div>
      <div class="ssh-mgr-actions">
        <button class="ssh-mgr-btn" data-action="edit" title="编辑" aria-label="编辑 ${escAttr(name)}">${Icons.iconSvg('pencil', 14)}</button>
        <button class="ssh-mgr-btn danger" data-action="delete" title="删除" aria-label="删除 ${escAttr(name)}">${Icons.iconSvg('trash', 14)}</button>
      </div>
    </article>`;
}

function _qcGroupHtml(gname, matched, expanded) {
    const rows = expanded ? matched.map(_qcRowHtml).join('') : '';
    return `<section class="ssh-mgr-group" aria-label="${escAttr(gname)}">
      <div class="ssh-mgr-group-title${expanded ? '' : ' collapsed'}" role="button" tabindex="0" aria-expanded="${expanded}"
           data-group="${escAttr(gname)}" onclick="toggleQCGroup(this)" onkeydown="qcGroupHeaderKey(event)">
        <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
        <span class="group-name-text">${escHtml(gname)}</span>
        <button class="group-rename" title="重命名分组" aria-label="重命名分组 ${escAttr(gname)}" onclick="event.stopPropagation();startRenameQCGroup(this)">${Icons.iconSvg('pencil', 11)}</button>
        <span class="ssh-group-count">${matched.length}</span>
        <span class="group-rule" aria-hidden="true"></span>
      </div>
      <div class="ssh-mgr-group-items${expanded ? '' : ' collapsed'}">${rows}</div>
    </section>`;
}

function _qcUpdateCount(matched, total) {
    const el = document.querySelector('[data-qc-count]');
    if (!el) return;
    el.textContent = matched === total ? `${total} 个命令` : `${matched} / ${total} 个命令`;
}

function renderQCCommandsList() {
    const container = document.getElementById('qc-commands-list');
    if (!container) return;
    // Sync the "auto-execute trailing Enter" toggle state
    const qcToggle = document.getElementById('qc-auto-enter');
    if (qcToggle) qcToggle.classList.toggle('on', !!_settingsConfig.qcAutoEnter);
    const snap = _qcFocusSnapshot(container);
    const querying = _qcSettingsView.query.trim().length > 0;
    if (_qcCommands.length === 0) {
        container.innerHTML = `<div class="ssh-mgr-empty">暂无命令
          <div class="ssh-mgr-empty-hint">通过 Ctrl+Shift+P 快速执行</div>
          <div class="ssh-mgr-empty-actions"><button class="btn-primary" onclick="openQCEdit(true)">+ 添加第一个命令</button></div></div>`;
        _qcUpdateCount(0, 0);
        _qcFocusRestore(container, snap);
        return;
    }
    const groups = {};
    _qcCommands.forEach(c => {
        const g = c.group || '未分组';
        (groups[g] = groups[g] || []).push(c);
    });
    let html = '', totalMatches = 0;
    Object.keys(groups).sort().forEach(g => {
        const matched = filterQuickCommands(groups[g], _qcSettingsView.query);
        if (!matched.length) return;
        totalMatches += matched.length;
        // While querying, matched groups are force-expanded so results stay
        // visible; the collapse set itself is untouched and reappears as-is
        // once the query is cleared.
        const expanded = querying || !_qcSettingsView.collapsed.has(g);
        html += _qcGroupHtml(g, matched, expanded);
    });
    container.innerHTML = totalMatches === 0
        ? `<div class="ssh-mgr-empty">没有匹配的命令<div class="ssh-mgr-empty-hint">试试调整或清空搜索。</div></div>`
        : html;
    _qcUpdateCount(totalMatches, _qcCommands.length);
    _qcFocusRestore(container, snap);
}

function filterQCCommands(query) {
    _qcSettingsView.query = query || '';
    renderQCCommandsList();
}

function toggleQCGroup(header) {
    if (header.querySelector('input')) return; // group rename in progress
    // Force-expansion during search is display-only; collapse toggles resume
    // once the query is cleared, so ignore them while a query is active.
    if (_qcSettingsView.query.trim()) return;
    const gname = header.dataset.group || '';
    if (_qcSettingsView.collapsed.has(gname)) _qcSettingsView.collapsed.delete(gname);
    else _qcSettingsView.collapsed.add(gname);
    // Re-render through the single render path: a collapsed group then has no
    // rows in the DOM at all, and focus continuity comes from the
    // snapshot/restore inside the renderer.
    renderQCCommandsList();
}

function qcGroupHeaderKey(e) {
    if (e.target !== e.currentTarget) return; // inner rename button keeps native behavior
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleQCGroup(e.currentTarget);
    }
}

// Delegated row interaction for the settings list: no inline handlers, so
// command values (ids, names) never enter an HTML/JS quoting context. The
// container deliberately does NOT carry .ssh-mgr-list — that class is the SSH
// profiles delegation hook and would double-handle these clicks.
(function bindQCSettingsDelegation() {
    const wire = () => {
        const list = document.getElementById('qc-commands-list');
        if (!list || list._qcBound) return;
        list._qcBound = true;
        list.addEventListener('click', e => {
            const row = e.target.closest('.ssh-mgr-row');
            if (!row || !list.contains(row)) return;
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !row.contains(actionEl)) return;
            const id = row.dataset.qcId;
            if (!id) return;
            const action = actionEl.dataset.action;
            if (action === 'edit') openQCEdit(false, id);
            else if (action === 'delete') deleteQC(id);
        });
        list.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const identity = e.target.closest('.ssh-mgr-identity');
            if (!identity || !list.contains(identity)) return;
            const row = identity.closest('.ssh-mgr-row');
            const id = row && row.dataset.qcId;
            if (!id) return;
            e.preventDefault();
            openQCEdit(false, id);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();

function startRenameQCGroup(btn) {
    const header = btn.closest('.ssh-mgr-group-title');
    if (!header) return;
    const nameSpan = header.querySelector('.group-name-text');
    if (!nameSpan) return;
    // Derive the name from the header's data attribute so group names never
    // enter an inline-JS quoting context.
    const oldName = header.dataset.group || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-input inline-edit';
    input.value = oldName;
    nameSpan.replaceWith(input);
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>';
    btn.style.color = '';
    input.focus();
    input.select();
    // Keep the original onclick (HTML attribute) and restore it on Esc —
    // otherwise the btn.onclick closure left over from finish(false) would run
    // the finish(true) commit path on the next click instead of re-entering rename
    const originalOnClick = btn.getAttribute('onclick');

    const finish = (save) => {
        const newName = save ? input.value.trim() : oldName;
        const span = document.createElement('span');
        span.className = 'group-name-text';
        span.textContent = newName || oldName;
        input.replaceWith(span);
        btn.innerHTML = Icons.iconSvg('pencil', 11);
        btn.style.color = '';
        // Restore the original onclick (the HTML attribute overridden by startRenameQCGroup)
        btn.onclick = null;
        if (originalOnClick) btn.setAttribute('onclick', originalOnClick);

        if (save && newName && newName !== oldName) {
            _qcCommands.forEach(c => {
                if ((c.group || '未分组') === oldName) c.group = newName;
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
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
}

// Collapse/expand-all applies to the settings list only.
function collapseAllQC() {
    _qcCommands.forEach(c => _qcSettingsView.collapsed.add(c.group || '未分组'));
    renderQCCommandsList();
}

function expandAllQC() {
    _qcSettingsView.collapsed.clear();
    renderQCCommandsList();
}

function deleteQC(id) {
    showConfirm('确定删除此命令？', () => {
        _qcCommands = _qcCommands.filter(c => c.id !== id);
        saveQuickCommands();
        renderQCCommandsList();
        showToast('命令已删除');
    });
}

// QC group dropdown (mirrors the group combo of the SSH profiles editor)
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
    // mousedown triggers renderOptions: clicking the input again after Esc closed
    // the menu reopens it (input never blurred, so no focus/input event fires)
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
    // command is stored verbatim (keeping any trailing Enter the user typed): whatever the
    // edit field shows is saved; the "auto-execute trailing Enter" toggle decides at injection time
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

