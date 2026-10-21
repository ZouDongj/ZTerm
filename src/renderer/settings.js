// ZTerm - settings page body + custom dropdown + color picker (color conversion pure functions live in color-utils.js, loaded first by renderer.html)

// ── Custom dropdown (replaces native <select class="styled-select">) ──
function convertSelects() {
    document.querySelectorAll('select.styled-select').forEach(sel => {
        // Font selects use the filterable combo instead of the plain dropdown.
        if (sel.dataset.combo === 'font') { buildFontCombo(sel); return; }
        // Remove existing custom dropdown wrapper if present (so we can rebuild with new options)
        const existingWrapper = sel.parentNode && sel.parentNode.querySelector('.cust-dropdown');
        // Skip the rebuild when options + selection are unchanged: with ~1000
        // system fonts, rebuilding every visit recreates thousands of
        // .dd-option nodes on a timer that can fire after the settings tab
        // already closed (the post-close tab-hover jank report).
        const sig = sel.selectedIndex + '|' + sel.options.length + '|' + Array.from(sel.options, o => o.value).join(' ');
        if (existingWrapper && sel._convSig === sig) return;
        if (existingWrapper) existingWrapper.remove();
        sel._convSig = sig;

        const wrapper = document.createElement('div');
        wrapper.className = 'cust-dropdown';
        const trigger = document.createElement('div');
        trigger.className = 'dd-trigger';
        const menu = document.createElement('div');
        menu.className = 'dd-menu';
        const selectedOpt = sel.options[sel.selectedIndex];
        trigger.textContent = selectedOpt ? selectedOpt.text : (sel.options[0]?.text || '');
        Array.from(sel.options).forEach((opt, i) => {
            const div = document.createElement('div');
            div.className = 'dd-option' + (opt.selected ? ' selected' : '') + (opt.value === '__new__' ? ' new-group' : '');
            div.setAttribute('data-value', opt.value || opt.text);
            div.textContent = opt.text;
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                if (opt.value === '__new__') {
                    // Trigger the onchange handler on the native select
                    sel.value = '__new__';
                    sel.dispatchEvent(new Event('change'));
                    wrapper.classList.remove('open');
                    return;
                }
                sel.selectedIndex = i;
                trigger.textContent = opt.text;
                menu.querySelectorAll('.dd-option').forEach(o => o.classList.remove('selected'));
                div.classList.add('selected');
                wrapper.classList.remove('open');
                // Fire change event on native select
                sel.dispatchEvent(new Event('change'));
            });
            menu.appendChild(div);
        });
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.cust-dropdown.open').forEach(d => { if (d !== wrapper) d.classList.remove('open'); });
            wrapper.classList.toggle('open');
        });
        // Prevent scroll from propagating to settings page when menu is open
        menu.addEventListener('wheel', (e) => {
            const menuRect = menu.getBoundingClientRect();
            const isAtTop = menu.scrollTop <= 0 && e.deltaY < 0;
            const isAtBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight && e.deltaY > 0;
            if (!isAtTop && !isAtBottom) {
                e.stopPropagation();
            }
        }, { passive: false });
        wrapper.appendChild(trigger);
        wrapper.appendChild(menu);
        sel.style.display = 'none';
        sel.parentNode.insertBefore(wrapper, sel);
    });
}

// ── Font combobox (Tabby-style filterable input over the hidden select) ──
// The four font selects (data-combo="font") keep the native <select> as their
// data model — option filling (_buildFontSelects), value restore and the
// saveAppearance reads are unchanged. The combo replaces only the
// cust-dropdown presentation with an input that filters the option list, so
// ~1000 system fonts stay navigable by typing. Free text is a legal value: it
// becomes an extra option exactly like _buildFontSelects' missing-font one.

// Resolve what a font combo should do with committed text (blur / Enter).
// options: bare [{ value, label }] so the rule stays DOM-free and testable.
// Returns { action: 'select', index } | { action: 'extra', value, label } |
// { action: 'none' }.
function _resolveFontCommit(options, text, selectId) {
    const q = (text || '').trim();
    if (!q) {
        // Empty input selects the sentinel option: '' for the UI/fallback
        // selects ('系统默认' / '无'), 'monospace' for the terminal font.
        let idx = options.findIndex(o => o.value === '');
        if (idx < 0) idx = options.findIndex(o => o.value === 'monospace');
        return idx >= 0 ? { action: 'select', index: idx } : { action: 'none' };
    }
    let idx = options.findIndex(o => o.label === q);
    if (idx < 0) {
        const lq = q.toLowerCase();
        idx = options.findIndex(o => o.label.toLowerCase() === lq);
    }
    if (idx >= 0) return { action: 'select', index: idx };
    // Free text: a font that failed to enumerate, or one that only exists on
    // the target machine. Mirror _buildFontSelects' extra-option rule,
    // including the per-field CSS-family suffix.
    const suffix = selectId === 'set-font' ? ',monospace' : selectId === 'set-ui-font' ? ',sans-serif' : '';
    return { action: 'extra', value: suffix ? `'${q}'${suffix}` : q, label: q };
}

function _fontComboDisplay(sel) {
    const opt = sel.options[sel.selectedIndex];
    return opt ? opt.textContent : '';
}

function buildFontCombo(sel) {
    const existing = sel.parentNode && sel.parentNode.querySelector('.font-combo');
    if (existing) {
        // Idempotent refresh (convertSelects runs after every option rebuild /
        // value restore): sync the input with the programmatic value, but never
        // clobber text the user is typing right now.
        const input = existing.querySelector('input');
        if (input && document.activeElement !== input) input.value = _fontComboDisplay(sel);
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'cust-combo font-combo';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '输入以筛选字体';
    input.value = _fontComboDisplay(sel);
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    wrapper.appendChild(input);
    wrapper.appendChild(menu);
    sel.style.display = 'none';
    sel.parentNode.insertBefore(wrapper, sel);

    let activeIdx = -1;
    // Render cap: the full system-font list is ~1000 entries; typing narrows
    // it quickly, and re-rendering thousands of nodes per keystroke would
    // stutter the input.
    const CAP = 300;

    function commitOption(index) {
        const opt = sel.options[index];
        if (!opt) return;
        const changed = sel.selectedIndex !== index;
        sel.selectedIndex = index;
        input.value = opt.textContent;
        menu.classList.remove('open');
        if (changed) sel.dispatchEvent(new Event('change'));
    }

    function commitText() {
        // Enumeration still in flight: no options to match or extend. Restore
        // the display and leave the configured value untouched (a commit here
        // would also defeat _fontSelectValue's empty-options guard).
        if (sel.options.length === 0) { input.value = _fontComboDisplay(sel); return; }
        const opts = Array.from(sel.options, o => ({ value: o.value, label: o.textContent }));
        const r = _resolveFontCommit(opts, input.value, sel.id);
        if (r.action === 'select') {
            const changed = sel.selectedIndex !== r.index;
            sel.selectedIndex = r.index;
            input.value = sel.options[r.index].textContent;
            if (changed) sel.dispatchEvent(new Event('change'));
        } else if (r.action === 'extra') {
            let opt = [...sel.options].find(o => o.value === r.value);
            if (!opt) {
                opt = document.createElement('option');
                opt.value = r.value;
                opt.textContent = r.label;
                sel.appendChild(opt);
            }
            const changed = sel.selectedIndex !== opt.index;
            sel.selectedIndex = opt.index;
            input.value = opt.textContent;
            if (changed) sel.dispatchEvent(new Event('change'));
        } else {
            input.value = _fontComboDisplay(sel);
        }
    }

    function renderOptions(filter) {
        const opts = Array.from(sel.options);
        // Enumeration still in flight: no list to show, and the free-text hint
        // would misread "not loaded yet" as "no such font".
        if (opts.length === 0) { menu.classList.remove('open'); return; }
        const q = (filter || '').trim().toLowerCase();
        const matched = q ? opts.filter(o => o.textContent.toLowerCase().includes(q)) : opts;
        menu.innerHTML = '';
        matched.slice(0, CAP).forEach(o => {
            const div = document.createElement('div');
            div.className = 'dd-option' + (o.index === sel.selectedIndex ? ' selected' : '');
            div.dataset.optIndex = o.index;
            div.textContent = o.textContent;
            // mousedown precedes the input's blur, so pick there; click answers
            // the real-mouse path that follows it (idempotent no-op by then).
            const pick = (e) => { e.preventDefault(); commitOption(o.index); };
            div.addEventListener('mousedown', pick);
            div.addEventListener('click', pick);
            menu.appendChild(div);
        });
        if (matched.length > CAP) {
            const more = document.createElement('div');
            more.className = 'dd-option dd-more';
            more.textContent = `…共 ${matched.length} 个匹配，继续输入以缩小范围`;
            menu.appendChild(more);
        }
        if (matched.length === 0 && q) {
            // Free text stays legal: say so instead of showing a dead menu.
            const none = document.createElement('div');
            none.className = 'dd-option dd-none';
            none.textContent = `无匹配字体——将直接使用「${(filter || '').trim()}」`;
            menu.appendChild(none);
        }
        if (matched.length > 0 || q) menu.classList.add('open');
        else menu.classList.remove('open');
        activeIdx = -1;
    }

    // Focus opens the FULL list (Tabby precedent): the current value doubles
    // as the display text, not as a filter — typing narrows it from there.
    input.addEventListener('focus', () => renderOptions(''));
    input.addEventListener('input', () => renderOptions(input.value));
    // After Esc closed the menu, clicking the still-focused input must reopen
    // it (neither focus nor input fires in that case) — group-combo precedent.
    input.addEventListener('mousedown', () => { if (!menu.classList.contains('open')) renderOptions(''); });
    input.addEventListener('blur', () => {
        // A keyboard highlight survives Tab/mouse-away: "↓ then leave" commits
        // the highlighted option, matching native <select> arrow semantics.
        const items = menu.classList.contains('open') ? [...menu.querySelectorAll('.dd-option[data-opt-index]')] : [];
        if (activeIdx >= 0 && items[activeIdx]) commitOption(+items[activeIdx].dataset.optIndex);
        else commitText();
        setTimeout(() => menu.classList.remove('open'), 150);
    });
    input.addEventListener('keydown', (e) => {
        // IME composition: let the candidate window own Enter/arrows/Esc.
        if (e.isComposing || e.keyCode === 229) return;
        const items = [...menu.querySelectorAll('.dd-option[data-opt-index]')];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!menu.classList.contains('open')) { renderOptions(input.value); return; }
            if (!items.length) return;
            activeIdx = e.key === 'ArrowDown'
                ? Math.min(activeIdx + 1, items.length - 1)
                : Math.max(activeIdx - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
            if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (menu.classList.contains('open') && activeIdx >= 0 && items[activeIdx]) {
                commitOption(+items[activeIdx].dataset.optIndex);
            } else {
                commitText();
                menu.classList.remove('open');
            }
        } else if (e.key === 'Escape') {
            // Close only the menu; never the settings tab underneath.
            e.stopPropagation();
            menu.classList.remove('open');
        }
    });
    // Mousedown anywhere inside the menu must not move focus out of the
    // input: without this, pressing the menu's scrollbar (or a hint row) would
    // blur the input and commit the half-typed filter text as a font name.
    // Option picks already preventDefault on their own; this covers the rest.
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    // Keep wheel scrolling inside the open menu from leaking to the settings
    // page (same guard as the cust-dropdown menu).
    menu.addEventListener('wheel', (e) => {
        const isAtTop = menu.scrollTop <= 0 && e.deltaY < 0;
        const isAtBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight && e.deltaY > 0;
        if (!isAtTop && !isAtBottom) e.stopPropagation();
    }, { passive: false });
}

// Close custom dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.cust-dropdown')) {
        document.querySelectorAll('.cust-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});

// Escape while a custom dropdown menu is open must close just that menu, not
// the dialog/overlay underneath it (e.g. the auth select in the SSH edit
// dialog). Capture phase + stopImmediatePropagation terminates the key before
// the global overlay-close chain in shortcuts.js runs (settings.js loads
// before shortcuts.js, so this listener is registered first on the same
// node/phase). Dropdowns left 'open' inside an already hidden overlay
// (display:none) have no client rects and are skipped, so they never swallow
// Escape presses meant for the terminal.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('.cust-dropdown.open'))
        .filter(d => d.getClientRects().length > 0);
    if (!open.length) return;
    open.forEach(d => d.classList.remove('open'));
    e.preventDefault();
    e.stopImmediatePropagation();
}, true);


function openSettings(page) {
    // If already open, just switch to it
    const existing = TabManager.tabs.find(t => t.type === 'settings');
    if (existing) { TabManager.switchTo(existing.id); }
    else {
        const id = 't_' + (TabManager._counter++);
        const tab = { id, name: '设置', type: 'settings', connected: true, command: '' };
        TabManager.tabs.push(tab);
        TabManager.switchTo(id);
        TabManager.render();
    }
    if (page) {
        // Switch to specific page after opening
        setTimeout(() => {
            const sidebarItem = document.querySelector(`.settings-sidebar-item[onclick*="${page}"]`);
            if (sidebarItem) switchSettingsTab(sidebarItem, page);
        }, 50);
    }
}

function closeSettingsTab() {
    const tab = TabManager.tabs.find(t => t.type === 'settings');
    if (!tab) return;
    TabManager.closeTab(tab.id);
}

function switchSettingsTab(el, page) {
    document.querySelectorAll('#settings-sidebar .settings-sidebar-item').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('#settings-content .settings-page').forEach(p => p.classList.remove('active'));
    const target = document.querySelector(`#settings-content .settings-page[data-page="${page}"]`);
    if (target) {
        target.classList.add('active');
        // Refresh SSH list when switching to ssh page
        if (page === 'ssh') renderSSHManagerInSettings();
        // Refresh quick commands list when switching to quickcommands page
        if (page === 'quickcommands') renderQCCommandsList();
        // Refresh highlight rules list when switching to highlight page
        if (page === 'highlight') { updateHighlightToggles(); renderHighlightRulesList(); }
        // Populate settings when switching to terminal/appearance
        if (page === 'terminal' || page === 'appearance') loadSettingsIntoForm();
        // Render shortcut list when switching to keys page
        if (page === 'keys') renderShortcutsList();
        // Refresh data dir info when switching to about page
        if (page === 'about') {
            loadDataDirInfo();
            loadAboutInfo();
            // The update-proxy input lives on this page — repopulate it here
            // too instead of relying solely on the tab-activation hook.
            const upEl = document.getElementById('set-update-proxy');
            if (upEl) upEl.value = _settingsConfig.updateProxy || '';
        }
        // Convert selects
        setTimeout(convertSelects, 50);
    }
}

function renderSSHManagerInSettings() {
    // Same renderer as the standalone manager overlay (ssh.js): identical row
    // content, actions and visual hierarchy
    renderSSHManagerInto(document.getElementById('settings-ssh-list'), _sshMgrView('settings-ssh-list'));
}

// The sidebar ships as plain labels so the markup stays easy to scan; decorate
// it once at startup with the same icon set used by the rest of the chrome.
function decorateSettingsSidebar() {
    const map = {
        terminal: 'terminal',
        appearance: 'palette',
        ssh: 'server',
        highlight: 'highlighter',
        quickcommands: 'zap',
        keys: 'keyboard',
        about: 'info',
    };
    document.querySelectorAll('.settings-sidebar-item').forEach(item => {
        if (item.querySelector('.settings-nav-icon')) return;
        const match = (item.getAttribute('onclick') || '').match(/'([^']+)'/);
        const name = match && map[match[1]];
        if (!name || typeof Icons === 'undefined') return;
        const span = document.createElement('span');
        span.className = 'settings-nav-icon';
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = Icons.iconSvg(name, 15);
        item.prepend(span);
    });
    // Menu icons that need the purpose-drawn small artwork (currently the
    // settings gear) are rendered here instead of duplicating SVG inline.
    document.querySelectorAll('[data-app-icon]').forEach(el => {
        if (!el.querySelector('svg') && typeof Icons !== 'undefined') {
            el.innerHTML = Icons.iconSvg(el.dataset.appIcon, 14);
        }
    });
}
decorateSettingsSidebar();

function toggleSwitch(el) {
    el.classList.toggle('on');
}

function loadSettingsIntoForm() {
    const config = _settingsConfig;
    // Terminal
    const cursorEl = document.getElementById('set-cursor');
    if (cursorEl) cursorEl.value = config.cursor || 'bar';
    const sbEl = document.getElementById('set-scrollback');
    if (sbEl) sbEl.value = config.scrollback ?? 10000;
    const bellEl = document.getElementById('set-bell');
    if (bellEl) bellEl.value = config.bell || 'off';
    const blinkEl = document.getElementById('set-blink');
    if (blinkEl) blinkEl.value = config.cursorBlink !== false ? 'on' : 'off';
    const contrastEl = document.getElementById('set-contrast');
    if (contrastEl && config.minimumContrastRatio) contrastEl.value = config.minimumContrastRatio;
    const wsEl = document.getElementById('set-word-separators');
    if (wsEl) wsEl.value = _normalizeWordSeparators(config.wordSeparators);
    // Local shell defaults (options come from auto-detected profiles)
    const dsEl = document.getElementById('set-default-shell');
    if (dsEl) {
        dsEl.innerHTML = '';
        (TabManager.profiles || []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id; opt.textContent = p.name;
            dsEl.appendChild(opt);
        });
        const def = getDefaultLocalProfile();
        if (def && def.id) dsEl.value = def.id;
    }
    const sdEl = document.getElementById('set-startup-dir');
    if (sdEl) sdEl.value = config.startupDir || '';
    const upEl = document.getElementById('set-update-proxy');
    if (upEl) upEl.value = config.updateProxy || '';
    // Shell visibility in session selector: one toggle row per local shell.
    // The group-level hint is static markup under the section title in
    // renderer.html (.settings-section-desc), not injected here.
    const svEl = document.getElementById('shell-visibility-list');
    if (svEl) {
        const hidden = config.hiddenProfiles || [];
        svEl.innerHTML = (TabManager.profiles || []).map(p => `
              <div class="settings-row">
                <div class="settings-card-label">
                  <div class="settings-card-title">${escHtml(p.name)}</div>
                </div>
                <div class="toggle-switch ${hidden.includes(p.id) ? '' : 'on'}" id="toggle-shell-${p.id}" onclick="toggleSwitch(this);saveTerminal()"></div>
              </div>`).join('');
    }
    setToggle('toggle-autocopy', config.autoCopy !== false);
    setToggle('toggle-rightclick', config.rightClickPaste !== false);
    // Appearance
    const fontEl = document.getElementById('set-font');
    if (fontEl) {
        // Extract the first font name from CSS font-family string for display
        const fullFamily = config.fontFamily || '';
        const firstFont = _firstFontName(fullFamily);
        const match = [...fontEl.options].find(o => o.value === firstFont);
        if (match) fontEl.value = firstFont;
    }
    const fontSizeEl = document.getElementById('set-font-size');
    if (fontSizeEl) fontSizeEl.value = config.fontSize || 16;
    const lhEl = document.getElementById('set-line-height');
    if (lhEl) lhEl.value = config.lineHeight || 1.125;
    const fwEl = document.getElementById('set-font-weight');
    if (fwEl) fwEl.value = config.fontWeight || '400';
    const fwbEl = document.getElementById('set-font-weight-bold');
    if (fwbEl) fwbEl.value = config.fontWeightBold || '600';
    const fallbackEl = document.getElementById('set-fallback-font');
    if (fallbackEl && config.fallbackFont) fallbackEl.value = config.fallbackFont;
    const schemeEl = document.getElementById('set-terminal-scheme');
    if (schemeEl) populateTerminalSchemeSelect(schemeEl, config.terminalScheme || 'onedark');
    const accentInput = document.getElementById('set-accent');
    if (accentInput && config.accentColor) {
        accentInput.value = config.accentColor;
        updateAccentDot();
    }
    setToggle('toggle-animations', config.animations !== false);
    setToggle('toggle-statusdot', config.showStatusDot !== false);
    setToggle('toggle-pane-ring', config.paneRing === true);
    setToggle('toggle-panel-edge', config.panelEdge !== false);
    setToggle('toggle-sftp-material', config.sftpMaterial !== false);
    setToggle('toggle-richtext', config.richTextCopy === true);
    setToggle('toggle-smartcopy', config.smartCopy !== false);
    setToggle('toggle-osc52', config.osc52 !== false);
    setToggle('toggle-restore-local', config.restoreLocalContent === true);

    renderAccentSwatches();
    populateFontList();
    setTimeout(convertSelects, 80);
}

// ── Custom Color Picker ──
let _cpHue = 210, _cpSat = 0.5, _cpVal = 0.9;

let _cpCallback = null;

function openColorPicker(initialHex, callback) {
    const overlay = document.getElementById('color-picker-overlay');
    const hex = initialHex || document.getElementById('set-accent')?.value || '#61afef';
    _cpCallback = callback || null;
    const rgb = hexToRgb(hex);
    if (rgb) {
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        _cpHue = hsv.h; _cpSat = hsv.s; _cpVal = hsv.v;
    }
    updateColorPickerUI();
    overlay.classList.add('open');
    initColorPickerEvents();
}

function closeColorPicker() {
    document.getElementById('color-picker-overlay').classList.remove('open');
    _cpCallback = null;
}

function confirmColorPicker() {
    const rgb = hsvToRgb(_cpHue, _cpSat, _cpVal);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (_cpCallback) {
        _cpCallback(hex);
        closeColorPicker();
        return;
    }
    const input = document.getElementById('set-accent');
    if (input) {
        input.value = hex;
        // Swatch .active / aria-checked / tabindex sync lives in updateAccentDot.
        updateAccentDot();
        saveAppearance();
    }
    closeColorPicker();
}

function updateColorPickerUI() {
    const rgb = hsvToRgb(_cpHue, _cpSat, _cpVal);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const pureHue = hsvToRgb(_cpHue, 1, 1);

    // Canvas background: hue gradient
    const canvas = document.getElementById('cp-canvas');
    canvas.style.background = `linear-gradient(to right, #fff, transparent), linear-gradient(to top, #000, transparent), rgb(${pureHue.r},${pureHue.g},${pureHue.b})`;

    // Canvas dot position
    const dot = document.getElementById('cp-canvas-dot');
    dot.style.left = (_cpSat * 100) + '%';
    dot.style.top = ((1 - _cpVal) * 100) + '%';

    // Hue dot position
    const hueDot = document.getElementById('cp-hue-dot');
    hueDot.style.left = (_cpHue / 360 * 100) + '%';

    // Inputs
    document.getElementById('cp-r').value = rgb.r;
    document.getElementById('cp-g').value = rgb.g;
    document.getElementById('cp-b').value = rgb.b;
    document.getElementById('cp-hex').value = hex;
}

function initColorPickerEvents() {
    const canvas = document.getElementById('cp-canvas');
    const hue = document.getElementById('cp-hue');

    const canvasHandler = (e) => {
        const rect = canvas.getBoundingClientRect();
        _cpSat = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        _cpVal = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        updateColorPickerUI();
    };

    const hueHandler = (e) => {
        const rect = hue.getBoundingClientRect();
        _cpHue = Math.max(0, Math.min(360, (e.clientX - rect.left) / rect.width * 360));
        updateColorPickerUI();
    };

    canvas.onmousedown = (e) => {
        canvasHandler(e);
        const move = (e) => canvasHandler(e);
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    };

    hue.onmousedown = (e) => {
        hueHandler(e);
        const move = (e) => hueHandler(e);
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    };

    // RGB input changes
    ['cp-r', 'cp-g', 'cp-b'].forEach(id => {
        document.getElementById(id).onchange = () => {
            // Clamp to 0-255: an out-of-range component would push HSV past
            // its bounds and make the confirmed hex invalid.
            const clamp8 = (v) => Math.max(0, Math.min(255, parseInt(v) || 0));
            const r = clamp8(document.getElementById('cp-r').value);
            const g = clamp8(document.getElementById('cp-g').value);
            const b = clamp8(document.getElementById('cp-b').value);
            const hsv = rgbToHsv(r, g, b);
            _cpHue = hsv.h; _cpSat = hsv.s; _cpVal = hsv.v;
            updateColorPickerUI();
        };
    });

    // Hex input change
    document.getElementById('cp-hex').onchange = () => {
        const rgb = hexToRgb(document.getElementById('cp-hex').value);
        if (rgb) {
            const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
            _cpHue = hsv.h; _cpSat = hsv.s; _cpVal = hsv.v;
            updateColorPickerUI();
        }
    };
}

// Color conversion helpers (implemented in color-utils.js)

function selectAccent(hex) {
    const input = document.getElementById('set-accent');
    if (input) {
        input.value = hex;
        // updateAccentDot is the single sync point for swatch .active /
        // aria-checked / roving tabindex (it also covers the picker and the
        // hex field); nothing swatch-related is re-written here.
        updateAccentDot();
        saveAppearance();
    }
}

function renderAccentSwatches() {
    const container = document.getElementById('accent-swatches');
    if (!container) return;
    const colors = ['#61afef', '#9CA3FF', '#8BC4FF', '#A8DAB5', '#FFB74D', '#F2B8B5', '#abb2bf', '#87CEEB'];
    const current = document.getElementById('set-accent')?.value || '#61afef';
    container.setAttribute('role', 'radiogroup');
    container.setAttribute('aria-label', '强调色预设');
    container.innerHTML = '';
    let anyOn = false;
    colors.forEach(c => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'accent-swatch';
        sw.style.background = c;
        sw.style.color = c;
        sw.setAttribute('data-color', c.replace('#', ''));
        sw.title = c;
        sw.setAttribute('role', 'radio');
        // WCAG relative luminance: pick the tick that stays visible on any
        // current or future preset (0.179 matches the shadcn recipe).
        const r = parseInt(c.slice(1, 3), 16) / 255;
        const g = parseInt(c.slice(3, 5), 16) / 255;
        const b = parseInt(c.slice(5, 7), 16) / 255;
        const lin = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        sw.style.setProperty('--swatch-tick', lum > 0.179 ? '#111111' : '#ffffff');
        const on = c.toUpperCase() === current.toUpperCase();
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        // Roving tabindex: one tab stop for the whole group, on the checked
        // swatch (or the first when a custom hex checks nothing).
        sw.setAttribute('tabindex', on ? '0' : '-1');
        anyOn = anyOn || on;
        if (on) sw.classList.add('active');
        sw.onclick = () => selectAccent(c);
        container.appendChild(sw);
    });
    if (!anyOn && container.children[0]) container.children[0].setAttribute('tabindex', '0');
    // Radiogroup keyboard model: arrows/Home/End move AND select (the roving
    // tab stop follows the selection via updateAccentDot). Space/Enter keep
    // their native button activation (click → selectAccent). Assigned, not
    // bound, so re-renders stay idempotent.
    container.onkeydown = (e) => {
        const swatches = [...container.querySelectorAll('.accent-swatch')];
        if (!swatches.length) return;
        let idx;
        if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = swatches.length - 1;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
            const cur = swatches.indexOf(document.activeElement);
            idx = (cur < 0 ? 0 : cur + dir + swatches.length) % swatches.length;
        } else return;
        e.preventDefault();
        const target = swatches[idx];
        target.focus();
        // Route through the swatch's own click so keyboard selection shares
        // the exact click path (canonical-case hex, single selection owner).
        target.click();
    };
}

// Font lists barely change while the app runs; cache them so each settings
// visit does not re-enumerate fonts and rebuild thousands of <option> nodes.
let _systemFontsCache = null;
// The tab-activation path and the page-switch path both call populateFontList
// on open; share one in-flight enumeration so the pair cannot race the cache.
let _systemFontsPromise = null;

function populateFontList() {
    if (_systemFontsCache) {
        _buildFontSelects(_systemFontsCache);
        return;
    }
    if (!_systemFontsPromise) {
        // Fetch all system fonts from main process (fontmanager-redux). On
        // failure reset the promise so the next settings visit retries the
        // enumeration instead of latching a rejected promise forever.
        _systemFontsPromise = ipcRenderer.invoke('get-system-fonts').then(fonts => {
            _systemFontsCache = fonts && fonts.length > 0 ? fonts : ['monospace'];
            return _systemFontsCache;
        }, () => {
            _systemFontsPromise = null;
            return null;
        });
    }
    _systemFontsPromise.then(fonts => { if (fonts) _buildFontSelects(fonts); });
}

// Split from populateFontList so the cached path can rebuild synchronously.
function _buildFontSelects(allFonts) {
    {

        // Populate terminal font dropdown with ALL system fonts
        // Restore the value from _settingsConfig: on the first settings visit
        // the select is still empty and select.value has lost the configured
        // value; restoring from config keeps later saveAppearance reads correct
        const fontEl = document.getElementById('set-font');
        if (fontEl) {
            const current = _settingsConfig.fontFamily || fontEl.value;
            fontEl.innerHTML = '';
            allFonts.forEach(f => {
                const opt = document.createElement('option');
                opt.value = `'${f}',monospace`;
                opt.textContent = f;
                fontEl.appendChild(opt);
            });
            const opt = document.createElement('option');
            opt.value = 'monospace';
            opt.textContent = 'Monospace';
            fontEl.appendChild(opt);
            // Configured font is missing from the enumerated list (uninstalled?) → append an option to preserve the configured value
            if (current && ![...fontEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current.replace(/'/g, '').replace(/,monospace$/, '');
                fontEl.appendChild(extra);
            }
            if (current) fontEl.value = current;
        }

        // Populate UI font dropdown (UI font; defaults to the system font stack)
        const uiFontEl = document.getElementById('set-ui-font');
        if (uiFontEl) {
            const current = _settingsConfig.uiFont || '';
            uiFontEl.innerHTML = '';
            allFonts.forEach(f => {
                const opt = document.createElement('option');
                opt.value = `'${f}',sans-serif`;
                opt.textContent = f;
                uiFontEl.appendChild(opt);
            });
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '系统默认';
            uiFontEl.appendChild(opt);
            // Configured font is missing from the enumerated list → append an option to preserve the configured value
            if (current && ![...uiFontEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current.replace(/'/g, '').replace(/,sans-serif$/, '');
                uiFontEl.appendChild(extra);
            }
            // Same restore pattern as the fallback selects below: assign even
            // an empty current so a saved '系统默认' re-selects that option
            // instead of leaving the first font auto-selected.
            uiFontEl.value = current || '';
        }

        // Populate UI fallback font dropdown
        const uiFbEl = document.getElementById('set-ui-fallback-font');
        if (uiFbEl) {
            const current = _settingsConfig.uiFallbackFont || '';
            uiFbEl.innerHTML = '';
            allFonts.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f;
                opt.textContent = f;
                uiFbEl.appendChild(opt);
            });
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '无';
            uiFbEl.appendChild(opt);
            if (current && ![...uiFbEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current;
                uiFbEl.appendChild(extra);
            }
            uiFbEl.value = current || '';
        }

        // Sync the follow-terminal toggle state and row visibility
        syncUiFollowUI();

        // Populate fallback font dropdown with ALL system fonts
        const fallbackEl = document.getElementById('set-fallback-font');
        if (fallbackEl) {
            const current = _settingsConfig.fallbackFont !== undefined ? _settingsConfig.fallbackFont : fallbackEl.value;
            fallbackEl.innerHTML = '';
            allFonts.forEach(f => {
                const opt = document.createElement('option');                opt.value = f;
                opt.textContent = f;
                fallbackEl.appendChild(opt);
            });
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '无';
            fallbackEl.appendChild(opt);
            if (current && ![...fallbackEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current;
                fallbackEl.appendChild(extra);
            }
            fallbackEl.value = current || '';
        }

        // Re-convert selects to custom dropdowns with new options
        setTimeout(convertSelects, 50);
    }
}

// Default UI font: system font stack (no external font dependency; stable on intranet/offline networks)
const DEFAULT_UI_FONT = "'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif";

// Follow-terminal-font toggle for the UI font: when on, the UI reuses the terminal font combination and the UI font settings are hidden
function toggleUiFollowTerminal() {
    _settingsConfig.uiFollowTerminal = !(_settingsConfig.uiFollowTerminal !== false);
    syncUiFollowUI();
    persistSettings();
    applyUiFont();
}

function syncUiFollowUI() {
    const follow = _settingsConfig.uiFollowTerminal !== false;
    const sw = document.getElementById('toggle-ui-follow');
    if (sw) sw.classList.toggle('on', follow);
    const rowUi = document.getElementById('row-ui-font');
    const rowFb = document.getElementById('row-ui-fallback');
    if (rowUi) rowUi.style.display = follow ? 'none' : '';
    if (rowFb) rowFb.style.display = follow ? 'none' : '';
}

// Apply the UI font to body:
// follow terminal → terminal font + terminal fallback; independent → UI font + UI fallback
function applyUiFont() {
    const follow = _settingsConfig.uiFollowTerminal !== false;
    let family;
    if (follow) {
        family = _normalizeFontFamily(_settingsConfig.fontFamily, _settingsConfig.fallbackFont) + ',system-ui,sans-serif';
    } else {
        family = _normalizeFontFamily(_settingsConfig.uiFont, _settingsConfig.uiFallbackFont) + ',system-ui,sans-serif';
    }
    document.body.style.fontFamily = family || DEFAULT_UI_FONT;
}

// Read a font select's current value. While the async system-font enumeration
// has not populated any options yet the select reads ''; persist the
// configured value in that window instead, so an early appearance save cannot
// blank the stored fonts. Once options exist the select is authoritative —
// '' is then a real choice ('系统默认' / '无').
function _fontSelectValue(id, fallback) {
    const el = document.getElementById(id);
    if (!el || el.options.length === 0) return fallback || '';
    return el.value;
}

// Font-weight validation: a number 1-1000 (xterm accepts only a number 1-1000 or 'normal'/'bold'/'100'..'900'
// hundred-step strings; numeric strings like '550' are silently reset to the default — so this must return a number)
function saveAppearance() {
    const fontFamily = _fontSelectValue('set-font', _settingsConfig.fontFamily);
    const uiFont = _fontSelectValue('set-ui-font', _settingsConfig.uiFont);
    const uiFallbackFont = _fontSelectValue('set-ui-fallback-font', _settingsConfig.uiFallbackFont);
    const fontSize = parseFloat(document.getElementById('set-font-size')?.value) || 16;
    // Line-height validation: xterm's option setter throws on any value < 1,
    // which would abort every later appearance hot-apply with no feedback
    // until the app restarts. Reject the bad value instead: revert the input
    // to the last valid config value (default 1.125), toast, and keep saving
    // the remaining fields — same policy as the accent check below.
    const lhEl = document.getElementById('set-line-height');
    let lineHeight = parseFloat(lhEl?.value);
    if (!Number.isFinite(lineHeight) || lineHeight < 1) {
        const prev = parseFloat(_settingsConfig.lineHeight);
        lineHeight = (Number.isFinite(prev) && prev >= 1) ? prev : 1.125;
        if (lhEl) lhEl.value = String(lineHeight);
        showToast('行高需为不小于 1 的数值', true);
    }
    const fontWeight = _clampFontWeight(document.getElementById('set-font-weight')?.value, '400');
    const fontWeightBold = _clampFontWeight(document.getElementById('set-font-weight-bold')?.value, '600');
    // The persisted accent must pass the same 6-digit hex check as
    // applyAccentColor; an invalid input (e.g. 3-digit '#fff', which the
    // accent dot still renders as valid CSS) would otherwise be saved and
    // silently fall back to the default on the next launch. Revert the input
    // to the last valid value instead of persisting the bad one.
    const accentInput = document.getElementById('set-accent');
    const hex6 = /^#?[0-9a-f]{6}$/i;
    let accentColor = accentInput?.value || '#61afef';
    if (!hex6.test(accentColor)) {
        const prev = _settingsConfig.accentColor;
        accentColor = (prev && hex6.test(prev)) ? prev : '#61afef';
        if (accentInput) accentInput.value = accentColor;
        showToast('强调色需为 6 位十六进制颜色', true);
    }
    const fallbackFont = _fontSelectValue('set-fallback-font', _settingsConfig.fallbackFont);
    updateAccentDot();
    const animations = getToggle('toggle-animations');
    const showStatusDot = getToggle('toggle-statusdot');
    const paneRing = getToggle('toggle-pane-ring');
    const panelEdge = getToggle('toggle-panel-edge');
    const sftpMaterial = getToggle('toggle-sftp-material');
    const terminalScheme = document.getElementById('set-terminal-scheme')?.value || 'onedark';
    const minimumContrastRatio = parseFloat(document.getElementById('set-contrast')?.value) || 4;

    const config = { fontFamily, uiFont, uiFallbackFont, fontSize, lineHeight, fontWeight, fontWeightBold, accentColor, fallbackFont, animations, showStatusDot, paneRing, panelEdge, sftpMaterial, terminalScheme, minimumContrastRatio, theme: 'dark' };
    _settingsConfig = { ..._settingsConfig, ...config };
    persistSettings();
    applyUiFont();

    // Apply animations setting
    const winEl = document.querySelector('.window');
    if (winEl) winEl.classList.toggle('no-animations', animations === false);
    if (typeof applyChromeFlags === 'function') applyChromeFlags();

    // Apply status dot setting
    TabManager.render();

    // Apply terminal color scheme (all terminals + container background)
    applyTerminalScheme();

    // Apply font settings to existing terminals
    // Must use the same quote normalization as startup, otherwise an unquoted monospace becomes a CSS generic keyword and changes CJK fallback
    const appliedFontFamily = fontFamily ? _normalizeFontFamily(fontFamily, fallbackFont) : '';
    TabManager.tabs.forEach(t => {
        if (t.term) {
            if (appliedFontFamily) t.term.options.fontFamily = appliedFontFamily;
            t.term.options.fontSize = fontSize;
            t.term.options.lineHeight = lineHeight;
            t.term.options.fontWeight = fontWeight;
            t.term.options.fontWeightBold = fontWeightBold;
            t.term.options.minimumContrastRatio = minimumContrastRatio;
            if (t._smoothCursor) t._smoothCursor.setOptions({ animations });
        }
        if (t.splitRoot) {
            getAllPanes(t).forEach(p => {
                if (p.term) {
                    if (appliedFontFamily) p.term.options.fontFamily = appliedFontFamily;
                    p.term.options.fontSize = fontSize;
                    p.term.options.lineHeight = lineHeight;
                    p.term.options.fontWeight = fontWeight;
                    p.term.options.fontWeightBold = fontWeightBold;
                    p.term.options.minimumContrastRatio = minimumContrastRatio;
                    if (p._smoothCursor) p._smoothCursor.setOptions({ animations });
                }
            });
        }
    });
}

function saveTerminal() {
    const cursor = document.getElementById('set-cursor')?.value || 'bar';
    // Scrollback validation: xterm's option setter throws on a negative
    // value, which would abort every later terminal-settings hot-apply.
    // Reject the bad value instead: revert the input to the last valid
    // config value (default 10000), toast, and keep saving the remaining
    // fields — same policy as the invalid-accent check in saveAppearance.
    const sbEl = document.getElementById('set-scrollback');
    let scrollback = parseInt(sbEl?.value);
    if (!Number.isFinite(scrollback) || scrollback < 0) {
        const prev = parseInt(_settingsConfig.scrollback);
        scrollback = (Number.isFinite(prev) && prev >= 0) ? prev : 10000;
        if (sbEl) sbEl.value = String(scrollback);
        showToast('回滚行数需为不小于 0 的整数', true);
    }
    const bell = document.getElementById('set-bell')?.value || 'off';
    const cursorBlink = (document.getElementById('set-blink')?.value || 'on') === 'on';
    // Double-click word separators: the raw input string, verbatim (spaces,
    // quotes and backticks are literal separator characters, so no trim).
    // '' means "follow the vendored default" on the apply side below.
    const wordSeparators = _normalizeWordSeparators(document.getElementById('set-word-separators')?.value);
    const autoCopy = getToggle('toggle-autocopy');
    const rightClickPaste = getToggle('toggle-rightclick');
    const richTextCopy = getToggle('toggle-richtext');
    const smartCopy = getToggle('toggle-smartcopy');
    const osc52 = getToggle('toggle-osc52');
    const restoreLocalContent = getToggle('toggle-restore-local');
    const defaultShell = document.getElementById('set-default-shell')?.value || '';
    const startupDir = document.getElementById('set-startup-dir')?.value || '';
    const updateProxy = (document.getElementById('set-update-proxy')?.value || '').trim();
    const hiddenProfiles = (TabManager.profiles || [])
        .filter(p => { const el = document.getElementById('toggle-shell-' + p.id); return el && !el.classList.contains('on'); })
        .map(p => p.id);

    const config = { cursor, scrollback, bell, cursorBlink, wordSeparators, autoCopy, rightClickPaste, richTextCopy, smartCopy, osc52, restoreLocalContent, defaultShell, startupDir, updateProxy, hiddenProfiles };
    _settingsConfig = { ..._settingsConfig, ...config };
    persistSettings();

    TabManager.tabs.forEach(t => {
        if (t.term) {
            t.term.options.cursorBlink = cursorBlink;
            t.term.options.cursorStyle = cursor;
            t.term.options.scrollback = scrollback;
            // Word separators are read live from rawOptions at click time,
            // so the assignment takes effect on the next double-click without
            // a repaint. Assigning '' (setting cleared) resets to the vendored
            // default: xterm's option sanitizer substitutes its own default
            // for falsy values, so no hardcoded copy of the default is needed.
            t.term.options.wordSeparator = wordSeparators;
            if (t._smoothCursor) t._smoothCursor.setOptions({ cursorBlink, cursorStyle: cursor });
        }
        if (t.splitRoot) {
            getAllPanes(t).forEach(p => {
                if (p.term) {
                    p.term.options.cursorBlink = cursorBlink;
                    p.term.options.cursorStyle = cursor;
                    p.term.options.scrollback = scrollback;
                    p.term.options.wordSeparator = wordSeparators;
                    if (p._smoothCursor) p._smoothCursor.setOptions({ cursorBlink, cursorStyle: cursor });
                }
            });
        }
    });
}

function persistSettings() {
    const config = { ..._settingsConfig };
    ipcRenderer.send('save-appearance', {
        fontFamily: config.fontFamily,
        uiFont: config.uiFont,
        uiFallbackFont: config.uiFallbackFont,
        uiFollowTerminal: config.uiFollowTerminal,
        fontSize: config.fontSize,
        lineHeight: config.lineHeight,
        fontWeight: config.fontWeight,
        fontWeightBold: config.fontWeightBold,
        accentColor: config.accentColor,
        fallbackFont: config.fallbackFont,
        terminalScheme: config.terminalScheme,
        theme: 'dark',
        animations: config.animations,
        showStatusDot: config.showStatusDot,
        showStatusbar: config.showStatusbar,
        paneRing: config.paneRing,
        panelEdge: config.panelEdge,
        sftpMaterial: config.sftpMaterial,
        minimumContrastRatio: config.minimumContrastRatio,
    });
    ipcRenderer.send('save-terminal-settings', {
        cursor: config.cursor,
        scrollback: config.scrollback,
        bell: config.bell,
        cursorBlink: config.cursorBlink,
        wordSeparators: config.wordSeparators,
        autoCopy: config.autoCopy,
        rightClickPaste: config.rightClickPaste,
        richTextCopy: config.richTextCopy,
        smartCopy: config.smartCopy,
        osc52: config.osc52,
        restoreLocalContent: config.restoreLocalContent,
        defaultShell: config.defaultShell,
        startupDir: config.startupDir,
        updateProxy: config.updateProxy,
        hiddenProfiles: config.hiddenProfiles,
        qcAutoEnter: config.qcAutoEnter,
    });
}

async function loadSettings() {
    try {
        const full = await ipcRenderer.invoke('load-settings');
        if (full) {
            _settingsConfig = {
                ...(full.terminal || {}),
                ...(full.appearance || {}),
                shortcuts: full.shortcuts || {},
            };
            // Restore persisted statusbar visibility as soon as config is in
            if (typeof applyChromeFlags === 'function') applyChromeFlags();
            applyStatusbarVisibility();
            return;
        }
    } catch(e) { console.error('[loadSettings]', e); }
    _settingsConfig = { cursor: 'bar', scrollback: 10000, bell: 'off', cursorBlink: true, autoCopy: true, rightClickPaste: true, fontFamily: '"JetBrainsMonoNL NF", "HarmonyOS Sans SC", monospace', fontSize: 16, lineHeight: 1.125, fontWeight: '400', fontWeightBold: '600', accentColor: '#61afef', theme: 'dark', animations: true, showStatusDot: true, paneRing: false, panelEdge: true, sftpMaterial: true, restoreLocalContent: false, smartCopy: true, osc52: true, richTextCopy: false };
    if (typeof applyChromeFlags === 'function') applyChromeFlags();
    applyStatusbarVisibility();
}

