// ZTerm - in-app context menu surface
//
// The native WebView2 context menu is disabled process-wide (main.rs:
// AreDefaultContextMenusEnabled=false), so plain text controls (inputs and
// textareas) get an application edit menu here — cut/copy/paste/select-all
// through the same clipboard IPC commands the terminal uses. Other surfaces
// (SFTP rows, the SFTP blank area) reuse the shared menu chrome with the
// existing tab-context-menu visuals; only styles are shared, the tab strip's
// own menu keeps its implementation. The terminal's right-click paste and
// the tab strip handlers are never intercepted: the xterm helper textarea
// and non-text targets keep propagating to their existing listeners.

// Input types whose value is editable/selectable text. Everything else
// (checkbox, radio, range, file, button…) exposes no text actions, so no
// menu is offered for them.
const _TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'tel', 'url', 'email', 'password', 'number']);

function _isEditableTextControl(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'TEXTAREA') {
        // The xterm helper textarea is the terminal's own IME surface — it
        // is never taken over by the app menu.
        return !(el.classList && el.classList.contains('xterm-helper-textarea'));
    }
    if (tag !== 'INPUT') return false;
    return _TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
}

// Fire the input event application code observes (mkdir/rename/path editors
// react to typed edits; programmatic value changes must look the same).
function _fireInput(el) {
    const ev = (typeof Event === 'function')
        ? new Event('input', { bubbles: true })
        : { type: 'input', bubbles: true };
    if (typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(ev); } catch (e) {}
    } else if (typeof el.dispatch === 'function') {
        el.dispatch('input', ev);
    }
}

// Fire ONE change event after a successful clipboard edit so the page's
// onchange save chain (e.g. settings inputs) still runs. Native `change`
// only fires on blur; a menu-driven edit must not depend on one.
function _fireChange(el) {
    const ev = (typeof Event === 'function')
        ? new Event('change', { bubbles: true })
        : { type: 'change', bubbles: true };
    if (typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(ev); } catch (e) {}
    } else if (typeof el.dispatch === 'function') {
        el.dispatch('change', ev);
    }
}

// Whether the control exposes readable selection offsets. Per spec,
// controls without selection support report null from selectionStart —
// measured on this engine: Chromium's number inputs return null rather than
// throwing. Their menu availability must reflect what is actually readable
// instead of pretending.
function _selectionReadable(el) {
    try {
        return typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number';
    } catch (e) {
        return false;
    }
}

// Replace the control's current selection with `text`. The NATIVE editing
// command is preferred (usable on number inputs whose selection APIs report
// null, preserves caret/selection semantics and fires the same trusted
// `input` a keystroke does); the manual splice is only for engines without
// it. Returns false when no path could edit the control — the caller must
// surface that, never pretend success.
function _applyEditText(el, text) {
    try {
        if (typeof document.execCommand === 'function') {
            // Empty text (cut's delete half) uses the native delete command:
            // inserting '' is not a reliable selection removal.
            const ok = text === ''
                ? document.execCommand('delete')
                : document.execCommand('insertText', false, text);
            if (ok) return true;
        }
    } catch (e) { /* fall through to the DOM paths */ }
    try {
        if (_selectionReadable(el)) {
            const value = String(el.value || '');
            const s = Math.min(el.selectionStart, el.selectionEnd);
            const t = Math.max(el.selectionStart, el.selectionEnd);
            if (typeof el.setRangeText === 'function') {
                el.setRangeText(text, s, t, 'end');
            } else {
                el.value = value.slice(0, s) + text + value.slice(t);
                try { el.selectionStart = el.selectionEnd = s + text.length; } catch (e) {}
            }
            _fireInput(el);
            return true;
        }
    } catch (e) { /* unreachable editing APIs: report failure below */ }
    return false;
}

const ContextMenu = {
    // The single open menu instance:
    // { el, gen, itemEls, activeIdx, onDocMouseDown, onDocKeyDown, onClosed }
    _open: null,
    // Monotonic generation: async actions (clipboard round trips) may only
    // apply while the menu generation that started them is still current.
    _gen: 0,

    isOpen() {
        return !!this._open;
    },

    // items: [{ label, action?, disabled?, danger? }] — action may return a
    // promise (the menu then closes only after it settles, rejections
    // included). opts.onClosed runs after teardown (selection cleanup etc).
    //
    // FOCUS MODEL: the menu chrome never takes DOM focus — an inline editor
    // underneath (SFTP rename, tab rename) must not blur-cancel or
    // blur-commit when the menu opens or an item is pressed. The visual
    // `.active` item is plain state; keyboard routing happens through a
    // document-capture keydown listener (see _onMenuKey).
    show(x, y, items, opts) {
        this.close();
        const list = (items || []).filter(it => it && it.label);
        if (!list.length) return;
        const gen = ++this._gen;
        const menu = document.createElement('div');
        menu.id = 'app-context-menu';
        menu.className = 'tab-context-menu';
        menu.setAttribute('role', 'menu');
        menu.tabIndex = -1;
        // Swallow pointerdown/mousedown on the whole menu: clicking an item
        // must never move DOM focus off the control being edited (the click
        // itself still fires afterwards).
        menu.addEventListener('pointerdown', (e) => e.preventDefault());
        menu.addEventListener('mousedown', (e) => e.preventDefault());
        const itemEls = [];
        list.forEach((it, i) => {
            const el = document.createElement('div');
            el.className = 'tab-context-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
            el.setAttribute('role', 'menuitem');
            el.tabIndex = -1;
            if (it.disabled) el.setAttribute('aria-disabled', 'true');
            el.textContent = it.label; // textContent — labels never parse as markup
            // Item-level pointerdown prevention (the menu-level listener is
            // the same intent; engines without bubbling still see this one).
            el.addEventListener('pointerdown', (e) => e.preventDefault());
            el.addEventListener('mousedown', (e) => e.preventDefault());
            el.addEventListener('mouseenter', () => this._setActive(gen, i));
            el.addEventListener('click', () => {
                if (it.disabled) return;
                this._setActive(gen, i);
                let result;
                try {
                    result = it.action ? it.action() : undefined;
                } catch (e) {
                    console.error('[ZTerm] context menu action failed:', e);
                    this.close(gen);
                    return;
                }
                if (result && typeof result.then === 'function') {
                    // Async action: close only after the result (success or
                    // rejection) so no pending promise is swallowed.
                    result.then(() => this.close(gen), () => this.close(gen));
                    return;
                }
                this.close(gen);
            });
            itemEls.push(el);
            menu.appendChild(el);
        });
        document.body.appendChild(menu);
        // Viewport clamping (best-effort: measurement needs layout).
        try {
            const vw = window.innerWidth || 0;
            const vh = window.innerHeight || 0;
            const w = menu.offsetWidth || 200;
            const h = menu.offsetHeight || list.length * 34 + 8;
            const mx = vw ? Math.max(8, Math.min(x, vw - w - 8)) : x;
            const my = vh ? Math.max(8, Math.min(y, vh - h - 8)) : y;
            menu.style.left = Math.round(mx) + 'px';
            menu.style.top = Math.round(my) + 'px';
        } catch (e) {
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
        }
        const onDocMouseDown = (e) => {
            const target = e && e.target;
            if (target && menu.contains && !menu.contains(target)) this.close(gen);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
        const onDocKeyDown = (e) => this._onMenuKey(e, gen);
        document.addEventListener('keydown', onDocKeyDown, true);
        this._open = {
            el: menu, gen, itemEls, activeIdx: -1,
            onDocMouseDown, onDocKeyDown,
            onClosed: (opts && typeof opts.onClosed === 'function') ? opts.onClosed : null,
        };
        // Register with the shared modal stack so Escape-through-closeAllOverlays
        // and the global shortcut guard treat the menu like an overlay layer.
        if (typeof pushModalLayer === 'function') {
            pushModalLayer('app-context-menu', () => this.close(gen));
        }
        // A fully-disabled menu is a legitimate state (it communicates that
        // nothing is available on this surface); it stays until dismissed.
        const firstEnabled = itemEls.findIndex(el => !el.classList.contains('disabled'));
        if (firstEnabled !== -1) this._setActive(gen, firstEnabled);
    },

    // Visual active-item state only — never touches DOM focus. (No
    // aria-activedescendant: it only applies to a focused container, and
    // this menu deliberately never takes DOM focus.)
    _setActive(gen, idx) {
        const open = this._open;
        if (!open || open.gen !== gen) return;
        if (idx < 0 || idx >= open.itemEls.length) return;
        if (open.itemEls[idx].classList.contains('disabled')) return;
        open.itemEls.forEach((el, i) => {
            el.classList.toggle('active', i === idx);
        });
        open.activeIdx = idx;
    },

    // Document-capture keyboard routing while a menu is open. Menu keys are
    // consumed BEFORE the page sees them (an Enter under a rename editor
    // must activate the menu, not commit the edit); IME composition keys
    // always pass through; every other key passes through untouched.
    _onMenuKey(e, gen) {
        const open = this._open;
        if (!open || open.gen !== gen) return;
        if (e.isComposing || e.keyCode === 229) return; // the IME owns this key
        const enabled = [];
        open.itemEls.forEach((el, i) => { if (!el.classList.contains('disabled')) enabled.push(i); });
        if (!enabled.length) return;
        const pos = enabled.indexOf(open.activeIdx);
        const move = (next) => this._setActive(gen, enabled[next]);
        switch (e.key) {
            case 'Escape':
                e.preventDefault(); e.stopPropagation();
                this.close(gen);
                return;
            case 'ArrowDown':
                e.preventDefault(); e.stopPropagation();
                move(pos < 0 ? 0 : (pos + 1) % enabled.length);
                return;
            case 'ArrowUp':
                e.preventDefault(); e.stopPropagation();
                move(pos < 0 ? enabled.length - 1 : (pos - 1 + enabled.length) % enabled.length);
                return;
            case 'Home':
                e.preventDefault(); e.stopPropagation();
                move(0);
                return;
            case 'End':
                e.preventDefault(); e.stopPropagation();
                move(enabled.length - 1);
                return;
            case 'Enter': case ' ': case 'Spacebar': {
                e.preventDefault(); e.stopPropagation();
                const el = open.itemEls[open.activeIdx];
                if (!el || el.classList.contains('disabled')) return;
                // Same activation path as a click.
                if (typeof el.click === 'function') {
                    try { el.click(); return; } catch (err) {}
                }
                if (typeof el.dispatch === 'function') el.dispatch('click', { preventDefault() {}, stopPropagation() {} });
                return;
            }
        }
    },

    // gen-qualified close: a stale closer (an async action settling after a
    // successor menu opened) never tears down the successor.
    close(gen) {
        const open = this._open;
        if (!open) return;
        if (gen !== undefined && open.gen !== gen) return;
        this._open = null;
        if (open.onDocMouseDown) document.removeEventListener('mousedown', open.onDocMouseDown, true);
        if (open.onDocKeyDown) document.removeEventListener('keydown', open.onDocKeyDown, true);
        if (open.el && open.el.parentElement) open.el.remove();
        if (typeof removeModalLayer === 'function') removeModalLayer('app-context-menu');
        if (open.onClosed) {
            try { open.onClosed(); } catch (e) { console.error('[ZTerm] context menu close hook failed:', e); }
        }
        // No focus restore: the menu never took DOM focus, and an outside
        // click transfers focus natively before this close runs.
    },
};

// ── Text-edit menu ──

// The current menu generation, for async clipboard validation.
function _currentMenuGen() {
    return ContextMenu._open ? ContextMenu._open.gen : -1;
}

// An async clipboard result may only edit a control that is still connected,
// still holds the focus the right-click gave it, and belongs to the menu
// generation that asked. (The menu chrome never takes focus itself, so a
// focused editor keeps it through the whole clipboard round trip.)
function _applyValidated(el, gen, apply) {
    const open = ContextMenu._open;
    if (!open || open.gen !== gen) return false; // superseded menu generation
    if (!el || el.parentElement === null || el.isConnected === false) return false; // control died mid-flight
    const focus = document.activeElement;
    if (focus && focus !== el) return false; // the user moved focus elsewhere
    if (typeof el.focus === 'function') {
        try { el.focus(); } catch (e) {}
    }
    const ok = apply();
    if (!ok) {
        if (typeof showToast === 'function') showToast('编辑未能应用到该控件', true);
    }
    return ok;
}

function _textMenuItems(el) {
    const type = String(el.type || '').toLowerCase();
    const password = type === 'password';
    const readOnly = !!el.readOnly;
    const value = () => String(el.value || '');
    const readable = () => _selectionReadable(el);
    const hasSelection = () => {
        if (!readable()) return false;
        try { return el.selectionStart !== el.selectionEnd; } catch (e) { return false; }
    };
    const selectionText = () => {
        const s = Math.min(el.selectionStart, el.selectionEnd);
        const t = Math.max(el.selectionStart, el.selectionEnd);
        return value().slice(s, t);
    };
    // Clipboard goes through the Rust commands (system clipboard; works
    // outside a user gesture, unlike navigator.clipboard in WebView2).
    const writeClipboard = (text) => ipcRenderer.invoke('clipboard-write-text', { text });
    const readClipboard = () => ipcRenderer.invoke('clipboard-read-text');
    const clipFailToast = (what) => {
        console.error('[ZTerm] clipboard ' + what + ' failed');
        if (typeof showToast === 'function') showToast('剪贴板不可用，' + what + '失败', true);
    };

    const doCopy = () => {
        const text = selectionText();
        return writeClipboard(text).then(
            () => {},
            () => clipFailToast('复制')
        );
    };
    const doCut = () => {
        const gen = _currentMenuGen();
        // Snapshot the selection BEFORE the IPC wait: if the value or the
        // selection changed while the write was in flight, deleting "the
        // selection" would destroy text the user has since entered. The
        // copy stands; the deletion is refused with a visible toast and no
        // input/change events.
        const snap = { value: value(), start: el.selectionStart, end: el.selectionEnd };
        return writeClipboard(selectionText()).then(
            () => {
                _applyValidated(el, gen, () => {
                    const unchanged = readable() && el.value === snap.value &&
                        el.selectionStart === snap.start && el.selectionEnd === snap.end;
                    if (!unchanged) {
                        if (typeof showToast === 'function') showToast('选区已变化，已复制但未剪切', true);
                        return true;
                    }
                    if (!_applyEditText(el, '')) return false;
                    _fireChange(el);
                    return true;
                });
            },
            () => clipFailToast('剪切')
        );
    };
    const doPaste = () => {
        const gen = _currentMenuGen();
        return readClipboard().then(
            (text) => {
                _applyValidated(el, gen, () => {
                    if (!_applyEditText(el, String(text == null ? '' : text))) return false;
                    _fireChange(el);
                    return true;
                });
            },
            () => clipFailToast('粘贴')
        );
    };
    const doSelectAll = () => {
        if (typeof el.focus === 'function') {
            try { el.focus(); } catch (e) {}
        }
        // select() itself is NOT inferred invalid from null selection
        // offsets (they only mean the offsets are unreadable); the real
        // selection behavior of such controls is probed in E2E via
        // queryCommandEnabled — no clipboard access involved.
        if (typeof el.select === 'function') {
            try { el.select(); } catch (e) {}
        } else if (readable()) {
            try { el.selectionStart = 0; el.selectionEnd = value().length; } catch (e) {}
        }
    };

    const sel = hasSelection();
    return [
        { label: '剪切', disabled: password || readOnly || !sel, action: doCut },
        { label: '复制', disabled: password || !sel, action: doCopy },
        { label: '粘贴', disabled: readOnly, action: doPaste },
        { label: '全选', disabled: !value().length, action: doSelectAll },
    ];
}

// Document-level router (capture phase, registered first): text controls get
// the app edit menu and stop propagation (a row menu underneath must not
// stack on top); every other target keeps the native menu suppressed while
// propagation continues so the terminal's right-click paste, the tab strip
// menu and the SFTP row handlers still receive the event.
// The right-press is the ENTRY GESTURE of the edit menu. For an
// ALREADY-FOCUSED editor, suppressing just this mousedown's default keeps
// the editor's DOM focus — and with it its connection, value and selection
// — through the gesture, so the menu that opens over it edits the very
// state the user was working on. An UNFOCUSED control keeps the native
// focus move: the menu's async edits require activeElement to be the
// target, so refusing the focus there would break paste/cut on every
// unfocused field. Left presses and non-text targets keep their native
// behavior; the contextmenu event always follows normally.
document.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    const el = e.target;
    if (el && _isEditableTextControl(el) && !el.disabled && document.activeElement === el) {
        e.preventDefault();
    }
}, true);

document.addEventListener('contextmenu', (e) => {
    // A new right-click supersedes any menu still open (closing here also
    // fires the onClosed hook, e.g. the SFTP row selection cleanup).
    if (ContextMenu.isOpen()) ContextMenu.close();
    const el = e.target;
    if (el && _isEditableTextControl(el) && !el.disabled && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        ContextMenu.show(e.clientX, e.clientY, _textMenuItems(el));
        return;
    }
    // Non-text area: no menu here (the terminal, tab strip and SFTP handlers
    // own their own menus); the browser menu stays suppressed.
    e.preventDefault();
}, true);

window.ContextMenu = ContextMenu;
