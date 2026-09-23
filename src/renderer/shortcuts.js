// ZTerm - 快捷键注册表 + 调度 + 自定义 UI + 数据目录/关于页（纯逻辑见 shortcut-utils.js，由 renderer.html 先加载）
// ── Keyboard shortcuts ──
// Capture-phase handler for keys that terminal would otherwise eat
// ── Keyboard shortcuts ──
// 必须在 capture 阶段拦截：xterm 会把 F2/Ctrl+W/Ctrl+Tab 等键处理成转义序列
// 并 stopPropagation，冒泡阶段的监听在终端聚焦时永远收不到。
function _comboFromEvent(e) {
    return comboFromEvent(e);
}

// 默认快捷键绑定（用户自定义覆盖见 _settingsConfig.shortcuts）
const DEFAULT_SHORTCUTS = {
    newTab: 'Ctrl+Shift+N',
    sshPanel: 'Ctrl+Shift+S',
    openSettings: 'Ctrl+,',
    closeTab: 'Ctrl+W',
    closePane: 'Ctrl+Shift+W',
    nextTab: 'Ctrl+Tab',
    prevTab: 'Ctrl+Shift+Tab',
    renameTab: 'F2',
    splitH: 'Ctrl+Shift+H',
    splitV: 'Ctrl+Shift+V',
    maximizePane: 'Ctrl+Shift+ArrowUp',
    extractPane: 'Ctrl+Shift+X',
    nextPane: 'Ctrl+Shift+ArrowRight',
    prevPane: 'Ctrl+Shift+ArrowLeft',
    syncInput: 'Ctrl+Shift+I',
    search: 'Ctrl+F',
    sftp: 'Ctrl+Shift+F',
    quickCommands: 'Ctrl+Shift+P',
    commandPalette: 'Ctrl+P',
    cloneTab: 'Ctrl+Shift+T',
    'toggle-statusbar': 'Ctrl+Shift+B',
    perfCapture: 'Ctrl+Shift+D',
};

function _getShortcutBindings() {
    return mergeShortcutBindings(DEFAULT_SHORTCUTS, _settingsConfig.shortcuts);
}

function _cycleTab(delta) {
    // Cycle among ALIVE tabs only — a rapid-close burst can leave dying tabs
    // in the array for their staggered removal window; landing on one would
    // strand activeId on a removed tab. Follow the bar's VISUAL order
    // (orderedTabs): the raw array can hold the settings tab mid-list, which
    // made cycling jump in a different order than the bar shows (issue #7).
    const alive = TabManager.orderedTabs().filter(t => !TabManager._closingTabs.has(t.id));
    const idx = alive.findIndex(t => t.id === TabManager.activeId);
    if (idx === -1 || alive.length < 2) return;
    const next = alive[(idx + delta + alive.length) % alive.length];
    TabManager.switchTo(next.id);
}

const SHORTCUT_ACTIONS = {
    newTab: () => openSessionSelector(),
    sshPanel: () => openSSHManager(),
    quickCommands: () => openQC(),
    openSettings: () => openSettings(),
    closeTab: () => {
        const tab = TabManager.getActive();
        if (!tab || tab.type === 'settings') return;
        if (TabManager.aliveCount() <= 1) {
            // 至少保留一个标签页（ZTerm 不能全空）；用存活数而非 tabs.length，
            // 快速连按时已有关闭中的 tab 还没 splice，长度守卫会被穿透
            showToast('至少保留一个标签页');
            return;
        }
        if (!document.querySelector('.overlay.open')) TabManager.closeTab(tab.id);
    },
    closePane: () => {
        const tab = TabManager.getActive();
        if (!tab || tab.type === 'settings') return;
        if (tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._closePane(tab.id, focused.id);
        } else if (!document.querySelector('.overlay.open') && TabManager.aliveCount() > 1) {
            // 不在分屏（单 terminal 或刚从分屏退出只剩 1 个 pane 后）：等同 Ctrl+W 关闭当前 tab
            // 与 tabby 行为一致（存活数守卫防止连按穿透保留最后一个 tab 的约束）
            TabManager.closeTab(tab.id);
        }
    },
    nextTab: () => { if (!document.querySelector('.overlay.open')) _cycleTab(1); },
    prevTab: () => { if (!document.querySelector('.overlay.open')) _cycleTab(-1); },
    renameTab: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) {
            TabManager.startRenameTab(tab.id);
        }
    },
    splitH: () => { if (!document.querySelector('.overlay.open')) TabManager.splitHorizontal(); },
    splitV: () => { if (!document.querySelector('.overlay.open')) TabManager.splitVertical(); },
    syncInput: () => {
        // 分屏同步输入开关（Tabby 同款）：开启后输入广播到当前 tab 的所有 pane
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        tab.syncInput = !tab.syncInput;
        const rootEl = document.getElementById('split_' + tab.id);
        if (rootEl) rootEl.classList.toggle('sync-input', tab.syncInput);
        showToast(tab.syncInput ? '同步输入已开启（输入广播到所有窗格）' : '同步输入已关闭');
    },
    maximizePane: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._maximizePane(tab.id, focused.id);
        }
    },
    extractPane: () => {
        // 提取当前聚焦 pane 为独立 tab（无分屏时无操作）
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.splitRoot) {
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused) TabManager._extractPaneToTab(tab.id, focused.id);
        }
    },
    nextPane: () => {
        // 分屏内循环聚焦下一个 pane（getAllPanes 深度优先 = 视觉左→右、上→下）
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        const panes = getAllPanes(tab);
        if (panes.length < 2) return;
        const cur = panes.findIndex(p => p.focused);
        const next = panes[(cur + 1) % panes.length];
        TabManager._focusPane(tab, next.id);
    },
    prevPane: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (!tab || !tab.splitRoot) return;
        const panes = getAllPanes(tab);
        if (panes.length < 2) return;
        const cur = panes.findIndex(p => p.focused);
        const prev = panes[(cur - 1 + panes.length) % panes.length];
        TabManager._focusPane(tab, prev.id);
    },
    search: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) openSearch();
    },
    sftp: () => {
        if (document.querySelector('.overlay.open')) return;
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings') {
            const panes = tab.splitRoot ? getAllPanes(tab) : [];
            const target = panes.find(p => p.focused) || panes[0] || tab;
            if (target.type === 'ssh' && target.tabId) {
                if (SFTP.isOpen && SFTP._tabId === target.tabId) SFTP.close();
                else SFTP.open(target.tabId);
            }
        }
    },
    commandPalette: () => {
        const palette = document.getElementById('overlay-palette');
        if (palette && palette.classList.contains('open')) {
            closePalette();  // toggle：面板已开 → 关闭
            return;
        }
        if (document.querySelector('.overlay.open')) return;  // 其他 overlay 打开时不响应
        openPalette();
    },
    cloneTab: () => {
        const tab = TabManager.getActive();
        if (tab && tab.type !== 'settings' && !document.querySelector('.overlay.open')) {
            TabManager.cloneTab(tab.id);
        }
    },
    'toggle-statusbar': () => {
        // Show/hide bottom status bar; feedback toast names the CURRENT binding
        // (the user may have customized the combo).
        const on = toggleStatusbar();
        const combo = _comboDisplay(_getShortcutBindings()['toggle-statusbar'] || 'Ctrl+Shift+B');
        showToast(on ? '状态栏已显示' : `状态栏已隐藏（${combo} 恢复）`);
    },
    perfCapture: () => {
        // Metadata only. rAF callback gaps measure scheduling, not presented FPS.
        if (window.__perfCapturing) { showToast('采样已在进行中', true); return; }
        window.__perfCapturing = true;
        const diagnostics = globalThis.ZTermDiagnostics;
        let ownedSession = null, tl = null, deadline = null, frame = null;
        let ltObs = null, etObs = null, finished = false;
        const cleanup = () => {
            clearInterval(tl);
            clearTimeout(deadline);
            if (frame !== null) cancelAnimationFrame(frame);
            try { ltObs && ltObs.disconnect(); } catch (e) {}
            try { etObs && etObs.disconnect(); } catch (e) {}
            if (ownedSession !== null && diagnostics.sessionId === ownedSession) diagnostics.stop('perf-complete');
            window.__perfCapturing = false;
        };
        const snapshot = a => {
            try { return a && a.snapshot ? a.snapshot() : null; }
            catch (e) { return null; }
        };
        try {
        if (diagnostics && !diagnostics.enabled) {
            diagnostics.start({ durationMs: 4000 });
            ownedSession = diagnostics.sessionId;
        }
        showToast('性能采样中（4 秒）—— 打字 / 划动鼠标 / 或保持待测状态');
        const t0 = performance.now();
        const raf = [];
        const loop = (t) => { if (finished) return; raf.push(t); if (t - t0 < 4000) frame = requestAnimationFrame(loop); else finish(); };
        const tab = TabManager.getActive();
        const adapter = tab && tab._smoothCursor && tab._smoothCursor._adapter;
        // stability counters: stream volume per backend tabId + every tab's
        // adapter counters (hidden tabs included — are they drawing too?)
        globalThis.__ztStreamBytes = {};
        const adaptersBefore = TabManager.tabs.map(t => {
            const a = t._smoothCursor && t._smoothCursor._adapter;
            const s = snapshot(a)?.counters;
            return { id: t.id, visible: t.id === TabManager.activeId,
                cursorDrawPasses: s ? s.cursorDrawPasses : null, baseDrawPasses: s ? s.baseDrawPasses : null };
        });
        // long tasks + slow input handlers during the window
        const longTasks = [];
        const slowEvents = [];
        try {
            ltObs = new PerformanceObserver(list => {
                for (const e of list.getEntries()) {
                    if (longTasks.length < 20) longTasks.push({ dur: Math.round(e.duration) });
                }
            });
            ltObs.observe({ entryTypes: ['longtask'] });
        } catch (e) {}
        try {
            etObs = new PerformanceObserver(list => {
                for (const e of list.getEntries()) if (e.duration > 50 && slowEvents.length < 20) slowEvents.push({ type: e.name, dur: Math.round(e.duration) });
            });
            etObs.observe({ type: 'event', buffered: false, durationThreshold: 50 });
        } catch (e) {}
        const before = snapshot(adapter)?.counters;
        const caretMetadata = s => {
            const c = s?.caretOwnership;
            const o = tab?._inkObserver?.state?.();
            const reason = value => [
                'cell-overwritten', 'candidate-cell-mismatch', 'out-of-range', 'buffer-switch',
                'invalidate:scroll', 'invalidate:resize', 'invalidate:session-reset',
                'invalidate:observer:resize', 'invalidate:observer:unmodeled-coordinate-change',
                'unmodeled-coordinate-change', 'resize', 'stale-watermark', 'open-lexical-unit',
                'unsupported-parser-state', 'non-default-style', 'invalid-geometry',
            ].includes(value) ? value : null;
            const number = value => Number.isFinite(value) ? value : null;
            return {
                customDrawSource: ['none', 'software', 'protocol'].includes(c?.customDrawSource) ? c.customDrawSource : null,
                active: typeof c?.active === 'boolean' ? c.active : null,
                queued: number(c?.queued), parsed: number(c?.parsed), generation: number(c?.generation), trustRun: number(c?.trustRun),
                reason: reason(c?.reason), positionKnown: typeof o?.positionKnown === 'boolean' ? o.positionKnown : null,
                positionReason: reason(o?.positionReason), checkpointReason: reason(o?.checkpointReason), recoveries: number(o?.recoveries),
            };
        };
        // drawable/hidden timeline: the missing observable — 100ms samples of
        // the adapter status reveal idle-hide cycles (ink TUIs hide the caret
        // ~1s after the last keystroke) vs continuous animation.
        const timeline = [];
        tl = setInterval(() => {
            // Mid-capture tab close disposes the adapter/term — every tick
            // would throw into the console for the rest of the window.
            try {
                const s = snapshot(adapter);
                // WHY the cursor is (not) drawable — via the PUBLIC buffer API:
                // term._core.buffer has no '.active' (that path threw every 100ms
                // and silently emptied this timeline in the field).
                const core = tab && tab.term ? tab.term._core : null;
                const buf = tab && tab.term ? tab.term.buffer : null;
                const flags = {
                    hidden: core && core.coreService ? core.coreService.isCursorHidden : null,
                    initialized: core && core.coreService ? core.coreService.isCursorInitialized : null,
                    cx: buf && buf.active ? buf.active.cursorX : null,
                    cy: buf && buf.active ? buf.active.cursorY : null,
                };
                timeline.push({ t: Math.round(performance.now() - t0), st: s ? s.drawPassStatus : '-', anim: s ? s.animationActive : null, flags, caret: caretMetadata(s) });
            } catch (e) { /* disposed mid-capture */ }
        }, 100);
        deadline = setTimeout(finish, 4000);
        frame = requestAnimationFrame(loop);
        function finish() {
            if (finished) return;
            finished = true;
            cleanup();
            try {
            const gaps = [];
            for (let i = 1; i < raf.length; i++) gaps.push(+(raf[i] - raf[i - 1]).toFixed(1));
            gaps.sort((a, b) => a - b);
            const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null);
            const after = snapshot(adapter);
            const adaptersAfter = TabManager.tabs.map(t => {
                const a = t._smoothCursor && t._smoothCursor._adapter;
                const s = snapshot(a)?.counters;
                return { id: t.id, visible: t.id === TabManager.activeId,
                    cursorDrawPasses: s ? s.cursorDrawPasses : null, baseDrawPasses: s ? s.baseDrawPasses : null };
            });
            const adaptersDelta = adaptersAfter.map(a => {
                const b = adaptersBefore.find(x => x.id === a.id) || {};
                return { id: a.id, visible: a.visible,
                    cursorDrawPasses: (a.cursorDrawPasses != null && b.cursorDrawPasses != null) ? a.cursorDrawPasses - b.cursorDrawPasses : null,
                    baseDrawPasses: (a.baseDrawPasses != null && b.baseDrawPasses != null) ? a.baseDrawPasses - b.baseDrawPasses : null };
            });
            // Opt-in capture only: no terminal text, commands or session names.
            let glyphs = null;
            try {
                const active = TabManager.getActive();
                const panes = active?.splitRoot ? getAllPanes(active) : active ? [active] : [];
                glyphs = { scope: 'active-tab-at-capture-end',
                    panes: panes.slice(0, 8).map(p => globalThis.__glyphDiagnostics?.snapshot(p.term) ?? null),
                    truncatedPanes: panes.length > 8 };
            } catch { glyphs = { unavailable: true }; }
            const report = {
                at: new Date().toISOString(),
                interaction: diagnostics ? diagnostics.snapshot() : null,
                durationMs: +(performance.now() - t0).toFixed(0),
                display: { dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight },
                glyphs,
                raf: { measurement: 'callback-gap-ms-not-presented-fps', count: raf.length, p50: q(0.5), p95: q(0.95), max: gaps[gaps.length - 1] || null },
                stability: {
                    longTasks: longTasks.slice(0, 20),
                    slowEvents: slowEvents.slice(0, 20),
                    streamBytesByTabId: globalThis.__ztStreamBytes || {},
                    adaptersDelta,
                    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
                    tabCount: TabManager.tabs.length,
                },
                cursor: after ? {
                    countersDelta: before ? {
                        cursorDrawPasses: after.counters.cursorDrawPasses - before.cursorDrawPasses,
                        baseDrawPasses: after.counters.baseDrawPasses - before.baseDrawPasses,
                    } : null,
                    recentDrawGapMs: after.recentDrawGapMs,
                    // only retargets INSIDE the sample window (clock values >= t0)
                    retargets: after.retargets.filter(r => r.at >= t0 - 50).slice(-40).map(r => ({ dt: Math.round(r.at - t0), from: (+r.from.x.toFixed(2)) + ',' + (+r.from.y.toFixed(2)), to: r.target.x + ',' + r.target.y })),
                    drawPassStatus: after.drawPassStatus,
                    caret: caretMetadata(after),
                    tabType: tab ? tab.type : null,
                    timeline,
                } : 'no-adapter',
            };
            const text = JSON.stringify(report);
            navigator.clipboard.writeText(text).then(
                () => showToast('采样完成：数据已复制到剪贴板，直接粘贴给开发者'),
                () => showToast('采样完成（剪贴板写入失败，见控制台）', true),
            );
            console.log('[perf-sample]', text);
            } catch (e) { showToast('采样未能生成报告', true); }
        }
        } catch (e) {
            finished = true;
            cleanup();
            showToast('采样未能启动', true);
        }
    },
};

// ── Shortcut customization (settings page) ──
const SHORTCUT_LABELS = {
    newTab: '新建标签页',
    sshPanel: 'SSH 连接面板',
    openSettings: '打开设置',
    closeTab: '关闭标签页',
    closePane: '关闭聚焦窗格',
    nextTab: '下一个标签页',
    prevTab: '上一个标签页',
    renameTab: '重命名标签页',
    splitH: '左右分屏',
    splitV: '上下分屏',
    maximizePane: '窗格最大化/恢复',
    extractPane: '提取窗格为标签页',
    nextPane: '聚焦下一个窗格',
    prevPane: '聚焦上一个窗格',
    syncInput: '同步输入到所有窗格',
    search: '终端搜索',
    sftp: 'SFTP 文件面板',
    quickCommands: '快捷命令',
    commandPalette: '命令面板',
    cloneTab: '克隆标签页',
    'toggle-statusbar': '显示/隐藏状态栏',
    perfCapture: '性能采样（4秒，复制到剪贴板）',
};

function _comboDisplay(combo) {
    return comboDisplay(combo);
}

let _shortcutCapture = null;

function renderShortcutsList() {
    const table = document.getElementById('shortcuts-table');
    if (!table) return;
    const bindings = _getShortcutBindings();
    const overrides = _settingsConfig.shortcuts || {};
    let html = '<tr><th>操作</th><th>快捷键</th><th style="width:110px"></th></tr>';
    Object.keys(SHORTCUT_LABELS).forEach(id => {
        const combo = bindings[id] || '';
        const overridden = overrides[id] !== undefined;
        html += `<tr><td>${SHORTCUT_LABELS[id]}</td><td><kbd>${escHtml(_comboDisplay(combo))}</kbd></td>`
            + `<td style="white-space:nowrap;text-align:right">`
            + `<button class="btn-outline shortcut-edit-btn" onclick="startShortcutCapture('${id}',this)">修改</button>`
            + (overridden ? `<button class="btn-outline shortcut-reset-btn" title="恢复默认（${escHtml(_comboDisplay(DEFAULT_SHORTCUTS[id]))}）" onclick="resetShortcut('${id}')">${Icons.iconSvg('rotate-ccw', 11)}</button>` : '')
            + `</td></tr>`;
    });
    html += `<tr><td>关闭面板 / 退出最大化 / 关闭搜索</td><td><kbd>Esc</kbd></td><td></td></tr>`;
    table.innerHTML = html;
}

function startShortcutCapture(actionId, btn) {
    if (_shortcutCapture) return;
    _shortcutCapture = { actionId };
    btn.textContent = '按下快捷键…';
    btn.classList.add('capturing');
    const onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { finish(null); return; }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // 等待非修饰键
        finish(_comboFromEvent(e));
    };
    const finish = (combo) => {
        document.removeEventListener('keydown', onKey, true);
        _shortcutCapture = null;
        if (combo) {
            const keyPart = combo.split('+').pop();
            const ok = combo.includes('Ctrl+') || combo.includes('Alt+') || /^F\d{1,2}$/.test(keyPart);
            const bindings = _getShortcutBindings();
            const conflict = ok && Object.keys(bindings).find(id => id !== actionId && bindings[id] === combo);
            if (!ok) showToast('普通按键不能单独作为快捷键（需含 Ctrl/Alt，或使用 F1-F12）');
            else if (conflict) showToast('快捷键已被「' + SHORTCUT_LABELS[conflict] + '」占用');
            else {
                if (!_settingsConfig.shortcuts) _settingsConfig.shortcuts = {};
                if (combo === DEFAULT_SHORTCUTS[actionId]) delete _settingsConfig.shortcuts[actionId];
                else _settingsConfig.shortcuts[actionId] = combo;
                persistShortcuts();
            }
        }
        renderShortcutsList();
        // 顶栏菜单的快捷键提示要立即跟随用户最新绑定
        if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
    };
    document.addEventListener('keydown', onKey, true);
}

function resetShortcut(actionId) {
    if (_settingsConfig.shortcuts) delete _settingsConfig.shortcuts[actionId];
    persistShortcuts();
    renderShortcutsList();
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
}

function resetAllShortcuts() {
    _settingsConfig.shortcuts = {};
    persistShortcuts();
    renderShortcutsList();
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
}

function persistShortcuts() {
    ipcRenderer.send('save-shortcuts', _settingsConfig.shortcuts || {});
}

// ── Data directory (settings → 关于) ──
async function loadDataDirInfo() {
    const el = document.getElementById('data-dir-path');
    if (!el) return;
    const info = await ipcRenderer.invoke('get-data-dir-info');
    if (!info) return;
    el.textContent = info.current + (info.isCustom ? '（自定义）' : '（默认）');
    document.getElementById('data-dir-reset').style.display = info.isCustom ? '' : 'none';
}

// ── About info（主进程动态读取版本号）──
async function loadAboutInfo() {
    try {
        const info = await ipcRenderer.invoke('get-about-info');
        if (!info) return;
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('about-ver', '版本 ' + (info.version || '?'));
        set('about-fw', 'Electron ' + (info.electron || '?'));
        set('about-engine', 'xterm.js ' + (info.xterm || '?') + ' + node-pty');
        set('about-ssh', 'russh ' + (info.russh || '?'));
    } catch(e) {}
    // Reset the update card each time the about page opens: no stale result.
    _stopUpdatePoll();
    const desc = document.getElementById('update-check-desc');
    if (desc) { desc.textContent = '从 GitHub Releases 检查新版本'; desc.style.color = ''; }
    const dl = document.getElementById('btn-update-download');
    if (dl) { dl.style.display = 'none'; dl.disabled = false; dl.textContent = '下载更新'; }
    const apply = document.getElementById('btn-update-apply');
    if (apply) apply.style.display = 'none';
    const notes = document.getElementById('update-release-notes');
    if (notes) notes.style.display = 'none';
    const check = document.getElementById('btn-check-update');
    if (check) { check.disabled = false; check.textContent = '检查更新'; }
    window.__updateUrl = null;
    window.__updateTag = null;
    // A download started on an earlier visit may still run (or be done) in
    // the main process; sync the card from its state instead of staying idle.
    _syncUpdateCardFromState();
}

// ── In-app update download (about page state machine) ──
let _updatePollTimer = null;
// Toast at most once per downloaded tag (poll path and invoke-return path
// both reach the ready state).
let _updateToastTag = null;

function _stopUpdatePoll() {
    if (_updatePollTimer) { clearInterval(_updatePollTimer); _updatePollTimer = null; }
}

function _setUpdateDesc(text, color) {
    const desc = document.getElementById('update-check-desc');
    if (desc) { desc.textContent = text; desc.style.color = color || ''; }
}

function _toastUpdateReadyOnce(tag) {
    if (_updateToastTag === tag) return;
    _updateToastTag = tag;
    showToast('更新已下载完成，可在关于页安装');
}

function _renderUpdateDownloading(st) {
    const dl = document.getElementById('btn-update-download');
    const apply = document.getElementById('btn-update-apply');
    const check = document.getElementById('btn-check-update');
    if (apply) apply.style.display = 'none';
    if (check) check.disabled = true;
    if (dl) {
        dl.style.display = '';
        dl.disabled = true;
        let pct = '';
        if (st.total > 0) pct = ' ' + Math.floor(st.downloaded * 100 / st.total) + '%';
        else if (st.downloaded > 0) pct = ' ' + (st.downloaded / 1048576).toFixed(1) + 'MB';
        dl.textContent = '下载中' + pct;
    }
    _setUpdateDesc('正在下载 ' + (st.tag || '') + ' 安装包…');
}

function _renderUpdateReady(tag) {
    const dl = document.getElementById('btn-update-download');
    const apply = document.getElementById('btn-update-apply');
    const check = document.getElementById('btn-check-update');
    if (dl) dl.style.display = 'none';
    if (check) { check.disabled = false; check.textContent = '检查更新'; }
    if (apply) { apply.style.display = ''; apply.disabled = false; apply.textContent = '重启并安装 ' + (tag || ''); }
    _setUpdateDesc((tag || '新版本') + ' 已下载完成，随时可安装', 'rgba(120,200,120,0.9)');
}

// Map the backend's stable error tag ([timeout]/[resolve]/[connect]/[http])
// to friendly guidance; unknown errors pass through with their raw detail so
// diagnosis stays possible. The tag is classified from typed ureq errors in
// Rust, so it does not depend on ureq's display wording.
function _friendlyUpdateError(raw) {
    const s = (raw && raw !== '未知错误') ? String(raw) : '';
    if (s.includes('invalid update proxy')) return '更新代理地址无效（仅支持 http/https 代理），请在 设置 → 关于 中修正。详细信息：' + s;
    const m = /\[(\w+)\]/.exec(s);
    const tag = m && m[1];
    let msg = '';
    if (tag === 'timeout') msg = '网络超时，无法连接更新服务器（请检查网络或代理设置）';
    else if (tag === 'resolve') msg = '无法解析更新服务器域名（请检查网络或 DNS 设置）';
    else if (tag === 'connect') msg = '无法连接更新服务器（请检查网络或代理设置）';
    else if (tag === 'http') msg = '更新服务器返回错误';
    if (!msg) return s || '未知错误';
    return msg + '。详细信息：' + s;
}

function _renderUpdateFailed(err) {
    const dl = document.getElementById('btn-update-download');
    const apply = document.getElementById('btn-update-apply');
    const check = document.getElementById('btn-check-update');
    if (apply) apply.style.display = 'none';
    if (check) { check.disabled = false; check.textContent = '检查更新'; }
    if (dl) { dl.style.display = ''; dl.disabled = false; dl.textContent = '重试下载'; }
    _setUpdateDesc('下载失败：' + _friendlyUpdateError(err), 'rgba(220,120,120,0.9)');
}

function _startUpdatePoll() {
    _stopUpdatePoll();
    _updatePollTimer = setInterval(async () => {
        // Stop when the about page is hidden; the main-process download
        // continues and is re-synced on the next visit.
        const desc = document.getElementById('update-check-desc');
        if (!desc || desc.offsetParent === null) { _stopUpdatePoll(); return; }
        try {
            const st = await ipcRenderer.invoke('update-download-state');
            if (!st) return;
            if (st.phase === 'downloading') {
                _renderUpdateDownloading(st);
            } else if (st.phase === 'ready') {
                _stopUpdatePoll();
                _renderUpdateReady(st.tag);
                _toastUpdateReadyOnce(st.tag);
            } else if (st.phase === 'failed') {
                _stopUpdatePoll();
                _renderUpdateFailed(st.error);
            }
        } catch(e) {}
    }, 500);
}

async function _syncUpdateCardFromState() {
    try {
        const st = await ipcRenderer.invoke('update-download-state');
        if (!st || !st.phase) return;
        if (st.phase === 'downloading') {
            _renderUpdateDownloading(st);
            _startUpdatePoll();
        } else if (st.phase === 'ready') {
            _renderUpdateReady(st.tag);
        } else if (st.phase === 'failed') {
            _renderUpdateFailed(st.error);
        }
    } catch(e) {}
}

// Update check (about page): check -> download -> ready -> restart & install.
async function checkForUpdates() {
    const btn = document.getElementById('btn-check-update');
    const desc = document.getElementById('update-check-desc');
    const dl = document.getElementById('btn-update-download');
    const apply = document.getElementById('btn-update-apply');
    const notes = document.getElementById('update-release-notes');
    if (!btn || !desc) return;
    btn.disabled = true;
    btn.textContent = '检查中…';
    desc.style.color = '';
    try {
        const r = await ipcRenderer.invoke('check-update');
        if (r && r.none) {
            desc.textContent = '官方还没有发布版本';
        } else if (r && r.newer) {
            window.__updateUrl = r.url;
            window.__updateTag = r.tag;
            if (notes) notes.style.display = '';
            if (r.ready) {
                // Verified installer already on disk from an earlier
                // download (survives restarts): skip straight to apply.
                _renderUpdateReady(r.tag);
            } else {
                desc.textContent = `发现新版本 ${r.latest}（当前 ${r.current}）`;
                desc.style.color = 'rgba(120,200,120,0.9)';
                if (apply) apply.style.display = 'none';
                if (dl) { dl.style.display = ''; dl.disabled = false; dl.textContent = '下载更新'; }
            }
        } else if (r) {
            desc.textContent = `已是最新版本 (${r.current})`;
            if (dl) dl.style.display = 'none';
            if (apply) apply.style.display = 'none';
            if (notes) notes.style.display = 'none';
            window.__updateUrl = null;
            window.__updateTag = null;
        } else {
            desc.textContent = '检查失败：空响应';
        }
    } catch (e) {
        desc.textContent = '检查失败：' + _friendlyUpdateError(e && e.message ? e.message : String(e));
        desc.style.color = 'rgba(220,120,120,0.9)';
    } finally {
        btn.disabled = false;
        btn.textContent = '检查更新';
    }
}

function goUpdateReleaseNotes() {
    // Unified open + categorized failure toast (ADR-0003): release
    // notes go through the same backend validation as terminal links.
    if (window.__updateUrl) LinkOpen.invokeOpenUrl(window.__updateUrl);
}

async function startUpdateDownload() {
    const dl = document.getElementById('btn-update-download');
    if (!dl || dl.disabled) return;
    dl.disabled = true;
    dl.textContent = '下载中…';
    _startUpdatePoll();
    try {
        const st = await ipcRenderer.invoke('download-update', { tag: window.__updateTag || '' });
        _stopUpdatePoll();
        if (st && st.phase === 'ready') {
            _renderUpdateReady(st.tag);
            _toastUpdateReadyOnce(st.tag);
        } else {
            _renderUpdateFailed(st && st.error ? st.error : '未知错误');
        }
    } catch (e) {
        _stopUpdatePoll();
        _renderUpdateFailed(e && e.message ? e.message : String(e));
    }
}

// Exit blockers: only live SSH sessions and in-flight SFTP transfers are
// worth a confirmation; local shells die on every ordinary exit anyway.
// Counting itself is the pure countUpdateBlockers (update-utils.js).
function _countUpdateBlockers() {
    try {
        const transfers = (typeof TransferManager !== 'undefined') ? TransferManager._transfers : [];
        return countUpdateBlockers(TabManager.tabs || [], transfers, typeof getAllPanes === 'function' ? getAllPanes : null);
    } catch(e) {
        return { ssh: 0, sftp: 0 };
    }
}

async function applyUpdate() {
    const apply = document.getElementById('btn-update-apply');
    if (apply && apply.disabled) return;
    const { ssh, sftp } = _countUpdateBlockers();
    if (ssh + sftp > 0) {
        const parts = [];
        if (ssh > 0) parts.push(ssh + ' 个已连接的 SSH 会话');
        if (sftp > 0) parts.push(sftp + ' 个传输中的 SFTP 任务');
        showConfirm('退出安装将中断 ' + parts.join('、') + '。确定继续？', _doApplyUpdate, '退出并安装');
        return;
    }
    _doApplyUpdate();
}

async function _doApplyUpdate() {
    const apply = document.getElementById('btn-update-apply');
    if (apply) { apply.disabled = true; apply.textContent = '正在退出…'; }
    showToast('正在退出并启动安装…');
    // Persist session state so the post-install relaunch restores tabs.
    try { if (typeof saveConfig === 'function') await saveConfig(); } catch(e) {}
    try {
        await ipcRenderer.invoke('apply-update');
        // On success the main process exits and the installer takes over;
        // control only returns here when the launch failed.
    } catch (e) {
        if (apply) { apply.disabled = false; apply.textContent = '重启并安装'; }
        const raw = e && e.message ? e.message : String(e);
        const msg = raw.includes('elevation prompt declined')
            ? '已取消管理员授权，更新未安装'
            : '启动安装失败：' + raw;
        _setUpdateDesc(msg, 'rgba(220,120,120,0.9)');
    }
}

async function changeDataDir() {
    const result = await ipcRenderer.invoke('show-open-dialog', { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return;
    const r = await ipcRenderer.invoke('set-data-dir', { dir: result.filePaths[0] });
    if (r && r.error) { showToast('更改失败: ' + r.error, true); return; }
    showToast('数据目录已更改，配置已迁移');
    loadDataDirInfo();
}

async function resetDataDir() {
    const r = await ipcRenderer.invoke('set-data-dir', { dir: '' });
    if (r && r.error) { showToast('恢复失败: ' + r.error, true); return; }
    showToast('已恢复默认数据目录');
    loadDataDirInfo();
}

// Browser-accelerator guard (WebView2 gap): see browserAcceleratorDenied in
// shortcut-utils.js. preventDefault marks the key consumed in every focus
// context, including the textarea-blurred corner case that opened the Edge
// downloads hub in the field. Combos ZTerm binds itself are already consumed
// by the dispatcher below; the denylist is only for Edge-OOUI keys.
document.addEventListener('keydown', e => {
    if (browserAcceleratorDenied(e)) e.preventDefault();
}, true);

document.addEventListener('keydown', e => {
    if (_shortcutCapture) return; // 正在录制新快捷键，交给录制监听器处理
    // Escape：弹窗/最大化恢复的优先级最高，其余情况放行给 xterm（vim 等程序要用）
    if (e.key === 'Escape') {
        // 内联编辑输入框（SFTP 路径/mkdir、分组重命名等）的 Escape
        // 应由输入框自己处理（取消编辑），不能在这里关掉整个 overlay。
        // 本监听器是 capture 阶段，先于 input 的 keydown，必须在这里放行。
        if (e.target && e.target.classList && e.target.classList.contains('inline-edit')) {
            return;
        }
        // combo dropdown menu 开着时（SSH/QC 编辑面板的分组字段），Escape 应先关 menu
        // 而非关整个编辑表单；input keydown 已 stopPropagation（bubble），这里负责放行
        if (document.querySelector('.dd-menu.open')) {
            return;
        }
        // The session selector routes Esc/IME/focus through its own capture listener (registered on open in ssh.js); let it pass here to avoid double handling.
        const sessionsOv = document.getElementById('overlay-sessions');
        if (sessionsOv && sessionsOv.classList.contains('open')) {
            return;
        }
        // The SSH template picker and the add-connection menu run their own
        // capture listeners in ssh.js (Esc closes just them and restores
        // focus to the opener); do not closeAllOverlays underneath them.
        const sshTplOv = document.getElementById('overlay-ssh-template');
        if (sshTplOv && sshTplOv.classList.contains('open')) {
            return;
        }
        const sshAddMenu = document.getElementById('ssh-add-menu');
        if (sshAddMenu && sshAddMenu.classList.contains('open')) {
            return;
        }
        const menuPopup = document.getElementById('menu-popup');
        if (menuPopup && menuPopup.classList.contains('open')) {
            menuPopup.classList.remove('open');
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (document.querySelector('.overlay.open')) {
            closeAllOverlays();
            const tab = TabManager.getActive();
            if (tab && tab.term) setTimeout(() => tab.term.focus(), 50);
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (TabManager._maximizedPaneId) {
            const tab = TabManager.getActive();
            if (tab && tab.splitRoot) {
                e.preventDefault(); e.stopPropagation();
                TabManager._maximizePane(tab.id, TabManager._maximizedPaneId);
            }
        }
        return;
    }

    // 在输入框/下拉框里打字时不触发全局快捷键（xterm 的辅助输入框除外）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
        && !(t.classList && t.classList.contains('xterm-helper-textarea'))) return;

    const combo = _comboFromEvent(e);
    const bindings = _getShortcutBindings();
    const actionId = Object.keys(bindings).find(id => bindings[id] === combo);
    if (!actionId || !SHORTCUT_ACTIONS[actionId]) return;
    e.preventDefault(); e.stopPropagation();
    SHORTCUT_ACTIONS[actionId]();
}, true);

