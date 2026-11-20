// ZTerm - per-terminal cursor style defaults for DECSCUSR, RIS and DECSTR.
// A terminal belongs to the user: the configured cursor style/blink are the
// fallback whenever an application asks for the default cursor (CSI 0 SP q)
// or resets the terminal. Explicit DECSCUSR shapes stay app-owned until the
// application releases them. Dual-exported for the renderer and node:test.

(function (global) {
    const STYLES = new Set(['bar', 'block', 'underline']);
    const BLINKING = { 1: true, 2: false, 3: true, 4: false, 5: true, 6: false };
    const SHAPE = { 1: 'block', 2: 'block', 3: 'underline', 4: 'underline', 5: 'bar', 6: 'bar' };

    function normalizeStyle(value, fallback) {
        return STYLES.has(value) ? value : fallback;
    }

    function installCursorStyleDefaults(term, options) {
        const parser = term?.parser;
        if (!parser || typeof parser.registerCsiHandler !== 'function') return null;
        const initialStyle = normalizeStyle(options?.cursorStyle ?? term.options?.cursorStyle, 'bar');
        const initialBlink = (options?.cursorBlink ?? term.options?.cursorBlink) === true;
        let userStyle = initialStyle;
        let userBlink = initialBlink;
        let serial = 0;
        const disposables = [];
        const later = typeof global.queueMicrotask === 'function'
            ? fn => global.queueMicrotask(fn)
            : fn => Promise.resolve().then(fn);

        function applyUser() {
            if (term.options) {
                term.options.cursorStyle = userStyle;
                term.options.cursorBlink = userBlink;
            }
        }

        function applyShape(style, blink) {
            if (term.options) {
                term.options.cursorStyle = style;
                term.options.cursorBlink = blink;
            }
        }

        // A reset re-applies the user values after xterm's own reset has run.
        // The serial guard keeps an explicit DECSCUSR later in the same parse
        // cycle authoritative.
        function scheduleUserRestore() {
            const at = serial;
            later(() => {
                if (serial !== at) return;
                applyUser();
            });
        }

        // All-or-nothing: a later registration failure must not leave the
        // earlier handlers active on a terminal that reports no installation.
        const registered = [];
        try {
            registered.push(parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
                const value = params?.[0] ?? 0;
                if (value === 0) {
                    serial += 1;
                    applyUser();
                    return true;
                }
                const style = SHAPE[value];
                if (!style) return false;
                serial += 1;
                applyShape(style, BLINKING[value]);
                return true;
            }));

            // RIS and DECSTR must still run xterm's reset (return false), then
            // the user defaults replace whatever the reset leaves behind.
            registered.push(parser.registerEscHandler({ final: 'c' }, () => {
                serial += 1;
                scheduleUserRestore();
                return false;
            }));
            registered.push(parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
                serial += 1;
                scheduleUserRestore();
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
                if (STYLES.has(next?.cursorStyle)) userStyle = next.cursorStyle;
                if (typeof next?.cursorBlink === 'boolean') userBlink = next.cursorBlink;
                serial += 1;
                applyUser();
            },
            dispose() {
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
