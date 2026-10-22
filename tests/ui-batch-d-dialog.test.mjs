// UI batch D — SSH add/edit dialog + settings accent cluster (review
// dev/docs/reviews/ui-batch-consolidated-2026-10-21.md), driven through the
// REAL ssh.js (tests/helpers/manager-vm.mjs) and the REAL
// color-utils.js/state.js/settings.js (accent VM below).
//
// U-04: the key-auth password branch was only dimmed (opacity +
// pointer-events:none): Tab/Enter still reached the 修改/eye/✓/× buttons and a
// typed plaintext could be saved inline while authType was 密钥. The branch is
// hidden again (display:none — no tab stops for any descendant), the inputs
// stay disabled as a second layer, a revealed plaintext is masked on the
// switch, and _savePasswordInline has a logic-level key-auth guard.
// U-10: the accent hex field's onchange chain (updateAccentDot) used to move
// only the visible tick (.active); aria-checked stayed on the old preset.
// updateAccentDot is now the single sync point for .active / aria-checked /
// roving tabindex on every accent path.
// U-11: the accent radiogroup rendered 8 tab stops with no arrow-key model;
// it now has a roving tabindex (one stop, on the checked swatch — or the
// first when a custom hex checks nothing) and Arrow/Home/End move+select.
// U-14: the auth segmented slider was measured while the overlay was
// display:none (0) and the first real write ~100ms later animated a grow
// from zero width; unmeasurable writes are now skipped and the first
// measurable placement goes transitions off → place → flush → restore.
//
// Auth-switch row geometry: the U-04 fix hid the password form-group but
// showed a second grid row for key auth, so switching auth jumped the dialog
// height by a full row (66px measured). The key form-group now shares
// #ssh-pwd-row with the password field — pinned below by a markup-structure
// test plus a VM visibility-swap test.
//
// CSS-geometry-only parts are NOT covered here: the U-09 short-window panel
// cap/scroll/sticky footer (stylesheet contract pinned in
// ui-batch-d-css.test.mjs) and the U-17 34px segmented-control baseline are
// pure app.css rules with no VM-observable logic.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSshVm, mkDoc, mkEvt, runIn } from './helpers/manager-vm.mjs';

const src = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
const pageHtml = readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');

// Extract the balanced <div>…</div> block whose open tag carries id="<id>".
function divBlock(html, id) {
    const start = html.indexOf(`id="${id}"`);
    assert.notEqual(start, -1, `#${id} exists in renderer.html`);
    const tagStart = html.lastIndexOf('<div', start);
    const re = /<div\b|<\/div>/g;
    re.lastIndex = tagStart;
    let depth = 0, m;
    while ((m = re.exec(html))) {
        depth += m[0] === '</div>' ? -1 : 1;
        if (depth === 0) return html.slice(tagStart, re.lastIndex);
    }
    assert.fail(`#${id} block never closes`);
}

// The segmented control's two tabs as the real markup has them
// (renderer.html #ssh-auth-tabs); the harness only auto-vivifies by-id
// elements, so the buttons are built here.
function buildAuthTabs(ctx) {
    const tabs = ctx.document.getElementById('ssh-auth-tabs');
    for (const auth of ['密码', '密钥']) {
        const b = ctx.document.createElement('button');
        b.className = 'auth-tab' + (auth === '密码' ? ' active' : '');
        b.setAttribute('data-auth', auth);
        tabs.appendChild(b);
    }
    return [...tabs.children];
}

// ── U-04: inactive auth branch inertness ────────────────────────────────────

test('U-04: switching to key auth hides the password branch and masks a revealed plaintext', () => {
    const ctx = loadSshVm();
    buildAuthTabs(ctx);
    const pwdInput = ctx.document.getElementById('ssh-edit-password');
    const eye = ctx.document.getElementById('ssh-pwd-inline-eye');
    // Worst case from the review: a typed plaintext currently revealed.
    pwdInput.value = 's3cret';
    pwdInput.type = 'text';
    eye.classList.add('active');

    ctx.setSSHAuth('密钥');

    assert.equal(ctx.document.getElementById('ssh-pwd-field').style.display, 'none',
        'password form-group display:none — removes every descendant tab stop and pointer target at once');
    assert.notEqual(ctx.document.getElementById('ssh-pwd-row').style.display, 'none',
        'the row itself stays: the note sharing it is auth-independent');
    assert.equal(ctx.document.getElementById('ssh-key-row').style.display, '', 'key branch shown');
    assert.equal(pwdInput.disabled, true, 'input disabled as a second inertness layer');
    assert.equal(ctx.document.getElementById('ssh-edit-keypath').disabled, false);
    assert.equal(ctx.document.getElementById('ssh-key-browse').disabled, false);
    assert.equal(pwdInput.type, 'password', 'revealed plaintext masked on the switch');
    assert.equal(eye.classList.contains('active'), false, 'eye active-state reset');
    assert.equal(pwdInput.value, 's3cret',
        'masked, not cleared: the value is never persisted under key auth, and an accidental toggle must not destroy it');
});

test('U-04: switching back to password auth restores the branch, still masked', () => {
    const ctx = loadSshVm();
    buildAuthTabs(ctx);
    const pwdInput = ctx.document.getElementById('ssh-edit-password');
    pwdInput.value = 's3cret';
    pwdInput.type = 'text';

    ctx.setSSHAuth('密钥');
    ctx.setSSHAuth('密码');

    assert.equal(ctx.document.getElementById('ssh-pwd-field').style.display, '', 'password branch visible again');
    assert.equal(ctx.document.getElementById('ssh-key-row').style.display, 'none', 'key branch hidden');
    assert.equal(pwdInput.disabled, false);
    assert.equal(ctx.document.getElementById('ssh-edit-keypath').disabled, true);
    assert.equal(pwdInput.type, 'password', 'round trip never re-exposes plaintext');
    assert.equal(pwdInput.value, 's3cret', 'typed value survives the toggle');
});

test('U-04: the inline password save cannot persist under key auth', async () => {
    const ctx = loadSshVm();
    buildAuthTabs(ctx);
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => { calls.push({ cmd, payload }); return Promise.resolve({ encrypted: 'enc1' }); };
    runIn(ctx, `_editingSSHId = 'p1'`);
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h' }];
    // A plaintext is staged as if typed before the switch (the branch is
    // hidden, so only the guard stands between it and the credential store).
    ctx.document.getElementById('ssh-edit-password').value = 's3cret';

    ctx.setSSHAuth('密钥');
    await ctx._savePasswordInline();

    assert.equal(calls.length, 0, 'no encrypt/save IPC under key auth');
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, undefined, 'profile untouched');
});

test('U-04 (control): under password auth the inline save still persists', async () => {
    const ctx = loadSshVm();
    buildAuthTabs(ctx);
    const calls = [];
    ctx.ipcRenderer.invoke = (cmd, payload) => { calls.push({ cmd, payload }); return Promise.resolve({ encrypted: 'enc1' }); };
    runIn(ctx, `_editingSSHId = 'p1'`);
    ctx.TabManager.sshProfiles = [{ id: 'p1', name: 'n', host: 'h' }];
    ctx.document.getElementById('ssh-edit-password').value = 's3cret';

    ctx.setSSHAuth('密码');
    await ctx._savePasswordInline();

    assert.deepEqual(calls.map(c => c.cmd), ['encrypt-password', 'save-ssh-profiles']);
    assert.equal(ctx.TabManager.sshProfiles[0].encryptedPassword, 'enc1');
});

// ── Auth-switch row geometry (height-stable dialog) ─────────────────────────
// Regression introduced by the U-04 fix (3d69fc2): key mode hid only the
// password form-group but showed a SECOND grid row (the standalone
// #ssh-key-row form-row) underneath, so switching 密码↔密钥 moved the dialog
// height by a full row (66px measured). The key form-group now lives inside
// #ssh-pwd-row as a sibling of the password field: exactly one of the two is
// visible per mode, the note always keeps the second cell, and both modes
// render the same single grid row.

test('the key field is a sibling of the password field inside #ssh-pwd-row', () => {
    const row = divBlock(pageHtml, 'ssh-pwd-row');
    const keyTag = row.match(/<div class="form-group" id="ssh-key-row"[^>]*>/);
    assert.ok(keyTag, 'the key form-group keeps id="ssh-key-row" after the move');
    assert.ok(keyTag[0].includes('display:none'), 'key branch starts hidden (password is the default auth)');
    assert.ok(!keyTag[0].includes('grid-column'), 'single grid cell — no full-width span');
    const order = ['id="ssh-pwd-field"', 'id="ssh-key-row"', 'id="ssh-edit-note"']
        .map(marker => row.indexOf(marker));
    assert.ok(order.every(i => i >= 0), 'password field, key field and note all live in the same row');
    assert.ok(order[0] < order[1] && order[1] < order[2],
        'grid order keeps [password|key][note] in both modes');
    assert.ok(!pageHtml.includes('<div class="form-row" id="ssh-key-row"'),
        'the standalone key form-row is gone — it was the second row that jumped the dialog height');
});

test('both auth modes show exactly one credential branch inside the same row', () => {
    const ctx = loadSshVm();
    buildAuthTabs(ctx);
    for (const auth of ['密码', '密钥']) {
        ctx.setSSHAuth(auth);
        const pwdShown = ctx.document.getElementById('ssh-pwd-field').style.display !== 'none';
        const keyShown = ctx.document.getElementById('ssh-key-row').style.display !== 'none';
        assert.notEqual(pwdShown, keyShown,
            `${auth}: exactly one credential branch occupies the row's first cell`);
        assert.notEqual(ctx.document.getElementById('ssh-pwd-row').style.display, 'none',
            `${auth}: the shared row itself never hides (the note is auth-independent)`);
    }
});

// ── U-14: auth slider first-frame suppression ───────────────────────────────

test('U-14: the auth slider skips unmeasurable writes and places the first frame without transition', () => {
    const ctx = loadSshVm();
    const [pwTab, keyTab] = buildAuthTabs(ctx);
    const slider = ctx.document.getElementById('ssh-auth-slider');
    const transitionWrites = [];
    Object.defineProperty(slider.style, 'transition', {
        get() { return this._t; },
        set(v) { transitionWrites.push(v); this._t = v; },
        configurable: true,
    });

    // The fake DOM has no layout — elements are unmeasurable exactly like the
    // real display:none overlay at dialog-open time.
    ctx.setSSHAuth('密钥');
    assert.ok(!slider.style.width, 'no zero-measure write while the dialog is hidden');

    // Once painted, the first measurable sync places instantly.
    pwTab.offsetLeft = 3; pwTab.offsetWidth = 60;
    keyTab.offsetLeft = 65; keyTab.offsetWidth = 60;
    ctx._syncSSHAuthTabs();
    assert.equal(slider.style.width, '60px');
    assert.equal(slider.style.left, '65px');
    assert.deepEqual(transitionWrites, ['none', ''], 'transitions off → place → flush → restore');
    assert.equal(slider.style.transition, '', 'transition restored afterwards');

    // A genuine auth switch still takes the animated path.
    ctx.setSSHAuth('密码');
    assert.equal(slider.style.left, '3px');
    assert.equal(transitionWrites.length, 2, 'animated path never touches the transition property');
});

test('U-14: every dialog open resets the slider so its first placement is instant again', () => {
    const ctx = loadSshVm();
    const [pwTab, keyTab] = buildAuthTabs(ctx);
    pwTab.offsetLeft = 3; pwTab.offsetWidth = 60;
    keyTab.offsetLeft = 65; keyTab.offsetWidth = 60;
    const slider = ctx.document.getElementById('ssh-auth-slider');
    ctx.document.getElementById('ssh-edit-auth').value = '密码';
    ctx._syncSSHAuthTabs();
    assert.equal(slider.style.width, '60px', 'slider carries a stale placement from the last open');

    const widthWrites = [];
    Object.defineProperty(slider.style, 'width', {
        get() { return this._w; },
        set(v) { widthWrites.push(v); this._w = v; },
        configurable: true,
    });
    ctx.openSSHEdit(true);
    ctx.__advance(200); // openSSHEdit's deferred slider/select/focus pass

    assert.equal(widthWrites[0], '', 'open clears the stale inline placement first');
    assert.equal(widthWrites[widthWrites.length - 1], '60px', 'then re-places once measurable');
});

// ── Accent VM (U-10/U-11): REAL color-utils.js + state.js + settings.js ────
// state.js computes CONFIG_FILE from path/process at load; the persistence
// tail of saveAppearance is out of scope here and stubbed after load.

function loadAccentVm() {
    const doc = mkDoc();
    doc.documentElement = { style: { setProperty() {} } };
    const origCreate = doc.createElement;
    doc.createElement = (tag) => {
        const el = origCreate(tag);
        el.style.setProperty = (k, v) => { el.style[k] = v; };
        return el;
    };
    const ctx = {
        console,
        setTimeout: () => 0,
        requestAnimationFrame: (fn) => { fn(); return 0; },
        document: doc,
        path,
        process: { env: { APPDATA: 'x' } },
        ipcRenderer: { send() {}, once() {}, on() {}, removeListener() {}, invoke: () => new Promise(() => {}) },
        TabManager: { tabs: [], sshProfiles: [], render() {} },
        Icons: { iconSvg: () => 'svg' },
        showToast() {},
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['color-utils.js', 'state.js', 'settings.js']) {
        vm.runInContext(src(f), ctx, { filename: f });
    }
    vm.runInContext('saveAppearance = () => {}', ctx);
    return ctx;
}

const swatchesOf = (ctx) => [...ctx.document.getElementById('accent-swatches').children];
const checkedIdx = (ctx) => swatchesOf(ctx).findIndex(sw => sw.getAttribute('aria-checked') === 'true');
const tabStopIdx = (ctx) => swatchesOf(ctx).findIndex(sw => sw.getAttribute('tabindex') === '0');

test('U-10: the hex-field path moves aria-checked and the tab stop together with the tick', () => {
    const ctx = loadAccentVm();
    const input = ctx.document.getElementById('set-accent');
    input.value = '#61afef';
    ctx.renderAccentSwatches();
    assert.equal(swatchesOf(ctx).length, 8);
    assert.equal(checkedIdx(ctx), 0);
    assert.equal(tabStopIdx(ctx), 0);

    // The exact hex-field chain: onchange="updateAccentDot();saveAppearance()".
    input.value = '#9CA3FF';
    ctx.updateAccentDot();

    assert.equal(checkedIdx(ctx), 1, 'aria-checked follows the hex-typed preset');
    assert.equal(tabStopIdx(ctx), 1, 'roving tab stop follows too');
    assert.equal(swatchesOf(ctx)[1].classList.contains('active'), true, 'visible tick agrees');
    assert.equal(swatchesOf(ctx).filter(sw => sw.getAttribute('tabindex') === '0').length, 1,
        'exactly one tab stop in the radiogroup');
});

test('U-10: a custom hex checks no preset but keeps the group keyboard-reachable', () => {
    const ctx = loadAccentVm();
    const input = ctx.document.getElementById('set-accent');
    input.value = '#61afef';
    ctx.renderAccentSwatches();

    input.value = '#123456';
    ctx.updateAccentDot();

    assert.equal(checkedIdx(ctx), -1, 'no preset is checked');
    assert.equal(swatchesOf(ctx).filter(sw => sw.classList.contains('active')).length, 0, 'no tick');
    assert.equal(tabStopIdx(ctx), 0, 'the tab stop falls back to the first swatch');
});

test('U-11: arrows/Home/End move and select; Space/Enter stay on the native click path', () => {
    const ctx = loadAccentVm();
    const input = ctx.document.getElementById('set-accent');
    input.value = '#61afef';
    ctx.renderAccentSwatches();
    const container = ctx.document.getElementById('accent-swatches');
    const sw = swatchesOf(ctx);

    sw[0].focus();
    container.dispatch('keydown', mkEvt({ key: 'ArrowRight' }));
    assert.equal(ctx.document.activeElement, sw[1], 'arrow moves focus');
    assert.equal(input.value.toUpperCase(), '#9CA3FF', 'arrow also selects');
    assert.equal(checkedIdx(ctx), 1);
    assert.equal(tabStopIdx(ctx), 1, 'tab stop follows the selection');

    container.dispatch('keydown', mkEvt({ key: 'ArrowLeft' }));
    container.dispatch('keydown', mkEvt({ key: 'ArrowLeft' }));
    assert.equal(ctx.document.activeElement, sw[7], 'ArrowLeft wraps around the start');
    assert.equal(input.value.toUpperCase(), '#87CEEB');

    container.dispatch('keydown', mkEvt({ key: 'Home' }));
    assert.equal(ctx.document.activeElement, sw[0]);
    assert.equal(input.value.toUpperCase(), '#61AFEF');
    container.dispatch('keydown', mkEvt({ key: 'End' }));
    assert.equal(ctx.document.activeElement, sw[7]);

    // Space/Enter must keep the native button activation (click →
    // selectAccent): the radiogroup handler neither prevents the default nor
    // changes the selection for them.
    const before = input.value;
    for (const key of [' ', 'Enter']) {
        const ev = mkEvt({ key });
        container.dispatch('keydown', ev);
        assert.equal(ev.defaultPrevented, false, `${key} not intercepted`);
        assert.equal(input.value, before, `${key} does not move the selection by itself`);
    }
});

test('U-11 (control): a swatch click still selects and roves the tab stop', () => {
    const ctx = loadAccentVm();
    ctx.document.getElementById('set-accent').value = '#61afef';
    ctx.renderAccentSwatches();
    const sw = swatchesOf(ctx);

    sw[2].click();

    assert.equal(ctx.document.getElementById('set-accent').value, '#8BC4FF');
    assert.equal(checkedIdx(ctx), 2);
    assert.equal(tabStopIdx(ctx), 2);
});
