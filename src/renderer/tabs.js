// ZTerm - tab management (the entire TabManager object) (split out of renderer.html as a pure code move, logic unchanged)
const GAP_PX = 8; // fixed pixel gap between panes

// Tab-strip slide animations (WAAPI, composite transforms only — layout
// transitions stay banned on the strip; see the .tab-exit comment in
// app.css). Every slide this code creates carries this id so cancel/filter
// never touches unrelated animations (CSS color transitions, bell flash)
// living on the same element.
const STRIP_SLIDE_ID = 'zterm-strip-slide';

function _cancelStripSlides(el) {
    if (!el.getAnimations) return;
    try { el.getAnimations().forEach(a => { if (a.id === STRIP_SLIDE_ID) a.cancel(); }); } catch (e) {}
}

// An element's current composited translateX (0 when unanimated): the
// computed style reflects in-flight WAAPI values, so a follow-up slide
// chains from where the tab actually is instead of snapping back to 0.
function _stripSlideOffset(el) {
    try {
        const t = getComputedStyle(el).transform;
        if (!t || t === 'none') return 0;
        const e = new DOMMatrixReadOnly(t).e;
        return Number.isFinite(e) ? e : 0;
    } catch (e) { return 0; }
}

// Slide a strip tab by `delta` from its CURRENT visual offset — a rapid
// close burst retargets the follower mid-flight instead of restarting it
// from 0 (which read as a right-then-left jump).
function _slideStripTab(el, delta, fill) {
    const from = _stripSlideOffset(el);
    _cancelStripSlides(el);
    try {
        const anim = el.animate(
            [{ transform: `translateX(${from}px)` }, { transform: `translateX(${from + delta}px)` }],
            { duration: 180, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)', fill: fill || 'none' });
        anim.id = STRIP_SLIDE_ID;
    } catch (e) {}
}

// Look up loginScripts from the SSH profile
function _getLoginScripts(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return [];
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return (profile && profile.loginScripts) || [];
}

// Look up clearOnConnect from the SSH profile (default true: clear the terminal on reconnect; false: keep previous content)
function _clearOnConnect(tab, pane) {
    const profileId = (pane && pane._sshProfileId) || tab.sshProfileId;
    if (!profileId) return true;
    const profile = (TabManager.sshProfiles || []).find(p => p.id === profileId);
    return !profile || profile.clearOnConnect !== false;
}

// Single source of every local pty-create payload. Adds colorFgbg: ConPTY
// swallows the shell's OSC 10/11 color queries, so TUI apps fall back to the
// COLORFGBG env var (rxvt convention) to detect light/dark backgrounds —
// seed it from the rendered scheme so their default colors match the theme.
// Both getTerminalTheme and colorFgbgForBackground are cross-script globals
// (state.js / color-utils.js load before this file, same mechanism as
// _settingsConfig below). A null colorFgbg (invalid background) is omitted by
// the backend's strict whitelist, so an unparsable value degrades to today's
// behavior instead of throwing.
function _ptyCreatePayload(shell, args, cwd, requestId) {
    return {
        shell, args, cwd: cwd || undefined, requestId,
        colorFgbg: colorFgbgForBackground(getTerminalTheme().background),
    };
}

// SSH connect with credential fallback: after a main-process restart all
// credentialId handles are dead, so re-register from the SSH profile when no
// valid credential is at hand (plaintext never passes through the renderer).
// ALL outbound ssh-connect traffic goes through _enqueueSshConnect's
// app-wide serial queue (session restore, splits, interactive creation,
// reconnects) so concurrent handshakes can never race strict sshd configs.
// Every connect is one ATTEMPT (ssh-attempts.js): its OWN invocation promise
// settles only its queue slot — lifecycle events never release the queue,
// and nothing is keyed by a display address.
let _sshConnectChain = Promise.resolve();

function _enqueueSshConnect(profile, token) {
    // Rust's early validation (missing host/username/attemptId) rejects the
    // invocation WITHOUT emitting ssh-error — no event will ever settle this
    // attempt. Terminate it here through the same shared transition so the
    // owner sees the failure once and the record retires (no-event path).
    if (!profile || !profile.host || !profile.username) {
        console.warn('[ssh] dropping connect with missing host/username, attemptId=' + token);
        sshAttempts.onRpcTerminal(token, 'failed', null, 'ssh-connect: missing host or username');
        return;
    }
    _sshConnectChain = _sshConnectChain.then(() => new Promise((release) => {
        // Unsent requests of closed/replaced owners never start: the owner
        // binding tracks migrations, and closing cancels the attempt.
        if (!sshAttempts.ownerWants(token)) { release(); return; }
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Release the slot through the registry (exactly-once, no
            // re-entry: releaseSlot clears its waiters before calling).
            sshAttempts.releaseSlot(token);
            release();
        };
        // Fallback for pathological non-settlement ONLY: it releases the
        // queue slot but never retires the attempt — a legitimate late
        // result still routes (the record stays addressable/cancellable).
        const timer = setTimeout(finish, 20000);
        sshAttempts.armSlot(token, finish);
        // The invocation is now actually in flight: from here a cancellation
        // keeps the record addressable for its own late settlement. Before
        // this point, cancelling an attempt retires it immediately (it has
        // no native counterpart that could ever answer).
        sshAttempts.markInvoked(token);
        ipcRenderer.invoke('ssh-connect', { profile, attemptId: token }).then(
            (r) => { sshAttempts.onRpcTerminal(token, r && r.cancelled ? 'cancelled' : 'ok', r && r.tabId); finish(); },
            (e) => { sshAttempts.onRpcTerminal(token, 'failed', null, String(e)); finish(); },
        );
    }));
}

// Cancel the SSH attempt an owner currently awaits, by immutable identity:
// the backend id when the owner holds one (authoritative; Rust locates that
// pending generation anywhere), else the attempt token. Destroys a
// registered session by backend id exactly as before. Never selects by a
// display address. channel stays 'pty-destroy' for close/teardown and
// 'ssh-disconnect' for reconnect/retry, matching the existing producers.
function _cancelSshAttemptOf(owner, backendId, channel) {
    if (!owner) return;
    const token = sshAttempts.ownerAttempt(owner);
    if (!token && !backendId) return;
    const payload = {};
    if (backendId) payload.tabId = backendId;
    if (token) {
        payload.attemptId = token;
        sshAttempts.cancelAttempt(token);
    }
    ipcRenderer.send(channel || 'pty-destroy', payload);
}

// Global credential-reference check for revocation: does any wrapper other
// than excludePane still hold credId? Handles are minted fresh per
// registration (the main process never dedupes), so one id is shared only
// where the renderer copied it (clone tabs, pane-extraction adoption, split
// inheritance, cross-tab pane moves). Revoking while another wrapper still
// holds the id kills that wrapper's reconnect for good — the connect path
// keeps sending the dead id and never falls back to the profile — so only
// the LAST referencing wrapper's close may revoke. A pane committed to
// close (_closing) is not a surviving reference: it can never reconnect.
function _credIdStillReferenced(tabs, credId, excludePane) {
    if (credId == null) return false;
    for (const t of tabs) {
        if (t._credId === credId) return true;
        if (t.splitRoot) {
            for (const p of getAllPanes(t)) {
                if (p === excludePane || p._closing) continue;
                if (p._sshCredId === credId) return true;
            }
        }
    }
    return false;
}

function _sshConnectWithCredentials(tab, pane) {
    const isPane = !!pane;
    // One NEW attempt per initiated connect: reconnect/retry callers cancel
    // the previous attempt by identity before reaching here. The token is
    // bound to the wrapper that awaits it and follows it through migrations.
    const token = sshAttempts.createAttempt(pane || tab);
    const host = isPane ? (pane._sshHost || tab.host) : tab.host;
    const port = isPane ? (pane._sshPort || tab.port) : tab.port;
    const user = isPane ? (pane._sshUser || tab.user) : tab.user;
    const credId = isPane ? (pane._sshCredId || tab._credId) : tab._credId;
    const pId = isPane ? (pane._sshProfileId || tab.sshProfileId) : tab.sshProfileId;
    let followCwd = false;
    if (pId) {
        const p = (TabManager.sshProfiles || []).find(x => x.id === pId);
        if (p) followCwd = !!p.followCwd;
    }
    const send = (cid) => {
        _enqueueSshConnect({
            host, port: port || 22, username: user, credentialId: cid || null,
            followCwd, loginScripts: _getLoginScripts(tab, pane),
        }, token);
    };
    if (credId) { send(credId); return; }
    const prof = pId ? (TabManager.sshProfiles || []).find(x => x.id === pId) : null;
    if (prof && (prof.encryptedPassword || prof.privateKeyPath)) {
        ipcRenderer.invoke('register-credential', {
            encryptedPassword: prof.encryptedPassword || '',
            privateKeyPath: prof.privateKeyPath || '',
        }).then(({ credId: newCredId }) => {
            // The credential round trip can outlive migrations/closures: the
            // ATTEMPT record (not the captured wrapper) owns the decision —
            // never enqueue into a dead or replaced attempt. The handle
            // itself is profile-derived and potentially shared; it is not
            // revoked on this dead path.
            if (!sshAttempts.ownerWants(token)) return;
            if (newCredId) {
                const o = sshAttempts.ownerOf(token);
                if (o) {
                    if (o._sshHost !== undefined || o._sshCredId !== undefined) o._sshCredId = newCredId;
                    else o._credId = newCredId;
                }
            }
            send(newCredId);
        }).catch(() => { if (sshAttempts.ownerWants(token)) send(null); });
    } else {
        send(null);
    }
}

// ── Tab Manager ──
const TabManager = {
    tabs: [],
    activeId: null,
    _counter: 1,
    _paneCounter: 1,
    _activeTabEl: null,
    profiles: [],
    sshProfiles: [],
    // Tabs whose exit animation is running and whose deferred removal is
    // scheduled (rapid-close bookkeeping — see closeTab).
    _closingTabs: new Set(),
    _closedTabIds: new Map(), // id → close timestamp; deleted once consumed; entries older than 60s are swept to prevent leaks
    _markClosed(id) {
        if (id == null) return;
        const now = Date.now();
        // Sweep expired entries older than 60s that were never consumed (error path: pty-exit never arrived)
        for (const [k, t] of this._closedTabIds) { if (now - t > 60000) this._closedTabIds.delete(k); }
        this._closedTabIds.set(id, now);
    },
    _consumeClosed(id) { return this._closedTabIds.delete(id); },
    _dragTab: null, // { sourceTabId, targetTabId, side: 'left'|'right' }
    // Tab whose inline rename input is live: render() keeps that tab's DOM
    // node so background lifecycle redraws never interrupt the typing.
    _renamingTabId: null,

    // ── Tab strip layout (Windows Terminal tab-row model) ──
    // Three states via tabstrip-layout.js, decided on the measured per-tab
    // content widths: sparse keeps content sizing (buttons hug the last
    // tab), sharing pins floor(equal share), overflow pins 100px + scroll
    // arrows. Widths are pinned in px (not flex shares) so a close can hold
    // siblings' rects steady while the pointer is over the strip (MUX defers
    // re-width until pointer-leave for the same reason).
    _pointerInStrip: false,
    _deferStripRelayout: false,
    _lastStripPlan: null,
    _stripObserver: null,
    // Tab id currently widened by hover (sharing/overflow only); the active
    // tab is always the first expansion priority, this is the second.
    _hoverExpandId: null,

    // Build (idempotently) the strip chrome: ‹ viewport › before the
    // add/menu buttons. Also repairs bare stub DOMs (tests) that pre-populate
    // #tabbar without the viewport: stray .tab children move inside it.
    _ensureStripChrome() {
        const bar = document.getElementById('tabbar');
        if (!bar) return null;
        let vp = document.getElementById('tab-viewport');
        if (!vp) {
            const mkArrow = (id, icon, dir) => {
                const b = document.createElement('div');
                b.id = id;
                b.className = 'tab-scroll-btn';
                b.innerHTML = Icons.iconSvg(icon, 12);
                this._wireScrollArrow(b, dir);
                return b;
            };
            vp = document.createElement('div');
            vp.id = 'tab-viewport';
            const first = bar.children[0] || null;
            bar.insertBefore(mkArrow('tab-scroll-left', 'chevron-left', -1), first);
            bar.insertBefore(vp, first);
            bar.insertBefore(mkArrow('tab-scroll-right', 'chevron-right', 1), first);
            // Adopt any tabs a stub/test placed directly under #tabbar.
            bar.querySelectorAll('.tab').forEach(el => { if (el.parentElement === bar) vp.appendChild(el); });
        }
        return vp;
    },

    _wireStripInteraction(bar) {
        if (bar._stripWired) return;
        bar._stripWired = true;
        const vp = document.getElementById('tab-viewport');
        if (vp) {
            // Wheel over the strip scrolls it horizontally; map the dominant
            // axis so both vertical wheels and trackpad/tilt horizontal
            // deltas work (WebView2 wheel deltas are always pixel-mode).
            vp.addEventListener('wheel', (e) => {
                const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
                if (!d) return;
                vp.scrollLeft += d;
                if (e.cancelable) e.preventDefault();
            }, { passive: false });
            vp.addEventListener('scroll', () => this._updateScrollArrows());
            // Hover expansion (sharing/overflow only): the tab under the
            // pointer widens toward its content width after a short dwell;
            // once one tab is expanded, sweeping across neighbors retargets
            // immediately. A live close deferral owns the strip widths and a
            // drag owns the tab positions — hover stays out of both.
            let hoverTimer = null, hoverCandidate = null;
            const hoverTabId = (e) => {
                const el = e.target && e.target.closest ? e.target.closest('.tab') : null;
                return (el && vp.contains(el)) ? el.getAttribute('data-tab') : null;
            };
            const clearHoverExpand = (relayout) => {
                if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
                hoverCandidate = null;
                if (this._hoverExpandId == null) return;
                this._hoverExpandId = null;
                if (relayout) this._relayoutWithFlip();
            };
            vp.addEventListener('pointerover', (e) => {
                if (this._dragTab || (this._deferStripRelayout && this._pointerInStrip)) return;
                if (!this._lastStripPlan || this._lastStripPlan.tabWidth == null) return;
                const id = hoverTabId(e);
                if (id === hoverCandidate) return; // intra-tab movement: the dwell keeps running
                hoverCandidate = id;
                if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
                // Moving into a strip gap keeps the current expansion (a
                // sweep crosses gaps constantly); only leaving the viewport
                // collapses it. The active tab is already expanded as the
                // first priority — hovering it needs no second entry.
                if (id == null) return;
                if (id === this.activeId) {
                    if (this._hoverExpandId != null) { this._hoverExpandId = null; this._relayoutWithFlip(); }
                    return;
                }
                if (this._hoverExpandId != null) {
                    this._hoverExpandId = id; // already expanded: retarget immediately
                    this._relayoutWithFlip();
                    return;
                }
                hoverTimer = setTimeout(() => {
                    hoverTimer = null;
                    if (this._dragTab || (this._deferStripRelayout && this._pointerInStrip)) return;
                    // The strip may have flipped sparse since the pointerover
                    // (resize/close): expanding there is pointless state.
                    if (!this._lastStripPlan || this._lastStripPlan.tabWidth == null) return;
                    this._hoverExpandId = id;
                    this._relayoutWithFlip();
                }, 150);
            });
            vp.addEventListener('pointerleave', () => {
                // The deferral path must not force a relayout here: the BAR
                // pointerleave recomputes once the pointer is fully out.
                clearHoverExpand(!(this._deferStripRelayout && this._pointerInStrip));
            });
        }
        bar.addEventListener('pointerenter', () => { this._pointerInStrip = true; });
        bar.addEventListener('pointerleave', () => {
            this._pointerInStrip = false;
            if (this._deferStripRelayout) {
                this._deferStripRelayout = false;
                this._relayout(true);
            }
        });
        if (typeof ResizeObserver === 'function') {
            this._stripObserver = new ResizeObserver(() => this._relayout(true));
            this._stripObserver.observe(bar);
        }
    },

    // Click-and-hold scroll arrow: 50px per step (MUX TabView's scroll
    // amount), auto-repeating while held like the XAML RepeatButton.
    _wireScrollArrow(btn, dir) {
        let repeat = null, delay = null;
        const stop = () => {
            if (delay) { clearTimeout(delay); delay = null; }
            if (repeat) { clearInterval(repeat); repeat = null; }
        };
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || btn.classList.contains('disabled')) return;
            e.preventDefault();
            // Capture the pointer so the hold keeps reporting pointerup even
            // if the cursor slips off the button; a window blur mid-hold
            // (alt-tab) must never leave the repeat timer running.
            if (btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) {} }
            this._nudgeTabStrip(dir);
            stop();
            delay = setTimeout(() => { repeat = setInterval(() => this._nudgeTabStrip(dir), 90); }, 350);
        });
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('pointercancel', stop);
        btn.addEventListener('pointerleave', stop);
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('blur', stop);
    },

    _nudgeTabStrip(dir) {
        const vp = document.getElementById('tab-viewport');
        if (!vp) return;
        vp.scrollLeft += dir * 50;
        this._updateScrollArrows();
    },

    _updateScrollArrows() {
        const vp = document.getElementById('tab-viewport');
        const left = document.getElementById('tab-scroll-left');
        const right = document.getElementById('tab-scroll-right');
        if (!vp || !left || !right) return;
        const maxScroll = (vp.scrollWidth || 0) - (vp.clientWidth || 0);
        left.classList.toggle('disabled', (vp.scrollLeft || 0) <= 1);
        right.classList.toggle('disabled', (vp.scrollLeft || 0) >= maxScroll - 1);
    },

    // Recompute the strip state and pin tab widths. While a close deferral is
    // armed (pointer over the strip), re-apply the last plan instead: the DOM
    // may lose the closing tab, but the survivors keep their pixel rects
    // until the pointer leaves.
    _relayout(force) {
        const bar = document.getElementById('tabbar');
        const vp = document.getElementById('tab-viewport');
        if (!bar || !vp) return;
        let plan = this._lastStripPlan;
        const deferred = this._deferStripRelayout && this._pointerInStrip && plan;
        if (force || !deferred) {
            this._deferStripRelayout = false;
            // The viewport does not grow (flex:0 1 auto) so the add/menu
            // buttons stay anchored right after the last tab — meaning its
            // width is the CONTENT width, not the availability. Measure from
            // the bar instead: total width minus every visible non-viewport
            // sibling (outer width incl. margins) and the flex gaps. The
            // scroll arrows are skipped: the decision basis is the
            // arrows-hidden width, so toggling them can never flip the
            // verdict back (no oscillation).
            let chrome = 0, siblings = 0;
            const gcs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
            for (const el of bar.children) {
                if (el === vp || el.id === 'tab-scroll-left' || el.id === 'tab-scroll-right') continue;
                const cs = gcs ? gcs(el) : null;
                if (cs && cs.display === 'none') continue;
                siblings++;
                chrome += (el.offsetWidth || 0) + (cs ? (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0) : 0);
            }
            // clientWidth includes the right breathing-reserve padding
            // (TAB_STRIP_RIGHT_RESERVE, mirrored in app.css), so subtract it:
            // the flips happen while a visible gap remains and the buttons
            // never jam against the titlebar's right-side cluster.
            const avail = (bar.clientWidth || 0) - TAB_STRIP_RIGHT_RESERVE - chrome - 2 * siblings;
            // Decision basis: the per-tab CONTENT widths measured at render
            // time (cached on the tab object; unmeasured tabs fall back to
            // the content floor so a never-painted tab still reserves a
            // sane slot).
            const tabEls = [...vp.querySelectorAll('.tab')];
            const desired = tabEls.map(el => {
                const t = this.tabs.find(x => x.id === el.getAttribute('data-tab'));
                const w = t && t._desiredW;
                return (Number.isFinite(w) && w > 0) ? w : Math.max(TAB_CONTENT_MIN, el.offsetWidth || 0);
            });
            plan = computeTabStripPlan(desired, avail, 2, TAB_MIN_WIDTH);
            // Priority expansion is part of the plan so a deferred re-apply
            // keeps the exact same pixel widths while the pointer is over
            // the strip.
            plan.widths = this._expandedStripWidths(plan, avail, tabEls);
            this._lastStripPlan = plan;
        }
        bar.classList.toggle('tabbar-sharing', plan.state === 'sharing');
        bar.classList.toggle('tabbar-overflow', plan.state === 'overflow');
        vp.querySelectorAll('.tab').forEach(el => {
            const w = plan.widths ? plan.widths.get(el.getAttribute('data-tab')) : null;
            el.style.width = w != null ? w + 'px' : (plan.tabWidth == null ? '' : plan.tabWidth + 'px');
        });
        this._updateScrollArrows();
    },

    // Priority expansion for the crowded states: in sharing/overflow the
    // active tab (then the hovered one) widens toward its measured content
    // width so its name and icons stay readable — the fixed share is only a
    // floor, never a cap on the tab the user is looking at. Siblings absorb
    // the difference in sharing (never below TAB_MIN_WIDTH), the scrolling
    // strip simply grows in overflow. The state verdict itself always comes
    // from the UNEXPANDED widths, so expanding can never flip the state and
    // oscillate. Returns a per-tab px Map, or null when nothing expands
    // (sparse plan, single tab, no priority tab present).
    _expandedStripWidths(plan, avail, els) {
        if (!plan || plan.tabWidth == null || els.length < 2) return null;
        const prio = [];
        for (const id of [this.activeId, this._hoverExpandId]) {
            if (id == null || prio.includes(id) || this._closingTabs.has(id)) continue;
            if (els.some(el => el.getAttribute('data-tab') === id)) prio.push(id);
        }
        if (!prio.length) return null;
        const gap = 2, count = els.length, others = count - prio.length;
        const byId = new Map(this.tabs.map(t => [t.id, t]));
        const widths = new Map();
        for (const id of prio) {
            const t = byId.get(id);
            const desired = (t && Number.isFinite(t._desiredW) && t._desiredW > 0) ? t._desiredW : plan.tabWidth;
            // +8 display slack: the measured content width is an EXACT fit
            // for the label, so a 1px sub-pixel shortage flips the name to
            // ellipsis; the expansion exists to show the full name, so it
            // carries a small margin (the classifier keeps the pure value).
            widths.set(id, Math.min(TAB_MAX_WIDTH, Math.max(plan.tabWidth, desired + 8)));
        }
        if (plan.state !== 'sharing') {
            // overflow: the strip scrolls, so priority tabs simply take
            // their width and everyone else keeps the plan pin.
            els.forEach(el => {
                const id = el.getAttribute('data-tab');
                if (!widths.has(id)) widths.set(id, plan.tabWidth);
            });
            return widths;
        }
        // sharing: siblings split what the priority tabs leave behind.
        const sumPrio = prio.reduce((acc, id) => acc + widths.get(id), 0);
        let otherW = others > 0 ? Math.floor((avail - sumPrio - gap * (count - 1)) / others) : 0;
        if (others > 0 && otherW >= TAB_MIN_WIDTH) {
            otherW = Math.min(otherW, plan.tabWidth);
        } else {
            // Either too crowded for the full expansion (squeeze the priority
            // tabs into what the sibling floor leaves), or the every-tab-is-
            // priority case (others === 0, e.g. exactly two tabs), which
            // always lands here: the same water-fill splits the whole budget
            // between the priority tabs. Sharing guarantees the budget covers
            // at least the plan width for each priority tab (share >= min),
            // so the water-fill never breaks the floor.
            let left = avail - gap * (count - 1) - TAB_MIN_WIDTH * others;
            prio.forEach((id, i) => {
                const reserve = plan.tabWidth * (prio.length - i - 1);
                const w = Math.min(widths.get(id), Math.max(plan.tabWidth, left - reserve));
                widths.set(id, w);
                left -= w;
            });
            otherW = TAB_MIN_WIDTH;
        }
        if (others > 0) els.forEach(el => {
            const id = el.getAttribute('data-tab');
            if (!widths.has(id)) widths.set(id, otherW);
        });
        return widths;
    },

    // Recompute the strip plan and FLIP-animate the reflow. Used by the
    // hover/active expansion, which fires outside render(). A close
    // deferral owns every strip width until the pointer leaves the bar —
    // it must not be force-recomputed away mid-close.
    _relayoutWithFlip() {
        if (this._deferStripRelayout && this._pointerInStrip) return;
        const vp = document.getElementById('tab-viewport');
        if (!vp) { this._relayout(true); return; }
        const prevRects = this._captureStripRects(vp);
        this._relayout(true);
        this._reholdStripSlides(vp, prevRects);
        this._applyStripFlip(vp, prevRects);
    },

    // Bring a tab fully into the viewport (used on switch/create; a no-op
    // when the strip fits). Manual math instead of scrollIntoView: the
    // latter would also scroll outer containers (block axis) on some pages.
    _scrollTabIntoView(tabId) {
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn();
        raf(() => {
            const vp = document.getElementById('tab-viewport');
            const el = vp && vp.querySelector(`.tab[data-tab="${tabId}"]`);
            if (!vp || !el) return;
            if (!Number.isFinite(el.offsetLeft) || !Number.isFinite(el.offsetWidth)) return;
            const left = el.offsetLeft, right = left + el.offsetWidth;
            if (left < vp.scrollLeft) vp.scrollLeft = left;
            else if (right > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
            this._updateScrollArrows();
        });
    },

    init() {
        // Mount chrome once: scroll arrows + viewport / addBtn / menuBtn (no
        // longer rebuilt on every render). Tabs live INSIDE the viewport so
        // the add/menu buttons can never be overflow-clipped (WT keeps its
        // "+" in the non-scrolling footer for the same reason).
        const bar = document.getElementById('tabbar');
        if (bar) {
            this._ensureStripChrome();
            if (!document.getElementById('btn-add-tab')) {
                const addBtn = document.createElement('div');
                addBtn.id = 'btn-add-tab';
                addBtn.dataset.tip = '新建标签页（默认终端），Ctrl+Shift+N 选择会话';
                addBtn.innerHTML = Icons.iconSvg('plus', 14);
                addBtn.onclick = () => {
                    const p = getDefaultLocalProfile();
                    TabManager.createTab({ name: p.name, type: 'local', command: p.command, args: p.args });
                };
                bar.appendChild(addBtn);
            }
            if (!document.getElementById('btn-menu')) {
                const menuBtn = document.createElement('div');
                menuBtn.id = 'btn-menu';
                menuBtn.dataset.tip = '菜单';
                menuBtn.innerHTML = Icons.iconSvg('more-vertical', 14);
                menuBtn.onclick = (e) => { e.stopPropagation(); toggleMenuPopup(); };
                bar.appendChild(menuBtn);
            }
            this._wireStripInteraction(bar);
        }

        ipcRenderer.once('profiles', async (event, { profiles, sshProfiles, lastTabs }) => {
            // Auto-detect local shells (Git Bash/WSL etc.), keeping custom config entries that detection missed
            let detected = [];
            try { detected = await ipcRenderer.invoke('get-local-shells') || []; } catch(e) {}
            const custom = (profiles || []).filter(p => !detected.some(d => d.command === p.command));
            this.profiles = detected.length > 0 ? [...detected, ...custom] : (profiles || []);
            this.sshProfiles = sshProfiles || [];

            // Filter out settings tabs / bad data (older versions may have saved a settings tab into lastTabs)
            const tabsToRestore = ((lastTabs && lastTabs.length > 0) ? lastTabs : [])
                .filter(t => t && typeof t === 'object' && t.type !== 'settings');
            if (tabsToRestore.length === 0) tabsToRestore.push(getDefaultLocalProfile());

            tabsToRestore.forEach(t => {
                // Tabs with split data go through the full restore path
                if (t.splitRoot) {
                    this._restoreSplitTab(t);
                    return;
                }
                let sshOpts = null;
                if (t.type === 'ssh') {
                    sshOpts = { host: t.host, port: t.port, user: t.user, sshProfileId: t.sshProfileId };
                    if (t.sshProfileId) {
                        const profile = (this.sshProfiles || []).find(p => p.id === t.sshProfileId);
                        if (profile) {
                            sshOpts.host = sshOpts.host || profile.host;
                            sshOpts.port = sshOpts.port || profile.port;
                            sshOpts.user = sshOpts.user || profile.username;
                            sshOpts.privateKey = profile.privateKeyPath;
                            sshOpts._encryptedPwd = profile.encryptedPassword;
                            sshOpts.followCwd = !!profile.followCwd;
                            sshOpts.loginScripts = profile.loginScripts || [];
                        }
                    }
                }
                const tid = this.createTabSilent(t.name, t.command || 'powershell.exe', t.type || 'local', sshOpts, t.args);
                const tab = this.tabs.find(x => x.id === tid);
                // Restore the manual-rename lock with the name: without it a
                // later split's auto-naming would overwrite the user's rename
                // (the lock itself was lost across the restart).
                if (tab) tab._customName = t.customName === true;
                if (tab && t.content) tab._contentBuffer = normalizeRestoredContent(t.content);

                if (sshOpts && sshOpts._encryptedPwd) {
                    const capturedId = tid;
                    // Register the credential with the main process for a
                    // credentialId; the plaintext password never reaches the
                    // renderer. The connect itself goes through the app-wide
                    // serial queue — at restore several SSH tabs connect at
                    // once and strict sshd configs randomly drop concurrent
                    // handshakes, whose retry churn used to trigger the
                    // zombie-wrap bug.
                    ipcRenderer.invoke('register-credential', {
                        encryptedPassword: sshOpts._encryptedPwd,
                        privateKeyPath: sshOpts.privateKey,
                    }).then(({ credId, error }) => {
                        const reTab = this.tabs.find(x => x.id === capturedId);
                        if (!reTab || reTab.connected) {
                            // The registration outlived its consumer (the tab
                            // closed or connected another way): nobody will
                            // hold this handle — release the plaintext now.
                            if (credId) ipcRenderer.send('revoke-credential', { credId });
                            return;
                        }
                        if (error || !credId) {
                            reTab.connected = false;
                            this.render();
                            return;
                        }
                        reTab._credId = credId;
                        _sshConnectWithCredentials(reTab, null);
                    });
                }
            });
            this.render();
            if (this.tabs.length > 0) {
                this.switchTo(this.tabs[0].id);
            }
        });
        ipcRenderer.send('get-profiles');

        const main = document.getElementById('main-area');
        if (main) {
            main.ondragover = (e) => this._onMainDragOver(e);
            main.ondragleave = (e) => this._onMainDragLeave(e);
            main.ondrop = (e) => this._onMainDrop(e);
        }
    },

    createTabSilent(name, command, type, sshOpts, args) {
        const id = 't_' + (this._counter++);
        const isSSH = type === 'ssh';
        const tab = {
            id, name: name || 'PowerShell', type: type || 'local',
            command: isSSH ? '' : (command || 'powershell.exe'),
            args: isSSH ? [] : (args || []),
            connected: !isSSH,
        };
        if (isSSH && sshOpts) {
            Object.assign(tab, {
                host: sshOpts.host, port: sshOpts.port, user: sshOpts.user,
                privateKey: sshOpts.privateKey, sshProfileId: sshOpts.sshProfileId,
                _credId: sshOpts.credId,
            });
        }
        this.tabs.push(tab);
        if (isSSH) {
            // Enqueue here only when the restore callback won't: profiles with
            // BOTH a password and a key would otherwise connect twice (the
            // first session succeeds and is orphaned by the second).
            if (sshOpts && sshOpts.host && (sshOpts.credId || sshOpts.privateKey) && !sshOpts._encryptedPwd) {
                _sshConnectWithCredentials(tab, null);
            }
        } else {
            ipcRenderer.send('pty-create', _ptyCreatePayload(tab.command, tab.args, _settingsConfig.startupDir, id));
        }
        return id;
    },

    createTab(options = {}) {
        // A new tab is an explicit geometry change: drop any close-deferral
        // so the strip re-plans immediately and the new tab is reachable.
        this._deferStripRelayout = false;
        const { name, type, command, args, host, port, user, credId, privateKey, sshProfileId } = options;
        const id = 't_' + (this._counter++);
        const isSSH = type === 'ssh';
        const tab = {
            id, name: name || 'PowerShell',
            type: type || 'local',
            command: isSSH ? '' : (command || 'powershell.exe'),
            args: isSSH ? [] : (args || []),
            connected: !isSSH,
            host, port, user, _credId: credId, privateKey, sshProfileId,
        };
        this.tabs.push(tab);
        this.switchTo(id);
        this.render();
        if (isSSH) {
            // tab already carries host/user/credId — the attempt (and its
            // credential fallback) is created inside the connect helper.
            _sshConnectWithCredentials(tab, null);
        } else {
            ipcRenderer.send('pty-create', _ptyCreatePayload(tab.command, tab.args, _settingsConfig.startupDir, id));
        }
        return id;
    },

    // opts.passiveFocus: the switch is a deferred COMPLETION (e.g. the
    // closeTab fallback re-activation inside the removal timer), not a user
    // activation — its delayed terminal focus follows the passive intent
    // rule instead of the explicit one (see terminal.js).
    switchTo(id, opts) {
        if (this.activeId === id) {
            const tab = this.tabs.find(t => t.id === id);
            if (tab && tab.type === 'ssh' && !tab.connected) this.reconnectTab(id);
            return;
        }
        const passiveFocus = !!(opts && opts.passiveFocus);
        if (this.activeId) {
            const oldTab = this.tabs.find(t => t.id === this.activeId);
            if (oldTab && oldTab.type === 'settings') {
                document.getElementById('settings-pane').classList.remove('active');
            } else if (oldTab && oldTab.splitRoot) {
                const split = document.getElementById('split_' + this.activeId);
                if (split) split.style.display = 'none';
                // WebGL contexts are budgeted by visibility: release the
                // outgoing tab's contexts (after the idle grace) so the page
                // total stays bounded by what is actually on screen.
                if (typeof _detachWebglRenderer === 'function') getAllPanes(oldTab).forEach(p => _detachWebglRenderer(p, p.term));
            } else {
                const el = document.getElementById('wrap_' + this.activeId);
                if (el) el.classList.remove('active');
                if (oldTab && typeof _detachWebglRenderer === 'function') _detachWebglRenderer(oldTab, oldTab.term);
            }
        }
        this.activeId = id;
        this.updateActiveClass();
        // Active-tab expansion: in sharing/overflow the newly active tab
        // widens toward its content width (FLIP-animated; a no-op in sparse,
        // or while a close deferral owns the strip).
        this._relayoutWithFlip();
        this._scrollTabIntoView(id);
        const tab = this.tabs.find(t => t.id === id);
        if (tab && tab.type === 'settings') {
            document.getElementById('settings-pane').classList.add('active');
            const sshPage = document.querySelector('#settings-content .settings-page[data-page="ssh"]');
            if (sshPage && sshPage.classList.contains('active')) renderSSHManagerInSettings();
            loadSettingsIntoForm();
        } else if (tab && tab.splitRoot) {
            const split = document.getElementById('split_' + id);
            if (split) { split.style.display = 'flex'; this._layoutTime = Date.now(); this._layoutSplit(tab); }
            if (typeof _attachWebglRenderer === 'function') getAllPanes(tab).forEach(p => { if (p.term) _attachWebglRenderer(p, p.term); });
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused && focused.term) {
                // Re-check at fire time: a reconnect/close inside the 250ms
                // window nulls the pane's terminal, and reading it through
                // the scheduling-time guard would throw.
                if (focused.fitAddon) setTimeout(() => {
                    if (!focused.term) return;
                    // Same-frame flush variant (see the non-split branch):
                    // fit() clears the WebGL bitmap synchronously and the
                    // debounced repaint would composite one cleared frame.
                    const body = document.getElementById('pane-body_' + focused.id);
                    if (typeof _fitTermSync === 'function') _fitTermSync(focused.term, focused.fitAddon, body);
                    else _fitWithScroll(focused.term, focused.fitAddon, body);
                }, 250);
                // Fire-time validated: the pane may be closed/disposed, the
                // tab switched away, or a newer focus intent (overlay/search
                // input) active when the timer runs.
                _scheduleTerminalFocus(() => focused.term, 250, passiveFocus);
            }
        } else {
            const el = document.getElementById('wrap_' + id);
            if (el) {
                el.classList.add('active');
                // Attach the GPU renderer before the fit so the (restored,
                // never-fitted) grid jump repaints through it atomically.
                if (tab && tab.term && typeof _attachWebglRenderer === 'function') _attachWebglRenderer(tab, tab.term);
                if (tab && tab.fitAddon) setTimeout(() => {
                    // A running dock open/close animation owns the wrap width
                    // (and the terminal already took its predicted final
                    // grid): fitting against the mid-transition width here
                    // would bounce the grid there and back. The dock's settle
                    // pass performs the authoritative fit afterwards. (typeof
                    // guard: _sftpAnimating lives in sftp.js, which some test
                    // harnesses never load.)
                    if (typeof _sftpAnimating !== 'undefined' && _sftpAnimating) return;
                    // _fitTermSync over _fitWithScroll: fit() clears the WebGL
                    // bitmap synchronously; the same-frame flush keeps the
                    // clear+repaint atomic (no blank frame on activation).
                    // (typeof guard: _fitTermSync lives in terminal.js, which
                    // some test harnesses never load.)
                    if (typeof _fitTermSync === 'function') _fitTermSync(tab.term, tab.fitAddon, tab.term?.element?.parentElement);
                    else _fitWithScroll(tab.term, tab.fitAddon, tab.term?.element?.parentElement);
                }, 10);
                // Re-check at fire time: a reconnect/close inside the 100ms
                // window nulls the terminal (scheduling-time guard only).
                if (tab && tab.term) _scheduleTerminalFocus(() => tab.term, 100, passiveFocus);
            }
        }
        this.updateStatus();
        // The active terminal changed (terminal search follows)
        if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
        // SFTP dock follows the active tab's focused pane (hide on settings)
        if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
    },

    // Tabs that are not currently closing (rapid-close safe count: the
    // "keep at least one tab" guards must look through pending removals,
    // otherwise a burst can schedule the last two tabs for removal and
    // leave the app empty).
    aliveCount() {
        return this.tabs.filter(t => !this._closingTabs.has(t.id)).length;
    },

    // The SFTP panel is bound to one backend session: any teardown of that
    // session (tab close, pane close, reconnect) closes the panel first, so
    // it never points at a destroyed session.
    _closeSftpForSessions(ids) {
        if (window.SFTP && SFTP._tabId && ids.indexOf(SFTP._tabId) >= 0) SFTP.close();
    },

    closeTab(id) {
        // Idempotent: a rapid shortcut burst hits the same tab repeatedly
        // while its exit animation runs — re-closing would re-add the exit
        // class, re-switch tabs and stack extra deferred removals.
        if (this._closingTabs.has(id)) return;
        if (this.aliveCount() <= 1) {
            // A settings tab carries no session and no terminal: as the last
            // tab alive it cannot be "reset to a local shell" — that fallback
            // used to convert it in place into an invisible terminal while
            // the settings layer stayed mounted as an orphan over whatever
            // came next. Close it for real: drop the layer, remove the tab,
            // and leave the empty state the + button (createTab) serves.
            const st = this.tabs.find(t => t.id === id && t.type === 'settings');
            if (st) {
                document.getElementById('settings-pane')?.classList.remove('active');
                this.tabs.splice(this.tabs.indexOf(st), 1);
                if (this.activeId === id) {
                    this.activeId = null;
                    this.updateActiveClass();
                }
                this.render();
                return;
            }
            // The last tab cannot be closed; if its split tree was already emptied (0 panes, error path),
            // or it was reduced to a terminal-less shell with nothing pending (all of its panes died in
            // the same close window), reset it to the default local terminal as a fallback so no
            // unclosable empty dead tab remains. A tab with a live connect attempt, a pending local
            // creation or a pending reconnect (the pre-attempt 500ms window holds no attempt identity
            // yet) is NOT dead — closing is simply refused as before.
            const t = this.tabs[0];
            const deadShell = t && t.type !== 'settings' && !t.splitRoot && !t.term && !t.tabId && !sshAttempts.ownerAttempt(t) && !t._ptyRequestId && !t._reconnectPending;
            if (t && ((t.splitRoot && getAllPanes(t).length === 0) || deadShell)) {
                t.splitRoot = null;
                t.type = 'local';
                t.command = t.command || 'powershell.exe';
                t.term = null; t.fitAddon = null; t.tabId = null;
                const { wrap: w } = createTermWrap(t);
                document.getElementById('main-area').appendChild(w);
                ipcRenderer.send('pty-create', _ptyCreatePayload(t.command, t.args || [], undefined, t.id));
                this.render();
            }
            return;
        }
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const tab = this.tabs[idx];
        const wasActive = this.activeId === id;
        // If the tab being closed has the SFTP panel open, close the panel too (so it never points at a destroyed session)
        this._closeSftpForSessions(tab.splitRoot ? getAllPanes(tab).map(p => p.tabId) : [tab.tabId]);
        if (tab.type === 'settings') {
            document.getElementById('settings-pane')?.classList.remove('active');
        }
        this._closingTabs.add(id);
        // A hover expansion on the dying tab lapses here: leaving the id set
        // would make the next hovered tab skip its 150ms dwell (the "already
        // expanded, retarget immediately" branch) even though the strip is
        // no longer in an expanded state.
        if (this._hoverExpandId === id) this._hoverExpandId = null;
        // MUX TabView defers re-width after a tab close until the pointer
        // leaves the strip, so rapid-fire closes never move the next tab's
        // close button out from under the cursor. Arm that deferral here;
        // render()/_relayout() keep applying the pre-close plan while set.
        if (this._pointerInStrip) this._deferStripRelayout = true;
        // Cancellation is committed at initiation, not at the deferred
        // removal: an attempt still in flight is cancelled by its immutable
        // identity (the main process locates that exact pending generation),
        // its queue slot is released at once, and once the tab is spliced out
        // no owner is left to destroy late results — those fall through to
        // the orphan disposal paths in ipc.js. The closing skip in the claim
        // paths keeps the dying tab/panes unclaimable during the fade.
        // Local pending creates keep their requestId markers: local creation
        // has no attempt identity; its late result is orphan-destroyed by the
        // pty-created handler as before.
        if (tab.type !== 'settings') {
            if (tab.splitRoot) {
                // A split tab's tabId is structurally null (the session lives
                // on its panes). Cancel only PRE-CLAIM attempts here: a
                // claimed pane's session tears down at the deferred removal
                // (the fade contract), carrying its attempt identity then.
                for (const p of getAllPanes(tab)) {
                    if (!p.tabId && sshAttempts.ownerAttempt(p)) _cancelSshAttemptOf(p, null);
                }
            } else if (!tab.tabId && sshAttempts.ownerAttempt(tab)) {
                _cancelSshAttemptOf(tab, null);
            }
        }
        // Close animation: fade only. The .tab-exit rule must stay free of
        // layout-property transitions — they stall the WebView2 host message
        // pump for seconds (see the rule's comment in app.css).
        const tabEl = document.querySelector(`.tab[data-tab="${id}"]`);
        if (tabEl) {
            tabEl.classList.add('tab-exit');
            // Follow-through slide: siblings after the closing tab start
            // moving left NOW (composited transform, no layout) instead of
            // teleporting when the slot collapses at doRemove. The slide is
            // forwards-filled so it holds until the collapse; render()
            // re-anchors the hold on rebuilt elements (a background redraw
            // discards element-level animations) via _reholdStripSlides.
            const vp = document.getElementById('tab-viewport');
            const dx = (tabEl.offsetWidth || 0) + 2; // one slot + the strip gap
            if (vp && !this._dragTab && Number.isFinite(dx) && dx > 0 && typeof tabEl.animate === 'function') {
                let past = false;
                vp.querySelectorAll('.tab').forEach(el => {
                    if (el === tabEl) { past = true; return; }
                    if (!past || typeof el.animate !== 'function') return;
                    // A sibling already dying keeps its own slot+slide.
                    if (this._closingTabs.has(el.getAttribute('data-tab'))) return;
                    _slideStripTab(el, -dx, 'forwards');
                });
            }
        }
        // Compute the next tab BEFORE splice (after splice, the old idx+1 occupies idx).
        // Tabs being closed must be skipped: during a burst the tabs array is not yet spliced,
        // so blindly taking a neighbor reactivates a dying tab and later keys ping-pong between dying tabs.
        // Neighbors follow VISUAL order (orderedTabs): the raw array can hold
        // the settings tab mid-list, which would steal the activation from
        // the tab that actually sits next to the closed one on the bar.
        let next = null;
        if (wasActive) {
            const ordered = this.orderedTabs();
            const oidx = ordered.findIndex(t => t.id === id);
            for (let j = oidx + 1; j < ordered.length; j += 1) {
                if (!this._closingTabs.has(ordered[j].id)) { next = ordered[j]; break; }
            }
            if (!next) {
                for (let j = oidx - 1; j >= 0; j -= 1) {
                    if (!this._closingTabs.has(ordered[j].id)) { next = ordered[j]; break; }
                }
            }
        }
        // Switch to next immediately (old wrap hides and next wrap shows at once)
        if (next) this.switchTo(next.id);
        const doRemove = () => {
            // Re-locate idx by id — the user may have reordered or closed other tabs
            // during the animation, and the closure's stale idx would splice the wrong slot
            const cur = this.tabs.findIndex(t => t.id === id);
            if (cur < 0) { this._closingTabs.delete(id); return; } // already closed by another path
            this.tabs.splice(cur, 1);
            this._closingTabs.delete(id);
            // Release the plaintext credential held in main-process memory
            // (if any) — but only when no other wrapper still shares the
            // handle (clone/extract/split inheritance copy one id across
            // tabs and panes; see _credIdStillReferenced). The closing tab
            // is already spliced out, so "still referenced" means exactly
            // the other tabs' live references.
            if (tab._credId && !_credIdStillReferenced(this.tabs, tab._credId)) {
                ipcRenderer.send('revoke-credential', { credId: tab._credId });
            }
            // Pane-level credential handles (a restored/registered SSH pane
            // holds its own _sshCredId) are owned by this tab exactly like
            // tab._credId: release them on the same contract — deduped,
            // excluding the tab-level handle just decided above, never while
            // another wrapper still holds the id, and never for panes whose
            // own _closePane already decided their handle.
            if (tab.splitRoot) {
                const seen = new Set(tab._credId ? [tab._credId] : []);
                for (const p of getAllPanes(tab)) {
                    if (p._closing) continue;
                    const cid = p._sshCredId;
                    if (cid && !seen.has(cid)) {
                        seen.add(cid);
                        if (!_credIdStillReferenced(this.tabs, cid)) {
                            ipcRenderer.send('revoke-credential', { credId: cid });
                        }
                    }
                }
            }
            if (tab.splitRoot) {
                getAllPanes(tab).forEach((p, i) => {
                    // Claimed-session teardown at the deferred removal (the
                    // fade contract): the destroy carries the pane's backend
                    // id and its attempt token (identity-exact pending
                    // cancel + slot release), never a display address.
                    if (p.tabId) {
                        this._markClosed(p.tabId);
                        _cancelSshAttemptOf(p, p.tabId);
                        delete ptyBuffers[p.tabId];
                    }
                    // Disconnect pane-body resize observers before dropping
                    // the split subtree — Blink keeps observed nodes (and
                    // their whole DOM subtrees, canvases included) alive.
                    const body = document.getElementById('pane-body_' + p.id);
                    if (body && body._resizeObserver) body._resizeObserver.disconnect();
                    // Stagger per-pane term.dispose like the tab-level
                    // stagger: a split tab closing must not fire N WebGL
                    // context teardowns in one task.
                    if (p.term) setTimeout(() => { try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(p.term); p._smoothCursor?.dispose(); p._smoothCursor = null; p.term.dispose(); } catch(e) {} }, i * 80);
                });
                const split = document.getElementById('split_' + id);
                if (split) split.remove();
                tab.splitRoot = null; // prevent a stale reference from being treated as a live split by later code
            } else {
                const el = document.getElementById('wrap_' + id);
                if (el) { if (el._resizeObserver) el._resizeObserver.disconnect(); el.remove(); }
                // Claimed-session teardown stays at the deferred removal (the
                // fade contract); the attempt identity and queue slot go with
                // the destroy — see the split branch above.
                if (tab.tabId) {
                    this._markClosed(tab.tabId);
                    _cancelSshAttemptOf(tab, tab.tabId);
                    delete ptyBuffers[tab.tabId];
                }
                if (tab.term) try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(tab.term); tab._smoothCursor?.dispose(); tab._smoothCursor = null; tab.term.dispose(); } catch(e) {}
            }
            this.render();
            // Correct activeId regardless of wasActive: a BACKGROUND tab
            // closed via context menu can be activated (Ctrl+Tab) during its
            // staggered removal window — after splice nothing else would fix
            // a dangling activeId (blank main area until a manual click).
            if (this.tabs.length > 0) {
                if (this.tabs.findIndex(t => t.id === this.activeId) < 0 || this._closingTabs.has(this.activeId)) {
                    let newActive = this.tabs[Math.min(cur, this.tabs.length - 1)];
                    if (!newActive || this._closingTabs.has(newActive.id)) {
                        newActive = this.tabs.find(t => !this._closingTabs.has(t.id)) || newActive;
                    }
                    if (newActive && !this._closingTabs.has(newActive.id)) this.switchTo(newActive.id, { passiveFocus: true });
                }
            } else if (this.tabs.length === 0) {
                this.activeId = null;
                this.updateActiveClass();
            }
            // Bar-button visibility after the removal settled (the binding
            // itself was already closed by _closeSftpForSessions)
            if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
        };
        if (tabEl) {
            // Stagger deferred removals: a rapid burst must not fire N
            // term.dispose() calls (each disposing its renderer — a WebGL
            // context while the tab is visible) at the same instant —
            // parallel context teardown synchronously waits on the GPU
            // process and froze the renderer for seconds.
            const delay = 200 + Math.max(0, this._closingTabs.size - 1) * 120;
            setTimeout(doRemove, delay);
        } else {
            doRemove();
        }
    },

    reconnectTab(id) {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab || tab.type !== 'ssh') return;
        // Supersede any pending ssh-error retry timer for this tab (both
        // would enqueue a connect; the loser's session gets orphaned).
        tab._sshRetryToken = (tab._sshRetryToken || 0) + 1;

        if (tab.splitRoot) {
            // Only an SSH pane can be reconnected: a mixed split (a local pane
            // dragged into an SSH tab) keeps the focused pane's own type, and
            // reconnecting a local pane would clear its terminal and open a
            // silent SSH session inside it (the pane header gates the same way).
            const focused = getAllPanes(tab).find(p => p.focused);
            if (focused && focused.type === 'ssh') this._reconnectPane(tab.id, focused.id);
            return;
        }

        // In-flight reconnect dedupe (pre-attempt window): between initiation
        // and the 500ms fire there is no attempt identity yet to cancel, so a
        // second trigger (double click on the tab / reconnect button, the
        // switchTo re-entry) would stack a second timer and start a second
        // full connect — the loser's session gets orphaned. Merge: the
        // pending reconnect carries on for both triggers. Once the timer
        // fires, the created attempt owns supersede semantics again (a later
        // trigger cancels it by identity below as before).
        if (tab._reconnectPending) return;
        tab._reconnectPending = true;
        tab._sshConnecting = true;
        tab._sshErrored = false;
        tab._sshReconnectNotice = true;
        if (typeof showToast === 'function') showToast('正在重连: ' + this._tabDisplayName(tab));

        // The old session is discarded below: the SFTP panel must not stay
        // bound to it (it would show a dead session's listing).
        this._closeSftpForSessions([tab.tabId]);
        // The old generation is discarded by this replacement: its attempt
        // (if still unsettled) is cancelled by identity and its queue slot
        // released, so a late event for the dead generation can neither
        // re-claim the pending reconnect window nor hold the queue. Pre-claim
        // (no backend id yet) the token alone still identifies the attempt —
        // cancelling it releases the queue slot at once instead of leaving
        // the replacement queued behind the old invocation for up to 20s.
        _cancelSshAttemptOf(tab, tab.tabId, 'ssh-disconnect');
        if (_clearOnConnect(tab, null)) {
            if (tab.term) { try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(tab.term); tab._smoothCursor?.dispose(); tab._smoothCursor = null; tab.term.dispose(); } catch(e) {}; tab.term = null; tab.fitAddon = null; }
            const wrap = document.getElementById('wrap_' + id);
            if (wrap) { if (wrap._resizeObserver) wrap._resizeObserver.disconnect(); wrap.remove(); }
            // Explicitly release ptyBuffers (the old tabId is never reused by a new connection; otherwise buffers pile up 1MB+)
            if (tab.tabId) delete ptyBuffers[tab.tabId];
        } else if (tab.term) {
            // Keep content: write a separator line and scroll to bottom so the user sees the notice
            tab.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
            try { tab.term.scrollToBottom(); } catch(e) {}
        }
        tab.tabId = null;
        tab.connected = false;
        this.render();
        this.updateStatus();
        // The wrapper awaiting this reconnect is the one carrying the kept
        // terminal (null when the profile clears on connect): a first split
        // inside the 500ms window migrates that terminal onto a pane, and a
        // request still aimed at the tab binds its new attempt to a split
        // root that no session-owner resolution can ever match — the result
        // is orphan-disposed and the reconnect silently lost. Terminal
        // identity IS the session identity (ADR-0004), so resolving by the
        // kept terminal at fire time follows every later migration too.
        const keptTerm = tab.term || null;
        setTimeout(() => {
            tab._reconnectPending = false;
            // In-tree is not "alive": burst closes stagger doRemove
            // (200ms + 120ms per queued close), so a tab already committed
            // to close can still be found in the array here — firing would
            // start an orphan SSH handshake the teardown must then dispose.
            // Objects committed to close never fire.
            if (!this.tabs.find(t => t.id === id) || this._closingTabs.has(id)) return;
            if (!tab.splitRoot) {
                // A reconnect creates a NEW attempt identity (the old one was
                // cancelled explicitly above — no implicit supersede needed).
                _sshConnectWithCredentials(tab, null);
                return;
            }
            // The first split promoted the kept terminal onto a pane (or a
            // collapse inside the window would have cleared splitRoot and
            // taken the branch above): the reconnect follows it there.
            const pane = keptTerm && getAllPanes(tab).find(p => p.term === keptTerm);
            if (pane) _sshConnectWithCredentials(tab, pane);
        }, 500);
    },

    _reconnectPane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        // Same supersede as reconnectTab: cancel a pending retry for this pane.
        tab._sshRetryToken = (tab._sshRetryToken || 0) + 1;
        const pane = findPane(tab, paneId);
        if (!pane) return;
        // Type guard (mirrors the pane header's reconnect button): only SSH
        // panes reconnect. A local pane here would be cleared and reconnected
        // against the tab's SSH host, and its local backend id would be sent
        // through ssh-disconnect — which silently unmanages the local session.
        if (pane.type !== 'ssh') return;
        // Same in-flight dedupe as reconnectTab, scoped to THIS pane: a
        // second trigger inside the pre-attempt window has no attempt
        // identity to supersede — merging keeps one connect per pane.
        if (pane._reconnectPending) return;
        pane._reconnectPending = true;
        pane._sshConnecting = true;
        pane._sshErrored = false;
        tab._sshReconnectNotice = true;
        if (typeof showToast === 'function') showToast('正在重连: ' + (pane._sshHost || pane.name || tab.name));
        // The old session is discarded below: the SFTP panel must not stay
        // bound to it.
        this._closeSftpForSessions([pane.tabId]);
        // Same identity-exact discard as reconnectTab: the pane's OWN attempt
        // (backend id once claimed, else the token alone — a pre-claim cancel
        // releases the queue slot the replacement is about to need), never a
        // display address.
        _cancelSshAttemptOf(pane, pane.tabId, 'ssh-disconnect');
        if (_clearOnConnect(tab, pane)) {
            if (pane.term) { try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(pane.term); pane._smoothCursor?.dispose(); pane._smoothCursor = null; pane.term.dispose(); } catch(e) {}; pane.term = null; pane.fitAddon = null; }
            const body = document.getElementById('pane-body_' + pane.id);
            if (body) body.innerHTML = '';
            // Explicitly release ptyBuffers
            if (pane.tabId) delete ptyBuffers[pane.tabId];
        } else if (pane.term) {
            // Keep content: write a separator line and scroll to bottom
            pane.term.write('\r\n\x1b[2m─────── 重新连接中… ───────\x1b[0m\r\n');
            try { pane.term.scrollToBottom(); } catch(e) {}
        }
        pane.tabId = null;
        // Aggregated connected state (same semantic as the ipc.js pane
        // branches): reconnecting ONE pane must not mark the whole split tab
        // disconnected while a sibling session stays alive. The pane itself is
        // flagged disconnected for the reconnect window — findPane above only
        // resolves inside a split, so this branch is always split.
        _updatePaneDot(pane, false);
        _aggregateSplitConnected(tab);
        this.render();
        this.updateStatus();
        // Fire-time owner resolution (mirrors the ssh-error retry timer in
        // ipc.js): inside the window the pane may close (its flag drops at
        // close-initiation in _closePane), or the split may collapse around
        // THIS pane — the survivorDead carve-out keeps it alive and _exitSplit
        // adopts its identity onto the tab. Connecting the captured pane
        // object in either case binds the attempt to a wrapper no owner
        // resolution can find: the fresh session is unclaimed-disposed and
        // the reconnect silently lost. Term identity cannot detect the
        // adoption here (clearOnConnect may already have disposed the
        // terminal), so the pending flag itself discriminates — a closed pane
        // lost it, an adopted pane kept it until this timer runs.
        setTimeout(() => {
            const collapsedOntoTab = pane._reconnectPending && !tab.splitRoot && tab.type === 'ssh';
            pane._reconnectPending = false;
            // Same committed-to-close guard as the tab timer above: a close
            // leaves the whole tab in the array inside this window (staggered
            // doRemove), and every pane in it is doomed with it — firing
            // would start an orphan SSH handshake the teardown must dispose.
            if (!this.tabs.find(t => t.id === tab.id) || this._closingTabs.has(tab.id)) return;
            if (collapsedOntoTab) {
                // The pane's session identity moved onto the tab with the
                // collapse: the tab owns the reconnect now.
                _sshConnectWithCredentials(tab, null);
                return;
            }
            // The pane's own close initiation keeps it in the tree for its
            // ~200ms fade: the commitment (_closing), not tree membership,
            // decides whether it may still fire.
            if (!tab.splitRoot || pane._closing || !getAllPanes(tab).some(p => p.id === pane.id)) return;
            _sshConnectWithCredentials(tab, pane);
        }, 500);
    },

    getActive() { return this.tabs.find(t => t.id === this.activeId); },

    // Visual tab order: creation/array order with the settings tab pinned to
    // the end. Render, keyboard cycling and close-next selection must all use
    // this single ordering — the array itself can hold settings mid-list (a
    // tab created after settings was opened), which made Ctrl+Alt+H/L cycle
    // in a different order than the bar shows (issue #7).
    orderedTabs() {
        return [...this.tabs].sort((a, b) => {
            if (a.type === 'settings' && b.type !== 'settings') return 1;
            if (a.type !== 'settings' && b.type === 'settings') return -1;
            return 0;
        });
    },

    render() {
        const bar = document.getElementById('tabbar');
        const vp = this._ensureStripChrome() || bar;
        // The rebuild collapses the viewport's scroll width to zero and back;
        // without a restore the scroll offset silently clamps to 0 and the
        // strip jumps to its left edge on every background redraw.
        const prevScroll = vp.scrollLeft || 0;
        // FLIP capture: every tab's current VISUAL position (in-flight close
        // slides included) before the rebuild; _applyStripFlip at the end of
        // render replays the delta as a composited slide, so any reflow
        // (close/reorder/width change) animates instead of teleporting.
        const prevRects = this._captureStripRects(vp);
        // An in-flight rename must survive background redraws (lifecycle
        // events render at any time): rebuilding this tab would remove the
        // focused input, and Blink's synchronous blur-on-removal would
        // commit the half-typed value as the locked custom name. Keep the
        // hosting node instead and re-seat it at its order position below.
        const renamingId = this._renamingTabId;
        let renameKeep = (renamingId && this.tabs.some(t => t.id === renamingId))
            ? vp.querySelector(`.tab[data-tab="${renamingId}"]`) : null;
        if (renameKeep && !renameKeep.querySelector('.tab-rename-input')) renameKeep = null;
        vp.querySelectorAll('.tab').forEach(el => {
            if (el === renameKeep) return;
            // The renamed tab is GONE (closed mid-edit): removing its input
            // is an automatic collapse — defuse the blur handler so the
            // half-typed value is never committed as a name.
            if (renamingId && el.getAttribute('data-tab') === renamingId) {
                const dying = el.querySelector('.tab-rename-input');
                if (dying) dying.onblur = null;
                this._renamingTabId = null;
            }
            el.remove();
        });

        const sortedTabs = this.orderedTabs();
        sortedTabs.forEach(t => {
            if (renameKeep && t.id === renamingId) {
                // Live input kept (title area shows the input; its value only
                // becomes the name at commit). Refresh the cheap state a
                // rebuild would have recomputed; the status dot / reconnect
                // button stay stale until the rename finishes.
                renameKeep.dataset.tip = this._tabDisplayName(t);
                renameKeep.classList.toggle('tab-exit', this._closingTabs.has(t.id));
                vp.appendChild(renameKeep);
                return;
            }
            const div = document.createElement('div');
            div.className = 'tab';
            div.setAttribute('data-tab', t.id);
            // no native title attribute: the OS tooltip delay is ~1s, which
            // reads as lag when sweeping across tabs. The shared low-latency
            // tooltip below (delegated on #tabbar) replaces it.
            div.dataset.tip = this._tabDisplayName(t);
            div.onclick = () => this.switchTo(t.id);
            div.ondblclick = (e) => { if (t.type !== 'settings') { e.stopPropagation(); this.startRenameTab(t.id); } };
            div.oncontextmenu = (e) => { if (t.type !== 'settings') { e.preventDefault(); this.showTabContextMenu(e, t.id); } };
            // Tab drag (reorder + drag onto the content area to split) uses pointer events:
            // HTML5 draggable is intercepted by Tauri WebView2's window-level DnD handler
            // (dragover never fires, cursor shows no-drop) — same pointer drag as panes (Tabby).
            div.onmousedown = (e) => this._onTabPointerDown(e, t.id);
            let inner;
            if (t.type === 'settings') {
                inner = `<span class="tab-lead-icon">${Icons.iconSvg('settingsSmall', 14)}</span><span class="tab-name">${escHtml(this._tabDisplayName(t))}</span>`;
            } else {
                let dotClass = t.connected ? 'connected' : 'disconnected';
                if (!t.connected) {
                    if (t.splitRoot) {
                        const panes = getAllPanes(t);
                        if (panes.some(p => p._sshConnecting)) dotClass = 'connecting';
                        else if (panes.some(p => p._sshErrored)) dotClass = 'error';
                    } else if (t._sshConnecting) {
                        dotClass = 'connecting';
                    } else if (t._sshErrored) {
                        dotClass = 'error';
                    }
                }
                const showDot = _settingsConfig.showStatusDot !== false;
                inner = (showDot ? `<span class="tab-icon ${dotClass}"></span>` : '') + `<span class="tab-name">${escHtml(this._tabDisplayName(t))}</span>`;
                // In split mode the tab label shows no reconnect button; each pane reconnects via its own pane header
                if (t.type === 'ssh' && !t.splitRoot) {
                    if (t._sshConnecting) {
                        inner += `<button type="button" class="tab-reconnect tab-reconnect-busy" title="正在重连" onclick="event.stopPropagation()">${Icons.iconSvg('rotate-cw', 12)}</button>`;
                    } else {
                        const rcClass = t.connected ? 'tab-reconnect-normal' : 'tab-reconnect';
                        const rcTitle = t.connected ? '强制重连' : '重新连接';
                        inner += `<button type="button" class="${rcClass}" title="${rcTitle}" onclick="event.stopPropagation();TabManager.reconnectTab('${t.id}');this.blur()" ondblclick="event.stopPropagation()">${Icons.iconSvg('rotate-cw', 12)}</button>`;
                    }
                }
            }
            inner += `<button type="button" class="tab-close" onclick="event.stopPropagation();TabManager.closeTab('${t.id}');this.blur()" ondblclick="event.stopPropagation()">${Icons.iconSvg('x', 13)}</button>`;
            div.innerHTML = inner;
            // A full re-render wipes the exit class of tabs still inside the
            // staggered removal window — they would pop back to full opacity,
            // look alive and intercept clicks. Re-apply so they stay born
            // invisible and inert (no transition, per the .tab-exit rule).
            if (this._closingTabs.has(t.id)) div.classList.add('tab-exit');
            vp.appendChild(div);
        });
        this.updateActiveClass();
        // Measure each tab's content-driven width with the state classes
        // lifted (they would otherwise pin the width and poison the
        // measurement): _relayout decides the sparse->sharing flip from the
        // per-tab content total. The kept rename node and mid-exit tabs have
        // unstable widths — keep their cached value instead. Removal and
        // re-pinning (in _relayout below) happen in the same task, so no
        // frame is ever painted with the classes off.
        bar.classList.remove('tabbar-sharing', 'tabbar-overflow');
        const byId = new Map(this.tabs.map(t => [t.id, t]));
        vp.querySelectorAll('.tab').forEach(el => {
            const t = byId.get(el.getAttribute('data-tab'));
            if (!t || el === renameKeep || this._closingTabs.has(t.id)) return;
            // Read the NATURAL content width: with the state classes lifted
            // the tab is a default flex item (shrink 1), so a viewport too
            // narrow for the content total would squeeze it and floor the
            // measurement at min-width — poisoning _desiredW exactly in the
            // crowded states whose expansion targets read it. Freeze the
            // flex for the measurement (same task as the re-pin below, so
            // nothing paints mid-state).
            el.style.flex = '0 0 auto';
            const w = el.offsetWidth;
            el.style.flex = '';
            if (Number.isFinite(w) && w > 0) t._desiredW = w;
        });
        vp.scrollLeft = prevScroll;
        this._relayout(false);
        this._reholdStripSlides(vp, prevRects);
        this._applyStripFlip(vp, prevRects);
    },

    // A render rebuilds every strip element, discarding in-flight close-tab
    // follow slides — without a re-anchor the follower snaps back right here
    // and slides left again at doRemove (a visible bounce on any background
    // redraw inside the exit window, e.g. an ssh-status render while closing).
    // Continue each follower from its pre-rebuild visual offset (prevRects)
    // toward the held target implied by the dying tabs to its left. Elements
    // re-anchored here are skipped by _applyStripFlip (their offset is already
    // measured into the new animation, not into FLIP's dx).
    _reholdStripSlides(vp, prevRects) {
        if (!vp || this._dragTab || this._closingTabs.size === 0 || !vp.querySelectorAll) return;
        let cumDx = 0;
        vp.querySelectorAll('.tab').forEach(el => {
            const tabId = el.getAttribute('data-tab');
            if (this._closingTabs.has(tabId)) {
                cumDx += (el.offsetWidth || 0) + 2; // dying slot + strip gap
                return;
            }
            if (cumDx <= 0 || typeof el.animate !== 'function' || !el.getBoundingClientRect) return;
            const prev = prevRects ? prevRects.get(tabId) : null;
            const layoutLeft = el.getBoundingClientRect().left;
            // Continue from where the OLD element visually was (its in-flight
            // slide is in the capture), never from the bare layout position.
            const from = prev == null ? 0 : prev - layoutLeft;
            const to = -cumDx;
            el._stripSlideHeld = true;
            _cancelStripSlides(el);
            if (Math.abs(from - to) < 0.5) {
                if (el.style) el.style.transform = `translateX(${to}px)`;
                return;
            }
            try {
                const anim = el.animate(
                    [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
                    { duration: 180, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)', fill: 'forwards' });
                anim.id = STRIP_SLIDE_ID;
            } catch (e) {}
        });
    },

    // FLIP helpers for the tab strip. Positions are animated with WAAPI
    // composite transforms only — layout-property transitions stay banned on
    // the strip (they stall the WebView2 host message pump; see the .tab-exit
    // comment in app.css). Returns null while a tab drag is live: drag
    // positions are pointer-driven and must never be smoothed.
    _captureStripRects(vp) {
        if (!vp || this._dragTab || !vp.querySelectorAll) return null;
        const rects = new Map();
        vp.querySelectorAll('.tab').forEach(el => {
            const r = el.getBoundingClientRect && el.getBoundingClientRect();
            if (r && Number.isFinite(r.left)) rects.set(el.getAttribute('data-tab'), r.left);
        });
        return rects;
    },

    _applyStripFlip(vp, prevRects) {
        if (!vp || !prevRects || prevRects.size === 0 || this._dragTab) return;
        vp.querySelectorAll('.tab').forEach(el => {
            // A re-held close slide owns this tab's offset for this render.
            if (el._stripSlideHeld) return;
            if (typeof el.animate !== 'function') return;
            const prev = prevRects.get(el.getAttribute('data-tab'));
            if (prev == null) return; // newborn tab: no prior position to slide from
            const r = el.getBoundingClientRect();
            const dx = prev - r.left;
            if (!Number.isFinite(dx) || Math.abs(dx) < 0.5) return;
            // Cancel a still-running (or forwards-filled) strip slide: its
            // composite offset was measured into dx, so cancelling +
            // re-animating from dx chains the motion instead of
            // double-applying it. Only our own tagged slides are touched —
            // CSS transitions and the bell flash share the element.
            _cancelStripSlides(el);
            try {
                const anim = el.animate(
                    [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0px)' }],
                    { duration: 180, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)' });
                anim.id = STRIP_SLIDE_ID;
            } catch (e) {}
        });
    },

    updateActiveClass() {
        if (this._activeTabEl) this._activeTabEl.classList.remove('active');
        const bar = document.getElementById('tabbar');
        if (!bar) return;
        const el = bar.querySelector(`.tab[data-tab="${this.activeId}"]`);
        if (el) {
            el.classList.add('active');
            this._activeTabEl = el;
        }
    },

    updateStatus() {
        const t = this.getActive();
        if (!t) return;
        // innerHTML swap (no listeners involved); `info` contains user data and
        // must stay escaped, the SVG icon is a static string
        if (t.type === 'settings') {
            document.getElementById('sb-conn').innerHTML = `<span class="sb-conn-icon">${Icons.iconSvg('settingsSmall', 12)}</span>设置`;
            return;
        }
        let iconName = 'terminal';
        let info = this._tabDisplayName(t);
        if (t.type === 'ssh') {
            iconName = 'zap';
            info = t.user ? `${t.user}@${t.host}` : t.name;
            if (!t.connected) info += ' (已断开)';
        }
        document.getElementById('sb-conn').innerHTML = `<span class="sb-conn-icon">${Icons.iconSvg(iconName, 12)}</span>${escHtml(info)}`;
    },

    // ── Split pane support (Tabby-aligned absolute model) ──
    _createContainer(orientation) { return { orientation, children: [], ratios: [] }; },

    _newPaneData(tab, srcPane) {
        const id = 'p_' + (this._paneCounter++);
        // Prefer srcPane fields (a split inherits from the focused pane), fall back to the tab
        const src = srcPane || tab;
        const isLocal = (src.type || tab.type || 'local') !== 'ssh';
        return {
            id,
            requestId: id,
            tabId: null,
            term: null,
            fitAddon: null,
            focused: false,
            // Pane name prefers srcPane.name (keeps the original pane name on drag-in/clone), otherwise tab.name (first split)
            name: srcPane ? (srcPane.name || '') : tab.name,
            type: src.type || (isLocal ? 'local' : 'ssh'),
            connected: isLocal || src.connected,
            _sshHost: src._sshHost || src.host,
            _sshPort: src._sshPort || src.port,
            _sshUser: src._sshUser || src.user,
            _sshCredId: src._sshCredId || src._credId,
            _sshProfileId: src._sshProfileId || src.sshProfileId,
            _command: isLocal ? (src._command || src.command || '') : '',
            _args: isLocal ? (src._args || src.args || []) : [],
        };
    },

    _spawnBackendForPane(pane, tab) {
        if (pane.type === 'ssh' && (pane._sshHost || tab.host)) {
            _sshConnectWithCredentials(tab, pane);
        } else {
            ipcRenderer.send('pty-create', _ptyCreatePayload(pane._command || tab.command || 'powershell.exe', pane._args || tab.args || [], _settingsConfig.startupDir, pane.requestId));
        }
    },

    splitHorizontal() {
        const tab = this.getActive();
        if (tab && tab.type !== 'settings') this.addPaneRelativeTo(tab, 'r');
    },

    splitVertical() {
        const tab = this.getActive();
        if (tab && tab.type !== 'settings') this.addPaneRelativeTo(tab, 'b');
    },

    addPaneRelativeTo(tab, side) {
        if (!tab.splitRoot) {
            if (!tab.term && !tab.tabId) return;
            const ew = document.getElementById('wrap_' + tab.id);
            if (ew) ew.remove();
            const existing = this._newPaneData(tab);
            existing.term = tab.term;
            existing.fitAddon = tab.fitAddon;
            existing._smoothCursor = tab._smoothCursor;
            existing.tabId = tab.tabId;
            existing.focused = false;
            // An in-flight SSH attempt follows its session onto the pane
            // (identity transfer; migrations never create attempts).
            sshAttempts.transferPendingAttempt(tab, existing);
            // The known-failed liveness marker (ipc.js) belongs to THIS
            // session and must survive the tab→pane promotion — a pending
            // paste would otherwise deliver into healthy siblings.
            existing._sessionFailed = tab._sessionFailed === true;
            // The stored tool-provided name travels with the terminal onto its
            // new pane wrapper — the split branch of resolveTabDisplayName only reads pane slots.
            if (tab._toolName !== undefined) { existing._toolName = tab._toolName; delete tab._toolName; }
            // Rebind onData: the terminal moved onto the pane, so it must use pane.tabId, not the now-cleared tab.tabId
            if (tab._onDataDisp) { tab._onDataDisp.dispose(); tab._onDataDisp = null; }
            existing._onDataDisp = existing.term?.onData(data => {
                _sendInputForTerm(existing.term, data);
            });
            tab.term = null;
            tab.fitAddon = null;
            tab.tabId = null;
            // The smooth-cursor wrapper now belongs to the pane that received
            // the terminal — leaving the tab-level reference alive would make
            // _inkFeed read a disposed wrapper's null adapter forever.
            tab._smoothCursor = null;
            const newPane = this._newPaneData(tab);
            const isH = side === 'l' || side === 'r';
            tab.splitRoot = this._createContainer(isH ? 'h' : 'v');
            if (side === 'l' || side === 't') tab.splitRoot.children = [newPane, existing];
            else tab.splitRoot.children = [existing, newPane];
            tab.splitRoot.ratios = [0.5, 0.5];
            newPane.focused = true;
            // Creating a split exits THIS tab's maximize state (per-tab source
            // of truth); the new pane must enter a visible layout, not stay
            // hidden behind a stale maximized-pane reference
            tab._maximizedPaneId = null;
            this._renderSplit(tab);
            this._spawnBackendForPane(newPane, tab);
            // The active terminal moved to the newly focused pending pane
            // (terminal search follows; rebinds when its terminal arrives)
            if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
            this._updateTabName(tab);
            this.render();
            return;
        }
        const all = getAllPanes(tab);
        const focused = all.find(p => p.focused) || all[all.length - 1];
        if (!focused) return;
        const newPane = this._newPaneData(tab, focused);
        // Kept as a fallback: when the tab lacks a credential, inherit from focused (defensive; _newPaneData normally covers this)
        if (!tab._credId && !newPane._sshCredId && focused._sshCredId) {
            newPane._sshHost = focused._sshHost || tab.host;
            newPane._sshPort = focused._sshPort || tab.port;
            newPane._sshUser = focused._sshUser || tab.user;
            newPane._sshCredId = focused._sshCredId;
            newPane._sshProfileId = focused._sshProfileId || tab.sshProfileId;
        }
        this.add(tab, newPane, focused, side);
        all.forEach(p => p.focused = false);
        newPane.focused = true;
        // The active terminal moved to the new pane (terminal search follows)
        if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
        // Same per-tab rule as the first-split branch above
        tab._maximizedPaneId = null;
        this._layoutTime = Date.now();
        this._renderSplit(tab);
        this._spawnBackendForPane(newPane, tab);
        this._updateTabName(tab);
        this.render();
    },

    add(tab, thing, relative, side) {
        // Tabby add semantics: when relative is null (root-edge zone) or the parent container is missing, repack the root container
        let target = relative ? getParentOf(tab, relative) : null;
        if (!target) {
            target = this._createContainer(['l', 'r'].includes(side) ? 'h' : 'v');
            target.children = [tab.splitRoot];
            target.ratios = [1];
            tab.splitRoot = target;
        }
        let insertIndex = relative
            ? target.children.indexOf(relative) + ('tl'.includes(side) ? 0 : 1)
            : 'tl'.includes(side) ? 0 : -1;
        if (
            (target.orientation === 'v' && ['l', 'r'].includes(side)) ||
            (target.orientation === 'h' && ['t', 'b'].includes(side))
        ) {
            const newContainer = this._createContainer(['l', 'r'].includes(side) ? 'h' : 'v');
            newContainer.children = relative ? [relative] : [];
            newContainer.ratios = [1];
            target.children.splice(relative ? target.children.indexOf(relative) : -1, 1, newContainer);
            target = newContainer;
            insertIndex = 'tl'.includes(side) ? 0 : 1;
        }
        for (let i = 0; i < target.children.length; i++) {
            target.ratios[i] *= target.children.length / (target.children.length + 1);
        }
        if (insertIndex === -1) insertIndex = target.ratios.length;
        target.ratios.splice(insertIndex, 0, 1 / (target.children.length + 1));
        target.children.splice(insertIndex, 0, thing);
        normalize(tab.splitRoot);
    },

    // passiveFocus: this render is a deferred COMPLETION (closeTab/closePane
    // removal machinery, session restore), not a user tree action — the
    // post-render focused-pane refocus then follows the passive intent rule.
    _renderSplit(tab, passiveFocus) {
        const main = document.getElementById('main-area');
        let rootEl = document.getElementById('split_' + tab.id);
        // splitRoot already torn down (split exited etc.): remove leftover DOM
        if (!tab.splitRoot) {
            if (rootEl) rootEl.remove();
            return;
        }
        // Reuse the existing root: keep pane DOM on tree changes and only update coordinates, so
        // CSS transitions animate smoothly from the old coordinates to the new (reorder animation)
        if (!rootEl) {
            document.getElementById('wrap_' + tab.id)?.remove();
            rootEl = document.createElement('div');
            rootEl.id = 'split_' + tab.id;
            rootEl.className = 'split-root' + (tab.syncInput ? ' sync-input' : '');
            main.appendChild(rootEl);
        } else {
            rootEl.className = 'split-root' + (tab.syncInput ? ' sync-input' : '');
        }
        // Visibility always tracks the active state: paths like cross-tab drag rebuild or reuse an
        // inactive tab's split root; otherwise the new visible root stacks over the active tab (ghost overlay)
        rootEl.style.display = (tab.id === this.activeId) ? '' : 'none';

        const buildPane = (pane) => {
            const el = document.createElement('div');
            el.className = 'split-pane' + (pane.focused ? ' active' : '');
            el.setAttribute('data-pane', pane.id);
            el.onmousedown = () => { if (!tab._maximizedPaneId) this._focusPane(tab, pane.id); };
            // Pane drag-reorder uses a Tabby-style drop-zone layer (rendered at _onPaneDragStart); panes carry no drop listeners of their own
            const dc = pane._sshConnecting ? 'connecting'
                : pane._sshErrored ? 'error'
                : ((pane.connected !== false && (pane.connected || !!pane.tabId)) ? 'connected' : 'disconnected');
            const showDot = _settingsConfig.showStatusDot !== false;
            const hdr = document.createElement('div');
            hdr.className = 'pane-header';
            // Only a disconnected SSH pane offers reconnecting; a live session
            // does not need a force-reconnect entry in the pane header.
            const reconnectPaneBtn = pane.type === 'ssh' && pane.connected === false && !pane._sshConnecting ? '<button title="重新连接" onclick="event.stopPropagation();TabManager._reconnectPane(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('rotate-cw', 12) + '</button>' : '';
            hdr.innerHTML = (showDot ? '<span class="dot ' + dc + '"></span>' : '') +
                '<span class="label">' + escHtml(pane.name || tab.name) + '</span>' +
                reconnectPaneBtn +
                '<button title="extract" onclick="event.stopPropagation();TabManager._extractPaneToTab(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('external-link', 12) + '</button>' +
                '<button title="maximize" onclick="event.stopPropagation();TabManager._maximizePane(\'' + tab.id + '\',\'' + pane.id + '\')">' + Icons.iconSvg('maximize', 13) + '</button>' +
                '<button title="close" onclick="event.stopPropagation();TabManager._closePane(\'' + tab.id + '\',\'' + pane.id + '\');this.blur()">' + Icons.iconSvg('x', 13) + '</button>';
            el.appendChild(hdr);
            // Drag-reorder: same pointer-based drag as Tabby (mousedown tracking, no HTML5 draggable)
            hdr.addEventListener('mousedown', (e) => this._onPaneHeaderMouseDown(e, tab, pane));
            const body = document.createElement('div');
            body.className = 'pane-body';
            body.id = 'pane-body_' + pane.id;
            if (pane.term) body.appendChild(pane.term.element);
            el.appendChild(body);
            return el;
        };

        const allPanes = getAllPanes(tab);
        // Collect existing pane nodes. pane-exit nodes are not excluded: if the pane re-enters the
        // tree within its fade-out window it is revived in place, avoiding duplicate DOM for one data-pane
        const existing = new Map();
        rootEl.querySelectorAll('.split-pane').forEach(el => {
            existing.set(el.getAttribute('data-pane'), el);
        });
        // Suppress ResizeObserver-driven fit during the animation: per-frame pane size changes
        // would trigger continuous full repaints + a pty-resize storm (TUI apps resized repeatedly,
        // terminal flicker); after the animation the 250ms timer below + _scheduleSettleResize settle
        this._layoutAnimating = true;
        const enterIds = [];
        allPanes.forEach(p => {
            let el = existing.get(p.id);
            if (el) {
                existing.delete(p.id);
                el.classList.remove('pane-exit'); // a pane mid-fade-out re-entering the tree is revived
                // Reused node: refresh the connection-status dot (state may have changed with the tree)
                const dc = p._sshConnecting ? 'connecting'
                    : p._sshErrored ? 'error'
                    : ((p.connected !== false && (p.connected || !!p.tabId)) ? 'connected' : 'disconnected');
                const dot = el.querySelector('.dot');
                if (dot) dot.className = 'dot ' + dc;
                return;
            }
            el = buildPane(p);
            rootEl.appendChild(el);
            const body = document.getElementById('pane-body_' + p.id);
            if (body && p.term) {
                if (body._resizeObserver) body._resizeObserver.disconnect();
                let raf = false;
                const obs = new ResizeObserver(() => {
                    if (raf) return;
                    if (TabManager._layoutAnimating) return;
                    raf = true;
                    requestAnimationFrame(() => {
                        // _windowResizing: suppress fit during window-drag resize (per-frame full repaints + pty-resize
                        // storm); after the drag stops, split.js's resize settle performs one unified fit
                        // _sftpAnimating: same suppression while the SFTP dock's width animation runs
                        if (!_spannerDrag && !TabManager._maximizing && !_windowResizing && !_sftpAnimating) _fitWithScroll(p.term, p.fitAddon, body);
                        raf = false;
                    });
                });
                obs.observe(body);
                body._resizeObserver = obs;
            }
            enterIds.push(p.id);
        });
        // Panes removed from the tree: fade out, then remove (only present when nodes were reused)
        existing.forEach((el) => {
            el.classList.add('pane-exit');
            setTimeout(() => { if (el.isConnected) el.remove(); }, 200);
        });
        this._layoutTime = Date.now();
        this._layoutSplit(tab);
        // Enter animation for newly created panes
        enterIds.forEach(id => {
            const newEl = rootEl.querySelector('.split-pane[data-pane="' + id + '"]');
            if (newEl) {
                newEl.classList.add('pane-enter');
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    newEl.classList.remove('pane-enter');
                }));
            }
        });
        // Lift the fit suppression (transition 200ms + margin)
        setTimeout(() => { this._layoutAnimating = false; }, 300);
        setTimeout(() => {
            allPanes.forEach(p => {
                if (!p.term || !p.fitAddon) return;
                const body = document.getElementById('pane-body_' + p.id);
                // Same-frame flush variant: a settle that still corrects the
                // grid repaints without a cleared-canvas frame (see switchTo).
                if (typeof _fitTermSync === 'function') _fitTermSync(p.term, p.fitAddon, body);
                else _fitWithScroll(p.term, p.fitAddon, body);
            });
        }, 250);
        // After tree changes, existing panes' xterm loses focus; forcibly refocus the focused pane
        // (fire-time validated: a tree change inside the window can close the pane or switch the tab)
        const fp = allPanes.find(p => p.focused);
        if (fp && fp.term) _scheduleTerminalFocus(() => fp.term, 200, passiveFocus);
        // Tree rebuilds (split/extract/collapse) can move the focused pane;
        // updateTarget's early-outs keep pane-drag rebuilds free of rebinds
        if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
    },

    _layoutSplit(tab) {
        if (!tab.splitRoot) return;
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl) return;
        const rootRect = rootEl.getBoundingClientRect();
        tab._gapXPct = (GAP_PX / rootRect.width) * 100;
        tab._gapYPct = (GAP_PX / rootRect.height) * 100;
        const maximizedPane = tab._maximizedPaneId ? findPane(tab, tab._maximizedPaneId) : null;
        const panes = getAllPanes(tab);
        panes.forEach(p => {
            const el = rootEl.querySelector('.split-pane[data-pane="' + p.id + '"]');
            if (el) {
                el.classList.toggle('active', p.focused && !maximizedPane);
                el.classList.toggle('maximized', maximizedPane === p);
                el.classList.toggle('minimized', !!maximizedPane && maximizedPane !== p);
                el.style.display = '';
            }
        });
        this._layoutInternal(tab, tab.splitRoot, 0, 0, 100, 100, rootEl);
        rootEl.querySelectorAll('.split-spanner').forEach(s => s.remove());
        if (maximizedPane) {
            const maxEl = rootEl.querySelector('.split-pane[data-pane="' + maximizedPane.id + '"]');
            if (maxEl) {
                maxEl.style.left = '0';
                maxEl.style.top = '0';
                maxEl.style.width = '100%';
                maxEl.style.height = '100%';
            }
            rootEl.querySelectorAll('.split-pane').forEach(el => {
                if (el !== maxEl) el.style.display = 'none';
            });
            return;
        }
        this._addSpanners(tab, tab.splitRoot);
        // Settle sizes after the animation (the onResize suppression window drops the final animated size; without this, nvim and other TUI layouts break)
        _scheduleSettleResize(tab);
    },

    _layoutInternal(tab, container, x, y, w, h, rootEl) {
        container._x = x;
        container._y = y;
        container._w = w;
        container._h = h;
        const isV = container.orientation === 'v';
        const gap = isV ? (tab._gapYPct || 0) : (tab._gapXPct || 0);
        const size = isV ? h : w;
        const n = container.children.length;
        const totalGap = (n - 1) * gap;
        const avail = Math.max(size - totalGap, 0);
        const sizes = container.ratios.map(r => r * avail);
        let offset = 0;
        container.children.forEach((child, i) => {
            const childX = isV ? x : x + offset;
            const childY = isV ? y + offset : y;
            const childW = isV ? w : sizes[i];
            const childH = isV ? sizes[i] : h;
            if (child.orientation) {
                this._layoutInternal(tab, child, childX, childY, childW, childH, rootEl);
            } else {
                // Use the rootEl passed in from outside, avoiding a getElementById + querySelector per leaf
                const el = rootEl ? rootEl.querySelector('.split-pane[data-pane="' + child.id + '"]') : null;
                if (el) {
                    if (tab._maximizedPaneId && tab._maximizedPaneId === child.id) {
                        el.style.left = '0.5%';
                        el.style.top = '0.5%';
                        el.style.width = '99%';
                        el.style.height = '99%';
                    } else {
                        el.style.left = childX + '%';
                        el.style.top = childY + '%';
                        el.style.width = childW + '%';
                        el.style.height = childH + '%';
                    }
                }
            }
            offset += sizes[i] + gap;
        });
    },

    _addSpanners(tab, container) {
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl) return;
        const isH = container.orientation === 'h';
        const gap = isH ? (tab._gapXPct || 0) : (tab._gapYPct || 0);
        const size = isH ? container._w : container._h;
        const n = container.children.length;
        const totalGap = (n - 1) * gap;
        const avail = Math.max(size - totalGap, 0);
        let offset = 0;
        for (let i = 1; i < n; i++) {
            offset += container.ratios[i - 1] * avail + gap;
            const spanner = document.createElement('div');
            // Horizontal container -> vertical divider; vertical container -> horizontal divider
            spanner.className = 'split-spanner ' + (isH ? 'v' : 'h');
            if (isH) {
                spanner.style.left = (container._x + offset - gap / 2) + '%';
                spanner.style.top = container._y + '%';
                spanner.style.height = container._h + '%';
            } else {
                spanner.style.top = (container._y + offset - gap / 2) + '%';
                spanner.style.left = container._x + '%';
                spanner.style.width = container._w + '%';
            }
            spanner.onmousedown = (e) => _startSpannerDrag(e, tab, container, i);
            spanner.ondblclick = (e) => {
                e.stopPropagation();
                const r = (container.ratios[i - 1] + container.ratios[i]) / 2;
                container.ratios[i - 1] = r;
                container.ratios[i] = r;
                this._layoutSplit(tab);
            };
            rootEl.appendChild(spanner);
        }
        container.children.forEach(child => {
            if (child.orientation) this._addSpanners(tab, child);
        });
    },

    // ── Pane drag swap (swap any two panes' position and size) ──
    _paneDragState: null,

    // Same pointer-based drag as Tabby: mousedown on the header, drag starts past a threshold, drop zones are hit while moving, release performs the insert
    _onPaneHeaderMouseDown(e, tab, pane) {
        if (e.button !== 0 || tab._maximizedPaneId) return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        this._paneDragState = { sourceTab: tab, sourcePane: pane, startX: e.clientX, startY: e.clientY, dragging: false, zones: [], ghost: null };
        const move = (ev) => this._onPanePointerMove(ev);
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            this._onPanePointerUp(ev);
        };
        // mouseup is not dispatched when the pointer leaves the window or it loses focus, so clean up defensively (leftover ghost/translucency/drop zones)
        const cancelDrag = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            this._onPaneDragEnd();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('mouseleave', cancelDrag);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('pointercancel', cancelDrag);
    },

    _onPanePointerMove(e) {
        const state = this._paneDragState;
        if (!state) return;
        if (!state.dragging) {
            if (Math.abs(e.clientX - state.startX) + Math.abs(e.clientY - state.startY) < 5) return;
            state.dragging = true;
            document.body.classList.add('pane-dragging');
            // Source pane turns translucent (Tabby behavior)
            const el = document.querySelector(`.split-pane[data-pane="${state.sourcePane.id}"]`);
            if (el) el.style.opacity = '0.4';
            this._showPaneDropZones(state.sourceTab);
            this._showPaneDragGhost(state, e);
        }
        this._movePaneDragGhost(state, e);
        // Hit detection (Tabby's drop-zone highlight)
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const zoneEl = hit && hit.closest ? hit.closest('.pane-drop-zone') : null;
        document.querySelectorAll('.pane-drop-zone.drag-over').forEach(el => { if (el !== zoneEl) el.classList.remove('drag-over'); });
        if (zoneEl) {
            zoneEl.classList.add('drag-over');
            const zone = state.zones && state.zones[parseInt(zoneEl.getAttribute('data-zone-idx'), 10)];
            if (zone) this._updatePaneDropPreview(state.sourceTab, zone);
            else this._hideDropHint();
        } else {
            this._hideDropHint();
        }
    },

    _onPanePointerUp(e) {
        const state = this._paneDragState;
        if (!state) return;
        if (state.dragging) {
            const hit = document.elementFromPoint(e.clientX, e.clientY);
            const zoneEl = hit && hit.closest ? hit.closest('.pane-drop-zone') : null;
            if (zoneEl) {
                const zone = state.zones[parseInt(zoneEl.getAttribute('data-zone-idx'), 10)];
                if (zone) this._movePaneToZone(state.sourceTab, zone);
            }
        }
        this._onPaneDragEnd();
    },

    _showPaneDragGhost(state, e) {
        const ghost = document.createElement('div');
        ghost.className = 'pane-drag-ghost';
        ghost.textContent = (state.sourcePane._toolName || '').trim() || state.sourcePane.name || this._tabDisplayName(state.sourceTab);
        document.body.appendChild(ghost);
        state.ghost = ghost;
        this._movePaneDragGhost(state, e);
    },

    _movePaneDragGhost(state, e) {
        if (state.ghost) {
            state.ghost.style.left = (e.clientX + 12) + 'px';
            state.ghost.style.top = (e.clientY + 14) + 'px';
        }
    },

    // ── Same pane drag-reorder as Tabby: compute drop-zone bars; a hit inserts in the side direction ──

    // Compute drop zones (aligned with Tabby layoutInternal): root container edges + per-child side bars + spanner gap bars
    _computePaneDropZones(tab) {
        const zones = [];
        const T = 8; // zone thickness (percent of the split area; Tabby uses 10)
        const walk = (container, x, y, w, h) => {
            const isV = container.orientation === 'v';
            const gap = isV ? (tab._gapYPct || 0) : (tab._gapXPct || 0);
            const size = isV ? h : w;
            const avail = Math.max(size - (container.children.length - 1) * gap, 0);
            const sizes = container.ratios.map(r => r * avail);
            // Root container's four edges (Tabby: root l/t/r/b)
            if (container === tab.splitRoot) {
                zones.push({ x: x - T / 2, y: y + T, w: T, h: h - T * 2, side: 'l', relativeTo: null });
                zones.push({ x, y: y - T / 2, w, h: T, side: 't', relativeTo: null });
                zones.push({ x: x + w - T / 2, y: y + T, w: T, h: h - T * 2, side: 'r', relativeTo: null });
                zones.push({ x, y: y + h - T / 2, w, h: T, side: 'b', relativeTo: null });
            }
            let offset = 0;
            container.children.forEach((child, i) => {
                const childX = isV ? x : x + offset;
                const childY = isV ? y + offset : y;
                const childW = isV ? w : sizes[i];
                const childH = isV ? sizes[i] : h;
                if (child.orientation) walk(child, childX, childY, childW, childH);
                offset += sizes[i];
                // Spanner gap zone: inserts after the child along the container direction (Tabby adds one for every non-last child)
                if (i !== container.ratios.length - 1) {
                    zones.push({
                        x: isV ? childX + T : childX + offset - T / 2,
                        y: isV ? childY + offset - T / 2 : childY + T,
                        w: isV ? childW - T * 2 : T,
                        h: isV ? T : childH - T * 2,
                        side: isV ? 'b' : 'r',
                        relativeTo: child,
                    });
                }
                // Child side zone: inserts on the child's side perpendicular to the parent direction (Tabby adds these for all children)
                if (isV) {
                    zones.push({ x: childX, y: childY + T, w: T, h: childH - T * 2, side: 'l', relativeTo: child });
                    zones.push({ x: childX + childW - T, y: childY + T, w: T, h: childH - T * 2, side: 'r', relativeTo: child });
                } else {
                    zones.push({ x: childX + T, y: childY, w: childW - T * 2, h: T, side: 't', relativeTo: child });
                    zones.push({ x: childX + T, y: childY + childH - T, w: childW - T * 2, h: T, side: 'b', relativeTo: child });
                }
                offset += gap;
            });
        };
        walk(tab.splitRoot, 0, 0, 100, 100);
        return zones;
    },

    _showPaneDropZones(tab) {
        this._hidePaneDropZones();
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl || !tab.splitRoot) return;
        if (getAllPanes(tab).length < 2) return; // a single pane has nothing to reorder with (Tabby canActivateFor)
        const src = this._paneDragState && this._paneDragState.sourcePane;
        const zones = this._computePaneDropZones(tab).filter(z => !(src && z.relativeTo === src)); // exclude dropping back onto itself (Tabby canActivateFor)
        if (this._paneDragState) this._paneDragState.zones = zones;
        const layer = document.createElement('div');
        layer.id = 'pane-drop-layer';
        zones.forEach((z, i) => {
            const el = document.createElement('div');
            el.className = 'pane-drop-zone side-' + z.side;
            el.setAttribute('data-zone-idx', i);
            el.style.left = z.x + '%'; el.style.top = z.y + '%';
            el.style.width = z.w + '%'; el.style.height = z.h + '%';
            layer.appendChild(el);
        });
        rootEl.appendChild(layer);
    },

    _hidePaneDropZones() {
        document.getElementById('pane-drop-layer')?.remove();
    },

    _movePaneToZone(tab, zone) {
        const state = this._paneDragState;
        if (!state) return;
        const sourcePane = state.sourcePane;
        if (zone.relativeTo === sourcePane) { this._onPaneDragEnd(); return; }
        // A zone that names a sub-container holding ONLY the dragged pane and
        // one sibling collapses to that sibling when the pane detaches (the
        // normalize below): re-anchor the drop to the sibling now. Inserting
        // against the detached container computes a stale index and lands the
        // pane on a root edge instead.
        let rel = zone.relativeTo;
        if (rel && rel.orientation && rel.children.length === 2 && rel.children.indexOf(sourcePane) >= 0) {
            rel = rel.children[rel.children[0] === sourcePane ? 1 : 0];
        }
        // 1. Detach from the original parent container (Tabby: removeTab before add)
        const parent = getParentOf(tab, sourcePane);
        if (!parent) { this._onPaneDragEnd(); return; }
        const idx = parent.children.indexOf(sourcePane);
        parent.children.splice(idx, 1);
        parent.ratios.splice(idx, 1);
        normalize(tab.splitRoot);
        // 2. Insert per the zone's side at the position relative to relativeTo (reuses the Tabby-semantics add)
        this.add(tab, sourcePane, rel, zone.side);
        this._onPaneDragEnd();
        this._renderSplit(tab);
    },

    _onPaneDragEnd() {
        document.body.classList.remove('pane-dragging');
        this._hidePaneDropZones();
        this._hideDropHint();
        const state = this._paneDragState;
        if (state) {
            if (state.ghost) state.ghost.remove();
            const el = document.querySelector(`.split-pane[data-pane="${state.sourcePane.id}"]`);
            if (el) el.style.opacity = '';
        }
        this._paneDragState = null;
    },

    _closePane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || !tab.splitRoot) return;
        const pane = findPane(tab, paneId);
        if (!pane) return;
        // Dying guard: the close button keeps focus after its click (Enter/
        // Space re-fires it) and a repeated close shortcut still resolves to
        // this pane while its exit animation runs. A second close must not
        // schedule a second removal — after the first one collapses the tree,
        // the late one would close the whole tab and kill the survivor's
        // live session.
        if (pane._closing) return;
        pane._closing = true;
        if (tab._maximizedPaneId === paneId) tab._maximizedPaneId = null;
        // The pane's session is destroyed below: the SFTP panel must not stay
        // bound to it (it would keep showing a dead session's listing).
        this._closeSftpForSessions([pane.tabId]);
        // Destroy backend immediately but keep the DOM for exit animation.
        // The cancellation carries the pane's OWN attempt identity (backend
        // id once claimed, else the attempt token): the main process locates
        // exactly that pending generation wherever it lives, and the attempt's
        // queue slot is released with it — never a display address.
        if (pane.tabId) {
            this._markClosed(pane.tabId);
            _cancelSshAttemptOf(pane, pane.tabId);
            delete ptyBuffers[pane.tabId]; // prevent permanent buffer leaks (a closed pane is never wired again)
        } else {
            // Pending-creation cancellation at initiation: a pane without a
            // backend yet may still have its SSH attempt in flight. Cancel it
            // now — after the pane leaves the tree nobody remains to destroy
            // the completed session. (Local pending panes keep their
            // requestId marker; a late local pty-created is orphan-destroyed
            // by the pty-created handler.)
            _cancelSshAttemptOf(pane, null);
        }
        if (pane.term) try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(pane.term); pane._smoothCursor?.dispose(); pane._smoothCursor = null; pane.term.dispose(); } catch(e) {}
        // Disconnect the dying pane's body observer NOW: every path the
        // deferred removal fans into (survivors re-render, collapse via
        // _exitSplit, whole-tab closeTab) iterates only SURVIVING panes, so
        // this body's observer would never be disconnected — Blink keeps
        // observed nodes (and their DOM subtrees) alive.
        const paneBody = document.getElementById('pane-body_' + pane.id);
        if (paneBody && paneBody._resizeObserver) paneBody._resizeObserver.disconnect();
        // Release the pane's own credential handle — but only when no other
        // wrapper still uses it: siblings split from the same session inherit
        // the same id (their reconnects need it), other tabs can hold it too
        // (clone/extract adoption), and the tab-level handle is decided by
        // closeTab. A pane committed to close can no longer reconnect, so
        // dying siblings do not count as references.
        const paneCredId = pane._sshCredId;
        if (paneCredId && !_credIdStillReferenced(this.tabs, paneCredId, pane)) {
            ipcRenderer.send('revoke-credential', { credId: paneCredId });
        }
        // Closing is committed at initiation, not at the deferred removal:
        // drop the session slots immediately so the dying pane resolves to NO
        // owner during the exit animation (a pending right-click paste must
        // not reach the destroyed backend) and the sync-input broadcast skips
        // it (only panes with a live tabId receive input). requestId and the
        // attempt binding go with them: a late pty-created/ssh-connecting
        // must not claim the fading pane and resurrect a terminal nobody will
        // dispose. The pane element itself stays mounted purely for the fade
        // animation.
        pane.term = null;
        pane.fitAddon = null;
        pane.tabId = null;
        pane.requestId = null;
        pane._pendingAttempt = null;
        // A pane committed to close can never reconnect: drop the pending
        // flag too, or a lone survivor check below would read this dying
        // pane as "awaiting its reconnect" instead of dead.
        pane._reconnectPending = false;
        // The dying pane must not stay the focus marker owner: a repeated
        // close shortcut inside the exit window resolves the focused pane and
        // would hit it again. Hand the marker to the next sibling in tree
        // order (exactly what the deferred removal would pick).
        if (pane.focused) {
            pane.focused = false;
            const sibling = getAllPanes(tab).find(p => p !== pane && !p._closing);
            if (sibling) sibling.focused = true;
        }
        // Exit animation: fade + shrink, then remove from tree and re-render
        const rootEl = document.getElementById('split_' + tab.id);
        const paneEl = rootEl ? rootEl.querySelector('.split-pane[data-pane="' + paneId + '"]') : null;
        const doRemove = () => {
            // The pane may already be out of the tree (the whole tab closed
            // inside the fade window): that teardown path owns the tree.
            const parent = getParentOf(tab, pane);
            if (!parent) return;
            const idx = parent.children.indexOf(pane);
            if (idx >= 0) { parent.children.splice(idx, 1); parent.ratios.splice(idx, 1); }
            normalize(tab.splitRoot);
            const rem = getAllPanes(tab);
            // A lone survivor that is itself mid-close (its session slots were
            // already dropped at initiation but its own removal timer is still
            // pending) is dead: promoting it would leave a terminal-less shell
            // tab that still reads connected. Take the no-survivor path
            // instead; its own pending removal finishes the tree teardown.
            // A survivor inside its own pre-attempt reconnect window (same
            // reasoning as the deadShell check in closeTab) is NOT dead.
            const survivorDead = rem.length === 1 && !rem[0].term && !rem[0].tabId && !rem[0].requestId && !rem[0]._pendingAttempt && !rem[0]._reconnectPending;
            if (rem.length === 0 || survivorDead) {
                this.closeTab(tabId);
            } else if (rem.length === 1) {
                // A manual rename (_customName) outranks the pane-inherited
                // name: the survivor's name froze at split time, so adopting it
                // here would resurrect the pre-rename name while the lock keeps
                // _updateTabName from ever restoring the user's name.
                if (!tab._customName) tab.name = rem[0]?.name || tab.name;
                this._exitSplit(tab);
                // The active terminal collapsed back onto the tab (terminal
                // search follows the surviving terminal)
                if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
                this._updateTabName(tab);
                this.render();
            } else {
                if (!rem.some(p => p.focused)) rem[0].focused = true;
                // The active terminal changed (terminal search follows)
                if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
                // Deferred completion of the user's close (200ms ago): the
                // refocuses below are PASSIVE, not new activations.
                this._renderSplit(tab, true);
                this._updateTabName(tab);
                this.render();
                const focused = rem.find(p => p.focused);
                if (focused && focused.term) {
                    setTimeout(() => {
                        _fitWithScroll(focused.term, focused.fitAddon, document.getElementById('pane-body_' + focused.id));
                        // Fire-time validated PASSIVE focus only: the survivor
                        // may itself be closed or the tab switched away inside
                        // the window, and a live form focus the user is holding
                        // survives the completion — the fit above still runs
                        // regardless.
                        _focusTerminalIfCurrent(focused.term, null, true);
                    }, 150);
                }
            }
        };
        if (paneEl) {
            paneEl.classList.add('pane-exit');
            setTimeout(doRemove, 200);
        } else {
            doRemove();
        }
    },

    _focusPane(tab, paneId) {
        if (tab._maximizedPaneId) return;
        const all = getAllPanes(tab);
        all.forEach(p => p.focused = (p.id === paneId));
        const rootEl = document.getElementById('split_' + tab.id);
        if (rootEl) {
            rootEl.querySelectorAll('.split-pane').forEach(el => {
                el.classList.toggle('active', el.getAttribute('data-pane') === paneId);
            });
        }
        const pane = findPane(tab, paneId);
        // Do not steal focus mid pane drag (a term.focus() 50ms later would kill a just-started drag).
        // The focus itself is validated at fire time: closing the pane inside
        // the window nulls its term slot (the old captured-slot deref threw),
        // and a newer pane/tab/form focus wins over this timer.
        if (pane && pane.term) {
            const priorFocus = document.activeElement || null;
            setTimeout(() => { if (!this._paneDragState) _focusTerminalIfCurrent(pane.term, priorFocus); }, 50);
        }
        // The active terminal changed (terminal search follows)
        if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
        // SFTP dock follows the focused pane
        if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
    },

    _maximizePane(tabId, paneId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || !tab.splitRoot) return;
        if (tab._maximizedPaneId === paneId) {
            tab._maximizedPaneId = null;
        } else {
            tab._maximizedPaneId = paneId;
            const pane = findPane(tab, paneId);
            if (pane) getAllPanes(tab).forEach(p => p.focused = (p.id === paneId));
            // The focused pane may have moved with the maximize: the SFTP
            // dock follows it
            if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
            // The active terminal changed (terminal search follows)
            if (typeof _refreshSearchAfterActiveChange === 'function') _refreshSearchAfterActiveChange();
        }
        this._maximizing = true;
        this._layoutSplit(tab);
        const pane = findPane(tab, tab._maximizedPaneId || paneId);
        if (pane && pane.term && pane.fitAddon) {
            const priorFocus = document.activeElement || null;
            setTimeout(() => {
                this._maximizing = false;
                const body = document.getElementById('pane-body_' + pane.id);
                if (body) _fitWithScroll(pane.term, pane.fitAddon, body);
                // onResize/applyFit are fully suppressed during _maximizing, so after fit the final size must be
                // sent explicitly; otherwise the backend stays at the old cols/rows (nvim, htop and other TUI layouts break)
                if (pane.tabId && pane.term?.cols && pane.term?.rows) {
                    ipcRenderer.send('pty-resize', { tabId: pane.tabId, cols: pane.term.cols, rows: pane.term.rows });
                }
                // Fire-time validated focus only: a close/switch inside the
                // 220ms window makes this pane's focus stale — the fit and
                // the explicit resize above still complete.
                _focusTerminalIfCurrent(pane.term, priorFocus);
            }, 220);
        } else {
            setTimeout(() => { this._maximizing = false; }, 220);
        }
    },

    _extractPaneToTab(tabId, paneId) {
        const st = this.tabs.find(t => t.id === tabId);
        if (!st || !st.splitRoot) return;
        const pane = findPane(st, paneId);
        if (!pane || !pane.term || !pane.tabId) return;
        const nt = {
            id: 't_' + (this._counter++),
            name: pane.name || st.name,
            term: pane.term,
            fitAddon: pane.fitAddon,
            tabId: pane.tabId,
            splitRoot: null,
        };
        // Session identity (type/ssh fields/command/args/credential) is adopted
        // from the extracted pane's own session — the source tab's fields may
        // belong to a different session and must not leak into the new tab
        adoptPaneFieldsIntoTab(nt, pane);
        // An in-flight SSH attempt follows its session onto the extracted
        // tab: the attempt keeps its immutable token/backend identity, only
        // the owner binding moves (close/reconnect of the extracted wrapper
        // cancels exactly this attempt — the proved extract-of-claimed case).
        sshAttempts.transferPendingAttempt(pane, nt);
        // The pane's smooth-cursor wrapper follows its terminal onto the new
        // tab; the dropped pane must not keep a reference to the living wrapper
        nt._smoothCursor = pane._smoothCursor;
        pane._smoothCursor = null;
        // Rebind onData after moving to the new tab: the original closure referenced pane (the source tab's
        // old pane); the rebind resolves the owner at send time
        if (pane._onDataDisp) { pane._onDataDisp.dispose(); pane._onDataDisp = null; }
        nt._onDataDisp = pane.term?.onData(data => {
            _sendInputForTerm(pane.term, data);
        });
        // The pane's tool-provided name follows its terminal onto the new single tab.
        if (pane._toolName !== undefined) nt._toolName = pane._toolName;
        this.tabs.push(nt);
        const parent = getParentOf(st, pane);
        if (parent) {
            const idx = parent.children.indexOf(pane);
            parent.children.splice(idx, 1);
            parent.ratios.splice(idx, 1);
        }
        if (st._maximizedPaneId === paneId) st._maximizedPaneId = null;
        // Disconnect the extracted pane's body observer before the DOM drop —
        // Blink keeps observed nodes (and their DOM subtrees) alive
        const exBody = document.getElementById('pane-body_' + pane.id);
        if (exBody && exBody._resizeObserver) exBody._resizeObserver.disconnect();
        normalize(st.splitRoot);
        const rem = getAllPanes(st);
        if (rem.length === 0) {
            const idx = this.tabs.indexOf(st);
            if (idx >= 0) this.tabs.splice(idx, 1);
            const sp = document.getElementById('split_' + st.id);
            if (sp) sp.remove();
        } else if (rem.length === 1) {
            const rp = rem[0];
            st.splitRoot = null;
            // The collapse ends sync input with the split: a leftover flag
            // would silently resume broadcasting on the next re-split (and
            // fire the exit-on-click toast on a tab that shows no split).
            st.syncInput = false;
            if (!rem.some(p => p.focused)) rp.focused = true;
            // Pending backend hand-off: the surviving pane's creation request
            // must survive the collapse, or its pty-created finds no consumer
            // and the fresh backend is orphan-destroyed
            if (rp.tabId) delete st._ptyRequestId;
            else st._ptyRequestId = rp.requestId;
            sshAttempts.transferPendingAttempt(rp, st);
            // The term moves from pane back to tab: dispose the pane's zombie onData listener and rebind to the tab
            if (rp._onDataDisp) { rp._onDataDisp.dispose(); rp._onDataDisp = null; }
            st.term = rp.term;
            st.fitAddon = rp.fitAddon;
            st.tabId = rp.tabId;
            // Same collapse rule as _closePane: the rename lock outranks the
            // surviving pane's stale (split-time) name.
            if (!st._customName) st.name = rp.name || st.name;
            // Session identity follows the surviving pane — the tab's old
            // host/user/credential may belong to the extracted session
            adoptPaneFieldsIntoTab(st, rp);
            st._smoothCursor = rp._smoothCursor ?? null;
            if (rp._toolName !== undefined) st._toolName = rp._toolName; else delete st._toolName;
            if (st.term) {
                st._onDataDisp = st.term.onData(data => {
                    _sendInputForTerm(st.term, data);
                });
            }
            const rpBody = document.getElementById('pane-body_' + rp.id);
            if (rpBody && rpBody._resizeObserver) rpBody._resizeObserver.disconnect();
            const os = document.getElementById('split_' + st.id);
            if (os) os.remove();
            // Standard wrap/inner structure: FitAddon must measure the padded
            // content area (same geometry as every single-terminal tab), not
            // the padded container
            const { wrap: w, inner: wInner } = createTermWrap(st);
            document.getElementById('main-area').appendChild(w);
            if (st.term) {
                wInner.appendChild(st.term.element);
                setupWrapResizeObserver(w, st);
                if (st.fitAddon) setTimeout(() => {
                    _fitWithScroll(st.term, st.fitAddon, wInner);
                    // Report the final size explicitly: an unchanged fit fires
                    // no onResize, and the backend would keep the pre-collapse
                    // geometry
                    if (st.term?.cols) _sendResizeForTerm(st.term, st.term.cols, st.term.rows);
                }, 50);
            }
        } else {
            if (!rem.some(p => p.focused)) rem[0].focused = true;
            this._renderSplit(st);
        }
        const { wrap: nw, inner: nInner } = createTermWrap(nt);
        document.getElementById('main-area').appendChild(nw);
        if (nt.term) {
            nInner.appendChild(nt.term.element);
            setupWrapResizeObserver(nw, nt);
            if (nt.fitAddon) setTimeout(() => {
                _fitWithScroll(nt.term, nt.fitAddon, nInner);
                if (nt.term?.cols) _sendResizeForTerm(nt.term, nt.term.cols, nt.term.rows);
            }, 50);
        }
        this._updateTabName(st);
        this._updateTabName(nt);
        this.render();
        this.switchTo(nt.id);
        this.updateStatus();
    },

    // anchorNode (optional): the zone-bar anchor of a tab drag — a leaf pane
    // or a nested split CONTAINER (its edge / spanner bars name the container
    // child directly; containers carry no pane id, so the id-only transport
    // degraded those hits to whole-split root-edge inserts).
    _moveTerminalToTab(sourceTabId, targetTabId, side, targetPaneId, anchorNode) {
        const sourceTab = this.tabs.find(t => t.id === sourceTabId);
        const targetTab = this.tabs.find(t => t.id === targetTabId);
        if (!sourceTab || !targetTab || sourceTab === targetTab) return;
        if (sourceTab.type === 'settings' || targetTab.type === 'settings') return;
        // Validate the target pane still exists first (a shortcut split may have changed the target tree
        // during the drag). Detach the source pane only after validation — otherwise the failure path drops it
        const focusedPane = targetPaneId ? findPane(targetTab, targetPaneId) : null;
        if (targetPaneId && !focusedPane) return;
        // A container anchor must still be attached to the target tree at
        // drop time (the tree may have changed mid-drag) — same staleness
        // rule as the pane id: a stale anchor drops the drop, never guesses.
        const anchorIsContainer = !!(anchorNode && anchorNode.orientation);
        if (anchorIsContainer && !getParentOf(targetTab, anchorNode)) return;
        const dropAnchor = anchorIsContainer ? anchorNode : focusedPane;
        let mt = null, mf = null, mid = null, sc = null, msc = null, mconn = false, mfailed = false;
        let paneName = sourceTab.name, paneType = sourceTab.type || 'local';
        let toolName = sourceTab._toolName;
        // The wrapper whose in-flight SSH attempt must follow the moved
        // session: the FOCUSED PANE for a split source (that object leaves
        // the tree below; the source tab keeps only the surviving panes),
        // or the source tab itself for a single-tab move.
        let movedOwner = sourceTab;
        // Shell config comes from the MOVED session: a local pane dragged out
        // of an SSH-rooted tab must keep bash.exe and its args — the source
        // tab's command/args belong to a different session
        let paneCommand = sourceTab.command || '', paneArgs = sourceTab.args || [];
        let sshHost = sourceTab.host, sshPort = sourceTab.port, sshUser = sourceTab.user;
        let sshCredId = sourceTab._credId, sshProfileId = sourceTab.sshProfileId;
        if (sourceTab.splitRoot) {
            const ap = getAllPanes(sourceTab);
            const focused = ap.find(p => p.focused) || ap[ap.length - 1];
            // Readiness check BEFORE tearing the source split tree apart —
            // otherwise an unready pane (SSH still connecting) leaves the
            // tree damaged and the pane's input permanently broken.
            if (!focused || !focused.term || !focused.tabId) return;
            mt = focused.term; mf = focused.fitAddon; mid = focused.tabId;
            msc = focused?._smoothCursor ?? null;
            movedOwner = focused;
            // Connection state travels with the MOVED session: a disconnected
            // (or still-connecting) pane must not read as online on arrival
            mconn = paneConnectedState(focused);
            mfailed = focused._sessionFailed === true;
            // Dispose the dragged pane's onData listener immediately: otherwise after np is rebound below, the term
            // would hold two listeners (the old pane's + np's) and every keypress would fire twice
            if (focused._onDataDisp) { focused._onDataDisp.dispose(); focused._onDataDisp = null; }
            paneName = focused.name || sourceTab.name;
            paneType = focused.type || sourceTab.type || 'local';
            toolName = focused._toolName;
            paneCommand = focused._command || '';
            paneArgs = focused._args || [];
            sshHost = focused._sshHost || sourceTab.host;
            sshPort = focused._sshPort || sourceTab.port;
            sshUser = focused._sshUser || sourceTab.user;
            sshCredId = focused._sshCredId || sourceTab._credId;
            sshProfileId = focused._sshProfileId || sourceTab.sshProfileId;
            const parent = getParentOf(sourceTab, focused);
            if (parent) {
                const idx = parent.children.indexOf(focused);
                parent.children.splice(idx, 1);
                parent.ratios.splice(idx, 1);
                // The moved pane cannot stay this tab's maximized pane: a stale
                // id would keep the remaining layout minimized forever
                if (sourceTab._maximizedPaneId === focused.id) sourceTab._maximizedPaneId = null;
                normalize(sourceTab.splitRoot);
                const rem = getAllPanes(sourceTab);
                if (rem.length === 1) {
                    sc = () => {
                        const rp = rem[0];
                        // Pending backend hand-off: keep the surviving pane's
                        // LOCAL creation request claimable after the collapse
                        // (marker consumed by the pty-created handler); an
                        // in-flight SSH attempt transfers by identity instead.
                        if (rp.tabId) delete sourceTab._ptyRequestId;
                        else sourceTab._ptyRequestId = rp.requestId;
                        sshAttempts.transferPendingAttempt(rp, sourceTab);
                        // The term moves from pane back to tab: dispose the pane's zombie onData listener and rebind to the tab
                        if (rp._onDataDisp) { rp._onDataDisp.dispose(); rp._onDataDisp = null; }
                        sourceTab.term = rp.term;
                        sourceTab.fitAddon = rp.fitAddon;
                        sourceTab._smoothCursor = rp._smoothCursor;
                        sourceTab.tabId = rp.tabId;
                        sourceTab.splitRoot = null;
                        // Same collapse rule as _extractPaneToTab: sync input
                        // dies with the split tree.
                        sourceTab.syncInput = false;
                        // Same collapse rule as _closePane: the rename lock
                        // outranks the surviving pane's stale (split-time) name.
                        if (!sourceTab._customName) sourceTab.name = rp.name || sourceTab.name;
                        // Session identity follows the surviving pane — the
                        // tab's old host/credential/command may belong to the
                        // moved session
                        adoptPaneFieldsIntoTab(sourceTab, rp);
                        if (rp._toolName !== undefined) sourceTab._toolName = rp._toolName; else delete sourceTab._toolName;
                        if (sourceTab.term) {
                            sourceTab._onDataDisp = sourceTab.term.onData(data => {
                                _sendInputForTerm(sourceTab.term, data);
                            });
                        }
                        const rpBody = document.getElementById('pane-body_' + rp.id);
                        if (rpBody && rpBody._resizeObserver) rpBody._resizeObserver.disconnect();
                        const sp = document.getElementById('split_' + sourceTab.id);
                        if (sp) sp.remove();
                        const { wrap: w, inner: wInner } = createTermWrap(sourceTab);
                        document.getElementById('main-area').appendChild(w);
                        if (sourceTab.term) {
                            wInner.appendChild(sourceTab.term.element);
                            setupWrapResizeObserver(w, sourceTab);
                            if (sourceTab.fitAddon) setTimeout(() => {
                                _fitWithScroll(sourceTab.term, sourceTab.fitAddon, wInner);
                                // Explicit final-size report: an unchanged fit
                                // fires no onResize and the backend would keep
                                // the pre-collapse geometry
                                if (sourceTab.term?.cols) _sendResizeForTerm(sourceTab.term, sourceTab.term.cols, sourceTab.term.rows);
                            }, 50);
                        }
                        this._updateTabName(sourceTab);
                    };
                } else if (rem.length === 0) {
                    sc = () => {
                        const i2 = this.tabs.indexOf(sourceTab);
                        if (i2 >= 0) this.tabs.splice(i2, 1);
                        const s2 = document.getElementById('split_' + sourceTab.id);
                        if (s2) s2.remove();
                    };
                } else {
                    sc = () => { this._renderSplit(sourceTab); this._updateTabName(sourceTab); };
                }
            }
        } else {
            mt = sourceTab.term; mf = sourceTab.fitAddon; mid = sourceTab.tabId;
            msc = sourceTab._smoothCursor;
            // Same rule as the split branch: the tab's own session state moves
            // with its terminal (paneConnectedState reads .connected/.tabId,
            // which a single tab carries directly)
            mconn = paneConnectedState(sourceTab);
            mfailed = sourceTab._sessionFailed === true;
            const idx = this.tabs.indexOf(sourceTab);
            sc = () => {
                this.tabs.splice(idx, 1);
                const el = document.getElementById('wrap_' + sourceTab.id);
                if (el) el.remove();
            };
        }
        if (!mt || !mid) return;
        // Idempotency guard: if the dragged terminal element is already inside the target split DOM (from any
        // duplicate drop/move via two paths), refuse to insert again — one connection must never appear as two panes
        const tgtRoot = document.getElementById('split_' + targetTab.id);
        if (tgtRoot && mt.element && tgtRoot.contains(mt.element)) {
            console.warn('[tabdrag] terminal already in target split, drop ignored');
            return;
        }
        if (!targetTab.splitRoot) {
            const ew = document.getElementById('wrap_' + targetTab.id);
            if (ew) ew.remove();
            const fp = this._newPaneData(targetTab);
            fp.term = targetTab.term;
            fp.fitAddon = targetTab.fitAddon;
            fp._smoothCursor = targetTab._smoothCursor;
            fp.tabId = targetTab.tabId;
            fp.focused = false;
            // Same transfer rule as the first-split promotion: the target's
            // existing session keeps its liveness marker on the fp pane.
            fp._sessionFailed = targetTab._sessionFailed === true;
            // The terminal moves from targetTab onto the fp pane, so onData must use fp.tabId
            // (targetTab.tabId is about to be cleared; the rebind resolves the owner at send time)
            if (targetTab._onDataDisp) { targetTab._onDataDisp.dispose(); targetTab._onDataDisp = null; }
            fp._onDataDisp = fp.term?.onData(data => {
                _sendInputForTerm(fp.term, data);
            });
            // Same transfer rule as the tool name: a pending LOCAL creation
            // marker must move onto fp (left on the tab it becomes
            // unreachable — the claim branches only match single tabs).
            if (targetTab._ptyRequestId) { fp.requestId = targetTab._ptyRequestId; delete targetTab._ptyRequestId; }
            // An in-flight SSH attempt moves with the target's own session.
            sshAttempts.transferPendingAttempt(targetTab, fp);
            // Same transfer rule as the terminal: the tool-provided name moves onto fp.
            if (targetTab._toolName !== undefined) { fp._toolName = targetTab._toolName; delete targetTab._toolName; }
            targetTab.splitRoot = this._createContainer('h');
            targetTab.splitRoot.children = [fp];
            targetTab.splitRoot.ratios = [1];
            targetTab.term = null;
            targetTab.fitAddon = null;
            targetTab.tabId = null;
            targetTab._smoothCursor = null; // moved onto fp — same transfer rule as addPaneRelativeTo
        }
        // targetPaneId === null → add() with relative=null repacks the root
        // container, i.e. the pane is inserted around the whole split.
        const np = {
            id: 'p_' + (this._paneCounter++),
            requestId: 'p_' + (this._paneCounter - 1),
            term: mt, fitAddon: mf, _smoothCursor: msc, tabId: mid, focused: true,
            name: paneName, type: paneType,
            connected: mconn,
            // Known-failed liveness marker travels with the moved session
            // (ipc.js owns its lifecycle; see the ssh-error/pty-exit handlers)
            _sessionFailed: mfailed,
            _sshHost: sshHost, _sshPort: sshPort, _sshUser: sshUser,
            _sshCredId: sshCredId, _sshProfileId: sshProfileId,
            // From the MOVED session (paneCommand/paneArgs), not the source
            // tab's command/args; an empty args array is meaningful and must
            // not be replaced by another owner's args
            _command: paneType !== 'ssh' ? paneCommand : '',
            _args: paneType !== 'ssh' ? paneArgs : [],
        };
        // Rebind onData after the terminal moves: the original closure referenced sourceTab (already spliced away,
        // or its tabId taken over by the new pane); the rebind resolves the owner at send time
        if (mt && sourceTab._onDataDisp) { sourceTab._onDataDisp.dispose(); sourceTab._onDataDisp = null; }
        np._onDataDisp = mt?.onData(data => {
            _sendInputForTerm(mt, data);
        });
        // An in-flight SSH attempt of the MOVED session follows it onto the
        // new pane wrapper — transferred from the ACTUAL previous owner (the
        // focused pane for a split source: that object is removed from the
        // tree above, and the source tab never held its attempt; the source
        // collapse keeps the SURVIVING pane's own binding untouched).
        sshAttempts.transferPendingAttempt(movedOwner, np);
        if (toolName !== undefined) np._toolName = toolName;
        this.add(targetTab, np, dropAnchor, side);
        getAllPanes(targetTab).forEach(p => p.focused = false);
        np.focused = true;
        targetTab._maximizedPaneId = null;
        const ss = document.getElementById('split_' + sourceTabId);
        if (ss && sourceTabId !== targetTabId) {
            // Blink keeps ResizeObserver-observed nodes (and their whole DOM
            // subtrees) alive: disconnect every pane-body observer before
            // dropping the source subtree — surviving panes are rebuilt with
            // fresh bodies/observers below.
            ss.querySelectorAll('.pane-body').forEach(b => { if (b._resizeObserver) b._resizeObserver.disconnect(); });
            ss.remove();
        }
        const sw = document.getElementById('wrap_' + sourceTabId);
        if (sw && sourceTabId !== targetTabId) sw.remove();
        if (sc) sc();
        this._renderSplit(targetTab);
        if (this.activeId !== targetTab.id) this.switchTo(targetTab.id);
        this._updateTabName(targetTab);
        this.render();
        this.updateStatus();
        // Fire-time validated: the moved terminal's auto-activation must not
        // steal focus if the user switched away inside the 150ms window (the
        // term may also be closed — its owner resolves to none then).
        const priorFocus = document.activeElement || null;
        setTimeout(() => _focusTerminalIfCurrent(mt, priorFocus), 150);
    },

    _exitSplit(tab) {
        const all = getAllPanes(tab);
        const fp = all[0];
        all.forEach((p, i) => {
            if (i > 0 && p.tabId) {
                this._markClosed(p.tabId);
                // Attempt identity carries the pending cancel — see _closePane.
                _cancelSshAttemptOf(p, p.tabId);
            }
            if (i > 0 && p.term) try { if (typeof _releaseWebglForTerm === 'function') _releaseWebglForTerm(p.term); p._smoothCursor?.dispose(); p._smoothCursor = null; p.term.dispose(); } catch(e) {}
        });
        // Sync all tab fields from the surviving pane — otherwise tab.type/host/user etc. keep the old tab's type
        // (e.g. an SSH tab exits split leaving a local pane but stays marked SSH: after restart it would really connect via SSH with a mismatched pane name)
        if (fp) {
            // Pending LOCAL backend hand-off: the surviving pane's creation
            // request must stay claimable on the tab after the split tree is
            // gone (an in-flight SSH attempt transfers by identity instead).
            if (fp.tabId) delete tab._ptyRequestId;
            else tab._ptyRequestId = fp.requestId;
            sshAttempts.transferPendingAttempt(fp, tab);
            adoptPaneFieldsIntoTab(tab, fp);
        }
        tab.term = fp?.term || null;
        tab.fitAddon = fp?.fitAddon || null;
        tab.tabId = fp?.tabId || null;
        // The surviving pane's smooth-cursor wrapper must come back with the
        // terminal — otherwise the tab keeps the disposed original wrapper
        // and the software caret silently dies for this tab's whole life.
        tab._smoothCursor = fp?._smoothCursor ?? null;
        // The surviving pane's tool-provided name comes back onto the tab with its term.
        if (fp && fp._toolName !== undefined) tab._toolName = fp._toolName;
        else delete tab._toolName;
        // Connection state was synced by adoptPaneFieldsIntoTab above; with no
        // surviving pane at all the tab is simply offline.
        if (!fp) tab.connected = false;
        tab.splitRoot = null;
        // Sync input belongs to the split tree: reset it on the merge so a
        // later re-split does not silently resume broadcasting.
        tab.syncInput = false;
        tab._maximizedPaneId = null;
        // The term moves from pane back to tab: the pane's onData listener must be disposed and rebound to the tab,
        // otherwise it stays on the term as a permanent zombie and re-splitting double-binds it — every keypress inputs twice
        if (fp && fp._onDataDisp) { fp._onDataDisp.dispose(); fp._onDataDisp = null; }
        if (tab.term) {
            tab._onDataDisp = tab.term.onData(data => {
                _sendInputForTerm(tab.term, data);
            });
        }
        // Split panes are not captured (the pane branch of the pty-output
        // router never appends), so on unsplit the buffer can only hold
        // stale single-tab content from before the split — reset it so that
        // content cannot resurrect on a later restore.
        tab._contentBuffer = '';
        // Disconnect pane-body resize observers before dropping the split
        // subtree (Blink retains observed nodes and their DOM subtrees).
        all.forEach(p => { const body = document.getElementById('pane-body_' + p.id); if (body && body._resizeObserver) body._resizeObserver.disconnect(); });
        const os = document.getElementById('split_' + tab.id);
        if (os) os.remove();
        const sw = document.getElementById('wrap_' + tab.id);
        if (sw) { if (sw._resizeObserver) sw._resizeObserver.disconnect(); sw.remove(); }
        const { wrap: w, inner: wInner } = createTermWrap(tab);
        document.getElementById('main-area').appendChild(w);
        if (tab.term) {
            wInner.appendChild(tab.term.element);
            setupWrapResizeObserver(w, tab);
            if (tab.fitAddon) setTimeout(() => {
                _fitWithScroll(tab.term, tab.fitAddon, wInner);
                // Explicit final-size report to the CURRENT owner: an
                // unchanged fit fires no onResize, and the backend would keep
                // the split-era geometry
                if (tab.term?.cols) _sendResizeForTerm(tab.term, tab.term.cols, tab.term.rows);
            }, 50);
        }
        // Fire-time validated, PASSIVE: _exitSplit is only reached from the
        // deferred close collapse — the refocus is a completion, not an
        // activation, so a live form focus the user is holding survives it.
        // The slot is still re-read at fire time (a reconnect inside the
        // window disposes the term and nulls tab.term; the old
        // captured-slot deref threw).
        if (this.activeId === tab.id && tab.term) _scheduleTerminalFocus(() => tab.term, 100, true);
        // The split tree collapsed onto a single tab-owned session: the dock's
        // focused-pane resolution changed shape — re-evaluate the binding
        if (typeof SFTP !== 'undefined' && SFTP.updateTarget) SFTP.updateTarget();
    },

    // ── Tab → split drop zones (unified with pane reorder visuals) ──
    // Uses the same .pane-drop-zone bars as pane drag reorder (consistency).
    _tabSplitZones: null, // { layer, zones, tabId }

    _tabComputeSplitZones(tab) {
        if (tab.splitRoot) {
            // Reuse pane drop zones as-is (root-edge zones included), so the
            // outermost edges of the whole split area get their bars too.
            return this._computePaneDropZones(tab);
        }
        const wrap = document.getElementById('wrap_' + tab.id);
        if (!wrap) return [];
        const T = 8; // bar thickness in % (same as pane zones)
        return [
            { x: 0, y: T, w: T, h: 100 - T * 2, side: 'l', relativeTo: null },
            { x: T, y: 0, w: 100 - T * 2, h: T, side: 't', relativeTo: null },
            { x: 100 - T, y: T, w: T, h: 100 - T * 2, side: 'r', relativeTo: null },
            { x: T, y: 100 - T, w: 100 - T * 2, h: T, side: 'b', relativeTo: null },
        ];
    },

    _tabShowSplitZones(tab) {
        this._tabHideSplitZones();
        const rootEl = tab.splitRoot
            ? document.getElementById('split_' + tab.id)
            : document.getElementById('wrap_' + tab.id);
        if (!rootEl) return;
        const zones = this._tabComputeSplitZones(tab);
        if (zones.length === 0) return;
        const layer = document.createElement('div');
        layer.id = 'tab-drop-layer';
        zones.forEach((z, i) => {
            const el = document.createElement('div');
            el.className = 'pane-drop-zone side-' + z.side;
            el.setAttribute('data-zone-idx', i);
            el.style.left = z.x + '%'; el.style.top = z.y + '%';
            el.style.width = z.w + '%'; el.style.height = z.h + '%';
            layer.appendChild(el);
        });
        rootEl.appendChild(layer);
        this._tabSplitZones = { layer, zones, tabId: tab.id };
    },

    _tabHideSplitZones() {
        this._tabSplitZones = null;
        document.getElementById('tab-drop-layer')?.remove();
        this._hideDropHint();
    },

    // Geometry hit test on current zones (the drag overlay intercepts mouse
    // events, so ev.target is always the overlay — use rect math).
    _tabHitSplitZone(ev) {
        const st = this._tabSplitZones;
        if (!st || !st.layer) return null;
        for (const z of st.layer.children) {
            const r = z.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                return z;
            }
        }
        return null;
    },

    // Pure mapping of a hit zone bar to the drag payload. A bar anchored on
    // a pane keeps its pane id; a bar anchored on a nested split CONTAINER
    // (its edge / spanner bars) names the container node itself — containers
    // carry no pane id, and the id-only transport used to degrade those hits
    // to whole-split root-edge inserts, landing the pane on the outermost
    // edge instead of the container edge the bar promised.
    _tabResolveZoneHit(zone) {
        const rel = (zone && zone.relativeTo) || null;
        const isContainer = !!(rel && rel.orientation);
        return {
            side: zone ? zone.side : null,
            targetPaneId: rel && !isContainer ? rel.id : null,
            anchor: rel,
        };
    },

    // ── v12 drop preview ──
    // The prototype's feedback is not a thin edge bar but the full rect the
    // dropped pane will occupy. Hit detection stays untouched (the 8% bars and
    // 28/30% edge bands still decide); this only visualizes the result.
    _dropSideLabel(side) {
        return ({ l: '左侧', r: '右侧', t: '上方', b: '下方' })[side] || '';
    },

    _showDropHint(rect, name, action) {
        if (!rect) { this._hideDropHint(); return; }
        let el = document.getElementById('drop-hint');
        if (!el) {
            el = document.createElement('div');
            el.id = 'drop-hint';
            el.className = 'drop-hint';
            el.innerHTML = '<div class="dh"><span class="dh-dot"></span><span class="dh-name"></span><b class="dh-action"></b></div>';
            document.body.appendChild(el);
        }
        const key = name + '\u0000' + action;
        if (el.dataset.key !== key) {
            el.querySelector('.dh-name').textContent = name;
            el.querySelector('.dh-action').textContent = action;
            el.dataset.key = key;
        }
        el.style.left = rect.left + 'px';
        el.style.top = rect.top + 'px';
        el.style.width = rect.width + 'px';
        el.style.height = rect.height + 'px';
        el.classList.add('show');
    },

    _hideDropHint() {
        const el = document.getElementById('drop-hint');
        if (!el) return;
        el.classList.remove('show');
    },

    _updateTabDropPreview(sourceTab, targetTab, side, anchor) {
        if (!side) { this._hideDropHint(); return; }
        const rootEl = targetTab.splitRoot
            ? document.getElementById('split_' + targetTab.id)
            : document.getElementById('wrap_' + targetTab.id);
        if (!rootEl) { this._hideDropHint(); return; }
        const r = rootEl.getBoundingClientRect();
        if (!r.width || !r.height) { this._hideDropHint(); return; }
        let box;
        if (!targetTab.splitRoot) {
            const vertical = side === 't' || side === 'b';
            box = {
                left: r.left + (side === 'r' ? r.width / 2 : 0),
                top: r.top + (side === 'b' ? r.height / 2 : 0),
                width: vertical ? r.width : r.width / 2,
                height: vertical ? r.height / 2 : r.height,
            };
        } else {
            const pct = previewDropRect(targetTab.splitRoot, {
                side,
                relative: anchor,
                gapX: targetTab._gapXPct,
                gapY: targetTab._gapYPct,
            });
            if (!pct) { this._hideDropHint(); return; }
            box = {
                left: r.left + r.width * pct.x / 100,
                top: r.top + r.height * pct.y / 100,
                width: r.width * pct.w / 100,
                height: r.height * pct.h / 100,
            };
        }
        this._showDropHint(box, this._tabDisplayName(sourceTab), this._dropSideLabel(side) + '分屏');
    },

    _updatePaneDropPreview(tab, zone) {
        if (!zone || !tab.splitRoot) { this._hideDropHint(); return; }
        const rootEl = document.getElementById('split_' + tab.id);
        if (!rootEl) { this._hideDropHint(); return; }
        const r = rootEl.getBoundingClientRect();
        if (!r.width || !r.height) { this._hideDropHint(); return; }
        const src = this._paneDragState && this._paneDragState.sourcePane;
        const pct = previewDropRect(tab.splitRoot, {
            side: zone.side,
            relative: zone.relativeTo,
            moving: src,
            gapX: tab._gapXPct,
            gapY: tab._gapYPct,
        });
        if (!pct) { this._hideDropHint(); return; }
        const name = src ? ((src._toolName || '').trim() || src.name || this._tabDisplayName(tab)) : this._tabDisplayName(tab);
        this._showDropHint({
            left: r.left + r.width * pct.x / 100,
            top: r.top + r.height * pct.y / 100,
            width: r.width * pct.w / 100,
            height: r.height * pct.h / 100,
        }, name, '移到' + this._dropSideLabel(zone.side));
    },

    // ── Tab drag via pointer events ──
    // HTML5 draggable is intercepted by Tauri's window-level DnD handler in
    // WebView2 (dragover never fires, cursor shows the no-drop icon), so tab
    // drag uses the same pointer-based approach as pane drag.
    _onTabPointerDown(e, tabId) {
        if (e.button !== 0) return;
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || tab.type === 'settings') return;
        // Action buttons are semantic <button>s and the rename field is a text input;
        // interactive elements must never start a tab drag.
        if (e.target.closest('button, input, textarea, [contenteditable]')) return;
        e.preventDefault();
        const el = e.currentTarget;
        const startX = e.clientX, startY = e.clientY;
        let dragging = false;
        let dragImage = null;
        const move = (ev) => {
            if (!dragging) {
                if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
                dragging = true;
                this._dragTab = { sourceTabId: tabId, targetTabId: null, side: null, targetPaneId: null, targetAnchor: null };
                el.classList.add('dragging');
                const main = document.getElementById('main-area');
                if (main) main.classList.add('drop-target');
                document.body.classList.add('tab-dragging');
                // Snapshot of the dragged tab (matching the default HTML5 drag image), following the mouse
                const srcEl = document.querySelector('.tab[data-tab="' + tabId + '"]');
                if (srcEl) {
                    const img = srcEl.cloneNode(true);
                    img.className = 'tab tab-drag-image';
                    img.id = 'tab-drag-image';
                    img.removeAttribute('data-tab');
                    document.body.appendChild(img);
                    dragImage = img;
                }
                // Full-screen interception layer: blocks hover/interaction on everything below during the drag
                const overlay = document.createElement('div');
                overlay.id = 'tab-drag-overlay';
                document.body.appendChild(overlay);
            }
            ev.preventDefault();
            if (dragImage) { dragImage.style.left = (ev.clientX + 12) + 'px'; dragImage.style.top = (ev.clientY + 8) + 'px'; }
            // Hit test by geometry: the drag overlay intercepts all mouse
            // events, so ev.target is always the overlay — use rect math.
            // Only entering the content area (main-area) shows the split
            // hints; inside the tabbar only reorder hints are shown.
            const mainEl = document.getElementById('main-area');
            const inMain = !!(mainEl && ev.clientX >= mainEl.getBoundingClientRect().left && ev.clientX <= mainEl.getBoundingClientRect().right && ev.clientY >= mainEl.getBoundingClientRect().top && ev.clientY <= mainEl.getBoundingClientRect().bottom);
            if (inMain) {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
                this._hideDropZone();
                const targetTab = this.getActive();
                if (targetTab && targetTab.type !== 'settings' && this._dragTab.sourceTabId !== targetTab.id) {
                    // Hit test keeps the Electron original tolerance
                    // (wrap 30% edge / pane 28% edge) — the 8% zone bars are
                    // visuals only; a generous hit area matches user intuition
                    // ("drop anywhere near the edge").
                    let side = null, targetPaneId = null, targetAnchor = null;
                    try {
                        if (targetTab.splitRoot) {
                        // 1) Zone-bar hit test first (Tabby's approach: the bars
                        //    are real elements; pointer inside a bar = drop there).
                        //    This gives precise semantics: root top/bottom bar =
                        //    whole split above/below, spanner bar = insert at the
                        //    separator, pane side bar = insert around that pane.
                        if (!this._tabSplitZones || this._tabSplitZones.tabId !== targetTab.id) {
                            this._tabShowSplitZones(targetTab);
                        }
                        const stBars = this._tabSplitZones;
                        if (stBars && stBars.layer) {
                            for (const zEl of stBars.layer.children) {
                                const r = zEl.getBoundingClientRect();
                                if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                                    const z = stBars.zones[parseInt(zEl.getAttribute('data-zone-idx'), 10)];
                                    if (z) {
                                        // Container-anchored bars carry the
                                        // container node (no pane id exists).
                                        const hit = this._tabResolveZoneHit(z);
                                        side = hit.side;
                                        targetPaneId = hit.targetPaneId;
                                        targetAnchor = hit.anchor;
                                    }
                                    break;
                                }
                            }
                        }
                        // 2) Geometry fallback for the area just outside the bars
                        //    (edge band between 8% bar and the 28% hit area).
                        if (!side) {

                            const hitPad = GAP_PX / 2; // hit the gap/spanner between panes too
                            for (const p of getAllPanes(targetTab)) {
                                const el = document.querySelector('.split-pane[data-pane="' + p.id + '"]');
                                if (!el) continue;
                                const r = el.getBoundingClientRect();
                                if (ev.clientX >= r.left - hitPad && ev.clientX <= r.right + hitPad && ev.clientY >= r.top - hitPad && ev.clientY <= r.bottom + hitPad) {
                                    const rx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
                                    const ry = Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1);
                                    const s = this._pickDropSide(rx, ry, 0.28);
                                    if (s) {
                                        // Vertical edge priority: when the pointer
                                        // is in a pane's top/bottom edge band, t/b
                                        // wins over l/r. In a horizontal split the
                                        // panes span the full height, so t/b means
                                        // "above/below the whole split" — matches
                                        // the intuition of dropping above the
                                        // separator to get one pane on top.
                                        if (ry < 0.28) side = 't';
                                        else if (ry > 0.72) side = 'b';
                                        else side = s;
                                        targetPaneId = p.id;
                                        targetAnchor = p;
                                        break;
                                    }
                                }
                            }
                            // Root-level fallback: pointer in the split area's
                            // outer edge band but not inside any pane (top/
                            // bottom padding strip) → insert around the whole
                            // split root (e.g. one pane on top of two).
                            if (!side) {
                                const rootEl = document.getElementById('split_' + targetTab.id);
                                if (rootEl) {
                                    const r = rootEl.getBoundingClientRect();
                                    const rx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
                                    const ry = Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1);
                                    side = this._pickDropSide(rx, ry, 0.30);
                                    targetPaneId = null;
                                    targetAnchor = null;
                                }
                            }
                        }
                        } else {
                            const wrap = document.getElementById('wrap_' + targetTab.id);
                            if (wrap) {
                                const r = wrap.getBoundingClientRect();
                                const rx = (ev.clientX - r.left) / r.width;
                                const ry = (ev.clientY - r.top) / r.height;
                                side = this._pickDropSide(rx, ry, 0.30);
                                targetAnchor = null;
                            }
                        }
                    } catch (err) {
                        console.warn('[tabdrag] side calc failed:', err);
                    }
                    // Function first: commit the drop target before any
                    // visual work, so a bar/zone failure can never break the
                    // split action itself.
                    this._dragTab.targetTabId = side ? targetTab.id : null;
                    this._dragTab.side = side;
                    this._dragTab.targetPaneId = targetPaneId;
                    this._dragTab.targetAnchor = targetAnchor;
                    // Visual bars (same as pane reorder) — isolated: any failure
                    // here must not affect the split functionality.
                    try {
                        if (!this._tabSplitZones || this._tabSplitZones.tabId !== targetTab.id) {
                            this._tabShowSplitZones(targetTab);
                        }
                        const st = this._tabSplitZones;
                        if (st && st.layer) {
                            st.layer.querySelectorAll('.pane-drop-zone.drag-over').forEach(el => el.classList.remove('drag-over'));
                            if (side) {
                                // Highlight by node identity: pane- and
                                // container-anchored bars alike must light the
                                // exact bar the drop will use (the id-only
                                // lookup lit the ROOT bar for container hits).
                                let idx = st.zones.findIndex(z => z.side === side && z.relativeTo === targetAnchor);
                                if (idx >= 0) {
                                    const zEl = st.layer.querySelector('[data-zone-idx="' + idx + '"]');
                                    if (zEl) zEl.classList.add('drag-over');
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('[tabdrag] bars failed:', err);
                    }
                    try {
                        this._updateTabDropPreview(tab, targetTab, side, targetAnchor);
                    } catch (err) {
                        console.warn('[tabdrag] preview failed:', err);
                    }
                } else {
                    this._tabHideSplitZones();
                    this._dragTab.targetTabId = null;
                    this._dragTab.side = null;
                    this._dragTab.targetPaneId = null;
                    this._dragTab.targetAnchor = null;
                }
            } else {
                this._tabHideSplitZones();
                const tabbar = document.getElementById('tabbar');
                let hitTabId = null;
                if (tabbar) {
                    for (const t of tabbar.querySelectorAll('.tab[data-tab]')) {
                        const r = t.getBoundingClientRect();
                        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                            hitTabId = t.getAttribute('data-tab');
                            break;
                        }
                    }
                }
                if (hitTabId) {
                    this._onTabDragOver(ev, hitTabId);
                } else {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
                }
            }
        };
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            if (!dragging) return;
            if (dragImage) { dragImage.remove(); dragImage = null; }
            document.getElementById('tab-drag-overlay')?.remove();
            const mainEl = document.getElementById('main-area');
            const inMain = !!(mainEl && ev.clientX >= mainEl.getBoundingClientRect().left && ev.clientX <= mainEl.getBoundingClientRect().right && ev.clientY >= mainEl.getBoundingClientRect().top && ev.clientY <= mainEl.getBoundingClientRect().bottom);
            if (inMain) {
                this._tabHideSplitZones();
                if (this._dragTab && this._dragTab.targetTabId && this._dragTab.side) {
                    const src = this._dragTab.sourceTabId, tgt = this._dragTab.targetTabId, sd = this._dragTab.side, pid = this._dragTab.targetPaneId;
                    const anchor = this._dragTab.targetAnchor || null;
                    this._dragTab = null;
                    try {
                        this._moveTerminalToTab(src, tgt, sd, pid, anchor);
                    } catch (err) {
                        console.warn('[tabdrag] drop failed:', err);
                    }
                } else {
                    this._dragTab = null;
                }
            } else {
                const tabbar = document.getElementById('tabbar');
                let hitTabId = null;
                if (tabbar) {
                    for (const t of tabbar.querySelectorAll('.tab[data-tab]')) {
                        const r = t.getBoundingClientRect();
                        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                            hitTabId = t.getAttribute('data-tab');
                            break;
                        }
                    }
                }
                if (hitTabId) this._onTabDrop(ev, hitTabId);
            }
            this._onTabDragEnd();
            document.body.classList.remove('tab-dragging');
        };
        // mouseup is not dispatched when the pointer leaves the window or it loses focus, so clean up drag
        // state defensively (otherwise the full-screen interception layer lingers and the UI freezes until the next in-window mouseup)
        const cancelDrag = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('mouseleave', cancelDrag);
            window.removeEventListener('blur', cancelDrag);
            document.removeEventListener('pointercancel', cancelDrag);
            if (dragImage) { dragImage.remove(); dragImage = null; }
            document.getElementById('tab-drag-overlay')?.remove();
            this._tabHideSplitZones();
            this._dragTab = null;
            this._onTabDragEnd();
            document.body.classList.remove('tab-dragging');
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('mouseleave', cancelDrag);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('pointercancel', cancelDrag);
    },

    _onTabDragStart(e, tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab || tab.type === 'settings') { e.preventDefault(); return; }
        this._dragTab = { sourceTabId: tabId, targetTabId: null, side: null, targetPaneId: null };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tabId);
        const el = document.querySelector('.tab[data-tab="' + tabId + '"]');
        if (el) setTimeout(() => el.classList.add('dragging'), 0);
        const main = document.getElementById('main-area');
        if (main) main.classList.add('drop-target');
    },

    _onTabDragEnd(e) {
        document.querySelectorAll('.tab').forEach(el => { el.classList.remove('dragging', 'drag-over-left', 'drag-over-right'); });
        const main = document.getElementById('main-area');
        if (main) main.classList.remove('drop-target');
        this._hideDropZone();
        this._dragTab = null;
    },

    // Drag-to-reorder within tabbar
    _onTabDragOver(e, targetTabId) {
        if (!this._dragTab || this._dragTab.sourceTabId === targetTabId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer = e.dataTransfer || { dropEffect: 'move' }; // pointer events have no dataTransfer
        const el = document.querySelector('.tab[data-tab="' + targetTabId + '"]');
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const isLeft = e.clientX < midX;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        el.classList.add(isLeft ? 'drag-over-left' : 'drag-over-right');
    },

    _onTabDrop(e, targetTabId) {
        if (!this._dragTab) return;
        e.preventDefault();
        e.stopPropagation();
        const sourceId = this._dragTab.sourceTabId;
        if (sourceId === targetTabId) return;
        const sourceIdx = this.tabs.findIndex(t => t.id === sourceId);
        const targetIdx = this.tabs.findIndex(t => t.id === targetTabId);
        if (sourceIdx < 0 || targetIdx < 0) return;
        const el = document.querySelector('.tab[data-tab="' + targetTabId + '"]');
        const rect = el ? el.getBoundingClientRect() : null;
        const insertBefore = rect ? (e.clientX < rect.left + rect.width / 2) : true;
        const [moved] = this.tabs.splice(sourceIdx, 1);
        let insertIdx = this.tabs.findIndex(t => t.id === targetTabId);
        if (!insertBefore) insertIdx += 1;
        this.tabs.splice(insertIdx, 0, moved);
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        this.render();
    },

    // F2 / double-click rename
    startRenameTab(tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        const el = document.querySelector('.tab[data-tab="' + tabId + '"] .tab-name');
        if (!el) return;
        // Mark BEFORE the DOM swap: renders triggered from here on keep this
        // tab's node (the input stays focused through background redraws).
        this._renamingTabId = tabId;
        const oldName = tab.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.className = 'tab-rename-input inline-edit';
        el.replaceWith(input);
        input.focus();
        input.select();
        // One-shot guard (same pattern as sftp.js _editPath): finish() renders,
        // and removing the still-focused input from the document makes Blink
        // dispatch blur SYNCHRONOUSLY — without the guard the nested blur
        // re-enters finish(true) and an Esc cancel still commits the typed name.
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            // Release the render-preservation marker only when THIS rename
            // still owns it (a rename on another tab may have taken over).
            if (this._renamingTabId === tabId) this._renamingTabId = null;
            if (save && input.value.trim()) {
                tab.name = input.value.trim();
                tab._customName = true; // lock the custom name so pane changes no longer overwrite it
            } else if (save && !input.value.trim() && tab.splitRoot) {
                // user cleared the name → restore auto-generation
                delete tab._customName;
                this._updateTabName(tab);
            }
            this.render();
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
            e.stopPropagation();
        };
        input.onblur = () => finish(true);
        input.onclick = (e) => e.stopPropagation();
    },

    // Right-click context menu
    showTabContextMenu(e, tabId) {
        this._hideTabContextMenu();
        const menu = document.createElement('div');
        menu.id = 'tab-context-menu';
        menu.className = 'tab-context-menu';
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        // Read shortcuts from _getShortcutBindings() so user-remapped bindings are reflected
        const bindings = _getShortcutBindings();
        const items = [
            { label: '重命名', actionId: 'renameTab', action: () => this.startRenameTab(tabId) },
            { label: '克隆标签页', actionId: 'cloneTab', action: () => this.cloneTab(tabId) },
            { label: '关闭', actionId: 'closeTab', action: () => this.closeTab(tabId) },
            { label: '关闭其他标签页', actionId: null, action: () => this.closeOtherTabs(tabId) },
        ];
        items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'tab-context-item';
            const combo = item.actionId ? (bindings[item.actionId] || '') : '';
            el.innerHTML = `<span>${escHtml(item.label)}</span>` + (combo ? `<span class="tab-context-shortcut">${escHtml(_comboDisplay(combo))}</span>` : '');
            el.onclick = () => { this._hideTabContextMenu(); item.action(); };
            menu.appendChild(el);
        });
        document.body.appendChild(menu);
        // Width grows with the shortcut hints (base 180 plus margin for the shortcut text)
        const x = Math.min(e.clientX, window.innerWidth - 220);
        const y = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        setTimeout(() => document.addEventListener('click', this._hideTabContextMenuBound = () => this._hideTabContextMenu(), { once: true }), 0);
    },

    _hideTabContextMenu() {
        const menu = document.getElementById('tab-context-menu');
        if (menu) menu.remove();
    },

    closeOtherTabs(keepId) {
        const toClose = this.tabs.filter(t => t.id !== keepId && t.type !== 'settings');
        toClose.forEach(t => this.closeTab(t.id));
    },

    cloneTab(tabId) {
        const src = this.tabs.find(t => t.id === tabId);
        if (!src || src.type === 'settings') return;

        // Has splits: deep-clone the split tree and start a new backend for each pane
        if (src.splitRoot) return this._cloneSplitTab(src);

        // Single pane: plain createTab
        const options = { name: src.name, type: src.type };
        if (src.type === 'ssh') {
            options.host = src.host;
            options.port = src.port;
            options.user = src.user;
            options.credId = src._credId;
            options.privateKey = src.privateKey;
            options.sshProfileId = src.sshProfileId;
        } else {
            options.command = src.command;
            options.args = src.args;
        }
        // The clone shares the source's credential handle (_credId copied
        // above); revocation is decided by the global reference check
        // (_credIdStillReferenced), not by a clone marker.
        return this.createTab(options);
    },

    _cloneSplitTab(src) {
        const id = 't_' + (this._counter++);
        const tab = {
            id,
            name: src.name,
            type: src.type,
            command: src.command,
            args: [...(src.args || [])],
            connected: false,
        };
        if (src.type === 'ssh') {
            Object.assign(tab, {
                host: src.host, port: src.port, user: src.user,
                privateKey: src.privateKey,
                sshProfileId: src.sshProfileId,
                // Note: _credId is NOT copied — each cloned pane keeps the
                // source pane's _sshCredId, so the shared handles stay
                // tracked per pane (revocation goes through the global
                // reference check either way).
            });
        }
        // Deep-clone the split tree; leaf nodes keep the source pane's own type/SSH parameters
        const clonePane = (srcPane) => ({
            id: 'p_' + (this._paneCounter++),
            requestId: null,
            tabId: null, term: null, fitAddon: null,
            focused: srcPane.focused,
            name: srcPane.name,
            type: srcPane.type || 'local',
            connected: srcPane.type !== 'ssh',
            _sshHost: srcPane._sshHost,
            _sshPort: srcPane._sshPort,
            _sshUser: srcPane._sshUser,
            _sshCredId: srcPane._sshCredId,
            _sshProfileId: srcPane._sshProfileId,
            _command: srcPane._command || '',
            _args: srcPane._args || [],
        });
        const cloneTree = (node) => {
            if (node.orientation) {
                return {
                    orientation: node.orientation,
                    children: node.children.map(cloneTree),
                    ratios: [...node.ratios],
                };
            }
            const p = clonePane(node);
            p.requestId = p.id;
            return p;
        };
        tab.splitRoot = cloneTree(src.splitRoot);

        this.tabs.push(tab);
        this._renderSplit(tab);

        // During _renderSplit the old and new split-root are both visible, causing layout contention,
        // so hide the new one first; switchTo then displays it correctly in a single-split context
        const newSplit = document.getElementById('split_' + tab.id);
        if (newSplit) newSplit.style.display = 'none';

        // Start backend connections for all leaf panes
        const panes = getAllPanes(tab);
        panes.forEach(p => this._spawnBackendForPane(p, tab));

        this.switchTo(id);
        // DOM layout is stable after switchTo; recompute gaps to fix spanner widths
        requestAnimationFrame(() => this._layoutSplit(tab));
        this._updateTabName(tab);
        this.render();
        return id;
    },

    _updateTabName(tab) {
        if (!tab || tab._customName) return;
        const panes = tab.splitRoot ? getAllPanes(tab) : [];
        const next = resolveTabName(tab, panes);
        const changed = next != null && next !== tab.name;
        if (changed) tab.name = next;
        // Split-tree callers rely on this hook to persist layout mutations even
        // when the computed name is unchanged, so the save stays unconditional
        // for split tabs; a single-terminal tab only saves when its name moved.
        if (tab.splitRoot || changed) this._scheduleSaveConfig();
    },

    // Visible-name overlay: a manual rename wins, then a tool-provided
    // `_toolName` (OSC 1337 rename channel), then the persisted base name.
    // Display-only — the result is never written back to `tab.name`.
    _tabDisplayName(tab) {
        if (!tab) return '';
        if (tab._customName) return tab.name || '';
        return resolveTabDisplayName(tab, tab.splitRoot ? getAllPanes(tab) : []);
    },

    // A tool-provided name changed: refresh the tab strip and (for the active
    // tab) the status bar. No saveConfig — `_toolName` is ephemeral and must
    // never reach the persisted config.
    refreshTabDisplay(tab) {
        this.render();
        if (tab && this.activeId === tab.id) this.updateStatus();
    },

    // Coalesced persistence: under continuous triggers like drags / pane create-destroy, write once per idle window (no more synchronous IPC blocking the render each time)
    _scheduleSaveConfig() {
        if (typeof requestIdleCallback !== 'undefined') {
            if (this._saveConfigIdleHandle) cancelIdleCallback(this._saveConfigIdleHandle);
            this._saveConfigIdleHandle = requestIdleCallback(() => {
                this._saveConfigIdleHandle = null;
                if (typeof saveConfig === 'function') saveConfig();
            });
        } else if (typeof saveConfig === 'function') {
            saveConfig();
        }
    },

    _restoreSplitTab(tabData) {
        const id = 't_' + (this._counter++);
        const tab = {
            id, name: tabData.name, type: tabData.type,
            command: tabData.command || 'powershell.exe',
            args: tabData.args || [],
            connected: false,
            // Restore the manual-rename lock BEFORE the _updateTabName calls
            // below: unlocked, they would rejoin the pane names over the
            // user's rename and the original name is lost for good.
            _customName: tabData.customName === true,
        };
        if (tabData.type === 'ssh') {
            Object.assign(tab, {
                host: tabData.host, port: tabData.port, user: tabData.user,
                sshProfileId: tabData.sshProfileId,
            });
        }
        tab.splitRoot = deserializeSplitNode(tabData.splitRoot, {
            defaultName: tab.name,
            nextPaneId: () => 'p_' + (this._paneCounter++),
        });
        // Guard against abnormal trees — normalize after deserialization; an empty tree (0 leaves) must not
        // enter the runtime: closing its last pane would leave an unclosable empty-split dead tab. Degraded trees restore as normal tabs.
        if (tab.splitRoot) {
            normalize(tab.splitRoot);
            const panes = getAllPanes(tab);
            if (panes.length === 0) {
                tab.splitRoot = null;
            } else if (!panes.some(p => p.focused)) {
                // Every focus-gated path reads p.focused (switchTo's refocus,
                // reconnectTab's pane pick, wireTerminalToPane's arrival
                // focus, the active-pane highlight), and the deserialized
                // tree ships none — typing went nowhere and clicking a
                // disconnected split SSH tab never reconnected. The saved
                // format carries no focus state, so the first pane takes the
                // marker: a restored tree always lands with exactly one
                // focus owner.
                panes[0].focused = true;
            }
        }
        this.tabs.push(tab);
        if (!tab.splitRoot) {
            // Degraded (empty tree): restore as a normal single-terminal tab and start the backend
            const { wrap: w, inner: wInner } = createTermWrap(tab);
            document.getElementById('main-area').appendChild(w);
            if (tabData.type === 'ssh' && tabData.host) {
                _sshConnectWithCredentials(tab, null);
            } else {
                ipcRenderer.send('pty-create', _ptyCreatePayload(tab.command, tab.args || [], undefined, tab.id));
            }
            this._updateTabName(tab);
            return tab;
        }
        // Session restore is a passive completion (no user tree action):
        // its refocus, if any pane already holds a term, follows the passive
        // intent rule.
        this._renderSplit(tab, true);
        this._updateTabName(tab);
        // Hide on restore and show only after switchTo activates it, preventing multiple splits from stacking
        const splitEl = document.getElementById('split_' + tab.id);
        if (splitEl) splitEl.style.display = 'none';

        // Register credentials (SSH) and start the backend for each pane
        const panes = getAllPanes(tab);
        panes.forEach(p => {
            if (p.type === 'ssh' && p._sshHost) {
                const prof = (this.sshProfiles || []).find(x => x.id === p._sshProfileId);
                // Credential registration is async; spawn the backend when it completes
                const doSpawn = (credId) => {
                    if (credId) p._sshCredId = credId;
                    this._spawnBackendForPane(p, tab);
                };
                if (prof && (prof.encryptedPassword !== undefined || prof.privateKeyPath)) {
                    ipcRenderer.invoke('register-credential', {
                        encryptedPassword: prof.encryptedPassword,
                        privateKeyPath: prof.privateKeyPath,
                    }).then(({ credId }) => doSpawn(credId)).catch(() => doSpawn(null));
                } else {
                    doSpawn(null);
                }
            } else {
                this._spawnBackendForPane(p, tab);
            }
        });
        return tab;
    },

    _showDropZone() {
        let dz = document.getElementById('drop-zone-overlay');
        if (!dz) {
            dz = document.createElement('div');
            dz.id = 'drop-zone-overlay';
            dz.className = 'drop-zone';
            dz.innerHTML = '<div class=zone-left></div><div class=zone-right></div><div class=zone-top></div><div class=zone-bottom></div>';
            document.getElementById('main-area').appendChild(dz);
        }
        dz.classList.add('active');
    },

    _hideDropZone() {
        const dz = document.getElementById('drop-zone-overlay');
        if (dz) {
            dz.classList.remove('active');
            dz.querySelectorAll('.zone').forEach(z => z.classList.remove('show'));
        }
        document.querySelectorAll('.split-pane.drop-target, .term-wrap.drop-target').forEach(el => { el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-top', 'drop-bottom'); });
    },

    _pickDropSide(rx, ry, edge = 0.28) {
        const dL = rx, dR = 1 - rx, dT = ry, dB = 1 - ry;
        const minD = Math.min(dL, dR, dT, dB);
        if (minD > edge) return null;
        const eps = 0.001;
        if (Math.abs(minD - dL) < eps) return 'l';
        if (Math.abs(minD - dR) < eps) return 'r';
        if (Math.abs(minD - dT) < eps) return 't';
        return 'b';
    },

    _onMainDragOver(e) {
        if (!this._dragTab) return;
        const targetTab = this.getActive();
        if (!targetTab || targetTab.type === 'settings') return;
        if (this._dragTab.sourceTabId === targetTab.id) return;
        e.preventDefault();
        e.dataTransfer = e.dataTransfer || { dropEffect: 'move' }; // pointer events have no dataTransfer
        const main = document.getElementById('main-area');
        if (!main) return;
        const rect = main.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        document.querySelectorAll('.split-pane.drop-target, .term-wrap.drop-target').forEach(el => { el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-top', 'drop-bottom'); });
        const sideToClass = s => s ? { l: 'left', r: 'right', t: 'top', b: 'bottom' }[s] : null;
        let side = null, targetPaneEl = null;
        if (targetTab.splitRoot) {
            this._hideDropZone();
            const paneEls = main.querySelectorAll('#split_' + targetTab.id + ' .split-pane');
            const hitPad = GAP_PX / 2;
            for (const el of paneEls) {
                const pr = el.getBoundingClientRect();
                if (x >= pr.left - rect.left - hitPad && x <= pr.right - rect.left + hitPad && y >= pr.top - rect.top - hitPad && y <= pr.bottom - rect.top + hitPad) {
                    const pid = el.getAttribute('data-pane');
                    const tp = findPane(targetTab, pid);
                    if (tp) {
                        const rx = (x - (pr.left - rect.left)) / pr.width, ry = (y - (pr.top - rect.top)) / pr.height;
                        side = this._pickDropSide(rx, ry);
                        if (side) targetPaneEl = el;
                    }
                    break;
                }
            }
        } else {
            this._hideDropZone();
            const wrap = document.getElementById('wrap_' + targetTab.id);
            if (wrap) {
                const wr = wrap.getBoundingClientRect();
                const rx = (e.clientX - wr.left) / wr.width;
                const ry = (e.clientY - wr.top) / wr.height;
                side = this._pickDropSide(rx, ry, 0.30);
                if (side) wrap.classList.add('drop-target', 'drop-' + sideToClass(side));
            }
        }
        if (targetPaneEl && side) targetPaneEl.classList.add('drop-target', 'drop-' + sideToClass(side));
        this._dragTab.targetTabId = side ? targetTab.id : null;
        this._dragTab.side = side;
        this._dragTab.targetPaneId = (targetPaneEl && side) ? targetPaneEl.getAttribute('data-pane') : null;
    },

    _onMainDragLeave(e) { const main = document.getElementById('main-area'); if (main && !main.contains(e.relatedTarget)) this._hideDropZone(); },

    _onMainDrop(e) {
        e.preventDefault();
        this._hideDropZone();
        if (!this._dragTab || !this._dragTab.targetTabId || !this._dragTab.side) { this._dragTab = null; return; }
        const src = this._dragTab.sourceTabId, tgt = this._dragTab.targetTabId, sd = this._dragTab.side, pid = this._dragTab.targetPaneId;
        this._dragTab = null;
        this._moveTerminalToTab(src, tgt, sd, pid);
    },

};

// ── Shared low-latency tab tooltip ──
// Native title attributes carry a ~1s OS delay, which reads as lag when the
// pointer sweeps across tabs. One delegated listener + one shared element.
// Hover must NEVER change tab geometry — long names stay truncated and
// are fully revealed by this tooltip alone; the handler only switches the
// pending target and does one rect-read/style-write per NEW target inside
// the 120ms timer. No width measurement, no expansion state machine.
(() => {
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    let tip = null, timer = null, current = null;
    const ensure = () => {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'zt-tip';
            document.body.appendChild(tip);
        }
        return tip;
    };
    const hide = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (tip) tip.classList.remove('show');
        current = null;
    };
    bar.addEventListener('mouseover', (e) => {
        // Covers tabs plus the tabbar's two chrome buttons (their dataset.tip shares this low-latency tooltip).
        // Moving between a tab's internal spans/svg resolves to the same
        // closest('.tab') target and must NOT restart the timer.
        const el = e.target.closest('.tab, #btn-add-tab, #btn-menu');
        if (!el || el === current) return;
        hide();
        current = el;
        timer = setTimeout(() => {
            if (!el.isConnected) { hide(); return; }
            const name = (el.dataset.tip || el.querySelector('.tab-name')?.textContent || '').trim();
            if (!name) return;
            const t = ensure();
            t.textContent = name;
            t.classList.add('show');
            const r = el.getBoundingClientRect();
            t.style.left = Math.min(Math.max(8, r.left), window.innerWidth - t.offsetWidth - 8) + 'px';
            t.style.top = (r.bottom + 6) + 'px';
        }, 120);
    });
    bar.addEventListener('mouseleave', hide);
    bar.addEventListener('click', hide, true);
    bar.addEventListener('mousedown', hide, true);
    // Tab re-renders (connect/close/rename state changes) replace the DOM
    // under a possibly stationary pointer — drop stale targets so a tooltip
    // never lingers on detached elements until the next mouse move.
    new MutationObserver(() => { if (current && !current.isConnected) hide(); })
        .observe(bar, { childList: true, subtree: true });
})();
