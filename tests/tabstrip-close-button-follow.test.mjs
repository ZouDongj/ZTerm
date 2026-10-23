// Tab-strip add/menu buttons following a tab close. Root cause of the fixed
// bug: #btn-add-tab/#btn-menu are flex siblings AFTER #tab-viewport (app.css),
// outside the FLIP capture/re-hold system that only iterates .tab elements —
// so on a close they teleported one beat late, when the dying slot collapsed
// at doRemove, instead of sliding with the follower tabs at close initiation.
// Driven through the REAL tabs.js in the shared renderer VM
// (tests/helpers/renderer-vm.mjs); only the environment is faked. The fake
// DOM carries no animation engine, so each relevant element is instrumented
// with a recording WAAPI surface: animate() stores a controllable fake
// Animation, getAnimations() reports the live ones — exactly the contract
// _slideStripTab/_cancelStripSlides consume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadVm, wiredTab } from './helpers/renderer-vm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(__dirname, '../src/renderer/app.css'), 'utf8');

// Body (declarations between the braces) of a single `selector{...}` rule.
const ruleBody = (selector) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, `rule not found: ${selector}`);
    return m[1];
};

// Recording WAAPI surface for one element: every animate() call lands in
// _animateCalls and stays live until cancel() removes it (the browser's
// getAnimations() reports unfinished, uncancelled animations).
function instrumentEl(el) {
    el._animations = [];
    el._animateCalls = [];
    el.animate = (keyframes, options) => {
        const anim = {
            id: '', keyframes, options, cancelled: false,
            cancel() {
                this.cancelled = true;
                const i = el._animations.indexOf(this);
                if (i >= 0) el._animations.splice(i, 1);
            },
        };
        el._animateCalls.push(anim);
        el._animations.push(anim);
        return anim;
    };
    el.getAnimations = () => el._animations.slice();
    return el;
}

const liveStripSlides = (el) => el.getAnimations().filter(a => a.id === 'zterm-strip-slide');

// `count` rendered local tabs with both strip buttons mounted (the shared
// stub pre-mounts only #btn-add-tab; the page mounts #btn-menu at init) and
// a recording WAAPI surface on every strip element. Instrumentation must
// come after the last render(): the render rebuilds every tab element.
function stripFixture(ctx, count = 3) {
    for (let i = 1; i <= count; i += 1) wiredTab(ctx, 't' + i, 'b' + i, null);
    ctx.TabManager.render();
    const bar = ctx.document.getElementById('tabbar');
    const menuBtn = ctx.document.createElement('div');
    menuBtn.id = 'btn-menu';
    bar.appendChild(menuBtn);
    ctx.TabManager.switchTo('t1'); // active-tab close: the realistic path
    const vp = ctx.document.getElementById('tab-viewport');
    vp.querySelectorAll('.tab').forEach(el => { el.offsetWidth = 120; instrumentEl(el); });
    const addBtn = instrumentEl(ctx.document.getElementById('btn-add-tab'));
    instrumentEl(menuBtn);
    return { bar, vp, addBtn, menuBtn };
}

test('close initiation slides the add/menu buttons along with the follower tabs', () => {
    const ctx = loadVm();
    const { vp, addBtn, menuBtn } = stripFixture(ctx);

    ctx.TabManager.closeTab('t1');

    for (const [label, btn] of [['#btn-add-tab', addBtn], ['#btn-menu', menuBtn]]) {
        assert.equal(btn._animateCalls.length, 1, `${label} received exactly one slide`);
        const call = btn._animateCalls[0];
        // Index-by-index comparison: keyframes was built inside the VM, and
        // deepEqual on a cross-realm array fails on the prototype alone.
        assert.equal(call.keyframes.length, 2, `${label} slide is a single from->to`);
        assert.equal(call.keyframes[0].transform, 'translateX(0px)', `${label} starts at the current offset`);
        assert.equal(call.keyframes[1].transform, 'translateX(-122px)',
            `${label} slides one dying slot (120px tab + 2px gap) to the left`);
        assert.equal(call.options.duration, 180, `${label} shares the tab slide duration`);
        assert.equal(call.options.easing, 'cubic-bezier(0.05, 0.7, 0.1, 1)', `${label} shares the tab slide curve`);
        assert.equal(call.options.fill, 'forwards', `${label} holds the slide until the slot collapses`);
        assert.equal(call.id, 'zterm-strip-slide', `${label} slide carries the scoped cancel id`);
    }
    // The follower tabs slide through the pre-existing mechanism, and the
    // dying tab itself is never slid (fade only, per the .tab-exit rule).
    assert.ok(vp.querySelector('.tab[data-tab="t2"]')._animateCalls.length >= 1, 'follower tab still slides');
    assert.equal(vp.querySelector('.tab[data-tab="t1"]')._animateCalls.length, 0, 'closing tab only fades');
});

test('the removal render cancels the button slide holds in the same settle', () => {
    const ctx = loadVm();
    const { addBtn, menuBtn } = stripFixture(ctx);

    ctx.TabManager.closeTab('t1');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 1, 'the hold is live inside the fade window');
    }

    ctx.__tq.advance(200); // doRemove: splice + render
    assert.equal(ctx.TabManager.tabs.length, 2, 'the dying tab is gone');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 0, 'the hold was cancelled as the slot collapsed');
        assert.ok(btn._animateCalls[0].cancelled, 'cancel(), not replacement, retired the hold');
    }
    // Nothing resurrects a hold afterwards.
    ctx.TabManager.render();
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 0, 'a later idle render leaves the buttons clean');
    }
});

test('a close burst keeps the button hold until the LAST dying slot settles', () => {
    const ctx = loadVm();
    const { addBtn, menuBtn } = stripFixture(ctx, 4);

    ctx.TabManager.closeTab('t1'); // removal at t=200
    ctx.TabManager.closeTab('t2'); // removal staggered to t=200+120
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(btn._animateCalls.length, 2, 'the second close re-targets the hold');
        assert.ok(btn._animateCalls[0].cancelled, 'the superseded hold was cancelled');
        assert.equal(liveStripSlides(btn).length, 1, 'exactly one live hold during the burst');
    }

    ctx.__tq.advance(200); // the first slot collapses; t2 is still dying
    assert.equal(ctx.TabManager.tabs.length, 3, 'only the first tab settled');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 1, 'still held: another dying slot is owed');
    }

    ctx.__tq.advance(120); // the second slot collapses
    assert.equal(ctx.TabManager.tabs.length, 2, 'both tabs settled');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 0, 'cancelled once the last dying slot collapsed');
    }
});

// The burst intermediate render must not just KEEP the hold — the settled
// slot's width already collapsed out of the layout, so the held offset is
// stale by exactly that width (the buttons would jump a full slot at each
// intermediate doRemove and snap back at the settle). The render re-anchors
// the hold onto the REMAINING dying width, like _reholdStripSlides does for
// the follower tabs.
test('the burst intermediate render re-anchors the button hold to the remaining dying width', () => {
    const ctx = loadVm();
    const { addBtn, menuBtn } = stripFixture(ctx, 4);

    ctx.TabManager.closeTab('t1');
    ctx.TabManager.closeTab('t2');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(btn._animateCalls.length, 2, 'burst: second close re-targeted the hold');
        assert.equal(liveStripSlides(btn).length, 1, 'burst: one live hold');
    }

    ctx.__tq.advance(200); // t1's slot collapses inside this render
    for (const btn of [addBtn, menuBtn]) {
        const live = liveStripSlides(btn);
        assert.equal(live.length, 1, 'one re-anchored hold, not a stale one');
        // Geometry note: render rebuilt the dying tab element, so the VM reads
        // its width as 0 — the remaining dying width here is just the 2px
        // strip gap (in a real layout: t2's 120px + 2). The pin is the
        // RETARGET to remaining-only, not the absolute figure.
        assert.equal(live[0].keyframes[1].transform, 'translateX(-2px)',
            'the hold retargets to the remaining dying slot only');
        assert.notEqual(live[0], btn._animateCalls[1], 'the re-anchor replaced the burst hold');
        assert.ok(btn._animateCalls[1].cancelled, 'the stale full-owed hold was cancelled');
    }
});

// doRemove's early return (the tab was already removed by another path) runs
// no render — the button hold from the close slide would linger until the
// next unrelated render. It settles inline now.
test('a doRemove that finds the tab already gone still settles the button hold', () => {
    const ctx = loadVm();
    const { addBtn, menuBtn } = stripFixture(ctx);

    ctx.TabManager.closeTab('t1');
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 1, 'hold armed by the close');
    }
    // Another path (drag-extract, teardown, ...) removes the tab before the
    // fade timer fires.
    ctx.TabManager.tabs.splice(ctx.TabManager.tabs.findIndex(t => t.id === 't1'), 1);

    ctx.__tq.advance(200); // doRemove takes the cur < 0 early return
    for (const btn of [addBtn, menuBtn]) {
        assert.equal(liveStripSlides(btn).length, 0, 'the hold settled without waiting for a render');
    }
});

// The buttons move on a close only when the viewport actually shrinks:
// overflow keeps it clamped to the availability, and sharing recomputes the
// widths at the removal unless the close deferral holds them (pointer over
// the strip). Sliding the buttons there would move them AWAY from their
// final position (a left-then-right bounce).
test('overflow keeps the buttons parked (the viewport width stays clamped)', () => {
    const ctx = loadVm();
    const { bar, addBtn, menuBtn } = stripFixture(ctx);
    bar.classList.add('tabbar-overflow'); // the state marker the guard reads

    ctx.TabManager.closeTab('t1');

    assert.equal(addBtn._animateCalls.length, 0, 'overflow: add button parked');
    assert.equal(menuBtn._animateCalls.length, 0, 'overflow: menu button parked');
});

test('sharing slides the buttons only while the close deferral pins the widths', () => {
    // Sharing without the pointer over the strip: the removal re-shares the
    // availability, the viewport width is unchanged — buttons parked.
    const ctx = loadVm();
    const { bar, addBtn, menuBtn } = stripFixture(ctx);
    bar.classList.add('tabbar-sharing');

    ctx.TabManager.closeTab('t1');

    assert.equal(addBtn._animateCalls.length, 0, 'sharing recompute: add button parked');
    assert.equal(menuBtn._animateCalls.length, 0, 'sharing recompute: menu button parked');

    // Sharing with the pointer over the strip: the deferral holds every
    // width, so the collapse shrinks the viewport by the dying slot — the
    // buttons must slide along.
    const ctx2 = loadVm();
    const f2 = stripFixture(ctx2);
    f2.bar.classList.add('tabbar-sharing');
    ctx2.TabManager._pointerInStrip = true; // closeTab arms the deferral

    ctx2.TabManager.closeTab('t1');

    assert.equal(f2.addBtn._animateCalls.length, 1, 'deferred sharing: add button slides');
    assert.equal(f2.menuBtn._animateCalls.length, 1, 'deferred sharing: menu button slides');
    assert.equal(f2.addBtn._animateCalls[0].options.fill, 'forwards', 'held until the collapse');
});

// CSS pin: cancelling a forwards-filled WAAPI transform must land on the
// same frame the slot collapses. A `transition:all` on the buttons would
// glide that reset over another 120ms (the transform is a transitioned
// property then), re-introducing visible drift.
test('CSS pin: the strip buttons transition background/color only, never transform', () => {
    for (const sel of ['#btn-add-tab', '#btn-menu']) {
        const body = ruleBody(sel);
        assert.ok(body.includes('transition:background 0.12s,color 0.12s'),
            `${sel} narrows the hover transition to the painted properties`);
        assert.ok(!body.includes('transition:all'), `${sel} must not transition transform (WAAPI cancel glide)`);
    }
});
