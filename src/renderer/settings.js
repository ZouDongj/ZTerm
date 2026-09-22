// ZTerm - 设置页主体 + 自定义下拉 + 取色盘（颜色转换纯函数见 color-utils.js，由 renderer.html 先加载）

// ── Custom dropdown (replaces native <select class="styled-select">) ──
function convertSelects() {
    document.querySelectorAll('select.styled-select').forEach(sel => {
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
    // Same renderer as the standalone manager overlay (ssh.js): identical row
    // content, actions and visual hierarchy
    renderSSHManagerInto(document.getElementById('settings-ssh-list'), _sshMgrView('settings-ssh-list'));
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
    const contrastEl = document.getElementById('set-contrast');
    if (contrastEl && config.minimumContrastRatio) contrastEl.value = config.minimumContrastRatio;
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

// Color conversion helpers（实现见 color-utils.js）

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

        // Populate UI font dropdown（界面字体，默认系统字体栈）
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
            // 配置的字体不在枚举列表里 → 追加一个选项保留配置
            if (current && ![...uiFontEl.options].some(o => o.value === current)) {
                const extra = document.createElement('option');
                extra.value = current;
                extra.textContent = current.replace(/'/g, '').replace(/,sans-serif$/, '');
                uiFontEl.appendChild(extra);
            }
            if (current) uiFontEl.value = current;
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

        // 同步界面字体跟随开关状态与行可见性
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

// 界面字体默认值：系统字体栈（不依赖外部字体，内网/离线环境稳定）
const DEFAULT_UI_FONT = "'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif";

// 界面字体跟随终端字体开关：开启时界面复用终端字体组合，隐藏界面字体设置
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

// 应用界面字体到 body：
// 跟随终端 → 终端字体 + 终端回退组合；独立 → 界面字体 + 界面回退组合
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

// 字重校验：1-1000 的数字（xterm 只接受 number 1-1000 或 'normal'/'bold'/'100'..'900' 整百字符串，
// 数字字符串如 '550' 会被静默打回默认值——所以这里必须返回 number）
function saveAppearance() {
    const fontFamily = document.getElementById('set-font')?.value || '';
    const uiFont = document.getElementById('set-ui-font')?.value || _settingsConfig.uiFont || '';
    const uiFallbackFont = document.getElementById('set-ui-fallback-font')?.value || _settingsConfig.uiFallbackFont || '';
    const fontSize = parseFloat(document.getElementById('set-font-size')?.value) || 16;
    const lineHeight = parseFloat(document.getElementById('set-line-height')?.value) || 1.125;
    const fontWeight = _clampFontWeight(document.getElementById('set-font-weight')?.value, '400');
    const fontWeightBold = _clampFontWeight(document.getElementById('set-font-weight-bold')?.value, '600');
    const accentColor = document.getElementById('set-accent')?.value || '#61afef';
    const fallbackFont = document.getElementById('set-fallback-font')?.value || '';
    updateAccentDot();
    const animations = getToggle('toggle-animations');
    const showStatusDot = getToggle('toggle-statusdot');
    const terminalScheme = document.getElementById('set-terminal-scheme')?.value || 'onedark';
    const minimumContrastRatio = parseFloat(document.getElementById('set-contrast')?.value) || 4;

    const config = { fontFamily, uiFont, uiFallbackFont, fontSize, lineHeight, fontWeight, fontWeightBold, accentColor, fallbackFont, animations, showStatusDot, terminalScheme, minimumContrastRatio, theme: 'dark' };
    _settingsConfig = { ..._settingsConfig, ...config };
    persistSettings();
    applyUiFont();

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
            if (t._smoothCursor) t._smoothCursor.setOptions({ cursorBlink, cursorStyle: cursor });
        }
        if (t.splitRoot) {
            getAllPanes(t).forEach(p => {
                if (p.term) {
                    p.term.options.cursorBlink = cursorBlink;
                    p.term.options.cursorStyle = cursor;
                    p.term.options.scrollback = scrollback;
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
        minimumContrastRatio: config.minimumContrastRatio,
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
            applyStatusbarVisibility();
            return;
        }
    } catch(e) { console.error('[loadSettings]', e); }
    _settingsConfig = { cursor: 'bar', scrollback: 10000, bell: 'off', cursorBlink: true, autoCopy: true, rightClickPaste: true, fontFamily: '"JetBrainsMonoNL NF", "HarmonyOS Sans SC", monospace', fontSize: 16, lineHeight: 1.125, fontWeight: '400', fontWeightBold: '600', accentColor: '#61afef', theme: 'dark', animations: true, showStatusDot: true, restoreLocalContent: false, smartCopy: true, osc52: true, richTextCopy: false };
    applyStatusbarVisibility();
}

