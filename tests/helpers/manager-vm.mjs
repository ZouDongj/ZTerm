// Shared VM harness for the manager/dialog renderer scripts (ssh.js,
// quick-commands.js + qc-utils.js): runs the REAL source files in one VM,
// faked is only the environment — a minimal DOM, an ipcRenderer recording
// bus, a queued timer wheel and toast/overlay spies. Modelled on
// tests/helpers/renderer-vm.mjs (kept separate: that VM owns the terminal
// stack and must not see these globals).
//
// Blink parity notes:
// - focus()/blur() track document.activeElement; blur() on the active
//   element falls back to <body> and dispatches one blur event.
// - replaceWith()/remove() on the ACTIVE element dispatches one SYNCHRONOUS
//   blur (Blink unloads the focused subtree), then focus falls to <body> —
//   the exact race behind the group-rename Esc defect these tests pin down.
// - dispatch() also invokes on<type> property handlers, as real events do.
// - document.getElementById auto-vivifies: dialog code reaches dozens of
//   static page elements by id; each is created once, attached to <body>,
//   and reused. Only simple selectors resolve (dot-chains, bare tags).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = f => readFileSync(new URL(`../../src/renderer/${f}`, import.meta.url), 'utf8');

function classSet(str) { return new Set(String(str || '').split(/\s+/).filter(Boolean)); }
function camel(k) { return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

export function mkEvt(init = {}) {
    return {
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...init,
    };
}

export function mkDoc() {
    const byId = new Map();
    const doc = { readyState: 'complete', activeElement: null, addEventListener() {} };

    // Simple selectors only: dot-chains ('.a.b') or a bare tag ('input').
    function matchesSimple(elm, sel) {
        if (!elm || !elm.tagName) return false;
        if (sel.startsWith('.')) {
            const cs = classSet(elm.className);
            return sel.split('.').filter(Boolean).every(c => cs.has(c));
        }
        return elm.tagName === sel.toUpperCase();
    }
    function queryAll(root, sel) {
        if (!/^(\.[A-Za-z0-9_-]+)+$/.test(sel) && !/^[a-zA-Z][a-zA-Z0-9]*$/.test(sel)) return [];
        const out = [];
        const walk = n => { n.children.forEach(c => { if (matchesSimple(c, sel)) out.push(c); walk(c); }); };
        walk(root);
        return out;
    }

    const mkEl = (tag = 'div') => {
        const el = {
            tagName: String(tag).toUpperCase(),
            style: {}, dataset: {}, children: [], parentElement: null,
            className: '', id: '', value: '', textContent: '', type: '',
            _listeners: new Map(), _attrs: new Map(), _innerHTML: '',
            get innerHTML() { return this._innerHTML; },
            set innerHTML(v) {
                this._innerHTML = String(v);
                this.children.forEach(c => { c.parentElement = null; });
                this.children = [];
            },
            setAttribute(k, v) {
                this._attrs.set(k, String(v));
                if (k === 'id') this.id = v;
                if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
            },
            getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; },
            appendChild(c) {
                if (c.parentElement) {
                    const i = c.parentElement.children.indexOf(c);
                    if (i >= 0) c.parentElement.children.splice(i, 1);
                }
                c.parentElement = this; this.children.push(c); return c;
            },
            remove() {
                if (this.parentElement) {
                    const i = this.parentElement.children.indexOf(this);
                    if (i >= 0) this.parentElement.children.splice(i, 1);
                }
                this.parentElement = null;
                if (doc.activeElement === this) {
                    doc.activeElement = doc.body;
                    this.dispatch('blur', mkEvt());
                }
            },
            replaceWith(node) {
                const p = this.parentElement;
                if (!p) return;
                const i = p.children.indexOf(this);
                if (i >= 0) p.children.splice(i, 1, node); else p.children.push(node);
                node.parentElement = p;
                this.parentElement = null;
                if (doc.activeElement === this) {
                    doc.activeElement = doc.body;
                    this.dispatch('blur', mkEvt());
                }
            },
            addEventListener(type, fn) {
                if (!this._listeners.has(type)) this._listeners.set(type, []);
                this._listeners.get(type).push(fn);
            },
            removeEventListener(type, fn) {
                const l = this._listeners.get(type) || [];
                const i = l.indexOf(fn);
                if (i >= 0) l.splice(i, 1);
            },
            dispatch(type, ev = mkEvt()) {
                (this._listeners.get(type) || []).slice().forEach(fn => fn(ev));
                const h = this['on' + type];
                if (typeof h === 'function') h(ev);
            },
            click() { this.dispatch('click', mkEvt()); },
            querySelector(sel) { return queryAll(this, sel)[0] || null; },
            querySelectorAll(sel) { return queryAll(this, sel); },
            contains(n) { let cur = n; while (cur) { if (cur === this) return true; cur = cur.parentElement; } return false; },
            closest(sel) {
                const sels = String(sel).split(',').map(s => s.trim());
                let cur = this;
                while (cur) {
                    if (sels.some(s => matchesSimple(cur, s))) return cur;
                    cur = cur.parentElement;
                }
                return null;
            },
            getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
            focus() { doc.activeElement = this; },
            blur() {
                if (doc.activeElement !== this) return;
                doc.activeElement = doc.body;
                this.dispatch('blur', mkEvt());
            },
            select() {},
            scrollIntoView() {},
        };
        el.classList = {
            add: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
            remove: (...cs) => { const s = classSet(el.className); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
            toggle: (c, force) => {
                const s = classSet(el.className);
                const on = force === undefined ? !s.has(c) : !!force;
                on ? s.add(c) : s.delete(c);
                el.className = [...s].join(' ');
                return on;
            },
            contains: c => classSet(el.className).has(c),
        };
        return el;
    };

    doc.body = mkEl('body');
    doc.activeElement = doc.body;
    doc.createElement = tag => mkEl(tag);
    doc.getElementById = id => {
        if (!byId.has(id)) { const el = mkEl(); el.id = id; byId.set(id, el); doc.body.appendChild(el); }
        return byId.get(id);
    };
    doc.querySelector = sel => queryAll(doc.body, sel)[0] || null;
    doc.querySelectorAll = sel => queryAll(doc.body, sel);
    return doc;
}

function baseCtx(doc) {
    const sends = [];
    const toasts = [];
    const timers = new Map();
    let seq = 0, now = 0;
    const ctx = {
        console,
        setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { id, fn, at: now + (Number(ms) || 0) }); return id; },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: fn => { fn(); return 0; },
        document: doc,
        ipcRenderer: {
            send: (cmd, payload) => sends.push({ cmd, payload }),
            once() {}, // recorded handlers are fired explicitly by tests if needed
            on() {},
            removeListener() {},
            invoke: () => new Promise(() => {}),
        },
        TabManager: { profiles: [], sshProfiles: [], getActive: () => null },
        Icons: { iconSvg: () => 'svg' },
        escHtml: s => String(s),
        escAttr: s => String(s),
        showToast: (msg, isError) => toasts.push({ msg, isError }),
        _settingsConfig: {},
        openOverlay() {},
        closeOverlay() {},
        closeAllOverlays() { ctx.__overlayCloseCalls++; },
        convertSelects() {},
        __sends: sends,
        __toasts: toasts,
        __overlayCloseCalls: 0,
        // Chronological sweep of the queued timers (nested ones included).
        __advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.values()].filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
                if (!due.length) break;
                timers.delete(due[0].id);
                if (due[0].at > now) now = due[0].at;
                due[0].fn();
            }
            now = target;
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    return ctx;
}

// Top-level `let` bindings (e.g. _qcCommands) are lexical to the VM's global
// scope — they are NOT reachable as context-object properties from the test
// side. Read or replace them by evaluating inside the context.
export function runIn(ctx, code) { return vm.runInContext(code, ctx); }

export function loadSshVm() {
    const ctx = baseCtx(mkDoc());
    vm.createContext(ctx);
    vm.runInContext(src('ssh.js'), ctx, { filename: 'ssh.js' });
    return ctx;
}

export function loadQcVm() {
    const ctx = baseCtx(mkDoc());
    vm.createContext(ctx);
    vm.runInContext(src('qc-utils.js'), ctx, { filename: 'qc-utils.js' });
    vm.runInContext(src('quick-commands.js'), ctx, { filename: 'quick-commands.js' });
    return ctx;
}
