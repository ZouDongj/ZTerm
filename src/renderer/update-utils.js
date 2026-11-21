// ZTerm - in-app update pure logic (no DOM dependency; browser global + CommonJS dual export, node:test-able)

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

// Return a safe release page for the manual-download link. Only the project's
// own HTTPS releases pages are accepted; percent-encoded traversals, queries,
// fragments, or other paths fall back to the stable latest-release page.
function updateReleasePageUrl(url) {
    const fallback = 'https://github.com/ZouDongj/ZTerm/releases/latest';
    if (typeof url !== 'string') return fallback;
    const trimmed = url.trim();
    if (!trimmed || /[\s%\\?#]/.test(trimmed) || trimmed.includes('..')) return fallback;
    let parsed;
    try { parsed = new URL(trimmed); } catch (_) { return fallback; }
    if (parsed.protocol !== 'https:'
        || parsed.hostname !== 'github.com'
        || parsed.port !== ''
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.search !== ''
        || parsed.hash !== '') {
        return fallback;
    }
    if (!/^\/ZouDongj\/ZTerm\/releases(?:\/(?:latest|tag\/[A-Za-z0-9.+-]+))?$/.test(parsed.pathname)) {
        return fallback;
    }
    if (parsed.pathname.includes('..')) return fallback;
    return parsed.href;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { countUpdateBlockers, updateReleasePageUrl };
}
