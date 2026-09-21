// ZTerm - terminal link opening (ADR-0003): gesture/scheme gate plus the
// shared browser glue behind both the plain-link WebLinksAddon and the OSC 8
// linkHandler. Browser global + CommonJS dual export for node:test.
//
// Contract:
//  - activation requires bare Ctrl + primary button (no Alt/Meta/Shift); any
//    other gesture is ignored silently so text selection, context menus and
//    TUI mouse reporting keep their native behavior;
//  - a valid activation consumes the event ONLY when the terminal is in
//    mouse-reporting (TUI) mode: there the document-level mouseup listener
//    reports the click to the remote app, and swallowing our own activation
//    keeps vim/htop from also receiving it (ADR-0003 §1; the mousedown half
//    is irrevocable — ADR-0003 §59). In normal mode the same document
//    listener runs xterm's selection cleanup, so the event must flow
//    through or selection state strands (ghost selection, stuck drag);
//  - only http/https targets ever leave the renderer — the Rust side
//    re-validates before anything reaches the OS shell;
//  - OSC 8 links confirm first and display the real target as plain text;
//  - plain links open directly; every failure surfaces as one toast.
(function installLinkOpen(root) {
    'use strict';

    function isAllowedLinkGesture(e) {
        return !!e && e.button === 0 && e.ctrlKey === true
            && !e.altKey && !e.metaKey && !e.shiftKey;
    }

    // Coarse pre-check for UI decisions; zterm.rs::validate_open_url is the
    // authoritative gate.
    function classifyLinkTarget(uri) {
        const s = String(uri || '');
        if (/^https:\/\//i.test(s)) return 'https';
        if (/^http:\/\//i.test(s)) return 'http';
        return 'other';
    }

    const api = { isAllowedLinkGesture, classifyLinkTarget };

    // Browser-only glue; under node:test `document` is absent and only the
    // pure functions are exported.
    if (typeof document !== 'undefined') {
        let tipEl = null;

        function hideLinkTip() {
            if (tipEl) tipEl.classList.remove('show');
        }

        // Hover feedback for both link kinds: the real target (plain text)
        // plus the gesture hint, anchored near the mouse.
        function showLinkTip(event, uri) {
            if (!tipEl) {
                tipEl = document.createElement('div');
                tipEl.className = 'link-tip';
                document.body.appendChild(tipEl);
            }
            tipEl.textContent = '';
            const target = document.createElement('span');
            target.className = 'link-tip-target';
            target.textContent = String(uri || '');
            const hint = document.createElement('span');
            hint.className = 'link-tip-hint';
            hint.textContent = 'Ctrl+点击打开';
            tipEl.append(target, hint);
            const x = Math.max(8, Math.min((event && event.clientX) || 0, window.innerWidth - 480));
            const y = Math.max(8, ((event && event.clientY) || 0) + 18);
            tipEl.style.left = x + 'px';
            tipEl.style.top = y + 'px';
            tipEl.classList.add('show');
        }

        function invokeOpenUrl(uri) {
            Promise.resolve(ipcRenderer.invoke('open-url', { url: String(uri) }))
                .then(res => {
                    if (res && res.ok === false) {
                        showToast('无法打开链接：' + (res.error || '未知错误'), true);
                    }
                })
                .catch(err => {
                    const detail = err && err.message ? err.message : String(err);
                    showToast('无法打开链接：' + detail, true);
                });
        }

        // Unified activation entry. A wrong gesture is ignored silently so
        // selection/context menu/TUI mouse keep their native behavior.
        function handleLinkActivate(event, uri, opts) {
            if (!isAllowedLinkGesture(event)) return;
            // Consume only in mouse-reporting (TUI) mode: the mousedown half
            // already reached the remote app (irrevocable), but swallowing
            // this mouseup keeps the document-level reporter from completing
            // the click inside vim/htop while the browser opens. In normal
            // mode that document listener performs xterm's selection cleanup
            // instead — blocking it strands selection state, so pass through.
            if (_isMouseReporting(opts && opts.term)) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            }
            if (classifyLinkTarget(uri) === 'other') {
                showToast('仅支持打开 http/https 链接', true);
                return;
            }
            hideLinkTip();
            if (opts && opts.osc8) {
                // OSC 8 targets come from terminal output (less trusted than
                // text the user can read), so they always confirm first. Show
                // the normalized target (same WHATWG rules the Rust side
                // applies) with the host spelled out, as plain text.
                showConfirm('打开链接？\n' + describeLinkTarget(uri), () => invokeOpenUrl(uri), '打开');
            } else {
                invokeOpenUrl(uri);
            }
        }

        // Mouse reporting active means a TUI app (vim/htop/…) asked for
        // pointer events; term.modes is absent on plain-object test doubles.
        function _isMouseReporting(term) {
            return !!(term && term.modes && term.modes.mouseTrackingMode
                && term.modes.mouseTrackingMode !== 'none');
        }

        // "主机： host\n完整地址： normalized" for the OSC 8 confirm dialog;
        // falls back to the raw string when URL parsing fails (the backend
        // will reject it anyway).
        function describeLinkTarget(uri) {
            try {
                const u = new URL(String(uri));
                return '主机：' + u.host + '\n完整地址：' + u.href;
            } catch (_) {
                return String(uri);
            }
        }

        api.showLinkTip = showLinkTip;
        api.hideLinkTip = hideLinkTip;
        api.invokeOpenUrl = invokeOpenUrl;
        api.handleLinkActivate = handleLinkActivate;
    }

    root.LinkOpen = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
