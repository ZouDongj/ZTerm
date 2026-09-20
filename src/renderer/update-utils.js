// ZTerm - 应用内更新纯逻辑（无 DOM 依赖，浏览器全局 + CommonJS 双导出，node:test 可测）

// Count the activities that an update install would interrupt: live SSH
// sessions (including split panes) and in-flight SFTP transfers. Local
// shells are ignored on purpose — they die on every ordinary app exit.
// `getPanes` is injected (production passes the global getAllPanes) so the
// function stays free of renderer globals.
function countUpdateBlockers(tabs, transfers, getPanes) {
    let ssh = 0;
    for (const tab of (tabs || [])) {
        if (tab.splitRoot && typeof getPanes === 'function') {
            for (const pane of getPanes(tab)) {
                if ((pane.type === 'ssh' || pane._sshHost) && pane.connected === true) ssh++;
            }
        } else if (tab.type === 'ssh' && tab.connected === true) {
            ssh++;
        }
    }
    const sftp = (transfers || []).filter(t => !t.done && !t.cancelled).length;
    return { ssh, sftp };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { countUpdateBlockers };
}
