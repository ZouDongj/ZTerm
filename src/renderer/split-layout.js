// ZTerm - 分屏树纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）
// 浏览器通过 script 标签加载得到全局函数；node 通过 module.exports 导入。

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
                // 内层循环把 i 推进到了合并区之后；回退一步让外层 i++ 重新
                // 检查合并区后的下一个兄弟（否则相邻的同向容器会被跳过不合并）
                i--;
            }
        }
    }
    let s = 0;
    for (const x of container.ratios) s += x;
    container.ratios = container.ratios.map(x => x / s);
}

// 拖拽调整相邻两个 pane 的 ratio，最小比例钳制（拖动不会把 pane 压没）
function applyDragRatios(r1, r2, deltaRatio, minRatio) {
    let a = r1 + deltaRatio;
    let b = r2 - deltaRatio;
    if (a < minRatio) { b -= minRatio - a; a = minRatio; }
    if (b < minRatio) { a -= minRatio - b; b = minRatio; }
    // 极端输入（两侧初始和 < minRatio）双钳制会过冲为负，裁到 0 防负尺寸
    const sum = a + b;
    if (a < 0) { a = 0; b = sum; }
    if (b < 0) { b = 0; a = sum; }
    return [a, b];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getAllPanes, findPane, getParentOf, normalize, applyDragRatios };
}
