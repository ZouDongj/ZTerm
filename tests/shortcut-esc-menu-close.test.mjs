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
//
// Follow-up: the menu popup is not on the shared modal layer stack, and the
// popup branch used to run BEFORE popModalLayer() — with a menu and a modal
// layer both open, Esc closed the menu instead of the topmost layer (LIFO
// violation). The layer check now precedes the popup branch.
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

test('(order) menu and a modal layer both open: Esc pops the topmost layer first (LIFO), menu second', () => {
    const f = fixture();
    f.openMenu();
    // The menu popup is NOT on the modal layer stack; stage a stack that has
    // one layer on top of it (fixture seam: utils.js is not loaded here).
    let popped = 0;
    f.ctx.popModalLayer = () => { popped++; return true; };

    const esc1 = f.keydown({ target: ESC_TARGET });
    assert.ok(esc1.defaultPrevented, 'first Esc consumed by the modal-layer branch');
    assert.equal(popped, 1, 'the topmost modal layer pops before the menu');
    assert.ok(f.popup().classList.contains('open'), 'the menu underneath survives the first Esc');

    f.ctx.popModalLayer = () => false; // layer popped, stack drained
    const esc2 = f.keydown({ target: ESC_TARGET });
    assert.ok(esc2.defaultPrevented, 'second Esc reaches the menu branch');
    assert.ok(allClosed(f), 'menu fully closed on the second Esc');
});

// Follow-up (mouse entry into the SSH manager): Ctrl+Shift+S was the only
// way into the SSH manager overlay. The ⋮ menu now ships an item that first
// closes the menu (closeMenuPopup) and then reuses the exact overlay opener
// the keyboard binding uses (openSSHManager) — no parallel open path. The
// structural contract below reads the REAL renderer.html, so a dropped,
// rewired or duplicated entry fails here before it ships.
test('menu popup: SSH manager entry reuses openSSHManager after closing the menu', () => {
    const html = fs.readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');
    const idAt = html.indexOf('id="menu-popup"');
    assert.notEqual(idAt, -1, '#menu-popup exists in renderer.html');
    // Balanced <div> scan scoped to #menu-popup (a bare class search would
    // bleed into the separate #ssh-add-menu popup further down the page).
    const start = html.lastIndexOf('<div', idAt);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    let match;
    let popup = null;
    while ((match = tags.exec(html))) {
        depth += match[0] === '</div>' ? -1 : 1;
        if (depth === 0) { popup = html.slice(start, tags.lastIndex); break; }
    }
    assert.ok(popup, '#menu-popup block extracted');
    // Menu items are flat one-line divs (spans only, no nested divs).
    const items = popup.match(/<div class="menu-item"[^>]*>[\s\S]*?<\/div>/g) || [];
    assert.ok(items.length >= 5, `menu items parsed (${items.length})`);
    const entries = items.filter(it => it.includes('data-action="sshPanel"'));
    assert.equal(entries.length, 1, 'exactly one SSH manager entry lives in #menu-popup');
    const entry = entries[0];
    assert.ok(entry.includes('onclick="closeMenuPopup();openSSHManager()"'),
        'the item closes the menu and reuses the Ctrl+Shift+S overlay opener');
    assert.ok(entry.includes('<span class="menu-label">SSH 配置管理</span>'), 'label text');
    assert.ok(entry.includes('<span class="menu-shortcut" data-action="sshPanel"></span>'),
        'shortcut metadata (updateMenuShortcuts fills it from the sshPanel binding)');
    assert.ok(entry.includes('data-app-icon="server"'), 'menu icon via the shared icon system');
});
