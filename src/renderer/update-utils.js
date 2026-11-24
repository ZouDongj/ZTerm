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

// True when a version or tag string carries a SemVer pre-release suffix
// (e.g. "1.2.5-dev.4", "v1.2.5-rc.1+build.2"). Build metadata after "+" is
// stripped first so "+build-1" is not mistaken for a pre-release suffix.
function isPrereleaseVersion(version) {
    if (typeof version !== 'string') return false;
    const trimmed = version.trim();
    if (!trimmed) return false;
    const withoutBuild = trimmed.split('+')[0];
    return /^v?\d+(?:\.\d+){0,2}-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/i.test(withoutBuild);
}

// True when a check-update payload represents a pre-release build.
function isUpdatePrerelease(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.isPrerelease === true) return true;
    return isPrereleaseVersion(result.latest) || isPrereleaseVersion(result.tag);
}

// Display label for a version or release tag: prefixes pre-releases with the
// dev-build label while keeping stable releases unchanged.
function formatUpdateTagLabel(tag, isPrerelease) {
    const clean = typeof tag === 'string' ? tag.trim() : '';
    const pre = isPrerelease === true || isPrereleaseVersion(clean);
    if (!clean) return pre ? '开发版' : '';
    return pre ? `开发版 ${clean}` : clean;
}

// Status description shown when a newer release is discovered.
function formatUpdateFoundDesc(result) {
    const latest = result && result.latest != null ? String(result.latest) : '';
    const current = result && result.current != null ? String(result.current) : '';
    const label = formatUpdateTagLabel(latest, isUpdatePrerelease(result));
    return `发现新版本 ${label}（当前 ${current}）`;
}

// Download button text for a discovered release.
function formatUpdateDownloadButton(result) {
    return isUpdatePrerelease(result) ? '下载开发版' : '下载更新';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        countUpdateBlockers,
        updateReleasePageUrl,
        isPrereleaseVersion,
        isUpdatePrerelease,
        formatUpdateTagLabel,
        formatUpdateFoundDesc,
        formatUpdateDownloadButton,
    };
}
