// ZTerm - 通用工具（拆自 renderer.html，纯代码搬运，未改逻辑）
const { ipcRenderer, shell, webUtils } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebglAddon } = require('@xterm/addon-webgl');
const { SearchAddon } = require('@xterm/addon-search');
const { ClipboardAddon } = require('@xterm/addon-clipboard');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const fs = require('fs');
const path = require('path');
// ── Global error hooks（异常进控制台，不静默）──
window.addEventListener('error', e => { console.error('[ZTerm]', e.message, e.filename + ':' + e.lineno); });
window.addEventListener('unhandledrejection', e => { console.error('[ZTerm] unhandled rejection:', e.reason); });

// ── Toast ──
function showToast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.classList.add('show');
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Overlay helpers ──
function closeAllOverlays() {
    document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
}

function closeOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
}

function openOverlay(id) {
    closeAllOverlays();
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(ts) {
    // 兼容秒（SFTP mtime）和毫秒（Date.now()）
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    if (isNaN(d.getTime())) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
}

function sftpRefresh() { SFTP.refresh(); }
function sftpGoUp() { SFTP.goUp(); }
function sftpClose() { SFTP.close(); }
function sftpUpload() { SFTP.upload(); }
function sftpMkdir() { SFTP.mkdir(); }

// HTML 文本节点转义（只转义 & < >，文本节点中引号无特殊含义）
function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// HTML 属性值转义（转义 & < > " '，用于 title="..." 等属性上下文）
function escAttr(s) { return escHtml(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// 单引号 JS 字符串转义（转义 ' \ 和换行，用于 onclick='fn("...")' 内嵌字符串上下文）
// 防止用户可控数据闭合单引号注入任意 JS（XSS）
function escJsString(s) { return (s || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r'); }

function showConfirm(msg, onOk) {
    document.getElementById('confirm-msg').textContent = msg;
    const overlay = document.getElementById('overlay-confirm');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');

    const cleanup = () => {
        overlay.classList.remove('open');
        cancelBtn.removeEventListener('click', onCancel);
        okBtn.removeEventListener('click', onOkClick);
        overlay.querySelector('.overlay-backdrop').removeEventListener('click', onCancel);
    };
    const onCancel = () => cleanup();
    const onOkClick = () => { cleanup(); onOk(); };

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOkClick);
    overlay.querySelector('.overlay-backdrop').addEventListener('click', onCancel);
    overlay.classList.add('open');
}

// ── Smart copy helpers ──
function _stripSoftWrap(text, term) {
    // xterm.js soft-wrapped lines end with a space when selected
    // Join lines that were soft-wrapped (no actual newline in the source)
    try {
        const lines = text.split('\n');
        const result = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // If line ends with space and next line exists, it might be a soft wrap
            if (i < lines.length - 1 && line.endsWith(' ') && lines[i + 1].length > 0) {
                // Check if this is actually a soft wrap by looking at the terminal buffer
                result.push(line.slice(0, -1)); // Remove trailing space
            } else {
                result.push(line);
                if (i < lines.length - 1) result.push('\n');
            }
        }
        return result.join('');
    } catch(e) {
        return text;
    }
}

function _ansiToHtml(text, term) {
    // Convert ANSI escape sequences to HTML with inline styles
    // This is a simplified version - full ANSI parsing would be more complex
    try {
        const theme = getTerminalTheme();
        let html = '<div style="font-family:monospace;white-space:pre;background:' + theme.background + ';color:' + theme.foreground + '">';
        // For now, just escape HTML and wrap in a styled div
        // A full implementation would parse ANSI codes and convert to spans
        html += text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        html += '</div>';
        return html;
    } catch(e) {
        return text;
    }
}

// ── Build terminal options from settings ──
function _getAccentColor() {
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    return rgb ? 'rgb(' + rgb + ')' : '#61afef';
}

function _getAccentColorAlpha(alpha) {
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    return rgb ? 'rgba(' + rgb + ',' + alpha + ')' : 'rgba(97,175,239,' + alpha + ')';
}

// Ctrl+Click 打开链接（http/https/ftp/mailto），其余协议不打开
function _createWebLinksAddon() {
    return new WebLinksAddon((event, uri) => {
        if (/^(https?|ftp|mailto):/i.test(uri)) shell.openExternal(uri);
    }, { requireModifier: true });
}

// 规范化 fontFamily：字体名加引号（带空格的必须引号），
// CSS 通用字体族关键字（monospace/serif/sans-serif 等）不加引号。
// 关键：fallback 字体（通常是 CJK 字体）必须插在通用关键字 *之前*，
// 否则 monospace 会截胡（Windows 上 monospace 默认映射到宋体），
// 导致中文回退到宋体而不是用户指定的 fallback 字体。
// 启动（_buildTerminalOptions）和设置页热更新（saveAppearance）必须走同一逻辑
const _GENERIC_FONT_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji',
    'math', 'fangsong', 'inherit', 'initial', 'revert', 'unset',
]);
function _normalizeFontFamily(fontFamily, fallbackFont) {
    const quote = (name) => {
        const t = (name || '').trim();
        if (!t) return '';
        if (t.startsWith('"') || t.startsWith("'")) return t;
        if (_GENERIC_FONT_FAMILIES.has(t.toLowerCase())) return t; // 通用关键字不加引号
        return '"' + t + '"';
    };
    let parts = (fontFamily || '').split(',').map(quote).filter(Boolean);
    if (fallbackFont) {
        const fb = quote(fallbackFont);
        // 插在第一个通用关键字之前，避免 monospace 等截胡 CJK 回退
        const idx = parts.findIndex(p => _GENERIC_FONT_FAMILIES.has(p.toLowerCase()));
        if (idx === -1) parts.push(fb);
        else parts.splice(idx, 0, fb);
    }
    return parts.join(',');
}

// Extract the first font name from a CSS font-family string for display
function _firstFontName(fontFamily) {
    if (!fontFamily) return '';
    const first = fontFamily.split(',')[0].trim();
    if ((first.startsWith('"') && first.endsWith('"')) ||
        (first.startsWith("'") && first.endsWith("'"))) {
        return first.slice(1, -1);
    }
    return first;
}

function _clampFontWeight(v, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return parseInt(dflt, 10);
    return Math.min(1000, Math.max(1, n));
}

