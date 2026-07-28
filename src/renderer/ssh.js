// ZTerm - 会话选择器 + SSH 管理 + 菜单弹窗（拆自 renderer.html，纯代码搬运，未改逻辑）
function toggleMenuPopup() {
    const popup = document.getElementById('menu-popup');
    const backdrop = document.getElementById('menu-backdrop');
    if (popup.classList.contains('open')) {
        popup.classList.remove('open');
        backdrop.classList.remove('open');
        document.body.classList.remove('menu-open');
        return;
    }
    const btn = document.getElementById('btn-menu');
    if (btn) {
        const rect = btn.getBoundingClientRect();
        const popupWidth = 180;
        popup.style.top = (rect.bottom + 4) + 'px';
        // Align left edge to button left, expand rightward; fall back to right-aligned if no space
        if (window.innerWidth - rect.left >= popupWidth) {
            popup.style.left = rect.left + 'px';
            popup.style.right = 'auto';
        } else {
            popup.style.left = 'auto';
            popup.style.right = (window.innerWidth - rect.right) + 'px';
        }
    }
    // Disable SFTP menu item when current tab is not SSH
    const sftpItem = popup.querySelector('[data-action="sftp"]');
    if (sftpItem) {
        const tab = TabManager.getActive();
        const isSSH = tab && (tab.type === 'ssh' || (tab.splitRoot && getAllPanes(tab).some(p => p.type === 'ssh' && p.tabId)));
        sftpItem.classList.toggle('disabled', !isSSH);
    }
    popup.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('menu-open');
}
function closeMenuPopup() {
    document.getElementById('menu-popup').classList.remove('open');
    document.getElementById('menu-backdrop').classList.remove('open');
    document.body.classList.remove('menu-open');
}
function openSFTPFromMenu() {
    const tab = TabManager.getActive();
    if (!tab) return;
    if (tab.splitRoot) {
        const focused = getAllPanes(tab).find(p => p.focused);
        if (focused && focused.tabId && focused.type === 'ssh') SFTP.open(focused.tabId);
    } else if (tab.tabId && tab.type === 'ssh') {
        SFTP.open(tab.tabId);
    }
}
// Close menu popup on click outside — the transparent backdrop intercepts all mouse events
// (clicks, hover) so buttons underneath (e.g. "+") are never triggered while menu is open
document.addEventListener('click', (e) => {
    const popup = document.getElementById('menu-popup');
    if (popup && popup.classList.contains('open') && !e.target.closest('.menu-popup') && !e.target.closest('#btn-menu')) {
        closeMenuPopup();
    }
}, true);


function openSessionSelector() {
    document.getElementById('sessions-search').value = '';
    renderSessionList();
    openOverlay('overlay-sessions');
    setTimeout(() => document.getElementById('sessions-search').focus(), 100);
}

// 默认本地终端：defaultShell 配置（兼容旧值存 command 的情况）→ 第一个 profile → 兜底 pwsh
function getDefaultLocalProfile() {
    const profiles = TabManager.profiles || [];
    const cur = _settingsConfig.defaultShell || '';
    return profiles.find(x => x.id === cur) || profiles.find(x => x.command === cur) || profiles[0]
        || { id: 'powershell', name: 'PowerShell', type: 'local', command: 'powershell.exe', args: [] };
}

function getSessionItems(filter) {
    const items = [];
    const hidden = _settingsConfig.hiddenProfiles || [];
    // Local profiles（可在设置里隐藏）
    (TabManager.profiles || []).forEach(p => {
        if (hidden.includes(p.id)) return;
        const cmdShort = (p.command || '').split('\\').pop();
        const detail = (p.args && p.args.length) ? cmdShort + ' ' + p.args.join(' ') : p.command;
        items.push({
            id: 'local_' + p.id, name: p.name, detail,
            type: 'local', badge: '', icon: p.icon === 'local' ? '⊞' : '>_',
            profile: p,
        });
    });
    // SSH profiles
    (TabManager.sshProfiles || []).forEach(p => {
        const detail = `${p.username}@${p.host}:${p.port || 22}`;
        items.push({
            id: 'ssh_' + p.id, name: p.name, detail,
            type: 'ssh', badge: p.group || '', icon: '⚡',
            sshProfile: p,
        });
    });
    if (filter) {
        const q = filter.toLowerCase();
        return items.filter(i =>
            i.name.toLowerCase().includes(q) ||
            i.detail.toLowerCase().includes(q) ||
            i.badge.toLowerCase().includes(q)
        );
    }
    return items;
}

function renderSessionList(filter) {
    const list = document.getElementById('sessions-list');
    const items = getSessionItems(filter);
    if (items.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:rgba(171,178,191,0.3);font-size:13px">没有匹配的会话</div>';
        return;
    }
    let html = '';
    let lastType = '';
    items.forEach((item, i) => {
        if (item.type !== lastType) {
            html += `<div class="panel-section-title">${item.type === 'local' ? '本地终端' : 'SSH 连接'}</div>`;
            lastType = item.type;
        }
        html += `<div class="panel-item" data-index="${i}" data-session-id="${item.id}" onclick="selectSession('${item.id}')" onmouseenter="selectPanelItem(this)">
          <div class="panel-item-icon ${item.type === 'ssh' ? 'ssh' : 'loc'}">${item.icon}</div>
          <div class="panel-item-info">
            <div class="panel-item-name">${escHtml(item.name)}</div>
            <div class="panel-item-detail">${escHtml(item.detail)}</div>
          </div>
          ${item.badge ? `<span class="panel-item-badge">${escHtml(item.badge)}</span>` : ''}
        </div>`;
    });
    list.innerHTML = html;
    // Pre-select the default local profile (fallback: first item)
    const defId = 'local_' + getDefaultLocalProfile().id;
    const target = list.querySelector(`[data-session-id="${defId}"]`) || list.querySelector('.panel-item');
    if (target) target.setAttribute('data-selected', '');
}

function filterSessions(query) {
    renderSessionList(query);
}

function selectPanelItem(el) {
    const list = document.getElementById('sessions-list');
    list.querySelectorAll('.panel-item').forEach(i => i.removeAttribute('data-selected'));
    el.setAttribute('data-selected', '');
}

function selectSession(sessionId) {
    const items = getSessionItems();
    const item = items.find(i => i.id === sessionId);
    if (!item) return;
    closeAllOverlays();
    if (item.type === 'local') {
        TabManager.createTab({ name: item.name, type: 'local', command: item.profile.command, args: item.profile.args });
    } else {
        // SSH: 注册凭据到主进程拿 credentialId，明文密码不回传 renderer
        const p = item.sshProfile;
        if (p.encryptedPassword || p.privateKeyPath) {
            ipcRenderer.invoke('register-credential', {
                encryptedPassword: p.encryptedPassword || '',
                privateKeyPath: p.privateKeyPath || '',
            }).then(({ credId, error }) => {
                if (error || !credId) {
                    showToast('凭据注册失败: ' + (error || 'unknown'), true);
                    return;
                }
                TabManager.createTab({
                    name: p.name, type: 'ssh',
                    host: p.host, port: p.port, user: p.username,
                    credId, sshProfileId: p.id,
                });
            });
        } else {
            TabManager.createTab({
                name: p.name, type: 'ssh',
                host: p.host, port: p.port, user: p.username,
                credId: null, sshProfileId: p.id,
            });
        }
    }
}

// ── SSH Manager ──
let _editingSSHId = null;

function openSSHManager() {
    renderSSHManager();
    openOverlay('overlay-ssh-manager');
}

function getSSHGroups() {
    const profiles = TabManager.sshProfiles || [];
    const groups = {};
    profiles.forEach(p => {
        const g = p.group || '默认';
        if (!groups[g]) groups[g] = [];
        groups[g].push(p);
    });
    return groups;
}

function renderSSHManager() {
    const list = document.getElementById('ssh-manager-list');
    const groups = getSSHGroups();
    const groupNames = Object.keys(groups);
    if (groupNames.length === 0) {
        list.innerHTML = '<div style="padding:30px;text-align:center;color:rgba(171,178,191,0.3);font-size:13px">暂无 SSH 连接<br><span style="font-size:11px;cursor:pointer;color:rgba(var(--accent-rgb),0.5);margin-top:8px;display:inline-block" onclick="openSSHEdit(true)">+ 添加第一个连接</span></div>';
        return;
    }
    let html = '';
    groupNames.forEach(gname => {
        const items = groups[gname];
        html += `<div class="ssh-group">
          <div class="ssh-group-header" onclick="toggleSSHGroup(this)">
            <svg class="group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            <span class="group-name-text">${escHtml(gname)}</span>
            <button class="group-rename" title="重命名分组" onclick="event.stopPropagation();startRenameGroup(this,'${escJsString(gname)}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
            <span class="ssh-group-count">${items.length}</span>
          </div>
          <div class="ssh-group-items">`;
        items.forEach(p => {
            html += `<div class="ssh-item">
              <div class="ssh-item-icon">⚡</div>
              <div class="ssh-item-info" style="cursor:pointer" onclick="openSSHEdit(false,'${p.id}')">
                <div class="ssh-item-name">${escHtml(p.name)}</div>
                <div class="ssh-item-detail">${escHtml(p.username)}@${escHtml(p.host)}:${p.port||22} ${p.authType==='key'?'🔑':''}</div>
              </div>
              <button class="ssh-item-btn connect" title="连接" onclick="event.stopPropagation();connectSSHProfile('${p.id}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
              <button class="ssh-item-btn" title="编辑" onclick="openSSHEdit(false,'${p.id}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
              <button class="ssh-item-btn danger" title="删除" onclick="deleteSSHProfile('${p.id}')">×</button>
            </div>`;
        });
        html += '</div></div>';
    });
    list.innerHTML = html;
    // Also refresh the settings page SSH list if visible
    setTimeout(() => {
        if (document.getElementById('settings-ssh-list')) renderSSHManagerInSettings();
    }, 0);
}

function toggleSSHGroup(header) {
    // Ignore if clicking on input
    if (header.querySelector('input')) return;
    header.classList.toggle('collapsed');
    const items = header.nextElementSibling;
    if (items) items.classList.toggle('collapsed');
}

function startRenameGroup(btn, oldName) {
    const header = btn.closest('.ssh-group-header');
    const nameSpan = header.querySelector('.group-name-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-input';
    input.value = oldName;
    nameSpan.replaceWith(input);
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>';
    btn.style.color = '';
    input.focus();
    input.select();

    const finish = (save) => {
        const newName = save ? input.value.trim() : oldName;
        const span = document.createElement('span');
        span.className = 'group-name-text';
        span.textContent = newName || oldName;
        input.replaceWith(span);
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        btn.style.color = '';

        if (save && newName && newName !== oldName) {
            const profiles = TabManager.sshProfiles || [];
            let changed = false;
            profiles.forEach(p => {
                if (p.group === oldName) { p.group = newName; changed = true; }
            });
            if (changed) {
                TabManager.sshProfiles = profiles;
                ipcRenderer.send('save-ssh-profiles', { sshProfiles: profiles });
                ipcRenderer.once('ssh-profiles-saved', () => {
                    renderSSHManager();
                    showToast('分组已重命名');
                });
            }
        }
    };

    btn.onclick = (e) => { e.stopPropagation(); finish(true); };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
}

function collapseAllGroups() {
    document.querySelectorAll('#ssh-manager-list .ssh-group-header').forEach(h => h.classList.add('collapsed'));
    document.querySelectorAll('#ssh-manager-list .ssh-group-items').forEach(i => i.classList.add('collapsed'));
}

function expandAllGroups() {
    document.querySelectorAll('#ssh-manager-list .ssh-group-header').forEach(h => h.classList.remove('collapsed'));
    document.querySelectorAll('#ssh-manager-list .ssh-group-items').forEach(i => i.classList.remove('collapsed'));
}

function openSSHEdit(isNew, profileId) {
    _editingSSHId = isNew ? null : profileId;
    document.getElementById('ssh-edit-title').textContent = isNew ? '添加 SSH 连接' : '编辑 SSH 连接';

    // Remove old custom dropdown wrappers
    document.querySelectorAll('#overlay-ssh-edit .cust-dropdown').forEach(d => d.remove());

    // Reset form
    document.getElementById('ssh-edit-name').value = '';
    document.getElementById('ssh-edit-host').value = '';
    document.getElementById('ssh-edit-port').value = '22';
    document.getElementById('ssh-edit-user').value = '';
    document.getElementById('ssh-edit-password').value = '';
    document.getElementById('ssh-edit-note').value = '';
    document.getElementById('ssh-edit-keypath').value = '';
    document.getElementById('ssh-edit-group').value = '';
    document.getElementById('ssh-edit-auth').selectedIndex = 0;
    document.getElementById('ssh-edit-followcwd').classList.remove('on');
    document.getElementById('ssh-edit-clearonconnect').classList.add('on');
    updateAuthFields();

    // Reset to connection tab
    switchSSHTab('conn');
    // Populate group select from existing profiles
    initGroupCombo();
    clearLoginScripts();

    if (!isNew && profileId) {
        const p = (TabManager.sshProfiles || []).find(x => x.id === profileId);
        if (p) {
            document.getElementById('ssh-edit-name').value = p.name || '';
            document.getElementById('ssh-edit-host').value = p.host || '';
            document.getElementById('ssh-edit-port').value = p.port || '22';
            document.getElementById('ssh-edit-user').value = p.username || '';
            document.getElementById('ssh-edit-note').value = p.note || '';
            document.getElementById('ssh-edit-keypath').value = p.privateKeyPath || '';
            document.getElementById('ssh-edit-group').value = p.group || '';
            document.getElementById('ssh-edit-followcwd').classList.toggle('on', !!p.followCwd);
            document.getElementById('ssh-edit-clearonconnect').classList.toggle('on', p.clearOnConnect !== false);
            if (p.authType === 'key') {
                document.getElementById('ssh-edit-auth').value = '密钥';
            }
            updateAuthFields();
            // Restore login scripts
            if (p.loginScripts && p.loginScripts.length > 0) {
                p.loginScripts.forEach(s => addLoginScriptRow(s.expect, s.send, s.isRegex, s.optional));
            }
        }
    }
    openOverlay('overlay-ssh-edit');
    setTimeout(() => {
        _initTabSlider();
        convertSelects();
        document.getElementById('ssh-edit-name').focus();
    }, 100);
}

// ── Group combobox ──
function initGroupCombo() {
    const input = document.getElementById('ssh-edit-group');
    const menu = document.getElementById('group-menu');
    const groups = [...new Set((TabManager.sshProfiles || []).map(p => p.group).filter(Boolean))];
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
        // "Create new" option when no exact match
        if (q && !groups.some(g => g.toLowerCase() === q)) {
            const div = document.createElement('div');
            div.className = 'dd-option create';
            div.textContent = '✚ 创建分组 "' + filter + '"';
            div.addEventListener('mousedown', (e) => {
                e.preventDefault();
                menu.classList.remove('open');
            });
            menu.appendChild(div);
        }
        if (matched.length > 0 || q) {
            menu.classList.add('open');
        } else {
            menu.classList.remove('open');
        }
        activeIdx = -1;
    }

    input.addEventListener('focus', () => renderOptions(input.value));
    input.addEventListener('input', () => renderOptions(input.value));
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
            menu.classList.remove('open');
        }
    });
}
function updateAuthFields() {
    const isKey = document.getElementById('ssh-edit-auth').value === '密钥';
    document.getElementById('ssh-pwd-row').style.display = isKey ? 'none' : '';
    document.getElementById('ssh-key-row').style.display = isKey ? '' : 'none';
}

function switchSSHTab(name) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === name));
    document.querySelectorAll('.ssh-tab-panel').forEach(p => p.classList.toggle('active', p.id === 'ssh-tab-' + name));
    // Animate pill slider
    const targetTab = document.querySelector('.panel-tab[data-tab="' + name + '"]');
    const tabsEl = document.getElementById('ssh-edit-tabs');
    const slider = document.getElementById('panel-tab-slider');
    if (targetTab && tabsEl && slider) {
        const tr = targetTab.getBoundingClientRect();
        const pr = tabsEl.getBoundingClientRect();
        slider.style.left = (tr.left - pr.left) + 'px';
        slider.style.top = (tr.top - pr.top) + 'px';
        slider.style.width = tr.width + 'px';
        slider.style.height = tr.height + 'px';
    }
    if (name === 'scripts') {
        requestAnimationFrame(() => _updateLSBadge());
    }
}

// Initialize slider position when panel opens
function _initTabSlider() {
    const activeTab = document.querySelector('.panel-tab.active');
    const tabsEl = document.getElementById('ssh-edit-tabs');
    const slider = document.getElementById('panel-tab-slider');
    if (!activeTab || !tabsEl || !slider) return;
    const tr = activeTab.getBoundingClientRect();
    const pr = tabsEl.getBoundingClientRect();
    slider.style.left = (tr.left - pr.left) + 'px';
    slider.style.top = (tr.top - pr.top) + 'px';
    slider.style.width = tr.width + 'px';
    slider.style.height = tr.height + 'px';
    // Disable transition on first render so it doesn't fly in from 0,0
    slider.style.transition = 'none';
    requestAnimationFrame(() => { slider.style.transition = ''; });
}

function _updateLSBadge() {
    const badge = document.getElementById('ls-tab-badge');
    if (!badge) return;
    const n = document.querySelectorAll('#login-scripts-container .login-script-row').length;
    badge.textContent = n > 0 ? n : '';
}

function clearLoginScripts() {
    const container = document.getElementById('login-scripts-container');
    if (container) container.innerHTML = '';
    _updateLSBadge();
}

function addLoginScriptRow(expect, send, isRegex, optional) {
    const container = document.getElementById('login-scripts-container');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'login-script-row';
    row.innerHTML =
        '<input class="ls-expect" placeholder="Expect" value="' + escHtml(expect || '') + '">' +
        '<input class="ls-send" placeholder="Send" value="' + escHtml(send || '') + '">' +
        '<span class="ls-toggle' + (isRegex ? ' on' : '') + '" title="正则匹配" onclick="this.classList.toggle(\'on\')">正则</span>' +
        '<span class="ls-toggle' + (optional ? ' on' : '') + '" title="可选匹配" onclick="this.classList.toggle(\'on\')">可选</span>' +
        '<button class="ls-del" onclick="deleteLoginScriptRow(this)">×</button>';
    container.appendChild(row);
    _updateLSBadge();
}

function deleteLoginScriptRow(btn) {
    const row = btn.closest('.login-script-row');
    if (row) { row.remove(); _updateLSBadge(); }
}

function collectLoginScripts() {
    const rows = document.querySelectorAll('#login-scripts-container .login-script-row');
    const scripts = [];
    rows.forEach(row => {
        const expect = row.querySelector('.ls-expect')?.value || '';
        const send = row.querySelector('.ls-send')?.value || '';
        const toggles = row.querySelectorAll('.ls-toggle');
        const isRegex = toggles[0]?.classList.contains('on') || false;
        const optional = toggles[1]?.classList.contains('on') || false;
        if (expect || send) {
            scripts.push({ expect, send, isRegex, optional });
        }
    });
    return scripts;
}

function closeSSHEdit() {
    closeOverlay('overlay-ssh-edit');
}

function saveSSHEdit() {
    const name = document.getElementById('ssh-edit-name').value.trim();
    const host = document.getElementById('ssh-edit-host').value.trim();
    const port = parseInt(document.getElementById('ssh-edit-port').value) || 22;
    const username = document.getElementById('ssh-edit-user').value.trim();
    const password = document.getElementById('ssh-edit-password').value;
    const note = document.getElementById('ssh-edit-note').value.trim();
    const group = document.getElementById('ssh-edit-group').value.trim();
    const authType = document.getElementById('ssh-edit-auth').value === '密钥' ? 'key' : 'password';
    const privateKeyPath = document.getElementById('ssh-edit-keypath').value.trim();
    const followCwd = document.getElementById('ssh-edit-followcwd').classList.contains('on');
    const clearOnConnect = document.getElementById('ssh-edit-clearonconnect').classList.contains('on');

    if (!name || !host) {
        showToast('名称和主机地址不能为空', true);
        return;
    }

    const doSave = (encryptedPassword) => {
        let profiles = [...(TabManager.sshProfiles || [])];
        const profile = {
            id: _editingSSHId || ('ssh_' + Date.now()),
            name, group, host, port, username, authType,
            encryptedPassword: encryptedPassword || '',
            privateKeyPath: authType === 'key' ? privateKeyPath : '',
            note, followCwd, clearOnConnect,
            loginScripts: collectLoginScripts(),
        };

        if (_editingSSHId) {
            const idx = profiles.findIndex(p => p.id === _editingSSHId);
            if (idx >= 0) {
                profile.id = _editingSSHId;
                profiles[idx] = profile;
            } else {
                profiles.push(profile);
            }
        } else {
            profiles.push(profile);
        }

        TabManager.sshProfiles = profiles;
        ipcRenderer.once('ssh-profiles-saved', () => {
            renderSSHManager();
            closeSSHEdit();
            showToast('SSH 连接已保存');
        });
        ipcRenderer.send('save-ssh-profiles', { sshProfiles: profiles });
    };

    if (authType === 'password' && password) {
        ipcRenderer.once('encrypt-password-result', (event, result) => {
            if (result.error) {
                showToast('密码加密失败: ' + result.error, true);
                return;
            }
            doSave(result.encrypted);
        });
        ipcRenderer.send('encrypt-password', { plaintext: password });
    } else {
        doSave(_editingSSHId ? (TabManager.sshProfiles.find(p => p.id === _editingSSHId) || {}).encryptedPassword || '' : '');
    }
}

function connectSSHProfile(profileId) {
    closeAllOverlays();
    const p = (TabManager.sshProfiles || []).find(x => x.id === profileId);
    if (!p) return;
    if (p.encryptedPassword || p.privateKeyPath) {
        ipcRenderer.invoke('register-credential', {
            encryptedPassword: p.encryptedPassword || '',
            privateKeyPath: p.privateKeyPath || '',
        }).then(({ credId, error }) => {
            if (error || !credId) {
                showToast('凭据注册失败: ' + (error || 'unknown'), true);
                return;
            }
            TabManager.createTab({
                name: p.name, type: 'ssh',
                host: p.host, port: p.port, user: p.username,
                credId, sshProfileId: p.id,
            });
        });
    } else {
        TabManager.createTab({
            name: p.name, type: 'ssh',
            host: p.host, port: p.port, user: p.username,
            credId: null, sshProfileId: p.id,
        });
    }
}

function deleteSSHProfile(id) {
    showConfirm('确定删除此 SSH 连接？', () => {
        let profiles = (TabManager.sshProfiles || []).filter(p => p.id !== id);
        TabManager.sshProfiles = profiles;
        ipcRenderer.once('ssh-profiles-saved', () => {
            renderSSHManager();
            showToast('SSH 连接已删除');
        });
        ipcRenderer.send('save-ssh-profiles', { sshProfiles: profiles });
    });
}

// ── Confirm dialog ──
