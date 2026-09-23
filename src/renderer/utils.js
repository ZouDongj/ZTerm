// ZTerm - shared utilities (extracted verbatim from renderer.html; logic unchanged)
const { ipcRenderer, webUtils } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebglAddon } = require('@xterm/addon-webgl');
const { SearchAddon } = require('@xterm/addon-search');
const { ClipboardAddon } = require('@xterm/addon-clipboard');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const fs = require('fs');
const path = require('path');
// ── Global error hooks (exceptions go to the console, never swallowed) ──
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
    // A hover tip survives keyboard-driven overlay opens (no mousemove → no
    // leave event); its z-index sits above overlays, so hide it explicitly.
    if (typeof LinkOpen !== 'undefined' && LinkOpen.hideLinkTip) LinkOpen.hideLinkTip();
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
    // Accepts both seconds (SFTP mtime) and milliseconds (Date.now())
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

// Escape an HTML text node (only & < >; quotes have no special meaning in text nodes)
function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Escape an HTML attribute value (& < > " ', for attribute contexts like title="...")
function escAttr(s) { return escHtml(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Escape a single-quoted JS string (' \ and newlines, for embedded-string contexts like onclick='fn("...")')
// Prevents user-controlled data from closing the quote and injecting arbitrary JS (XSS)
function escJsString(s) { return (s || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r'); }

// Cleanup of the currently active confirm dialog: Escape (closeAllOverlays) only removes the
// .open class without running cleanup, so stale listeners would stack onto the next dialog
// (deleting the wrong data). Unbind the old one before opening a new dialog.
let _activeConfirmCleanup = null;

function showConfirm(msg, onOk, okText) {
    if (_activeConfirmCleanup) _activeConfirmCleanup();
    // The hostkey dialog shares this DOM but keeps its own cleanup registry;
    // unbind it too or a following OK click would fire its stale callbacks
    // (trusting an unconfirmed host key).
    if (typeof _activeHostkeyCleanup === 'function' && _activeHostkeyCleanup) _activeHostkeyCleanup();
    document.getElementById('confirm-msg').textContent = msg;
    const overlay = document.getElementById('overlay-confirm');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okText || '删除';

    const cleanup = () => {
        _activeConfirmCleanup = null;
        overlay.classList.remove('open');
        cancelBtn.removeEventListener('click', onCancel);
        okBtn.removeEventListener('click', onOkClick);
        overlay.querySelector('.overlay-backdrop').removeEventListener('click', onCancel);
        // Restore the default label so delete flows are unaffected.
        okBtn.textContent = '删除';
    };
    const onCancel = () => cleanup();
    const onOkClick = () => { cleanup(); onOk(); };

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOkClick);
    overlay.querySelector('.overlay-backdrop').addEventListener('click', onCancel);
    overlay.classList.add('open');
    _activeConfirmCleanup = cleanup;
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

// Terminal link opening: the vendored addon's built-in regex is already
// http(s)-only and `requireModifier` is not a real option — the gesture gate
// lives in the unified LinkOpen entry (bare Ctrl+click).
// Known detection gap: the regex matches only all-lower or all-upper case
// schemes, so mixed-case "Https://…" plain text is not linkified (harmless;
// the backend validator is case-insensitive and would accept it).
function _createWebLinksAddon(term) {
    return new WebLinksAddon(
        (event, uri) => LinkOpen.handleLinkActivate(event, uri, { term }),
        {
            hover: (event, text) => LinkOpen.showLinkTip(event, text),
            leave: () => LinkOpen.hideLinkTip(),
        }
    );
}

// Normalize fontFamily: quote font names (names with spaces must be quoted);
// CSS generic family keywords (monospace/serif/sans-serif etc.) stay unquoted.
// Key: the fallback font (usually a CJK font) must be inserted *before* the
// generic keyword, otherwise monospace wins (on Windows monospace maps to
// SimSun by default) and Chinese would fall back to SimSun instead of the
// user-specified fallback font.
// Startup (_buildTerminalOptions) and settings hot update (saveAppearance) must share this logic
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
        if (_GENERIC_FONT_FAMILIES.has(t.toLowerCase())) return t; // generic keywords stay unquoted
        return '"' + t + '"';
    };
    let parts = (fontFamily || '').split(',').map(quote).filter(Boolean);
    if (fallbackFont) {
        const fb = quote(fallbackFont);
        // Insert before the first generic keyword so monospace etc. cannot hijack CJK fallback
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

