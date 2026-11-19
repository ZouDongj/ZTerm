// Native-backed reduced-motion preference for the smooth cursor gate.
//
// WebView2 caches page-level matchMedia('(prefers-reduced-motion: reduce)') at
// document creation time and does not refresh it when a remote desktop session
// returns to the local console or when Windows "Animation effects" is toggled.
// When the Rust backend reports SPI_GETCLIENTAREAANIMATION, that live native
// state is authoritative; matchMedia is kept solely as a fallback when native
// IPC is unavailable or fails to query.
(function (root) {
    'use strict';

    const MEDIA_QUERY = '(prefers-reduced-motion: reduce)';
    const IPC_COMMAND = 'get-system-animation-preference';
    const IPC_EVENT = 'system-animation-preference-changed';
    const DEFAULT_PASSIVE_REFRESH_MS = 15000;

    function createReducedMotionController(deps) {
        const opts = deps || {};
        const win = 'win' in opts ? opts.win : (typeof root.window !== 'undefined' ? root.window : root);
        const doc = 'doc' in opts ? opts.doc : (typeof root.document !== 'undefined' ? root.document : null);
        const now = typeof opts.now === 'function'
            ? opts.now
            : () => (typeof root.performance?.now === 'function' ? root.performance.now() : Date.now());
        const minPassiveRefreshMs = Number.isFinite(opts.minPassiveRefreshMs) && opts.minPassiveRefreshMs >= 0
            ? opts.minPassiveRefreshMs
            : DEFAULT_PASSIVE_REFRESH_MS;
        const resolveIpc = () => (typeof root.ipcRenderer !== 'undefined' && root.ipcRenderer)
            || root.electron?.ipcRenderer
            || null;
        const invoke = typeof opts.invoke === 'function'
            ? opts.invoke
            : (channel => {
                const ipc = resolveIpc();
                return ipc && typeof ipc.invoke === 'function'
                    ? ipc.invoke(channel)
                    : Promise.reject(new Error('ipcRenderer.invoke unavailable'));
            });
        const onEvent = typeof opts.on === 'function'
            ? opts.on
            : ((channel, fn) => {
                const ipc = resolveIpc();
                return ipc && typeof ipc.on === 'function' ? ipc.on(channel, fn) : undefined;
            });
        const removeEvent = typeof opts.removeListener === 'function'
            ? opts.removeListener
            : ((channel, fn) => {
                const ipc = resolveIpc();
                if (ipc && typeof ipc.removeListener === 'function') ipc.removeListener(channel, fn);
            });
        const matchMediaFn = typeof opts.matchMedia === 'function'
            ? opts.matchMedia
            : (typeof root.matchMedia === 'function' ? q => root.matchMedia(q) : null);

        let pageQuery = null;
        try {
            pageQuery = matchMediaFn ? (matchMediaFn(MEDIA_QUERY) || null) : null;
        } catch (e) {
            pageQuery = null;
        }

        let nativeAnimationsEnabled = null;
        let remoteSession = null;
        let refreshSeq = 0;
        let inFlight = null;
        let inFlightSeq = 0;
        let lastRefreshAt = -Infinity;
        let started = false;
        let startGen = 0;
        const listeners = new Set();

        function pageReducedMotion() {
            return pageQuery ? pageQuery.matches === true : null;
        }

        function currentSource() {
            if (typeof nativeAnimationsEnabled === 'boolean') return 'native';
            if (pageQuery) return 'page-match-media';
            return 'default';
        }

        function currentReducedMotion() {
            if (typeof nativeAnimationsEnabled === 'boolean') return !nativeAnimationsEnabled;
            return pageQuery?.matches === true;
        }

        let lastEffective = currentReducedMotion();

        function notifyIfChanged() {
            const next = currentReducedMotion();
            if (next === lastEffective) return;
            lastEffective = next;
            const event = { matches: next };
            for (const fn of [...listeners]) {
                try { fn(event); } catch (e) {}
            }
        }

        function applyNative(payload, seq) {
            if (!payload || typeof payload !== 'object') return;
            if (seq !== null) {
                if (seq < refreshSeq) return;
            } else {
                // Push events supersede any older in-flight pull request.
                refreshSeq += 1;
            }
            nativeAnimationsEnabled = typeof payload.animationsEnabled === 'boolean'
                ? payload.animationsEnabled : null;
            remoteSession = typeof payload.remoteSession === 'boolean'
                ? payload.remoteSession : null;
            notifyIfChanged();
        }

        function snapshot() {
            return {
                reducedMotion: currentReducedMotion(),
                nativeAnimationsEnabled,
                remoteSession,
                pageReducedMotion: pageReducedMotion(),
                source: currentSource(),
            };
        }

        function refresh() {
            lastRefreshAt = now();
            if (inFlight && inFlightSeq === refreshSeq) return inFlight;
            const seq = ++refreshSeq;
            inFlightSeq = seq;
            let p;
            try {
                p = Promise.resolve(invoke(IPC_COMMAND));
            } catch (e) {
                p = Promise.reject(e);
            }
            const settled = p.then(
                res => {
                    applyNative(res, seq);
                    return snapshot();
                },
                () => snapshot(),
            ).finally(() => {
                if (inFlightSeq === seq) {
                    inFlight = null;
                    inFlightSeq = 0;
                }
            });
            inFlight = settled;
            return settled;
        }

        function maybeRefresh() {
            const elapsed = now() - lastRefreshAt;
            if (elapsed >= 0 && elapsed < minPassiveRefreshMs) return null;
            return refresh();
        }

        const onFocus = () => { if (started) refresh(); };
        const onVisibility = () => {
            if (started && doc && doc.visibilityState === 'visible') refresh();
        };
        const onPassiveActivity = () => { if (started) maybeRefresh(); };
        const onNativePush = (_ev, payload) => {
            if (!started) return;
            applyNative(payload, null);
        };
        const onPageQueryChange = () => { if (started) notifyIfChanged(); };

        function start() {
            if (!started) {
                started = true;
                const gen = ++startGen;
                try { win?.addEventListener?.('focus', onFocus); } catch (e) {}
                try { win?.addEventListener?.('keydown', onPassiveActivity, true); } catch (e) {}
                try { win?.addEventListener?.('pointerdown', onPassiveActivity, true); } catch (e) {}
                try { doc?.addEventListener?.('visibilitychange', onVisibility); } catch (e) {}
                try {
                    const maybeUnlisten = onEvent(IPC_EVENT, onNativePush);
                    if (maybeUnlisten && typeof maybeUnlisten.then === 'function') {
                        maybeUnlisten.then(unlisten => {
                            // If stop() ran before async listen() settled, detach the
                            // handle immediately so no zombie Tauri listener lingers.
                            if ((!started || startGen !== gen) && typeof unlisten === 'function') {
                                try { unlisten(); } catch (e) {}
                            }
                        }, () => {});
                    }
                } catch (e) {}
                try {
                    if (pageQuery?.addEventListener) pageQuery.addEventListener('change', onPageQueryChange);
                    else if (pageQuery?.addListener) pageQuery.addListener(onPageQueryChange);
                } catch (e) {}
            }
            return refresh();
        }

        function stop() {
            if (!started) return;
            started = false;
            startGen += 1;
            try { win?.removeEventListener?.('focus', onFocus); } catch (e) {}
            try { win?.removeEventListener?.('keydown', onPassiveActivity, true); } catch (e) {}
            try { win?.removeEventListener?.('pointerdown', onPassiveActivity, true); } catch (e) {}
            try { doc?.removeEventListener?.('visibilitychange', onVisibility); } catch (e) {}
            try { removeEvent(IPC_EVENT, onNativePush); } catch (e) {}
            try {
                if (pageQuery?.removeEventListener) pageQuery.removeEventListener('change', onPageQueryChange);
                else if (pageQuery?.removeListener) pageQuery.removeListener(onPageQueryChange);
            } catch (e) {}
        }

        // MediaQueryList-compatible live view consumed by createXtermWebglSmoothCursor.
        // The matches getter stays strictly read-only (no IPC side effects on draw/snapshot).
        const query = {
            get matches() { return currentReducedMotion(); },
            addEventListener(type, fn) {
                if (type === 'change' && typeof fn === 'function') listeners.add(fn);
            },
            removeEventListener(type, fn) {
                if (type === 'change') listeners.delete(fn);
            },
        };

        return { query, start, stop, refresh, maybeRefresh, snapshot };
    }

    const singleton = createReducedMotionController();
    root.createReducedMotionController = createReducedMotionController;
    root.ZTermReducedMotion = singleton;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { createReducedMotionController, ZTermReducedMotion: singleton };
    }
}(typeof globalThis !== 'undefined' ? globalThis : this));
