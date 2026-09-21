// ZTerm - SSH profile display model (pure, no DOM; browser global + CommonJS dual export)
//
// Single source for how an SSH connection is presented, shared by the
// settings manager page, the standalone manager overlay and the session
// selector. Render layers escape text for their own context; these functions
// only compute raw display values. They never mutate the source profile and
// never return credential material.
(function installSshDisplay(root) {
    'use strict';

    // Effective port semantics used across the whole app: port || 22.
    // Number() also normalizes string ports from hand-edited config files
    // (and drops garbage like "22;rm -rf" to the 22 default via NaN).
    function effectivePort(profile) {
        return Number(profile && profile.port) || 22;
    }

    // Bracket-wrap IPv6 literals for host:port display. Already-bracketed
    // values pass through untouched; the raw host is never rewritten.
    function formatEndpoint(host, port) {
        const h = String(host || '');
        const wrapped = h.indexOf(':') !== -1 && h.charAt(0) !== '[' ? '[' + h + ']' : h;
        return wrapped + ':' + port;
    }

    // Display model for one SSH profile.
    //   unnamed (no name, or name identical to host):
    //       primary = host (technical/mono text), meta = "user · 端口 port"
    //   named (any other explicit name):
    //       primary = full stored name (UI text), meta = "host:port · user"
    function sshDisplayModel(profile) {
        const p = profile || {};
        const name = String(p.name || '').trim();
        const host = String(p.host || '');
        const user = String(p.username || '');
        const port = effectivePort(p);
        // An explicit name that merely repeats the host counts as unnamed:
        // the connection is introduced by its technical address instead.
        const named = name.length > 0 && name !== host;
        return {
            primary: named ? name : host,
            primaryIsHost: !named,
            endpoint: formatEndpoint(host, port),
            user: user,
            port: port,
            named: named,
            keyAuth: p.authType === 'key',
        };
    }

    // Search match across name, host, username, effective port and group
    // (case-insensitive, substring). Empty query matches everything.
    function sshProfileMatches(profile, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return true;
        const p = profile || {};
        const haystack = [p.name, p.host, p.username, String(effectivePort(p)), p.group];
        return haystack.some(v => String(v || '').toLowerCase().indexOf(q) !== -1);
    }

    const api = { effectivePort, formatEndpoint, sshDisplayModel, sshProfileMatches };
    root.SshDisplay = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
