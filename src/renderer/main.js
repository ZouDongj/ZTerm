// ZTerm - startup sequence + periodic save + window.electronAPI (moved verbatim out of renderer.html, logic unchanged)
// ── Window controls ──
function _refocusActiveTerminal() {
    const tab = TabManager.getActive();
    if (!tab || tab.type === 'settings') return;
    if (tab.splitRoot) {
        const focused = getAllPanes(tab).find(p => p.focused);
        if (focused && focused.term) focused.term.focus();
    } else if (tab.term) {
        tab.term.focus();
    }
}

window.electronAPI = {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => {
        ipcRenderer.send('window-maximize');
        // Toggle icon will update via window-state-changed event
        setTimeout(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                _refocusActiveTerminal();
            }));
        }, 200);
    },
    close: () => { saveConfig(); ipcRenderer.send('window-close'); },
};

// Update the maximize/restore icon when the window state changes
ipcRenderer.on('window-state-changed', (event, { maximized }) => {
    const btn = document.getElementById('win-maximize');
    if (btn) btn.textContent = maximized ? '\uE923' : '\uE922'; // Restore ↔ Maximize
    const winEl = document.querySelector('.window');
    if (winEl) winEl.classList.toggle('is-maximized', maximized);
});

// ── Globally disable form autofill / spellcheck suggestions ──
// WebView2 autofill is already disabled in the main process (general_autofill_enabled(false));
// this adds a second layer: turn off autocomplete/autocorrect/spellcheck on all inputs,
// so dynamically created inputs (login script rows, rename fields, etc.) cannot trigger browser-style suggestion popups
function _disableFormEnhancements(root) {
    (root.querySelectorAll ? root.querySelectorAll('input, textarea') : []).forEach(el => {
        if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
        if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off');
        if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'false');
    });
}
new MutationObserver(muts => {
    for (const m of muts) {
        for (const n of m.addedNodes) {
            if (n.nodeType === 1) _disableFormEnhancements(n);
        }
    }
}).observe(document.documentElement, { childList: true, subtree: true });
_disableFormEnhancements(document);

// ── Save / Periodic ──
// Returns a Promise: the quit flow must wait for the save to hit disk, so this cannot be fire-and-forget
function saveConfig() {
    const tabs = TabManager.tabs
        .filter(t => t.type !== 'settings')
        .map((t, i) => {
            let saveName = t.name;
            const entry = { name: saveName, type: t.type, command: t.command || 'powershell.exe', args: t.args || [], content: t.splitRoot ? [] : (t._contentBuffer || []) };
            if (t.splitRoot) {
                entry.splitRoot = serializeSplitNode(t.splitRoot);
            }
            if (t.type === 'ssh') {
                entry.host = t.host; entry.port = t.port; entry.user = t.user;
                entry.sshProfileId = t.sshProfileId;
            }
            return entry;
        });
    // Save the current state even when there is no content / all tabs are closed, otherwise stale lastTabs would resurrect closed tabs
    // invoke waits until the Rust side has written to disk (save_last_tabs flushes synchronously), so calling it before quit guarantees persistence
    return ipcRenderer.invoke('save-last-tabs', tabs).catch(e => console.error('[saveConfig]', e));
}

setInterval(() => { saveConfig(); }, 15000);

// The main process grants one final save before the window closes (app-before-quit → quit-ready)
ipcRenderer.on('app-before-quit', async () => {
    try { await saveConfig(); } catch(e) {}
    ipcRenderer.send('quit-ready');
});

// Startup animation: once the window state (position/size/maximized) has been restored and the window shown,
// the main process emits this event to trigger the .window fade-in (a restrained 0.4s so startup does not feel abrupt)
ipcRenderer.on('window-shown', () => {
    const winEl = document.querySelector('.window');
    if (winEl && !winEl.classList.contains('win-in')) {
        winEl.classList.add('win-in');
        setTimeout(() => winEl.classList.remove('win-in'), 400);
    }
    // Window shown: lift the splash-hide ban; if a hide was deferred earlier (first frame beat the window), retry it now
    _windowShownAt = Date.now();
    if (_splashHidePending) { _splashHidePending = false; hideStartupSplash(); }
});

// Renderer finished loading and listeners are registered: tell the main process to restore the window state and show the window.
// This lets the main process guarantee window-shown is only emitted after listeners are ready (otherwise the splash would stall)
ipcRenderer.invoke('renderer-ready').catch(() => {});

// Startup splash: fades out once the first terminal's first frame has rendered (precise xterm onRender detection + 3s fallback)
let _splashHidden = false;
// Window-shown timestamp: the splash must not hide before the window is shown (so it cannot vanish before the window appears);
// after the window is shown, fade out the moment the terminal's first frame arrives, with no extra dwell
let _windowShownAt = 0;
let _splashHidePending = false;
// Green-dot loader animation: cycles one-way along the Z-shaped cells, one cell per step (current cell turns white, next turns green), slow
let _splashLoaderTimer = null;
function startSplashLoader() {
    const cells = document.querySelectorAll('#splash-cells .cell');
    if (!cells.length) return;
    let idx = 0;
    cells[idx].classList.add('loading');
    _splashLoaderTimer = setInterval(() => {
        cells[idx].classList.remove('loading');
        idx = (idx + 1) % cells.length;
        cells[idx].classList.add('loading');
    }, 450); // 450ms per cell; 13 cells ≈ 5.9s per lap, stepping slowly one cell at a time
}
function hideStartupSplash(force) {
    if (_splashHidden) return;
    // Window not shown yet (still restoring state / not visible): defer the hide until window-shown
    if (!force && !_windowShownAt) { _splashHidePending = true; return; }
    // Terminal first frame rendered → fade out immediately (no extra dwell; the force fallback path is equally immediate)
    _splashHidden = true;
    _splashHidePending = false;
    if (_splashLoaderTimer) { clearInterval(_splashLoaderTimer); _splashLoaderTimer = null; }
    const s = document.getElementById('startup-splash');
    if (s) {
        s.classList.add('leaving');
        setTimeout(() => s.remove(), 450);
    }
}

function armSplashHide() {
    const waitTerm = () => {
        const t = TabManager.tabs.find(t => t.term || (t.splitRoot && getAllPanes(t)[0] && getAllPanes(t)[0].term));
        if (t) {
            const term = t.term || getAllPanes(t)[0].term;
            if (term) {
                const un = term.onRender(() => { un.dispose(); hideStartupSplash(); });
                return;
            }
        }
        setTimeout(waitTerm, 200);
    };
    waitTerm();
    // Fallback 1: if the window-shown event was lost (the normal path only emits it after the page loads),
    // forcibly lift the "window not shown" ban and retry, so the splash cannot stick around forever
    setTimeout(() => {
        if (!_windowShownAt) {
            console.warn('[startup] window-shown 1.2s 未收到，假定窗口已显示并重试隐藏 splash');
            _windowShownAt = Date.now();
        }
        if (_splashHidePending) { _splashHidePending = false; hideStartupSplash(); }
    }, 1200);
    // Fallback 2: force-hide after 3s regardless of first frame / events (bypassing the dwell restriction).
    // Per Tabby's behavior, a timeout must not remove the splash silently — log startup diagnostics before hiding;
    // only log when the splash still exists (on the normal path the first frame removed it long ago, so this avoids misleading logs)
    setTimeout(() => {
        if (_splashHidden) return;
        console.warn('[startup] splash 3s 兜底强制隐藏（未检测到终端首帧）', {
            tabs: TabManager.tabs.length,
            terminalReady: TabManager.tabs.some(t => t.term || (t.splitRoot && getAllPanes(t)[0] && getAllPanes(t)[0].term)),
            windowShownAt: _windowShownAt || null,
        });
        hideStartupSplash(true);
    }, 3000);
}

// ── Settings ──
// ── Init ──
(async () => {
    // Preload terminal fonts before any terminal opens: xterm measures cell
    // size at open() time, and a first frame on the fallback font would both
    // flash and poison the measurement until the next resize (Tabby parity).
    try {
        await Promise.all([
            document.fonts.load('400 16px "JetBrainsMonoNL NF"', 'Study Z'),
            document.fonts.load('600 16px "JetBrainsMonoNL NF"', 'Study Z'),
            document.fonts.load('400 16px "HarmonyOS Sans SC"', '中文'),
        ]);
    } catch(e) { /* missing fonts fall back silently */ }
    // The data directory is resolved by the main process (packaged builds default to <install dir>/data; a user-defined pointer is supported)
    try {
        const info = await ipcRenderer.invoke('get-data-dir-info');
        if (info && info.current) CONFIG_FILE = path.join(info.current, 'config.json');
    } catch(e) {}
    await loadSettings();
    loadQuickCommands();
    loadHighlightRules();
    applyAccentColor(_settingsConfig.accentColor || '#61afef');
    applyTerminalScheme();
    applyUiFont();
    // Top-bar menu shortcut hints must reflect user customization: fill them right after loadSettings
    if (typeof updateMenuShortcuts === 'function') updateMenuShortcuts();
    const _winEl = document.querySelector('.window');
    if (_winEl && _settingsConfig.animations === false) {
        _winEl.classList.add('no-animations');
        // The splash lives outside .window, so sibling selectors cannot reach it: mirror the anchor onto body (app.css depends on it)
        document.body.classList.add('no-animations');
    }
    TabManager.init();
    startSplashLoader();
    armSplashHide();
})();
