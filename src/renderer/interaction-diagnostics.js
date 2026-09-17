// Explicitly armed, bounded diagnostics. Never records input text or keys.
(function (root) {
    'use strict';
    function createInteractionDiagnostics(env = {}) {
        const now = env.now || (() => performance.now());
        const later = env.setTimeout || setTimeout;
        const cancel = env.clearTimeout || clearTimeout;
        const doc = env.document;
        const win = env.window;
        const resolve = env.resolveSource || (() => null);
        const epochs = new WeakMap();
        let enabled = false, records = [], limit = 2048, sequence = 0, cursor = 0, eventCount = 0;
        let timeout = null, heartbeat = null, rawTimer = null, raw = null;
        let reason = 'not-started', run = 0;
        let inputSequence = 0;
        const listeners = [];
        const bounded = (v, fallback, min, max) => Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
        const identifier = v => typeof v === 'string' ? v.slice(0, 96) : typeof v === 'number' && Number.isFinite(v) ? v : null;
        const epoch = owner => epochs.get(owner) || 0;
        function stopRaw(why) {
            if (raw && raw.active) { raw.active = false; raw.reason = why; raw.owner = null; }
            if (rawTimer !== null) cancel(rawTimer);
            rawTimer = null;
        }
        function stop(why = 'manual') {
            enabled = false;
            reason = why;
            for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
            listeners.length = 0;
            if (timeout !== null) cancel(timeout);
            if (heartbeat !== null) cancel(heartbeat);
            timeout = heartbeat = null;
            stopRaw(why);
        }
        function record(type, fields) {
            if (!enabled) return;
            const entry = { at: now(), type, ...fields };
            if (records.length < limit) records.push(entry);
            else { records[cursor] = entry; cursor = (cursor + 1) % limit; }
            eventCount += 1;
            if (eventCount >= limit * 4) stop('record-cap');
        }
        function state() {
            const open = (id, cls = 'open') => !!doc?.getElementById(id)?.classList.contains(cls);
            return {
                menu: open('menu-popup'), backdrop: open('menu-backdrop'),
                settings: open('settings-pane', 'active'),
                dragOverlay: !!doc?.getElementById('tab-drag-overlay'),
                modal: !!doc?.querySelector('.overlay.open'),
                focusedId: identifier(doc?.activeElement?.id),
            };
        }
        function input(event) {
            record(event.type, {
                targetId: identifier(event.target?.id),
                targetType: identifier(event.target?.tagName),
                tabId: identifier(event.target?.closest?.('.tab[data-tab]')?.getAttribute('data-tab')),
                trusted: event.isTrusted === true, ...state(),
            });
        }
        function start(options = {}) {
            stop('restart');
            records = []; raw = null; sequence = 0; cursor = 0; eventCount = 0; run += 1;
            limit = bounded(options.maxRecords, 2048, 16, 8192);
            const duration = bounded(options.durationMs, 15000, 250, 60000);
            if (options.raw) {
                const source = resolve(options.raw.tabId);
                if (!source || !source.owner) throw new Error('Raw capture requires one live backend tabId');
                const rawDuration = bounded(options.raw.durationMs, 5000, 100, Math.min(duration, 10000));
                raw = {
                    active: true, owner: source.owner, tabId: identifier(options.raw.tabId),
                    epoch: epoch(source.owner), bytes: 0, chunks: [], reason: null,
                    deadline: now() + rawDuration,
                    maxBytes: bounded(options.raw.maxBytes, 65536, 1, 262144),
                };
                rawTimer = later(() => stopRaw('timeout'), rawDuration);
            }
            enabled = true; reason = null;
            for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'focusin', 'focusout']) {
                if (doc) { doc.addEventListener(type, input, true); listeners.push([doc, type, input]); }
            }
            for (const type of ['focus', 'blur']) {
                if (win) { win.addEventListener(type, input, true); listeners.push([win, type, input]); }
            }
            let expected = now() + 250;
            function beat() {
                record('heartbeat', { lagMs: Math.max(0, now() - expected) });
                if (enabled) { expected = now() + 250; heartbeat = later(beat, 250); }
            }
            heartbeat = later(beat, 250);
            timeout = later(() => stop('timeout'), duration);
            record('start', state());
        }
        function receive(tabId, data, trace) {
            if (!enabled) return null;
            const token = { run, frontendSeq: ++sequence, tabId: identifier(tabId) };
            // Keep the backend schema explicit: never spread event payloads.
            const backend = {};
            for (const key of ['epoch', 'seq', 'us']) {
                if (typeof trace?.[key] === 'number' && Number.isFinite(trace[key])) backend[key] = trace[key];
            }
            record('receive', { ...token, chars: typeof data === 'string' ? data.length : 0, backend });
            return token;
        }
        function routed(token, owner, data) {
            if (!enabled || !token || token.run !== run) return;
            token.owner = owner; token.epoch = epoch(owner);
            record('routed', { frontendSeq: token.frontendSeq, tabId: token.tabId, epoch: token.epoch });
            if (!raw?.active) return;
            if (now() >= raw.deadline) { stopRaw('timeout'); return; }
            if (resolve(raw.tabId)?.owner !== raw.owner) { stopRaw('source-changed'); return; }
            if (owner !== raw.owner || token.tabId !== raw.tabId) return;
            if (epoch(owner) !== raw.epoch) { stopRaw('session-reset'); return; }
            if (typeof data !== 'string') return;
            if (data.length > raw.maxBytes - raw.bytes) { stopRaw('byte-or-chunk-cap'); return; }
            const bytes = new TextEncoder().encode(data).length;
            // Preserve whole chunks and their boundaries, never truncate a chunk.
            if (raw.bytes + bytes > raw.maxBytes || raw.chunks.length >= 2048) { stopRaw('byte-or-chunk-cap'); return; }
            raw.chunks.push({ at: now(), frontendSeq: token.frontendSeq, data, bytes });
            raw.bytes += bytes;
            if (raw.bytes === raw.maxBytes) stopRaw('byte-or-chunk-cap');
        }
        function filtered(token, data) {
            if (enabled && token?.run === run) record('filtered', { frontendSeq: token.frontendSeq, tabId: token.tabId, epoch: token.epoch, chars: typeof data === 'string' ? data.length : 0 });
        }
        function parsed(token) {
            if (enabled && token?.run === run) record('parsed', { frontendSeq: token.frontendSeq, tabId: token.tabId, epoch: token.epoch, stale: token.owner ? epoch(token.owner) !== token.epoch : true });
        }
        function reset(owner) {
            epochs.set(owner, epoch(owner) + 1);
            if (raw?.active && raw.owner === owner) stopRaw('session-reset');
            record('session-reset', { tabId: identifier(owner.tabId), epoch: epoch(owner) });
        }
        function inputSent(tabId, data) {
            if (!enabled) return null;
            const id = ++inputSequence;
            record('input-send', { tabId: identifier(tabId), diagnosticInputId: id, chars: typeof data === 'string' ? data.length : 0 });
            return id;
        }
        function snapshot(options = {}) {
            const ordered = records.slice(cursor).concat(records.slice(0, cursor));
            const result = { version: 1, enabled, reason, dropped: eventCount - records.length, clock: 'renderer-performance-ms', records: ordered.map(r => ({ ...r, ...(r.backend ? { backend: { ...r.backend } } : {}) })) };
            if (raw) {
                result.raw = { tabId: raw.tabId, epoch: raw.epoch, bytes: raw.bytes, active: raw.active, reason: raw.reason, chunkCount: raw.chunks.length };
                if (options.includeRaw === true) result.raw.chunks = raw.chunks.map(c => ({ ...c }));
            }
            return result;
        }
        return { get enabled() { return enabled; }, get sessionId() { return run; }, start, stop, snapshot, receive, routed, filtered, parsed, reset, inputSent,
            clear() { stop('cleared'); records = []; raw = null; cursor = 0; eventCount = 0; } };
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { createInteractionDiagnostics };
    else root.ZTermDiagnostics = createInteractionDiagnostics({ document: root.document, window: root,
        resolveSource(tabId) {
            for (const tab of TabManager.tabs) {
                if (tab.splitRoot) {
                    const owner = getAllPanes(tab).find(p => p.tabId === tabId);
                    if (owner) return { owner };
                } else if (tab.tabId === tabId) return { owner: tab };
            }
            return null;
        },
    });
    // Native tracing is a separate, explicit opt-in and has its own timeout.
    if (root.ZTermDiagnostics) root.ZTermDiagnostics.native = (action, options = {}) =>
        root.electron.ipcRenderer.invoke('pty-diagnostics', { ...options, action });
})(typeof globalThis !== 'undefined' ? globalThis : this);
