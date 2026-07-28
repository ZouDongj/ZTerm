// ZTerm - 全局状态 + 常量 + 配色（拆自 renderer.html，纯代码搬运，未改逻辑）
let CONFIG_FILE = path.join(process.env.APPDATA || process.env.HOME, 'ZTerm', 'config.json');

// ── PTY output → terminal (shared by PTY and SSH) ──
const ptyBuffers = {};
// ── Terminal color schemes ──
// 光标固定纯白、选中色跟随强调色（全应用统一），方案只定义背景/前景/16 色
const TERMINAL_SCHEMES = {
    onedark: {
        name: 'One Dark Pro',
        background:'#282c34', foreground:'#abb2bf',
        black:'#282c34', red:'#e06c75', green:'#98c379', yellow:'#e5c07b',
        blue:'#61afef', magenta:'#c678dd', cyan:'#56b6c2', white:'#abb2bf',
        brightBlack:'#545862', brightRed:'#e06c75', brightGreen:'#98c379', brightYellow:'#e5c07b',
        brightBlue:'#61afef', brightMagenta:'#c678dd', brightCyan:'#56b6c2', brightWhite:'#ffffff',
    },
    snazzy: {
        name: 'Snazzy',
        background:'#282a36', foreground:'#eff0eb',
        black:'#232323', red:'#ff5c57', green:'#5af78e', yellow:'#f3f99d',
        blue:'#57c7ff', magenta:'#ff6ac1', cyan:'#9aedfe', white:'#ffffff',
        brightBlack:'#444444', brightRed:'#ff5c57', brightGreen:'#5af78e', brightYellow:'#f3f99d',
        brightBlue:'#57c7ff', brightMagenta:'#ff6ac1', brightCyan:'#9aedfe', brightWhite:'#ffffff',
    },
    tokyonight: {
        name: 'Tokyo Night',
        background:'#1a1b26', foreground:'#c0caf5',
        black:'#15161e', red:'#f7768e', green:'#9ece6a', yellow:'#e0af68',
        blue:'#7aa2f7', magenta:'#bb9af7', cyan:'#7dcfff', white:'#a9b1d6',
        brightBlack:'#414868', brightRed:'#f7768e', brightGreen:'#9ece6a', brightYellow:'#e0af68',
        brightBlue:'#7aa2f7', brightMagenta:'#bb9af7', brightCyan:'#7dcfff', brightWhite:'#c0caf5',
    },
    catppuccin: {
        name: 'Catppuccin Mocha',
        background:'#1e1e2e', foreground:'#cdd6f4',
        black:'#45475a', red:'#f38ba8', green:'#a6e3a1', yellow:'#f9e2af',
        blue:'#89b4fa', magenta:'#f5c2e7', cyan:'#94e2d5', white:'#bac2de',
        brightBlack:'#585b70', brightRed:'#f38ba8', brightGreen:'#a6e3a1', brightYellow:'#f9e2af',
        brightBlue:'#89b4fa', brightMagenta:'#f5c2e7', brightCyan:'#94e2d5', brightWhite:'#e0e0f0',
    },
    gruvbox: {
        name: 'Gruvbox Dark',
        background:'#282828', foreground:'#ebdbb2',
        black:'#282828', red:'#cc241d', green:'#98971a', yellow:'#d79921',
        blue:'#458588', magenta:'#b16286', cyan:'#689d6a', white:'#a89984',
        brightBlack:'#928374', brightRed:'#fb4934', brightGreen:'#b8bb26', brightYellow:'#fabd2f',
        brightBlue:'#83a598', brightMagenta:'#d3869b', brightCyan:'#8ec07c', brightWhite:'#ebdbb2',
    },
    nord: {
        name: 'Nord',
        background:'#2e3440', foreground:'#d8dee9',
        black:'#3b4252', red:'#bf616a', green:'#a3be8c', yellow:'#ebcb8b',
        blue:'#81a1c1', magenta:'#b48ead', cyan:'#88c0d0', white:'#e5e9f0',
        brightBlack:'#4c566a', brightRed:'#bf616a', brightGreen:'#a3be8c', brightYellow:'#ebcb8b',
        brightBlue:'#81a1c1', brightMagenta:'#b48ead', brightCyan:'#8fbcbb', brightWhite:'#eceff4',
    },
    monokai: {
        name: 'Monokai',
        background:'#272822', foreground:'#f8f8f2',
        black:'#272822', red:'#f92672', green:'#a6e22e', yellow:'#f4bf75',
        blue:'#66d9ef', magenta:'#ae81ff', cyan:'#a1efe4', white:'#f8f8f2',
        brightBlack:'#75715e', brightRed:'#f92672', brightGreen:'#a6e22e', brightYellow:'#f4bf75',
        brightBlue:'#66d9ef', brightMagenta:'#ae81ff', brightCyan:'#a1efe4', brightWhite:'#f9f8f5',
    },
    ayu: {
        name: 'Ayu Dark',
        background:'#0a0e14', foreground:'#b3b1ad',
        black:'#01060e', red:'#ea6c73', green:'#91b362', yellow:'#f9af4f',
        blue:'#53bdfa', magenta:'#fae994', cyan:'#90e1c6', white:'#c7c7c7',
        brightBlack:'#686868', brightRed:'#f07178', brightGreen:'#c2d94c', brightYellow:'#ffb454',
        brightBlue:'#59c2ff', brightMagenta:'#ffee99', brightCyan:'#95e6cb', brightWhite:'#ffffff',
    },
    kanagawa: {
        name: 'Kanagawa Wave',
        background:'#1f1f28', foreground:'#dcd7ba',
        black:'#090618', red:'#c34043', green:'#76946a', yellow:'#c0a36e',
        blue:'#7e9cd8', magenta:'#957fb8', cyan:'#6a9589', white:'#c8c093',
        brightBlack:'#727169', brightRed:'#e82424', brightGreen:'#98bb6c', brightYellow:'#e6c384',
        brightBlue:'#7fb4ca', brightMagenta:'#938aa9', brightCyan:'#7aa89f', brightWhite:'#dcd7ba',
    },
    dracula: {
        name: 'Dracula',
        background:'#282a36', foreground:'#f8f8f2',
        black:'#21222c', red:'#ff5555', green:'#50fa7b', yellow:'#f1fa8c',
        blue:'#bd93f9', magenta:'#ff79c6', cyan:'#8be9fd', white:'#f8f8f2',
        brightBlack:'#6272a4', brightRed:'#ff5555', brightGreen:'#50fa7b', brightYellow:'#f1fa8c',
        brightBlue:'#bd93f9', brightMagenta:'#ff79c6', brightCyan:'#8be9fd', brightWhite:'#ffffff',
    },
    solarized: {
        name: 'Solarized Dark',
        background:'#002b36', foreground:'#839496',
        black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900',
        blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5',
        brightBlack:'#002b36', brightRed:'#cb4b16', brightGreen:'#586e75', brightYellow:'#657b83',
        brightBlue:'#839496', brightMagenta:'#6c71c4', brightCyan:'#93a1a1', brightWhite:'#fdf6e3',
    },
    campbell: {
        name: 'Campbell',
        background:'#0c0c0c', foreground:'#cccccc',
        black:'#0c0c0c', red:'#c50f1f', green:'#13a10e', yellow:'#c19c00',
        blue:'#0037da', magenta:'#881798', cyan:'#3a96dd', white:'#cccccc',
        brightBlack:'#767676', brightRed:'#e74856', brightGreen:'#16c60c', brightYellow:'#f9f1a5',
        brightBlue:'#3b78ff', brightMagenta:'#b4009e', brightCyan:'#61d6d6', brightWhite:'#f2f2f2',
    },
    campbellPowershell: {
        name: 'Campbell Powershell',
        background:'#012456', foreground:'#cccccc',
        black:'#0c0c0c', red:'#c50f1f', green:'#13a10e', yellow:'#c19c00',
        blue:'#0037da', magenta:'#881798', cyan:'#3a96dd', white:'#cccccc',
        brightBlack:'#767676', brightRed:'#e74856', brightGreen:'#16c60c', brightYellow:'#f9f1a5',
        brightBlue:'#3b78ff', brightMagenta:'#b4009e', brightCyan:'#61d6d6', brightWhite:'#f2f2f2',
    },
    oneHalfDark: {
        name: 'One Half Dark',
        background:'#282c34', foreground:'#dcdfe4',
        black:'#282c34', red:'#e06c75', green:'#98c379', yellow:'#e5c07b',
        blue:'#61afef', magenta:'#c678dd', cyan:'#56b6c2', white:'#dcdfe4',
        brightBlack:'#5a6374', brightRed:'#e06c75', brightGreen:'#98c379', brightYellow:'#e5c07b',
        brightBlue:'#61afef', brightMagenta:'#c678dd', brightCyan:'#56b6c2', brightWhite:'#dcdfe4',
    },
    oneHalfLight: {
        name: 'One Half Light',
        background:'#fafafa', foreground:'#383a42',
        black:'#383a42', red:'#e45649', green:'#50a14f', yellow:'#c18301',
        blue:'#0184bc', magenta:'#a626a4', cyan:'#0997b3', white:'#fafafa',
        brightBlack:'#4f525d', brightRed:'#df6c75', brightGreen:'#98c379', brightYellow:'#e4c07a',
        brightBlue:'#61afef', brightMagenta:'#c577dd', brightCyan:'#56b5c1', brightWhite:'#ffffff',
    },
    solarizedLight: {
        name: 'Solarized Light',
        background:'#fdf6e3', foreground:'#657b83',
        black:'#002b36', red:'#dc322f', green:'#859900', yellow:'#b58900',
        blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5',
        brightBlack:'#073642', brightRed:'#cb4b16', brightGreen:'#586e75', brightYellow:'#657b83',
        brightBlue:'#839496', brightMagenta:'#6c71c4', brightCyan:'#93a1a1', brightWhite:'#fdf6e3',
    },
    tangoDark: {
        name: 'Tango Dark',
        background:'#000000', foreground:'#d3d7cf',
        black:'#000000', red:'#cc0000', green:'#4e9a06', yellow:'#c4a000',
        blue:'#3465a4', magenta:'#75507b', cyan:'#06989a', white:'#d3d7cf',
        brightBlack:'#555753', brightRed:'#ef2929', brightGreen:'#8ae234', brightYellow:'#fce94f',
        brightBlue:'#729fcf', brightMagenta:'#ad7fa8', brightCyan:'#34e2e2', brightWhite:'#eeeec',
    },
    tangoLight: {
        name: 'Tango Light',
        background:'#ffffff', foreground:'#555753',
        black:'#000000', red:'#cc0000', green:'#4e9a06', yellow:'#c4a000',
        blue:'#3465a4', magenta:'#75507b', cyan:'#06989a', white:'#d3d7cf',
        brightBlack:'#555753', brightRed:'#ef2929', brightGreen:'#8ae234', brightYellow:'#fce94f',
        brightBlue:'#729fcf', brightMagenta:'#ad7fa8', brightCyan:'#34e2e2', brightWhite:'#eeeec',
    },
    darkPlus: {
        name: 'Dark+',
        background:'#1e1e1e', foreground:'#cccccc',
        black:'#000000', red:'#cd3131', green:'#0dbc79', yellow:'#e5e510',
        blue:'#2472c8', magenta:'#bc3fbc', cyan:'#11a8cd', white:'#e5e5e5',
        brightBlack:'#666666', brightRed:'#f14c4c', brightGreen:'#23d18b', brightYellow:'#f5f543',
        brightBlue:'#3b8eea', brightMagenta:'#d670d6', brightCyan:'#29b8db', brightWhite:'#e5e5e5',
    },
    vscodeDarkModern: {
        name: 'VSCode Dark Modern',
        background:'#1f1f1f', foreground:'#cccccc',
        black:'#000000', red:'#cd3131', green:'#0dbc79', yellow:'#e5e510',
        blue:'#2472c8', magenta:'#bc3fbc', cyan:'#11a8cd', white:'#e5e5e5',
        brightBlack:'#666666', brightRed:'#f14c4c', brightGreen:'#23d18b', brightYellow:'#f5f543',
        brightBlue:'#3b8eea', brightMagenta:'#d670d6', brightCyan:'#29b8db', brightWhite:'#e5e5e5',
    },
    vscodeLightModern: {
        name: 'VSCode Light Modern',
        background:'#ffffff', foreground:'#3b3b3b',
        black:'#000000', red:'#cd3131', green:'#00bc00', yellow:'#949800',
        blue:'#0451a5', magenta:'#bc05bc', cyan:'#0598bc', white:'#555555',
        brightBlack:'#666666', brightRed:'#cd3131', brightGreen:'#14ce14', brightYellow:'#b5ba00',
        brightBlue:'#0451a5', brightMagenta:'#bc05bc', brightCyan:'#0598bc', brightWhite:'#a5a5a5',
    },
    vintage: {
        name: 'Vintage',
        background:'#000000', foreground:'#c0c0c0',
        black:'#000000', red:'#800000', green:'#008000', yellow:'#808000',
        blue:'#000080', magenta:'#800080', cyan:'#008080', white:'#c0c0c0',
        brightBlack:'#808080', brightRed:'#ff0000', brightGreen:'#00ff00', brightYellow:'#ffff00',
        brightBlue:'#0000ff', brightMagenta:'#ff00ff', brightCyan:'#00ffff', brightWhite:'#ffffff',
    },
    dimidium: {
        name: 'Dimidium',
        background:'#141414', foreground:'#bab7b6',
        black:'#000000', red:'#cf494c', green:'#60b442', yellow:'#db9c11',
        blue:'#0575d8', magenta:'#af5ed2', cyan:'#1db6bb', white:'#bab7b6',
        brightBlack:'#817e7e', brightRed:'#ff643b', brightGreen:'#37e57b', brightYellow:'#fccd1a',
        brightBlue:'#688dfd', brightMagenta:'#ed6fe9', brightCyan:'#32e0fb', brightWhite:'#dee3e4',
    },
    cga: {
        name: 'CGA',
        background:'#000000', foreground:'#aaaaaa',
        black:'#000000', red:'#aa0000', green:'#00aa00', yellow:'#aa5500',
        blue:'#0000aa', magenta:'#aa00aa', cyan:'#00aaaa', white:'#aaaaaa',
        brightBlack:'#555555', brightRed:'#ff5555', brightGreen:'#55ff55', brightYellow:'#ffff55',
        brightBlue:'#5555ff', brightMagenta:'#ff55ff', brightCyan:'#55ffff', brightWhite:'#ffffff',
    },
    ibm5153: {
        name: 'IBM 5153',
        background:'#000000', foreground:'#aaaaaa',
        black:'#000000', red:'#aa0000', green:'#00aa00', yellow:'#c47e00',
        blue:'#0000aa', magenta:'#aa00aa', cyan:'#00aaaa', white:'#aaaaaa',
        brightBlack:'#555555', brightRed:'#ff5555', brightGreen:'#55ff55', brightYellow:'#ffff55',
        brightBlue:'#5555ff', brightMagenta:'#ff55ff', brightCyan:'#55ffff', brightWhite:'#ffffff',
    },
};

function populateTerminalSchemeSelect(selectEl, currentKey) {
    if (selectEl.options.length === 0) {
        for (const [key, scheme] of Object.entries(TERMINAL_SCHEMES)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = scheme.name;
            selectEl.appendChild(opt);
        }
    }
    selectEl.value = currentKey || 'onedark';
}

function getTerminalScheme() {
    const key = _settingsConfig.terminalScheme || _settingsConfig.theme || 'onedark';
    return TERMINAL_SCHEMES[key] || TERMINAL_SCHEMES.onedark;
}

function getTerminalTheme() {
    const s = getTerminalScheme();
    return {
        background: s.background, foreground: s.foreground, cursor: '#ffffff',
        selectionBackground: _getAccentColorAlpha(0.3),
        black:s.black, red:s.red, green:s.green, yellow:s.yellow,
        blue:s.blue, magenta:s.magenta, cyan:s.cyan, white:s.white,
        brightBlack:s.brightBlack, brightRed:s.brightRed, brightGreen:s.brightGreen,
        brightYellow:s.brightYellow, brightBlue:s.brightBlue, brightMagenta:s.brightMagenta,
        brightCyan:s.brightCyan, brightWhite:s.brightWhite,
    };
}

// 热应用配色方案：更新所有已打开终端 + 终端容器背景变量
function applyTerminalScheme() {
    const theme = getTerminalTheme();
    document.documentElement.style.setProperty('--term-bg', theme.background);
    TabManager.tabs.forEach(t => {
        if (t.term) t.term.options.theme = theme;
        if (t.splitRoot) {
            getAllPanes(t).forEach(p => { if (p.term) p.term.options.theme = theme; });
        }
    });
}

let _settingsConfig = {};
function updateAccentDot() {
    const input = document.getElementById('set-accent');
    const dot = document.getElementById('accent-dot');
    if (input && dot) dot.style.background = input.value;
    // Sync swatch active states with current input value
    const hex = input ? input.value : '';
    document.querySelectorAll('.accent-swatch').forEach(sw => {
        sw.classList.toggle('active', sw.getAttribute('data-color').toUpperCase() === hex.replace('#', '').toUpperCase());
    });
    // Apply accent color to UI via CSS variable
    applyAccentColor(input ? input.value : '#61afef');
}

function applyAccentColor(hex) {
    // Parse hex to RGB and set CSS variable
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return;
    const int = parseInt(m[1], 16);
    const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
    document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
    // Compute contrast color (dark text on light accent, light text on dark accent)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const contrast = luminance > 0.5 ? '#1d1b20' : '#ffffff';
    document.documentElement.style.setProperty('--accent-contrast', contrast);
}

