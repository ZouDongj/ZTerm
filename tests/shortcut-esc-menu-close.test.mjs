// Regression: the document-level Esc dispatcher closed the top-bar menu by
// removing only #menu-popup.open. The proper close path (closeMenuPopup() in
// ssh.js — what the backdrop click and every menu item use) also clears
// #menu-backdrop.open and body.menu-open. The backdrop is a fullscreen
// position:fixed z-index:299 layer (display:none until .open), so after Esc
// the INVISIBLE backdrop kept covering the page: the next click anywhere hit
// it (its onclick just closes the menu) and was swallowed — e.g. the first
// click on "+", a tab or the terminal did nothing.
//
// Fix: the Esc branch calls closeMenuPopup(). Loaded here are the REAL
// shortcut-utils.js + ssh.js + shortcuts.js (page load order, renderer.html),
// staged through the REAL toggleMenuPopup(); faked is only the environment
// (auto-vivifying document from the manager seam + a listener registry so the
// capture-phase keydown dispatcher is drivable).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mkEvt, mkDoc } from './helpers/manager-vm.mjs';

const src = f => fs.readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');

function fixture() {
    const listeners = new Map();
    const doc = mkDoc();
    // The manager seam's document swallows addEventListener; driving the
    // document-level keydown dispatcher needs a real registry (capture keys
    // kept separate, like the page).
    doc.addEventListener = (type, fn, capture) => {
        const key = type + (capture ? ':c' : ':b');
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
    };
    doc.removeEventListener = () => {};

    const timers = new Map();
    let seq = 0;
    const ctx = {
        console,
        document: doc,
        setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: fn => { fn(); return 0; },
        ipcRenderer: { send() {}, once() {}, on() {}, removeListener() {}, invoke: () => new Promise(() => {}) },
        TabManager: { profiles: [], sshProfiles: [], tabs: [], getActive: () => null },
        Icons: { iconSvg: () => 'svg' },
        escHtml: s => String(s),
        escAttr: s => String(s),
        showToast() {},
        _settingsConfig: {},
        openOverlay() {},
        closeOverlay() {},
        closeAllOverlays() { ctx.__overlayCloses++; },
        convertSelects() {},
        _refocusActiveTerminal() {},
        __overlayCloses: 0,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src('shortcut-utils.js'), ctx, { filename: 'shortcut-utils.js' });
    vm.runInContext(src('ssh.js'), ctx, { filename: 'ssh.js' });
    vm.runInContext(src('shortcuts.js'), ctx, { filename: 'shortcuts.js' });

    const keydown = (init = {}) => {
        const ev = mkEvt({ key: 'Escape', isComposing: false, keyCode: 0, ...init });
        (listeners.get('keydown:c') || []).slice().forEach(fn => fn(ev));
        return ev;
    };
    return {
        ctx, doc, keydown,
        popup: () => doc.getElementById('menu-popup'),
        backdrop: () => doc.getElementById('menu-backdrop'),
        // Real open path: popup + backdrop + body.menu-open all set at once.
        openMenu: () => ctx.toggleMenuPopup(),
    };
}

// Esc from the terminal comes from xterm's helper textarea; never an
// inline-edit input in these scenarios.
const ESC_TARGET = { tagName: 'TEXTAREA', classList: { contains: () => false } };

const allClosed = (f) =>
    !f.popup().classList.contains('open')
    && !f.backdrop().classList.contains('open')
    && !f.doc.body.classList.contains('menu-open');

test('Escape on the open menu clears popup, backdrop and body.menu-open together', () => {
    const f = fixture();
    f.openMenu();
    assert.ok(f.popup().classList.contains('open'), 'staged: menu popup open');
    assert.ok(f.backdrop().classList.contains('open'), 'staged: backdrop open');
    assert.ok(f.doc.body.classList.contains('menu-open'), 'staged: body.menu-open set');

    const ev = f.keydown({ target: ESC_TARGET });
    assert.equal(ev.defaultPrevented, true, 'the Esc keydown is consumed');
    assert.equal(ev.propagationStopped, true, 'and not passed to xterm');
    assert.ok(allClosed(f),
        'closeMenuPopup() cleared all three states — the invisible fullscreen '
        + 'backdrop no longer covers the page, so the next click is not swallowed');
});

test('(control) menu closed, no overlay: Esc passes through untouched', () => {
    const f = fixture();
    const ev = f.keydown({ target: ESC_TARGET });
    assert.equal(ev.defaultPrevented, false, 'plain Esc still reaches the terminal (vim etc.)');
    assert.equal(ev.propagationStopped, false);
    assert.equal(f.ctx.__overlayCloses, 0, 'no overlay was touched');
    assert.ok(allClosed(f), 'menu state stays closed');
});

test('(control) menu closed, overlay open: Esc still closes the overlay via closeAllOverlays', () => {
    const f = fixture();
    const overlay = f.doc.createElement('div');
    overlay.className = 'overlay open';
    f.doc.body.appendChild(overlay);

    const ev = f.keydown({ target: ESC_TARGET });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(f.ctx.__overlayCloses, 1, 'the overlay branch still runs when the menu is closed');
    assert.ok(allClosed(f), 'the menu popup never opens as a side effect');
});

test('(order) menu and overlay both open: first Esc closes only the menu, second the overlay', () => {
    const f = fixture();
    f.openMenu();
    const overlay = f.doc.createElement('div');
    overlay.className = 'overlay open';
    f.doc.body.appendChild(overlay);

    const esc1 = f.keydown({ target: ESC_TARGET });
    assert.ok(esc1.defaultPrevented, 'first Esc consumed by the menu branch');
    assert.equal(f.ctx.__overlayCloses, 0, 'the overlay underneath is left open (existing precedence)');
    assert.ok(overlay.classList.contains('open'), 'overlay untouched');
    assert.ok(allClosed(f), 'menu fully closed');

    const esc2 = f.keydown({ target: ESC_TARGET });
    assert.ok(esc2.defaultPrevented, 'second Esc consumed by the overlay branch');
    assert.equal(f.ctx.__overlayCloses, 1, 'overlay closed on the second Esc');
});
