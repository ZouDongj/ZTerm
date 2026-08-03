// ZTerm - 分屏树辅助 + resize bar 拖拽 + 窗口 resize（拆自 renderer.html，纯代码搬运，未改逻辑）
// ── Split tree helpers (Tabby-aligned) ──
function getAllPanes(tab) {
    if (!tab.splitRoot) return [];
    const out = [];
    const walk = (node) => {
        if (node.orientation) node.children.forEach(walk);
        else out.push(node);
    };
    walk(tab.splitRoot);
    return out;
}

function findPane(tab, paneId) {
    if (!tab.splitRoot) return null;
    const search = (node) => {
        if (!node.orientation) return node.id === paneId ? node : null;
        for (const c of node.children) {
            const r = search(c);
            if (r) return r;
        }
        return null;
    };
    return search(tab.splitRoot);
}

function getParentOf(tab, node) {
    if (!tab.splitRoot || tab.splitRoot === node) return null;
    const search = (parent) => {
        for (const child of parent.children) {
            if (child === node) return parent;
            if (child.orientation) {
                const r = search(child);
                if (r) return r;
            }
        }
        return null;
    };
    return search(tab.splitRoot);
}

function normalize(container) {
    if (!container || !container.orientation) return;
    for (let i = 0; i < container.children.length; i++) {
        const child = container.children[i];
        if (child.orientation) {
            normalize(child);
            if (child.children.length === 0) {
                container.children.splice(i, 1);
                container.ratios.splice(i, 1);
                i--;
                continue;
            } else if (child.children.length === 1) {
                container.children[i] = child.children[0];
            } else if (child.orientation === container.orientation) {
                const ratio = container.ratios[i];
                container.children.splice(i, 1);
                container.ratios.splice(i, 1);
                for (let j = 0; j < child.children.length; j++) {
                    container.children.splice(i, 0, child.children[j]);
                    container.ratios.splice(i, 0, child.ratios[j] * ratio);
                    i++;
                }
            }
        }
    }
    let s = 0;
    for (const x of container.ratios) s += x;
    container.ratios = container.ratios.map(x => x / s);
}

function getOffsetRatio(container, index) {
    let s = 0;
    for (let i = 0; i < index; i++) s += container.ratios[i];
    return s;
}

// ── Session Selector ──
// ── Recalculate split gap percentages when the window is resized ──
window.addEventListener('resize', () => {
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
    const minRatio = 0.05;
    let r1 = startRatio1 + deltaRatio;
    let r2 = startRatio2 - deltaRatio;
    if (r1 < minRatio) { r2 -= minRatio - r1; r1 = minRatio; }
    if (r2 < minRatio) { r1 -= minRatio - r2; r2 = minRatio; }
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

