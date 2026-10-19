// ZTerm - split tree pure logic (no DOM dependency; browser global + CommonJS dual export, node:test-able)
// The browser gets global functions via a script tag; node imports via module.exports.

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
                // The inner loop advanced i past the merged region; step back
                // so the outer i++ re-checks the sibling right after it
                // (otherwise adjacent same-orientation containers get skipped
                // and never merged)
                i--;
            }
        }
    }
    let s = 0;
    for (const x of container.ratios) s += x;
    container.ratios = container.ratios.map(x => x / s);
}

// ── Drop preview geometry ──────────────────────────────────────────────
// Pure mirror of TabManager.add(): given a split tree, the side/relative
// anchor of a prospective drop and (for pane drags) the pane being moved,
// return the percent rect the inserted pane would occupy. This drives the
// v12 full-area preview without touching the real tree or its hit zones.
function _parentIn(root, node) {
    if (!root || !root.orientation || root === node) return null;
    const stack = [root];
    while (stack.length) {
        const parent = stack.pop();
        for (const child of parent.children) {
            if (child === node) return parent;
            if (child.orientation) stack.push(child);
        }
    }
    return null;
}

function _cloneSplitTree(node, map) {
    if (!node) return null;
    if (!node.orientation) {
        map.set(node, node);
        return node;
    }
    const copy = { orientation: node.orientation, children: [], ratios: node.ratios.slice() };
    map.set(node, copy);
    for (const child of node.children) copy.children.push(_cloneSplitTree(child, map));
    return copy;
}

function _insertPreview(root, thing, relative, side) {
    let target = relative ? _parentIn(root, relative) : null;
    let nextRoot = root;
    if (!target) {
        target = { orientation: ['l', 'r'].includes(side) ? 'h' : 'v', children: [root], ratios: [1] };
        nextRoot = target;
    }
    let insertIndex = relative
        ? target.children.indexOf(relative) + ('tl'.includes(side) ? 0 : 1)
        : ('tl'.includes(side) ? 0 : -1);
    if (
        (target.orientation === 'v' && ['l', 'r'].includes(side)) ||
        (target.orientation === 'h' && ['t', 'b'].includes(side))
    ) {
        const newContainer = {
            orientation: ['l', 'r'].includes(side) ? 'h' : 'v',
            children: relative ? [relative] : [],
            ratios: [1],
        };
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
    normalize(nextRoot);
    return nextRoot;
}

function _previewLayout(root, target, gapX, gapY) {
    let hit = null;
    const walk = (node, x, y, w, h) => {
        if (node === target) {
            hit = { x, y, w, h };
            return;
        }
        if (!node.orientation) return;
        const n = node.children.length;
        if (n === 0) return;
        if (node.orientation === 'h') {
            const gap = gapX * (n - 1);
            let cx = x;
            for (let i = 0; i < n; i++) {
                const cw = (w - gap) * node.ratios[i];
                walk(node.children[i], cx, y, cw, h);
                cx += cw + gapX;
            }
        } else {
            const gap = gapY * (n - 1);
            let cy = y;
            for (let i = 0; i < n; i++) {
                const ch = (h - gap) * node.ratios[i];
                walk(node.children[i], x, cy, w, ch);
                cy += ch + gapY;
            }
        }
    };
    walk(root, 0, 0, 100, 100);
    return hit;
}

function previewDropRect(root, opts) {
    if (!root) return null;
    const side = opts && opts.side;
    const moving = opts && opts.moving;
    const gapX = opts && Number.isFinite(opts.gapX) ? opts.gapX : 0.8;
    const gapY = opts && Number.isFinite(opts.gapY) ? opts.gapY : 1;
    if (!side) return null;
    if (moving && opts.relative === moving) return null;
    // Mirrors _movePaneToZone's re-anchor: a zone naming the two-child
    // container that holds the dragged pane collapses when it detaches.
    let relative = (opts && opts.relative) || null;
    if (relative && relative.orientation && relative.children.length === 2 && relative.children.indexOf(moving) >= 0) {
        relative = relative.children[relative.children[0] === moving ? 1 : 0];
    }
    const map = new Map();
    let tree = _cloneSplitTree(root, map);
    const placeholder = { preview: true };
    if (moving) {
        const movingClone = map.get(moving);
        if (movingClone) {
            const parent = _parentIn(tree, movingClone);
            if (parent) {
                const idx = parent.children.indexOf(movingClone);
                parent.children.splice(idx, 1);
                parent.ratios.splice(idx, 1);
                normalize(tree);
            }
        }
    }
    const rel = relative ? map.get(relative) || null : null;
    tree = _insertPreview(tree, placeholder, rel, side);
    const rect = _previewLayout(tree, placeholder, gapX, gapY);
    return rect;
}

// Drag-adjust the ratios of two adjacent panes with a minimum-ratio clamp (dragging can never shrink a pane away)
function applyDragRatios(r1, r2, deltaRatio, minRatio) {
    let a = r1 + deltaRatio;
    let b = r2 - deltaRatio;
    if (a < minRatio) { b -= minRatio - a; a = minRatio; }
    if (b < minRatio) { a -= minRatio - b; b = minRatio; }
    // Extreme input (initial sum of both sides < minRatio) makes the double clamp overshoot negative; clamp to 0 to prevent negative sizes
    const sum = a + b;
    if (a < 0) { a = 0; b = sum; }
    if (b < 0) { b = 0; a = sum; }
    return [a, b];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getAllPanes, findPane, getParentOf, normalize, applyDragRatios, previewDropRect };
}
