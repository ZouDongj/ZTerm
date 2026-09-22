// ZTerm - 会话选择器 + SSH 管理 + 菜单弹窗（拆自 renderer.html，纯代码搬运，未改逻辑）

// 动态填充顶栏"⋮"菜单的快捷键文本：必须用 _getShortcutBindings() 拿当前绑定，
// 否则用户改过快捷键后菜单显示跟实际不一致
function updateMenuShortcuts() {
    const bindings = _getShortcutBindings();
    document.querySelectorAll('.menu-shortcut[data-action]').forEach(el => {
        const actionId = el.getAttribute('data-action');
        const combo = bindings[actionId] || '';
        el.textContent = combo ? _comboDisplay(combo) : '';
    });
}

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


// ── Session Selector (new-session overlay) ──
// Selection is tracked by stable session ID (local_/ssh_ + profile id), never
// by filtered DOM index; key/focus/Esc routing is consolidated in this
// module's own listeners, bound on open and unbound on close.
let _sessionSel = null;

function openSessionSelector() {
    const opener = document.activeElement;
    _sessionSel = {
        activeId: null,
        opener: opener && opener !== document.body && opener.isConnected ? opener : null,
        keysBound: false,
    };
    const search = document.getElementById('sessions-search');
    search.value = '';
    _updateSessionClearBtn();
    renderSessionList('');
    // Pre-select the visible default-local-profile item, else the first item;
    // with no visible items the selection stays empty
    const items = getSessionItems('');
    const defId = 'local_' + getDefaultLocalProfile().id;
    _sessionSel.activeId = items.some(i => i.id === defId) ? defId : (items.length ? items[0].id : null);
    // Scroll the preselected row into view: the default local profile is not
    // necessarily among the first few items.
    _syncSessionSelection(true);
    openOverlay('overlay-sessions');
    _bindSessionKeys();
    // Focus only while this exact opening is still live (a close/reopen within
    // the delay must not steal focus back).
    const openToken = _sessionSel;
    setTimeout(() => {
        if (_sessionSel !== openToken) return;
        const s = document.getElementById('sessions-search');
        if (s) s.focus();
    }, 100);
}

// Unified close path: unbind listeners and clear selection state. A plain
// close restores the invoking control, falling back to the active terminal
// when it is gone; navigating to the manager or opening a session hands
// focus to the destination instead.
function _closeSessionSelector(restoreFocus) {
    _unbindSessionKeys();
    closeOverlay('overlay-sessions');
    const opener = _sessionSel ? _sessionSel.opener : null;
    _sessionSel = null;
    if (!restoreFocus) return;
    // A still-connected but hidden opener (e.g. a button inside an overlay
    // that has since closed) swallows focus() as a silent no-op; treat it as
    // gone and fall back to the active terminal.
    if (opener && opener.isConnected && opener.getClientRects().length > 0) {
        opener.focus({ preventScroll: true });
    } else if (typeof _refocusActiveTerminal === 'function') {
        _refocusActiveTerminal();
    }
}

function _bindSessionKeys() {
    if (!_sessionSel || _sessionSel.keysBound) return;
    _sessionSel.keysBound = true;
    document.addEventListener('keydown', _sessionKeyHandler, true);
}
function _unbindSessionKeys() {
    if (_sessionSel) _sessionSel.keysBound = false;
    document.removeEventListener('keydown', _sessionKeyHandler, true);
}

function _sessionKeyHandler(e) {
    const overlay = document.getElementById('overlay-sessions');
    if (!overlay || !overlay.classList.contains('open')) {
        // Closed via an external path (closeAllOverlays / another overlay):
        // self-clean so no stale listener survives
        _unbindSessionKeys();
        return;
    }
    // IME composition: never select, connect or close; confirming a
    // candidate is not "open session".
    if (e.isComposing || e.keyCode === 229) return;
    const onButton = e.target && e.target.closest && e.target.closest('button');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        _moveSessionActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
        if (onButton) return; // native buttons (footer/clear/close) run their own action
        e.preventDefault(); e.stopPropagation();
        if (_sessionSel && _sessionSel.activeId) selectSession(_sessionSel.activeId);
    } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        _closeSessionSelector(true);
    } else if (e.key === 'Tab') {
        _trapSessionTab(e);
    }
    // Left/right/Home/End keep the search field's native text editing
}

function _moveSessionActive(delta) {
    if (!_sessionSel) return;
    const search = document.getElementById('sessions-search');
    const items = getSessionItems(search ? search.value : '');
    if (!items.length) return; // 零结果不执行选择、不报错
    const idx = items.findIndex(i => i.id === _sessionSel.activeId);
    // No current selection (edge): Down lands on the first item, Up on the
    // last — never a wrapped-around middle item.
    const next = idx < 0
        ? (delta > 0 ? items[0] : items[items.length - 1])
        : items[(idx + delta + items.length) % items.length];
    _sessionSel.activeId = next.id;
    _syncSessionSelection(true);
}

function _trapSessionTab(e) {
    const panel = document.querySelector('#overlay-sessions .panel');
    if (!panel) return;
    const focusables = [...panel.querySelectorAll('input, button')]
        .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!panel.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    }
}

// Delegated row interaction: mousedown must not steal the search field's
// focus; a click opens exactly the clicked row's stable ID (not a stale
// keyboard selection); hover is CSS-only and never changes the selection.
(function bindSessionListDelegation() {
    const wire = () => {
        const list = document.getElementById('sessions-list');
        if (!list) return;
        list.addEventListener('mousedown', e => {
            if (e.target.closest('.ss-row')) e.preventDefault();
        });
        list.addEventListener('click', e => {
            const row = e.target.closest('.ss-row');
            if (!row) return;
            const id = row.dataset.id;
            if (id) selectSession(id);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();

// 默认本地终端：defaultShell 配置（兼容旧值存 command 的情况）→ 第一个 profile → 兜底 pwsh
function getDefaultLocalProfile() {
    const profiles = TabManager.profiles || [];
    const cur = _settingsConfig.defaultShell || '';
    return profiles.find(x => x.id === cur) || profiles.find(x => x.command === cur) || profiles[0]
        || { id: 'powershell', name: 'PowerShell', type: 'local', command: 'powershell.exe', args: [] };
}

function getSessionItems(filter) {
    const hidden = _settingsConfig.hiddenProfiles || [];
    const items = buildSessionItems(TabManager.profiles, TabManager.sshProfiles, hidden);
    return filterSessionItems(items, filter);
}

function renderSessionList(filter) {
    const list = document.getElementById('sessions-list');
    const status = document.getElementById('sessions-status');
    const items = getSessionItems(filter);
    if (items.length === 0) {
        list.innerHTML = '<div class="ss-empty" role="presentation"><strong>没有匹配的会话</strong><p>试试名称、地址、用户名或分组。</p></div>';
        if (status) status.textContent = '没有匹配的会话';
        return items;
    }
    let html = '';
    let lastType = '';
    items.forEach(item => {
        if (item.type !== lastType) {
            if (lastType) html += '</div>';
            const label = item.type === 'local' ? '本地终端' : 'SSH 连接';
            html += `<div class="ss-section" role="group" aria-label="${label}"><div class="ss-section-label" aria-hidden="true">${label}</div>`;
            lastType = item.type;
        }
        html += _sessionRowHtml(item);
    });
    if (lastType) html += '</div>';
    list.innerHTML = html;
    if (status) status.textContent = `${items.length} 个可用会话`;
    return items;
}

// Same display algorithm as the SSH manager (ssh-display.js); only grouping
// and selection presentation differ
function _sessionRowHtml(item) {
    const selected = !!_sessionSel && _sessionSel.activeId === item.id;
    let icon, primary, meta, group = '', titleText = '';
    if (item.type === 'ssh') {
        const m = SshDisplay.sshDisplayModel(item.sshProfile);
        const keyBadge = m.keyAuth
            ? `<span class="ss-key" role="img" aria-label="密钥认证" title="密钥认证">${Icons.iconSvg('key', 11)}</span>` : '';
        icon = 'server';
        primary = `<span class="ss-primary ${m.primaryIsHost ? 'host' : ''}">${escHtml(m.primary)}</span>`;
        meta = m.named
            ? `<span class="mono">${escHtml(m.endpoint)}</span><span class="dot">·</span><span>${escHtml(m.user)}</span>${keyBadge}`
            : `<span>${escHtml(m.user)}</span><span class="dot">·</span><span>端口 <span class="mono">${escHtml(String(m.port))}</span></span>${keyBadge}`;
        titleText = m.named ? `${m.primary} — ${m.endpoint} · ${m.user}` : `${m.primary} — ${m.user} · 端口 ${m.port}`;
        group = item.badge || '';
    } else {
        icon = 'terminal';
        primary = `<span class="ss-primary">${escHtml(item.name)}</span>`;
        meta = `<span>${escHtml(item.detail)}</span>`;
        titleText = item.detail ? `${item.name} — ${item.detail}` : item.name;
    }
    return `<div class="ss-row" role="option" id="sess-opt-${escAttr(item.id)}" aria-selected="${selected}" data-id="${escAttr(item.id)}" title="${escAttr(titleText)}">
      <span class="ss-row-icon" aria-hidden="true">${Icons.iconSvg(icon, 19)}</span>
      <span class="ss-identity">${primary}<span class="ss-meta">${meta}</span></span>
      ${group ? `<span class="ss-group-name">${escHtml(group)}</span>` : ''}
      <span class="ss-open" aria-hidden="true">${Icons.iconSvg('enter-arrow', 15)}</span>
    </div>`;
}

function _syncSessionSelection(scroll) {
    const list = document.getElementById('sessions-list');
    const search = document.getElementById('sessions-search');
    const activeId = _sessionSel ? _sessionSel.activeId : null;
    let activeEl = null;
    list.querySelectorAll('.ss-row').forEach(row => {
        const on = !!activeId && row.dataset.id === activeId;
        row.setAttribute('aria-selected', String(on));
        if (on) activeEl = row;
    });
    if (search) {
        if (activeEl) search.setAttribute('aria-activedescendant', activeEl.id);
        else search.removeAttribute('aria-activedescendant');
    }
    // Scroll only the inner list so the active row enters the nearest visible
    // area; the search field, footer and background must not jump
    if (activeEl && scroll) activeEl.scrollIntoView({ block: 'nearest' });
}

function filterSessions(query) {
    const items = renderSessionList(query || '');
    _updateSessionClearBtn();
    if (!_sessionSel) return;
    if (_sessionSel.activeId && items.some(i => i.id === _sessionSel.activeId)) {
        // Keep the selection while it remains in the results (also when the
        // query is cleared and the selection is still valid)
    } else {
        const defId = 'local_' + getDefaultLocalProfile().id;
        const cleared = !query || !query.trim();
        _sessionSel.activeId = cleared && items.some(i => i.id === defId)
            ? defId
            : (items.length ? items[0].id : null);
    }
    _syncSessionSelection(true);
}

function _updateSessionClearBtn() {
    const search = document.getElementById('sessions-search');
    const clear = document.getElementById('sessions-clear');
    if (clear && search) clear.hidden = !search.value;
}

function clearSessionSearch() {
    const search = document.getElementById('sessions-search');
    if (!search) return;
    search.value = '';
    filterSessions('');
    search.focus();
}

function selectSession(sessionId) {
    const items = getSessionItems();
    const item = items.find(i => i.id === sessionId);
    if (!item) return;
    _closeSessionSelector(false); // focus is taken over by the new session/tab flow
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

// ── SSH Manager (scheme-A rows shared by settings page and overlay) ──
let _editingSSHId = null;

// Per-container in-memory view state: search query + collapse choices.
// Collapse state deliberately has no storage contract — it lives here for
// the app run only, so re-renders (CRUD, filtering) preserve it and clearing
// the search restores the pre-query collapse view for free.
const _sshMgrViews = new Map();
function _sshMgrView(containerId) {
    let v = _sshMgrViews.get(containerId);
    if (!v) {
        v = { query: '', collapsed: new Set() };
        _sshMgrViews.set(containerId, v);
    }
    return v;
}

function openSSHManager() {
    renderSSHManager();
    openOverlay('overlay-ssh-manager');
    setTimeout(() => {
        const s = document.getElementById('ssh-manager-search');
        if (s) s.focus();
    }, 100);
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

// Focus continuity across a redraw: remember the focused control, re-focus
// the same logical control afterwards; a vanished control falls back to the
// container's stable search field (never strands focus on a removed node).
function _sshFocusSnapshot(listEl) {
    const el = document.activeElement;
    if (!el || !listEl || !listEl.contains(el)) return null;
    const row = el.closest('.ssh-mgr-row');
    if (row) {
        // Identity (row body) and icon buttons both carry data-action; record
        // which kind held focus so the restore lands on the same control.
        if (el.closest('.ssh-mgr-identity') && row.contains(el)) {
            return { profileId: row.dataset.profileId, action: '' };
        }
        const btn = el.closest('.ssh-mgr-btn');
        if (btn && row.contains(btn)) {
            return { profileId: row.dataset.profileId, action: btn.dataset.action || '' };
        }
        return { profileId: row.dataset.profileId, action: '' };
    }
    const group = el.closest('.ssh-mgr-group-title');
    if (group) return { group: group.dataset.group || '' };
    return null;
}
function _sshFocusRestore(listEl, snap) {
    if (!snap) return;
    let target = null;
    if (snap.profileId) {
        const row = [...listEl.querySelectorAll('.ssh-mgr-row')]
            .find(r => r.dataset.profileId === snap.profileId);
        if (row) {
            const known = ['connect', 'edit', 'delete'].includes(snap.action);
            target = snap.action === '' || !known
                ? row.querySelector('.ssh-mgr-identity')
                : row.querySelector(`.ssh-mgr-btn[data-action="${snap.action}"]`);
        }
    } else if (snap.group) {
        target = [...listEl.querySelectorAll('.ssh-mgr-group-title')]
            .find(h => h.dataset.group === snap.group);
    }
    if (target) { target.focus({ preventScroll: true }); return; }
    const search = document.querySelector(`[data-ssh-search="${listEl.id}"]`);
    if (search) search.focus({ preventScroll: true });
}

function _sshRowHtml(p) {
    const m = SshDisplay.sshDisplayModel(p);
    const metaText = m.named ? `${m.endpoint} · ${m.user}` : `${m.user} · 端口 ${m.port}`;
    const keyBadge = m.keyAuth
        ? `<span class="ssh-mgr-key" role="img" aria-label="密钥认证" title="密钥认证">${Icons.iconSvg('key', 11)}</span>` : '';
    const meta = m.named
        ? `<span class="mono">${escHtml(m.endpoint)}</span><span class="dot">·</span><span>${escHtml(m.user)}</span>`
        : `<span>${escHtml(m.user)}</span><span class="dot">·</span><span>端口 <span class="mono">${escHtml(String(m.port))}</span></span>`;
    // No profile values in inline JS (design §3): clicks resolve the action
    // and profile id from data attributes via the container delegation below.
    // No title tooltip on the identity: it would just repeat the visible text.
    return `<article class="ssh-mgr-row" data-profile-id="${escAttr(p.id)}">
      <span class="ssh-mgr-server" aria-hidden="true">${Icons.iconSvg('server', 21)}</span>
      <div class="ssh-mgr-identity" role="button" tabindex="0" data-action="edit" aria-label="编辑 ${escAttr(m.primary)} — ${escAttr(metaText)}">
        <span class="ssh-mgr-primary ${m.primaryIsHost ? 'host' : ''}">${escHtml(m.primary)}</span>
        <span class="ssh-mgr-meta">${meta}${keyBadge}</span>
      </div>
      <div class="ssh-mgr-actions">
        <button class="ssh-mgr-btn connect" data-action="connect" title="连接" aria-label="连接 ${escAttr(m.primary)}">${Icons.iconSvg('play', 14)}</button>
        <button class="ssh-mgr-btn" data-action="edit" title="编辑" aria-label="编辑 ${escAttr(m.primary)}">${Icons.iconSvg('pencil', 14)}</button>
        <button class="ssh-mgr-btn danger" data-action="delete" title="删除" aria-label="删除 ${escAttr(m.primary)}">${Icons.iconSvg('trash', 14)}</button>
      </div>
    </article>`;
}

// Delegated row interaction for both manager containers: no inline handlers,
// so config values (ids, names) never enter an HTML/JS quoting context.
(function bindSSHManagerDelegation() {
    const wire = () => {
        document.querySelectorAll('.ssh-mgr-list').forEach(list => {
            if (list._sshMgrBound) return;
            list._sshMgrBound = true;
            list.addEventListener('click', e => {
                const row = e.target.closest('.ssh-mgr-row');
                if (!row || !list.contains(row)) return;
                const actionEl = e.target.closest('[data-action]');
                if (!actionEl || !row.contains(actionEl)) return;
                const id = row.dataset.profileId;
                if (!id) return;
                const action = actionEl.dataset.action;
                if (action === 'connect') connectSSHProfile(id);
                else if (action === 'edit') openSSHEdit(false, id);
                else if (action === 'delete') deleteSSHProfile(id);
            });
            list.addEventListener('keydown', e => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const identity = e.target.closest('.ssh-mgr-identity');
                if (!identity || !list.contains(identity)) return;
                const row = identity.closest('.ssh-mgr-row');
                const id = row && row.dataset.profileId;
                if (!id) return;
                e.preventDefault();
                openSSHEdit(false, id);
            });
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();

function _sshGroupHtml(gname, matched, expanded) {
    const rows = expanded ? matched.map(_sshRowHtml).join('') : '';
    return `<section class="ssh-mgr-group" aria-label="${escAttr(gname)}">
      <div class="ssh-mgr-group-title${expanded ? '' : ' collapsed'}" role="button" tabindex="0" aria-expanded="${expanded}"
           data-group="${escAttr(gname)}" onclick="toggleSSHGroup(this)" onkeydown="sshGroupHeaderKey(event)">
        <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
        <span class="group-name-text">${escHtml(gname)}</span>
        <button class="group-rename" title="重命名分组" aria-label="重命名分组 ${escAttr(gname)}" onclick="event.stopPropagation();startRenameGroup(this)">${Icons.iconSvg('pencil', 11)}</button>
        <span class="ssh-group-count">${matched.length}</span>
        <span class="group-rule" aria-hidden="true"></span>
      </div>
      <div class="ssh-mgr-group-items${expanded ? '' : ' collapsed'}">${rows}</div>
    </section>`;
}

function _sshUpdateCount(containerId, matched, total) {
    const el = document.querySelector(`[data-ssh-count="${containerId}"]`);
    if (!el) return;
    el.textContent = matched === total ? `${total} 个连接` : `${matched} / ${total} 个连接`;
}

// Shared A-scheme renderer for both manager entries. Display format comes
// from ssh-display.js; order and IDs are the stored profile order/identity.
function renderSSHManagerInto(listEl, view) {
    if (!listEl) return;
    const profiles = TabManager.sshProfiles || [];
    const snap = _sshFocusSnapshot(listEl);
    const querying = view.query.trim().length > 0;
    if (profiles.length === 0) {
        listEl.innerHTML = `<div class="ssh-mgr-empty">暂无 SSH 连接
          <div class="ssh-mgr-empty-hint">密码使用 Windows DPAPI 加密存储</div>
          <div class="ssh-mgr-empty-actions"><button class="btn-primary" onclick="openSSHEdit(true)">+ 添加第一个连接</button></div></div>`;
        _sshUpdateCount(listEl.id, 0, 0);
        // Rows are gone: return focus to the container's stable search field
        // instead of stranding it on a removed node.
        _sshFocusRestore(listEl, snap);
        return;
    }
    const groups = getSSHGroups();
    let html = '', totalMatches = 0;
    Object.keys(groups).forEach(gname => {
        const matched = groups[gname].filter(p => SshDisplay.sshProfileMatches(p, view.query));
        if (!matched.length) return;
        totalMatches += matched.length;
        // While querying, matched groups are force-expanded so results stay
        // visible; the collapse set itself is untouched and reappears as-is
        // once the query is cleared.
        const expanded = querying || !view.collapsed.has(gname);
        html += _sshGroupHtml(gname, matched, expanded);
    });
    listEl.innerHTML = totalMatches === 0
        ? `<div class="ssh-mgr-empty">没有匹配的连接<div class="ssh-mgr-empty-hint">试试调整或清空搜索。</div></div>`
        : html;
    _sshUpdateCount(listEl.id, totalMatches, profiles.length);
    _sshFocusRestore(listEl, snap);
}

function renderSSHManager() {
    renderSSHManagerInto(document.getElementById('ssh-manager-list'), _sshMgrView('ssh-manager-list'));
    // Both manager entries show the same data: keep the settings page in sync.
    renderSSHManagerInSettings();
}

function filterSSHManager(containerId, query) {
    const view = _sshMgrView(containerId);
    view.query = query || '';
    renderSSHManagerInto(document.getElementById(containerId), view);
}

function toggleSSHGroup(header) {
    if (header.querySelector('input')) return; // group rename in progress
    const list = header.closest('.ssh-mgr-list');
    if (!list) return;
    const view = _sshMgrView(list.id);
    // Force-expansion during search is display-only; collapse toggles resume
    // once the query is cleared, so ignore them while a query is active.
    if (view.query.trim()) return;
    const gname = header.dataset.group || '';
    if (view.collapsed.has(gname)) view.collapsed.delete(gname);
    else view.collapsed.add(gname);
    // Re-render through the single render path: a collapsed group then has no
    // rows in the DOM at all (same shape as its initially-rendered form), and
    // focus continuity comes from the snapshot/restore inside the renderer.
    renderSSHManagerInto(list, view);
}

function sshGroupHeaderKey(e) {
    if (e.target !== e.currentTarget) return; // inner rename button keeps native behavior
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSSHGroup(e.currentTarget);
    }
}

// Collapse/expand-all applies to its own manager container only
// (settings page and overlay do not affect each other)
function collapseAllGroups(containerId) {
    const view = _sshMgrView(containerId);
    Object.keys(getSSHGroups()).forEach(g => view.collapsed.add(g));
    renderSSHManagerInto(document.getElementById(containerId), view);
}

function expandAllGroups(containerId) {
    const view = _sshMgrView(containerId);
    view.collapsed.clear();
    renderSSHManagerInto(document.getElementById(containerId), view);
}

function startRenameGroup(btn, oldName) {
    const header = btn.closest('.ssh-mgr-group-title, .ssh-group-header');
    if (!header) return;
    const nameSpan = header.querySelector('.group-name-text');
    if (!nameSpan) return;
    // The manager renderer passes no name: derive it from the header's data
    // attribute so group names never enter an inline-JS quoting context.
    if (oldName === undefined) oldName = header.dataset.group || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-input inline-edit';
    input.value = oldName;
    nameSpan.replaceWith(input);
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>';
    btn.style.color = '';
    input.focus();
    input.select();
    // 保留原始 onclick 字符串（HTML 属性），Esc 时还原——
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
        // 还原原始 onclick（被 startRenameGroup 覆盖的 HTML 属性），
        // 否则下次点击残留的 finish 闭包走完成路径而非重新重命名
        btn.onclick = null;
        if (originalOnClick) btn.setAttribute('onclick', originalOnClick);

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
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
}

// 已配密码的状态控制：dirty=true 表示用户在"已配"状态下点过修改按钮
// 之后才允许 saveSSHEdit 真正写新密码；false 表示保留原 encryptedPassword
let _sshPwdDirty = false;
// Encrypted password carried into a template-created profile: the DPAPI
// ciphertext stays decryptable for the same user, so a copied connection
// keeps its credential without the user retyping it. Reset by openSSHEdit.
let _sshTemplatePwd = '';

function _updatePwdBtnVisibility() {
    const inputEl = document.getElementById('ssh-edit-password');
    const eyeBtn = document.getElementById('ssh-pwd-inline-eye');
    const saveBtn = document.getElementById('ssh-pwd-inline-save');
    const hasText = inputEl && inputEl.value.length > 0;
    // Eye shows whenever the field has text; ✓ only for an existing profile
    // (a new profile is saved with the whole dialog — there is no existing
    // profile to write inline); × is the edit-existing cancel-back path.
    if (eyeBtn) eyeBtn.classList.toggle('show', hasText);
    if (saveBtn) saveBtn.classList.toggle('show', hasText && !!_editingSSHId);
}

function _renderPasswordField(mode) {
    const statusEl = document.getElementById('ssh-pwd-status');
    const inputEl = document.getElementById('ssh-edit-password');
    const saveBtn = document.getElementById('ssh-pwd-inline-save');
    const cancelBtn = document.getElementById('ssh-pwd-inline-cancel');
    const eyeBtn = document.getElementById('ssh-pwd-inline-eye');
    if (mode === 'view') {
        statusEl.style.display = 'flex';
        inputEl.style.display = 'none';
        [saveBtn, cancelBtn, eyeBtn].forEach(b => { if (b) b.classList.remove('show'); });
        if (eyeBtn) { eyeBtn.classList.remove('active'); eyeBtn.title = '显示密码'; }
        inputEl.value = '';
        inputEl.type = 'password';
    } else {
        statusEl.style.display = 'none';
        inputEl.style.display = '';
        inputEl.type = 'password';
        if (eyeBtn) { eyeBtn.classList.remove('active'); eyeBtn.title = '显示密码'; }
        inputEl.value = '';
        inputEl.focus();
        // New profile (no _editingSSHId): the password is saved together with
        // the dialog, so the inline ✓ (saves into an existing profile) and ×
        // (restores the "已加密保存" status row — meaningless for a new
        // profile) both stay hidden; the eye moves to the trailing slot.
        const isNew = !_editingSSHId;
        if (cancelBtn) cancelBtn.classList.toggle('show', !isNew);
        if (eyeBtn) eyeBtn.style.right = isNew ? '8px' : '44px';
        inputEl.style.paddingRight = isNew ? '32px' : '64px';
        // 👁 和 ✓ 根据内容显示（由 input 事件驱动）
        _updatePwdBtnVisibility();
    }
}

function _togglePasswordVisibility() {
    const inputEl = document.getElementById('ssh-edit-password');
    const eyeBtn = document.getElementById('ssh-pwd-inline-eye');
    if (!inputEl || !eyeBtn) return;
    const showing = inputEl.type === 'text';
    // 切换 type 会重置光标位置，先记住原位置再恢复
    const pos = inputEl.selectionStart != null ? inputEl.selectionStart : inputEl.value.length;
    inputEl.type = showing ? 'password' : 'text';
    // 激活态持久高亮（类似 hover 的视觉），提示"显示明文"已开启
    eyeBtn.classList.toggle('active', !showing);
    eyeBtn.title = showing ? '显示密码' : '隐藏密码';
    // 恢复光标（等一帧让 type 切换生效），保持焦点
    inputEl.focus();
    requestAnimationFrame(() => {
        try { inputEl.setSelectionRange(pos, pos); } catch(e) {}
    });
}

function _cancelPasswordEdit() {
    _sshPwdDirty = false;
    _renderPasswordField('view');
    showToast('已取消密码修改');
}

async function _savePasswordInline() {
    const password = document.getElementById('ssh-edit-password').value;
    if (!password || !_editingSSHId) return;
    try {
        const result = await ipcRenderer.invoke('encrypt-password', { plaintext: password });
        if (result.error) {
            showToast('密码加密失败: ' + result.error, true);
            return;
        }
        let profiles = [...(TabManager.sshProfiles || [])];
        const idx = profiles.findIndex(p => p.id === _editingSSHId);
        if (idx >= 0) {
            profiles[idx].encryptedPassword = result.encrypted;
            TabManager.sshProfiles = profiles;
            // persist
            await ipcRenderer.invoke('save-ssh-profiles', { sshProfiles: profiles });
            _sshPwdDirty = false;
            _renderPasswordField('view');
            showToast('密码已保存');
        }
    } catch(e) {
        showToast('密码保存失败: ' + e.message, true);
    }
}

// Open the editor as a NEW connection prefilled from an existing profile
// (issue #5: create-from-template — the user typically only changes the
// host). Reached from the add menu's "从模板新建" picker, never from a row
// action. The encrypted password carries over via the "已保存" status row;
// everything else (group/auth/login scripts/toggles) is copied verbatim.
function openSSHEditFromTemplate(profileId) {
    const src = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    if (!src) return;
    openSSHEdit(true);
    document.getElementById('ssh-edit-title').textContent = '从模板新建 SSH 连接';
    document.getElementById('ssh-edit-name').value = src.name ? src.name + ' 副本' : '';
    document.getElementById('ssh-edit-host').value = src.host || '';
    document.getElementById('ssh-edit-port').value = src.port || '22';
    document.getElementById('ssh-edit-user').value = src.username || '';
    document.getElementById('ssh-edit-note').value = src.note || '';
    document.getElementById('ssh-edit-keypath').value = src.privateKeyPath || '';
    document.getElementById('ssh-edit-group').value = src.group || '';
    document.getElementById('ssh-edit-auth').value = src.authType === 'key' ? '密钥' : '密码';
    document.getElementById('ssh-edit-followcwd').classList.toggle('on', !!src.followCwd);
    document.getElementById('ssh-edit-clearonconnect').classList.toggle('on', src.clearOnConnect !== false);
    updateAuthFields();
    _sshTemplatePwd = src.encryptedPassword || '';
    if (_sshTemplatePwd) {
        _sshPwdDirty = false; // untouched = keep the carried password on save
        _renderPasswordField('view');
    }
    if (src.loginScripts && src.loginScripts.length > 0) {
        src.loginScripts.forEach(s => addLoginScriptRow(s.expect, s.send, s.isRegex, s.optional));
    }
    // The field the user almost always edits next — preselect it (runs after
    // openSSHEdit's own 100ms name focus).
    setTimeout(() => {
        const hostEl = document.getElementById('ssh-edit-host');
        hostEl.focus();
        hostEl.select();
    }, 120);
}

// ── Add-connection menu + template picker (issue #5) ──
// The "添加连接" buttons (settings page + manager overlay, both marked
// data-ssh-add) open a small menu: blank new, or new-from-template. The
// template choice opens a picker overlay that mirrors the session selector's
// chrome and keyboard model but lists only SSH profiles and dispatches to
// openSSHEditFromTemplate.

let _sshAddMenu = null; // { trigger } while the add menu is open

function openSSHAddMenu(trigger) {
    const menu = document.getElementById('ssh-add-menu');
    if (!menu || !trigger) return;
    if (_sshAddMenu && _sshAddMenu.trigger === trigger) { closeSSHAddMenu(true); return; }
    closeSSHAddMenu(false);
    _sshAddMenu = { trigger };
    const tpl = document.getElementById('ssh-add-template');
    // No profiles yet -> nothing can serve as a template.
    const noTemplates = (TabManager.sshProfiles || []).length === 0;
    tpl.classList.toggle('disabled', noTemplates);
    tpl.setAttribute('aria-disabled', String(noTemplates));
    // Right-aligned under the trigger, clamped into the viewport. The
    // .menu-popup base style keeps it measurable while closed (opacity 0).
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - mh - 8)) + 'px';
    menu.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', _sshAddMenuKeys, true);
    // The menu is position:fixed while its trigger lives in scrollable
    // settings content — close on scroll/resize instead of floating detached
    // (the toolbar menu-popup gets this for free from its full-screen
    // backdrop; this menu has none).
    document.addEventListener('scroll', _sshAddMenuDetach, true);
    window.addEventListener('resize', _sshAddMenuDetach);
}

function _sshAddMenuDetach() {
    closeSSHAddMenu(false);
}

function closeSSHAddMenu(restoreFocus) {
    if (!_sshAddMenu) return;
    const trigger = _sshAddMenu.trigger;
    _sshAddMenu = null;
    document.removeEventListener('keydown', _sshAddMenuKeys, true);
    document.removeEventListener('scroll', _sshAddMenuDetach, true);
    window.removeEventListener('resize', _sshAddMenuDetach);
    const menu = document.getElementById('ssh-add-menu');
    if (menu) menu.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
}

function _sshAddMenuKeys(e) {
    const menu = document.getElementById('ssh-add-menu');
    if (!_sshAddMenu || !menu || !menu.classList.contains('open')) {
        document.removeEventListener('keydown', _sshAddMenuKeys, true);
        return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    const items = [...menu.querySelectorAll('.menu-item:not(.disabled)')];
    if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeSSHAddMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (!items.length) return;
        const idx = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
            ? items[(idx + 1) % items.length]
            : items[(idx - 1 + items.length) % items.length];
        next.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && items.includes(document.activeElement)) {
        e.preventDefault(); e.stopPropagation();
        document.activeElement.click();
    } else if (e.key === 'Tab') {
        closeSSHAddMenu(false); // let focus move on naturally
    }
}

// Outside clicks close the menu; clicks on any add trigger re-target or
// toggle it inside openSSHAddMenu, so they are excluded here.
document.addEventListener('click', (e) => {
    if (!_sshAddMenu) return;
    if (e.target.closest('#ssh-add-menu') || e.target.closest('[data-ssh-add]')) return;
    closeSSHAddMenu(false);
}, true);

function sshAddMenuPick(choice) {
    const trigger = _sshAddMenu && _sshAddMenu.trigger;
    closeSSHAddMenu(false);
    if (choice === 'template') {
        if (!(TabManager.sshProfiles || []).length) return; // disabled entry guard
        openSSHTemplatePicker(trigger);
    } else {
        openSSHEdit(true);
    }
}

// Selection tracked by stable item id ('ssh_' + profile id), never by
// filtered DOM index — same discipline as the session selector.
let _sshTpl = null;

function openSSHTemplatePicker(opener) {
    _sshTpl = {
        activeId: null,
        opener: opener && opener.isConnected ? opener : null,
        keysBound: false,
    };
    const search = document.getElementById('ssh-template-search');
    search.value = '';
    _updateSshTemplateClearBtn();
    const items = renderSSHTemplateList('');
    _sshTpl.activeId = items.length ? items[0].id : null;
    _syncSshTemplateSelection(true);
    openOverlay('overlay-ssh-template');
    _bindSshTemplateKeys();
    // Focus only while this exact opening is still live.
    const openToken = _sshTpl;
    setTimeout(() => {
        if (_sshTpl !== openToken) return;
        const s = document.getElementById('ssh-template-search');
        if (s) s.focus();
    }, 100);
}

function _closeSSHTemplatePicker(restoreFocus) {
    _unbindSshTemplateKeys();
    closeOverlay('overlay-ssh-template');
    const opener = _sshTpl ? _sshTpl.opener : null;
    _sshTpl = null;
    if (!restoreFocus) return;
    if (opener && opener.isConnected && opener.getClientRects().length > 0) {
        opener.focus({ preventScroll: true });
    } else if (typeof _refocusActiveTerminal === 'function') {
        _refocusActiveTerminal();
    }
}

function _bindSshTemplateKeys() {
    if (!_sshTpl || _sshTpl.keysBound) return;
    _sshTpl.keysBound = true;
    document.addEventListener('keydown', _sshTemplateKeyHandler, true);
}
function _unbindSshTemplateKeys() {
    if (_sshTpl) _sshTpl.keysBound = false;
    document.removeEventListener('keydown', _sshTemplateKeyHandler, true);
}

function _sshTemplateKeyHandler(e) {
    const overlay = document.getElementById('overlay-ssh-template');
    if (!overlay || !overlay.classList.contains('open')) {
        _unbindSshTemplateKeys(); // closed via an external path: self-clean
        return;
    }
    // IME composition: never select or close; confirming a candidate is not
    // "use this template".
    if (e.isComposing || e.keyCode === 229) return;
    const onButton = e.target && e.target.closest && e.target.closest('button');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        _moveSshTemplateActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
        if (onButton) return; // native buttons (clear/close) run their own action
        e.preventDefault(); e.stopPropagation();
        if (_sshTpl && _sshTpl.activeId) selectSSHTemplate(_sshTpl.activeId);
    } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        _closeSSHTemplatePicker(true);
    } else if (e.key === 'Tab') {
        _trapSshTemplateTab(e);
    }
}

function _moveSshTemplateActive(delta) {
    if (!_sshTpl) return;
    const search = document.getElementById('ssh-template-search');
    const items = getSshTemplateItems(search ? search.value : '');
    if (!items.length) return;
    const idx = items.findIndex(i => i.id === _sshTpl.activeId);
    const next = idx < 0
        ? (delta > 0 ? items[0] : items[items.length - 1])
        : items[(idx + delta + items.length) % items.length];
    _sshTpl.activeId = next.id;
    _syncSshTemplateSelection(true);
}

function _trapSshTemplateTab(e) {
    const panel = document.querySelector('#overlay-ssh-template .panel');
    if (!panel) return;
    const focusables = [...panel.querySelectorAll('input, button')]
        .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!panel.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    }
}

// Delegated row interaction: mousedown must not steal the search field's
// focus; a click picks exactly the clicked row's stable id.
(function bindSshTemplateListDelegation() {
    const wire = () => {
        const list = document.getElementById('ssh-template-list');
        if (!list) return;
        list.addEventListener('mousedown', e => {
            if (e.target.closest('.ss-row')) e.preventDefault();
        });
        list.addEventListener('click', e => {
            const row = e.target.closest('.ss-row');
            if (!row) return;
            const id = row.dataset.id;
            if (id) selectSSHTemplate(id);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();

function selectSSHTemplate(itemId) {
    const profileId = String(itemId).slice(4); // 'ssh_' prefix from buildSessionItems
    _closeSSHTemplatePicker(false);
    openSSHEditFromTemplate(profileId);
}

function getSshTemplateItems(filter) {
    const items = buildSessionItems([], TabManager.sshProfiles || []);
    return filterSessionItems(items, filter);
}

function renderSSHTemplateList(filter) {
    const list = document.getElementById('ssh-template-list');
    const status = document.getElementById('ssh-template-status');
    const items = getSshTemplateItems(filter);
    if (!items.length) {
        list.innerHTML = '<div class="ss-empty" role="presentation"><strong>没有匹配的连接</strong><p>试试名称、地址、用户名或分组。</p></div>';
        if (status) status.textContent = '没有匹配的连接';
        return items;
    }
    list.innerHTML = items.map(_sshTemplateRowHtml).join('');
    if (status) status.textContent = `${items.length} 个可用模板`;
    return items;
}

// Same display algorithm as the SSH manager (ssh-display.js); only the
// selection presentation differs.
function _sshTemplateRowHtml(item) {
    const selected = !!_sshTpl && _sshTpl.activeId === item.id;
    const m = SshDisplay.sshDisplayModel(item.sshProfile);
    const keyBadge = m.keyAuth
        ? `<span class="ss-key" role="img" aria-label="密钥认证" title="密钥认证">${Icons.iconSvg('key', 11)}</span>` : '';
    const primary = `<span class="ss-primary ${m.primaryIsHost ? 'host' : ''}">${escHtml(m.primary)}</span>`;
    const meta = m.named
        ? `<span class="mono">${escHtml(m.endpoint)}</span><span class="dot">·</span><span>${escHtml(m.user)}</span>${keyBadge}`
        : `<span>${escHtml(m.user)}</span><span class="dot">·</span><span>端口 <span class="mono">${escHtml(String(m.port))}</span></span>${keyBadge}`;
    const titleText = m.named ? `${m.primary} — ${m.endpoint} · ${m.user}` : `${m.primary} — ${m.user} · 端口 ${m.port}`;
    const group = item.badge || '';
    return `<div class="ss-row" role="option" id="ssh-tpl-opt-${escAttr(item.id)}" aria-selected="${selected}" data-id="${escAttr(item.id)}" title="${escAttr(titleText)}">
      <span class="ss-row-icon" aria-hidden="true">${Icons.iconSvg('server', 19)}</span>
      <span class="ss-identity">${primary}<span class="ss-meta">${meta}</span></span>
      ${group ? `<span class="ss-group-name">${escHtml(group)}</span>` : ''}
      <span class="ss-open" aria-hidden="true">${Icons.iconSvg('enter-arrow', 15)}</span>
    </div>`;
}

function _syncSshTemplateSelection(scroll) {
    const list = document.getElementById('ssh-template-list');
    const search = document.getElementById('ssh-template-search');
    const activeId = _sshTpl ? _sshTpl.activeId : null;
    let activeEl = null;
    list.querySelectorAll('.ss-row').forEach(row => {
        const on = !!activeId && row.dataset.id === activeId;
        row.setAttribute('aria-selected', String(on));
        if (on) activeEl = row;
    });
    if (search) {
        if (activeEl) search.setAttribute('aria-activedescendant', activeEl.id);
        else search.removeAttribute('aria-activedescendant');
    }
    if (activeEl && scroll) activeEl.scrollIntoView({ block: 'nearest' });
}

function filterSSHTemplates(query) {
    const items = renderSSHTemplateList(query || '');
    _updateSshTemplateClearBtn();
    if (!_sshTpl) return;
    if (!(_sshTpl.activeId && items.some(i => i.id === _sshTpl.activeId))) {
        _sshTpl.activeId = items.length ? items[0].id : null;
    }
    _syncSshTemplateSelection(true);
}

function _updateSshTemplateClearBtn() {
    const search = document.getElementById('ssh-template-search');
    const clear = document.getElementById('ssh-template-clear');
    if (clear && search) clear.hidden = !search.value;
}

function clearSSHTemplateSearch() {
    const search = document.getElementById('ssh-template-search');
    if (!search) return;
    search.value = '';
    filterSSHTemplates('');
    search.focus();
}

function openSSHEdit(isNew, profileId) {
    _editingSSHId = isNew ? null : profileId;
    _sshTemplatePwd = '';
    document.getElementById('ssh-edit-title').textContent = isNew ? '添加 SSH 连接' : '编辑 SSH 连接';

    // Remove old custom dropdown wrappers
    document.querySelectorAll('#overlay-ssh-edit .cust-dropdown').forEach(d => d.remove());

    // Reset form
    document.getElementById('ssh-edit-name').value = '';
    document.getElementById('ssh-edit-host').value = '';
    document.getElementById('ssh-edit-port').value = '22';
    document.getElementById('ssh-edit-user').value = '';
    _sshPwdDirty = true; // 新建场景默认 true：用户输入即视为新密码要保存
    _renderPasswordField('edit'); // 默认显示输入框（新建场景）
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

    // 密码字段：每次 openSSHEdit 重绑（避免被覆盖）
    const pwdEditBtn = document.getElementById('ssh-pwd-edit-btn');
    if (pwdEditBtn) pwdEditBtn.onclick = () => { _sshPwdDirty = true; _renderPasswordField('edit'); };
    const pwdInput = document.getElementById('ssh-edit-password');
    if (pwdInput) {
        pwdInput.oninput = () => _updatePwdBtnVisibility();
        pwdInput.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (!_editingSSHId) {
                    // New profile: nothing to cancel back to. The global Esc
                    // handler skips inline-edit inputs, so close the dialog
                    // here — same as Esc on the name/host/user fields.
                    closeAllOverlays();
                    const tab = TabManager.getActive();
                    if (tab && tab.term) setTimeout(() => tab.term.focus(), 50);
                    return;
                }
                _sshPwdDirty = false;
                _renderPasswordField('view');
                showToast('已取消密码修改');
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (_editingSSHId) {
                    if (document.getElementById('ssh-pwd-inline-save').classList.contains('show')) {
                        _savePasswordInline();
                    }
                } else {
                    // New profile: Enter saves the whole dialog (the password
                    // is read from the input by saveSSHEdit).
                    saveSSHEdit();
                }
            }
        };
        pwdInput.onblur = () => {
            // Only the edit-existing flow cancels back to the status row on
            // blur. For a new profile the typed password must survive until
            // the dialog saves — discarding it here silently saved the
            // profile without a password.
            if (_editingSSHId && _sshPwdDirty) {
                _sshPwdDirty = false;
                _renderPasswordField('view');
                showToast('已取消密码修改');
            }
        };
    }
    // 保存按钮 mousedown 阻止 input 失焦：避免 blur handler 在保存读取 input.value 之前
    // 把它还原成 view 模式（清空 value + 切回状态行），导致保存丢失密码。
    // mousedown 时机早于 blur（mousedown → button focus → input blur），用 preventDefault 阻止默认
    // 焦点切换，input 保持 focus，保存能正常读 value；保存成功后 closeSSHEdit 关面板即可。
    const saveBtn = document.querySelector('#overlay-ssh-edit button.btn-primary');
    if (saveBtn) {
        saveBtn.addEventListener('mousedown', (e) => {
            if (document.activeElement && document.activeElement.id === 'ssh-edit-password') {
                e.preventDefault();
            }
        });
    }
    // 内联保存/取消按钮同样阻止 blur 抢跑
    const inlineSave = document.getElementById('ssh-pwd-inline-save');
    const inlineCancel = document.getElementById('ssh-pwd-inline-cancel');
    const inlineEye = document.getElementById('ssh-pwd-inline-eye');
    [inlineSave, inlineCancel, inlineEye].forEach(btn => {
        if (btn) btn.addEventListener('mousedown', (e) => e.preventDefault());
    });

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
            // 已配密码：显示状态行（🔒 密码已加密保存 + 修改按钮），隐藏输入框
            // _renderPasswordField 必须在 updateAuthFields 之后调用——它操作的就是 updateAuthFields 控制的密码行
            if (p.encryptedPassword) {
                _renderPasswordField('view');
                _sshPwdDirty = false; // 已配密码且用户未点修改 = 不视为修改，保留原密码
            }
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
            // filter is user input: escape it now that the row is HTML, not plain text
            div.innerHTML = Icons.iconSvg('plus', 11) + ' 创建分组 "' + escHtml(filter) + '"';
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
        '<button class="ls-del" onclick="deleteLoginScriptRow(this)">' + Icons.iconSvg('x', 12) + '</button>';
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

async function saveSSHEdit() {
    const name = document.getElementById('ssh-edit-name').value.trim();
    const host = document.getElementById('ssh-edit-host').value.trim();
    const port = parseInt(document.getElementById('ssh-edit-port').value) || 22;
    const username = document.getElementById('ssh-edit-user').value.trim();
    // 密码：仅当用户点过"修改"按钮（_sshPwdDirty=true）才读 input 值；
    // 已配状态下未点修改 = 保留原密码；点过修改但清空 input = 保留原密码（清空=不删）
    const password = _sshPwdDirty ? document.getElementById('ssh-edit-password').value : '';
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

    const doSave = async (encryptedPassword) => {
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
        await ipcRenderer.invoke('save-ssh-profiles', { sshProfiles: profiles });
        renderSSHManager();
        closeSSHEdit();
        showToast('SSH 连接已保存');
    };

    if (authType === 'password' && password) {
        try {
            const result = await ipcRenderer.invoke('encrypt-password', { plaintext: password });
            if (result.error) {
                showToast('密码加密失败: ' + result.error, true);
                return;
            }
            await doSave(result.encrypted);
        } catch(e) {
            showToast('密码加密失败', true);
        }
    } else {
        // No new password typed: editing keeps the profile's own ciphertext;
        // a template-created profile keeps the template's carried ciphertext.
        await doSave(_editingSSHId ? (TabManager.sshProfiles.find(p => p.id === _editingSSHId) || {}).encryptedPassword || '' : _sshTemplatePwd || '');
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
