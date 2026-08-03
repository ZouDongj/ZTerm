// 命令面板 — 列出全部快捷键操作，搜索 + 键盘导航 + 回车执行
let _paletteSelected = 0;

// action 显示顺序（语义序：标签页 → 分屏 → SSH → 搜索 → 设置/快捷命令）
const _paletteOrder = [
    'newTab', 'closeTab', 'nextTab', 'prevTab', 'renameTab', 'cloneTab',
    'closePane', 'splitH', 'splitV', 'maximizePane',
    'extractPane', 'nextPane', 'prevPane', 'syncInput',
    'sshPanel', 'sftp',
    'search', 'openSettings', 'quickCommands'
];

function openPalette() {
    document.getElementById('overlay-palette').classList.add('open');
    _paletteSelected = 0;
    renderPaletteList();
    setTimeout(() => {
        const inp = document.getElementById('palette-input');
        if (inp) { inp.value = ''; inp.focus(); }
    }, 50);
}

function closePalette() {
    document.getElementById('overlay-palette').classList.remove('open');
}

function renderPaletteList(filter = '') {
    const list = document.getElementById('palette-list');
    const empty = document.getElementById('palette-empty');
    if (!list) return;
    const q = filter.toLowerCase();
    const bindings = typeof _getShortcutBindings === 'function' ? _getShortcutBindings() : {};

    const visibleIds = _paletteOrder.filter(id => {
        if (!q) return true;
        const label = (typeof SHORTCUT_LABELS !== 'undefined' ? SHORTCUT_LABELS[id] : '') || '';
        const shortcut = (bindings[id] || '').toLowerCase();
        return label.toLowerCase().includes(q) || shortcut.includes(q);
    });

    if (visibleIds.length === 0) {
        list.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    let html = '';
    visibleIds.forEach((id, i) => {
        const label = (typeof SHORTCUT_LABELS !== 'undefined' ? SHORTCUT_LABELS[id] : id) || id;
        const combo = bindings[id] || '';
        const comboDisplay = typeof _comboDisplay === 'function' ? _comboDisplay(combo) : combo;
        const sel = i === _paletteSelected ? ' data-selected' : '';
        html += `<div class="qc-item"${sel} data-action-id="${id}"
                  onclick="paletteClickItem('${id}')"
                  onmouseenter="paletteSelect(${i})">
                  <span class="qc-item-name">${escHtml(label)}</span>
                  ${comboDisplay ? `<span style="margin-left:auto;font-size:10px;color:rgba(171,178,191,0.45);font-family:'JetBrains Mono',monospace">${escHtml(comboDisplay)}</span>` : ''}
                </div>`;
    });
    list.innerHTML = html;
}

function paletteSelect(i) {
    _paletteSelected = i;
    const items = document.querySelectorAll('#palette-list .qc-item');
    items.forEach((el, idx) => {
        if (idx === i) {
            el.setAttribute('data-selected', '');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.removeAttribute('data-selected');
        }
    });
}

function paletteFilter() {
    const inp = document.getElementById('palette-input');
    const q = inp ? inp.value : '';
    _paletteSelected = 0;
    renderPaletteList(q);
}

function paletteKeyDown(e) {
    const inp = document.getElementById('palette-input');
    const q = inp ? inp.value.toLowerCase() : '';
    const bindings = typeof _getShortcutBindings === 'function' ? _getShortcutBindings() : {};

    const visibleIds = _paletteOrder.filter(id => {
        if (!q) return true;
        const label = (typeof SHORTCUT_LABELS !== 'undefined' ? SHORTCUT_LABELS[id] : '') || '';
        const shortcut = (bindings[id] || '').toLowerCase();
        return label.toLowerCase().includes(q) || shortcut.includes(q);
    });

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const n = Math.max(visibleIds.length, 1);
        _paletteSelected = (_paletteSelected + 1) % n;
        paletteSelect(_paletteSelected);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const n = Math.max(visibleIds.length, 1);
        _paletteSelected = (_paletteSelected - 1 + n) % n;
        paletteSelect(_paletteSelected);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const id = visibleIds[_paletteSelected];
        if (id && typeof SHORTCUT_ACTIONS !== 'undefined' && SHORTCUT_ACTIONS[id]) {
            closePalette();
            SHORTCUT_ACTIONS[id]();
        }
    } else if (e.key === 'Escape') {
        closePalette();
    }
}

function paletteClickItem(id) {
    closePalette();
    if (typeof SHORTCUT_ACTIONS !== 'undefined' && SHORTCUT_ACTIONS[id]) {
        SHORTCUT_ACTIONS[id]();
    }
}
