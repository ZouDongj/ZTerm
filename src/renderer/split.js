// ZTerm - split drag + window resize (pure logic functions live in split-layout.js, loaded earlier by renderer.html)
// ── Window resize: re-layout only the DOM live, suppress term fit ──
// Window dragging fires resize every frame; fitting at the same time (full
// redraw + pty-resize dispatch) reflows characters every frame and the
// terminal area jitters (more visible over remote desktop). Instead, 250ms
// after dragging stops, _scheduleSettleResize (320ms debounce, includes the
// pty-resize report) settles everything in one pass.
let _windowResizing = false;
let _windowResizeTimer = null;

window.addEventListener('resize', () => {
    _windowResizing = true;
    clearTimeout(_windowResizeTimer);
    _windowResizeTimer = setTimeout(() => {
        _windowResizing = false;
        TabManager.tabs.forEach(tab => _scheduleSettleResize(tab));
    }, 250);
    requestAnimationFrame(() => {
        TabManager.tabs.forEach(tab => {
            if (tab.splitRoot) TabManager._layoutSplit(tab);
        });
    });
});

// ── Session selector keyboard navigation ──
// ── Spanner drag (Tabby style absolute resize) ──
let _spannerDrag = null;

function _startSpannerDrag(e, tab, container, index) {
    e.preventDefault();
    if (_spannerDrag) _stopSpannerDrag(e);
    const rootEl = document.getElementById('split_' + tab.id);
    if (!rootEl || !tab.splitRoot) return;
    const isV = container.orientation === 'v';
    const rootRect = rootEl.getBoundingClientRect();
    const containerSize = isV
        ? (container._h / 100) * rootRect.height
        : (container._w / 100) * rootRect.width;
    const n = container.children.length;
    const totalGapPx = (n - 1) * GAP_PX;
    const effectiveSize = Math.max(containerSize - totalGapPx, 1);
    _spannerDrag = {
        tab, container, index,
        isV,
        startPos: isV ? e.pageY : e.pageX,
        effectiveSize,
        startRatio1: container.ratios[index - 1],
        startRatio2: container.ratios[index],
    };
    rootEl.classList.add('resizing');
    document.addEventListener('mousemove', _onSpannerDrag);
    document.addEventListener('mouseup', _stopSpannerDrag);
}

function _onSpannerDrag(e) {
    if (!_spannerDrag) return;
    const { tab, container, index, isV, startPos, effectiveSize, startRatio1, startRatio2 } = _spannerDrag;
    const currentPos = isV ? e.pageY : e.pageX;
    const deltaRatio = (currentPos - startPos) / effectiveSize;
    const [r1, r2] = applyDragRatios(startRatio1, startRatio2, deltaRatio, 0.05);
    container.ratios[index - 1] = r1;
    container.ratios[index] = r2;
    TabManager._layoutSplit(tab);
}

function _stopSpannerDrag(e) {
    if (!_spannerDrag) return;
    const { tab } = _spannerDrag;
    const rootEl = document.getElementById('split_' + tab.id);
    if (rootEl) rootEl.classList.remove('resizing');
    getAllPanes(tab).forEach(p => {
        if (p.term && p.fitAddon) p.fitAddon.fit();
    });
    _spannerDrag = null;
    document.removeEventListener('mousemove', _onSpannerDrag);
    document.removeEventListener('mouseup', _stopSpannerDrag);
}

function setToggle(id, on) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', on);
}
function getToggle(id) {
    const el = document.getElementById(id);
    return el ? el.classList.contains('on') : true;
}

