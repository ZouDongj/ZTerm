// ZTerm - per-terminal cursor style defaults for DECSCUSR, RIS and DECSTR.
// A terminal belongs to the user: the configured cursor style/blink are the
// fallback whenever an application asks for the default cursor (CSI 0 SP q)
// or resets the terminal. Explicit DECSCUSR shapes stay app-owned until the
// application releases them. Dual-exported for the renderer and node:test.

(function (global) {
    'use strict';

    const STYLES = new Set(['bar', 'block', 'underline']);
    const BLINKING = { 1: true, 2: false, 3: true, 4: false, 5: true, 6: false };
    const SHAPE = { 1: 'block', 2: 'block', 3: 'underline', 4: 'underline', 5: 'bar', 6: 'bar' };

    function normalizeStyle(value, fallback) {
        return STYLES.has(value) ? value : fallback;
    }

    function installCursorStyleDefaults(term, options) {
        const parser = term?.parser;
        if (!parser
            || typeof parser.registerCsiHandler !== 'function'
            || typeof parser.registerEscHandler !== 'function') {
            return null;
        }
        const initialStyle = normalizeStyle(options?.cursorStyle ?? term.options?.cursorStyle, 'bar');
        const initialBlink = (options?.cursorBlink ?? term.options?.cursorBlink) === true;
        let userStyle = initialStyle;
        let userBlink = initialBlink;
        let disposed = false;
        const disposables = [];

        function apply(style, blink) {
            if (!disposed && term.options) {
                term.options.cursorStyle = style;
                term.options.cursorBlink = blink;
            }
        }

        function applyUser() {
            apply(userStyle, userBlink);
        }

        // All-or-nothing: a later registration failure must not leave the
        // earlier handlers active on a terminal that reports no installation.
        const registered = [];
        try {
            registered.push(parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
                const value = params?.[0] ?? 0;
                if (value === 0) {
                    applyUser();
                    return true;
                }
                const style = SHAPE[value];
                if (!style) return false;
                apply(style, BLINKING[value]);
                return true;
            }));

            // Vendored xterm fullReset() and softReset() never modify
            // options.cursorStyle or options.cursorBlink, so restore user
            // defaults synchronously before xterm's reset runs (return false).
            // Synchronous restoration keeps subsequent sequences in the same
            // chunk (DECSCUSR, CSI ?12h/l, DECRQSS) and write callbacks exact.
            registered.push(parser.registerEscHandler({ final: 'c' }, () => {
                applyUser();
                return false;
            }));
            registered.push(parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
                applyUser();
                return false;
            }));
        } catch (error) {
            for (const disposable of registered) {
                try { disposable?.dispose?.(); } catch (cleanupError) { /* terminal disposal */ }
            }
            throw error;
        }
        disposables.push(...registered);

        return {
            setUserOptions(next) {
                if (disposed) return;
                if (STYLES.has(next?.cursorStyle)) userStyle = next.cursorStyle;
                if (typeof next?.cursorBlink === 'boolean') userBlink = next.cursorBlink;
                applyUser();
            },
            dispose() {
                disposed = true;
                for (const disposable of disposables.splice(0)) {
                    try { disposable.dispose(); } catch (error) { /* terminal disposal */ }
                }
            },
            snapshot() {
                return { cursorStyle: userStyle, cursorBlink: userBlink };
            },
        };
    }

    const api = { installCursorStyleDefaults };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.ZTermCursorStyleDefaults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
