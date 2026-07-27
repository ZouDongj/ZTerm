// ZTerm - 设置页主体 + 自定义下拉 + 取色盘（拆自 renderer.html，纯代码搬运，未改逻辑）

// ── Custom dropdown (replaces native <select class="styled-select">) ──
function convertSelects() {
    document.querySelectorAll('select.styled-select').forEach(sel => {
        // Remove existing custom dropdown wrapper if present (so we can rebuild with new options)
        const existingWrapper = sel.parentNode && sel.parentNode.querySelector('.cust-dropdown');
        if (existingWrapper) existingWrapper.remove();

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

// Close custom dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.cust-dropdown')) {
        document.querySelectorAll('.cust-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});


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
        if (page === 'about') { loadDataDirInfo(); loadAboutInfo(); }
        // Convert selects
        setTimeout(convertSelects, 50);
    }
}

function renderSSHManagerInSettings() {
    const list = document.getElementById('settings-ssh-list');
    if (!list) return;
    const groups = getSSHGroups();
    const groupNames = Object.keys(groups);
    if (groupNames.length === 0) {
        list.innerHTML = '<div style="padding:30px;text-align:center;color:rgba(171,178,191,0.3);font-size:13px">暂无 SSH 连接</div>';
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
}

function toggleSwitch(el) {
    el.classList.toggle('on');
}

function loadSettingsIntoForm() {
    const config = _settingsConfig;
    // Terminal
    const cursorEl = document.getElementById('set-cursor');
    if (cursorEl) cursorEl.value = config.cursor || 'bar';
    const sbEl = document.getElementById('set-scrollback');
    if (sbEl) sbEl.value = config.scrollback || 10000;
    const bellEl = document.getElementById('set-bell');
    if (bellEl) bellEl.value = config.bell || 'off';
    const blinkEl = document.getElementById('set-blink');
    if (blinkEl) blinkEl.value = config.cursorBlink !== false ? 'on' : 'off';
    // Local shell defaults（选项来自自动探测的 profiles）
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
    // Shell visibility in session selector（每个本地终端一行开关）
    const svEl = document.getElementById('shell-visibility-list');
    if (svEl) {
        const hidden = config.hiddenProfiles || [];
        svEl.innerHTML = (TabManager.profiles || []).map(p => `
              <div class="settings-row">
                <div class="settings-card-label">
                  <div class="settings-card-title">${escHtml(p.name)}</div>
                  <div class="settings-card-desc">在新建会话列表中显示</div>
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
    if (fontSizeEl && config.fontSize) fontSizeEl.value = config.fontSize;
    const lhEl = document.getElementById('set-line-height');
    if (lhEl && config.lineHeight) lhEl.value = config.lineHeight;
    const fwEl = document.getElementById('set-font-weight');
    if (fwEl) fwEl.value = config.fontWeight || '400';
    const fwbEl = document.getElementById('set-font-weight-bold');
    if (fwbEl) fwbEl.value = config.fontWeightBold || '700';
    const fallbackEl = document.getElementById('set-fallback-font');
    if (fallbackEl && config.fallbackFont) fallbackEl.value = config.fallbackFont;
    const schemeEl = document.getElementById('set-terminal-scheme');
    if (schemeEl && config.terminalScheme) schemeEl.value = config.terminalScheme;
    const accentInput = document.getElementById('set-accent');
    if (accentInput && config.accentColor) {
        accentInput.value = config.accentColor;
        updateAccentDot();
    }
    setToggle('toggle-animations', config.animations !== false);
    setToggle('toggle-statusdot', config.showStatusDot !== false);
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
        updateAccentDot();
        saveAppearance();
        // Update swatch active states
        document.querySelectorAll('.accent-swatch').forEach(sw => {
            sw.classList.toggle('active', sw.getAttribute('data-color').toUpperCase() === hex.replace('#', '').toUpperCase());
        });
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
            const r = parseInt(document.getElementById('cp-r').value) || 0;
            const g = parseInt(document.getElementById('cp-g').value) || 0;
            const b = parseInt(document.getElementById('cp-b').value) || 0;
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

// Color conversion helpers
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const int = parseInt(m[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb(h, s, v) {
    h = h / 60;
    const i = Math.floor(h), f = h - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    let r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function selectAccent(hex) {
    const input = document.getElementById('set-accent');
    if (input) {
        input.value = hex;
        updateAccentDot();
        saveAppearance();
        // Update swatch active states
        document.querySelectorAll('.accent-swatch').forEach(sw => {
            sw.classList.toggle('active', sw.getAttribute('data-color').toUpperCase() === hex.replace('#', '').toUpperCase());
        });
    }
}

function renderAccentSwatches() {
    const container = document.getElementById('accent-swatches');
    if (!container) return;
    const colors = ['#61afef', '#9CA3FF', '#8BC4FF', '#A8DAB5', '#FFB74D', '#F2B8B5', '#abb2bf', '#87CEEB'];
    const current = document.getElementById('set-accent')?.value || '#61afef';
    container.innerHTML = '';
    colors.forEach(c => {
        const sw = document.createElement('div');
        sw.className = 'accent-swatch';
        sw.style.background = c;
        sw.style.color = c;
        sw.setAttribute('data-color', c.replace('#', ''));
        sw.title = c;
        sw.onclick = () => selectAccent(c);
        if (c.toUpperCase() === current.toUpperCase()) sw.classList.add('active');
        container.appendChild(sw);
    });
}

function populateFontList() {
    // Fetch all system fonts from main process (fontmanager-redux)
    ipcRenderer.invoke('get-system-fonts').then(fonts => {
        const allFonts = fonts && fonts.length > 0 ? fonts : ['monospace'];

        // Populate terminal font dropdown with ALL system fonts
        // 恢复值以 _settingsConfig 为准：首次打开设置页时 select 还是空的，
        // select.value 已丢失配置值，从配置恢复才能保证后续 saveAppearance 读到正确值
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
            // 配置的字体不在枚举列表里（已卸载？）→ 追加一个选项保留配置，避免被覆盖
            if (current && ![...fontEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current.replace(/'/g, '').replace(/,monospace$/, '');
                fontEl.appendChild(extra);
            }
            if (current) fontEl.value = current;
        }

        // Populate fallback font dropdown with ALL system fonts
        const fallbackEl = document.getElementById('set-fallback-font');
        if (fallbackEl) {
            const current = _settingsConfig.fallbackFont !== undefined ? _settingsConfig.fallbackFont : fallbackEl.value;
            fallbackEl.innerHTML = '';
            allFonts.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f;
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
    });
}

// 字重校验：1-1000 的数字（xterm 只接受 number 1-1000 或 'normal'/'bold'/'100'..'900' 整百字符串，
// 数字字符串如 '550' 会被静默打回默认值——所以这里必须返回 number）
function saveAppearance() {
    const fontFamily = document.getElementById('set-font')?.value || '';
    const fontSize = parseFloat(document.getElementById('set-font-size')?.value) || 13.5;
    const lineHeight = parseFloat(document.getElementById('set-line-height')?.value) || 1.6;
    const fontWeight = _clampFontWeight(document.getElementById('set-font-weight')?.value, '400');
    const fontWeightBold = _clampFontWeight(document.getElementById('set-font-weight-bold')?.value, '700');
    const accentColor = document.getElementById('set-accent')?.value || '#61afef';
    const fallbackFont = document.getElementById('set-fallback-font')?.value || '';
    updateAccentDot();
    const animations = getToggle('toggle-animations');
    const showStatusDot = getToggle('toggle-statusdot');
    const terminalScheme = document.getElementById('set-terminal-scheme')?.value || 'onedark';

    const config = { fontFamily, fontSize, lineHeight, fontWeight, fontWeightBold, accentColor, fallbackFont, animations, showStatusDot, terminalScheme, theme: 'dark' };
    _settingsConfig = { ..._settingsConfig, ...config };
    persistSettings();

    // Apply animations setting
    const winEl = document.querySelector('.window');
    if (winEl) winEl.classList.toggle('no-animations', animations === false);

    // Apply status dot setting
    TabManager.render();

    // Apply terminal color scheme (all terminals + container background)
    applyTerminalScheme();

    // Apply font settings to existing terminals
    // 必须走与启动相同的引号规范化，否则未加引号的 monospace 会变成 CSS 通用关键字，改变 CJK 回退
    const appliedFontFamily = fontFamily ? _normalizeFontFamily(fontFamily, fallbackFont) : '';
    TabManager.tabs.forEach(t => {
        if (t.term) {
            if (appliedFontFamily) t.term.options.fontFamily = appliedFontFamily;
            t.term.options.fontSize = fontSize;
            t.term.options.lineHeight = lineHeight;
            t.term.options.fontWeight = fontWeight;
            t.term.options.fontWeightBold = fontWeightBold;
        }
        if (t.splitRoot) {
            getAllPanes(t).forEach(p => {
                if (p.term) {
                    if (appliedFontFamily) p.term.options.fontFamily = appliedFontFamily;
                    p.term.options.fontSize = fontSize;
                    p.term.options.lineHeight = lineHeight;
                    p.term.options.fontWeight = fontWeight;
                    p.term.options.fontWeightBold = fontWeightBold;
                }
            });
        }
    });
}

function saveTerminal() {
    const cursor = document.getElementById('set-cursor')?.value || 'bar';
    const scrollback = parseInt(document.getElementById('set-scrollback')?.value) || 10000;
    const bell = document.getElementById('set-bell')?.value || 'off';
    const cursorBlink = (document.getElementById('set-blink')?.value || 'on') === 'on';
    const autoCopy = getToggle('toggle-autocopy');
    const rightClickPaste = getToggle('toggle-rightclick');
    const richTextCopy = getToggle('toggle-richtext');
    const smartCopy = getToggle('toggle-smartcopy');
    const osc52 = getToggle('toggle-osc52');
    const restoreLocalContent = getToggle('toggle-restore-local');
    const defaultShell = document.getElementById('set-default-shell')?.value || '';
    const startupDir = document.getElementById('set-startup-dir')?.value || '';
    const hiddenProfiles = (TabManager.profiles || [])
        .filter(p => { const el = document.getElementById('toggle-shell-' + p.id); return el && !el.classList.contains('on'); })
        .map(p => p.id);

    const config = { cursor, scrollback, bell, cursorBlink, autoCopy, rightClickPaste, richTextCopy, smartCopy, osc52, restoreLocalContent, defaultShell, startupDir, hiddenProfiles };
    _settingsConfig = { ..._settingsConfig, ...config };
    persistSettings();

    TabManager.tabs.forEach(t => {
        if (t.term) {
            t.term.options.cursorBlink = cursorBlink;
            t.term.options.cursorStyle = cursor;
            t.term.options.scrollback = scrollback;
        }
    });
}

function persistSettings() {
    const config = { ..._settingsConfig };
    ipcRenderer.send('save-appearance', {
        fontFamily: config.fontFamily,
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
    });
    ipcRenderer.send('save-terminal-settings', {
        cursor: config.cursor,
        scrollback: config.scrollback,
        bell: config.bell,
        cursorBlink: config.cursorBlink,
        autoCopy: config.autoCopy,
        rightClickPaste: config.rightClickPaste,
        richTextCopy: config.richTextCopy,
        smartCopy: config.smartCopy,
        osc52: config.osc52,
        restoreLocalContent: config.restoreLocalContent,
        defaultShell: config.defaultShell,
        startupDir: config.startupDir,
        hiddenProfiles: config.hiddenProfiles,
    });
}

function loadSettings() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const full = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            _settingsConfig = {
                ...(full.terminal || {}),
                ...(full.appearance || {}),
                shortcuts: full.shortcuts || {},
            };
            return;
        }
    } catch(e) {}
    _settingsConfig = { cursor: 'bar', scrollback: 10000, bell: 'off', cursorBlink: true, autoCopy: true, rightClickPaste: true, fontFamily: '"JetBrains Mono","Cascadia Code",Consolas,monospace', fontSize: 14, lineHeight: 1.6, fontWeight: '450', fontWeightBold: '700', accentColor: '#61afef', theme: 'dark', animations: true, showStatusDot: true, restoreLocalContent: false, smartCopy: true, osc52: true, richTextCopy: false };
}

